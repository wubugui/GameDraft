"""场景页的粒子布置：**只读显示**（2026-09-14 拆掉场景页里那一整套粒子区域编辑之后的护栏）。

制作人原话："发射区域和效果区域不该在主编辑器里调，主编辑器里只负责显示。"
布置、发射区域、范围区域、效果参数全在粒子工作台里做（它是 ``vfx_placements.json`` 与 ``assets/data/vfx/``
唯一的写入者）；场景页只剩一个「显示时段外观」下拉、一段摘要、「刷新粒子数据」按钮，画布上画区域与锚点。

口径（editor-tools norms 过程义务 3）：画布手势一律发**真实鼠标事件**进视口、面板点**真按钮**、
下拉用**真键盘**切；断言落在盘上的布置库 / 模型里的场景 / 选中集合上。区域画在把手之上
（``_Z_DECOR_VFX_OVERLAY``），所以"NPC 摆在边线下点得中"不是靠 z 序侥幸——谁把 overlay 改回能吃鼠标，
第一条用例就红。
"""
from __future__ import annotations

import copy
import json
import os
import re
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import QPoint, QPointF, Qt  # noqa: E402
from PySide6.QtWidgets import (  # noqa: E402
    QAbstractItemView, QAbstractSpinBox, QApplication, QCheckBox, QComboBox, QLineEdit,
    QPlainTextEdit, QPushButton, QSlider, QTextEdit, QWidget,
)

from tools.editor.editors.scene_editor import (  # noqa: E402
    SceneEditor, _EditableZonePolygon, _VfxAnchorMarker, _VfxAreaPolygon,
)
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared import vfx_confine, vfx_placements  # noqa: E402
from tools.editor.tests.qt_teardown import quiesce_scene_editor  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
_SID = "粒子显示测试"
_EMPTY_SID = "没有粒子的场景"

#: 基底那份：纸钱（发射区域 A + 范围区域 R，边带 80、限高 400）+ 蝙蝠（没有区域，只有锚点）
_A = [[300.0, 200.0], [900.0, 200.0], [900.0, 600.0], [300.0, 600.0]]
_R = [[100.0, 100.0], [1100.0, 100.0], [1100.0, 750.0], [100.0, 750.0]]
#: 夜那份：纸钱换了一块发射区域 B、没有限定；蝙蝠没摆，多了萤火虫
_B = [[150.0, 300.0], [500.0, 300.0], [500.0, 700.0], [150.0, 700.0]]
_BAT_ANCHOR = (1000.0, 150.0)


def _library() -> dict:
    lib = vfx_placements.empty_library()
    lib["scenes"][_SID] = {
        "base": [
            {"id": "纸钱", "effect": "paper_money", "anchor": {"x": 700, "y": 400},
             "area": copy.deepcopy(_A), "confine": {"area": copy.deepcopy(_R), "feather": 80, "ceiling": 400}},
            {"id": "蝙蝠", "effect": "bat_cliff",
             "anchor": {"x": _BAT_ANCHOR[0], "y": _BAT_ANCHOR[1], "h": 10, "surface": "shell"}},
        ],
        "variants": {"夜": [
            {"id": "纸钱", "effect": "paper_money", "anchor": {"x": 300, "y": 500}, "area": copy.deepcopy(_B)},
            {"id": "萤火", "effect": "fireflies", "anchor": {"x": 800, "y": 650, "h": 40}},
        ]},
    }
    return lib


def _scene(sid: str, **extra) -> dict:
    sc = {
        "id": sid, "name": sid, "worldWidth": 1200, "worldHeight": 800,
        "spawnPoint": {"x": 10, "y": 10},
        # n1 正压在发射区域 A 的上边线上；n2 正压在蝙蝠的锚点十字上
        "npcs": [
            {"id": "n1", "name": "路人", "x": 600, "y": 200, "interactionRange": 40},
            {"id": "n2", "name": "看崖的", "x": _BAT_ANCHOR[0], "y": _BAT_ANCHOR[1], "interactionRange": 40},
        ],
        "hotspots": [], "zones": [],
        "dayNight": {"enabled": True},
        "timeVariants": {"夜": {"bgm": "夜曲"}},
    }
    sc.update(extra)
    return sc


