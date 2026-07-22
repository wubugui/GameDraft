from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from PIL import Image, ImageQt
from PySide6.QtCore import QObject, QTimer, Qt, Signal
from PySide6.QtGui import QKeySequence, QPixmap, QShortcut
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QScrollArea,
    QSizePolicy,
    QSlider,
    QVBoxLayout,
    QWidget,
)

HORIZONTAL = "horizontal"
VERTICAL = "vertical"
LEFT = "left"
BOTH = "both"
END = "end"


class TclError(Exception):
    pass


def _app() -> QApplication:
    inst = QApplication.instance()
    if inst is None:
        inst = QApplication([])
    if isinstance(inst, QApplication) and not getattr(
        inst, "_gamedraft_combo_wheel_blocker_installed", False,
    ):
        try:
            from tools.editor.shared.qt_combo_wheel_guard import (
                install_global_combo_wheel_block,
            )
            install_global_combo_wheel_block(inst)
        except Exception:
            pass  # 独立分发场景下缺 tools.editor 也不影响本工具运行
    return inst


class _MainThreadInvoker(QObject):
    """把 after() 的调度搬到主线程。

    tkinter 里从工作线程调 root.after(0, cb) 能回主线程；而 QTimer.singleShot
    的定时器归属调用线程，工作线程没有 Qt 事件循环 → 回调永不触发（深度估计假死）。
    用一个住在主线程的 QObject 信号：从任意线程 emit，跨线程走 QueuedConnection
    到主线程再 singleShot，保证回调一定在主线程触发。
    """

    _scheduled = Signal(int, object)

    def __init__(self) -> None:
        super().__init__()
        self._scheduled.connect(self._run)

    def _run(self, ms: int, callback: Callable[[], None]) -> None:
        QTimer.singleShot(max(0, int(ms)), callback)

    def schedule(self, ms: int, callback: Callable[[], None]) -> None:
        self._scheduled.emit(int(ms), callback)


def _sticky_to_alignment(sticky: str | None) -> Qt.AlignmentFlag:
    if not sticky:
        return Qt.AlignmentFlag(0)
    align = Qt.AlignmentFlag(0)
    if "w" in sticky:
        align |= Qt.AlignLeft
    if "e" in sticky:
        align |= Qt.AlignRight
    if "n" in sticky:
        align |= Qt.AlignTop
    if "s" in sticky:
        align |= Qt.AlignBottom
    return align


def _pad_tuple(pad: Any) -> tuple[int, int, int, int]:
    if pad is None:
        return (0, 0, 0, 0)
    if isinstance(pad, (int, float)):
        v = int(pad)
        return (v, v, v, v)
    if isinstance(pad, tuple):
        vals = list(pad)
        if len(vals) == 2:
            return (int(vals[0]), int(vals[1]), int(vals[0]), int(vals[1]))
        if len(vals) == 4:
            return tuple(int(v) for v in vals)  # type: ignore[return-value]
    return (0, 0, 0, 0)


class Variable:
    def __init__(self, value: Any = None) -> None:
        self._value = value
        self._callbacks: list[Callable[..., None]] = []
        self._widgets: list[Callable[[Any], None]] = []

    def get(self) -> Any:
        return self._value

    def set(self, value: Any) -> None:
        self._value = value
        for sync in list(self._widgets):
            sync(value)
        for cb in list(self._callbacks):
            cb()

    def trace_add(self, _mode: str, callback: Callable[..., None]) -> None:
        self._callbacks.append(callback)

    def bind_widget(self, sync: Callable[[Any], None]) -> None:
        self._widgets.append(sync)
        sync(self._value)


class StringVar(Variable):
    def get(self) -> str:
        v = super().get()
        return "" if v is None else str(v)


class DoubleVar(Variable):
    def get(self) -> float:
        return float(super().get())


class IntVar(Variable):
    def get(self) -> int:
        return int(super().get())


class BooleanVar(Variable):
    def get(self) -> bool:
        return bool(super().get())


