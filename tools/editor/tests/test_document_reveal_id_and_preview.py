"""文档揭示编辑器的两处作者面：id 能直接手打（含改名/重名提示）、预览虚拟屏跟随游戏视口。

- id 是**这条揭示自己的名字**，不是对他者的引用，按选择器铁律属"定义自身新 id"的例外，
  必须能手打；此前是只读下拉，新建的条目只能顶着 `新揭示_N` 或去挑别人的 id。
- 预览按屏幕百分比摆图，虚拟屏比例若与 `game_config` 的逻辑视口不同，x/y 就是骗人的
  （4:3 的游戏配 16:9 的预览，纵向全错）。
"""
from __future__ import annotations

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.editor.editors.narrative_data_editors import DocumentRevealsEditor  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402


def _reveal(rid: str) -> dict:
    return {
        "id": rid,
        "blurredImagePath": "/assets/blur.png",
        "clearImagePath": "/assets/clear.png",
        "revealCondition": {"all": []},
        "animation": {"durationMs": 2000, "delayMs": 0},
    }


class DocumentRevealIdEditingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path, reveals: list[dict], game_config: dict | None = None):
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.document_reveals = reveals
        if game_config is not None:
            model.game_config = game_config
        return DocumentRevealsEditor(model), model

    def _type_id(self, ed, text: str) -> None:
        """走真实入口：改输入框文本并发 textEdited（与用户键入同一条路）。"""
        ed._dr_id_sel.setText(text)
        ed._dr_id_sel.textEdited.emit(text)

    def test_手打_id_落进条目与列表(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p", [_reveal("doc_old")])
            ed._dr_list.setCurrentRow(0)
            self._type_id(ed, "崖墓_告示")
            self.assertEqual(ed._reveals[0]["id"], "崖墓_告示")
            self.assertEqual(ed._dr_list.item(0).text(), "崖墓_告示")
            ed.deleteLater()

    def test_新建条目可以立刻改名(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p", [])
            ed._dr_add()
            self.assertEqual(ed._dr_list.count(), 1)
            self._type_id(ed, "我起的名字")
            self.assertEqual(ed._reveals[0]["id"], "我起的名字")
            ed.deleteLater()

    def test_重名提示(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p", [_reveal("a"), _reveal("b")])
            ed._dr_list.setCurrentRow(1)
            self.assertEqual(ed._dr_id_status.text(), "")
            self._type_id(ed, "a")
            self.assertIn("重名", ed._dr_id_status.text())
            self._type_id(ed, "b2")
            self.assertNotIn("重名", ed._dr_id_status.text())
            ed.deleteLater()

    def test_改名提示引用不跟随(self) -> None:
        """改名不拦（拦住就比运行时更严），但必须说出引用会悬垂。"""
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p", [_reveal("doc_old")])
            ed._dr_list.setCurrentRow(0)
            self._type_id(ed, "doc_new")
            self.assertIn("doc_old", ed._dr_id_status.text())
            self.assertIn("revealDocument", ed._dr_id_status.text())
            ed.deleteLater()

    def test_切行不把上一行的提示留在界面上(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(Path(td) / "p", [_reveal("a"), _reveal("b")])
            ed._dr_list.setCurrentRow(0)
            self._type_id(ed, "b")
            self.assertIn("重名", ed._dr_id_status.text())
            ed._dr_list.setCurrentRow(1)
            self.assertNotIn("改名", ed._dr_id_status.text())
            ed.deleteLater()


class BlendPreviewViewportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _editor(self, root: Path, viewport: dict | None):
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        model.document_reveals = [_reveal("doc")]
        model.game_config = dict(viewport) if viewport else {}
        return DocumentRevealsEditor(model), model

    def test_预览虚拟屏比例跟随视口(self) -> None:
        with TemporaryDirectory() as td:
            ed, _model = self._editor(
                Path(td) / "p", {"viewport": {"width": 1024, "height": 768}},
            )
            prev = ed._dr_blend_preview
            self.assertAlmostEqual(
                prev._screen_h / prev._screen_w, 768 / 1024, places=2,
                msg="预览比例没跟上 game_config.viewport —— x/y 百分比在这上面是骗人的",
            )
            ed.deleteLater()

    def test_改了视口下一次刷新就跟上(self) -> None:
        with TemporaryDirectory() as td:
            ed, model = self._editor(
                Path(td) / "p", {"viewport": {"width": 1024, "height": 768}},
            )
            prev = ed._dr_blend_preview
            model.game_config = {"viewport": {"width": 1920, "height": 1080}}
            ed.reload_refs_from_model()
            self.assertAlmostEqual(
                prev._screen_h / prev._screen_w, 1080 / 1920, places=2,
                msg="切回本页没重取视口比例",
            )
            ed.deleteLater()

    def test_没配视口回落窗口再回落默认(self) -> None:
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.game_config = {"windowSize": {"width": 800, "height": 600}}
            self.assertEqual(model.game_viewport_size(), (800.0, 600.0))
            model.game_config = {}
            self.assertEqual(model.game_viewport_size(), (1024.0, 768.0))
            model.game_config = {"viewport": {"width": 0, "height": 768}}
            self.assertEqual(model.game_viewport_size(), (1024.0, 768.0))


if __name__ == "__main__":
    unittest.main()
