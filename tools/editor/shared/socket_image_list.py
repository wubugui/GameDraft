"""多帧挂件的贴图列表控件（顺序即帧号）。

两个消费方：`action_editor` 的 `attachToSocket.images` 参数、
「挂件预设」页的 images 字段——同一份数据形状，不该有两套控件。
"""
from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QHBoxLayout,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from .image_path_picker import CutsceneImagePathRow


class SocketImageListField(QWidget):
    """一行一张图，可增删改、可上下移（顺序即帧号）。

    顺序会写进 JSON（`images[frame]`），所以按 list_affordances 的规矩必须给上移/下移。
    路径一律走 `CutsceneImagePathRow`（选择器铁律：资源路径禁裸 QLineEdit）。
    """

    changed = Signal()

    def __init__(self, model, initial, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._rows: list[CutsceneImagePathRow] = []
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        self._rows_layout = QVBoxLayout()
        self._rows_layout.setSpacing(2)
        lay.addLayout(self._rows_layout)
        add = QPushButton("+ 帧贴图")
        add.clicked.connect(lambda: self._add(""))
        lay.addWidget(add)
        for item in (initial if isinstance(initial, list) else []):
            if isinstance(item, str) and item.strip():
                self._add(item.strip(), quiet=True)

    def _add(self, path: str, *, quiet: bool = False) -> None:
        row_w = QWidget(self)
        rl = QHBoxLayout(row_w)
        rl.setContentsMargins(0, 0, 0, 0)
        picker = CutsceneImagePathRow(self._model, path, self, external_copy_subdir="illustrations")
        picker.changed.connect(self.changed)
        rl.addWidget(picker, 1)
        up = QPushButton("↑")
        up.setMaximumWidth(28)
        up.clicked.connect(lambda: self._move(picker, -1))
        rl.addWidget(up)
        dn = QPushButton("↓")
        dn.setMaximumWidth(28)
        dn.clicked.connect(lambda: self._move(picker, 1))
        rl.addWidget(dn)
        rm = QPushButton("−")
        rm.setMaximumWidth(28)
        rm.clicked.connect(lambda: self._remove(picker, row_w))
        rl.addWidget(rm)
        self._rows.append(picker)
        self._rows_layout.addWidget(row_w)
        if not quiet:
            self.changed.emit()

    def _move(self, picker: CutsceneImagePathRow, delta: int) -> None:
        if picker not in self._rows:
            return
        i = self._rows.index(picker)
        j = i + delta
        if j < 0 or j >= len(self._rows):
            return
        # 只换值不换控件：控件顺序与 self._rows 一致，换值最省事也不动布局
        a, b = self._rows[i].path(), self._rows[j].path()
        self._rows[i].set_path(b)
        self._rows[j].set_path(a)
        self.changed.emit()

    def _remove(self, picker: CutsceneImagePathRow, row_w: QWidget) -> None:
        if picker in self._rows:
            self._rows.remove(picker)
        row_w.setParent(None)
        row_w.deleteLater()
        self.changed.emit()

    def set_paths(self, paths) -> None:
        """整表重填（主从列表切换选中项时用）。"""
        for picker in list(self._rows):
            parent = picker.parentWidget()
            self._remove(picker, parent if parent is not None else picker)
        self._rows.clear()
        for item in (paths if isinstance(paths, list) else []):
            if isinstance(item, str) and item.strip():
                self._add(item.strip(), quiet=True)

    def to_list(self) -> list[str]:
        return [p.path().strip() for p in self._rows if p.path().strip()]