def _dump(obj) -> bytes:
    return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _pump(n: int = 6) -> None:
    for _ in range(n):
        QApplication.processEvents()


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[SceneEditor] = []

    def tearDown(self) -> None:
        for ed in self._editors:
            quiesce_scene_editor(ed)
            ed._vfx_area_overlay_refresh_timer.stop()
            ed.deleteLater()
        self._editors.clear()
        _pump()

    # ---- 临时工程：场景与布置库都**落盘**，模型从盘上载入（保存往返要比字节） ----
    def _project(self, td: str, scenes: dict[str, dict], lib: dict | None = None) -> Path:
        root = Path(td) / "p"
        write_minimal_loadable_project(root)
        dp = root / "public" / "assets" / "data"
        (dp / "game_config.json").write_bytes(_dump({"dayNight": {"phases": [
            {"id": "辰时", "label": "辰时", "from": "07:00", "daylight": True},
            {"id": "夜", "label": "入夜", "from": "19:00"},
        ]}}))
        (dp / "vfx_placements.json").write_bytes(_dump(_library() if lib is None else lib))
        for sid, sc in scenes.items():
            (root / "public" / "assets" / "scenes" / f"{sid}.json").write_bytes(_dump(sc))
        return root

    def _editor(self, root: Path, sid: str = _SID) -> tuple[SceneEditor, ProjectModel]:
        model = ProjectModel()
        model.load_project(root)
        ed = SceneEditor(model)
        self._editors.append(ed)
        ed._refresh_scene_list()
        ed._load_scene(sid)
        ed._undo.clear()
        ed.resize(1400, 900)
        ed.show()
        _pump()
        ed._canvas.fit_all()
        _pump()
        ed._canvas._auto_fit_after_layout = False
        _pump()
        self.assertFalse(model.is_dirty, "打开场景就脏了")
        return ed, model

    @staticmethod
    def _scene_text(model: ProjectModel, sid: str = _SID) -> str:
        return json.dumps(model.scenes[sid], ensure_ascii=False, indent=2)

    def _vp(self, ed: SceneEditor, x: float, y: float) -> QPoint:
        return ed._canvas.mapFromScene(QPointF(x, y))

    def _drag(self, ed: SceneEditor, a: tuple[float, float], b: tuple[float, float]) -> None:
        from PySide6.QtTest import QTest

        vp = ed._canvas.viewport()
        p0, p1 = self._vp(ed, *a), self._vp(ed, *b)
        QTest.mousePress(vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, p0)
        QTest.mouseMove(vp, (p0 + p1) / 2)
        QTest.mouseMove(vp, p1)
        QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, p1)
        _pump()

    def _click(self, ed: SceneEditor, x: float, y: float) -> None:
        from PySide6.QtTest import QTest

        vp = ed._canvas.viewport()
        p = self._vp(ed, x, y)
        QTest.mousePress(vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, p)
        QTest.mouseRelease(vp, Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier, p)
        _pump()

    @staticmethod
    def _click_button(btn: QPushButton) -> None:
        from PySide6.QtTest import QTest

        QTest.mouseClick(btn, Qt.MouseButton.LeftButton)
        _pump()

    @staticmethod
    def _areas(ed: SceneEditor) -> dict[tuple[str, str], list]:
        return {(it.instance_id, it.role): it.area_points()
                for it in ed._canvas.vfx_overlay_items() if isinstance(it, _VfxAreaPolygon)}

    @staticmethod
    def _anchors(ed: SceneEditor) -> dict[str, tuple[float, float]]:
        return {it.instance_id: it.anchor_point()
                for it in ed._canvas.vfx_overlay_items() if isinstance(it, _VfxAnchorMarker)}


# --------------------------------------------------------------------------- #
# 画布 overlay：只读、不吃鼠标
# --------------------------------------------------------------------------- #

