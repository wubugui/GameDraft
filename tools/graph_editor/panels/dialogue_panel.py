from PySide6.QtWidgets import QWidget, QVBoxLayout, QLabel, QTextEdit
from ..model.node_types import NodeData


class DialoguePanel(QWidget):
    """Read-only panel for dialogue graph asset nodes."""

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        self._header = QLabel()
        self._header.setWordWrap(True)
        self._header.setStyleSheet("font-size: 13px; padding: 4px;")
        layout.addWidget(self._header)

        self._text = QTextEdit()
        self._text.setReadOnly(True)
        self._text.setStyleSheet("font-family: Consolas, monospace; font-size: 12px;")
        layout.addWidget(self._text)

    def load_node(self, nd: NodeData):
        gid = nd.data.get("graphId", nd.label)
        src = nd.source_file or ""
        lines = [
            f"<h3>Dialogue graph: {gid}</h3>",
            f"<b>Source:</b> {src}<br>",
        ]
        self._header.setText("".join(lines))
        self._text.setPlainText(
            "请使用「图对话编辑器」编辑对白：\n"
            "  工程根目录运行 edit-dialogue-graph.cmd\n"
            "  或：python -m tools.dialogue_graph_editor --project <工程根>\n"
            "资源路径：public/assets/dialogues/graphs/<id>.json\n"
            "本 Graph Editor 窗口仅展示引用关系。",
        )
