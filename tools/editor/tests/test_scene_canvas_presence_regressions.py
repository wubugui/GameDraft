"""画布「该藏的没藏」整族回归锁。

## 为什么单独一个文件

`test_scene_view_filters_compose.py` 锁的是**判定**（两条轴怎么 and、缺省怎么分叉），
断言口径是 `_entity_items["kind:id"].isVisible()` —— 也就是**只看那一个圆点图元**。
于是判定一直是对的、测试一直是绿的，而画布上真正显眼的那几层（NPC 动画精灵、
热点展示图、碰撞幽灵、巡逻折线）从来没被查过：

- **NPC 动画精灵根本不在画布的实体图元表里**（它住 `SceneEditor._scene_npc_runtimes`），
  `set_entity_visible` 的 npc 分支压根碰不到它 → 切时段/位面，圆点藏了，人还站在那儿。
- 附属图元**重建后默认可见**，没人重贴过滤 → 藏起来的实体只要被刷新一次就冒回来一半。

本文件按「图元层」而不是「判定」组织断言，专治这一类。判定归 compose 那份，两边互补。

标了 `expectedFailure` 的用例 = **当前确实有这个 bug**，修复后必须去掉标记转绿。
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

_SCENE_ID = "显隐测试街"

#: 与 test_scene_view_filters_compose 同款时段表：辰/午 是「街上有人」，暮/夜 不是。
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
            # 无 phases → 吃 NPC 缺省（只在 daylight 段），故切到「夜」应当藏起来
            {"id": "npc_龙套", "name": "龙套", "x": 100, "y": 100, "interactionRange": 50},
        ],
        "hotspots": [
            # 写死只在「夜」出现，故切到「辰」应当藏起来。
            # displayImage 指向一张磁盘上不存在的图 → 画布走「紫色缺件占位框」分支，
            # 该分支不设签名缓存，每次刷新都重建图元 —— 正好用来验「重建后过滤丢没丢」。
            {"id": "hs_夜市摊", "type": "inspect", "x": 200, "y": 200,
             "interactionRange": 50, "phases": ["夜"],
             "displayImage": {"image": "/assets/scenes/nope/missing.png",
                              "worldWidth": 120, "worldHeight": 90},
             "collisionPolygonLocal": True,
             "collisionPolygon": [{"x": -20, "y": -15}, {"x": 20, "y": -15}, {"x": 0, "y": 20}]},
        ],
        "zones": [],
    }


class _CanvasPresenceBase(unittest.TestCase):
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

    def _editor(self, root: Path) -> SceneEditor:
        write_minimal_loadable_project(root)
        cfg_path = root / "public" / "assets" / "data" / "game_config.json"
        cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
        cfg["dayNight"] = {"phases": _PHASES}
        cfg_path.write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        model = ProjectModel()
        model.load_project(root)
        model.scenes[_SCENE_ID] = _scene()
        ed = SceneEditor(model)
        self._editors.append(ed)
        ed._refill_scene_cutscene_ctx_combo(init=True)
        ed._refill_scene_phase_view_combo(init=True)
        ed._load_scene(_SCENE_ID)
        ed._canvas._auto_fit_after_layout = False
        return ed

    # ---- 断言口径 ----

    def _item(self, ed: SceneEditor, key: str):
        return ed._canvas._entity_items.get(key)

    def _assert_hidden(self, ed: SceneEditor, key: str, why: str) -> None:
        it = self._item(ed, key)
        self.assertIsNotNone(it, f"{key} 不在画布上（本用例要求它存在但隐藏）")
        self.assertFalse(it.isVisible(), why)

    def _set_night(self, ed: SceneEditor) -> None:
        """切到「夜」：NPC 缺省(daylight) 被藏，写了 phases=['夜'] 的热点显出来。"""
        ed._canvas.set_phase_filter("夜", ed._model.daylight_phase_ids())

    def _set_morning(self, ed: SceneEditor) -> None:
        """切到「辰」：NPC 显出来，只在夜里的热点被藏。"""
        ed._canvas.set_phase_filter("辰", ed._model.daylight_phase_ids())


class NpcSpriteFollowsViewFiltersTests(_CanvasPresenceBase):
    """P0：NPC 动画精灵必须跟着圆点一起藏。"""

    def _attach_runtime(self, ed: SceneEditor, npc_id: str) -> _SceneNpcAnimRuntime:
        """挂一个**真的** `_SceneNpcAnimRuntime`（不是桩），这样 8ms 自愈能被真实复现。"""
        atlas = QPixmap(8, 8)
        atlas.fill()
        item = QGraphicsPixmapItem()
        ed._canvas.graphics_scene().addItem(item)
        rt = _SceneNpcAnimRuntime(
            npc_id, item, atlas, 1, 1, 40.0, 80.0, [0], 8.0, True)
        ed._scene_npc_runtimes[npc_id] = rt
        rt.draw_at(100.0, 100.0)
        self.assertTrue(item.isVisible(), "前置条件：精灵初始应当可见")
        return rt

    def test_phase_filter_hides_npc_sprite(self) -> None:
        """切时段藏掉 NPC 时，它的动画精灵必须一起藏。

        修复前：`set_entity_visible` 的 npc 分支手写了三个键加巡逻折线，**完全不碰**
        精灵——精灵不在 `_entity_items` 里，而在 `SceneEditor._scene_npc_runtimes[eid].item`。
        现在 sprite 是 `PART_TABLE["npc"]` 里的一个 part，经适配器覆盖到。
        """
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            rt = self._attach_runtime(ed, "npc_龙套")
            self._set_night(ed)
            self._assert_hidden(ed, "npc:npc_龙套", "前置条件：圆点应当被时段藏起来")
            self.assertFalse(
                rt.item.isVisible(),
                "圆点藏了但动画精灵还在画——画布上那个人根本没消失")

    def test_anim_tick_does_not_resurrect_hidden_sprite(self) -> None:
        """精灵被时段藏起来后，8ms 动画定时器**连走三拍**也不许把它放出来。

        修复前：`_SceneNpcAnimRuntime.draw_at` 最后一行是无条件 `self.item.show()`，
        每拍都执行。所以「给精灵补一句 `item.setVisible(False)`」是**无效修法**，
        改完看着像判定函数写错——闸门必须在 runtime 内部（`rt.visible`）。
        """
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            rt = self._attach_runtime(ed, "npc_龙套")
            self._set_night(ed)
            self.assertFalse(rt.item.isVisible(), "前置条件：切时段后精灵应当已经藏了")
            ed._patrol_preview_ids = set()
            ed._scene_npc_anim_elapsed.start()
            for tick in range(3):
                ed._tick_scene_npc_anims()
                self.assertFalse(
                    rt.item.isVisible(),
                    f"第 {tick + 1} 拍把隐藏结论冲掉了——draw_at 又无条件 show() 了")


class RebuiltPartsKeepPresenceTests(_CanvasPresenceBase):
    """附属图元重建后必须重贴过滤，不许默认可见地冒回来。"""

    def test_display_image_rebuild_keeps_hidden(self) -> None:
        """被时段藏起来的热点，刷新展示图后展示图不许冒出来。

        触发链（真实可复现）：改透视配置 → `_refresh_all_persp_previews` 无差别遍历
        **全部**热点调 `refresh_hotspot_visuals` → 重建出来的展示图默认可见，
        没人重贴过滤 → 圆点还藏着、贴图回来了，画布上出现半个鬼影。

        修复：`refresh_hotspot_visuals` 末尾无条件重贴一次 presence。
        """
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            self._set_morning(ed)
            self._assert_hidden(ed, "hotspot:hs_夜市摊", "前置条件：圆点应当被时段藏起来")
            self._assert_hidden(
                ed, "hotspot_display:hs_夜市摊", "前置条件：展示图初始应当也是藏的")

            ed._refresh_all_persp_previews()    # 任何一次全量刷新都触发

            self._assert_hidden(
                ed, "hotspot_display:hs_夜市摊",
                "展示图重建后默认可见，把时段过滤的结论冲掉了")

    def test_collision_polygon_refresh_keeps_hidden(self) -> None:
        """碰撞多边形刷新后仍是藏的 —— **这条现在就是绿的**，写下来是当护栏。

        它和上面那条展示图用例只差一个字：碰撞多边形走的是
        `set_points_from_model` **原地更新**（图元没被换掉，可见性自然留着），
        而展示图缺件占位框那一支没有签名缓存、每次都重建，于是把过滤冲掉。

        所以「重建即丢显隐」这个 bug 的边界是**重建**，不是刷新。重构成统一 sync
        出口后，两条路径都必须在末尾无条件重贴一次 presence —— 那时这条用例保证
        原地更新那一支没被顺手改成删了重建（那会同时带回崩溃与狂闪的老账）。
        """
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            self._set_morning(ed)
            self._assert_hidden(
                ed, "hotspot_collision:hs_夜市摊", "前置条件：碰撞多边形初始应当是藏的")

            ed._refresh_all_persp_previews()

            self._assert_hidden(
                ed, "hotspot_collision:hs_夜市摊",
                "碰撞多边形重建后默认可见，把时段过滤的结论冲掉了")


class LedgerIsEmptyAfterClearTests(_CanvasPresenceBase):
    """`clear_scene()` 之后每一本账都必须是空的。

    这一条现在**是绿的**，靠的是 `_gfx.clear()` 一把梭兜底。写下来是为了在把
    `clear_scene` 改成逐项 removeItem 时立刻发现漏网的那两个
    （背景占位文字完全没登记；NPC 精灵不在画布任何容器里）。
    """

    def test_all_ledgers_empty(self) -> None:
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            canvas = ed._canvas
            self.assertTrue(canvas._entity_items, "前置条件：清空前账本应当非空")

            canvas.clear_scene()

            self.assertEqual(canvas._entity_items, {}, "_entity_items 未清空")
            self.assertEqual(canvas._group_boxes, {}, "_group_boxes 未清空")
            self.assertEqual(canvas._patrol_overlays, {}, "_patrol_overlays 未清空")
            self.assertEqual(canvas._entity_view_meta, {}, "_entity_view_meta 未清空")
            self.assertEqual(canvas._npc_ref_items, [], "_npc_ref_items 未清空")
            self.assertIsNone(canvas._lightcurve_overlay, "_lightcurve_overlay 未置空")
            self.assertIsNone(canvas._transform_gizmo, "_transform_gizmo 未置空")
            self.assertIsNone(canvas._persp_axis_item, "_persp_axis_item 未置空")
            self.assertIsNone(canvas._bg_item, "_bg_item 未置空")

    def test_saved_pick_z_dropped_on_clear(self) -> None:
        """叠放循环点选临时抬 z 后清场：`_saved_item_z` 必须一起丢掉。

        否则里面存的是已析构图元的引用，下次 `_restore_pick_z_order` 直接碰 C++ 死对象。
        """
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            canvas = ed._canvas
            item = canvas._entity_items["npc:npc_龙套"]
            canvas._saved_item_z = [(item, item.zValue())]

            canvas.clear_scene()

            self.assertIsNone(canvas._saved_item_z, "清场后仍留着已析构图元的 z 快照")


class PerspectiveConfigIsolationTests(_CanvasPresenceBase):
    """画布持有的透视配置必须与模型隔离（live 拖轴会就地改端点）。"""

    def test_canvas_persp_cfg_is_a_deep_copy(self) -> None:
        with TemporaryDirectory() as td:
            ed = self._editor(Path(td) / "p")
            cfg = {"near": {"x": 0, "y": 0, "scale": 1.0},
                   "far": {"x": 100, "y": 100, "scale": 2.0}}
            ed._canvas.set_perspective_config(cfg)

            self.assertIsNotNone(ed._canvas._persp_cfg)
            self.assertIsNot(
                ed._canvas._persp_cfg, cfg,
                "画布直接持了模型的 dict —— live 拖轴会就地改端点，污染模型与撤销基线")
            self.assertIsNot(
                ed._canvas._persp_cfg["near"], cfg["near"],
                "只做了浅拷贝：端点子 dict 仍与模型共享")


if __name__ == "__main__":
    unittest.main()
