"""可控角色（character_registry 带 avatar 段）的化身一致性闸。

与 playerAvatar 侧对称：stateMap 指向动画包里不存在的片段 = 运行时该动词静默禁用，
是最难查的失败（策划只看到"这个角色走路没反应"）。playerAvatar 早有这道闸，
可控角色一侧不加就是同样的笔误一边报 error 一边放行。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import validate

_BUNDLE = "axiu_anim"
_MANIFEST = f"/resources/runtime/animation/{_BUNDLE}/anim.json"
_ALT_BUNDLE = "axiu_carry_anim"
_ALT_MANIFEST = f"/resources/runtime/animation/{_ALT_BUNDLE}/anim.json"


class TestCharacterAvatarValidation(unittest.TestCase):
    def _issues(self, characters: list[dict[str, Any]]) -> tuple[list[str], list[str]]:
        """→ (error 文案, warning 文案)，只取 data_type == 'character' 的。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            dp = root / "public" / "assets" / "data"
            (dp / "character_registry.json").write_text(
                json.dumps({"characters": characters}, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            # 两个动画包：常态包有 idle/walk/kick，换装包只有 carry_idle/carry_walk
            anim_root = root / "public" / "resources" / "runtime" / "animation"
            for bundle, states in (
                (_BUNDLE, ["idle", "walk", "kick", "yawn"]),
                (_ALT_BUNDLE, ["carry_idle", "carry_walk"]),
            ):
                d = anim_root / bundle
                d.mkdir(parents=True, exist_ok=True)
                (d / "anim.json").write_text(
                    json.dumps({
                        "spritesheet": "atlas.png", "cols": 1, "rows": 1,
                        "states": {s: {"frames": [0], "frameRate": 8, "loop": True} for s in states},
                    }, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
            model = ProjectModel()
            model.load_project(root)
            issues = [i for i in validate(model) if i.data_type == "character"]
            return (
                [i.message for i in issues if i.severity == "error"],
                [i.message for i in issues if i.severity == "warning"],
            )

    # —— 不该报的 ——

    def test_no_avatar_segment_is_not_checked(self) -> None:
        """普通 NPC 角色（无 avatar 段）不受本闸约束——绝大多数角色是这种。"""
        errs, warns = self._issues([{"id": "popo", "name": "婆婆", "animFile": _MANIFEST}])
        self.assertEqual(errs, [])
        self.assertEqual(warns, [])

    def test_valid_controllable_character_passes(self) -> None:
        errs, warns = self._issues([{
            "id": "axiu", "name": "阿秀", "animFile": _MANIFEST,
            "avatar": {
                "stateMap": {"idle": "idle", "walk": "walk", "kick": "kick"},
                "idle": {"entries": [{"animState": "yawn"}]},
                "outfits": {"carry": {"animFile": _ALT_MANIFEST,
                                      "stateMap": {"idle": "carry_idle", "walk": "carry_walk"}}},
            },
        }])
        self.assertEqual(errs, [])
        self.assertEqual(warns, [])

    def test_unresolvable_bundle_does_not_false_alarm(self) -> None:
        """包解析不到（外部包/尚未导出）时不误报，由素材审计另行兜底。"""
        errs, _ = self._issues([{
            "id": "axiu", "animFile": "/resources/runtime/animation/not_exported/anim.json",
            "avatar": {"stateMap": {"walk": "whatever"}},
        }])
        self.assertEqual(errs, [])

    # —— 该报的 ——

    def test_controllable_without_anim_file_is_error(self) -> None:
        errs, _ = self._issues([{"id": "axiu", "avatar": {"stateMap": {"walk": "walk"}}}])
        self.assertTrue(any("没有 animFile" in m for m in errs), errs)

    def test_state_map_clip_not_in_bundle(self) -> None:
        errs, _ = self._issues([{
            "id": "axiu", "animFile": _MANIFEST,
            "avatar": {"stateMap": {"walk": "wallk"}},  # 笔误
        }])
        self.assertTrue(any("'wallk'" in m and "不在动画包" in m for m in errs), errs)

    def test_outfit_state_map_checked_against_outfit_bundle(self) -> None:
        """装扮换了包，就该按**新包**查——按常态包查会把对的判错、把错的放过。"""
        errs, _ = self._issues([{
            "id": "axiu", "animFile": _MANIFEST,
            "avatar": {"outfits": {"carry": {
                "animFile": _ALT_MANIFEST,
                # 'walk' 在常态包里有、在换装包里没有 → 必须报
                "stateMap": {"walk": "walk"},
            }}},
        }])
        self.assertTrue(any("avatar.outfits[carry]" in m and "不在动画包" in m for m in errs), errs)
        self.assertTrue(any(_ALT_BUNDLE in m for m in errs), errs)

    def test_outfit_without_anim_file_falls_back_to_own_bundle(self) -> None:
        """纯状态换装（不换包）按角色本体的包查。"""
        errs, _ = self._issues([{
            "id": "axiu", "animFile": _MANIFEST,
            "avatar": {"outfits": {"limp": {"stateMap": {"walk": "nope"}}}},
        }])
        self.assertTrue(any("avatar.outfits[limp]" in m and _BUNDLE in m for m in errs), errs)

    def test_idle_entry_anim_state_checked(self) -> None:
        errs, _ = self._issues([{
            "id": "axiu", "animFile": _MANIFEST,
            "avatar": {"idle": {"entries": [{"animState": "no_such"}]}},
        }])
        self.assertTrue(any("idle.entries[0]" in m for m in errs), errs)

    def test_unknown_logical_name_is_warning_not_error(self) -> None:
        """未知逻辑名可能是脚本显式播的别名，只 warning 提醒笔误。"""
        errs, warns = self._issues([{
            "id": "axiu", "animFile": _MANIFEST,
            "avatar": {"stateMap": {"wlak": "walk"}},
        }])
        self.assertEqual(errs, [])
        self.assertTrue(any("不在自动解析清单里" in m for m in warns), warns)

    def test_empty_clip_is_error(self) -> None:
        errs, _ = self._issues([{
            "id": "axiu", "animFile": _MANIFEST, "avatar": {"stateMap": {"walk": "  "}},
        }])
        self.assertTrue(any("须为非空字符串" in m for m in errs), errs)

    def test_malformed_shapes_do_not_crash(self) -> None:
        """坏形状必须报错而不是抛异常（构建期 fail-closed，别把校验器炸掉）。"""
        errs, _ = self._issues([{
            "id": "axiu", "animFile": _MANIFEST,
            "avatar": {"stateMap": "not-a-dict", "outfits": {"bad": "not-a-dict"}},
        }])
        self.assertTrue(any("stateMap 须为对象" in m for m in errs), errs)
        self.assertTrue(any("装扮 'bad' 须为对象" in m for m in errs), errs)


class TestCharacterDialogueGraphValidation(unittest.TestCase):
    """角色级对话图绑定的构建期闸（与 NpcDef 侧同口径）。"""

    def _issues(self, characters: list[dict[str, Any]],
                graphs: dict[str, Any] | None = None) -> list[str]:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            dp = root / "public" / "assets" / "data"
            (dp / "character_registry.json").write_text(
                json.dumps({"characters": characters}, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            gdir = root / "public" / "assets" / "dialogues" / "graphs"
            gdir.mkdir(parents=True, exist_ok=True)
            for gid, doc in (graphs or {}).items():
                (gdir / f"{gid}.json").write_text(
                    json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            model = ProjectModel()
            model.load_project(root)
            return [i.message for i in validate(model)
                    if i.data_type == "character" and i.severity == "error"]

    _GRAPH = {"id": "g1", "entry": "start", "nodes": {"start": {}, "alt": {}}}

    def test_valid_binding_passes(self) -> None:
        errs = self._issues(
            [{"id": "li", "dialogueGraphId": "g1", "dialogueGraphEntry": "alt"}],
            {"g1": self._GRAPH},
        )
        self.assertEqual(errs, [])

    def test_graph_without_entry_passes(self) -> None:
        self.assertEqual(
            self._issues([{"id": "li", "dialogueGraphId": "g1"}], {"g1": self._GRAPH}), [])

    def test_missing_graph_file_is_error(self) -> None:
        errs = self._issues([{"id": "li", "dialogueGraphId": "nope"}])
        self.assertTrue(any("缺少文件" in m for m in errs), errs)

    def test_entry_not_a_node_is_error(self) -> None:
        errs = self._issues(
            [{"id": "li", "dialogueGraphId": "g1", "dialogueGraphEntry": "ghost"}],
            {"g1": self._GRAPH},
        )
        self.assertTrue(any("不是图 'g1' 里的节点" in m for m in errs), errs)

    def test_entry_without_graph_is_error(self) -> None:
        """入口没有图就无从解析——运行时整条忽略，必须构建期拦。"""
        errs = self._issues([{"id": "li", "dialogueGraphEntry": "alt"}])
        self.assertTrue(any("没写 dialogueGraphId" in m for m in errs), errs)

    def test_plain_character_without_dialogue_is_silent(self) -> None:
        self.assertEqual(self._issues([{"id": "li", "name": "瞎子李"}]), [])


if __name__ == "__main__":
    unittest.main()
