"""K 组（注册表 / 配置 / 位面 / 动画）修复安全网。

覆盖：
- P1-04 角色注册表切页（reload_refs_from_model）不丢未 Apply 编辑；
- P1-13 flag 引用全工程扫描 + 改名连引用一起改 / 删除拦截；
- P2 ① 位面 extends 成环 / 缺父即时问题检测；
- P2 ② 位面反向引用计数；
- P2 ③ game_config 引用候选刷新保当前值；
- P2 ⑥ 玩家化身 showEvent 脏保护；
- P3 气味数值放宽后越界 / 多位小数往返保真；
- 全局契约 select_by_id 返回 bool。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _app() -> QApplication:
    return QApplication.instance() or QApplication(sys.argv)


def _loaded_model(root: Path) -> ProjectModel:
    write_minimal_loadable_project(root)
    m = ProjectModel()
    m.load_project(root)
    return m


class FlagReferenceScanTests(unittest.TestCase):
    """P1-13：flag key 全工程扫描与机械改名（纯函数，无 Qt 弹窗依赖）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()

    def _model(self, root: Path) -> ProjectModel:
        m = _loaded_model(root)
        m.flag_registry = {"static": [{"key": "f_target", "valueType": "bool"}], "patterns": []}
        m.quests = [{
            "id": "q1",
            "preconditions": [{"flag": "f_target", "value": True}],
            "acceptActions": [{"type": "setFlag", "params": {"key": "f_target", "value": True}}],
        }]
        m.game_config = {
            "startupFlags": {"f_target": True, "other": False},
            "initialCutsceneDoneFlag": "f_target",
        }
        m.scenes = {
            "sc_a": {
                "id": "sc_a",
                "hotspots": [{
                    "id": "h1",
                    "conditions": [{"flag": "f_target", "value": True}],
                    "data": {"actions": [
                        {"type": "runActions", "params": {"actions": [
                            {"type": "addFlagValue", "params": {"key": "f_target", "delta": 1}},
                        ]}},
                    ]},
                }],
                "zones": [], "npcs": [], "spawnPoints": {},
            }
        }
        m.scenarios_catalog = {"scenarios": [
            {"id": "s1", "phases": {}, "exposes": {"f_target": True}, "exposeAfterPhase": "p"},
        ]}
        m.pending_dialogue_graph_edits = {
            "g1": {"nodes": {"n1": {"type": "runActions", "actions": [
                {"type": "setFlag", "params": {"key": "f_target", "value": False}},
            ]}}},
        }
        return m

    def test_find_references_hits_all_sites(self) -> None:
        from tools.editor.editors.flag_registry_editor import find_flag_key_references
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            refs = find_flag_key_references(m, "f_target")
            joined = "\n".join(refs)
            # 条件叶 / setFlag / addFlagValue(嵌套) / startupFlags / initialCutsceneDoneFlag
            # / scenario.exposes / 图对话节点内 setFlag 都应命中。
            self.assertIn("条件叶.flag", joined)
            self.assertTrue(any("setFlag.key" in r for r in refs))
            self.assertTrue(any("addFlagValue.key" in r for r in refs))
            self.assertTrue(any("startupFlags[f_target]" in r for r in refs))
            self.assertTrue(any("initialCutsceneDoneFlag" in r for r in refs))
            self.assertTrue(any("exposes[f_target]" in r for r in refs))
            self.assertTrue(any("dialogueGraph:g1" in r for r in refs))
            # 无关键 other 不应被牵连
            self.assertFalse(any("other" in r for r in refs))

    def test_rename_rewrites_all_and_marks_buckets(self) -> None:
        from tools.editor.editors.flag_registry_editor import (
            find_flag_key_references,
            rename_flag_key_references,
        )
        with TemporaryDirectory() as td:
            m = self._model(Path(td) / "p")
            n = rename_flag_key_references(m, "f_target", "f_new")
            self.assertGreater(n, 0)
            # 旧键在全工程应清零，新键接手
            self.assertEqual(find_flag_key_references(m, "f_target"), [])
            self.assertTrue(find_flag_key_references(m, "f_new"))
            # 关键映射键被改名（保留其它键）
            self.assertIn("f_new", m.game_config["startupFlags"])
            self.assertIn("other", m.game_config["startupFlags"])
            self.assertNotIn("f_target", m.game_config["startupFlags"])
            self.assertEqual(m.game_config["initialCutsceneDoneFlag"], "f_new")
            # 图对话改动进 pending 暂存面并标脏
            self.assertEqual(
                m.pending_dialogue_graph_edits["g1"]["nodes"]["n1"]["actions"][0]["params"]["key"],
                "f_new",
            )
            self.assertIn("dialogue_graph_edits", m._dirty)
            self.assertIn("config", m._dirty)
            self.assertIn("scenarios", m._dirty)


