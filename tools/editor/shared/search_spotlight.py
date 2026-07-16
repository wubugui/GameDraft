"""跳转后的「字段级聚光」——全局搜索双击落页后,把命中文本所在的具体输入控件
送到用户眼前:展开祖先(Tab 页/折叠区/滚动区)、聚焦、选中命中段,并用一圈
短暂的琥珀色描边标出来,免得进了页面还要肉眼再找一遍。

纯只读定位:不改任何控件内容、不写模型;找不到匹配控件就静默作罢
(条目级定位仍然有效)。匹配用「数据里的原文切片」做区分大小写的包含查找,
控件回显与数据一致时即可命中;越短的文本越具体,优先选中。
"""

from __future__ import annotations

from PySide6.QtCore import QPoint, QRect, Qt, QTimer
from PySide6.QtGui import QColor, QPainter, QPen, QTextCursor
from PySide6.QtWidgets import (
    QAbstractSpinBox, QComboBox, QLineEdit, QPlainTextEdit, QScrollArea,
    QStackedWidget, QTabWidget, QTextEdit, QWidget,
)

from .collapsible_section import CollapsibleSection

# 含全文的只读预览类控件:永远不该被当成"命中字段"(它们什么都包含)
_DENY_TYPE_NAMES = {"JsonPreview"}

_FLASH_COLOR = "#e6a817"  # 琥珀,明暗主题下都醒目;仅用于临时覆盖层,不动控件样式
_FLASH_MS = 1600


class _FlashOverlay(QWidget):
    """罩在目标区域上的一次性描边(鼠标穿透,定时自毁,不触碰目标样式)。

    默认几何 = 目标控件整体;传 rect(目标控件坐标系)则只圈那一块——
    画布(QGraphicsView)里的图元用后者。"""

    def __init__(self, target: QWidget, rect: QRect | None = None):
        win = target.window()
        super().__init__(win)
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        local = rect if rect is not None else QRect(QPoint(0, 0), target.size())
        geo = QRect(target.mapTo(win, local.topLeft()), local.size()).adjusted(-3, -3, 3, 3)
        self.setGeometry(geo)
        self.show()
        self.raise_()
        QTimer.singleShot(_FLASH_MS, self.deleteLater)

    def paintEvent(self, _event) -> None:
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        color = QColor(_FLASH_COLOR)
        pen = QPen(color)
        pen.setWidth(3)
        p.setPen(pen)
        fill = QColor(color)
        fill.setAlpha(28)
        p.setBrush(fill)
        p.drawRoundedRect(self.rect().adjusted(1, 1, -2, -2), 4, 4)


def flash_canvas_item(view, item) -> None:
    """在 QGraphicsView 里给一个图元来一圈琥珀描边(几何映射失败静默)。

    给"画布类编辑器的外部跳转落点"用:选中往往只有细虚线,叠一圈短暂高亮
    让眼睛直接锁定;view 需已可见,几何按当前视口换算,自毁前不跟随滚动。"""
    try:
        vp = view.viewport()
        r = view.mapFromScene(item.sceneBoundingRect()).boundingRect()
        r = r.intersected(vp.rect().adjusted(-4, -4, 4, 4))
        if r.width() <= 0 or r.height() <= 0:
            return
        _FlashOverlay(vp, r)
    except Exception:
        pass


def _widget_text(w: QWidget) -> str:
    if isinstance(w, QLineEdit):
        return w.text()
    if isinstance(w, (QTextEdit, QPlainTextEdit)):
        return w.toPlainText()
    if isinstance(w, QComboBox):
        return w.currentText()
    if isinstance(w, QAbstractSpinBox):
        return w.text()
    return ""


def _reveal_ancestors(w: QWidget) -> None:
    """让 w 真正可见:切到包含它的 Tab 页、展开折叠区(由外到内),再滚到眼前。"""
    chain: list[QWidget] = []
    p = w.parentWidget()
    while p is not None:
        chain.append(p)
        p = p.parentWidget()
    for anc in reversed(chain):  # 外层先切,内层的几何才可靠
        if isinstance(anc, QTabWidget):
            for i in range(anc.count()):
                page = anc.widget(i)
                if page is not None and (page is w or page.isAncestorOf(w)):
                    anc.setCurrentIndex(i)
                    break
        elif isinstance(anc, CollapsibleSection):
            try:
                anc.set_expanded(True)
            except Exception:
                pass
    for anc in chain:  # 滚动区由内到外逐层滚到位
        if isinstance(anc, QScrollArea):
            try:
                anc.ensureWidgetVisible(w, 48, 48)
            except Exception:
                pass


