"""数据核心审查修复护栏（P-数据核心组，审查 2026-07-14）。

覆盖：
- P1-06 场景 id 影子化：stem 键载入、不互相覆盖、id≠文件名记异常
- P1-18 坏 JSON 报错带文件路径
- P1-19 detect_external_changes 基线与检测
- P2-① 空登记表工程结构性校验仍生效（假 action 被抓）
- P2-② 缺 scenarios.json 不锁死保存
- P2-③ presave 按脏桶收口 + 暂存对话图按暂存版校验
- P2-④ 缺实例文件不凭空造空实例、记异常
- P2-⑤ characterRegistry 按载入顺序回写
- P3 scenarios 校验收集全部错误
- numeric_roundtrip 控件 int / 原值 float 方向
- validator 新增：cutscene 重复 id、空 not、updateQuest.id
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import (
    file_sha256,
    patch_staged_add,
    write_minimal_loadable_project,
)


def _dump(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


class _QtBase(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)


# ---------------------------------------------------------------------------
# P1-06 场景 id 影子化
# ---------------------------------------------------------------------------

class TestSceneIdShadowing(_QtBase):
    def test_same_internal_id_two_files_both_loaded_by_stem(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            sp = root / "public" / "assets" / "scenes"
            # town.json 内 id=town(npcA)；village.json 内 id 也是 town(npcB) —— 旧实现只剩一个
            _dump(sp / "town.json", {"id": "town", "name": "T", "npcs": [{"id": "npcA"}]})
            _dump(sp / "village.json", {"id": "town", "name": "V", "npcs": [{"id": "npcB"}]})
            m = ProjectModel()
            m.load_project(root)
            # 两个文件都按文件名 stem 载入，互不覆盖
            self.assertIn("town", m.scenes)
            self.assertIn("village", m.scenes)
            self.assertEqual(m.scenes["town"]["npcs"][0]["id"], "npcA")
            self.assertEqual(m.scenes["village"]["npcs"][0]["id"], "npcB")
            # 两条 load_anomalies：id≠文件名（village）+ id 重复
            joined = "\n".join(m.load_anomalies)
            self.assertIn("village.json", joined)
            self.assertIn("重复", joined)

    def test_save_writes_each_scene_to_own_file_no_clobber(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            sp = root / "public" / "assets" / "scenes"
            _dump(sp / "town.json", {"id": "town", "name": "T", "npcs": [{"id": "npcA"}]})
            _dump(sp / "village.json", {"id": "town", "name": "V", "npcs": [{"id": "npcB"}]})
            m = ProjectModel()
            m.load_project(root)
            m.scenes["village"]["name"] = "V2"
            m.mark_dirty("scene", "village")
            m.save_all()
            # village 写回自己的文件；town.json 内容不被影子覆写
            town_after = json.loads((sp / "town.json").read_text(encoding="utf-8"))
            village_after = json.loads((sp / "village.json").read_text(encoding="utf-8"))
            self.assertEqual(town_after["npcs"][0]["id"], "npcA")
            self.assertEqual(village_after["name"], "V2")
            self.assertEqual(village_after["npcs"][0]["id"], "npcB")

    def test_validator_warns_on_id_mismatch(self) -> None:
        # K 修复(对抗组 V5):此处刻意是 warning 而非 error——数据已由「文件名 stem 为
        # 键」载入保护、互不覆写,不因「复制场景忘改 id」硬拦全域保存。原测试名
        # test_validator_errors_on_id_mismatch 与断言(断的是 warning)矛盾,故改名对齐。
        # 断言逻辑不变。
        from tools.editor.validator import validate
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            sp = root / "public" / "assets" / "scenes"
            _dump(sp / "mismatch.json", {"id": "other_id", "name": "M"})
            m = ProjectModel()
            m.load_project(root)
            issues = validate(m)
            hits = [i for i in issues if "mismatch.json" in i.message]
            self.assertTrue(hits, "内部 id≠文件名应冒 load_anomaly warning")


# ---------------------------------------------------------------------------
# P1-18 坏 JSON 报错带文件路径
# ---------------------------------------------------------------------------

class TestBadJsonError(_QtBase):
    def test_read_json_error_includes_path(self) -> None:
        from tools.editor.file_io import read_json, JsonFileError
        with TemporaryDirectory() as td:
            bad = Path(td) / "items.json"
            bad.write_text('{"a": 1,,}', encoding="utf-8")
            with self.assertRaises(JsonFileError) as ar:
                read_json(bad)
            msg = str(ar.exception)
            self.assertIn("items.json", msg)
            self.assertIn("解析失败", msg)
            # JSONDecodeError ⊂ ValueError：既有兜底捕获兼容
            self.assertIsInstance(ar.exception, ValueError)

    def test_load_project_reports_which_file(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            (root / "public" / "assets" / "data" / "items.json").write_text(
                '[ {"id": "x",, } ]', encoding="utf-8",
            )
            m = ProjectModel()
            with self.assertRaises(ValueError) as ar:
                m.load_project(root)
            self.assertIn("items.json", str(ar.exception))


# ---------------------------------------------------------------------------
# P1-19 detect_external_changes
# ---------------------------------------------------------------------------

class TestDetectExternalChanges(_QtBase):
    def test_no_dirty_reports_nothing(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            self.assertEqual(m.detect_external_changes(), [])

    def test_external_edit_to_planned_write_is_detected(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.items[0]["name"] = "changed_in_memory"
            m.mark_dirty("item")
            # 外部改动 items.json
            items_path = root / "public" / "assets" / "data" / "items.json"
            items_path.write_text(
                json.dumps([{"id": "i_ok", "name": "EXTERNAL"}], ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            changed = m.detect_external_changes()
            self.assertIn("public/assets/data/items.json", changed)

    def test_unrelated_external_edit_not_reported(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.items[0]["name"] = "x"
            m.mark_dirty("item")
            # 外部改的是 quests.json（本次不写它）→ 不报告
            (root / "public" / "assets" / "data" / "quests.json").write_text(
                '[{"id":"q_new"}]\n', encoding="utf-8",
            )
            self.assertEqual(m.detect_external_changes(), [])

    def test_baseline_refreshed_after_save(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.items[0]["name"] = "saved_value"
            m.mark_dirty("item")
            m.save_all()
            # 保存后基线刷新，紧接着再改内存 + 无外部改动 → 不报冲突
            m.items[0]["name"] = "again"
            m.mark_dirty("item")
            self.assertEqual(m.detect_external_changes(), [])


# ---------------------------------------------------------------------------
# P2-① 空登记表工程结构性校验仍生效
# ---------------------------------------------------------------------------

class TestEmptyRegistryStillValidatesContent(_QtBase):
    def test_fake_action_caught_with_empty_registry(self) -> None:
        from tools.editor.validator import validate
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            # 空登记表
            _dump(root / "public" / "assets" / "data" / "flag_registry.json",
                  {"static": [], "patterns": [], "migrations": {}, "runtime": {}})
            # 场景热点挂一个假 action
            sp = root / "public" / "assets" / "scenes"
            _dump(sp / "sc_a.json", {
                "id": "sc_a", "name": "A",
                "hotspots": [{"id": "h1", "type": "inspect",
                              "data": {"actions": [{"type": "totallyFakeAction", "params": {}}]}}],
                "zones": [], "spawnPoints": {},
            })
            m = ProjectModel()
            m.load_project(root)
            issues = validate(m)
            fake = [i for i in issues if "totallyFakeAction" in i.message]
            self.assertTrue(fake, "空登记表下假 action 仍必须被抓（P2-①）")
            self.assertTrue(any(i.severity == "error" for i in fake))


# ---------------------------------------------------------------------------
# P2-② 缺 scenarios.json 不锁死保存
# ---------------------------------------------------------------------------

class TestMissingScenariosNotLocked(_QtBase):
    def test_default_scenarios_allows_save(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            # 删掉 scenarios.json
            (root / "public" / "assets" / "data" / "scenarios.json").unlink()
            m = ProjectModel()
            m.load_project(root)
            self.assertEqual(m.scenarios_catalog, {"scenarios": []})
            # 改无关域并保存，不应因缺 scenarios 被拦
            m.items[0]["name"] = "ok"
            m.mark_dirty("item")
            m.save_all()  # 不抛
            self.assertFalse(m.is_dirty)


# ---------------------------------------------------------------------------
# P2-③ presave 按脏桶收口 + 暂存对话图校验
# ---------------------------------------------------------------------------

class TestPresaveDirtyGating(_QtBase):
    def test_bad_tag_in_untouched_domain_does_not_block_other_save(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            # 盘上既有坏 tag 在 shops（本次不写它）
            m.shops = [{"id": "shop1", "name": "[tag:item:__NOPE__]"}]
            # 只改 items 并保存 → 不应被 shops 的坏 tag 拦住
            m.items[0]["name"] = "clean"
            m.mark_dirty("item")
            m.save_all()  # 不抛
            self.assertFalse(m.is_dirty)

    def test_bad_tag_in_dirty_domain_still_blocks(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.shops = [{"id": "shop1", "name": "[tag:item:__NOPE__]"}]
            m.mark_dirty("shop")
            with self.assertRaises(ValueError):
                m.save_all()
            self.assertTrue(m.is_dirty)

    def test_staged_dialogue_graph_bad_tag_blocked(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.pending_dialogue_graph_edits["g_bad"] = {
                "id": "g_bad",
                "nodes": {"n1": {"type": "line", "text": "[tag:item:__NOPE__]"}},
            }
            m.mark_dirty("dialogue_graph_edits")
            with self.assertRaises(ValueError):
                m.save_all()

    def test_staged_dialogue_graph_clean_tag_ok(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            m.pending_dialogue_graph_edits["g_ok"] = {
                "id": "g_ok",
                "nodes": {"n1": {"type": "line", "text": "[tag:item:i_ok]"}},
            }
            m.mark_dirty("dialogue_graph_edits")
            m.save_all()  # 不抛
            self.assertTrue((root / "public" / "assets" / "dialogues" / "graphs" / "g_ok.json").is_file())


# ---------------------------------------------------------------------------
# P2-④ 缺实例文件不凭空造空实例
# ---------------------------------------------------------------------------

class TestMinigameMissingInstance(_QtBase):
    def test_missing_instance_file_records_anomaly_not_empty_instance(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            dp = root / "public" / "assets" / "data"
            # index 指向不存在的实例文件
            _dump(dp / "water_minigames" / "index.json",
                  [{"id": "wm1", "file": "wm1.json", "label": "L"}])
            m = ProjectModel()
            m.load_project(root)
            self.assertNotIn("wm1", m.water_minigames_instances,
                             "缺实例文件不得凭空造空实例（P2-④）")
            self.assertTrue(any("wm1" in a and "缺失" in a for a in m.load_anomalies))


# ---------------------------------------------------------------------------
# P2-⑤ characterRegistry 按载入顺序回写
# ---------------------------------------------------------------------------

class TestCharacterRegistryOrder(_QtBase):
    def test_save_preserves_load_order_not_sorted(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            dp = root / "public" / "assets" / "data"
            # 故意乱序（非字母序）
            order = ["zoe", "alan", "mike"]
            _dump(dp / "character_registry.json",
                  {"characters": [{"id": c, "name": c} for c in order]})
            m = ProjectModel()
            m.load_project(root)
            m.character_registry["zoe"]["name"] = "Zoe!"
            m.mark_dirty("characterRegistry")
            m.save_all()
            saved = json.loads((dp / "character_registry.json").read_text(encoding="utf-8"))
            self.assertEqual([c["id"] for c in saved["characters"]], order,
                             "应按载入顺序回写，不强制 sorted（P2-⑤）")

    def test_open_then_save_no_reorder_bytes(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            dp = root / "public" / "assets" / "data"
            _dump(dp / "character_registry.json",
                  {"characters": [{"id": "zoe", "name": "Z"}, {"id": "alan", "name": "A"}]})
            m = ProjectModel()
            m.load_project(root)
            before = file_sha256(dp / "character_registry.json")
            # 打开→不动内容，仅标脏保存 → 顺序不变（字节一致）
            m.mark_dirty("characterRegistry")
            m.save_all()
            self.assertEqual(file_sha256(dp / "character_registry.json"), before)


# ---------------------------------------------------------------------------
# P3 scenarios 校验收集全部错误
# ---------------------------------------------------------------------------

class TestScenariosCollectAllErrors(_QtBase):
    def test_returns_all_errors_not_just_first(self) -> None:
        from tools.editor.scenarios_catalog_validate import validate_scenarios_list
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            data = [
                {"id": "", "phases": {}},          # 空 id
                {"id": "dup", "phases": {}},
                {"id": "dup", "phases": {}},       # 重复 id
                {"id": "s3", "exposeAfterPhase": "nope", "phases": {}},  # exposeAfterPhase 悬垂
            ]
            errs = validate_scenarios_list(data, flag_registry={}, model=m)
            self.assertIsInstance(errs, list)
            self.assertGreaterEqual(len(errs), 3, f"应一次报多条: {errs}")


# ---------------------------------------------------------------------------
# numeric_roundtrip 控件 int / 原值 float
# ---------------------------------------------------------------------------

class TestNumericRoundtripIntOverFloat(unittest.TestCase):
    def test_int_control_float_original_restored(self) -> None:
        from tools.editor.shared.numeric_roundtrip import preserve_numeric_repr
        out = preserve_numeric_repr({"scale": 1}, {"scale": 1.0})
        self.assertIsInstance(out["scale"], float, "控件 int 1、原值 float 1.0 → 恢复 1.0")

    def test_int_control_int_original_unchanged(self) -> None:
        from tools.editor.shared.numeric_roundtrip import preserve_numeric_repr
        out = preserve_numeric_repr({"n": 5}, {"n": 3})
        self.assertEqual(out["n"], 5)
        self.assertIsInstance(out["n"], int)

    def test_float_control_int_original_still_works(self) -> None:
        from tools.editor.shared.numeric_roundtrip import preserve_numeric_repr
        out = preserve_numeric_repr({"d": 1000.0}, {"d": 1000})
        self.assertIsInstance(out["d"], int)


# ---------------------------------------------------------------------------
# validator 新增检查
# ---------------------------------------------------------------------------

class TestValidatorNewChecks(_QtBase):
    def _model(self, root: Path) -> ProjectModel:
        m = ProjectModel()
        m.load_project(root)
        return m

    def test_cutscene_duplicate_id_error(self) -> None:
        from tools.editor.validator import validate
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            _dump(root / "public" / "assets" / "data" / "cutscenes" / "index.json",
                  [{"id": "dup", "steps": []}, {"id": "dup", "steps": []}])
            m = self._model(root)
            issues = validate(m)
            hits = [i for i in issues if i.data_type == "cutscene" and "重复" in i.message]
            self.assertTrue(hits and hits[0].severity == "error")

    def test_empty_not_condition_warning(self) -> None:
        from tools.editor.validator import validate
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            sp = root / "public" / "assets" / "scenes"
            _dump(sp / "sc_a.json", {
                "id": "sc_a", "name": "A", "zones": [], "spawnPoints": {},
                "hotspots": [{"id": "h1", "type": "inspect", "conditions": [{"not": {}}],
                              "data": {"text": "x"}}],
            })
            m = self._model(root)
            issues = validate(m)
            hits = [i for i in issues if "not 内层为空" in i.message]
            self.assertTrue(hits, "not{} 应告警恒假")

    def test_update_quest_dangling_id_error(self) -> None:
        from tools.editor.validator import validate
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            _dump(root / "public" / "assets" / "data" / "narrative_graphs.json", {
                "schemaVersion": 2,
                "signals": [],
                "compositions": [{
                    "id": "c1",
                    "mainGraph": {
                        "id": "g1",
                        "states": {
                            "s1": {"onEnterActions": [
                                {"type": "updateQuest", "params": {"id": "__no_such_quest__"}}
                            ]},
                        },
                    },
                    "elements": [],
                }],
            })
            m = self._model(root)
            issues = validate(m)
            hits = [i for i in issues if i.data_type == "narrative" and "updateQuest" in i.message]
            self.assertTrue(hits and hits[0].severity == "error")


if __name__ == "__main__":
    unittest.main()
