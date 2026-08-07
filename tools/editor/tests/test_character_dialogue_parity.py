"""角色级对话图绑定：编辑器镜像 vs 运行时权威的 parity + 反查消费方不再失明。

运行时权威：`src/data/characterRegistry.ts#applyCharacterDefaults`
编辑器镜像：`tools/editor/shared/character_dialogue.py#resolve_npc_dialogue_graph`

两边的合并规则必须逐用例一致——尤其那条**成对继承**：摆放覆盖了 dialogueGraphId 时，
角色的 dialogueGraphEntry 绝不能跟过来（入口名只在它所属那张图里有意义，套到别的图上
会静默落到错误/不存在的入口，且零报错）。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from tools.editor.shared.character_dialogue import (
    load_character_registry,
    npc_uses_graph,
    resolve_npc_dialogue_graph,
)

REG = {
    "blind_li": {
        "id": "blind_li",
        "name": "瞎子李",
        "dialogueGraphId": "街头_瞎子李",
        "dialogueGraphEntry": "blind_li",
    },
    "graph_only": {"id": "graph_only", "dialogueGraphId": "g_only"},
    "no_graph": {"id": "no_graph", "name": "路人"},
}


def npc(**over):
    base = {"id": "n1", "characterId": "blind_li"}
    base.update(over)
    return base


class ResolveParityTests(unittest.TestCase):
    """每条用例都与 src/data/characterRegistry.test.ts 的同名用例一一对应。"""

    def test_inherits_graph_and_entry_together(self):
        self.assertEqual(resolve_npc_dialogue_graph(npc(), REG), ("街头_瞎子李", "blind_li"))

    def test_own_graph_never_inherits_character_entry(self):
        # ⭐ 本对字段唯一的硬约束
        self.assertEqual(
            resolve_npc_dialogue_graph(npc(dialogueGraphId="茶馆瞎子李"), REG),
            ("茶馆瞎子李", ""),
        )

    def test_own_graph_and_own_entry(self):
        self.assertEqual(
            resolve_npc_dialogue_graph(npc(dialogueGraphId="茶馆瞎子李", dialogueGraphEntry="tea"), REG),
            ("茶馆瞎子李", "tea"),
        )

    def test_inherited_graph_with_local_entry_override(self):
        self.assertEqual(
            resolve_npc_dialogue_graph(npc(dialogueGraphEntry="blind_li_night"), REG),
            ("街头_瞎子李", "blind_li_night"),
        )

    def test_blank_own_graph_counts_as_unset(self):
        self.assertEqual(
            resolve_npc_dialogue_graph(npc(dialogueGraphId="   "), REG),
            ("街头_瞎子李", "blind_li"),
        )

    def test_character_graph_without_entry(self):
        self.assertEqual(
            resolve_npc_dialogue_graph(npc(characterId="graph_only"), REG), ("g_only", ""),
        )

    def test_character_without_graph_yields_nothing(self):
        self.assertEqual(resolve_npc_dialogue_graph(npc(characterId="no_graph"), REG), ("", ""))

    def test_no_character_id_or_dangling(self):
        self.assertEqual(resolve_npc_dialogue_graph({"id": "n"}, REG), ("", ""))
        self.assertEqual(resolve_npc_dialogue_graph(npc(characterId="nobody"), REG), ("", ""))

    def test_empty_or_missing_registry_is_noop(self):
        """空注册表 = no-op（与运行时既有 back-compat 契约一致）。"""
        self.assertEqual(resolve_npc_dialogue_graph(npc(), {}), ("", ""))
        self.assertEqual(resolve_npc_dialogue_graph(npc(), None), ("", ""))
        self.assertEqual(
            resolve_npc_dialogue_graph(npc(dialogueGraphId="own"), None), ("own", ""),
        )


class NpcUsesGraphTests(unittest.TestCase):
    def test_matches_inherited_graph(self):
        """反查的核心：角色级绑定的图也算"这个 NPC 挂着它"。"""
        self.assertTrue(npc_uses_graph(npc(), "街头_瞎子李", REG))

    def test_does_not_match_when_overridden(self):
        self.assertFalse(npc_uses_graph(npc(dialogueGraphId="茶馆瞎子李"), "街头_瞎子李", REG))
        self.assertTrue(npc_uses_graph(npc(dialogueGraphId="茶馆瞎子李"), "茶馆瞎子李", REG))

    def test_blank_graph_id_never_matches(self):
        self.assertFalse(npc_uses_graph(npc(), "", REG))
        self.assertFalse(npc_uses_graph(npc(), "   ", REG))


class LoadRegistryTests(unittest.TestCase):
    def test_reads_registry_file(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            dp = root / "public" / "assets" / "data"
            dp.mkdir(parents=True)
            (dp / "character_registry.json").write_text(
                json.dumps({"characters": [{"id": "a", "dialogueGraphId": "g"}]}, ensure_ascii=False),
                encoding="utf-8",
            )
            self.assertEqual(load_character_registry(root)["a"]["dialogueGraphId"], "g")

    def test_missing_or_broken_file_returns_empty_not_raise(self):
        """注册表缺失/损坏一律回落成空表——反查退化为"只看就地字段"，不能把编辑器炸掉。"""
        with TemporaryDirectory() as td:
            self.assertEqual(load_character_registry(Path(td)), {})
            dp = Path(td) / "public" / "assets" / "data"
            dp.mkdir(parents=True)
            (dp / "character_registry.json").write_text("{ not json", encoding="utf-8")
            self.assertEqual(load_character_registry(Path(td)), {})

    def test_entries_without_id_are_skipped(self):
        with TemporaryDirectory() as td:
            root = Path(td)
            dp = root / "public" / "assets" / "data"
            dp.mkdir(parents=True)
            (dp / "character_registry.json").write_text(
                json.dumps({"characters": [{"name": "无 id"}, "not-a-dict", {"id": "ok"}]}),
                encoding="utf-8",
            )
            self.assertEqual(list(load_character_registry(root)), ["ok"])


class ReverseLookupConsumersTests(unittest.TestCase):
    """四个"按谁挂了这张图反查 NPC"的消费方：角色级绑定必须能被看见。"""

    def _project(self, td: str) -> Path:
        root = Path(td) / "p"
        dp = root / "public" / "assets" / "data"
        sp = root / "public" / "assets" / "scenes"
        dp.mkdir(parents=True)
        sp.mkdir(parents=True)
        (dp / "character_registry.json").write_text(json.dumps({"characters": [{
            "id": "clara", "name": "克拉拉",
            "animFile": "/resources/runtime/animation/克拉拉_anim/anim.json",
            "portraitSlug": "clara",
            "dialogueGraphId": "寻狗_克拉拉招募",
        }]}, ensure_ascii=False), encoding="utf-8")
        # 摆放只写 characterId：图/立绘都靠继承——这正是只读原始键会漏掉的形状
        (sp / "s1.json").write_text(json.dumps({
            "id": "s1", "name": "S", "hotspots": [], "zones": [], "spawnPoints": {},
            "npcs": [{"id": "npc_clara", "characterId": "clara", "x": 0, "y": 0,
                      "interactionRange": 70}],
        }, ensure_ascii=False), encoding="utf-8")
        return root

    def test_portrait_preview_resolves_inherited_graph_and_slug(self):
        from tools.editor.shared.portrait_catalog import (
            graph_context_portrait_slug,
            npc_portrait_slug_index,
        )
        with TemporaryDirectory() as td:
            root = self._project(td)
            # 图与立绘都在注册表上，两层解引用都要生效
            self.assertEqual(graph_context_portrait_slug(root, "寻狗_克拉拉招募"), "clara")
            self.assertEqual(npc_portrait_slug_index(root).get("npc_clara"), "clara")

    def test_narrative_catalog_sees_inherited_binding(self):
        from tools.editor.shared.narrative_catalog import dialogue_owner_refs_from_scenes
        with TemporaryDirectory() as td:
            root = self._project(td)
            scenes = {"s1": json.loads((root / "public/assets/scenes/s1.json").read_text("utf-8"))}
            registry = load_character_registry(root)
            refs = dialogue_owner_refs_from_scenes(scenes, registry)
            owners = [r["ownerId"] for r in refs.get("寻狗_克拉拉招募", [])]
            self.assertIn("npc_clara", owners)

    def test_narrative_catalog_without_registry_keeps_legacy_behavior(self):
        """不传注册表 = 历史行为（只看就地字段），既有调用点不受影响。"""
        from tools.editor.shared.narrative_catalog import dialogue_owner_refs_from_scenes
        with TemporaryDirectory() as td:
            root = self._project(td)
            scenes = {"s1": json.loads((root / "public/assets/scenes/s1.json").read_text("utf-8"))}
            self.assertEqual(dialogue_owner_refs_from_scenes(scenes).get("寻狗_克拉拉招募"), None)


if __name__ == "__main__":
    unittest.main()


class RegistryEditorRoundTripTests(unittest.TestCase):
    """角色页新增的两个字段：零丢失往返 + 悬垂值保值。"""

    @classmethod
    def setUpClass(cls) -> None:
        from tools.editor.tests.test_config_registry_fixes import _app
        cls._qt = _app()

    def _editor(self, registry: dict):
        from tools.editor.editors.character_registry_editor import CharacterRegistryEditor
        from tools.editor.project_model import ProjectModel
        m = ProjectModel()
        m.character_registry = registry
        ed = CharacterRegistryEditor(m)
        ed.reload_refs_from_model()
        return ed, m

    def test_untouched_entry_saves_identical_bytes(self) -> None:
        """打开即保存不得改动任何键（零丢失往返；含本模块不认识的未知键）。"""
        original = {
            "id": "li", "name": "瞎子李",
            "animFile": "/resources/runtime/animation/npc_blind_li_anim/anim.json",
            "portraitSlug": "blind_li",
            "dialogueGraphId": "街头_瞎子李", "dialogueGraphEntry": "blind_li",
            "someFutureKey": {"keep": True},
        }
        ed, _m = self._editor({"li": json.loads(json.dumps(original))})
        ed.select_by_id("li")
        entry = json.loads(json.dumps(original))
        ed._write_entry_into(entry)
        self.assertEqual(entry, original)

    def test_dangling_entry_survives_load(self) -> None:
        """磁盘上的悬垂 entry 必须原样展示与回写，不能载入时被静默清掉。"""
        ed, _m = self._editor({"li": {
            "id": "li", "dialogueGraphId": "不存在的图", "dialogueGraphEntry": "不存在的节点",
        }})
        ed.select_by_id("li")
        self.assertEqual(ed._graph.current_value(), "不存在的图")
        self.assertEqual(ed._graph_entry.current_value(), "不存在的节点")
        entry: dict = {}
        ed._write_entry_into(entry)
        self.assertEqual(entry.get("dialogueGraphEntry"), "不存在的节点")

    def test_clearing_graph_drops_orphan_entry(self) -> None:
        """图清空则 entry 连带清掉——入口没有图是 validator 直接报 error 的形状。"""
        ed, _m = self._editor({"li": {
            "id": "li", "dialogueGraphId": "g", "dialogueGraphEntry": "n",
        }})
        ed.select_by_id("li")
        ed._graph.set_value("")
        entry = {"id": "li", "dialogueGraphId": "g", "dialogueGraphEntry": "n"}
        ed._write_entry_into(entry)
        self.assertNotIn("dialogueGraphId", entry)
        self.assertNotIn("dialogueGraphEntry", entry)

    def test_new_fields_participate_in_dirty_detection(self) -> None:
        """改了新字段却不算脏 = 切页时静默丢编辑（本编辑器踩过的那类坑）。"""
        ed, _m = self._editor({"li": {"id": "li", "name": "瞎子李"}})
        ed.select_by_id("li")
        self.assertFalse(ed._is_dirty())
        ed._graph.set_value("街头_瞎子李")
        self.assertTrue(ed._is_dirty(), "改了 dialogueGraphId 必须算脏")
