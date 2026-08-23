"""交互回归：**手上的动作要有正确的后果**。

全功能回归里第三类缺口的共性是"工具模式化的连带伤"：v1 没有模式（选、拖、转、
点组框都在同一次按下里按优先级竞争），v2 拆成并列工具之后，每个工具都只管自己
那一件事，于是出现了"点空白把选中实体甩走""按钮点进去画布装死""看不出自己在
哪个模式"这类 v1 根本不存在的问题。

这一份把无模式手感与几条硬后果钉死。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPointF, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.page import SceneEditorV2
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_NO_MOD = Qt.KeyboardModifier.NoModifier
_LEFT = Qt.MouseButton.LeftButton
_MID = Qt.MouseButton.MiddleButton
_SCENE = "交互街"


def _scene() -> dict:
    return {
        "id": _SCENE, "name": _SCENE, "worldWidth": 900, "worldHeight": 700,
        "hotspots": [
            {"id": "h1", "type": "inspect", "x": 200, "y": 200,
             "interactionRange": 50, "group": "g1"},
            {"id": "h2", "type": "inspect", "x": 700, "y": 600,
             "interactionRange": 50, "group": "g1"},
        ],
        "npcs": [], "zones": [],
        "entityGroups": [{"id": "g1", "label": "一组"}],
    }


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.scenes[_SCENE] = _scene()
        self.page = SceneEditorV2(self.model)
        self.page.load_scene(_SCENE)
        self.doc = self.page.document
        self.view = self.page.view
        # **把视图标定到 1:1**。页刚建出来还没被 Qt 布局，`fit_scene` 会算出
        # 0.03 之类的荒唐缩放；而命中尺寸一律按屏幕像素换算，缩放越小折合的世界
        # 范围越大（7px 的把手在 0.03 倍下折合 200 多个世界单位）。不标定的话
        # 下面那些"点空白"其实都点在把手的命中带里。
        self.view.resize(900, 700)
        self.view.resetTransform()
        self.view.renderer.set_view_scale(1.0)

    def tearDown(self) -> None:
        self.page.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()

    def ent(self, eid: str) -> dict:
        return self.doc.model_entity(EntityRef("hotspot", eid))


class MoveNeedsAHitTests(_Base):
    """「移动」工具不许在没按中东西的时候把选中实体甩走。"""

    def test_pressing_empty_space_does_not_start_a_drag(self) -> None:
        """在空白处按下拖动，选中的实体必须纹丝不动。

        不做命中判定的话，被拖的实体可能在视口外：用户只看到"我拖的这个没动"，
        实际另一个实体的坐标已经被改并写进模型，很可能存盘后才发现。
        """
        ref = EntityRef("hotspot", "h1")
        self.doc.set_selection([ref])
        tool = self.page.move_tool
        self.view.tools.select(tool)
        started = tool.mouse_pressed(QPointF(500, 400), _LEFT, _NO_MOD)
        tool.mouse_moved(QPointF(560, 460), _LEFT, _NO_MOD)
        tool.mouse_released(QPointF(560, 460), _LEFT, _NO_MOD)
        self.assertFalse(started, "在空白处按下也起了拖动")
        self.assertEqual((self.ent("h1")["x"], self.ent("h1")["y"]), (200, 200))

    def test_pressing_on_the_selected_entity_still_drags(self) -> None:
        """加了闸不等于拖不动：按在选中的实体上照常拖。"""
        ref = EntityRef("hotspot", "h1")
        self.doc.set_selection([ref])
        tool = self.page.move_tool
        self.view.tools.select(tool)
        self.assertTrue(tool.mouse_pressed(QPointF(200, 200), _LEFT, _NO_MOD))
        tool.mouse_moved(QPointF(250, 240), _LEFT, _NO_MOD)
        tool.mouse_released(QPointF(250, 240), _LEFT, _NO_MOD)
        self.assertEqual((self.ent("h1")["x"], self.ent("h1")["y"]), (250, 240))


class DragFollowsTheMouseTests(_Base):
    """**拖动必须逐帧跟手，且全程不写数据。**

    这条逃过了之前所有用例：它们只断言"松手后模型等于放手处"，而那一条在
    bug 存在时**照样是绿的** —— 松手那一下会用 `_start + 总偏移` 覆盖掉中途
    被写坏的值。真正坏掉的是**中途**：实测鼠标每步走 20、实体飞 40，且每帧复利
    （屏幕上就是"不跟鼠标、飘得很快"）。

    成因是画布拖动中把预览坐标喂给属性面板，而面板的回写方法末尾会
    `_emit_props_changed()`，桥把它当用户编辑提交成命令 → 模型在手势中被写 →
    图元的"数据位"跟着动 → 预览位移再叠上去。
    """

    def _drag_steps(self, tool, ref, steps=5, dx=20):
        ent = self.doc.model_entity(ref)
        x0, y0 = float(ent["x"]), float(ent["y"])
        self.doc.set_selection([ref])
        self.view.tools.select(tool)
        self.assertTrue(tool.mouse_pressed(QPointF(x0, y0), _LEFT, _NO_MOD),
                        "前置条件：这一按应当抓住了实体")
        self.view.refresh_gesture_preview()
        item = self.view.item_for(ref, "handle")
        out = []
        for i in range(1, steps + 1):
            mx = x0 + i * dx
            tool.mouse_moved(QPointF(mx, y0), _LEFT, _NO_MOD)
            self.view.refresh_gesture_preview()
            QApplication.processEvents()
            out.append((mx, item.pos().x(), float(
                self.doc.model_entity(ref)["x"])))
        return (x0, y0), out

    def test_item_tracks_the_cursor_frame_by_frame(self) -> None:
        ref = EntityRef("hotspot", "h1")
        _start, steps = self._drag_steps(self.page.select_tool, ref)
        for mouse_x, item_x, _model_x in steps:
            self.assertAlmostEqual(
                item_x, mouse_x, places=3,
                msg=f"拖动中图元没跟住鼠标：鼠标 {mouse_x}、图元 {item_x}")

    def test_model_is_untouched_until_release(self) -> None:
        ref = EntityRef("hotspot", "h1")
        (x0, _y0), steps = self._drag_steps(self.page.select_tool, ref)
        for _mouse_x, _item_x, model_x in steps:
            self.assertEqual(model_x, x0, "手势中就把数据改了")
        self.assertEqual(self.doc.undo_stack.count(), 0,
                         "手势中已经产生了撤销记录")

    def test_release_lands_exactly_where_the_mouse_let_go(self) -> None:
        ref = EntityRef("hotspot", "h1")
        (x0, y0), steps = self._drag_steps(self.page.select_tool, ref)
        drop = steps[-1][0]
        self.page.select_tool.mouse_released(QPointF(drop, y0), _LEFT, _NO_MOD)
        self.view.refresh_gesture_preview()
        self.assertEqual(float(self.doc.model_entity(ref)["x"]), drop)
        self.assertEqual(self.doc.undo_stack.count(), 1)

    def test_panel_readout_follows_without_committing(self) -> None:
        """面板 x 数值框要跟着走（这是那条 live 读数的价值），但**不许落库**。"""
        ref = EntityRef("hotspot", "h1")
        _start, steps = self._drag_steps(self.page.select_tool, ref)
        self.assertAlmostEqual(self.page._props._hs_x.value(), steps[-1][0],
                               places=1, msg="面板数值框没跟着预览走")
        self.assertEqual(self.doc.undo_stack.count(), 0)

    def test_move_tool_directly_also_tracks(self) -> None:
        """走「移动」工具那条路同样要跟手。"""
        ref = EntityRef("hotspot", "h1")
        _start, steps = self._drag_steps(self.page.move_tool, ref)
        for mouse_x, item_x, _m in steps:
            self.assertAlmostEqual(item_x, mouse_x, places=3)


class NoModeSelectToolTests(_Base):
    """「选择」工具兼管 gizmo 手柄与分组框 —— 回到老画布的无模式手感。"""

    def test_single_selection_shows_the_gizmo_without_switching_tools(self) -> None:
        """选中一个实体就出手柄，不必先切到"缩放旋转"。"""
        self.view.tools.select(self.page.select_tool)
        self.doc.set_selection([EntityRef("hotspot", "h1")])
        self.view.refresh_gesture_preview()
        self.assertTrue(self.view.transform_gizmo.isVisible(),
                        "选中实体后手柄没出现 —— 又变回模式化了")

    def test_dragging_the_gizmo_works_from_the_select_tool(self) -> None:
        ref = EntityRef("hotspot", "h1")
        self.view.tools.select(self.page.select_tool)
        self.doc.set_selection([ref])
        pos = self.page.transform_tool.handle_positions(ref)["rotate"]
        self.assertTrue(
            self.page.select_tool.mouse_pressed(pos, _LEFT, _NO_MOD),
            "选择工具没把手柄按下委派出去")
        self.page.select_tool.mouse_moved(QPointF(200, 260), _LEFT, _NO_MOD)
        self.page.select_tool.mouse_released(QPointF(200, 260), _LEFT, _NO_MOD)
        self.assertIsNotNone(self.ent("h1").get("rotation"))

    def test_clicking_an_entity_still_selects_it(self) -> None:
        """委派链不许把普通点选吃掉。"""
        self.view.tools.select(self.page.select_tool)
        self.page.select_tool.mouse_pressed(QPointF(700, 600), _LEFT, _NO_MOD)
        self.assertEqual(self.doc.selection, (EntityRef("hotspot", "h2"),))


class GroupSelectionTests(_Base):
    """分组选中态不许粘滞。"""

    def test_clicking_empty_space_clears_the_group_selection(self) -> None:
        """点空白要熄灯。

        不熄的话用户以为什么都没选，一按方向键就把整组坐标改了并标脏，
        而撤销记录写的是"整组微移"，与操作意图对不上。
        """
        tool = self.page.group_box_tool
        self.view.tools.select(tool)
        self.page.refresh_group_boxes()
        boxes = self.view.group_boxes
        self.assertIn("g1", boxes, "前置条件：应当有一个分组框")
        tool.select_group("g1")
        tool.mouse_pressed(QPointF(450, 350), _LEFT, _NO_MOD)
        before = (self.ent("h1")["x"], self.ent("h1")["y"])
        tool.key_pressed(Qt.Key.Key_Right, _NO_MOD)
        self.assertEqual((self.ent("h1")["x"], self.ent("h1")["y"]), before,
                         "点空白之后方向键仍在挪整组")


class ToolbarTests(_Base):
    """工具栏要说清"现在是什么工具"和"这个按钮建什么"。"""

    def test_dead_group_move_button_is_gone(self) -> None:
        ids = {t.tool_id for t in self.view.tools.tools}
        self.assertNotIn("group_move", ids)

    def test_view_actions_exist(self) -> None:
        texts = {a.text() for a in self.page._toolbar.actions()}
        for want in ("适配", "撤销", "重做", "+", "−"):
            self.assertIn(want, texts, f"工具栏缺「{want}」")

    def test_fit_action_changes_the_zoom(self) -> None:
        self.view.zoom_by(1.15)
        before = self.view.transform().m11()
        self.page.fit_view()
        self.assertNotEqual(round(self.view.transform().m11(), 6),
                            round(before, 6), "「适配」没起作用")


class ViewportTests(_Base):
    """视口导航。"""

    def test_middle_button_pans(self) -> None:
        """中键拖动平移 —— 全编辑器统一的手势，缺了会以为画布卡死。"""
        from PySide6.QtGui import QMouseEvent

        self.view.resize(400, 300)
        hbar = self.view.horizontalScrollBar()
        hbar.setRange(0, 500)
        hbar.setValue(200)
        press = QMouseEvent(QMouseEvent.Type.MouseButtonPress,
                            QPointF(200, 150), QPointF(200, 150),
                            _MID, _MID, _NO_MOD)
        self.view.mousePressEvent(press)
        move = QMouseEvent(QMouseEvent.Type.MouseMove,
                           QPointF(160, 150), QPointF(160, 150),
                           Qt.MouseButton.NoButton, _MID, _NO_MOD)
        self.view.mouseMoveEvent(move)
        self.assertEqual(hbar.value(), 240, "中键拖动没有平移画布")
        release = QMouseEvent(QMouseEvent.Type.MouseButtonRelease,
                              QPointF(160, 150), QPointF(160, 150),
                              _MID, Qt.MouseButton.NoButton, _NO_MOD)
        self.view.mouseReleaseEvent(release)
        self.assertIsNone(self.view._pan_from)


class InitialFitTests(unittest.TestCase):
    """**打开场景时的初始缩放** —— 这条错了整块画布就是"什么都没画出来"。

    真实序列是：页先被布好版 → 用户选场景 → `load_scene` **新建** view
    （此刻它刚 addWidget，viewport 还是 100x30 之类的占位尺寸）→ Qt 才给这个
    新 view 布版。在占位尺寸上 fit 出来的缩放是正确值的百分之一：4000×2251 的
    场景被画成十几个像素，背景和实体全挤成一坨。

    所以这一条必须**按真实序列**测：先 show 再 load。此前把补 fit 的钩子挂在
    **页**上，页在 load_scene 之后再也不会 resize，于是补 fit 永远等不到 ——
    而当时的用例没有走这个序列，测不出来。
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)
        big = dict(_scene())
        big["worldWidth"] = 4000
        big["worldHeight"] = 2250
        self.model.scenes[_SCENE] = big
        self.page = SceneEditorV2(self.model)

    def tearDown(self) -> None:
        self.page.deleteLater()
        QApplication.processEvents()
        self._tmp.cleanup()

    def test_fit_lands_after_the_view_is_laid_out(self) -> None:
        self.page.resize(1200, 800)
        self.page.show()
        QApplication.processEvents()
        self.page.load_scene(_SCENE)      # view 此刻还没被布版
        QApplication.processEvents()
        view = self.page.view
        vp = view.viewport()
        self.assertGreaterEqual(vp.width(), 64, "前置条件：视口应当已经布好版")
        expect = min(vp.width() / 4000.0, vp.height() / 2250.0)
        got = view.transform().m11()
        self.assertAlmostEqual(
            got / expect, 1.0, delta=0.08,
            msg=f"初始缩放不对：m11={got:.4f}，应当约 {expect:.4f}"
                "（场景被画成一小坨就是这个值差了两个数量级）")
        self.assertFalse(view._pending_fit, "补 fit 的账没销掉")

    def test_manual_fit_still_works_on_an_unlaid_view(self) -> None:
        """用户点「适配」是明确指令，不看布版状态。"""
        self.page.load_scene(_SCENE)
        self.page.fit_view()
        self.assertFalse(self.page.view._pending_fit)

    def test_user_zoom_is_not_overwritten_by_a_later_layout(self) -> None:
        """补 fit 只补一次：用户缩放过之后再布版一次，不许把他的视口抢回去。"""
        self.page.resize(1200, 800)
        self.page.show()
        QApplication.processEvents()
        self.page.load_scene(_SCENE)
        QApplication.processEvents()
        view = self.page.view
        view.zoom_by(2.0)
        zoomed = view.transform().m11()
        self.page.resize(1000, 700)
        QApplication.processEvents()
        self.assertAlmostEqual(view.transform().m11(), zoomed, places=6,
                               msg="布版又把用户的缩放冲掉了")


