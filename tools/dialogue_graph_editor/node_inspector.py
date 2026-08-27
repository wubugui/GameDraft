"""Single-node form editor for DialogueGraphNodeDef."""
from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any, Callable, Optional

from PySide6.QtWidgets import (
    QWidget, QVBoxLayout, QHBoxLayout, QFormLayout, QLabel, QLineEdit,
    QPlainTextEdit, QComboBox, QTableWidget, QTableWidgetItem, QPushButton,
    QHeaderView, QMessageBox, QCheckBox, QGroupBox,
    QSizePolicy, QSpinBox, QDoubleSpinBox, QStackedWidget, QToolButton, QDialog,
    QAbstractSpinBox, QBoxLayout, QLayout,
    QStyle,
)
from PySide6.QtCore import Qt, QSize
from PySide6.QtGui import QFontMetrics, QPainter, QPixmap

from tools.editor import theme as app_theme
from tools.editor.shared.condition_expr_tree import ConditionExprTreeRootWidget
from tools.editor.shared.action_editor import (
    _hide_combo_popups_under,
    FilterableTypeCombo,
    NarrativeSignalPickerField,
)

from tools.editor.shared.portrait_catalog import (
    PORTRAIT_EMOTIONS_FALLBACK as _PORTRAIT_EMOTIONS_FALLBACK,
    graph_context_portrait_slug,
    load_portrait_emotions,
    load_portrait_sets,
    npc_portrait_slug_index,
    player_default_portrait_slug,
    portrait_image_path,
)
from tools.editor.shared.portrait_ref_field import PortraitRefField
from tools.editor.shared.reference_picker import ReferencePickerField
from tools.editor.shared.bubble_anchor_field import (
    BubbleAnchorPickField,
    actor_for_dialogue_speaker,
)
from tools.editor.shared.collapsible_section import CollapsibleSection
from tools.editor.shared.voice_spec_field import VoiceSpecField
from .dialogue_condition_text import (
    ALWAYS as _COND_ALWAYS,
    NEVER as _COND_NEVER,
    case_verdict as _case_verdict,
    condition_expr_text,
    shorten,
)
from .editor_asset_catalog import load_rule_id_name_pairs
from .graph_analysis import (
    PRIVATE_SIGNAL_MARK,
    PRIVATE_SIGNAL_TOOLTIP,
    collect_private_signal_ids,
)
from .node_picker_dialog import NodePickerDialog
from .npc_picker_dialog import NpcPickerDialog


#: 私有信号标记 QLabel 的 objectName——每轮刷新按它复用，不然每次 changed 都会
#: 在那一行右边再挂一个「私有」。
_PRIVATE_SIGNAL_MARK_OBJECT = "gdPrivateSignalMark"

#: 配音折叠区的说明（单拍与多拍两处共用；与过场字幕/对话框同一套语义）
_GRAPH_VOICE_TIP = (
    "这一句的配音，以及这一句怎么结束。\n"
    "默认：无配音、等玩家点击。\n"
    "一条长配音要盖住后面几句时，起头那句勾「播完不停」，"
    "由后面某句选「跟随配音结束」来收尾。"
)


def _without_private_note(text: str) -> str:
    """把上一轮加过的私有说明剥掉，拿回控件自己的提示（幂等的关键）。"""
    if text.startswith(PRIVATE_SIGNAL_TOOLTIP):
        return text[len(PRIVATE_SIGNAL_TOOLTIP):].lstrip("\n")
    return text


def mark_private_signal_fields(root: QWidget, private_ids: set[str]) -> None:
    """给动作树里挑中私有信号的发射行挂上标记与提示（幂等，可反复调）。

    为什么标在**发射端**：私有信号按发射方 owner 定向投递，缺 owner 上下文是当场丢弃
    （fail-loud，**不回落成全局广播**）。对话图本身无状态、owner 是调用那一刻带进来的，
    所以同一张图挂在有实体的热点上就正常推、挂在没有实体上下文的容器上就一声不响地
    丢——策划在挑信号这一刻看不出区别，等跑起来才发现"怎么没反应"。

    为什么每次都重扫而不是装一次：动作行是整行 ``deleteLater`` 重建的（换动作类型、
    增删行都会），一次性装饰活不过一次编辑。
    """
    for field in root.findChildren(NarrativeSignalPickerField):
        try:
            is_private = field.current_signal() in private_ids
        except RuntimeError:
            # 行已经在重建途中被销毁：对已析构的 C++ 对象再调方法会抛，跳过这一枝就好
            continue
        mark = field.findChild(QLabel, _PRIVATE_SIGNAL_MARK_OBJECT)
        if mark is None and is_private:
            mark = QLabel(PRIVATE_SIGNAL_MARK, field)
            mark.setObjectName(_PRIVATE_SIGNAL_MARK_OBJECT)
            layout = field.layout()
            if layout is None:      # 上游换了布局方式就安静退场，绝不把标记扔到窗口左上角
                continue
            layout.addWidget(mark)
        if mark is not None:
            mark.setVisible(is_private)
            _apply_private_tooltip(mark, is_private)
        _apply_private_tooltip(field, is_private)
        for line in field.findChildren(QLineEdit):
            # 只读框才是鼠标真正停留的地方；它的提示每次改值都会被自己重写，所以每轮补
            _apply_private_tooltip(line, is_private)


def _apply_private_tooltip(widget: QWidget, is_private: bool) -> None:
    """私有说明置顶挂到控件提示上；不是私有就恢复原样。

    每轮都按当前提示重算（而不是记一份"原始提示"）：信号框的提示会被它自己的
    ``_refresh_line()`` 改写成当前显示名，缓存一份原始值只会把旧信号名贴回去。
    """
    base = _without_private_note(widget.toolTip())
    if not is_private:
        widget.setToolTip(base)
        return
    widget.setToolTip(f"{PRIVATE_SIGNAL_TOOLTIP}\n{base}" if base else PRIVATE_SIGNAL_TOOLTIP)


SpeakerKinds = ("player", "npc", "literal", "sceneNpc")
#: 说话人四态的中文短名——画布与节点列表早就在用中文（graph_document.node_summary），
#: 检查器下拉却直接印 `literal` 这种原文，同一个东西左中右三栏三个名字。
SPEAKER_KIND_LABELS_ZH = {
    "player": "玩家",
    "npc": "NPC",
    "literal": "旁白",
    "sceneNpc": "场景 NPC",
}

# 与 GraphDialogueManager.resolveSpeaker（sceneNpc）约定一致
PROMPT_LINE_SCENE_NPC_CONTEXT_TOKEN = "@contextNpc"

# line / choice 等共用；默认 4 行可视高度（图对话 line 节点正文）
_PLAIN_MIN_LINES = 4


def _plain_text_edit(
    *,
    placeholder: str = "",
    min_lines: int = _PLAIN_MIN_LINES,
    parent: QWidget | None = None,
) -> QPlainTextEdit:
    w = QPlainTextEdit(parent)
    if placeholder:
        w.setPlaceholderText(placeholder)
    fm = QFontMetrics(w.font())
    lh = max(1, int(fm.lineSpacing()))
    lines = max(1, int(min_lines))
    # 约 lines 行起步高度；用 min/max 区间而非 setFixedHeight，便于随内容/窗口伸缩
    w.setMinimumHeight(max(32, lh * lines + 18))
    w.setMaximumHeight(max(120, lh * (lines + 6) + 18))
    w.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
    w.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
    w.setLineWrapMode(QPlainTextEdit.LineWrapMode.WidgetWidth)
    return w


def _form_wrap_rows(fl: QFormLayout) -> None:
    fl.setRowWrapPolicy(QFormLayout.RowWrapPolicy.WrapAllRows)
    fl.setHorizontalSpacing(8)
    fl.setVerticalSpacing(6)


