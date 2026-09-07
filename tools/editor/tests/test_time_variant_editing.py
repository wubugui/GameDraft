"""「改其他时段的配置」从面板进：`timeVariants[时段]` 的每一项都要能在表单上改。

此前：①「+ 时段外观…」一点就 AttributeError（面板上没有 `_scene_id`），弹窗根本出不来；
②环境覆盖只能整块快照白天的值，改一个夜里的雾浓度要重走一遍快照；③深度 / 环境音 /
BGM / 滤镜只能手写 JSON；④游戏在夜里 F2 调好的参数被编辑器一律拒收，而自动同步那条
路却没拦，合并后的夜值直接灌进白天基底。

这里从最外层入口锁：表格选行 → 表单改值 → 写回 staging；以及同步槽按时段拆分 / 合并。
"""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication, QInputDialog, QMessageBox

from tools.editor.editors import scene_lights
from tools.editor.editors.scene_editor import ScenePropertyPanel
from tools.editor.editors.scene_time_variant_form import variant_summary
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SID = "夜街"
_BASE_LIGHTING = {
    "sky": {"kelvin": 9000, "intensity": 0.05, "hemi": 0.85},
    "lights": [{"id": "lamp_a", "kind": "point", "pos": [100.0, 20.0, 100.0], "range": 300.0,
                "intensity": 1.0, "kelvin": 3000.0}],
    "fog": {"sigma": 0.0, "scaleHeight": 530.0, "baseHeight": 0.0, "kelvin": 7000.0,
            "scatter": 0.15},
    "display": {"ev": 0.0, "tonemap": "filmic", "whiteKelvin": 7000.0, "contrast": 0.85,
                "saturation": 0.9, "lift": 0.0, "liftKelvin": 10000.0},
    "emissive": {"gain": 2.0, "coreRadius": 30.0, "haloRadius": 140.0, "haloGain": 0.18},
    "aoStrength": 1.0,
}


def _scene() -> dict:
    return {
        "id": _SID, "name": "夜街", "worldWidth": 800, "worldHeight": 600,
        "backgrounds": [{"image": "background.png", "x": 0, "y": 0}],
        "bgm": "bgm_day", "ambientSounds": ["amb_street"], "filterId": "",
        "dayNight": {"enabled": True},
        "lighting": copy.deepcopy(_BASE_LIGHTING),
        "depthConfig": {"depth_map": "raw_depth_rg.png", "collision_map": "collision.png",
                        "M": {"R": [[1, 0], [0, 1]], "ppu": 1, "cx": 0, "cy": 0},
                        "depth_mapping": {"invert": False, "scale": 1, "offset": 0},
                        "shader": {"depth_per_sy": 0.1},
                        "depth_tolerance": 0.5, "floor_offset": 0.0},
        "timeVariants": {
            "夜": {
                "backgrounds": [{"image": "background-night.png", "x": 0, "y": 0}],
                "lighting": {"fog": {"sigma": 0.4, "color": [0.1, 0.1, 0.2]}},
                "lightEnv": {"legacy": 1},
            },
        },
        "hotspots": [], "npcs": [], "zones": [], "spawnPoint": {"x": 10, "y": 10},
    }


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        dp = root / "public" / "assets" / "data"
        cfg = json.loads((dp / "game_config.json").read_text(encoding="utf-8"))
        cfg["dayNight"] = {"phases": [{"id": "午", "from": "11:00", "daylight": True},
                                      {"id": "夜", "from": "20:00"}]}
        (dp / "game_config.json").write_text(json.dumps(cfg, ensure_ascii=False), encoding="utf-8")
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.scenes[_SID] = _scene()
        rt = self.model.paths.scene_runtime_dir(_SID)
        rt.mkdir(parents=True, exist_ok=True)
        for name in ("background.png", "background-night.png", "collision.png",
                     "raw_depth_rg.png", "raw_depth_night.png"):
            (rt / name).write_bytes(b"")

    def tearDown(self) -> None:
        self._app.processEvents()
        self._tmp.cleanup()


