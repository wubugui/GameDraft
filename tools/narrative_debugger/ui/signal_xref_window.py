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

from tools.narrative_debugger.humanize import (
    DRAFT_SIGNAL,
    PRIVATE_MARK,
    PRIVATE_NOTE,
    player_action_for,
    signal_phrase,
)
from tools.narrative_debugger.model import NarrativeIndex, PrivateListenerPattern
from tools.narrative_xref import CHANNEL_UPSTREAM, SignalIndex, transition_is_unwired
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
STATUS_UNWIRED = "unwired"      # 接的是占位信号：运行时拒发，这条路根本走不到
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


def _private_pattern_headline(pattern: PrivateListenerPattern) -> str:
    """模式行的抬头：说的是一类实体，不是某一张图。

    文案与 web 编辑器的 `signalXref.privatePatternHeadline` 对齐——同一件事在两个工具里
    说两种话，人就得先分辨"这俩说的是不是一回事"。
    """
    sample = pattern.sample
    jump = f"{sample.from_label} → {sample.to_label}"
    if pattern.count > 1:
        return f"所有绑此类 wrapper 的实体（{pattern.count} 张图）· {jump}"
    return f"{sample.graph_label} · {jump}"


def _private_pattern_detail(pattern: PrivateListenerPattern) -> str:
    """把被折叠掉的图列出来，别让人以为少扫了。"""
    if pattern.count <= 1:
        return pattern.sample.composition_label or pattern.sample.graph_id
    shown = "、".join(pattern.graph_ids[:8])
    rest = f" 等 {len(pattern.graph_ids)} 张" if len(pattern.graph_ids) > 8 else ""
    return f"这一跳在 {pattern.count} 张同款 wrapper 图上各有一份：{shown}{rest}"


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
        # 看哪一面：信号（谁发谁听）/ 状态（这一拍牵动世界里的哪些东西）
        self._mode = "signal"
        self._current_state = ""
        self._state_cache: list[Any] | None = None

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

        # 「这份关系是旧的」黄条。**必须长在窗里**：这是独立的非模态窗，主窗状态栏那句话
        # 被它挡在后面，人一个字都看不见——只在主窗提示等于没提示。
        self.stale_bar = QLabel()
        self.stale_bar.setStyleSheet("color:#a5822c;")
        self.stale_bar.setWordWrap(True)
        self.stale_bar.setVisible(False)
        outer.addWidget(self.stale_bar)

        modes = QHBoxLayout()
        self.mode_signal = QPushButton("信号：谁发谁听")
        self.mode_state = QPushButton("状态：这一拍牵动谁")
        for btn in (self.mode_signal, self.mode_state):
            btn.setCheckable(True)
            modes.addWidget(btn)
        self.mode_signal.setChecked(True)
        self.mode_signal.clicked.connect(lambda: self._set_mode("signal"))
        self.mode_state.clicked.connect(lambda: self._set_mode("state"))
        modes.addStretch(1)
        outer.addLayout(modes)

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
        """顶部那句话要跟着**模式**和**连接状态**一起改口：
        断线之后圆点说的是最后一次连着时的世界，还照着"此刻"讲就是骗人；
        状态那一面讲的也不是"谁在等这一下"，照抄信号那套同样是驴唇不对马嘴。"""
        if self._mode == "state":
            self.tip.setText(
                "一拍牵动谁：世界里哪些人、哪道门、哪个任务在看着它。"
                + ("● 这一项现在满足了，○ 现在不满足（或者判不出来）。"
                   if self._connected() else "游戏没连上——下面是静态关系，判不出此刻。")
            )
            return
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
    def set_indexes(self, xref: SignalIndex | None, index: NarrativeIndex) -> bool:
        """主窗「重新读一遍数据」之后换索引：保住当前选中的信号，别把人踢回列表头。

        `xref=None`＝这次扫描失败（半截数据）。**保留上一份索引**并返回 False：
        换成 None 会让后面每一次重画都抛 `AttributeError`，把"数据坏了"升级成"工具坏了"。
        """
        if xref is None:
            return False
        self.mark_stale("")          # 换新成功 = 这份关系是新的，撤掉黄条
        self.xref = xref
        self.index = index
        self._cards_cache = None
        self._state_cache = None
        # 换了数据就重试一次刚才那条查不到的信号——「重新读一遍数据」正是为了这个；
        # 抱着旧的"查无此名"不放，等于让人重开窗口才看得见新加的信号。
        # 恢复选中一律走统一入口：这里曾是最后一处手写模式判断，
        # 而"各写各的模式判断"正是这个窗栽过三次的形状。
        keep = self._current_key() or (self._missing if self._mode == "signal" else "")
        self._missing = ""
        self._rebuild_list()
        if keep:
            self.show_state(keep) if self._mode == "state" else self.show_signal(keep)
        return True

    def mark_stale(self, reason: str) -> None:
        """标记"窗里这份关系已经不是最新的"。空字符串＝撤掉。

        用在扫描失败时：索引刻意保留旧的（不让工具崩），但**必须当面说清楚它是旧的**，
        否则就是给一个看着正确的错答案——比崩溃更隐蔽。
        """
        self.stale_bar.setText(reason)
        self.stale_bar.setVisible(bool(reason))

    def show_signal(self, signal: str) -> bool:
        """选中某条信号（从时间线/别处点进来），返回**有没有真找到**。

        ⚠ 必须先切回信号那一面：状态页的行 id 是 `图.态`，拿信号 id 去比必然落空，
        于是弹一句"这份扫描里没有信号 X"——而它明明就在扫描里（审查坐实的回归）。

        被筛选挡住时先清筛选；索引里压根没有这条（刚加的信号、或者游戏跑的是另一份
        数据）时，绝不能把上一条的卡片留在右边——那比"点了没反应"更糟：给的是一个
        看着正确的错答案，连「就当这件事发生了」都会打错信号。
        """
        target = (signal or "").strip()
        if not target:
            return False
        if self._mode != "signal":
            self._set_mode("signal")
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

    def show_state(self, key: str) -> bool:
        """选中某一拍（`图.态`）。与 show_signal 对称：先切到状态那一面再找，
        否则拿拍子 id 去信号列表里比必然落空。"""
        target = (key or "").strip()
        if not target:
            return False
        if self._mode != "state":
            self._set_mode("state")
        if self._select_row(target):
            return True
        # 被筛选挡住了：清掉筛选再找一次（点了没反应最气人）
        self.search.clear()
        self.only_problem.setChecked(False)
        self._rebuild_list(keep_selection=False)
        return self._select_row(target)

    # 「当前选中的是哪一个」必须按面取。**别再散着判模式**：同一个形状已经栽过三次
    # （show_signal 拿信号 id 查状态列表、_rebuild_list 用错保留键、
    # refresh_history 拿 _current 渲染信号卡把状态页顶掉），全是把 `_current`
    # 当成通用当前项。入口收在这里，加第四个刷新点时不用再想一遍。
    def _current_key(self) -> str:
        return self._current_state if self._mode == "state" else self._current

    def _render_current(self) -> None:
        """重画右栏那张卡——按当前那一面。没有选中就什么都不动。"""
        key = self._current_key()
        if not key:
            return
        if self._mode == "state":
            self._render_state(key)
        else:
            self._render(key)

    def refresh_runtime(self) -> None:
        """状态变了（谁停在哪）：圆点与详情一起重画。不重扫数据。"""
        self._sync_tip()
        self._sync_only_live_enabled()
        # _rebuild_list 先 clear() 再重选，重选必然触发 _on_pick → 重画；
        # 只有它没重选任何一行时才要自己补一次，否则每次运行时事件都白渲染两遍。
        rendered = self._rebuild_list(keep_selection=True, runtime=True)
        if not rendered:
            self._render_current()
        self._sync_buttons()

    def refresh_history(self) -> None:
        """只是时间线多了一条：左边圆点不受影响，重画右边就够（省得列表闪）。

        ⚠ 必须按面重画：状态页正看着一拍时，游戏随便发一条信号都会走到这里——
        无脑 `_render(self._current)` 会把那张拍子卡顶成一张信号卡，
        而左栏还高亮着那一拍，列表与详情当场对不上（审查坐实）。
        """
        self._render_current()

    # ------------------------------------------------------------------ 列表
    def _active_states(self) -> dict[str, str]:
        state = getattr(self.hub, "state", None)
        active = getattr(state, "active_states", None)
        return dict(active) if isinstance(active, dict) else {}

    def _listener_status(self, row: Any, active: dict[str, str]) -> str:
        """这条监听此刻是什么处境。**别只看起点对不对**：条件挡着、活计挂起着、
        接的是占位信号，都是"看着在等、其实不动"——报成"正等着"会把人送去改一个
        没坏的发射端。占位信号尤其毒：运行时明确拒发它（NarrativeStateManager），
        亮绿点等于指着一条永远走不通的路说"就等你这一下了"。"""
        if transition_is_unwired(row.signal, row.trigger):
            return STATUS_UNWIRED
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
        if statuses and all(st == STATUS_UNWIRED for st in statuses):
            return OFF_MARK
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

    # ------------------------------------------------------------------ 状态那一面
    def _set_mode(self, mode: str) -> None:
        self._mode = mode
        self.mode_signal.setChecked(mode == "signal")
        self.mode_state.setChecked(mode == "state")
        self.only_live.setVisible(mode == "signal")
        self._sync_tip()
        self.only_problem.setText("只看两侧对不齐的" if mode == "signal" else "只看有问题的拍子")
        self.search.setPlaceholderText(
            "打几个字筛：信号名、发它的那段戏、听它的那张图都能搜" if mode == "signal"
            else "打几个字筛：图名、拍名、或者被它牵动的那个人/那道门"
        )
        # 两面各记各的选中：点时间线信号会自动切到信号面，手点回「状态」时
        # 该回到原来那一拍，而不是列表第一行（P0-1 的修法新暴露出来的）。
        # _rebuild_list 重选中任何一行都会经 _on_pick 画一次，只有它没重选时才补画。
        if not self._rebuild_list(keep_selection=True):
            self._render_current()

    def _states(self) -> list[Any]:
        if self._state_cache is None:
            # 只留**牵动到东西**的拍子（一个都不牵动的在调试时没有可看的）。判据要与引擎的
            # DIAG_STATE_UNUSED 一致：那条也把 emits 算进"牵动"——进这一拍就发真信号的拍子
            # 被藏起来的话，「只看有问题的拍子」永远看不到它们（审查坐实 5 个）。
            self._state_cache = [
                c for c in self.xref.state_overview()
                if c.readers or c.broadcasts or c.emits or any(
                    d.severity in ("error", "warning") for d in c.diagnostics)
            ]
        return self._state_cache

    def _state_rows(self) -> list[Any]:
        """按此刻最该看的排：正停在的拍子在最前，其余按牵动的东西多少排。"""
        active = self._active_states()
        rows = self._states()
        return sorted(rows, key=lambda c: (active.get(c.graph_id) != c.state_id, -len(c.readers), c.key))

    def _reader_verdict(self, card: Any, read: Any) -> tuple[str, str]:
        """这条引用**此刻**是什么结论。判不出来就照实说，绝不编。"""
        if not self._connected():
            return IDLE_MARK, "游戏没连上，看不出此刻"
        here = self._active_states().get(card.graph_id)
        now_here = here == card.state_id
        if read.reached and not now_here:
            # 「到过」要看历史，调试器手上没有那份历史（快照只给当前 activeStates）
            return IDLE_MARK, "它看的是「到过没有」——这个判不出来（要看历史），现在人不在这一拍"
        satisfied = now_here
        if read.negated:
            satisfied = not satisfied
        verb = "到过" if read.reached else "正停在"
        if satisfied:
            return LIVE_MARK, f"这一项现在满足了（要求{verb}这一拍{'的反面' if read.negated else ''}）"
        return IDLE_MARK, f"这一项现在不满足（要求{verb}这一拍{'的反面' if read.negated else ''}）"

    def _render_state(self, key: str) -> None:
        gid, _, sid = key.rpartition(".")
        card = self.xref.state_card(gid, sid)
        active = self._active_states()
        here = active.get(gid)
        parts: list[str] = [f"<h3 style='margin:0'>{_esc(card.graph_label)} · {_esc(card.state_label)}</h3>"]
        marks = [m for m, on in (("初始拍", card.is_initial), ("进入时广播", card.broadcasts),
                                 ("活计图", card.run_graph)) if on]
        parts.append(
            f"<p style='color:#7a756e;margin:2px 0 8px'>{_esc(card.composition_label)} · {_esc(card.key)}"
            + (f" · {_esc(' / '.join(marks))}" if marks else "") + "</p>"
        )
        for diag in card.diagnostics:
            color = {"error": "#c0392b", "warning": "#a5822c"}.get(diag.severity, "#7a756e")
            parts.append(f"<p style='color:{color};margin:2px 0'>{_esc(diag.message)}</p>")

        if not self._connected():
            parts.append("<p><b>现在：</b>游戏没连上（下面是静态关系）。</p>")
        elif here == sid:
            parts.append("<p><b>现在：</b>游戏<b>正停在这一拍</b>。</p>")
        elif here:
            parts.append(
                f"<p><b>现在：</b>这条线停在「{_esc(self._state_label(gid, here))}」，不在这一拍。</p>")
        else:
            parts.append("<p><b>现在：</b>这条线没在跑。</p>")

        parts.append(f"<h4 style='margin:12px 0 4px'>这一拍牵动谁（{len(card.readers)}）</h4>")
        if not card.readers:
            parts.append("<p style='color:#7a756e'>没有任何东西看着这一拍——它变不变，世界都不会有反应。</p>")
        for read in card.readers:
            mark, note = self._reader_verdict(card, read)
            who = read.subject_kind_label or read.kind_label
            where = f"{read.subject_scene}的" if read.subject_scene else ""
            parts.append(
                f"<div style='margin:4px 0'>{mark} <b>{_esc(where)}{_esc(who)}"
                f"「{_esc(read.subject_display)}」</b>"
                + (f"　<span style='color:#8a7f5f'>{_esc(read.subject_effect)}</span>" if read.subject_effect else "")
                # where 不能省：对话节点既无 id 也无名字，两条相反分支的抬头一模一样，
                # 不带位置就看起来像渲染坏了（审查实测 165/371 行受影响）。
                + (f"　<span style='color:#7a756e'>{_esc(read.where)}</span>" if read.where else "")
                + f"<br/>　　<span style='color:#7a756e'>{_esc(note)}</span></div>"
            )

        if card.emits:
            parts.append(f"<h4 style='margin:12px 0 4px'>进出这一拍会发什么（{len(card.emits)}）</h4>")
            for e in card.emits:
                parts.append(
                    f"<div style='margin:3px 0'>· <b>{_esc(e.signal)}</b>"
                    f"　<span style='color:#7a756e'>{_esc(e.where)}</span></div>")
        if card.ways_in:
            parts.append(f"<h4 style='margin:12px 0 4px'>怎么进这一拍（{len(card.ways_in)}）</h4>")
            for e in card.ways_in:
                parts.append(
                    f"<div style='margin:3px 0'>· {_esc(e.where)}"
                    f"　<span style='color:#8a7f5f'>{_esc(e.context)}</span></div>")
        if card.ways_out:
            parts.append(f"<h4 style='margin:12px 0 4px'>从这儿去哪（{len(card.ways_out)}）</h4>")
            for l in card.ways_out:
                how = l.how or ("条件满足自动走" if l.trigger else "没接触发条件")
                # 条件不能吞：「四条全触发才走」被写成「条件满足就自动走」，
                # 听起来像到点自动过——而"为什么没反应"正是这个窗的看家问题。
                if l.conditions:
                    how += "；还要满足：" + " 且 ".join(l.conditions)
                link = f"{l.graph_id}.{l.from_state}"
                parts.append(
                    f"<div style='margin:3px 0'>· <a href='focus:{_esc(link)}'>→ {_esc(l.to_label or l.to_state)}</a>"
                    f"　<span style='color:#7a756e'>{_esc(how)}</span></div>")
        self.detail.setHtml("".join(parts))

    def _rebuild_list(self, keep_selection: bool = True, runtime: bool = False) -> bool:
        """重建左栏，返回**有没有顺带把详情重画过**（选中行变化会触发 _on_pick → _render）。

        默认保住当前选中：搜索/勾选框每敲一下就把人踢回第一条，等于每次筛选都要重新
        找一遍自己刚才在看的那条信号。
        """
        keep = self._current_key() if keep_selection else ""
        needle = self.search.text().strip().lower()
        only_live = self.only_live.isChecked()
        only_problem = self.only_problem.isChecked()

        active = self._active_states()
        self.listing.blockSignals(True)
        self.listing.clear()
        shown = 0
        if self._mode == "state":
            shown = self._fill_state_rows(needle, only_problem, active)
            self.listing.blockSignals(False)
            self.count_label.setText(f"{shown} / {len(self._states())} 拍")
            if keep and self._select_row(keep):
                return True
            if runtime and self._current_state:
                # 游戏往前走一步把选中那拍筛掉/挤走时**绝不换人**：换了的话人还盯着原来那张卡，
                # 而「在图上看这一拍」已经悄悄指向别人（与信号那一面同一条规矩）。
                self.listing.setCurrentRow(-1)
                self._render_state(self._current_state)
                self._sync_buttons()
                return True
            if shown:
                self.listing.setCurrentRow(0)
                return True
            # 清掉选中：不清的话，_render_current() 会把这句空提示再盖成上一张拍子卡，
            # 于是"状态页 + 谁都不匹配的搜索词"因来路不同显示两样（审查坐实）。
            self._current_state = ""
            self.detail.setHtml("<p style='color:#7a756e'>没有匹配的拍子。</p>")
            self._sync_buttons()
            return False
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
            private = self.index.is_private_signal(card.signal)
            label = f"{mark} {PRIVATE_MARK}{name}" if private else f"{mark} {name}"
            listen_text = (
                f"听 {len(self.index.aggregate_private_listeners(card.listeners))} 类实体"
                if private else f"听 {len(card.listeners)}"
            )
            item = QListWidgetItem(
                f"{label}\n　　发 {card.real_emitter_count} · {listen_text}"
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
        # 选中的那条被筛掉了。**这里必须分清是谁把它筛掉的**：
        # - 用户自己改了搜索/勾选 → 跟着筛选结果走（列表与右栏指同一条）；
        # - 游戏走了一步导致它不再 live（runtime=True）→ **绝不换人**。换了的话，人还
        #   盯着原来那张卡，而「就当这件事发生了」已经悄悄改指向列表第一条——那颗按钮
        #   会真的改运行中游戏的状态，打错人的代价比看错一眼大得多。
        if runtime and self._current:
            self.listing.setCurrentRow(-1)
            self._render(self._current, filtered_out=True)
            self._sync_buttons()
            return True
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

    def _fill_state_rows(self, needle: str, only_problem: bool, active: dict[str, str]) -> int:
        shown = 0
        for card in self._state_rows():
            problem = any(d.severity in ("error", "warning") for d in card.diagnostics)
            if only_problem and not problem:
                continue
            if needle and needle not in self._state_haystack(card):
                continue
            now_here = active.get(card.graph_id) == card.state_id and self._connected()
            mark = LIVE_MARK if now_here else (IDLE_MARK if card.readers else OFF_MARK)
            item = QListWidgetItem(
                f"{mark} {card.graph_label} · {card.state_label}\n"
                f"　　牵动 {len(card.readers)} 处{'　⚠' if problem else ''}"
            )
            item.setData(ROLE_SIGNAL, card.key)
            item.setToolTip(
                f"{card.key}\n" + ("游戏现在正停在这一拍" if now_here else "现在不在这一拍")
            )
            if now_here:
                font = item.font()
                font.setBold(True)
                item.setFont(font)
                item.setForeground(QColor("#3f8c3f"))
            self.listing.addItem(item)
            shown += 1
        return shown

    def _state_haystack(self, card: Any) -> str:
        bits = [card.key, card.graph_label, card.state_label, card.composition_label]
        bits += [f"{r.subject_kind_label}{r.subject_display}{r.subject_scene}{r.subject_effect}"
                 for r in card.readers]
        return " ".join(bits).lower()

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
        if self.index.is_private_signal(card.signal):
            lines.append(PRIVATE_NOTE + "——发的时候得指明是哪个实体发的，不指就被丢弃")
        lines.append(f"现在有 {live} 条路在等这一下" if live else "现在没有路在等这一下")
        return "\n".join(lines)

    def _select_row(self, signal: str) -> bool:
        for i in range(self.listing.count()):
            if str(self.listing.item(i).data(ROLE_SIGNAL) or "") == signal:
                self.listing.setCurrentRow(i)
                return True
        return False

    def _on_pick(self, item: QListWidgetItem | None, _prev: QListWidgetItem | None = None) -> None:
        if self._mode == "state":
            key = str(item.data(ROLE_SIGNAL) or "") if item is not None else ""
            self._current_state = key
            if key:
                self._render_state(key)
            self._sync_buttons()
            return
        signal = str(item.data(ROLE_SIGNAL) or "") if item is not None else ""
        if signal:
            self._missing = ""
        self._current = signal
        if signal:
            self._render(signal)
        self._sync_buttons()

    # ------------------------------------------------------------------ 详情
    def _render(self, signal: str, filtered_out: bool = False) -> None:
        card = self.xref.card(signal)
        active = self._active_states()
        parts: list[str] = []

        title = _esc(card.signal)
        if card.label and card.label != card.signal:
            title += f"　<span style='color:#7a756e'>{_esc(card.label)}</span>"
        parts.append(f"<h3 style='margin:0'>{title}</h3>")
        if filtered_out:
            # 游戏往前走了一步，这条被「只看现在能推动的」筛出了列表。刻意**不换人**：
            # 换了的话下面那颗会改游戏状态的按钮就悄悄指向别人了。
            parts.append(
                "<p style='color:#a5822c;margin:2px 0'>⚠ 游戏往前走了，这条已经不在左边的"
                "筛选结果里了——下面说的还是它（按钮也还指着它）。</p>"
            )
        kind_line = _KIND_TEXT.get(card.kind, card.kind)
        private = self.index.is_private_signal(card.signal)
        if private:
            kind_line += f"　·　{PRIVATE_MARK}{PRIVATE_NOTE}"
        parts.append(f"<p style='color:#7a756e;margin:2px 0 8px'>{_esc(kind_line)}</p>")
        if private:
            parts.append(
                "<p style='color:#8a7f5f;margin:2px 0'>同一条信号名挂在一类实体上，"
                "运行时只推<b>发射的那一个</b>的图——所以「就当这件事发生了」得先说清是谁发的"
                "（在主窗「假装做了那一下」里挑）。</p>"
            )
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
        elif live_rows and private:
            # 私有信号绝不能报"有 100 条路正等着这一下"：真发出去只会推其中一个
            # （发射方 owner 那张图），报总数等于承诺一次推倒全部——正是本机制要避免的事。
            sample = live_rows[0]
            parts.append(
                f"<p><b>现在：</b>这一类实体里有 {len(live_rows)} 个停在起点上"
                f"（如「{_esc(sample.graph_label)}」{_esc(sample.from_label)} → {_esc(sample.to_label)}）；"
                "真发出去只会推<b>发射方那一个</b>，不是全部。</p>"
            )
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
        elif statuses and all(st == STATUS_UNWIRED for _r, st in statuses):
            parts.append(
                f"<p><b>现在：</b>听它的 {len(statuses)} 条路全都还没接线（占位信号运行时不会发），"
                "打出去一定没反应——要接线请去编辑器给这些转移选一条真信号。</p>"
            )
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

        if private and card.listeners:
            self._append_private_listeners(parts, card, active)
            rows_to_render: list[Any] = []
        else:
            parts.append(f"<h4 style='margin:12px 0 4px'>谁在听（{len(card.listeners)}）</h4>")
            if not card.listeners:
                parts.append("<p style='color:#7a756e'>没有任何转移在等它。</p>")
            rows_to_render = list(card.listeners)
        for row in rows_to_render:
            status = self._listener_status(row, active)
            if not self._connected():
                mark, note = OFF_MARK, "（游戏没连上，看不出现在等不等）"
            elif status == STATUS_UNWIRED:
                mark, note = OFF_MARK, "这条路还没接线（占位信号，运行时不会发）"
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

    def _append_private_listeners(self, parts: list[str], card: SignalCard, active: dict[str, str]) -> None:
        """私有信号的「谁在听」：一类实体一行，不是一张图一行。

        逐条列 100 张同款 wrapper 图是 100 行没有信息量的重复；策划真正要知道的只有
        「哪一类实体会在收到它时走哪一跳」，以及**此刻这一类里有几个正等着**——
        因为运行时只会推其中一个（发射方那个），说"有 100 条路在等"是误导。
        """
        patterns = self.index.aggregate_private_listeners(card.listeners)
        parts.append(f"<h4 style='margin:12px 0 4px'>谁在听（{len(patterns)} 类）</h4>")
        for pattern in patterns:
            sample = pattern.sample
            statuses = [
                self._listener_status(row, active)
                for row in card.listeners if row.graph_id in pattern.graph_ids
            ]
            live = sum(1 for st in statuses if st == STATUS_LIVE)
            if not self._connected():
                mark, note = OFF_MARK, "（游戏没连上，看不出现在等不等）"
            elif live:
                mark = LIVE_MARK
                note = f"这一类里有 {live} 个正停在起点上（真发的时候只推其中发射的那一个）"
            elif STATUS_CONDITIONAL in statuses or STATUS_SUSPENDED in statuses:
                mark, note = MAYBE_MARK, "有的起点对上了，但还挂着条件（或那条活计挂起着）"
            elif all(st == STATUS_UNWIRED for st in statuses) and statuses:
                mark, note = OFF_MARK, "这一跳还没接线（占位信号，运行时不会发）"
            else:
                mark, note = IDLE_MARK, "这一类现在都不在这一跳的起点上"
            link = f"{sample.graph_id}.{sample.from_state}"
            parts.append(
                f"<div style='margin:3px 0'>{mark} <a href='focus:{_esc(link)}'>"
                f"<b>{_esc(_private_pattern_headline(pattern))}</b></a>"
                f"　<span style='color:#7a756e'>{_esc(note)}</span>"
                f"<br/>　　<span style='color:#7a756e'>{_esc(_private_pattern_detail(pattern))}</span>"
                + (f"<br/>　　<span style='color:#8a7f5f'>还要满足：{_esc(' 且 '.join(sample.conditions))}</span>"
                   if sample.conditions else "")
                + "</div>"
            )

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
        if self._mode == "state":
            if self._current_state and self._on_focus is not None:
                self._on_focus(self._current_state)
            return
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
        # 状态那一面没有"发信号"这回事。今天打不到（按钮禁用发不出 clicked），但靠别人
        # 保平安正是这个形状栽过三次的原因——判据留在自己手里。
        if self._mode == "state" or not self._current:
            return
        # 私有信号不带 owner 发出去必被运行时丢弃（signal.private.noOwner），
        # 而"按了什么都没发生"正是这个工具存在的理由。挑 owner 的面板在主窗，
        # 这里不复制一份（两处挑法迟早会漂）——按钮已禁用，这里只是把判据留在手里。
        if self.index.is_private_signal(self._current):
            return
        self.hub.send_command({
            "command": "emitSignal",
            "signal": self._current,
            "sourceType": "debug",
            "sourceId": "narrative-debugger",
        })

    def _sync_buttons(self) -> None:
        if self._mode == "state":
            key = self._current_state
            self.fire_btn.setEnabled(False)
            self.fire_btn.setToolTip("这一面看的是拍子，不发信号——切到「信号」那一面")
            can_focus = bool(key) and key in getattr(self.index, "states", {}) and self._on_focus is not None
            self.focus_btn.setEnabled(can_focus)
            self.focus_btn.setToolTip(
                "把中间那张因果图的焦点挪到这一拍（不动游戏）" if can_focus
                else "这一拍在当前数据里找不到，定位不了")
            return
        card = self.xref.card(self._current) if self._current else None
        connected = bool(getattr(getattr(self.hub, "state", None), "connected", False))
        draft = self._current == DRAFT_SIGNAL
        private = bool(self._current) and self.index.is_private_signal(self._current)
        self.fire_btn.setEnabled(bool(self._current) and connected and not draft and not private)
        if not self._current:
            self.fire_btn.setToolTip("先在左边挑一条信号")
        elif draft:
            self.fire_btn.setToolTip("草稿占位信号运行时拒绝发出——这条路还没接线")
        elif private:
            self.fire_btn.setToolTip(
                "私有信号得先说清是哪个实体发的（不说会被运行时直接丢弃）——"
                "去主窗「假装做了那一下」，那里能挑 owner"
            )
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
