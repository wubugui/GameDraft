"""场景分组的画布代理框：选中、整组位移、把手、撤销。

护栏语义（每条对应一个真实用户入口，不允许只在 model 层验）：
- 组框是从最外层鼠标事件点中并拖动的，不是直接调平移函数；
- 位移的对象是**模型层成员名册**：cutsceneOnly / 位面过滤隐藏的成员也必须跟着动，
  否则留下"半份移动"的坏数据（与批量删除 P1-B 同一个坑）；
- npc.patrol.route、zone.polygon、旧世界坐标 collisionPolygon 一并平移；
- 一次手势 = 一条撤销命令；零位移点击不入栈不标脏；Esc 原路回滚；
- 组框不进 Qt 选择系统：橡皮筋框选/批量删除的目标集合里永远没有它。
"""
from __future__ import annotations

import copy
import os
import sys
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtCore import QPoint, QPointF, QRectF, Qt
from PySide6.QtGui import QKeyEvent
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor, _SceneGroupBox
from tools.editor.project_model import ProjectModel
from tools.editor.shared.entity_sort_math import anchor_collision_polygon_to_world
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


def _scene() -> dict:
    return {
        "id": "sc_a",
        "name": "甲场景",
        "hotspots": [
            {
                "id": "h1", "type": "inspect", "label": "", "x": 100, "y": 120,
                "interactionRange": 50, "data": {"text": ""}, "group": "夜巡",
                # 局部坐标碰撞多边形：挂在锚点上，整组位移时**不该**再被平移一次
                "collisionPolygon": [{"x": -10, "y": -10}, {"x": 10, "y": -10},
                                     {"x": 10, "y": 10}],
                "collisionPolygonLocal": True,
                "unknownMember": {"keep": True},
            },
            # 仅过场实体：画布上不建图元，但整组位移必须带上它
            {
                "id": "h_cut", "type": "inspect", "label": "", "x": 300, "y": 300,
                "interactionRange": 50, "data": {"text": ""}, "group": "夜巡",
                "cutsceneIds": ["cs_x"], "cutsceneOnly": True,
            },
        ],
        "npcs": [
            {
                "id": "n1", "name": "甲", "x": 160, "y": 180,
                "interactionRange": 50, "group": "夜巡",
                "patrol": {"route": [{"x": 160, "y": 180}, {"x": 260, "y": 180}]},
                # 刻意写成**旧的世界坐标**形状：加载期迁移（shared/scene_migrations.py）
                # 会把它就地转成局部坐标并打标，本夹具因此顺带把迁移也跑成了端到端用例。
                "collisionPolygon": [{"x": 150, "y": 170}, {"x": 170, "y": 170},
                                     {"x": 170, "y": 190}],
            },
            {"id": "n_free", "name": "乙", "x": 500, "y": 400, "interactionRange": 50},
        ],
        "zones": [
            {
                "id": "z1", "group": "夜巡",
                "polygon": [{"x": 60, "y": 60}, {"x": 200, "y": 60},
                            {"x": 200, "y": 200}, {"x": 60, "y": 200}],
            },
        ],
        "entityGroups": [
            {"id": "夜巡", "label": "夜巡队", "unknownGroup": {"keep": 9}},
        ],
        "unknownScene": {"keep": 7},
    }


class SceneGroupCanvasMoveTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[SceneEditor] = []

    def tearDown(self) -> None:
        for ed in self._editors:
            try:
                ed._scene_npc_anim_timer.stop()
                ed._patrol_overlay_refresh_timer.stop()
                ed._canvas._gfx.blockSignals(True)
            except Exception:
                pass
            ed.deleteLater()
        QApplication.processEvents()

    def _editor(self, root: Path) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {"sc_a": _scene()}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        model._dirty.clear()
        model._dirty_scene_ids.clear()
        model._dirty_scenes_all = False
        ed._undo.clear()
        ed.resize(1200, 800)
        ed.show()
        QApplication.processEvents()
        ed._canvas.fit_all()
        QApplication.processEvents()
        # 关掉「布局稳定后再 fit 一次」的延后步骤：它会在随后的 resize/show 事件里
        # 重新 resetTransform+fitInView，让本测试算好的屏幕坐标失效（并行跑时尤其
        # 明显，串行侥幸能过）。视图变换锁死后，鼠标坐标换算才是确定的。
        ed._canvas._auto_fit_after_layout = False
        QApplication.processEvents()
        return ed, model

    # ---- helpers ----------------------------------------------------------

    @staticmethod
    def _ent(model: ProjectModel, coll: str, eid: str) -> dict:
        for row in model.scenes["sc_a"][coll]:
            if row.get("id") == eid:
                return row
        raise AssertionError(f"missing {coll}:{eid}")

    def _assert_points_close(self, actual, expected, msg: str = "") -> None:
        """坐标序列按容差比。

        断言的是"每个成员挪了同一个 Δ"，不是浮点位模式：拖动的世界 Δ 由视口像素经
        视图变换换算而来（如 96.1），而各成员基准值量级不同，`(160+96.1)-160` 得
        96.10000000000002、`(100+96.1)-100` 得 96.1 —— 用 assertEqual 比就是在赌
        Δ 恰好是二进制可精确表示的数（缩放一变就赌输，本文件曾因此在整套跑时红三条）。
        """
        act = [tuple(float(v) for v in pt) for pt in actual]
        exp = [tuple(float(v) for v in pt) for pt in expected]
        self.assertEqual(len(act), len(exp), f"{msg}（点数不同：{act} vs {exp}）")
        for i, (a, e) in enumerate(zip(act, exp)):
            self.assertEqual(len(a), len(e), f"{msg}（第 {i} 点维度不同）")
            for j, (av, ev) in enumerate(zip(a, e)):
                self.assertAlmostEqual(
                    av, ev, places=6,
                    msg=f"{msg}（第 {i} 点第 {j} 维：{act} vs {exp}）")

    def _assert_point_close(self, actual, expected, msg: str = "") -> None:
        self._assert_points_close([actual], [expected], msg)

    @staticmethod
    def _tree_item(ed: SceneEditor, ref: tuple[str, str]):
        for item in ed._iter_entity_tree_items():
            data = item.data(0, Qt.ItemDataRole.UserRole)
            if data and tuple(data) == ref:
                return item
        raise AssertionError(f"tree ref missing: {ref}")

    def _box(self, ed: SceneEditor, gid: str = "夜巡") -> _SceneGroupBox:
        box = ed._canvas.group_box(gid)
        self.assertIsNotNone(box, f"分组框缺失: {gid}")
        return box

    def _select_box(self, ed: SceneEditor, gid: str = "夜巡") -> None:
        """两段式的第一段：点一下框边选中该组（不产生位移）。"""
        from PySide6.QtTest import QTest

        box = self._box(ed, gid)
        pos = ed._canvas.mapFromScene(box.mapToScene(box._w / 2.0, 0.0))
        vp = ed._canvas.viewport()
        QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=pos)
        QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=pos)
        QApplication.processEvents()

    def _drag_box_edge(
        self, ed: SceneEditor, dx: int, dy: int, *, gid: str = "夜巡",
        release: bool = True, esc: bool = False, select_first: bool = True,
    ) -> None:
        """从最外层入口拖组框：先点选中（两段式），再按住上边线拖。"""
        from PySide6.QtTest import QTest

        if select_first and not self._box(ed, gid).is_selected():
            self._select_box(ed, gid)
        box = self._box(ed, gid)
        top_mid = box.mapToScene(box._w / 2.0, 0.0)
        start = ed._canvas.mapFromScene(top_mid)
        vp = ed._canvas.viewport()
        QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start)
        QTest.mouseMove(vp, pos=start + QPoint(dx // 2, dy // 2))
        QTest.mouseMove(vp, pos=start + QPoint(dx, dy))
        if esc:
            ed._canvas.keyPressEvent(QKeyEvent(
                QKeyEvent.Type.KeyPress, Qt.Key.Key_Escape,
                Qt.KeyboardModifier.NoModifier))
        if release:
            QTest.mouseRelease(
                vp, Qt.MouseButton.LeftButton, pos=start + QPoint(dx, dy))
        QApplication.processEvents()

    # ---- 选中 -------------------------------------------------------------

    def test_group_boxes_exist_and_are_not_qt_selectable(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            box = self._box(ed)
            self.assertIs(ed._canvas._entity_items.get("group:夜巡"), box,
                          "组框须登记进 _entity_items 供聚焦/定位")
            self.assertFalse(
                bool(box.flags() & box.GraphicsItemFlag.ItemIsSelectable),
                "组框不得进 Qt 选择系统（否则框选/批量删除会误伤分组）")
            # 直接尝试选中也无效 → 批量操作集合里永远没有 group
            box.setSelected(True)
            self.assertNotIn(("group", "夜巡"), ed._canvas_selected_entity_refs())

    def test_click_box_selects_group_and_opens_panel(self) -> None:
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            # 先选中一个实体，验证点组框会把它顶掉而不是反过来
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("npc", "n1")))
            QApplication.processEvents()

            # 未选中的组只能从框边选（把手仅在选中后才吃鼠标，免得挡住成员）
            box = self._box(ed)
            edge_vp = ed._canvas.mapFromScene(box.mapToScene(box._w / 2.0, 0.0))
            vp = ed._canvas.viewport()
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=edge_vp)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=edge_vp)
            QApplication.processEvents()

            self.assertEqual(ed._canvas.selected_group(), "夜巡")
            self.assertIs(ed._props._stack.currentWidget(), ed._props._group_panel)
            self.assertEqual(ed._props._group_original_id, "夜巡")
            self.assertEqual(ed._canvas_selected_entity_refs(), [],
                             "选组要清掉实体选中，否则 release 会顶掉分组面板")

    def test_ctrl_click_on_box_edge_keeps_entity_multiselect(self) -> None:
        """Ctrl 是实体多选手势，组框不许吃：框边只有几个屏幕像素宽，用户眼里
        就是空白处，吃掉这一下等于把辛苦加选的一串实体全清了。"""
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            for key in ("npc:n1", "hotspot:h1"):
                it = ed._canvas._entity_items.get(key)
                it.setSelected(True)
            QApplication.processEvents()
            before = set(ed._canvas_selected_entity_refs())
            self.assertEqual(len(before), 2, "前提：先有两个实体被多选")

            box = self._box(ed)
            pos = ed._canvas.mapFromScene(box.mapToScene(box._w / 2.0, 0.0))
            vp = ed._canvas.viewport()
            QTest.mousePress(
                vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.ControlModifier, pos)
            QTest.mouseRelease(
                vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.ControlModifier, pos)
            QApplication.processEvents()

            self.assertEqual(set(ed._canvas_selected_entity_refs()), before,
                             "Ctrl+点组框边线不得清掉实体多选")
            self.assertIsNone(ed._canvas.selected_group())

    def test_first_click_on_unselected_box_selects_without_moving(self) -> None:
        """两段式：没选中的组，边线按下只选中不拖。否则用户想从这儿起手拉
        橡皮筋框选，实际把整组悄悄挪走了。"""
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            before = copy.deepcopy(model.scenes["sc_a"])
            box = self._box(ed)
            start = ed._canvas.mapFromScene(box.mapToScene(box._w / 2.0, 0.0))
            vp = ed._canvas.viewport()
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start)
            QTest.mouseMove(vp, pos=start + QPoint(80, 60))
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=start + QPoint(80, 60))
            QApplication.processEvents()

            self.assertEqual(model.scenes["sc_a"], before,
                             "第一下只该选中，不该挪动任何成员")
            self.assertFalse(model.is_dirty)
            self.assertEqual(ed._canvas.selected_group(), "夜巡", "但要选中")
            # 选中之后再拖才动
            self._drag_box_edge(ed, 40, 30, select_first=False)
            self.assertNotEqual(model.scenes["sc_a"], before, "第二次手势才位移")

    def test_hit_targets_are_screen_sized_at_small_zoom(self) -> None:
        """命中带/把手按屏幕像素给：世界单位在大场景缩放下会细成几像素，按不中。"""
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            box = self._box(ed)
            ed._canvas.resetTransform()
            ed._canvas.scale(0.2, 0.2)  # 模拟大场景 fit 后的缩放
            QApplication.processEvents()
            edge_px = box._edge_pad() * 0.2
            handle_px = box._handle_r() * 0.2
            self.assertGreater(edge_px, 6.0, "0.2 倍缩放下框边可点带仍须 >6 屏幕像素")
            self.assertGreater(handle_px, 8.0, "把手半径同理")

    def test_default_handle_sits_above_the_box_within_its_width(self) -> None:
        """把手默认在框**上边线正上方**的左端。

        不放中心：那是成员最密处，把手会压住实体点选（组框又被叠放循环点选跳过）。
        不放框内：把手是屏幕恒定尺寸，缩小的视图里换算成的世界半径很大，选中态
        会挡住靠近左上角的本组成员。
        不甩到框左边之外：那样会去压左邻组的框角。
        """
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            rect, anchor, _total, _hidden = ed._group_geometry(
                model.scenes["sc_a"], "夜巡")
            self.assertIsNotNone(rect)
            self.assertLess(anchor.y(), rect.top(), "把手必须在框上边线之上")
            self.assertGreaterEqual(anchor.x(), rect.left(), "水平不得甩出框左边")
            self.assertLess(anchor.x(), rect.center().x(), "靠左端，不在中间")

    # 注：曾有一条 test_adjacent_group_handle_does_not_cover_neighbour_corner，
    # 想验"相邻两组时下组把手不抢上组框角的命中"。变异检验发现它恒绿——**不是**
    # 因为把手压邻组不可能发生（那确实可能：把手在框外时圆盘会伸进邻组命中带），
    # 而是因为它断言的 `items()` 归属由 z 序（面积 + 登记序）决定，**对把手几何
    # 天生不敏感**：即便把手真盖住了那个点，谁赢也是 z 说了算。
    # 与其留一条永远绿的假护栏，不如把这段话留在这里。把手不挡东西这件事由
    # test_handle_does_not_block_entities_until_group_selected 真正守着（它经
    # 变异检验会红）。

    def test_title_label_is_clickable_and_selects_the_group(self) -> None:
        """点标题标签就能选中该组。

        未选中态下标题是除发丝虚线框外唯一常驻的组标识，而且恒 22px 高，是全
        画布最好按的靶子——不可点的话，"点标签选中"这个几乎人人会试的动作落空。
        """
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            box = self._box(ed)
            self.assertFalse(box.is_selected(), "前提：初始未选中")
            title_rect = box._title_hit_rect()
            self.assertTrue(title_rect.isValid() and title_rect.width() > 0)
            center = title_rect.center()
            self.assertTrue(box.shape().contains(center), "标题矩形须进命中区")

            pos = ed._canvas.mapFromScene(box.mapToScene(center))
            vp = ed._canvas.viewport()
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=pos)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=pos)
            QApplication.processEvents()

            self.assertEqual(ed._canvas.selected_group(), "夜巡")
            self.assertIs(ed._props._stack.currentWidget(), ed._props._group_panel)

    def test_title_hit_rect_matches_the_drawn_text_at_any_zoom(self) -> None:
        """标题的命中矩形必须跟着画出来的文字走。

        标题是 ItemIgnoresTransformations 子项：`mapRectFromItem` 拿到的是未缩放的
        逻辑矩形，缩小时画出来 120×22px 而可点的只有 26×5px（只有 19% 的文字响应），
        放大时反过来盖住框左上一带的成员。宽高必须按当前缩放现算。
        """
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            box = self._box(ed)
            drawn = box._title_item.boundingRect()  # 屏幕像素尺度，恒定
            for zoom in (0.2, 1.0, 3.0):
                with self.subTest(zoom=zoom):
                    ed._canvas.resetTransform()
                    ed._canvas.scale(zoom, zoom)
                    ed._canvas.sync_group_box_screen_metrics()
                    QApplication.processEvents()
                    hit = box._title_hit_rect()
                    # 命中矩形换算回屏幕像素后，应与画出来的文字尺寸一致
                    self.assertAlmostEqual(hit.width() * zoom, drawn.width(), delta=1.0)
                    self.assertAlmostEqual(hit.height() * zoom, drawn.height(), delta=1.0)

    def test_title_sits_above_the_box_and_blocks_no_member(self) -> None:
        """标题必须在框上边线之上，且两态都不遮任何成员。

        标题是屏幕恒定尺寸（约 120×22px），一旦摆进框内，缩小的视图里换算成的
        世界矩形能到 564×103 —— 实测把 4 个 NPC（3 个还是本组成员）罩死点不中，
        正是当初逼着把把手挪出人群的那条坑经由标题复活。
        """
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            # 先把整组挪离世界上边界：贴边时把手/标题会被钳进可见区（那是另一条
            # 规则，见 test_group_at_world_top_keeps_handle_and_title_on_screen），
            # 会掩盖这里要验的"抬出框外"。
            sc = model.scenes["sc_a"]
            for coll in ("npcs", "hotspots"):
                for e in sc[coll]:
                    e["y"] = e["y"] + 400
            for p in sc["zones"][0]["polygon"]:
                p["y"] = p["y"] + 400
            ed._load_scene("sc_a", reset_view=False)
            ed._canvas.resetTransform()
            ed._canvas.scale(0.2, 0.2)  # 缩小 = 标题的世界矩形最大的时候
            ed._canvas.sync_group_box_screen_metrics()
            QApplication.processEvents()

            box = self._box(ed)
            title = box._title_hit_rect()
            self.assertLessEqual(
                title.bottom(), 0.5,
                f"标题必须整体落在框上边线之上（实测 bottom={title.bottom():.1f}）")
            handle_bottom = box._anchor_local.y() + box._handle_r()
            self.assertLessEqual(
                handle_bottom, 0.5,
                f"把手也必须整体在框上边线之上（实测 bottom={handle_bottom:.1f}）")

            # 组内每个成员在画布上的落点都不许被标题罩住
            sc = model.scenes["sc_a"]
            for kind, ent in ed._group_members(sc, "夜巡"):
                eid = str(ent.get("id") or "")
                item = ed._canvas._entity_items.get(f"{kind}:{eid}")
                if item is None or not item.isVisible():
                    continue
                at = item.sceneBoundingRect().center()
                for selected in (False, True):
                    ed._canvas.set_selected_group("夜巡" if selected else None)
                    hits = ed._canvas._gfx.items(at)
                    self.assertNotIn(
                        box, hits[:1],
                        f"成员 {eid} 被组框（标题）挡住了点选（selected={selected}）")

    def test_group_at_world_top_keeps_handle_and_title_on_screen(self) -> None:
        """框顶贴着世界上边界时，把手/标题不许抬到世界外——那样标题（组名 + 成员数
        这个唯一辨识信息）看不见、把手也够不着。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            sc = model.scenes["sc_a"]
            sc["entityGroups"].append({"id": "贴顶"})
            for i, x in enumerate((100, 200)):
                sc["npcs"].append({
                    "id": f"n_top{i}", "name": f"顶{i}", "x": x, "y": 8 + i * 6,
                    "interactionRange": 50, "group": "贴顶"})
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()

            _rect, anchor, _t, _h = ed._group_geometry(sc, "贴顶")
            scene_top = ed._canvas._gfx.sceneRect().top()
            self.assertGreaterEqual(
                anchor.y(), scene_top,
                f"把手被抬到世界外了（y={anchor.y():.1f} < {scene_top:.1f}）")
            box = self._box(ed, "贴顶")
            self.assertGreaterEqual(
                box.mapToScene(box._title_hit_rect().topLeft()).y(), scene_top - 1.0,
                "标题也不许跑到世界外")

    def test_edge_band_leaves_clearance_around_members_when_zoomed_out(self) -> None:
        """框的留白必须 = 边线命中带宽 + 净空。

        带宽按屏幕像素恒定，缩小的视图里换算成的世界宽度远超写死的留白，会把
        紧贴框线的成员压得点不中。**断"没被罩住"不够**：留白只取 max 时带子内沿
        与包围盒恰好相切，定义极值的那个成员在边界上 `contains()` 判 False（测试
        照绿），用户真点却因 1 像素取整落进带子。所以这里断的是**净空余量**。
        """
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._canvas.resetTransform()
            ed._canvas.scale(0.2, 0.2)
            ed._canvas.sync_group_box_screen_metrics()
            ed._load_scene("sc_a", reset_view=False)
            ed._canvas.resetTransform()
            ed._canvas.scale(0.2, 0.2)
            QApplication.processEvents()

            box = self._box(ed)
            sc = model.scenes["sc_a"]
            band = box._edge_pad()
            need = band + 2.0 * box._world_per_px()

            # 成员几何的并集 = 框在派生时的输入；框每一边都要比它多出「带宽 + 净空」。
            # 断这个而不是"图元中心没被罩住"：相切恰恰发生在定义极值的那条边上，
            # 中心点离得远，测不出来（这条测试上一版就是这么空转的）。
            union: QRectF | None = None
            for kind, ent in ed._group_members(sc, "夜巡"):
                r = ed._entity_canvas_bbox(kind, ent)
                if r is None:
                    continue
                union = r if union is None else union.united(r)
            self.assertIsNotNone(union, "前提：至少有一个成员有可用几何")
            frame = QRectF(box.pos().x(), box.pos().y(), box._w, box._h)
            for name, d in (
                ("左", union.left() - frame.left()),
                ("右", frame.right() - union.right()),
                ("上", union.top() - frame.top()),
                ("下", frame.bottom() - union.bottom()),
            ):
                self.assertGreater(
                    d, need,
                    f"框的{name}侧留白只有 {d:.1f}，成员会落进命中带（需 >{need:.1f}）")

            # 再抽查每个可见成员的落点两态都不被组框拿走第一命中
            for kind, ent in ed._group_members(sc, "夜巡"):
                eid = str(ent.get("id") or "")
                item = ed._canvas._entity_items.get(f"{kind}:{eid}")
                if item is None or not item.isVisible():
                    continue
                at = item.sceneBoundingRect().center()
                for selected in (False, True):
                    ed._canvas.set_selected_group("夜巡" if selected else None)
                    self.assertNotIn(
                        box, ed._canvas._gfx.items(at)[:1],
                        f"成员 {eid} 被框线命中带压住（selected={selected}）")

    def test_unselected_group_does_not_draw_a_handle_it_cannot_take(self) -> None:
        """未选中的组不许画把手：画面上最像按钮的东西点下去毫无反应，
        比不画更糟——而未选中恰恰是用户第一眼看到的状态。"""
        from PySide6.QtGui import QImage, QPainter

        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            box = self._box(ed)
            self.assertFalse(box.is_selected(), "前提：初始未选中")

            def _handle_pixels() -> int:
                """只把这个组框自己画一遍（不带背景/成员），数把手那块的着墨量。"""
                img = QImage(80, 80, QImage.Format.Format_ARGB32)
                img.fill(0)
                p = QPainter(img)
                try:
                    # 把把手锚点摆到图中心，1:1 世界比例
                    p.translate(40.0 - box._anchor_local.x(),
                                40.0 - box._anchor_local.y())
                    box.paint(p, None)
                finally:
                    p.end()
                return sum(
                    1 for y in range(img.height()) for x in range(img.width())
                    if (img.pixel(x, y) >> 24) & 0xFF
                )

            before = _handle_pixels()
            self._select_box(ed)
            self.assertTrue(box.is_selected())
            after = _handle_pixels()
            self.assertGreater(
                after, before,
                "选中后才该出现把手；未选中时画了把手 = 点不动的假按钮")

    def test_group_context_menu_actions_are_wired(self) -> None:
        """画布右键组框：路由判据 + 菜单项 + 信号接线。

        `QMenu.exec` 在 PySide 里打桩不掉（离屏会永久挂在模态循环），所以生产
        代码把构造与 exec 分开，这里测构造出来的那一半 + 命中判据。
        """
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            box = self._box(ed)
            scene_pt = box.mapToScene(box._w / 2.0, 0.0)
            self.assertIs(ed._canvas._group_box_at(scene_pt), box,
                          "前提：右键落在框边时会路由到分组菜单")
            far = box.mapToScene(box._w / 2.0, box._h / 2.0)
            self.assertIsNone(ed._canvas._group_box_at(far),
                              "框内空白不算命中：右键那儿仍该是「在此添加实体」")

            # 路由本身也要断：只测 build_* 的话，把 contextMenuEvent 里那三行
            # 删掉测试照样绿，而用户右键组框会退回「在此添加实体」。
            # 打桩 _exec_group_context_menu（不是 QMenu.exec——后者在 PySide 里
            # 打桩不掉，离屏会挂死在模态循环）。
            from PySide6.QtGui import QContextMenuEvent

            routed: list[str] = []
            orig_exec = ed._canvas._exec_group_context_menu
            ed._canvas._exec_group_context_menu = (  # type: ignore[method-assign]
                lambda gid, pos: routed.append(str(gid)))
            try:
                vp_pt = ed._canvas.mapFromScene(scene_pt)
                ed._canvas.contextMenuEvent(QContextMenuEvent(
                    QContextMenuEvent.Reason.Mouse, vp_pt,
                    ed._canvas.mapToGlobal(vp_pt)))
                QApplication.processEvents()
            finally:
                ed._canvas._exec_group_context_menu = orig_exec  # type: ignore[method-assign]
            self.assertEqual(routed, ["夜巡"],
                             "右键框边必须路由到分组菜单，而不是「在此添加实体」")

            menu = ed._canvas.build_group_context_menu("夜巡")
            self.assertEqual(
                [a.text() for a in menu.actions()],
                ["选中该组全部成员", "把手回到默认位置", "删除该分组…"])

            # 「选中该组全部成员」真的接到了槽上
            menu.actions()[0].trigger()
            QApplication.processEvents()
            self.assertEqual(
                set(ed._canvas_selected_entity_refs()),
                {("npc", "n1"), ("hotspot", "h1"), ("zone", "z1")})

    def test_group_context_menu_delete_asks_before_deleting(self) -> None:
        """「删除该分组…」必须走带二次确认的删除路径，不得静默删。"""
        from PySide6.QtWidgets import QMessageBox

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            asked: list[str] = []
            orig = QMessageBox.question

            def _fake_question(*a, **_k):
                asked.append(str(a[2]) if len(a) > 2 else "")
                return QMessageBox.StandardButton.No

            QMessageBox.question = staticmethod(_fake_question)  # type: ignore[assignment]
            try:
                ed._canvas.group_delete_requested.emit("夜巡")
                QApplication.processEvents()
            finally:
                QMessageBox.question = orig  # type: ignore[assignment]

            self.assertEqual(len(asked), 1, "必须问过一次")
            self.assertIn("夜巡", asked[0])
            self.assertEqual(
                [g["id"] for g in model.scenes["sc_a"]["entityGroups"]], ["夜巡"],
                "回答 No 之后分组必须还在")

    def test_tree_group_selection_lights_canvas_box(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            self.assertEqual(ed._canvas.selected_group(), "夜巡")
            self.assertTrue(self._box(ed).is_selected())
            # 再点实体：组框熄灯
            ed._entity_tree.clearSelection()
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("npc", "n1")))
            QApplication.processEvents()
            self.assertIsNone(ed._canvas.selected_group())

    # ---- 整组位移 ---------------------------------------------------------

    def test_drag_box_moves_every_member_including_hidden_one_command(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            before = copy.deepcopy(model.scenes["sc_a"])
            self.assertIsNone(
                ed._canvas._entity_items.get("hotspot:h_cut"),
                "前提：cutsceneOnly 成员在画布上没有图元")

            self._drag_box_edge(ed, 60, 40)

            h1 = self._ent(model, "hotspots", "h1")
            dx = h1["x"] - before["hotspots"][0]["x"]
            dy = h1["y"] - before["hotspots"][0]["y"]
            self.assertNotEqual((dx, dy), (0, 0), "拖组框必须真的挪动成员")

            # 每一类成员、每一处几何都按同一个 Δ 走
            h_cut = self._ent(model, "hotspots", "h_cut")
            self._assert_point_close(
                (h_cut["x"] - 300, h_cut["y"] - 300), (dx, dy),
                "画布上看不到的成员也必须跟着移动（否则是半份移动的坏数据）")
            n1 = self._ent(model, "npcs", "n1")
            self._assert_point_close((n1["x"] - 160, n1["y"] - 180), (dx, dy))
            self._assert_points_close(
                [(p["x"], p["y"]) for p in n1["patrol"]["route"]],
                [(160 + dx, 180 + dy), (260 + dx, 180 + dy)],
                "缺省 movePatrol=true：巡逻路点一起挪")
            # NPC 碰撞面：夹具是旧世界坐标，加载期迁移已转成局部。局部多边形挂在锚点上，
            # 整组位移时**不该**再被平移一次，但它的**有效世界位置**必须跟着走。
            self.assertIs(n1.get("collisionPolygonLocal"), True, "加载期迁移没跑")
            self._assert_points_close(
                [(p["x"], p["y"])
                 for p in anchor_collision_polygon_to_world(n1["x"], n1["y"], n1) or []],
                [(150 + dx, 170 + dy), (170 + dx, 170 + dy), (170 + dx, 190 + dy)],
                "NPC 碰撞面的有效世界位置必须跟着整组走")
            self.assertEqual(
                [(p["x"], p["y"]) for p in h1["collisionPolygon"]],
                [(-10, -10), (10, -10), (10, 10)],
                "局部坐标多边形挂在锚点上，不得被再平移一次（否则碰撞面漂两倍）")
            z1 = self._ent(model, "zones", "z1")
            self._assert_points_close(
                [(p["x"], p["y"]) for p in z1["polygon"]],
                [(60 + dx, 60 + dy), (200 + dx, 60 + dy),
                 (200 + dx, 200 + dy), (60 + dx, 200 + dy)])

            # 非成员不动；未知键透传
            n_free = self._ent(model, "npcs", "n_free")
            self.assertEqual((n_free["x"], n_free["y"]), (500, 400))
            self.assertEqual(h1["unknownMember"], {"keep": True})
            self.assertEqual(model.scenes["sc_a"]["unknownScene"], {"keep": 7})
            self.assertEqual(
                model.scenes["sc_a"]["entityGroups"][0]["unknownGroup"], {"keep": 9})

            self.assertTrue(model.is_dirty)
            self.assertEqual(ed._undo.stack.count(), 1,
                             "一次拖动手势 = 一条撤销命令")
            ed.editor_undo()
            self.assertEqual(model.scenes["sc_a"], before, "撤销须整场景回到原样")

    def _assert_preselected_member_moves(self, pre: tuple[str, str]) -> None:
        """先选中组内某成员（哪怕一个字没改）再拖组框：它必须跟着走。

        面板持有该成员的 source/staging；整组位移若直写模型，release 的
        commit-on-leave 会用按下之前的 staging 深拷贝把它整份拍回旧坐标——
        组里少一个人跟上 = 半份移动的坏数据，且画布还照新位置画（看不出来）。
        """
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, pre))
            QApplication.processEvents()

            self._drag_box_edge(ed, 50, 40)

            h1 = self._ent(model, "hotspots", "h1")
            n1 = self._ent(model, "npcs", "n1")
            z1 = self._ent(model, "zones", "z1")
            dh = (h1["x"] - 100, h1["y"] - 120)
            dn = (n1["x"] - 160, n1["y"] - 180)
            dz = (z1["polygon"][0]["x"] - 60, z1["polygon"][0]["y"] - 60)
            self.assertNotEqual(dh, (0, 0), "前提：拖动确实产生了位移")
            self._assert_point_close(dn, dh, f"预选 {pre} 后 npc 掉队")
            self._assert_point_close(dz, dh, f"预选 {pre} 后 zone 掉队")
            self._assert_points_close(
                [(p["x"] - 160, p["y"] - 180) for p in n1["patrol"]["route"]],
                [dh, (100 + dh[0], dh[1])],
                f"预选 {pre} 后巡逻路点掉队")
            # NPC 碰撞面：夹具写的是旧世界坐标，加载期迁移已把它转成局部并打标。
            self.assertIs(n1.get("collisionPolygonLocal"), True,
                          "加载期迁移没跑：NPC 碰撞面仍停在世界坐标")
            # 局部多边形挂在锚点上，整组位移时**不该**再被平移一次（平移两次 = 跑掉一倍）
            self._assert_points_close(
                [(p["x"], p["y"]) for p in n1["collisionPolygon"]],
                [(-10, -10), (10, -10), (10, 10)],
                f"预选 {pre} 后局部碰撞多边形被重复平移了")
            # 真正要保的是**有效世界位置**跟着组走。原先那条 assertIsNone 只是这件事的
            # 代理信号（"没被面板写口拿旧坐标反算"），这里直接断言结果本身，更强：
            # 面板若拿表里的旧坐标反算成 local，锚点已移而 local 未变，这里立刻红。
            self._assert_points_close(
                [(p["x"] - 150, p["y"] - 170)
                 for p in anchor_collision_polygon_to_world(n1["x"], n1["y"], n1) or []],
                [dh, (20 + dh[0], dh[1]), (20 + dh[0], 20 + dh[1])],
                f"预选 {pre} 后 NPC 碰撞面的有效世界位置掉队")

    def test_preselected_npc_still_moves_with_group(self) -> None:
        self._assert_preselected_member_moves(("npc", "n1"))

    def test_preselected_hotspot_still_moves_with_group(self) -> None:
        self._assert_preselected_member_moves(("hotspot", "h1"))

    def test_preselected_zone_still_moves_with_group(self) -> None:
        self._assert_preselected_member_moves(("zone", "z1"))

    def _assert_preselected_member_moves_via(
        self, pre: tuple[str, str], nudge: bool,
    ) -> None:
        """预选成员 → 树选组 → 方向键微移 / 面板 Δ：位移必须真的落到**模型**。

        位移写的是「成员的当前真相份」（该成员正被面板持有时就是 staging）。
        入口若只 `mark_dirty` 模型而不点亮 pending，出口的 commit-on-leave 会被
        `is_pending_dirty` 门控挡掉，staging 永远回灌不到 source：那几个成员留在
        原地、关窗不提示、Save All 把半份移动写进磁盘，用户回头点该成员时
        `load_*_props` 还会用模型旧值把位移彻底抹掉。
        """
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            ed, model = self._editor(root)
            ed._entity_tree.setCurrentItem(self._tree_item(ed, pre))
            QApplication.processEvents()
            ed._entity_tree.clearSelection()
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()

            if nudge:
                for _ in range(10):
                    ed._canvas.keyPressEvent(QKeyEvent(
                        QKeyEvent.Type.KeyPress, Qt.Key.Key_Right,
                        Qt.KeyboardModifier.ShiftModifier))
                QApplication.processEvents()
                dx = 100.0
            else:
                ed._props._grp_move_dx.setValue(100.0)
                ed._props._grp_move_dy.setValue(0.0)
                ed._props._grp_move_btn.click()
                QApplication.processEvents()
                dx = 100.0

            # 收尾路径（保存/关窗前的 flush）之后，模型必须含完整位移
            ed.flush_to_model()
            QApplication.processEvents()
            self.assertEqual(self._ent(model, "npcs", "n1")["x"], 160 + dx,
                             f"预选 {pre} 后 npc 没落到模型")
            self.assertEqual(self._ent(model, "hotspots", "h1")["x"], 100 + dx,
                             f"预选 {pre} 后 hotspot 没落到模型")
            self.assertEqual(
                self._ent(model, "zones", "z1")["polygon"][0]["x"], 60 + dx,
                f"预选 {pre} 后 zone 没落到模型")

            # 落盘也必须是完整位移
            model.save_all()
            reloaded = ProjectModel()
            reloaded.load_project(root)
            disk = reloaded.scenes["sc_a"]
            self.assertEqual(
                [n["x"] for n in disk["npcs"] if n["id"] == "n1"], [160 + dx])
            self.assertEqual(
                [h["x"] for h in disk["hotspots"] if h["id"] == "h1"], [100 + dx])

    def test_preselected_member_moves_via_arrow_keys(self) -> None:
        self._assert_preselected_member_moves_via(("npc", "n1"), nudge=True)

    def test_preselected_member_moves_via_panel_delta(self) -> None:
        self._assert_preselected_member_moves_via(("npc", "n1"), nudge=False)

    def test_preselected_hotspot_moves_via_panel_delta(self) -> None:
        self._assert_preselected_member_moves_via(("hotspot", "h1"), nudge=False)

    def test_preselected_zone_moves_via_arrow_keys(self) -> None:
        self._assert_preselected_member_moves_via(("zone", "z1"), nudge=True)

    def test_member_pulled_out_of_group_in_panel_is_not_moved(self) -> None:
        """面板里把某成员移出本组（还没点应用）：屏幕上它已经不在组里，
        整组位移就不该带上它——归属判断要和写入用同一份真相。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("npc", "n1")))
            QApplication.processEvents()
            # 直接改 staging 的 group（等价于面板上「指派分组」后未应用）
            ed._props._staging_npc["group"] = "别的组"

            ed._on_group_translate_requested("夜巡", 20.0, 10.0)
            QApplication.processEvents()

            h1 = self._ent(model, "hotspots", "h1")
            self.assertEqual((h1["x"], h1["y"]), (120, 130), "组内其余成员照常移动")
            self.assertEqual(ed._props._staging_npc["x"], 160,
                             "已被移出该组的成员不得跟着走")

    def test_zero_move_click_does_not_dirty_or_push_command(self) -> None:
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            before = copy.deepcopy(model.scenes["sc_a"])
            box = self._box(ed)
            vp = ed._canvas.viewport()
            # 两段：先点框边选中，再在把手上零位移点一下——两段都不许标脏
            edge = ed._canvas.mapFromScene(box.mapToScene(box._w / 2.0, 0.0))
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=edge)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=edge)
            QApplication.processEvents()
            self.assertEqual(ed._canvas.selected_group(), "夜巡")

            pos = ed._canvas.mapFromScene(box.anchor_scene_pos())
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=pos)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=pos)
            QApplication.processEvents()
            self.assertEqual(model.scenes["sc_a"], before)
            self.assertEqual(ed._undo.stack.count(), 0)
            self.assertFalse(model.is_dirty, "点一下选中不得标脏")

    def test_escape_during_group_drag_rolls_back(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            before = copy.deepcopy(model.scenes["sc_a"])
            self._drag_box_edge(ed, 50, 30, esc=True)
            self.assertEqual(model.scenes["sc_a"], before,
                             "Esc 须把本次手势累计的 Δ 原路退回")
            self.assertEqual(ed._undo.stack.count(), 0)
            self.assertFalse(model.is_dirty)

    def test_escape_restores_sub_0_1_precision_exactly(self) -> None:
        """Esc 必须按快照精确复原，不能靠反向 Δ——位移每步 round 到 0.1，
        原坐标带 2 位小数（真实场景里有 30+ 个）时反算退不回去，结果是
        「取消了但数据被悄悄截断改过」，还不标脏、进不了撤销栈。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            sc = model.scenes["sc_a"]
            sc["npcs"][0]["x"] = 160.25
            sc["npcs"][0]["y"] = 180.55
            sc["npcs"][0]["patrol"]["route"][0] = {"x": 160.25, "y": 180.55}
            sc["zones"][0]["polygon"][0] = {"x": 60.33, "y": 60.77}
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()
            before = copy.deepcopy(model.scenes["sc_a"])

            self._drag_box_edge(ed, 45, 35, esc=True)

            self.assertEqual(model.scenes["sc_a"], before,
                             "Esc 之后必须逐字段回到原值（含 2 位小数）")
            self.assertEqual(ed._undo.stack.count(), 0)
            self.assertFalse(model.is_dirty, "取消的手势不得留下脏态")

    def test_committed_move_keeps_sub_0_1_precision(self) -> None:
        """已提交的位移也不许砍精度：挪过去再挪回来必须回到原值。

        真实场景里有几十个 2 位小数坐标，一律 round 到 0.1 的话，
        「Δ+10 再 Δ-10」会静静地把 100.25 变成 100.2。
        """
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            sc = model.scenes["sc_a"]
            sc["hotspots"][0]["x"] = 100.25
            sc["zones"][0]["polygon"][0] = {"x": 60.33, "y": 60.77}
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()
            before = copy.deepcopy(model.scenes["sc_a"])

            ed._on_group_translate_requested("夜巡", 10.0, 0.0)
            QApplication.processEvents()
            self.assertEqual(self._ent(model, "hotspots", "h1")["x"], 110.25)
            ed._on_group_translate_requested("夜巡", -10.0, 0.0)
            QApplication.processEvents()

            self.assertEqual(model.scenes["sc_a"], before,
                             "挪过去再挪回来必须逐字段回到原值")

    def test_move_that_changes_nothing_does_not_dirty(self) -> None:
        """有位移手势但一个成员也没改到（几何全缺）：标脏就是伪脏。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            sc = model.scenes["sc_a"]
            sc["entityGroups"].append({"id": "坏组"})
            # 成员只有坏几何：polygon 里全是非 dict，也没有遗留矩形字段
            sc["zones"].append({"id": "z_bad", "group": "坏组", "polygon": [1, 2, 3]})
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()
            before = copy.deepcopy(model.scenes["sc_a"])

            ed._canvas.group_translate_live.emit("坏组", 10.0, 10.0)
            ed._canvas.group_translate_committed.emit("坏组", 10.0, 10.0)
            QApplication.processEvents()

            self.assertEqual(model.scenes["sc_a"], before)
            self.assertFalse(model.is_dirty, "零效果位移不得标脏")
            self.assertEqual(ed._undo.stack.count(), 0)

    def test_panel_delta_move_and_move_patrol_toggle(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()

            # 关掉「带巡逻路线」，再用面板 Δ 精确位移
            ed._props._grp_move_patrol.setChecked(False)
            ed._props._grp_move_dx.setValue(25.0)
            ed._props._grp_move_dy.setValue(-10.0)
            ed._props._grp_move_btn.click()
            QApplication.processEvents()

            n1 = self._ent(model, "npcs", "n1")
            self.assertEqual((n1["x"], n1["y"]), (185, 170))
            self.assertEqual(
                [(p["x"], p["y"]) for p in n1["patrol"]["route"]],
                [(160, 180), (260, 180)],
                "movePatrol=false：路线留在原地")
            # 两条命令：勾选变更被 commit-on-leave 提交为一条，位移本身一条
            self.assertEqual(ed._undo.stack.count(), 2)
            self.assertIs(
                model.scenes["sc_a"]["entityGroups"][0]["editor"]["movePatrol"], False)
            self.assertTrue(model.is_dirty)
            ed.editor_undo()
            self.assertEqual(
                (self._ent(model, "npcs", "n1")["x"], self._ent(model, "npcs", "n1")["y"]),
                (160, 180), "撤销位移回到原位")

    def test_arrow_key_nudge_moves_selected_group(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._canvas.keyPressEvent(QKeyEvent(
                QKeyEvent.Type.KeyPress, Qt.Key.Key_Right,
                Qt.KeyboardModifier.NoModifier))
            QApplication.processEvents()
            ed._canvas.keyPressEvent(QKeyEvent(
                QKeyEvent.Type.KeyPress, Qt.Key.Key_Down,
                Qt.KeyboardModifier.ShiftModifier))
            QApplication.processEvents()

            n1 = self._ent(model, "npcs", "n1")
            self.assertEqual((n1["x"], n1["y"]), (161, 190),
                             "方向键 1 单位、Shift 10 单位")
            # 命令在连发静默窗口结束时收口；Ctrl+Z 自身也会先收口
            ed.editor_undo()
            self.assertEqual((self._ent(model, "npcs", "n1")["x"],
                              self._ent(model, "npcs", "n1")["y"]), (161, 180))
            ed.editor_undo()
            n1 = self._ent(model, "npcs", "n1")
            self.assertEqual((n1["x"], n1["y"]), (160, 180),
                             "两次独立按键 = 两条可分别撤销的命令")

    def test_autorepeat_nudge_collapses_into_one_command(self) -> None:
        """按住方向键的连发合并成一条命令：否则按住一秒要按 30 次 Ctrl+Z。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()

            first = QKeyEvent(QKeyEvent.Type.KeyPress, Qt.Key.Key_Right,
                              Qt.KeyboardModifier.NoModifier)
            ed._canvas.keyPressEvent(first)
            for _ in range(9):
                ed._canvas.keyPressEvent(QKeyEvent(
                    QKeyEvent.Type.KeyPress, Qt.Key.Key_Right,
                    Qt.KeyboardModifier.NoModifier, "", True))  # autoRepeat
            QApplication.processEvents()

            n1 = self._ent(model, "npcs", "n1")
            self.assertEqual((n1["x"], n1["y"]), (170, 180), "10 次按键共挪 10 单位")
            ed.editor_undo()
            n1 = self._ent(model, "npcs", "n1")
            self.assertEqual((n1["x"], n1["y"]), (160, 180),
                             "一次 Ctrl+Z 就该退回连发之前")

    def test_arrow_key_without_group_selection_is_untouched(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            before = copy.deepcopy(model.scenes["sc_a"])
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("npc", "n1")))
            QApplication.processEvents()
            ed._canvas.keyPressEvent(QKeyEvent(
                QKeyEvent.Type.KeyPress, Qt.Key.Key_Right,
                Qt.KeyboardModifier.NoModifier))
            QApplication.processEvents()
            self.assertEqual(model.scenes["sc_a"], before,
                             "没选中分组时方向键不得改任何数据")

    # ---- 把手（editor.anchor） --------------------------------------------

    def test_handle_hit_area_matches_alt_drag_criterion(self) -> None:
        """Alt 判据必须与命中区同源：早先这里留了个世界单位常量，缩小的视图下
        把手可点区远大于它，用户在把手边缘 Alt+拖会错判成整组位移。"""
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            self._select_box(ed)  # 把手仅在选中时吃鼠标
            ed._canvas.resetTransform()
            ed._canvas.scale(0.2, 0.2)
            QApplication.processEvents()
            members_before = copy.deepcopy(
                [model.scenes["sc_a"][c] for c in ("npcs", "hotspots", "zones")])

            box = self._box(ed)
            r = box._handle_r()
            self.assertGreater(r, 20.0, "前提：0.2 倍下把手换算成的世界半径很大")
            # 取把手可点区的外圈（旧的世界常量判据在这儿会判成"不在把手上"）
            edge_local = QPointF(box._anchor_local.x() + r * 0.8,
                                 box._anchor_local.y())
            self.assertTrue(box.shape().contains(edge_local), "前提：该点属把手命中区")
            start = ed._canvas.mapFromScene(box.mapToScene(edge_local))
            end = start + QPoint(12, 9)
            vp = ed._canvas.viewport()
            QTest.mousePress(
                vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.AltModifier, start)
            QTest.mouseMove(vp, pos=end)
            QTest.mouseRelease(
                vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.AltModifier, end)
            QApplication.processEvents()

            self.assertEqual(
                [model.scenes["sc_a"][c] for c in ("npcs", "hotspots", "zones")],
                members_before,
                "在把手可点区内 Alt+拖，只能改把手，绝不能挪成员")
            self.assertIn(
                "anchor", model.scenes["sc_a"]["entityGroups"][0].get("editor", {}))

    def test_box_corners_are_clickable(self) -> None:
        """框的四角必须可点：默认 OddEvenFill 会让把手椭圆与边框描边在角上互相
        抵消，留下约 9 像素的命中缺口——那儿恰好是选中态画角标、最招手的地方。"""
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            self._select_box(ed)
            box = self._box(ed)
            for name, pt in (
                ("左上", QPointF(0.0, 0.0)),
                ("右上", QPointF(box._w, 0.0)),
                ("左下", QPointF(0.0, box._h)),
                ("右下", QPointF(box._w, box._h)),
            ):
                self.assertTrue(box.shape().contains(pt), f"{name}角点不可点")
                self.assertIn(
                    box, ed._canvas._gfx.items(box.mapToScene(pt)),
                    f"{name}角在场景层面也必须命中该组框")

    def test_handle_does_not_block_entities_until_group_selected(self) -> None:
        """把手是屏幕恒定尺寸，缩小视图里换算成世界单位很大；未选中的组不许
        用它挡住底下成员的点选（组框又被叠放循环点选跳过，挡住就救不回来）。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            # 先把整组挪离世界上边界：贴顶时把手会被钳进边线带，那时罩住实体的
            # 是带子不是把手，会掩盖这里要验的门控（贴顶行为另有测试覆盖）。
            sc = model.scenes["sc_a"]
            for coll in ("npcs", "hotspots"):
                for e in sc[coll]:
                    e["y"] = e["y"] + 400
            for p in sc["zones"][0]["polygon"]:
                p["y"] = p["y"] + 400
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()

            box = self._box(ed)
            # 把一个自由 NPC 摆到把手正下方
            anchor = box.anchor_scene_pos()
            model.scenes["sc_a"]["npcs"].append({
                "id": "n_under", "name": "底下", "x": anchor.x(), "y": anchor.y(),
                "interactionRange": 50})
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()
            box = self._box(ed)
            at = box.anchor_scene_pos()

            self.assertNotIn(box, ed._canvas._gfx.items(at),
                             "未选中时把手不吃鼠标，实体照常点得中")
            self._select_box(ed)
            self.assertIn(box, ed._canvas._gfx.items(box.anchor_scene_pos()),
                          "选中之后把手才接管")

    def test_alt_drag_handle_writes_anchor_without_moving_members(self) -> None:
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            self._select_box(ed)  # 把手仅在选中时吃鼠标
            members_before = copy.deepcopy(
                [model.scenes["sc_a"][c] for c in ("npcs", "hotspots", "zones")])
            box = self._box(ed)
            start = ed._canvas.mapFromScene(box.anchor_scene_pos())
            end = start + QPoint(20, 16)
            vp = ed._canvas.viewport()
            QTest.mousePress(
                vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.AltModifier, start)
            QTest.mouseMove(vp, pos=end)
            QTest.mouseRelease(
                vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.AltModifier, end)
            QApplication.processEvents()

            group = model.scenes["sc_a"]["entityGroups"][0]
            self.assertIn("anchor", group.get("editor", {}),
                          "Alt+拖把手应写 editor.anchor")
            self.assertEqual(
                [model.scenes["sc_a"][c] for c in ("npcs", "hotspots", "zones")],
                members_before,
                "挪把手不得动任何成员坐标")
            self.assertEqual(group["unknownGroup"], {"keep": 9})

            # 面板「把手回到中心」清掉 anchor，且不留空 editor 壳
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_anchor_reset_btn.click()
            QApplication.processEvents()
            group = model.scenes["sc_a"]["entityGroups"][0]
            self.assertNotIn("editor", group, "anchor 清掉后不留空 editor 壳")

    def test_anchor_write_then_panel_apply_keeps_anchor(self) -> None:
        """画布直写模型后必须 rebind staging，否则面板 Apply 用旧副本覆盖回去。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._canvas.group_anchor_committed.emit("夜巡", 333.0, 222.0)
            QApplication.processEvents()

            ed._props._grp_label.setText("改个显示名")
            ed._apply_props()
            QApplication.processEvents()

            group = model.scenes["sc_a"]["entityGroups"][0]
            self.assertEqual(group["label"], "改个显示名")
            self.assertEqual(group["editor"]["anchor"], {"x": 333.0, "y": 222.0},
                             "Apply 不得把画布写的把手位置覆盖掉")

    def test_editor_state_survives_save_all_and_reload(self) -> None:
        """editor.anchor / movePatrol 必须经真实写盘出口原样往返。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            ed, model = self._editor(root)
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._canvas.group_anchor_committed.emit("夜巡", 321.5, 654.0)
            QApplication.processEvents()
            ed._props._grp_move_patrol.setChecked(False)
            ed._apply_props()
            QApplication.processEvents()

            model.save_all()
            reloaded = ProjectModel()
            reloaded.load_project(root)
            group = reloaded.scenes["sc_a"]["entityGroups"][0]
            self.assertEqual(group["editor"],
                             {"anchor": {"x": 321.5, "y": 654.0}, "movePatrol": False})
            self.assertEqual(group["unknownGroup"], {"keep": 9},
                             "未知键必须随写盘往返保留")

    def test_move_patrol_false_survives_roundtrip_and_default_writes_no_key(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_move_patrol.setChecked(False)
            ed._apply_props()
            QApplication.processEvents()
            group = model.scenes["sc_a"]["entityGroups"][0]
            self.assertIs(group["editor"]["movePatrol"], False)

            # 勾回默认 = 不写键（存量场景零变化）
            ed._props._grp_move_patrol.setChecked(True)
            ed._apply_props()
            QApplication.processEvents()
            group = model.scenes["sc_a"]["entityGroups"][0]
            self.assertNotIn("editor", group)

    # ---- 空组 / 旧标签组 ---------------------------------------------------

    def test_empty_group_shows_handle_only_and_move_is_noop(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            model.scenes["sc_a"]["entityGroups"].append({"id": "空组"})
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()
            box = self._box(ed, "空组")
            self.assertTrue(box._empty, "空组不画框，只留把手")

            before = copy.deepcopy(model.scenes["sc_a"])
            ed._canvas.group_translate_committed.emit("空组", 10.0, 10.0)
            QApplication.processEvents()
            self.assertEqual(model.scenes["sc_a"], before)

    def test_empty_group_drag_moves_handle_not_members(self) -> None:
        """空组拖动降级为挪把手：否则手势看着动、松手弹回，像坏了。"""
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            model.scenes["sc_a"]["entityGroups"].append({"id": "空组"})
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()
            members_before = copy.deepcopy(
                [model.scenes["sc_a"][c] for c in ("npcs", "hotspots", "zones")])

            box = self._box(ed, "空组")
            start = ed._canvas.mapFromScene(box.anchor_scene_pos())
            end = start + QPoint(18, 14)
            vp = ed._canvas.viewport()
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start)
            QTest.mouseMove(vp, pos=end)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=end)
            QApplication.processEvents()

            empty = next(g for g in model.scenes["sc_a"]["entityGroups"]
                         if g["id"] == "空组")
            self.assertIn("anchor", empty.get("editor", {}))
            self.assertEqual(
                [model.scenes["sc_a"][c] for c in ("npcs", "hotspots", "zones")],
                members_before)

    def test_new_group_gets_canvas_box_immediately(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._add_scene_group()
            QApplication.processEvents()
            new_gid = next(
                g["id"] for g in model.scenes["sc_a"]["entityGroups"]
                if g["id"] != "夜巡")
            self.assertIsNotNone(
                ed._canvas.group_box(new_gid),
                "新建分组必须立刻有画布框，不能等到下次场景重载")
            self.assertEqual(ed._canvas.selected_group(), new_gid)

    def test_smaller_group_box_sits_above_larger_one(self) -> None:
        """两组重叠时小框在上：否则套在大组里的小组永远点不中。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            sc = model.scenes["sc_a"]
            sc["entityGroups"].append({"id": "小组"})
            sc["npcs"].append({
                "id": "n_small_a", "name": "丙", "x": 120, "y": 130,
                "interactionRange": 50, "group": "小组"})
            sc["npcs"].append({
                "id": "n_small_b", "name": "丁", "x": 140, "y": 150,
                "interactionRange": 50, "group": "小组"})
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()
            big = self._box(ed, "夜巡")
            small = self._box(ed, "小组")
            self.assertGreater(small._w * small._h, 0)
            self.assertLess(small._w * small._h, big._w * big._h, "前提：小组更小")
            self.assertGreater(small.zValue(), big.zValue())

    def test_undo_of_group_move_keeps_group_selected(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            self._drag_box_edge(ed, 40, 30)
            ed.editor_undo()
            QApplication.processEvents()
            self.assertEqual(ed._canvas.selected_group(), "夜巡",
                             "撤销整组位移后该组仍应保持选中，不该让用户重新找")
            self.assertIs(ed._props._stack.currentWidget(), ed._props._group_panel)

    def test_group_box_follows_member_drag_and_rename(self) -> None:
        """组框是模型投影：拖成员、改组 id 之后必须自己跟上。"""
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            box_before = self._box(ed)
            rect_before = (box_before.pos().x(), box_before.pos().y(),
                           box_before._w, box_before._h)

            it = ed._canvas._entity_items.get("npc:n1")
            it.setSelected(True)
            QApplication.processEvents()
            start = ed._canvas.mapFromScene(it.pos())
            # 拖到远处（超出原包围盒），否则成员仍落在旧框内、测不出有没有重算
            vp = ed._canvas.viewport()
            end = QPoint(vp.width() - 20, vp.height() - 20)
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start)
            QTest.mouseMove(vp, pos=start + QPoint(20, 20))
            QTest.mouseMove(vp, pos=end)
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=end)
            QApplication.processEvents()
            n1 = self._ent(model, "npcs", "n1")
            self.assertNotEqual((n1["x"], n1["y"]), (160, 180), "前提：成员真的挪了")
            box_after = self._box(ed)
            self.assertNotEqual(
                (box_after.pos().x(), box_after.pos().y(),
                 box_after._w, box_after._h),
                rect_before,
                "成员挪出原包围盒后，组框必须重算")
            self.assertGreaterEqual(
                box_after.pos().y() + box_after._h, n1["y"],
                "重算后的框须把成员新位置包住")

            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_id.setText("夜巡乙")
            ed._apply_props()
            QApplication.processEvents()
            self.assertIsNone(ed._canvas.group_box("夜巡"), "旧 id 的框须移除")
            self.assertIsNotNone(ed._canvas.group_box("夜巡乙"))
            self.assertEqual(ed._canvas.selected_group(), "夜巡乙")

    def test_hide_group_boxes_toggle(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            before = copy.deepcopy(model.scenes["sc_a"])
            ed._chk_group_boxes.setChecked(False)
            QApplication.processEvents()
            self.assertFalse(self._box(ed).isVisible())
            self.assertIsNone(ed._canvas.selected_group())
            # 隐藏只是不画：数据零影响，方向键也不再作用于分组
            ed._canvas.keyPressEvent(QKeyEvent(
                QKeyEvent.Type.KeyPress, Qt.Key.Key_Right,
                Qt.KeyboardModifier.NoModifier))
            QApplication.processEvents()
            self.assertEqual(model.scenes["sc_a"], before)
            ed._chk_group_boxes.setChecked(True)
            QApplication.processEvents()
            self.assertTrue(self._box(ed).isVisible())

    def test_blocked_commit_vetoes_group_drag(self) -> None:
        """提交被保护性校验挡下时，按着不放继续拖不得改成员坐标。"""
        from PySide6.QtTest import QTest
        from PySide6.QtWidgets import QMessageBox

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            # 制造一个必被 preflight 拒绝的未应用编辑：把分组 id 清空
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_id.blockSignals(True)
            ed._props._grp_id.setText("")
            ed._props._grp_id.blockSignals(False)
            ed._props._on_group_props_changed()
            QApplication.processEvents()

            before = copy.deepcopy(model.scenes["sc_a"])
            asked: list[str] = []
            orig = QMessageBox.warning
            QMessageBox.warning = staticmethod(  # type: ignore[assignment]
                lambda *a, **k: asked.append(str(a[2] if len(a) > 2 else "")))
            try:
                box = self._box(ed)
                top_mid = box.mapToScene(box._w / 2.0, 0.0)
                start = ed._canvas.mapFromScene(top_mid)
                vp = ed._canvas.viewport()
                QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start)
                QTest.mouseMove(vp, pos=start + QPoint(40, 30))
                QTest.mouseRelease(
                    vp, Qt.MouseButton.LeftButton, pos=start + QPoint(40, 30))
                QApplication.processEvents()
            finally:
                QMessageBox.warning = orig  # type: ignore[assignment]

            self.assertTrue(asked, "前提：提交确实被保护性校验挡下并给了提示")
            self.assertEqual(
                model.scenes["sc_a"], before,
                "提交被拒后继续拖动，不得写进任何成员坐标")

    def test_legacy_rect_zone_member_moves_too(self) -> None:
        """遗留矩形 zone（x/y/width/height，无 polygon）也在组框里，必须跟着挪。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            model.scenes["sc_a"]["zones"].append({
                "id": "z_rect", "group": "夜巡",
                "x": 400, "y": 300, "width": 120, "height": 90,
            })
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()

            ed._on_group_translate_requested("夜巡", 30.0, -15.0)
            QApplication.processEvents()
            z = self._ent(model, "zones", "z_rect")
            self.assertEqual((z["x"], z["y"]), (430, 285))
            self.assertEqual((z["width"], z["height"]), (120, 90), "宽高不得被动")

    def test_click_box_after_pending_rename_does_not_move_stale_group(self) -> None:
        """未应用的改名 + 直接拖旧框：提交后旧组已不存在，本次手势必须作废。"""
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._entity_tree.setCurrentItem(self._tree_item(ed, ("group", "夜巡")))
            QApplication.processEvents()
            ed._props._grp_id.setText("夜巡丙")
            QApplication.processEvents()

            n1_before = (self._ent(model, "npcs", "n1")["x"],
                         self._ent(model, "npcs", "n1")["y"])
            box = self._box(ed, "夜巡")
            start = ed._canvas.mapFromScene(box.mapToScene(box._w / 2.0, 0.0))
            vp = ed._canvas.viewport()
            QTest.mousePress(vp, Qt.MouseButton.LeftButton, pos=start)
            QTest.mouseMove(vp, pos=start + QPoint(35, 25))
            QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, pos=start + QPoint(35, 25))
            QApplication.processEvents()
            QTest.qWait(30)  # 延后的组框重建
            QApplication.processEvents()

            n1 = self._ent(model, "npcs", "n1")
            self.assertEqual((n1["x"], n1["y"]), n1_before,
                             "旧框对应的组已被改名提交掉，不得再挪成员")
            self.assertEqual(
                model.scenes["sc_a"]["entityGroups"][0]["id"], "夜巡丙")
            self.assertIsNone(ed._canvas.group_box("夜巡"), "旧框须被清掉")
            self.assertIsNotNone(ed._canvas.group_box("夜巡丙"))

    def test_malformed_entity_groups_do_not_crash_or_overwrite(self) -> None:
        """entityGroups 是畸形数据时：照常能按成员标签位移，且绝不覆盖原字段。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            model.scenes["sc_a"]["entityGroups"] = {"不是": "数组"}
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()

            # 兼容标签派生出的组仍可位移（不碰畸形字段）
            ed._canvas.group_translate_committed.emit("夜巡", 0.0, 0.0)
            ed._on_group_translate_requested("夜巡", 12.0, 8.0)
            QApplication.processEvents()
            n1 = self._ent(model, "npcs", "n1")
            self.assertEqual((n1["x"], n1["y"]), (172, 188))
            self.assertEqual(model.scenes["sc_a"]["entityGroups"], {"不是": "数组"},
                             "畸形字段必须原样保留，不得被编辑器覆盖")

    def test_legacy_tag_group_moves_without_materializing(self) -> None:
        """旧标签组（无 entityGroups 条目）也能整组位移，且不因此被升格。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            del model.scenes["sc_a"]["entityGroups"]
            ed._load_scene("sc_a", reset_view=False)
            QApplication.processEvents()

            self._drag_box_edge(ed, 40, 30)
            n1 = self._ent(model, "npcs", "n1")
            self.assertNotEqual((n1["x"], n1["y"]), (160, 180))
            self.assertNotIn(
                "entityGroups", model.scenes["sc_a"],
                "纯位移不得把兼容标签组升级成显式分组实体")


if __name__ == "__main__":
    unittest.main()
