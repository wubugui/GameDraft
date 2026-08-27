"""场景编辑器三条视图轴（过场 / 位面 / 时段）的正交性与缺省口径。

三条轴的分工，混了就是最难查的一类编辑器 bug（画布骗人，策划照着它排位）：

- **过场视图**：决定实体**存不存在**（cutsceneOnly 实体不加载；改它触发场景重载）
- **位面视图**：决定已加载实体**显不显**（`planes` 白名单）
- **时段视图**：同上（`phases` 白名单）

后两条都是后置显隐，必须**合成一个判定**再落 `set_entity_visible`。分开各贴各的
（本次改动之前 `_apply_plane_filter` 就是无条件覆写）会让"切位面把时段藏起来的实体
放出来"——这正是本文件第一组用例锁的东西。

时段轴的缺省**按实体种类分叉**，与运行时 `getNpcBaseVisibleForInteraction`（NPC 传
daylight 清单当 fallback）/ `getHotspotBaseEnabledForInteraction`（不传 fallback）同口径：
NPC 未写 phases = 只在「街上有人」的段；热点/区域未写 = 全时段都在。

时段轴还有**第四个输入**：实体所属分组的 `entityGroups[].phases`。它不是第四条轴，
而是**并进时段轴这一个判定**里的三级就近取用（自己 → 组 → 种类缺省）+ 组的整体限制。
本文件末尾两组用例锁它：一组打判定（零 Qt），一组打新画布的接线（组框也吃时段轴）。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import Qt
from PySide6.QtGui import QKeyEvent
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_canvas_model import iter_part_keys
from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.editors.scene_v2.changes import EntityProperty, EntityRef
from tools.editor.editors.scene_v2.commands import build_change_fields_command
from tools.editor.editors.scene_v2.groups import assign_group
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.project_model import ProjectModel
from tools.editor.shared.scene_view_filters import (
    ViewAxes,
    passes_group_box_filters,
    passes_view_filters,
)
from tools.editor.tests.qt_teardown import quiesce_scene_editor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENE_ID = "视图测试街"
_PHASES = [
    {"id": "辰", "from": "07:00", "label": "辰时", "daylight": True},
    {"id": "午", "from": "11:00", "label": "午时", "daylight": True},
    {"id": "暮", "from": "18:00", "label": "向晚"},
    {"id": "夜", "from": "20:00", "label": "入夜"},
]


def _scene() -> dict:
    return {
        "id": _SCENE_ID, "name": _SCENE_ID, "worldWidth": 800, "worldHeight": 600,
        "spawnPoint": {"x": 10, "y": 10},
        "dayNight": {"enabled": True},
        "npcs": [
            # 缺省：无 phases 无 planes —— 时段轴按 daylight 分叉，位面轴不限
            {"id": "npc_龙套", "name": "龙套", "x": 100, "y": 100, "interactionRange": 50},
            # 显式夜班：写了 phases 就按白名单，不吃缺省
            {"id": "npc_更夫", "name": "更夫", "x": 120, "y": 100, "interactionRange": 50,
             "phases": ["夜"]},
            # 两轴都写：位面 ∧ 时段都要通过
            {"id": "npc_阴间摊主", "name": "阴间摊主", "x": 140, "y": 100,
             "interactionRange": 50, "phases": ["夜"], "planes": ["yin"]},
        ],
        "hotspots": [
            # 缺省热点：时段轴**不吃** NPC 的 daylight 缺省，夜里照样在
            {"id": "hs_门", "type": "inspect", "x": 200, "y": 200, "interactionRange": 50},
            {"id": "hs_夜市摊", "type": "inspect", "x": 220, "y": 200,
             "interactionRange": 50, "phases": ["夜"]},
        ],
        "zones": [],
    }


class SceneViewFilterCompositionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(
        self, root: Path, phases: list[dict] | None = _PHASES, *, cutscene_npc: bool = False,
    ) -> SceneEditor:
        write_minimal_loadable_project(root)
        cfg_path = root / "public" / "assets" / "data" / "game_config.json"
        cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
        if phases is not None:
            cfg["dayNight"] = {"phases": phases}
        cfg_path.write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        model = ProjectModel()
        model.load_project(root)
        scene = _scene()
        if cutscene_npc:
            model.cutscenes.append({"id": "cs_夜访", "steps": []})
            # 仅过场实体：没写 phases，故同样吃时段轴的 daylight 缺省
            scene["npcs"].append({
                "id": "npc_过场鬼", "name": "过场鬼", "x": 160, "y": 100,
                "interactionRange": 50, "cutsceneIds": ["cs_夜访"],
            })
        model.scenes[_SCENE_ID] = scene
        editor = SceneEditor(model)
        editor._refill_scene_cutscene_ctx_combo(init=True)
        editor._refill_scene_phase_view_combo(init=True)
        editor._load_scene(_SCENE_ID)
        return editor

    def _close(self, editor: SceneEditor) -> None:
        canvas = getattr(editor, "_canvas", None)
        if canvas is not None:
            canvas._auto_fit_after_layout = False
            canvas._fit_layout_token += 1
        self._qt_app.processEvents()
        editor.close()
        editor.deleteLater()
        self._qt_app.processEvents()

    def _visible(self, editor: SceneEditor, kind: str, eid: str) -> bool:
        item = editor._canvas._entity_items.get(f"{kind}:{eid}")
        self.assertIsNotNone(item, f"{kind}:{eid} 不在画布上（应加载但没加载）")
        return bool(item.isVisible())

    # ---- 正交性：两条后置显隐轴不许互相冲掉 ----

    def test_plane_view_does_not_clobber_phase_view(self) -> None:
        """回归锁：先设时段视图，再切位面视图，被时段藏起来的实体**不许**冒出来。

        改动前 `_apply_plane_filter` 无条件 set_entity_visible，切位面即把时段判定覆写。
        """
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p")
            try:
                editor._canvas.set_phase_filter("夜", npc_default_phases=["辰", "午"])
                self.assertFalse(self._visible(editor, "npc", "npc_龙套"))
                # 切到「全部位面」——位面轴不设限，但不该把时段轴的判定带走
                editor._canvas.set_plane_filter(None)
                self.assertFalse(
                    self._visible(editor, "npc", "npc_龙套"),
                    "切位面视图把时段视图藏起来的 NPC 放出来了（两轴各自覆写）",
                )
            finally:
                self._close(editor)

    def test_phase_view_does_not_clobber_plane_view(self) -> None:
        """对称方向：先设位面视图，再切时段视图，被位面藏起来的实体不许冒出来。"""
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p")
            try:
                # 阴间摊主只属 yin 位面；选 normal 位面时它该消失
                editor._canvas.set_plane_filter("normal")
                self.assertFalse(self._visible(editor, "npc", "npc_阴间摊主"))
                editor._canvas.set_phase_filter("夜", npc_default_phases=["辰", "午"])
                self.assertFalse(
                    self._visible(editor, "npc", "npc_阴间摊主"),
                    "切时段视图把位面视图藏起来的 NPC 放出来了",
                )
            finally:
                self._close(editor)

    def test_both_axes_must_pass(self) -> None:
        """两轴是 and：位面对了、时段不对，照样不显示。"""
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p")
            try:
                editor._canvas.set_plane_filter("yin")
                editor._canvas.set_phase_filter("夜", npc_default_phases=["辰", "午"])
                self.assertTrue(self._visible(editor, "npc", "npc_阴间摊主"))
                editor._canvas.set_phase_filter("午")  # 位面仍对，时段不对
                self.assertFalse(self._visible(editor, "npc", "npc_阴间摊主"))
            finally:
                self._close(editor)

    # ---- 时段轴缺省：NPC 与 热点/区域 分叉 ----

    def test_npc_default_follows_daylight_but_hotspot_does_not(self) -> None:
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p")
            try:
                editor._canvas.set_phase_filter("午", npc_default_phases=["辰", "午"])
                self.assertTrue(self._visible(editor, "npc", "npc_龙套"))
                self.assertFalse(self._visible(editor, "npc", "npc_更夫"))
                self.assertTrue(self._visible(editor, "hotspot", "hs_门"))
                self.assertFalse(self._visible(editor, "hotspot", "hs_夜市摊"))

                editor._canvas.set_phase_filter("夜", npc_default_phases=["辰", "午"])
                self.assertFalse(
                    self._visible(editor, "npc", "npc_龙套"), "龙套夜里不该在街上")
                self.assertTrue(self._visible(editor, "npc", "npc_更夫"))
                self.assertTrue(
                    self._visible(editor, "hotspot", "hs_门"),
                    "热点不吃 NPC 的 daylight 缺省——门夜里当然还在",
                )
                self.assertTrue(self._visible(editor, "hotspot", "hs_夜市摊"))
            finally:
                self._close(editor)

    def test_empty_daylight_list_fails_open_for_npcs(self) -> None:
        """一段都没标 daylight（2026-08-18 事故形状）→ 缺省 NPC 全时段都在，不是全空。

        编辑器与运行时同口径：宁可画布上多几个人，也绝不静默清空整条街。
        """
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p")
            try:
                for phase in ("辰", "午", "暮", "夜"):
                    editor._canvas.set_phase_filter(phase, npc_default_phases=[])
                    self.assertTrue(
                        self._visible(editor, "npc", "npc_龙套"),
                        f"没标 daylight 时 {phase} 段把缺省 NPC 藏了（应 fail-open）",
                    )
            finally:
                self._close(editor)

    # ---- 第三条轴：过场视图（决定"存不存在"，与前两条不同层）----

    def test_cutscene_view_governs_existence_not_visibility(self) -> None:
        """不选过场 → cutsceneOnly 实体**根本不加载**（不是加载后隐藏）。

        这是它与位面/时段轴的本质区别：那两条是已加载实体的显隐开关。
        """
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p", cutscene_npc=True)
            try:
                self.assertNotIn("npc:npc_过场鬼", editor._canvas._entity_items)
                editor._combo_cutscene_ctx.set_committed_type("cs_夜访")
                editor._on_cutscene_edit_context_changed()
                self.assertIn(
                    "npc:npc_过场鬼", editor._canvas._entity_items,
                    "选了绑定过场后仅过场实体仍未加载",
                )
            finally:
                self._close(editor)

    def test_cutscene_entity_is_still_subject_to_phase_filter(self) -> None:
        """加载进来的过场实体**照样吃时段轴**——与运行时判定顺序一致。

        `SceneManager.getNpcBaseVisibleForInteraction` 里 `entityInPhase` 排在
        `isCutsceneOnlyEntity` 分支**之前**，所以没写 phases 的过场 NPC 在非白天
        时段同样不可见。这是个真陷阱（夜里摆的过场，NPC 会没影），画布必须如实照抄，
        不能"过场实体就一律显示"地糊弄过去。
        """
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p", cutscene_npc=True)
            try:
                editor._combo_cutscene_ctx.set_committed_type("cs_夜访")
                editor._on_cutscene_edit_context_changed()
                editor._canvas.set_phase_filter("午", npc_default_phases=["辰", "午"])
                self.assertTrue(self._visible(editor, "npc", "npc_过场鬼"))
                editor._canvas.set_phase_filter("夜", npc_default_phases=["辰", "午"])
                self.assertFalse(
                    self._visible(editor, "npc", "npc_过场鬼"),
                    "过场 NPC 没写 phases，夜里运行时是不可见的，画布不该显示",
                )
            finally:
                self._close(editor)

    # ---- 与模型的接线 ----

    def test_combo_candidates_come_from_config_and_mark_daylight(self) -> None:
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p")
            try:
                rows = list(editor._combo_phase_view._entries)
                labels = {v: a for a, v in rows}
                self.assertEqual(list(labels.keys()), ["", "辰", "午", "暮", "夜"])
                self.assertIn("街上有人", labels["辰"])
                self.assertIn("街上有人", labels["午"])
                self.assertNotIn("街上有人", labels["暮"])
                self.assertNotIn("街上有人", labels["夜"])
            finally:
                self._close(editor)

    def test_selecting_phase_through_the_combo_applies_to_canvas(self) -> None:
        """从最外层用户入口进：动下拉，而不是直接调 set_phase_filter。"""
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p")
            try:
                editor._combo_phase_view.set_committed_type("夜")
                editor._on_phase_view_changed()
                self.assertEqual(editor._canvas._phase_filter, "夜")
                self.assertEqual(editor._canvas._phase_npc_default, ["辰", "午"])
                self.assertFalse(self._visible(editor, "npc", "npc_龙套"))
                self.assertTrue(self._visible(editor, "npc", "npc_更夫"))

                editor._combo_phase_view.set_committed_type("")  # 回到「全部时段」
                editor._on_phase_view_changed()
                self.assertIsNone(editor._canvas._phase_filter)
                self.assertTrue(self._visible(editor, "npc", "npc_龙套"))
                self.assertTrue(self._visible(editor, "npc", "npc_更夫"))
            finally:
                self._close(editor)

    def test_view_state_survives_scene_reload(self) -> None:
        """切场景/重载后按同一视图重贴——与位面视图既有行为一致。"""
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p")
            try:
                editor._canvas.set_phase_filter("夜", npc_default_phases=["辰", "午"])
                editor._load_scene(_SCENE_ID, reset_view=False)
                self.assertFalse(
                    self._visible(editor, "npc", "npc_龙套"),
                    "重载后时段视图没重贴（登记表被清了却没按当前过滤套用）",
                )
                self.assertTrue(self._visible(editor, "npc", "npc_更夫"))
            finally:
                self._close(editor)

    def test_unconfigured_day_night_falls_back_to_builtin_table(self) -> None:
        """没配 dayNight 时候选回落内置四段，且 `day` 带「街上有人」标记。"""
        with TemporaryDirectory() as td:
            editor = self._editor(Path(td) / "p", phases=None)
            try:
                rows = list(editor._combo_phase_view._entries)
                labels = {v: a for a, v in rows}
                self.assertEqual(list(labels.keys()), ["", "dawn", "day", "dusk", "night"])
                self.assertIn("街上有人", labels["day"])
                self.assertNotIn("街上有人", labels["night"])
            finally:
                self._close(editor)


# ==== 分组的「时段归属」：并进时段轴的第四个输入，不是第四条轴 ==============

#: 判定层用例遍历的全部时段（辰/午 是「街上有人」，暮/夜 不是）
_ALL_PHASES = ("辰", "午", "暮", "夜")


class GroupPhaseCompositionTests(unittest.TestCase):
    """判定层（零 Qt）：`entityGroups[].phases` 怎样并进时段轴。

    公式与运行时 `SceneManager.entityInPhase` 逐字同构：

        in_phase(实体.phases, 当前时段, 组.phases ?? 种类缺省)
        and in_phase(组.phases, 当前时段, 无)

    出口仍然只有 `passes_view_filters` 一个 —— 这里全部经它调，不去单点
    `passes_phase`，免得用例反过来给"另开一条并行判定"背书。
    """

    DAYLIGHT = ("辰", "午")

    def _visible(self, kind: str, ent: dict, phase: str,
                 group: dict | None = None, **axis_kw) -> bool:
        axes = ViewAxes(phase_id=phase, npc_default_phases=self.DAYLIGHT, **axis_kw)
        return passes_view_filters(kind, ent, axes, group)

    def test_member_without_phases_follows_its_group(self) -> None:
        """**雾津送葬队伍那 13 个人的回归锁。**

        组配「夜」、成员一个都没写 phases。改动前成员落 NPC 的 daylight 缺省
        （辰/午），与组的夜是纯 AND —— 交集为空，13 个人一天 24 小时都不出现，
        而校验器全绿。改动后成员没写就**跟组走**。
        """
        grp = {"id": "送葬队伍", "phases": ["夜"]}
        mourner = {"id": "npc_孝子"}
        self.assertTrue(
            self._visible("npc", mourner, "夜", grp),
            "成员没写 phases、组写了夜 → 夜里必须在场（这就是那 13 个人）")
        self.assertFalse(
            self._visible("npc", mourner, "午", grp),
            "组只在夜，成员白天不该冒出来")
        # 分组是**异构容器**：同一个组里的热点也跟组走，
        # 不再享有「热点缺省全时段」——组是整体限制。
        coffin = {"id": "hs_棺"}
        self.assertTrue(self._visible("hotspot", coffin, "夜", grp))
        self.assertFalse(
            self._visible("hotspot", coffin, "午", grp),
            "组只在夜，组里的热点白天不该在（改动前热点缺省是全时段）")

    def test_member_phases_intersect_group_phases(self) -> None:
        """成员写了、组也写了 → **取交集**（组是整体限制，不是"就近取用就完了"）。"""
        grp = {"id": "夜市", "phases": ["暮", "夜"]}
        stallman = {"id": "npc_更夫", "phases": ["夜"]}
        self.assertTrue(self._visible("npc", stallman, "夜", grp))
        self.assertFalse(
            self._visible("npc", stallman, "暮", grp),
            "成员只写了夜，组的暮不该把成员放出来（成员没被组放宽）")
        self.assertFalse(self._visible("npc", stallman, "午", grp))
        # 反方向：成员写得比组宽，**组把它收窄**（组是整体限制，不是"就近取用完事"）
        night_only = {"id": "送葬队伍", "phases": ["夜"]}
        wide = {"id": "npc_扛幡的", "phases": ["暮", "夜"]}
        self.assertTrue(self._visible("npc", wide, "夜", night_only))
        self.assertFalse(
            self._visible("npc", wide, "暮", night_only),
            "组只在夜，成员写的暮不该越过组（改动前成员白名单说了算，暮是可见的）")

    def test_empty_intersection_is_never_visible(self) -> None:
        """交集为空 = 恒不可见。这类死内容本身仍然是死的 —— 本次改动消灭的是
        「成员没写就与组对撞」，不是"把作者写错的交集救活"。"""
        grp = {"id": "送葬队伍", "phases": ["夜"]}
        stray = {"id": "npc_串场的", "phases": ["午"]}
        for phase in _ALL_PHASES:
            self.assertFalse(
                self._visible("npc", stray, phase, grp),
                f"{phase}：组要夜、成员要午，交集为空却判成可见")

    def test_group_without_phases_is_byte_identical_to_before(self) -> None:
        """组没写 phases（或写了空数组、或压根没有组）→ 与改动前**完全一致**：
        NPC 走 daylight 缺省，热点/区域全时段。"""
        for grp in (None, {}, {"id": "常驻"}, {"id": "常驻", "phases": []},
                    {"id": "常驻", "phases": ["  "]}):
            for phase in _ALL_PHASES:
                self.assertEqual(
                    self._visible("npc", {"id": "npc_龙套"}, phase, grp),
                    phase in self.DAYLIGHT,
                    f"组={grp} 段={phase}：缺省 NPC 的口径变了")
                for kind in ("hotspot", "zone"):
                    self.assertTrue(
                        self._visible(kind, {"id": "x"}, phase, grp),
                        f"组={grp} 段={phase}：{kind} 的缺省被收窄了")

    def test_group_phase_does_not_clobber_the_plane_axis(self) -> None:
        """组的时段通过、位面不通过 → 仍然不可见（两轴是 and）。"""
        grp = {"id": "送葬队伍", "phases": ["夜"]}
        guide = {"id": "npc_引路人", "planes": ["yin"]}
        self.assertTrue(self._visible("npc", guide, "夜", grp, plane_id="yin"))
        self.assertFalse(
            self._visible("npc", guide, "夜", grp, plane_id="normal"),
            "组的时段对了就把位面判定冲掉了")

    def test_plane_axis_does_not_clobber_the_group_phase(self) -> None:
        """反方向：位面通过、组的时段不通过 → 仍然不可见。"""
        grp = {"id": "送葬队伍", "phases": ["夜"]}
        guide = {"id": "npc_引路人", "planes": ["yin"]}
        self.assertFalse(
            self._visible("npc", guide, "午", grp, plane_id="yin"),
            "位面对上了就把组的时段限制放掉了（改动前它走 daylight 缺省，午是白天）")

    def test_group_box_takes_the_phase_axis(self) -> None:
        """分组框自己也吃时段轴 —— 否则组切走后画布上留一个"框在、人没了"的空框。"""
        grp = {"id": "送葬队伍", "phases": ["夜"]}
        night = ViewAxes(phase_id="夜", npc_default_phases=self.DAYLIGHT)
        noon = ViewAxes(phase_id="午", npc_default_phases=self.DAYLIGHT)
        self.assertTrue(passes_group_box_filters(grp, night))
        self.assertFalse(passes_group_box_filters(grp, noon))
        # 组没写 phases → 不施加限制（分组**没有** NPC 那条只在白日的缺省：
        # 它是异构容器，可能同时装着人和门）
        for plain in (None, {}, {"id": "常驻"}, {"id": "常驻", "phases": []}):
            self.assertTrue(passes_group_box_filters(plain, noon))
            self.assertTrue(passes_group_box_filters(plain, night))

    def test_group_box_does_not_take_the_plane_or_cutscene_axis(self) -> None:
        """分组框**不**吃位面轴与过场轴。

        组 dict 里没有 `planes`，走 `passes_plane` 就落进「缺省实体」那一支，
        在 exclusive（独立世界型）位面视图下判为不存在 —— 一开梦境位面，
        全场分组框集体消失，而整组位移的唯一入口就是这个框。
        """
        grp = {"id": "送葬队伍", "phases": ["夜"]}
        exclusive = ViewAxes(plane_id="dream", plane_exclusive=True)
        self.assertTrue(passes_group_box_filters(grp, exclusive))
        self.assertTrue(passes_group_box_filters(
            grp, ViewAxes(plane_id="dream", plane_exclusive=True,
                          phase_id="夜", npc_default_phases=self.DAYLIGHT)))
        self.assertTrue(passes_group_box_filters(grp, ViewAxes(cutscene_id="cs_夜访")))

    def test_group_is_ignored_when_the_phase_axis_is_off(self) -> None:
        """没选时段视图 → 组的时段归属一个字都不该生效（纯视图，不是数据校验）。"""
        grp = {"id": "送葬队伍", "phases": ["夜"]}
        self.assertTrue(passes_view_filters("npc", {"id": "n"}, ViewAxes(), grp))
        self.assertTrue(passes_group_box_filters(grp, ViewAxes()))

    # ---- 场景总闸：scene.dayNight.enabled ----

    def test_the_scene_gate_turns_the_whole_phase_axis_off(self) -> None:
        """场景没开日夜 → **实体、分组、种类缺省全都不生效**，一律恒显。

        运行时 `SceneManager.entityInPhase` 首行就是这道闸
        （`currentScene?.dayNight?.enabled !== true` 直接 return true）。编辑器少了它，
        没开日夜的场景里配了 phases 的实体/分组会在画布上按时段被藏起来，而运行时
        它们恒显 —— 又一处"画布骗人"。
        """
        grp = {"id": "送葬队伍", "phases": ["夜"]}
        for phase in _ALL_PHASES:
            axes = ViewAxes(phase_id=phase, npc_default_phases=self.DAYLIGHT,
                            day_night_enabled=False)
            for ent in ({"id": "n"}, {"id": "n", "phases": ["夜"]},
                        {"id": "n", "phases": ["午"]}):
                self.assertTrue(
                    passes_view_filters("npc", ent, axes, grp),
                    f"{phase}：场景没开日夜，{ent} 却被时段轴藏了")
            self.assertTrue(
                passes_group_box_filters(grp, axes),
                f"{phase}：场景没开日夜，分组框却被组的 phases 藏了")

    def test_the_scene_gate_does_not_touch_the_plane_axis(self) -> None:
        """总闸只关时段这一条轴。关掉日夜不等于把位面过滤一起放掉。"""
        axes = ViewAxes(phase_id="午", npc_default_phases=self.DAYLIGHT,
                        plane_id="normal", day_night_enabled=False)
        self.assertFalse(
            passes_view_filters("npc", {"id": "n", "planes": ["yin"]}, axes),
            "总闸把位面轴一起关了")

    def test_the_scene_gate_defaults_to_open(self) -> None:
        """缺省必须是 `True`（= 与本字段加入之前逐字一致）。

        缺省若是 `False`，所有没显式传这个字段的既有调用方会瞬间失去时段过滤 ——
        那是静默行为翻转：画布一夜之间把全部实体都显示出来，而没有任何报错。
        """
        self.assertTrue(ViewAxes().day_night_enabled)
        grp = {"id": "送葬队伍", "phases": ["夜"]}
        for phase in _ALL_PHASES:
            axes = ViewAxes(phase_id=phase, npc_default_phases=self.DAYLIGHT)
            self.assertEqual(
                passes_view_filters("npc", {"id": "npc_孝子"}, axes, grp),
                phase == "夜", f"{phase}：不传总闸的调用方口径变了")
            self.assertEqual(
                passes_group_box_filters(grp, axes), phase == "夜",
                f"{phase}：不传总闸时分组框的口径变了")
            self.assertEqual(
                passes_view_filters("npc", {"id": "npc_龙套"}, axes),
                phase in self.DAYLIGHT, f"{phase}：不传总闸时 NPC 缺省的口径变了")


_V2_SCENE = "分组时段街"
#: 同一份内容、只是**没开日夜**。运行时对它恒显（`entityInPhase` 首行就 return true），
#: 画布必须照抄——这是「总闸」那一组用例的对照场景。
_NO_DN_SCENE = "没开日夜街"


def _group_scene() -> dict:
    """一份"组配了时段、成员大多没写"的场景 —— 雾津街头那份死内容的最小形状。"""
    return {
        "id": _V2_SCENE, "name": _V2_SCENE, "worldWidth": 800, "worldHeight": 600,
        "spawnPoint": {"x": 10, "y": 10},
        "dayNight": {"enabled": True},
        "entityGroups": [
            {"id": "送葬队伍", "label": "雾津送葬队伍", "phases": ["夜"]},
            {"id": "常驻", "label": "常驻摊子"},
        ],
        "npcs": [
            # 成员没写 phases：改动前落 daylight 缺省，与组的夜对撞 = 全天不可见
            {"id": "npc_孝子", "name": "孝子", "x": 100, "y": 100,
             "interactionRange": 50, "group": "送葬队伍"},
            # 组没配时段 → 与改前一致（走 NPC 的 daylight 缺省）
            {"id": "npc_摊主", "name": "摊主", "x": 150, "y": 100,
             "interactionRange": 50, "group": "常驻"},
            # 成员写了午、组要夜 → 交集为空，恒不可见
            {"id": "npc_串场的", "name": "串场的", "x": 170, "y": 100,
             "interactionRange": 50, "group": "送葬队伍", "phases": ["午"]},
            # 组的时段 × 位面轴：两条不许互相冲掉
            {"id": "npc_引路人", "name": "引路人", "x": 190, "y": 100,
             "interactionRange": 50, "group": "送葬队伍", "planes": ["yin"]},
            # 没有组的对照组
            {"id": "npc_龙套", "name": "龙套", "x": 210, "y": 100,
             "interactionRange": 50},
        ],
        "hotspots": [
            {"id": "hs_棺", "type": "inspect", "x": 300, "y": 200,
             "interactionRange": 50, "group": "送葬队伍"},
        ],
        "zones": [],
    }


def _group_scene_without_day_night() -> dict:
    """同一份内容，去掉 `dayNight` 这一块（= 场景没开日夜，缺省形状）。"""
    sc = _group_scene()
    sc["id"] = sc["name"] = _NO_DN_SCENE
    sc.pop("dayNight", None)
    return sc


class SceneV2GroupPhaseWiringTests(unittest.TestCase):
    """新画布的接线：组的时段归属真的落到画布显隐与分组框上。

    判定对了不等于画布对了 —— 中间还隔着"按成员的 group 标签查表"这一步，
    以及"改完组的时段要重贴显隐"这一步。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        cfg_path = root / "public" / "assets" / "data" / "game_config.json"
        cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
        cfg["dayNight"] = {"phases": _PHASES}
        cfg_path.write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.scenes[_V2_SCENE] = _group_scene()
        self.model.scenes[_NO_DN_SCENE] = _group_scene_without_day_night()
        self.page = SceneEditorV2(self.model)
        self.page.refresh_scene_list()
        self.page.load_scene(_V2_SCENE)

    def tearDown(self) -> None:
        self.page.deleteLater()
        self._qt_app.processEvents()
        self._tmp.cleanup()

    # ---- 断言小工具 ----

    def _phase(self, phase: str | None, **axis_kw) -> None:
        self.page.set_view_axes(ViewAxes(
            phase_id=phase, npc_default_phases=("辰", "午"), **axis_kw))

    def _visible(self, kind: str, eid: str) -> bool:
        items = self.page.view.items_of(EntityRef(kind, eid))
        self.assertTrue(items, f"{kind}:{eid} 不在画布上（应加载但没加载）")
        states = {bool(i.isVisible()) for i in items}
        self.assertEqual(
            len(states), 1,
            f"{kind}:{eid} 的图元显隐不一致 —— 藏了一半（圆点没了、人还站着）")
        return states.pop()

    def _box_visible(self, gid: str) -> bool:
        box = self.page.view.group_boxes.get(gid)
        self.assertIsNotNone(box, f"分组框 {gid} 不在画布上")
        return bool(box.isVisible())

    def _boxes_action(self):
        for act in self.page._toolbar.actions():
            if act.text() == "分组框":
                return act
        self.fail("工具栏上没有「分组框」总开关")

    # ---- 用例 ----

    def test_members_without_phases_follow_the_group(self) -> None:
        """**那 13 个人的画布级回归。** 组配夜、成员没写 → 夜里在，白天不在。"""
        self._phase("夜")
        self.assertTrue(
            self._visible("npc", "npc_孝子"),
            "组配了夜、成员没写 phases —— 改动前它走 daylight 缺省，一天都不出现")
        self.assertTrue(self._visible("hotspot", "hs_棺"))
        self._phase("午")
        self.assertFalse(self._visible("npc", "npc_孝子"))
        self.assertFalse(
            self._visible("hotspot", "hs_棺"),
            "组只在夜，组里的热点白天不该在")

    def test_group_without_phases_keeps_the_old_kind_fork(self) -> None:
        """没配时段的组 → 成员照旧按种类缺省判（改动前后逐字一致）。"""
        self._phase("午")
        self.assertTrue(self._visible("npc", "npc_摊主"))
        self.assertTrue(self._visible("npc", "npc_龙套"))
        self._phase("夜")
        self.assertFalse(self._visible("npc", "npc_摊主"), "NPC 缺省仍只在白日段")
        self.assertFalse(self._visible("npc", "npc_龙套"))

    def test_empty_intersection_member_never_shows(self) -> None:
        for phase in _ALL_PHASES:
            self._phase(phase)
            self.assertFalse(
                self._visible("npc", "npc_串场的"),
                f"{phase}：组要夜、成员要午，交集为空却显示了")

    def test_group_phase_and_plane_axis_do_not_clobber_each_other(self) -> None:
        self._phase("夜", plane_id="yin")
        self.assertTrue(self._visible("npc", "npc_引路人"))
        # 位面对、组的时段不对
        self._phase("午", plane_id="yin")
        self.assertFalse(
            self._visible("npc", "npc_引路人"),
            "切位面把组的时段限制冲掉了")
        # 组的时段对、位面不对
        self._phase("夜", plane_id="normal")
        self.assertFalse(
            self._visible("npc", "npc_引路人"),
            "组的时段对上了就把位面判定冲掉了")

    def test_group_box_follows_the_phase_axis(self) -> None:
        """组切到自己时段之外时，框要跟着隐去 —— 不然是个"框在、人没了"的空框。"""
        self._phase("夜")
        self.assertTrue(self._box_visible("送葬队伍"))
        self._phase("午")
        self.assertFalse(
            self._box_visible("送葬队伍"),
            "成员整批藏了、框还留着 —— 用户会以为成员数据丢了")
        self.assertTrue(self._box_visible("常驻"), "没配时段的组不该被时段轴碰")

    def test_a_hidden_group_box_is_not_a_click_target(self) -> None:
        """藏起来的框不许还能点中、还留着选中态。

        命中判定走 `GroupBoxTool` 自己那本册子（只比几何、不看 isVisible），
        留在册子里就是个看不见的点击靶：用户以为点的是空白，实际选中了一个组，
        再按方向键就把整组坐标改了，而画布上一个动的东西都没有。
        """
        tool = self.page.group_box_tool
        self._phase("夜")
        tool.select_group("送葬队伍")
        self.assertEqual(tool.selected_gid, "送葬队伍")
        self._phase("午")                       # 组切到自己时段之外
        self.assertNotIn("送葬队伍", tool._boxes, "看不见的框还留在命中册子里")
        self.assertEqual(tool.selected_gid, "", "框藏了，选中态还粘着")
        self.assertIn("常驻", tool._boxes, "还在的框被一起摘掉了")

    def test_group_box_survives_an_exclusive_plane_view(self) -> None:
        """分组框**不**吃位面轴：一开梦境位面全场组框消失的话，
        整组位移就没有入口了（组 dict 里根本没有 `planes` 键）。"""
        self.page.set_view_axes(ViewAxes(plane_id="dream", plane_exclusive=True))
        for gid in ("送葬队伍", "常驻"):
            self.assertTrue(self._box_visible(gid), f"{gid} 的框被位面轴藏掉了")
        # 成员确实被 exclusive 位面藏了 —— 放行组框不等于把 exclusive 语义放掉
        self.assertFalse(self._visible("hotspot", "hs_棺"))

    def test_group_box_toggle_does_not_resurrect_a_hidden_box(self) -> None:
        """「分组框」总开关关了再开，不该把时段轴藏起来的框放出来
        （框的显隐 = 总开关 ∧ 时段轴，**合成一次**再落）。"""
        self._phase("午")
        act = self._boxes_action()
        act.setChecked(False)
        self.assertFalse(self._box_visible("常驻"))
        act.setChecked(True)
        self.assertTrue(self._box_visible("常驻"))
        self.assertFalse(
            self._box_visible("送葬队伍"),
            "总开关把时段轴藏起来的空框又点亮了")

    def test_editing_the_group_phases_reapplies_presence(self) -> None:
        """改完组的「时段归属」画布要当场变 —— 不变的话用户会以为没生效去改数据。"""
        self._phase("午")
        self.assertFalse(self._visible("npc", "npc_孝子"))
        self.assertFalse(self._box_visible("送葬队伍"))
        cmd = build_change_fields_command(
            self.page.document, [EntityRef("group", "送葬队伍")],
            [{"phases": ["午"]}], EntityProperty.PRESENCE, "改组的时段")
        self.assertIsNotNone(cmd, "前置条件：改组时段应当构造出一条命令")
        self.page.document.push(cmd)
        self.assertTrue(
            self._visible("npc", "npc_孝子"), "组的时段改了，成员显隐没重贴")
        self.assertTrue(self._box_visible("送葬队伍"), "组的时段改了，框没重贴")
        self.page.editor_undo()
        self.assertFalse(self._visible("npc", "npc_孝子"), "撤销后没退回去")

    def test_reassigning_a_member_reapplies_presence(self) -> None:
        """换组 = 换一套时段归属，显隐要跟着走。"""
        self._phase("午")
        self.assertTrue(self._visible("npc", "npc_摊主"))
        assign_group(self.page.document, [EntityRef("npc", "npc_摊主")], "送葬队伍")
        self.assertFalse(
            self._visible("npc", "npc_摊主"),
            "指派进只在夜的组之后，白天还显示着")

    def test_group_phases_survive_a_scene_reload(self) -> None:
        """重投影/重载后按当前轴重贴 —— 否则过滤静默失效，画布显示的是"全部"。"""
        self._phase("午")
        self.assertFalse(self._visible("npc", "npc_孝子"))
        self.page.reload_from_model()
        self.assertFalse(
            self._visible("npc", "npc_孝子"), "重投影后组的时段过滤没重贴")
        self.assertFalse(self._box_visible("送葬队伍"))

    def test_a_scene_without_day_night_ignores_every_phase(self) -> None:
        """**场景总闸（新画布这一条）。** 没开日夜的场景里，实体与分组的 phases
        都不生效 —— 运行时对它们恒显，画布必须照抄。

        接线点在**装载路径与下拉回调**上（`set_view_axes` 仍是原样照收的裸设置器），
        所以这条从最外层用户入口进：动时段下拉、切场景，不手捏 `ViewAxes`。
        轴的选择跨场景保留，而"这个场景开没开日夜"是场景自己的事 —— 不接的话，
        从开了日夜的场景切过来，时段过滤会继续按上一个场景的闸把人藏着。
        """
        combo = self.page._axis_combos["phase"]
        combo.setCurrentIndex(combo.findData("午"))
        self.assertFalse(self._visible("npc", "npc_孝子"), "前置条件：开了日夜时该藏")
        self.page.load_scene(_NO_DN_SCENE)
        for phase in _ALL_PHASES:
            combo.setCurrentIndex(combo.findData(phase))
            self.assertTrue(
                self._visible("npc", "npc_孝子"),
                f"{phase}：场景没开日夜，组的 phases 却把成员藏了")
            self.assertTrue(
                self._visible("npc", "npc_串场的"),
                f"{phase}：场景没开日夜，成员自己的 phases 却生效了")
            self.assertTrue(
                self._visible("npc", "npc_龙套"),
                f"{phase}：场景没开日夜，NPC 的 daylight 缺省却生效了")
            self.assertTrue(
                self._box_visible("送葬队伍"),
                f"{phase}：场景没开日夜，分组框却被时段轴藏了")

    def test_phase_combo_is_the_outermost_entry(self) -> None:
        """从用户入口进：动时段下拉，而不是直接调 `set_view_axes`。"""
        combo = self.page._axis_combos["phase"]
        idx = combo.findData("夜")
        self.assertGreaterEqual(idx, 0, "时段下拉里没有「夜」（候选没接上 game_config）")
        combo.setCurrentIndex(idx)
        self.assertTrue(
            self._visible("npc", "npc_孝子"), "选了夜，送葬队伍的成员应当出现")
        self.assertFalse(self._visible("npc", "npc_龙套"), "缺省 NPC 夜里不该在街上")
        combo.setCurrentIndex(combo.findData("午"))
        self.assertFalse(self._visible("npc", "npc_孝子"))
        self.assertFalse(self._box_visible("送葬队伍"))