class CanvasOverlayIsReadOnlyTests(_Base):
    def test_在顶点与边线上按下拖动_什么都不改_点击落到下面的实体(self) -> None:
        with TemporaryDirectory() as td:
            root = self._project(td, {_SID: _scene(_SID)})
            ed, model = self._editor(root)
            lib_path = vfx_placements.library_path(root)
            lib_bytes = lib_path.read_bytes()
            lib_mirror = copy.deepcopy(model.vfx_placements)
            scene_before = self._scene_text(model)
            self.assertEqual(self._areas(ed)[("纸钱", "emit")], _A, "overlay 没画出基底那份的发射区域")
            self.assertEqual(ed._canvas._gfx.selectedItems(), [])

            # 发射区域顶点、范围区域顶点、范围区域边线（不在任何实体上）各按住拖一下
            for a, b in (((900.0, 600.0), (960.0, 650.0)),
                         ((1100.0, 750.0), (1150.0, 780.0)),
                         ((640.0, 100.0), (700.0, 140.0))):
                self._drag(ed, a, b)
                self.assertEqual(lib_path.read_bytes(), lib_bytes, f"拖 {a} 改了盘上的布置库")
                self.assertEqual(model.vfx_placements, lib_mirror, f"拖 {a} 改了模型里的布置库镜像")
                self.assertEqual(self._scene_text(model), scene_before, f"拖 {a} 改了场景 JSON")
                self.assertEqual(ed._canvas._gfx.selectedItems(), [], f"拖 {a} 之后选中集合变了")
                self.assertFalse(model.is_dirty, f"拖 {a} 标脏了")
                self.assertFalse(ed._undo.stack.canUndo(), f"拖 {a} 进了撤销栈")
            self.assertEqual(self._areas(ed)[("纸钱", "emit")], _A, "发射区域的形状被手势改了")
            self.assertEqual(self._areas(ed)[("纸钱", "range")], _R, "范围区域的形状被手势改了")

            # 压在发射区域上边线下的 NPC：点得中
            self._click(ed, 600.0, 200.0)
            self.assertIs(ed._props._stack.currentWidget(), ed._props._npc_panel, "边线下的 NPC 点不中了")
            self.assertEqual(ed._canvas_selected_entity_refs(), [("npc", "n1")])
            # 压在蝙蝠锚点十字下的 NPC：也点得中
            self._click(ed, *_BAT_ANCHOR)
            self.assertEqual(ed._canvas_selected_entity_refs(), [("npc", "n2")], "锚点十字下的 NPC 点不中了")
            self.assertEqual(self._scene_text(model), scene_before)

    def test_图元不是实体_不吃任何鼠标键_不进命中与选中(self) -> None:
        with TemporaryDirectory() as td:
            root = self._project(td, {_SID: _scene(_SID)})
            ed, _model = self._editor(root)
            items = ed._canvas.vfx_overlay_items()
            self.assertEqual(len(items), 4, "基底那份应有：纸钱发射区域 / 范围区域、纸钱与蝙蝠两个锚点")
            labels = [c for it in items for c in it.childItems()]
            self.assertEqual(len(labels), 4, "每个图元一个标签子项")
            items = [*items, *labels]      # 标签子项同样不许吃鼠标
            for it in items:
                with self.subTest(item=(getattr(it, "instance_id", "label"), type(it).__name__)):
                    self.assertEqual(it.acceptedMouseButtons(), Qt.MouseButton.NoButton)
                    self.assertFalse(bool(it.flags() & it.GraphicsItemFlag.ItemIsSelectable))
                    self.assertFalse(bool(it.flags() & it.GraphicsItemFlag.ItemIsMovable))
                    self.assertFalse(it.acceptHoverEvents())
                    self.assertFalse(hasattr(it, "entity_kind"))
                    self.assertNotIsInstance(it, _EditableZonePolygon)
                    self.assertTrue(it.shape().isEmpty(), "shape 非空 = items(pos) 能命中它")
            for pt in (QPointF(300.0, 200.0), QPointF(600.0, 200.0), QPointF(*_BAT_ANCHOR)):
                hit = ed._canvas._gfx.items(pt)
                self.assertFalse(any(it in hit for it in items), f"{pt} 处的命中列表里有 overlay 图元")
                self.assertFalse(any(it in ed._canvas._entity_stack_at(pt) for it in items))


# --------------------------------------------------------------------------- #
# 显示时段外观
# --------------------------------------------------------------------------- #

