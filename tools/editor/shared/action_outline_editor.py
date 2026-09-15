"""动作大纲编辑器：左边一棵大纲树看全结构，右边检查器只编辑选中的那一条。

为什么不是「把 ActionEditor 塞进对话框」（旧形态，2026-09-14 制作人打回）：
内联 ActionEditor 把每条动作的全部参数、嵌套分支、条件树**一层层平铺**。一条
runActionsIf 带四组 all+not 的条件，光条件就十几个节点、上千像素高，对话框又没有
滚动区——整个窗口被条件占满，后面的分支动作一条都看不见，也没法折叠。
复杂度是**乘出来的**（嵌套深度 × 条件节点数 × 每条参数行数），平铺怎么排都顶不住。

这里的形态与任何复杂度解耦：
- **大纲树**每条动作/分支/选项只占一行（类型 + 一行人话摘要，条件也在摘要里），
  嵌套就是树的缩进；折叠、搜索、拖拽改层级、剪切粘贴都在树上做；
- **检查器**只放选中那一条的标量参数（容器动作的条件整页铺开），自己一层滚动；
- 表单仍是 `ActionRow`（大纲模式），序列化 / omit / 数值保真规则与内联完全同一条路；
- 工作副本是纯 JSON，未被编辑的节点**一个字节都不碰**（只看不改 = 原样返回）；
- 撤销/重做按整份快照做，结构操作与参数编辑一视同仁。
"""
from __future__ import annotations

import json
import time
from copy import deepcopy
from dataclasses import dataclass
from typing import Any

from PySide6.QtCore import QSettings, QSize, Qt, QTimer, Signal
from PySide6.QtGui import QBrush, QColor, QIcon, QKeySequence, QPainter, QPixmap, QShortcut
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QFrame,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMenu,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSplitter,
    QToolButton,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from tools.editor import theme as _theme
from .action_editor import (
    ACTION_TYPES,
    CONTENT_ACTION_TYPES,
    DEBUG_ONLY_ACTION_TYPES,
    LEGACY_ACTION_TYPES,
    OUTLINE_ABSENT,
    ActionRow,
    ActionTypePickerDialog,
    action_type_writes_save,
)
from .action_structure import (
    ActionListSlot,
    action_row_label,
    action_slots,
    count_actions_deep,
    item_row_label,
    slot_row_texts,
    summarize_action,
    summarize_slot_item,
)
from .dialog_geometry import remember_dialog_geometry
from .form_layout import compact_form
from .widget_discard import discard_widget

_ROLE = Qt.ItemDataRole.UserRole
_UNDO_LIMIT = 200
# 同一节点上连续编辑合成一步撤销的时间窗（打字不该一个字一步）。
_UNDO_COALESCE_SEC = 1.2
_SETTINGS_ORG = "GameDraft"
_SETTINGS_APP = "Editor"

_NEW_ITEM_TEMPLATES: dict[str, dict] = {
    # 与内联 ActionChoiceOptionsEditor / RuleSlotsParamEditor 写出的形状一致。
    "options": {"text": "", "actions": []},
    "slots": {"ruleId": "", "resultText": "", "resultActions": []},
}


@dataclass(eq=False)
class _Node:
    """大纲树的一行。

    kind:
      "action" —— obj 是动作 dict，container 是它所在的列表；
      "bad"    —— 列表里不是对象的条目（运行时跳过；原样保留，只允许删/挪）；
      "slot"   —— 多分支容器的一条分支（满足时/不满足时…），obj 是所属动作 dict；
      "item"   —— 选项 / 规矩槽，obj 是条目 dict，container 是条目列表。
    path 是从根出发的稳定寻址（int = 下标，("s", key) = 分支，("i", j) = 条目），
    重建树后按它找回选中与展开状态。
    """

    kind: str
    path: tuple
    parent: "_Node | None"
    container: list | None = None
    obj: Any = None
    slot: ActionListSlot | None = None


def _direct_slot(action: Any) -> ActionListSlot | None:
    """只有一条子列表的容器：子节点直接挂在动作下面，不再多一层「分支」行。"""
    if not isinstance(action, dict):
        return None
    slots = action_slots(action.get("type"))
    return slots[0] if len(slots) == 1 else None


def _index_in(container: list | None, obj: Any) -> int:
    if container is None:
        return -1
    for i, x in enumerate(container):
        if x is obj:
            return i
    return -1


