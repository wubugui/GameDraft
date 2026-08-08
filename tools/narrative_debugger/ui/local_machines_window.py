"""「局部机实例」窗：这台私有机器现在什么状态。

局部机按设计对内容层**不可寻址**（`narrative` / `narrativeCount` 叶拒收它的 id），
外面永远问不到"那个箱子什么状态"。代价是排障时也问不到——所以调试器必须开这一扇窗，
它是唯一有权看见实例私有状态的消费者。没有它，"箱子为什么没开"只能靠重开游戏猜。

界面回答三句话：

1. **这一局到底有几台机器、装在谁身上** —— 按原型 / 场景两层分组，1000 台也翻得动。
2. **这一台现在什么态、变量是多少** —— 变量表给**当前全量值**（原型默认值叠实例覆盖），
   不是只列被写过的那几个：策划问"踢过几次"，没踢过时答案是 0，不是"没这一栏"。
3. **它下一次动的时候停一下** —— 断点可以下在这一台，也可以下在这个原型的所有实例上。

单开一扇窗而不是塞进主窗第四栏：不打开就一分钱不花（1000 行的表不该跟着每次快照重画），
与「信号关系…」「存档点…」同一范式。
"""
from __future__ import annotations

from typing import Any

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QColor, QFont
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPushButton,
    QSplitter,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from tools.narrative_debugger import local_machines
from tools.narrative_debugger.breakpoints import BreakpointStore
from tools.narrative_debugger.hub import DebugHub
from tools.narrative_debugger.local_machines import LocalInstance, LocalMachineDef
from tools.narrative_debugger.model import NarrativeIndex

ROLE_INSTANCE = Qt.ItemDataRole.UserRole
ROLE_GROUP = Qt.ItemDataRole.UserRole + 1

#: 一次最多画多少行。真到 1000 台时，画满不如画一屏 + 明说还有多少——
#: 满屏一模一样的「铁箱」本来也翻不出东西，缩筛子才是出路。
MAX_ROWS = 400

#: 快照最快 4 次/秒，一条信号还能让 1000 台同时动。合批到这个间隔再重画一次。
REFRESH_DEBOUNCE_MS = 150