def _select_span(w: QWidget, start: int, length: int) -> None:
    """在文本控件里选中命中段(光标落到命中处;非文本控件跳过)。"""
    try:
        if isinstance(w, QLineEdit):
            w.setSelection(start, length)
        elif isinstance(w, (QTextEdit, QPlainTextEdit)):
            cur = w.textCursor()
            cur.setPosition(start)
            cur.setPosition(start + length, QTextCursor.MoveMode.KeepAnchor)
            w.setTextCursor(cur)
            w.ensureCursorVisible()
    except Exception:
        pass  # 选择只是锦上添花,失败不影响聚焦本身


def _norm(s: str) -> str:
    """与搜索后端 _excerpt_of 同口径的等长归一(控制字符→空格),用于跨行匹配。"""
    return "".join(" " if ch in "\r\n\t" else ch for ch in s)


# 过滤/搜索框的占位符特征:这些框恰好残留同词时会抢走聚光(对抗审查确认项)
_FILTER_PLACEHOLDER_HINTS = ("搜索", "过滤", "search", "filter")


def _is_filter_box(w: QWidget) -> bool:
    if not isinstance(w, QLineEdit):
        return False
    ph = (w.placeholderText() or "").casefold()
    return bool(ph) and any(h in ph for h in _FILTER_PLACEHOLDER_HINTS)


def _behind_inactive_stack_page(w: QWidget) -> bool:
    """w 是否藏在某个 QStackedWidget 的非当前页里。

    栈页是数据驱动的分型视图(hotspot 分型参数页/字符串值类型页…),擅自切页会
    展示错误的子表单——所以不切,直接把这类候选排除(非当前页里往往是陈旧文本)。"""
    child = w
    p = w.parentWidget()
    while p is not None:
        if isinstance(p, QStackedWidget) and p.currentWidget() is not None:
            page = child if child.parentWidget() is p else None
            if page is None:
                for i in range(p.count()):
                    cand = p.widget(i)
                    if cand is child or cand.isAncestorOf(w):
                        page = cand
                        break
            if page is not None and page is not p.currentWidget():
                return True
        child = p
        p = p.parentWidget()
    return False


def spotlight_match(page: QWidget, matched_text: str, context_text: str = "") -> bool:
    """在 page 里找到承载命中的最具体控件:优先匹配摘要窗口的完整上下文
    (同一个词出现在多个字段时锁定正确字段),退而匹配命中切片本身。
    展开/聚焦/选中/闪烁;返回是否命中。

    候选排除:只读预览类/禁用控件/过滤搜索框/藏在非当前栈页后的陈旧文本;
    逐候选揭示后仍不可见的(条件隐藏表单)跳过,绝不聚焦隐形控件或画悬空描边。"""
    needle = (matched_text or "").strip()
    if not needle or page is None:
        return False
    core = (context_text or "").strip().strip("…").strip()
    core_n = _norm(core) if len(core) > len(needle) else ""

    candidates: list[tuple[int, int, int, QWidget]] = []  # (-score, len, 序号, w)
    for order, w in enumerate(page.findChildren(QWidget)):
        if type(w).__name__ in _DENY_TYPE_NAMES:
            continue
        if not w.isEnabled() or _is_filter_box(w) or _behind_inactive_stack_page(w):
            continue
        text = _widget_text(w)
        if not text:
            continue
        has_core = bool(core_n) and core_n in _norm(text)
        has_needle = needle in text
        if not (has_core or has_needle):
            continue
        candidates.append((-(2 if has_core else 1), len(text), order, w))
    candidates.sort(key=lambda t: t[:3])

    for _neg_score, _tlen, _order, w in candidates:
        _reveal_ancestors(w)
        if not w.isVisible():
            continue  # 揭示(Tab/折叠区)也救不回的隐藏控件:换下一个候选
        # 把焦点真正送进字段:主窗口成为活动窗口(搜索对话框是其子窗口,仍浮在
        # 上层,用户可以继续点下一条结果)。
        win = w.window()
        win.activateWindow()
        win.raise_()
        w.setFocus(Qt.FocusReason.OtherFocusReason)
        idx = _widget_text(w).find(needle)
        if idx >= 0:
            _select_span(w, idx, len(needle))
        _FlashOverlay(w)
        return True
    return False
