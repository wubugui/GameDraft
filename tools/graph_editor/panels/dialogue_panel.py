from PySide6.QtWidgets import QWidget, QVBoxLayout, QLabel, QTextEdit
from ..model.node_types import NodeData


class DialoguePanel(QWidget):
    """Read-only panel showing dialogue knot details."""

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
        d = nd.data
        lines = [f"<h3>Dialogue: {d.get('knot_name', nd.label)}</h3>"]
        lines.append(f"<b>File:</b> {d.get('file', '')}.ink<br>")
        lines.append(f"<b>Start Line:</b> {d.get('start_line', '?')}<br>")

        tags = d.get("action_tags", [])
        if tags:
            lines.append(f"<br><b>Action Tags:</b><br>")
            for t in tags:
                lines.append(f"  &bull; {t}<br>")

        flags = d.get("getflags", [])
        if flags:
            lines.append(f"<br><b>Reads Flags:</b><br>")
            for f in flags:
                lines.append(f"  &bull; {f}<br>")

        self._header.setText("".join(lines))
        self._text.setPlainText(d.get("text", ""))
