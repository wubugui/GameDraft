"""调试器主窗：左边"戏走到哪"，中间"现在在哪/前后是哪"，右边"刚才那下听见没"。

三块正好对应策划真正会问的三句话。刻意不做标签页嵌套——一屏全在，不用找。
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QEvent, Qt, QTimer, Signal
from PySide6.QtGui import QBrush, QColor, QFont
from PySide6.QtGui import QAction
from PySide6.QtWidgets import (
    QApplication,
    QInputDialog,
    QCheckBox,
    QComboBox,
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMenu,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QSlider,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from tools.narrative_debugger.breakpoints import BreakpointStore
from tools.narrative_debugger.humanize import (
    DRAFT_SIGNAL,
    PRIVATE_MARK,
    PRIVATE_NOTE,
    VERDICT_BLOCKED,
    VERDICT_DANGLING,
    VERDICT_OK,
    VERDICT_STALE,
    TimelineEntry,
    player_action_for,
    signal_phrase,
    waiting_items,
)
from tools.narrative_debugger.humanize import TraceTranslator
from tools.narrative_debugger.hub import DebugHub
from tools.narrative_debugger.model import NarrativeIndex
from tools.narrative_debugger.savepoints import SavepointStore
from tools.narrative_debugger.ui.focus_graph import FocusGraphView

VERDICT_ICON = {
    VERDICT_OK: "✓",
    VERDICT_BLOCKED: "🔒",
    VERDICT_DANGLING: "✕",
    VERDICT_STALE: "…",
}
VERDICT_COLOR = {
    VERDICT_OK: "#3f8c3f",
    VERDICT_BLOCKED: "#b8860b",
    VERDICT_DANGLING: "#c0392b",
    VERDICT_STALE: "#7a756e",
}

# 左栏每行挂的几样东西：key 给跳转用，base 是"带图名的正文"（打标记时要拿它重拼，
# 不能拿 node.display，否则一刷新图名就没了），hay 是搜索用的干草堆。
ROLE_KEY = Qt.ItemDataRole.UserRole
ROLE_BASE = Qt.ItemDataRole.UserRole + 1
ROLE_HAY = Qt.ItemDataRole.UserRole + 2
ROLE_HEADER = Qt.ItemDataRole.UserRole + 3
ROLE_TIP = Qt.ItemDataRole.UserRole + 4
# 时间线那一行对应的信号（双击 → 看这条信号谁发谁听）。UserRole+1 在时间线里是
# merge_key，不能复用。
ROLE_TIMELINE_SIGNAL = Qt.ItemDataRole.UserRole + 5

# 半透明才行：底下还压着隔行底色和「当前这拍」的绿字，不透明色块会把它们全盖掉
SEARCH_HIT = QColor(255, 209, 102, 76)
NO_BRUSH = QBrush(Qt.BrushStyle.NoBrush)


class MainWindow(QMainWindow):
    def __init__(self, index: NarrativeIndex, hub: DebugHub, store: SavepointStore, project_root: Path) -> None:
        super().__init__()
        self.index = index
        self.hub = hub
        self.store = store
        self.project_root = project_root
        self._focus_locked = False
        self._history: list[str] = []
        self._missed: set[str] = set()
        self._drifted: set[str] = set()
        self._list_mode = "line"
        self.breakpoints = BreakpointStore(project_root)
        self._paused_at: dict | None = None
        self._step_armed = False
        self._default_fg = self.palette().text().color()
        # 「信号关系」窗（非模态，懒建）：不开就一分钱不花，开着就跟着运行时刷新。
        self._xref_window = None
        # 「假装做了那一下」那个框里的几件东西（框是每次现搭的，关掉就作废）。
        # 私有信号要在这里挑发射方 owner——不挑就发，运行时会当场丢弃。
        self._signal_dialog_listing: QListWidget | None = None
        self._signal_owner_picker: QComboBox | None = None
        self._signal_owner_widgets: tuple = ()
        self._signal_fire_btn: QPushButton | None = None
        # 上一次建索引是不是失败了。`_set_hint` 是单一广播位（谁最后写谁赢），
        # 光靠它区分不了"扫描失败"和"信号不在索引里"——那会让人照错的提示白跑一趟。
        self._xref_scan_failed = False
        self._xref_scan_error = ""
        self._xref_stale = False  # 关着时重读过数据 → 下次打开先重扫

        self.setWindowTitle("叙事调试器 · GameDraft")
        self.resize(1360, 820)

        root = QWidget()
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(10, 8, 10, 8)
        outer.setSpacing(8)

        outer.addWidget(self._build_status_bar())

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(self._build_beat_panel())
        splitter.addWidget(self._build_center_panel())
        splitter.addWidget(self._build_timeline_panel())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setStretchFactor(2, 0)
        # 左栏行里多了图名，250 装不下；右栏时间线是单行短句，让出来的地方给中间的图
        splitter.setSizes([300, 760, 300])
        outer.addWidget(splitter, 1)

        self.hub.tool_handler = self._handle_tool_command
        self.hub.stateChanged.connect(self._on_state_changed)
        self.hub.timelineAppended.connect(self._on_timeline)
        self.hub.timelineReplaced.connect(self._on_timeline_replaced)
        self.hub.connectionChanged.connect(self._on_connection)
        self.hub.savepointCaptured.connect(self._on_savepoint_captured)
        self.hub.savepointMissed.connect(self._on_savepoint_missed)
        self.hub.breakpointHit.connect(self._on_breakpoint_hit)
        self.hub.logged.connect(self._set_hint)
        self.hub.targetsChanged.connect(self._refresh_targets)
        self.hub.activeTargetChanged.connect(self._on_active_target_changed)
        self._refresh_targets()

        self._refresh_beats()
        self._refresh_savepoint_marks()
        # 一打开就有东西看：游戏还没连上时先停在主线第一拍，而不是一片空白。
        # 第 0 行现在是分组标题（没有 key），得往下找第一个真状态行。
        opening = ""
        for i in range(self.beat_list.count()):
            opening = str(self.beat_list.item(i).data(ROLE_KEY) or "")
            if opening:
                break
        self.graph.render_focus(opening)
        self._refresh_now_panel()
        self._update_status()

    # ---- 顶栏 ---------------------------------------------------------

    def _build_status_bar(self) -> QWidget:
        bar = QWidget()
        row = QHBoxLayout(bar)
        row.setContentsMargins(2, 0, 2, 0)
        row.setSpacing(12)

        self.dot = QLabel("●")
        self.dot.setStyleSheet("color:#c0392b;")
        row.addWidget(self.dot)

        # 调试对象：同时开着几个游戏页签时（一个码头一个义庄）在这儿切。
        # 只有一个页签也照样显示——不显示的话，人根本不会知道还能开第二个。
        self.target_picker = QComboBox()
        self.target_picker.setToolTip(
            "同时开着几个游戏页签时，在这儿挑要调哪一个。\n"
            "断点、跳拍、自动记点只作用于选中的那个；切走的那个会被立刻放行。"
        )
        # 240：装得下「游戏 2 · 义庄 · 直达 beishi_1」这种最长的一行；再窄就得靠省略号猜
        self.target_picker.setMinimumWidth(240)
        self.target_picker.activated.connect(self._on_target_picked)
        row.addWidget(self.target_picker)

        self.status_label = QLabel("等游戏连上…")
        row.addWidget(self.status_label)

        self.hint_label = QLabel("")
        self.hint_label.setStyleSheet("color:#7a756e;")
        row.addWidget(self.hint_label, 1)

        self.auto_save = QCheckBox("自动记点")
        # 默认开：策划不会主动去勾，而不勾的话「回到上一拍」永远是空的，
        # 工具一半的价值就废了。代价只是每走到新的一拍在 idle 里存一次档。
        self.auto_save.setChecked(True)
        self.auto_save.setToolTip(
            "每走到新的一拍就自动存一份全量档，之后可以随时回到那一拍。\n"
            "只在能存档的时候记（对话/演出进行中会跳过）。"
        )
        self.auto_save.toggled.connect(self._on_auto_save_toggled)
        row.addWidget(self.auto_save)

        # 策划一天改十几次 JSON；没有这个按钮就只能关了重开
        reload_btn = QPushButton("重新读一遍数据")
        reload_btn.setToolTip("在编辑器里改完 JSON，点这个就能看到新的接线，不用关掉重开")
        reload_btn.clicked.connect(self._reload_data)
        row.addWidget(reload_btn)

        return bar

    def _reload_data(self) -> None:
        old_fingerprint = self.index.fingerprint
        fresh = NarrativeIndex(self.project_root)
        fresh.load()
        if not fresh.states:
            self._set_hint("读不到数据，没换")
            return
        self.index = fresh
        self.hub.index = fresh
        self.hub.translator = TraceTranslator(fresh)
        self.graph.index = fresh
        self.store.fingerprint = fresh.fingerprint
        self.store.graph_fingerprints = dict(fresh.graph_fingerprints)
        # 记住策划正看哪条线：改一次 JSON 就把人踢回主线，等于每次都要重新找位置
        keep = self.comp_picker.currentData()
        self.comp_picker.blockSignals(True)
        self.comp_picker.clear()
        self.comp_picker.blockSignals(False)
        self._refresh_beats()
        if keep:
            idx = self.comp_picker.findData(keep)
            if idx >= 0:
                self.comp_picker.setCurrentIndex(idx)
        self._refresh_savepoint_marks()
        self.graph.render_focus(self.graph.focus_key, force=True)
        self._refresh_now_panel()
        # 信号关系窗开着就一起换新（不然它还照着旧数据说"谁发谁听"，比不开更误导）；
        # 关着的先记一笔，等真打开时再扫——没人看的窗不值得扫一遍全工程。
        if self._xref_window is not None and self._xref_window.isVisible():
            # 扫描失败时保留旧索引、并把 stale 留着：下次打开会再试一次，
            # 而不是抱着一份 None 每次重画都抛 AttributeError。
            self._xref_stale = not self._xref_window.set_indexes(self._build_xref_index(), fresh)
        else:
            self._xref_stale = True
        changed = old_fingerprint != fresh.fingerprint
        hint = "数据换新了" if changed else "数据没变，已重读"
        # 扫描失败的原因绝不能被这句成功文案顶掉（`_set_hint` 是单一广播位）：
        # "已重读" + 窗里还是旧关系 = 看着正确的错答案，比崩溃更隐蔽。
        if self._xref_scan_failed:
            hint += "；但信号关系没扫出来，那个窗里还是上一份"
        self._set_hint(hint)

    # ---- 左：拍子清单 --------------------------------------------------

    def _build_beat_panel(self) -> QWidget:
        panel = QWidget()
        box = QVBoxLayout(panel)
        box.setContentsMargins(0, 0, 0, 0)
        box.setSpacing(6)

        head = QLabel("戏走到哪")
        head.setFont(_bold(11))
        box.addWidget(head)

        # 两种看法：跟着故事线看（含每张子图的全部状态），或者"我人在这个场景，
        # 这儿都有什么戏"。后者是策划站在场景里最直接的问法。
        mode_row = QHBoxLayout()
        mode_row.setSpacing(6)
        self.mode_line_btn = QPushButton("按线看")
        self.mode_scene_btn = QPushButton("按场景看")
        for btn in (self.mode_line_btn, self.mode_scene_btn):
            btn.setCheckable(True)
            btn.setFont(_font(9))
            mode_row.addWidget(btn)
        self.mode_line_btn.setChecked(True)
        self.mode_line_btn.setToolTip("按故事线列：主线/活计各自的拍子，下面挂着每张子图的全部状态")
        self.mode_scene_btn.setToolTip("按场景列：人在这个场景里，这儿能推动的每一条线和每个状态")
        self.mode_line_btn.clicked.connect(lambda: self._set_list_mode("line"))
        self.mode_scene_btn.clicked.connect(lambda: self._set_list_mode("scene"))
        box.addLayout(mode_row)

        self.comp_picker = QComboBox()
        self.comp_picker.setToolTip("主线和几条活计线分开列；游戏跑到哪条会自动切过去")
        self.comp_picker.currentIndexChanged.connect(lambda _: self._refresh_beats())
        box.addWidget(self.comp_picker)

        self.scene_label = QLabel("")
        self.scene_label.setStyleSheet("color:#7a756e;")
        self.scene_label.setFont(_font(9))
        self.scene_label.setVisible(False)
        box.addWidget(self.scene_label)

        # 一条线能拉出 178 行，其中 7 行都叫「未」、6 行都叫「未触发」——
        # 光靠滚是找不到的。图名和状态名一起搜，命中的留下并高亮。
        self.beat_search = QLineEdit()
        self.beat_search.setPlaceholderText("搜图名或状态名，比如「偷鸡」「未触发」")
        self.beat_search.setClearButtonEnabled(True)
        self.beat_search.setToolTip("图的名字和状态的名字一起匹配；搜图名会把那张图整组留下")
        self.beat_search.textChanged.connect(lambda _: self._apply_beat_filter())
        box.addWidget(self.beat_search)

        self.search_count = QLabel("")
        self.search_count.setStyleSheet("color:#7a756e;")
        self.search_count.setFont(_font(9))
        self.search_count.setVisible(False)
        box.addWidget(self.search_count)

        self.beat_list = QListWidget()
        self.beat_list.setAlternatingRowColors(True)
        # 行里多了图名就撑出横向滚动条，看一行状态名要先横着拖一次——
        # 宁可尾部截断（完整的挂在 tooltip 上），也不要横滚
        self.beat_list.setTextElideMode(Qt.TextElideMode.ElideRight)
        self.beat_list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.beat_list.itemClicked.connect(self._on_beat_clicked)
        self.beat_list.itemDoubleClicked.connect(self._on_beat_double_clicked)
        box.addWidget(self.beat_list, 1)

        tip = QLabel("单击＝看这一拍前后\n双击＝回到这一拍\n右键＝在这拍下断点")
        tip.setStyleSheet("color:#7a756e;")
        tip.setFont(_font(9))
        box.addWidget(tip)

        self.beat_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.beat_list.customContextMenuRequested.connect(self._on_beat_context_menu)
        box.addWidget(self._build_breakpoint_panel())
        return panel

    # ---- 断点 ---------------------------------------------------------

    def _build_breakpoint_panel(self) -> QWidget:
        """断点面板：列出当前断点，双击回到那一拍，命中时整条高亮。

        断在「状态刚激活、onEnter 演出还没跑」那一刻，游戏主 tick 同时冻住——
        与语言调试器同款：现场是干净的，看完点「继续」再往下演。
        """
        panel = QWidget()
        box = QVBoxLayout(panel)
        box.setContentsMargins(0, 0, 0, 0)
        box.setSpacing(4)

        head = QLabel("断点")
        head.setFont(_bold(10))
        box.addWidget(head)

        self.bp_list = QListWidget()
        self.bp_list.setFont(_font(9))
        self.bp_list.setMaximumHeight(120)
        self.bp_list.setTextElideMode(Qt.TextElideMode.ElideRight)
        self.bp_list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.bp_list.setToolTip(
            "双击＝跳到那一拍看上下文；勾/取消勾＝临时停用；Delete＝删除；右键＝按触发源过滤")
        self.bp_list.itemDoubleClicked.connect(self._on_bp_double_clicked)
        self.bp_list.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self.bp_list.customContextMenuRequested.connect(self._on_bp_context_menu)
        self.bp_list.itemChanged.connect(self._on_bp_item_changed)
        self.bp_list.installEventFilter(self)
        box.addWidget(self.bp_list)

        row = QHBoxLayout()
        row.setSpacing(4)
        self.bp_continue_btn = QPushButton("继续")
        self.bp_continue_btn.setFont(_font(9))
        self.bp_continue_btn.setToolTip("放行，游戏接着演（F5 同）")
        self.bp_continue_btn.clicked.connect(self._on_bp_continue)
        row.addWidget(self.bp_continue_btn)
        self.bp_step_btn = QPushButton("单步")
        self.bp_step_btn.setFont(_font(9))
        self.bp_step_btn.setToolTip("放行到**下一个**进入的状态再停（不管那儿有没有断点）")
        self.bp_step_btn.clicked.connect(self._on_bp_step)
        row.addWidget(self.bp_step_btn)
        clear = QPushButton("清空")
        clear.setFont(_font(9))
        clear.setToolTip("删掉所有断点")
        clear.clicked.connect(self._on_bp_clear)
        row.addWidget(clear)
        box.addLayout(row)

        self.bp_status = QLabel("")
        self.bp_status.setFont(_font(9))
        self.bp_status.setWordWrap(True)
        box.addWidget(self.bp_status)

        self._refresh_breakpoints()
        return panel

    def _refresh_breakpoints(self, *, push: bool = True) -> None:
        # 左栏标记跟着一起刷（下/删断点后那一行的 ⏻ 要立刻出现/消失）
        if hasattr(self, "beat_list"):
            self._refresh_beats_marks()
        self.bp_list.blockSignals(True)
        self.bp_list.clear()
        for bp in self.breakpoints.items():
            node = self.index.state(bp.graph_id, bp.state_id)
            label = node.display if node else bp.state_id
            suffix = f"  ·仅 {bp.trigger_contains}" if bp.trigger_contains else ""
            item = QListWidgetItem(f"〔{self._short_graph_label(bp.graph_id)}〕{label}{suffix}")
            item.setData(ROLE_KEY, f"{bp.graph_id}.{bp.state_id}")
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
            item.setCheckState(
                Qt.CheckState.Checked if bp.enabled else Qt.CheckState.Unchecked)
            item.setToolTip(f"{label}\n图：{self._graph_label(bp.graph_id)}\nid：{bp.graph_id}.{bp.state_id}")
            self.bp_list.addItem(item)
        self.bp_list.blockSignals(False)
        self._sync_bp_buttons()
        if push:
            self._push_breakpoints()

    def _push_breakpoints(self) -> None:
        self.hub.send_command({
            "command": "setBreakpoints",
            "breakpoints": self.breakpoints.to_wire(),
        })

    def _sync_bp_buttons(self) -> None:
        paused = self._paused_at is not None
        self.bp_continue_btn.setEnabled(paused)
        self.bp_step_btn.setEnabled(paused)
        if paused:
            hit = self._paused_at or {}
            gid = str(hit.get("graphId") or "")
            sid = str(hit.get("stateId") or "")
            node = self.index.state(gid, sid)
            label = node.display if node else sid
            trig = str(hit.get("triggerKey") or "")
            more = int(hit.get("concurrent") or 1)
            extra = f"\n还有 {more - 1} 条链一起断着（点继续会一起放行）" if more > 1 else ""
            self.bp_status.setText(
                f"⏸ 断在：{label}\n（{self._short_graph_label(gid)}，由 {trig or '?'} 推过来）{extra}")
            self.bp_status.setStyleSheet("color:#d08a3a;")
        elif self._step_armed:
            self.bp_status.setText("单步已武装：下一次进**任何**状态（可能是别的图）都会停一次")
            self.bp_status.setStyleSheet("color:#d08a3a;")
        elif self.breakpoints.items():
            self.bp_status.setText("")
            self.bp_status.setStyleSheet("color:#7a756e;")
        else:
            self.bp_status.setText("在左边列表右键某一拍就能下断点")
            self.bp_status.setStyleSheet("color:#7a756e;")

    def _on_beat_context_menu(self, pos) -> None:  # noqa: ANN001
        item = self.beat_list.itemAt(pos)
        if item is None:
            return
        key = str(item.data(ROLE_KEY) or "")
        if "." not in key:
            return
        graph_id, state_id = key.split(".", 1)
        menu = QMenu(self)
        has = self.breakpoints.has(graph_id, state_id)
        act = QAction("取消这一拍的断点" if has else "在这一拍下断点", menu)
        act.triggered.connect(lambda: self._toggle_breakpoint(graph_id, state_id))
        menu.addAction(act)
        menu.exec(self.beat_list.mapToGlobal(pos))

    def _toggle_breakpoint(self, graph_id: str, state_id: str) -> None:
        self.breakpoints.toggle(graph_id, state_id)
        self._refresh_breakpoints()

    def eventFilter(self, obj, event):  # noqa: ANN001, ANN201
        """断点列表按 Delete 删掉选中项。

        ⚠ 之前只 `installEventFilter(self)` 却没实现这个方法，tooltip 上却写着「Delete＝删除」——
        按下去什么都不发生。这类"承诺了但没接线"的死操作是最难自查的一种（不报错、不留痕）。
        """
        if obj is self.bp_list and event.type() == QEvent.Type.KeyPress:
            if event.key() in (Qt.Key.Key_Delete, Qt.Key.Key_Backspace):
                item = self.bp_list.currentItem()
                if item is not None:
                    key = str(item.data(ROLE_KEY) or "")
                    if "." in key:
                        graph_id, state_id = key.split(".", 1)
                        self.breakpoints.remove(graph_id, state_id)
                        self._refresh_breakpoints()
                return True
        return super().eventFilter(obj, event)

    def _on_bp_context_menu(self, pos) -> None:  # noqa: ANN001
        item = self.bp_list.itemAt(pos)
        if item is None:
            return
        key = str(item.data(ROLE_KEY) or "")
        if "." not in key:
            return
        graph_id, state_id = key.split(".", 1)
        menu = QMenu(self)
        filt = QAction("只在触发键包含…时断", menu)
        filt.triggered.connect(lambda: self._edit_bp_filter(graph_id, state_id))
        menu.addAction(filt)
        rm = QAction("删掉这个断点", menu)
        rm.triggered.connect(lambda: (self.breakpoints.remove(graph_id, state_id),
                                      self._refresh_breakpoints()))
        menu.addAction(rm)
        menu.exec(self.bp_list.mapToGlobal(pos))

    def _edit_bp_filter(self, graph_id: str, state_id: str) -> None:
        """同一个状态常被好几条线推到；填一段文字就只在触发键包含它时才断。"""
        cur = next(
            (b.trigger_contains for b in self.breakpoints.items()
             if b.graph_id == graph_id and b.state_id == state_id),
            "",
        )
        text, ok = QInputDialog.getText(
            self, "只在触发键包含…时断",
            "留空＝任何来源都断。\n触发键长这样：signal:某信号 / setState:图:拍 / __reactive__",
            text=cur,
        )
        if not ok:
            return
        self.breakpoints.set_trigger_filter(graph_id, state_id, text)
        self._refresh_breakpoints()

    def _on_bp_double_clicked(self, item: QListWidgetItem) -> None:
        key = str(item.data(ROLE_KEY) or "")
        if not key:
            return
        # 与「拍子清单」的双击同口径：先关跟随，否则游戏一发 state.changed
        # 镜头立刻被拽回当前拍，看着像"工具抽风"
        self.follow_btn.setChecked(False)
        self._on_focus_requested(key)

    def _on_bp_item_changed(self, item: QListWidgetItem) -> None:
        key = str(item.data(ROLE_KEY) or "")
        if "." not in key:
            return
        graph_id, state_id = key.split(".", 1)
        self.breakpoints.set_enabled(
            graph_id, state_id, item.checkState() == Qt.CheckState.Checked)
        self._push_breakpoints()

    def _on_bp_continue(self) -> None:
        self._paused_at = None
        self._step_armed = False
        self._sync_bp_buttons()
        self.hub.send_command({"command": "continue"})

    def _on_bp_step(self) -> None:
        self._paused_at = None
        # 单步是**全局**武装（下一次进任何图的任何状态都断）。不显式说出来的话，
        # 若这一拍恰好是级联末尾，武装会一直挂着，策划十分钟后毫无预兆被冻住。
        self._step_armed = True
        self._sync_bp_buttons()
        self.hub.send_command({"command": "step"})

    def _on_bp_clear(self) -> None:
        self.breakpoints.clear()
        # 「清空」在策划心智里＝收工。单步的武装态不跟着解，游戏还会再冻一次。
        self._step_armed = False
        self.hub.send_command({"command": "disarmStep"})
        self._refresh_breakpoints()

    def _on_breakpoint_hit(self, hit: object) -> None:
        if not isinstance(hit, dict):
            return
        self._paused_at = hit
        self._step_armed = False
        self._sync_bp_buttons()
        # 窗口多半在后台（策划正全屏玩游戏）：让任务栏闪一下，否则那边看到的
        # 就是"画面定格 + 按键没反应"，与真崩溃无法区分
        app = QApplication.instance()
        if app is not None:
            app.alert(self)
        gid = str(hit.get("graphId") or "")
        sid = str(hit.get("stateId") or "")
        if gid and sid:
            self._on_focus_requested(f"{gid}.{sid}")

    # ---- 中：焦点图 + 在等什么 ------------------------------------------

    def _build_center_panel(self) -> QWidget:
        panel = QWidget()
        box = QVBoxLayout(panel)
        box.setContentsMargins(0, 0, 0, 0)
        box.setSpacing(6)

        head_row = QHBoxLayout()
        head = QLabel("现在在哪儿")
        head.setFont(_bold(11))
        head_row.addWidget(head)
        head_row.addStretch(1)

        self.follow_btn = QPushButton("跟着游戏走")
        self.follow_btn.setCheckable(True)
        self.follow_btn.setChecked(True)
        self.follow_btn.setToolTip("开着＝镜头自动跟到游戏当前那一拍；关掉＝停在你自己选的那儿")
        self.follow_btn.toggled.connect(self._on_follow_toggled)
        head_row.addWidget(self.follow_btn)

        head_row.addWidget(QLabel("看多远"))
        self.hops = QSlider(Qt.Orientation.Horizontal)
        self.hops.setMinimum(1)
        self.hops.setMaximum(4)
        self.hops.setValue(2)
        self.hops.setFixedWidth(90)
        self.hops.setToolTip("往前往后各看几步")
        self.hops.valueChanged.connect(self._on_hops_changed)
        head_row.addWidget(self.hops)
        self.hops_label = QLabel("前后 2 步")
        self.hops_label.setStyleSheet("color:#7a756e;")
        head_row.addWidget(self.hops_label)

        # 缩放得有看得见的按钮。只留 Ctrl+滚轮那种手势，策划根本发现不了，
        # 界面上又写着"图太小"——等于这个能力不存在。
        head_row.addSpacing(10)
        self.zoom_out_btn = _icon_button("－", "缩小")
        self.zoom_out_btn.clicked.connect(lambda: self.graph.zoom_by(1 / 1.2))
        head_row.addWidget(self.zoom_out_btn)

        self.zoom_label = QLabel("100%")
        self.zoom_label.setStyleSheet("color:#7a756e;")
        self.zoom_label.setFont(_font(9))
        self.zoom_label.setFixedWidth(38)
        self.zoom_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        head_row.addWidget(self.zoom_label)

        self.zoom_in_btn = _icon_button("＋", "放大")
        self.zoom_in_btn.clicked.connect(lambda: self.graph.zoom_by(1.2))
        head_row.addWidget(self.zoom_in_btn)

        self.zoom_fit_btn = QPushButton("适应")
        self.zoom_fit_btn.setFont(_font(9))
        self.zoom_fit_btn.setToolTip("整张图塞进画面；之后换焦点会重新自动排比例")
        self.zoom_fit_btn.setFixedWidth(46)
        head_row.addWidget(self.zoom_fit_btn)

        self.zoom_one_btn = QPushButton("1:1")
        self.zoom_one_btn.setFont(_font(9))
        self.zoom_one_btn.setToolTip("按设计尺寸画，字最清楚；放不下就拖")
        self.zoom_one_btn.setFixedWidth(40)
        head_row.addWidget(self.zoom_one_btn)

        # 按钮到位之后这句只是补充手势，别再占满整条——右边紧挨着时间线的标题
        zoom_tip = QLabel("　拖动平移")
        zoom_tip.setStyleSheet("color:#9a9691;")
        zoom_tip.setFont(_font(9))
        head_row.addWidget(zoom_tip)
        box.addLayout(head_row)

        self.graph = FocusGraphView(self.index)
        self.graph.setMinimumHeight(260)
        self.graph.focusRequested.connect(self._on_focus_requested)
        self.graph.jumpRequested.connect(self._jump_to)
        self.graph.zoomChanged.connect(self._on_zoom_changed)
        self.zoom_fit_btn.clicked.connect(self.graph.zoom_fit)
        self.zoom_one_btn.clicked.connect(self.graph.zoom_actual)
        box.addWidget(self.graph, 1)

        legend = QLabel(
            "蓝框＝你在看的　绿框＝游戏正停在这儿　绿点＝有存档点　"
            "实线＝同一条线往下走　虚线＝这一步会带动另一条线"
        )
        legend.setStyleSheet("color:#7a756e;")
        legend.setFont(_font(9))
        legend.setWordWrap(True)
        box.addWidget(legend)

        box.addWidget(self._build_waiting_panel())
        # 这里曾经有一句 addStretch(1)：图区被 setMaximumHeight 焊死拿不走余量，
        # 剩下的高度就全灌进这个 spacer——实测 348px 的死空白横在「在等什么」和按钮之间。
        # 现在图区自己吃满（比例跟着重排，不是拉出一圈白边），spacer 就不需要了。
        box.addWidget(self._build_action_row())
        return panel

    def _on_zoom_changed(self, scale: float) -> None:
        self.zoom_label.setText(f"{int(round(scale * 100))}%")

    def _build_waiting_panel(self) -> QWidget:
        frame = QFrame()
        frame.setFrameShape(QFrame.Shape.StyledPanel)
        box = QVBoxLayout(frame)
        box.setContentsMargins(10, 8, 10, 8)
        box.setSpacing(4)

        self.now_title = QLabel("—")
        self.now_title.setFont(_bold(12))
        box.addWidget(self.now_title)

        self.waiting_label = QLabel("在等什么：—")
        self.waiting_label.setWordWrap(True)
        self.waiting_label.setTextFormat(Qt.TextFormat.RichText)
        box.addWidget(self.waiting_label)

        frame.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Maximum)
        return frame

    def _build_action_row(self) -> QWidget:
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)

        # 名字里带上"重看这段戏"：策划想重看时会去点名字像那回事的按钮，
        # 而真能办成这件事的恰恰是回上一拍（回去再走进来，戏就重演一遍）。
        self.back_btn = QPushButton("← 回上一拍（重看这段戏）")
        self.back_btn.setToolTip(
            "读上一拍的存档：身上的东西、场景变化、任务进度都跟着回去。\n"
            "回去之后再走进来，这段戏就会重演一遍——想再看一次就用这个。\n"
            "只在同一条故事线里找，不会把你扔到别的线上。"
        )
        self.back_btn.clicked.connect(self._go_back)
        layout.addWidget(self.back_btn)

        self.replay_btn = QPushButton("再演一遍这段戏")
        self.replay_btn.setToolTip(
            "重演**你正看着的**那一拍（图中间蓝框那个，不一定是游戏当前那拍）。\n"
            "先读那一拍的存档把世界退回去，再把它重新走一次——\n"
            "那一拍挂的演出会原样重演，不用自己跑回场景里触发。"
        )
        self.replay_btn.clicked.connect(self._replay_current)
        layout.addWidget(self.replay_btn)

        self.mark_btn = QPushButton("记一个点")
        self.mark_btn.setToolTip("把现在这一刻整个存下来，之后随时回来")
        self.mark_btn.clicked.connect(self._capture_now)
        layout.addWidget(self.mark_btn)

        self.signal_btn = QPushButton("假装做了那一下…")
        self.signal_btn.setToolTip("直接把某件事标成「已发生」，用来验后面的路通不通")
        self.signal_btn.clicked.connect(self._open_signal_dialog)
        layout.addWidget(self.signal_btn)

        self.xref_btn = QPushButton("信号关系…")
        self.xref_btn.setToolTip(
            "一条信号：谁把它打出去、谁在等它，外加此刻谁真在等。\n"
            "「我刚才那下怎么没反应」先来这儿看一眼。"
        )
        self.xref_btn.clicked.connect(lambda: self._open_signal_xref())
        layout.addWidget(self.xref_btn)

        layout.addStretch(1)

        self.savepoint_label = QLabel("")
        self.savepoint_label.setStyleSheet("color:#7a756e;")
        self.savepoint_label.setToolTip("点一下看存了哪些点")
        layout.addWidget(self.savepoint_label)

        self.points_btn = QPushButton("存档点…")
        self.points_btn.clicked.connect(self._open_savepoints_dialog)
        layout.addWidget(self.points_btn)
        return row

    # ---- 右：时间线 ----------------------------------------------------

    def _build_timeline_panel(self) -> QWidget:
        panel = QWidget()
        box = QVBoxLayout(panel)
        box.setContentsMargins(0, 0, 0, 0)
        box.setSpacing(6)

        head_row = QHBoxLayout()
        head = QLabel("刚才发生了什么")
        head.setFont(_bold(11))
        head_row.addWidget(head)
        head_row.addStretch(1)

        self.only_problems = QCheckBox("只看没走通的")
        self.only_problems.toggled.connect(lambda _: self._rebuild_timeline())
        head_row.addWidget(self.only_problems)

        clear = QPushButton("清空")
        clear.clicked.connect(self._clear_timeline)
        head_row.addWidget(clear)
        box.addLayout(head_row)

        self.timeline_list = QListWidget()
        self.timeline_list.setWordWrap(True)
        self.timeline_list.setAlternatingRowColors(True)
        self.timeline_list.itemClicked.connect(self._on_timeline_clicked)
        self.timeline_list.itemDoubleClicked.connect(self._on_timeline_double_clicked)
        self.timeline_list.setToolTip("单击：镜头挪到那一拍；双击：看那条信号谁发谁听")
        box.addWidget(self.timeline_list, 1)

        self.timeline_empty = QLabel("在游戏里走两步、点个人，这里就会有反应")
        self.timeline_empty.setStyleSheet("color:#7a756e;")
        self.timeline_empty.setWordWrap(True)
        box.addWidget(self.timeline_empty)
        return panel

    # ---- 状态更新 -----------------------------------------------------

    # ---- 调试对象 ------------------------------------------------------

    def _refresh_targets(self) -> None:
        """重画「调试对象」下拉。

        ⚠ 必须 blockSignals：重填会触发 currentIndexChanged，那会把"重画"变成"切人"。
        （用 activated 只认真人点击已经挡住大半，但下拉是外部状态的镜子，双保险。）
        """
        targets = self.hub.targets()
        self.target_picker.blockSignals(True)
        self.target_picker.clear()
        if not targets:
            self.target_picker.addItem("（没有游戏连上）", "")
            self.target_picker.setEnabled(False)
        else:
            for entry in targets:
                self.target_picker.addItem(entry["label"], entry["id"])
            active = self.hub.active_target_id
            idx = self.target_picker.findData(active)
            if idx >= 0:
                self.target_picker.setCurrentIndex(idx)
            # 只有一个页签时也留着能点：点它不会出事，而灰掉的控件没人会去研究它干嘛用
            self.target_picker.setEnabled(True)
        self.target_picker.blockSignals(False)

    def _on_target_picked(self, index: int) -> None:
        client_id = str(self.target_picker.itemData(index) or "")
        if not client_id:
            return
        if not self.hub.set_active_target(client_id):
            # 已经是它了：把选中项拉回真值，别让下拉显示成另一个
            self._refresh_targets()

    def _on_active_target_changed(self) -> None:
        """换人了：界面整块跟过去。

        断点表必须重新下发——刚切过去的那个页签一个断点都没有（切走时被撤干净了），
        不补发的话调试器列着断点、游戏那边却谁也不断。
        """
        self._paused_at = None
        self._step_armed = False
        self._sync_bp_buttons()
        self._push_breakpoints()
        if self.auto_save.isChecked():
            self.hub.send_command(
                {"command": "setAutoSavepoints", "enabled": True, "graphs": self._savepoint_graph_ids()}
            )
        self._rebuild_timeline()
        self._refresh_targets()
        self._on_state_changed()

    def _on_connection(self, connected: bool) -> None:
        if connected:
            # 游戏是新起的进程，断点表要重新下发一次，否则调试器列着断点、游戏侧一个都没有
            self._push_breakpoints()
        else:
            # 断住时关掉游戏页签：游戏侧靠 onclose 自己解冻了，这边不清的话状态栏会
            # 一直写着"⏸ 断在 X"、继续/单步还亮着，点下去只回一句"游戏没连上"
            self._step_armed = False
        self._paused_at = None
        self._sync_bp_buttons()
        self.dot.setStyleSheet("color:#3f8c3f;" if connected else "color:#c0392b;")
        self._update_status()
        # 连上/断开都要让信号关系窗跟着变（「就当这件事发生了」按钮的可用性看连接）
        self._refresh_xref_runtime()
        if connected and self.auto_save.isChecked():
            self.hub.send_command(
                {"command": "setAutoSavepoints", "enabled": True, "graphs": self._savepoint_graph_ids()}
            )

    def _on_state_changed(self) -> None:
        live = {f"{g}.{s}" for g, s in self.hub.state.active_states.items()}
        self.graph.set_live_states(live)
        self._follow_composition()
        self._refresh_beats_marks()
        if self.follow_btn.isChecked():
            focus = self.hub.state.primary_focus(self.index)
            if focus and focus != self.graph.focus_key:
                self._push_history(self.graph.focus_key)
                self.graph.render_focus(focus)
            elif focus:
                self.graph.render_focus(focus)
        self._refresh_now_panel()
        self._update_status()
        self._refresh_xref_runtime()

    def _refresh_xref_runtime(self) -> None:
        """信号关系窗只在**开着**时才刷：关着的时候一分钱不花。"""
        if self._xref_window is not None and self._xref_window.isVisible():
            self._xref_window.refresh_runtime()

    def _update_status(self) -> None:
        state = self.hub.state
        if not state.connected:
            # 三条路都写出来：改地址栏要重开页面（现场就没了），后两条是现场就能开的
            self.status_label.setText(
                f"游戏没连上（端口 {self.hub.port}）· 游戏里 F2 →「叙事调试」勾「连上叙事调试器」"
                "，或控制台 __ndbg.on()，或地址后面加 ?ndbg=1"
            )
            return
        scene = self.index.scene_names.get(state.scene_id, state.scene_id) or "—"
        save_hint = "" if state.can_save else " · 演出中，记不了点"
        others = max(0, len(self.hub.targets()) - 1)
        more = f" · 另有 {others} 个页签连着" if others else ""
        self.status_label.setText(f"已连上 · 场景 {scene} · {state.last_update}{save_hint}{more}")
        self.savepoint_label.setText(f"存了 {len(self.store.all())} 个点")

    def _set_hint(self, text: str) -> None:
        self.hint_label.setText(text)
        QTimer.singleShot(4000, lambda: self.hint_label.setText(""))

    def _refresh_now_panel(self) -> None:
        key = self.graph.focus_key
        if not key:
            self.now_title.setText("—")
            self.waiting_label.setText("在等什么：—")
            return
        graph_id, _, state_id = key.rpartition(".")
        node = self.index.state(graph_id, state_id)
        if node is None:
            self.now_title.setText(key)
            self.waiting_label.setText("")
            return
        live = self.hub.state.active_states.get(graph_id) == state_id
        badge = "　（游戏正停在这儿）" if live else "　（你正在看的位置）"
        self.now_title.setText(f"{node.display}{badge}")

        items = waiting_items(self.index, graph_id, state_id)
        if not items:
            self.waiting_label.setText("<span style='color:#7a756e'>这是这条线的末尾，没有出口了</span>")
            return
        lines = ["<b>在等这些事之一：</b>" if len(items) > 1 else "<b>在等：</b>"]
        for item in items:
            # 玩家动作是策划真正要的答案；"等某子图走完"只作为次要说明，
            # 且两者一样时绝不重复说一遍（"也就是让<同一句>"看着像工具坏了）。
            head = item.action or item.what
            where = item.action_where or item.where
            where_html = f" <span style='color:#7a756e'>（{where}）</span>" if where else ""
            lines.append(f"　<b>·</b> {head}{where_html}")
            if item.action and item.what and item.what != item.action:
                lines.append(
                    f"　　<span style='color:#7a756e'>也就是让{item.what} → {item.to_label}</span>"
                )
            else:
                lines.append(f"　　<span style='color:#7a756e'>→ {item.to_label}</span>")
            if item.blocked_by:
                lines.append(f"　　<span style='color:#b8860b'>但要先：{item.blocked_by}</span>")
        self.waiting_label.setText("<br>".join(lines))

    # ---- 拍子清单 -----------------------------------------------------

    def _set_list_mode(self, mode: str) -> None:
        self._list_mode = mode
        self.mode_line_btn.setChecked(mode == "line")
        self.mode_scene_btn.setChecked(mode == "scene")
        self.comp_picker.setVisible(mode == "line")
        self.scene_label.setVisible(mode == "scene")
        self._refresh_beats()

    def _graph_label(self, graph_id: str) -> str:
        return self.index.graph_labels.get(graph_id, graph_id)

    def _short_graph_label(self, graph_id: str) -> str:
        """行首那个〔图名〕只要认得出是哪张图就够。

        真实图名带一截括号注解（「①.5偷鸡（概率·失败记仇）」），整段塞进 250px 的左栏
        会把状态名挤出屏幕——前缀取括号前那截，注解留给 tooltip 和搜索。
        """
        label = self._graph_label(graph_id)
        for bracket in ("（", "("):
            head = label.split(bracket)[0].strip()
            if head:
                label = head
        return label

    def _make_state_item(self, graph_id: str, state_id: str, fallback: str = "") -> QListWidgetItem:
        """一行一个状态，正文永远带上图名。

        129 行子图状态里 7 行都叫「未」、6 行都叫「未触发」——只靠分组标题分辨的话，
        一滚动标题就出了视野，剩下满屏「未 / 未 / 已触发」，谁是谁全靠猜。
        """
        node = self.index.state(graph_id, state_id)
        label = node.display if node else (fallback or state_id)
        full = self._graph_label(graph_id)
        base = f"〔{self._short_graph_label(graph_id)}〕{label}"
        item = QListWidgetItem(base)
        item.setData(ROLE_KEY, f"{graph_id}.{state_id}")
        item.setData(ROLE_BASE, base)
        # 干草堆用**完整**图名：括号里的注解（「概率·失败记仇」）常常正是策划记得的那半句
        item.setData(ROLE_HAY, f"{full} {label} {graph_id} {state_id}".lower())
        item.setData(ROLE_TIP, f"{label}\n图：{full}\nid：{graph_id}.{state_id}")
        return item

    def _make_header_item(self, graph_id: str) -> QListWidgetItem:
        label = self._graph_label(graph_id)
        header = QListWidgetItem(f"— {label} —")
        header.setForeground(QColor("#7a756e"))
        font = header.font()
        font.setBold(True)
        header.setFont(font)
        header.setFlags(Qt.ItemFlag.NoItemFlags)
        header.setData(ROLE_HEADER, True)
        header.setData(ROLE_HAY, f"{label} {graph_id}".lower())
        return header

    def _fill_scene_list(self) -> None:
        """按场景列：人在这儿，这个场景能推动的每条线 + 每条线的每个状态。"""
        scene_id = self.hub.state.scene_id
        scene = self.index.scene_names.get(scene_id, scene_id)
        self.beat_list.clear()
        if not scene:
            self.scene_label.setText("游戏没连上，不知道人在哪个场景")
            return

        groups = self.index.scene_graphs(scene)
        total = sum(len(nodes) for _, nodes in groups)
        self.scene_label.setText(f"【{scene}】{len(groups)} 条线 · {total} 个状态")
        if not groups:
            item = QListWidgetItem("这个场景里没有挂任何叙事")
            item.setForeground(QColor("#7a756e"))
            self.beat_list.addItem(item)
            return

        for graph_id, nodes in groups:
            self.beat_list.addItem(self._make_header_item(graph_id))
            for node in nodes:
                self.beat_list.addItem(self._make_state_item(node.graph_id, node.state_id))

    def _fill_line_list(self) -> None:
        """按线列：这条线的拍子，后面挂上它每张子图的全部状态。

        只列 mainGraph 那十来拍是不够的——主线下面还挂着三十多张子图，
        策划要找的那个状态多半在子图里。
        """
        comp_id = self.comp_picker.currentData()
        self.beat_list.clear()
        main_ids = {b.graph_id for b in self.index.beats if b.composition_id == comp_id}
        for graph_id in sorted(main_ids):
            self.beat_list.addItem(self._make_header_item(graph_id))
            for beat in self.index.beats:
                if beat.composition_id != comp_id or beat.graph_id != graph_id:
                    continue
                self.beat_list.addItem(
                    self._make_state_item(beat.graph_id, beat.state_id, fallback=beat.label)
                )

        for graph_id in self.index.graphs_in_composition(str(comp_id or "")):
            if graph_id in main_ids:
                continue
            nodes = self.index.graph_states(graph_id)
            if not nodes:
                continue
            self.beat_list.addItem(self._make_header_item(graph_id))
            for node in nodes:
                self.beat_list.addItem(self._make_state_item(node.graph_id, node.state_id))

    # ---- 搜索 ---------------------------------------------------------

    def _apply_beat_filter(self) -> None:
        """图名和状态名一起匹配，命中的留下并高亮，其余收起来。

        状态行的干草堆里含它自己的图名，所以搜一个图名＝那张图整组留下，
        不用为"搜到图名要连带它的状态"再写一层特殊逻辑。
        """
        needle = self.beat_search.text().strip().lower()
        count = self.beat_list.count()
        if not needle:
            for i in range(count):
                item = self.beat_list.item(i)
                item.setHidden(False)
                item.setBackground(NO_BRUSH)
            self.search_count.setVisible(False)
            return

        matched: list[bool] = []
        hits = 0
        for i in range(count):
            item = self.beat_list.item(i)
            ok = needle in str(item.data(ROLE_HAY) or "")
            is_header = bool(item.data(ROLE_HEADER))
            matched.append(ok)
            item.setHidden(not ok)
            item.setBackground(QBrush(SEARCH_HIT) if ok and not is_header else NO_BRUSH)
            if ok and not is_header:
                hits += 1

        # 组里还有命中就把标题留着当路标——否则一串「未」浮在半空，又不知道是谁的了
        head = -1
        keep_head = False
        for i in range(count + 1):
            item = self.beat_list.item(i) if i < count else None
            is_header = item is not None and bool(item.data(ROLE_HEADER))
            if item is None or is_header:
                if head >= 0:
                    self.beat_list.item(head).setHidden(not (keep_head or matched[head]))
                head = i if is_header else -1
                keep_head = False
                continue
            if head >= 0 and matched[i]:
                keep_head = True

        self.search_count.setText(f"命中 {hits} 条" if hits else self._miss_text(needle))
        self.search_count.setVisible(True)

    def _miss_text(self, needle: str) -> str:
        """这条线里没有，就说清楚别的线里有没有。

        左栏一次只列一条线，光说"没搜到"会让人以为整个项目都没有这东西——
        而 `水鬼` 明明在码头那条线里躺着。
        """
        if self._list_mode == "scene":
            # 按场景看的时候列表装的是"这个场景挂了什么"，跟哪条线无关，
            # 报"别的线里有 N 条"是答非所问
            return "这个场景里没有"
        elsewhere: dict[str, int] = {}
        current = str(self.comp_picker.currentData() or "")
        for key in self.index.states:
            graph_id, _, state_id = key.rpartition(".")
            comp = self.index.graph_composition.get(graph_id, "")
            if not comp or comp == current:
                continue
            node = self.index.state(graph_id, state_id)
            label = node.display if node else state_id
            hay = f"{self._graph_label(graph_id)} {label} {graph_id} {state_id}".lower()
            if needle in hay:
                elsewhere[comp] = elsewhere.get(comp, 0) + 1
        if not elsewhere:
            return "整个项目里都没有"
        parts = []
        for comp, n in sorted(elsewhere.items(), key=lambda kv: -kv[1])[:2]:
            idx = self.comp_picker.findData(comp)
            parts.append(f"「{self.comp_picker.itemText(idx) if idx >= 0 else comp}」{n} 条")
        return "这条线里没有；" + "、".join(parts)

    def _refresh_beats(self) -> None:
        if self.comp_picker.count() == 0:
            seen: list[tuple[str, str]] = []
            for beat in self.index.beats:
                pair = (beat.composition_id, beat.composition_label)
                if pair not in seen:
                    seen.append(pair)
            self.comp_picker.blockSignals(True)
            for comp_id, label in seen:
                self.comp_picker.addItem(label, comp_id)
            main_idx = self.comp_picker.findData("xungou_demo_main")
            if main_idx >= 0:
                self.comp_picker.setCurrentIndex(main_idx)
            self.comp_picker.blockSignals(False)

        if self._list_mode == "scene":
            self._fill_scene_list()
        else:
            self._fill_line_list()
        self._refresh_beats_marks()
        # 重填过就得重新过一遍筛子，否则切换线／重读数据之后搜索框还写着字、列表却全放出来了
        self._apply_beat_filter()

    def _follow_composition(self) -> None:
        """游戏跑到哪条流程，左栏就跟到哪条。

        不跟的话左栏会亮着一个错的拍子——而"戏走到哪"正是这一栏的标题，
        给错答案比不给答案更糟。
        """
        if not self.follow_btn.isChecked():
            return
        graph_id = self.hub.state.last_changed_graph
        if not graph_id:
            return
        comp_id = self.index.graph_composition.get(graph_id)
        if not comp_id:
            return
        idx = self.comp_picker.findData(comp_id)
        if idx >= 0 and idx != self.comp_picker.currentIndex():
            self.comp_picker.setCurrentIndex(idx)

    def _refresh_beats_marks(self) -> None:
        live = {f"{g}.{s}" for g, s in self.hub.state.active_states.items()}
        for i in range(self.beat_list.count()):
            item = self.beat_list.item(i)
            key = str(item.data(ROLE_KEY) or "")
            if not key:
                continue  # 分组标题行，没有状态可标
            # 正文拿建行时存下的 base（已含〔图名〕），别用 node.display 重算——
            # 那样每次刷标记都会把图名抹掉一次
            base = str(item.data(ROLE_BASE) or key)
            marks: list[str] = []
            if key in live:
                marks.append("▶")
            if self.store.has(key):
                # ◐＝补记的：回去可能落在这一拍后面。策划天天在左栏双击回退，
                # 只在弹窗里写等于没写——最容易被骗的那一下必须在这儿就看得见。
                if self.store.is_stale(key):
                    marks.append("○")
                elif self._is_drifted(key):
                    marks.append("◐")
                else:
                    marks.append("●")
            elif key in self._missed:
                marks.append("✕")  # 试过但整段都在演出里，存不上
            # 断点标记必须落在**策划真正在看的那一栏**：清单动辄几百行，
            # 只靠下面 120px 的小列表，几个断点散在不同流程里时根本认不出哪拍武装了
            if "." in key:
                g, sid = key.split(".", 1)
                if self.breakpoints.has(g, sid):
                    marks.append("⏻")
            prefix = "".join(marks)
            item.setText(f"{prefix} {base}" if prefix else f"　 {base}")
            # tooltip 每次重拼：行首前缀省掉了完整图名，注解得在这儿补回来；
            # 而存档点提示是叠加项，不能把身份信息整条顶掉
            tip = [str(item.data(ROLE_TIP) or "")]
            if key in self._missed and not self.store.has(key):
                tip.append("这一拍没能记点（整段都在演出里），回不到这儿")
            elif self._is_drifted(key):
                tip.append("这个点是等演出结束才补记的，回去可能落在这一拍后面一点")
            item.setToolTip("\n\n".join(p for p in tip if p))
            font = item.font()
            font.setBold(key in live)
            item.setFont(font)
            # 绿色必须**每次都重设**：只在 live 时染色、不在时不还原的话，
            # 玩一遍下来会攒一串绿字，满屏都在说"现在在这儿"。
            item.setForeground(QColor("#3f8c3f") if key in live else QColor(self._default_fg))

    def _on_beat_clicked(self, item: QListWidgetItem) -> None:
        key = str(item.data(Qt.ItemDataRole.UserRole) or "")
        if key:
            self.follow_btn.setChecked(False)
            self._on_focus_requested(key)

    def _on_beat_double_clicked(self, item: QListWidgetItem) -> None:
        key = str(item.data(Qt.ItemDataRole.UserRole) or "")
        if key:
            self._jump_to(key)

    # ---- 焦点与跳转 ---------------------------------------------------

    def _on_focus_requested(self, key: str) -> None:
        self._push_history(self.graph.focus_key)
        self.graph.render_focus(key)
        self._refresh_now_panel()

    def _push_history(self, key: str) -> None:
        if key and (not self._history or self._history[-1] != key):
            self._history.append(key)
            del self._history[:-40]

    def _on_follow_toggled(self, on: bool) -> None:
        if on:
            self._on_state_changed()

    def _on_hops_changed(self, value: int) -> None:
        self.hops_label.setText(f"前后 {value} 步")
        self.graph.set_hops(value)

    def _jump_to(self, key: str) -> None:
        """回到某一拍：优先读那一拍的全量档，没有档才退回推状态机。"""
        if self.store.has(key):
            if self.store.is_stale(key):
                answer = QMessageBox.question(
                    self,
                    "这个存档点是旧内容存的",
                    "叙事数据从存这个点之后改过了，读回去可能对不上。\n还是要回去吗？",
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                )
                if answer != QMessageBox.StandardButton.Yes:
                    return
            payload = self.store.payload(key)
            if payload:
                drift_note = "（这个点是补记的，可能落在这一拍后面一点）" if self._is_drifted(key) else ""
                self.hub.send_command(
                    {"command": "restoreSavepoint", "payload": payload},
                    lambda reply: self._after_command(reply, f"回到了这一拍{drift_note}"),
                )
                return
        graph_id, _, state_id = key.rpartition(".")
        node = self.index.state(graph_id, state_id)
        name = node.display if node else key
        answer = QMessageBox.question(
            self,
            "这一拍还没存过点",
            f"「{name}」还没存过点，回不到那个现场。\n\n"
            "可以硬把剧情标成走到这儿了，但身上的东西、场景里的变化、任务进度都还停在原地，\n"
            "画面多半对不上——只适合看看这拍的戏，不适合评效果。\n\n"
            "想要准的：开着「自动记点」正常玩一遍，之后随时能精确回来。\n\n"
            "还是先硬跳过去看看？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        self.hub.send_command(
            {"command": "setState", "graphId": graph_id, "stateId": state_id},
            lambda reply: self._after_command(reply, "硬跳过去了——身上的东西和场景没跟着回去"),
        )

    def _go_back(self) -> None:
        """回到上一拍：沿主线找当前状态的前一个有档的落点。"""
        current = self.hub.state.primary_focus(self.index) or self.graph.focus_key
        if not current:
            self._set_hint("还不知道现在在哪一拍")
            return
        target = self._previous_savepoint(current)
        if not target:
            self._set_hint("这条线上还没有更早的存档点——开着「自动记点」玩一遍就有了")
            return
        node = self.index.state(*target.rpartition(".")[::2])
        self._set_hint(f"回到「{node.display if node else target}」——走进去那段戏就会重演")
        self._jump_to(target)

    def _previous_savepoint(self, current: str) -> str:
        """往回找最近一个有档的落点——**只在同一条故事线里找**。

        绝不跨线：曾经出现过"人在背尸活计里，点回退直接被扔到码头那条线"，
        而且不问一声。把人送进另一个故事比不给回退更耽误事。
        """
        graph_id = current.rpartition(".")[0]
        comp_id = self.index.graph_composition.get(graph_id, "")
        same_line = [b.key for b in self.index.beats if b.composition_id == comp_id]
        if current in same_line:
            idx = same_line.index(current)
            for key in reversed(same_line[:idx]):
                if self.store.has(key):
                    return key
        # 不在主线拍子清单上（正在某个子图里）：只认**这张图自己**更早的存档点。
        # 早先按"同一条线里最后存的那个"兜底，结果从崖墓那单被扔到码头——
        # 存档写入顺序不是剧情顺序，兜底兜出个更靠后的点比不给回退更糟。
        order = self._reached_order(graph_id)
        here = order.index(current) if current in order else -1
        if here > 0:
            for key in reversed(order[:here]):
                if self.store.has(key):
                    return key
        return ""

    def _reached_order(self, graph_id: str) -> list[str]:
        """这张图从起点走出去的状态顺序（拓扑序），用来判断谁在谁前面。"""
        graph = self.index.graphs.get(graph_id) or {}
        initial = str(graph.get("initialState") or "")
        edges: dict[str, list[str]] = {}
        for t in self.index.transitions:
            if t.graph_id == graph_id:
                edges.setdefault(t.from_state, []).append(t.to_state)
        ordered: list[str] = []
        seen: set[str] = set()
        queue = [initial] if initial else []
        while queue:
            cur = queue.pop(0)
            if cur in seen:
                continue
            seen.add(cur)
            ordered.append(f"{graph_id}.{cur}")
            queue.extend(n for n in edges.get(cur, []) if n not in seen)
        return ordered

    def _replay_current(self) -> None:
        """一键重演这一拍的戏。

        两步：先读这一拍的档（世界回到刚进这拍的样子），再把状态重新设成同一个
        状态——`debugSetNarrativeState` 走的是 enterState，会把这一拍的
        `onEnterActions` 重跑一遍，那就是这段戏。读档在前保证不叠加副作用。
        """
        # 用**你正看着的**那一拍，不是游戏当前那一拍：想重看的十次里有七八次
        # 是刚过去的那一段，焦点已经指过去了，再拿"当前"就重演错了拍。
        current = self.graph.focus_key or self.hub.state.primary_focus(self.index)
        if not current:
            return
        graph_id, _, state_id = current.rpartition(".")
        node = self.index.state(graph_id, state_id)
        name = node.display if node else current
        if not self.store.has(current):
            self._set_hint(f"「{name}」还没存过点，先「记一个点」再重演")
            return
        payload = self.store.payload(current)
        if not payload:
            self._set_hint("存档读不出来")
            return

        def after_restore(reply: dict) -> None:
            if not reply.get("ok"):
                self._set_hint(str(reply.get("detail") or "读档没成功"))
                return
            self.hub.send_command(
                {"command": "setState", "graphId": graph_id, "stateId": state_id},
                lambda r: self._after_command(r, f"「{name}」这段重演了"),
            )

        self.hub.send_command({"command": "restoreSavepoint", "payload": payload}, after_restore)

    def _capture_now(self) -> None:
        if not self.hub.state.connected:
            self._set_hint("游戏没连上")
            return
        focus = self.hub.state.primary_focus(self.index)
        graph_id, _, state_id = focus.rpartition(".")
        node = self.index.state(graph_id, state_id)
        label = node.display if node else (focus or "手动记点")
        self.hub.send_command(
            {"command": "captureSavepoint", "label": label},
            lambda reply: self._on_manual_capture(reply, focus or label, label),
        )

    def _on_manual_capture(self, reply: dict, key: str, label: str) -> None:
        if not reply.get("ok"):
            self._set_hint(str(reply.get("detail") or "记点失败"))
            return
        payload = str(reply.get("payload") or "")
        if not payload:
            self._set_hint("记点失败：没拿到存档内容")
            return
        graph_id, _, state_id = key.rpartition(".")
        self.store.capture(
            key,
            label,
            payload,
            graph_id=graph_id,
            state_id=state_id,
            scene_id=self.hub.state.scene_id,
        )
        self._refresh_savepoint_marks()
        self._set_hint(f"记下了「{label}」")

    def _on_savepoint_captured(self, key: str, label: str, payload: str, drifted: bool = False) -> None:
        graph_id, _, state_id = key.rpartition(".")
        node = self.index.state(graph_id, state_id)
        name = node.display if node else label
        self.store.capture(
            key,
            f"{name}（补记的，可能不是这一拍的现场）" if drifted else name,
            payload,
            graph_id=graph_id,
            state_id=state_id,
            scene_id=self.hub.state.scene_id,
            drifted=drifted,
        )
        if drifted:
            self._set_hint(f"「{name}」是等演出结束才补记的，回去可能落在后面一点")
        self._refresh_savepoint_marks()

    def _is_drifted(self, key: str) -> bool:
        point = self.store.get(key)
        return bool(point and point.drifted)

    def _on_savepoint_missed(self, key: str, label: str) -> None:
        """这一拍从头到尾都在演出里，档没存上——当场说，别等要回去时才发现是空的。"""
        graph_id, _, state_id = key.rpartition(".")
        node = self.index.state(graph_id, state_id)
        name = node.display if node else (label or key)
        self._missed.add(key)
        self._set_hint(f"「{name}」这一拍没能记点（整段都在演出里），回不到这儿")
        self._refresh_beats_marks()

    def _refresh_savepoint_marks(self) -> None:
        self.graph.set_savepoints({p.key for p in self.store.all()})
        if self.graph.focus_key:
            self.graph.render_focus(self.graph.focus_key)
        self._refresh_beats_marks()
        self.savepoint_label.setText(f"存了 {len(self.store.all())} 个点")

    def _after_command(self, reply: dict, ok_text: str) -> None:
        self._set_hint(ok_text if reply.get("ok") else str(reply.get("detail") or "没成功"))

    def _savepoint_graph_ids(self) -> list[str]:
        """值得记点的图。

        判据是"这张图有 3 个以上状态"——拍子线（scenario_* 那些戏）都过得了，
        而 wrap_读人 / wrap_镇尸 那种二值开关过不了。全记的话一次推进能攒几十份
        全量档、列表里全是策划不认识的名字；只记 4 张主图又回不到梦那段。
        """
        ids = {b.graph_id for b in self.index.beats}
        ids.update(self.hub.state.run_archetypes)
        counts: dict[str, int] = {}
        for key in self.index.states:
            graph_id = key.rpartition(".")[0]
            counts[graph_id] = counts.get(graph_id, 0) + 1
        ids.update(g for g, n in counts.items() if n >= 3)
        return sorted(ids)

    def _on_auto_save_toggled(self, on: bool) -> None:
        self.hub.send_command(
            {"command": "setAutoSavepoints", "enabled": on, "graphs": self._savepoint_graph_ids()}
        )
        self._set_hint("每走到新的一拍会自动存档" if on else "不再自动存档")

    # ---- 时间线 -------------------------------------------------------

    def _passes_filter(self, entry: TimelineEntry) -> bool:
        return not (self.only_problems.isChecked() and entry.verdict in {VERDICT_OK, "info"})

    def _on_timeline(self, entry: TimelineEntry) -> None:
        # 「本次会话」那一栏跟着走：不过滤掉的行也要算（被过滤只是不显示在时间线里）
        if self._xref_window is not None and self._xref_window.isVisible():
            self._xref_window.refresh_history()
        if not self._passes_filter(entry):
            return
        self._append_timeline_item(entry)
        self.timeline_list.scrollToBottom()

    def _on_timeline_replaced(self, _index: int, entry: TimelineEntry) -> None:
        """同一动作的后续结果并进原来那一行；找不到（被过滤掉过）就补一条。"""
        if self._xref_window is not None and self._xref_window.isVisible():
            self._xref_window.refresh_history()
        if entry.merge_key:
            start = self.timeline_list.count() - 1
            for i in range(start, max(-1, start - 12), -1):
                item = self.timeline_list.item(i)
                if item is None:
                    continue
                if str(item.data(Qt.ItemDataRole.UserRole + 1) or "") == entry.merge_key:
                    if self._passes_filter(entry):
                        self._fill_timeline_item(item, entry)
                    else:
                        self.timeline_list.takeItem(i)
                    return
        if self._passes_filter(entry):
            self._append_timeline_item(entry)
            self.timeline_list.scrollToBottom()

    def _fill_timeline_item(self, item: QListWidgetItem, entry: TimelineEntry) -> None:
        icon = VERDICT_ICON.get(entry.verdict, "·")
        text = f"{entry.at}  {icon} {entry.headline}"
        if entry.detail and entry.detail != "……":
            # 续行要缩进对齐，否则第二行顶格跟下一条的时间戳混在一起，分不清谁是谁。
            # 太长的还要截断——Qt 自动折行出来的第三行不会带缩进，一样会混。
            wrapped = " ".join(entry.detail.split())
            if len(wrapped) > 38:
                wrapped = wrapped[:37] + "…"
            text += f"\n{' ' * 12}{wrapped}"
        item.setText(text)
        item.setForeground(QColor(VERDICT_COLOR.get(entry.verdict, "#23211f")))
        item.setData(Qt.ItemDataRole.UserRole + 1, entry.merge_key)
        # 全文 + 工程原文挂 tooltip：正文截断了，但要贴给程序时能取到完整的
        tip_parts = [entry.headline, entry.detail, entry.raw]
        if entry.graph_id:
            tip_parts.append(f"{entry.graph_id}.{entry.state_id}")
        item.setToolTip("\n".join(p for p in tip_parts if p and p != "……"))
        if entry.graph_id and entry.state_id:
            item.setData(Qt.ItemDataRole.UserRole, f"{entry.graph_id}.{entry.state_id}")
        # 这一行是哪条信号：双击就去看它的两侧（"这下怎么没反应"的入口）
        item.setData(ROLE_TIMELINE_SIGNAL, entry.signal)

    def _append_timeline_item(self, entry: TimelineEntry) -> None:
        item = QListWidgetItem()
        self._fill_timeline_item(item, entry)
        self.timeline_list.addItem(item)
        while self.timeline_list.count() > 400:
            self.timeline_list.takeItem(0)
        self.timeline_empty.setVisible(False)

    def _rebuild_timeline(self) -> None:
        self.timeline_list.clear()
        for entry in self.hub.timeline:
            if self._passes_filter(entry):
                self._append_timeline_item(entry)
        self.timeline_list.scrollToBottom()

    def _clear_timeline(self) -> None:
        self.hub.clear_timeline()
        self.timeline_list.clear()
        self.timeline_empty.setVisible(True)

    def _on_timeline_clicked(self, item: QListWidgetItem) -> None:
        key = str(item.data(Qt.ItemDataRole.UserRole) or "")
        if key and key in self.index.states:
            self.follow_btn.setChecked(False)
            self._on_focus_requested(key)

    def _on_timeline_double_clicked(self, item: QListWidgetItem) -> None:
        """双击时间线那一行 → 看这条信号谁发谁听。"""
        signal = str(item.data(ROLE_TIMELINE_SIGNAL) or "")
        if not signal:
            self._set_hint("这一行不是信号（没有可看的两侧）")
            return
        if not self._open_signal_xref(signal):
            # 扫描本身就失败时，_build_xref_index 已经写了准确原因（半截数据…），
            # 别用"信号不在索引里"盖掉它——照那条提示去点「重新读一遍数据」只会再撞一次。
            # 扫描失败时 _build_xref_index 已经写了准确原因，别用"信号不在索引里"盖掉它
            # （守卫不能只判窗口存不存在：走 stale 重扫那一支时窗口早就在了）。
            if not self._xref_scan_failed:
                self._set_hint(f"「{signal}」不在当前这份扫描里——点「重新读一遍数据」再试")

    # ---- 弹窗：存档点 / 假装做了那一下 ----------------------------------

    def _open_savepoints_dialog(self) -> None:
        """存了哪些点得看得见、删得掉——只报个数字，等要用的时候才发现是空的。"""
        dialog = QDialog(self)
        dialog.setWindowTitle("存档点")
        dialog.resize(560, 420)
        box = QVBoxLayout(dialog)

        listing = QListWidget()
        for point in reversed(self.store.all()):
            stale = self.store.is_stale(point.key)
            mark = "○ " if stale else "● "
            # 场景名要翻成中文（29 个场景里 21 个 id≠名），并带上是哪条线——
            # 两单里都有「已接活」，光看名字分不出是路倒那单还是淹尸那单
            scene = self.index.scene_names.get(point.scene_id, point.scene_id)
            where = f"　{scene}" if scene else ""
            line = self.index.graph_labels.get(point.graph_id, "")
            line_txt = f"　〔{line}〕" if line else ""
            tail = "　（旧内容存的，可能对不上）" if stale else ""
            item = QListWidgetItem(f"{mark}{point.label}{line_txt}{where}　{point.captured_at}{tail}")
            item.setData(Qt.ItemDataRole.UserRole, point.key)
            if stale:
                item.setForeground(QColor("#b8860b"))
            listing.addItem(item)
        if listing.count() == 0:
            listing.addItem("还没存过点。打开「自动记点」玩一遍就有了。")
        box.addWidget(listing, 1)

        buttons = QHBoxLayout()
        go = QPushButton("回到选中的点")
        go.clicked.connect(lambda: self._dialog_goto(listing, dialog))
        buttons.addWidget(go)

        drop = QPushButton("删掉选中的")
        drop.clicked.connect(lambda: self._dialog_delete(listing))
        buttons.addWidget(drop)

        drop_stale = QPushButton("清掉所有旧的")
        drop_stale.clicked.connect(lambda: self._dialog_clear_stale(listing))
        buttons.addWidget(drop_stale)

        buttons.addStretch(1)
        close = QPushButton("关掉")
        close.clicked.connect(dialog.accept)
        buttons.addWidget(close)
        box.addLayout(buttons)
        dialog.exec()

    def _dialog_goto(self, listing: QListWidget, dialog: QDialog) -> None:
        item = listing.currentItem()
        key = str(item.data(Qt.ItemDataRole.UserRole) or "") if item else ""
        if key:
            dialog.accept()
            self._jump_to(key)

    def _dialog_delete(self, listing: QListWidget) -> None:
        item = listing.currentItem()
        key = str(item.data(Qt.ItemDataRole.UserRole) or "") if item else ""
        if key and self.store.delete(key):
            listing.takeItem(listing.row(item))
            self._refresh_savepoint_marks()

    def _dialog_clear_stale(self, listing: QListWidget) -> None:
        removed = [p.key for p in self.store.all() if self.store.is_stale(p.key)]
        for key in removed:
            self.store.delete(key)
        for i in range(listing.count() - 1, -1, -1):
            if str(listing.item(i).data(Qt.ItemDataRole.UserRole) or "") in removed:
                listing.takeItem(i)
        self._refresh_savepoint_marks()
        self._set_hint(f"清掉了 {len(removed)} 个旧的点")

    # ---- 弹窗：信号关系（谁发谁听 + 此刻状态）---------------------------

    def _build_xref_index(self):
        """建/重建共享扫描索引（与编辑器面板同一套口径，见 tools/narrative_xref）。

        **失败返回 None，绝不往外抛**：半截数据下一句 traceback 会顺带打断「重新读一遍
        数据」的后半段流程，人只看到按钮没反应（fail-safe 不 fail-open）。
        """
        from tools.narrative_xref import build_index, from_disk

        try:
            index = build_index(from_disk(self.project_root))
            self._xref_scan_failed = False
            return index
        except Exception as exc:  # noqa: BLE001 - 工具窗不许被数据问题带崩
            print(f"[signal-xref] 扫描失败: {exc!r}", flush=True)
            self._xref_scan_failed = True
            self._xref_scan_error = str(exc)
            self._set_hint(f"信号关系扫描失败（数据可能是半截的）：{exc}")
            if self._xref_window is not None:
                self._xref_window.mark_stale(
                    f"⚠ 这次没扫出来（{exc}）——下面显示的还是**上一份**关系，别照着它下判断。"
                    .replace("**", "")
                )
            return None

    def _open_signal_xref(self, signal: str = "") -> bool:
        """打开「信号关系」窗。非模态：策划要一边在游戏里走一边盯着圆点变。

        返回**有没有真的选中那条信号**——找不到时主窗要如实说一句，绝不让窗口弹出来
        却停在别的信号上。
        """
        from tools.narrative_debugger.ui.signal_xref_window import SignalXrefWindow

        if self._xref_window is None:
            xref = self._build_xref_index()
            if xref is None:
                # 扫描失败：_build_xref_index 已经把真正的原因写进提示条。
                # 这里必须 return False（裸 return＝None＝falsy 也行，但签名是 bool，
                # 而且调用方会拿它当"信号不在索引里"去覆盖那条准确提示）。
                return False
            self._xref_window = SignalXrefWindow(
                xref, self.index, self.hub,
                parent=self, on_focus=self._focus_from_xref,
            )
        elif self._xref_stale:
            # 关着的时候重读过数据：这时才重扫，省得没人看的窗白扫一遍全工程。
            # 扫不出来就留着旧的（窗里会照旧显示上一份关系），stale 不清、下次再试。
            if not self._xref_window.set_indexes(self._build_xref_index(), self.index):
                self._xref_window.show()
                self._xref_window.raise_()
                return False
        self._xref_stale = False
        self._xref_window.show()
        self._xref_window.raise_()
        self._xref_window.activateWindow()
        if signal:
            return self._xref_window.show_signal(signal)
        return True

    def _focus_from_xref(self, key: str) -> None:
        """信号关系窗里点某条转移 → 中间那张图挪过去（只挪镜头，不动游戏）。"""
        if key not in self.index.states:
            self._set_hint("那一拍在当前数据里找不到（图可能改过，试试「重新读一遍数据」）")
            return
        self.follow_btn.setChecked(False)
        self._on_focus_requested(key)
        self._set_hint("镜头挪过去了（游戏没动）")

    def _open_signal_dialog(self) -> None:
        """按人话挑一件事，直接标成已发生——不用真跑一遍去验后面的路。"""
        if not self.hub.state.connected:
            self._set_hint("游戏没连上")
            return
        self._build_signal_dialog().exec()

    def _build_signal_dialog(self) -> QDialog:
        """搭「假装做了那一下」那个框。

        与 exec() 分开是为了能从测试里进同一条路：这个框最贵的一脚（私有信号不挑 owner
        就发出去，运行时静默丢弃）只有把框搭起来、真按那颗按钮才试得出来。
        """
        dialog = QDialog(self)
        dialog.setWindowTitle("假装做了那一下")
        dialog.resize(640, 520)
        box = QVBoxLayout(dialog)

        tip = QLabel("挑一件事，直接标成「已发生」。搜得到的都是这条线上真会发生的事。")
        tip.setStyleSheet("color:#7a756e;")
        box.addWidget(tip)

        search = QLineEdit()
        search.setPlaceholderText("打几个字筛一下，比如「婆子」「背尸」")
        box.addWidget(search)

        listing = QListWidget()
        rows: list[tuple[str, str, str]] = []
        for signal in self.index.listeners.keys():
            if signal == DRAFT_SIGNAL:
                continue
            what, where = signal_phrase(self.index, signal)
            action, action_where = player_action_for(self.index, signal)
            text = action or what
            place = action_where or where
            # 光有动作文案会撞车（同一段戏里九条路都是"点那条进山的路"）——
            # 把"这一下会让什么往前走"接在后面，才挑得出想要的那条。
            outcome = self._signal_outcome(signal)
            label = text + (f"　【{place}】" if place else "")
            # 私有信号必须一眼认出来：它跟旁边那条全局信号长得一模一样，
            # 但发法完全不同（不挑 owner 就等于没发）。
            if self.index.is_private_signal(signal):
                label = f"{PRIVATE_MARK}{label}"
            rows.append((signal, label, outcome))
        rows.sort(key=lambda r: (r[1], r[2]))
        for signal, label, outcome in rows:
            item = QListWidgetItem(f"{label}\n　　→ {outcome}" if outcome else label)
            item.setData(Qt.ItemDataRole.UserRole, signal)
            item.setToolTip(
                f"{signal}\n{PRIVATE_NOTE}——先在下面挑是哪个实体发的"
                if self.index.is_private_signal(signal) else signal
            )
            listing.addItem(item)
        listing.setWordWrap(True)
        box.addWidget(listing, 1)

        # 私有信号那一行：发射方 owner。全局信号时整行藏起来，交互一字不变。
        owner_row = QHBoxLayout()
        owner_label = QLabel("谁发的：")
        owner_row.addWidget(owner_label)
        owner_picker = QComboBox()
        owner_picker.setToolTip("私有信号只推这个实体自己的图——不挑的话运行时会直接把它丢掉")
        owner_row.addWidget(owner_picker, 1)
        box.addLayout(owner_row)
        owner_hint = QLabel()
        owner_hint.setStyleSheet("color:#a5822c;")
        owner_hint.setWordWrap(True)
        box.addWidget(owner_hint)

        def refilter(text: str) -> None:
            needle = text.strip()
            for i in range(listing.count()):
                item = listing.item(i)
                hay = item.text() + str(item.data(Qt.ItemDataRole.UserRole) or "")
                item.setHidden(bool(needle) and needle not in hay)

        search.textChanged.connect(refilter)

        buttons = QHBoxLayout()
        buttons.addStretch(1)
        fire = QPushButton("就当这件事发生了")
        fire.clicked.connect(lambda: self._fire_selected_signal(listing, dialog))
        buttons.addWidget(fire)
        cancel = QPushButton("算了")
        cancel.clicked.connect(dialog.reject)
        buttons.addWidget(cancel)
        box.addLayout(buttons)

        self._signal_dialog_listing = listing
        self._signal_owner_picker = owner_picker
        self._signal_owner_widgets = (owner_label, owner_picker, owner_hint)
        self._signal_fire_btn = fire
        listing.currentItemChanged.connect(lambda *_a: self._sync_signal_owner_picker())
        self._sync_signal_owner_picker()
        search.setFocus()
        return dialog

    def _sync_signal_owner_picker(self) -> None:
        """选中的信号换了：owner 那一行跟着换（全局信号整行藏起来）。

        私有信号**没有可选 owner** 时不许放行：那种情况下发出去必被丢弃
        （`signal.private.noOwner`），而"按了什么都没发生"正是这个工具要消灭的体验。
        """
        picker = self._signal_owner_picker
        if picker is None:
            return
        label, _picker, hint = self._signal_owner_widgets
        fire = self._signal_fire_btn
        item = self._signal_dialog_listing.currentItem() if self._signal_dialog_listing else None
        signal = str(item.data(Qt.ItemDataRole.UserRole) or "") if item else ""
        private = bool(signal) and self.index.is_private_signal(signal)

        for widget in (label, picker, hint):
            widget.setVisible(private)
        if not private:
            picker.clear()
            hint.setText("")
            if fire is not None:
                fire.setEnabled(True)
                fire.setToolTip("")
            return

        owners = self.index.private_signal_owners(signal)
        picker.clear()
        for owner in owners:
            picker.addItem(
                f"{self.index.owner_display(owner.owner_type, owner.owner_id)}　·　{owner.graph_label}",
                (owner.owner_type, owner.owner_id),
            )
        picker.setEnabled(bool(owners))
        hint.setText(
            "" if owners else
            "这条私有信号没有任何绑了 owner 的图在听它——现在发出去一定会被丢掉。"
            "（私有信号只能被 owner 绑定的 wrapper 图监听）"
        )
        if fire is not None:
            fire.setEnabled(bool(owners))
            fire.setToolTip(
                "私有信号只推上面挑中的那个实体自己的图" if owners
                else "没有 owner 可挑，发出去必被运行时丢弃"
            )

    def _signal_outcome(self, signal: str) -> str:
        """这一下会让哪条线往前走到哪——用来把撞车的同名动作区分开。"""
        parts: list[str] = []
        for t in self.index.listeners.get(signal, [])[:2]:
            src = self.index.state(t.graph_id, t.from_state)
            dst = self.index.state(t.graph_id, t.to_state)
            line = src.graph_label if src else t.graph_id
            parts.append(f"{line}：{dst.display if dst else t.to_state}")
        return "；".join(parts)

    def _fire_selected_signal(self, listing: QListWidget, dialog: QDialog) -> None:
        item = listing.currentItem()
        signal = str(item.data(Qt.ItemDataRole.UserRole) or "") if item else ""
        if not signal:
            return
        payload: dict = {
            "command": "emitSignal",
            "signal": signal,
            "sourceType": "debug",
            "sourceId": "narrative-debugger",
        }
        hint = "标成已发生了，看看时间线"
        if self.index.is_private_signal(signal):
            # 私有信号缺 owner = 运行时 fail-loud 丢弃，绝不回落全局广播。
            # 这里宁可不发也不发一条注定被丢的——静默没反应正是这个工具要消灭的东西。
            owner = self._selected_owner()
            if owner is None:
                self._set_hint("这条是私有信号，得先挑是哪个实体发的")
                return
            payload["ownerType"], payload["ownerId"] = owner
            hint = f"发给了{self.index.owner_display(*owner)}，看看时间线"
        dialog.accept()
        self.hub.send_command(payload, lambda reply: self._after_command(reply, hint))

    def _selected_owner(self) -> tuple[str, str] | None:
        picker = self._signal_owner_picker
        if picker is None or picker.currentIndex() < 0:
            return None
        data = picker.currentData()
        if not isinstance(data, tuple) or len(data) != 2 or not all(data):
            return None
        return (str(data[0]), str(data[1]))

    # ---- MCP（agent 侧）------------------------------------------------

    def _handle_tool_command(self, payload: dict) -> dict | None:
        """agent 经 MCP 发来的命令里，调试器自己能答的那部分。

        返回 None = 这条该转给游戏。这样 agent 与策划共享同一份状态与同一个档案库，
        agent 跳一拍，界面上焦点跟着动。
        """
        command = str(payload.get("command") or "")

        if command == "debuggerState":
            state = self.hub.state
            focus = state.primary_focus(self.index) or self.graph.focus_key
            graph_id, _, state_id = focus.rpartition(".")
            node = self.index.state(graph_id, state_id)
            return {
                "ok": True,
                "connected": state.connected,
                "sceneId": state.scene_id,
                "canSave": state.can_save,
                "focus": focus,
                "focusLabel": node.display if node else "",
                "activeStates": dict(state.active_states),
                "runArchetypes": list(state.run_archetypes),
                "savepointCount": len(self.store.all()),
                # 同时挂着几个游戏页签时，agent 得知道自己在驱动哪一个——
                # 不说的话，"我明明跳了一拍，画面没动"会被当成引擎的锅。
                "target": self.hub.active_target_id,
                "targets": self.hub.targets(),
            }

        if command == "debuggerTimeline":
            limit = int(payload.get("limit") or 30)
            rows = [e.as_dict() for e in self.hub.timeline[-limit:]]
            return {"ok": True, "timeline": rows}

        if command == "debuggerSavepoints":
            return {
                "ok": True,
                "keys": [p.key for p in self.store.all()],
                "savepoints": [
                    {**p.as_dict(), "stale": self.store.is_stale(p.key)} for p in self.store.all()
                ],
            }

        if command == "debuggerGoto":
            beat = str(payload.get("beat") or "")
            if self.store.has(beat):
                data = self.store.payload(beat)
                if data:
                    self.hub.send_command({"command": "restoreSavepoint", "payload": data})
                    self._set_hint(f"agent 让游戏回到了 {beat}")
                    return {"ok": True, "detail": "restored from savepoint", "beat": beat}
            if not payload.get("force"):
                return {
                    "ok": False,
                    "detail": f"{beat} 没有存档点；要强推状态机请传 forceSetState=true（世界前置不会跟着回去）",
                }
            graph_id, _, state_id = beat.rpartition(".")
            self.hub.send_command({"command": "setState", "graphId": graph_id, "stateId": state_id})
            self._set_hint(f"agent 把状态推到了 {beat}")
            return {"ok": True, "detail": "state forced (world prerequisites not restored)", "beat": beat}

        if command == "emitNarrativeSignalByName":
            signal = str(payload.get("signal") or "")
            if not signal:
                return {"ok": False, "detail": "缺 signal"}
            owner_type = str(payload.get("ownerType") or "").strip()
            owner_id = str(payload.get("ownerId") or "").strip()
            # 私有信号缺 owner 会被运行时静默丢弃。agent 拿不到"什么都没发生"的反馈，
            # 只会以为流程断在别处——所以这里当场退回，并把可选的 owner 列给它。
            if self.index.is_private_signal(signal) and not (owner_type and owner_id):
                owners = self.index.private_signal_owners(signal)
                return {
                    "ok": False,
                    "detail": f"「{signal}」是私有信号，必须带 ownerType/ownerId（否则运行时丢弃）",
                    "owners": [
                        {"ownerType": o.owner_type, "ownerId": o.owner_id,
                         "display": self.index.owner_display(o.owner_type, o.owner_id),
                         "graphId": o.graph_id}
                        for o in owners
                    ],
                }
            self.hub.send_command({
                "command": "emitSignal",
                "signal": signal,
                "sourceType": "debug",
                "sourceId": "narrative-debugger-mcp",
                **({"ownerType": owner_type, "ownerId": owner_id} if owner_type and owner_id else {}),
            })
            self._set_hint(f"agent 发了信号 {signal}")
            return {"ok": True, "detail": "emitted", "signal": signal}

        if command == "captureSavepointNamed":
            label = str(payload.get("label") or "")
            if not self.hub.state.connected:
                return {"ok": False, "detail": "游戏没连上"}
            self._capture_now()
            return {"ok": True, "detail": "capture requested", "label": label}

        return None

    def closeEvent(self, event) -> None:  # noqa: ANN001
        self.hub.stop()
        super().closeEvent(event)


def _font(size: float) -> QFont:
    font = QFont()
    font.setPointSizeF(size)
    return font


def _bold(size: float) -> QFont:
    font = _font(size)
    font.setBold(True)
    return font


def _icon_button(text: str, tip: str) -> QPushButton:
    btn = QPushButton(text)
    btn.setToolTip(tip)
    btn.setFixedWidth(28)
    return btn
