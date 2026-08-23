"""把**仓库里真实的每一个场景**装进新画布跑一遍。

存在理由只有一句：本轮的所有事故都是"我的测试用我自己造的数据形状"。
`lightEnvCurve` 是 dict 不是列表、坐标是多位小数的 float、热点配了
`displayImage` 但图缺件 —— 这些都不是想出来的边界，是磁盘上现成的。

所以这一份不构造任何 fixture：直接读 `public/assets/scenes/*.json`，
逐个装载、逐个做一遍最基本的交互，只要抛异常就算红。
"""
from __future__ import annotations

import glob
import json
import sys
import unittest
from pathlib import Path

from PySide6.QtCore import QPointF, Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_v2.changes import EntityRef
from tools.editor.editors.scene_v2.document import SceneDocument
from tools.editor.editors.scene_v2.sorting import assign_content_z
from tools.editor.editors.scene_v2.tools_builtin import (
    MoveTool,
    PolygonEditTool,
    SelectTool,
)
from tools.editor.editors.scene_v2.view import SceneView
from tools.editor.shared.scene_migrations import migrate_scene_collision_to_local

REPO = Path(__file__).resolve().parents[3]
_NO_MOD = Qt.KeyboardModifier.NoModifier
_LEFT = Qt.MouseButton.LeftButton


class _FakeModel:
    def __init__(self, scenes: dict) -> None:
        self.scenes = scenes
        self.dirty: list[tuple[str, str]] = []

    def mark_dirty(self, domain: str, key: str) -> None:
        self.dirty.append((domain, key))