class FlagRegistryGuardWiringTests(unittest.TestCase):
    """P1-13：Rename/Delete 按钮流程接上引用防护（打桩弹窗，验证分支效果）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()

    def _editor(self, root: Path):
        from tools.editor.editors.flag_registry_editor import FlagRegistryEditor
        m = _loaded_model(root)
        m.flag_registry = {"static": [{"key": "f_a", "valueType": "bool"}], "patterns": []}
        m.quests = [{"id": "q1", "preconditions": [{"flag": "f_a", "value": True}]}]
        ed = FlagRegistryEditor(m)
        ed.refresh_views()
        return ed, m

    def test_rename_all_rewrites_reference(self) -> None:
        from PySide6.QtWidgets import QInputDialog
        from unittest.mock import patch
        with TemporaryDirectory() as td:
            ed, m = self._editor(Path(td) / "p")
            ed.select_by_id("f_a")
            with patch.object(QInputDialog, "getText", return_value=("f_b", True)), \
                    patch.object(ed, "_confirm_rename_with_refs", return_value="all"):
                ed._rename_static()
            self.assertEqual(m.quests[0]["preconditions"][0]["flag"], "f_b",
                             "选『连引用一起改』必须机械替换引用处")
            keys = {e["key"] for e in m.flag_registry["static"]}
            self.assertIn("f_b", keys)
            self.assertNotIn("f_a", keys)

    def test_rename_registry_only_leaves_reference(self) -> None:
        from PySide6.QtWidgets import QInputDialog
        from unittest.mock import patch
        with TemporaryDirectory() as td:
            ed, m = self._editor(Path(td) / "p")
            ed.select_by_id("f_a")
            with patch.object(QInputDialog, "getText", return_value=("f_b", True)), \
                    patch.object(ed, "_confirm_rename_with_refs", return_value="registry"):
                ed._rename_static()
            self.assertEqual(m.quests[0]["preconditions"][0]["flag"], "f_a",
                             "选『仅改登记』不动引用（引用悬垂，仅登记改名）")
            self.assertIn("f_b", {e["key"] for e in m.flag_registry["static"]})

    def test_rename_cancel_keeps_everything(self) -> None:
        from PySide6.QtWidgets import QInputDialog
        from unittest.mock import patch
        with TemporaryDirectory() as td:
            ed, m = self._editor(Path(td) / "p")
            ed.select_by_id("f_a")
            with patch.object(QInputDialog, "getText", return_value=("f_b", True)), \
                    patch.object(ed, "_confirm_rename_with_refs", return_value="cancel"):
                ed._rename_static()
            self.assertEqual({e["key"] for e in m.flag_registry["static"]}, {"f_a"})

    def test_delete_blocked_by_confirm_no(self) -> None:
        from PySide6.QtWidgets import QMessageBox
        from unittest.mock import patch
        with TemporaryDirectory() as td:
            ed, m = self._editor(Path(td) / "p")
            # f_a 被 q1.preconditions 引用一次；删除前必须走引用感知确认框。
            ed.select_by_id("f_a")
            captured: dict[str, str] = {}

            def _fake_question(_parent, _title, text, *args, **kwargs):
                captured["text"] = text
                return QMessageBox.StandardButton.No

            with patch.object(QMessageBox, "question", side_effect=_fake_question):
                ed._delete_static()
            self.assertIn("f_a", {e["key"] for e in m.flag_registry["static"]},
                          "有引用时确认框选 No 必须保留 flag")
            # 假护栏堵漏：不仅拦删，确认框文案必须真是「引用感知」的——
            # 含引用计数（否则关掉引用扫描、退回裸 "Delete N flag(s)?" 也能通过）。
            self.assertIn("text", captured, "删除必须弹出确认框")
            body = captured["text"]
            self.assertIn("引用", body,
                          "被引用的 flag 删除确认框必须提示其仍被引用（引用感知）")
            self.assertIn("1 处引用", body,
                          "确认框必须给出真实引用计数（关掉引用扫描则退回无计数文案，护栏应咬住）")
            self.assertNotIn("Delete 1 flag(s)?", body,
                             "被引用时不得退回无引用信息的裸删除文案")

    def test_select_by_id_returns_bool(self) -> None:
        with TemporaryDirectory() as td:
            ed, _m = self._editor(Path(td) / "p")
            self.assertTrue(ed.select_by_id("f_a"))
            self.assertFalse(ed.select_by_id("nope"))


class CharacterRegistryReloadTests(unittest.TestCase):
    """P1-04：切页（reload_refs_from_model）前提交未 Apply 编辑，不静默丢弃。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()

    def _editor(self, root: Path):
        from tools.editor.editors.character_registry_editor import CharacterRegistryEditor
        m = _loaded_model(root)
        m.character_registry = {
            "c0": {"id": "c0", "name": "甲"},
            "c1": {"id": "c1", "name": "乙"},
        }
        ed = CharacterRegistryEditor(m)
        ed.reload_refs_from_model()
        return ed, m

    def test_reload_commits_unapplied_edit(self) -> None:
        with TemporaryDirectory() as td:
            ed, m = self._editor(Path(td) / "p")
            ed.select_by_id("c0")
            ed._name.setText("甲改")           # 不点 Apply
            ed.reload_refs_from_model()          # 模拟切页回来
            self.assertEqual(m.character_registry["c0"]["name"], "甲改",
                             "切页重载前必须提交未应用编辑（P1-04）")
            self.assertEqual(ed._name.text(), "甲改", "切回后表单应保住编辑")

    def test_select_by_id_returns_bool(self) -> None:
        with TemporaryDirectory() as td:
            ed, _m = self._editor(Path(td) / "p")
            self.assertTrue(ed.select_by_id("c0"))
            self.assertFalse(ed.select_by_id("missing"))


