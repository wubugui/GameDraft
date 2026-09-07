"""场景级与 zone 级 `footstepSet` 字段的编辑器护栏。

契约（与「按 E 交互」区块同口径）：
- 打开已有数据 → zone 区块自动展开、两级字段都回填（未展开也不许丢字段）；
- 打开-不动-Apply → 内容与未知键原样不变（往返零丢失）；
- 面板编辑 → Apply 落 dict；清空 → 删键而不是写空串；
- 切成 depth_floor 会清掉 zone.footstepSet（该类型不做区域判定），确认框判据要认它；
- 目录里没有的集 id 必须保值（脚步素材尚未入库，作者会先把 id 填进去）。

⚠ 只按区配 ≠ 配了：背尸上山那六个场景 `zones` 全为空，区上根本没地方填 ——
所以场景级默认那一格必须自成一条往返用例，不能只验 zone。
"""
from __future__ import annotations

import copy
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.scene_editor import SceneEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

_SETS = {
    "sets": {
        "fs_stone": {"label": "石板路", "sfx": {"walk": "step_stone_1"}},
        "fs_grass": {"label": "草地", "sfx": {"walk": "step_grass_1"}},
    },
}


def _scene(*, scene_set: str | None = None, zone_set: str | None = None) -> dict:
    zone: dict = {
        "id": "z1",
        "polygon": [{"x": 0, "y": 0}, {"x": 50, "y": 0}, {"x": 50, "y": 50}],
        "unknownZoneField": {"keep": True},
    }
    if zone_set is not None:
        zone["footstepSet"] = zone_set
    sc: dict = {
        "id": "sc_a",
        "name": "场景甲",
        "hotspots": [],
        "npcs": [],
        "zones": [zone],
        "spawnPoints": {},
        "unknownSceneField": {"keep": True},
    }
    if scene_set is not None:
        sc["footstepSet"] = scene_set
    return sc


class SceneFootstepFieldTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

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
        self._editors.clear()
        QApplication.processEvents()

    def _editor(
        self, root: Path, *, scene_set: str | None = None, zone_set: str | None = None,
    ) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        # 真候选：保值分支与「未知 id」分支只有在有候选时才分得开
        model.footstep_sets = copy.deepcopy(_SETS)
        model.scenes = {"sc_a": _scene(scene_set=scene_set, zone_set=zone_set)}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        ed._undo.clear()
        return ed, model

    @staticmethod
    def _zone(model: ProjectModel) -> dict:
        return model.scenes["sc_a"]["zones"][0]

    @staticmethod
    def _sc(model: ProjectModel) -> dict:
        return model.scenes["sc_a"]

    def _select_zone(self, ed: SceneEditor) -> None:
        ed._on_item_selected("zone", "z1")
        QApplication.processEvents()

    # ------------------------------------------------------------ zone 级

    def test_zone_existing_data_loads_and_section_expands(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p", zone_set="fs_grass")
            self._select_zone(ed)
            self.assertEqual(ed._props._zn_footstep.current_id(), "fs_grass")
            self.assertTrue(
                ed._props._zn_footstep_fold.is_expanded(),
                "已配 footstepSet 的区，脚步声区块应自动展开（折叠着＝作者看不见已有配置）",
            )

    def test_zone_section_stays_collapsed_when_empty(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            self._select_zone(ed)
            self.assertEqual(ed._props._zn_footstep.current_id(), "")
            self.assertFalse(ed._props._zn_footstep_fold.is_expanded())

    def test_zone_apply_without_touching_keeps_content(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", zone_set="fs_stone")
            before = copy.deepcopy(self._zone(model))
            self._select_zone(ed)
            ed._apply_props()
            self.assertEqual(self._zone(model), before,
                             "打开-不动-Apply 必须逐字节回来（含未知键）")

    def test_zone_apply_without_touching_keeps_absence(self) -> None:
        """本来就没这个键的区，浏览一趟不许被塞一个空串/默认值进去。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            before = copy.deepcopy(self._zone(model))
            self._select_zone(ed)
            ed._apply_props()
            self.assertEqual(self._zone(model), before)
            self.assertNotIn("footstepSet", self._zone(model))

    def test_zone_edit_applies(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            self._select_zone(ed)
            ed._props._zn_footstep.set_current("fs_stone")
            ed._apply_props()
            z = self._zone(model)
            self.assertEqual(z["footstepSet"], "fs_stone")
            self.assertEqual(z["unknownZoneField"], {"keep": True})

    def test_zone_clearing_drops_key(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", zone_set="fs_grass")
            self._select_zone(ed)
            ed._props._zn_footstep.set_current("")
            ed._apply_props()
            z = self._zone(model)
            self.assertNotIn("footstepSet", z, "清空要删键，不能写空串")
            self.assertEqual(z["unknownZoneField"], {"keep": True})

    def test_zone_unknown_set_id_preserved(self) -> None:
        """脚步素材还没入库时作者会先填 id：候选里查不到也必须保值。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", zone_set="fs_not_in_catalog_yet")
            self._select_zone(ed)
            self.assertEqual(ed._props._zn_footstep.current_id(), "fs_not_in_catalog_yet")
            ed._apply_props()
            self.assertEqual(self._zone(model)["footstepSet"], "fs_not_in_catalog_yet")

    def test_depth_floor_switch_sees_footstep_set_and_clears_it(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", zone_set="fs_stone")
            self._select_zone(ed)
            props = ed._props
            # 只配了 footstepSet 的区，切类型确认框必须认它会丢（否则静默丢数据）
            props._zn_enter.set_data([])
            props._zn_stay.set_data([])
            props._zn_exit.set_data([])
            props._zn_interact.set_data([])
            self.assertEqual(props._zn_smell_scent.committed_type().strip(), "")
            asked: list[tuple[str, str]] = []
            original_confirm = props._confirm_zone_kind_switch
            props._confirm_zone_kind_switch = lambda prev, new: (  # type: ignore[method-assign]
                asked.append((prev, new)) or True)
            try:
                idx = props._zn_kind.findData("depth_floor")
                self.assertGreaterEqual(idx, 0)
                props._zn_kind.setCurrentIndex(idx)
                QApplication.processEvents()
            finally:
                props._confirm_zone_kind_switch = original_confirm  # type: ignore[method-assign]
            self.assertEqual(asked, [("standard", "depth_floor")],
                             "只配 footstepSet 的区切 depth_floor 也必须弹确认")

            ed._apply_props()
            z = self._zone(model)
            self.assertEqual(z.get("zoneKind"), "depth_floor")
            self.assertNotIn("footstepSet", z)

    def test_depth_floor_disables_footstep_section(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            self._select_zone(ed)
            props = ed._props
            self.assertTrue(props._zn_footstep_fold.isEnabled())
            props._zn_kind.blockSignals(True)
            try:
                props._zn_kind.setCurrentIndex(props._zn_kind.findData("depth_floor"))
            finally:
                props._zn_kind.blockSignals(False)
            props._apply_zone_kind_ui()
            self.assertFalse(props._zn_footstep_fold.isEnabled(),
                             "depth_floor 不做区域判定，脚步集在它上面无意义")

    # ------------------------------------------------------------ 场景级

    def test_scene_existing_data_loads(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p", scene_set="fs_stone")
            self.assertEqual(ed._props._sc_footstep.current_id(), "fs_stone")

    def test_scene_apply_without_touching_keeps_content(self) -> None:
        """场景级往返：打开-不动-Apply，字段与未知键都不许动。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", scene_set="fs_grass")
            ed._apply_props()
            sc = self._sc(model)
            self.assertEqual(sc["footstepSet"], "fs_grass")
            self.assertEqual(sc["unknownSceneField"], {"keep": True})

    def test_scene_apply_without_touching_keeps_absence(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._apply_props()
            self.assertNotIn("footstepSet", self._sc(model))

    def test_scene_edit_applies(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._props._sc_footstep.set_current("fs_grass")
            ed._apply_props()
            self.assertEqual(self._sc(model)["footstepSet"], "fs_grass")
            self.assertEqual(self._sc(model)["unknownSceneField"], {"keep": True})

    def test_scene_clearing_drops_key(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", scene_set="fs_stone")
            ed._props._sc_footstep.set_current("")
            ed._apply_props()
            self.assertNotIn("footstepSet", self._sc(model), "清空要删键，不能写空串")

    def test_scene_unknown_set_id_preserved(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", scene_set="fs_not_in_catalog_yet")
            self.assertEqual(ed._props._sc_footstep.current_id(), "fs_not_in_catalog_yet")
            ed._apply_props()
            self.assertEqual(self._sc(model)["footstepSet"], "fs_not_in_catalog_yet")

    def test_scene_and_zone_levels_are_independent(self) -> None:
        """zone 覆盖场景：两级各写各的，Apply 一次都得在。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", scene_set="fs_stone", zone_set="fs_grass")
            self._select_zone(ed)
            ed._apply_props()
            self.assertEqual(self._sc(model)["footstepSet"], "fs_stone")
            self.assertEqual(self._zone(model)["footstepSet"], "fs_grass")

    # ------------------------------------------------------------ 跨域候选

    def test_reload_refs_picks_up_new_sets(self) -> None:
        """在「脚步集」页新增一集后切回本页，两个选择器都要能选到它。"""
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            self._select_zone(ed)
            props = ed._props
            before_sc = props._sc_footstep.count()
            before_zn = props._zn_footstep.count()
            model.footstep_sets["sets"]["fs_mud"] = {
                "label": "泥地", "sfx": {"walk": "step_mud_1"}}
            props.reload_refs_from_model()
            self.assertEqual(props._sc_footstep.count(), before_sc + 1)
            self.assertEqual(props._zn_footstep.count(), before_zn + 1)
            props._zn_footstep.set_current("fs_mud")
            self.assertEqual(props._zn_footstep.current_id(), "fs_mud")

    def test_reload_refs_keeps_current_value(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p", scene_set="fs_stone", zone_set="fs_grass")
            self._select_zone(ed)
            props = ed._props
            model.footstep_sets["sets"]["fs_mud"] = {"sfx": {"walk": "step_mud_1"}}
            props.reload_refs_from_model()
            self.assertEqual(props._sc_footstep.current_id(), "fs_stone")
            self.assertEqual(props._zn_footstep.current_id(), "fs_grass")


if __name__ == "__main__":
    unittest.main()