class PhaseAppearanceTests(_Base):
    def test_下拉切时段外观_overlay与摘要换成那一份(self) -> None:
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            root = self._project(td, {_SID: _scene(_SID)})
            ed, model = self._editor(root)
            props = ed._props
            combo = props._sc_vfx_phase
            self.assertEqual([combo.itemData(i) for i in range(combo.count())], ["", "夜"])
            self.assertEqual(combo.currentData(), "", "画布时段视图是「全部时段」时应显示基底")
            self.assertEqual(self._areas(ed), {("纸钱", "emit"): _A, ("纸钱", "range"): _R})
            self.assertEqual(set(self._anchors(ed)), {"纸钱", "蝙蝠"})
            self.assertEqual(props._sc_vfx_summary.text().splitlines(), [
                "纸钱 · paper_money · 发射区域 / 范围区域(边带 80) / 限高 400",
                "蝙蝠 · bat_cliff · 无区域",
            ])
            emit = ed._canvas.vfx_area_item("纸钱", "emit")
            rng = ed._canvas.vfx_area_item("纸钱", "range")
            self.assertTrue(rng.is_confined() and not emit.is_confined(), "边带只画在起限定作用的范围区域上")
            self.assertEqual(rng.feather(), 80.0)

            combo.setFocus()
            QTest.keyClick(combo, Qt.Key.Key_Down)
            _pump()
            self.assertEqual(combo.currentData(), "夜")
            self.assertEqual(props.vfx_view_phase(), "夜")
            self.assertEqual(self._areas(ed), {("纸钱", "emit"): _B}, "切到夜，overlay 没换成夜那份")
            self.assertEqual(set(self._anchors(ed)), {"纸钱", "萤火"}, "夜里没摆蝙蝠，锚点却还在")
            self.assertEqual(props._sc_vfx_summary.text().splitlines(), [
                "纸钱 · paper_money · 发射区域", "萤火 · fireflies · 无区域"])
            self.assertFalse(model.is_dirty, "切显示哪一份不是编辑，不许标脏")

    def test_默认跟随画布时段视图_同场景重装保住手选(self) -> None:
        from PySide6.QtTest import QTest

        with TemporaryDirectory() as td:
            root = self._project(td, {_SID: _scene(_SID)})
            ed, _model = self._editor(root)
            props = ed._props
            ed._combo_phase_view.set_committed_type("夜", emit=True)
            _pump()
            self.assertEqual(props.vfx_view_phase(), "夜", "画布切到夜，vfx 块没跟过去")
            self.assertEqual(self._areas(ed), {("纸钱", "emit"): _B})
            # 作者在块里手选回基底；点画布空白（场景页重装）不许冲掉
            props._sc_vfx_phase.setFocus()
            QTest.keyClick(props._sc_vfx_phase, Qt.Key.Key_Up)
            _pump()
            self.assertEqual(props.vfx_view_phase(), "")
            self._click(ed, 1180.0, 20.0)
            self.assertIs(props._stack.currentWidget(), props._scene_panel)
            self.assertEqual(props.vfx_view_phase(), "", "同一场景重装把手选的那份冲掉了")
            # 画布切到一个没单列外观的时段 = 基底；再切回夜 = 夜
            ed._combo_phase_view.set_committed_type("辰时", emit=True)
            _pump()
            self.assertEqual(props.vfx_view_phase(), "")
            ed._combo_phase_view.set_committed_type("夜", emit=True)
            _pump()
            self.assertEqual(props.vfx_view_phase(), "夜")
            self.assertEqual(self._areas(ed), {("纸钱", "emit"): _B})

    def test_标题带条数_有布置展开_没有折叠(self) -> None:
        with TemporaryDirectory() as td:
            root = self._project(td, {_SID: _scene(_SID), _EMPTY_SID: _scene(_EMPTY_SID)})
            ed, _model = self._editor(root)
            fold = ed._props._sc_vfx_fold
            self.assertEqual(fold._plain_title, "世界空间效果 vfx（粒子）· 4 个布置")
            self.assertTrue(fold.is_expanded())
            ed._load_scene(_EMPTY_SID)
            _pump()
            self.assertEqual(fold._plain_title, "世界空间效果 vfx（粒子）· 0 个布置")
            self.assertFalse(fold.is_expanded(), "没有布置的场景该折起来")
            self.assertEqual(ed._canvas.vfx_overlay_items(), [], "换到没布置的场景，上个场景的区域还画着")


# --------------------------------------------------------------------------- #
# 面板：没有编辑控件 / 刷新 / 残留
# --------------------------------------------------------------------------- #