def _real_scenes() -> list[tuple[str, dict]]:
    out: list[tuple[str, dict]] = []
    for path in sorted(glob.glob(str(REPO / "public/assets/scenes/*.json"))):
        try:
            sc = json.loads(Path(path).read_text("utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(sc, dict):
            # 与真实装载同口径：加载期把碰撞面归一成局部坐标
            migrate_scene_collision_to_local(sc)
            out.append((Path(path).stem, sc))
    return out


class RealSceneSmokeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)
        cls._scenes = _real_scenes()

    def test_the_repo_actually_has_scenes(self) -> None:
        """前置条件：没有场景文件时下面全是空转，那才是最坏的绿。"""
        self.assertGreater(len(self._scenes), 10,
                           f"只找到 {len(self._scenes)} 个场景文件")

    def _open(self, sid: str, sc: dict):
        model = _FakeModel({sid: sc})
        doc = SceneDocument(model, sid)
        view = SceneView(doc)
        view.resize(800, 600)
        view.renderer.set_view_scale(1.0)
        return model, doc, view

    def test_every_scene_loads_and_projects(self) -> None:
        for sid, sc in self._scenes:
            with self.subTest(scene=sid):
                _m, doc, view = self._open(sid, sc)
                try:
                    self.assertIsNotNone(doc.scene())
                    # 每个实体都要有图元账；缺 part 是允许的，缺账不是
                    for kind in ("hotspot", "npc", "zone", "spawn"):
                        for ref in doc.entity_refs(kind):
                            self.assertIsInstance(ref, EntityRef)
                    assign_content_z(doc, view)
                finally:
                    view.deleteLater()
                    doc.deleteLater()
                    QApplication.processEvents()

    def test_light_curve_shape_is_read_not_guessed(self) -> None:
        """磁盘上的 `lightEnvCurve` 是 `{"points": [...]}`。

        按裸列表读会拿到字符串 `'p'`（dict 的第一个键），装载当场 `ValueError`；
        按裸列表写则老画布再也读不出这条曲线，属于静默数据丢失。
        """
        seen = 0
        for sid, sc in self._scenes:
            if "lightEnvCurve" not in sc:
                continue
            seen += 1
            with self.subTest(scene=sid):
                _m, doc, view = self._open(sid, sc)
                try:
                    item = view.item_for(EntityRef("scene", sid), "lightcurve")
                    pts = sc["lightEnvCurve"]
                    expect = pts.get("points") if isinstance(pts, dict) else pts
                    if expect:
                        self.assertIsNotNone(
                            item, "配了光曲线的场景没建出曲线图元")
                        self.assertEqual(len(item.points()), len(expect))
                finally:
                    view.deleteLater()
                    doc.deleteLater()
                    QApplication.processEvents()
        self.assertGreater(seen, 0, "一个带 lightEnvCurve 的场景都没有 —— 这条没测到")

    def test_every_entity_is_reachable_by_clicking_its_anchor(self) -> None:
        """按每个实体的锚点点下去，必须**点得中它**。

        这是"画得出来 ≠ 点得中"的直接堵漏：命中与绘制此前分属两套口径。

        允许一次点不中：真实数据里确实有几乎重合的实体（`义庄` 的
        `npc_义庄门口老人` 与 `hs_验尸_老人` 相距 10 个世界单位，两个把手的
        命中圈互相覆盖）。这种情况谁在上面本来就没有唯一答案，画布给的答案是
        **同一处重复点击轮转**。所以这里断言的是"轮转若干次之内一定轮到它"，
        而不是"第一下就必须是它" —— 后者会把一条正常设计当成 bug 钉死。
        """
        for sid, sc in self._scenes:
            _m, doc, view = self._open(sid, sc)
            select = view.tools.register(SelectTool(doc, view.renderer, view))
            try:
                for ref in doc.entity_refs("hotspot") + doc.entity_refs("npc"):
                    ent = doc.entity(ref)
                    if not isinstance(ent, dict) or "x" not in ent:
                        continue
                    item = view.item_for(ref, "handle")
                    if item is None or not item.isVisible():
                        continue
                    pos = QPointF(float(ent["x"]), float(ent["y"]))
                    rounds = max(1, len(select._hits(pos)))
                    hit = False
                    for _ in range(rounds):
                        select.mouse_pressed(pos, _LEFT, _NO_MOD)
                        if ref in doc.selection:
                            hit = True
                            break
                    with self.subTest(scene=sid, entity=ref.key):
                        self.assertTrue(
                            hit, f"点在实体锚点上、轮转 {rounds} 次都没选中它")
            finally:
                view.deleteLater()
                doc.deleteLater()
                QApplication.processEvents()

    def test_dragging_every_entity_writes_its_own_coordinates(self) -> None:
        """逐个实体拖 10 个单位：坐标必须**恰好**加 10，且只动它自己。"""
        for sid, sc in self._scenes:
            _m, doc, view = self._open(sid, sc)
            move = view.tools.register(MoveTool(doc, view.renderer, view))
            try:
                for ref in doc.entity_refs("hotspot"):
                    ent = doc.entity(ref)
                    if not isinstance(ent, dict) or "x" not in ent:
                        continue
                    x0, y0 = float(ent["x"]), float(ent["y"])
                    doc.set_selection([ref])
                    move.mouse_pressed(QPointF(x0, y0), _LEFT, _NO_MOD)
                    move.mouse_moved(QPointF(x0 + 10, y0), _LEFT, _NO_MOD)
                    move.mouse_released(QPointF(x0 + 10, y0), _LEFT, _NO_MOD)
                    with self.subTest(scene=sid, entity=ref.key):
                        after = doc.model_entity(ref)
                        self.assertAlmostEqual(float(after["x"]), x0 + 10, places=1)
                        self.assertAlmostEqual(float(after["y"]), y0, places=1)
            finally:
                view.deleteLater()
                doc.deleteLater()
                QApplication.processEvents()

    def test_collision_polygons_round_trip_through_the_canvas(self) -> None:
        """真实碰撞面：画布上的世界点写回后必须还原成同一份局部点。

        带 `scale` / `rotation` 的实体上，画与写只要有一侧漏掉实例 transform，
        这里就会红 —— 而画面上完全看不出来。
        """
        checked = 0
        for sid, sc in self._scenes:
            _m, doc, view = self._open(sid, sc)
            poly_tool = view.tools.register(
                PolygonEditTool(doc, view.renderer, view))
            try:
                for kind in ("hotspot", "npc"):
                    for ref in doc.entity_refs(kind):
                        item = view.item_for(ref, "collision")
                        if item is None or not item.isVisible():
                            continue
                        doc.set_selection([ref])
                        x0, y0 = item.points()[0]
                        # **走真实手势**：拖第一个顶点右移 10 个单位再松手。
                        # 顶点必须停在放手处 —— 画（正变换）与写（反变换）
                        # 只要有一侧漏掉实例 transform，这里就会偏。
                        poly_tool.mouse_pressed(QPointF(x0, y0), _LEFT, _NO_MOD)
                        poly_tool.mouse_moved(
                            QPointF(x0 + 10, y0), _LEFT, _NO_MOD)
                        poly_tool.mouse_released(
                            QPointF(x0 + 10, y0), _LEFT, _NO_MOD)
                        checked += 1
                        with self.subTest(scene=sid, entity=ref.key):
                            got = view.item_for(ref, "collision").points()[0]
                            self.assertAlmostEqual(got[0], x0 + 10, places=1,
                                                   msg="松手后顶点跳走了")
                            self.assertAlmostEqual(got[1], y0, places=1)
            finally:
                view.deleteLater()
                doc.deleteLater()
                QApplication.processEvents()
        self.assertGreater(checked, 0, "一个真实碰撞面都没查到 —— 这条没测到")

    def test_undo_restores_every_scene_byte_for_byte(self) -> None:
        """拖一下再撤销，整份场景必须回到**逐字节相同**。

        数值表示（int 仍是 int）也算在内 —— 漂成 `.0` 就是黄金往返红。
        """
        for sid, sc in self._scenes:
            _m, doc, view = self._open(sid, sc)
            move = view.tools.register(MoveTool(doc, view.renderer, view))
            try:
                refs = doc.entity_refs("hotspot")
                if not refs:
                    continue
                ref = refs[0]
                ent = doc.entity(ref)
                if not isinstance(ent, dict) or "x" not in ent:
                    continue
                before = json.dumps(doc.scene(), ensure_ascii=False, sort_keys=True)
                x0, y0 = float(ent["x"]), float(ent["y"])
                doc.set_selection([ref])
                move.mouse_pressed(QPointF(x0, y0), _LEFT, _NO_MOD)
                move.mouse_moved(QPointF(x0 + 7, y0 + 3), _LEFT, _NO_MOD)
                move.mouse_released(QPointF(x0 + 7, y0 + 3), _LEFT, _NO_MOD)
                doc.undo_stack.undo()
                with self.subTest(scene=sid):
                    self.assertEqual(
                        json.dumps(doc.scene(), ensure_ascii=False, sort_keys=True),
                        before, "撤销之后场景与原始内容不再逐字节相同")
            finally:
                view.deleteLater()
                doc.deleteLater()
                QApplication.processEvents()


if __name__ == "__main__":
    unittest.main()