class TimeVariantFormTests(_Base):
    def setUp(self) -> None:
        super().setUp()
        self.panel = ScenePropertyPanel(self.model)
        self.panel.load_scene_props(self.model.scenes[_SID])
        self.panel._select_tv_row("夜")
        self.form = self.panel._tv_form

    def tearDown(self) -> None:
        self.panel.deleteLater()
        super().tearDown()

    def _written(self) -> dict:
        sc = copy.deepcopy(self.panel._staging_scene)
        self.panel._flush_scene_widgets_into(sc)
        return sc["timeVariants"]["夜"]

    def test_selecting_a_row_loads_that_phase(self) -> None:
        self.assertEqual(self.form.phase_id, "夜")
        self.assertTrue(self.form._block_cb["fog"].isChecked())
        self.assertFalse(self.form._block_cb["sky"].isChecked())
        self.assertAlmostEqual(self.form._fields[("fog", "sigma")].value(), 0.4)
        self.assertEqual(self.form._bg.currentData(), "background-night.png")
        self.assertFalse(self.panel.is_pending_dirty(), "只是选中一行不许标脏")

    def test_editing_a_fog_field_writes_only_that_field(self) -> None:
        self.form._fields[("fog", "sigma")].setValue(0.75)
        self.assertTrue(self.panel.is_pending_dirty())
        v = self._written()
        self.assertAlmostEqual(v["lighting"]["fog"]["sigma"], 0.75)
        self.assertEqual(v["lighting"]["fog"]["color"], [0.1, 0.1, 0.2], "块里没显示的键要原样带回")
        self.assertEqual(v["lightEnv"], {"legacy": 1}, "变体里面板不认识的键要原样带回")
        self.assertEqual(v["backgrounds"][0]["image"], "background-night.png")

    def test_partial_block_shows_day_values_and_is_completed_on_first_edit(self) -> None:
        """手写的半块（只有 sigma）：运行时整块替换，缺的字段夜里就没有值。
        显示用白天兜底、不动数据；一改就把这块写全。"""
        self.assertEqual(self.form._fields[("fog", "scaleHeight")].value(), 530.0)
        self.assertNotIn("scaleHeight", self._written()["lighting"]["fog"], "只看不改不许补字段")
        self.form._fields[("fog", "scatter")].setValue(0.5)
        fog = self._written()["lighting"]["fog"]
        self.assertEqual(fog["scaleHeight"], 530.0)
        self.assertEqual(fog["kelvin"], 7000.0)
        self.assertAlmostEqual(fog["scatter"], 0.5)
        self.assertAlmostEqual(fog["sigma"], 0.4, msg="原有字段不动")
        self.assertEqual(fog["color"], [0.1, 0.1, 0.2], "面板不认识的键原样保留")

    def test_enabling_a_block_prefills_from_the_day_base(self) -> None:
        self.form._block_cb["sky"].setChecked(True)
        v = self._written()
        self.assertEqual(v["lighting"]["sky"], _BASE_LIGHTING["sky"], "勾上那一刻从白天基底预填")
        self.assertEqual(self.form._fields[("sky", "kelvin")].value(), 9000.0)
        self.form._fields[("sky", "intensity")].setValue(0.01)
        v = self._written()
        self.assertAlmostEqual(v["lighting"]["sky"]["intensity"], 0.01)
        self.assertEqual(v["lighting"]["sky"]["kelvin"], 9000, "没改的整数不许漂成 float")

    def test_disabling_a_block_drops_the_key(self) -> None:
        self.form._block_cb["fog"].setChecked(False)
        v = self._written()
        self.assertNotIn("lighting", v, "最后一块也去掉时整个 lighting 键都不该留")

    def test_scalar_blocks_and_tonemap_choice(self) -> None:
        self.form._block_cb["aoStrength"].setChecked(True)
        self.form._fields[("aoStrength", "")].setValue(0.3)
        self.form._block_cb["display"].setChecked(True)
        combo = self.form._fields[("display", "tonemap")]
        combo.setCurrentIndex(combo.findData("reinhard"))
        v = self._written()
        self.assertAlmostEqual(v["lighting"]["aoStrength"], 0.3)
        self.assertEqual(v["lighting"]["display"]["tonemap"], "reinhard")
        self.assertEqual(v["lighting"]["display"]["contrast"], 0.85)

    def test_background_choice_and_inherit(self) -> None:
        self.form._bg.setCurrentIndex(self.form._bg.findData("background.png"))
        self.assertEqual(self._written()["backgrounds"][0]["image"], "background.png")
        self.form._bg.setCurrentIndex(self.form._bg.findData(""))
        self.assertNotIn("backgrounds", self._written())

    def test_bgm_filter_ambient_are_tristate(self) -> None:
        self.form._bgm_cb.setChecked(True)
        self.assertEqual(self.form._bgm.current_id(), "bgm_day", "勾上先预填白天的 BGM")
        self.form._bgm.set_current("")
        self.form._on_scalar_key("bgm", "")
        self.form._filter_cb.setChecked(True)
        self.form._filter.set_current("f_night")
        self.form._on_scalar_key("filterId", "f_night")
        self.form._amb_cb.setChecked(True)
        self.assertEqual(self.form._amb_ids(), ["amb_street"], "勾上先预填白天的环境音")
        self.form._amb_list.setCurrentRow(0)
        self.form._remove_ambient()
        v = self._written()
        self.assertEqual(v["bgm"], "", "覆盖成空 = 该时段无 BGM，键要在")
        self.assertEqual(v["filterId"], "f_night")
        self.assertEqual(v["ambientSounds"], [], "覆盖成空列表 = 该时段静音，键要在")
        self.form._bgm_cb.setChecked(False)
        self.form._amb_cb.setChecked(False)
        v = self._written()
        self.assertNotIn("bgm", v)
        self.assertNotIn("ambientSounds", v)

    def test_depth_override_copies_the_whole_day_config(self) -> None:
        self.form._depth_cb.setChecked(True)
        self.form._depth_map.set_current("raw_depth_night.png")
        self.form._on_depth_field("depth_map", "raw_depth_night.png")
        self.form._depth_tol.setValue(0.25)
        v = self._written()
        dc = v["depthConfig"]
        self.assertEqual(dc["depth_map"], "raw_depth_night.png")
        self.assertEqual(dc["M"], _scene()["depthConfig"]["M"], "整份复制，M/映射/shader 都在")
        self.assertAlmostEqual(dc["depth_tolerance"], 0.25)

    def test_depth_override_refuses_without_a_day_config(self) -> None:
        self.panel._staging_scene.pop("depthConfig", None)
        with patch.object(QMessageBox, "information", return_value=None) as info:
            self.form._depth_cb.setChecked(True)
        info.assert_called_once()
        self.assertFalse(self.form._depth_cb.isChecked())
        self.assertNotIn("depthConfig", self._written())

    def test_table_summary_says_what_is_overridden(self) -> None:
        self.form._bgm_cb.setChecked(True)
        self.form._amb_cb.setChecked(True)
        cell = self.panel._sc_tv_table.item(0, 2).text()
        for needle in ("环境：fog", "BGM=bgm_day", "环境音×1", "另有 lightEnv"):
            self.assertIn(needle, cell)
        self.assertEqual(variant_summary({}), "—")

    def test_add_phase_dialog_opens_and_selects_the_new_row(self) -> None:
        """此前这一按就 AttributeError（面板没有 `_scene_id`），什么都不发生。"""
        from PySide6.QtWidgets import QDialog
        with patch.object(QDialog, "exec", return_value=QDialog.DialogCode.Accepted):
            self.panel._on_tv_add()
        self.assertIn("午", self.panel._time_variants, "弹窗里第一个时段 + 第一张图")
        self.assertEqual(self.panel._tv_selected_phase(), "午")
        self.assertEqual(self.form.phase_id, "午")

    def test_switching_scene_clears_the_form(self) -> None:
        other = dict(_scene(), id="sc_a", timeVariants={})
        self.panel.load_scene_props(other)
        self.assertEqual(self.form.phase_id, "")
        self.assertFalse(self.form.isEnabled())