class _WidgetMixin:
    _pack_counter = 0

    def _init_layout(self) -> None:
        layout = QGridLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(4)
        self._layout = layout

    def columnconfigure(self, column: int, weight: int = 0) -> None:
        if hasattr(self, "_layout"):
            self._layout.setColumnStretch(column, weight)

    def rowconfigure(self, row: int, weight: int = 0) -> None:
        if hasattr(self, "_layout"):
            self._layout.setRowStretch(row, weight)

    def grid(self, row: int = 0, column: int = 0, sticky: str | None = None,
             padx: Any = None, pady: Any = None, columnspan: int = 1, **_: Any) -> None:
        parent = self.parent()
        if parent is None or not hasattr(parent, "_layout"):
            return
        l, t, r, b = _pad_tuple(padx)
        pl, pt, pr, pb = _pad_tuple(pady)
        self.setContentsMargins(l + pl, t + pt, r + pr, b + pb)

        # tkinter sticky -> Qt：对向边(e&w / n&s)= 填充该轴(对齐位=0 才会拉伸)，
        # 单边 = 该侧对齐(保持自然尺寸)。错把 "ew" 当对齐会让控件不再填满格子。
        s = sticky or ""
        fill_h = ("e" in s) and ("w" in s)
        fill_v = ("n" in s) and ("s" in s)
        cur = self.sizePolicy()
        self.setSizePolicy(
            QSizePolicy.Expanding if fill_h else cur.horizontalPolicy(),
            QSizePolicy.Expanding if fill_v else cur.verticalPolicy(),
        )
        align = Qt.AlignmentFlag(0)
        if not fill_h:
            if "w" in s:
                align |= Qt.AlignLeft
            elif "e" in s:
                align |= Qt.AlignRight
        if not fill_v:
            if "n" in s:
                align |= Qt.AlignTop
            elif "s" in s:
                align |= Qt.AlignBottom
        parent._layout.addWidget(self, row, column, 1, columnspan, align)

    def pack(self, side: str | None = None, fill: str | None = None,
             expand: bool = False, padx: Any = None, pady: Any = None, **_: Any) -> None:
        parent = self.parent()
        if parent is None or not hasattr(parent, "_layout"):
            return
        row = 0
        col = getattr(parent, "_pack_counter", 0)
        parent._pack_counter = col + 1
        if side == "left":
            parent._layout.addWidget(self, row, col)
        else:
            parent._layout.addWidget(self, col, 0)
        if fill in ("both", "x") or expand:
            self.setSizePolicy(QSizePolicy.Expanding, self.sizePolicy().verticalPolicy())
        if fill in ("both", "y") or expand:
            self.setSizePolicy(self.sizePolicy().horizontalPolicy(), QSizePolicy.Expanding)

    def configure(self, **kwargs: Any) -> None:
        self.config(**kwargs)

    def config(self, **kwargs: Any) -> None:
        if "text" in kwargs and hasattr(self, "setText"):
            self.setText(str(kwargs["text"]))
        if "foreground" in kwargs:
            self.setStyleSheet(f"color: {kwargs['foreground']};")
        if "wraplength" in kwargs and hasattr(self, "setWordWrap"):
            self.setWordWrap(True)
            self.setMaximumWidth(int(kwargs["wraplength"]))
        if "image" in kwargs and hasattr(self, "setPixmap"):
            img = kwargs["image"]
            if not img:
                self.clear()
            elif isinstance(img, PhotoImage):
                self.setPixmap(img.pixmap)

    def bind(self, sequence: str, callback: Callable[..., None]) -> None:
        if sequence == "<Return>":
            if isinstance(self, QLineEdit):
                self.returnPressed.connect(lambda: callback(None))
            return
        if sequence == "<KeyPress>":
            self._key_callback = callback
            self.setFocusPolicy(Qt.StrongFocus)
            return

    def winfo_children(self) -> list[QWidget]:
        return [c for c in self.children() if isinstance(c, QWidget)]

    def winfo_exists(self) -> bool:
        return not self.isHidden() or self.parent() is not None

    def focus_force(self) -> None:
        self.activateWindow()
        self.setFocus()

    def destroy(self) -> None:
        self.close()
        self.deleteLater()

    def keyPressEvent(self, event):  # noqa: N802
        cb = getattr(self, "_key_callback", None)
        if cb is not None:
            cb(_KeyEvent(event))
            return
        super().keyPressEvent(event)


