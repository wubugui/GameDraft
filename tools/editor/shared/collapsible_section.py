"""可折叠属性面板区块（与场景编辑器侧栏同款）。"""

from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QPushButton,
    QSizePolicy,
)
from PySide6.QtCore import Qt, Signal


class CollapsibleSection(QWidget):
    """点击标题行展开或折叠内容，不使用标题旁方框勾选。"""

    #: 展开状态变化（含首次展开）。供**重块懒建**用：默认折叠的区块把真正的控件树
    #: 推迟到第一次展开时才造。全套编辑器测试的耗时对存活控件数是 O(N²)
    #: （`app.setStyleSheet()` 全应用重刷，见 tests/qt_teardown.py 的实测记录），
    #: 一个面板多挂十几棵 ActionEditor 子树就会把测试从分钟级推到超时。
    expanded_changed = Signal(bool)

    def __init__(
        self,
        title: str,
        *,
        start_open: bool = True,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._plain_title = title
        self._expanded = start_open
        # Vertical Maximum 会在 QScrollArea+可伸缩子部件中被迫压缩高度，导致底部表单项被裁切；
        # Preferred 保留「按内容高度」布局，仍可由外层 addStretch 吸收多余空白。
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Preferred,
        )
        self._header = QPushButton()
        self._header.setFlat(True)
        self._header.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._header.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Fixed,
        )
        self._header.setCursor(Qt.CursorShape.PointingHandCursor)
        self._header.clicked.connect(self._toggle)
        self._header.setStyleSheet(
            "QPushButton { text-align: left; padding: 4px 2px; border: none; "
            "background: transparent; }\n"
            "QPushButton:hover { background-color: rgba(0, 0, 0, 24); }\n"
            "QPushButton:pressed { background-color: rgba(0, 0, 0, 40); }",
        )
        self._content = QWidget()
        self._content.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Preferred,
        )
        self._body_layout = QVBoxLayout(self._content)
        self._body_layout.setContentsMargins(8, 2, 0, 8)
        self._body_layout.setSpacing(6)
        self._body_layout.setAlignment(Qt.AlignmentFlag.AlignTop)
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 2, 0, 2)
        root.setSpacing(0)
        root.setAlignment(Qt.AlignmentFlag.AlignTop)
        root.addWidget(self._header, 0, Qt.AlignmentFlag.AlignTop)
        root.addWidget(self._content, 0, Qt.AlignmentFlag.AlignTop)
        self._content.setVisible(self._expanded)
        self._sync_header_text()

    def _sync_header_text(self) -> None:
        mark = "\u25bc" if self._expanded else "\u25b6"
        self._header.setText(f"{mark}  {self._plain_title}")

    def _toggle(self) -> None:
        self.set_expanded(not self._expanded)

    def add_body(self, widget: QWidget) -> None:
        self._body_layout.addWidget(widget)

    def set_expanded(self, on: bool) -> None:
        if self._expanded == on:
            return
        self._expanded = on
        self._content.setVisible(on)
        self._sync_header_text()
        self.expanded_changed.emit(on)

    def is_expanded(self) -> bool:
        return self._expanded

    def set_header_tool_tip(self, text: str) -> None:
        self._header.setToolTip(text)

    def set_title(self, title: str) -> None:
        """改标题（内容跟着数据走的块用：折起来时标题就是这条的辨识依据）。"""
        if self._plain_title == title:
            return
        self._plain_title = title
        self._sync_header_text()
