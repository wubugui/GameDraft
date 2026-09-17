"""挂件预设页的「可燃」块（A3.8 模板 + 实例）与试挂预览按模板画。

钉死：
- 可燃块没动过：连未知键一起原样往返；开 = 写 ``burnable: {template}``、关 = 删整块；挂件不出「玩家点火 / 条件」两行；
- 开了可燃：火把那一套块（灯 / 粒子挂载 / 火焰 / 风吹灭 / 玩家操作 / 能点火 / 耐久 / 效果块 / 等级 / 状态表）灰掉并说明，
  写着的能一键清掉（先确认）；贴图 / 支点提示被模板接管；互斥清单与 ``prop_preview.BURNABLE_EXCLUSIVE_KEYS`` 同一份；
- 试挂预览画模板图：挂点对准模板握点、``scale = widthCm·0.88 / texW × 预设 scale``（运行时挂件贴图宽 = texW × scale）、
  标出模板着火点，不画起火点 / 火苗 / 粒子挂载。
"""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPointF
from PySide6.QtGui import QColor, QImage, QPixmap
from PySide6.QtWidgets import QApplication

from tools.editor.editors.prop_preset_editor import PropPresetEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared import burnables as bn
from tools.editor.shared.prop_preview import (
    BURNABLE_EXCLUSIVE_KEYS,
    burnable_prop_placement,
    burnable_template_id,
)
from tools.editor.shared.prop_tryon_canvas import PropTryOnCanvas

INCENSE_IMG = "/resources/runtime/images/burn/incense.png"
TORCH_IMG = "/resources/runtime/images/props/torch.png"

SEED = {
    "incense": {
        "label": "香",
        "scale": 2,
        "burnable": {"template": "incense_stick", "initial": "burning", "zzz": 1},
        "persistent": True,
    },
    "torch": {
        "label": "火把",
        "image": TORCH_IMG,
        "anchorX": 0.5,
        "anchorY": 0.9,
        "light": {"socket": "hand_r", "intensity": 1.2},
        "particles": [{"effect": "torch_flame"}],
        "states": {"lit": {"burn": 1}},
        "defaultState": "lit",
    },
}

INCENSE = {"id": "incense_stick", "label": "线香", "image": INCENSE_IMG, "widthCm": 2, "heightCm": 30,
           "grip": {"u": 0.5, "v": 0.8}, "mode": "consume",
           "ignitionPoints": [{"id": "tip", "u": 0.5, "v": 0.02}]}