class OldCanvasGroupPhaseWiringTests(unittest.TestCase):
    """老画布的接线：组的时段归属必须与新画布**逐段相同**。

    为什么要单独打老画布：`tools/editor/scene_page_registry.py` 的 `NAV_TARGET`
    仍然是 `"v1"`，老画布是全局搜索 / 引用跳转的**唯一落点**，不是退役代码。
    分组这一支落地时只接了新画布，于是同一份雾津街头在两个画布上表现**逐段相反**：
    老画布切「夜」13 个送葬 NPC 全隐、切「辰」全显，而运行时正好反过来。
    策划照着老画布排位，排的是一个游戏里根本不存在的场面。

    断言口径按**图元层**（`PART_TABLE` 的每一个 part）而不是只看圆点 ——
    「藏一个实体 = 藏它的每一个图元」是另一条硬契约，判定对了不等于藏对了。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        cfg_path = root / "public" / "assets" / "data" / "game_config.json"
        cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
        cfg["dayNight"] = {"phases": _PHASES}
        cfg_path.write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.scenes[_V2_SCENE] = _group_scene()
        self.model.scenes[_NO_DN_SCENE] = _group_scene_without_day_night()
        self._editors: list[SceneEditor] = []

    def tearDown(self) -> None:
        for ed in self._editors:
            quiesce_scene_editor(ed)
            ed.deleteLater()
        self._qt_app.processEvents()
        self._tmp.cleanup()

    # ---- 断言小工具 ----

    def _old(self, scene_id: str = _V2_SCENE) -> SceneEditor:
        ed = SceneEditor(self.model)
        self._editors.append(ed)
        ed._refill_scene_cutscene_ctx_combo(init=True)
        ed._refill_scene_plane_view_combo(init=True)
        ed._refill_scene_phase_view_combo(init=True)
        ed._load_scene(scene_id)
        return ed

    def _set_phase(self, ed: SceneEditor, phase: str) -> None:
        """从最外层用户入口进：动时段下拉，而不是直接调 `set_phase_filter`。"""
        ed._combo_phase_view.set_committed_type(phase)
        ed._on_phase_view_changed()

    def _visible(self, ed: SceneEditor, kind: str, eid: str) -> bool:
        """**这个实体的每一个 part** 的显隐；不一致就是"藏了一半"，当场报错。"""
        states: set[bool] = set()
        for part, key in iter_part_keys(kind, eid):
            if key is None:                      # 不住 _entity_items 的 part
                adapter = ed._canvas._part_adapters.get((kind, part))
                if adapter is None:
                    continue
                item = adapter["item_of"](eid)
                if item is not None:
                    states.add(bool(item.isVisible()))
                continue
            item = ed._canvas._entity_items.get(key)
            if item is not None:
                states.add(bool(item.isVisible()))
        runtime = ed._scene_npc_runtimes.get(eid)   # NPC 精灵的闸门在 runtime 上
        if runtime is not None:
            states.add(bool(runtime.visible))
        self.assertTrue(states, f"{kind}:{eid} 在老画布上一个图元都没有（应加载）")
        self.assertEqual(
            len(states), 1,
            f"{kind}:{eid} 的图元显隐不一致 —— 藏了一半（圆点没了、人还站着）")
        return states.pop()

    def _box_visible(self, ed: SceneEditor, gid: str) -> bool:
        box = ed._canvas.group_box(gid)
        self.assertIsNotNone(box, f"分组框 {gid} 不在老画布上")
        return bool(box.isVisible())

    # ---- 用例 ----

    def test_members_without_phases_follow_the_group(self) -> None:
        """**那 13 个人的老画布回归。** 组配夜、成员没写 → 夜里在，白天不在。

        改动前 `_record_entity_view` 只存 (planes, phases)，成员的 `group` 标签压根
        没进登记表，于是判定拿不到组：成员落 NPC 的 daylight 缺省，夜里全隐、白天全显
        —— 与运行时逐段相反。
        """
        ed = self._old()
        self._set_phase(ed, "夜")
        self.assertTrue(
            self._visible(ed, "npc", "npc_孝子"),
            "组配了夜、成员没写 phases —— 老画布把 13 个送葬 NPC 在夜里全藏了")
        self.assertTrue(self._visible(ed, "hotspot", "hs_棺"))
        self._set_phase(ed, "午")
        self.assertFalse(
            self._visible(ed, "npc", "npc_孝子"),
            "组只在夜，成员白天不该冒出来（老画布此前白天把他们全显示了）")
        self.assertFalse(
            self._visible(ed, "hotspot", "hs_棺"),
            "组只在夜，组里的热点白天不该在")

    def test_old_canvas_matches_the_new_canvas_phase_by_phase(self) -> None:
        """**本轮的主回归：两套画布逐段对拍。**

        同一份场景、同一个模型，四个时段各判一遍；任何一格不一致都意味着策划在
        两个画布上会看到两个不同的场面，而其中至少一个是假的。
        """
        old = self._old()
        new = SceneEditorV2(self.model)
        new.load_scene(_V2_SCENE)
        combo = new._axis_combos["phase"]
        try:
            for phase in _ALL_PHASES:
                self._set_phase(old, phase)
                combo.setCurrentIndex(combo.findData(phase))
                for kind, eid in (("npc", "npc_孝子"), ("npc", "npc_摊主"),
                                  ("npc", "npc_串场的"), ("npc", "npc_引路人"),
                                  ("npc", "npc_龙套"), ("hotspot", "hs_棺")):
                    items = new.view.items_of(EntityRef(kind, eid))
                    self.assertTrue(items, f"前置条件：新画布上 {kind}:{eid} 应有图元")
                    self.assertEqual(
                        self._visible(old, kind, eid),
                        all(i.isVisible() for i in items),
                        f"{phase} 段 {kind}:{eid}：老画布与新画布判得不一样")
                for gid in ("送葬队伍", "常驻"):
                    new_box = new.view.group_boxes.get(gid)
                    self.assertIsNotNone(new_box, f"前置条件：新画布上应有 {gid} 的框")
                    self.assertEqual(
                        self._box_visible(old, gid), bool(new_box.isVisible()),
                        f"{phase} 段 {gid} 的分组框：老画布与新画布判得不一样")
        finally:
            new.deleteLater()
            self._qt_app.processEvents()

    def test_group_box_takes_the_phase_axis(self) -> None:
        """老画布的分组框也吃时段轴 —— 否则组切走后留一个"框在、人没了"的空框。"""
        ed = self._old()
        self._set_phase(ed, "夜")
        self.assertTrue(self._box_visible(ed, "送葬队伍"))
        self._set_phase(ed, "午")
        self.assertFalse(
            self._box_visible(ed, "送葬队伍"),
            "成员整批藏了、框还留着 —— 用户会以为成员数据丢了")
        self.assertTrue(self._box_visible(ed, "常驻"), "没配时段的组不该被时段轴碰")

    def test_a_hidden_group_box_is_not_an_arrow_key_target(self) -> None:
        """被时段轴藏起来的框不许还是**方向键**的操作靶。

        点选那一侧由 Qt 兜住（`QGraphicsScene.items(pos)` 只返回可见图元，实测确认），
        方向键微移这条路却是画布自己判的：此前它只看「分组框」总开关，于是组切到
        自己时段之外、框已经不见了，按方向键照样在改整组坐标 —— 用户按着方向键，
        画布上一个动的东西都没有，而数据在动。
        """
        ed = self._old()
        self._set_phase(ed, "夜")
        ed._canvas.set_selected_group("送葬队伍")
        nudges: list[tuple] = []
        ed._canvas.group_nudge.connect(lambda *a: nudges.append(a))
        press = QKeyEvent(QKeyEvent.Type.KeyPress, Qt.Key.Key_Left,
                          Qt.KeyboardModifier.NoModifier)
        ed._canvas.keyPressEvent(press)
        self.assertEqual(len(nudges), 1, "前置条件：框可见时方向键应当推得动")
        self._set_phase(ed, "午")
        self.assertFalse(self._box_visible(ed, "送葬队伍"), "前置条件：框应已被时段轴藏起")
        ed._canvas.keyPressEvent(press)
        self.assertEqual(
            len(nudges), 1, "框被时段轴藏了，方向键还在推整组坐标")

    def test_group_box_survives_an_exclusive_plane_view(self) -> None:
        """老画布的分组框**不**吃位面轴（与新画布同口径）。

        组 dict 里没有 `planes`，走 `passes_plane` 就落进「缺省实体」那一支：
        一开独立世界型位面，全场组框集体消失，而整组位移的唯一入口就是这个框。
        """
        ed = self._old()
        ed._canvas.set_plane_filter("dream", exclusive=True)
        for gid in ("送葬队伍", "常驻"):
            self.assertTrue(
                self._box_visible(ed, gid), f"{gid} 的框被位面轴藏掉了")
        # 成员确实被 exclusive 位面藏了 —— 放行组框不等于把 exclusive 语义放掉
        self.assertFalse(self._visible(ed, "hotspot", "hs_棺"))

    def test_group_box_toggle_does_not_resurrect_a_hidden_box(self) -> None:
        """「分组框」总开关关了再开，不该把时段轴藏起来的空框放出来
        （框的显隐 = 总开关 ∧ 时段轴，**合成一次**再落）。"""
        ed = self._old()
        self._set_phase(ed, "午")
        ed._canvas.set_group_boxes_visible(False)
        self.assertFalse(self._box_visible(ed, "常驻"))
        ed._canvas.set_group_boxes_visible(True)
        self.assertTrue(self._box_visible(ed, "常驻"))
        self.assertFalse(
            self._box_visible(ed, "送葬队伍"),
            "总开关把时段轴藏起来的空框又点亮了")

    def test_a_scene_without_day_night_ignores_every_phase(self) -> None:
        """**场景总闸（老画布这一条）。** 没开日夜的场景里，实体与分组的 phases
        都不生效 —— 运行时对它们恒显（`entityInPhase` 首行），画布必须照抄。
        """
        ed = self._old(_NO_DN_SCENE)
        for phase in _ALL_PHASES:
            self._set_phase(ed, phase)
            self.assertTrue(
                self._visible(ed, "npc", "npc_孝子"),
                f"{phase}：场景没开日夜，组的 phases 却把成员藏了")
            self.assertTrue(
                self._visible(ed, "npc", "npc_串场的"),
                f"{phase}：场景没开日夜，成员自己的 phases 却生效了")
            self.assertTrue(
                self._visible(ed, "npc", "npc_龙套"),
                f"{phase}：场景没开日夜，NPC 的 daylight 缺省却生效了")
            self.assertTrue(
                self._box_visible(ed, "送葬队伍"),
                f"{phase}：场景没开日夜，分组框却被时段轴藏了")

    def test_the_gate_follows_the_scene_not_the_axis_selection(self) -> None:
        """总闸跟着**场景**走，不跟着轴的选择走：切到没开日夜的场景，
        上一个场景的闸不许继续生效（时段选择本身是保留的，那是另一回事）。"""
        ed = self._old(_V2_SCENE)
        self._set_phase(ed, "午")
        self.assertFalse(self._visible(ed, "npc", "npc_孝子"), "前置条件：这一份开了日夜")
        ed._load_scene(_NO_DN_SCENE, reset_view=False)
        self.assertEqual(ed._combo_phase_view.committed_type(), "午",
                         "前置条件：切场景不该把时段选择清掉")
        self.assertTrue(
            self._visible(ed, "npc", "npc_孝子"),
            "切到没开日夜的场景后，还按上一个场景的总闸把成员藏着")


if __name__ == "__main__":
    unittest.main()
