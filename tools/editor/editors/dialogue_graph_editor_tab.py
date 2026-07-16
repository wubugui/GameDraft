"""主编辑器内嵌：图对话 JSON编辑器。"""
from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import QWidget, QVBoxLayout, QLabel, QMessageBox

from ..project_model import ProjectModel
from tools.dialogue_graph_editor.editor_widget import DialogueGraphEditorWidget
from tools.dialogue_graph_editor.graph_document import graphs_dir


class DialogueGraphEditorTab(QWidget):
    dirty_state_changed = Signal(bool)
    """内嵌图对话面板脏态变化（True=有未保存修改）。

    主窗口可接到脏芯片/页签标题上——图对话不走 ProjectModel 脏桶，
    过去主窗「✓ 已保存」芯片对本面板的未保存修改零可视（审查 P2）。
    """

    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model
        self._panel: DialogueGraphEditorWidget | None = None
        self._flush_error: str = ""
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        if model.project_path is None:
            layout.addWidget(QLabel("未加载工程"))
            return
        self._panel = DialogueGraphEditorWidget(
            model.project_path, self, project_model=model
        )
        self._panel.dirty_changed.connect(self.dirty_state_changed)
        layout.addWidget(self._panel)

    def is_dirty_now(self) -> bool:
        """当前是否有未保存的图对话修改（信号之外的即时查询口）。"""
        return bool(self._panel is not None and self._panel.has_unsaved_changes())

    def focus_node(self, node_id: str, graph_id: str = "") -> bool:
        """全局搜索落点：定位节点（选中+居中+检查器同步）。

        传 graph_id 时先核验面板当前打开的确实是这张图——open_graph_by_id 可能
        因未保存弹窗被取消/文件缺失而没换图,各图节点 id 高度雷同(root/n1/done_1…),
        不核验会在旧图上选中同名节点还谎报成功(对抗审查确认项)。"""
        if self._panel is None:
            return False
        gid = (graph_id or "").strip()
        if gid:
            cur = self._panel.current_path()
            if cur is None or cur.stem != gid:
                return False
        fn = getattr(self._panel, "focus_node_by_id", None)
        return bool(fn(node_id)) if callable(fn) else False

    def open_graph_by_id(self, graph_id: str) -> None:
        """按图资源 id（与 graphs/*.json 文件名一致，可带或不带 .json）打开。"""
        if self._panel is None or self._model.project_path is None:
            return
        gid = graph_id.strip()
        if gid.endswith(".json"):
            name = gid
        else:
            name = f"{gid}.json"
        path = graphs_dir(self._model.project_path) / name
        if not path.is_file():
            QMessageBox.information(self, "图对话", f"找不到图文件：{name}")
            return
        current_path = self._panel.current_path()
        if current_path is not None:
            try:
                if current_path.resolve() == path.resolve():
                    return
            except OSError:
                pass
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
        self._panel.load_path(path)

    def flush_to_model(self, *, for_save_all: bool = False) -> bool:
        self._flush_error = ""
        if self._panel is None or not self._panel.has_unsaved_changes():
            return True
        # Save All 不把「新建后从未编辑过」的全新草稿静默物化成 graphs/new_dialogue.json
        # （不问文件名、重名自动叠 _1/_2，积累垃圾——审查 P3）。跳过写盘、保留脏态，
        # 由用户在图对话页里显式保存/命名。
        if for_save_all and self._panel.is_untouched_new_draft():
            return True
        if self._panel.save():
            return True
        reason = self._panel.last_save_failure_reason() or "保存被取消"
        name = self._panel.graph_display_name()
        self._flush_error = (
            f"图对话「{name}」：{reason}，本次保存被跳过——"
            f"该图的修改仍保留在图对话编辑器中，可稍后修正再存。"
        )
        return False

    def pop_flush_error(self) -> str:
        """取出并清空最近一次 flush_to_model 失败的中文原因（无失败返回空串）。"""
        msg, self._flush_error = self._flush_error, ""
        return msg

    def confirm_close(self, parent: QWidget) -> bool:
        if self._panel is None:
            return True
        if not self._panel.confirm_discard_or_save_before_close(parent):
            return False
        if self._panel.has_unsaved_changes():
            # 走到这里 = 用户选了「放弃」（选保存则已写盘、不再有未保存修改）。
            # 必须立刻真正放弃（重载磁盘/清空草稿），否则关闭路径随后的统一
            # flush_to_model 会把被放弃的编辑直接写盘（复核 P1-01）。
            self._panel.discard_unsaved_changes()
        return True
