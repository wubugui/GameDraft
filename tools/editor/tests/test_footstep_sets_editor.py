"""脚步集编辑器（footstep_sets.json）契约测试。

锁定的形状：
1. **黄金往返**：打开-逐集浏览-不改-保存，模型内容与**未知键**、以及数值的
   int/float 原始表示全部不变（`json.dumps` 逐字节比较，150 不许漂成 150.0，
   `planarDepthScale` 不许被 6 位小数的 spinbox 舍成 1.414214）。
2. 各字段编辑确实落进 dict；空值 / 取消勾选是**删键**，不是写空串或写 0。
3. 每集 `sfx` 是「片段名 → **一条**音效 key」：选择器改值落进 dict、片段增删改名保键序、
   没选 key 的条目一眼看得出；异形数据（值不是字符串、旧 `variants` 键）只透传不改写。
4. 本页**不配触地帧**：数据里没有 contactFrames，页面上也没有那张表。
5. sets 增 / 删 / 改名（改名保原键序）。
6. `ProjectModel.all_footstep_set_ids()` 返回 (id, label)。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PySide6.QtWidgets import QApplication, QMessageBox

from tools.editor.editors.footstep_sets_editor import FootstepSetsEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

#: 覆盖全部结构 + 每一层都埋一个编辑器不认识的键（必须原样透传）。
FIXTURE: dict = {
    "schemaNote": "顶层未知键：编辑器不认识，必须原样透传",
    "sets": {
        "stone": {
            "label": "石板路",
            "sfx": {
                "walk": "fs_stone_a",
                "run": "fs_stone_run",
            },
            "gainDb": -3,
            "futureSetKnob": {"keep": True},
        },
        "wood": {
            "sfx": {"walk": "fs_wood_a"},
        },
    },
    "clipFallback": {"carry_walk": "walk", "crouchWalk": "walk"},
    "defaults": {"gainDb": -6},
    "spatial": {
        "refDistanceWu": 150,
        "rolloff": 1,
        "maxDistanceWu": 3000,
        "panWidth": 0.7,
        "listenerBackAtBaseZoomWu": 600,
        "planarDepthScale": 1.4142135623730951,
        "futureSpatialKnob": 7,
    },
    "listener": {"mode": "camera", "futureListenerKnob": "x"},
}


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list = []
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        for target, value in (
            ("tools.editor.shared.confirm.confirm_delete", True),
            ("tools.editor.editors.footstep_sets_editor.QMessageBox.information", None),
            ("tools.editor.editors.footstep_sets_editor.QMessageBox.warning", None),
            ("tools.editor.editors.footstep_sets_editor.QMessageBox.question",
             QMessageBox.StandardButton.Yes),
        ):
            p = patch(target, return_value=value)
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self) -> None:
        for ed in self._editors:
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _editor(self, data: dict | None = None) -> tuple[FootstepSetsEditor, ProjectModel]:
        root = Path(self._tmp.name) / "p"
        if not root.exists():
            write_minimal_loadable_project(root)
        dp = root / "public" / "assets" / "data"
        payload = FIXTURE if data is None else data
        (dp / "footstep_sets.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        model = ProjectModel()
        model.load_project(root)
        ed = FootstepSetsEditor(model)
        self._editors.append(ed)
        return ed, model

    @staticmethod
    def _blob(obj: object) -> str:
        """字节级比较用：json.dumps 会把 150 与 150.0 渲染成不同文本。"""
        return json.dumps(obj, ensure_ascii=False, sort_keys=True)

    @staticmethod
    def _clip_texts(ed: FootstepSetsEditor) -> list[str]:
        return [ed._clip_list.item(i).text() for i in range(ed._clip_list.count())]

    @staticmethod
    def _pick_sfx(ed: FootstepSetsEditor, aid: str) -> None:
        """模拟在选择窗里选了一条 key（弹窗本身在 offscreen 下会挂住，直接走它的回调）。"""
        ed._sfx_selector.set_current(aid)
        ed._on_sfx_changed(aid)


class GoldenRoundtripTests(_Base):
    def test_open_browse_save_changes_nothing(self) -> None:
        ed, model = self._editor()
        before = self._blob(model.footstep_sets)
        for row in range(ed._set_list.count()):
            ed._set_list.setCurrentRow(row)
            for c in range(ed._clip_list.count()):
                ed._clip_list.setCurrentRow(c)
        self.assertFalse(ed._is_dirty(), "纯浏览不许判脏（否则 Save All 会自动改写文件）")
        self.assertTrue(ed.flush_to_model())
        self.assertEqual(self._blob(model.footstep_sets), before)
        self.assertFalse(model.is_dirty, "纯浏览不许标脏桶")

    def test_unknown_keys_survive_a_real_edit(self) -> None:
        ed, model = self._editor()
        ed._set_list.setCurrentRow(0)
        ed._f_label.setText("青石板")
        ed._spatial_rows["rolloff"].spin.setValue(1.5)
        self.assertTrue(ed._apply())
        data = model.footstep_sets
        self.assertEqual(data["schemaNote"], FIXTURE["schemaNote"])
        self.assertEqual(data["sets"]["stone"]["futureSetKnob"], {"keep": True})
        self.assertEqual(data["spatial"]["futureSpatialKnob"], 7)
        self.assertEqual(data["listener"]["futureListenerKnob"], "x")

    def test_untouched_numbers_keep_int_and_full_precision(self) -> None:
        ed, model = self._editor()
        ed._set_list.setCurrentRow(0)
        ed._f_label.setText("青石板")  # 只改一个字符串，数值一个没动
        self.assertTrue(ed._apply())
        spatial = model.footstep_sets["spatial"]
        self.assertIsInstance(spatial["refDistanceWu"], int)
        self.assertIsInstance(spatial["rolloff"], int)
        self.assertEqual(spatial["planarDepthScale"], 1.4142135623730951)
        self.assertIsInstance(model.footstep_sets["defaults"]["gainDb"], int)
        self.assertIsInstance(model.footstep_sets["sets"]["stone"]["gainDb"], int)

    def test_malformed_sfx_values_are_passed_through_not_rewritten(self) -> None:
        """异形数据（值不是字符串）本页只透传——不许静默改写成 "" 或 "5"。"""
        data = json.loads(json.dumps(FIXTURE))
        data["sets"]["stone"]["sfx"]["oops"] = ["fs_a", "fs_b"]
        data["sets"]["stone"]["sfx"]["num"] = 5
        ed, model = self._editor(data)
        before = self._blob(model.footstep_sets)
        ed._set_list.setCurrentRow(0)
        for c in range(ed._clip_list.count()):
            ed._clip_list.setCurrentRow(c)
        self.assertFalse(ed._is_dirty(), "异形数据不许把页面判成永远脏（Save All 会毁数据）")
        self.assertTrue(ed.flush_to_model())
        self.assertEqual(self._blob(model.footstep_sets), before)
        # 异形条目在 UI 上说得明明白白，且改不动
        self.assertTrue(any("数据不是字符串" in t for t in self._clip_texts(ed)))
        ed._clip_list.setCurrentRow(self._clip_texts(ed).index(
            next(t for t in self._clip_texts(ed) if "oops" in t)))
        self.assertFalse(ed._sfx_selector.isEnabled())

    def test_legacy_variants_key_is_passed_through_untouched(self) -> None:
        """旧形状 `variants`（变体数组）本页不认识：不删、不改、不判脏——校验器会报它。"""
        data = json.loads(json.dumps(FIXTURE))
        data["sets"]["wood"] = {"variants": {"walk": ["a", "b"]}}
        ed, model = self._editor(data)
        before = self._blob(model.footstep_sets)
        ed._set_list.setCurrentRow(1)
        self.assertEqual(ed._clip_list.count(), 0)
        self.assertFalse(ed._is_dirty())
        self.assertTrue(ed.flush_to_model())
        self.assertEqual(self._blob(model.footstep_sets), before)

    def test_missing_file_loads_as_empty_and_writes_nothing(self) -> None:
        root = Path(self._tmp.name) / "empty"
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        self.assertEqual(model.footstep_sets, {})
        ed = FootstepSetsEditor(model)
        self._editors.append(ed)
        self.assertFalse(ed._is_dirty())
        self.assertTrue(ed.flush_to_model())
        self.assertEqual(model.footstep_sets, {})
        self.assertFalse(model.is_dirty)

    def test_page_has_no_contact_frame_table(self) -> None:
        """触地帧在动画浏览页标（sockets.json contactSlots），本页不能再长出那张表。"""
        ed, _model = self._editor()
        self.assertFalse(hasattr(ed, "_cf_table"))
        self.assertNotIn("contactFrames", _model_keys(ed))


def _model_keys(ed: FootstepSetsEditor) -> set[str]:
    test = json.loads(json.dumps(ed._data))
    ed._write_all_into(test)
    return set(test.keys())


class FieldEditingTests(_Base):
    def test_label_and_gain_land(self) -> None:
        ed, model = self._editor()
        ed._set_list.setCurrentRow(1)  # wood
        self.assertEqual(ed._current_set, "wood")
        ed._f_label.setText("木栈道")
        ed._set_num_rows["gainDb"].check.setChecked(True)
        ed._set_num_rows["gainDb"].spin.setValue(-4.5)
        self.assertTrue(ed._apply())
        wood = model.footstep_sets["sets"]["wood"]
        self.assertEqual(wood["label"], "木栈道")
        self.assertEqual(wood["gainDb"], -4.5)
        self.assertTrue(model.is_dirty)

    def test_empty_label_and_unchecked_number_delete_the_key(self) -> None:
        ed, model = self._editor()
        ed._set_list.setCurrentRow(0)  # stone: 有 label 与 gainDb
        ed._f_label.setText("   ")
        ed._set_num_rows["gainDb"].check.setChecked(False)
        self.assertTrue(ed._apply())
        stone = model.footstep_sets["sets"]["stone"]
        self.assertNotIn("label", stone, "空值必须删键，不是写空串")
        self.assertNotIn("gainDb", stone, "取消勾选必须删键，不是写 0")

    def test_pick_sfx_key_for_a_clip(self) -> None:
        ed, model = self._editor()
        ed._set_list.setCurrentRow(0)
        ed._clip_list.setCurrentRow(0)  # walk → fs_stone_a
        self.assertEqual(ed._current_clip, "walk")
        self.assertEqual(ed._sfx_selector.current_id(), "fs_stone_a")
        self._pick_sfx(ed, "fs_stone_c")
        self.assertTrue(ed._is_dirty())
        self.assertTrue(ed._apply())
        self.assertEqual(model.footstep_sets["sets"]["stone"]["sfx"],
                         {"walk": "fs_stone_c", "run": "fs_stone_run"},
                         "一个片段一条 key，改的只是 walk 这一条，键序不变")
        self.assertIn("fs_stone_c", self._clip_texts(ed)[0])

    def test_clip_add_rename_delete_keeps_key_order(self) -> None:
        ed, model = self._editor()
        ed._set_list.setCurrentRow(0)
        with patch("tools.editor.editors.footstep_sets_editor.QInputDialog.getText",
                   return_value=("carry_walk", True)):
            ed._add_clip()
        self.assertEqual(list(ed._sfx), ["walk", "run", "carry_walk"])
        self.assertEqual(ed._current_clip, "carry_walk")
        self.assertEqual(ed._sfx["carry_walk"], "")
        self.assertTrue(any("没选音效" in t for t in self._clip_texts(ed)),
                        "刚加的条目还没选 key，列表里必须一眼看见")
        self._pick_sfx(ed, "fs_stone_heavy")

        ed._clip_list.setCurrentRow(0)
        with patch("tools.editor.editors.footstep_sets_editor.QInputDialog.getText",
                   return_value=("slow_walk", True)):
            ed._rename_clip()
        self.assertEqual(list(ed._sfx), ["slow_walk", "run", "carry_walk"],
                         "改名必须保原键序，不能把这一条挪到最后")
        self.assertEqual(ed._sfx["slow_walk"], "fs_stone_a", "改名不能丢值")

        ed._clip_list.setCurrentRow(1)
        ed._delete_clip()
        self.assertTrue(ed._apply())
        self.assertEqual(
            model.footstep_sets["sets"]["stone"]["sfx"],
            {"slow_walk": "fs_stone_a", "carry_walk": "fs_stone_heavy"},
        )

    def test_unset_key_is_visible_at_a_glance(self) -> None:
        data = json.loads(json.dumps(FIXTURE))
        data["sets"]["wood"]["sfx"]["run"] = ""
        ed, _model = self._editor(data)
        ed._set_list.setCurrentRow(1)
        texts = self._clip_texts(ed)
        self.assertIn("→  fs_wood_a", next(t for t in texts if t.startswith("walk")))
        self.assertIn("没选音效", next(t for t in texts if "run" in t))
        self.assertIn("没选音效", ed._set_list.item(1).text(), "集列表里也要看得见")
        ed._clip_list.setCurrentRow(1)
        self.assertIn("不响", ed._sfx_hint.text())

    def test_switching_sets_refreshes_selector_even_when_clip_names_collide(self) -> None:
        """两集都有 walk：从 stone 切到 wood，右侧必须显示 wood 的 key（截图里抓到过挂着旧值）。"""
        ed, _model = self._editor()
        ed._set_list.setCurrentRow(0)
        ed._clip_list.setCurrentRow(0)
        self.assertEqual(ed._sfx_selector.current_id(), "fs_stone_a")
        self.assertTrue(ed.select_by_id("wood"))
        self.assertEqual(ed._current_clip, "walk")
        self.assertEqual(ed._sfx_selector.current_id(), "fs_wood_a")
        self.assertIn("fs_wood_a", ed._sfx_hint.text())
        self.assertFalse(ed._is_dirty(), "只是切集浏览，不许判脏")

    def test_unregistered_key_hint(self) -> None:
        """key 没在 audio_config 登记 → 提示去 Audio 页登记（运行时对未知 key 完全静默）。"""
        ed, _model = self._editor()
        ed._set_list.setCurrentRow(0)
        ed._clip_list.setCurrentRow(0)
        self.assertIn("没登记", ed._sfx_hint.text())

    def test_clip_fallback_table_roundtrips_and_edits(self) -> None:
        ed, model = self._editor()
        ed._fb_table.item(0, 1).setText("run")
        ed._add_table_row(ed._fb_table)
        r = ed._fb_table.rowCount() - 1
        ed._fb_table.item(r, 0).setText("slow_walk")
        ed._fb_table.item(r, 1).setText("walk")
        self.assertTrue(ed._apply())
        self.assertEqual(
            model.footstep_sets["clipFallback"],
            {"carry_walk": "run", "crouchWalk": "walk", "slow_walk": "walk"},
        )

    def test_half_filled_fallback_row_blocks_apply(self) -> None:
        ed, model = self._editor()
        before = self._blob(model.footstep_sets)
        ed._add_table_row(ed._fb_table)
        r = ed._fb_table.rowCount() - 1
        ed._fb_table.item(r, 0).setText("slow_walk")
        self.assertTrue(ed._is_dirty(), "改坏的行也算未提交的编辑")
        self.assertFalse(ed._apply(), "半空行必须整体拒绝")
        self.assertEqual(self._blob(model.footstep_sets), before)

    def test_spatial_and_defaults_edits_land(self) -> None:
        ed, model = self._editor()
        ed._spatial_rows["maxDistanceWu"].spin.setValue(4000)
        ed._spatial_rows["panWidth"].check.setChecked(False)
        ed._default_rows["gainDb"].spin.setValue(-8)
        self.assertTrue(ed._apply())
        spatial = model.footstep_sets["spatial"]
        self.assertEqual(spatial["maxDistanceWu"], 4000)
        self.assertNotIn("panWidth", spatial)
        self.assertEqual(model.footstep_sets["defaults"]["gainDb"], -8)

    def test_max_distance_warning_fires_when_too_close_to_listener_back(self) -> None:
        ed, _model = self._editor()
        self.assertEqual(ed._spatial_warn.text(), "", "3000 wu 远大于 600 wu，不该报警")
        ed._spatial_rows["maxDistanceWu"].spin.setValue(600)
        self.assertIn("maxDistanceWu", ed._spatial_warn.text())
        self.assertFalse(ed._spatial_warn.isHidden())

    def test_listener_mode_switch_writes_target_and_keeps_unknown(self) -> None:
        ed, model = self._editor()
        ed._listener_mode.setCurrentIndex(ed._listener_mode.findData("npc"))
        ed._listener_target.set_current("npc_zhang")
        ed._listener_rows["heightWu"].check.setChecked(True)
        ed._listener_rows["heightWu"].spin.setValue(120)
        self.assertTrue(ed._apply())
        listener = model.footstep_sets["listener"]
        self.assertEqual(listener["mode"], "npc")
        self.assertEqual(listener["targetId"], "npc_zhang")
        self.assertEqual(listener["heightWu"], 120)
        self.assertEqual(listener["futureListenerKnob"], "x")

    def test_listener_can_be_removed_entirely(self) -> None:
        ed, model = self._editor()
        ed._listener_enabled.setChecked(False)
        self.assertTrue(ed._apply())
        self.assertNotIn("listener", model.footstep_sets)

    def test_unknown_listener_mode_is_preserved_not_replaced(self) -> None:
        data = json.loads(json.dumps(FIXTURE))
        data["listener"]["mode"] = "someFutureMode"
        ed, model = self._editor(data)
        self.assertEqual(ed._listener_mode.currentData(), "someFutureMode")
        self.assertFalse(ed._is_dirty())
        self.assertTrue(ed.flush_to_model())
        self.assertEqual(model.footstep_sets["listener"]["mode"], "someFutureMode")


class SetListOpsTests(_Base):
    def test_add_set(self) -> None:
        ed, model = self._editor()
        with patch("tools.editor.editors.footstep_sets_editor.QInputDialog.getText",
                   return_value=("gravel", True)):
            ed._add_set()
        self.assertIn("gravel", model.footstep_sets["sets"])
        self.assertEqual(model.footstep_sets["sets"]["gravel"], {"sfx": {}})
        self.assertEqual(ed._current_set, "gravel")
        self.assertTrue(model.is_dirty)

    def test_add_set_rejects_duplicate_id(self) -> None:
        ed, model = self._editor()
        with patch("tools.editor.editors.footstep_sets_editor.QInputDialog.getText",
                   return_value=("stone", True)):
            ed._add_set()
        self.assertEqual(list(model.footstep_sets["sets"]), ["stone", "wood"])

    def test_rename_set_keeps_key_order_and_payload(self) -> None:
        ed, model = self._editor()
        ed._set_list.setCurrentRow(0)
        with patch("tools.editor.editors.footstep_sets_editor.QInputDialog.getText",
                   return_value=("stone_wet", True)):
            ed._rename_set()
        sets = model.footstep_sets["sets"]
        self.assertEqual(list(sets), ["stone_wet", "wood"], "改名必须保原键序")
        self.assertEqual(sets["stone_wet"]["sfx"]["run"], "fs_stone_run")
        self.assertEqual(sets["stone_wet"]["futureSetKnob"], {"keep": True})
        self.assertEqual(ed._current_set, "stone_wet")

    def test_delete_set_and_empty_state(self) -> None:
        ed, model = self._editor()
        ed._set_list.setCurrentRow(0)
        ed._delete_set()
        self.assertEqual(list(model.footstep_sets["sets"]), ["wood"])
        self.assertEqual(ed._current_set, "wood")
        ed._delete_set()
        self.assertEqual(model.footstep_sets["sets"], {})
        self.assertEqual(ed._current_set, "")
        self.assertFalse(ed._set_form_host.isEnabled(), "空表必须禁用表单，消除幽灵表单")

    def test_select_by_id_jumps_to_the_set(self) -> None:
        ed, _model = self._editor()
        self.assertTrue(ed.select_by_id("wood"))
        self.assertEqual(ed._current_set, "wood")
        self.assertFalse(ed.select_by_id("nope"))


class ProjectModelRegistrationTests(_Base):
    def test_all_footstep_set_ids(self) -> None:
        _ed, model = self._editor()
        self.assertEqual(
            model.all_footstep_set_ids(), [("stone", "石板路"), ("wood", "wood")],
        )

    def test_all_footstep_set_ids_tolerates_garbage(self) -> None:
        _ed, model = self._editor()
        model.footstep_sets = {"sets": {"a": None, "b": {"label": ""}}}
        self.assertEqual(model.all_footstep_set_ids(), [("a", "a"), ("b", "b")])
        model.footstep_sets = []  # type: ignore[assignment]
        self.assertEqual(model.all_footstep_set_ids(), [])

    def test_bucket_is_registered_end_to_end(self) -> None:
        _ed, model = self._editor()
        self.assertIn("footstep_sets", ProjectModel.KNOWN_DIRTY_BUCKETS)
        model.footstep_sets["sets"]["wood"]["label"] = "木栈道"
        model.mark_dirty("footstep_sets")
        model.save_all()
        dp = Path(model.project_path) / "public" / "assets" / "data"  # type: ignore[arg-type]
        on_disk = json.loads((dp / "footstep_sets.json").read_text(encoding="utf-8"))
        self.assertEqual(on_disk["sets"]["wood"]["label"], "木栈道")
        self.assertEqual(on_disk["schemaNote"], FIXTURE["schemaNote"])

    def test_overlay_mirror_registered(self) -> None:
        from tools.editor.shared.lsp_client import overlay_mirrored_buckets, overlay_payloads

        self.assertIn("footstep_sets", overlay_mirrored_buckets())
        _ed, model = self._editor()
        out = overlay_payloads(model, "footstep_sets")
        self.assertEqual(len(out), 1)
        path, data = out[0]
        self.assertEqual(path.name, "footstep_sets.json")
        self.assertEqual(data, model.footstep_sets)


if __name__ == "__main__":
    unittest.main()
