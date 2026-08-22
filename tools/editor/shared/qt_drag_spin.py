"""数值框**左右拖动直接改值**(Unity 那种)。

## 为什么做成全局过滤器,不是一个新控件类

编辑器里的数字框有 **300 多个**,散在 30 来个编辑器文件里,构造方式五花八门
(`QDoubleSpinBox()` 裸建、局部 `spin()` 工厂、`.ui` 里摆的都有)。挨个换成自定义
控件类要动 30 个文件,而且**下次谁新写一个又会漏**——漏掉的那个和别的长得一模一样,
拖不动的时候只会以为"这个功能坏了"。

装成全局过滤器则是:一处代码,现有的和以后新建的一起生效,零改动到业务文件。

## 为什么装在控件上,不装在 QApplication 上

与 `qt_combo_wheel_guard` 同一条理由(那边写着):QtWebEngine 会从 Chromium 线程
投递内部 QObject 事件,PySide 包装这些内部对象时可能 native crash。所以同样走
「定时扫 `app.allWidgets()`,给没装过的装上」这条路。

## 交互设计

· **在数字框的文本区里左右拖** = 改值。按下不动再松开仍然是普通点击(定位光标),
  所以**打字完全不受影响**——判据是位移超过 `DRAG_THRESHOLD_PX` 才转入拖动。
· 上下箭头按钮**不受影响**:过滤器只装在内部的 QLineEdit 上,箭头不在它里面。
· Shift = 粗调 ×10,Ctrl = 精调 ×0.1。中途换修饰键会**重新锚定**,不会跳一大截。
· 拖动期间光标变成左右箭头。

## 一条不能省的规矩:绝对锚定,不累加

每次移动都从**起手那一刻的值 + 总位移**算出目标值,而不是"在当前值上加一点点"。
累加的写法在 Qt 上会踩两个坑:值被 min/max 钳住之后再往回拖会"粘"在边界;
每一步各自 round 到 decimals 会把误差攒起来,拖一趟回到原点却不等于原值。
"""
from __future__ import annotations

import shiboken6

from PySide6.QtCore import QEvent, QObject, Qt, QTimer
from PySide6.QtGui import QMouseEvent
from PySide6.QtWidgets import (
    QAbstractSpinBox,
    QApplication,
    QDoubleSpinBox,
    QLineEdit,
    QSpinBox,
    QWidget,
)

_GUARD_PROP = "_gamedraft_drag_spin_installed"

#: 拖多少像素算一个 `singleStep`。2px/步 = 拖满 200px 走 100 步,
#: 与 Unity 手感接近;再快就没法停在想要的数上。
PX_PER_STEP = 2.0

#: 位移超过这么多像素才转入拖动。小于它一律当普通点击(要能定位光标、要能打字)。
DRAG_THRESHOLD_PX = 4

#: 修饰键倍率。粗调 ×10、精调 ×0.1。
COARSE_MULT = 10.0
FINE_MULT = 0.1

_TIP = "左右拖动可直接改数值（Shift 粗调 ×10 / Ctrl 精调 ×0.1）"


def modifier_multiplier(shift: bool, ctrl: bool) -> float:
    """修饰键 → 倍率。两个都按住时**粗调赢**(先按到哪个都一样,免得手感随顺序变)。"""
    if shift:
        return COARSE_MULT
    if ctrl:
        return FINE_MULT
    return 1.0


def scrub_value(
    anchor_value: float, dx_px: float, single_step: float,
    mult: float, decimals: int | None,
) -> float:
    """起手值 + 横向位移 → 目标值。**纯函数**,不碰 Qt,可直接单测。

    `decimals=None` 表示整数框(QSpinBox):四舍五入到整。否则按小数位数 round ——
    不 round 会把 `0.30000000000000004` 这种写进策划数据,diff 里全是噪声。
    """
    steps = (dx_px / PX_PER_STEP) * mult
    raw = anchor_value + steps * single_step
    if decimals is None:
        return float(round(raw))
    return round(raw, decimals)