class Tk(QMainWindow, _WidgetMixin):
    def __init__(self) -> None:
        _app()
        super().__init__()
        central = Frame()
        self.setCentralWidget(central)
        self._layout = central._layout
        self._central = central
        self._invoker = _MainThreadInvoker()  # 主线程，after() 跨线程回调用

    def title(self, text: str) -> None:
        self.setWindowTitle(text)

    def geometry(self, value: str) -> str | None:
        if "x" in value:
            wh = value.split("+", 1)[0]
            w, h = wh.split("x", 1)
            self.resize(int(w), int(h))
            return None
        return f"{self.width()}x{self.height()}"

    def minsize(self, w: int, h: int) -> None:
        self.setMinimumSize(w, h)

    def after(self, ms: int, callback: Callable[[], None]) -> None:
        # 线程安全：无论从主线程还是深度估计工作线程调用，都在主线程触发
        self._invoker.schedule(ms, callback)

    def bind(self, sequence: str, callback: Callable[..., None]) -> None:
        if sequence == "<KeyPress>":
            self._key_callback = callback
            self.setFocusPolicy(Qt.StrongFocus)

    def keyPressEvent(self, event):  # noqa: N802
        cb = getattr(self, "_key_callback", None)
        if cb is not None:
            cb(_KeyEvent(event))
            return
        super().keyPressEvent(event)

    def mainloop(self) -> None:
        self.show()
        _app().exec()


class Toplevel(QMainWindow, _WidgetMixin):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        central = Frame()
        self.setCentralWidget(central)
        self._layout = central._layout
        self._central = central

    def title(self, text: str) -> None:
        self.setWindowTitle(text)

    def geometry(self, value: str | None = None) -> str | None:
        if value is None:
            return f"{self.width()}x{self.height()}"
        wh = value.split("+", 1)[0]
        w, h = wh.split("x", 1)
        self.resize(int(w), int(h))
        self.show()
        return None

    def protocol(self, _name: str, callback: Callable[[], None]) -> None:
        self._close_callback = callback

    def bind(self, sequence: str, callback: Callable[..., None]) -> None:
        if sequence == "<KeyPress>":
            self._key_callback = callback
            self.setFocusPolicy(Qt.StrongFocus)

    def keyPressEvent(self, event):  # noqa: N802
        cb = getattr(self, "_key_callback", None)
        if cb is not None:
            cb(_KeyEvent(event))
            return
        super().keyPressEvent(event)

    def destroy(self) -> None:
        self._close_callback = None
        self.close()
        self.deleteLater()

    def closeEvent(self, event):  # noqa: N802
        cb = getattr(self, "_close_callback", None)
        if cb is not None:
            self._close_callback = None
            cb()
            event.accept()
            return
        super().closeEvent(event)


class Frame(QWidget, _WidgetMixin):
    def __init__(self, parent: QWidget | None = None, padding: Any = None, **_: Any) -> None:
        super().__init__(parent)
        self._init_layout()
        self._layout.setContentsMargins(*_pad_tuple(padding))


class LabelFrame(QGroupBox, _WidgetMixin):
    def __init__(self, parent: QWidget | None = None, text: str = "", padding: Any = None, **_: Any) -> None:
        super().__init__(text, parent)
        self._init_layout()
        pad = _pad_tuple(padding)
        # 顶部留出标题空间，避免控件压到标题上
        self._layout.setContentsMargins(pad[0], max(pad[1], 4), pad[2], pad[3])
        # 清晰的分组边框，避免各区块糊在一起看不清
        self.setStyleSheet(
            "QGroupBox{border:1px solid rgba(128,128,128,0.45);border-radius:5px;"
            "margin-top:10px;}"
            "QGroupBox::title{subcontrol-origin:margin;subcontrol-position:top left;"
            "left:8px;padding:0 4px;}")


class Label(QLabel, _WidgetMixin):
    def __init__(self, parent: QWidget | None = None, text: str = "",
                 textvariable: Variable | None = None, **kwargs: Any) -> None:
        super().__init__(text, parent)
        self.setWordWrap(True)
        if textvariable is not None:
            textvariable.bind_widget(lambda v: self.setText(str(v)))
        self.config(**kwargs)


class Button(QPushButton, _WidgetMixin):
    def __init__(self, parent: QWidget | None = None, text: str = "",
                 command: Callable[..., None] | None = None, **_: Any) -> None:
        super().__init__(text, parent)
        if command is not None:
            self.clicked.connect(command)


class Checkbutton(QCheckBox, _WidgetMixin):
    def __init__(self, parent: QWidget | None = None, text: str = "",
                 variable: Variable | None = None,
                 command: Callable[..., None] | None = None, **_: Any) -> None:
        super().__init__(text, parent)
        self._variable = variable
        if variable is not None:
            variable.bind_widget(lambda v: self.setChecked(bool(v)))
            self.toggled.connect(lambda v: variable.set(bool(v)))
        if command is not None:
            self.toggled.connect(lambda _v: command())


