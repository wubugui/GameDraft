"""三条视图轴的判定只准有**一份**实现。

`agent_docs/editor-tools/mechanisms/scene-view-filter-axes.md` 的硬契约里最要紧的
一条是"后置显隐轴必须合成一个判定"。如果新老画布各写一份，这件事就变成两份实现
各自维护 —— 正是本次重建要消灭的东西。

本文件锁两件事：判定语义（含那几个反直觉的缺省），以及**老画布真的在用共享实现**。
"""
from __future__ import annotations

import unittest
from pathlib import Path

from tools.editor.shared.scene_view_filters import (
    ViewAxes,
    entity_cutscene_ids,
    entity_is_cutscene_only,
    norm_id_list,
    passes_cutscene,
    passes_phase,
    passes_plane,
    passes_view_filters,
)

REPO = Path(__file__).resolve().parents[3]


class NormalisationTests(unittest.TestCase):
    def test_missing_and_empty_are_both_default(self) -> None:
        """"写了个空数组"与"没写"在作者意图上是一回事。"""
        self.assertIsNone(norm_id_list(None))
        self.assertIsNone(norm_id_list([]))
        self.assertIsNone(norm_id_list(["", "   "]))
        self.assertIsNone(norm_id_list("不是列表"))

    def test_strips_and_keeps_order(self) -> None:
        self.assertEqual(norm_id_list([" a ", "b"]), ["a", "b"])


class PlaneAxisTests(unittest.TestCase):
    def test_inactive_axis_passes_everything(self) -> None:
        self.assertTrue(passes_plane({"planes": ["yin"]}, ViewAxes()))

    def test_membership(self) -> None:
        axes = ViewAxes(plane_id="yin")
        self.assertTrue(passes_plane({"planes": ["yin"]}, axes))
        self.assertFalse(passes_plane({"planes": ["yang"]}, axes))

    def test_default_entity_follows_the_world_model(self) -> None:
        """缺省实体：shared 位面存在 / exclusive（独立世界型）不存在。"""
        self.assertTrue(passes_plane({}, ViewAxes(plane_id="yin")))
        self.assertFalse(
            passes_plane({}, ViewAxes(plane_id="yin", plane_exclusive=True)))


class PhaseAxisTests(unittest.TestCase):
    DAYLIGHT = ("辰", "午")

    def test_inactive_axis_passes_everything(self) -> None:
        self.assertTrue(passes_phase("npc", {}, ViewAxes()))

    def test_explicit_phases_win(self) -> None:
        axes = ViewAxes(phase_id="夜", npc_default_phases=self.DAYLIGHT)
        self.assertTrue(passes_phase("npc", {"phases": ["夜"]}, axes))
        self.assertFalse(passes_phase("npc", {"phases": ["辰"]}, axes))

    def test_default_forks_by_entity_kind(self) -> None:
        """**缺省按种类分叉** —— 与位面轴唯一的形状差别。"""
        night = ViewAxes(phase_id="夜", npc_default_phases=self.DAYLIGHT)
        self.assertFalse(passes_phase("npc", {}, night),
                         "未写 phases 的 NPC 夜里不该在街上")
        self.assertTrue(passes_phase("hotspot", {}, night),
                        "门、路牌夜里当然还在")
        self.assertTrue(passes_phase("zone", {}, night))

    def test_empty_daylight_list_fails_open(self) -> None:
        """一段都没标 daylight 时**不施加限制** —— 宁可多显示，绝不静默清空整场景。"""
        axes = ViewAxes(phase_id="夜", npc_default_phases=())
        self.assertTrue(passes_phase("npc", {}, axes))


class CutsceneAxisTests(unittest.TestCase):
    ONLY = {"cutsceneIds": ["cs_夜访"], "cutsceneOnly": True}
    BOUND = {"cutsceneIds": ["cs_夜访"]}

    def test_unbound_entity_always_exists(self) -> None:
        self.assertTrue(passes_cutscene({}, ViewAxes()))

    def test_bound_but_not_only_always_exists(self) -> None:
        self.assertTrue(passes_cutscene(self.BOUND, ViewAxes()))

    def test_cutscene_only_needs_the_matching_context(self) -> None:
        self.assertFalse(passes_cutscene(self.ONLY, ViewAxes()))
        self.assertFalse(passes_cutscene(self.ONLY, ViewAxes(cutscene_id="cs_别的")))
        self.assertTrue(passes_cutscene(self.ONLY, ViewAxes(cutscene_id="cs_夜访")))

    def test_helpers(self) -> None:
        self.assertEqual(entity_cutscene_ids(self.ONLY), ("cs_夜访",))
        self.assertTrue(entity_is_cutscene_only(self.ONLY))
        self.assertFalse(entity_is_cutscene_only(self.BOUND))


class CompositionTests(unittest.TestCase):
    """**合成一个判定** —— 三条轴串成一串 and。"""

    def test_all_axes_must_pass(self) -> None:
        axes = ViewAxes(plane_id="yin", phase_id="夜", npc_default_phases=("辰",))
        ent = {"planes": ["yin"], "phases": ["夜"]}
        self.assertTrue(passes_view_filters("npc", ent, axes))
        self.assertFalse(passes_view_filters(
            "npc", {"planes": ["yang"], "phases": ["夜"]}, axes))
        self.assertFalse(passes_view_filters(
            "npc", {"planes": ["yin"], "phases": ["辰"]}, axes))

    def test_cutscene_only_entity_still_eats_the_other_axes(self) -> None:
        """判定顺序照抄运行时：仅过场实体**同样吃**时段与位面过滤，
        画布不得为了"方便编辑"擅自放行。"""
        axes = ViewAxes(cutscene_id="cs_夜访", phase_id="夜",
                        npc_default_phases=("辰",))
        ent = {"cutsceneIds": ["cs_夜访"], "cutsceneOnly": True}
        self.assertFalse(passes_view_filters("npc", ent, axes),
                         "仅过场 NPC 未写 phases，夜里仍该被时段轴挡住")

    def test_no_active_axis_shows_everything(self) -> None:
        self.assertTrue(passes_view_filters("npc", {"planes": ["yin"]}, ViewAxes()))
        self.assertFalse(ViewAxes().any_active)


class OldCanvasUsesTheSharedImplementationTests(unittest.TestCase):
    """老画布必须真的在调共享判定，而不是留着自己那份。"""

    def setUp(self) -> None:
        self.src = (REPO / "tools/editor/editors/scene_editor.py").read_text(
            encoding="utf-8")

    def test_it_imports_the_shared_module(self) -> None:
        self.assertIn("from ..shared.scene_view_filters import", self.src)

    def test_it_no_longer_reimplements_the_phase_fork(self) -> None:
        """缺省分叉的实现只准有一处 —— 老画布里不该再出现第二份。"""
        self.assertNotIn("self._phase_npc_default) or pf in self._phase_npc_default",
                         self.src,
                         "老画布又留了一份时段缺省分叉的实现")

    def test_old_canvas_predicates_delegate(self) -> None:
        from tools.editor.editors import scene_editor as se
        import inspect
        body = inspect.getsource(se.SceneCanvas._entity_visible_under_view_filters)
        self.assertIn("passes_plane", body)
        self.assertIn("passes_phase", body)


if __name__ == "__main__":
    unittest.main()