class PanelTests(_Base):
    def test_vfx块里没有任何可编辑控件(self) -> None:
        with TemporaryDirectory() as td:
            root = self._project(td, {_SID: _scene(_SID, vfx=[{"id": "旧", "effect": "x"}])})
            ed, _model = self._editor(root)
            props = ed._props
            body = props._sc_vfx_fold._content
            editable = (QLineEdit, QAbstractSpinBox, QCheckBox, QTextEdit, QPlainTextEdit,
                        QAbstractItemView, QSlider)
            combo = props._sc_vfx_phase

            def inside_combo(w: QWidget) -> bool:
                # 下拉自己的弹出列表（QComboBox 内部的 QListView，挂在独立的 popup 窗口里）不算；
                # isAncestorOf 不跨窗口，只能沿 parent 链走
                p = w.parent()
                while p is not None:
                    if p is combo:
                        return True
                    p = p.parent()
                return False

            bad = [type(w).__name__ for w in body.findChildren(QWidget)
                   if isinstance(w, editable) and not inside_combo(w)]
            self.assertEqual(bad, [], "vfx 块里出现了编辑控件")
            combos = body.findChildren(QComboBox)
            self.assertEqual(combos, [props._sc_vfx_phase], "vfx 块里只许有「显示时段外观」那一个下拉")
            self.assertFalse(props._sc_vfx_phase.isEditable())
            self.assertEqual(sorted(b.text() for b in body.findChildren(QPushButton)),
                             sorted(["刷新粒子数据", "删掉残留的旧 vfx 块"]))
            texts = {b.text() for b in props._scene_panel.findChildren(QPushButton)}
            for gone in ("在粒子工作台中打开…", "拉发射区域", "拉范围区域", "重拉发射区域", "重拉范围区域"):
                self.assertNotIn(gone, texts, f"场景页还留着「{gone}」")

    def test_刷新粒子数据_重读盘上的布置库_overlay与摘要当场更新(self) -> None:
        C = [[50.0, 50.0], [400.0, 50.0], [400.0, 300.0], [50.0, 300.0]]
        with TemporaryDirectory() as td:
            root = self._project(td, {_SID: _scene(_SID)})
            ed, model = self._editor(root)
            props = ed._props
            lib = _library()
            lib["scenes"][_SID]["base"] = [
                {"id": "纸钱", "effect": "paper_money", "anchor": {"x": 200, "y": 200}, "area": C},
                {"id": "新来的", "effect": "dust_motes", "anchor": {"x": 200, "y": 600}},
                {"id": "又一个", "effect": "dust_motes", "anchor": {"x": 250, "y": 650}},
            ]
            vfx_placements.library_path(root).write_bytes(_dump(lib))   # 粒子工作台存了盘
            _pump()
            self.assertEqual(self._areas(ed)[("纸钱", "emit")], _A, "还没点刷新 overlay 就变了：这条测不到按钮")

            self._click_button(props._sc_vfx_refresh)
            self.assertEqual(self._areas(ed), {("纸钱", "emit"): C}, "点了刷新，overlay 没换成盘上那份")
            self.assertEqual(set(self._anchors(ed)), {"纸钱", "新来的", "又一个"})
            self.assertIn("新来的 · dust_motes · 无区域", props._sc_vfx_summary.text().splitlines())
            self.assertEqual(props._sc_vfx_fold._plain_title, "世界空间效果 vfx（粒子）· 5 个布置")
            self.assertEqual(vfx_placements.rows_for(model.vfx_placements, _SID, "")[1]["id"], "新来的")
            self.assertFalse(model.is_dirty, "重读只读镜像不许标脏")

            # 布置库坏了：红字报出来、画布什么都不画（fail-safe：不留一份过期的区域骗人）
            vfx_placements.library_path(root).write_bytes(b"{ not json")
            self._click_button(props._sc_vfx_refresh)
            self.assertTrue(props._sc_vfx_error.isVisibleTo(props))
            self.assertIn("读不懂", props._sc_vfx_error.text())
            self.assertEqual(ed._canvas.vfx_overlay_items(), [])


