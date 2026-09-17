"""游戏配置页「玩家身体动词 → 点火」(playerActs.ignite) 的写盘口径与往返保真。

口径（与 src/data/types.ts PlayerIgniteActConfig / Game.ts 消费一致）：
- enabled 只在盘上原本有键、或用户关掉时写；
- animation 空 = 不写键（运行时缺省 ignite）；
- walkSpeed 不勾「写」= 不写键（本场景走路速度），int 不漂 float；
- 三项缺省且盘上原本没 ignite ⇒ 不写 ignite；未知子键透传。
"""
from __future__ import annotations

import copy
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtCore import Qt
from PySide6.QtWidgets import QApplication

from tools.editor.editors.game_config_editor import GameConfigEditor
from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import write_minimal_loadable_project


_USER_ROLE = Qt.ItemDataRole.UserRole

_BASE_ACTS = {
    "crouch": {"enabled": True, "allowRun": False, "speedScale": 0.45, "enterMs": 250, "exitMs": 300},
    "gaze": {"enabled": True, "speedScale": 0, "holdMsToTrigger": 0, "enterMs": 200, "exitMs": 200},
    "lie": {"enabled": True, "freeAnywhere": False, "enterMs": 700, "exitMs": 900},
    "kick": {"enabled": True, "missActions": []},
    "jump": {"enabled": True, "durationMs": 480, "arcHeight": 46},
}


class GameConfigIgniteActTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        self.addCleanup(self._td.cleanup)

    def _editor(self, game_config: dict) -> tuple[GameConfigEditor, ProjectModel]:
        root = Path(self._td.name) / "p"
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.game_config = game_config
        ed = GameConfigEditor(model)
        self.addCleanup(ed.deleteLater)
        return ed, model

    @staticmethod
    def _base_cfg(acts: dict | None) -> dict:
        cfg: dict = {
            "initialScene": "sc_a", "initialQuest": "", "fallbackScene": "sc_a",
            "playerAvatar": {"stateMap": {"idle": "idle", "walk": "walk", "light": "strike_match"}},
        }
        if acts is not None:
            cfg["playerActs"] = acts
        return cfg

    def _pick_anim_placeholder(self, ed: GameConfigEditor) -> None:
        """模拟用户在下拉里点「缺省（不写键）」那一项。"""
        combo = ed._ignite_anim
        idx = next(i for i in range(combo.count()) if str(combo.itemData(i, _USER_ROLE) or "") == "")
        combo.setCurrentIndex(idx)
        combo.activated.emit(idx)
        QApplication.processEvents()   # activated 走 QTimer.singleShot(0) 延迟提交

    # ---- 盘上没有 ignite ------------------------------------------------------

    def test_no_playeracts_open_apply_writes_nothing(self) -> None:
        ed, model = self._editor(self._base_cfg(None))
        before = copy.deepcopy(model.game_config)
        self.assertFalse(ed._is_dirty())
        ed._apply()
        self.assertNotIn("playerActs", model.game_config)
        self.assertEqual(model.game_config, before)

    def test_no_ignite_open_apply_does_not_grow_key(self) -> None:
        ed, model = self._editor(self._base_cfg(copy.deepcopy(_BASE_ACTS)))
        before = copy.deepcopy(model.game_config)
        self.assertFalse(ed._is_dirty())
        ed._apply()
        self.assertNotIn("ignite", model.game_config["playerActs"])
        self.assertEqual(model.game_config, before)

    # ---- 盘上完整 ignite 往返 --------------------------------------------------

    def test_full_ignite_roundtrip_is_value_exact(self) -> None:
        ignite = {"enabled": False, "animation": "light", "walkSpeed": 120, "x": 1}
        acts = copy.deepcopy(_BASE_ACTS)
        acts["ignite"] = copy.deepcopy(ignite)
        ed, model = self._editor(self._base_cfg(acts))
        self.assertFalse(ed._is_dirty())
        ed._apply()
        got = model.game_config["playerActs"]["ignite"]
        self.assertEqual(got, ignite)
        self.assertEqual(list(got.keys()), list(ignite.keys()))
        self.assertIs(type(got["walkSpeed"]), int, "120 不得漂成 120.0")
        self.assertIs(got["enabled"], False)
        self.assertEqual(got["x"], 1)

    def test_dangling_animation_preserved_and_shown(self) -> None:
        acts = copy.deepcopy(_BASE_ACTS)
        acts["ignite"] = {"animation": "no_such_state"}
        ed, model = self._editor(self._base_cfg(acts))
        self.assertEqual(ed._ignite_anim.committed_type(), "no_such_state")
        ed._apply()
        self.assertEqual(model.game_config["playerActs"]["ignite"], {"animation": "no_such_state"})

    def test_explicit_true_enabled_kept(self) -> None:
        acts = copy.deepcopy(_BASE_ACTS)
        acts["ignite"] = {"enabled": True}
        ed, model = self._editor(self._base_cfg(acts))
        ed._apply()
        self.assertEqual(model.game_config["playerActs"]["ignite"], {"enabled": True})

    # ---- 控件入口改动 ----------------------------------------------------------

    def test_uncheck_enabled_writes_false_then_recheck_removes_key(self) -> None:
        ed, model = self._editor(self._base_cfg(copy.deepcopy(_BASE_ACTS)))
        self.assertTrue(ed._ignite_enabled.isChecked())
        ed._ignite_enabled.click()
        self.assertTrue(ed._is_dirty())
        ed._apply()
        self.assertEqual(model.game_config["playerActs"]["ignite"], {"enabled": False})

        ed._ignite_enabled.click()
        self.assertTrue(ed._is_dirty())
        ed._apply()
        self.assertNotIn("ignite", model.game_config["playerActs"],
                         "盘上原本没 enabled/ignite：勾回启用 = 删键")
        self.assertFalse(ed._is_dirty())

    def test_uncheck_enabled_without_playeracts_then_recheck(self) -> None:
        ed, model = self._editor(self._base_cfg(None))
        ed._ignite_enabled.click()
        ed._apply()
        self.assertEqual(model.game_config["playerActs"]["ignite"], {"enabled": False})
        ed._ignite_enabled.click()
        ed._apply()
        self.assertNotIn("ignite", model.game_config["playerActs"])

    def test_walkspeed_uncheck_write_removes_key(self) -> None:
        acts = copy.deepcopy(_BASE_ACTS)
        acts["ignite"] = {"walkSpeed": 120, "x": 1}
        ed, model = self._editor(self._base_cfg(acts))
        self.assertTrue(ed._ignite_ws_chk.isChecked())
        ed._ignite_ws_chk.click()
        ed._apply()
        self.assertEqual(model.game_config["playerActs"]["ignite"], {"x": 1})

    def test_walkspeed_edit_writes_int_when_integral(self) -> None:
        ed, model = self._editor(self._base_cfg(copy.deepcopy(_BASE_ACTS)))
        ed._ignite_ws_chk.click()
        ed._ignite_ws.setValue(150.0)
        ed._apply()
        got = model.game_config["playerActs"]["ignite"]["walkSpeed"]
        self.assertEqual(got, 150)
        self.assertIs(type(got), int)
        ed._ignite_ws.setValue(87.5)
        ed._apply()
        self.assertEqual(model.game_config["playerActs"]["ignite"]["walkSpeed"], 87.5)

    def test_animation_clear_removes_key(self) -> None:
        acts = copy.deepcopy(_BASE_ACTS)
        acts["ignite"] = {"enabled": False, "animation": "light"}
        ed, model = self._editor(self._base_cfg(acts))
        self.assertEqual(ed._ignite_anim.committed_type(), "light")
        self._pick_anim_placeholder(ed)
        self.assertEqual(ed._ignite_anim.committed_type(), "")
        ed._apply()
        self.assertEqual(model.game_config["playerActs"]["ignite"], {"enabled": False})

    def test_animation_candidates_include_default_and_state_map(self) -> None:
        ed, _model = self._editor(self._base_cfg(None))
        values = [str(ed._ignite_anim.itemData(i, _USER_ROLE) or "") for i in range(ed._ignite_anim.count())]
        for v in ("", "ignite", "idle", "walk", "light"):
            self.assertIn(v, values)


if __name__ == "__main__":
    unittest.main()