def _save_dot_icon() -> QIcon:
    pm = QPixmap(10, 10)
    pm.fill(Qt.GlobalColor.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    p.setBrush(QColor("#d32f2f"))
    p.setPen(Qt.PenStyle.NoPen)
    p.drawEllipse(1, 1, 8, 8)
    p.end()
    return QIcon(pm)


class _OutlineTree(QTreeWidget):
    """放下时不让 Qt 自己搬行：只报告「谁拖到了哪」，由编辑器改数据再整树重建。"""

    drop_requested = Signal(object, object, int)
    resized = Signal()

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt API
        super().resizeEvent(event)
        self.resized.emit()

    def dropEvent(self, event) -> None:  # noqa: N802 - Qt API
        src = self.currentItem()
        target = self.itemAt(event.position().toPoint())
        indicator = self.dropIndicatorPosition()
        # IgnoreAction：QAbstractItemView::startDrag 见到 MoveAction 会把源行删掉——
        # 行的去留必须只由数据决定。
        event.setDropAction(Qt.DropAction.IgnoreAction)
        event.accept()
        self.stopAutoScroll()
        self.setState(QAbstractItemView.State.NoState)
        self.viewport().update()
        if src is not None:
            self.drop_requested.emit(src, target, int(indicator.value))


class ActionOutlineEditor(QWidget):
    """编辑一组 ActionDef[] 的大纲 + 检查器。`to_list()` 取结果；`modified_changed` 报是否改过。"""

    modified_changed = Signal(bool)

    def __init__(
        self,
        title: str,
        actions: list | None,
        *,
        model=None,
        scene_id: str | None = None,
        cutscene_id: str | None = None,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._title = title or "Actions"
        self._model = model
        self._scene_id = scene_id
        self._cutscene_id = cutscene_id
        self._original = deepcopy(list(actions) if isinstance(actions, list) else [])
        self._actions: list = deepcopy(self._original)
        self._nodes: list[_Node] = []
        self._items: list[QTreeWidgetItem] = []
        self._index_by_path: dict[tuple, int] = {}
        self._undo: list[tuple[list, tuple | None]] = []
        self._redo: list[tuple[list, tuple | None]] = []
        self._last_edit_key: tuple | None = None
        self._last_edit_at = 0.0
        self._inspector_node: _Node | None = None
        self._inspector_row: ActionRow | None = None
        self._inspector_body: QWidget | None = None
        self._syncing_selection = False
        self._last_modified = False
        self._last_type = "setFlag"
        self._save_icon = _save_dot_icon()

        root = QHBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        self._splitter = QSplitter(Qt.Orientation.Horizontal, self)
        self._splitter.setChildrenCollapsible(False)
        root.addWidget(self._splitter)

        self._splitter.addWidget(self._build_outline_pane())
        self._splitter.addWidget(self._build_inspector_pane())
        self._splitter.setStretchFactor(0, 4)
        self._splitter.setStretchFactor(1, 6)
        self._splitter.setSizes([420, 760])

        self._rebuild_tree(select_path=(0,) if self._actions else None)

    # ------------------------------------------------------------------ 外部接口

    def to_list(self) -> list:
        return deepcopy(self._actions)

    def is_modified(self) -> bool:
        return self._actions != self._original

    def splitter(self) -> QSplitter:
        return self._splitter

    def tree(self) -> QTreeWidget:
        return self._tree

    # ------------------------------------------------------------------ 构造

    def _tool(self, text: str, tip: str, slot, parent: QWidget) -> QToolButton:
        b = QToolButton(parent)
        b.setText(text)
        b.setToolTip(tip)
        b.setAutoRaise(True)
        b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        b.clicked.connect(slot)
        return b

    def _build_outline_pane(self) -> QWidget:
        pane = QWidget(self)
        lay = QVBoxLayout(pane)
        lay.setContentsMargins(0, 0, 4, 0)
        lay.setSpacing(4)

        bar = QHBoxLayout()
        bar.setSpacing(2)
        self._btn_add = QToolButton(pane)
        self._btn_add.setText("＋ 动作")
        self._btn_add.setToolTip("添加动作：选中动作时插在它后面；选中分支/选项时追加到里面（Insert）")
        self._btn_add.setPopupMode(QToolButton.ToolButtonPopupMode.MenuButtonPopup)
        self._btn_add.setAutoRaise(True)
        self._btn_add.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._btn_add.clicked.connect(self._add_default)
        self._add_menu = QMenu(self._btn_add)
        self._add_menu.aboutToShow.connect(lambda: self._fill_add_menu(self._add_menu))
        self._btn_add.setMenu(self._add_menu)
        bar.addWidget(self._btn_add)
        self._btn_dup = self._tool("复制一份", "在下方复制出一份（Ctrl+D）", self._duplicate_selected, pane)
        self._btn_del = self._tool("删除", "删除选中项（Delete；可撤销）", self._delete_selected, pane)
        self._btn_up = self._tool("↑", "上移（Alt+↑）", lambda: self._move_selected(-1), pane)
        self._btn_down = self._tool("↓", "下移（Alt+↓）", lambda: self._move_selected(1), pane)
        for b in (self._btn_dup, self._btn_del, self._btn_up, self._btn_down):
            bar.addWidget(b)
        bar.addStretch(1)
        self._btn_undo = self._tool("撤销", "撤销（Ctrl+Z）", self.undo, pane)
        self._btn_redo = self._tool("重做", "重做（Ctrl+Y / Ctrl+Shift+Z）", self.redo, pane)
        bar.addWidget(self._btn_undo)
        bar.addWidget(self._btn_redo)
        lay.addLayout(bar)

        bar2 = QHBoxLayout()
        bar2.setSpacing(2)
        self._filter = QLineEdit(pane)
        self._filter.setPlaceholderText("筛选：类型 / 参数 / 条件里的 flag…")
        self._filter.setClearButtonEnabled(True)
        self._filter.textChanged.connect(self._apply_filter)
        bar2.addWidget(self._filter, 1)
        bar2.addWidget(self._tool("全部展开", "展开整棵大纲", lambda: self._tree.expandAll(), pane))
        bar2.addWidget(self._tool("全部折叠", "只留顶层", lambda: self._tree.collapseAll(), pane))
        lay.addLayout(bar2)

        self._tree = _OutlineTree(pane)
        self._tree.setColumnCount(2)
        self._tree.setHeaderLabels(["动作", "内容"])
        self._tree.setUniformRowHeights(True)
        self._tree.setAlternatingRowColors(True)
        self._tree.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self._tree.setDragDropMode(QAbstractItemView.DragDropMode.InternalMove)
        self._tree.setDragEnabled(True)
        self._tree.setAcceptDrops(True)
        self._tree.setDropIndicatorShown(True)
        self._tree.setIndentation(16)
        self._tree.setExpandsOnDoubleClick(True)
        self._tree.setTextElideMode(Qt.TextElideMode.ElideRight)
        self._tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tree.customContextMenuRequested.connect(self._on_context_menu)
        self._tree.currentItemChanged.connect(self._on_current_item_changed)
        self._tree.drop_requested.connect(self._on_drop_requested)
        header = self._tree.header()
        header.setStretchLastSection(True)
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Interactive)
        # 第一列跟内容走（封顶视口 55%）；用户手动拖过列宽就不再自动改。
        self._col0_user_sized = False
        self._fitting_columns = False
        header.sectionResized.connect(self._on_section_resized)
        self._tree.resized.connect(self._fit_columns)
        self._tree.itemExpanded.connect(lambda _it: self._fit_columns())
        lay.addWidget(self._tree, 1)

        self._status = QLabel(pane)
        self._status.setStyleSheet(_theme.semantic_text_css("faint"))
        lay.addWidget(self._status)

        ctx = Qt.ShortcutContext.WidgetWithChildrenShortcut
        for keys, fn in (
            (QKeySequence.StandardKey.Delete, self._delete_selected),
            ("Ctrl+D", self._duplicate_selected),
            (QKeySequence.StandardKey.Copy, self._copy_selected),
            (QKeySequence.StandardKey.Cut, self._cut_selected),
            (QKeySequence.StandardKey.Paste, self._paste),
            ("Alt+Up", lambda: self._move_selected(-1)),
            ("Alt+Down", lambda: self._move_selected(1)),
            ("Insert", self._add_default),
            (QKeySequence.StandardKey.Undo, self.undo),
            ("Ctrl+Y", self.redo),
            ("Ctrl+Shift+Z", self.redo),
        ):
            sc = QShortcut(QKeySequence(keys), self._tree)
            sc.setContext(ctx)
            sc.activated.connect(fn)
        return pane

    def _build_inspector_pane(self) -> QWidget:
        pane = QWidget(self)
        lay = QVBoxLayout(pane)
        lay.setContentsMargins(4, 0, 0, 0)
        lay.setSpacing(4)
        self._breadcrumb = QLabel(pane)
        self._breadcrumb.setWordWrap(True)
        self._breadcrumb.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        lay.addWidget(self._breadcrumb)
        line = QFrame(pane)
        line.setFrameShape(QFrame.Shape.HLine)
        line.setFrameShadow(QFrame.Shadow.Sunken)
        lay.addWidget(line)
        self._inspector_scroll = QScrollArea(pane)
        self._inspector_scroll.setWidgetResizable(True)
        self._inspector_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self._inspector_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        lay.addWidget(self._inspector_scroll, 1)
        return pane

    # ------------------------------------------------------------------ 树

    def _node_at(self, item: QTreeWidgetItem | None) -> _Node | None:
        if item is None:
            return None
        idx = item.data(0, _ROLE)
        if isinstance(idx, int) and 0 <= idx < len(self._nodes):
            return self._nodes[idx]
        return None

    def selected_node(self) -> _Node | None:
        return self._node_at(self._tree.currentItem())

    def _expanded_paths(self) -> set[tuple]:
        return {n.path for n, it in zip(self._nodes, self._items) if it.isExpanded()}

    def _rebuild_tree(
        self,
        *,
        select_path: tuple | None = None,
        expanded: set[tuple] | None = None,
        rebuild_inspector: bool = True,
    ) -> None:
        first_build = not self._nodes and expanded is None
        self._syncing_selection = True
        try:
            self._tree.clear()
            self._nodes = []
            self._items = []
            self._index_by_path = {}
            self._populate_list(self._tree.invisibleRootItem(), self._actions, None, ())
            for node, item in zip(self._nodes, self._items):
                if first_build:
                    item.setExpanded(True)
                elif expanded is not None:
                    item.setExpanded(node.path in expanded)
            if first_build and len(self._nodes) > 400:
                # 巨型列表：只摊开两层，免得一打开就是几百行。
                for node, item in zip(self._nodes, self._items):
                    item.setExpanded(len(node.path) <= 3)
            target = None
            if select_path is not None:
                target = self._nearest_index(select_path)
            if target is not None:
                self._tree.setCurrentItem(self._items[target])
                self._tree.scrollToItem(self._items[target])
        finally:
            self._syncing_selection = False
        self._fit_columns()
        self._apply_filter(self._filter.text())
        self._refresh_status()
        self._sync_buttons()
        new_node = self.selected_node()
        if rebuild_inspector:
            self._show_inspector(new_node)
        else:
            self._rebind_inspector(new_node)

    def _on_section_resized(self, index: int, _old: int, _new: int) -> None:
        if index == 0 and not self._fitting_columns:
            self._col0_user_sized = True

    def _fit_columns(self) -> None:
        if self._col0_user_sized:
            return
        tree = self._tree
        content = tree.sizeHintForColumn(0) + 16
        vw = tree.viewport().width()
        cap = max(160, int(vw * 0.55)) if vw > 80 else 320
        self._fitting_columns = True
        try:
            tree.setColumnWidth(0, max(120, min(content, cap)))
        finally:
            self._fitting_columns = False

    def _nearest_index(self, path: tuple) -> int | None:
        """按路径找回节点；删掉的话退到同列表的前一个，再退到父节点。"""
        p = tuple(path)
        while p:
            if p in self._index_by_path:
                return self._index_by_path[p]
            last = p[-1]
            if isinstance(last, int) and last > 0:
                p = p[:-1] + (last - 1,)
                continue
            p = p[:-1]
        return 0 if self._nodes else None

    def _add_item(self, parent_item: QTreeWidgetItem, node: _Node) -> QTreeWidgetItem:
        item = QTreeWidgetItem(parent_item)
        idx = len(self._nodes)
        self._nodes.append(node)
        self._items.append(item)
        self._index_by_path[node.path] = idx
        item.setData(0, _ROLE, idx)
        flags = Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsDropEnabled
        if node.kind in ("action", "bad", "item"):
            flags |= Qt.ItemFlag.ItemIsDragEnabled
        item.setFlags(flags)
        self._decorate(item, node)
        return item

    def _populate_list(self, parent_item: QTreeWidgetItem, lst: list, owner: _Node | None, base: tuple) -> None:
        for i, entry in enumerate(lst):
            path = base + (i,)
            if not isinstance(entry, dict):
                self._add_item(parent_item, _Node("bad", path, owner, container=lst, obj=entry))
                continue
            node = _Node("action", path, owner, container=lst, obj=entry)
            item = self._add_item(parent_item, node)
            self._populate_action_children(item, node)

    def _populate_action_children(self, item: QTreeWidgetItem, node: _Node) -> None:
        act = node.obj
        slots = action_slots(act.get("type"))
        if not slots:
            return
        params = act.get("params") if isinstance(act.get("params"), dict) else {}
        direct = _direct_slot(act)
        for slot in slots:
            spath = node.path + (("s", slot.key),)
            if direct is not None:
                host_item, host_node = item, node
            else:
                host_node = _Node("slot", spath, node, obj=act, slot=slot)
                host_item = self._add_item(item, host_node)
            raw = params.get(slot.key)
            if not isinstance(raw, list):
                continue
            if slot.kind == "list":
                self._populate_list(host_item, raw, host_node, spath)
                continue
            for j, it in enumerate(raw):
                ipath = spath + (("i", j),)
                inode = _Node("item", ipath, host_node, container=raw, obj=it, slot=slot)
                iitem = self._add_item(host_item, inode)
                if isinstance(it, dict) and isinstance(it.get(slot.item_actions_key), list):
                    self._populate_list(iitem, it[slot.item_actions_key], inode, ipath + (("a", slot.item_actions_key),))

    def _decorate(self, item: QTreeWidgetItem, node: _Node) -> None:
        tip = ""
        color = None
        italic = False
        if node.kind == "action":
            act = node.obj
            typ = str(act.get("type") or "")
            col0 = action_row_label(node.path[-1], act)
            col1 = summarize_action(act)
            if typ not in ACTION_TYPES:
                col0 += "（未登记）"
                color = "error"
                tip = "未登记的动作类型：运行时不认识会跳过；数据原样保留。"
            elif typ in DEBUG_ONLY_ACTION_TYPES or typ in LEGACY_ACTION_TYPES:
                color = "warn"
                tip = "调试/遗留动作，不建议在内容里使用。"
            item.setIcon(0, self._save_icon if action_type_writes_save(typ) else QIcon())
            tip = f"{typ}\n{col1}" + (f"\n\n{tip}" if tip else "")
        elif node.kind == "bad":
            col0 = action_row_label(node.path[-1], node.obj)
            try:
                col1 = json.dumps(node.obj, ensure_ascii=False)[:80]
            except (TypeError, ValueError):
                col1 = str(node.obj)[:80]
            color = "error"
            tip = "这一条不是对象，运行时会跳过。原样保留，可删除或挪动。"
        elif node.kind == "slot":
            slot = node.slot
            col0, col1 = slot_row_texts(slot, node.obj)
            italic = True
            color = "info"
            tip = slot.hint if slot else ""
        else:  # item
            slot = node.slot
            col0 = item_row_label(slot, node.path[-1][1])
            col1 = summarize_slot_item(slot, node.obj)
            italic = True
            color = "info" if isinstance(node.obj, dict) else "error"
            tip = col1
        item.setText(0, col0)
        item.setText(1, col1)
        item.setToolTip(0, tip or col0)
        item.setToolTip(1, tip or col1)
        font = item.font(0)
        font.setItalic(italic)
        item.setFont(0, font)
        brush = QBrush(QColor(_theme.semantic_text_color(color))) if color else QBrush()
        item.setForeground(0, brush)

    def _refresh_labels(self) -> None:
        for node, item in zip(self._nodes, self._items):
            self._decorate(item, node)
        self._apply_filter(self._filter.text())
        self._refresh_status()

    def _refresh_status(self) -> None:
        top = len(self._actions)
        deep = count_actions_deep(self._actions)
        extra = f" · 含嵌套共 {deep} 条" if deep != top else ""
        mod = " · 已修改" if self.is_modified() else ""
        self._status.setText(f"顶层 {top} 条{extra}{mod}")

    def _apply_filter(self, text: str) -> None:
        q = (text or "").strip().lower()

        def visit(item: QTreeWidgetItem) -> bool:
            hit = not q or q in item.text(0).lower() or q in item.text(1).lower()
            child_hit = False
            for i in range(item.childCount()):
                child_hit = visit(item.child(i)) or child_hit
            item.setHidden(not (hit or child_hit))
            if q and child_hit:
                item.setExpanded(True)
            return hit or child_hit

        root = self._tree.invisibleRootItem()
        for i in range(root.childCount()):
            visit(root.child(i))

    # ------------------------------------------------------------------ 选择 → 检查器

    def _on_current_item_changed(self, current, _previous) -> None:
        if self._syncing_selection:
            return
        self._show_inspector(self._node_at(current))
        self._sync_buttons()

    def _sync_buttons(self) -> None:
        node = self.selected_node()
        movable = node is not None and node.kind in ("action", "bad", "item")
        idx = _index_in(node.container, node.obj) if movable else -1
        self._btn_dup.setEnabled(movable)
        self._btn_del.setEnabled(movable)
        self._btn_up.setEnabled(movable and idx > 0)
        self._btn_down.setEnabled(movable and 0 <= idx < len(node.container) - 1)
        self._btn_undo.setEnabled(bool(self._undo))
        self._btn_redo.setEnabled(bool(self._redo))

    def _breadcrumb_text(self, node: _Node | None) -> str:
        parts: list[str] = []
        n = node
        while n is not None:
            item = self._items[self._index_by_path[n.path]] if n.path in self._index_by_path else None
            parts.append(item.text(0) if item is not None else "?")
            n = n.parent
        parts.append(self._title)
        return "  ›  ".join(reversed(parts))

    def _teardown_inspector(self) -> None:
        self._inspector_row = None
        self._inspector_node = None
        old = self._inspector_scroll.takeWidget()
        # 不能直接 delete：类型切换时我们正处在旧检查器某个控件的信号回调里。
        if old is not None:
            discard_widget(old)
        self._inspector_body = None

    def _rebind_inspector(self, node: _Node | None) -> None:
        """树重建后同一对象换了新 _Node：检查器留着（用户正在里面编辑），只换绑定。"""
        cur = self._inspector_node
        if cur is not None and node is not None and node.kind == cur.kind and node.obj is cur.obj:
            self._inspector_node = node
            self._breadcrumb.setText(self._breadcrumb_text(node))
            return
        self._show_inspector(node)

    def _show_inspector(self, node: _Node | None) -> None:
        self._teardown_inspector()
        self._last_edit_key = None
        body = QWidget()
        lay = QVBoxLayout(body)
        lay.setContentsMargins(2, 2, 8, 8)
        lay.setSpacing(6)
        self._inspector_node = node
        self._breadcrumb.setText(self._breadcrumb_text(node))
        if node is None:
            self._build_overview_page(lay, body)
        elif node.kind == "action":
            self._build_action_page(lay, body, node)
        elif node.kind == "slot":
            self._build_slot_page(lay, body, node)
        elif node.kind == "item":
            self._build_item_page(lay, body, node)
        else:
            self._build_bad_page(lay, body, node)
        lay.addStretch(1)
        self._inspector_body = body
        self._inspector_scroll.setWidget(body)
        body.show()

    def _muted(self, text: str, parent: QWidget) -> QLabel:
        lb = QLabel(text, parent)
        lb.setWordWrap(True)
        lb.setStyleSheet(_theme.semantic_text_css("muted"))
        return lb

    def _build_overview_page(self, lay: QVBoxLayout, body: QWidget) -> None:
        lay.addWidget(QLabel(f"<b>{self._title}</b>", body))
        lay.addWidget(self._muted(
            "左侧大纲一行一条动作；分支、选项是树的下一层。选中一行在这里编辑它。\n"
            "拖拽改顺序或改层级；右键有全部操作。\n"
            "快捷键（焦点在大纲上）：Insert 添加 · Delete 删除 · Ctrl+D 复制一份 · "
            "Ctrl+C / Ctrl+X / Ctrl+V 复制剪切粘贴 · Alt+↑↓ 移动 · Ctrl+Z / Ctrl+Y 撤销重做。",
            body,
        ))
        btn = QPushButton("＋ 添加动作", body)
        btn.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        btn.clicked.connect(lambda: self._add_into_list(self._actions))
        lay.addWidget(btn)

    def _outline_children_value(self, act_type: str, key: str) -> object:
        node = self._inspector_node
        if node is None or node.kind != "action":
            return OUTLINE_ABSENT
        act = node.obj
        if not isinstance(act, dict) or act.get("type") != act_type:
            return OUTLINE_ABSENT
        params = act.get("params")
        if not isinstance(params, dict) or key not in params:
            return OUTLINE_ABSENT
        return params[key]

    def _build_action_page(self, lay: QVBoxLayout, body: QWidget, node: _Node) -> None:
        act = node.obj
        row = ActionRow(
            deepcopy(act),
            parent=body,
            model=self._model,
            scene_id=self._scene_id,
            show_delete_button=False,
            show_reorder_buttons=False,
            cutscene_id=self._cutscene_id,
            outline_children=self._outline_children_value,
        )
        row.apply_fold_policy(True)
        self._inspector_row = row
        lay.addWidget(row)
        row.changed.connect(self._on_row_changed)
        slots = action_slots(act.get("type"))
        if slots:
            quick = QHBoxLayout()
            quick.setSpacing(4)
            for slot in slots:
                text = f"＋ {slot.item_label}" if slot.kind == "items" else f"＋ 添加到「{slot.label}」"
                b = QPushButton(text, body)
                b.setToolTip(slot.hint)
                b.clicked.connect(lambda _=False, s=slot: self._add_into_slot(self._current_node_for(act), s))
                quick.addWidget(b)
            quick.addStretch(1)
            lay.addLayout(quick)

    def _current_node_for(self, obj: Any) -> _Node | None:
        for n in self._nodes:
            if n.kind == "action" and n.obj is obj:
                return n
        return None

    def _build_slot_page(self, lay: QVBoxLayout, body: QWidget, node: _Node) -> None:
        slot = node.slot
        lay.addWidget(QLabel(f"<b>{slot.label}</b>", body))
        if slot.hint:
            lay.addWidget(self._muted(slot.hint, body))
        text = f"＋ {slot.item_label}" if slot.kind == "items" else "＋ 添加动作到这里"
        btn = QPushButton(text, body)
        btn.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        owner = node.obj
        btn.clicked.connect(lambda: self._add_into_slot(self._current_node_for(owner), slot))
        lay.addWidget(btn)

    def _build_bad_page(self, lay: QVBoxLayout, body: QWidget, node: _Node) -> None:
        lay.addWidget(QLabel("<b>非法条目</b>", body))
        lay.addWidget(self._muted("动作列表里这一条不是对象，运行时会跳过。原样保留，可删除或挪动。", body))
        try:
            raw = json.dumps(node.obj, ensure_ascii=False, indent=2)
        except (TypeError, ValueError):
            raw = str(node.obj)
        view = QLabel(raw, body)
        view.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        lay.addWidget(view)

    def _build_item_page(self, lay: QVBoxLayout, body: QWidget, node: _Node) -> None:
        slot = node.slot
        item = node.obj
        j = node.path[-1][1] + 1
        lay.addWidget(QLabel(f"<b>{slot.item_label} {j}</b>", body))
        if not isinstance(item, dict):
            lay.addWidget(self._muted("这一条不是对象，运行时会跳过。原样保留，可删除或挪动。", body))
            return
        form_host = QWidget(body)
        form = compact_form(QFormLayout(form_host))
        # 选项文本 / 结果文本是长文本：检查器独占一栏，字段就该吃满宽度。
        form.setFieldGrowthPolicy(QFormLayout.FieldGrowthPolicy.AllNonFixedFieldsGrow)
        if slot.key == "options":
            self._build_option_form(form, form_host, item)
        elif slot.key == "slots":
            self._build_rule_slot_form(form, form_host, item)
        lay.addWidget(form_host)
        btn = QPushButton(f"＋ 添加动作到{slot.item_label} {j}", body)
        btn.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
        btn.clicked.connect(lambda: self._add_into_item(item, slot))
        lay.addWidget(btn)

    def _build_option_form(self, form: QFormLayout, host: QWidget, item: dict) -> None:
        from .rich_text_field import RichTextLineEdit

        cur = str(item.get("text", "") or "")
        if self._model is not None:
            edit = RichTextLineEdit(self._model, host)
            edit.setText(cur)
            edit.textChanged.connect(lambda _s=None: self._commit_item_field(item, "text", edit.text()))
        else:
            edit = QLineEdit(cur, host)
            edit.textChanged.connect(lambda s: self._commit_item_field(item, "text", s))
        edit.setPlaceholderText("选项文本（空文本的选项运行时不显示）")
        edit.setToolTip("选项展示文案；工程打开时可点「引用」插入 [tag:…]，运行时经 resolveDisplayText。")
        form.addRow("text", edit)

    def _build_rule_slot_form(self, form: QFormLayout, host: QWidget, item: dict) -> None:
        from .id_ref_selector import IdRefSelector
        from .rich_text_field import RichTextTextEdit

        rid = IdRefSelector(host, allow_empty=True, editable=True)
        rid.set_items(self._model.all_rule_ids() if self._model else [])
        rid.set_current(str(item.get("ruleId", "")))
        rid.value_changed.connect(lambda _v: self._commit_item_field(item, "ruleId", rid.current_id()))
        form.addRow("ruleId", rid)
        tx = RichTextTextEdit(self._model, host)
        tx.setMinimumHeight(56)
        tx.setMaximumHeight(160)
        tx.setPlainText(str(item.get("resultText", "")))
        tx.textChanged.connect(lambda: self._commit_item_field(item, "resultText", tx.toPlainText()))
        form.addRow("resultText", tx)
        layers = QWidget(host)
        ll = QHBoxLayout(layers)
        ll.setContentsMargins(0, 0, 0, 0)
        have = set(item.get("requiredLayers") or []) if isinstance(item.get("requiredLayers"), list) else set()
        boxes: list[tuple[str, QCheckBox]] = []
        for key, text in (("xiang", "象"), ("li", "理"), ("shu", "术")):
            cb = QCheckBox(text, layers)
            cb.setChecked(key in have)
            boxes.append((key, cb))
            ll.addWidget(cb)
        ll.addStretch(1)

        def commit_layers(_v=None) -> None:
            picked = [k for k, cb in boxes if cb.isChecked()]
            self._commit_item_field(item, "requiredLayers", picked if picked else OUTLINE_ABSENT)

        for _k, cb in boxes:
            cb.toggled.connect(commit_layers)
        form.addRow("requiredLayers", layers)

    # ------------------------------------------------------------------ 提交检查器编辑

    def _begin_edit(self, key: tuple) -> None:
        now = time.monotonic()
        if self._last_edit_key != key or now - self._last_edit_at > _UNDO_COALESCE_SEC:
            self._push_undo()
        self._last_edit_key = key
        self._last_edit_at = now

    def _on_row_changed(self) -> None:
        node = self._inspector_node
        row = self._inspector_row
        if node is None or row is None or node.kind != "action":
            return
        act = node.obj
        try:
            new = row.to_dict()
        except Exception:  # pragma: no cover - 表单半建时的瞬时态
            return
        new_type = new.get("type")
        new_params = new.get("params") if isinstance(new.get("params"), dict) else {}
        old_type = act.get("type")
        live = act.get("params") if isinstance(act.get("params"), dict) else None
        if new_type == old_type and live is not None:
            # 子列表换回活对象：大纲树的节点就挂在它们身上。
            for slot in action_slots(new_type):
                if slot.key in new_params and slot.key in live:
                    new_params[slot.key] = live[slot.key]
        if new_type == old_type:
            if live is not None and live == new_params:
                return
            if live is None and "params" not in act and not new_params:
                return
        self._begin_edit(("action", id(act)))
        act["type"] = new_type
        act["params"] = new_params
        if new_type != old_type:
            self._rebuild_tree(
                select_path=node.path, expanded=self._expanded_paths(), rebuild_inspector=False,
            )
        else:
            self._refresh_labels()
        self._after_change()

    def _commit_item_field(self, item: dict, key: str, value: object) -> None:
        if value is OUTLINE_ABSENT:
            if key not in item:
                return
        elif item.get(key) == value and key in item:
            return
        self._begin_edit(("item", id(item), key))
        if value is OUTLINE_ABSENT:
            item.pop(key, None)
        else:
            item[key] = value
        self._refresh_labels()
        self._after_change()

    def _after_change(self) -> None:
        self._redo.clear()
        self._sync_buttons()
        self._refresh_status()
        mod = self.is_modified()
        if mod != self._last_modified:
            self._last_modified = mod
            self.modified_changed.emit(mod)

    # ------------------------------------------------------------------ 撤销

    def _selected_path(self) -> tuple | None:
        node = self.selected_node()
        return node.path if node is not None else None

    def _push_undo(self) -> None:
        self._undo.append((deepcopy(self._actions), self._selected_path()))
        if len(self._undo) > _UNDO_LIMIT:
            del self._undo[0]

    def _restore(self, snap: tuple[list, tuple | None], other: list) -> None:
        other.append((deepcopy(self._actions), self._selected_path()))
        actions, path = snap
        expanded = self._expanded_paths()
        self._actions[:] = deepcopy(actions)
        self._last_edit_key = None
        self._rebuild_tree(select_path=path, expanded=expanded)
        self._sync_buttons()
        self._refresh_status()
        mod = self.is_modified()
        if mod != self._last_modified:
            self._last_modified = mod
            self.modified_changed.emit(mod)

    def undo(self) -> None:
        if self._undo:
            self._restore(self._undo.pop(), self._redo)

    def redo(self) -> None:
        if self._redo:
            self._restore(self._redo.pop(), self._undo)

    # ------------------------------------------------------------------ 结构操作

    def _structural(self, mutate, select_path_fn) -> None:
        """结构操作统一出口：记撤销 → 改数据 → 重建树 → 选中结果。"""
        self._push_undo()
        expanded = self._expanded_paths()
        result = mutate()
        if result is False:
            self._undo.pop()
            return
        path = select_path_fn()
        if path is not None:
            expanded |= {path[:k] for k in range(1, len(path))}
        self._last_edit_key = None
        self._rebuild_tree(select_path=path, expanded=expanded)
        self._after_change()

    def _pick_action_type(self) -> str:
        """弹可搜索的类型选择窗；测试可替换。"""
        dlg = ActionTypePickerDialog(self)
        dlg.set_rows([(t, t) for t in CONTENT_ACTION_TYPES], current=self._last_type)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return ""
        return dlg.selected_value()

    def _materialize_new_action(self, action_type: str) -> dict:
        """新动作的初值与内联「+ 添加」后保存出来的一致（控件默认值该落的键照样落）。"""
        tmp = ActionRow(
            {"type": action_type, "params": {}},
            parent=self,
            model=self._model,
            scene_id=self._scene_id,
            cutscene_id=self._cutscene_id,
            outline_children=lambda _t, _k: OUTLINE_ABSENT,
        )
        try:
            out = tmp.to_dict()
        finally:
            discard_widget(tmp)
        for slot in action_slots(action_type):
            out.setdefault("params", {}).setdefault(slot.key, [])
        return out

    def _path_of_obj(self, obj: Any, *, kind: str = "action") -> tuple | None:
        for n in self._nodes:
            if n.kind == kind and n.obj is obj:
                return n.path
        return None

    def _insert_new_action(self, lst: list, index: int) -> None:
        action_type = self._pick_action_type()
        if not action_type:
            return
        self._last_type = action_type
        new = self._materialize_new_action(action_type)
        holder: dict = {}

        def mutate():
            lst.insert(max(0, min(index, len(lst))), new)
            holder["obj"] = new

        self._structural(mutate, lambda: self._find_path_after_rebuild(holder.get("obj")))

    def _find_path_after_rebuild(self, obj: Any) -> tuple | None:
        """结构改完、树还没重建：沿数据自己算路径（与 _populate_* 的寻址规则一致）。"""
        if obj is None:
            return None

        def walk_list(lst: list, base: tuple) -> tuple | None:
            for i, entry in enumerate(lst):
                path = base + (i,)
                if entry is obj:
                    return path
                if isinstance(entry, dict):
                    got = walk_action(entry, path)
                    if got is not None:
                        return got
            return None

        def walk_action(act: dict, path: tuple) -> tuple | None:
            params = act.get("params") if isinstance(act.get("params"), dict) else {}
            for slot in action_slots(act.get("type")):
                spath = path + (("s", slot.key),)
                raw = params.get(slot.key)
                if not isinstance(raw, list):
                    continue
                if slot.kind == "list":
                    got = walk_list(raw, spath)
                    if got is not None:
                        return got
                    continue
                for j, it in enumerate(raw):
                    ipath = spath + (("i", j),)
                    if it is obj:
                        return ipath
                    if isinstance(it, dict) and isinstance(it.get(slot.item_actions_key), list):
                        got = walk_list(it[slot.item_actions_key], ipath + (("a", slot.item_actions_key),))
                        if got is not None:
                            return got
            return None

        return walk_list(self._actions, ())

    def _slot_list(self, action: dict, slot: ActionListSlot, *, create: bool) -> list | None:
        params = action.get("params")
        if not isinstance(params, dict):
            if not create or "params" in action:
                return None
            params = action["params"] = {}
        raw = params.get(slot.key)
        if isinstance(raw, list):
            return raw
        if raw is None and create and slot.key not in params:
            params[slot.key] = []
            return params[slot.key]
        return None

    def _item_actions(self, item: Any, slot: ActionListSlot, *, create: bool) -> list | None:
        if not isinstance(item, dict):
            return None
        raw = item.get(slot.item_actions_key)
        if isinstance(raw, list):
            return raw
        if create and slot.item_actions_key not in item:
            item[slot.item_actions_key] = []
            return item[slot.item_actions_key]
        return None

    def _add_into_list(self, lst: list | None, index: int | None = None) -> None:
        if lst is None:
            return
        self._insert_new_action(lst, len(lst) if index is None else index)

    def _add_into_slot(self, action_node: _Node | None, slot: ActionListSlot) -> None:
        if action_node is None or not isinstance(action_node.obj, dict):
            return
        act = action_node.obj
        if slot.kind == "items":
            self._add_item_to_slot(act, slot)
            return
        # 先确认类型再动数据：取消选择时不能凭空留下一个空的分支键。
        action_type = self._pick_action_type()
        if not action_type:
            return
        self._last_type = action_type
        new = self._materialize_new_action(action_type)

        def mutate():
            lst = self._slot_list(act, slot, create=True)
            if lst is None:
                return False
            lst.append(new)
            return None

        self._structural(mutate, lambda: self._find_path_after_rebuild(new))

    def _add_item_to_slot(self, act: dict, slot: ActionListSlot) -> None:
        new = deepcopy(_NEW_ITEM_TEMPLATES.get(slot.key, {slot.item_actions_key: []}))

        def mutate():
            lst = self._slot_list(act, slot, create=True)
            if lst is None:
                return False
            lst.append(new)
            return None

        self._structural(mutate, lambda: self._find_path_after_rebuild(new))

    def _add_into_item(self, item: Any, slot: ActionListSlot) -> None:
        action_type = self._pick_action_type()
        if not action_type:
            return
        self._last_type = action_type
        new = self._materialize_new_action(action_type)

        def mutate():
            lst = self._item_actions(item, slot, create=True)
            if lst is None:
                return False
            lst.append(new)
            return None

        self._structural(mutate, lambda: self._find_path_after_rebuild(new))

    def _add_default(self) -> None:
        node = self.selected_node()
        if node is None:
            self._add_into_list(self._actions)
        elif node.kind in ("action", "bad"):
            idx = _index_in(node.container, node.obj)
            self._add_into_list(node.container, idx + 1)
        elif node.kind == "slot":
            owner = self._current_node_for(node.obj)
            self._add_into_slot(owner, node.slot)
        elif node.kind == "item":
            self._add_into_item(node.obj, node.slot)

    def _fill_add_menu(self, menu: QMenu) -> None:
        menu.clear()
        node = self.selected_node()
        if node is not None and node.kind in ("action", "bad"):
            idx = _index_in(node.container, node.obj)
            menu.addAction("插入到选中项之前", lambda: self._add_into_list(node.container, idx))
            menu.addAction("插入到选中项之后", lambda: self._add_into_list(node.container, idx + 1))
            if node.kind == "action":
                for slot in action_slots(node.obj.get("type")):
                    label = f"添加{slot.item_label}" if slot.kind == "items" else f"添加到「{slot.label}」"
                    menu.addAction(label, lambda s=slot, n=node: self._add_into_slot(n, s))
            menu.addSeparator()
        elif node is not None and node.kind == "slot":
            text = f"添加{node.slot.item_label}" if node.slot.kind == "items" else f"添加到「{node.slot.label}」"
            menu.addAction(text, lambda: self._add_into_slot(self._current_node_for(node.obj), node.slot))
            menu.addSeparator()
        elif node is not None and node.kind == "item":
            menu.addAction(
                f"添加动作到{node.slot.item_label} {node.path[-1][1] + 1}",
                lambda: self._add_into_item(node.obj, node.slot),
            )
            menu.addSeparator()
        menu.addAction("追加到顶层末尾", lambda: self._add_into_list(self._actions))

    def _delete_selected(self) -> None:
        node = self.selected_node()
        if node is None or node.kind not in ("action", "bad", "item"):
            return
        container, obj = node.container, node.obj
        path = node.path

        def mutate():
            i = _index_in(container, obj)
            if i < 0:
                return False
            del container[i]
            return None

        self._structural(mutate, lambda: path)

    def _duplicate_selected(self) -> None:
        node = self.selected_node()
        if node is None or node.kind not in ("action", "bad", "item"):
            return
        container, obj = node.container, node.obj
        copy_obj = deepcopy(obj)
        holder: dict = {}

        def mutate():
            i = _index_in(container, obj)
            if i < 0:
                return False
            container.insert(i + 1, copy_obj)
            holder["path"] = node.path[:-1] + (
                (node.path[-1][0], node.path[-1][1] + 1) if isinstance(node.path[-1], tuple) else node.path[-1] + 1,
            )
            return None

        self._structural(mutate, lambda: holder.get("path"))

    def _move_selected(self, delta: int) -> None:
        node = self.selected_node()
        if node is None or node.kind not in ("action", "bad", "item"):
            return
        container, obj = node.container, node.obj
        i = _index_in(container, obj)
        j = i + delta
        if i < 0 or j < 0 or j >= len(container):
            return

        def mutate():
            container[i], container[j] = container[j], container[i]
            return None

        last = node.path[-1]
        new_last = (last[0], j) if isinstance(last, tuple) else j
        self._structural(mutate, lambda: node.path[:-1] + (new_last,))

    # ---- 剪贴板（纯文本 JSON：能粘到别处的编辑器/文本里，也能从文本粘回来）

    def _clipboard_payload(self, node: _Node) -> str:
        return json.dumps(node.obj, ensure_ascii=False, indent=2)

    def _copy_selected(self) -> None:
        node = self.selected_node()
        if node is None or node.kind not in ("action", "bad", "item"):
            return
        QApplication.clipboard().setText(self._clipboard_payload(node))

    def _cut_selected(self) -> None:
        node = self.selected_node()
        if node is None or node.kind not in ("action", "bad", "item"):
            return
        self._copy_selected()
        self._delete_selected()

    def _parse_clipboard(self) -> list | None:
        text = QApplication.clipboard().text() or ""
        try:
            data = json.loads(text)
        except (TypeError, ValueError):
            return None
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list) or not data or not all(isinstance(x, dict) for x in data):
            return None
        return data

    def _paste(self) -> None:
        data = self._parse_clipboard()
        if data is None:
            self._status.setText("剪贴板里不是动作 JSON（一个对象或对象数组），没粘贴。")
            return
        node = self.selected_node()
        is_item_payload = all("type" not in x for x in data)
        container: list | None
        if node is not None and node.kind == "item" and is_item_payload:
            container, index = node.container, _index_in(node.container, node.obj) + 1
        elif is_item_payload:
            self._status.setText("剪贴板里是选项/槽位，只能粘到选项/槽位旁边。")
            return
        elif node is None:
            container, index = self._actions, len(self._actions)
        elif node.kind in ("action", "bad"):
            # 粘在选中项「后面」而不是容器「里面」：与 Insert / 复制一份同向，不会意外塞进分支。
            container, index = node.container, _index_in(node.container, node.obj) + 1
        elif node.kind == "slot" and node.slot.kind == "items":
            self._status.setText("这里只能放选项/槽位。")
            return
        else:  # 分支 / 选项 + 动作载荷 → 追加到它里面
            container, index = None, 0
        payload = deepcopy(data)

        def mutate():
            target = container
            idx = index
            if target is None:
                if node.kind == "slot":
                    target = self._slot_list(node.obj, node.slot, create=True)
                else:
                    target = self._item_actions(node.obj, node.slot, create=True)
                if target is None:
                    return False
                idx = len(target)
            for k, obj in enumerate(payload):
                target.insert(idx + k, obj)
            return None

        self._structural(mutate, lambda: self._find_path_after_rebuild(payload[0]))

    # ---- 拖拽

    def _on_drop_requested(self, src_item, target_item, indicator: int) -> None:
        src = self._node_at(src_item)
        target = self._node_at(target_item)
        if src is None:
            return
        src_path = src.path
        target_path = target.path if target is not None else None
        # 延后到拖拽事件循环结束再动数据：此刻还在 QDrag::exec 里，旧 item 还被 Qt 持有。
        QTimer.singleShot(0, self, lambda: self.perform_drop(src_path, target_path, indicator))

    def _node_by_path(self, path: tuple | None) -> _Node | None:
        if path is None or path not in self._index_by_path:
            return None
        return self._nodes[self._index_by_path[path]]

    def _drop_destination(self, src: _Node, target: _Node | None, indicator: int) -> tuple[list, int] | None:
        above = int(QAbstractItemView.DropIndicatorPosition.AboveItem.value)
        below = int(QAbstractItemView.DropIndicatorPosition.BelowItem.value)
        on = int(QAbstractItemView.DropIndicatorPosition.OnItem.value)
        if src.kind == "item":
            if target is not None and target.kind == "item" and target.container is src.container:
                ti = _index_in(target.container, target.obj)
                return target.container, (ti if indicator == above else ti + 1)
            # 放到自己那组的组头上（分支行 / 单分支容器本身）= 挪到组末尾。
            owner = target.obj if target is not None and target.kind in ("slot", "action") else None
            if isinstance(owner, dict):
                lst = self._slot_list(owner, src.slot, create=False)
                if lst is src.container:
                    return lst, len(lst)
            return None
        if target is None:
            return self._actions, len(self._actions)
        titem = self._items[self._index_by_path[target.path]]
        if target.kind in ("action", "bad"):
            ti = _index_in(target.container, target.obj)
            if indicator == above:
                return target.container, ti
            if indicator == on and target.kind == "action":
                slots = action_slots(target.obj.get("type"))
                first_list = next((s for s in slots if s.kind == "list"), None)
                if first_list is not None:
                    lst = self._slot_list(target.obj, first_list, create=True)
                    if lst is not None:
                        return lst, len(lst)
            return target.container, ti + 1
        if target.kind == "slot":
            if target.slot.kind != "list":
                return None
            lst = self._slot_list(target.obj, target.slot, create=True)
            if lst is None:
                return None
            if indicator == below and titem.isExpanded() and lst:
                return lst, 0
            return lst, len(lst)
        if target.kind == "item":
            lst = self._item_actions(target.obj, target.slot, create=True)
            if lst is None:
                return None
            if indicator == below and titem.isExpanded() and lst:
                return lst, 0
            return lst, len(lst)
        return None

    def _contains(self, obj: Any, lst: list) -> bool:
        """lst 是不是 obj 自己（或其子孙）持有的列表：不许把容器拖进它自己肚子里。"""
        if not isinstance(obj, dict):
            return False
        stack: list[Any] = [obj]
        while stack:
            cur = stack.pop()
            if isinstance(cur, dict):
                for v in cur.values():
                    if v is lst:
                        return True
                    if isinstance(v, (dict, list)):
                        stack.append(v)
            elif isinstance(cur, list):
                for v in cur:
                    if v is lst:
                        return True
                    if isinstance(v, (dict, list)):
                        stack.append(v)
        return False

    def perform_drop(self, src_path: tuple, target_path: tuple | None, indicator: int) -> bool:
        src = self._node_by_path(src_path)
        target = self._node_by_path(target_path)
        if src is None or src.kind not in ("action", "bad", "item"):
            return False
        if target is not None and target.obj is src.obj and target.kind == src.kind:
            return False
        dest = self._drop_destination(src, target, indicator)
        if dest is None:
            self._status.setText("不能放在这里。")
            return False
        dest_list, dest_index = dest
        if self._contains(src.obj, dest_list):
            self._status.setText("不能把容器拖进它自己里面。")
            return False
        obj, container = src.obj, src.container

        def mutate():
            i = _index_in(container, obj)
            if i < 0:
                return False
            idx = dest_index
            if container is dest_list and i < idx:
                idx -= 1
            del container[i]
            dest_list.insert(max(0, min(idx, len(dest_list))), obj)
            return None

        self._structural(mutate, lambda: self._find_path_after_rebuild(obj))
        return True

    # ---- 右键

    def _on_context_menu(self, pos) -> None:
        item = self._tree.itemAt(pos)
        if item is not None:
            self._tree.setCurrentItem(item)
        node = self.selected_node()
        menu = QMenu(self._tree)
        self._fill_add_menu(menu)
        if node is not None and node.kind in ("action", "bad", "item"):
            menu.addSeparator()
            menu.addAction("复制一份\tCtrl+D", self._duplicate_selected)
            menu.addAction("复制 JSON\tCtrl+C", self._copy_selected)
            menu.addAction("剪切\tCtrl+X", self._cut_selected)
        menu.addAction("粘贴\tCtrl+V", self._paste)
        if node is not None and node.kind in ("action", "bad", "item"):
            menu.addSeparator()
            menu.addAction("上移\tAlt+↑", lambda: self._move_selected(-1))
            menu.addAction("下移\tAlt+↓", lambda: self._move_selected(1))
            menu.addSeparator()
            menu.addAction("删除\tDelete", self._delete_selected)
        if item is not None and item.childCount():
            menu.addSeparator()
            menu.addAction("展开此项全部", lambda: self._set_expanded_recursive(item, True))
            menu.addAction("折叠此项全部", lambda: self._set_expanded_recursive(item, False))
        menu.exec(self._tree.viewport().mapToGlobal(pos))

    def _set_expanded_recursive(self, item: QTreeWidgetItem, on: bool) -> None:
        item.setExpanded(on)
        for i in range(item.childCount()):
            self._set_expanded_recursive(item.child(i), on)


