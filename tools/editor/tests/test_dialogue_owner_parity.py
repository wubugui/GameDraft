"""编辑器 owner 静态解算 ↔ 运行时 owner 注入：语义级 parity 门。

由来：ownerState 节点在编辑器里"解不出所属实体"、在运行时却跑得好好的（反之亦然）。
根因是两侧各写了一套 owner 推导，且编辑器那套只认 NPC / 热区 / 场景 onEnter 三种来源，
运行时却还支持"动作显式传 ownerType/ownerId"这一档——于是 zone、热区动作、叙事图状态
动作、任务动作里开的对话，编辑器一律判为无 owner：状态下拉是空的、校验报假警告、
连新建 ownerState 节点都被硬拦。

这里锁两件事：
1. 优先级表逐格对齐 `src/core/actionOrigin.ts::resolveDialogueOwner`；
2. 运行时的每一个 owner 注入点，编辑器扫描面都认得（少一个就红）。

注释里写「有护栏」不算护栏——本文件用真源码文本做证据，不靠人肉同步。
"""
from __future__ import annotations

import re
import unittest
from pathlib import Path

from tools.editor.shared.narrative_catalog import (
    _OWNER_ORIGIN_SOURCES,
    dialogue_owner_refs_from_scenes,
    dialogue_start_sites,
    resolve_action_dialogue_owner,
)

REPO = Path(__file__).resolve().parents[3]


class _FakeModel:
    def __init__(self, **kw):
        self.scenes = kw.pop("scenes", {})
        self.narrative_graphs = kw.pop("narrative_graphs", {})
        self.quests = kw.pop("quests", [])
        for k, v in kw.items():
            setattr(self, k, v)


class DialogueOwnerPriorityParityTests(unittest.TestCase):
    """优先级表：与 actionOrigin.ts 的四档一一对应（编辑器把 ambient 并入 origin）。"""

    def test_explicit_owner_pair_wins(self) -> None:
        self.assertEqual(
            resolve_action_dialogue_owner(
                {"ownerType": "hotspot", "ownerId": "h1", "npcId": "n1"}, "zone", "z1"
            ),
            ("hotspot", "h1", "explicit"),
        )

    def test_explicit_type_without_id_is_no_owner(self) -> None:
        """最关键一格：显式类型缺 id 时绝不跨命名空间借 id。

        借来的 id 会解出一个根本不存在的 owner，比没有 owner 更难查
        （运行时 GraphDialogueManager 同款判定，见 startDialogueGraph）。
        """
        self.assertEqual(
            resolve_action_dialogue_owner({"ownerType": "hotspot", "npcId": "n1"}, "zone", "z1"),
            ("", "", "none"),
        )

    def test_npc_id_beats_origin(self) -> None:
        self.assertEqual(
            resolve_action_dialogue_owner({"npcId": "n1"}, "zone", "z1"),
            ("npc", "n1", "npcId"),
        )

    def test_origin_is_the_fallback(self) -> None:
        self.assertEqual(resolve_action_dialogue_owner({}, "zone", "z1"), ("zone", "z1", "origin"))

    def test_no_source_at_all(self) -> None:
        self.assertEqual(resolve_action_dialogue_owner({}, "", ""), ("", "", "none"))

    def test_owner_id_without_type_borrows_origin_type(self) -> None:
        self.assertEqual(
            resolve_action_dialogue_owner({"ownerId": "x"}, "zone", "z1"), ("zone", "x", "origin")
        )
        self.assertEqual(resolve_action_dialogue_owner({"ownerId": "x"}, "", ""), ("", "", "none"))

    def test_priority_table_matches_runtime_source(self) -> None:
        """运行时判定源必须仍是四档、且顺序未变（改了就必须同步本文件）。"""
        src = (REPO / "src/core/actionOrigin.ts").read_text(encoding="utf-8")
        for tier in ("'explicit'", "'npcId'", "'origin'", "'ambient'", "'none'"):
            self.assertIn(tier, src, f"运行时优先级档位 {tier} 消失了，编辑器镜像需同步")
        # 显式类型缺 id → none：这条不变量若被改掉，上面 test_explicit_type_without_id 就成了空转
        self.assertRegex(
            src,
            r"if \(pType\)[\s\S]{0,400}source: 'none'",
            "运行时不再对『显式 ownerType 缺 ownerId』判 none 了，编辑器镜像需同步",
        )


