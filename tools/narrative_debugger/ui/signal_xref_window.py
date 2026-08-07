"""调试期的「信号关系」窗：这条信号谁发、谁听，**外加现在到底能不能推动谁**。

与编辑器那块面板刻意分开做，因为问的不是同一件事：

- 编辑器问「我改之前，牵连谁」——静态、全工程、能点着跳到发射那一行去改。
- 这里问「刚才那一下为什么没反应」——同样两侧，但每条监听都压上**此刻的运行时状态**：
  谁正等着这一下、谁停在别处、这条线跑没跑、本次会话它发过几次、结果如何。

两边共用 `tools.narrative_xref` 一套扫描口径（否则同一条信号在两个工具里显示不一样，
人就没法信任何一个），界面各做各的。

窗口是**非模态**的：策划要一边在游戏里走、一边看着这里的圆点变化，模态弹窗会把人挡死。
"""

from __future__ import annotations

from typing import Any, Callable

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSplitter,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from tools.narrative_debugger.humanize import DRAFT_SIGNAL, player_action_for, signal_phrase
from tools.narrative_debugger.model import NarrativeIndex
from tools.narrative_xref import CHANNEL_UPSTREAM, SignalIndex
from tools.narrative_xref.model import SignalCard

ROLE_SIGNAL = Qt.ItemDataRole.UserRole

# 运行时状态标记。别用红绿灯语义——"没在等"不是错误，只是现在不在那一步。
LIVE_MARK = "●"     # 起点对上、没有条件、这条线也在跑：打出去真会动
MAYBE_MARK = "◐"    # 起点对上，但还挂着条件 / 这条活计现在挂起着：不一定动
IDLE_MARK = "○"     # 有人听，但那些图现在都不在起点那一拍
OFF_MARK = "·"      # 根本没有转移听它

# 每条监听在此刻的处境。判定口径必须与运行时一致：
# - 活计图（run）只有在它是 activatedArchetype 时才参与扫描
#   （NarrativeStateManager.listScannableGraphEntries）；挂起的活计一个信号都不接。
# - 条件不满足时转移被拦（transition.blocked），静态数据判不出满不满足，只能如实说"挂着条件"。
STATUS_LIVE = "live"
STATUS_CONDITIONAL = "conditional"
STATUS_SUSPENDED = "suspended"
STATUS_IDLE = "idle"
STATUS_OFF = "off"

_KIND_TEXT = {"author": "作者信号", "derived": "派生信号", "draft": "草稿占位", "unknown": "没登记"}


