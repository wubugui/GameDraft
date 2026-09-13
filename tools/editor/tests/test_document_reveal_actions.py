"""文档揭示的两条动作：revealDocument（含 force）与 hideDocument 的登记面与往返。

2026-09-12 制作人定调：作者只认揭示对象（documentId），叠图句柄（overlayId）作废。
于是「收图」是一条自己的动作 hideDocument，不再借 hideOverlayImage + 句柄那条路
——那条路踩过的坑是：句柄写错/写成展示串，运行时收不掉且**两边都不报错**。
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QCheckBox

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import ActionEditor  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402
from tools.editor.validator import validate  # noqa: E402


class _Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])

    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        root = Path(self._tmp.name) / "p"
        write_minimal_loadable_project(root)
        self.model = ProjectModel()
        self.model.load_project(root)
        self.model.document_reveals = [{
            "id": "告示_真相",
            "blurredImagePath": "/assets/blur.png",
            "clearImagePath": "/assets/clear.png",
            "revealCondition": {"all": []},
            "animation": {"durationMs": 2000, "delayMs": 0},
        }]
        self._trash: list[ActionEditor] = []

    def tearDown(self) -> None:
        for ed in self._trash:
            ed.deleteLater()
        self._tmp.cleanup()

    def _editor(self, action: dict) -> ActionEditor:
        ed = ActionEditor("测试")
        ed.set_project_context(self.model, None)
        ed.set_data([action])
        self._trash.append(ed)
        return ed

    def _force_checkbox(self, ed: ActionEditor) -> QCheckBox:
        row = ed._rows[0]
        w = row._param_widgets.get("force")
        assert isinstance(w, QCheckBox), f"force 控件不是勾选框：{type(w)}"
        return w


class RevealDocumentForceTests(_Base):
    def test_最小形态打开再保存不凭空多出_force_键(self) -> None:
        """加可选参数最经典的破口：打开→什么都不改→保存，数据里多一个 force:false。"""
        ed = self._editor({"type": "revealDocument", "params": {"documentId": "告示_真相"}})
        self.assertEqual(
            ed.to_list(),
            [{"type": "revealDocument", "params": {"documentId": "告示_真相"}}],
        )

    def test_勾上_force_才写键(self) -> None:
        ed = self._editor({"type": "revealDocument", "params": {"documentId": "告示_真相"}})
        self._force_checkbox(ed).setChecked(True)
        self.assertEqual(
            ed.to_list()[0]["params"],
            {"documentId": "告示_真相", "force": True},
        )

    def test_已有_force_打开时回勾且往返保值(self) -> None:
        action = {"type": "revealDocument", "params": {"documentId": "告示_真相", "force": True}}
        ed = self._editor(action)
        self.assertTrue(self._force_checkbox(ed).isChecked())
        self.assertEqual(ed.to_list(), [action])

    def test_取消勾选后键消失(self) -> None:
        ed = self._editor(
            {"type": "revealDocument", "params": {"documentId": "告示_真相", "force": True}})
        self._force_checkbox(ed).setChecked(False)
        self.assertNotIn("force", ed.to_list()[0]["params"])


class HideDocumentTests(_Base):
    def test_往返(self) -> None:
        action = {"type": "hideDocument", "params": {"documentId": "告示_真相"}}
        ed = self._editor(action)
        self.assertEqual(ed.to_list(), [action])

    def test_documentId_是选择器而不是裸输入框(self) -> None:
        """选择器铁律：引用字段的候选取自 ProjectModel，不许手打一个查不到的 id。"""
        from tools.editor.shared.action_editor import FilterableTypeCombo
        ed = self._editor({"type": "hideDocument", "params": {"documentId": "告示_真相"}})
        w = ed._rows[0]._param_widgets.get("documentId")
        self.assertIsInstance(w, FilterableTypeCombo)
        self.assertTrue(w._select_only, "documentId 必须是只能从清单里选的下拉")

    def test_登记在三个面上(self) -> None:
        from tools.editor.shared.action_editor import (
            ACTION_PERSISTENCE, ACTION_TYPES, CONTENT_ACTION_TYPES,
        )
        self.assertIn("hideDocument", ACTION_TYPES)
        self.assertIn("hideDocument", CONTENT_ACTION_TYPES)
        # 收图只动显示层，不碰「已揭示」状态，故不入存档
        self.assertEqual(ACTION_PERSISTENCE.get("hideDocument"), "memory")


class DocumentActionValidationTests(_Base):
    def _validate_with_hotspot_action(self, action: dict) -> list[str]:
        self.model.scenes["sc_a"]["hotspots"] = [{
            "id": "hs", "type": "inspect", "x": 0, "y": 0, "width": 10, "height": 10,
            "data": {"actions": [action]},
        }]
        return [i.message for i in validate(self.model) if i.severity == "error"]

    def test_未注册的_documentId_报错(self) -> None:
        errs = self._validate_with_hotspot_action(
            {"type": "hideDocument", "params": {"documentId": "不存在的"}})
        self.assertTrue(
            any("hideDocument" in e and "不存在的" in e for e in errs),
            f"悬垂 documentId 没被咬住：{errs}",
        )

    def test_已注册的_documentId_干净(self) -> None:
        errs = self._validate_with_hotspot_action(
            {"type": "hideDocument", "params": {"documentId": "告示_真相"}})
        self.assertFalse([e for e in errs if "hideDocument" in e], errs)


if __name__ == "__main__":
    unittest.main()