class SceneRoundTripTests(_Base):
    def test_打开不改保存_字节一致(self) -> None:
        with TemporaryDirectory() as td:
            root = self._project(td, {_SID: _scene(_SID)})
            path = root / "public" / "assets" / "scenes" / f"{_SID}.json"
            raw = path.read_bytes()
            ed, model = self._editor(root)
            props = ed._props
            props._flush_scene_widgets_into(props._staging_scene)
            props.commit_scene_staging_to_source()
            model.mark_dirty("scene", _SID)
            model.save_all()
            self.assertEqual(path.read_bytes(), raw, "场景页打开→不改→保存，场景文件字节变了")
            self.assertNotIn("vfx", json.loads(raw.decode("utf-8")))

    def test_残留的旧vfx键_不点按钮原样保留_点按钮才删且可撤销(self) -> None:
        from PySide6.QtTest import QTest

        legacy = [{"id": "vfx_bats", "effect": "bat_cliff", "anchor": {"x": 1, "y": 2}, "timePhases": ["夜"]}]
        sc = _scene(_SID)
        # 旧键夹在中间：保留时连它在文件里的位置都不许变
        sc = {**{k: sc[k] for k in ("id", "name", "worldWidth", "worldHeight")}, "vfx": legacy,
              **{k: v for k, v in sc.items() if k not in ("id", "name", "worldWidth", "worldHeight")}}
        with TemporaryDirectory() as td:
            root = self._project(td, {_SID: sc})
            path = root / "public" / "assets" / "scenes" / f"{_SID}.json"
            ed, model = self._editor(root)
            props = ed._props
            self.assertTrue(props._sc_vfx_legacy.isVisibleTo(props), "残留的旧 vfx 键没报出来")
            self.assertIn("运行时已经不读", props._sc_vfx_legacy.text())
            self.assertTrue(props._sc_vfx_legacy_drop.isVisibleTo(props))
            self.assertTrue(props._sc_vfx_fold.is_expanded(), "有残留要自己展开，否则红字没人看得见")

            # 1) 改别的字段、提交、保存：旧 vfx 键原样留着（内容与位置都不变）
            props._sc_name.setFocus()
            QTest.keyClicks(props._sc_name, "X")
            self.assertTrue(ed._undo_flush_pending_as_command())
            model.save_all()
            on_disk = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(on_disk["name"], _SID + "X")
            want = dict(sc, name=_SID + "X")
            self.assertEqual(path.read_bytes(), _dump(want), "没点按钮，保存却动了旧 vfx 键（或别的字节）")

            # 2) 点按钮：staging 里拿掉、标 pending；提交后模型里没了；存盘后文件里没了
            self._click_button(props._sc_vfx_legacy_drop)
            self.assertTrue(props.is_pending_dirty())
            self.assertFalse(props._sc_vfx_legacy.isVisibleTo(props))
            self.assertIn("vfx", model.scenes[_SID], "还没提交就直接改了模型")
            self.assertTrue(ed._undo_flush_pending_as_command())
            self.assertNotIn("vfx", model.scenes[_SID])
            model.save_all()
            self.assertEqual(path.read_bytes(), _dump({k: v for k, v in want.items() if k != "vfx"}))

            # 3) 撤销：键回来，位置不变，红字回来
            self.assertTrue(ed._undo.stack.canUndo())
            ed._undo.stack.undo()
            _pump()
            self.assertEqual(list(model.scenes[_SID].keys()), list(want.keys()), "撤销后键或键序不对")
            self.assertEqual(model.scenes[_SID]["vfx"], legacy)
            self.assertTrue(props._sc_vfx_legacy.isVisibleTo(props))


# --------------------------------------------------------------------------- #
# 纯函数：时段外观判据 / 校验器（与 TS 对账）
# --------------------------------------------------------------------------- #

class AppearancePhaseParityTests(unittest.TestCase):
    def test_与_resolveSceneAppearance_同判据(self) -> None:
        on = {"dayNight": {"enabled": True}, "timeVariants": {"夜": {"bgm": "x"}, "空": {}}}
        self.assertEqual(vfx_placements.resolve_appearance_phase(on, "夜"), "夜")
        self.assertEqual(vfx_placements.resolve_appearance_phase(on, "空"), "空", "TS 里 {} 为真")
        self.assertEqual(vfx_placements.resolve_appearance_phase(on, "辰时"), "")
        self.assertEqual(vfx_placements.resolve_appearance_phase(on, ""), "")
        off = dict(on, dayNight={"enabled": "yes"})
        self.assertEqual(vfx_placements.resolve_appearance_phase(off, "夜"), "", "enabled 必须 === true")
        ts = (REPO / "src/utils/sceneAppearance.ts").read_text(encoding="utf-8")
        self.assertIn("const on = scene.dayNight?.enabled === true;", ts, "TS 判据变了：对账失效")
        self.assertIn("const v = on && phase ? scene.timeVariants?.[phase] : undefined;", ts)


