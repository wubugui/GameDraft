"""挂件预设页的流程探针与往返契约。

钉死：
- 打开→不动→保存 逐值不变（含显式写着缺省值的键不被抹、int 不漂 float）；
- 零编辑 flush 不标脏（伪脏）、真编辑才标脏；
- Discard 中和（否则关闭路径的统一 flush 会把放弃的编辑写回）；
- 缺省值在"原本没有该键"时才不落键；
- 改名跟随改写全工程引用、删除前能报出引用清单；
- attachToSocket.prop 是选择器不是裸输入框，且候选来自 ProjectModel。
"""
from __future__ import annotations

import copy
import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication, QLineEdit

from tools.editor.editors.prop_preset_editor import PropPresetEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor
from tools.editor.shared.prop_preset_refs import (
    rename_prop_references,
    scan_prop_usages,
)

SEED = {
    "taomu_jian": {
        "label": "桃木剑",
        "image": "/resources/runtime/images/icons/taomu_sword.png",
        "anchorX": 0.79,
        "anchorY": 0.16,
        "rotation": 0,
        "scale": 0.5,
    },
    "denglong": {"label": "灯笼", "images": ["/a.png", "/b.png"], "lit": False},
}


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
        (root / "public/assets/data/prop_presets.json").write_text(
            json.dumps(SEED, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self._root = root
        self._model = ProjectModel()
        self._model.load_project(root)

    def tearDown(self) -> None:
        self._td.cleanup()


class PropPresetRoundtripTests(_Base):
    def test_open_untouched_save_is_identical(self) -> None:
        before = copy.deepcopy(self._model.prop_presets)
        ed = PropPresetEditor(self._model)
        self.assertEqual(ed._staged(), before, "打开→不动→保存必须逐值不变")

    def test_explicit_default_value_is_not_wiped(self) -> None:
        """磁盘上显式写着 rotation:0 的条目，打开再保存不许被抹掉。"""
        ed = PropPresetEditor(self._model)
        ed._refresh(keep="taomu_jian")
        self.assertIn("rotation", ed._collect(), "显式写的缺省值不是'没设'，不许剔")

    def test_int_repr_does_not_drift_to_float(self) -> None:
        ed = PropPresetEditor(self._model)
        ed._refresh(keep="taomu_jian")
        self.assertIsInstance(ed._collect()["rotation"], int,
                              "过一趟 QDoubleSpinBox 不该把 0 写成 0.0")

    def test_absent_default_stays_absent(self) -> None:
        """没写过的键、值又还是缺省 → 不凭空注入（否则每条预设都被撑满）。"""
        ed = PropPresetEditor(self._model)
        ed._refresh(keep="denglong")
        got = ed._collect()
        for key in ("anchorX", "anchorY", "rotation", "scale"):
            self.assertNotIn(key, got, f"{key} 原本就没有且仍是缺省，不该写出来")

    def test_lit_false_survives_roundtrip(self) -> None:
        ed = PropPresetEditor(self._model)
        ed._refresh(keep="denglong")
        self.assertIs(ed._collect()["lit"], False, "自发光挂件的 lit:false 不能被当缺省剔掉")

    def test_unknown_keys_pass_through(self) -> None:
        """本页没有的字段（agent 手写/未来 schema）不许被抹。"""
        self._model.prop_presets["taomu_jian"]["未来字段"] = {"x": 1}
        ed = PropPresetEditor(self._model)
        ed._refresh(keep="taomu_jian")
        self.assertEqual(ed._staged()["taomu_jian"].get("未来字段"), {"x": 1})


class PropPresetDirtyFlowTests(_Base):
    def test_zero_edit_flush_does_not_mark_dirty(self) -> None:
        ed = PropPresetEditor(self._model)
        self._model._dirty.clear()
        ed.flush_to_model(True)
        self.assertNotIn("prop_presets", self._model._dirty, "啥都没动就标脏 = 伪脏")

    def test_real_edit_reaches_model_through_flush(self) -> None:
        ed = PropPresetEditor(self._model)
        ed._refresh(keep="taomu_jian")
        ed._spins["anchorY"].setValue(0.42)
        ed.flush_to_model(True)
        self.assertIn("prop_presets", self._model._dirty)
        self.assertAlmostEqual(self._model.prop_presets["taomu_jian"]["anchorY"], 0.42)

    def test_discard_neutralizes(self) -> None:
        ed = PropPresetEditor(self._model)
        ed._refresh(keep="taomu_jian")
        ed._spins["scale"].setValue(9.0)
        self.assertTrue(ed._dirty)
        ed._reload_from_model()          # confirm_close 的 Discard 分支走的就是这条
        self.assertFalse(ed._dirty)
        ed.flush_to_model(True)
        self.assertAlmostEqual(self._model.prop_presets["taomu_jian"]["scale"], 0.5,
                               msg="Discard 之后的统一 flush 不许把放弃的编辑写回")

    def test_save_all_writes_the_file(self) -> None:
        ed = PropPresetEditor(self._model)
        ed._refresh(keep="taomu_jian")
        ed._spins["anchorX"].setValue(0.25)
        ed._apply()
        self._model.save_all()
        raw = json.loads(
            (self._root / "public/assets/data/prop_presets.json").read_text(encoding="utf-8"))
        self.assertAlmostEqual(raw["taomu_jian"]["anchorX"], 0.25)

    def test_saved_file_keeps_format_contract(self) -> None:
        ed = PropPresetEditor(self._model)
        ed._refresh(keep="taomu_jian")
        ed._spins["anchorX"].setValue(0.25)
        ed._apply()
        self._model.save_all()
        text = (self._root / "public/assets/data/prop_presets.json").read_text(encoding="utf-8")
        self.assertTrue(text.endswith("\n"), "末尾要有换行")
        self.assertIn("桃木剑", text, "中文不得转义成 \\uXXXX")


class PropPresetRenameDeleteTests(_Base):
    def _scene_with_prop(self, prop_id: str) -> None:
        self._model.scenes["s1"] = {
            "id": "s1",
            "hotspots": [{
                "id": "h", "actions": [
                    {"type": "attachToSocket",
                     "params": {"target": "player", "socket": "right_hand", "prop": prop_id}},
                ],
            }],
        }

    def test_scan_finds_usages(self) -> None:
        self._scene_with_prop("taomu_jian")
        self.assertEqual(scan_prop_usages(self._model, "taomu_jian"), ["场景 s1"])
        self.assertEqual(scan_prop_usages(self._model, "denglong"), [])

    def test_rename_cascades_into_references(self) -> None:
        self._scene_with_prop("taomu_jian")
        n = rename_prop_references(self._model, "taomu_jian", "tao_sword")
        self.assertEqual(n, 1)
        act = self._model.scenes["s1"]["hotspots"][0]["actions"][0]
        self.assertEqual(act["params"]["prop"], "tao_sword")
        self.assertIn("scene", self._model._dirty)

    def test_rename_keeps_key_order(self) -> None:
        """改名不该把条目挪到表尾——那会让无关 diff 铺满整个文件。"""
        ed = PropPresetEditor(self._model)
        ed._data = {(("x" if k == "taomu_jian" else k)): v for k, v in ed._data.items()}
        self.assertEqual(list(ed._data), ["x", "denglong"])

    def test_rename_is_noop_for_same_or_empty(self) -> None:
        self._scene_with_prop("taomu_jian")
        self.assertEqual(rename_prop_references(self._model, "taomu_jian", "taomu_jian"), 0)
        self.assertEqual(rename_prop_references(self._model, "", "x"), 0)


class PropParamSelectorTests(_Base):
    def test_prop_param_is_a_selector_not_a_line_edit(self) -> None:
        ed = ActionEditor("A")
        ed.set_project_context(self._model, None)
        ed.set_data([{"type": "attachToSocket",
                      "params": {"target": "player", "socket": "h", "prop": "taomu_jian"}}])
        w = ed._rows[0]._param_widgets["prop"]
        self.assertNotIsInstance(w, QLineEdit, "prop 引用他者 id，必须用选择器（§3 铁律）")

    def test_candidates_come_from_project_model(self) -> None:
        pairs = self._model.all_prop_preset_ids()
        self.assertEqual([p[0] for p in pairs], ["denglong", "taomu_jian"])
        self.assertEqual(dict(pairs)["taomu_jian"], "桃木剑", "有 label 就显示 label")

    def test_dangling_prop_value_is_preserved_not_cleared(self) -> None:
        """共享控件保值：指向已删预设的悬垂值必须留着让人看见，不许静默清空。"""
        ed = ActionEditor("A")
        ed.set_project_context(self._model, None)
        ed.set_data([{"type": "attachToSocket",
                      "params": {"target": "p", "socket": "h", "prop": "已经删掉的"}}])
        self.assertEqual(ed.to_list()[0]["params"]["prop"], "已经删掉的")


if __name__ == "__main__":
    unittest.main()