class LocalMachineWindow(QWidget):
    """局部机实例总览。非模态，关掉即停止一切刷新。"""

    #: (原型 id, 状态 id, 实例键)。实例键为空＝这个原型的所有实例。
    breakpointToggled = Signal(str, str, str)

    def __init__(
        self,
        index: NarrativeIndex,
        hub: DebugHub,
        breakpoints: BreakpointStore,
        parent: QWidget | None = None,
    ) -> None:
        # 挂在主窗下面（与「信号关系」窗同款）：主窗一关它跟着走，
        # 不会留下一个孤儿窗口把整个进程吊着不退。
        super().__init__(parent, Qt.WindowType.Window)
        self.index = index
        self.hub = hub
        self.breakpoints = breakpoints
        self._defs: dict[str, LocalMachineDef] = {}
        self._selected_key = ""
        self._rendered_keys: list[str] = []

        self.setWindowTitle("局部机实例 · 叙事调试器")
        self.resize(980, 620)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(10, 8, 10, 8)
        outer.setSpacing(6)
        outer.addWidget(self._build_filter_row())

        self.count_label = QLabel("")
        self.count_label.setStyleSheet("color:#7a756e;")
        self.count_label.setWordWrap(True)
        outer.addWidget(self.count_label)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(self._build_tree())
        splitter.addWidget(self._build_detail())
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        splitter.setSizes([580, 380])
        outer.addWidget(splitter, 1)

        # 合批定时器：一条信号能让 1000 台机器同时发 trace，逐条重画等于卡死
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.timeout.connect(self._render)

        self.hub.localsChanged.connect(self.schedule_refresh)
        self.refresh()

    # ---- 组装 ---------------------------------------------------------

    def _build_filter_row(self) -> QWidget:
        row = QWidget()
        box = QHBoxLayout(row)
        box.setContentsMargins(0, 0, 0, 0)
        box.setSpacing(6)

        box.addWidget(QLabel("原型"))
        self.machine_picker = QComboBox()
        self.machine_picker.setMinimumWidth(160)
        self.machine_picker.setToolTip("局部机原型＝可复用的那张图；每个绑定它的实体身上有一台自己的机器")
        self.machine_picker.activated.connect(lambda _: self.schedule_refresh())
        box.addWidget(self.machine_picker)

        box.addWidget(QLabel("场景"))
        self.scene_picker = QComboBox()
        self.scene_picker.setMinimumWidth(140)
        self.scene_picker.activated.connect(lambda _: self.schedule_refresh())
        box.addWidget(self.scene_picker)

        self.search = QLineEdit()
        self.search.setPlaceholderText("搜宿主、场景、当前态……（id 和名字都能搜）")
        self.search.setClearButtonEnabled(True)
        self.search.textChanged.connect(lambda _: self.schedule_refresh())
        box.addWidget(self.search, 1)

        self.only_loaded = QCheckBox("只看在场的")
        self.only_loaded.setToolTip("宿主所在的场景当前装载着。不在场的机器照样会换态，只是不放演出")
        self.only_loaded.toggled.connect(lambda _: self.schedule_refresh())
        box.addWidget(self.only_loaded)

        self.only_touched = QCheckBox("只看动过的")
        self.only_touched.setToolTip(
            "态离开了出厂态、或有变量被写过。没动过的机器在存档里是 0 条目——\n"
            "查「哪几个箱子被开过」先勾这个。"
        )
        self.only_touched.toggled.connect(lambda _: self.schedule_refresh())
        box.addWidget(self.only_touched)
        return row

    def _build_tree(self) -> QWidget:
        self.tree = QTreeWidget()
        self.tree.setColumnCount(4)
        self.tree.setHeaderLabels(["装在谁身上", "现在什么态", "在场", "变量"])
        self.tree.setAlternatingRowColors(True)
        self.tree.setUniformRowHeights(True)   # 1000 行时布局代价从 O(n) 降到常数
        self.tree.setTextElideMode(Qt.TextElideMode.ElideRight)
        self.tree.setColumnWidth(0, 250)
        self.tree.setColumnWidth(1, 120)
        self.tree.setColumnWidth(2, 52)
        self.tree.currentItemChanged.connect(lambda cur, _prev: self._on_pick(cur))
        return self.tree

    def _build_detail(self) -> QWidget:
        panel = QWidget()
        box = QVBoxLayout(panel)
        box.setContentsMargins(8, 0, 0, 0)
        box.setSpacing(6)

        self.detail_title = QLabel("左边选一台机器")
        self.detail_title.setFont(_bold(11))
        self.detail_title.setWordWrap(True)
        box.addWidget(self.detail_title)

        self.detail_body = QLabel("")
        self.detail_body.setTextFormat(Qt.TextFormat.RichText)
        self.detail_body.setWordWrap(True)
        self.detail_body.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        box.addWidget(self.detail_body)

        self.var_tree = QTreeWidget()
        self.var_tree.setColumnCount(3)
        self.var_tree.setHeaderLabels(["变量", "现在是", "出厂是"])
        self.var_tree.setRootIsDecorated(False)
        self.var_tree.setAlternatingRowColors(True)
        self.var_tree.setUniformRowHeights(True)
        box.addWidget(self.var_tree, 1)

        bp_row = QHBoxLayout()
        bp_row.setSpacing(4)
        bp_row.addWidget(QLabel("进入"))
        self.bp_state_picker = QComboBox()
        self.bp_state_picker.setMinimumWidth(110)
        bp_row.addWidget(self.bp_state_picker, 1)
        self.bp_this_btn = QPushButton("只断这一台")
        self.bp_this_btn.setToolTip("只有这一台机器进入选中的状态时才停下来（1000 个箱子里只有一个不对时用它）")
        self.bp_this_btn.clicked.connect(lambda: self._toggle_bp(instance_scoped=True))
        bp_row.addWidget(self.bp_this_btn)
        self.bp_all_btn = QPushButton("这个原型全断")
        self.bp_all_btn.setToolTip("任何一台绑了这个原型的机器进入该状态都停（查「到底有没有哪个走到过这一步」）")
        self.bp_all_btn.clicked.connect(lambda: self._toggle_bp(instance_scoped=False))
        bp_row.addWidget(self.bp_all_btn)
        box.addLayout(bp_row)

        self.bp_hint = QLabel("")
        self.bp_hint.setStyleSheet("color:#7a756e;")
        self.bp_hint.setFont(_font(9))
        self.bp_hint.setWordWrap(True)
        box.addWidget(self.bp_hint)

        self.bp_state_picker.activated.connect(lambda _: self._sync_bp_buttons())
        return panel

    # ---- 刷新 ---------------------------------------------------------

    def set_index(self, index: NarrativeIndex) -> None:
        """主窗「重新读一遍数据」之后换索引（原型的变量声明可能改了）。"""
        self.index = index
        self.refresh()

    def schedule_refresh(self) -> None:
        """合批：关着的时候一次都不画。"""
        if not self.isVisible():
            return
        if not self._debounce.isActive():
            self._debounce.start(REFRESH_DEBOUNCE_MS)

    def refresh(self) -> None:
        self._debounce.stop()
        self._render()

    def showEvent(self, event) -> None:  # noqa: ANN001
        super().showEvent(event)
        self.refresh()

    def _render(self) -> None:
        self._defs = local_machines.machine_defs(self.index)
        instances = self.hub.state.locals_list()
        self._sync_pickers(instances)

        shown = local_machines.filter_instances(
            self.index,
            instances,
            machine_id=str(self.machine_picker.currentData() or ""),
            scene_id=str(self.scene_picker.currentData() or ""),
            text=self.search.text(),
            only_loaded=self.only_loaded.isChecked(),
            only_touched=self.only_touched.isChecked(),
            defs=self._defs,
        )
        self._fill_tree(shown)
        self._fill_count(len(instances), len(shown))
        self._refresh_detail()

    def _fill_count(self, total: int, shown: int) -> None:
        if total == 0:
            if not self._defs:
                self.count_label.setText(
                    "这个工程里还没有局部机原型（narrative_graphs.json 里一台都没声明）。"
                    "有了之后，每个绑定它的实体身上会出现一台自己的机器。"
                )
            else:
                self.count_label.setText(
                    f"声明了 {len(self._defs)} 台原型，但这一局还没有任何实例——"
                    "实例是在场景装载、实体绑定那一刻才产生的。"
                )
            return
        text = f"这一局共 {total} 台机器，符合筛子的 {shown} 台"
        if shown > MAX_ROWS:
            text += f"（只画前 {MAX_ROWS} 台，再缩一下筛子）"
        self.count_label.setText(text)

    def _sync_pickers(self, instances: list[LocalInstance]) -> None:
        """原型/场景两个下拉跟着实况走，但**保住当前选择**——重填时把人选的项弄丢，
        等于每来一份快照就把筛子清一次。"""
        machines = sorted({i.machine_id for i in instances} | set(self._defs))
        self._refill_picker(
            self.machine_picker,
            [("全部原型", "")] + [(local_machines.machine_label(self.index, m), m) for m in machines],
        )
        scenes = sorted({i.scene_id for i in instances})
        self._refill_picker(
            self.scene_picker,
            [("全部场景", "")] + [(local_machines.scene_label(self.index, s), s) for s in scenes],
        )

    @staticmethod
    def _refill_picker(picker: QComboBox, rows: list[tuple[str, str]]) -> None:
        keep = picker.currentData()
        current = [(picker.itemText(i), picker.itemData(i)) for i in range(picker.count())]
        if current == rows:
            return
        picker.blockSignals(True)
        picker.clear()
        for label, data in rows:
            picker.addItem(label, data)
        idx = picker.findData(keep)
        picker.setCurrentIndex(idx if idx >= 0 else 0)
        picker.blockSignals(False)

    def _fill_tree(self, instances: list[LocalInstance]) -> None:
        rows = instances[:MAX_ROWS]
        keys = [i.key for i in rows]
        if keys == self._rendered_keys:
            # 行没增没减：只改文字。1000 行整树重建会把选中项和展开状态一起丢掉，
            # 而人正盯着某一行看它变不变。
            self._update_in_place(rows)
            return
        self._rendered_keys = keys
        self.tree.setUpdatesEnabled(False)
        self.tree.clear()
        self._items: dict[str, QTreeWidgetItem] = {}
        for machine_id, scenes in local_machines.group_by_machine_and_scene(rows):
            machine_node = QTreeWidgetItem([
                f"◆ {local_machines.machine_label(self.index, machine_id)}",
                "", "", f"{sum(len(r) for _, r in scenes)} 台",
            ])
            machine_node.setData(0, ROLE_GROUP, True)
            machine_node.setForeground(0, QColor("#7a756e"))
            machine_node.setFont(0, _bold(9.5))
            self.tree.addTopLevelItem(machine_node)
            for scene_id, group in scenes:
                scene_node = QTreeWidgetItem([
                    f"　{local_machines.scene_label(self.index, scene_id)}", "", "", f"{len(group)} 台",
                ])
                scene_node.setData(0, ROLE_GROUP, True)
                scene_node.setForeground(0, QColor("#7a756e"))
                machine_node.addChild(scene_node)
                for inst in group:
                    item = QTreeWidgetItem(self._row_texts(inst))
                    item.setData(0, ROLE_INSTANCE, inst.key)
                    item.setToolTip(0, f"实例键：{inst.key}")
                    scene_node.addChild(item)
                    self._items[inst.key] = item
                scene_node.setExpanded(True)
            machine_node.setExpanded(True)
        self.tree.setUpdatesEnabled(True)
        if self._selected_key in self._items:
            self.tree.setCurrentItem(self._items[self._selected_key])

    def _update_in_place(self, rows: list[LocalInstance]) -> None:
        for inst in rows:
            item = getattr(self, "_items", {}).get(inst.key)
            if item is None:
                continue
            for col, text in enumerate(self._row_texts(inst)):
                if item.text(col) != text:
                    item.setText(col, text)

    def _row_texts(self, inst: LocalInstance) -> list[str]:
        definition = self._defs.get(inst.machine_id)
        overrides = inst.overrides
        vars_text = "、".join(f"{k}={_value_text(v)}" for k, v in sorted(overrides.items()))
        mark = "" if definition is None or not local_machines.deviates(inst, definition) else "· "
        return [
            f"　　{mark}{local_machines.entity_label(self.index, inst)}",
            local_machines.state_label(self.index, inst.machine_id, inst.active),
            local_machines.presence_phrase(inst.loaded),
            vars_text or "（都是出厂值）",
        ]

    # ---- 详情 ---------------------------------------------------------

    def _on_pick(self, item: QTreeWidgetItem | None) -> None:
        key = str(item.data(0, ROLE_INSTANCE) or "") if item is not None else ""
        if key:
            self._selected_key = key
        self._refresh_detail()

    def _current(self) -> LocalInstance | None:
        return self.hub.state.local_instances.get(self._selected_key)

    def _refresh_detail(self) -> None:
        inst = self._current()
        if inst is None:
            self.detail_title.setText("左边选一台机器")
            self.detail_body.setText("")
            self.var_tree.clear()
            self.bp_state_picker.clear()
            self._sync_bp_buttons()
            return
        definition = self._defs.get(inst.machine_id)
        self.detail_title.setText(local_machines.instance_phrase(self.index, inst))

        lines = [
            f"<span style='color:#7a756e'>实例键</span>　{_esc(inst.key)}",
            f"<span style='color:#7a756e'>在场</span>　{local_machines.presence_phrase(inst.loaded)}"
            + ("　<span style='color:#7a756e'>（不在场也照样换态，只是不放这一拍的演出）</span>"
               if inst.loaded is False else ""),
        ]
        if inst.loaded is None:
            lines.append(
                "<span style='color:#b8860b'>引擎没报在场标记（debugSnapshot 里没有 loaded），"
                "这一栏答不出来</span>"
            )
        if definition is None:
            lines.append(
                "<span style='color:#b8860b'>这台原型不在 narrative_graphs.json 里"
                "（数据面还没落地）：变量表只能列被写过的那几个，出厂值答不出来</span>"
            )
        else:
            lines.append(
                f"<span style='color:#7a756e'>出厂态</span>　"
                f"{_esc(local_machines.state_label(self.index, inst.machine_id, definition.initial_state))}"
                + ("　<span style='color:#3f8c3f'>（现在还是出厂态，不进存档）</span>"
                   if not local_machines.deviates(inst, definition) else "")
            )
            if definition.listens:
                lines.append(f"<span style='color:#7a756e'>听这些信号</span>　{_esc('、'.join(definition.listens))}")
            if definition.emits:
                lines.append(f"<span style='color:#7a756e'>会发这些</span>　{_esc('、'.join(definition.emits))}")
        self.detail_body.setText("<br>".join(lines))

        self.var_tree.clear()
        current = local_machines.current_vars(inst, definition)
        for var_key, value in sorted(current.items()):
            default = definition.default_for(var_key) if definition is not None else None
            row = QTreeWidgetItem([
                var_key,
                _value_text(value),
                "—" if definition is None or not definition.declares(var_key) else _value_text(default),
            ])
            if definition is not None and definition.declares(var_key) and value != default:
                row.setForeground(1, QColor("#3f8c3f"))   # 改过的那一格才染色
            if definition is not None and not definition.declares(var_key):
                row.setForeground(0, QColor("#c0392b"))
                row.setToolTip(0, "原型里没声明这个变量——多半是存档里留下的历史脏数据")
            self.var_tree.addTopLevelItem(row)
        if not current:
            self.var_tree.addTopLevelItem(QTreeWidgetItem(["（这台机器没有变量）", "", ""]))

        self._fill_state_picker(inst)
        self._sync_bp_buttons()

    def _fill_state_picker(self, inst: LocalInstance) -> None:
        graph = self.index.graphs.get(inst.machine_id) or {}
        states = list((graph.get("states") or {}).keys())
        if inst.active and inst.active not in states:
            states.append(inst.active)
        keep = str(self.bp_state_picker.currentData() or "")
        self.bp_state_picker.blockSignals(True)
        self.bp_state_picker.clear()
        for state_id in states:
            self.bp_state_picker.addItem(
                local_machines.state_label(self.index, inst.machine_id, state_id), state_id
            )
        idx = self.bp_state_picker.findData(keep or inst.active)
        if idx >= 0:
            self.bp_state_picker.setCurrentIndex(idx)
        self.bp_state_picker.blockSignals(False)

    def _sync_bp_buttons(self) -> None:
        inst = self._current()
        state_id = str(self.bp_state_picker.currentData() or "")
        has_inst = bool(inst) and self.breakpoints.has(inst.machine_id, state_id, inst.key)
        has_all = bool(inst) and self.breakpoints.has(inst.machine_id, state_id)
        for btn in (self.bp_this_btn, self.bp_all_btn):
            btn.setEnabled(bool(inst) and bool(state_id))
        self.bp_this_btn.setText("取消这一台的断点" if has_inst else "只断这一台")
        self.bp_all_btn.setText("取消整原型的断点" if has_all else "这个原型全断")
        if not inst or not state_id:
            self.bp_hint.setText("")
        elif has_inst or has_all:
            self.bp_hint.setText(
                "断在「态刚置位、这一拍的演出还没跑」那一刻，游戏画面同时冻住；"
                "到主窗断点区点「继续」放行。"
            )
        else:
            self.bp_hint.setText("")

    def _toggle_bp(self, *, instance_scoped: bool) -> None:
        inst = self._current()
        state_id = str(self.bp_state_picker.currentData() or "")
        if inst is None or not state_id:
            return
        self.breakpointToggled.emit(inst.machine_id, state_id, inst.key if instance_scoped else "")
        self._sync_bp_buttons()


def _value_text(value: Any) -> str:
    if isinstance(value, bool):
        return "真" if value else "假"
    if value is None:
        return "（空）"
    return str(value)


def _esc(text: str) -> str:
    return str(text).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _font(size: float) -> QFont:
    font = QFont()
    font.setPointSizeF(size)
    return font


def _bold(size: float) -> QFont:
    font = _font(size)
    font.setBold(True)
    return font