class PlaneExtendsProblemsTests(unittest.TestCase):
    """P2 ①：extends 成环 / 缺父即时检测。"""

    def test_cycle_detected(self) -> None:
        from tools.editor.editors.plane_editor import plane_extends_problems
        planes = [
            {"id": "a", "extends": "b"},
            {"id": "b", "extends": "a"},
        ]
        self.assertTrue(plane_extends_problems(planes, "a"))
        self.assertTrue(any("环" in p for p in plane_extends_problems(planes, "a")))

    def test_missing_parent_detected(self) -> None:
        from tools.editor.editors.plane_editor import plane_extends_problems
        planes = [{"id": "a", "extends": "ghost"}]
        probs = plane_extends_problems(planes, "a")
        self.assertTrue(any("不在 planes.json" in p for p in probs))

    def test_clean_chain_no_problem(self) -> None:
        from tools.editor.editors.plane_editor import plane_extends_problems
        planes = [{"id": "normal"}, {"id": "a", "extends": "normal"}]
        self.assertEqual(plane_extends_problems(planes, "a"), [])


class PlaneReferenceCountTests(unittest.TestCase):
    """P2 ②：位面反向引用计数（点名 / 归属 / 子位面 extends）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()

    def test_counts_three_kinds(self) -> None:
        from tools.editor.editors.plane_editor import PlaneEditor
        with TemporaryDirectory() as td:
            m = _loaded_model(Path(td) / "p")
            m.planes = [{"id": "normal"}, {"id": "yin"}, {"id": "child", "extends": "yin"}]
            m.scenes = {"sc_a": {"id": "sc_a", "npcs": [
                {"id": "npc1", "planes": ["yin"]},
            ], "hotspots": [], "zones": [], "spawnPoints": {}}}
            m.narrative_graphs = {"schemaVersion": 2, "compositions": [
                {"id": "comp", "mainGraph": {"id": "g", "states": {
                    "st1": {"activePlane": "yin"},
                }}, "elements": []},
            ]}
            ed = PlaneEditor(m)
            ed.select_by_id("yin")
            naming, members, children = ed._plane_reference_counts("yin")
            self.assertEqual(len(naming), 1)
            self.assertEqual(len(members), 1)
            self.assertEqual(len(children), 1)

    def test_select_by_id_returns_bool(self) -> None:
        from tools.editor.editors.plane_editor import PlaneEditor
        with TemporaryDirectory() as td:
            m = _loaded_model(Path(td) / "p")
            m.planes = [{"id": "normal"}]
            ed = PlaneEditor(m)
            self.assertTrue(ed.select_by_id("normal"))
            self.assertFalse(ed.select_by_id("nope"))


class GameConfigReloadRefsTests(unittest.TestCase):
    """P2 ③：切页刷新引用候选，本会话新建 id 可见，且保当前值。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()

    def test_new_scene_id_becomes_selectable(self) -> None:
        from tools.editor.editors.game_config_editor import GameConfigEditor
        with TemporaryDirectory() as td:
            m = _loaded_model(Path(td) / "p")
            m.game_config = {"initialScene": "sc_a"}
            ed = GameConfigEditor(m)
            # 本会话新增一个场景（未重开工程）
            m.scenes["sc_new"] = {"id": "sc_new", "hotspots": [], "zones": [],
                                  "npcs": [], "spawnPoints": {}}
            ed.reload_refs_from_model()
            ed._initial_scene.set_current("sc_new")
            self.assertEqual(ed._initial_scene.current_id(), "sc_new",
                             "刷新后新建场景 id 必须可选中（P2 ③）")

    def test_reload_preserves_current_value(self) -> None:
        from tools.editor.editors.game_config_editor import GameConfigEditor
        with TemporaryDirectory() as td:
            m = _loaded_model(Path(td) / "p")
            m.game_config = {"initialScene": "sc_a"}
            ed = GameConfigEditor(m)
            ed.reload_refs_from_model()
            self.assertEqual(ed._initial_scene.current_id(), "sc_a",
                             "刷新候选不得改变当前选中值")


