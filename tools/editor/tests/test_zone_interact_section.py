"""Zone「按 E 交互」区块（onInteract / interactLabel）编辑器护栏。

契约：
- 打开已有数据 → 区块自动展开、动作与文案回填（未展开也不许丢字段）；
- 面板编辑 → Apply 落 dict；动作为空时 onInteract / interactLabel 两键都不留；
- 文案是 onInteract 的附属：动作清空则文案一并清（不留永不显示的孤字段）；
- 切成 depth_floor 会清掉这两键（运行时 depth_floor 不跑区域逻辑），且确认框判据要认它；
- 未识别的 zone 字段照常透传（往返零丢失）。

注：ActionEditor 会把 param schema 里的可选参数补成空串（`showNotification.type`），
这是 onEnter/onStay/onExit 共有的既有行为，本区块与它们同口径——所以断言只认语义
（动作类型 + 真正填了的参数），不锁 params 的完整形状。
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

_ACTIONS = [{"type": "showNotification", "params": {"text": "草席下压着东西"}}]


def _scene() -> dict:
    return {
        "id": "sc_a",
        "name": "场景甲",
        "hotspots": [],
        "npcs": [],
        "zones": [{
            "id": "z1",
            "polygon": [{"x": 0, "y": 0}, {"x": 50, "y": 0}, {"x": 50, "y": 50}],
            # 深拷贝：ActionEditor 会就地补 schema 缺省参数，共用同一份会串味
            "onInteract": copy.deepcopy(_ACTIONS),
            "interactLabel": "[E] 掀开草席",
            "unknownZoneField": {"keep": True},
        }],
        "spawnPoints": {},
    }


class ZoneInteractSectionTests(unittest.TestCase):
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

    def _editor(self, root: Path) -> tuple[SceneEditor, ProjectModel]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.scenes = {"sc_a": _scene()}
        ed = SceneEditor(model)
        ed._refresh_scene_list()
        ed._load_scene("sc_a")
        self._editors.append(ed)
        ed._undo.clear()
        return ed, model

    @staticmethod
    def _zone(model: ProjectModel) -> dict:
        return model.scenes["sc_a"]["zones"][0]

    def _assert_notification(self, batch: object, text: str) -> None:
        self.assertIsInstance(batch, list)
        assert isinstance(batch, list)
        self.assertEqual(len(batch), 1)
        self.assertEqual(batch[0].get("type"), "showNotification")
        self.assertEqual(batch[0].get("params", {}).get("text"), text)

    def test_existing_data_loads_and_section_expands(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p")
            ed._on_item_selected("zone", "z1")
            QApplication.processEvents()
            self._assert_notification(ed._props._zn_interact.to_list(), "草席下压着东西")
            self.assertEqual(ed._props._zn_interact_label.text(), "[E] 掀开草席")
            self.assertTrue(ed._props._zn_interact_fold.is_expanded(),
                            "已有 onInteract 的区，按 E 交互区块应自动展开")

    def test_apply_without_touching_keeps_content(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("zone", "z1")
            QApplication.processEvents()
            ed._apply_props()
            z = self._zone(model)
            self._assert_notification(z.get("onInteract"), "草席下压着东西")
            self.assertEqual(z["interactLabel"], "[E] 掀开草席")
            self.assertEqual(z["unknownZoneField"], {"keep": True})

    def test_edit_label_applies(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("zone", "z1")
            QApplication.processEvents()
            ed._props._zn_interact_label.setText("[E] 翻一翻")
            ed._apply_props()
            self.assertEqual(self._zone(model)["interactLabel"], "[E] 翻一翻")

    def test_clearing_actions_drops_both_keys(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("zone", "z1")
            QApplication.processEvents()
            ed._props._zn_interact.set_data([])
            ed._apply_props()
            z = self._zone(model)
            self.assertNotIn("onInteract", z)
            self.assertNotIn("interactLabel", z,
                             "动作清空后文案是永不显示的孤字段，必须一并清掉")
            self.assertEqual(z["unknownZoneField"], {"keep": True})

    def test_depth_floor_switch_sees_interact_actions_and_clears_them(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(Path(td) / "p")
            ed._on_item_selected("zone", "z1")
            QApplication.processEvents()
            props = ed._props
            # 只配了 onInteract 的区，切类型确认框必须认它会丢（否则静默丢数据）
            props._zn_enter.set_data([])
            props._zn_stay.set_data([])
            props._zn_exit.set_data([])
            asked: list[tuple[str, str]] = []
            self.assertTrue(props._zn_interact.to_list())
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
                             "只配 onInteract 的区切 depth_floor 也必须弹确认")

            ed._apply_props()
            z = self._zone(model)
            self.assertEqual(z.get("zoneKind"), "depth_floor")
            self.assertNotIn("onInteract", z)
            self.assertNotIn("interactLabel", z)


if __name__ == "__main__":
    unittest.main()