def _esc(text: Any) -> str:
    return (
        str(text or "")
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


class SignalXrefWindow(QDialog):
    """非模态窗口：左边挑信号，右边看两侧 + 此刻状态。"""

    def __init__(
        self,
        xref: SignalIndex,
        index: NarrativeIndex,
        hub: Any,
        parent: QWidget | None = None,
        on_focus: Callable[[str], None] | None = None,
    ) -> None:
        super().__init__(parent)
        self.xref = xref
        self.index = index
        self.hub = hub
        self._on_focus = on_focus
        self._current = ""
        # 「查无此信号」的现场：置上之后列表不许自动选中任何一行（否则下一次运行时刷新
        # 就把红字换成第一条信号的卡，「就当这件事发生了」会打错信号）。用户自己点一行才清。
        self._missing = ""
        # 卡片列表缓存：运行时状态一变就重画列表，每次重算 100+ 张卡纯属白烧
        # （数据没变，变的只是"谁现在停在哪"）。换索引时清掉。
        self._cards_cache: list[SignalCard] | None = None

        self.setWindowTitle("信号关系 · 谁发谁听")
        self.setModal(False)
        self.resize(1080, 680)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(10, 10, 10, 10)
        outer.setSpacing(8)

        # Qt 的 QLabel 不认 markdown：写 **强调** 会原样显示成星号（截图实测），一律用「」。
        self.tip = QLabel()
        self.tip.setStyleSheet("color:#7a756e;")
        self.tip.setWordWrap(True)
        outer.addWidget(self.tip)

        head = QHBoxLayout()
        self.search = QLineEdit()
        self.search.setPlaceholderText("打几个字筛：信号名、发它的那段戏、听它的那张图都能搜")
        self.search.setClearButtonEnabled(True)
        self.search.textChanged.connect(lambda _t: self._rebuild_list())
        head.addWidget(self.search, 1)

        self.only_live = QCheckBox("只看现在能推动的")
        self.only_live.setToolTip("只留下「现在真有人在等」的信号——排查「我这下为什么没反应」时先看这个")
        self.only_live.toggled.connect(lambda _v: self._rebuild_list())
        head.addWidget(self.only_live)

        self.only_problem = QCheckBox("只看两侧对不齐的")
        self.only_problem.setToolTip("没人发 / 没人听 / 没登记 / 广播没开——这些是「点了没反应」的常见根因")
        self.only_problem.toggled.connect(lambda _v: self._rebuild_list())
        head.addWidget(self.only_problem)
        outer.addLayout(head)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        self.listing = QListWidget()
        self.listing.setAlternatingRowColors(True)
        self.listing.currentItemChanged.connect(self._on_pick)
        splitter.addWidget(self.listing)

        self.detail = QTextBrowser()
        self.detail.setOpenExternalLinks(False)
        self.detail.setOpenLinks(False)
        self.detail.anchorClicked.connect(self._on_anchor)
        splitter.addWidget(self.detail)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([340, 720])
        outer.addWidget(splitter, 1)

        buttons = QHBoxLayout()
        self.count_label = QLabel("")
        self.count_label.setStyleSheet("color:#7a756e;")
        buttons.addWidget(self.count_label)
        buttons.addStretch(1)

        self.focus_btn = QPushButton("在图上看这一拍")
        self.focus_btn.setToolTip("把中间那张因果图的焦点挪到第一个接收方那一拍（不动游戏）")
        self.focus_btn.clicked.connect(self._focus_first_listener)
        buttons.addWidget(self.focus_btn)

        self.fire_btn = QPushButton("就当这件事发生了")
        self.fire_btn.setToolTip("直接把这条信号打出去，用来验后面的路通不通（要先连上游戏）")
        self.fire_btn.clicked.connect(self._fire_current)
        buttons.addWidget(self.fire_btn)

        close = QPushButton("关掉")
        close.clicked.connect(self.close)
        buttons.addWidget(close)
        outer.addLayout(buttons)

        self._sync_tip()
        self._sync_only_live_enabled()
        self._rebuild_list()
        self._sync_buttons()

    def _sync_tip(self) -> None:
        """顶部那句话要跟着连接状态改口：断线之后圆点说的是最后一次连着时的世界，
        还照着"此刻"讲就是骗人。"""
        if self._connected():
            self.tip.setText(
                "一条信号只有两侧：谁把它打出去、谁在等它。圆点是「此刻」的状态："
                "● 正等着这一下，◐ 起点对上了但还挂着条件（或这条活计挂起着），"
                "○ 听它的图现在不在起点那一拍，· 根本没有转移听它。"
            )
        else:
            self.tip.setText(
                "游戏没连上——下面是静态关系，圆点看不出「此刻」谁在等。"
                "（○ 有人听，· 没人听）"
            )

    # ------------------------------------------------------------------ 外部接口
    def set_indexes(self, xref: SignalIndex, index: NarrativeIndex) -> None:
        """主窗「重新读一遍数据」之后换索引：保住当前选中的信号，别把人踢回列表头。"""
        self.xref = xref
        self.index = index
        self._cards_cache = None
        # 换了数据就重试一次刚才那条查不到的信号——「重新读一遍数据」正是为了这个；
        # 抱着旧的"查无此名"不放，等于让人重开窗口才看得见新加的信号。
        keep = self._current or self._missing
        self._missing = ""
        self._rebuild_list()
        if keep:
            self.show_signal(keep)

    def show_signal(self, signal: str) -> bool:
        """选中某条信号（从时间线/别处点进来），返回**有没有真找到**。

        被筛选挡住时先清筛选；索引里压根没有这条（刚加的信号、或者游戏跑的是另一份
        数据）时，绝不能把上一条的卡片留在右边——那比"点了没反应"更糟：给的是一个
        看着正确的错答案，连「就当这件事发生了」都会打错信号。
        """
        target = (signal or "").strip()
        if not target:
            return False
        if self._select_row(target):
            self._missing = ""
            return True
        self._missing = ""
        self.search.clear()
        self.only_live.setChecked(False)
        self.only_problem.setChecked(False)
        self._rebuild_list(keep_selection=False)
        if self._select_row(target):
            self._missing = ""
            return True
        self._current = ""
        self._missing = target
        self.listing.setCurrentRow(-1)
        self.detail.setHtml(
            "<p style='color:#c0392b'>这份扫描里没有信号"
            f"「{_esc(target)}」</p><p style='color:#7a756e'>多半是刚加的还没重读，"
            "或者游戏跑的是另一份数据。点主窗的「重新读一遍数据」再试。</p>"
        )
        self._sync_buttons()
        return False

    def _sync_only_live_enabled(self) -> None:
        connected = self._connected()
        self.only_live.setEnabled(connected)
        self.only_live.setToolTip(
            "只留下「现在真有人在等」的信号——排查「我这下为什么没反应」时先看这个"
            if connected else "游戏没连上，看不出现在谁在等"
        )

    def refresh_runtime(self) -> None:
        """状态变了（谁停在哪）：圆点与详情一起重画。不重扫数据。"""
        self._sync_tip()
        self._sync_only_live_enabled()
        # _rebuild_list 先 clear() 再重选，重选必然触发 _on_pick → _render；
        # 只有它没重选任何一行时才要自己补一次，否则每次运行时事件都白渲染两遍。
        rendered = self._rebuild_list(keep_selection=True)
        if not rendered and self._current:
            self._render(self._current)
        self._sync_buttons()

    def refresh_history(self) -> None:
        """只是时间线多了一条：左边圆点不受影响，重画右边就够（省得列表闪）。"""
        if self._current:
            self._render(self._current)

    # ------------------------------------------------------------------ 列表
    def _active_states(self) -> dict[str, str]:
        state = getattr(self.hub, "state", None)
        active = getattr(state, "active_states", None)
        return dict(active) if isinstance(active, dict) else {}

    def _listener_status(self, row: Any, active: dict[str, str]) -> str:
        """这条监听此刻是什么处境。**别只看起点对不对**：条件挡着、活计挂起着，
        都是"看着在等、其实不动"——报成"正等着"会把人送去改一个没坏的发射端。"""
        if active.get(row.graph_id) != row.from_state:
            return STATUS_IDLE if row.graph_id in active else STATUS_OFF
        if row.run_graph and self._activated_archetype() != row.graph_id:
            return STATUS_SUSPENDED
        return STATUS_CONDITIONAL if row.conditions else STATUS_LIVE

    def _activated_archetype(self) -> str:
        state = getattr(self.hub, "state", None)
        return str(getattr(state, "activated_archetype", "") or "")

    def _connected(self) -> bool:
        return bool(getattr(getattr(self.hub, "state", None), "connected", False))

    def _card_mark(self, card: SignalCard, active: dict[str, str] | None = None) -> str:
        """左栏那个圆点。游戏没连上时一律降级——绿点说的是"此刻"，
        断线后它说的是十分钟前的世界。"""
        if not card.listeners:
            return OFF_MARK
        if not self._connected():
            return IDLE_MARK
        active = self._active_states() if active is None else active
        statuses = [self._listener_status(row, active) for row in card.listeners]
        if STATUS_LIVE in statuses:
            return LIVE_MARK
        if STATUS_CONDITIONAL in statuses or STATUS_SUSPENDED in statuses:
            return MAYBE_MARK
        return IDLE_MARK

    def _live_listener_count(self, card: SignalCard, active: dict[str, str] | None = None) -> int:
        """现在真能推动的监听条数（起点对上 + 无条件 + 这条线在跑）。"""
        if not self._connected():
            return 0
        active = self._active_states() if active is None else active
        return sum(1 for row in card.listeners if self._listener_status(row, active) == STATUS_LIVE)

    def _cards(self) -> list[SignalCard]:
        if self._cards_cache is None:
            self._cards_cache = self.xref.overview()
        return self._cards_cache

    def _rebuild_list(self, keep_selection: bool = True) -> bool:
        """重建左栏，返回**有没有顺带把详情重画过**（选中行变化会触发 _on_pick → _render）。

        默认保住当前选中：搜索/勾选框每敲一下就把人踢回第一条，等于每次筛选都要重新
        找一遍自己刚才在看的那条信号。
        """
        keep = self._current if keep_selection else ""
        needle = self.search.text().strip().lower()
        only_live = self.only_live.isChecked()
        only_problem = self.only_problem.isChecked()

        active = self._active_states()
        self.listing.blockSignals(True)
        self.listing.clear()
        shown = 0
        for card in self._cards():
            live = self._live_listener_count(card, active)
            problem = any(d.severity in ("error", "warning") for d in card.diagnostics)
            if only_live and live == 0:
                continue
            if only_problem and not problem:
                continue
            if needle and needle not in self._haystack(card):
                continue
            mark = self._card_mark(card, active)
            # 有中文名就一起显示：真起过中文名的那几条，光看 id 认不出来是哪件事
            name = f"{card.signal}（{card.label}）" if card.label and card.label != card.signal else card.signal
            label = f"{mark} {name}"
            item = QListWidgetItem(
                f"{label}\n　　发 {card.real_emitter_count} · 听 {len(card.listeners)}"
                f"{'　⚠' if problem else ''}"
            )
            item.setData(ROLE_SIGNAL, card.signal)
            item.setToolTip(self._tooltip(card, live))
            if live:
                font = item.font()
                font.setBold(True)
                item.setFont(font)
                item.setForeground(QColor("#3f8c3f"))
            self.listing.addItem(item)
            shown += 1
        self.listing.blockSignals(False)

        total = len(self._cards())
        self.count_label.setText(f"{shown} / {total} 条信号")
        if keep and self._select_row(keep):
            return True
        if self._missing:
            # 上一次问的那条压根不在这份扫描里：保持红字现场，绝不悄悄换成第一行
            # （换了就等于给一个看着正确的错答案，还会把发信号按钮武装到别人身上）。
            self.listing.setCurrentRow(-1)
            return False
        # 选中的那条被筛掉了：跟着筛选结果走（列表与右栏必须指同一条，否则右边说的是
        # 左边根本看不见的信号）。
        if shown:
            self.listing.setCurrentRow(0)
            return True
        else:
            self._current = ""
            if only_live:
                extra = "" if self._connected() else "——而且游戏没连上，这里本来就看不到实时状态"
                self.detail.setHtml(
                    f"<p style='color:#7a756e'>现在没有任何信号有人在等{extra}。</p>"
                )
            else:
                self.detail.setHtml("<p style='color:#7a756e'>没有匹配的信号。</p>")
            self._sync_buttons()
            return False

    def _haystack(self, card: SignalCard) -> str:
        bits = [card.signal, card.label, card.notes]
        bits += [f"{e.kind_label}{e.container_label}{e.where}{e.context}" for e in card.emitters]
        bits += [f"{r.composition_label}{r.graph_label}{r.from_label}{r.to_label}" for r in card.listeners]
        return " ".join(bits).lower()

    def _tooltip(self, card: SignalCard, live: int) -> str:
        what, where = signal_phrase(self.index, card.signal)
        lines = [card.signal]
        if card.label and card.label != card.signal:
            lines.append(card.label)
        if what:
            lines.append(what + (f"（{where}）" if where else ""))
        lines.append(f"现在有 {live} 条路在等这一下" if live else "现在没有路在等这一下")
        return "\n".join(lines)

    def _select_row(self, signal: str) -> bool:
        for i in range(self.listing.count()):
            if str(self.listing.item(i).data(ROLE_SIGNAL) or "") == signal:
                self.listing.setCurrentRow(i)
                return True
        return False

    def _on_pick(self, item: QListWidgetItem | None, _prev: QListWidgetItem | None = None) -> None:
        signal = str(item.data(ROLE_SIGNAL) or "") if item is not None else ""
        if signal:
            self._missing = ""
        self._current = signal
        if signal:
            self._render(signal)
        self._sync_buttons()

    # ------------------------------------------------------------------ 详情
    def _render(self, signal: str) -> None:
        card = self.xref.card(signal)
        active = self._active_states()
        parts: list[str] = []

        title = _esc(card.signal)
        if card.label and card.label != card.signal:
            title += f"　<span style='color:#7a756e'>{_esc(card.label)}</span>"
        parts.append(f"<h3 style='margin:0'>{title}</h3>")
        parts.append(f"<p style='color:#7a756e;margin:2px 0 8px'>{_KIND_TEXT.get(card.kind, card.kind)}</p>")
        if card.notes:
            parts.append(f"<p style='color:#8a7f5f'>📝 {_esc(card.notes)}</p>")

        for diag in card.diagnostics:
            color = {"error": "#c0392b", "warning": "#a5822c"}.get(diag.severity, "#7a756e")
            mark = {"error": "✗", "warning": "⚠"}.get(diag.severity, "·")
            parts.append(f"<p style='color:{color};margin:2px 0'>{mark} {_esc(diag.message)}</p>")

        # 现在：这一下按下去会不会有反应。条件与活计挂起都要算——只看起点对不对，
        # 就会把"被条件挡住"报成"正等着"，人掉头去改一个没坏的发射端。
        statuses = [(row, self._listener_status(row, active)) for row in card.listeners]
        live_rows = [r for r, st in statuses if st == STATUS_LIVE]
        maybe_rows = [(r, st) for r, st in statuses if st in (STATUS_CONDITIONAL, STATUS_SUSPENDED)]
        if not self._connected():
            parts.append("<p><b>现在：</b>游戏没连上，看不到实时状态（下面是静态关系）。</p>")
        elif live_rows:
            names = "；".join(
                f"「{_esc(r.graph_label)}」{_esc(r.from_label)} → {_esc(r.to_label)}" for r in live_rows[:3]
            )
            parts.append(f"<p><b>现在：</b>有 {len(live_rows)} 条路正等着这一下 —— {names}</p>")
        elif maybe_rows:
            row, st = maybe_rows[0]
            if st == STATUS_CONDITIONAL:
                detail = (
                    f"起点对上了（「{_esc(row.graph_label)}」{_esc(row.from_label)} → {_esc(row.to_label)}），"
                    f"但这条路还挂着条件：{_esc(' 且 '.join(row.conditions))}。"
                    "条件不满足时打出去照样不动——看下面「本次会话」里有没有「条件没过」。"
                )
            else:
                now = self._activated_archetype()
                who = self.index.graph_labels.get(now, now) if hasattr(self.index, "graph_labels") else now
                detail = (
                    f"起点对上了，但「{_esc(row.graph_label)}」这条活计现在挂起着"
                    + (f"（正在跑的是「{_esc(who)}」）" if now else "")
                    + "，挂起的活计一个信号都不接——得先切回它。"
                )
            parts.append(f"<p><b>现在：</b>{detail}</p>")
        elif card.listeners:
            parts.append(
                "<p><b>现在：</b>没有路在等这一下（听它的那些图都不在起点那一拍），"
                "现在打出去多半没反应。</p>"
            )
        else:
            parts.append("<p><b>现在：</b>没有任何转移听它，打出去一定没反应。</p>")

        # 玩家要做的那一下（调试器的看家本事，与下面的发射清单是不同粒度）
        action, action_where = player_action_for(self.index, card.signal)
        if action:
            parts.append(
                f"<p><b>玩家要做的那一下：</b>{_esc(action)}"
                + (f"　<span style='color:#7a756e'>【{_esc(action_where)}】</span>" if action_where else "")
                + "</p>"
            )

        reals = [e for e in card.emitters if e.channel != CHANNEL_UPSTREAM]
        ups = [e for e in card.emitters if e.channel == CHANNEL_UPSTREAM]

        parts.append(f"<h4 style='margin:12px 0 4px'>谁发的（{len(reals)}）</h4>")
        if not reals:
            parts.append("<p style='color:#7a756e'>没有任何地方发出它。</p>")
        for e in reals:
            who = _esc(f"{e.kind_label}「{e.container_label or e.container_id}」" if (e.container_label or e.container_id) else e.kind_label)
            line = f"<div style='margin:3px 0'>· <b>{who}</b>"
            if e.where:
                line += f"　<span style='color:#7a756e'>{_esc(e.where)}</span>"
            if e.context:
                line += f"<br/>　　<span style='color:#8a7f5f'>{_esc(e.context)}</span>"
            line += "</div>"
            parts.append(line)

        if ups:
            parts.append(f"<h4 style='margin:12px 0 4px'>能让它发生的路（{len(ups)}）</h4>")
            for e in ups:
                parts.append(
                    f"<div style='margin:3px 0'>· <b>{_esc(e.kind_label)}</b>　"
                    f"<span style='color:#7a756e'>{_esc(e.where)}</span><br/>"
                    f"　　<span style='color:#8a7f5f'>{_esc(e.context)}</span></div>"
                )

        parts.append(f"<h4 style='margin:12px 0 4px'>谁在听（{len(card.listeners)}）</h4>")
        if not card.listeners:
            parts.append("<p style='color:#7a756e'>没有任何转移在等它。</p>")
        for row in card.listeners:
            status = self._listener_status(row, active)
            if not self._connected():
                mark, note = OFF_MARK, "（游戏没连上，看不出现在等不等）"
            elif status == STATUS_LIVE:
                mark, note = LIVE_MARK, "正等着这一下"
            elif status == STATUS_CONDITIONAL:
                mark, note = MAYBE_MARK, "起点对上了，但还挂着条件"
            elif status == STATUS_SUSPENDED:
                mark, note = MAYBE_MARK, "这条活计现在挂起着，不接信号"
            elif status == STATUS_IDLE:
                here = active.get(row.graph_id, "")
                mark = IDLE_MARK
                note = f"这条线现在停在「{self._state_label(row.graph_id, here)}」"
            else:
                mark, note = OFF_MARK, "这条线现在没在跑"
            link = f"{row.graph_id}.{row.from_state}"
            parts.append(
                f"<div style='margin:3px 0'>{mark} <a href='focus:{_esc(link)}'>"
                f"<b>{_esc(row.graph_label)}</b>：{_esc(row.from_label)} → {_esc(row.to_label)}</a>"
                f"　<span style='color:#7a756e'>{_esc(note)}</span>"
                + (f"<br/>　　<span style='color:#8a7f5f'>还要满足：{_esc(' 且 '.join(row.conditions))}</span>"
                   if row.conditions else "")
                + "</div>"
            )

        if card.declarations:
            parts.append(
                f"<h4 style='margin:12px 0 4px'>画布上说会发它的盒子（{len(card.declarations)}）</h4>"
                "<p style='color:#7a756e;margin:0 0 4px'>只是标注，运行时不执行——别把它当成「有人在发」。</p>"
            )
            for d in card.declarations:
                parts.append(
                    f"<div style='margin:3px 0'>· {_esc(d.composition_label)} · "
                    f"「{_esc(d.element_label)}」</div>"
                )

        history = self._history_rows(card.signal)
        parts.append(f"<h4 style='margin:12px 0 4px'>本次会话（{len(history)}）</h4>")
        if not history:
            parts.append("<p style='color:#7a756e'>这条信号本次会话还没出现过。</p>")
        for entry in history[-8:]:
            parts.append(
                f"<div style='margin:2px 0'><span style='color:#7a756e'>{_esc(entry.at)}</span>　"
                f"{_esc(entry.headline)}"
                + (f"　<span style='color:#8a7f5f'>{_esc(entry.detail)}</span>" if entry.detail else "")
                + "</div>"
            )

        bar = self.detail.verticalScrollBar()
        offset = bar.value() if bar is not None else 0
        self.detail.setHtml("".join(parts))
        if bar is not None:
            bar.setValue(min(offset, bar.maximum()))

    def _state_label(self, graph_id: str, state_id: str) -> str:
        node = self.index.state(graph_id, state_id)
        return node.display if node is not None else state_id

    def _history_rows(self, signal: str) -> list[Any]:
        timeline = getattr(self.hub, "timeline", None) or []
        return [e for e in timeline if getattr(e, "signal", "") == signal]

    # ------------------------------------------------------------------ 动作
    def _on_anchor(self, url) -> None:  # noqa: ANN001 - Qt 传的是 QUrl
        text = url.toString()
        if not text.startswith("focus:"):
            return
        key = text[len("focus:"):]
        if self._on_focus is not None and key:
            self._on_focus(key)

    def _focus_first_listener(self) -> None:
        if not self._current or self._on_focus is None:
            return
        card = self.xref.card(self._current)
        active = self._active_states()
        rows = card.listeners
        if not rows:
            return
        # 优先挑现在真在等的那条：那才是策划盯着的
        row = next((r for r in rows if active.get(r.graph_id) == r.from_state), rows[0])
        self._on_focus(f"{row.graph_id}.{row.from_state}")

    def _fire_current(self) -> None:
        if not self._current:
            return
        self.hub.send_command({
            "command": "emitSignal",
            "signal": self._current,
            "sourceType": "debug",
            "sourceId": "narrative-debugger",
        })

    def _sync_buttons(self) -> None:
        card = self.xref.card(self._current) if self._current else None
        connected = bool(getattr(getattr(self.hub, "state", None), "connected", False))
        draft = self._current == DRAFT_SIGNAL
        self.fire_btn.setEnabled(bool(self._current) and connected and not draft)
        if not self._current:
            self.fire_btn.setToolTip("先在左边挑一条信号")
        elif draft:
            self.fire_btn.setToolTip("草稿占位信号运行时拒绝发出——这条路还没接线")
        elif not connected:
            self.fire_btn.setToolTip("游戏没连上，发不出去")
        else:
            self.fire_btn.setToolTip("直接把这条信号打出去，用来验后面的路通不通")
        has_listener = bool(card and card.listeners)
        self.focus_btn.setEnabled(has_listener and self._on_focus is not None)
        self.focus_btn.setToolTip(
            "把中间那张因果图的焦点挪到接收方那一拍（不动游戏）" if has_listener
            else "没有转移在等它，没有可看的拍子"
        )