class PlayerAvatarDirtyGuardTests(unittest.TestCase):
    """P2 ⑥：showEvent 触发的重载不覆盖未 Apply 的编辑。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()

    def test_dirty_form_not_overwritten_on_sync(self) -> None:
        from tools.editor.editors.player_avatar_editor import PlayerAvatarEditor
        with TemporaryDirectory() as td:
            m = _loaded_model(Path(td) / "p")
            m.game_config = {"playerAvatar": {"animManifest": "/a/anim.json"}}
            ed = PlayerAvatarEditor(m)
            ed._manifest_edit.setText("/edited/anim.json")   # 未 Apply
            self.assertTrue(ed._is_dirty())
            # 别页动了 config → 触发延后同步；有脏编辑时不得回填覆盖
            ed._sync_player_avatar_deferred = True
            ed._flush_player_avatar_model_sync()
            self.assertEqual(ed._manifest_edit.text(), "/edited/anim.json",
                             "有未 Apply 编辑时 showEvent 同步不得覆盖表单（P2 ⑥）")


class SmellNumericRoundtripTests(unittest.TestCase):
    """P3：放宽 decimals/上限后，越界值 / 多位小数载入即显示原值，纯浏览不写回走样。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()

    def test_out_of_old_range_and_precision_preserved(self) -> None:
        from tools.editor.editors.smell_profile_editor import SmellProfileEditor
        with TemporaryDirectory() as td:
            m = _loaded_model(Path(td) / "p")
            m.smell_profiles = {"profiles": {
                "p_hi": {"name": "浓", "color": "#abcdef",
                         "rise": 42.0, "sway": 1.234, "swayFreq": 1.0, "jitter": 0.2,
                         "special": {"envelope": {"attackMs": 150, "holdMs": 800,
                                                   "decayMs": 4000, "peak": 12.5}}},
            }}
            ed = SmellProfileEditor(m)
            ed.select_by_id("p_hi")
            # 越界值 42 未被夹到旧上限 10；多位小数 1.234 未被截成 1.23
            self.assertEqual(ed._spins["rise"].value(), 42.0)
            self.assertAlmostEqual(ed._spins["sway"].value(), 1.234, places=3)
            self.assertEqual(ed._env["peak"].value(), 12.5)
            # 纯浏览触发一次 _on_change：不得把走样值写回（值应保持原样）
            ed._on_change()
            self.assertEqual(m.smell_profiles["profiles"]["p_hi"]["rise"], 42.0)
            self.assertAlmostEqual(
                m.smell_profiles["profiles"]["p_hi"]["sway"], 1.234, places=3)

    def test_select_by_id_returns_bool(self) -> None:
        from tools.editor.editors.smell_profile_editor import SmellProfileEditor
        with TemporaryDirectory() as td:
            m = _loaded_model(Path(td) / "p")
            m.smell_profiles = {"profiles": {"p0": {"name": "a"}}}
            ed = SmellProfileEditor(m)
            ed.reload_refs_from_model()
            self.assertTrue(ed.select_by_id("p0"))
            self.assertFalse(ed.select_by_id("nope"))