class PhaseSyncSplitTests(_Base):
    def test_split_puts_env_diffs_into_variant_and_lights_into_base(self) -> None:
        base = copy.deepcopy(_BASE_LIGHTING)
        pulled = copy.deepcopy(base)
        pulled["fog"]["sigma"] = 0.5                     # 夜里改了雾
        pulled["lights"][0]["intensity"] = 2.0           # 也动了灯
        pulled["shadowBias"] = {"bias": 1.0}             # 非环境块
        new_base, override = scene_lights.split_phase_pull(pulled, base, {"sky": {"intensity": 0.02}})
        self.assertEqual(override, {"fog": pulled["fog"]}, "只有与基底不同的环境块进变体")
        self.assertNotIn("sky", override, "变体里原有、但游戏里已调回白天值的块要去掉")
        self.assertEqual(new_base["lights"][0]["intensity"], 2.0)
        self.assertEqual(new_base["shadowBias"], {"bias": 1.0})
        self.assertEqual(new_base["fog"], base["fog"], "基底的雾不动")

    def test_merge_mirrors_runtime_semantics(self) -> None:
        merged = scene_lights.merge_lighting_for_phase(
            _BASE_LIGHTING, {"fog": {"sigma": 9}, "lights": [], "aoStrength": None})
        self.assertEqual(merged["fog"], {"sigma": 9}, "整块替换，不深合并")
        self.assertEqual(merged["lights"], _BASE_LIGHTING["lights"], "lights 永远取基底")
        self.assertEqual(merged["aoStrength"], 1.0, "None 不覆盖")
        self.assertIsNone(scene_lights.merge_lighting_for_phase(None, {"fog": {}}))

    def test_validate_no_longer_refuses_a_phase_but_reports_it(self) -> None:
        payload = {"sceneId": _SID, "phase": "夜", "lighting": copy.deepcopy(_BASE_LIGHTING)}
        lit, err = scene_lights.validate_pulled_lighting(payload, _SID)
        self.assertIsNotNone(lit)
        self.assertEqual(err, "")
        self.assertEqual(scene_lights.pulled_phase(payload), "夜")
        self.assertEqual(scene_lights.pulled_phase({"sceneId": _SID}), "")

    def test_panel_apply_pulled_at_night_lands_in_the_variant(self) -> None:
        panel = ScenePropertyPanel(self.model)
        try:
            panel.load_scene_props(self.model.scenes[_SID])
            pulled = copy.deepcopy(_BASE_LIGHTING)
            pulled["display"]["ev"] = -2.0
            pulled["fog"]["sigma"] = 0.0          # 与白天相同 → 变体里原来的 fog 覆盖要被清掉
            pulled["lights"].append({"id": "lamp_night", "kind": "point", "pos": [1.0, 2.0, 3.0],
                                     "range": 100.0, "intensity": 1.0, "kelvin": 2000.0})
            panel.apply_pulled_lighting(pulled, "夜")
            sc = copy.deepcopy(panel._staging_scene)
            panel._flush_scene_widgets_into(sc)
            panel._writeback_scene_lights(sc)
            night = sc["timeVariants"]["夜"]["lighting"]
            self.assertEqual(night, {"display": pulled["display"]})
            self.assertEqual(sc["lighting"]["display"]["ev"], 0.0, "白天基底的 ev 不许被夜值灌进来")
            self.assertEqual([l["id"] for l in sc["lighting"]["lights"]], ["lamp_a", "lamp_night"])
            merged = panel.sync_lighting_snapshot("夜")
            self.assertEqual(merged["display"]["ev"], -2.0, "发给夜里的游戏的是合并结果")
            self.assertEqual(panel.sync_lighting_snapshot("")["display"]["ev"], 0.0)
        finally:
            panel.deleteLater()


class NewCanvasBridgeTests(_Base):
    def test_variant_edit_becomes_an_undoable_command(self) -> None:
        page = SceneEditorV2(self.model)
        try:
            page.load_scene(_SID)
            panel = page._props
            panel._select_tv_row("夜")
            panel._tv_form._fields[("fog", "sigma")].setValue(0.9)
            self._app.processEvents()
            sc = self.model.scenes[_SID]
            self.assertAlmostEqual(sc["timeVariants"]["夜"]["lighting"]["fog"]["sigma"], 0.9,
                                   "新画布上表单编辑要经桥落进模型")
            self.assertEqual(sc["timeVariants"]["夜"]["lightEnv"], {"legacy": 1})
            page.document.undo_stack.undo()
            self.assertAlmostEqual(self.model.scenes[_SID]["timeVariants"]["夜"]["lighting"]["fog"]["sigma"], 0.4)
        finally:
            page.deleteLater()