class _ElidingLabel(QLabel):
    """一行摘要标签：宽度不够时打省略号，而不是把整行顶出面板。

    检查器面板默认只有 280px 宽（主窗 `setSizes([200, 820, 280])`）。普通 QLabel
    在 `wordWrap=False` 时最小宽度 = 整段文本宽度，于是「分支标题 + 右侧五个操作按钮」
    这种行的最小宽度直接 400px 打底 —— 结果是**整个检查器横向滚动，删除/上移/下移
    按钮被挤出可视区，策划够都够不着**。摘要天生该省略：完整内容进 tooltip。
    """

    def __init__(self, text: str = "", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._full = ""
        self._elide_mode = Qt.TextElideMode.ElideMiddle
        self.setTextFormat(Qt.TextFormat.PlainText)
        self.setText(text)

    def setText(self, text: str) -> None:  # noqa: N802 - Qt 命名
        self._full = text or ""
        self.setToolTip(self._full)
        super().setText(self._full)
        self.updateGeometry()

    def fullText(self) -> str:  # noqa: N802 - 与 Qt 风格一致
        return self._full

    def minimumSizeHint(self) -> QSize:  # noqa: N802
        # 只要求能放下几个字，其余交给省略号——这正是不顶爆面板的关键。
        h = super().minimumSizeHint().height()
        return QSize(48, h)

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        metrics = QFontMetrics(self.font())
        # 用 ElideMiddle 而不是 ElideRight：摘要是「条件 → 去哪」，同一个 switch 里
        # 七条分支常共享长前缀（flow_背尸_零工活:… / flow_背尸_淹尸活:…），差异在尾部，
        # 而「去哪」也在尾部——右截等于把最有辨识度的两半一起吃掉。
        elided = metrics.elidedText(
            self._full, self._elide_mode, self.contentsRect().width()
        )
        painter.drawText(
            self.contentsRect(),
            int(self.alignment()),
            elided,
        )


# ---- 数组里混进非 dict 元素时的统一口径（元素级只读透传） --------------------
#
# 节点级早就定好了规矩：畸形数据降级为只读展示 + 原样透传 + 交给校验报错，不崩不丢
#（`set_node` 对非 dict 节点值、`_build_choice` 对非数组 options 都照办）。但**数组元素级**
# 一直是 `if not isinstance(x, dict): continue` —— 跳过之后再也不还原，于是
# 「打开图 → 点一下这个节点 → 点走」就把那一条从磁盘上抹掉了，而且校验证据同时消失
#（内存里已经没有它了），保存门自然放行。CLAUDE.md 的 production-mode 下 agent 直接写
# JSON，数组里混个字符串/null 是现实可能。下面两个函数把这一层补齐，五处容器共用。


def _dict_items(raw: Any) -> list[dict[str, Any]]:
    """数组里能进表单的那些元素（顺序不变）。

    表单行就是按它建的，所以任何「行 ↔ 数据元素」的配对都必须过这一层，
    否则坏元素之后的行会整体错位。
    """
    if not isinstance(raw, list):
        return []
    return [x for x in raw if isinstance(x, dict)]


def _split_dict_items(raw: Any) -> tuple[list[dict[str, Any]], list[tuple[int, Any]]]:
    """拆成「能进表单的 dict 元素」与「原位置 + 原值 的非 dict 元素」。"""
    if not isinstance(raw, list):
        return [], []
    junk = [(i, copy.deepcopy(x)) for i, x in enumerate(raw) if not isinstance(x, dict)]
    return _dict_items(raw), junk


def _reinsert_junk(items: list[Any], junk: list[tuple[int, Any]]) -> list[Any]:
    """把非 dict 元素按原下标塞回去（下标越界就贴到末尾）。

    用户增删/重排过表单行时原下标不一定还对得上，此时「位置尽量靠近、内容一个不少」
    就是能给的最好保证——总好过静默删除。
    """
    if not junk:
        return items
    out = list(items)
    for index, value in junk:
        out.insert(min(index, len(out)), copy.deepcopy(value))
    return out


def _row_data_indices(row_count: int, junk: list[tuple[int, Any]]) -> list[int]:
    """每个表单行在**最终写盘数组**里的下标。

    必须与 `_reinsert_junk` 用同一套规则跑一遍，不能拿"加载时记的 junk 原下标"去推：
    行被删掉之后行数少于 junk 原下标，`min(index, len(out))` 会把 junk 贴到末尾，
    两边规则就打架了——实测删一行后检查器标着 `2.` 的分支，校验说的「分支 2」
    其实是另一条。**编号看着权威却在骗人，比没有编号更坏。**
    """
    marks: list[Any] = list(range(row_count))
    out: list[Any] = list(marks)
    for index, _v in junk:
        out.insert(min(index, len(out)), None)
    return [out.index(i) for i in marks]


def _junk_notice(junk: list[tuple[int, Any]], what: str) -> QLabel | None:
    """把「有几条看不懂的元素被原样保留着」明明白白告诉策划，而不是悄悄留着。"""
    if not junk:
        return None
    try:
        preview = "；".join(
            f"第 {i} 条：{json.dumps(v, ensure_ascii=False)}" for i, v in junk[:3]
        )
    except (TypeError, ValueError):
        preview = "；".join(f"第 {i} 条：{v!r}" for i, v in junk[:3])
    more = f"（共 {len(junk)} 条）" if len(junk) > 3 else ""
    lbl = QLabel(
        f"⚠ 这里有 {len(junk)} 条{what}不是对象、表单显示不了，已原样保留不会被改写{more}：\n"
        f"{preview}\n请在数据文件里修好；校验面板也会把它们列为错误。"
    )
    lbl.setWordWrap(True)
    lbl.setStyleSheet(app_theme.semantic_text_css("warn"))
    return lbl


#: 检查器面板的默认宽度（主窗 `setSizes([200, 820, 280])`）。表单必须能压进这个宽度，
#: 否则整个面板横向滚动，行尾的删除/上移/下移按钮被挤出可视区、策划够都够不着。
INSPECTOR_PANEL_WIDTH = 280

#: 纯「打开选择器」的窄按钮：文案本身就短，不该按 Qt 默认的 ~80px 最小宽占位。
#: 一行里并排两三个就是 240px，光按钮就把面板顶爆了。
#: 统一成「选…」（原来「选…」9 处 / 「选择…」5 处混用，同一屏内两种写法并存）。
_PICK_BUTTON_TEXTS = frozenset({"选…", "选择…", "编辑…", "next…", "引用", "清除", "…"})


def _cap_combos_per_row(root: QWidget) -> None:
    """给每个下拉封顶：同一横排里的下拉平分面板预算，而不是各自封同一个死值。

    只封顶、不设最小宽——下拉在宽面板上仍会随布局撑开到分到的上限，
    窄面板上则被夹住不顶爆。没跟别人挤一行的下拉拿满预算。
    """
    # 留 44px 给外边距 + 滚动条 + **多层嵌套各自的边距**：条件行位于
    # 分支 → 内容 → AND 块 → 条件列表 → 条件行 → 叶子容器 六层之内，每层几 px
    # 累起来就是十几 px，正好卡在超不超 280 的分界上。
    budget = INSPECTOR_PANEL_WIDTH - 44
    # 基线：任何下拉单独占一行也不许超过预算（长 id 列表能把最小宽顶到 330px+）。
    # 下面再按「同一横排有几个」往下收——横排之外的（QFormLayout 行里那种）就吃这条基线。
    for cb in root.findChildren(QComboBox):
        cb.setMaximumWidth(budget)
    for lay in root.findChildren(QBoxLayout):
        if lay.direction() not in (
            QBoxLayout.Direction.LeftToRight,
            QBoxLayout.Direction.RightToLeft,
        ):
            continue
        combos: list[QComboBox] = []
        fixed = 0
        for i in range(lay.count()):
            w = lay.itemAt(i).widget()
            if w is None or w.isHidden():
                continue
            if isinstance(w, QComboBox):
                combos.append(w)
            else:
                fixed += min(w.minimumSizeHint().width(), 120)
        if not combos:
            continue
        share = max(90, (budget - fixed - 8 * lay.count()) // len(combos))
        for cb in combos:
            cur = cb.maximumWidth()
            cb.setMaximumWidth(min(cur, share) if cur < 16777215 else share)


def _fit_panel_width(root: QWidget) -> None:
    """把整棵表单压进窄面板。

    只做三件事，都是「让控件愿意变窄」，不改变任何数据语义：
    1. 选择器窄按钮按文字实宽封顶（Qt 默认最小宽 ~80px，并排几个就顶爆面板）；
    2. 下拉不再按最长选项要宽度（长 id 列表会把 QComboBox 的最小宽拉到 400px+）；
    3. 长的静态说明标签允许折行（QLabel 不折行时最小宽 = 整段文字宽）。

    放在 `set_node` 末尾统一跑一遍，而不是逐个控件设——新加的控件天然被覆盖，
    不会因为「这一处忘了设」再把面板顶出横向滚动条。
    """
    for btn in root.findChildren(QPushButton):
        if btn.text() in _PICK_BUTTON_TEXTS:
            fm = QFontMetrics(btn.font())
            btn.setMaximumWidth(fm.horizontalAdvance(btn.text()) + 30)
    for cb in root.findChildren(QComboBox):
        cb.setSizeAdjustPolicy(
            QComboBox.SizeAdjustPolicy.AdjustToMinimumContentsLengthWithIcon
        )
        # 按**自身选项**的长度要宽度，最多 6 个字：`==` 这种两字下拉不该跟
        # 长 id 列表一样占 100px（一行三个下拉就 300px，直接顶爆面板）。
        longest = max((len(cb.itemText(i)) for i in range(cb.count())), default=2)
        cb.setMinimumContentsLength(max(2, min(5, longest)))
    # QComboBox 的 minimumSizeHint 并不吃 minimumContentsLength（长 id 列表能把它顶到
    # 290px），只有 maximumWidth 夹得住。但封顶必须**按行分配**而不是每个都给同一个
    # 固定值：每个都封 240 的话，同排两个下拉就是 480px —— choice 的立绘行
    #（「立绘」标签 + 立绘集下拉 + 表情下拉）正是这么顶到 502px 的。
    _cap_combos_per_row(root)
    for sp in root.findChildren(QAbstractSpinBox):
        # 8 位小数的 QDoubleSpinBox 最小宽能到 160px；数值框够填就行，不必按最大位数占位。
        sp.setMaximumWidth(90)
    for lbl in root.findChildren(QLabel):
        if isinstance(lbl, _ElidingLabel):
            continue
        if not lbl.wordWrap() and len(lbl.text()) > 14:
            lbl.setWordWrap(True)
    # 嵌套容器的**左右**边距清零：条件行位于「分支→内容→AND块→条件列表→条件行→叶子」
    # 六层之内，Qt 默认每层左右各 9px，累起来 100px+ 全是白占的缩进——在 280px 面板里
    # 这是压不压得进的分水岭。纵向边距保留（行与行之间还是要透气）。
    for lay in root.findChildren(QLayout):
        m = lay.contentsMargins()
        if m.left() or m.right():
            lay.setContentsMargins(0, m.top(), 0, m.bottom())
    # 上面的封顶/折行都发生在布局已经建好并算过一轮之后，而 Qt 会**缓存**每层布局的
    # 最小尺寸——不显式失效的话，外层拿到的还是收窄前的旧值（实测 choice+promptLine
    # 停在 502px，invalidate 之后才降到 359px）。所以必须自下而上失效一遍。
    for lay in root.findChildren(QLayout):
        lay.invalidate()
    for w in root.findChildren(QWidget):
        w.updateGeometry()
    root.updateGeometry()


class _RowHeaderBar(QWidget):
    """列表行标题：宽度够就一行（摘要 + 按钮），不够就把按钮折到第二行。

    固定两行的代价实测是：7 条折叠分支共 413px，其中按钮行占 168px = **40%**；
    面板拉到 900px 也不合并，宽屏用户白白多滚一倍。固定一行的代价则是 280px 面板下
    摘要只剩 ~90px、条件全被省略号吃掉。所以按可用宽度自适应。
    """

    #: 一行放得下的判据：摘要至少要留这么宽才值得跟按钮挤一行。
    _SUMMARY_MIN_INLINE = 150

    def __init__(
        self,
        parent: QWidget,
        toggle: QToolButton,
        summary: QWidget,
        buttons: tuple[QWidget, ...],
    ) -> None:
        super().__init__(parent)
        self._toggle = toggle
        self._summary = summary
        self._buttons = buttons
        self._two_rows: bool | None = None
        self._outer = QVBoxLayout(self)
        self._outer.setContentsMargins(0, 0, 0, 0)
        self._outer.setSpacing(1)
        self._row1 = QHBoxLayout()
        self._row1.setContentsMargins(0, 0, 0, 0)
        self._row2 = QHBoxLayout()
        self._row2.setContentsMargins(0, 0, 0, 0)
        self._outer.addLayout(self._row1)
        self._outer.addLayout(self._row2)
        # 前两个是「在此之前/之后插入」：24px 的方按钮里放不下能区分二者的图标或文字，
        # 而它们又是低频操作 —— 挪进右键菜单，行内只留高频的 上移/下移/删除。
        self._menu_only = set(buttons[:2]) if len(buttons) >= 5 else set()
        self._buttons_width = sum(
            b.sizeHint().width() + 4 for b in buttons if b not in self._menu_only
        )
        self.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.customContextMenuRequested.connect(self._show_row_menu)
        self._apply(two_rows=True)

    #: 菜单项短标签（按钮 tooltip 是整句说明，直接当菜单项太长）。
    _MENU_LABELS = ("在此之前插入", "在此之后插入", "上移", "下移", "删除")

    def _show_row_menu(self, pos) -> None:
        from PySide6.QtWidgets import QMenu

        menu = QMenu(self)
        for i, b in enumerate(self._buttons):
            label = self._MENU_LABELS[i] if i < len(self._MENU_LABELS) else (b.toolTip() or "操作")
            act = menu.addAction(label)
            act.setToolTip(b.toolTip())
            # 继承按钮的禁用态：第一行的「上移」按钮本来是灰的，菜单里却可点，
            # 点了直接 return——静默无反应最招人烦。
            act.setEnabled(b.isEnabled())
            act.triggered.connect(b.click)
        menu.exec(self.mapToGlobal(pos))

    def _apply(self, *, two_rows: bool) -> None:
        if self._two_rows is two_rows:
            return
        self._two_rows = two_rows
        for lay in (self._row1, self._row2):
            while lay.count():
                it = lay.takeAt(0)
                w = it.widget()
                if w is not None:
                    w.setParent(self)
        self._row1.addWidget(self._toggle)
        self._row1.addWidget(self._summary, 1)
        target = self._row2 if two_rows else self._row1
        if two_rows:
            target.addStretch(1)
        for b in self._buttons:
            if b in self._menu_only:
                b.setVisible(False)
                continue
            target.addWidget(b)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        avail = self.width() - self._toggle.sizeHint().width() - self._buttons_width
        self._apply(two_rows=avail < self._SUMMARY_MIN_INLINE)


def _fill_stacked_row_header(
    header: QVBoxLayout,
    toggle: QToolButton,
    summary: QWidget,
    buttons: tuple[QWidget, ...],
) -> None:
    """列表行标题排两行：上行「折叠箭头 + 摘要（整宽）」，下行「操作按钮（右对齐）」。

    挤成一行时右侧五个按钮就吃掉 110px，280px 面板里留给摘要只剩 ~90px——
    「当 flow_xungou_main:等看进山路 → 已接活」被省略成「当 flow_xungou…」，
    条件和去向全看不见。而"一眼看出每条是什么"正是这个折叠列表存在的意义，
    所以让摘要独占整行、按钮另起一行右对齐；两行加起来仍远比展开一条短。
    """
    header.setContentsMargins(0, 0, 0, 0)
    header.setSpacing(0)
    # 交给 _RowHeaderBar：窄面板两行（摘要整宽）、宽面板一行（省掉 40% 的行高）。
    header.addWidget(_RowHeaderBar(toggle.parentWidget(), toggle, summary, buttons))


def _help_marker(text: str, parent: QWidget | None = None) -> QLabel:
    """紧凑的「ⓘ 说明」标记：把大段说明收进 tooltip，避免常驻界面占高（与布局铁律一致）。"""
    lbl = QLabel("ⓘ 说明", parent)
    lbl.setStyleSheet(app_theme.semantic_text_css("faint"))
    lbl.setToolTip(text)
    lbl.setCursor(Qt.CursorShape.WhatsThisCursor)
    return lbl


def _compact_row_nav_buttons(
    parent: QWidget,
    *,
    tip_before: str,
    tip_after: str,
    tip_up: str,
    tip_down: str,
    tip_del: str,
    side: int = 24,
) -> tuple[QToolButton, QToolButton, QToolButton, QToolButton, QToolButton]:
    """前插/后插/上移/下移/删除：小图标按钮，含义见 tooltip。"""
    st = parent.style()
    iz = QSize(max(12, side - 8), max(12, side - 8))
    del_pix = getattr(
        QStyle.StandardPixmap,
        "SP_TrashIcon",
        QStyle.StandardPixmap.SP_DialogCancelButton,
    )

    def mk(pix: QStyle.StandardPixmap, tip: str) -> QToolButton:
        b = QToolButton(parent)
        b.setIcon(st.standardIcon(pix))
        b.setIconSize(iz)
        b.setFixedSize(side, side)
        b.setToolTip(tip)
        b.setAutoRaise(True)
        b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        return b

    # 插入用「+」而不是左右箭头：四个同族箭头里 ◀▶ 会被读成「上一条/下一条」或
    # 「左移/右移」，误点就凭空多一条空分支——而空分支在运行时是恒命中的。
    def mk_text(label: str, tip: str) -> QToolButton:
        b = QToolButton(parent)
        b.setText(label)
        b.setFixedSize(side, side)
        b.setToolTip(tip)
        b.setAutoRaise(True)
        b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        return b

    return (
        mk_text("+↑", tip_before),
        mk_text("+↓", tip_after),
        mk(QStyle.StandardPixmap.SP_ArrowUp, tip_up),
        mk(QStyle.StandardPixmap.SP_ArrowDown, tip_down),
        mk(del_pix, tip_del),
    )


def _speaker_to_ui(sp: dict[str, Any]) -> tuple[str, str]:
    k = sp.get("kind", "player")
    if k == "literal":
        return "literal", str(sp.get("name", ""))
    if k == "sceneNpc":
        return "sceneNpc", str(sp.get("npcId", ""))
    return k if k in ("player", "npc") else "player", ""


def _ui_to_speaker(kind: str, extra: str) -> dict[str, Any]:
    if kind == "literal":
        return {"kind": "literal", "name": extra or "旁白"}
    if kind == "sceneNpc":
        return {"kind": "sceneNpc", "npcId": extra or "npc"}
    if kind == "npc":
        return {"kind": "npc"}
    return {"kind": "player"}


class NodeInspector(QWidget):
    """Emits content_changed when user edits."""

    def __init__(
        self,
        list_node_ids: Callable[[], list[str]],
        *,
        project_root: Path,
        project_model_getter: Optional[Callable[[], Any]] = None,
        node_types_getter: Optional[Callable[[], dict[str, str]]] = None,
        dialogue_graph_id_getter: Optional[Callable[[], str]] = None,
        parent=None,
    ):
        super().__init__(parent)
        self._list_node_ids = list_node_ids
        self._project_root = project_root
        self._project_model_getter = project_model_getter
        self._node_types_getter = node_types_getter
        #: 宿主注入「节点 id → 一行摘要」，供选择目标节点的弹窗显示上下文。
        self._node_summaries_getter: Optional[Callable[[], dict[str, str]]] = None
        self._dialogue_graph_id_getter = dialogue_graph_id_getter
        self._node_id = ""
        self._suppress_change_emit = False
        self._topology_refs: dict[str, Any] = {}
        self._body_valid = False
        self._assign_editor_group: Callable[[str, str], None] | None = None
        self._create_editor_group: Callable[[], str | None] | None = None
        self._editor_group_geometry_mode = False
        self._root_layout = QVBoxLayout(self)
        # 面板本身只有 280px，别再被自己的外边距吃掉 22px——那正好是压不压得进的差额。
        self._root_layout.setContentsMargins(2, 2, 2, 2)

        # 顶部这条「节点 id + 类型」同样必须可省略：它装的是**数据来的** id，长度无上限
        # （真实图里 `生态_歇口气_码头白天_搬运工_闲聊_02` 一抓一把），而富文本 QLabel 的
        # minimumSizeHint = 整行文字宽、`wordWrap=True` 对富文本根本不生效 —— 于是
        # **顶宽面板的元凶不在表单里，宽度护栏却红着指向表单**，下一个改检查器的人会以为
        # 是自己刚加的控件弄坏的（2026-08-17 偏差记录：choice_with_prompt 316px，成因是
        # 那条 24 字的 id 而非任何控件；把 id 换成 `n` 立刻降到 268px）。
        # 代价是 `<b>` 加粗没了（_ElidingLabel 只画纯文本），换来 id 再长也不顶宽、
        # 完整内容进 tooltip。
        self._type_label = _ElidingLabel("", self)
        self._root_layout.addWidget(self._type_label)

        # parent=self 从构造的第一刻起就在 inspector 子树内，避免短暂 orphan top-level。
        self._body = QWidget(self)
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        self._root_layout.addWidget(self._body, 0)
        # 多余纵向空间落在底部，避免把表单区纵向压扁导致控件重叠
        self._root_layout.addStretch(1)

        self._clear_body()

    def _clear_body(self) -> None:
        """切换节点类型时整页重建表单；必须拆掉嵌套的 QFormLayout，否则 takeAt 拿不到子布局里的 QLabel，旧标签会残留在 _body 上叠在新控件上。"""
        self._body_valid = False
        self._topology_refs = {}
        old_body = self._body
        # 只收起所有 QComboBox 公开弹出层（调公开 hidePopup）；
        # 禁止主动处理 QComboBoxPrivateContainer 或强制 processEvents —— 按 Qt 官方建议忽略这类内部 top-level。
        _hide_combo_popups_under(old_body)
        self._body = QWidget(self)
        self._body_layout = QVBoxLayout(self._body)
        self._body_layout.setContentsMargins(0, 0, 0, 0)
        idx = self._root_layout.indexOf(old_body)
        if idx < 0:
            idx = 1
        self._root_layout.removeWidget(old_body)
        self._root_layout.insertWidget(idx, self._body)
        old_body.deleteLater()

    def _emit_structural_changed(self) -> None:
        """增删/移动行等**离散结构操作**的变更出口：额外告诉宿主别把它与打字合并撤销。"""
        cb = getattr(self, "_structural_hint_cb", None)
        if callable(cb):
            cb()
        self._emit_changed()

    def set_structural_hint_callback(self, cb) -> None:
        self._structural_hint_cb = cb

    def _emit_changed(self):
        # Parent connects to slot that reads get_node()
        if self._suppress_change_emit:
            return
        if hasattr(self, "_change_cb") and self._change_cb:
            self._change_cb()

    def set_node_summaries_getter(self, getter: Callable[[], dict[str, str]]) -> None:
        self._node_summaries_getter = getter

    def set_change_callback(self, cb):
        self._change_cb = cb

    def set_editor_group_callbacks(
        self,
        assign: Callable[[str, str], None] | None,
        create_group: Callable[[], str | None] | None,
    ) -> None:
        """assign(node_id, group_id_or_empty)；create_group 返回新分组 id 或 None（仅编辑器）。"""
        self._assign_editor_group = assign
        self._create_editor_group = create_group

    def set_editor_group_geometry_mode(self, on: bool) -> None:
        """为 True 时：分组仅由画布分组框几何决定，本面板只读展示。"""
        self._editor_group_geometry_mode = bool(on)

    def set_node(
        self,
        node_id: str,
        data: dict[str, Any],
        *,
        editor_groups: dict[str, dict[str, Any]] | None = None,
        editor_group_for_node: str | None = None,
    ):
        # 按 Qt 官方推荐，用 setUpdatesEnabled(False/True) 包住 mass rebuild，
        # 避免一次点击里多个 QComboBox popup 创建/销毁造成小顶层窗闪烁。
        _win = self.window()
        if _win is not None:
            _win.setUpdatesEnabled(False)
        self._suppress_change_emit = True
        try:
            self._node_id = node_id
            self._clear_body()
            # 畸形节点值（agent 误写成字符串/列表等非对象）：过去 data.get 直接崩（审查 P2-③）。
            # 降级为只读展示 + 原样透传：getter 返回原值，不被改写、round-trip 无损。
            if not isinstance(data, dict):
                self._type_label.setText(
                    f"节点 id：{node_id}　　类型：畸形（非对象）"
                )
                self._body_layout.addWidget(
                    QLabel(
                        f"该节点的值不是对象（实际为 {type(data).__name__}），无法用表单编辑。\n"
                        "校验面板会将其列为错误；请在数据文件中修正为合法节点对象。",
                        self._body,
                    )
                )
                snap = copy.deepcopy(data)
                self._getter = lambda s=snap: copy.deepcopy(s)
                return
            t = data.get("type", "?")
            # 类型用中文短名：画布写「分支 · root」、节点列表写 `(switch)`、这里写
            # 「类型：switch」——同一个节点左中右三栏三个名字，交流时对不上号。
            # 映射复用 graph_document.node_type_label_zh（画布/布局估算的同一来源）。
            from .graph_document import node_type_label_zh
            # 类型名也可能无上限长（未知类型走 `其它({node_type})`，原文照抄数据里的字符串），
            # 所以整行一起交给 _ElidingLabel，而不是只省略 id 那一段。
            self._type_label.setText(
                f"节点 id：{node_id}　　类型：{node_type_label_zh(t)}"
            )

            # 几何模式只读展示所属分组（画布分组框决定），无需 assign 回调；
            # 非几何模式才需要 assign 回调驱动可编辑下拉。
            if node_id and (self._editor_group_geometry_mode or self._assign_editor_group):
                self._insert_editor_group_row(node_id, editor_groups or {}, editor_group_for_node or "")

            if t == "line":
                self._build_line(data)
            elif t == "runActions":
                self._build_run_actions(data)
            elif t == "choice":
                self._build_choice(data)
            elif t == "switch":
                self._build_switch(data)
            elif t == "ownerState":
                self._build_owner_state(data)
            elif t == "contextState":
                self._build_context_state(data)
            elif t == "end":
                self._body_layout.addWidget(QLabel("结束节点，无额外字段。", self._body))
                self._getter = lambda: {"type": "end"}
            else:
                self._body_layout.addWidget(
                    QLabel(
                        f"未知类型 {t!r}，请用「原始 JSON」在后续版本编辑。",
                        self._body,
                    )
                )
                snap = copy.deepcopy(data)
                self._getter = lambda s=snap: copy.deepcopy(s)
        finally:
            self._body_valid = True
            self._suppress_change_emit = False
            # 统一压进面板宽度：放在这里而不是逐个控件设，新加的控件天然被覆盖。
            _fit_panel_width(self._body)
            _hide_combo_popups_under(self._body)
            if _win is not None:
                _win.setUpdatesEnabled(True)
                # raise_/activateWindow 保留做最终兜底（不造成闪烁，仅可能抢焦点）；如后续发现多余可去掉。
                _win.raise_()
                _win.activateWindow()

    def get_node(self) -> dict[str, Any]:
        """Return current node dict from form state."""
        if not self._body_valid:
            return {"type": "end"}
        getter = getattr(self, "_getter", None)
        if getter:
            return getter()
        return {"type": "end"}

    def current_node_id(self) -> str:
        """当前正在编辑的节点 id（宿主用此判断「哪个节点在编辑」，勿再读私有 _node_id）。"""
        return self._node_id

    def is_form_valid(self) -> bool:
        """表单是否已构建完成且处于有效状态。"""
        return self._body_valid

    def expand_branch_by_data_index(self, data_index: int) -> bool:
        """按**数据下标**展开对应的分支/选项行（校验面板双击定位用）。

        校验消息说的是数据下标（「分支 1」「case[3]」），而表单行序在有坏元素时
        与下标不同——这里按各行自报的 `data_index()` 找，两边口径一致。
        """
        refs = self._topology_refs
        rows = refs.get("case_rows") or refs.get("option_rows") or []
        for row in rows:
            fn = row.get("data_index")
            if not callable(fn) or fn() != data_index:
                continue
            toggle = row.get("toggle")
            if row.get("collapsed") and toggle is not None:
                toggle.click()
            content = row.get("content")
            if content is not None:
                content.setVisible(True)
            return True
        return False

    def update_topology_from_data(self, node_data: dict[str, Any]) -> None:
        """Update connection fields from fresh data without rebuilding the entire form.

        Called when the canvas modifies a connection (next / options[].next / cases[].next /
        defaultNext) so the inspector's QLineEdit widgets reflect the new target without
        losing other in-progress edits.
        """
        refs = self._topology_refs
        if not refs:
            return
        self._suppress_change_emit = True
        try:
            t = refs.get("type")
            if t in ("line", "runActions"):
                ne = refs.get("next_edit")
                if isinstance(ne, QLineEdit):
                    ne.setText(str(node_data.get("next", "")))
            # 表单行只由「能进表单的 dict 元素」构成（非 dict 的坏元素走只读透传、
            # 不占行），所以这里配对前必须先按同一口径过滤，再按顺序 zip —— 直接拿
            # 行号当数据下标会在坏元素之后整体错位：画布上拉的线同步不到检查器，
            # 随后任意一次编辑还会把那条连线静默打回（审查 2026-08-06 P1-1）。
            elif t == "choice":
                opts = _dict_items(node_data.get("options"))
                rows = refs.get("option_rows") or []
                for row, opt in zip(rows, opts):
                    nx = row.get("nx")
                    if isinstance(nx, QLineEdit):
                        nx.setText(str(opt.get("next", "")))
            elif t == "switch":
                cases = _dict_items(node_data.get("cases"))
                rows = refs.get("case_rows") or []
                for row, case in zip(rows, cases):
                    nx = row.get("next_edit")
                    if isinstance(nx, QLineEdit):
                        nx.setText(str(case.get("next", "")))
                dn = refs.get("default_next")
                if isinstance(dn, QLineEdit):
                    dn.setText(str(node_data.get("defaultNext", "")))
            elif t in ("ownerState", "contextState"):
                cases = _dict_items(node_data.get("cases"))
                rows = refs.get("case_rows") or []
                for row, case in zip(rows, cases):
                    nx = row.get("next_edit")
                    if isinstance(nx, QLineEdit):
                        nx.setText(str(case.get("next", "")))
                    st = row.get("state_edit")
                    if isinstance(st, QComboBox):
                        st.setCurrentText(str(case.get("state", "")))
                dn = refs.get("default_next")
                if isinstance(dn, QLineEdit):
                    dn.setText(str(node_data.get("defaultNext", "")))
                mn = refs.get("missing_next")
                if isinstance(mn, QLineEdit):
                    mn.setText(str(node_data.get("missingWrapperNext", "")))
                gid = refs.get("graph_id_edit")
                if isinstance(gid, ReferencePickerField):
                    # 程序性 set_value 不发 value_changed —— 画布改连线不该被算成
                    # 「用户改了 graphId」而标脏。
                    gid.set_value(str(node_data.get("graphId", "")))
                elif isinstance(gid, QComboBox):
                    gid.setCurrentText(str(node_data.get("graphId", "")))
                wid = refs.get("wrapper_graph_id_edit")
                if isinstance(wid, QComboBox):
                    wid.setCurrentText(str(node_data.get("wrapperGraphId", "")))
                elif isinstance(wid, QLineEdit):
                    wid.setText(str(node_data.get("wrapperGraphId", "")))
        finally:
            self._suppress_change_emit = False

    def _insert_editor_group_row(
        self,
        node_id: str,
        group_defs: dict[str, dict[str, Any]],
        current_gid: str,
    ) -> None:
        if self._editor_group_geometry_mode:
            row_w = QWidget(self._body)
            h = QHBoxLayout(row_w)
            h.setContentsMargins(0, 0, 0, 0)
            h.addWidget(QLabel("编辑器分组", row_w))
            if current_gid:
                g = group_defs.get(current_gid) or {}
                label = str(g.get("name") or current_gid)
                sub = QLabel(f"{label}（由画布分组框自动判定，拖入/拖出框即可）", row_w)
            else:
                sub = QLabel("（无，节点中心不在任一分组框内）", row_w)
            sub.setWordWrap(True)
            h.addWidget(sub, 1)
            self._body_layout.addWidget(row_w)
            return
        row_w = QWidget(self._body)
        h = QHBoxLayout(row_w)
        h.setContentsMargins(0, 0, 0, 0)
        h.addWidget(QLabel("编辑器分组", row_w))
        cb = QComboBox(row_w)
        cb.addItem("(无)", "")
        for gid in sorted(group_defs.keys(), key=lambda x: (x.lower(), x)):
            g = group_defs.get(gid) or {}
            label = str(g.get("name") or gid)
            cb.addItem(label, gid)
        cb.addItem("新建分组…", "__new__")
        ix = cb.findData(current_gid)
        cb.setCurrentIndex(max(0, ix))

        def on_change(_i: int) -> None:
            if self._suppress_change_emit:
                return
            d = cb.currentData()
            if d == "__new__":
                cb.blockSignals(True)
                cb.setCurrentIndex(max(0, cb.findData(current_gid)))
                cb.blockSignals(False)
                if self._create_editor_group:
                    new_id = self._create_editor_group()
                    if new_id and self._assign_editor_group:
                        self._assign_editor_group(node_id, new_id)
                return
            if self._assign_editor_group:
                self._assign_editor_group(node_id, str(d) if d else "")

        cb.currentIndexChanged.connect(on_change)
        h.addWidget(cb, 1)
        self._body_layout.addWidget(row_w)

    # --- 玩家可见文本：优先富文本（可插 [tag:…]/[img:…]）；无 ProjectModel 时退回纯文本框 ---
    def _pm_for_rich(self):
        return self._project_model_getter() if self._project_model_getter else None

    def _make_player_textedit(
        self, initial: str, placeholder: str, *, min_lines: int = 4, parent: QWidget | None = None
    ):
        """多行玩家可见文本。返回控件统一支持 toPlainText/setPlainText/textChanged。"""
        host = parent if parent is not None else self._body
        pm = self._pm_for_rich()
        if pm is not None:
            from tools.editor.shared.rich_text_field import RichTextTextEdit

            w = RichTextTextEdit(pm, host)
            w.setPlainText(initial or "")
            if placeholder:
                w.setPlaceholderText(placeholder)
            fm = QFontMetrics(w.font())
            lh = max(1, int(fm.lineSpacing()))
            ln = max(1, int(min_lines))
            w.setMinimumHeight(max(48, lh * ln + 22))
            w.setMaximumHeight(max(140, lh * (ln + 6) + 22))
            return w
        w = _plain_text_edit(placeholder=placeholder, min_lines=min_lines, parent=host)
        w.setPlainText(initial or "")
        return w

    def _npc_entries_for_picker(self) -> list[tuple[str, str]]:
        pm = self._project_model_getter() if self._project_model_getter else None
        ent: list[tuple[str, str]] = []
        if pm:
            try:
                ent.extend(pm.all_npc_ids_global())
            except Exception:
                pass
        return ent

    def _make_id_pick_button(
        self,
        line_edit: QLineEdit,
        entries_getter: Callable[[], list[tuple[str, str]]],
        *,
        title: str,
        tip: str,
    ) -> QPushButton:
        """给承载某类引用 id 的 QLineEdit 配「选…」按钮，打开可搜索列表（保留自由输入，零丢失）。"""
        btn = QPushButton("选…", line_edit.parentWidget() or self._body)
        btn.setToolTip(tip)

        def _open() -> None:
            dlg = NpcPickerDialog(
                entries_getter(),
                title=title,
                initial_id=line_edit.text().strip(),
                parent=self,
            )
            if dlg.exec() == QDialog.DialogCode.Accepted:
                line_edit.setText(dlg.selected_id())
                self._emit_changed()

        btn.clicked.connect(_open)
        return btn

    def _make_npc_pick_button(self, line_edit: QLineEdit, title: str) -> QPushButton:
        """给一个承载 npcId 的 QLineEdit 配「选…」按钮，打开可搜索 NPC 列表。"""
        return self._make_id_pick_button(
            line_edit,
            self._npc_entries_for_picker,
            title=title,
            tip="打开可搜索的 NPC 列表（sceneNpc 说话人的 npcId）",
        )

    def _quest_entries_for_picker(self) -> list[tuple[str, str]]:
        pm = self._project_model_getter() if self._project_model_getter else None
        if not pm:
            return []
        try:
            # quest 叶目标排除 repeatable（无状态机，指向它=校验 error）
            if hasattr(pm, "quest_status_target_ids"):
                return list(pm.quest_status_target_ids())
            return list(pm.all_quest_ids())
        except Exception:
            return []

    def _narrative_graph_entries_for_picker(self) -> list[tuple[str, str]]:
        """switch narrative 叶子的图 id 候选：已知叙事图 + 运行时相对 token。"""
        entries: list[tuple[str, str]] = [
            ("@owner", "@owner（运行时所属实体）"),
            ("@scene", "@scene（运行时所在场景）"),
        ]
        pm = self._project_model_getter() if self._project_model_getter else None
        if pm:
            try:
                for gid in pm.narrative_graph_ids_ordered():
                    gid = str(gid).strip()
                    if gid:
                        entries.append((gid, gid))
            except Exception:
                pass
        return entries

    def _known_narrative_graph_ids(self) -> set[str]:
        pm = self._project_model_getter() if self._project_model_getter else None
        if not pm:
            return set()
        try:
            return {str(g).strip() for g in pm.narrative_graph_ids_ordered() if str(g).strip()}
        except Exception:
            return set()

    def _install_target_validation(self, edit: QLineEdit) -> None:
        """给承载「指向节点 id」的输入框加实时存在性校验：非空且不在当前图节点集
        则标红并提示，消除「打错字→静默悬空边」。纯视觉，不影响序列化（往返零变化）。"""

        def _validate(_t: str = "") -> None:
            tid = edit.text().strip()
            if tid and tid not in set(self._list_node_ids()):
                edit.setStyleSheet(f"QLineEdit {{ border: 1px solid {app_theme.semantic_text_color('error')}; }}")
                edit.setToolTip(f"指向不存在的节点 id：{tid!r}（笔误，或目标尚未创建）")
            else:
                edit.setStyleSheet("")
                if edit.toolTip().startswith("指向不存在的节点"):
                    edit.setToolTip("")

        edit.textChanged.connect(_validate)
        _validate()

    def _install_narrative_id_validation(self, edit: QLineEdit) -> None:
        """switch narrative 叶子的图 id：非空、非 @token、且不在已知叙事图集则标红提示。"""

        def _validate(_t: str = "") -> None:
            gid = edit.text().strip()
            if gid and not gid.startswith("@") and gid not in self._known_narrative_graph_ids():
                edit.setStyleSheet(f"QLineEdit {{ border: 1px solid {app_theme.semantic_text_color('error')}; }}")
                edit.setToolTip(f"未知叙事图 id：{gid!r}（应为 wrapper/scenario 图 id 或 @owner/@scene）")
            else:
                edit.setStyleSheet("")
                if edit.toolTip().startswith("未知叙事图"):
                    edit.setToolTip("")

        edit.textChanged.connect(_validate)
        _validate()

    # --- line ---
    def _build_line(self, data: dict[str, Any]):
        lines_raw = data.get("lines")
        use_multi = isinstance(lines_raw, list) and len(lines_raw) > 0
        _lines_good, _lines_junk = _split_dict_items(lines_raw)
        cb_multi = QCheckBox("多拍连续对白", self._body)
        cb_multi.setToolTip("勾上以后这个节点可以连着说好几句，每句仍需玩家点一下继续；存为 lines 数组。")
        cb_multi.setChecked(use_multi)

        beats_wrap = QWidget(self._body)
        beats_v = QVBoxLayout(beats_wrap)
        beats_v.setContentsMargins(0, 0, 0, 0)
        rows_wrap = QWidget(beats_wrap)
        rows_layout = QVBoxLayout(rows_wrap)
        rows_layout.setContentsMargins(0, 0, 0, 0)
        rows_layout.setSpacing(4)
        beat_rows: list[dict[str, Any]] = []

        def refresh_beat_nav_buttons() -> None:
            n = len(beat_rows)
            for i, r in enumerate(beat_rows):
                r["btn_up"].setEnabled(i > 0)
                r["btn_down"].setEnabled(i < n - 1)

        def refresh_beat_fold_policy() -> None:
            """按各拍**自己**的折叠状态刷新（与 switch 分支 / choice 选项同一套规矩）。"""
            if len(beat_rows) == 1:
                beat_rows[0]["collapsed"] = False
            for r in beat_rows:
                t = r.get("toggle")
                c = r.get("content")
                if t is None or c is None:
                    continue
                collapsed = bool(r.get("collapsed"))
                t.setVisible(True)
                c.setVisible(not collapsed)
                t.setArrowType(
                    Qt.ArrowType.RightArrow if collapsed else Qt.ArrowType.DownArrow
                )

        def rebuild_beats_rows_layout() -> None:
            while rows_layout.count():
                it = rows_layout.takeAt(0)
                w = it.widget()
                if w is not None:
                    w.setParent(None)
            for r in beat_rows:
                rows_layout.addWidget(r["outer"])

        def make_beat_block(beat: dict[str, Any] | None) -> dict[str, Any]:
            row: dict[str, Any] = {"collapsed": True}
            outer = QWidget(rows_wrap)
            ov = QVBoxLayout(outer)
            ov.setContentsMargins(0, 0, 0, 0)
            ov.setSpacing(4)

            header = QVBoxLayout()
            toggle = QToolButton(outer)
            toggle.setAutoRaise(True)
            toggle.setArrowType(Qt.ArrowType.RightArrow)
            toggle.setToolTip("折叠 / 展开本句详细表单")
            # 摘要必须可省略：普通 QLabel 的最小宽度 = 整段文本宽度，会把这一行连同
            # 右侧的操作按钮一起顶出 280px 面板（见 _ElidingLabel 注释）。
            summary = _ElidingLabel("", outer)
            summary.setStyleSheet(app_theme.semantic_text_css("muted"))

            btn_ins_before, btn_ins_after, btn_up, btn_down, btn_del = (
                _compact_row_nav_buttons(
                    outer,
                    tip_before="在此句之前插入空白一句",
                    tip_after="在此句之后插入空白一句",
                    tip_up="整条句子上移",
                    tip_down="整条句子下移",
                    tip_del="删除此句（至少保留一句）",
                )
            )

            _fill_stacked_row_header(
                header,
                toggle,
                summary,
                (btn_ins_before, btn_ins_after, btn_up, btn_down, btn_del),
            )

            content = QWidget(outer)
            o_fl = QFormLayout(content)
            _form_wrap_rows(o_fl)

            spb = (beat or {}).get("speaker") if isinstance(beat, dict) else None
            if not isinstance(spb, dict):
                spb = {"kind": "player"}
            bk, bex = _speaker_to_ui(spb)
            kcb = QComboBox(content)
            for sk in SpeakerKinds:
                kcb.addItem(SPEAKER_KIND_LABELS_ZH.get(sk, sk), sk)
            kcb.setCurrentIndex(max(0, kcb.findData(bk)))
            exed = QLineEdit(bex, content)
            exed_npc_btn = self._make_npc_pick_button(exed, "选择说话人 · sceneNpc")
            exed_row = QWidget(content)
            exed_row_lo = QHBoxLayout(exed_row)
            exed_row_lo.setContentsMargins(0, 0, 0, 0)
            exed_row_lo.addWidget(exed, 1)
            exed_row_lo.addWidget(exed_npc_btn)
            tx_plain = self._make_player_textedit(
                str((beat or {}).get("text", "") if isinstance(beat, dict) else ""),
                "本句对白正文",
                min_lines=4,
                parent=content,
            )
            tked = QLineEdit(
                str((beat or {}).get("textKey", "") if isinstance(beat, dict) else ""),
                content,
            )
            tked.setPlaceholderText("可选：strings 键")

            def update_summary() -> None:
                kk = kcb.currentData()
                sk = str(kk) if kk is not None else ""
                tx = tx_plain.toPlainText().strip().replace("\n", " ")
                if len(tx) > 36:
                    tx = tx[:33] + "…"
                if not tx:
                    tx = "—"
                summary.setText(f"{sk}  ·  {tx}")

            def upd_ex() -> None:
                kk = kcb.currentData()
                exed_row.setVisible(kk in ("literal", "sceneNpc"))
                exed_npc_btn.setVisible(kk == "sceneNpc")  # 仅 sceneNpc 是 npcId 引用
                exed.setPlaceholderText("显示名" if kk == "literal" else "npcId")

            kcb.currentIndexChanged.connect(
                lambda _i: (upd_ex(), update_summary(), self._emit_changed())
            )
            exed.textChanged.connect(self._emit_changed)
            tx_plain.textChanged.connect(self._emit_changed)
            tked.textChanged.connect(self._emit_changed)
            upd_ex()

            _lbl_sk = QLabel("说话人", content)
            _lbl_sk.setToolTip("JSON 字段 speaker.kind：玩家 / NPC / 旁白 / 场景 NPC")
            o_fl.addRow(_lbl_sk, kcb)
            o_fl.addRow("名字 / npcId", exed_row)
            _lb_t = QLabel("台词", content); _lb_t.setToolTip("JSON 字段 text")
            o_fl.addRow(_lb_t, tx_plain)
            _lb_tk = QLabel("文本键（可选）", content); _lb_tk.setToolTip("JSON 字段 textKey：走 strings 表时填")
            o_fl.addRow(_lb_tk, tked)
            # 拍级配音：与立绘/气泡锚不同，**必须逐拍可编**——各拍的配音必然各是一条，
            # 节点级默认在这里没有意义（继承只会让同一条声音每拍重播）。
            beat_voice = VoiceSpecField(
                content,
                model=self._project_model_getter() if self._project_model_getter else None,
                voice_raw=(beat or {}).get("voice") if isinstance(beat, dict) else None,
                advance_raw=(beat or {}).get("autoAdvance") if isinstance(beat, dict) else None,
                compact=True,
            )
            beat_voice.changed.connect(self._emit_changed)
            beat_voice_sec = CollapsibleSection(
                "配音（可选）",
                start_open=beat_voice.has_content(),
                parent=content,
            )
            beat_voice_sec.set_header_tool_tip(_GRAPH_VOICE_TIP)
            beat_voice_sec.add_body(beat_voice)
            o_fl.addRow(beat_voice_sec)

            def flip_collapse() -> None:
                row["collapsed"] = not row["collapsed"]
                content.setVisible(not row["collapsed"])
                toggle.setArrowType(
                    Qt.ArrowType.RightArrow if row["collapsed"] else Qt.ArrowType.DownArrow
                )

            toggle.clicked.connect(flip_collapse)
            tx_plain.textChanged.connect(update_summary)
            update_summary()

            def row_index() -> int:
                return beat_rows.index(row)

            def do_insert_before() -> None:
                insert_blank_beat_at(row_index())

            def do_insert_after() -> None:
                insert_blank_beat_at(row_index() + 1)

            def do_move_up() -> None:
                i = row_index()
                if i <= 0:
                    return
                beat_rows[i - 1], beat_rows[i] = beat_rows[i], beat_rows[i - 1]
                rebuild_beats_rows_layout()
                refresh_beat_nav_buttons()
                self._emit_structural_changed()

            def do_move_down() -> None:
                i = row_index()
                if i < 0 or i >= len(beat_rows) - 1:
                    return
                beat_rows[i + 1], beat_rows[i] = beat_rows[i], beat_rows[i + 1]
                rebuild_beats_rows_layout()
                refresh_beat_nav_buttons()
                self._emit_structural_changed()

            def do_delete() -> None:
                if len(beat_rows) <= 1:
                    QMessageBox.information(self, "多拍对白", "至少保留一句台词。")
                    return
                i = row_index()
                # 与其余五类同一套手感：有内容才二次确认。
                # 少了它，写满字的一句台词被 24px 图标误点一下就没了（Ctrl+Z 能救，
                # 但策划不一定知道、也不一定当场发现）。
                _txt = tx_plain.toPlainText().strip()
                if _txt:
                    r = QMessageBox.question(
                        self,
                        "删除台词",
                        f"确定删除第 {i} 句？\n\n{shorten(_txt, 40)}",
                        QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                        QMessageBox.StandardButton.Cancel,
                    )
                    if r != QMessageBox.StandardButton.Ok:
                        return
                beat_rows.pop(i)
                rows_layout.removeWidget(outer)
                outer.deleteLater()
                refresh_beat_nav_buttons()
                refresh_beat_fold_policy()
                self._emit_structural_changed()

            btn_ins_before.clicked.connect(do_insert_before)
            btn_ins_after.clicked.connect(do_insert_after)
            btn_up.clicked.connect(do_move_up)
            btn_down.clicked.connect(do_move_down)
            btn_del.clicked.connect(do_delete)

            ov.addLayout(header)
            ov.addWidget(content)
            content.setVisible(False)

            row.update(
                {
                    "outer": outer,
                    "toggle": toggle,
                    "content": content,
                    "kcb": kcb,
                    "exed": exed,
                    "tx_plain": tx_plain,
                    "tked": tked,
                    "btn_up": btn_up,
                    "btn_down": btn_down,
                    # 四个操作按钮都登记：护栏必须从按钮本身 click() 进（踩过一个 100% 抛异常的死按钮）
                    "btn_before": btn_ins_before,
                    "btn_after": btn_ins_after,
                    "btn_del": btn_del,
                    # 供「新拍继承上一拍说话人」读取，与 getter 用同一个 _ui_to_speaker
                    "speaker_getter": lambda: _ui_to_speaker(
                        kcb.currentData(), exed.text().strip()
                    ),
                    # 拍级头像 / 气泡锚无 UI（节点级选择器作各拍默认），但既有数据必须随行保真回写
                    "voice_field": beat_voice,
                    "portrait": copy.deepcopy((beat or {}).get("portrait"))
                    if isinstance(beat, dict)
                    else None,
                    "bubbleAnchorY": (beat or {}).get("bubbleAnchorY")
                    if isinstance(beat, dict)
                    else None,
                    "bubbleScale": (beat or {}).get("bubbleScale")
                    if isinstance(beat, dict)
                    else None,
                }
            )
            return row

        def _speaker_for_new_beat(pos: int) -> dict[str, Any]:
            """新拍继承前一拍（没有前一拍就用节点顶层）的说话人。

            旧实现写死 player：策划连着写一段 NPC 的话，每加一句都得手动改回 NPC，
            忘了改就是运行时说话人错、头像也跟着错。
            """
            ref = beat_rows[pos - 1] if 0 < pos <= len(beat_rows) else (
                beat_rows[0] if beat_rows else None
            )
            if ref is not None:
                sp = ref["speaker_getter"]() if callable(ref.get("speaker_getter")) else None
                if isinstance(sp, dict) and sp:
                    return copy.deepcopy(sp)
            base = data.get("speaker")
            return copy.deepcopy(base) if isinstance(base, dict) and base else {"kind": "player"}

        def insert_blank_beat_at(pos: int) -> None:
            nb = make_beat_block(
                {"speaker": _speaker_for_new_beat(pos), "text": "", "textKey": ""}
            )
            nb["collapsed"] = False  # 新加的这句直接展开，点完就能写
            pos = max(0, min(pos, len(beat_rows)))
            beat_rows.insert(pos, nb)
            rebuild_beats_rows_layout()
            refresh_beat_nav_buttons()
            refresh_beat_fold_policy()
            self._emit_structural_changed()

        if use_multi:
            for b in _lines_good:
                beat_rows.append(make_beat_block(b))
            _junk_lbl = _junk_notice(_lines_junk, "台词")
            if _junk_lbl is not None:
                _junk_lbl.setParent(self._body)
                self._body_layout.addWidget(_junk_lbl)
        else:
            beat_rows.append(
                make_beat_block(
                    {
                        "speaker": data.get("speaker") or {"kind": "player"},
                        "text": data.get("text", ""),
                        "textKey": data.get("textKey", ""),
                    }
                )
            )
        rebuild_beats_rows_layout()
        refresh_beat_nav_buttons()
        refresh_beat_fold_policy()

        bbar = QHBoxLayout()
        b_add_end = QPushButton("在末尾添加一句", self._body)
        b_add_end.setToolTip("在列表最后追加一条空白句")

        def do_add_end_beat() -> None:
            insert_blank_beat_at(len(beat_rows))

        b_add_end.clicked.connect(do_add_end_beat)
        bbar.addWidget(b_add_end)

        beats_v.addWidget(rows_wrap)
        beats_v.addLayout(bbar)

        sp = data.get("speaker") or {"kind": "player"}
        if not isinstance(sp, dict):
            sp = {"kind": "player"}
        kind, extra = _speaker_to_ui(sp)

        legacy_wrap = QWidget(self._body)
        kind_cb = QComboBox(legacy_wrap)
        for k in SpeakerKinds:
            kind_cb.addItem(SPEAKER_KIND_LABELS_ZH.get(k, k), k)
        idx = kind_cb.findData(kind)
        kind_cb.setCurrentIndex(max(0, idx))
        extra_edit = QLineEdit(extra, legacy_wrap)
        extra_npc_btn = self._make_npc_pick_button(extra_edit, "选择说话人 · sceneNpc")
        extra_row = QWidget(legacy_wrap)
        extra_row_lo = QHBoxLayout(extra_row)
        extra_row_lo.setContentsMargins(0, 0, 0, 0)
        extra_row_lo.addWidget(extra_edit, 1)
        extra_row_lo.addWidget(extra_npc_btn)
        text_edit = self._make_player_textedit(
            str(data.get("text", "")), "对白正文", min_lines=4, parent=legacy_wrap
        )
        text_key = QLineEdit(str(data.get("textKey", "")), legacy_wrap)
        text_key.setPlaceholderText("可选：strings 键")
        leg_l = QFormLayout(legacy_wrap)
        _form_wrap_rows(leg_l)
        _lbl_sk2 = QLabel("说话人", self._body)
        _lbl_sk2.setToolTip("JSON 字段 speaker.kind：玩家 / NPC / 旁白 / 场景 NPC")
        leg_l.addRow(_lbl_sk2, kind_cb)
        leg_l.addRow("名字 / npcId", extra_row)
        _lb_t2 = QLabel("台词", self._body); _lb_t2.setToolTip("JSON 字段 text")
        leg_l.addRow(_lb_t2, text_edit)
        _lb_tk2 = QLabel("文本键（可选）", self._body); _lb_tk2.setToolTip("JSON 字段 textKey")
        leg_l.addRow(_lb_tk2, text_key)
        # 单拍节点的配音写在节点顶层（多拍一律写在各拍上，节点级不作默认——
        # 各拍配音必然各是一条，继承只会让同一条声音每拍重播）。
        legacy_voice = VoiceSpecField(
            legacy_wrap,
            model=self._project_model_getter() if self._project_model_getter else None,
            voice_raw=data.get("voice"),
            advance_raw=data.get("autoAdvance"),
            compact=True,
        )
        legacy_voice.changed.connect(self._emit_changed)
        legacy_voice_sec = CollapsibleSection(
            "配音（可选）",
            start_open=legacy_voice.has_content(),
            parent=legacy_wrap,
        )
        legacy_voice_sec.set_header_tool_tip(_GRAPH_VOICE_TIP)
        legacy_voice_sec.add_body(legacy_voice)
        leg_l.addRow(legacy_voice_sec)

        def upd_extra_label():
            k = kind_cb.currentData()
            extra_row.setVisible(k in ("literal", "sceneNpc"))
            extra_npc_btn.setVisible(k == "sceneNpc")  # 仅 sceneNpc 才是 npcId 引用
            extra_edit.setPlaceholderText("显示名" if k == "literal" else "npcId")

        kind_cb.currentIndexChanged.connect(lambda _: (upd_extra_label(), self._emit_changed()))
        for w in (extra_edit, text_edit, text_key):
            w.textChanged.connect(self._emit_changed)
        upd_extra_label()

        next_edit = QLineEdit(str(data.get("next", "")), self._body)
        next_edit.setPlaceholderText("下一节点 id")
        pick = QPushButton("选…", self._body)
        pick.clicked.connect(lambda: self._pick_target(next_edit))
        next_edit.textChanged.connect(self._emit_changed)
        self._install_target_validation(next_edit)

        def toggle_multi():
            on = cb_multi.isChecked()
            legacy_wrap.setVisible(not on)
            beats_wrap.setVisible(on)
            self._emit_changed()

        def on_multi_toggled(checked: bool) -> None:
            # 取消多拍会丢弃已录入的多句台词：有多于一句时先确认（审查 P3-3）
            if not checked and len(beat_rows) > 1:
                r = QMessageBox.question(
                    self, "多拍对白",
                    f"取消多拍将只保留首句、丢弃其余 {len(beat_rows) - 1} 句台词。继续？",
                    QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                    QMessageBox.StandardButton.Cancel,
                )
                if r != QMessageBox.StandardButton.Ok:
                    cb_multi.blockSignals(True)
                    cb_multi.setChecked(True)
                    cb_multi.blockSignals(False)
                    return
            toggle_multi()

        cb_multi.toggled.connect(on_multi_toggled)
        toggle_multi()

        # —— 节点级头像（可选）：写 node.portrait；多拍模式下作各拍默认（拍级自带的覆盖之）。
        # 立绘集三态：（无头像）/ 跟随说话NPC（只写 emotion，运行时按 NPC.portraitSlug 解析）/ 显式集。
        FOLLOW_NPC = "@npc"
        POR_RAW = "@raw"  # 畸形 portrait（缺 emotion 等）走只读透传，不自动补首表情（审查 P3）
        por0 = data.get("portrait")
        por0 = por0 if isinstance(por0, dict) else None
        por_slug0 = str(por0.get("slug") or "").strip() if por0 else ""
        por_emo0 = str(por0.get("emotion") or "").strip() if por0 else ""
        # 数据里是 dict 但缺 emotion（表单表达不了）：原样透传，不吃键、不补值。
        por_raw_passthrough: dict[str, Any] | None = (
            copy.deepcopy(por0) if (por0 is not None and not por_emo0) else None
        )
        if por0 is not None and por_emo0 and not por_slug0:
            por_slug0 = FOLLOW_NPC  # 数据里 emotion-only = 跟随说话NPC

        por_wrap = QWidget(self._body)
        por_lo = QVBoxLayout(por_wrap)
        por_lo.setContentsMargins(0, 0, 0, 0)
        por_lo.setSpacing(3)
        slug_cb = QComboBox(por_wrap)
        slug_cb.addItem("（无头像）", "")
        slug_cb.addItem("跟随说话人", FOLLOW_NPC)
        for s in load_portrait_sets(self._project_root):
            slug_cb.addItem(s, s)
        if por_raw_passthrough is not None:
            _raw_lbl = por_slug0 if por_slug0 else "…"
            slug_cb.addItem(f"(数据) {_raw_lbl}", POR_RAW)
            slug_cb.setCurrentIndex(slug_cb.findData(POR_RAW))
        else:
            if por_slug0 and slug_cb.findData(por_slug0) < 0:
                # 数据里带了未知立绘集：保留可见可选，不静默清掉
                slug_cb.addItem(f"{por_slug0}（缺集）", por_slug0)
            slug_cb.setCurrentIndex(max(0, slug_cb.findData(por_slug0)))
        slug_cb.setToolTip(
            "立绘集（resources/runtime/images/dialogue_portraits/<slug>/）\n"
            "「跟随说话人」= 只存表情，运行时按说话人当前生效的装扮配置解析：\n"
            "  npc/sceneNpc → 该 NPC 配置的 portraitSlug（共享图自动跟人换脸）；\n"
            "  player → 主角当前装扮配置（game_config.playerAvatar / setPlayerAvatar 切换）。\n"
            "literal 说话人解析不到、不显头像。多拍模式下作各拍默认头像。"
        )
        emo_cb = QComboBox(por_wrap)
        emo_cb.setToolTip("表情；运行时按 <slug>_<emotion>.png 加载")
        # 注意：这个标签既显示立绘缩略图（setPixmap）又显示状态文字，**不能**换成
        # _ElidingLabel —— 那个重写了 paintEvent 只画文字，图会消失。文字靠折行收窄。
        por_preview = QLabel(por_wrap)
        por_preview.setWordWrap(True)
        por_preview.setFixedHeight(72)
        por_preview.setMinimumWidth(72)

        def _por_follow_resolved_slug() -> str:
            """「跟随说话人」在编辑器里的预览解析（尽力而为，解析不到不拦截）。"""
            k = kind_cb.currentData()
            if k == "player":
                return player_default_portrait_slug(self._project_root)
            if k == "sceneNpc":
                nid = extra_edit.text().strip()
                if nid and nid != "@contextNpc":
                    return npc_portrait_slug_index(self._project_root).get(nid, "")
            gid = (
                self._dialogue_graph_id_getter() if self._dialogue_graph_id_getter else ""
            )
            return graph_context_portrait_slug(self._project_root, gid or "")

        def _por_effective_slug() -> str:
            slug = str(slug_cb.currentData() or "")
            return _por_follow_resolved_slug() if slug == FOLLOW_NPC else slug

        def _por_refresh_emotions() -> None:
            picked = str(slug_cb.currentData() or "")
            eff = _por_effective_slug()
            want = str(emo_cb.currentData() or "") or por_emo0
            emo_cb.blockSignals(True)
            emo_cb.clear()
            if not picked or picked == POR_RAW:
                # 无头像 / 畸形透传：表情不可选，不自动补首表情（透传保原值）。
                emo_cb.setEnabled(False)
            else:
                emo_cb.setEnabled(True)
                pairs = (
                    load_portrait_emotions(self._project_root, eff)
                    if eff
                    else list(_PORTRAIT_EMOTIONS_FALLBACK)
                )
                for emo, label in pairs:
                    emo_cb.addItem(label, emo)
                if want and emo_cb.findData(want) < 0:
                    emo_cb.addItem(f"{want}（缺图）", want)
                idx = emo_cb.findData(want)
                emo_cb.setCurrentIndex(idx if idx >= 0 else 0)
            emo_cb.blockSignals(False)

        def _por_refresh_preview() -> None:
            picked = str(slug_cb.currentData() or "")
            eff = _por_effective_slug()
            emo = str(emo_cb.currentData() or "")
            if picked == POR_RAW:
                por_preview.setStyleSheet(app_theme.semantic_text_css("faint"))
                por_preview.setText("(数据) 透传")
                por_preview.setToolTip(
                    "该头像数据缺 emotion 等字段、表单无法编辑，已原样保留。\n"
                    "改选立绘集即可切回正常编辑。"
                )
                return
            if not picked or not emo:
                por_preview.clear()
                por_preview.setToolTip("")
                return
            if not eff:
                # 跟随NPC但当前上下文解析不到：运行时按实际挂载 NPC 解析，编辑器仅提示
                por_preview.setStyleSheet(app_theme.semantic_text_css("faint"))
                por_preview.setText("运行时按NPC解析")
                por_preview.setToolTip("说话 NPC 的 portraitSlug 在场景里配置")
                return
            p = portrait_image_path(self._project_root, eff, emo)
            por_preview.setToolTip(str(p))
            if p.is_file():
                pm = QPixmap(str(p))
                por_preview.setStyleSheet("")
                por_preview.setPixmap(
                    pm.scaledToHeight(72, Qt.TransformationMode.SmoothTransformation)
                )
            else:
                por_preview.setStyleSheet(app_theme.semantic_text_css("error"))
                por_preview.setText("缺图")

        slug_cb.currentIndexChanged.connect(
            lambda _i: (_por_refresh_emotions(), _por_refresh_preview(), self._emit_changed())
        )
        emo_cb.currentIndexChanged.connect(
            lambda _i: (_por_refresh_preview(), self._emit_changed())
        )
        # 说话人变化会影响「跟随NPC」的解析结果：跟随模式下联动刷新（不触发 changed，纯预览）
        kind_cb.currentIndexChanged.connect(
            lambda _i: (
                (_por_refresh_emotions(), _por_refresh_preview())
                if str(slug_cb.currentData() or "") == FOLLOW_NPC
                else None
            )
        )
        extra_edit.textChanged.connect(
            lambda _t: (
                (_por_refresh_emotions(), _por_refresh_preview())
                if str(slug_cb.currentData() or "") == FOLLOW_NPC
                else None
            )
        )
        _por_refresh_emotions()
        _por_refresh_preview()

        # 两个下拉一行、缩略图另起一行：三样挤一行的最小宽是 300px+，
        # 而检查器面板默认只有 280px（挤爆之后整块横向滚动）。
        _por_row1 = QHBoxLayout()
        _por_row1.setContentsMargins(0, 0, 0, 0)
        _por_row1.addWidget(slug_cb, 2)
        _por_row1.addWidget(emo_cb, 1)
        _por_row2 = QHBoxLayout()
        _por_row2.setContentsMargins(0, 0, 0, 0)
        _por_row2.addWidget(por_preview)
        _por_row2.addStretch(1)
        por_lo.addLayout(_por_row1)
        por_lo.addLayout(_por_row2)
        flp = QFormLayout()
        _form_wrap_rows(flp)
        flp.addRow("头像（可选）", por_wrap)

        # —— 说话气泡头顶锚（可选）：写 node.bubbleAnchorY；多拍模式下作各拍默认。
        # 不勾「覆盖」= 不写键，运行时按说话实体当前帧内容自动算（绝大多数情况用这个就对）。
        bub_field = BubbleAnchorPickField(
            self._body,
            self._project_model_getter() if self._project_model_getter else None,
            data.get("bubbleAnchorY"),
            lambda: actor_for_dialogue_speaker(
                self._project_model_getter() if self._project_model_getter else None,
                str(kind_cb.currentData() or ""),
                extra_edit.text(),
                self._dialogue_graph_id_getter() if self._dialogue_graph_id_getter else "",
            ),
            committed_scale=data.get("bubbleScale"),
        )
        bub_field.changed.connect(self._emit_changed)
        # 换说话人 = 换预览对象（纯预览刷新，不改数据、不触发 changed）
        kind_cb.currentIndexChanged.connect(lambda _i: bub_field.refresh_actor())
        extra_edit.textChanged.connect(lambda _t: bub_field.refresh_actor())
        # 重块默认折叠（布局纪律）：绝大多数行不需要动锚点，展开才占位
        bub_sec = CollapsibleSection("说话气泡位置（可选）", start_open=False, parent=self._body)
        bub_sec.set_header_tool_tip(
            "说话时角色头顶那个「…」气泡挂在哪。\n"
            "默认继承——按说话人当前帧的可见内容自动贴头顶（蹲/躺也跟着降）。\n"
            "只有个别情况（举着道具、背着东西挡住）才需要勾「覆盖」手调。",
        )
        bub_sec.add_body(bub_field)
        flp.addRow(bub_sec)
        if data.get("bubbleAnchorY") is not None or data.get("bubbleScale") is not None:
            bub_sec.set_expanded(True)   # 已经调过的行，一打开就看得见

        def collect_portrait() -> dict[str, Any] | None:
            slug = str(slug_cb.currentData() or "").strip()
            if slug == POR_RAW:
                # 畸形形状原样透传（不吃键、不补首表情，审查 P3）
                return copy.deepcopy(por_raw_passthrough) if por_raw_passthrough is not None else None
            emo = str(emo_cb.currentData() or "").strip()
            if not slug or not emo:
                return None
            if slug == FOLLOW_NPC:
                return {"emotion": emo}
            return {"slug": slug, "emotion": emo}

        row_n = QHBoxLayout()
        row_n.addWidget(next_edit)
        row_n.addWidget(pick)
        fln = QFormLayout()
        _form_wrap_rows(fln)
        _lbl_n2 = QLabel("去哪", self._body)
        _lbl_n2.setToolTip("JSON 字段 next：这一步演完之后跳到哪个节点")
        fln.addRow(_lbl_n2, row_n)

        self._body_layout.addWidget(cb_multi)
        self._body_layout.addWidget(legacy_wrap)
        self._body_layout.addWidget(beats_wrap)
        self._body_layout.addLayout(flp)
        self._body_layout.addLayout(fln)
        # 多拍的行也登记进来：护栏要从按钮本身 click() 进，
        # 不暴露就等于这条路径从来没被自动化测过（这次就是这么漏掉确认框的）。
        self._topology_refs = {
            "type": "line",
            "next_edit": next_edit,
            "beat_rows": beat_rows,
        }

        def collect_beats() -> list[dict[str, Any]]:
            out_beats: list[dict[str, Any]] = []
            for r in beat_rows:
                kcb = r["kcb"]
                exed = r["exed"]
                tx_plain = r["tx_plain"]
                tked = r["tked"]
                # tx_plain 可能是 RichTextTextEdit（富文本）或 QPlainTextEdit（无 pm 退回），
                # 二者都提供 toPlainText；用 duck-type 判断，避免误跳过整拍导致丢词。
                if (
                    not isinstance(kcb, QComboBox)
                    or not isinstance(exed, QLineEdit)
                    or not hasattr(tx_plain, "toPlainText")
                    or not isinstance(tked, QLineEdit)
                ):
                    continue
                kk = kcb.currentData()
                ex = exed.text().strip()
                b = {"speaker": _ui_to_speaker(kk, ex)}
                b["text"] = tx_plain.toPlainText()
                tk = tked.text().strip()
                if tk:
                    b["textKey"] = tk
                if r.get("portrait") is not None:
                    b["portrait"] = copy.deepcopy(r["portrait"])
                if r.get("bubbleAnchorY") is not None:
                    b["bubbleAnchorY"] = r["bubbleAnchorY"]
                if r.get("bubbleScale") is not None:
                    b["bubbleScale"] = r["bubbleScale"]
                vf = r.get("voice_field")
                if vf is not None:
                    vf.apply_to(b)
                out_beats.append(b)
            return out_beats

        # 多拍模式下，顶层 speaker/text/textKey 只是 lines[0] 的镜像（运行时取 lines[0]）。
        # 为「数据零改写」，原文件若已带这些顶层字段则原样保留，不用 lines[0] 覆盖。
        _orig_has_text = "text" in data
        _orig_text = data.get("text")
        _orig_has_text_key = "textKey" in data
        _orig_text_key = data.get("textKey")
        _orig_has_speaker = "speaker" in data
        _orig_speaker = copy.deepcopy(data.get("speaker"))
        _orig_empty_lines = isinstance(data.get("lines"), list) and not data.get("lines")

        def getter():
            nxt = next_edit.text().strip()
            if cb_multi.isChecked():
                beats = collect_beats()
                # getter 绝不抛异常：它一抛，本节点的编辑就整段进不了模型且不标脏，
                # 关窗口都不提示（审查 2026-08-06 P0-1 同源）。空 lines 由
                # graph_document._validate_line_beats 报 error。
                first = beats[0] if beats else {}
                out: dict[str, Any] = {
                    "type": "line",
                    "speaker": copy.deepcopy(_orig_speaker)
                    if _orig_has_speaker
                    else (first.get("speaker") or {"kind": "player"}),
                    "next": nxt,
                    "lines": _reinsert_junk(beats, _lines_junk),
                }
                if _orig_has_text:
                    out["text"] = _orig_text
                else:
                    out["text"] = first.get("text", "")
                if _orig_has_text_key:
                    out["textKey"] = _orig_text_key
                # 原本无顶层 textKey 就不注入：beat0 的 textKey 属于 lines[0]，
                # 运行时取 lines[0]，不镜像到顶层（否则往返平白多出一个 textKey 键）。
                por = collect_portrait()
                if por is not None:
                    out["portrait"] = por
                bay = bub_field.value()
                if bay is not None:
                    out["bubbleAnchorY"] = bay
                bsc = bub_field.scale_value()
                if bsc is not None:
                    out["bubbleScale"] = bsc
                # 多拍：配音只在各拍上（顶层不写，避免"节点级默认"这个会重播的错觉）
                return out
            k = kind_cb.currentData()
            ex = extra_edit.text().strip()
            out = {
                "type": "line",
                "speaker": _ui_to_speaker(k, ex),
                "next": nxt,
            }
            out["text"] = text_edit.toPlainText()
            tk = text_key.text().strip()
            if tk:
                out["textKey"] = tk
            # 磁盘上原本就有 lines:[]（空数组）时忠实回写这个键——表单形状保真，
            # 不因「单拍模式」顺手删键（校验器会另行报 error，那是它的事）。
            if _orig_empty_lines:
                out["lines"] = []
            por = collect_portrait()
            if por is not None:
                out["portrait"] = por
            bay = bub_field.value()
            if bay is not None:
                out["bubbleAnchorY"] = bay
            bsc = bub_field.scale_value()
            if bsc is not None:
                out["bubbleScale"] = bsc
            legacy_voice.apply_to(out)
            return out

        self._getter = getter

    # --- runActions ---
    def _build_run_actions(self, data: dict[str, Any]):
        from tools.editor.shared.action_editor import ActionEditor

        acts, acts_junk = _split_dict_items(data.get("actions"))
        next_edit = QLineEdit(str(data.get("next", "")), self._body)
        pick = QPushButton("选…", self._body)
        pick.clicked.connect(lambda: self._pick_target(next_edit))
        next_edit.textChanged.connect(self._emit_changed)
        self._install_target_validation(next_edit)

        fl = QFormLayout()
        _form_wrap_rows(fl)
        row = QHBoxLayout()
        row.addWidget(next_edit)
        row.addWidget(pick)
        _lbl_next = QLabel("去哪", self._body)
        _lbl_next.setToolTip("JSON 字段 next：这一步演完之后跳到哪个节点")
        fl.addRow(_lbl_next, row)
        self._body_layout.addLayout(fl)

        pm = self._project_model_getter() if self._project_model_getter else None
        # parent=self._body：让 ae 的 parent 链一开始就落在 inspector 的可见子树内；
        # 先 addWidget 再 set_data，避免 row 构造时父 widget 还未挂到布局里短暂成为 orphan。
        ae = ActionEditor(
            "动作",
            self._body,
            show_reorder_buttons=True,
        )
        ae.set_project_context(pm, None)
        self._body_layout.addWidget(ae)
        # 不再为空 actions 注入占位 setFlag——否则「空 runActions」打开即被改写成 1 条动作。
        # 空列表交给 ActionEditor 展示「+ 添加」入口，getter 原样回写 []。
        ae.set_data(list(acts))
        _junk_lbl = _junk_notice(acts_junk, "动作")
        if _junk_lbl is not None:
            _junk_lbl.setParent(self._body)
            self._body_layout.addWidget(_junk_lbl)
        ae.changed.connect(self._emit_changed)
        self._install_private_signal_marks(ae)
        self._topology_refs = {"type": "runActions", "next_edit": next_edit}

        def getter():
            return {
                "type": "runActions",
                "actions": _reinsert_junk(ae.to_list(), acts_junk),
                "next": next_edit.text().strip(),
            }

        self._getter = getter

    def _install_private_signal_marks(self, ae) -> None:
        """让这棵动作树上的私有信号一直带着标记（含之后新加的行）。

        私有作用域读的是 narrative_graphs.signals 的登记（与运行时投递判据、校验器
        ``validatePrivateSignalListeners`` 同一处口径），所以每轮现取——工程改了登记，
        下一次编辑动作就跟上，不留一份会漂的快照。
        """
        def refresh() -> None:
            model = self._project_model_getter() if self._project_model_getter else None
            private_ids = collect_private_signal_ids(getattr(model, "narrative_graphs", None))
            mark_private_signal_fields(ae, private_ids)

        ae.changed.connect(refresh)
        refresh()

    @staticmethod
    def _set_combo_current_data(cb: QComboBox, value: str) -> None:
        val = (value or "").strip()
        idx = cb.findData(val)
        if idx >= 0:
            cb.setCurrentIndex(idx)
        elif val:
            cb.insertItem(1, f"{val}（资源扫描未收录，请核对或补全数据后重选）", val)
            cb.setCurrentIndex(1)
        else:
            cb.setCurrentIndex(0)

    @staticmethod
    def _make_cost_coins_spin(on_change, parent: QWidget | None = None) -> QSpinBox:
        sp = QSpinBox(parent)
        sp.setRange(-1, 9_999_999)
        sp.setSingleStep(1)
        sp.setSpecialValueText("无（不校验铜钱）")
        sp.setValue(-1)
        sp.setToolTip(
            "运行时与 flagStore 中的 coins 比较；仅当玩家持有不少于该数额时才可选。"
            "选「无」不写 costCoins 字段。"
        )
        sp.valueChanged.connect(on_change)
        return sp

    @staticmethod
    def _set_cost_coins_spin(sp: QSpinBox, raw_val: object) -> None:
        if raw_val is None or raw_val == "":
            sp.setValue(-1)
            return
        try:
            n = int(raw_val)
        except (TypeError, ValueError):
            sp.setValue(-1)
            return
        if n < 0:
            sp.setValue(-1)
        else:
            sp.setValue(min(n, sp.maximum()))

    # --- choice ---
    def _build_choice(self, data: dict[str, Any]):
        # options 不是数组（null / 字符串 / 对象等被写坏的值）→ 走只读原样透传，
        # 与「节点值不是对象」「未知 type」两处同一口径：编辑器不当场把坏值抹成 []，
        # 否则磁盘上的原始证据被吃掉、之后再也查不出原来写的是什么。由校验层报 error。
        if "options" in data and not isinstance(data.get("options"), list):
            bad = data.get("options")
            self._body_layout.addWidget(
                QLabel(
                    f"该 choice 节点的 options 不是数组（实际为 {type(bad).__name__}），"
                    "无法用表单编辑。\n"
                    "内容已原样保留、不会被改写；校验面板会把它列为错误，"
                    "请在数据文件里改成数组后再回来编辑。",
                    self._body,
                )
            )
            snap = copy.deepcopy(data)
            self._getter = lambda s=snap: copy.deepcopy(s)
            return
        # promptLine optional
        pl = data.get("promptLine")
        has_pl = isinstance(pl, dict) and bool(pl)
        cb_pl = QCheckBox("选项前先播一行", self._body)
        cb_pl.setToolTip("勾上以后，弹选项之前先播一句话（存为 promptLine）。")
        cb_pl.setChecked(bool(has_pl))
        prompt_box = QGroupBox("选项前先播的一行", self._body)

        sp = (pl or {}).get("speaker") if has_pl else {"kind": "player"}
        if not isinstance(sp, dict):
            sp = {"kind": "player"}
        kind, extra = _speaker_to_ui(sp)
        pl_kind = QComboBox(prompt_box)
        for k in SpeakerKinds:
            pl_kind.addItem(SPEAKER_KIND_LABELS_ZH.get(k, k), k)
        pl_kind.setCurrentIndex(max(0, pl_kind.findData(kind)))
        pl_extra_stack = QStackedWidget(prompt_box)
        pl_extra_line = QLineEdit(prompt_box)
        pl_npc_wrap = QWidget(prompt_box)
        pl_npc_lo = QHBoxLayout(pl_npc_wrap)
        pl_npc_lo.setContentsMargins(0, 0, 0, 0)
        pl_npc_edit = QLineEdit(pl_npc_wrap)
        pl_npc_edit.setPlaceholderText("手输 npcId或点「选…」在对话框中搜索")
        pl_npc_edit.setToolTip(
            "可手输任意 npcId。\n"
            f"点「选…」打开可搜索列表（含「{PROMPT_LINE_SCENE_NPC_CONTEXT_TOKEN}」=进入图时传入的 npcId）。"
        )
        pl_npc_btn = QPushButton("选…", pl_npc_wrap)
        pl_npc_btn.setToolTip("打开可搜索的 NPC 列表")
        pl_npc_lo.addWidget(pl_npc_edit, 1)
        pl_npc_lo.addWidget(pl_npc_btn)
        if kind == "literal":
            pl_extra_line.setText(extra)
        elif kind == "sceneNpc":
            pl_npc_edit.setText(extra)
        pl_extra_stack.addWidget(pl_extra_line)
        pl_extra_stack.addWidget(pl_npc_wrap)
        if kind == "literal":
            pl_extra_stack.setCurrentWidget(pl_extra_line)
        else:
            pl_extra_stack.setCurrentWidget(pl_npc_wrap)

        def _pl_npc_entries() -> list[tuple[str, str]]:
            ent: list[tuple[str, str]] = [
                (
                    PROMPT_LINE_SCENE_NPC_CONTEXT_TOKEN,
                    "当前对话 NPC（进入图时的 npcId）",
                )
            ]
            pm_pl = self._project_model_getter() if self._project_model_getter else None
            if pm_pl:
                ent.extend(pm_pl.all_npc_ids_global())
            return ent

        def _open_pl_npc_picker() -> None:
            dlg = NpcPickerDialog(
                _pl_npc_entries(),
                title="选择 promptLine · sceneNpc",
                initial_id=pl_npc_edit.text().strip(),
                parent=self,
            )
            if dlg.exec() == QDialog.DialogCode.Accepted:
                pl_npc_edit.setText(dlg.selected_id())
                self._emit_changed()

        pl_npc_btn.clicked.connect(_open_pl_npc_picker)
        pl_extra_lbl = QLabel(prompt_box)
        pl_text = self._make_player_textedit(
            str((pl or {}).get("text", "")), "选项前多播一行对白", min_lines=2, parent=prompt_box
        )
        pl_text_key = QLineEdit(str((pl or {}).get("textKey", "") or ""), prompt_box)
        pl_text_key.setPlaceholderText("可选：strings 键")
        pl_text_key.textChanged.connect(self._emit_changed)
        pl_portrait = PortraitRefField(self._project_root, (pl or {}).get("portrait"), prompt_box)
        pl_portrait.changed.connect(self._emit_changed)

        pfl = QFormLayout()
        _form_wrap_rows(pfl)
        _lb_k = QLabel("说话人", prompt_box); _lb_k.setToolTip("JSON 字段 speaker.kind")
        pfl.addRow(_lb_k, pl_kind)
        pfl.addRow(pl_extra_lbl, pl_extra_stack)
        _lb_pt = QLabel("台词", prompt_box); _lb_pt.setToolTip("JSON 字段 text")
        pfl.addRow(_lb_pt, pl_text)
        _lb_ptk = QLabel("文本键（可选）", prompt_box); _lb_ptk.setToolTip("JSON 字段 textKey")
        pfl.addRow(_lb_ptk, pl_text_key)
        pfl.addRow("立绘（可选）", pl_portrait)
        # promptLine 也是一拍台词：配音语义与 line 拍完全一致
        pl_voice = VoiceSpecField(
            prompt_box,
            model=self._project_model_getter() if self._project_model_getter else None,
            voice_raw=(pl or {}).get("voice"),
            advance_raw=(pl or {}).get("autoAdvance"),
            compact=True,
        )
        pl_voice.changed.connect(self._emit_changed)
        pl_voice_sec = CollapsibleSection(
            "配音（可选）",
            start_open=pl_voice.has_content(),
            parent=prompt_box,
        )
        pl_voice_sec.set_header_tool_tip(_GRAPH_VOICE_TIP)
        pl_voice_sec.add_body(pl_voice)
        pfl.addRow(pl_voice_sec)
        prompt_box.setLayout(pfl)
        prompt_box.setVisible(has_pl)

        def pl_refresh_extra_row(_i: int = -1) -> None:
            del _i
            kk = pl_kind.currentData()
            if kk == "literal":
                pl_extra_lbl.setText("显示名（literal）")
                pl_extra_stack.setCurrentWidget(pl_extra_line)
                pl_extra_stack.setVisible(True)
            elif kk == "sceneNpc":
                pl_extra_lbl.setText("npcId（sceneNpc）")
                pl_extra_stack.setCurrentWidget(pl_npc_wrap)
                pl_extra_stack.setVisible(True)
            else:
                pl_extra_stack.setVisible(False)

        pl_refresh_extra_row()

        def toggle_pl():
            prompt_box.setVisible(cb_pl.isChecked())
            self._emit_changed()

        cb_pl.toggled.connect(toggle_pl)
        pl_kind.currentIndexChanged.connect(
            lambda _i: (pl_refresh_extra_row(_i), self._emit_changed())
        )
        pl_extra_line.textChanged.connect(self._emit_changed)
        pl_npc_edit.textChanged.connect(self._emit_changed)
        pl_text.textChanged.connect(self._emit_changed)

        self._body_layout.addWidget(cb_pl)
        self._body_layout.addWidget(prompt_box)

        opts, opts_junk = _split_dict_items(data.get("options"))
        rows_wrap = QWidget(self._body)
        rows_layout = QVBoxLayout(rows_wrap)
        rows_layout.setContentsMargins(0, 0, 0, 0)
        option_rows: list[dict[str, Any]] = []
        rule_pairs = load_rule_id_name_pairs(self._project_root)

        def refresh_choice_nav_buttons() -> None:
            n = len(option_rows)
            for i, r in enumerate(option_rows):
                r["btn_up"].setEnabled(i > 0)
                r["btn_down"].setEnabled(i < n - 1)

        def refresh_choice_fold_policy() -> None:
            """按各选项**自己**的折叠状态刷新（与 switch 分支同一套规矩）。

            旧实现每次增删选项都把所有选项强制折回去：策划展开第 2 个选项改到一半、
            点一下「添加选项」，正在编辑的那条被折上、滚动位置没了，新加的那条也是
            折叠的——视觉上「点了没反应」。
            """
            if len(option_rows) == 1:
                option_rows[0]["collapsed"] = False
            for r in option_rows:
                t = r.get("toggle")
                c = r.get("content")
                if t is None or c is None:
                    continue
                collapsed = bool(r.get("collapsed"))
                t.setVisible(True)
                c.setVisible(not collapsed)
                t.setArrowType(
                    Qt.ArrowType.RightArrow if collapsed else Qt.ArrowType.DownArrow
                )

        # 空选项提示控件在下面 make_option_block 之后才建得出来，这里先留个占位引用。
        _choice_hint_ref: dict[str, Any] = {"w": None}

        def rebuild_choice_rows_layout() -> None:
            while rows_layout.count():
                it = rows_layout.takeAt(0)
                w = it.widget()
                if w is not None:
                    w.setParent(None)
            for r in option_rows:
                rows_layout.addWidget(r["outer"])
            hint = _choice_hint_ref.get("w")
            if hint is not None:
                rows_layout.addWidget(hint)
                hint.setVisible(not option_rows)
            for r in option_rows:  # 序号依赖行位置，结构变了要重刷标题
                fn = r.get("refresh_summary")
                if callable(fn):
                    fn()

        def make_option_block(od: dict[str, Any]) -> dict[str, Any]:
            row: dict[str, Any] = {"collapsed": True}
            outer = QWidget(rows_wrap)
            ov = QVBoxLayout(outer)
            ov.setContentsMargins(0, 0, 0, 0)
            ov.setSpacing(4)

            header = QVBoxLayout()
            toggle = QToolButton(outer)
            toggle.setAutoRaise(True)
            toggle.setArrowType(Qt.ArrowType.RightArrow)
            toggle.setToolTip("折叠 / 展开本条详细表单（在本行右键可插入 / 移动 / 删除）")
            # 摘要必须可省略：普通 QLabel 的最小宽度 = 整段文本宽度，会把这一行连同
            # 右侧的操作按钮一起顶出 280px 面板（见 _ElidingLabel 注释）。
            summary = _ElidingLabel("", outer)
            summary.setStyleSheet(app_theme.semantic_text_css("muted"))

            btn_ins_before, btn_ins_after, btn_up, btn_down, btn_del = (
                _compact_row_nav_buttons(
                    outer,
                    tip_before="在此选项之前插入一条空白选项",
                    tip_after="在此选项之后插入一条空白选项",
                    tip_up="整条选项上移",
                    tip_down="整条选项下移",
                    tip_del="删除此选项（可以删空，校验面板会提醒）",
                )
            )

            _fill_stacked_row_header(
                header,
                toggle,
                summary,
                (btn_ins_before, btn_ins_after, btn_up, btn_down, btn_del),
            )

            content = QWidget(outer)
            o_fl = QFormLayout(content)
            _form_wrap_rows(o_fl)
            id_e = QLineEdit(str(od.get("id", "")), content)
            text_e = self._make_player_textedit(
                str(od.get("text", "")), "玩家看到的选项文字", min_lines=2, parent=content
            )
            nx = QLineEdit(str(od.get("next", "")), content)
            pick = QPushButton("选…", content)
            pick.clicked.connect(lambda _c=False, le=nx: self._pick_target(le))
            self._install_target_validation(nx)
            nx_lo = QHBoxLayout()
            nx_lo.addWidget(nx, 1)
            nx_lo.addWidget(pick)

            rf_wrap = QWidget(content)
            rf_lo = QHBoxLayout(rf_wrap)
            rf_lo.setContentsMargins(0, 0, 0, 0)
            rf_edit = QLineEdit(str(od.get("requireFlag", "") or ""), rf_wrap)
            rf_edit.setReadOnly(True)
            rf_edit.setPlaceholderText(
                "（无）点「选择…」打开登记表（与主编辑器 Flag 选择器相同）"
            )
            rf_edit.setToolTip("仅当 flagStore 中该键为真时选项可选；须从登记表选取以保证键名一致。")
            rf_pick = QPushButton("选…", rf_wrap)
            rf_clear = QPushButton("清除", rf_wrap)

            def do_pick_rf() -> None:
                getter = self._project_model_getter
                pm = getter() if getter else None
                if pm is None:
                    QMessageBox.warning(
                        self,
                        "requireFlag",
                        "无法加载工程 ProjectModel。\n"
                        "请从游戏工程根目录启动图对话编辑器（与 public/assets 同级），并确保可导入 tools.editor。\n"
                        "框内仍会显示 JSON 里已有的键（只读）。",
                    )
                    return
                from tools.editor.shared.flag_picker_dialog import FlagPickerDialog
                from tools.editor.flag_registry import registry_value_type_for_key

                dlg = FlagPickerDialog(pm, None, rf_edit.text().strip(), self)
                if dlg.exec() != QDialog.DialogCode.Accepted:
                    return
                k = dlg.selected_key().strip()
                rf_edit.setText(k)
                if k:
                    reg_type = registry_value_type_for_key(k, pm.flag_registry)
                    if reg_type is not None and reg_type != "bool":
                        QMessageBox.warning(
                            self,
                            "requireFlag 类型提示",
                            f"登记表中「{k}」的值类型为「{reg_type}」；"
                            "本选项仅按布尔真值判断 flagStore 是否满足。\n\n"
                            "请确认设计意图；仅提示，不阻止保存。",
                        )
                self._emit_changed()

            def do_clear_rf() -> None:
                if rf_edit.text():
                    rf_edit.setText("")
                    self._emit_changed()

            rf_pick.clicked.connect(do_pick_rf)
            rf_clear.clicked.connect(do_clear_rf)
            rf_lo.addWidget(rf_edit, 1)
            rf_lo.addWidget(rf_pick)
            rf_lo.addWidget(rf_clear)

            cost_sp = self._make_cost_coins_spin(self._emit_changed, content)
            self._set_cost_coins_spin(cost_sp, od.get("costCoins"))

            from tools.editor.shared.action_editor import FilterableTypeCombo

            rh_entries: list[tuple[str, str]] = [
                ("(无：不标规矩样式)", ""),
            ]
            for rid, rname in rule_pairs:
                rh_entries.append((f"{rname}（{rid}）", rid))
            # select_only=True：不让 editable 模式在构造时触发 QComboBoxPrivateContainer 顶层闪烁。
            rh_cb = FilterableTypeCombo(rh_entries, content, select_only=True)
            rh_cb.setToolTip(
                "对话 UI 上「规矩」标签与配色；与 requireFlag 是否满足无关。\n"
                "若下方「灰显点击提示」留空，锁定时会用 strings 中 choiceNeedRule 并结合该规矩名称生成说明。"
            )
            rh_cb.set_committed_type(str(od.get("ruleHintId", "") or ""))
            rh_cb.typeCommitted.connect(lambda _t: self._emit_changed())

            hint_plain = self._make_player_textedit(
                str(od.get("disabledClickHint", "") or ""),
                "可选。选项灰显时玩家点击后弹出此处全文；留空则由游戏按规矩名/铜钱等自动生成。",
                min_lines=2,
                parent=content,
            )
            hint_plain.textChanged.connect(self._emit_changed)

            o_fl.addRow("选项 id", id_e)
            o_fl.addRow("选项文案", text_e)
            wnx = QWidget(content)
            wnx.setLayout(nx_lo)
            _lbl_on = QLabel("去哪", content)
            _lbl_on.setToolTip("JSON 字段 next：选这条之后跳到哪个节点")
            o_fl.addRow(_lbl_on, wnx)
            _lbl_rf = QLabel("前提标志", content); _lbl_rf.setToolTip("JSON 字段 requireFlag：这个标志为真时本选项才可选")
            o_fl.addRow(_lbl_rf, rf_wrap)
            _lbl_cost = QLabel("花费铜钱", content); _lbl_cost.setToolTip("JSON 字段 costCoins：选这条要扣的铜钱")
            o_fl.addRow(_lbl_cost, cost_sp)
            _lbl_rh = QLabel("关联规矩", content); _lbl_rh.setToolTip("JSON 字段 ruleHintId：给这条选项标上规矩样式")
            o_fl.addRow(_lbl_rh, rh_cb)
            _lbl_hint = QLabel("灰显点击提示", content); _lbl_hint.setToolTip("JSON 字段 disabledClickHint：选项不可选时，玩家点它弹出的说明")
            o_fl.addRow(_lbl_hint, hint_plain)

            # 标题只留名字：QGroupBox 的最小宽度含标题全宽，一句说明写在标题里
            # 就把整块顶到 470px+，直接顶爆 280px 面板（说明进 tooltip，norms 布局纪律）。
            req_g = QGroupBox("附加条件（可选）", content)
            req_g.setToolTip(
                "JSON 字段 requireCondition：比「前提标志」更复杂的条件（任一 / 否定 / 嵌套）。\n"
                "与「前提标志」同时填时，两个都满足才可选。"
            )
            rg_l = QVBoxLayout(req_g)

            def _pm_get() -> Any:
                return self._project_model_getter() if self._project_model_getter else None

            req_tree = ConditionExprTreeRootWidget(req_g, model_getter=_pm_get)
            rc0 = od.get("requireCondition")
            if isinstance(rc0, dict):
                req_tree.set_expr(rc0)
            else:
                req_tree.set_expr(None)
            req_tree.changed.connect(self._emit_changed)
            rg_l.addWidget(req_tree)
            o_fl.addRow(req_g)

            def _opt_data_index() -> int:
                """本行在数据数组里的下标（坏元素不占行但占下标，口径同 switch）。"""
                try:
                    row_i = option_rows.index(row)
                except ValueError:
                    return -1
                mapping = _row_data_indices(len(option_rows), opts_junk)
                return mapping[row_i] if row_i < len(mapping) else -1

            def update_summary() -> None:
                # 摘要给「文案 → 去哪」而不是「id · 文案」：折叠列表是用来一眼看出
                # 每条选项通向哪的，而 id 是技术字段、策划不关心（降级进 tooltip）。
                tx = text_e.toPlainText().strip().replace("\n", " ")
                if len(tx) > 30:
                    tx = tx[:27] + "…"
                if not tx:
                    tx = "（未填文案）"
                nx_v = nx.text().strip() or "（未填 next）"
                idx = _opt_data_index()
                prefix = f"{idx}. " if idx >= 0 else ""
                summary.setText(f"{prefix}{tx}  →  {nx_v}")
                summary.setToolTip(
                    f"选项 id：{id_e.text().strip() or '(未填)'}\n"
                    f"文案：{text_e.toPlainText().strip() or '(未填)'}\n"
                    f"去哪：{nx.text().strip() or '(未填)'}"
                )

            def flip_collapse() -> None:
                row["collapsed"] = not row["collapsed"]
                content.setVisible(not row["collapsed"])
                toggle.setArrowType(
                    Qt.ArrowType.RightArrow if row["collapsed"] else Qt.ArrowType.DownArrow
                )

            toggle.clicked.connect(flip_collapse)
            id_e.textChanged.connect(update_summary)
            text_e.textChanged.connect(update_summary)
            # 摘要里现在有「去哪」，next 变了标题必须跟着变（否则画布拉完线，
            # 折叠列表还显示旧目标）。
            nx.textChanged.connect(lambda _t: update_summary())
            id_e.textChanged.connect(self._emit_changed)
            nx.textChanged.connect(self._emit_changed)
            text_e.textChanged.connect(self._emit_changed)
            update_summary()

            def row_index() -> int:
                return option_rows.index(row)

            def do_insert_before() -> None:
                insert_blank_option_at(row_index())

            def do_insert_after() -> None:
                insert_blank_option_at(row_index() + 1)

            def do_move_up() -> None:
                i = row_index()
                if i <= 0:
                    return
                option_rows[i - 1], option_rows[i] = option_rows[i], option_rows[i - 1]
                rebuild_choice_rows_layout()
                refresh_choice_nav_buttons()
                self._emit_structural_changed()

            def do_move_down() -> None:
                i = row_index()
                if i < 0 or i >= len(option_rows) - 1:
                    return
                option_rows[i + 1], option_rows[i] = option_rows[i], option_rows[i + 1]
                rebuild_choice_rows_layout()
                refresh_choice_nav_buttons()
                self._emit_structural_changed()

            def do_delete() -> None:
                # 与 switch 分支删除同一套手感：有内容才二次确认，且允许删空
                # （空 choice 由校验面板报 error，不用在这里硬拦）。
                i = row_index()
                label = text_e.toPlainText().strip() or id_e.text().strip()
                if label:
                    r = QMessageBox.question(
                        self,
                        "删除选项",
                        # 与 switch 分支同口径：带上数据下标，与摘要/画布/校验一致。
                        f"确定删除选项 {_opt_data_index()}？\n\n{shorten(label, 40)}",
                        QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                        QMessageBox.StandardButton.Cancel,
                    )
                    if r != QMessageBox.StandardButton.Ok:
                        return
                option_rows.pop(i)
                outer.setParent(None)
                outer.deleteLater()
                rebuild_choice_rows_layout()  # 同 switch：空状态提示 + 序号都靠它刷新
                refresh_choice_nav_buttons()
                refresh_choice_fold_policy()
                self._emit_structural_changed()

            btn_ins_before.clicked.connect(do_insert_before)
            btn_ins_after.clicked.connect(do_insert_after)
            btn_up.clicked.connect(do_move_up)
            btn_down.clicked.connect(do_move_down)
            btn_del.clicked.connect(do_delete)

            ov.addLayout(header)
            ov.addWidget(content)
            content.setVisible(False)

            row.update(
                {
                    "outer": outer,
                    "toggle": toggle,
                    "content": content,
                    "id_e": id_e,
                    # 原本有没有 id 键：没有且用户也没填就不注入 `"id": ""`
                    # （凭空注入会顺带凭空多出一条校验 error，还把文件标脏）。
                    "orig_has_id": isinstance(od, dict) and "id" in od,
                    "data_index": _opt_data_index,
                    "summary_label": summary,
                    "refresh_summary": update_summary,
                    "text_e": text_e,
                    "nx": nx,
                    "rf_edit": rf_edit,
                    "req_tree": req_tree,
                    "cost_sp": cost_sp,
                    "rh_cb": rh_cb,
                    "hint_plain": hint_plain,
                    "btn_up": btn_up,
                    "btn_down": btn_down,
                    # 四个操作按钮都登记：护栏必须从按钮本身 click() 进（踩过一个 100% 抛异常的死按钮）
                    "btn_before": btn_ins_before,
                    "btn_after": btn_ins_after,
                    "btn_del": btn_del,
                }
            )
            return row

        def _suggest_option_id() -> str:
            """给新选项一个当前节点内不冲突的 id：新选项出厂就得是合法的。"""
            used = {r["id_e"].text().strip() for r in option_rows}
            for n in range(1, 200):
                cand = f"opt{n}"
                if cand not in used:
                    return cand
            return ""

        def insert_blank_option_at(pos: int) -> None:
            nb = make_option_block({"id": _suggest_option_id(), "text": "", "next": ""})
            nb["collapsed"] = False  # 新选项直接展开，点完就能填
            pos = max(0, min(pos, len(option_rows)))
            option_rows.insert(pos, nb)
            rebuild_choice_rows_layout()
            refresh_choice_nav_buttons()
            refresh_choice_fold_policy()
            self._emit_structural_changed()

        # options 为空/非列表时**不再**凭空补一条「选项甲」（与 switch 侧同源问题）：
        # 那是用户没填的内容，打开+切走就会被写进 JSON。空就如实显示空 + 一句引导。
        for od in opts:
            option_rows.append(make_option_block(od))
        _junk_lbl = _junk_notice(opts_junk, "选项")
        if _junk_lbl is not None:
            _junk_lbl.setParent(self._body)
            self._body_layout.addWidget(_junk_lbl)
        choice_empty_hint = QLabel(
            "本节点当前没有选项，运行时会卡住无处可去。点下方「在末尾添加选项」新增。",
            rows_wrap,
        )
        choice_empty_hint.setWordWrap(True)
        choice_empty_hint.setStyleSheet(app_theme.semantic_text_css("warn"))
        _choice_hint_ref["w"] = choice_empty_hint
        rebuild_choice_rows_layout()
        refresh_choice_nav_buttons()
        refresh_choice_fold_policy()

        obar = QHBoxLayout()
        b_add = QPushButton("在末尾添加选项", self._body)
        b_add.setToolTip("在列表最后追加一条空白选项")

        def do_add_end() -> None:
            insert_blank_option_at(len(option_rows))

        b_add.clicked.connect(do_add_end)
        obar.addWidget(b_add)

        self._body_layout.addWidget(
            _help_marker(
                "选项：requireFlag 登记表；requireCondition 为 ConditionExpr；"
                "ruleHintId 规矩样式；disabledClickHint 灰显点击全文提示。",
                self._body,
            )
        )
        self._body_layout.addWidget(rows_wrap)
        self._body_layout.addLayout(obar)

        def getter():
            options: list[dict[str, Any]] = []
            for _idx_r, r in enumerate(option_rows):
                # getter **绝不抛异常**：它是本节点数据进模型的唯一出口，一抛就把整条
                # 通道断掉——表单上敲的字全在、模型里一个字没进、is_dirty 还是 False，
                # 于是关窗口不提示、整段编辑无声蒸发（审查 2026-08-06 P0-1）。
                # 「未填 id」改由校验面板与保存门拦（graph_document.validate_graph_tiered）。
                oid = r["id_e"].text().strip()
                out_opt: dict[str, Any] = {}
                if oid or r.get("orig_has_id"):
                    out_opt["id"] = oid
                out_opt["text"] = r["text_e"].toPlainText()
                out_opt["next"] = r["nx"].text().strip()
                rf_s = r["rf_edit"].text().strip()
                if rf_s:
                    out_opt["requireFlag"] = rf_s
                rcx = r["req_tree"].get_expr()
                if rcx is not None:
                    out_opt["requireCondition"] = rcx
                if r["cost_sp"].value() >= 0:
                    out_opt["costCoins"] = r["cost_sp"].value()
                rh_val = r["rh_cb"].committed_type()
                if isinstance(rh_val, str) and rh_val.strip():
                    out_opt["ruleHintId"] = rh_val.strip()
                hint_s = r["hint_plain"].toPlainText()
                if hint_s:
                    out_opt["disabledClickHint"] = hint_s
                options.append(out_opt)
            out: dict[str, Any] = {
                "type": "choice",
                "options": _reinsert_junk(options, opts_junk),
            }
            if cb_pl.isChecked():
                k = pl_kind.currentData()
                if k == "literal":
                    ex = pl_extra_line.text().strip()
                elif k == "sceneNpc":
                    ex = pl_npc_edit.text().strip()
                else:
                    ex = ""
                pl_out: dict[str, Any] = {
                    "speaker": _ui_to_speaker(k, ex),
                    "text": pl_text.toPlainText(),
                }
                pl_tk = pl_text_key.text().strip()
                if pl_tk:
                    pl_out["textKey"] = pl_tk
                pl_por = pl_portrait.to_ref()
                if pl_por:
                    pl_out["portrait"] = pl_por
                pl_voice.apply_to(pl_out)
                out["promptLine"] = pl_out
            return out

        self._getter = getter
        self._topology_refs = {"type": "choice", "option_rows": option_rows}

    # --- switch ---
    def _build_switch(self, data: dict[str, Any]):
        cases_raw, cases_junk = _split_dict_items(data.get("cases"))

        pm_switch = self._project_model_getter() if self._project_model_getter else None

        # defaultNext（else）建在这里但**排到分支列表下面**：它是「以上都不满足才走」，
        # 画在分支之前会让人以为它先生效。
        dn = QLineEdit(str(data.get("defaultNext", "")), self._body)
        pickd = QPushButton("选…", self._body)
        pickd.clicked.connect(lambda: self._pick_target(dn))
        dn.textChanged.connect(self._emit_changed)
        self._install_target_validation(dn)

        self._body_layout.addWidget(
            _help_marker(
                "分支自上而下判定，命中第一条就走，后面的不再看。"
                "都不命中才走最底下的「以上都不满足」。"
                "每条分支的条件可以写成「多条条件 AND」清单，也可以切成「结构化」写"
                "任一/否定/嵌套；两种写法之间来回切不会丢条件。",
                self._body,
            ),
        )

        cases_wrap = QWidget(self._body)
        cases_outer = QVBoxLayout(cases_wrap)
        cases_outer.setContentsMargins(0, 0, 0, 0)
        cases_outer.setSpacing(4)
        switch_case_rows: list[dict[str, Any]] = []
        # cases 为空时**不再**凭空补一条 some_flag 假分支：那条分支画布上根本不存在
        # （画布只按 JSON 里的 cases 画端口），策划随手改一下 defaultNext 就会把这条
        # 没人要的假分支写进 JSON。空就如实显示空 + 一句引导。
        empty_hint = QLabel(
            "本节点当前没有分支，运行时会直接走 defaultNext。点下方「在末尾添加分支」新增。",
            cases_wrap,
        )
        empty_hint.setWordWrap(True)
        empty_hint.setStyleSheet(app_theme.semantic_text_css("warn"))

        def refresh_case_nav() -> None:
            n = len(switch_case_rows)
            for i, c in enumerate(switch_case_rows):
                c["btn_up"].setEnabled(i > 0)
                c["btn_down"].setEnabled(i < n - 1)

        def refresh_case_fold_policy() -> None:
            """按各分支**自己**的折叠状态刷新可见性。

            旧实现每次增删分支都把所有分支强制折回去——策划展开第 3 条改到一半、
            点一下「添加分支」，正在编辑的那条就被折上、滚动位置也没了。
            这里只保留「只剩一条时没得折，强制展开」这一条规则，其余一律尊重现状。
            """
            if len(switch_case_rows) == 1:
                switch_case_rows[0]["collapsed"] = False
            for c in switch_case_rows:
                t = c.get("toggle")
                ct = c.get("content")
                if t is None or ct is None:
                    continue
                collapsed = bool(c.get("collapsed"))
                t.setVisible(True)
                ct.setVisible(not collapsed)
                t.setArrowType(
                    Qt.ArrowType.RightArrow if collapsed else Qt.ArrowType.DownArrow
                )

        def refresh_case_summaries() -> None:
            """行序变了就重刷所有分支标题——标题里的序号依赖本行在列表中的位置。"""
            for c in switch_case_rows:
                fn = c.get("refresh_summary")
                if callable(fn):
                    fn()

        def rebuild_cases_layout() -> None:
            while cases_outer.count():
                it = cases_outer.takeAt(0)
                w = it.widget()
                if w is not None:
                    w.setParent(None)
            for c in switch_case_rows:
                cases_outer.addWidget(c["outer"])
            cases_outer.addWidget(empty_hint)
            empty_hint.setVisible(not switch_case_rows)
            refresh_case_summaries()

        def make_case_block(case: dict[str, Any] | None) -> dict[str, Any]:
            case_rec: dict[str, Any] = {"collapsed": True}
            _mode_switch_busy = {"v": False}
            # 原本是否带 conditions 键（含空数组）——getter 据此保真回写，不注入 conditions:[]。
            _orig_conditions_present = isinstance(case, dict) and "conditions" in case
            # 磁盘上这条分支原本是哪种写法。只是切下拉「看一眼」不应该把
            # conditions 改写成 condition（会在 diff 里留下与内容无关的形状变化）；
            # 只有在新写法里**真的改了东西**，才按新写法回写（审查 2026-08-06 P2-3）。
            _orig_shape = (
                "condition"
                if isinstance(case, dict) and case.get("condition") is not None
                else ("conditions" if _orig_conditions_present else "")
            )
            # 「有没有在这种写法里真改过东西」不靠给每个按钮挂回调判定——那样每加一个
            # 操作入口都得记得挂一次，漏一个就是一整类编辑被静默丢弃（上移/下移/删除
            # 条件就这么漏过）。改成拿**当前序列化结果**跟「进入这种写法时的基线」比：
            # 不依赖任何回调挂全，新增按钮天然被覆盖。
            mode_baseline: dict[str, Any] = {"and": None, "expr": None}
            outer = QWidget(cases_wrap)
            ov = QVBoxLayout(outer)
            ov.setContentsMargins(0, 0, 0, 0)
            ov.setSpacing(4)

            header = QVBoxLayout()
            toggle = QToolButton(outer)
            toggle.setAutoRaise(True)
            toggle.setArrowType(Qt.ArrowType.RightArrow)
            toggle.setToolTip("折叠 / 展开本分支（在本行右键可插入 / 移动 / 删除）")
            # 摘要必须可省略：普通 QLabel 的最小宽度 = 整段文本宽度，会把这一行连同
            # 右侧的操作按钮一起顶出 280px 面板（见 _ElidingLabel 注释）。
            summary = _ElidingLabel("", outer)
            summary.setStyleSheet(app_theme.semantic_text_css("muted"))
            btn_ins_before, btn_ins_after, btn_up, btn_down, btn_del = (
                _compact_row_nav_buttons(
                    outer,
                    tip_before="在此分支之前插入空分支",
                    tip_after="在此分支之后插入空分支",
                    tip_up="整条分支上移",
                    tip_down="整条分支下移",
                    tip_del="删除本分支（可以删空，校验面板会提醒）",
                )
            )
            _fill_stacked_row_header(
                header,
                toggle,
                summary,
                (btn_ins_before, btn_ins_after, btn_up, btn_down, btn_del),
            )

            content = QWidget(outer)
            cv = QVBoxLayout(content)
            cv.setContentsMargins(0, 0, 0, 0)
            nx = QLineEdit(str((case or {}).get("next", "")), content)
            pk = QPushButton("选…", content)
            pk.clicked.connect(lambda: self._pick_target(nx))
            nx.textChanged.connect(self._emit_changed)
            self._install_target_validation(nx)
            hr = QHBoxLayout()
            _lbl_cn = QLabel("去哪", content)
            _lbl_cn.setToolTip("JSON 字段 next：命中本分支后跳到哪个节点")
            hr.addWidget(_lbl_cn)
            hr.addWidget(nx, 1)
            hr.addWidget(pk)
            cv.addLayout(hr)

            case_mode = QComboBox(content)
            case_mode.addItem("全部满足", "and")
            case_mode.addItem("任一·否定·嵌套", "expr")
            case_mode.setToolTip(
                "两种写法随便切，条件不会丢。\n"
                "「多条条件」= 列一串条件，全部满足才命中；\n"
                "「结构化」= 能写 任一满足 / 否定 / 多层嵌套。"
            )
            cm_row = QHBoxLayout()
            cm_row.addWidget(QLabel("本分支条件", content))
            cm_row.addWidget(case_mode, 1)
            cv.addLayout(cm_row)

            def _pm_get() -> Any:
                return self._project_model_getter() if self._project_model_getter else None

            expr_tree = ConditionExprTreeRootWidget(content, model_getter=_pm_get)
            expr_tree.changed.connect(self._emit_changed)
            cv.addWidget(expr_tree)

            # 原「将当前 AND 条件转成结构化 ConditionExpr」按钮已删：切模式本身就会
            # 双向无损转换（见 on_case_mode_changed），再留一个同义按钮只会让策划
            # 以为「不点这个就会丢」。

            cond_rows_layout = QVBoxLayout()
            cond_rows_layout.setSpacing(4)
            cond_rows_wrap = QWidget(content)
            cond_rows_wrap.setLayout(cond_rows_layout)
            cond_rows: list[dict[str, Any]] = []

            def refresh_cond_nav() -> None:
                m = len(cond_rows)
                for i, cr in enumerate(cond_rows):
                    cr["btn_up"].setEnabled(i > 0)
                    cr["btn_down"].setEnabled(i < m - 1)

            def rebuild_cond_layout() -> None:
                while cond_rows_layout.count():
                    it = cond_rows_layout.takeAt(0)
                    w = it.widget()
                    if w is not None:
                        w.setParent(None)
                for cr in cond_rows:
                    cond_rows_layout.addWidget(cr["outer"])

            def refresh_cond_fold_policy() -> None:
                """同 refresh_case_fold_policy：尊重每条条件自己的折叠状态，不批量重置。"""
                if len(cond_rows) == 1:
                    cond_rows[0]["collapsed"] = False
                for cr in cond_rows:
                    t = cr.get("toggle")
                    b = cr.get("body")
                    if t is None or b is None:
                        continue
                    collapsed = bool(cr.get("collapsed"))
                    t.setVisible(True)
                    b.setVisible(not collapsed)
                    t.setArrowType(
                        Qt.ArrowType.RightArrow if collapsed else Qt.ArrowType.DownArrow
                    )

            def make_cond_block(cd: dict[str, Any] | None) -> dict[str, Any]:
                return self._build_switch_and_cond_row(
                    cd,
                    pm_switch=pm_switch,
                    cond_rows=cond_rows,
                    cond_rows_wrap=cond_rows_wrap,
                    insert_cond_at=insert_cond_at,
                    rebuild_cond_layout=rebuild_cond_layout,
                    refresh_cond_nav=refresh_cond_nav,
                    refresh_cond_fold_policy=refresh_cond_fold_policy,
                    update_case_summary=update_case_summary,
                )

            def and_rows_snapshot() -> list[dict[str, Any]]:
                return [
                    r["serialize"]() for r in cond_rows if callable(r.get("serialize"))
                ]

            def mode_content_edited() -> bool:
                """当前写法里的内容，跟「进入这种写法时」相比变了没有。"""
                if case_mode.currentData() == "expr":
                    return expr_tree.get_expr() != mode_baseline["expr"]
                return and_rows_snapshot() != mode_baseline["and"]

            def _case_data_index() -> int:
                """本行在**数据数组**里的下标（与画布端口号、校验消息同一套口径）。

                行序 ≠ 数据下标：非 dict 的坏元素不占行但占下标。用 `_row_data_indices`
                按 getter 的实际落位算，保证三个面说的「分支 N」永远是同一条。
                """
                try:
                    row_i = switch_case_rows.index(case_rec)
                except ValueError:
                    return -1
                mapping = _row_data_indices(len(switch_case_rows), cases_junk)
                return mapping[row_i] if row_i < len(mapping) else -1

            def current_case_condition_text() -> str:
                """本分支当前条件的一行人话（与画布端口标签同源）。"""
                if case_mode.currentData() == "expr":
                    obj = expr_tree.get_expr()
                    return condition_expr_text(obj) if isinstance(obj, dict) else ""
                parts = [
                    condition_expr_text(r["serialize"]())
                    for r in cond_rows
                    if callable(r.get("serialize"))
                ]
                return " 且 ".join(p for p in parts if p)

            def current_case_snapshot() -> dict[str, Any]:
                """本分支当前状态下会写出的 case（供判定恒真/恒假，与 getter 同口径）。"""
                if case_mode.currentData() == "expr":
                    obj = expr_tree.get_expr()
                    return {"condition": obj} if isinstance(obj, dict) and obj else {}
                conds = [
                    r["serialize"]() for r in cond_rows if callable(r.get("serialize"))
                ]
                return {"conditions": conds}

            def update_case_summary() -> None:
                nn = nx.text().strip() or "（未填 next）"
                cond_text = current_case_condition_text()
                verdict = _case_verdict(current_case_snapshot())
                # 带上序号：画布端口写 `0. …/1. …/else`、校验消息说「分支 1」，
                # 而检查器这边一个数字都没有——策划拿到「分支 1 恒命中」只能回来
                # 一条条展开数，数错就改错分支。三个面统一用**数据下标**。
                idx = _case_data_index()
                prefix = f"{idx}. " if idx >= 0 else ""
                if verdict == _COND_ALWAYS:
                    # 运行时 all([]) 恒真 → 恒命中；必须在标题上就喊出来。
                    summary.setText(
                        f"{prefix}⚠ 条件为空，恒命中（其后分支与 else 全走不到）  →  {nn}"
                    )
                    summary.setStyleSheet(app_theme.semantic_text_css("warn"))
                elif verdict == _COND_NEVER:
                    summary.setText(
                        f"{prefix}⚠ 条件恒为假，这条分支永远走不到  →  {nn}"
                        + (f"  【{shorten(cond_text, 30)}】" if cond_text else "")
                    )
                    summary.setStyleSheet(app_theme.semantic_text_css("warn"))
                else:
                    summary.setText(f"{prefix}{shorten(cond_text, 44)}  →  {nn}")
                    summary.setStyleSheet(app_theme.semantic_text_css("muted"))

            def insert_cond_at(pos: int, data_d: dict[str, Any] | None = None) -> None:
                nb = make_cond_block(
                    data_d
                    if isinstance(data_d, dict)
                    else {"flag": "", "op": "==", "value": True}
                )
                # 新加的这条一定要展开——策划点「添加条件」就是要马上填它。
                nb["collapsed"] = False
                pos = max(0, min(pos, len(cond_rows)))
                cond_rows.insert(pos, nb)
                rebuild_cond_layout()
                refresh_cond_nav()
                refresh_cond_fold_policy()
                update_case_summary()
                self._emit_structural_changed()

            cond_expr_init = (
                (case or {}).get("condition") if isinstance(case, dict) else None
            )
            conds_init = (
                (case or {}).get("conditions") if isinstance(case, dict) else None
            )
            if isinstance(conds_init, list) and conds_init:
                for c in conds_init:
                    if isinstance(c, dict):
                        insert_cond_at(len(cond_rows), c)
            # 原本 conditions:[] / 既无 conditions 也无 condition：保持空 AND 列表，
            # 不再注入 some_flag 占位（新建分支的起始占位由 insert/add 路径显式给出）。
            # getter 依 _orig_conditions_present 决定是否回写空 conditions 数组，保真零丢失。

            nx.textChanged.connect(lambda _t: (update_case_summary(), self._emit_changed()))

            b_cond_end = QPushButton("在末尾添加条件", content)
            b_cond_end.clicked.connect(lambda: insert_cond_at(len(cond_rows)))
            and_block = QWidget(content)
            and_lay = QVBoxLayout(and_block)
            and_lay.setContentsMargins(0, 0, 0, 0)
            _and_lbl = QLabel("条件（全部满足）", and_block)
            _and_lbl.setToolTip("下面每条都满足，这个分支才命中。")
            and_lay.addWidget(_and_lbl)
            and_lay.addWidget(cond_rows_wrap)
            and_lay.addWidget(b_cond_end)
            cv.addWidget(and_block)

            def _sync_case_mode_ui() -> None:
                ex = case_mode.currentData() == "expr"
                expr_tree.setVisible(ex)
                and_block.setVisible(not ex)

            def _and_rows_to_expr() -> dict[str, Any] | None:
                parts = [
                    r["serialize"]() for r in cond_rows if callable(r.get("serialize"))
                ]
                parts = [p for p in parts if isinstance(p, dict) and p]
                if not parts:
                    return None
                if len(parts) == 1:
                    return copy.deepcopy(parts[0])
                return {"all": copy.deepcopy(parts)}

            def _clear_cond_rows() -> None:
                while cond_rows_layout.count():
                    it = cond_rows_layout.takeAt(0)
                    w = it.widget()
                    if w is not None:
                        w.setParent(None)
                        w.deleteLater()
                cond_rows.clear()

            def _expr_to_and_rows(expr: dict[str, Any]) -> bool:
                """把结构化表达式摊平成 AND 列表；顶层是 any/not 就摊不平，返回 False。

                摊得平的每一项即便表单画不出来（plane / 嵌套 / 未来新叶），也会落进
                只读透传行原样保留——所以「摊平」永远不丢数据。
                """
                if not isinstance(expr, dict) or not expr:
                    return False
                if isinstance(expr.get("all"), list):
                    items = [e for e in expr["all"] if isinstance(e, dict) and e]
                    if not items:
                        return False
                elif isinstance(expr.get("any"), list) or isinstance(expr.get("not"), dict):
                    return False
                else:
                    items = [expr]
                prev = self._suppress_change_emit
                self._suppress_change_emit = True
                try:
                    _clear_cond_rows()
                    for item in items:
                        insert_cond_at(len(cond_rows), copy.deepcopy(item))
                finally:
                    self._suppress_change_emit = prev
                return True

            def on_case_mode_changed(_i: int = 0) -> None:
                """两种条件写法之间**双向无损**切换。

                旧实现只切显隐：AND→结构化 后结构化树是空的 → 保存时 condition/conditions
                双双丢失，写出一条「无条件分支」（运行时恒命中）；结构化→AND 则把整棵
                condition 静默丢掉。策划只是想点开下拉看看，数据就没了。
                """
                if _mode_switch_busy["v"]:
                    return
                _mode_switch_busy["v"] = True
                try:
                    if case_mode.currentData() == "expr":
                        # AND → 结构化：把现有 AND 列表原样搬进表达式树
                        seeded = _and_rows_to_expr()
                        if seeded is not None:
                            expr_tree.set_expr(seeded)
                    else:
                        # 结构化 → AND：摊得平才切；摊不平就退回去并说清原因，绝不清空
                        obj = expr_tree.get_expr()
                        if isinstance(obj, dict) and obj and not _expr_to_and_rows(obj):
                            case_mode.blockSignals(True)
                            case_mode.setCurrentIndex(
                                max(0, case_mode.findData("expr"))
                            )
                            case_mode.blockSignals(False)
                            QMessageBox.information(
                                self,
                                "条件写法",
                                "这条分支的条件用到了「任一满足(any)」或「否定(not)」，"
                                "拆不成一串「全部满足」的清单。\n\n"
                                "已保持在「结构化」写法，条件原样保留——请直接在下面的"
                                "结构化编辑器里改。",
                            )
                            return
                finally:
                    _mode_switch_busy["v"] = False
                # 记下「刚进这种写法时长什么样」，之后与它比对来判断用户改没改。
                mode_baseline[str(case_mode.currentData())] = (
                    copy.deepcopy(expr_tree.get_expr())
                    if case_mode.currentData() == "expr"
                    else copy.deepcopy(and_rows_snapshot())
                )
                _sync_case_mode_ui()
                update_case_summary()
                self._emit_changed()

            if isinstance(cond_expr_init, dict) and cond_expr_init:
                case_mode.setCurrentIndex(1)
                expr_tree.set_expr(cond_expr_init)
            else:
                expr_tree.set_expr(None)

            # 两种写法各自的「载入基线」：getter 拿当前内容与之比对，判断用户到底
            # 在哪种写法里动过手（见 mode_content_edited）。
            mode_baseline["and"] = copy.deepcopy(and_rows_snapshot())
            mode_baseline["expr"] = copy.deepcopy(expr_tree.get_expr())

            # 连信号必须在上面的「按磁盘数据摆初值」之后：否则初始化时的 setCurrentIndex
            # 会当成用户切模式，跑一遍转换、把还没 set_expr 的空树当真值。
            case_mode.currentIndexChanged.connect(on_case_mode_changed)
            expr_tree.changed.connect(update_case_summary)
            _sync_case_mode_ui()

            def flip_case() -> None:
                case_rec["collapsed"] = not case_rec["collapsed"]
                content.setVisible(not case_rec["collapsed"])
                toggle.setArrowType(
                    Qt.ArrowType.RightArrow
                    if case_rec["collapsed"]
                    else Qt.ArrowType.DownArrow
                )

            toggle.clicked.connect(flip_case)
            update_case_summary()

            def case_index() -> int:
                return switch_case_rows.index(case_rec)

            def insert_case_at(pos: int, data_c: dict[str, Any] | None = None) -> None:
                nb = make_case_block(
                    data_c
                    if isinstance(data_c, dict)
                    else {"next": "", "conditions": [{"flag": "", "op": "==", "value": True}]}
                )
                nb["collapsed"] = False  # 新分支直接展开，点完就能填
                pos = max(0, min(pos, len(switch_case_rows)))
                switch_case_rows.insert(pos, nb)
                rebuild_cases_layout()
                refresh_case_nav()
                refresh_case_fold_policy()
                self._emit_structural_changed()

            btn_ins_before.clicked.connect(lambda: insert_case_at(case_index()))
            btn_ins_after.clicked.connect(lambda: insert_case_at(case_index() + 1))

            def do_case_up() -> None:
                i = case_index()
                if i <= 0:
                    return
                switch_case_rows[i - 1], switch_case_rows[i] = (
                    switch_case_rows[i],
                    switch_case_rows[i - 1],
                )
                rebuild_cases_layout()
                refresh_case_nav()
                self._emit_structural_changed()

            def do_case_down() -> None:
                i = case_index()
                if i < 0 or i >= len(switch_case_rows) - 1:
                    return
                switch_case_rows[i + 1], switch_case_rows[i] = (
                    switch_case_rows[i],
                    switch_case_rows[i + 1],
                )
                rebuild_cases_layout()
                refresh_case_nav()
                self._emit_structural_changed()

            def do_case_del() -> None:
                i = case_index()
                cond_text = current_case_condition_text()
                # 分支里有条件 = 有真内容，删之前问一声（撤销栈虽然兜得住，但策划不一定知道）。
                if cond_text or nx.text().strip():
                    r = QMessageBox.question(
                        self,
                        "删除分支",
                        # 现在序号已按数据下标算（_case_data_index），与画布端口、
                        # 校验消息同一套口径，弹窗也带上它，和摘要行对得上。
                        f"确定删除分支 {_case_data_index()}？\n\n"
                        f"当 {shorten(cond_text, 40) or '（无条件）'} → "
                        f"{nx.text().strip() or '（未填 next）'}",
                        QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                        QMessageBox.StandardButton.Cancel,
                    )
                    if r != QMessageBox.StandardButton.Ok:
                        return
                switch_case_rows.pop(i)
                outer.setParent(None)
                outer.deleteLater()
                # 必须重排：空状态提示的可见性、以及各行标题里的序号，都只在
                # rebuild 里刷新。少了它，删完最后一条不提示"这是死开关"，
                # 删中间一条则剩下各行的序号与数据下标对不上。
                rebuild_cases_layout()
                refresh_case_nav()
                refresh_case_fold_policy()
                self._emit_structural_changed()

            btn_up.clicked.connect(do_case_up)
            btn_down.clicked.connect(do_case_down)
            btn_del.clicked.connect(do_case_del)

            ov.addLayout(header)
            ov.addWidget(content)
            content.setVisible(False)
            case_rec.update(
                {
                    "outer": outer,
                    "toggle": toggle,
                    "content": content,
                    "next_edit": nx,
                    "cond_rows": cond_rows,
                    "case_mode": case_mode,
                    "expr_tree": expr_tree,
                    "orig_shape": _orig_shape,
                    "data_index": _case_data_index,
                    "refresh_summary": update_case_summary,
                    "mode_content_edited": mode_content_edited,
                    "btn_up": btn_up,
                    "btn_down": btn_down,
                    # 前插/后插也登记：六类里只有这里漏了，于是这两个按钮处于
                    # 「测试够不着」的状态——「删除本条件」100% 抛 NameError、
                    # `KeyError: 'beat_rows'` 都是同一个成因。而插出来的空分支
                    # 在运行时是恒命中的，出事代价不低。
                    "btn_before": btn_ins_before,
                    "btn_after": btn_ins_after,
                    "btn_del": btn_del,
                    "summary_label": summary,
                    "orig_conditions_present": _orig_conditions_present,
                }
            )
            return case_rec

        for c in cases_raw:
            if isinstance(c, dict):
                switch_case_rows.append(make_case_block(c))
        _junk_lbl = _junk_notice(cases_junk, "分支")
        if _junk_lbl is not None:
            _junk_lbl.setParent(self._body)
            self._body_layout.addWidget(_junk_lbl)
        rebuild_cases_layout()
        refresh_case_nav()
        refresh_case_fold_policy()

        cbar = QHBoxLayout()
        bc_add = QPushButton("在末尾添加分支", self._body)

        def do_add_case_end() -> None:
            nb = make_case_block(
                {
                    "next": "",
                    "conditions": [{"flag": "", "op": "==", "value": True}],
                }
            )
            nb["collapsed"] = False  # 新分支直接展开，点完就能填
            switch_case_rows.append(nb)
            rebuild_cases_layout()
            refresh_case_nav()
            refresh_case_fold_policy()
            self._emit_structural_changed()

        bc_add.clicked.connect(do_add_case_end)
        cbar.addWidget(bc_add)
        self._body_layout.addWidget(cases_wrap)
        self._body_layout.addLayout(cbar)

        fl = QFormLayout()
        _form_wrap_rows(fl)
        rowd = QHBoxLayout()
        rowd.addWidget(dn)
        rowd.addWidget(pickd)
        _dn_lbl = QLabel("都不满足走这里", self._body)
        _dn_lbl.setToolTip("以上分支自上而下都不命中时走的节点（JSON 字段 defaultNext）。")
        fl.addRow(_dn_lbl, rowd)
        self._body_layout.addLayout(fl)

        self._topology_refs = {"type": "switch", "case_rows": switch_case_rows, "default_next": dn}

        def getter():
            cs: list[dict[str, Any]] = []
            for cb in switch_case_rows:
                next_s = cb["next_edit"].text().strip()
                case_out: dict[str, Any] = {"next": next_s}
                # 用哪种写法回写：默认跟当前模式；但「切了下拉却什么都没改」时保持
                # 磁盘原写法，免得一次误点在 diff 里留下与内容无关的形状变化。
                # 两种模式的数据都是全的（切模式是双向搬运、不清空），所以回退安全。
                shape = "condition" if cb["case_mode"].currentData() == "expr" else "conditions"
                if cb.get("orig_shape") and not cb["mode_content_edited"]():
                    shape = cb["orig_shape"]
                if shape == "condition":
                    obj = cb["expr_tree"].get_expr()
                    if isinstance(obj, dict) and obj:
                        case_out["condition"] = obj
                    elif cb.get("orig_conditions_present"):
                        case_out["conditions"] = []
                    # 否则：原本无 conditions 键（裸 next / 仅 condition 被清空）→ 不注入
                else:
                    conds = [r["serialize"]() for r in cb["cond_rows"]]
                    if conds:
                        case_out["conditions"] = conds
                    elif cb.get("orig_conditions_present"):
                        case_out["conditions"] = []
                    # 否则裸 next，不注入 conditions:[]
                cs.append(case_out)
            return {
                "type": "switch",
                "cases": _reinsert_junk(cs, cases_junk),
                "defaultNext": dn.text().strip(),
            }

        self._getter = getter

    def _build_switch_and_cond_row(
        self,
        cd: dict[str, Any] | None,
        *,
        pm_switch: Any,
        cond_rows: list[dict[str, Any]],
        cond_rows_wrap: QWidget,
        insert_cond_at: Callable[..., None],
        rebuild_cond_layout: Callable[[], None],
        refresh_cond_nav: Callable[[], None],
        refresh_cond_fold_policy: Callable[[], None],
        update_case_summary: Callable[[], None],
    ) -> dict[str, Any]:
        """switch 分支「多条条件 AND」列表里的单条叶子编辑器。

        原为 _build_switch → make_case_block → make_cond_block 三层嵌套闭包；抽成方法后
        其对外依赖（本分支的条件行列表与刷新回调、ProjectModel）以参数显式传入，
        _build_switch 的体量与嵌套深度显著下降。返回该条件行的 record（含 serialize）。
        """
        crow: dict[str, Any] = {"collapsed": True}
        cow = QWidget(cond_rows_wrap)
        col = QVBoxLayout(cow)
        col.setContentsMargins(0, 0, 0, 0)
        col.setSpacing(4)
        ch = QVBoxLayout()
        ctog = QToolButton(cow)
        ctog.setAutoRaise(True)
        ctog.setArrowType(Qt.ArrowType.RightArrow)
        ctog.setToolTip("折叠 / 展开本条件（在本行右键可插入 / 移动 / 删除）")
        csum = _ElidingLabel("", cow)  # 同上：条件行标题也必须可省略
        csum.setStyleSheet(app_theme.semantic_text_css("muted"))
        c_before, c_after, c_up, c_down, c_del = _compact_row_nav_buttons(
            cow,
            tip_before="在此条件之前插入一条条件",
            tip_after="在此条件之后插入一条条件",
            tip_up="本条条件上移",
            tip_down="本条条件下移",
            tip_del="删除本条件（本分支至少保留一条）",
            side=22,
        )
        _fill_stacked_row_header(ch, ctog, csum, (c_before, c_after, c_up, c_down, c_del))

        body = QWidget(cow)
        h = QVBoxLayout(body)
        h.setContentsMargins(0, 0, 0, 0)
        h.setSpacing(3)
        # 不能在结构化模式表达的叶子（scenarioLine / not / all / any / 未知形）
        # 原样保留，不被改写；需编辑时切到本分支的「结构化」模式。
        raw_passthrough: dict[str, Any] = {"v": None}
        _had_op = isinstance(cd, dict) and "op" in cd
        # 记录原子原本带哪些可选键，序列化时忠实还原、不注入不丢弃（零丢失往返）：
        _had_value = isinstance(cd, dict) and "value" in cd
        _had_quest_status = (
            isinstance(cd, dict)
            and isinstance(cd.get("quest"), str)
            and ("questStatus" in cd or "status" in cd)
        )
        # 载入时 quest 状态的默认显示值（无 status 键时回退 Active）；序列化时用它区分
        # "用户主动改了状态下拉"与"从未动过"——前者必须写出，否则改了下拉却被静默丢弃
        #（审查 P1-40：_had_quest_status 是构建期常量，保真"不注入"矫枉过正到主动编辑）。
        _quest_status_loaded = {"v": "Active"}
        mode = QComboBox(body)
        mode.addItem("标志 flag", "flag")
        mode.addItem("任务 quest", "quest")
        mode.addItem("剧情线 scenario", "scenario")
        mode.addItem("叙事 narrative", "narrative")
        op_cb = QComboBox(body)
        for o in ("==", "!=", ">", "<", ">=", "<="):
            op_cb.addItem(o, o)
        qid_e = QLineEdit(body)
        st_cb = QComboBox(body)
        # 显示中文、itemData 保留原值：取值一律走 currentData()，不会写坏数据
        #（与说话人四态同款写法）。
        for _s, _zh in (("Inactive", "未接"), ("Active", "进行中"), ("Completed", "已完成")):
            st_cb.addItem(f"{_zh}（{_s}）", _s)
        # flag 条件排两行：一行放「标志键 + 选择器」，一行放「比较符 + 值」。
        # 挤成一行会撑破检查器宽度（实测 560px 下值下拉和删除按钮被切掉、出横向滚动条），
        # 违反 norms 布局纪律「短字段设宽度上限、不许地板堆叠顶爆小屏」。
        flag_w = QWidget(body)
        flag_v = QVBoxLayout(flag_w)
        flag_v.setContentsMargins(0, 0, 0, 0)
        flag_v.setSpacing(3)
        flag_row1 = QWidget(flag_w)
        fh = QHBoxLayout(flag_row1)
        fh.setContentsMargins(0, 0, 0, 0)
        flag_row2 = QWidget(flag_w)
        fh2 = QHBoxLayout(flag_row2)
        fh2.setContentsMargins(0, 0, 0, 0)
        flag_v.addWidget(flag_row1)
        flag_v.addWidget(flag_row2)
        fh.addWidget(QLabel("flag", flag_w))
        if pm_switch is not None:
            from tools.editor.shared.flag_key_field import FlagKeyPickField

            flag_ctrl = FlagKeyPickField(pm_switch, None, "", body)

            def _get_flag() -> str:
                return flag_ctrl.key()

            def _set_flag(s: str) -> None:
                flag_ctrl.set_key(s)
        else:
            flag_ctrl = QLineEdit(body)
            flag_ctrl.setPlaceholderText(
                "无法加载 ProjectModel 时可直接输入 flag 键"
            )
            flag_ctrl.textChanged.connect(self._emit_changed)

            def _get_flag() -> str:
                return flag_ctrl.text().strip()

            def _set_flag(s: str) -> None:
                flag_ctrl.setText(s)

        fh.addWidget(flag_ctrl, 1)
        fh2.addWidget(op_cb)
        val_kind = QComboBox(body)
        val_kind.addItem("布尔", "bool")
        val_kind.addItem("整数", "int")
        val_kind.addItem("小数", "float")
        val_kind.addItem("文本", "str")
        val_stack = QStackedWidget(body)
        val_bool = QComboBox(body)
        val_bool.addItem("false", False)
        val_bool.addItem("true", True)
        val_int = QSpinBox(body)
        val_int.setRange(-2_147_483_648, 2_147_483_647)
        val_float = QDoubleSpinBox(body)
        val_float.setRange(-1e12, 1e12)
        val_float.setDecimals(8)
        val_str = QLineEdit(body)
        val_stack.addWidget(val_bool)
        val_stack.addWidget(val_int)
        val_stack.addWidget(val_float)
        val_stack.addWidget(val_str)
        fh2.addWidget(val_kind)
        fh2.addWidget(val_stack, 1)

        # quest 同理排两行，避免「questId + 选择器 + 状态」挤爆一行。
        quest_w = QWidget(body)
        quest_v = QVBoxLayout(quest_w)
        quest_v.setContentsMargins(0, 0, 0, 0)
        quest_v.setSpacing(3)
        quest_row1 = QWidget(quest_w)
        qh = QHBoxLayout(quest_row1)
        qh.setContentsMargins(0, 0, 0, 0)
        quest_row2 = QWidget(quest_w)
        qh2 = QHBoxLayout(quest_row2)
        qh2.setContentsMargins(0, 0, 0, 0)
        quest_v.addWidget(quest_row1)
        quest_v.addWidget(quest_row2)
        qh.addWidget(QLabel("questId", quest_w))
        qh.addWidget(qid_e, 1)
        qh.addWidget(
            self._make_id_pick_button(
                qid_e,
                self._quest_entries_for_picker,
                title="选择 quest",
                tip="打开可搜索的任务列表",
            )
        )
        qh2.addWidget(QLabel("状态", quest_w))
        qh2.addWidget(st_cb)
        qh2.addStretch(1)

        scenario_w = QWidget(body)
        sc_form = QFormLayout(scenario_w)
        # 标签排到字段上方：中文标签比原来的英文字段名宽，并排会把这一行顶出面板
        #（改成中文是为了看得懂，不能因此又挤爆——两者靠换行兼得）。
        _form_wrap_rows(sc_form)
        sc_form.setContentsMargins(0, 0, 0, 0)
        scen_ids: list[str] = []
        if pm_switch is not None:
            scen_ids = list(pm_switch.scenario_ids_ordered())
        # 直接用不可编辑 QComboBox + 固定 placeholder；规避 editable combobox
        # activated -> clear/addItem 路径引发的原生崩溃。
        scen_id_combo = QComboBox(scenario_w)
        scen_id_combo.setEditable(False)
        scen_id_combo.addItem("(未选)", "")
        for sid in scen_ids:
            scen_id_combo.addItem(sid, sid)
        if not scen_ids:
            scen_id_combo.addItem("(无 scenarios.json 数据)", "")
            scen_id_combo.setEnabled(False)
        phase_combo = QComboBox(scenario_w)
        phase_combo.setEditable(False)
        scen_status = QComboBox(scenario_w)
        scen_status.setEditable(False)
        for _s, _zh in (
            ("pending", "未开始"), ("active", "进行中"),
            ("done", "已完成"), ("locked", "已锁定"),
        ):
            scen_status.addItem(f"{_zh}（{_s}）", _s)
        # outcome 的类型必须保真：运行时 evalScenarioLeaf 用 `=== expr.outcome` 严格比较，
        # 把 3 写成 "3"、把 true 写成 "True" 这条件就永远不命中（审查 2026-08-06 P1-4）。
        # 故与 flag 值一样给「类型 + 值」两件套，不做字符串猜测。
        scen_outcome_kind = QComboBox(scenario_w)
        for _lab, _val in (("（不填）", "none"), ("文本", "str"), ("整数", "int"),
                           ("小数", "float"), ("布尔", "bool")):
            scen_outcome_kind.addItem(_lab, _val)
        scen_outcome_stack = QStackedWidget(scenario_w)
        scen_outcome = QLineEdit(scenario_w)
        scen_outcome.setPlaceholderText("可选，与 scenario phase 的 outcome 比较")
        scen_outcome_int = QSpinBox(scenario_w)
        scen_outcome_int.setRange(-2_147_483_648, 2_147_483_647)
        scen_outcome_float = QDoubleSpinBox(scenario_w)
        scen_outcome_float.setRange(-1e12, 1e12)
        scen_outcome_float.setDecimals(8)
        scen_outcome_bool = QComboBox(scenario_w)
        scen_outcome_bool.addItem("false", False)
        scen_outcome_bool.addItem("true", True)
        scen_outcome_stack.addWidget(QWidget(scenario_w))  # none
        scen_outcome_stack.addWidget(scen_outcome)
        scen_outcome_stack.addWidget(scen_outcome_int)
        scen_outcome_stack.addWidget(scen_outcome_float)
        scen_outcome_stack.addWidget(scen_outcome_bool)

        def _sync_outcome_kind() -> None:
            idx = {"none": 0, "str": 1, "int": 2, "float": 3, "bool": 4}.get(
                str(scen_outcome_kind.currentData()), 0
            )
            scen_outcome_stack.setCurrentIndex(idx)

        def _outcome_value() -> Any:
            kind = str(scen_outcome_kind.currentData())
            if kind == "str":
                return scen_outcome.text().strip()
            if kind == "int":
                return scen_outcome_int.value()
            if kind == "float":
                return float(scen_outcome_float.value())
            if kind == "bool":
                return scen_outcome_bool.currentData()
            return None

        def _set_outcome_value(v: Any) -> None:
            scen_outcome_kind.blockSignals(True)
            try:
                if v is None:
                    scen_outcome_kind.setCurrentIndex(0)
                elif isinstance(v, bool):
                    scen_outcome_kind.setCurrentIndex(4)
                    scen_outcome_bool.setCurrentIndex(1 if v else 0)
                elif type(v) is int:
                    scen_outcome_kind.setCurrentIndex(2)
                    scen_outcome_int.setValue(int(v))
                elif isinstance(v, float):
                    scen_outcome_kind.setCurrentIndex(3)
                    scen_outcome_float.setValue(float(v))
                else:
                    scen_outcome_kind.setCurrentIndex(1)
                    scen_outcome.setText(str(v))
            finally:
                scen_outcome_kind.blockSignals(False)
            _sync_outcome_kind()

        def resolved_scenario_id() -> str:
            dv = scen_id_combo.currentData()
            return str(dv).strip() if isinstance(dv, str) else ""

        def refill_scen_phases() -> None:
            sid = resolved_scenario_id()
            phs = (
                pm_switch.phases_for_scenario(sid)
                if pm_switch and sid
                else []
            )
            # 用 currentData 记录真实 phase 值（旧实现用 currentText，对「(缺失) p1」
            # 展示项 text≠data → findData 落空 → phase 被静默清空写 phase:""，审查 P1-41）
            cur = phase_combo.currentData()
            cur = str(cur).strip() if isinstance(cur, str) else ""
            phase_combo.blockSignals(True)
            phase_combo.clear()
            phase_combo.addItem("(未选)", "")
            for p in phs:
                phase_combo.addItem(p, p)
            if cur:
                ix = phase_combo.findData(cur)
                if ix < 0:
                    # 清单外 phase 保值（改名/删除/跨 scenario）：加「(缺失)」项而非丢弃
                    phase_combo.addItem(f"(缺失) {cur}", cur)
                    ix = phase_combo.count() - 1
                phase_combo.setCurrentIndex(ix)
            phase_combo.blockSignals(False)

        scen_id_combo.currentIndexChanged.connect(
            lambda _i: (refill_scen_phases(), update_csum(), self._emit_changed()),
        )
        for wsig in (phase_combo, scen_status):
            wsig.currentIndexChanged.connect(
                lambda _i: (update_csum(), self._emit_changed()),
            )
        scen_outcome.textChanged.connect(
            lambda _t: (update_csum(), self._emit_changed()),
        )
        scen_outcome_kind.currentIndexChanged.connect(
            lambda _i: (_sync_outcome_kind(), update_csum(), self._emit_changed()),
        )
        scen_outcome_int.valueChanged.connect(
            lambda _v: (update_csum(), self._emit_changed()),
        )
        scen_outcome_float.valueChanged.connect(
            lambda _v: (update_csum(), self._emit_changed()),
        )
        scen_outcome_bool.currentIndexChanged.connect(
            lambda _i: (update_csum(), self._emit_changed()),
        )
        # 排两行：类型下拉一行、值一行。挤一行的最小宽是 291px，加上外层就超 280 面板，
        # 展开 scenario 条件叶时行尾删除按钮被切、出横向滚动条。
        _outcome_row = QWidget(scenario_w)
        _outcome_h = QVBoxLayout(_outcome_row)
        _outcome_h.setContentsMargins(0, 0, 0, 0)
        _outcome_h.setSpacing(2)
        _outcome_h.addWidget(scen_outcome_kind)
        _outcome_h.addWidget(scen_outcome_stack)
        sc_form.addRow("剧情线", scen_id_combo)
        sc_form.addRow("阶段", phase_combo)
        sc_form.addRow("状态", scen_status)
        sc_form.addRow("结果值（可选）", _outcome_row)

        # narrative 是真实数据里最常用的条件叶（占 70%），一行塞不下
        # 「图 id + 选择器 + 状态 + 选择器 + reached 勾选」，同样排两行。
        narrative_w = QWidget(body)
        narr_v = QVBoxLayout(narrative_w)
        narr_v.setContentsMargins(0, 0, 0, 0)
        narr_v.setSpacing(3)
        narr_row1 = QWidget(narrative_w)
        nh = QHBoxLayout(narr_row1)
        nh.setContentsMargins(0, 0, 0, 0)
        narr_row2 = QWidget(narrative_w)
        nh2 = QHBoxLayout(narr_row2)
        nh2.setContentsMargins(0, 0, 0, 0)
        narr_v.addWidget(narr_row1)
        narr_v.addWidget(narr_row2)
        nh.addWidget(QLabel("叙事图", narrative_w))
        narr_id_e = QLineEdit(narrative_w)
        narr_id_e.setPlaceholderText("wrapper/scenario 图 id 或 @owner/@scene")
        nh.addWidget(narr_id_e, 1)
        nh.addWidget(
            self._make_id_pick_button(
                narr_id_e,
                self._narrative_graph_entries_for_picker,
                title="选择叙事图",
                tip="wrapper/scenario 叙事图 id，或 @owner/@scene 相对 token",
            )
        )
        self._install_narrative_id_validation(narr_id_e)
        nh2.addWidget(QLabel("状态", narrative_w))
        narr_state_e = QLineEdit(narrative_w)
        nh2.addWidget(narr_state_e, 1)

        def _narr_state_entries() -> list[tuple[str, str]]:
            gid = narr_id_e.text().strip()
            pmx = self._project_model_getter() if self._project_model_getter else None
            if not gid or gid.startswith("@") or pmx is None or pmx.project_path is None:
                return []
            try:
                from tools.editor.shared.narrative_catalog import graph_states

                return [
                    (str(s), str(s))
                    for s in graph_states(pmx.project_path, gid)
                    if str(s).strip()
                ]
            except Exception:
                return []

        nh2.addWidget(
            self._make_id_pick_button(
                narr_state_e,
                _narr_state_entries,
                title="选择状态",
                tip="按上方选定的叙事图列出其状态 id",
            )
        )
        narr_reached = QCheckBox("到过", narrative_w)
        narr_reached.setToolTip("勾选=到达过该状态（含曾经）；不勾=仅当前处于该状态")
        nh2.addWidget(narr_reached)

        # 逐行表单画不出来的条件（plane / not / 嵌套 / 未来新叶）：原样保留 + 单独的
        # 结构化编辑弹窗。此前这里只有一块只读文字，策划面对真实数据里的
        # plane / not 叶子完全无路可走（改不了也删不掉，只能找程序）。
        raw_w = QWidget(body)
        rh = QHBoxLayout(raw_w)
        rh.setContentsMargins(0, 0, 0, 0)
        raw_lbl = QLabel(raw_w)
        raw_lbl.setWordWrap(True)
        raw_lbl.setStyleSheet(app_theme.semantic_text_css("muted"))
        raw_lbl.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        raw_lbl.setToolTip(
            "本条件用的是逐行表单画不出来的写法（位面 / 否定 / 嵌套 等），"
            "原样保留不会被改写；点右侧「编辑…」用结构化条件编辑器修改。"
        )
        rh.addWidget(raw_lbl, 1)
        btn_raw_edit = QPushButton("编辑…", raw_w)
        btn_raw_edit.setToolTip("用结构化条件编辑器修改这条条件")
        rh.addWidget(btn_raw_edit)

        # 叶子类型下拉**独占一行**：和右边的字段挤在一行时，行最小宽 = 下拉 + 字段区，
        # 光这一行就 360px+，顶爆 280px 面板（改成竖排后各段各自占一行、互不叠加）。
        h.addWidget(mode)
        h.addWidget(flag_w)
        h.addWidget(quest_w)
        h.addWidget(scenario_w)
        h.addWidget(narrative_w)
        h.addWidget(raw_w)

        def _apply_val_kind(which: str) -> None:
            idx = {"bool": 0, "int": 1, "float": 2, "str": 3}.get(which, 0)
            val_stack.setCurrentIndex(idx)

        def _set_value_py(v: object) -> None:
            val_kind.blockSignals(True)
            try:
                if isinstance(v, bool):
                    val_kind.setCurrentIndex(0)
                    val_bool.setCurrentIndex(1 if v else 0)
                    _apply_val_kind("bool")
                elif type(v) is int:
                    val_kind.setCurrentIndex(1)
                    val_int.setValue(int(v))
                    _apply_val_kind("int")
                elif isinstance(v, float):
                    val_kind.setCurrentIndex(2)
                    val_float.setValue(float(v))
                    _apply_val_kind("float")
                else:
                    val_kind.setCurrentIndex(3)
                    val_str.setText("" if v is None else str(v))
                    _apply_val_kind("str")
            finally:
                val_kind.blockSignals(False)

        # serialize 定义必须早于 update_csum 的首次调用——标题文本就是
        # `condition_expr_text(serialize())`，两者同源才不会漂。
        def serialize() -> dict[str, Any]:
            if raw_passthrough["v"] is not None:
                return copy.deepcopy(raw_passthrough["v"])
            if mode.currentData() == "scenario":
                ph_d = phase_combo.currentData()
                st_d = scen_status.currentData()
                out_s: dict[str, Any] = {
                    "scenario": resolved_scenario_id(),
                    "phase": str(ph_d).strip() if isinstance(ph_d, str) else "",
                    "status": str(st_d).strip() if isinstance(st_d, str) else "",
                }
                oo = _outcome_value()
                # 空串按「不填」处理（与旧行为一致）；其余按选定类型原样写出。
                if oo is not None and oo != "":
                    out_s["outcome"] = oo
                return out_s
            if mode.currentData() == "quest":
                out_q: dict[str, Any] = {"quest": qid_e.text().strip()}
                # 原本带 status/questStatus → 忠实写回；原本没有但用户把下拉从载入默认
                # 改走了 → 也写出（主动编辑不丢）；从未动过 → 保持缺省不注入。
                if _had_quest_status or st_cb.currentData() != _quest_status_loaded["v"]:
                    out_q[_quest_status_key] = st_cb.currentData()
                return out_q
            if mode.currentData() == "narrative":
                out_n: dict[str, Any] = {
                    "narrative": narr_id_e.text().strip(),
                    "state": narr_state_e.text().strip(),
                }
                if narr_reached.isChecked():
                    out_n["reached"] = True
                return out_n
            outf: dict[str, Any] = {"flag": _get_flag()}
            op = op_cb.currentData() or "=="
            # 仅在原子原本带 op、或 op 非默认时才写出，避免给 {flag,value} 注入多余 op
            if op != "==" or _had_op:
                outf["op"] = op
            kd = val_kind.currentData()
            if kd == "bool":
                outf["value"] = val_bool.currentData()
            elif kd == "int":
                outf["value"] = val_int.value()
            elif kd == "float":
                outf["value"] = float(val_float.value())
            else:
                s = val_str.text().strip()
                # 原本带 value（即便空串）就忠实写回，不因 falsy 丢键。
                if s or _had_value:
                    outf["value"] = s
            return outf

        def upd_mode() -> None:
            if raw_passthrough["v"] is not None:
                mode.setVisible(False)
                flag_w.setVisible(False)
                quest_w.setVisible(False)
                scenario_w.setVisible(False)
                narrative_w.setVisible(False)
                raw_w.setVisible(True)
                return
            mode.setVisible(True)
            raw_w.setVisible(False)
            m = mode.currentData()
            flag_w.setVisible(m == "flag")
            quest_w.setVisible(m == "quest")
            scenario_w.setVisible(m == "scenario")
            narrative_w.setVisible(m == "narrative")
            if m == "scenario":
                refill_scen_phases()

        def update_csum() -> None:
            """条件行标题。

            文本由 `condition_expr_text(serialize())` 生成——与画布端口标签、
            节点列表摘要、分支标题**同一个实现**，杜绝四处各写一套的漂移
            （旧实现这里写 `flag a == True`、画布写 `case0`、列表写 `flag a`）。
            """
            text = condition_expr_text(serialize())
            if raw_passthrough["v"] is not None:
                csum.setText(f"{shorten(text, 44)}（表单画不出，点「编辑…」改）")
            else:
                csum.setText(shorten(text, 44) or "（未填）")
            update_case_summary()

        raw_c = cd if isinstance(cd, dict) else {"flag": "", "op": "=="}
        if isinstance(raw_c.get("scenario"), str):
            mode.setCurrentIndex(2)
            sid0 = str(raw_c.get("scenario", "")).strip()
            scen_id_combo.blockSignals(True)
            try:
                ix0 = scen_id_combo.findData(sid0) if sid0 else 0
                if ix0 < 0:
                    scen_id_combo.addItem(f"(缺失) {sid0}", sid0)
                    ix0 = scen_id_combo.count() - 1
                scen_id_combo.setCurrentIndex(ix0)
            finally:
                scen_id_combo.blockSignals(False)
            refill_scen_phases()
            ph0 = str(raw_c.get("phase", "")).strip()
            if ph0:
                ix = phase_combo.findData(ph0)
                if ix < 0:
                    phase_combo.addItem(f"(缺失) {ph0}", ph0)
                    ix = phase_combo.count() - 1
                phase_combo.setCurrentIndex(ix)
            st0 = str(raw_c.get("status", "pending")).strip() or "pending"
            ix2 = scen_status.findData(st0)
            if ix2 < 0:
                scen_status.addItem(f"(非枚举) {st0}", st0)
                ix2 = scen_status.count() - 1
            scen_status.setCurrentIndex(ix2)
            _set_outcome_value(raw_c.get("outcome"))
        elif isinstance(raw_c.get("quest"), str):
            mode.setCurrentIndex(1)
            qid_e.setText(str(raw_c.get("quest", "")))
            qs = str(raw_c.get("questStatus") or raw_c.get("status") or "Active")
            ix = st_cb.findData(qs)
            st_cb.setCurrentIndex(max(0, ix))
            _quest_status_loaded["v"] = st_cb.currentData() or "Active"
        elif isinstance(raw_c.get("narrative"), str):
            mode.setCurrentIndex(mode.findData("narrative"))
            narr_id_e.setText(str(raw_c.get("narrative", "")))
            narr_state_e.setText(str(raw_c.get("state", "")))
            narr_reached.setChecked(raw_c.get("reached") is True)
        elif (
            any(k in raw_c for k in ("scenarioLine", "plane", "not", "all", "any"))
            or "flag" not in raw_c
        ):
            # 结构化/未识别叶子无法逐行表达：整条原样保留（只读），编辑请切「结构化」。
            # plane/scenarioLine 为后加条件叶(2026-07-13 修:此前 plane 落进下面的
            # flag 兜底被改写成 {"flag":""},打开即吃数据);任何未来新叶同样从这里
            # 透传——只有真正带 "flag" 键的原子才进 flag 编辑分支。
            raw_passthrough["v"] = copy.deepcopy(raw_c)
            try:
                raw_lbl.setText(json.dumps(raw_c, ensure_ascii=False, indent=2))
            except (TypeError, ValueError):
                raw_lbl.setText(str(raw_c))
        else:
            mode.setCurrentIndex(0)
            _set_flag(str(raw_c.get("flag", "")))
            op = str(raw_c.get("op") or "==")
            ix = op_cb.findData(op)
            op_cb.setCurrentIndex(max(0, ix))
            if "value" in raw_c:
                _set_value_py(raw_c.get("value"))
            else:
                _set_value_py(True)
        # quest 原本可能用 status 或 questStatus 作为键名，序列化时保持原样
        _quest_status_key = "status" if (
            "status" in raw_c and "questStatus" not in raw_c
        ) else "questStatus"

        mode.currentIndexChanged.connect(
            lambda _i: (upd_mode(), update_csum(), self._emit_changed())
        )
        val_kind.currentIndexChanged.connect(
            lambda _i: (
                _apply_val_kind(str(val_kind.currentData())),
                update_csum(),
                self._emit_changed(),
            )
        )
        for ww in (flag_ctrl, qid_e, val_str, narr_id_e, narr_state_e):
            if isinstance(ww, QLineEdit):
                ww.textChanged.connect(
                    lambda _t: (update_csum(), self._emit_changed())
                )
        narr_reached.toggled.connect(
            lambda _b: (update_csum(), self._emit_changed())
        )
        if pm_switch is not None:
            flag_ctrl.valueChanged.connect(
                lambda: (update_csum(), self._emit_changed())
            )
        op_cb.currentIndexChanged.connect(
            lambda _i: (update_csum(), self._emit_changed())
        )
        st_cb.currentIndexChanged.connect(
            lambda _i: (update_csum(), self._emit_changed())
        )
        val_bool.currentIndexChanged.connect(
            lambda _i: (update_csum(), self._emit_changed())
        )
        val_int.valueChanged.connect(
            lambda _v: (update_csum(), self._emit_changed())
        )
        val_float.valueChanged.connect(
            lambda _v: (update_csum(), self._emit_changed())
        )
        def on_raw_edit() -> None:
            """用结构化条件编辑器改这条「表单画不出来」的条件。"""
            dlg = QDialog(self)
            dlg.setWindowTitle("编辑条件")
            dlg.setMinimumSize(560, 420)
            lay = QVBoxLayout(dlg)
            tip = QLabel(
                "本条件用了逐行表单画不出来的写法。这里改完点「确定」原样写回；"
                "点「取消」则一个字都不动。",
                dlg,
            )
            tip.setWordWrap(True)
            lay.addWidget(tip)
            tree = ConditionExprTreeRootWidget(
                dlg,
                model_getter=lambda: (
                    self._project_model_getter() if self._project_model_getter else None
                ),
            )
            tree.set_expr(copy.deepcopy(raw_passthrough["v"]))
            lay.addWidget(tree, 1)
            btns = QHBoxLayout()
            ok_b = QPushButton("确定", dlg)
            cancel_b = QPushButton("取消", dlg)
            ok_b.clicked.connect(dlg.accept)
            cancel_b.clicked.connect(dlg.reject)
            btns.addStretch(1)
            btns.addWidget(ok_b)
            btns.addWidget(cancel_b)
            lay.addLayout(btns)
            if dlg.exec() != QDialog.DialogCode.Accepted:
                return
            new_expr = tree.get_expr()
            if not isinstance(new_expr, dict) or not new_expr:
                # 清空会让本分支变成「无条件」= 运行时恒命中；宁可不动也不放行。
                QMessageBox.warning(
                    self,
                    "编辑条件",
                    "条件被清空了。空条件在运行时等于「无条件命中」，"
                    "会让本分支之后的所有分支和 else 都走不到。\n\n"
                    "已保留原条件不变；要去掉这条请用条件行右侧的删除按钮。",
                )
                return
            raw_passthrough["v"] = copy.deepcopy(new_expr)
            try:
                raw_lbl.setText(json.dumps(new_expr, ensure_ascii=False, indent=2))
            except (TypeError, ValueError):
                raw_lbl.setText(str(new_expr))
            update_csum()
            self._emit_changed()

        btn_raw_edit.clicked.connect(on_raw_edit)

        upd_mode()
        update_csum()

        def flip_c() -> None:
            crow["collapsed"] = not crow["collapsed"]
            body.setVisible(not crow["collapsed"])
            ctog.setArrowType(
                Qt.ArrowType.RightArrow
                if crow["collapsed"]
                else Qt.ArrowType.DownArrow
            )

        ctog.clicked.connect(flip_c)

        def cond_row_index() -> int:
            return cond_rows.index(crow)

        c_before.clicked.connect(lambda: insert_cond_at(cond_row_index()))
        c_after.clicked.connect(lambda: insert_cond_at(cond_row_index() + 1))

        def do_c_up() -> None:
            i = cond_row_index()
            if i <= 0:
                return
            cond_rows[i - 1], cond_rows[i] = cond_rows[i], cond_rows[i - 1]
            rebuild_cond_layout()
            refresh_cond_nav()
            self._emit_structural_changed()

        def do_c_down() -> None:
            i = cond_row_index()
            if i < 0 or i >= len(cond_rows) - 1:
                return
            cond_rows[i + 1], cond_rows[i] = cond_rows[i], cond_rows[i + 1]
            rebuild_cond_layout()
            refresh_cond_nav()
            self._emit_structural_changed()

        def do_c_del() -> None:
            if len(cond_rows) <= 1:
                QMessageBox.information(
                    self,
                    "switch 条件",
                    "每个分支至少保留一条条件。\n\n"
                    "一条条件都没有的分支，运行时会「无条件命中」——"
                    "它后面的所有分支和 else 就永远走不到了。\n"
                    "要去掉这条分支，请用分支标题栏最右边的删除按钮。",
                )
                return
            i = cond_row_index()
            # 同上：写好的一条条件不该被误点一下就没。
            _cond_txt = condition_expr_text(serialize())
            if _cond_txt:
                r = QMessageBox.question(
                    self,
                    "删除条件",
                    f"确定删除第 {i} 条条件？\n\n{shorten(_cond_txt, 40)}",
                    QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                    QMessageBox.StandardButton.Cancel,
                )
                if r != QMessageBox.StandardButton.Ok:
                    return
            cond_rows.pop(i)
            # 这里曾写 `cond_rows_layout.removeWidget(cow)` —— 那个名字是 _build_switch
            # 闭包里的局部变量，本方法被抽出去之后从没传进来，于是「删除本条件」按钮
            # **每次都抛 NameError**：行已从 cond_rows 里 pop 掉，但控件没移除、界面不刷新、
            # 模型不变、也不标脏；策划看着像「按钮坏了」，直到他改点别的触发一次
            # get_node()，这次删除才延迟生效——删除动作与生效时刻错位，最难查的一类。
            # 用已传入的 rebuild_cond_layout 重排，控件由它 setParent(None) 后再销毁。
            cow.setParent(None)
            cow.deleteLater()
            rebuild_cond_layout()
            refresh_cond_nav()
            refresh_cond_fold_policy()
            update_case_summary()
            self._emit_structural_changed()

        c_up.clicked.connect(do_c_up)
        c_down.clicked.connect(do_c_down)
        c_del.clicked.connect(do_c_del)

        col.addLayout(ch)
        col.addWidget(body)
        body.setVisible(False)
        crow.update(
            {
                "outer": cow,
                "toggle": ctog,
                "body": body,
                "serialize": serialize,
                # 四个操作按钮都登记进 record：护栏必须从按钮本身 click() 进，
                # 否则「删除本条件」那种 100% 抛异常的死按钮再多测试也抓不到。
                "btn_before": c_before,
                "btn_after": c_after,
                "btn_up": c_up,
                "btn_down": c_down,
                "btn_del": c_del,
            }
        )
        return crow

    def _owner_wrapper_state_options(self) -> dict[str, Any]:
        from tools.editor.shared.narrative_catalog import resolve_owner_wrapper_states

        dialogue_id = ""
        if self._dialogue_graph_id_getter:
            dialogue_id = str(self._dialogue_graph_id_getter() or "").strip()
        model = self._project_model_getter() if self._project_model_getter else None
        if not dialogue_id or model is None:
            return {"stateIds": [], "ambiguous": False, "message": "无法解析对话图 id 或工程模型"}
        return resolve_owner_wrapper_states(self._project_root, model, dialogue_id)

    def _make_state_branch_rows(
        self,
        data: dict[str, Any],
        *,
        state_options: list[str],
        include_missing: bool,
    ) -> tuple[list[dict[str, Any]], QLineEdit, QLineEdit | None, Callable[[], dict[str, Any]]]:
        """构建 ownerState/contextState 的 cases UI，返回 (case_rows, default_next, missing_next, getter_factory)。"""
        cases_wrap = QWidget(self._body)
        cases_outer = QVBoxLayout(cases_wrap)
        cases_outer.setContentsMargins(0, 0, 0, 0)
        case_rows: list[dict[str, Any]] = []

        _state_hint_ref: dict[str, Any] = {"w": None}

        def rebuild_cases_layout() -> None:
            while cases_outer.count():
                it = cases_outer.takeAt(0)
                w = it.widget()
                if w is not None:
                    w.setParent(None)
            for c in case_rows:
                cases_outer.addWidget(c["outer"])
            _hint = _state_hint_ref.get("w")
            if _hint is not None:
                cases_outer.addWidget(_hint)
                _hint.setVisible(not case_rows)
            cases_outer.addWidget(btn_add)
            for c in case_rows:  # 序号依赖行位置，结构变了要重刷标题
                fn = c.get("refresh_summary")
                if callable(fn):
                    fn()

        def refresh_state_nav() -> None:
            n = len(case_rows)
            for i, c in enumerate(case_rows):
                c["btn_up"].setEnabled(i > 0)
                c["btn_down"].setEnabled(i < n - 1)

        def make_case_block(
            case: dict[str, Any] | None, *, orig_present: bool = False
        ) -> dict[str, Any]:
            outer = QWidget(cases_wrap)
            lay = QVBoxLayout(outer)
            row = QHBoxLayout()
            state_cb = QComboBox(outer)
            state_cb.setEditable(True)
            state_cb.addItem("")
            for sid in state_options:
                if sid and state_cb.findText(sid) < 0:
                    state_cb.addItem(sid)
            state_cb.setCurrentText(str((case or {}).get("state", "") or ""))
            # 排两行：一行「状态 + 五个操作按钮」，一行「去哪 + 选择器」。
            # 挤成一行的最小宽度是 360px+，而检查器面板默认只有 280px——结果是整个面板
            # 横向滚动，右端的删除/上移/下移按钮被挤出可视区、根本点不到。
            row2 = QHBoxLayout()
            row.addWidget(QLabel("状态", outer))
            row.addWidget(state_cb, 1)
            nx = QLineEdit(str((case or {}).get("next", "")), outer)
            btn = QPushButton("选…", outer)
            btn.setToolTip("从本图节点里挑一个作为这条分支的去处")
            btn.clicked.connect(lambda _c=False, le=nx: self._pick_target(le))
            self._install_target_validation(nx)
            row2.addWidget(QLabel("去哪", outer))
            row2.addWidget(nx, 1)
            row2.addWidget(btn)
            b_before, b_after, b_up, b_down, b_del = _compact_row_nav_buttons(
                outer,
                tip_before="在此分支之前插入空分支",
                tip_after="在此分支之后插入空分支",
                tip_up="本分支上移",
                tip_down="本分支下移",
                tip_del="删除本分支（可以删空，校验面板会提醒）",
            )
            # 接与 switch 分支 / choice 选项 / 条件行同一个自适应行头：
            # 窄面板按钮另起一行、宽面板并回摘要行，且带右键菜单。
            # 不接的话这两种节点还是老手感——两个方形按钮上印着谁也认不出的 `…`
            #（那其实是"插入空分支"，而空分支在运行时是恒命中的）。
            _hdr = QVBoxLayout()
            _state_summary = _ElidingLabel("", outer)
            _state_summary.setStyleSheet(app_theme.semantic_text_css("muted"))

            def _state_row_is_written(cb: dict[str, Any]) -> bool:
                """这一行会不会真的写进 JSON —— 必须与 getter 的丢弃判据**逐字一致**。

                getter 刻意丢弃「新加但从未填写」的空行（见 build_getter），而序号若按
                表单行位置算，这条空行就占了一个数据里根本不存在的号，其后每行顺移。
                这与 `_row_data_indices` 必须复刻 `_reinsert_junk` 是同一条规律：
                **凡是显示给人的下标，都只能由写盘那条唯一路径反算，不能由行位置推。**
                """
                st = cb["state_edit"].currentText().strip()
                nx_v = cb["next_edit"].text().strip()
                return bool(st or nx_v or cb.get("orig_present"))

            def _state_data_index() -> int:
                """本行在写盘数组里的下标；本行不会写盘时返回 -1（不给序号）。"""
                try:
                    row_i = case_rows.index(rec)
                except (ValueError, NameError):
                    return -1
                if not _state_row_is_written(rec):
                    return -1
                kept_before = sum(1 for c in case_rows[:row_i] if _state_row_is_written(c))
                kept_total = sum(1 for c in case_rows if _state_row_is_written(c))
                mapping = _row_data_indices(kept_total, state_cases_junk)
                return mapping[kept_before] if kept_before < len(mapping) else -1

            def _sync_state_summary() -> None:
                st = state_cb.currentText().strip() or "（未选状态）"
                tgt = nx.text().strip() or "（未填去哪）"
                # 带序号：校验消息说「分支 N」，这两类节点原来一个数字都没有，
                # 策划只能 1-based / 0-based 猜着数，坏元素还占一个号。
                idx = _state_data_index()
                if idx >= 0:
                    _state_summary.setText(f"{idx}. {st}  →  {tgt}")
                else:
                    # 没填完的新行不会写进 JSON，也就没有数据下标——明说，
                    # 免得它顶着一个假号混在正常分支里。
                    _state_summary.setText(f"（未填完，暂不写入）{st}  →  {tgt}")

            _fill_stacked_row_header(
                _hdr, QToolButton(outer), _state_summary,
                (b_before, b_after, b_up, b_down, b_del),
            )
            lay.setContentsMargins(0, 0, 0, 0)
            lay.setSpacing(2)
            lay.addLayout(_hdr)
            lay.addLayout(row)
            lay.addLayout(row2)
            def _refresh_all_state_summaries() -> None:
                # 某行从"未填"变成"填了"会让**其后所有行**的数据下标整体后移，
                # 所以任何一行变化都得全体重刷，不能只刷自己。
                for c in case_rows:
                    fn = c.get("refresh_summary")
                    if callable(fn):
                        fn()

            state_cb.currentTextChanged.connect(lambda _t: _refresh_all_state_summaries())
            nx.textChanged.connect(lambda _t: _refresh_all_state_summaries())
            _sync_state_summary()

            rec = {
                "outer": outer,
                "state_edit": state_cb,
                "next_edit": nx,
                # 四个操作按钮都登记：护栏必须从按钮本身 click() 进
                "btn_before": b_before,
                "btn_after": b_after,
                "btn_del": b_del,
                "summary_label": _state_summary,
                "data_index": _state_data_index,
                "refresh_summary": _sync_state_summary,
                "btn_up": b_up,
                "btn_down": b_down,
                "orig_present": orig_present,
            }

            def row_index() -> int:
                return case_rows.index(rec)

            def do_del() -> None:
                # 与 switch 分支 / choice 选项同一套手感：有内容才二次确认、**允许删空**。
                # 原来是硬拦「至少保留一条状态分支」——那是用「让编辑进不去」来拦非法数据，
                # 与机制卡硬契约 §7 的取向相反（非法数据交给校验层报，不挡编辑）；
                # 而且策划想清空重来时只能留一条没用的占位分支。
                # 删空后由校验提示「没有状态分支，将始终走…」，不会静默。
                label = state_cb.currentText().strip() or nx.text().strip()
                if label:
                    r = QMessageBox.question(
                        self,
                        "删除分支",
                        f"确定删除分支 {_state_data_index()}？\n\n{state_cb.currentText().strip() or '（未选状态）'}"
                        f"  →  {nx.text().strip() or '（未填去哪）'}",
                        QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel,
                        QMessageBox.StandardButton.Cancel,
                    )
                    if r != QMessageBox.StandardButton.Ok:
                        return
                case_rows.remove(rec)
                outer.setParent(None)
                outer.deleteLater()
                rebuild_cases_layout()
                refresh_state_nav()
                self._emit_structural_changed()

            def insert_at(pos: int) -> None:
                nb = make_case_block({"state": "", "next": ""})
                pos = max(0, min(pos, len(case_rows)))
                case_rows.insert(pos, nb)
                rebuild_cases_layout()
                refresh_state_nav()
                self._emit_structural_changed()

            def do_up() -> None:
                i = row_index()
                if i <= 0:
                    return
                case_rows[i - 1], case_rows[i] = case_rows[i], case_rows[i - 1]
                rebuild_cases_layout()
                refresh_state_nav()
                self._emit_changed()

            def do_down() -> None:
                i = row_index()
                if i < 0 or i >= len(case_rows) - 1:
                    return
                case_rows[i + 1], case_rows[i] = case_rows[i], case_rows[i + 1]
                rebuild_cases_layout()
                refresh_state_nav()
                self._emit_changed()

            b_before.clicked.connect(lambda: insert_at(row_index()))
            b_after.clicked.connect(lambda: insert_at(row_index() + 1))
            b_up.clicked.connect(do_up)
            b_down.clicked.connect(do_down)
            b_del.clicked.connect(do_del)
            state_cb.currentTextChanged.connect(lambda _t: self._emit_changed())
            nx.textChanged.connect(lambda _t: self._emit_changed())
            return rec

        cases_raw, state_cases_junk = _split_dict_items(data.get("cases"))
        # 空就如实显示空——不再凭空补一行空分支。switch/choice 早就移除了这个模式
        # （见 §8「空集合不许替用户造内容」）；放开删空之后，"空"变成了正常编辑
        # 就能到的常态，再补假行就会天天见到「（未填完，暂不写入）」那种半成品行。
        for c in cases_raw:
            case_rows.append(make_case_block(c, orig_present=True))
        state_empty_hint = QLabel(
            "本节点当前没有状态分支，运行时会直接走「都不满足走这里」。"
            "点下方「在末尾添加分支」新增。",
            cases_wrap,
        )
        state_empty_hint.setWordWrap(True)
        state_empty_hint.setStyleSheet(app_theme.semantic_text_css("warn"))
        _state_hint_ref["w"] = state_empty_hint
        _junk_lbl = _junk_notice(state_cases_junk, "分支")
        if _junk_lbl is not None:
            _junk_lbl.setParent(self._body)
            self._body_layout.addWidget(_junk_lbl)
        btn_add = QPushButton("在末尾添加分支", cases_wrap)
        btn_add.setToolTip("按 wrapper 状态多加一条分支")
        def do_add() -> None:
            case_rows.append(make_case_block({"state": "", "next": ""}))
            rebuild_cases_layout()
            refresh_state_nav()
            self._emit_changed()

        btn_add.clicked.connect(do_add)
        rebuild_cases_layout()
        refresh_state_nav()
        self._body_layout.addWidget(cases_wrap)

        dn = QLineEdit(str(data.get("defaultNext", "") or ""), self._body)
        row_dn = QHBoxLayout()
        _lbl_dn2 = QLabel("都不满足走这里", self._body)
        _lbl_dn2.setToolTip("JSON 字段 defaultNext：以上分支都不命中时跳到哪个节点")
        row_dn.addWidget(_lbl_dn2)
        row_dn.addWidget(dn, 1)
        btn_dn = QPushButton("选…", self._body)
        btn_dn.clicked.connect(lambda: self._pick_target(dn))
        row_dn.addWidget(btn_dn)
        self._body_layout.addLayout(row_dn)
        self._install_target_validation(dn)

        missing_next: QLineEdit | None = None
        if include_missing:
            missing_next = QLineEdit(str(data.get("missingWrapperNext", "") or ""), self._body)
            row_mn = QHBoxLayout()
            _lbl_mw = QLabel("找不到实体时", self._body)
            _lbl_mw.setToolTip("JSON 字段 missingWrapperNext：解析不到所属实体的 wrapper 图时走这里")
            row_mn.addWidget(_lbl_mw)
            row_mn.addWidget(missing_next, 1)
            btn_mn = QPushButton("选…", self._body)
            btn_mn.clicked.connect(lambda: self._pick_target(missing_next))
            row_mn.addWidget(btn_mn)
            self._body_layout.addLayout(row_mn)
            missing_next.textChanged.connect(lambda _t: self._emit_changed())
            self._install_target_validation(missing_next)
        dn.textChanged.connect(lambda _t: self._emit_changed())

        def build_getter(node_type: str, graph_id: str = "") -> Callable[[], dict[str, Any]]:
            def getter() -> dict[str, Any]:
                cs = []
                for cb in case_rows:
                    st = cb["state_edit"].currentText().strip()
                    nx_v = cb["next_edit"].text().strip()
                    # 原本就存在的分支即使 state/next 都空也忠实保留（零丢失往返）；
                    # 仅丢弃「新加但从未填写」的空行，避免持久化误加的空分支。
                    if st or nx_v or cb.get("orig_present"):
                        cs.append({"state": st, "next": nx_v})
                out: dict[str, Any] = {
                    "type": node_type,
                    "cases": _reinsert_junk(cs, state_cases_junk),
                    "defaultNext": dn.text().strip(),
                }
                if include_missing and missing_next is not None:
                    mn_v = missing_next.text().strip()
                    # 原本没这个键、用户也没填 → 不注入空串（表单形状保真回写）。
                    if mn_v or "missingWrapperNext" in data:
                        out["missingWrapperNext"] = mn_v
                if graph_id:
                    out["graphId"] = graph_id
                return out

            return getter

        return case_rows, dn, missing_next, build_getter

    def _build_owner_state(self, data: dict[str, Any]) -> None:
        info = self._owner_wrapper_state_options()
        self._body_layout.addWidget(
            _help_marker(
                "数据源：当前对话所属实体的 wrapper 状态（运行时 ownerType/ownerId）。\n"
                f"{info.get('message', '')}",
                self._body,
            )
        )
        if info.get("ambiguous"):
            warn = QLabel("警告：多个 NPC/Hotspot 共用本对话图，state 列表为并集，运行时按当前交互实体解析。", self._body)
            warn.setWordWrap(True)
            warn.setStyleSheet(app_theme.semantic_text_css("warn"))
            self._body_layout.addWidget(warn)

        # 解不出 owner 时把「这张图从哪儿被打开、哪几处没 owner」直接摆出来：
        # 以前只给一句"未找到引用"，策划无从下手；现在照着调用点去补就行。
        if not (info.get("wrappers") or []):
            sites = [s for s in (info.get("sites") or []) if isinstance(s, dict)]
            if sites:
                lines = []
                for s in sites[:6]:
                    owner = f"{s.get('ownerType', '')}:{s.get('ownerId', '')}".strip(":")
                    lines.append(f"· {s.get('detail', '?')} → {owner or '解不出 owner'}")
                more = f"\n…共 {len(sites)} 处" if len(sites) > 6 else ""
                tip = QLabel("这张对话图的调用点：\n" + "\n".join(lines) + more, self._body)
            else:
                tip = QLabel("全工程还没有任何地方打开这张对话图——接上线之后 owner 才解得出来。", self._body)
            tip.setWordWrap(True)
            tip.setStyleSheet(app_theme.semantic_text_css("warn"))
            self._body_layout.addWidget(tip)

        wrappers = [w for w in (info.get("wrappers") or []) if isinstance(w, dict)]
        wrapper_map: dict[str, dict[str, Any]] = {}
        wrapper_order: list[str] = []
        for wrapper in wrappers:
            gid = str(wrapper.get("graphId", "") or "").strip()
            if not gid or gid in wrapper_map:
                continue
            wrapper_map[gid] = wrapper
            wrapper_order.append(gid)

        # 磁盘上有没有 wrapperGraphId 这个键，语义完全不同：
        #   有 → 硬绑定到这张 wrapper 图；
        #   无 → 运行时按当前 owner 动态解算（同一张对话图给多个 NPC/hotspot 复用）。
        # 所以「本实体恰好只有一张 wrapper」时的自动选中只能作 UI 展示，绝不能顺手
        # 写进 JSON——否则「点开这个节点看一眼再点别的」就把复用型节点焊死了
        #（审查 2026-08-06 P1-1）。
        _orig_has_wrapper_key = "wrapperGraphId" in data
        selected_wrapper_id = str(data.get("wrapperGraphId", "") or "").strip()
        _auto_filled_wrapper = ""
        if not selected_wrapper_id and len(wrapper_order) == 1:
            selected_wrapper_id = wrapper_order[0]
            _auto_filled_wrapper = selected_wrapper_id

        row_wid = QHBoxLayout()
        _lbl_wg = QLabel("绑定叙事图", self._body)
        _lbl_wg.setToolTip("JSON 字段 wrapperGraphId：留空=运行时按当前实体动态解算（同一张对话图可给多个实体复用）")
        row_wid.addWidget(_lbl_wg)
        wrapper_edit = QLineEdit(selected_wrapper_id, self._body)
        wrapper_edit.setPlaceholderText("选择或输入 wrapper graphId")
        row_wid.addWidget(wrapper_edit, 1)
        btn_pick_wrapper = QPushButton("选…", self._body)
        btn_pick_wrapper.setToolTip("从本对话图所属实体的 wrapper 叙事图里挑一张")
        row_wid.addWidget(btn_pick_wrapper)
        self._body_layout.addLayout(row_wid)

        wrapper_detail = QLabel(self._body)
        wrapper_detail.setWordWrap(True)
        wrapper_detail.setStyleSheet(app_theme.semantic_text_css("info"))
        self._body_layout.addWidget(wrapper_detail)

        def _current_wrapper_graph_id() -> str:
            return wrapper_edit.text().strip()

        def _wrapper_detail_text(gid: str) -> str:
            wrapper = wrapper_map.get(gid)
            if not wrapper:
                return "没绑叙事图：这个实体有多张 wrapper 图时，运行时会走「找不到实体时」或「都不满足走这里」。"
            owner_type = str(wrapper.get("ownerType", "") or "").strip()
            owner_id = str(wrapper.get("ownerId", "") or "").strip()
            category = str(wrapper.get("category", "") or "").strip()
            comp = str(wrapper.get("compositionLabel", "") or wrapper.get("compositionId", "") or "").strip()
            element = str(wrapper.get("elementId", "") or "").strip()
            states = [str(x) for x in (wrapper.get("stateIds") or []) if str(x).strip()]
            parts = [
                f"实体：{owner_type}:{owner_id}" if owner_type or owner_id else "",
                f"分类：{category}" if category else "分类：未填写",
                f"编排：{comp}" if comp else "",
                f"元素：{element}" if element else "",
                f"状态：{', '.join(states)}" if states else "状态：无",
            ]
            return "　".join(part for part in parts if part)

        def _refresh_wrapper_detail() -> None:
            wrapper_detail.setText(_wrapper_detail_text(_current_wrapper_graph_id()))

        def _state_ids_for_wrapper(gid: str) -> list[str]:
            g = str(gid or "").strip()
            if g:
                hit = wrapper_map.get(g)
                if isinstance(hit, dict):
                    return [str(x) for x in (hit.get("stateIds") or []) if str(x).strip()]
                # 手选/手输了一张不在 owner 解算结果里的 wrapper（owner 静态解不出、
                # 或显式绑到别的实体）：直接去叙事目录读它的状态，不能让状态下拉空着
                # ——状态选不了就等于 ownerState 节点编不下去。
                if not g.startswith("@"):
                    try:
                        from tools.editor.shared.narrative_catalog import graph_info

                        detail = graph_info(self._project_root, g)
                    except Exception:
                        detail = None
                    if isinstance(detail, dict):
                        ids = [str(x) for x in (detail.get("stateIds") or []) if str(x).strip()]
                        if ids:
                            wrapper_map.setdefault(g, detail)
                            return ids
            return [str(x) for x in (info.get("stateIds") or []) if str(x).strip()]

        state_ids = _state_ids_for_wrapper(selected_wrapper_id)
        btn_refresh = QPushButton("刷新状态", self._body)
        btn_refresh.setToolTip("重新从 wrapper 叙事图读取状态列表")
        self._body_layout.addWidget(btn_refresh)

        case_rows, dn, missing_next, build_getter = self._make_state_branch_rows(
            data,
            state_options=state_ids,
            include_missing=True,
        )

        def _apply_state_options(ids: list[str]) -> None:
            for row in case_rows:
                cb = row.get("state_edit")
                if not isinstance(cb, QComboBox):
                    continue
                cur = cb.currentText()
                cb.blockSignals(True)
                try:
                    cb.clear()
                    cb.addItem("")
                    for sid in ids:
                        cb.addItem(sid)
                    cb.setCurrentText(cur)
                finally:
                    cb.blockSignals(False)

        def _node_snapshot() -> Any:
            try:
                return self._getter() if self._getter else None
            except Exception:
                return None

        def refresh_states() -> None:
            nonlocal info
            # 「刷新 wrapper 状态列表」只是重新查目录、重填下拉选项，本身不改动已编辑数据。
            # 用序列化快照前后比对，唯有实质变化才标脏，杜绝点一下刷新就变「未保存」。
            _before = _node_snapshot()
            refreshed = self._owner_wrapper_state_options()
            info = refreshed
            wrappers2 = [w for w in (refreshed.get("wrappers") or []) if isinstance(w, dict)]
            new_map: dict[str, dict[str, Any]] = {}
            new_order: list[str] = []
            for wrapper in wrappers2:
                gid = str(wrapper.get("graphId", "") or "").strip()
                if not gid or gid in new_map:
                    continue
                new_map[gid] = wrapper
                new_order.append(gid)

            cur_gid = _current_wrapper_graph_id()
            wrapper_map.clear()
            wrapper_map.update(new_map)
            wrapper_order.clear()
            wrapper_order.extend(new_order)
            wrapper_edit.setText(cur_gid)

            ids = _state_ids_for_wrapper(_current_wrapper_graph_id())
            _apply_state_options(ids)
            _refresh_wrapper_detail()
            if _node_snapshot() != _before:
                self._emit_changed()

        def on_wrapper_changed(_t: str = "") -> None:
            ids = _state_ids_for_wrapper(_current_wrapper_graph_id())
            _apply_state_options(ids)
            _refresh_wrapper_detail()
            self._emit_changed()

        def pick_wrapper() -> None:
            from .wrapper_graph_picker_dialog import WrapperGraphPickerDialog

            choices = [wrapper_map[gid] for gid in wrapper_order if gid in wrapper_map]
            # owner 解出来时优先只列本实体的 wrapper（选错的概率最低）；解不出时
            # 退到全工程实体 wrapper 清单——否则弹窗是空的，节点根本编不下去。
            if not choices:
                try:
                    from tools.editor.shared.narrative_catalog import list_entity_wrapper_graphs

                    choices = list_entity_wrapper_graphs(self._project_root)
                except Exception:
                    choices = []
            dlg = WrapperGraphPickerDialog(
                choices,
                initial_id=_current_wrapper_graph_id(),
                parent=self,
            )
            if dlg.exec() != QDialog.DialogCode.Accepted:
                return
            wrapper_edit.setText(dlg.selected_id())

        wrapper_edit.textChanged.connect(on_wrapper_changed)
        btn_pick_wrapper.clicked.connect(pick_wrapper)
        btn_refresh.clicked.connect(refresh_states)
        _refresh_wrapper_detail()
        self._topology_refs = {
            "type": "ownerState",
            "case_rows": case_rows,
            "default_next": dn,
            "missing_next": missing_next,
            "wrapper_graph_id_edit": wrapper_edit,
        }

        def getter() -> dict[str, Any]:
            base = build_getter("ownerState")()
            cur = _current_wrapper_graph_id()
            # 原本没这个键、而且框里的值只是我们自动填上去展示的 → 保持不写，
            # 让运行时继续按当前 owner 动态解算。用户真选过（值变了）才写出。
            if not _orig_has_wrapper_key and cur == _auto_filled_wrapper:
                base.pop("wrapperGraphId", None)
            else:
                base["wrapperGraphId"] = cur
            return base

        self._getter = getter

    def _build_context_state(self, data: dict[str, Any]) -> None:
        from tools.editor.shared.narrative_catalog import (
            CONTEXT_GRAPH_CROSS_ENTITY,
            CONTEXT_GRAPH_MISSING,
            classify_context_graph,
            graph_states,
            list_context_state_graphs,
        )

        _CONTEXT_BASE_TIP = (
            "按另一张叙事图的当前状态分支。\n"
            "flow / scenario / scene 这类上层编排图随便读；\n"
            "读实体 wrapper（NPC/热区/区域/任务）也允许——那是「甲的对话按乙的状态分支」，"
            "但读「当前对话 owner 自己的状态」用 ownerState 节点或 @owner 更稳，"
            "免得把这张对话图焊死到一个具体实体 id 上。"
        )
        hint = _help_marker(_CONTEXT_BASE_TIP, self._body)
        self._body_layout.addWidget(hint)

        # 引用字段一律走弹窗选择器（editor-tools-norms 选择器铁律 §5 +
        # decisions/2026-07-11-dropdown-vs-popup-selector）：候选 40+ 且跨文件，
        # 长下拉本就是明令禁止的形状。附带修掉旧实现的两个真 bug——
        # ① 可编辑下拉逼出一套「按当前显示文本反查 itemData」的解析（
        #    production-tooling-requirements.md:301 记的「保存时用了当前显示的
        #    graphId」就是它），标签与真 id 对不上就写坏数据；
        # ② `currentTextChanged` 连 `_emit_changed`，程序性填值也会标脏。
        def _graph_rows() -> list[tuple[str, str, str]]:
            rows: list[tuple[str, str, str]] = [
                ("@owner", "当前对话 owner 的主 wrapper",
                 "相对 token：运行时按 owner 解析，不写死 id"),
                ("@scene", "本场景的 wrapper",
                 "相对 token：运行时按当前场景解析，不写死 id"),
            ]
            for g in list_context_state_graphs(self._project_root):
                gid = str(g.get("graphId", "") or "").strip()
                if gid:
                    rows.append((
                        gid,
                        str(g.get("label", "") or gid),
                        str(g.get("detail", "") or ""),
                    ))
            return rows

        gid_field = ReferencePickerField(
            _graph_rows,
            self._body,
            allow_empty=True,
            title="选择叙事图",
            geometry_key="dialogue_context_state_graph_picker",
        )
        gid_field.setToolTip("JSON 字段 graphId：按这张叙事图的当前状态分支")
        gid_field.set_value(str(data.get("graphId", "") or ""))
        _lbl_gid = QLabel("读哪张叙事图", self._body)
        _lbl_gid.setToolTip("JSON 字段 graphId：按这张叙事图的当前状态分支")
        # 竖排而不是「标签 + 控件」一行：检查器只有 280px 预算，弹窗选择器本身就是
        # 只读框 + 三颗按钮，再挤个标签进去就把「清空」顶出可视区（界面硬契约 §15）。
        self._body_layout.addWidget(_lbl_gid)
        self._body_layout.addWidget(gid_field)

        state_options = graph_states(self._project_root, gid_field.current_value())

        case_rows, dn, _missing, build_getter = self._make_state_branch_rows(
            data,
            state_options=state_options,
            include_missing=False,
        )

        def _refresh_graph_verdict() -> None:
            """把 graphId 的判定画到「ⓘ 说明」上：缺失=红，跨实体=黄，其余=常态。

            光变颜色不够——说明本身收在 tooltip 里（布局纪律），所以判定也要写进
            tooltip，否则策划看见黄字却无从知道黄在哪。
            """
            gid = gid_field.current_value().strip()
            verdict = ""
            owner_type = ""
            if gid and not gid.startswith("@"):
                verdict, owner_type = classify_context_graph(self._project_root, gid)
            if verdict == CONTEXT_GRAPH_MISSING:
                hint.setStyleSheet(app_theme.semantic_text_css("error"))
                hint.setToolTip(
                    f"⛔ {gid} 不在 narrative_graphs 里——悬垂引用，保存时会报 error。\n\n"
                    f"{_CONTEXT_BASE_TIP}",
                )
            elif verdict == CONTEXT_GRAPH_CROSS_ENTITY:
                hint.setStyleSheet(app_theme.semantic_text_css("warn"))
                hint.setToolTip(
                    f"⚠ 这是跨实体读取：{gid} 是 {owner_type or '未知归属'} 的 wrapper。\n"
                    "有意为之就没问题（保存不拦，只提醒）；\n"
                    "要读的其实是「当前对话 owner 自己」的话，改用 ownerState 节点或 @owner。\n\n"
                    f"{_CONTEXT_BASE_TIP}",
                )
            else:
                hint.setStyleSheet(app_theme.semantic_text_css("faint"))
                hint.setToolTip(_CONTEXT_BASE_TIP)

        def on_graph_changed(_value: str = "") -> None:
            gid = gid_field.current_value()
            ids = graph_states(self._project_root, gid)
            for row in case_rows:
                cb = row.get("state_edit")
                if not isinstance(cb, QComboBox):
                    continue
                cur = cb.currentText()
                cb.blockSignals(True)
                try:
                    cb.clear()
                    cb.addItem("")
                    for sid in ids:
                        cb.addItem(sid)
                    cb.setCurrentText(cur)
                finally:
                    cb.blockSignals(False)
            _refresh_graph_verdict()
            self._emit_changed()

        # 只有真实用户选择才走这里（ReferencePickerField 的程序性 set_value /
        # refresh_display 从不发 value_changed）。
        gid_field.value_changed.connect(on_graph_changed)
        _refresh_graph_verdict()

        self._topology_refs = {
            "type": "contextState",
            "case_rows": case_rows,
            "default_next": dn,
            "graph_id_edit": gid_field,
        }

        def getter() -> dict[str, Any]:
            base = build_getter("contextState", gid_field.current_value())()
            return base

        self._getter = getter

    def _node_summaries_for_picker(self) -> dict[str, str]:
        """节点 id → 一行摘要（与左侧节点列表同源）。取不到就退化成空。"""
        getter = getattr(self, "_node_summaries_getter", None)
        if callable(getter):
            try:
                return getter() or {}
            except Exception:
                return {}
        return {}

    def _pick_target(self, line_edit: QLineEdit):
        ids = self._list_node_ids()
        if not ids:
            QMessageBox.information(self, "选择 next", "图中还没有节点 id。")
            return
        types = self._node_types_getter() if self._node_types_getter else None
        dlg = NodePickerDialog(
            ids,
            type_by_id=types,
            summary_by_id=self._node_summaries_for_picker(),
            title="选择目标节点",
            initial=line_edit.text().strip(),
            parent=self,
        )
        if dlg.exec() == QDialog.DialogCode.Accepted:
            line_edit.setText(dlg.selected_id())