class FlagPickerDialogTests(unittest.TestCase):
    """P3：停在登记页点 Ok 返回新建 key；关窗 flush 内嵌防抖编辑。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt = _app()

    def _dialog(self, root: Path):
        from tools.editor.shared.flag_picker_dialog import FlagPickerDialog
        m = _loaded_model(root)
        m.flag_registry = {"static": [{"key": "f_old", "valueType": "bool"}], "patterns": []}
        dlg = FlagPickerDialog(m, None, initial="f_old")
        return dlg, m

    def test_ok_on_registry_tab_returns_selected_key(self) -> None:
        with TemporaryDirectory() as td:
            dlg, m = self._dialog(Path(td) / "p")
            # 在内嵌登记表里新建一个 flag 并选中（模拟"停在编辑页刚建"）
            m.flag_registry["static"].append({"key": "f_brand_new", "valueType": "bool"})
            dlg._reg_editor.refresh_views()
            dlg._reg_editor.select_by_id("f_brand_new")
            dlg._tabs.setCurrentIndex(1)   # 停在「编辑登记表」页
            dlg._accept()
            self.assertEqual(dlg.selected_key(), "f_brand_new",
                             "停在登记页点 Ok 应返回刚选中的新 key（P3）")

    def test_close_flushes_embedded_pattern_edits(self) -> None:
        from tools.editor.editors.flag_registry_editor import _PatternRow
        with TemporaryDirectory() as td:
            dlg, m = self._dialog(Path(td) / "p")
            reg = dlg._reg_editor
            reg._add_pattern()                    # 建一行 pattern
            # 找到该行并改 id（textChanged 启动 220ms 防抖计时器，模拟"刚敲完字"）
            row = next(
                reg._patterns_layout.itemAt(i).widget()
                for i in range(reg._patterns_layout.count())
                if isinstance(reg._patterns_layout.itemAt(i).widget(), _PatternRow)
            )
            row._id.setText("edited_pattern_id")
            self.assertTrue(reg._patterns_flush_timer.isActive(), "改 pattern 应进防抖窗")
            dlg.reject()                          # 关窗（尾窗内）
            self.assertFalse(reg._patterns_flush_timer.isActive(),
                             "关窗必须 flush 内嵌登记表防抖编辑（P3）")
            ids = [p.get("id") for p in m.flag_registry.get("patterns") or []]
            self.assertIn("edited_pattern_id", ids,
                          "尾窗内的 pattern 编辑必须落进模型")


if __name__ == "__main__":
    unittest.main()