def _png(root: Path, url: str, w: int, h: int) -> None:
    p = root / "public" / url.lstrip("/")
    p.parent.mkdir(parents=True, exist_ok=True)
    img = QImage(w, h, QImage.Format.Format_ARGB32)
    img.fill(QColor(120, 90, 60, 255))
    assert img.save(str(p))


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        root = Path(self._td.name) / "p"
        for sub in ("public/assets/data", "public/assets/scenes",
                    "public/assets/dialogues/graphs", "public/resources/runtime/animation"):
            (root / sub).mkdir(parents=True, exist_ok=True)
        (root / "public/assets/data/prop_presets.json").write_bytes(
            (json.dumps(SEED, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        bdir = bn.burnables_dir(root)
        bdir.mkdir(parents=True, exist_ok=True)
        (bdir / "incense_stick.json").write_bytes(bn.dumps(INCENSE))
        _png(root, INCENSE_IMG, 10, 150)
        _png(root, TORCH_IMG, 40, 80)
        self._root = root
        self._model = ProjectModel()
        self._model.load_project(root)
        self._eds: list[PropPresetEditor] = []

    def _editor(self, keep: str) -> PropPresetEditor:
        ed = PropPresetEditor(self._model)
        self._eds.append(ed)
        ed._refresh(keep=keep)
        return ed

    def tearDown(self) -> None:
        for ed in self._eds:
            ed.deleteLater()
        QApplication.processEvents()
        self._td.cleanup()


class BurnableBlockRoundtripTests(_Base):
    def test_untouched_roundtrip_keeps_unknown_keys_and_order(self) -> None:
        before = copy.deepcopy(self._model.prop_presets)
        ed = self._editor("incense")
        self.assertEqual(ed._staged(), before, "打开→不动→保存逐值不变（含 burnable 里的未知键）")
        self.assertEqual(list(ed._staged()["incense"]), list(before["incense"]), "键序不变")
        blk = ed._burnable_block
        self.assertTrue(blk.is_built() and blk.section.is_expanded(), "有配置：自动展开")
        self.assertIsNone(blk.player_ignite_box, "挂件不走按 E 点：没有「玩家点火」")
        self.assertIsNone(blk.conditions, "挂件不走按 E 点：没有「能点的条件」")
        ed.flush_to_model()
        self.assertFalse(self._model.is_dirty, "零编辑 flush 不标脏")

    def test_turn_on_writes_template_and_off_removes_block(self) -> None:
        ed = self._editor("torch")
        blk = ed._burnable_block
        self.assertFalse(blk.is_enabled())
        blk.section.set_expanded(True)
        blk.enable_box.setChecked(True)
        out = ed._collect()
        self.assertEqual(out["burnable"], {"template": "incense_stick"})
        self.assertEqual(list(ed._staged()["torch"])[-1], "burnable", "新块追加在既有键之后")
        blk.initial_combo.setCurrentIndex(blk.initial_combo.findData("burning"))
        self.assertEqual(ed._collect()["burnable"], {"template": "incense_stick", "initial": "burning"})
        blk._confirm_disable = lambda _t: True  # type: ignore[method-assign]
        blk.enable_box.setChecked(False)
        self.assertNotIn("burnable", ed._collect())
        ed.flush_to_model()
        self.assertNotIn("burnable", self._model.prop_presets["torch"])


class BurnableExclusiveTests(_Base):
    def test_exclusive_list_is_the_shared_one(self) -> None:
        keys = {k for k, _a, _l in PropPresetEditor._BURN_EXCLUSIVE_BLOCKS}
        self.assertEqual(keys, set(BURNABLE_EXCLUSIVE_KEYS), "互斥清单只有一份（prop_preview）")

    def test_torch_blocks_are_greyed_out_with_a_note_and_can_be_cleared(self) -> None:
        ed = self._editor("torch")
        for attr in ("_light_block", "_particles_block", "_states_editor", "_fire_block", "_igniter_block"):
            self.assertTrue(getattr(ed, attr).isEnabled(), f"没开可燃：{attr} 可编辑")
        blk = ed._burnable_block
        blk.section.set_expanded(True)
        blk.enable_box.setChecked(True)
        for attr in ("_light_block", "_particles_block", "_states_editor", "_fire_block", "_blowout_block",
                     "_player_block", "_igniter_block", "_fuel_block", "_effects_block", "_levels_editor"):
            self.assertFalse(getattr(ed, attr).isEnabled(), f"开了可燃：{attr} 灰掉（与可燃互斥）")
        self.assertFalse(ed._burn_exclusive_box.isHidden())
        note = ed._burn_exclusive_note.text()
        self.assertIn("互斥", note)
        self.assertIn("自带光源", note)
        self.assertIn("粒子挂载", note)
        self.assertIn("状态表", note)
        self.assertIn("与可燃互斥、却还写着", blk.warn_label.text())
        self.assertIn("image", blk.warn_label.text(), "贴图 / 支点被接管要提示")
        self.assertFalse(ed._burn_image_hint.isHidden())
        self.assertIn("被模板接管", ed._burn_place_hint.text())
        self.assertIn("握点", ed._burn_place_hint.text())
        self.assertFalse(ed._pick_fire_btn.isEnabled())

        asked: list[list[str]] = []
        ed._confirm_clear_exclusive = lambda labels: asked.append(labels) or True  # type: ignore[method-assign]
        self.assertTrue(ed._burn_exclusive_clear.isEnabled())
        ed._burn_exclusive_clear.click()
        self.assertEqual(asked and set(asked[0]), {"自带光源", "粒子挂载", "状态表"})
        out = ed._collect()
        for key in ("light", "particles", "states", "defaultState"):
            self.assertNotIn(key, out, f"清掉互斥：{key} 删了")
        self.assertEqual(out["burnable"], {"template": "incense_stick"}, "可燃块本身保住（没 Apply 的开关不丢）")
        self.assertEqual(out["image"], TORCH_IMG, "被接管的贴图只提示不删")
        self.assertFalse(ed._burn_exclusive_clear.isEnabled())
        self.assertNotIn("却还写着", blk.warn_label.text())

        blk._confirm_disable = lambda _t: True  # type: ignore[method-assign]
        blk.enable_box.setChecked(False)
        self.assertTrue(ed._light_block.isEnabled() and ed._states_editor.isEnabled(), "关了可燃：全部恢复")
        self.assertTrue(ed._burn_exclusive_box.isHidden() and ed._burn_image_hint.isHidden())


class BurnablePreviewTests(_Base):
    def test_placement_follows_runtime_rule(self) -> None:
        self.assertEqual(burnable_template_id(SEED["incense"]), "incense_stick")
        self.assertEqual(burnable_template_id(SEED["torch"]), "")
        pl = burnable_prop_placement({"scale": 2, "rotation": 15, "anchorX": 0.1, "anchorY": 0.1}, INCENSE, 10)
        assert pl is not None
        self.assertAlmostEqual(pl.scale, 2 * 2 * bn.WU_PER_CM / 10)
        self.assertEqual((pl.anchor_x, pl.anchor_y), (0.5, 0.8), "挂点对准模板握点，不用预设支点")
        self.assertEqual(pl.rotation, 15)
        self.assertEqual(pl.image, INCENSE_IMG)
        self.assertIsNone(burnable_prop_placement({}, {"image": INCENSE_IMG}, 10), "模板没真实宽：画不出来")
        grip_default = burnable_prop_placement({}, {"image": INCENSE_IMG, "widthCm": 2, "heightCm": 3}, 10)
        self.assertEqual((grip_default.anchor_x, grip_default.anchor_y), (0.5, 1.0), "没标握点 = 底边中点")

    def test_tryon_draws_the_template_scaled_to_real_width(self) -> None:
        ed = self._editor("incense")
        cv = ed._canvas
        self.assertIsNotNone(cv._prop)
        self.assertEqual((cv._prop.width(), cv._prop.height()), (10, 150), "画的是模板的图")
        self.assertEqual(cv._anchor, (0.5, 0.8))
        self.assertAlmostEqual(cv._scale, 2 * 2 * bn.WU_PER_CM / 10, msg="宽 = widthCm·0.88 × 预设 scale")
        self.assertEqual(cv._burn_points, [("tip", (0.5, 0.02))])
        self.assertFalse(cv._fire_configured, "火把那一套（起火点 / 火苗）不画")
        self.assertEqual(cv._mounts, [])
        # 改预设缩放：试挂跟着乘
        ed._spins["scale"].setValue(1.0)
        self.assertAlmostEqual(cv._scale, 2 * bn.WU_PER_CM / 10)
        # 模板在盘上改了真实宽（燃烧工作台存盘）→ 重读 → 试挂按新宽画
        doc = dict(INCENSE, widthCm=4)
        (bn.burnables_dir(self._root) / "incense_stick.json").write_bytes(bn.dumps(doc))
        self.assertTrue(self._model.reload_burn_from_disk())
        ed.reload_refs_from_model()
        self.assertAlmostEqual(cv._scale, 4 * bn.WU_PER_CM / 10)
        # 非可燃挂件：照旧画自己的图、没有着火点
        ed._refresh(keep="torch")
        self.assertEqual(cv._prop.width(), 40)
        self.assertEqual(cv._burn_points, [])

    def test_canvas_burn_points_use_the_same_uv_transform_as_fire_point(self) -> None:
        cv = PropTryOnCanvas()
        try:
            cell = QPixmap(100, 200)
            cell.fill(QColor(40, 40, 40))
            cv.resize(340, 400)
            cv.set_host(cell, 60.0, 120.0)
            cv.set_pose((0.5, 0.5, 20.0, True))
            prop = QPixmap(10, 150)
            prop.fill(QColor(200, 200, 200))
            cv.set_prop(prop)
            cv.set_placement(0.5, 0.8, 10.0, 0.35)
            cv.set_burn_points([("tip", (0.5, 0.02))])
            pts = cv.burn_point_view_points()
            self.assertEqual(len(pts), 1)
            ref = cv._uv_view_point((0.5, 0.02))
            self.assertIsInstance(ref, QPointF)
            self.assertAlmostEqual(pts[0][1].x(), ref.x())
            self.assertAlmostEqual(pts[0][1].y(), ref.y())
            cv.grab()   # 真画一遍（HUD 菱形 + 文本）不抛
        finally:
            cv.deleteLater()


if __name__ == "__main__":
    unittest.main()