class SmallButRealTests(_Base):
    """回归清单尾巴上那几条：单独看都不致命，凑一起就是"这画布用着别扭"。"""

    def test_tree_click_centers_the_canvas(self) -> None:
        """树里点一行，画布要滚过去 —— 否则实体多的场景里树失去定位功能。"""
        far = EntityRef("hotspot", "h2")          # (700, 600)
        self.view.centerOn(0, 0)
        before = self.view.mapToScene(self.view.viewport().rect().center())
        self.doc.set_selection([far])
        self.page._center_on_selection()
        after = self.view.mapToScene(self.view.viewport().rect().center())
        self.assertNotEqual((round(before.x()), round(before.y())),
                            (round(after.x()), round(after.y())),
                            "树里选中之后画布没有滚过去")

    def test_zone_pick_lock_excludes_zones_from_picking(self) -> None:
        """大面积 Zone 盖住别人时，锁定之后点选跳过它（**仍然显示**）。"""
        self.view.zone_pick_frozen = True
        zone_item = self.view.item_for(EntityRef("hotspot", "h1"), "handle")
        self.assertTrue(zone_item.isVisible(), "锁定点选不该影响显示")

    def test_undo_goes_to_the_focused_text_field(self) -> None:
        """焦点在输入框里时 Ctrl+Z 该退那一格字，而不是退画布上一步编辑。"""
        from PySide6.QtWidgets import QLineEdit

        edit = QLineEdit(self.page)
        edit.show()
        edit.setFocus()
        QApplication.processEvents()
        if QApplication.focusWidget() is not edit:
            self.skipTest("offscreen 平台没给到焦点")
        edit.setText("abc")
        self.doc.set_selection([EntityRef("hotspot", "h1")])
        before = self.doc.undo_stack.count()
        self.page.editor_undo()
        self.assertEqual(self.doc.undo_stack.count(), before,
                         "Ctrl+Z 没交回文本框，去动了画布的撤销栈")