class Radiobutton(QRadioButton, _WidgetMixin):
    def __init__(self, parent: QWidget | None = None, text: str = "",
                 variable: Variable | None = None, value: Any = None,
                 command: Callable[..., None] | None = None, **_: Any) -> None:
        super().__init__(text, parent)
        # 碰撞工具与深度工具分属不同 parent，但共用同一 StringVar。
        # Qt 默认按 parent 互斥，会把跨分组的选中状态打乱；改由 Variable 统一同步。
        self.setAutoExclusive(False)
        self._variable = variable
        self._value = value
        if variable is not None:
            variable.bind_widget(lambda v: self.setChecked(v == value))
            self.clicked.connect(lambda: variable.set(value))
        if command is not None:
            self.clicked.connect(command)


class Entry(QLineEdit, _WidgetMixin):
    def __init__(self, parent: QWidget | None = None, width: int | None = None,
                 **_: Any) -> None:
        super().__init__(parent)
        if width:
            self.setMaximumWidth(max(40, int(width) * 10))

    def insert(self, index: int, text: str) -> None:
        if index == 0:
            self.setText(text + self.text())
        else:
            self.setText(self.text() + text)

    def delete(self, _start: int, _end: Any = None) -> None:
        self.clear()

    def get(self) -> str:
        return self.text()


class Combobox(QComboBox, _WidgetMixin):
    def __init__(self, parent: QWidget | None = None, values: list[str] | tuple[str, ...] = (),
                 textvariable: Variable | None = None, **_: Any) -> None:
        super().__init__(parent)
        self.addItems([str(v) for v in values])
        self._variable = textvariable
        if textvariable is not None:
            textvariable.bind_widget(self._sync_from_variable)
            self.currentTextChanged.connect(self._on_text_changed)

    def _sync_from_variable(self, value: Any) -> None:
        text = "" if value is None else str(value)
        if text == self.currentText():
            return
        idx = self.findText(text)
        self.blockSignals(True)
        self.setCurrentIndex(idx)  # 找不到时 -1 = 清空选择
        self.blockSignals(False)

    def _on_text_changed(self, text: str) -> None:
        if self._variable is not None and self._variable.get() != text:
            self._variable.set(text)

    def current(self, index: int) -> None:
        self.setCurrentIndex(index)

    def get(self) -> str:
        return self.currentText()

    def configure(self, **kwargs: Any) -> None:
        # tkinter 用 configure(values=...) 动态刷新候选；不实现会把
        # 场景选择器整个变成空下拉框(项目绑定流程不可用)。
        if "values" in kwargs:
            values = [str(v) for v in kwargs.pop("values")]
            cur = self.currentText()
            self.blockSignals(True)
            self.clear()
            self.addItems(values)
            self.setCurrentIndex(self.findText(cur))
            self.blockSignals(False)
            if self._variable is not None and self.currentText() != (self._variable.get() or ""):
                self._variable.set(self.currentText())
        if kwargs:
            self.config(**kwargs)

    def __getitem__(self, key: str) -> tuple[str, ...]:
        if key == "values":
            return tuple(self.itemText(i) for i in range(self.count()))
        raise KeyError(key)