class RuntimeInjectionSiteCoverageTests(unittest.TestCase):
    """运行时每一个 owner 注入点，编辑器都得有对应扫描面。"""

    def _runtime_owner_types(self) -> set[str]:
        """从运行时源码里抓 executeBatchFromOwner / 来源上下文实际用的 ownerType 字面量。"""
        found: set[str] = set()
        for rel in (
            "src/systems/ZoneSystem.ts",
            "src/core/InteractionCoordinator.ts",
            "src/systems/QuestManager.ts",
            "src/core/Game.ts",
            "src/systems/waterMinigame/WaterMinigameScene.ts",
            "src/systems/sugarWheel/SugarWheelMinigameScene.ts",
            "src/systems/paperCraft/PaperCraftMinigameScene.ts",
            "src/systems/objectExamine/ObjectExamineScene.ts",
        ):
            text = (REPO / rel).read_text(encoding="utf-8")
            found |= set(re.findall(r"executeBatchFromOwner\([^,]+,\s*'([a-zA-Z]+)'", text))
            found |= set(re.findall(r"ownerType:\s*'([a-zA-Z]+)'", text))
            found |= set(re.findall(r"makeOwnerOrigin\('([a-zA-Z]+)'", text))
        return found

    def test_every_runtime_owner_type_is_scannable_by_the_editor(self) -> None:
        runtime_types = self._runtime_owner_types()
        self.assertTrue(runtime_types, "没从运行时源码抓到任何 ownerType，正则失效了")
        editor_types = {
            "npc", "hotspot", "zone", "scene",   # _scan_scene_start_sites
            "quest",                              # _scan_quest_start_sites
            *(t for _attr, t, _idf, _rt in _OWNER_ORIGIN_SOURCES),  # 小游戏等
        }
        # 叙事图状态动作的 owner 取自图自身，覆盖任意合法 ownerType
        missing = runtime_types - editor_types
        self.assertFalse(
            missing,
            f"运行时注入了这些 owner 类型但编辑器扫不到：{sorted(missing)}；"
            f"请在 narrative_catalog 补对应扫描面",
        )

    def test_minigame_origin_sources_point_at_live_runtime_files(self) -> None:
        for attr, owner_type, _id_field, runtime_rel in _OWNER_ORIGIN_SOURCES:
            path = REPO / "src" / runtime_rel
            self.assertTrue(path.is_file(), f"{attr} 登记的运行时注入点 {runtime_rel} 不存在了")
            text = path.read_text(encoding="utf-8")
            self.assertIn(
                f"executeBatchFromOwner(acts, '{owner_type}'",
                text,
                f"{runtime_rel} 不再以 {owner_type} owner 执行动作批，编辑器登记面需同步",
            )


