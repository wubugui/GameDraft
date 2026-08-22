"""画布内容层的前后次序必须与运行时一致（"画布不许骗人"）。

运行时 `Renderer.sortEntityLayer` 按「三档 × 档内脚底 y」每帧实时排；编辑器画布
此前是一张写死的层表 —— NPC 动画精灵恒 z=-10、热点展示图恒 z=-4，于是
**画布上 NPC 永远被热点贴图压住**，与游戏里谁前谁后毫无关系。而"精灵排序"
（`spriteSort`）那个下拉框在画布上更是完全没有体现。

这类偏差是"看着对、跑起来不对"：策划照着画布把物件前后关系排好，进游戏才发现
反了，而且没有任何东西会报错。规则本身的 parity 由
`test_entity_sort_parity.py` 锁；**本文件锁画布真的用上了它**。
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import QApplication, QGraphicsPixmapItem

from tools.editor.editors.scene_editor import SceneEditor, _SceneNpcAnimRuntime
from tools.editor.project_model import ProjectModel
from tools.editor.tests.qt_teardown import quiesce_scene_editor
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SCENE_ID = "叠放测试街"


#: 由 `_editor()` 填成一张真实存在的 PNG 的绝对路径。
#: **档位测试必须用真能加载的图**：运行时 `Hotspot._syncEntitySortBand` 要求
#: `displaySprite !== null` 才标档位，编辑器同口径（读盘失败 = 画紫色缺件框 = 无档位）。
#: 早先这里写的是一张不存在的图，于是 back/front 用例全都"没生效"——
#: 那不是 bug，是镜像正确、而夹具喂错了。
_REAL_PNG = ""


def _hotspot(hid: str, x: float, y: float, sprite_sort: str | None = None) -> dict:
    di: dict = {"image": _REAL_PNG, "worldWidth": 100, "worldHeight": 80}
    if sprite_sort:
        di["spriteSort"] = sprite_sort
    return {"id": hid, "type": "inspect", "x": x, "y": y,
            "interactionRange": 50, "displayImage": di}


def _scene() -> dict:
    return {
        "id": _SCENE_ID, "name": _SCENE_ID, "worldWidth": 800, "worldHeight": 600,
        "spawnPoint": {"x": 10, "y": 10},
        "hotspots": [
            _hotspot("hs_近", 200, 400),   # 脚底更靠下 = 更近 = 该更靠前
            _hotspot("hs_远", 300, 100),   # 脚底更靠上 = 更远 = 该更靠后
        ],
        "npcs": [
            {"id": "npc_中", "name": "中", "x": 250, "y": 250, "interactionRange": 50},
        ],
        "zones": [],
    }


class CanvasContentOrderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._editors: list[SceneEditor] = []

    def tearDown(self) -> None:
        for ed in self._editors:
            quiesce_scene_editor(ed)
            ed.deleteLater()
        self._editors.clear()
        QApplication.processEvents()

    def _write_real_png(self, root: Path) -> str:
        """落一张真能被 QPixmap 读出来的图，返回绝对路径（解析器接受本机绝对路径）。"""
        global _REAL_PNG
        root.mkdir(parents=True, exist_ok=True)
        png = root / "disp.png"
        pm = QPixmap(4, 4)
        pm.fill()
        self.assertTrue(pm.save(str(png), "PNG"), "测试夹具：PNG 没写出来")
        _REAL_PNG = str(png)
        return _REAL_PNG

    def _editor(self, root: Path, mutate=None) -> SceneEditor:
        write_minimal_loadable_project(root)
        # 必须先落图再建场景：_hotspot() 读的是模块级 _REAL_PNG
        self._write_real_png(root)
        scene = _scene()
        if mutate is not None:
            mutate(scene)
        model = ProjectModel()
        model.load_project(root)
        model.scenes[_SCENE_ID] = scene
        ed = SceneEditor(model)
        self._editors.append(ed)
        ed._load_scene(_SCENE_ID)
        ed._canvas._auto_fit_after_layout = False
        return ed

    def _attach_sprite(self, ed: SceneEditor, npc_id: str) -> _SceneNpcAnimRuntime:
        """给 NPC 挂一个真 runtime（最小 1x1 图集），让它进入内容排序。"""
        atlas = QPixmap(8, 8)
        atlas.fill()
        item = QGraphicsPixmapItem()
        ed._canvas.graphics_scene().addItem(item)
        rt = _SceneNpcAnimRuntime(npc_id, item, atlas, 1, 1, 40.0, 80.0, [0], 8.0, True)
        ed._scene_npc_runtimes[npc_id] = rt
        return rt

    def _z(self, ed: SceneEditor, key: str) -> float:
        it = ed._canvas._entity_items.get(key)
        self.assertIsNotNone(it, f"{key} 不在画布上")
        return it.zValue()

    # ---- 档内按脚底 y ----

    def test_nearer_hotspot_draws_in_front(self) -> None:
        """脚底更靠下（y 更大 = 离镜头更近）的热点必须画在更前面。"""
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            ed._resort_canvas_content_z()
            self.assertGreater(
                self._z(ed, "hotspot_display:hs_近"),
                self._z(ed, "hotspot_display:hs_远"),
                "脚底更近的热点没有画在更前面——画布没按脚底 y 排")

    def test_npc_sprite_interleaves_with_hotspots_by_foot_y(self) -> None:
        """NPC 精灵必须与热点展示图**混排**，而不是恒在它们底下。

        这正是原来那张写死层表的病灶：精灵恒 -10、展示图恒 -4，
        于是画布上 NPC 永远被任何热点贴图压住。
        """
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            rt = self._attach_sprite(ed, "npc_中")
            ed._resort_canvas_content_z()

            z_far = self._z(ed, "hotspot_display:hs_远")     # y=100
            z_npc = rt.item.zValue()                          # y=250
            z_near = self._z(ed, "hotspot_display:hs_近")    # y=400

            self.assertGreater(z_npc, z_far, "NPC(y=250) 应画在远处热点(y=100)之前")
            self.assertLess(z_npc, z_near, "NPC(y=250) 应画在近处热点(y=400)之后")

    # ---- 三档 ----

    def test_sprite_sort_back_pushes_behind_everything(self) -> None:
        """`spriteSort: back` 的热点必须沉到全部无档位实体之下（哪怕它脚底最近）。"""
        with TemporaryDirectory() as td:
            def mk(sc):
                sc["hotspots"][0] = _hotspot("hs_近", 200, 400, sprite_sort="back")
            ed = self._editor(Path(td) / "p", mk)
            rt = self._attach_sprite(ed, "npc_中")
            ed._resort_canvas_content_z()

            self.assertLess(
                self._z(ed, "hotspot_display:hs_近"), rt.item.zValue(),
                "标了 back 的热点没有沉到 NPC 之下")
            self.assertLess(
                self._z(ed, "hotspot_display:hs_近"),
                self._z(ed, "hotspot_display:hs_远"),
                "标了 back 的热点没有沉到无档位热点之下")

    def test_sprite_sort_front_lifts_above_everything(self) -> None:
        """`spriteSort: front` 的热点必须浮到全部无档位实体之上（哪怕它脚底最远）。"""
        with TemporaryDirectory() as td:
            def mk(sc):
                sc["hotspots"][1] = _hotspot("hs_远", 300, 100, sprite_sort="front")
            ed = self._editor(Path(td) / "p", mk)
            rt = self._attach_sprite(ed, "npc_中")
            ed._resort_canvas_content_z()

            self.assertGreater(
                self._z(ed, "hotspot_display:hs_远"), rt.item.zValue(),
                "标了 front 的热点没有浮到 NPC 之上")
            self.assertGreater(
                self._z(ed, "hotspot_display:hs_远"),
                self._z(ed, "hotspot_display:hs_近"),
                "标了 front 的热点没有浮到无档位热点之上")

    def test_npc_sprite_sort_also_honoured(self) -> None:
        """NPC 侧的 `spriteSort` 同样要生效（运行时不要求精灵已装载）。"""
        with TemporaryDirectory() as td:
            def mk(sc):
                sc["npcs"][0]["spriteSort"] = "front"
            ed = self._editor(Path(td) / "p", mk)
            rt = self._attach_sprite(ed, "npc_中")
            ed._resort_canvas_content_z()
            self.assertGreater(
                rt.item.zValue(), self._z(ed, "hotspot_display:hs_近"),
                "NPC 标了 front 却没浮到脚底更近的热点之上")

    # ---- 区间与稳定性 ----

    def test_content_z_stays_inside_the_content_band(self) -> None:
        """内容 z 不许溢出到装饰品区间，否则会盖住把手/碰撞顶点，画布点不动。"""
        from tools.editor.editors import scene_editor as se
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            self._attach_sprite(ed, "npc_中")
            ed._resort_canvas_content_z()
            for key in ("hotspot_display:hs_近", "hotspot_display:hs_远"):
                z = self._z(ed, key)
                self.assertGreaterEqual(z, se._Z_CONTENT_LO)
                self.assertLess(z, se._Z_CONTENT_HI)

    def test_handles_stay_above_content(self) -> None:
        """把手恒在内容之上 —— 否则拖不动、点不着。"""
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            ed._resort_canvas_content_z()
            self.assertGreater(
                self._z(ed, "hotspot:hs_近"), self._z(ed, "hotspot_display:hs_近"),
                "热点把手被自己的展示图盖住了")

    def test_resort_is_idempotent_and_dirty_checked(self) -> None:
        """没变化时重排必须是空操作（巡逻预览下每 8ms 调一次，不能每拍全场写 z）。"""
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            self._attach_sprite(ed, "npc_中")
            ed._resort_canvas_content_z()
            before = dict(
                (k, ed._canvas._entity_items[k].zValue())
                for k in ("hotspot_display:hs_近", "hotspot_display:hs_远"))
            key_before = ed._content_z_key

            ed._resort_canvas_content_z()

            self.assertIs(ed._content_z_key, key_before, "脏检查没命中，白重排了一趟")
            for k, v in before.items():
                self.assertEqual(ed._canvas._entity_items[k].zValue(), v)

    # ---- 排序输入变了就必须重排（对抗式复核逮到的整族漏网） ----

    def test_property_panel_y_change_reorders(self) -> None:
        """在**数值框**里改 y 也要重排 —— 不能只有画布拖动那条路对。

        漏这一条的表现最刺眼：数值框改完，贴图移过去了、前后关系没跟着变；
        而在画布上拖同一个热点却是对的。两条路径行为不一致。
        """
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            ed._resort_canvas_content_z()
            self.assertLess(
                self._z(ed, "hotspot_display:hs_远"),
                self._z(ed, "hotspot_display:hs_近"))

            ed._on_item_selected("hotspot", "hs_远")
            ed._props._hs_y.setValue(590.0)

            self.assertGreater(
                self._z(ed, "hotspot_display:hs_远"),
                self._z(ed, "hotspot_display:hs_近"),
                "数值框改 y 后没重排：贴图移了、前后关系没动")

    def test_sprite_sort_change_takes_effect_without_apply(self) -> None:
        """改「精灵排序」下拉必须**立刻**在画布上生效，不能等到 Apply。

        两处新 tooltip 对策划承诺了"画布已按运行时同一条规则预览"。
        """
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            ed._resort_canvas_content_z()
            self.assertLess(
                self._z(ed, "hotspot_display:hs_远"),
                self._z(ed, "hotspot_display:hs_近"))

            ed._on_item_selected("hotspot", "hs_远")
            idx = ed._props._hs_disp_sprite_sort.findData("front")
            self.assertGreaterEqual(idx, 0, "夹具：找不到 front 选项")
            ed._props._hs_disp_sprite_sort.setCurrentIndex(idx)

            self.assertGreater(
                self._z(ed, "hotspot_display:hs_远"),
                self._z(ed, "hotspot_display:hs_近"),
                "改精灵排序后画布没跟着重排（要等 Apply 才跳一下）")

    def test_npc_sprite_sort_reads_staging_not_model(self) -> None:
        """NPC 的档位也要读 staging —— 与热点侧对称。

        同一个函数里位置读 staging、档位读模型，是最难查的不对称。
        """
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            # 先选中再挂精灵：选中会走 _refresh_one_scene_npc_anim，那条路会（正确地）
            # 把手工挂的替身 runtime 回收掉——真实场景里那里会重建一个真 runtime。
            ed._on_item_selected("npc", "npc_中")
            rt = self._attach_sprite(ed, "npc_中")
            ed._resort_canvas_content_z()
            self.assertLess(rt.item.zValue(), self._z(ed, "hotspot_display:hs_近"))

            idx = ed._props._npc_sprite_sort.findData("front")
            self.assertGreaterEqual(idx, 0, "夹具：找不到 front 选项")
            ed._props._npc_sprite_sort.setCurrentIndex(idx)
            ed._resort_canvas_content_z()

            self.assertGreater(
                rt.item.zValue(), self._z(ed, "hotspot_display:hs_近"),
                "NPC 档位读的是模型而不是 staging：改完要等 Apply 才生效")

    def test_dirty_key_survives_item_identity_reuse(self) -> None:
        """脏检查的键不许用 `id(item)` —— CPython 的 id 是内存地址，会被回收复用。

        图元析构后新图元完全可能拿到同一个 id，那时键"看着没变"而图元已换人，
        该重排的一趟被静默跳过。这里直接断言键里不含任何 id 值。
        """
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            ed._resort_canvas_content_z()
            ids = {id(e[2]) for e in ed._content_sort_entries()}
            flat = {v for row in ed._content_z_key for v in row}
            self.assertTrue(ed._content_z_key, "前置条件：脏检查键不应为空")
            self.assertFalse(
                ids & flat, "脏检查键里混进了 id(item)，图元换人后会静默跳过重排")

    def test_moving_an_entity_reorders(self) -> None:
        """把远处热点拖到最下面，它就该翻到最前 —— 排序是真的在跟着数据走。"""
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            ed._resort_canvas_content_z()
            self.assertLess(
                self._z(ed, "hotspot_display:hs_远"),
                self._z(ed, "hotspot_display:hs_近"))

            ed._on_item_selected("hotspot", "hs_远")
            ed._on_item_position_live("hotspot", "hs_远", 300.0, 590.0)

            self.assertGreater(
                self._z(ed, "hotspot_display:hs_远"),
                self._z(ed, "hotspot_display:hs_近"),
                "拖到最下面后仍没翻到最前——拖动路径没有触发重排")


if __name__ == "__main__":
    unittest.main()