class Scale(QWidget, _WidgetMixin):
    """QSlider + 数值标签（tk.Scale showvalue 的等价），并按 resolution 取整。"""

    def __init__(self, parent: QWidget | None = None, from_: float = 0.0, to: float = 1.0,
                 orient: str = HORIZONTAL, resolution: float = 1.0,
                 variable: Variable | None = None, command: Callable[[Any], None] | None = None,
                 showvalue: bool = True, **_: Any) -> None:
        super().__init__(parent)
        self._from = float(from_)
        self._to = float(to)
        self._resolution = float(resolution) if resolution else 1.0
        self._decimals = self._calc_decimals(self._resolution)
        self._variable = variable
        self._command = command

        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(6)
        self._slider = QSlider(Qt.Horizontal if orient == HORIZONTAL else Qt.Vertical, self)
        self._slider.setMinimumWidth(56)  # 让滑块能收窄，给数值标签留位、行不溢出
        lay.addWidget(self._slider, 1)
        self._value_label: QLabel | None = None
        if showvalue:
            self._value_label = QLabel(self)
            self._value_label.setMinimumWidth(46)
            self._value_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
            lay.addWidget(self._value_label, 0)

        self._sync_range()
        if variable is not None:
            variable.bind_widget(self._set_from_variable)
        self._slider.valueChanged.connect(self._on_changed)
        self._refresh_label()

    @staticmethod
    def _calc_decimals(res: float) -> int:
        if res >= 1:
            return 0
        text = repr(res)
        if "." in text:
            return max(1, len(text.split(".", 1)[1].rstrip("0")))
        return 1

    def _sync_range(self) -> None:
        steps = max(1, int(round((self._to - self._from) / self._resolution)))
        self._slider.setRange(0, steps)

    def _raw_to_value(self, raw: int) -> float:
        # 按 resolution 网格取整，避免 from + raw*res 的浮点尾巴(导出一致性)
        return round(self._from + raw * self._resolution, self._decimals)

    def _refresh_label(self) -> None:
        if self._value_label is None:
            return
        v = self._raw_to_value(self._slider.value())
        if isinstance(self._variable, IntVar):
            self._value_label.setText(str(int(round(v))))
        else:
            self._value_label.setText(f"{v:.{self._decimals}f}")

    def _set_from_variable(self, value: Any) -> None:
        iv = int(round((float(value) - self._from) / self._resolution))
        self._slider.blockSignals(True)
        self._slider.setValue(max(self._slider.minimum(), min(self._slider.maximum(), iv)))
        self._slider.blockSignals(False)
        self._refresh_label()

    def _on_changed(self, raw: int) -> None:
        value = self._raw_to_value(raw)
        if self._variable is not None:
            if isinstance(self._variable, IntVar):
                self._variable.set(int(round(value)))
            else:
                self._variable.set(float(value))
        self._refresh_label()
        if self._command is not None:
            self._command(value)

    def configure(self, **kwargs: Any) -> None:
        if "from_" in kwargs:
            self._from = float(kwargs["from_"])
        if "to" in kwargs:
            self._to = float(kwargs["to"])
        self._sync_range()
        if self._variable is not None:
            self._set_from_variable(self._variable.get())

    def cget(self, key: str) -> float:
        if key == "from":
            return self._from
        if key == "to":
            return self._to
        raise KeyError(key)


class Separator(QFrame, _WidgetMixin):
    def __init__(self, parent: QWidget | None = None, orient: str = HORIZONTAL, **_: Any) -> None:
        super().__init__(parent)
        self.setFrameShape(QFrame.HLine if orient == HORIZONTAL else QFrame.VLine)
        self.setFrameShadow(QFrame.Sunken)


class PhotoImage:
    def __init__(self, image: Image.Image) -> None:
        self.pixmap = QPixmap.fromImage(ImageQt.ImageQt(image.convert("RGBA")))


class _FileDialog:
    @staticmethod
    def askdirectory(title: str = "", initialdir: str | None = None, **_: Any) -> str:
        return QFileDialog.getExistingDirectory(None, title, initialdir or str(Path.cwd()))

    @staticmethod
    def askopenfilename(title: str = "", filetypes: Any = None, **_: Any) -> str:
        filters = "All files (*)"
        if filetypes:
            parts = []
            for label, glob in filetypes:
                parts.append(f"{label} ({glob})")
            filters = ";;".join(parts)
        path, _selected = QFileDialog.getOpenFileName(None, title, str(Path.cwd()), filters)
        return path


class _MessageBox:
    @staticmethod
    def showinfo(title: str, message: str) -> None:
        QMessageBox.information(None, title, message)

    @staticmethod
    def showerror(title: str, message: str) -> None:
        QMessageBox.critical(None, title, message)

    @staticmethod
    def askyesno(title: str, message: str) -> bool:
        return QMessageBox.question(None, title, message) == QMessageBox.Yes


class _SimpleDialog:
    @staticmethod
    def askstring(title: str, prompt: str, parent: QWidget | None = None) -> str | None:
        text, ok = QInputDialog.getText(parent, title, prompt)
        return text if ok else None


class _KeyEvent:
    def __init__(self, event) -> None:
        self.keysym = QKeySequence(event.key()).toString().lower() or event.text().lower()
        # macOS 上 Qt 把物理 Ctrl 映射为 MetaModifier(ControlModifier=Cmd)，两个都算
        mods = event.modifiers()
        self.state = 0x4 if mods & (Qt.ControlModifier | Qt.MetaModifier) else 0


class _Ttk:
    Frame = Frame
    LabelFrame = LabelFrame
    Button = Button
    Label = Label
    Checkbutton = Checkbutton
    Radiobutton = Radiobutton
    Combobox = Combobox
    Entry = Entry
    Separator = Separator
    Scrollbar = Frame


ttk = _Ttk()
filedialog = _FileDialog()
messagebox = _MessageBox()
simpledialog = _SimpleDialog()