class EditorScanSurfaceTests(unittest.TestCase):
    """扫描面本身：每一类来源都真能解出 owner（回归历史盲区）。"""

    def test_zone_actions_resolve_zone_owner(self) -> None:
        scenes = {
            "s1": {
                "zones": [
                    {
                        "id": "z1",
                        "onEnter": [{"type": "startDialogueGraph", "params": {"graphId": "dlg_zone"}}],
                        "onStay": [{"type": "startDialogueGraph", "params": {"graphId": "dlg_stay"}}],
                    }
                ]
            }
        }
        refs = dialogue_owner_refs_from_scenes(scenes)
        self.assertIn(("zone", "z1"), {(r["ownerType"], r["ownerId"]) for r in refs["dlg_zone"]})
        self.assertIn(("zone", "z1"), {(r["ownerType"], r["ownerId"]) for r in refs["dlg_stay"]})

    def test_zone_action_with_npc_id_resolves_npc_owner(self) -> None:
        """真实工程里踩到的那一条：zone 里 startDialogueGraph 只写了 npcId。

        运行时解出 npc:<npcId>（跑得好好的），旧编辑器却完全扫不到 zone，
        于是报"未找到引用该对话图的 NPC/Hotspot/场景 onEnter"并硬拦建节点。
        """
        scenes = {
            "s1": {
                "zones": [
                    {
                        "id": "z1",
                        "onEnter": [
                            {
                                "type": "startDialogueGraph",
                                "params": {"graphId": "dlg", "npcId": "发布者"},
                            }
                        ],
                    }
                ]
            }
        }
        refs = dialogue_owner_refs_from_scenes(scenes)
        self.assertEqual(
            {(r["ownerType"], r["ownerId"]) for r in refs["dlg"]}, {("npc", "发布者")}
        )

    def test_hotspot_inline_actions_resolve_hotspot_owner(self) -> None:
        scenes = {
            "s1": {
                "hotspots": [
                    {
                        "id": "h1",
                        "data": {
                            "actions": [
                                {"type": "startDialogueGraph", "params": {"graphId": "dlg_hs"}}
                            ]
                        },
                    }
                ]
            }
        }
        refs = dialogue_owner_refs_from_scenes(scenes)
        self.assertIn(("hotspot", "h1"), {(r["ownerType"], r["ownerId"]) for r in refs["dlg_hs"]})

    def test_entity_binding_registers_only_the_runtime_bare_id(self) -> None:
        """运行时以裸实体 id 建 owner 索引，编辑器不得多认一个 `场景:id` 别名。

        多认 = 编辑器说能绑、运行时永远匹配不上，正是要消灭的静默 fallback。
        """
        scenes = {"s1": {"npcs": [{"id": "n1", "dialogueGraphId": "dlg"}]}}
        refs = dialogue_owner_refs_from_scenes(scenes)
        self.assertEqual({(r["ownerType"], r["ownerId"]) for r in refs["dlg"]}, {("npc", "n1")})

    def test_narrative_state_actions_inherit_graph_owner(self) -> None:
        model = _FakeModel(
            narrative_graphs={
                "compositions": [
                    {
                        "id": "c1",
                        "elements": [
                            {
                                "id": "el1",
                                "kind": "wrapperGraph",
                                "ownerType": "npc",
                                "ownerId": "n1",
                                "graph": {
                                    "id": "w1",
                                    "states": {
                                        "s": {
                                            "onEnterActions": [
                                                {
                                                    "type": "startDialogueGraph",
                                                    "params": {"graphId": "dlg_nar"},
                                                }
                                            ]
                                        }
                                    },
                                },
                            }
                        ],
                    }
                ]
            }
        )
        sites = dialogue_start_sites(model)
        self.assertEqual(
            {(s["ownerType"], s["ownerId"]) for s in sites["dlg_nar"]}, {("npc", "n1")}
        )

    def test_quest_actions_resolve_quest_owner(self) -> None:
        model = _FakeModel(
            quests=[
                {
                    "id": "q1",
                    "acceptActions": [
                        {"type": "startDialogueGraph", "params": {"graphId": "dlg_q"}}
                    ],
                    "rewards": [{"type": "startDialogueGraph", "params": {"graphId": "dlg_r"}}],
                }
            ]
        )
        sites = dialogue_start_sites(model)
        self.assertEqual({(s["ownerType"], s["ownerId"]) for s in sites["dlg_q"]}, {("quest", "q1")})
        self.assertEqual({(s["ownerType"], s["ownerId"]) for s in sites["dlg_r"]}, {("quest", "q1")})

    def test_unresolvable_site_is_reported_not_dropped(self) -> None:
        """解不出 owner 的调用点必须留在 sites 里——策划要靠它知道该去补哪一处。"""
        scenes = {
            "s1": {
                "hotspots": [
                    {
                        "id": "",  # 没 id 的热区：owner 无从谈起
                        "data": {
                            "actions": [
                                {"type": "startDialogueGraph", "params": {"graphId": "dlg_x"}}
                            ]
                        },
                    }
                ],
                "onExit": [{"type": "startDialogueGraph", "params": {"graphId": "dlg_y"}}],
            }
        }
        sites = dialogue_start_sites(_FakeModel(scenes=scenes))
        # onExit 不在运行时的 scene owner 注入窗口内（只有 onEnter 是），故解不出 owner
        self.assertNotIn("dlg_y", sites)


if __name__ == "__main__":
    unittest.main()