class _SpinScrubber(QObject):
    """一个实例伺候全编辑器的数字框(拖动状态是全局唯一的:同时只可能拖一个)。"""

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._spin: QAbstractSpinBox | None = None
        self._armed = False          # 按下了,还没超过阈值
        self._scrubbing = False      # 已转入拖动
        self._press_x = 0.0
        self._anchor_x = 0.0
        self._anchor_val = 0.0
        self._mult = 1.0
        self._cursor_pushed = False

    # ------------------------------------------------------------ 工具
    @staticmethod
    def _spin_of(obj: QObject) -> QAbstractSpinBox | None:
        """事件对象 → 它所属的数字框。只认 QSpinBox / QDoubleSpinBox。

        QDateTimeEdit 之类也是 QAbstractSpinBox,但它们的 `singleStep` 不是一个
        有意义的标量,拖出来的东西没法解释,所以不接。
        """
        w = obj if isinstance(obj, QWidget) else None
        while w is not None:
            if isinstance(w, (QSpinBox, QDoubleSpinBox)):
                return w
            w = w.parentWidget()
        return None

    @staticmethod
    def _decimals_of(spin: QAbstractSpinBox) -> int | None:
        return spin.decimals() if isinstance(spin, QDoubleSpinBox) else None

    def _push_cursor(self) -> None:
        if self._cursor_pushed:
            return
        QApplication.setOverrideCursor(Qt.CursorShape.SizeHorCursor)
        self._cursor_pushed = True

    def _pop_cursor(self) -> None:
        if not self._cursor_pushed:
            return
        QApplication.restoreOverrideCursor()
        self._cursor_pushed = False

    def _alive(self) -> bool:
        """手上这个数字框还在不在。

        ⚠ 这条判据不是防御性编程,是**必需**的:表单会在拖动过程中被重建
        (切页、灯表重填、同步收到对面的整块参数),原来的 spinbox 当场被 Qt 销毁。
        下一个 MouseMove 打到已销毁对象上,PySide 抛 RuntimeError **进 Qt 的事件
        派发里**——那不是一个能 catch 住的异常,是进程直接崩。
        实测:一个用例里销毁控件、下一个用例继续发 move,pytest worker 当场 crash。
        """
        spin = self._spin
        return spin is not None and shiboken6.isValid(spin)

    def _reset(self) -> None:
        self._pop_cursor()
        self._spin = None
        self._armed = False
        self._scrubbing = False

    def _reanchor(self, x: float, mult: float) -> bool:
        """换了修饰键就把锚点挪到当前位置。控件已销毁则收手并返回 False。

        不挪的话,按下 Shift 的一瞬间整段已走的位移会突然按 ×10 重算,
        数值当场跳一大截 —— 那正是人想"稍微调快一点"时最不想要的。
        """
        if not self._alive():
            self._reset()
            return False
        self._anchor_x = x
        self._anchor_val = float(self._spin.value())
        self._mult = mult
        return True

    # ------------------------------------------------------------ 主体
    def eventFilter(self, obj: QObject, event: object) -> bool:  # noqa: N802
        # 与 qt_combo_wheel_guard 同一条理由:用 isinstance 而不是 event.type() 比较,
        # 避开 Shiboken 在收尾阶段包装内部事件时的 SystemError。
        if not isinstance(event, QMouseEvent):
            return False
        etype = event.type()

        if etype == QEvent.Type.MouseButtonPress:
            if event.button() != Qt.MouseButton.LeftButton:
                return False
            spin = self._spin_of(obj)
            if spin is None or spin.isReadOnly() or not spin.isEnabled():
                return False
            # **不吃掉这个事件**:没超过阈值的按下要照旧定位光标,不然就没法打字了。
            # 上一轮没收干净就先收(松开事件丢了、或者控件被销毁过)
            self._reset()
            self._spin = spin
            self._armed = True
            self._scrubbing = False
            self._press_x = event.position().x()
            self._reanchor(self._press_x, 1.0)
            return False

        if etype == QEvent.Type.MouseMove:
            if not self._armed:
                return False
            if not self._alive():
                # 拖到一半控件没了。收手,别去碰那个已销毁的对象(见 _alive)。
                self._reset()
                return False
            x = event.position().x()
            if not self._scrubbing:
                if abs(x - self._press_x) < DRAG_THRESHOLD_PX:
                    return False
                self._scrubbing = True
                self._push_cursor()
                if not self._reanchor(self._press_x, self._mult):
                    return False
            mods = event.modifiers()
            mult = modifier_multiplier(
                bool(mods & Qt.KeyboardModifier.ShiftModifier),
                bool(mods & Qt.KeyboardModifier.ControlModifier),
            )
            if mult != self._mult and not self._reanchor(x, mult):
                return False
            spin = self._spin
            spin.setValue(scrub_value(
                self._anchor_val, x - self._anchor_x, float(spin.singleStep()),
                self._mult, self._decimals_of(spin),
            ))
            return True

        if etype == QEvent.Type.MouseButtonRelease:
            if event.button() != Qt.MouseButton.LeftButton:
                return False
            was = self._scrubbing
            spin = self._spin if self._alive() else None
            self._reset()
            if was:
                # 吃掉这次松开,并清掉选区:拖动期间光标一直停在按下的位置,
                # 松手后留一片选中文字看着像"我选了它",下一次敲键会整段替换掉。
                if isinstance(obj, QLineEdit) and shiboken6.isValid(obj):
                    obj.deselect()
                if spin is not None:
                    # 让下游的 editingFinished 收尾照常跑(有些表单靠它入脏/写回)
                    spin.editingFinished.emit()
                return True
            return False

        return False


def install_global_spin_drag(app: QApplication) -> None:
    """给现有和后续创建的数字框装上拖动改值;重复调用无效。

    去重用控件自身的动态属性(随控件销毁消失)——不能用 `id(widget)` 集合:
    CPython 会复用被销毁控件的内存地址,新控件会被误判"已装"而漏掉。
    这条与 `qt_combo_wheel_guard` 是同一个坑,同一个解法。
    """
    if getattr(app, "_gamedraft_spin_drag_installed", False):
        return
    scrubber = _SpinScrubber(app)

    def install_on_widgets() -> None:
        for widget in app.allWidgets():
            if not isinstance(widget, (QSpinBox, QDoubleSpinBox)):
                continue
            if widget.property(_GUARD_PROP):
                continue
            # 鼠标事件是发给内部那个 QLineEdit 的,不是发给 spinbox 本身。
            # 只装在 line edit 上还有个好处:**上下箭头按钮不在它里面**,
            # 点箭头的行为一点没变。
            line = widget.findChild(QLineEdit)
            if line is not None:
                line.installEventFilter(scrubber)
            widget.setProperty(_GUARD_PROP, True)
            tip = widget.toolTip()
            widget.setToolTip(f"{tip}\n{_TIP}" if tip else _TIP)

    install_on_widgets()
    timer = QTimer(app)
    timer.setInterval(750)
    timer.timeout.connect(install_on_widgets)
    timer.start()

    app._gamedraft_spin_scrubber = scrubber      # 防止被 GC
    app._gamedraft_spin_drag_timer = timer
    app._gamedraft_spin_drag_installed = True