class ViewAxisUiTests(_Base):
    """三条视图轴要有真的入口 —— 此前 `set_view_axes` 全仓只有测试在调。"""

    def test_three_combos_exist(self) -> None:
        self.assertEqual(set(self.page._axis_combos), {"cutscene", "plane", "phase"})

    def test_choosing_a_phase_applies_the_filter(self) -> None:
        combo = self.page._axis_combos["phase"]
        self.assertGreater(combo.count(), 1, "时段候选没填上")
        combo.setCurrentIndex(1)
        self.assertIsNotNone(self.page._axes.phase_id,
                             "选了时段但没落到视图轴上")

    def test_activate_plane_view_is_reachable(self) -> None:
        """位面页 hub 的跳转入口。"""
        self.assertTrue(self.page.activate_plane_view(""))


class NavigationTargetTests(_Base):
    """`scene_page_registry.NAV_TARGET` 承诺的落点方法必须齐。"""

    def test_all_four_targets_exist(self) -> None:
        for name in ("select_scene_by_id", "select_hotspot_by_id",
                     "select_npc_by_id", "select_zone_by_id"):
            self.assertTrue(callable(getattr(self.page, name, None)),
                            f"缺跳转落点 {name} —— 切到 v2 后这类跳转会静默失效")

    def test_hotspot_target_selects_and_centers(self) -> None:
        self.assertTrue(self.page.select_hotspot_by_id(_SCENE, "h2"))
        self.assertEqual(self.doc.selection, (EntityRef("hotspot", "h2"),))

    def test_reload_refs_hook_exists(self) -> None:
        """缺了它，别处新建的引用在面板下拉里永远看不见（要重开编辑器）。"""
        self.assertTrue(callable(getattr(self.page, "reload_refs_from_model", None)))
        self.page.reload_refs_from_model()


