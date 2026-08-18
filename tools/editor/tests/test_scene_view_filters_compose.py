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
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
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


if __name__ == "__main__":
    unittest.main()