class ActionOutlineDialog(QDialog):
    """模态大窗口包装：确定返回 `result_actions()`；有改动时取消/关窗先确认。"""

    def __init__(
        self,
        title: str,
        actions: list | None,
        *,
        model=None,
        scene_id: str | None = None,
        cutscene_id: str | None = None,
        parent: QWidget | None = None,
        geometry_key: str = "action_outline",
    ) -> None:
        super().__init__(parent)
        self._base_title = (title or "Actions").strip() or "Actions"
        self._geometry_key = geometry_key
        self.setWindowTitle(self._base_title)
        self.setMinimumSize(640, 420)
        self.resize(*self._default_size())
        lay = QVBoxLayout(self)
        lay.setContentsMargins(8, 8, 8, 8)
        self._editor = ActionOutlineEditor(
            self._base_title, actions, model=model, scene_id=scene_id, cutscene_id=cutscene_id, parent=self,
        )
        self._editor.modified_changed.connect(self._on_modified)
        lay.addWidget(self._editor, 1)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel, parent=self,
        )
        # 检查器里全是输入框：回车不能顺手把整个窗口「确定」掉。
        for b in buttons.buttons():
            if isinstance(b, QPushButton):
                b.setAutoDefault(False)
                b.setDefault(False)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        lay.addWidget(buttons)
        remember_dialog_geometry(self, geometry_key)
        self._restore_splitter()
        self.finished.connect(lambda _r: self._save_splitter())
        self._editor.tree().setFocus()

    def _default_size(self) -> tuple[int, int]:
        w, h = 1180, 760
        screen = self.screen() or QApplication.primaryScreen()
        if screen is not None:
            avail = screen.availableGeometry()
            w = min(w, int(avail.width() * 0.9))
            h = min(h, int(avail.height() * 0.9))
        return max(640, w), max(420, h)

    def _settings_key(self) -> str:
        return f"dialogSplitter/{self._geometry_key}"

    def _restore_splitter(self) -> None:
        try:
            state = QSettings(_SETTINGS_ORG, _SETTINGS_APP).value(self._settings_key())
            if state is not None:
                self._editor.splitter().restoreState(state)
        except Exception:
            pass

    def _save_splitter(self) -> None:
        try:
            QSettings(_SETTINGS_ORG, _SETTINGS_APP).setValue(self._settings_key(), self._editor.splitter().saveState())
        except Exception:
            pass

    def editor(self) -> ActionOutlineEditor:
        return self._editor

    def result_actions(self) -> list:
        return self._editor.to_list()

    def _on_modified(self, modified: bool) -> None:
        self.setWindowTitle(f"* {self._base_title}" if modified else self._base_title)

    def _confirm_discard(self) -> bool:
        """有改动时取消的确认；默认 No（不丢）。测试可替换。"""
        ret = QMessageBox.question(
            self,
            "放弃修改",
            "这组动作有未确定的修改，关闭将全部丢弃。确定放弃？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        return ret == QMessageBox.StandardButton.Yes

    def reject(self) -> None:
        if self._editor.is_modified() and not self._confirm_discard():
            return
        super().reject()

    def sizeHint(self) -> QSize:  # noqa: N802 - Qt API
        return QSize(*self._default_size())