class ValidatorTests(unittest.TestCase):
    """粒子区域形状的校验（``validator._check_vfx_confine``）+ 与 TS 的几何对账。"""

    def _issues(self, row: dict, effects: dict | None = None) -> list:
        from tools.editor import validator

        class FakeModel:
            vfx_effects = effects or {}

        issues: list = []
        area = row.get("area") if isinstance(row.get("area"), list) else None
        validator._check_vfx_confine(FakeModel(), issues, "s", str(row.get("id")), row, area)  # type: ignore[arg-type]
        return issues

    PAPER = {"paper_money": {"id": "paper_money", "emitters": [
        {"id": "paper", "appearance": {"image": "x", "sizeWu": 16}, "spawn": {"max": 1},
         "plate": {"size": [16, 16], "terminalSpeed": 90}}]}}

    def test_合法形态零告警(self) -> None:
        for conf in ({}, {"feather": 0}, {"feather": 150, "ceiling": 400}):
            row = {"id": "v", "effect": "paper_money", "anchor": {"x": 600, "y": 400},
                   "area": _A, "confine": conf}
            self.assertEqual(self._issues(row, self.PAPER), [], conf)
        self.assertEqual(self._issues({"id": "v", "area": _A}), [], "没配 confine 什么都不查")

    def test_坏数据必报(self) -> None:
        def sev(row: dict, effects: dict | None = None) -> list[str]:
            return [i.severity for i in self._issues(row, effects)]

        base = {"id": "v", "effect": "paper_money", "anchor": {"x": 600, "y": 400}, "area": _A}
        only_range = {k: v for k, v in base.items() if k != "area"}
        self.assertEqual(sev({**only_range, "confine": {"area": _A}}), [])
        self.assertIn("error", sev({**base, "confine": {"area": [[0, 0], [1, 1]]}}), "范围区域形状坏")
        far = [[5000, 5000], [5100, 5000], [5100, 5100], [5000, 5100]]
        self.assertEqual(sev({**base, "anchor": {"x": 5050, "y": 5050}, "confine": {"area": far}}),
                         ["warning"], "发射区域与范围区域不相交")
        self.assertEqual(sev({**base, "confine": "yes"}), ["error"])
        self.assertIn("error", sev({**base, "confine": {"feather": -1}}))
        self.assertIn("error", sev({**base, "confine": {"feather": "宽"}}))
        self.assertIn("error", sev({**base, "confine": {"ceiling": 0}}))
        self.assertEqual(sev({**only_range, "confine": {}}), ["error"], "没有区域的限定运行时整条忽略")
        bow = [[0, 0], [100, 100], [100, 0], [0, 100]]
        self.assertEqual(sev({**base, "area": bow, "confine": {}}), ["warning"], "自相交")

    def test_自相交判据(self) -> None:
        self.assertFalse(vfx_confine.polygon_self_intersects(_A))
        self.assertTrue(vfx_confine.polygon_self_intersects([[0, 0], [100, 100], [100, 0], [0, 100]]))

    def test_缺省边带宽与运行时同一个数(self) -> None:
        ts = (REPO / "src/systems/vfx/vfxConfine.ts").read_text(encoding="utf-8")
        m = re.search(r"export const CONFINE_FEATHER_DEFAULT = (\d+(?:\.\d+)?);", ts)
        self.assertIsNotNone(m, "TS 那边的常量改名了：对账失效")
        self.assertEqual(float(m.group(1)), vfx_confine.CONFINE_FEATHER_DEFAULT)

    def test_点在多边形里与运行时同一条式子(self) -> None:
        ts = (REPO / "src/systems/vfx/vfxConfine.ts").read_text(encoding="utf-8")
        self.assertIn("x < ((xj - xi) * (y - yi)) / (yj - yi) + xi", ts, "运行时奇偶规则的式子变了：对账失效")
        self.assertTrue(vfx_confine.point_in_polygon(_A, 600, 400))
        self.assertFalse(vfx_confine.point_in_polygon(_A, 100, 400))

    def test_仓库里的真布置零新增告警(self) -> None:
        """布置库里每一条实例（跑马梁纸钱：有 area、没 confine）不许因为区域这一块多出任何 issue。"""
        lib, err = vfx_placements.load_library(REPO)
        self.assertEqual(err, "")
        rows = list(vfx_placements.iter_rows(lib))
        self.assertTrue(rows, "布置库是空的：这条断言形同虚设")
        for sid, ph, _i, row in rows:
            with self.subTest(where=(sid, ph, row.get("id"))):
                self.assertEqual(self._issues(row), [])


if __name__ == "__main__":
    unittest.main()