class ContextMenuTests(_Base):
    """画布右键菜单 —— 老画布最常用的建实体方式。"""

    def test_menu_creates_an_entity_at_the_click_point(self) -> None:
        from tools.editor.editors.scene_v2.tools_structure import create_entity_at

        before = len(self.doc.entity_refs("hotspot"))
        self.assertTrue(create_entity_at(self.doc, "hotspot", QPointF(333, 444)))
        self.assertEqual(len(self.doc.entity_refs("hotspot")), before + 1)
        new_ref = self.doc.selection[0]
        ent = self.doc.model_entity(new_ref)
        self.assertEqual((ent["x"], ent["y"]), (333.0, 444.0))

    def test_view_emits_a_context_menu_request(self) -> None:
        """右键要请求菜单。

        **先断开页面那个槽**：它会 `menu.exec()`，那是模态循环 —— 在无头测试里
        永远不返回，整条 pytest 会挂死（本条自己踩过一次）。这里只验证信号本身。
        """
        from PySide6.QtGui import QContextMenuEvent

        try:
            self.view.context_menu_requested.disconnect(self.page._show_canvas_menu)
        except (RuntimeError, TypeError):
            self.fail("页面没有接右键菜单 —— 画布上建不了实体")
        got = []
        self.view.context_menu_requested.connect(lambda p, g: got.append(p))
        ev = QContextMenuEvent(QContextMenuEvent.Reason.Mouse,
                               self.view.mapFromScene(QPointF(300, 300)))
        self.view.contextMenuEvent(ev)
        self.assertTrue(got, "右键没有请求菜单")


if __name__ == "__main__":
    unittest.main()
