"""重导出 anim.json 时人工字段必须活下来（`merge_preserved_anim_fields` 的护栏）。

背景：导出器是"从零拼 dict"（`export_gamedraft_anim*`），`save_outputs` 覆盖已有
anim.json 前调 `merge_preserved_anim_fields` 把人工值捞回来。2026-08-03 之前那只捞
per-state 的两个字段，**顶层的 `normalBake` 每次重导出都被静默抹掉**（法线烘焙配置，
人工填、`bake_normal_atlas` 读）。

本文件钉死两侧：
- 导出器**自己算得出来**的顶层键（图集布局/世界尺寸/states）必须以新导出为准，不被旧值盖住；
- 其余顶层键（`normalBake` 及任何旁路工具写的键）必须原样带回；
- per-state 白名单（referenceSpeed / bubbleAnchor）行为不变。
"""
from __future__ import annotations

import unittest

from tools.video_to_atlas.atlas_core import (
    EXPORTER_OWNED_TOP_LEVEL_KEYS,
    PRESERVED_STATE_FIELDS,
    export_gamedraft_anim_multi,
    merge_preserved_anim_fields,
)

#: 最小可用 meta（字段取自 anim_atlas_frames_from_meta / export_gamedraft_anim_multi 的读取面）
_META = {
    "cols": 9,
    "rows": 10,
    "cellWidth": 219,
    "cellHeight": 204,
    "frames": [{"contentWidth": 47, "contentHeight": 182}],
}


def _fresh_export() -> dict:
    """**调真导出器**产出一次重导出结果。

    不手抄键集：手抄的话导出器新增字段时这里不会红，黑名单漏登记就查不出来
    （norms 第 8 条：镜像必须配对账，宁可消灭镜像）。
    """
    return export_gamedraft_anim_multi(
        _META,
        "atlas.png",
        148,
        150,
        {"idle": {"frames": [0, 1, 2], "frameRate": 8, "loop": True}},
    )


class ReexportPreservesManualFieldsTests(unittest.TestCase):
    def test_normal_bake_survives_reexport(self) -> None:
        """回归本体：顶层 normalBake 不再被重导出抹掉。"""
        old = {**_fresh_export(), "normalBake": {"enabled": True, "downscale": 2}}
        merged = merge_preserved_anim_fields(_fresh_export(), old)
        self.assertEqual(merged.get("normalBake"), {"enabled": True, "downscale": 2})

    def test_unknown_top_level_keys_survive(self) -> None:
        """旁路工具/人工写的任何顶层键都带回来（挂点 sidecar 之外的旁注同理）。"""
        old = {**_fresh_export(), "notes": "手抠过第 7 帧", "customTool": {"v": 1}}
        merged = merge_preserved_anim_fields(_fresh_export(), old)
        self.assertEqual(merged.get("notes"), "手抠过第 7 帧")
        self.assertEqual(merged.get("customTool"), {"v": 1})

    def test_exporter_owned_keys_take_new_values(self) -> None:
        """图集布局/世界尺寸/states 必须以新导出为准——旧值盖住就是错位的图集。"""
        old = {key: "旧值污染" for key in EXPORTER_OWNED_TOP_LEVEL_KEYS}
        merged = merge_preserved_anim_fields(_fresh_export(), old)
        for key, want in _fresh_export().items():
            self.assertEqual(merged[key], want, f"{key} 应取新导出值")

    def test_owned_key_set_covers_every_exporter_output(self) -> None:
        """黑名单漏登记＝旧值盖新值。

        对账用的是**真导出器的输出键集**（不是手抄清单）：导出器以后新增产物字段而忘了
        登记进 EXPORTER_OWNED_TOP_LEVEL_KEYS，这条会当场红。
        """
        produced = set(_fresh_export().keys())
        self.assertEqual(
            produced,
            set(EXPORTER_OWNED_TOP_LEVEL_KEYS),
            "导出器输出键集与 EXPORTER_OWNED_TOP_LEVEL_KEYS 漂移了："
            f"导出器多出 {produced - set(EXPORTER_OWNED_TOP_LEVEL_KEYS)}，"
            f"名单多出 {set(EXPORTER_OWNED_TOP_LEVEL_KEYS) - produced}",
        )

    def test_per_state_whitelist_unchanged(self) -> None:
        """per-state 仍是白名单：两个人工字段并回，帧序等导出产物不被旧值污染。"""
        old = {
            **_fresh_export(),
            "states": {
                "idle": {
                    "frames": [9, 9, 9],
                    "frameRate": 99,
                    "loop": False,
                    "referenceSpeed": 42,
                    "bubbleAnchor": 0.75,
                    "手写旁注": "不该被并回",
                },
            },
        }
        merged = merge_preserved_anim_fields(_fresh_export(), old)
        idle = merged["states"]["idle"]
        self.assertEqual(idle["referenceSpeed"], 42)
        self.assertEqual(idle["bubbleAnchor"], 0.75)
        self.assertEqual(idle["frames"], [0, 1, 2], "帧序必须是新导出的")
        self.assertEqual(idle["frameRate"], 8)
        self.assertTrue(idle["loop"])
        self.assertNotIn("手写旁注", idle, "per-state 是白名单，不在名单里的不并回")
        self.assertEqual(set(PRESERVED_STATE_FIELDS), {"referenceSpeed", "bubbleAnchor"})

    def test_new_export_value_wins_over_old(self) -> None:
        """新导出已显式给值的不被旧值覆盖（两侧同一条规则）。"""
        fresh = _fresh_export()
        fresh["normalBake"] = {"enabled": False, "downscale": 1}
        merged = merge_preserved_anim_fields(
            fresh, {**_fresh_export(), "normalBake": {"enabled": True, "downscale": 9}},
        )
        self.assertEqual(merged["normalBake"], {"enabled": False, "downscale": 1})

    def test_no_existing_file_is_noop(self) -> None:
        """首次导出（磁盘上没有旧文件）原样返回。"""
        fresh = _fresh_export()
        self.assertIs(merge_preserved_anim_fields(fresh, None), fresh)


if __name__ == "__main__":
    unittest.main()
