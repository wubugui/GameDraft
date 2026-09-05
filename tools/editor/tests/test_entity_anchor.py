# -*- coding: utf-8 -*-
"""锚点(`NpcDef.anchor`)的编辑器侧闸门:形状校验 + 面板往返 + 缺省不落键。

缺省锚点(底中=脚底)是**锚点可配之前的唯一行为**,所以"缺省不落键"不只是格式洁癖:
一旦缺省值被写进 JSON,全库实体的 diff 会集体炸开,而语义一个字没变。
"""
from __future__ import annotations

import unittest

import json
from pathlib import Path
from tempfile import TemporaryDirectory

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project
from tools.editor.validator import validate
from tools.editor.shared.entity_transform_math import (
    entity_anchor_of,
    entity_contact_offset,
    is_default_entity_anchor,
)


#: "这个键根本不存在" —— 与 "值是 None" 分开
_ABSENT = object()


class AnchorDefaultsTests(unittest.TestCase):
    def test_absent_anchor_is_the_foot(self) -> None:
        ax, ay = entity_anchor_of({})
        self.assertEqual((ax, ay), (0.5, 1.0))
        self.assertTrue(is_default_entity_anchor(ax, ay))

    def test_default_anchor_means_zero_contact_offset(self) -> None:
        """缺省锚点的接地偏移恒 (0,0) —— 排序锚 / 阴影脚点 / 透视采样点逐位不变。"""
        for d in ({}, {"anchor": {"x": 0.5, "y": 1.0}}, {"anchor": {}}):
            self.assertEqual(entity_contact_offset(d, 60.0, 150.0), (0.0, 0.0), msg=repr(d))

    def test_centre_anchor_offsets_by_half_height(self) -> None:
        off = entity_contact_offset({"anchor": {"x": 0.5, "y": 0.5}}, 14.0, 14.0)
        self.assertAlmostEqual(off[0], 0.0, places=9)
        self.assertAlmostEqual(off[1], 7.0, places=9)

    def test_out_of_range_anchor_is_clamped_not_rejected(self) -> None:
        """运行时对越界锚点钳到 [0,1];Python 兜底必须是 TS 权威的**子集**,不许更严。"""
        self.assertEqual(entity_anchor_of({"anchor": {"x": -3, "y": 9}}), (0.0, 1.0))
        self.assertEqual(entity_anchor_of({"anchor": {"x": "x", "y": None}}), (0.5, 1.0))


class AnchorValidatorTests(unittest.TestCase):
    """校验器只报 warning：运行时对越界锚点钳制、对非数回落缺省，兜底更严就会拦死合法数据。"""

    def _anchor_issues(self, anchor) -> list:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            npc = {"id": "n1", "name": "n1", "x": 10.0, "y": 20.0,
                   "interactionRange": 0}
            if anchor is not _ABSENT:
                npc["anchor"] = anchor
            scene = {"id": "S1", "name": "S1", "worldWidth": 400.0,
                     "worldHeight": 300.0,
                     "spawnPoint": {"x": 10.0, "y": 20.0}, "npcs": [npc]}
            sp = root / "public" / "assets" / "scenes"
            sp.mkdir(parents=True, exist_ok=True)
            # write_bytes + chr(10)：Windows 上 write_text 会把换行翻成 CRLF
            (sp / "S1.json").write_bytes(
                (json.dumps(scene, ensure_ascii=False, indent=2)
                 + chr(10)).encode("utf-8"))
            model = ProjectModel()
            model.load_project(root)
            return [i for i in validate(model) if "anchor" in i.message]

    def test_out_of_range_anchor_warns(self) -> None:
        found = self._anchor_issues({"x": 5, "y": -1})
        self.assertTrue(found, "越界锚点应报")
        self.assertTrue(all(i.severity == "warning" for i in found),
                        [(i.severity, i.message) for i in found])

    def test_non_dict_anchor_warns(self) -> None:
        found = self._anchor_issues([0.5, 0.5])
        self.assertTrue(found)
        self.assertTrue(all(i.severity == "warning" for i in found))

    def test_default_and_absent_anchor_are_silent(self) -> None:
        for anc in (_ABSENT, {"x": 0.5, "y": 1.0}):
            self.assertEqual(self._anchor_issues(anc), [], msg=repr(anc))


if __name__ == "__main__":
    unittest.main()
