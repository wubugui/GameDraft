"""主编辑器内嵌：图对话 JSON编辑器。"""
from __future__ import annotations

from PySide6.QtWidgets import QWidget, QVBoxLayout, QLabel, QMessageBox

from ..project_model import ProjectModel
from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
from tools.dialogue_graph_editor.graph_document import graphs_dir


class DialogueGraphEditorTab(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._panel: DialogueGraphEditorWidget | None = None
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        if model.project_path is None:
            layout.addWidget(QLabel("未加载工程"))
            return
        self._panel = DialogueGraphEditorWidget(model.project_path, self)
        layout.addWidget(self._panel)

    def open_graph_by_id(self, graph_id: str) -> None:
        """按图资源 id（与 graphs/*.json 文件名一致，可带或不带 .json）打开。"""
        if self._panel is None or self._model.project_path is None:
            return
        if self._panel.has_unsaved_changes():
            r = QMessageBox.question(
                self,
                "图对话未保存",
                "当前图有未保存修改，是否保存后再跳转？",
                QMessageBox.StandardButton.Save
                | QMessageBox.StandardButton.Discard
                | QMessageBox.StandardButton.Cancel,
            )
            if r == QMessageBox.StandardButton.Save:
                if not self._panel.save():
                    return
            elif r == QMessageBox.StandardButton.Cancel:
                return
        gid = graph_id.strip()
        if gid.endswith(".json"):
            name = gid
        else:
            name = f"{gid}.json"
        path = graphs_dir(self._model.project_path) / name
        if path.is_file():
            self._panel.load_path(path)
        else:
            QMessageBox.information(self, "图对话", f"找不到图文件：{name}")

    def flush_to_model(self) -> None:
        if self._panel is not None and self._panel.has_unsaved_changes():
            self._panel.save()

    def confirm_close(self, parent: QWidget) -> bool:
        if self._panel is None:
            return True
        return self._panel.confirm_discard_or_save_before_close(parent)
