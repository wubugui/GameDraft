"""递归 ConditionExpr 树形编辑器（all / any / not / flag / quest / scenario / scenarioLine / narrative / plane / posture / timePhase / heldProp / burn）。"""
from __future__ import annotations

import copy
import json
from typing import Any, Callable

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtWidgets import (
    QWidget,
    QVBoxLayout,
    QHBoxLayout,
    QFormLayout,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFrame,
    QPushButton,
    QLineEdit,
    QLabel,
    QMessageBox,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QToolButton,
)

from tools.editor import theme as _theme
from .action_structure import summarize_condition
from .flag_key_field import FlagKeyPickField
from .flag_value_edit import FlagValueEdit
from .id_ref_selector import IdRefSelector
from .reference_picker import ReferencePickerField
from .rich_text_field import RichTextLineEdit
from .form_layout import compact_form, fit_width_cap
from .widget_discard import discard_layout_widgets, discard_widget

# 与 narrative_data_editors /运行时一致
_SCENARIO_STATUSES = ("pending", "active", "done", "locked")
_QUEST_STATUSES = ("Inactive", "Active", "Completed")


def _render_outcome_text(oc: object) -> str:
    """与 set_dict 展示 outcome 的渲染保持一致（用于"文本未改动"判定）。"""
    if isinstance(oc, str):
        return oc
    try:
        return json.dumps(oc, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(oc)
_SCENARIO_LINE_STATUSES = ("inactive", "active", "completed")
_MAX_DEPTH = 32

# ---- heldProp（手持挂件叶）的短枚举：与运行时 evaluateGraphCondition.ts / types.ts 同口径 ----
#: 表单管着的键（写出顺序，与 types.ts `HeldPropConditionLeaf` 的字段顺序逐字对齐）；叶子里别的键原样透传
_HELD_PROP_KEYS = (
    "heldProp", "socket", "prop", "propState", "burning",
    "vitalityOp", "vitality", "fuelOp", "fuel", "effect", "lock",
)
#: 火势 / 燃料比较（HELD_VITALITY_OPS，两处共用一张表）
_HELD_VITALITY_OPS = ("<", "<=", ">", ">=")

# ---- propLevel（挂件等级叶）：与 types.ts `PropLevelConditionLeaf` / evaluateGraphCondition.ts 同口径 ----
#: 表单管着的键（写出顺序）；叶子里别的键原样透传
_PROP_LEVEL_KEYS = ("propLevel", "op", "value")
#: 比较运算符（PROP_LEVEL_OPS）；不写 = `>=`
_PROP_LEVEL_OPS = ("==", "!=", "<", "<=", ">", ">=")
#: 不写 `op` 时运行时用的那一档
_PROP_LEVEL_DEFAULT_OP = ">="
#: 锁（HeldPropConditionLeaf.lock）→ 展示名，与 lockPropState 下拉同一套叫法
_HELD_LOCK_ROWS = (("lit", "锁定不灭（lit）"), ("unlit", "点不燃（unlit）"), ("none", "没上锁（none）"))
#: 下拉里「不写这个键」那一行的取值（不落盘）
_HP_UNSET = ""
#: 下拉里「磁盘上是运行时不认的怪值」那一行的取值（不落盘，原值原样回吐）
_HP_RAW = "\x00raw"
#: 「不写键」哨兵（区分于 None / 空串）
_HP_ABSENT = object()

# ---- burn（可燃物叶）：与运行时 evaluateGraphCondition.ts `isBurnLeaf` / types.ts `BurnConditionLeaf` 同口径 ----
#: 表单管着的键（写出顺序）；叶子里别的键原样透传
_BURN_KEYS = ("burn", "burnSocket", "burnScene", "burnState")
#: burnSocket 空值那一行的说法
_BURN_SOCKET_EMPTY_LABEL = "（不写 = 场景里的可燃实体）"
#: 四个状态（值, 展示名）；叫法与 shared/burnables.BURN_STATE_LABELS 同一份
_BURN_STATE_ROWS = (
    ("unburnt", "没点（unburnt）"), ("burning", "在烧（burning，含余烬）"),
    ("out", "灭了（out，还剩燃料）"), ("burnt", "烧完（burnt）"),
)
# 单个 flag 节点约 ~120px；旧值 640 会让常见的一节点条件凭空占掉大片空白。
# 设一个紧凑的下限，内容更多时由滚动条接管（直到 MAX）。
_CONDITION_EXPR_TREE_SCROLL_MIN_HEIGHT = 180
_CONDITION_EXPR_TREE_SCROLL_MAX_HEIGHT = 2400


def _is_flag_atom(d: dict[str, Any]) -> bool:
    if "flag" not in d:
        return False
    return set(d.keys()) <= {"flag", "op", "value"}


# 组合子左侧色条：嵌套一深，光靠 8px 缩进根本分不清"这条属于哪个 any"。
# 颜色取 theme 的语义色（不在这里写死色值），all/any/not 三种一眼可辨。
_GROUP_RAIL_KIND = {"all": "info", "any": "warn", "not": "error"}


def _group_rail_frame(kind: str) -> QFrame:
    frame = QFrame()
    frame.setObjectName("conditionGroupRail")
    color = _theme.semantic_text_color(_GROUP_RAIL_KIND.get(kind, "muted"))
    frame.setStyleSheet(
        f"QFrame#conditionGroupRail {{ border: none; border-left: 2px solid {color}; }}"
    )
    return frame


class ConditionExprNodeEditor(QWidget):
    """单节点：可表示组合子或叶子。"""

    changed = Signal()

    def __init__(
        self,
        depth: int,
        model_getter: Callable[[], Any],
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._depth = depth
        self._model_getter = model_getter
        self._child_editors: list[ConditionExprNodeEditor] = []
        self._not_child: ConditionExprNodeEditor | None = None
        # 程序性载入期间抑制 changed（契约：set_dict 是程序性 set，不得外发编辑信号误标脏）。
        self._loading = False
        # 当前生效的节点类型（用于换类型时按"旧类型 + 旧控件"判断子树是否非空，据此弹确认）。
        self._active_kind = "flag"

        # 纵向不吃多余高度：宿主给多了就留在底下，别摊成节点之间一截截空白。
        self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Maximum)
        root = QVBoxLayout(self)
        root.setContentsMargins(0, 2, 0, 2)
        # 折叠态：body 整块藏起，头行在类型后面给一行摘要（「(A 且 非 B) 或 …」）。
        # 条件一复杂，展开态每个叶子占三行，十几个节点就把宿主顶爆——折叠是唯一不丢信息的收法。
        self._collapsed = False

        head = QHBoxLayout()
        head.setSpacing(4)
        self._fold_btn = QToolButton(self)
        self._fold_btn.setAutoRaise(True)
        self._fold_btn.setArrowType(Qt.ArrowType.DownArrow)
        self._fold_btn.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        self._fold_btn.setToolTip("折叠 / 展开此条件节点（Ctrl+点击：连同全部子节点一起）")
        self._fold_btn.clicked.connect(self._on_fold_clicked)
        head.addWidget(self._fold_btn, 0)
        self._kind = QComboBox()
        for lab, val in (
            ("全部满足 (all)", "all"),
            ("任一满足 (any)", "any"),
            ("否定 (not)", "not"),
            ("Flag 条件", "flag"),
            ("任务状态", "quest"),
            ("Scenario 阶段", "scenario"),
            ("Scenario 线（生命周期）", "scenarioLine"),
            ("叙事状态", "narrative"),
            ("活计计数 (做过几单)", "narrativeCount"),
            ("激活位面", "plane"),
            ("玩家姿态", "posture"),
            ("时段（日夜）", "timePhase"),
            ("手持挂件（火把燃着没有 / 火势 / 燃料 / 效果块）", "heldProp"),
            ("挂件等级（火把升到第几级）", "propLevel"),
            ("可燃物燃烧状态（没点 / 在烧 / 灭了 / 烧完）", "burn"),
        ):
            self._kind.addItem(lab, val)
        self._kind.currentIndexChanged.connect(self._on_kind_changed)
        self._kind_label = QLabel("类型", self)
        head.addWidget(self._kind_label, 0)
        head.addWidget(self._kind, 1)
        # 摘要只在折叠态出现；Ignored 横向策略 = 不往外要宽度（窄面板里自己截断）。
        self._summary = QLabel(self)
        self._summary.setSizePolicy(QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred)
        self._summary.setStyleSheet(_theme.semantic_text_css("muted"))
        self._summary.setTextInteractionFlags(Qt.TextInteractionFlag.NoTextInteraction)
        self._summary.setVisible(False)
        head.addWidget(self._summary, 2)
        if depth > 0:
            # 文案只留「移除」：这颗按钮在每层嵌套里都出现一次，写全称会把
            # 每一行的最小宽顶高，宿主面板（280px）里就横向滚动了。
            self._btn_remove = QPushButton("移除")
            self._btn_remove.setToolTip("移除此条件节点")
            self._btn_remove.clicked.connect(lambda: self._request_remove())
            head.addWidget(self._btn_remove)
        root.addLayout(head)
        self._head = head
        self._root_layout = root

        self._body_host = QWidget(self)
        self._body = QVBoxLayout(self._body_host)
        self._body.setContentsMargins(0, 0, 0, 0)
        root.addWidget(self._body_host)
        # 单行叶子（flag / 位面 / 姿态 / 时段）在宽度够时并进头行：一个叶子一行。
        # 窄宿主（图对话检查器 280px）自动退回上下排。带回滞，拖窗口边不会来回跳。
        self._inline = False
        self.changed.connect(self._refresh_summary_if_collapsed)

        self._container_all_any: QWidget | None = None
        self._lay_all_any: QVBoxLayout | None = None
        self._flag_wrap: QWidget | None = None
        self._quest_wrap: QWidget | None = None
        self._sc_wrap: QWidget | None = None
        self._sl_wrap: QWidget | None = None
        self._not_wrap: QWidget | None = None
        self._not_empty_hint: QLabel | None = None

        self._flag_field: FlagKeyPickField | None = None
        self._flag_op: QComboBox | None = None
        self._flag_val_mode: QComboBox | None = None
        self._flag_val_reg: FlagValueEdit | None = None
        self._flag_free_value: QWidget | None = None
        self._q_id: QLineEdit | None = None
        self._q_st: QComboBox | None = None
        self._sc_id: ReferencePickerField | None = None
        self._sc_ph: QComboBox | None = None
        self._sc_st: QComboBox | None = None
        self._sc_out: QLineEdit | None = None
        self._sl_id: ReferencePickerField | None = None
        self._sl_st: QComboBox | None = None
        self._nv_wrap: QWidget | None = None
        self._nv_graph: ReferencePickerField | None = None
        self._nv_state: ReferencePickerField | None = None
        self._nv_reached: QCheckBox | None = None
        self._nc_wrap: QWidget | None = None
        self._nc_graph: ReferencePickerField | None = None
        self._nc_exit: ReferencePickerField | None = None
        self._nc_op: QComboBox | None = None
        self._nc_value: QSpinBox | None = None
        self._pl_wrap: QWidget | None = None
        self._po_wrap: QWidget | None = None
        self._po_kind: QComboBox | None = None
        self._tp_wrap: QWidget | None = None
        self._tp_kind: QComboBox | None = None
        self._pl_id: IdRefSelector | None = None
        self._hp_wrap: QWidget | None = None
        self._hp_who: ReferencePickerField | None = None
        self._hp_socket: QWidget | None = None  # FilterableTypeCombo（懒导入，action_editor 很重）
        self._hp_prop: ReferencePickerField | None = None
        self._hp_state: QComboBox | None = None
        self._hp_burning: QComboBox | None = None
        self._hp_op: QComboBox | None = None
        self._hp_vitality: QDoubleSpinBox | None = None
        self._hp_fuel_op: QComboBox | None = None
        self._hp_fuel: QDoubleSpinBox | None = None
        self._hp_effect: ReferencePickerField | None = None
        self._hp_lock: QComboBox | None = None
        # heldProp 载入快照：{键: 磁盘原值}（没有的键不在里面）+ 各控件载入后的样子
        self._hp_raw: dict[str, Any] = {}
        self._hp_seed: dict[str, Any] = {}
        self._lv_wrap: QWidget | None = None
        self._lv_prop: ReferencePickerField | None = None
        self._lv_op: QComboBox | None = None
        self._lv_value: QSpinBox | None = None
        # propLevel 载入快照：磁盘原值 + 各控件载入后的样子（逐字段"没动过回吐原值"）
        self._lv_raw: dict[str, Any] = {}
        self._lv_seed: dict[str, Any] = {}
        self._bn_wrap: QWidget | None = None
        self._bn_target: ReferencePickerField | None = None
        self._bn_socket: QWidget | None = None  # FilterableTypeCombo（懒导入，action_editor 很重）
        self._bn_scene: ReferencePickerField | None = None
        self._bn_state: QComboBox | None = None
        # burn 载入快照：磁盘原值（改动时按原键序重写、不认识的键透传）
        self._bn_raw: dict[str, Any] = {}

        self._remove_callback: Callable[[ConditionExprNodeEditor], None] | None = None

        self._kind.blockSignals(True)
        self._kind.setCurrentIndex(3)
        self._kind.blockSignals(False)
        self._rebuild_body("flag")

    def _emit_changed(self) -> None:
        """统一出口：程序性载入（set_dict）期间不外发 changed，避免误标工程脏。"""
        if not self._loading:
            self.changed.emit()

    def _refresh_not_empty_hint(self) -> None:
        """not 节点：内层未配置时亮红字（恒假警告），配置后隐藏。"""
        hint = self._not_empty_hint
        if hint is None:
            return
        empty = not (self._not_child and self._not_child._has_content())
        hint.setVisible(empty)

    def set_remove_callback(self, cb: Callable[[ConditionExprNodeEditor], None]) -> None:
        self._remove_callback = cb

    def _request_remove(self) -> None:
        if self._remove_callback:
            self._remove_callback(self)

    # ---- 折叠 ----------------------------------------------------------------

    def _child_nodes(self) -> list["ConditionExprNodeEditor"]:
        out = list(self._child_editors)
        if self._not_child is not None:
            out.append(self._not_child)
        return out

    def _on_fold_clicked(self) -> None:
        from PySide6.QtWidgets import QApplication

        want = not self._collapsed
        if QApplication.keyboardModifiers() & Qt.KeyboardModifier.ControlModifier:
            self.set_collapsed_recursive(want)
        else:
            self.set_collapsed(want)

    def is_collapsed(self) -> bool:
        return self._collapsed

    def set_collapsed(self, on: bool) -> None:
        on = bool(on)
        self._collapsed = on
        self._body_host.setVisible(not on)
        self._fold_btn.setArrowType(Qt.ArrowType.RightArrow if on else Qt.ArrowType.DownArrow)
        self._summary.setVisible(on)
        if on:
            self._refresh_summary()
        self._refresh_ancestor_geometry()

    def _refresh_ancestor_geometry(self) -> None:
        # 按模式切显隐 / 挪布局 / 增删子节点后自内向外刷新几何，否则外层行高冻在旧 sizeHint
        # （要么整行压成一条缝，要么多出来的高度被摊成一大截空白）。
        # body 是独立的宿主控件：父布局按控件项缓存它的 sizeHint，不显式 updateGeometry 就一直是旧值
        # （控件没显示过时连 LayoutRequest 都不投递，缓存永远不刷——条件树高度因此冻在一行）。
        self._body.invalidate()
        self._body_host.updateGeometry()
        w: QWidget | None = self
        while w is not None:
            lay = w.layout()
            if lay is not None:
                lay.invalidate()
            w.updateGeometry()
            if isinstance(w, ConditionExprTreeRootWidget):
                w._sync_height_to_content()
                if w._scroll is not None:
                    break  # 自带滚动区：高度变化到此为止；无滚动区模式要一路刷到宿主
            w = w.parentWidget()

    def set_collapsed_recursive(self, on: bool) -> None:
        for child in self._child_nodes():
            child.set_collapsed_recursive(on)
        self.set_collapsed(on)

    def collapse_below_depth(self, depth: int) -> None:
        """深度 ≥ depth 的组合子折起、其余展开（叶子一律展开）：给「只看骨架」用。"""
        for child in self._child_nodes():
            child.collapse_below_depth(depth)
        is_group = self._active_kind in ("all", "any", "not")
        self.set_collapsed(is_group and self._depth >= depth)

    # ---- 单行叶子并进头行 -------------------------------------------------------

    _INLINE_KINDS = ("flag", "plane", "posture", "timePhase")
    # 并排后给主输入（flag 键 / id 选择器）至少留这么宽，否则宁可上下排。
    _INLINE_FIELD_ROOM = 110
    _INLINE_HYSTERESIS = 40
    _INLINE_KIND_MAX_W = 120

    def _available_width(self) -> int:
        w = self.parentWidget()
        while w is not None:
            if isinstance(w, QScrollArea):
                vp = w.viewport()
                try:
                    x = self.mapTo(vp, self.rect().topLeft()).x()
                except Exception:
                    x = 0
                return vp.width() - max(0, x)
            w = w.parentWidget()
        return self.width()

    def _schedule_inline_check(self) -> None:
        """并排与否由整棵树的根统一决定（同一棵树里一半并排一半上下排，读起来更乱）。"""
        w = self.parentWidget()
        while w is not None:
            if isinstance(w, ConditionExprTreeRootWidget):
                w.schedule_inline_policy()
                return
            w = w.parentWidget()

    def _inline_need_width(self) -> int:
        """并排所需宽度：头行固定件 + 叶子各控件的建议宽 + 给主输入的余量。按内容算，不写死阈值。"""
        need = self._fold_btn.sizeHint().width() + self._INLINE_KIND_MAX_W + 24
        rb = getattr(self, "_btn_remove", None)
        if rb is not None:
            need += rb.sizeHint().width()
        item = self._body.itemAt(0) if self._body.count() else None
        leaf = item.widget() if item is not None else None
        if leaf is not None:
            # 叶子控件的最小宽 + 给主输入（flag 键 / id）额外留出的阅读宽度。
            need += leaf.minimumSizeHint().width() + self._INLINE_FIELD_ROOM
        return need

    def inline_fits(self, currently_inline: bool) -> bool:
        slack = self._INLINE_HYSTERESIS if currently_inline else 0
        return self._available_width() >= self._inline_need_width() - slack

    def is_inline(self) -> bool:
        return self._inline

    def set_inline(self, on: bool) -> None:
        on = bool(on) and self._active_kind in self._INLINE_KINDS
        if on == self._inline:
            return
        self._inline = on
        if on:
            self._root_layout.removeWidget(self._body_host)
            idx = self._head.indexOf(self._summary) + 1
            self._head.insertWidget(idx, self._body_host, 4)
            self._kind.setMaximumWidth(self._INLINE_KIND_MAX_W)
            self._head.setStretchFactor(self._kind, 0)
        else:
            self._head.removeWidget(self._body_host)
            self._root_layout.addWidget(self._body_host)
            self._kind.setMaximumWidth(16777215)
            self._head.setStretchFactor(self._kind, 1)
        self._kind_label.setVisible(not on)
        self._body_host.setVisible(not self._collapsed)
        self._refresh_ancestor_geometry()

    def _refresh_summary(self) -> None:
        text = summarize_condition(self.to_dict())
        self._summary.setText(text)
        self._summary.setToolTip(text)

    def _refresh_summary_if_collapsed(self) -> None:
        if self._collapsed:
            self._refresh_summary()

    def _model(self) -> Any:
        return self._model_getter()

    def _has_content(self, kind: str | None = None) -> bool:
        """当前节点子树是否已配置（用现存控件按 kind 判断）；换类型/删节点确认据此。"""
        k = kind if kind is not None else self._active_kind

        def _combo_has(cb: QComboBox | None) -> bool:
            if cb is None:
                return False
            d = cb.currentData()
            return isinstance(d, str) and bool(d.strip())

        def _picker_has(field: ReferencePickerField | None) -> bool:
            return bool(field and field.current_value().strip())

        if k in ("all", "any"):
            return any(c._has_content() for c in self._child_editors)
        if k == "not":
            return bool(self._not_child and self._not_child._has_content())
        if k == "flag":
            return bool(self._flag_field and self._flag_field.key().strip())
        if k == "quest":
            return bool(self._q_id and self._q_id.current_id().strip())
        if k == "scenario":
            return _picker_has(self._sc_id)
        if k == "scenarioLine":
            return _picker_has(self._sl_id)
        if k == "narrative":
            return _picker_has(self._nv_graph)
        if k == "narrativeCount":
            return _picker_has(self._nc_graph)
        if k == "plane":
            return bool(self._pl_id and self._pl_id.current_id().strip())
        if k == "posture":
            return bool(self._po_kind and str(self._po_kind.currentData() or "").strip())
        if k == "timePhase":
            return bool(self._tp_kind and str(self._tp_kind.currentData() or "").strip())
        if k == "heldProp":
            return _picker_has(self._hp_who)
        if k == "propLevel":
            return _picker_has(self._lv_prop)
        if k == "burn":
            return _picker_has(self._bn_target)
        return False

    def _confirm_destructive_discard(self, action_label: str) -> bool:
        """子树非空时的破坏性操作确认；默认 No（不执行）。测试可 monkeypatch。"""
        if not self._has_content():
            return True
        ret = QMessageBox.question(
            self,
            action_label,
            f"{action_label}将丢弃此节点下已配置的条件（不可撤销）。确定？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        return ret == QMessageBox.StandardButton.Yes

    def _on_kind_changed(self) -> None:
        k = self._kind.currentData()
        if not isinstance(k, str):
            return
        prev = self._active_kind
        if prev and k != prev and self._has_content(prev):
            if not self._confirm_destructive_discard("切换条件类型"):
                # 用户放弃：还原下拉到原类型，保留原控件与配置
                idx = self._kind.findData(prev)
                if idx >= 0:
                    self._kind.blockSignals(True)
                    self._kind.setCurrentIndex(idx)
                    self._kind.blockSignals(False)
                return
        self._rebuild_body(k)
        self._emit_changed()

    def _clear_body(self) -> None:
        # 必须走 discard_layout_widgets：直接 setParent(None) 会把**当前可见**的条件体
        # 变成一个野顶层窗口，在 deleteLater 落地之前被 Qt 显示出来（屏幕中央一闪一个
        # 「GameDraft Editor」小窗）。见 shared/widget_discard.py 模块文档。
        discard_layout_widgets(self._body)
        self._container_all_any = None
        self._lay_all_any = None
        self._flag_wrap = None
        self._quest_wrap = None
        self._sc_wrap = None
        self._sl_wrap = None
        self._not_wrap = None
        self._not_empty_hint = None
        self._child_editors.clear()
        self._not_child = None
        self._flag_field = None
        self._flag_op = None
        self._flag_val_mode = None
        self._flag_val_reg = None
        self._flag_free_value = None
        self._q_id = None
        self._q_st = None
        self._sc_id = None
        self._sc_ph = None
        self._sc_st = None
        self._sc_out = None
        self._sl_id = None
        self._sl_st = None
        self._nv_wrap = None
        self._nv_graph = None
        self._nv_state = None
        self._nv_reached = None
        self._nc_wrap = None
        self._nc_graph = None
        self._nc_exit = None
        self._nc_op = None
        self._nc_value = None
        self._pl_wrap = None
        self._po_wrap = None
        self._po_kind = None
        self._tp_wrap = None
        self._tp_kind = None
        self._pl_id = None
        self._hp_wrap = None
        self._hp_who = None
        self._hp_socket = None
        self._hp_prop = None
        self._hp_state = None
        self._hp_burning = None
        self._hp_op = None
        self._hp_vitality = None
        self._hp_fuel_op = None
        self._hp_fuel = None
        self._hp_effect = None
        self._hp_lock = None
        self._hp_raw = {}
        self._hp_seed = {}
        self._lv_wrap = None
        self._lv_prop = None
        self._lv_op = None
        self._lv_value = None
        self._lv_raw = {}
        self._lv_seed = {}
        self._bn_wrap = None
        self._bn_target = None
        self._bn_socket = None
        self._bn_scene = None
        self._bn_state = None
        self._bn_raw = {}

    def _rebuild_body(self, kind: str) -> None:
        self._rebuild_body_impl(kind)
        self._refresh_ancestor_geometry()

    def _rebuild_body_impl(self, kind: str) -> None:
        self._active_kind = kind
        self._clear_body()
        if self._inline and kind not in self._INLINE_KINDS:
            self.set_inline(False)  # 组合子的子树绝不能进头行
        self._schedule_inline_check()
        if kind in ("all", "any"):
            wrap = _group_rail_frame(kind)
            vl = QVBoxLayout(wrap)
            vl.setContentsMargins(10, 2, 0, 2)
            vl.setSpacing(2)
            self._container_all_any = wrap
            self._lay_all_any = vl
            # 按钮放组**末尾**（子条件插在它前面）：加子条件是往后追加，按钮就该在最后一条下面。
            btn = QPushButton("+ 添加子条件")
            btn.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
            if self._depth >= _MAX_DEPTH - 1:
                btn.setEnabled(False)
                btn.setToolTip(f"嵌套深度上限 {_MAX_DEPTH}")
            btn.clicked.connect(self._add_child)
            vl.addWidget(btn)
            self._body.addWidget(wrap)
        elif kind == "not":
            nw = _group_rail_frame("not")
            nl = QVBoxLayout(nw)
            nl.setContentsMargins(10, 2, 0, 2)
            self._not_wrap = nw
            # 裸 not（内层未配置）导出 {"not":{"all":[]}} = 恒假，挂条件上"永远不出现"极难排查：
            # 行内红字提示（validator 侧另由数据组补）。
            self._not_empty_hint = QLabel("not 未配置内层 = 恒为假（该条件永不满足）")
            self._not_empty_hint.setWordWrap(True)
            self._not_empty_hint.setStyleSheet(_theme.semantic_text_css("error"))
            nl.addWidget(self._not_empty_hint)
            if self._depth >= _MAX_DEPTH - 1:
                tip = QLabel(f"嵌套已达上限（{_MAX_DEPTH}），无法添加 not 子节点")
                tip.setWordWrap(True)
                nl.addWidget(tip)
            else:
                ch = ConditionExprNodeEditor(self._depth + 1, self._model_getter, nw)
                ch.set_remove_callback(None)
                ch.changed.connect(self._emit_changed)
                ch.changed.connect(self._refresh_not_empty_hint)
                self._not_child = ch
                nl.addWidget(ch)
            self._body.addWidget(nw)
            self._refresh_not_empty_hint()
        elif kind == "flag":
            fw = QWidget()
            main = QVBoxLayout(fw)
            main.setContentsMargins(0, 0, 0, 0)
            row1 = QHBoxLayout()
            row1.setContentsMargins(0, 0, 0, 0)
            m = self._model()
            reg = m.flag_registry if m else {}
            self._flag_field = FlagKeyPickField(m, None, "", fw)
            self._flag_field.setMinimumWidth(100)
            self._flag_field.valueChanged.connect(self._on_flag_field_value_changed)
            self._flag_op = QComboBox()
            self._flag_op.addItems(["==", "!=", ">", "<", ">=", "<="])
            self._flag_op.currentTextChanged.connect(lambda _t: self._emit_changed())
            self._flag_val_mode = QComboBox()
            self._flag_val_mode.addItem("按登记表", "registry")
            self._flag_val_mode.addItem("文本/引用", "string_ref")
            self._flag_val_mode.currentIndexChanged.connect(self._on_flag_val_mode_changed)
            self._flag_val_mode.setToolTip("值的写法：按 flag 登记表的类型给控件，或写字符串 / [tag:…] 引用")
            # 一行排完（key · 运算符 · 值 · 值写法）：旧形态把一个 true 单独放一整行还居中，
            # 每个叶子白白多占一行高，四组 all+not 的条件因此多出一屏。
            row1.addWidget(self._flag_field, stretch=2)
            row1.addWidget(self._flag_op)
            main.addLayout(row1)
            self._flag_val_reg = FlagValueEdit(fw, reg)
            self._flag_val_reg.valueChanged.connect(self._emit_changed)
            pm = self._model()
            if pm is not None:
                free = RichTextLineEdit(pm, fw)
                free.setPlaceholderText(
                    "与 Flag 比较：true/数字，或 [tag:…]（运行时 resolve 后再比较）",
                )
                free.textChanged.connect(lambda _s: self._emit_changed())
                self._flag_free_value = free
            else:
                fe = QLineEdit(fw)
                fe.setPlaceholderText("纯文本；载入工程后可插入 [tag:…]")
                fe.textChanged.connect(lambda _s: self._emit_changed())
                self._flag_free_value = fe
            row1.addWidget(self._flag_val_reg, stretch=0)
            row1.addWidget(self._flag_free_value, stretch=1)
            row1.addWidget(self._flag_val_mode)
            self._flag_wrap = fw
            self._body.addWidget(fw)
            if self._flag_val_reg and self._flag_field:
                self._flag_val_reg.set_flag_key(self._flag_field.key())
            self._sync_flag_value_widgets_visibility()
        elif kind == "quest":
            qw = QWidget()
            qf = compact_form(QFormLayout(qw))
            self._q_id = IdRefSelector(allow_empty=True, editable=False, click_opens_popup=True)
            _qm = self._model()
            # 候选排除 repeatable（无状态机，quest 叶指向它=校验 error）
            if _qm is not None and hasattr(_qm, "quest_status_target_ids"):
                self._q_id.set_items(list(_qm.quest_status_target_ids()))
            elif _qm is not None and hasattr(_qm, "all_quest_ids"):
                self._q_id.set_items(list(_qm.all_quest_ids()))
            self._q_id.value_changed.connect(lambda *_: self._emit_changed())
            self._q_st = QComboBox()
            for qs in _QUEST_STATUSES:
                self._q_st.addItem(qs, qs)
            self._q_st.currentIndexChanged.connect(lambda _i: self._emit_changed())
            qf.addRow("quest", self._q_id)
            qf.addRow("questStatus", self._q_st)
            self._quest_wrap = qw
            self._body.addWidget(qw)
        elif kind == "scenario":
            sw = QWidget()
            sf = compact_form(QFormLayout(sw))
            self._sc_id = ReferencePickerField(
                lambda: self._scenario_reference_rows(),
                sw,
                allow_empty=True,
                title="选择 Scenario",
                geometry_key="condition_scenario_picker",
            )
            self._sc_id.value_changed.connect(self._on_scenario_reference_changed)
            self._sc_ph = QComboBox()
            self._sc_ph.setEditable(False)
            self._sc_ph.currentIndexChanged.connect(lambda _i: self._emit_changed())
            self._sc_st = QComboBox()
            for s in _SCENARIO_STATUSES:
                self._sc_st.addItem(s, s)
            self._sc_st.currentIndexChanged.connect(lambda _i: self._emit_changed())
            self._sc_out = QLineEdit()
            self._sc_out.setPlaceholderText("可选 outcome（JSON 或字面量）")
            self._sc_out.textChanged.connect(lambda: self._emit_changed())
            sf.addRow("scenario", self._sc_id)
            sf.addRow("phase", self._sc_ph)
            sf.addRow("status", self._sc_st)
            sf.addRow("outcome（可选）", self._sc_out)
            self._sc_wrap = sw
            self._body.addWidget(sw)
            self._fill_scenario_combos()
        elif kind == "scenarioLine":
            lw = QWidget()
            lf = compact_form(QFormLayout(lw))
            self._sl_id = ReferencePickerField(
                lambda: self._scenario_reference_rows(),
                lw,
                allow_empty=True,
                title="选择 Scenario 线",
                geometry_key="condition_scenario_line_picker",
            )
            self._sl_id.value_changed.connect(lambda _value: self._emit_changed())
            self._sl_st = QComboBox()
            for s in _SCENARIO_LINE_STATUSES:
                self._sl_st.addItem(s, s)
            self._sl_st.currentIndexChanged.connect(lambda _i: self._emit_changed())
            lf.addRow("scenarioLine", self._sl_id)
            lf.addRow("lineStatus", self._sl_st)
            self._sl_wrap = lw
            self._body.addWidget(lw)
            self._fill_scenario_line_combo()
        elif kind == "narrative":
            nw = QWidget()
            nf = compact_form(QFormLayout(nw))
            self._nv_graph = ReferencePickerField(
                lambda: self._narrative_graph_reference_rows(),
                nw,
                allow_empty=True,
                title="选择叙事图",
                geometry_key="condition_narrative_graph_picker",
            )
            self._nv_graph.value_changed.connect(self._on_narrative_graph_reference_changed)
            self._nv_state = ReferencePickerField(
                lambda: self._narrative_state_reference_rows(),
                nw,
                allow_empty=True,
                title="选择叙事状态",
                geometry_key="condition_narrative_state_picker",
            )
            self._nv_state.value_changed.connect(lambda _value: self._emit_changed())
            self._nv_reached = QCheckBox("曾到达过（含当前；用于「X 之后」类门控）")
            self._nv_reached.stateChanged.connect(lambda _s: self._emit_changed())
            nf.addRow("叙事图", self._nv_graph)
            nf.addRow("状态", self._nv_state)
            nf.addRow("", self._nv_reached)
            self._nv_wrap = nw
            self._body.addWidget(nw)
            self._fill_narrative_combos()
        elif kind == "narrativeCount":
            cw = QWidget()
            cf = compact_form(QFormLayout(cw))
            self._nc_graph = ReferencePickerField(
                lambda: self._narrative_graph_reference_rows(run_only=True),
                cw,
                allow_empty=True,
                title="选择活计图",
                geometry_key="condition_narrative_count_graph_picker",
            )
            self._nc_graph.setToolTip(
                "活计图（声明了 run 的叙事图）。计数=该活计历史累计结算次数，跨轮持久、入存档。"
            )
            self._nc_graph.value_changed.connect(self._on_narrative_count_graph_reference_changed)
            self._nc_exit = ReferencePickerField(
                lambda: self._narrative_count_exit_reference_rows(),
                cw,
                allow_empty=True,
                title="选择活计出口",
                geometry_key="condition_narrative_count_exit_picker",
            )
            self._nc_exit.setToolTip("按哪个出口计数；「全部出口合计」= 不区分交付/失败等出口")
            self._nc_exit.value_changed.connect(lambda _value: self._emit_changed())
            self._nc_op = QComboBox()
            for _op in (">=", "==", "!=", ">", "<", "<="):
                self._nc_op.addItem(_op, _op)
            self._nc_op.currentIndexChanged.connect(lambda _i: self._emit_changed())
            self._nc_value = QSpinBox()
            self._nc_value.setRange(0, 9999)
            self._nc_value.setValue(1)
            self._nc_value.valueChanged.connect(lambda _v: self._emit_changed())
            cf.addRow("活计图", self._nc_graph)
            cf.addRow("出口", self._nc_exit)
            row = QHBoxLayout()
            row.addWidget(self._nc_op, 0)
            row.addWidget(self._nc_value, 0)
            row.addStretch(1)
            cf.addRow("结算次数", row)
            self._nc_wrap = cw
            self._body.addWidget(cw)
            self._fill_narrative_count_combos()
        elif kind == "plane":
            pw = QWidget()
            pf = compact_form(QFormLayout(pw))
            self._pl_id = IdRefSelector(allow_empty=True, editable=False, click_opens_popup=True)
            self._pl_id.setToolTip(
                "当前激活位面 === 该 id（含 activatePlane 手动覆盖压过叙事点名后的结果）。"
                "「非 normal」写法：否定(not) + 本叶子选 normal。列表来自 planes.json。",
            )
            _pm = self._model()
            if _pm is not None and hasattr(_pm, "all_plane_ids"):
                self._pl_id.set_items(list(_pm.all_plane_ids()))
            self._pl_id.value_changed.connect(lambda *_: self._emit_changed())
            pf.addRow("plane", self._pl_id)
            self._pl_wrap = pw
            self._body.addWidget(pw)
        elif kind == "posture":
            ow = QWidget()
            of = compact_form(QFormLayout(ow))
            self._po_kind = QComboBox()
            self._po_kind.setMaximumWidth(220)
            for _lab, _val in (("蹲下 (crouch)", "crouch"), ("驻足注视 (gaze)", "gaze"), ("躺 (lie)", "lie")):
                self._po_kind.addItem(_lab, _val)
            self._po_kind.setToolTip(
                "玩家此刻的身体姿态 === 该值。姿态是瞬时表现态（不入存档）。\n"
                "挂在实体 conditions 上＝「蹲下才翻得动」（条件默认只锁交互不隐藏）；\n"
                "「站着」写法：否定(not) + 本叶子任选一个姿态。",
            )
            self._po_kind.currentIndexChanged.connect(lambda *_: self._emit_changed())
            of.addRow("posture", self._po_kind)
            self._po_wrap = ow
            self._body.addWidget(ow)
        elif kind == "timePhase":
            tw = QWidget()
            tf = compact_form(QFormLayout(tw))
            self._tp_kind = QComboBox()
            self._tp_kind.setMaximumWidth(220)
            _tm = self._model()
            _phases: list[tuple[str, str]] = []
            if _tm is not None and hasattr(_tm, "all_time_phase_ids"):
                _phases = list(_tm.all_time_phase_ids())
            for _pid, _plabel in _phases:
                self._tp_kind.addItem(_plabel, _pid)
            self._tp_kind.setToolTip(
                "此刻的时段 === 该值。时段由时刻派生（不是独立状态、不入 Flag）。\n"
                "列表来自 game_config.dayNight.phases。\n"
                "「白天」写法：否定(not) + 本叶子选夜晚那一档。",
            )
            self._tp_kind.currentIndexChanged.connect(lambda *_: self._emit_changed())
            tf.addRow("timePhase", self._tp_kind)
            self._tp_wrap = tw
            self._body.addWidget(tw)
        elif kind == "heldProp":
            self._build_held_prop_body()
        elif kind == "propLevel":
            self._build_prop_level_body()
        elif kind == "burn":
            self._build_burn_body()

    # ---- propLevel（挂件等级叶） ------------------------------------------------
    #
    # 形状以 src/data/types.ts `PropLevelConditionLeaf` 为准：`propLevel`（挂件预设 id）与 `value` 必填，
    # `op` 不写 = `>=`。问的是**这根挂件升到第几级**，与拿没拿在手上无关（收在包里也算）。
    # 候选与校验器同一对 ProjectModel 函数（候选面 = 校验面）：只列配了 `levels` 的预设，
    # 级数上限跟着选中的那个预设走。往返：逐字段"没动过 ⇒ 回吐磁盘原值"，不认识的键透传、键序按磁盘原序。

    def _build_prop_level_body(self) -> None:
        lw = QWidget()
        lw.setToolTip(
            "这根挂件（火把）升到第几级（读存档里的等级，不是 flag）。第 1 级 = 出厂的样子。\n"
            "与拿没拿在手上无关——收在背包里也算；物品描述按等级变、升级对话的前置都写这一条。\n"
            "没有等级表的挂件运行时恒第 1 级（校验器会提醒这条恒真 / 恒假）。",
        )
        lf = compact_form(QFormLayout(lw))
        self._lv_prop = ReferencePickerField(
            lambda: self._prop_level_rows(),
            lw,
            allow_empty=True,
            title="选择挂件预设（只列配了等级表的）",
            geometry_key="condition_prop_level_prop_picker",
        )
        self._lv_prop.setToolTip(
            "哪根挂件（prop_presets.json 里配了「等级」块的那些）。\n"
            "没配等级表的不在候选里——它运行时恒第 1 级，问它没有意义。",
        )
        self._lv_prop.value_changed.connect(self._on_lv_prop_changed)
        self._lv_op = QComboBox(lw)
        self._lv_op.setMaximumWidth(150)
        self._lv_op.setToolTip("怎么比。不写 = >=（「升到第 2 级或更高」是最常见的写法）。")
        self._lv_op.currentIndexChanged.connect(lambda _i: self._emit_changed())
        self._lv_value = QSpinBox(lw)
        self._lv_value.setRange(1, 999)
        self._lv_value.setValue(1)
        self._lv_value.setMaximumWidth(96)
        self._lv_value.setToolTip("第几级（1 起）。上限跟着上面选的挂件走（= 它 levels 的条数）。")
        self._lv_value.valueChanged.connect(lambda _v: self._emit_changed())
        lf.addRow("挂件", self._lv_prop)
        row = QHBoxLayout()
        row.addWidget(self._lv_op, 0)
        row.addWidget(self._lv_value, 0)
        row.addStretch(1)
        lf.addRow("等级", row)
        self._lv_wrap = lw
        self._body.addWidget(lw)
        self._lv_raw = {}
        self._lv_load_controls({})
        self._lv_seed = self._lv_snapshot()

    def _prop_level_rows(self) -> list[tuple[str, str, str]]:
        m = self._model()
        fn = getattr(m, "prop_preset_ids_with_levels", None) if m is not None else None
        if not callable(fn):
            return []
        try:
            return [(str(pid), str(label), "挂件预设") for pid, label in fn()]
        except Exception:  # noqa: BLE001 — 候选是锦上添花，不许把表单打挂
            return []

    def _lv_sync_max(self) -> None:
        """级数上限跟着选中的挂件走。**当前值不被夹掉**：磁盘上写着第 3 级、预设后来砍成 2 级时，
        夹成 2 就是静默改数据（校验器本该报的那条也跟着消失）。"""
        if self._lv_value is None or self._lv_prop is None:
            return
        m = self._model()
        fn = getattr(m, "prop_level_counts", None) if m is not None else None
        counts = fn() if callable(fn) else {}
        n = int(counts.get(self._lv_prop.current_value().strip(), 0) or 0)
        cur = int(self._lv_value.value())
        self._lv_value.setMaximum(max(n, cur, 1) if n else max(cur, 999))

    def _on_lv_prop_changed(self, _value: str) -> None:
        self._lv_sync_max()
        self._emit_changed()

    def _lv_load_controls(self, raw: dict[str, Any]) -> None:
        """把一条叶子的磁盘值摆进控件（程序性：不外发、不改数据）。调用方先设好 `_lv_raw`。"""
        if self._lv_prop is None or self._lv_op is None or self._lv_value is None:
            return
        pid = raw.get("propLevel")
        self._lv_prop.set_value(pid.strip() if isinstance(pid, str) else "")
        op = raw.get("op", _HP_ABSENT)
        if op is _HP_ABSENT:
            op_want: Any = _HP_UNSET
        elif isinstance(op, str) and op in _PROP_LEVEL_OPS:
            op_want = op
        else:
            op_want = _HP_RAW
        self._hp_set_combo(
            self._lv_op,
            [(f"（不写 = {_PROP_LEVEL_DEFAULT_OP}）", _HP_UNSET), *((o, o) for o in _PROP_LEVEL_OPS)],
            op_want, op,
        )
        v = raw.get("value")
        self._lv_value.blockSignals(True)
        self._lv_value.setMaximum(999)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and 1 <= int(v) <= 999:
            self._lv_value.setValue(int(v))
        else:
            self._lv_value.setValue(1)
        self._lv_value.blockSignals(False)
        self._lv_sync_max()

    def _lv_snapshot(self) -> dict[str, Any]:
        return {
            "propLevel": self._lv_prop.current_value() if self._lv_prop else "",
            "op": self._lv_op.currentData() if self._lv_op else None,
            "value": self._lv_value.value() if self._lv_value else None,
        }

    def _prop_level_canonical(self) -> dict[str, Any]:
        pid = self._lv_prop.current_value().strip() if self._lv_prop else ""
        if not pid:
            return {}
        raw, seed, snap = self._lv_raw, self._lv_seed, self._lv_snapshot()
        vals: dict[str, Any] = {}
        if snap["propLevel"] == seed.get("propLevel") and "propLevel" in raw:
            vals["propLevel"] = copy.deepcopy(raw["propLevel"])  # 没动过：磁盘原值（含 " x " 这种带空格的）
        else:
            vals["propLevel"] = pid
        op = snap["op"]
        if snap["op"] == seed.get("op"):
            if "op" in raw:
                vals["op"] = copy.deepcopy(raw["op"])
        elif op == _HP_RAW:
            if "op" in raw:
                vals["op"] = copy.deepcopy(raw["op"])
        elif isinstance(op, str) and op:
            vals["op"] = op
        rv = raw.get("value")
        if (snap["value"] == seed.get("value") and isinstance(rv, (int, float))
                and not isinstance(rv, bool)):
            vals["value"] = rv  # 数值没动：回吐磁盘原表示（2 不漂成 2.0）
        else:
            vals["value"] = int(snap["value"])
        out: dict[str, Any] = {}
        for key, value in raw.items():
            if key in vals:
                out[key] = vals[key]
            elif key not in _PROP_LEVEL_KEYS:
                out[key] = copy.deepcopy(value)  # 表单不认识的键透传
        for key in _PROP_LEVEL_KEYS:
            if key in vals and key not in out:
                out[key] = vals[key]
        return out

    # ---- burn（可燃物叶） -----------------------------------------------------
    #
    # 形状以 src/data/types.ts `BurnConditionLeaf` 为准：`burn` + `burnState` 必填；
    # 不写 `burnSocket` = burn 是场景里开了可燃的实体（热点 / NPC / 演出生成留下的对象），`burnScene` 缺省 = 当前场景；
    # 写了 = burn 是拿东西的人（player / NPC），问他这个挂点上的可燃挂件（`burnScene` 不读）。
    # 候选与校验器同一组 ProjectModel 函数（候选面 = 校验面）：`burn_target_ids` / `burn_socket_names` / `burn_scene_ids`。
    # 往返：没编辑过由 to_dict 的原始快照逐字回吐；编辑过按磁盘原键序重写、不认识的键透传。

    def _build_burn_body(self) -> None:
        # 懒导入：action_editor 很重，只有真用到这类叶子才载入；挂点下拉与 heldProp 叶同一个控件
        from .action_editor import FilterableTypeCombo

        bw = QWidget()
        bw.setToolTip(
            "这个可燃物实例此刻烧到哪一步（读世界状态，不是 flag）。状态一变叙事自动迁移会被叫醒重评。\n"
            "不是可燃实例 ⇒ 恒为假。模板在燃烧工作台里做；实体 / 挂件在自己的「可燃」块里选模板。",
        )
        bf = compact_form(QFormLayout(bw))
        self._bn_target = ReferencePickerField(
            lambda: self._burn_target_rows(),
            bw,
            allow_empty=True,
            title="选择可燃实体 / 拿东西的人",
            geometry_key="condition_burn_target_picker",
        )
        self._bn_target.setToolTip(
            "没写挂点：场景里开了可燃的实体（热点 / NPC，或演出生成且留下的对象）；写了场景只列那个场景的。\n"
            "写了挂点：拿着可燃挂件的人（player / NPC）。",
        )
        self._bn_target.value_changed.connect(self._on_bn_target_changed)
        socket = FilterableTypeCombo([(_BURN_SOCKET_EMPTY_LABEL, "")], bw, select_only=False)
        socket.setMaximumWidth(240)
        socket.setToolTip(
            "不写 = 问场景里的可燃实体；写了 = 问上面那个人这个挂点上拿着的可燃挂件（挂件预设开了可燃的那种）。\n"
            "候选来自那个人的动画包 sockets.json（还没选人时列玩家的挂点）；取不到候选时可以手打——挂点名跨动画包通用。",
        )
        socket.typeCommitted.connect(lambda _t: self._on_bn_socket_changed())
        self._bn_socket = socket
        self._bn_scene = ReferencePickerField(
            lambda: self._burn_scene_rows(),
            bw,
            allow_empty=True,
            title="选择场景（不选 = 当前场景）",
            geometry_key="condition_burn_scene_picker",
        )
        self._bn_scene.setToolTip(
            "问哪个场景的可燃实体；不选 = 当前场景（burnScene 不写）。写了挂点时不读。\n"
            "问别的场景（玩家不在那儿）要写它——离开场景后那边的火照样按时间推算。",
        )
        self._bn_scene.value_changed.connect(lambda _v: self._emit_changed())
        self._bn_state = QComboBox(bw)
        self._bn_state.setMaximumWidth(240)
        self._bn_state.setToolTip("没点 / 在烧（含余烬）/ 灭了（熄灭或吹灭，还剩燃料）/ 烧完。")
        self._bn_state.currentIndexChanged.connect(lambda _i: self._emit_changed())
        bf.addRow("可燃物 / 人", self._bn_target)
        bf.addRow("挂点", socket)
        bf.addRow("场景", self._bn_scene)
        bf.addRow("燃烧状态", self._bn_state)
        self._bn_wrap = bw
        self._body.addWidget(bw)
        self._bn_raw = {}
        self._bn_load_controls({})

    def _bn_socket_value(self) -> str:
        return self._bn_socket.committed_type().strip() if self._bn_socket is not None else ""

    def _burn_target_rows(self) -> list[tuple[str, str, str]]:
        m = self._model()
        fn = getattr(m, "burn_target_ids", None) if m is not None else None
        if not callable(fn):
            return []
        socket = self._bn_socket_value()
        scene = self._bn_scene.current_value().strip() if self._bn_scene else ""
        try:
            if socket:
                return [(str(i), str(lab), "拿东西的人") for i, lab in fn(None, socket)]
            if scene:
                return [(str(i), str(lab), scene) for i, lab in fn(scene, "")]
            return [(str(i), str(lab), "可燃实体") for i, lab in fn(None, "")]
        except Exception:  # noqa: BLE001 — 候选是锦上添花，不许把表单打挂
            return []

    def _burn_scene_rows(self) -> list[tuple[str, str, str]]:
        m = self._model()
        fn = getattr(m, "burn_scene_ids", None) if m is not None else None
        if not callable(fn):
            return []
        try:
            return [(str(i), str(lab), "场景") for i, lab in fn()]
        except Exception:  # noqa: BLE001 — 候选是锦上添花，不许把表单打挂
            return []

    def _bn_fill_socket_combo(self, want: str | None = None) -> None:
        cb = self._bn_socket
        if cb is None or self._bn_target is None:
            return
        cur = cb.committed_type().strip() if want is None else want
        rows: list[tuple[str, str]] = [(_BURN_SOCKET_EMPTY_LABEL, "")]
        m = self._model()
        fn = getattr(m, "burn_socket_names", None) if m is not None else None
        if callable(fn):
            try:
                for name, label in fn(None, self._bn_target.current_value()) or []:
                    rows.append((f"{name}  {label}" if label and label != name else str(name), str(name)))
            except Exception:  # noqa: BLE001 — 候选是锦上添花，不许把表单打挂
                pass
        if cur and cur not in {v for _l, v in rows}:
            rows = [(f"（数据）{cur}", cur)] + rows
        cb.set_entries(rows)
        cb.set_committed_type(cur)
        le = cb.lineEdit()
        if le is not None:
            le.setCursorPosition(0)

    def _on_bn_target_changed(self, _value: str) -> None:
        # 换人只刷挂点候选；已选的挂点名保值（名字跨动画包通用）
        self._bn_fill_socket_combo()
        self._emit_changed()

    def _on_bn_socket_changed(self) -> None:
        # 挂点有无决定 burn 的候选是「可燃实体」还是「拿东西的人」：候选是现取的（provider），刷一下显示即可；已选值保值
        if self._bn_target is not None:
            self._bn_target.refresh_display()
        self._emit_changed()

    def _bn_load_controls(self, raw: dict[str, Any]) -> None:
        """把一条叶子的磁盘值摆进控件（程序性：不外发、不改数据）。"""
        if self._bn_target is None or self._bn_scene is None or self._bn_state is None:
            return
        eid = raw.get("burn")
        self._bn_target.set_value(eid.strip() if isinstance(eid, str) else "")
        sk = raw.get("burnSocket")
        self._bn_fill_socket_combo(want=sk.strip() if isinstance(sk, str) else "")
        sc = raw.get("burnScene")
        self._bn_scene.set_value(sc.strip() if isinstance(sc, str) else "")
        st = raw.get("burnState", _HP_ABSENT)
        if st is _HP_ABSENT:
            want: Any = "burnt"
        elif isinstance(st, str):
            want = st.strip()
        else:
            want = _HP_RAW
        self._hp_set_combo(self._bn_state, [(lab, val) for val, lab in _BURN_STATE_ROWS], want, st)

    def _burn_canonical(self) -> dict[str, Any]:
        eid = self._bn_target.current_value().strip() if self._bn_target else ""
        if not eid:
            return {}
        raw = self._bn_raw
        vals: dict[str, Any] = {"burn": eid}
        socket = self._bn_socket_value()
        if socket:
            vals["burnSocket"] = socket
        elif "burnSocket" in raw and not isinstance(raw["burnSocket"], str):
            vals["burnSocket"] = copy.deepcopy(raw["burnSocket"])  # 怪值：控件摆不出，原样留住
        scene = self._bn_scene.current_value().strip() if self._bn_scene else ""
        if scene:
            vals["burnScene"] = scene
        elif "burnScene" in raw and not isinstance(raw["burnScene"], str):
            vals["burnScene"] = copy.deepcopy(raw["burnScene"])
        st = self._bn_state.currentData() if self._bn_state else None
        if st == _HP_RAW:
            if "burnState" in raw:
                vals["burnState"] = copy.deepcopy(raw["burnState"])
        elif isinstance(st, str) and st:
            vals["burnState"] = st
        out: dict[str, Any] = {}
        for key, value in raw.items():
            if key in vals:
                out[key] = vals[key]
            elif key not in _BURN_KEYS:
                out[key] = copy.deepcopy(value)  # 表单不认识的键透传
        for key in _BURN_KEYS:
            if key in vals and key not in out:
                out[key] = vals[key]
        return out

    # ---- heldProp（手持挂件叶） -------------------------------------------------
    #
    # 形状与语义以 src/data/types.ts `HeldPropConditionLeaf` 为准：`heldProp` 必填，其余项不写 = 不限。
    # 往返：每个字段各自「没动过 ⇒ 回吐磁盘原值（含运行时不认的怪值），动过 ⇒ 写新值 / 选不限就删键」，
    # 表单不认识的键原样透传、键序按磁盘原序——编辑其中一项不许顺手改写别的项。

    def _build_held_prop_body(self) -> None:
        # 懒导入：action_editor 很重，只有真用到这类叶子才载入；挂点下拉与状态候选与挂件动作同一套
        from .action_editor import FilterableTypeCombo

        hw = QWidget()
        hw.setToolTip(
            "这个人身上**有一件**挂件同时满足写了的每一项（没写的项不限）；手上什么都没有 ⇒ 假。\n"
            "读的是此刻的世界状态（与姿态 / 时段同一类，不是 flag）。\n"
            "「手上没有燃着的东西」写法：否定(not) + 本叶子「燃着」选燃着。",
        )
        hf = compact_form(QFormLayout(hw))
        self._hp_who = ReferencePickerField(
            lambda: self._held_prop_holder_rows(),
            hw,
            allow_empty=True,
            title="选择拿东西的人",
            geometry_key="condition_held_prop_holder_picker",
        )
        self._hp_who.setToolTip(
            "谁手上：player 或 NPC 实例 id（过场临时演员 / 轨迹生成对象也行）。\n"
            "条件没有场景上下文，候选是全工程的并集；这个人此刻不在场 ⇒ 恒为假。",
        )
        self._hp_who.value_changed.connect(self._on_hp_who_changed)
        socket = FilterableTypeCombo([("（不限挂点）", "")], hw, select_only=False)
        socket.setMaximumWidth(240)
        socket.setToolTip(
            "哪个挂点上的那件；不限 = 身上任何一件。\n"
            "候选来自上面那个人的动画包 sockets.json（在动画编辑器的「挂点」区标）；\n"
            "取不到候选时可以手打——挂点名跨动画包通用。",
        )
        socket.typeCommitted.connect(lambda _t: self._emit_changed())
        self._hp_socket = socket
        self._hp_prop = ReferencePickerField(
            lambda: self._held_prop_preset_rows(),
            hw,
            allow_empty=True,
            title="选择挂件预设",
            geometry_key="condition_held_prop_preset_picker",
        )
        self._hp_prop.setToolTip("哪件挂件预设（prop_presets.json）；不限 = 哪件都算。")
        self._hp_prop.value_changed.connect(self._on_hp_prop_changed)
        self._hp_state = QComboBox(hw)
        self._hp_state.setMaximumWidth(280)
        self._hp_state.setToolTip(
            "挂件此刻的状态名（挂件预设 states 里的键）；不限 = 什么状态都算。\n"
            "选了挂件就只列它的状态；没选列全工程挂件预设出现过的状态名（标签注明哪些预设有它）。",
        )
        self._hp_state.currentIndexChanged.connect(lambda _i: self._emit_changed())
        self._hp_burning = QComboBox(hw)
        self._hp_burning.setMaximumWidth(160)
        self._hp_burning.setToolTip(
            "燃着没有：当前状态有灯（点着 / 护火 / 残炭）= 燃着，灭了 = 没燃。不限 = 不写。",
        )
        self._hp_burning.currentIndexChanged.connect(lambda _i: self._emit_changed())
        self._hp_op = QComboBox(hw)
        self._hp_op.setMaximumWidth(90)
        self._hp_op.setToolTip(
            "火势比较：火势 0..1（风吹灭火那一套；没配风吹灭的挂件恒为 1）。\n"
            "运算符与数值一起写；不限 = 两个都不写。",
        )
        self._hp_op.currentIndexChanged.connect(self._on_hp_op_changed)
        self._hp_vitality = QDoubleSpinBox(hw)
        self._hp_vitality.setRange(0.0, 1.0)
        self._hp_vitality.setSingleStep(0.05)
        self._hp_vitality.setDecimals(3)
        self._hp_vitality.setValue(0.5)
        self._hp_vitality.setMaximumWidth(96)
        self._hp_vitality.setToolTip("火势阈值 0..1（选了运算符才生效）。")
        self._hp_vitality.valueChanged.connect(lambda _v: self._emit_changed())
        self._hp_fuel_op = QComboBox(hw)
        self._hp_fuel_op.setMaximumWidth(90)
        self._hp_fuel_op.setToolTip(
            "燃料比较：还剩几成燃料 0..1（火把养成的耐久；没配耐久的挂件恒为 1 = 烧不完）。\n"
            "运算符与数值一起写；不限 = 两个都不写。",
        )
        self._hp_fuel_op.currentIndexChanged.connect(self._on_hp_fuel_op_changed)
        self._hp_fuel = QDoubleSpinBox(hw)
        self._hp_fuel.setRange(0.0, 1.0)
        self._hp_fuel.setSingleStep(0.05)
        self._hp_fuel.setDecimals(3)
        self._hp_fuel.setValue(0.5)
        self._hp_fuel.setMaximumWidth(96)
        self._hp_fuel.setToolTip("燃料阈值 0..1（选了运算符才生效）。「快烧完了」= < 0.2 这一类。")
        self._hp_fuel.valueChanged.connect(lambda _v: self._emit_changed())
        self._hp_effect = ReferencePickerField(
            lambda: self._held_prop_effect_rows(),
            hw,
            allow_empty=True,
            title="选择效果块 / 标签",
            geometry_key="condition_held_prop_effect_picker",
        )
        self._hp_effect.setToolTip(
            "手上这件带着哪一块效果（prop_effects.json，「挂件效果块」页维护）。\n"
            "写效果块 id，或写它的**标签**（「驱虫」「招东西」）——运行时两样都认，\n"
            "所以「手上拿的是驱虫的火把」不用点名是哪一支。不限 = 不写。",
        )
        self._hp_effect.value_changed.connect(lambda _v: self._emit_changed())
        self._hp_lock = QComboBox(hw)
        self._hp_lock.setMaximumWidth(180)
        self._hp_lock.setToolTip(
            "挂件的锁（lockPropState 设的）：锁定不灭 / 点不燃 / 没上锁。不限 = 不写。",
        )
        self._hp_lock.currentIndexChanged.connect(lambda _i: self._emit_changed())
        hf.addRow("谁手上", self._hp_who)
        hf.addRow("挂点", socket)
        hf.addRow("挂件", self._hp_prop)
        hf.addRow("状态", self._hp_state)
        hf.addRow("燃着", self._hp_burning)
        # 单位写在屏幕上，不许只躺在 tooltip 里：0.2 是两成还是两秒，光看数字分不出
        vrow = QHBoxLayout()
        vrow.addWidget(self._hp_op, 0)
        vrow.addWidget(self._hp_vitality, 0)
        vrow.addWidget(QLabel("（0..1 剩余火势）", hw), 0)
        vrow.addStretch(1)
        hf.addRow("火势", vrow)
        frow = QHBoxLayout()
        frow.addWidget(self._hp_fuel_op, 0)
        frow.addWidget(self._hp_fuel, 0)
        frow.addWidget(QLabel("（0..1 剩余比例）", hw), 0)
        frow.addStretch(1)
        hf.addRow("燃料", frow)
        hf.addRow("效果块", self._hp_effect)
        hf.addRow("锁", self._hp_lock)
        self._hp_wrap = hw
        self._body.addWidget(hw)
        self._hp_raw = {}
        self._hp_load_controls({})
        # 宽度上限得等到候选填完再收：空下拉的 sizeHint 量不出东西。
        # 运算符那两个铉死 90px 时连自己的缺省项「（不限）」都画不下。
        for _cb in (self._hp_burning, self._hp_op, self._hp_fuel_op,
                    self._hp_state, self._hp_lock):
            fit_width_cap(_cb, _cb.maximumWidth())
        self._hp_seed = self._hp_snapshot()

    def _held_prop_holder_rows(self) -> list[tuple[str, str, str]]:
        m = self._model()
        fn = getattr(m, "held_prop_holder_items", None) if m is not None else None
        if callable(fn):
            try:
                return [(str(i), str(lab), str(det)) for i, lab, det in fn()]
            except Exception:  # noqa: BLE001 — 候选是锦上添花，不许把表单打挂
                pass
        return [("player", "玩家", "玩家")]

    def _held_prop_preset_rows(self) -> list[tuple[str, str, str]]:
        m = self._model()
        fn = getattr(m, "all_prop_preset_ids", None) if m is not None else None
        if not callable(fn):
            return []
        return [(str(pid), str(label), "挂件预设") for pid, label in fn()]

    def _held_prop_effect_rows(self) -> list[tuple[str, str, str]]:
        """`effect` 的候选：效果块 id ∪ 它们的标签（运行时 `s.effects` 是这两样的并集）。
        与校验器同一个函数 `ProjectModel.prop_effect_match_items`（候选面 = 校验面）。"""
        m = self._model()
        fn = getattr(m, "prop_effect_match_items", None) if m is not None else None
        if not callable(fn):
            return []
        try:
            return [(str(v), str(lab), str(det)) for v, lab, det in fn()]
        except Exception:  # noqa: BLE001 — 候选是锦上添花，不许把表单打挂
            return []

    @staticmethod
    def _hp_set_combo(cb: QComboBox, rows: list[tuple[str, Any]], want: Any, raw: Any) -> None:
        """重建一个短枚举下拉（程序性，不外发）。悬垂值 / 怪值保值展示，绝不顶替成第一项。"""
        cb.blockSignals(True)
        try:
            cb.clear()
            for label, value in rows:
                cb.addItem(label, value)
            if want == _HP_RAW:
                cb.addItem(f"（数据）{raw!r}", _HP_RAW)
            elif isinstance(want, str) and want and cb.findData(want) < 0:
                cb.addItem(f"（数据）{want}  ⚠ 不在候选里", want)
            idx = cb.findData(want)
            cb.setCurrentIndex(idx if idx >= 0 else 0)
        finally:
            cb.blockSignals(False)

    def _hp_fill_socket_combo(self, want: str | None = None) -> None:
        cb = self._hp_socket
        if cb is None or self._hp_who is None:
            return
        cur = cb.committed_type().strip() if want is None else want
        rows: list[tuple[str, str]] = [("（不限挂点）", "")]
        m = self._model()
        fn = getattr(m, "socket_names_for_holder_any_scene", None) if m is not None else None
        if callable(fn):
            try:
                for name, label in fn(self._hp_who.current_value()) or []:
                    rows.append((f"{name}  {label}" if label and label != name else str(name), str(name)))
            except Exception:  # noqa: BLE001 — 候选是锦上添花，不许把表单打挂
                pass
        if cur and cur not in {v for _l, v in rows}:
            rows = [(f"（数据）{cur}", cur)] + rows
        cb.set_entries(rows)
        cb.set_committed_type(cur)
        # 可编辑下拉设完文本光标停在**末尾**：框一窄就只剩尾巴（「（不限挂点）」显示成
        # 「不限挂点）」，作者读到的是半句话）。程序性赋值一律把光标拨回开头。
        le = cb.lineEdit()
        if le is not None:
            le.setCursorPosition(0)

    def _hp_state_rows(self) -> list[tuple[str, str]]:
        """状态候选 `(展示名, 值)`：选了（存在的）挂件 ⇒ 它的 states；否则全工程状态名并集。与校验器同一口径。"""
        from .action_editor import _prop_state_name_rows, _prop_state_rows_for_prop

        m = self._model()
        pid = self._hp_prop.current_value().strip() if self._hp_prop else ""
        table = getattr(m, "prop_presets", None) if m is not None else None
        if pid and isinstance(table, dict) and isinstance(table.get(pid), dict):
            return _prop_state_rows_for_prop(m, pid)
        return _prop_state_name_rows(m)

    def _hp_fill_state_combo(self, want: Any = None) -> None:
        cb = self._hp_state
        if cb is None:
            return
        cur = cb.currentData() if want is None else want
        rows: list[tuple[str, Any]] = [("（不限状态）", _HP_UNSET)]
        rows.extend(self._hp_state_rows())
        self._hp_set_combo(cb, rows, cur, self._hp_raw.get("propState"))

    def _hp_sync_vitality_enabled(self) -> None:
        if self._hp_op is not None and self._hp_vitality is not None:
            self._hp_vitality.setEnabled(self._hp_op.currentData() not in (None, _HP_UNSET))
        if self._hp_fuel_op is not None and self._hp_fuel is not None:
            self._hp_fuel.setEnabled(self._hp_fuel_op.currentData() not in (None, _HP_UNSET))

    def _on_hp_who_changed(self, _value: str) -> None:
        # 换人只刷挂点候选；已选的挂点名保值（名字跨动画包通用，清掉比留着危险）
        self._hp_fill_socket_combo()
        self._emit_changed()

    def _on_hp_prop_changed(self, _value: str) -> None:
        # 换挂件只刷状态候选；已选状态名保值（不在新挂件里就标「不在候选里」，校验器报 error）
        self._hp_fill_state_combo()
        self._emit_changed()

    def _on_hp_op_changed(self, _i: int) -> None:
        self._hp_sync_vitality_enabled()
        self._emit_changed()

    def _on_hp_fuel_op_changed(self, _i: int) -> None:
        self._hp_sync_vitality_enabled()
        self._emit_changed()

    def _hp_load_controls(self, raw: dict[str, Any]) -> None:
        """把一条叶子的磁盘值摆进控件（程序性：不外发、不改数据）。调用方先设好 `_hp_raw`。"""
        if self._hp_who is None or self._hp_op is None or self._hp_vitality is None:
            return
        who = raw.get("heldProp")
        self._hp_who.set_value(who if isinstance(who, str) else "")
        sk = raw.get("socket")
        self._hp_fill_socket_combo(want=sk.strip() if isinstance(sk, str) else "")
        pr = raw.get("prop")
        self._hp_prop.set_value(pr if isinstance(pr, str) else "")
        st = raw.get("propState", _HP_ABSENT)
        if st is _HP_ABSENT:
            st_want: Any = _HP_UNSET
        elif isinstance(st, str):
            st_want = st.strip()
        else:
            st_want = _HP_RAW
        self._hp_fill_state_combo(want=st_want)

        b = raw.get("burning", _HP_ABSENT)
        b_want = _HP_UNSET if b is _HP_ABSENT else ("true" if b is True else "false" if b is False else _HP_RAW)
        self._hp_set_combo(
            self._hp_burning,
            [("（不限）", _HP_UNSET), ("燃着（true）", "true"), ("没燃（false）", "false")],
            b_want, b,
        )
        op = raw.get("vitalityOp", _HP_ABSENT)
        op_want = _HP_UNSET if op is _HP_ABSENT else (
            op if isinstance(op, str) and op in _HELD_VITALITY_OPS else _HP_RAW)
        self._hp_set_combo(
            self._hp_op,
            [("（不限）", _HP_UNSET), *((o, o) for o in _HELD_VITALITY_OPS)],
            op_want, op,
        )
        v = raw.get("vitality")
        self._hp_vitality.blockSignals(True)
        self._hp_vitality.setValue(
            float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0.5,
        )
        self._hp_vitality.blockSignals(False)
        fop = raw.get("fuelOp", _HP_ABSENT)
        fop_want = _HP_UNSET if fop is _HP_ABSENT else (
            fop if isinstance(fop, str) and fop in _HELD_VITALITY_OPS else _HP_RAW)
        self._hp_set_combo(
            self._hp_fuel_op,
            [("（不限）", _HP_UNSET), *((o, o) for o in _HELD_VITALITY_OPS)],
            fop_want, fop,
        )
        fv = raw.get("fuel")
        self._hp_fuel.blockSignals(True)
        self._hp_fuel.setValue(
            float(fv) if isinstance(fv, (int, float)) and not isinstance(fv, bool) else 0.5,
        )
        self._hp_fuel.blockSignals(False)
        ef = raw.get("effect")
        self._hp_effect.set_value(ef.strip() if isinstance(ef, str) else "")
        lk = raw.get("lock", _HP_ABSENT)
        lock_values = [val for val, _lab in _HELD_LOCK_ROWS]
        lk_want = _HP_UNSET if lk is _HP_ABSENT else (
            lk if isinstance(lk, str) and lk in lock_values else _HP_RAW)
        self._hp_set_combo(
            self._hp_lock,
            [("（不限）", _HP_UNSET), *((lab, val) for val, lab in _HELD_LOCK_ROWS)],
            lk_want, lk,
        )
        self._hp_sync_vitality_enabled()

    def _hp_snapshot(self) -> dict[str, Any]:
        return {
            "heldProp": self._hp_who.current_value() if self._hp_who else "",
            "socket": self._hp_socket.committed_type().strip() if self._hp_socket else "",
            "prop": self._hp_prop.current_value() if self._hp_prop else "",
            "propState": self._hp_state.currentData() if self._hp_state else None,
            "burning": self._hp_burning.currentData() if self._hp_burning else None,
            "vitalityOp": self._hp_op.currentData() if self._hp_op else None,
            "vitality": self._hp_vitality.value() if self._hp_vitality else None,
            "fuelOp": self._hp_fuel_op.currentData() if self._hp_fuel_op else None,
            "fuel": self._hp_fuel.value() if self._hp_fuel else None,
            "effect": self._hp_effect.current_value() if self._hp_effect else "",
            "lock": self._hp_lock.currentData() if self._hp_lock else None,
        }

    def _held_prop_canonical(self) -> dict[str, Any]:
        who = self._hp_who.current_value().strip() if self._hp_who else ""
        if not who:
            return {}
        raw, seed, snap = self._hp_raw, self._hp_seed, self._hp_snapshot()
        vals: dict[str, Any] = {}

        def put(key: str, new: Any, *, untouched: bool | None = None) -> None:
            same = snap.get(key) == seed.get(key) if untouched is None else untouched
            if same:
                if key in raw:
                    vals[key] = copy.deepcopy(raw[key])
                elif key == "heldProp":
                    vals[key] = new
                return
            if new is not _HP_ABSENT:
                vals[key] = new

        def pick(key: str, value: Any, mapping: dict[Any, Any] | None = None) -> Any:
            if value in (None, _HP_UNSET):
                return _HP_ABSENT
            if value == _HP_RAW:
                return copy.deepcopy(raw.get(key)) if key in raw else _HP_ABSENT
            return mapping.get(value, value) if mapping else value

        put("heldProp", who)
        put("socket", snap["socket"] or _HP_ABSENT)
        put("prop", snap["prop"].strip() or _HP_ABSENT)
        put("propState", pick("propState", snap["propState"]))
        put("burning", pick("burning", snap["burning"], {"true": True, "false": False}))
        # 火势 / 燃料比较各是一对：两个都没动 ⇒ 各自回吐原值；动了任一 ⇒ 按运算符整对重写（不限 = 两个都删）
        for op_key, v_key in (("vitalityOp", "vitality"), ("fuelOp", "fuel")):
            pair_same = snap[op_key] == seed.get(op_key) and snap[v_key] == seed.get(v_key)
            op_val = pick(op_key, snap[op_key])
            put(op_key, op_val, untouched=pair_same)
            if op_val is _HP_ABSENT:
                put(v_key, _HP_ABSENT, untouched=pair_same)
                continue
            rv = raw.get(v_key)
            if (snap[v_key] == seed.get(v_key) and isinstance(rv, (int, float))
                    and not isinstance(rv, bool)):
                num: Any = rv  # 数值没动：回吐磁盘原表示（0 不漂成 0.0、0.3333 不被截断）
            else:
                num = round(float(snap[v_key]), 4)
            put(v_key, num, untouched=pair_same)
        put("effect", snap["effect"].strip() or _HP_ABSENT)
        put("lock", pick("lock", snap["lock"]))

        out: dict[str, Any] = {}
        for key, value in raw.items():
            if key in vals:
                out[key] = vals[key]
            elif key not in _HELD_PROP_KEYS:
                out[key] = copy.deepcopy(value)  # 表单不认识的键透传
        for key in _HELD_PROP_KEYS:
            if key in vals and key not in out:
                out[key] = vals[key]
        return out

    def _narrative_graph_entries(self) -> list[tuple[str, str, dict[str, Any]]]:
        """(显示名, graphId, graph dict)：主图 + wrapper 子图，与 narrative_graphs.json 一致。"""
        m = self._model()
        data = getattr(m, "narrative_graphs", None) if m else None
        out: list[tuple[str, str, dict[str, Any]]] = []
        if not isinstance(data, dict):
            return out
        for comp in data.get("compositions") or []:
            if not isinstance(comp, dict):
                continue
            main = comp.get("mainGraph")
            if isinstance(main, dict) and main.get("id"):
                label = str(main.get("label") or comp.get("label") or main["id"])
                out.append((f"{label} ({main['id']})", str(main["id"]), main))
            for el in comp.get("elements") or []:
                # 与运行时/ProjectModel 同口径：带内嵌 graph 的两种 kind 都算（只认
                # wrapperGraph 会漏掉 scenarioSubgraph，条件里就点不到事件子图的状态）。
                if not isinstance(el, dict) or el.get("kind") not in ("wrapperGraph", "scenarioSubgraph"):
                    continue
                g = el.get("graph")
                if isinstance(g, dict) and g.get("id"):
                    label = str(el.get("label") or g.get("label") or g["id"])
                    out.append((f"{label} ({g['id']})", str(g["id"]), g))
        return out

    def _scenario_reference_rows(self) -> list[tuple[str, str, str]]:
        """Live Scenario catalog rows, including labels when the host has them."""
        model = self._model()
        if model is None or not hasattr(model, "scenario_ids_ordered"):
            return []
        raw_rows = (
            model.scenarios_catalog.get("scenarios")
            if isinstance(getattr(model, "scenarios_catalog", None), dict)
            else []
        )
        labels = {
            str(row.get("id", "")).strip(): str(
                row.get("label") or row.get("name") or row.get("title") or row.get("id") or "",
            ).strip()
            for row in (raw_rows or [])
            if isinstance(row, dict)
        }
        return [
            (str(sid), labels.get(str(sid), str(sid)), "Scenario")
            for sid in model.scenario_ids_ordered()
            if str(sid).strip()
        ]

    def _narrative_graph_reference_rows(
        self,
        *,
        run_only: bool = False,
    ) -> list[tuple[str, str, str]]:
        """Live picker rows. The model is queried when the popup is opened."""
        rows: list[tuple[str, str, str]] = []
        for label, gid, graph in self._narrative_graph_entries():
            if run_only and not isinstance(graph.get("run"), dict):
                continue
            detail = "活计图" if isinstance(graph.get("run"), dict) else "叙事图"
            rows.append((gid, label, detail))
        return rows

    def _narrative_state_reference_rows(self) -> list[tuple[str, str, str]]:
        gid = self._nv_graph.current_value().strip() if self._nv_graph else ""
        if not gid:
            return []
        for _label, graph_id, graph in self._narrative_graph_entries():
            if graph_id != gid:
                continue
            rows: list[tuple[str, str, str]] = []
            for state_id, state in (graph.get("states") or {}).items():
                sid = str(state_id)
                label = str((state or {}).get("label") or sid) if isinstance(state, dict) else sid
                rows.append((sid, label, f"叙事图 {gid}"))
            return rows
        return []

    def _narrative_count_exit_reference_rows(self) -> list[tuple[str, str, str]]:
        gid = self._nc_graph.current_value().strip() if self._nc_graph else ""
        if not gid:
            return []
        for _label, graph_id, graph in self._narrative_graph_entries():
            if graph_id != gid:
                continue
            states = graph.get("states") or {}
            rows: list[tuple[str, str, str]] = []
            for state_id in graph.get("exitStates") or []:
                sid = str(state_id)
                state = states.get(sid)
                label = str((state or {}).get("label") or sid) if isinstance(state, dict) else sid
                rows.append((sid, label, f"活计图 {gid} 的出口"))
            return rows
        return []

    def _fill_narrative_combos(self) -> None:
        if not self._nv_graph:
            return
        self._nv_graph.refresh_display()
        self._fill_narrative_state_combo()

    def _on_narrative_graph_reference_changed(self, _value: str) -> None:
        # A user-selected parent invalidates the dependent state. Programmatic
        # refresh/set never calls this handler, so stale catalogs cannot clear a
        # draft or mark the editor dirty.
        if self._nv_state:
            self._nv_state.set_value("")
        self._fill_narrative_state_combo()
        self._emit_changed()

    def _fill_narrative_count_combos(self) -> None:
        if not self._nc_graph:
            return
        self._nc_graph.refresh_display()
        self._fill_narrative_count_exit_combo()

    def _on_narrative_count_graph_reference_changed(self, _value: str) -> None:
        if self._nc_exit:
            self._nc_exit.set_value("")
        self._fill_narrative_count_exit_combo()
        self._emit_changed()

    def _fill_narrative_count_exit_combo(self) -> None:
        if not self._nc_exit or not self._nc_graph:
            return
        self._nc_exit.refresh_display()

    def _fill_narrative_state_combo(self) -> None:
        if not self._nv_state or not self._nv_graph:
            return
        self._nv_state.refresh_display()

    def _fill_scenario_combos(self) -> None:
        if not self._sc_id or not self._sc_ph:
            return
        self._sc_id.refresh_display()
        self._fill_phase_combo()

    def _on_scenario_reference_changed(self, _value: str) -> None:
        if self._sc_ph:
            self._sc_ph.blockSignals(True)
            self._sc_ph.clear()
            self._sc_ph.addItem("（选择）", "")
            self._sc_ph.blockSignals(False)
        self._fill_phase_combo()
        self._emit_changed()

    def _fill_phase_combo(self) -> None:
        if not self._sc_ph or not self._sc_id:
            return
        m = self._model()
        sid = self._sc_id.current_value().strip()
        # 刷新保值：记住当前 phase，重建后还原；未知值以「（数据）」注入保留。
        cur_ph = self._sc_ph.currentData()
        cur_ph = cur_ph.strip() if isinstance(cur_ph, str) else ""
        self._sc_ph.blockSignals(True)
        self._sc_ph.clear()
        self._sc_ph.addItem("（选择）", "")
        if m and sid:
            for ph in m.phases_for_scenario(sid):
                self._sc_ph.addItem(ph, ph)
        if cur_ph:
            idx = self._sc_ph.findData(cur_ph)
            if idx < 0:
                self._sc_ph.addItem(f"（数据）{cur_ph}", cur_ph)
                idx = self._sc_ph.count() - 1
            self._sc_ph.setCurrentIndex(idx)
        self._sc_ph.blockSignals(False)

    def _fill_scenario_line_combo(self) -> None:
        if not self._sl_id:
            return
        self._sl_id.refresh_display()

    def refresh_scenario_dropdowns(self) -> None:
        if self._sc_id:
            self._fill_scenario_combos()
        if self._sl_id:
            self._fill_scenario_line_combo()
        for c in self._child_editors:
            c.refresh_scenario_dropdowns()
        if self._not_child:
            self._not_child.refresh_scenario_dropdowns()

    def refresh_live_reference_fields(self) -> None:
        """Refresh labels only; providers stay live and values/signals stay untouched."""
        for field in (
            self._sc_id,
            self._sl_id,
            self._nv_graph,
            self._nv_state,
            self._nc_graph,
            self._nc_exit,
            self._hp_who,
            self._hp_prop,
            self._hp_effect,
            self._lv_prop,
        ):
            if field is not None:
                field.refresh_display()
        if self._lv_prop is not None:
            self._lv_sync_max()
        if self._hp_who is not None:
            # 挂点 / 状态候选跟着工程刷新；当前值保值、不外发（程序性刷新不是编辑）
            self._hp_fill_socket_combo()
            self._hp_fill_state_combo()
        if self._bn_target is not None:
            self._bn_target.refresh_display()
            self._bn_fill_socket_combo()
        for child in self._child_editors:
            child.refresh_live_reference_fields()
        if self._not_child:
            self._not_child.refresh_live_reference_fields()

    def _on_flag_field_value_changed(self) -> None:
        if self._flag_val_reg and self._flag_field:
            self._flag_val_reg.set_flag_key(self._flag_field.key())
        self._emit_changed()

    def _on_flag_val_mode_changed(self, _i: int = 0) -> None:
        self._sync_flag_value_widgets_visibility()
        self._emit_changed()

    def _sync_flag_value_widgets_visibility(self) -> None:
        if not self._flag_val_mode or not self._flag_val_reg or self._flag_free_value is None:
            return
        is_ref = self._flag_val_mode.currentData() == "string_ref"
        self._flag_val_reg.setVisible(not is_ref)
        self._flag_free_value.setVisible(is_ref)

    def _flag_free_text(self) -> str:
        w = self._flag_free_value
        if w is None:
            return ""
        if isinstance(w, RichTextLineEdit):
            return w.text()
        if isinstance(w, QLineEdit):
            return w.text()
        return ""

    def _add_child(self) -> None:
        if self._depth >= _MAX_DEPTH - 1 or not self._lay_all_any:
            return
        ch = ConditionExprNodeEditor(self._depth + 1, self._model_getter)
        ch.set_remove_callback(self._remove_child)
        ch.changed.connect(self._emit_changed)
        self._child_editors.append(ch)
        # 末项是「+ 添加子条件」按钮：子条件一律插在它前面。
        self._lay_all_any.insertWidget(max(0, self._lay_all_any.count() - 1), ch)
        ch.show()
        ch._schedule_inline_check()  # 构造时还没挂进树，找不到根；挂上后再报一次
        self._refresh_ancestor_geometry()
        self._emit_changed()

    def _remove_child(self, editor: ConditionExprNodeEditor) -> None:
        if editor in self._child_editors:
            # 子树非空时先确认，避免误删整棵已配置子条件（不可撤销）。
            if not editor._confirm_destructive_discard("移除此节点"):
                return
            self._child_editors.remove(editor)
            discard_widget(editor)
            self._refresh_ancestor_geometry()
            self._emit_changed()

    def set_dict(self, data: dict[str, Any] | None) -> None:
        """程序性载入：全程抑制 changed（契约——载入 UI 不得外发编辑信号误标工程脏）。"""
        prev = self._loading
        self._loading = True
        try:
            self._set_dict_impl(data)
        finally:
            self._loading = prev
        # 载入完成后同步一次 not 恒假提示（此期间被抑制的可视状态需要落定）
        self._refresh_not_empty_hint()
        self._refresh_summary_if_collapsed()
        self._refresh_ancestor_geometry()

    def _set_dict_impl(self, data: dict[str, Any] | None) -> None:
        # 原始形状快照：UI 未实际编辑时 to_dict 逐字返回原 dict
        #（不注入 questStatus/lineStatus/phase/status 默认键、不丢 reached:false、
        #  不把旧 "status" 键名改写成 "questStatus"、保留未知附加键）。
        self._orig_data: dict[str, Any] | None = None
        self._orig_canonical: dict[str, Any] | None = None
        if not isinstance(data, dict):
            self._kind.blockSignals(True)
            self._kind.setCurrentIndex(3)
            self._kind.blockSignals(False)
            self._rebuild_body("flag")
            return
        self._kind.blockSignals(True)
        if "all" in data and isinstance(data["all"], list):
            self._kind.setCurrentIndex(0)
        elif "any" in data and isinstance(data["any"], list):
            self._kind.setCurrentIndex(1)
        elif "not" in data and isinstance(data["not"], dict):
            self._kind.setCurrentIndex(2)
        elif _is_flag_atom(data):
            self._kind.setCurrentIndex(3)
        elif isinstance(data.get("quest"), str) and str(data.get("quest", "")).strip():
            self._kind.setCurrentIndex(4)
        elif isinstance(data.get("scenarioLine"), str) and str(data.get("scenarioLine", "")).strip():
            self._kind.setCurrentIndex(6)
        elif isinstance(data.get("scenario"), str) and str(data.get("scenario", "")).strip():
            self._kind.setCurrentIndex(5)
        elif isinstance(data.get("narrative"), str) and str(data.get("narrative", "")).strip():
            self._kind.setCurrentIndex(7)
        elif isinstance(data.get("narrativeCount"), str) and str(data.get("narrativeCount", "")).strip():
            self._kind.setCurrentIndex(self._kind.findData("narrativeCount"))
        elif isinstance(data.get("plane"), str) and str(data.get("plane", "")).strip():
            self._kind.setCurrentIndex(self._kind.findData("plane"))
        elif isinstance(data.get("posture"), str) and str(data.get("posture", "")).strip():
            self._kind.setCurrentIndex(self._kind.findData("posture"))
        elif isinstance(data.get("timePhase"), str) and str(data.get("timePhase", "")).strip():
            self._kind.setCurrentIndex(self._kind.findData("timePhase"))
        elif isinstance(data.get("heldProp"), str) and str(data.get("heldProp", "")).strip():
            self._kind.setCurrentIndex(self._kind.findData("heldProp"))
        elif isinstance(data.get("propLevel"), str) and str(data.get("propLevel", "")).strip():
            self._kind.setCurrentIndex(self._kind.findData("propLevel"))
        elif isinstance(data.get("burn"), str) and str(data.get("burn", "")).strip():
            self._kind.setCurrentIndex(self._kind.findData("burn"))
        else:
            self._kind.setCurrentIndex(3)
        k = self._kind.currentData()
        self._kind.blockSignals(False)
        assert isinstance(k, str)
        self._rebuild_body(k)

        if k == "all" or k == "any":
            key = "all" if k == "all" else "any"
            for item in data.get(key) or []:
                if isinstance(item, dict):
                    self._add_child()
                    self._child_editors[-1].set_dict(item)
        elif k == "not":
            inner = data.get("not")
            if isinstance(inner, dict) and self._not_child:
                self._not_child.set_dict(inner)
        elif k == "flag" and self._flag_field and self._flag_op and self._flag_val_reg and self._flag_val_mode and self._flag_free_value is not None:
            # 程序性载入：静默设值，不发 valueChanged（_loading 亦已兜底，双重保险）。
            self._flag_field.set_key_silent(str(data.get("flag", "")))
            self._flag_val_reg.set_flag_key(self._flag_field.key())
            op = str(data.get("op", "=="))
            iop = self._flag_op.findText(op)
            self._flag_op.setCurrentIndex(max(0, iop))
            v = data.get("value", True)
            if isinstance(v, str):
                ir = self._flag_val_mode.findData("string_ref")
                self._flag_val_mode.blockSignals(True)
                self._flag_val_mode.setCurrentIndex(ir if ir >= 0 else 1)
                self._flag_val_mode.blockSignals(False)
                self._sync_flag_value_widgets_visibility()
                if isinstance(self._flag_free_value, RichTextLineEdit):
                    self._flag_free_value.setText(v)
                else:
                    self._flag_free_value.setText(v)
            else:
                ir0 = self._flag_val_mode.findData("registry")
                self._flag_val_mode.blockSignals(True)
                self._flag_val_mode.setCurrentIndex(ir0 if ir0 >= 0 else 0)
                self._flag_val_mode.blockSignals(False)
                self._sync_flag_value_widgets_visibility()
                self._flag_val_reg.set_value(v)
        elif k == "quest" and self._q_id and self._q_st:
            _qid = str(data.get("quest", ""))
            _qm = self._model()
            if _qm is not None and hasattr(_qm, "quest_status_target_ids"):
                _items = list(_qm.quest_status_target_ids())
            elif _qm is not None and hasattr(_qm, "all_quest_ids"):
                _items = list(_qm.all_quest_ids())
            else:
                _items = []
            _ids = [i[0] if isinstance(i, (list, tuple)) else i for i in _items]
            if _qid and _qid not in _ids:
                _items.append((_qid, _qid))  # 保留指向已删/未知任务的既有值,不静默丢失
            self._q_id.set_items(_items)
            self._q_id.set_current(_qid)
            qs = str(data.get("questStatus", data.get("status", "Completed")))
            iqs = self._q_st.findData(qs)
            if iqs < 0:
                iqs = self._q_st.findText(qs)
            self._q_st.setCurrentIndex(iqs if iqs >= 0 else 2)
        elif k == "scenarioLine" and self._sl_id and self._sl_st:
            self._fill_scenario_line_combo()
            slid = str(data.get("scenarioLine", "")).strip()
            self._sl_id.set_value(slid)
            lst = str(data.get("lineStatus", "inactive")).strip()
            i2 = self._sl_st.findData(lst)
            if i2 < 0:
                self._sl_st.addItem(f"（数据）{lst}", lst)
                i2 = self._sl_st.count() - 1
            self._sl_st.setCurrentIndex(i2)
        elif k == "scenario" and self._sc_id and self._sc_ph and self._sc_st and self._sc_out:
            self._fill_scenario_combos()
            sc = str(data.get("scenario", "")).strip()
            self._sc_id.set_value(sc)
            self._fill_phase_combo()
            ph = str(data.get("phase", "")).strip()
            idx2 = self._sc_ph.findData(ph)
            if idx2 < 0 and ph:
                # 已删/未知 phase 同样保留，避免静默改写
                self._sc_ph.addItem(f"（数据）{ph}", ph)
                idx2 = self._sc_ph.count() - 1
            self._sc_ph.setCurrentIndex(idx2 if idx2 >= 0 else 0)
            st = str(data.get("status", "done"))
            idx3 = self._sc_st.findData(st)
            if idx3 < 0:
                self._sc_st.addItem(f"（数据）{st}", st)
                idx3 = self._sc_st.count() - 1
            self._sc_st.setCurrentIndex(idx3)
            oc = data.get("outcome")
            if oc is None:
                self._sc_out.clear()
            elif isinstance(oc, (str, int, float, bool)):
                self._sc_out.setText(str(oc) if isinstance(oc, str) else json.dumps(oc, ensure_ascii=False))
            else:
                try:
                    self._sc_out.setText(json.dumps(oc, ensure_ascii=False))
                except (TypeError, ValueError):
                    self._sc_out.setText(str(oc))
        elif k == "narrative" and self._nv_graph and self._nv_state and self._nv_reached:
            gid = str(data.get("narrative", "")).strip()
            self._nv_graph.set_value(gid)
            self._fill_narrative_state_combo()
            sid = str(data.get("state", "")).strip()
            self._nv_state.set_value(sid)
            self._nv_reached.setChecked(data.get("reached") is True)
        elif k == "narrativeCount" and self._nc_graph and self._nc_exit and self._nc_op and self._nc_value:
            gid = str(data.get("narrativeCount", "")).strip()
            self._nc_graph.set_value(gid)
            self._fill_narrative_count_exit_combo()
            exit_id = str(data.get("exitState", "")).strip()
            self._nc_exit.set_value(exit_id)
            op = str(data.get("op", ">="))
            iop = self._nc_op.findData(op)
            self._nc_op.blockSignals(True)
            self._nc_op.setCurrentIndex(max(0, iop))
            self._nc_op.blockSignals(False)
            v = data.get("value")
            self._nc_value.blockSignals(True)
            self._nc_value.setValue(int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else 1)
            self._nc_value.blockSignals(False)
        elif k == "posture" and self._po_kind:
            want = str(data.get("posture", "")).strip()
            idx = self._po_kind.findData(want)
            self._po_kind.blockSignals(True)
            self._po_kind.setCurrentIndex(idx if idx >= 0 else 0)
            self._po_kind.blockSignals(False)
        elif k == "timePhase" and self._tp_kind:
            want = str(data.get("timePhase", "")).strip()
            idx = self._tp_kind.findData(want)
            if idx < 0 and want:
                # 保值展示：时段表里没有的值（改名/尚未登记）也必须原样留住，
                # 否则一次「打开→保存」就把内容里的时段悄悄顶替成第一档。
                self._tp_kind.addItem(f"{want}（未登记）", want)
                idx = self._tp_kind.findData(want)
            self._tp_kind.blockSignals(True)
            self._tp_kind.setCurrentIndex(idx if idx >= 0 else 0)
            self._tp_kind.blockSignals(False)
        elif k == "heldProp" and self._hp_who is not None:
            self._hp_raw = copy.deepcopy(data)
            self._hp_load_controls(self._hp_raw)
            self._hp_seed = self._hp_snapshot()
        elif k == "propLevel" and self._lv_prop is not None:
            self._lv_raw = copy.deepcopy(data)
            self._lv_load_controls(self._lv_raw)
            self._lv_seed = self._lv_snapshot()
        elif k == "burn" and self._bn_target is not None:
            self._bn_raw = copy.deepcopy(data)
            self._bn_load_controls(self._bn_raw)
        elif k == "plane" and self._pl_id:
            pid = str(data.get("plane", "")).strip()
            _pm = self._model()
            _items = (
                list(_pm.all_plane_ids())
                if (_pm is not None and hasattr(_pm, "all_plane_ids"))
                else []
            )
            _ids = [i[0] if isinstance(i, (list, tuple)) else i for i in _items]
            if pid and pid not in _ids:
                _items.append((pid, pid))  # 保留指向已删/未知位面的既有值，不静默丢失
            self._pl_id.set_items(_items)
            self._pl_id.set_current(pid)
        # 记录原始 dict 与"载入后立即序列化"的规范化基线：
        # to_dict 时若规范化输出仍等于基线（= UI 无实际编辑），逐字返回原 dict。
        self._orig_data = copy.deepcopy(data)
        self._orig_canonical = self._to_dict_canonical()

    def to_dict(self) -> dict[str, Any]:
        cur = self._to_dict_canonical()
        orig = getattr(self, "_orig_data", None)
        if orig is not None and cur == getattr(self, "_orig_canonical", None):
            return copy.deepcopy(orig)
        return cur

    def _to_dict_canonical(self) -> dict[str, Any]:
        k = self._kind.currentData()
        if not isinstance(k, str):
            return {}
        if k == "all":
            items = [c.to_dict() for c in self._child_editors if c.to_dict()]
            return {"all": items}
        if k == "any":
            items = [c.to_dict() for c in self._child_editors if c.to_dict()]
            return {"any": items}
        if k == "not":
            if self._not_child:
                inner = self._not_child.to_dict()
                if inner:
                    return {"not": inner}
            return {"not": {"all": []}}
        if k == "flag" and self._flag_field and self._flag_op and self._flag_val_reg and self._flag_val_mode and self._flag_free_value is not None:
            fk = self._flag_field.key().strip()
            if not fk:
                return {}
            result: dict[str, Any] = {"flag": fk}
            op = self._flag_op.currentText()
            if op != "==":
                result["op"] = op
            mode = self._flag_val_mode.currentData()
            if mode == "string_ref":
                result["value"] = self._flag_free_text()
            else:
                v = self._flag_val_reg.get_value()
                if isinstance(v, bool):
                    if op == "==" and v is True:
                        pass
                    else:
                        result["value"] = v
                else:
                    # 不做 float() 强转：FlagValueEdit 原值保留（int 保 int、raw 保原类型）
                    result["value"] = v
            return result
        if k == "quest" and self._q_id and self._q_st:
            qid = self._q_id.current_id().strip()
            if not qid:
                return {}
            qs = self._q_st.currentData()
            return {"quest": qid, "questStatus": str(qs) if qs is not None else "Completed"}
        if k == "scenarioLine" and self._sl_id and self._sl_st:
            slid = self._sl_id.current_value().strip()
            st_d = self._sl_st.currentData()
            st = str(st_d) if st_d is not None else self._sl_st.currentText()
            if not slid:
                return {}
            return {"scenarioLine": slid, "lineStatus": st}
        if k == "scenario" and self._sc_id and self._sc_ph and self._sc_st and self._sc_out:
            sid = self._sc_id.current_value().strip()
            phd = self._sc_ph.currentData()
            ph = phd.strip() if isinstance(phd, str) else ""
            st_d = self._sc_st.currentData()
            st = str(st_d) if st_d is not None else self._sc_st.currentText()
            if not sid:
                return {}
            # phase 允许为空（运行时 isScenarioLeaf / validator 接受 phase:''）：
            # 保留该值而非把整条 scenario 条件静默丢弃。
            out: dict[str, Any] = {"scenario": sid, "phase": ph, "status": st}
            ot = self._sc_out.text().strip()
            if ot:
                orig = getattr(self, "_orig_data", None)
                orig_oc = orig.get("outcome") if isinstance(orig, dict) else None
                if (
                    isinstance(orig, dict)
                    and "outcome" in orig
                    and _render_outcome_text(orig_oc) == ot
                ):
                    # 文本未改动：按原始类型回写（字符串 "true" 不漂成 bool）
                    out["outcome"] = copy.deepcopy(orig_oc)
                else:
                    try:
                        out["outcome"] = json.loads(ot)
                    except json.JSONDecodeError:
                        if ot.lower() in ("true", "false"):
                            out["outcome"] = ot.lower() == "true"
                        else:
                            out["outcome"] = ot
            return out
        if k == "narrative" and self._nv_graph and self._nv_state and self._nv_reached:
            gid = self._nv_graph.current_value().strip()
            sid = self._nv_state.current_value().strip()
            if not gid or not sid:
                return {}
            leaf: dict[str, Any] = {"narrative": gid, "state": sid}
            if self._nv_reached.isChecked():
                leaf["reached"] = True
            return leaf
        if k == "narrativeCount" and self._nc_graph and self._nc_exit and self._nc_op and self._nc_value:
            gid = self._nc_graph.current_value().strip()
            if not gid:
                return {}
            leaf: dict[str, Any] = {"narrativeCount": gid}
            exit_id = self._nc_exit.current_value().strip()
            if exit_id:
                leaf["exitState"] = exit_id
            op_d = self._nc_op.currentData()
            leaf["op"] = str(op_d) if op_d is not None else ">="
            leaf["value"] = int(self._nc_value.value())
            return leaf
        if k == "plane" and self._pl_id:
            pid = self._pl_id.current_id().strip()
            if not pid:
                return {}
            return {"plane": pid}
        if k == "posture" and self._po_kind:
            want = str(self._po_kind.currentData() or "").strip()
            if not want:
                return {}
            return {"posture": want}
        if k == "timePhase" and self._tp_kind:
            want = str(self._tp_kind.currentData() or "").strip()
            if not want:
                return {}
            return {"timePhase": want}
        if k == "heldProp" and self._hp_who is not None:
            return self._held_prop_canonical()
        if k == "propLevel" and self._lv_prop is not None:
            return self._prop_level_canonical()
        if k == "burn" and self._bn_target is not None:
            return self._burn_canonical()
        return {}


class ConditionExprTreeRootWidget(QWidget):
    """根容器：对外 set_expr / get_expr；changed 在子树变更时发出。

    scroll_mode:
      "embedded"（默认）—— 自带一个随内容长高的滚动区（旧宿主：图对话检查器等窄面板）；
      "none" —— 不套滚动区，整棵树按内容高度排布，由宿主那唯一一层滚动条滚
      （动作大纲编辑器的检查器用：滚动条里再套滚动条是最难用的形态）。
    """

    changed = Signal()

    def __init__(
        self,
        parent: QWidget | None = None,
        *,
        model_getter: Callable[[], Any],
        scroll_mode: str = "embedded",
    ) -> None:
        super().__init__(parent)
        self._model_getter = model_getter
        # 先占位：构造根节点时它就会沿父链回头找本控件刷几何，此刻滚动区/根节点都还没建。
        self._scroll: QScrollArea | None = None
        self._root: ConditionExprNodeEditor | None = None
        lay = QVBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(2)
        lay.addLayout(self._build_fold_bar())
        if scroll_mode == "none":
            self.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Preferred)
            self._scroll = None
            self._root = ConditionExprNodeEditor(0, model_getter, self)
            self._root.set_remove_callback(None)
            self._root.changed.connect(self.changed.emit)
            self._root.setToolTip(
                "与运行时 evaluateConditionExpr 一致；嵌套最深 32 层。"
                "根节点可为任意类型；留空必填项（flag / scenario / scenarioLine / quest）导出时省略该分支。",
            )
            lay.addWidget(self._root)
            return
        self.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding,
        )
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        # 横向按需滚动 + 不把内部树的最小宽度往外传：条件树天生会随嵌套变宽，
        # 若让它对外要宽度，宿主面板（图对话检查器默认只有 280px）就整块横向滚动，
        # 行尾的删除/上下移按钮被挤出可视区。宁可让这一块自己滚，也不能顶爆整个面板。
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        scroll.setMinimumWidth(0)
        scroll.setSizeAdjustPolicy(QScrollArea.SizeAdjustPolicy.AdjustIgnored)
        scroll.setMinimumHeight(_CONDITION_EXPR_TREE_SCROLL_MIN_HEIGHT)
        scroll.setMaximumHeight(_CONDITION_EXPR_TREE_SCROLL_MAX_HEIGHT)
        scroll.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Expanding,
        )
        host = QWidget(scroll)
        hl = QVBoxLayout(host)
        self._root = ConditionExprNodeEditor(0, model_getter, host)
        self._root.set_remove_callback(None)
        self._root.changed.connect(self.changed.emit)
        hl.addWidget(self._root)
        hl.addStretch()
        scroll.setWidget(host)
        self._scroll = scroll
        # 高度跟着内容长，别锁死 180px。锁死的后果实测是：三个子条件的表达式内容
        # 有 766px 高，却只开一个 162px 的猫眼，一次看到 21%，而且**把面板拉多高多宽
        # 都不变**——外面还套着检查器自己的滚动条，滚动条里套滚动条。
        # 宿主（图对话检查器）本身就在 QScrollArea 里，让它去滚才是对的。
        self._root.changed.connect(self._sync_height_to_content)
        # 说明改入 tooltip，不在界面长期堆大段文字（没人会逐字读）。
        scroll.setToolTip(
            "与运行时 evaluateConditionExpr 一致；嵌套最深 32 层。"
            "根节点可为任意类型；留空必填项（flag / scenario / scenarioLine / quest）导出时省略该分支。",
        )
        lay.addWidget(scroll, stretch=1)

    def _build_fold_bar(self) -> QHBoxLayout:
        bar = QHBoxLayout()
        bar.setContentsMargins(0, 0, 0, 0)
        bar.setSpacing(2)
        bar.addStretch(1)
        # 一颗按钮 + 菜单：窄宿主（图对话检查器 280px）里三颗并排按钮就把面板顶出横向滚动。
        from PySide6.QtWidgets import QMenu

        b = QToolButton(self)
        b.setText("折叠")
        b.setToolTip("折叠 / 展开条件树（每个节点左侧箭头也能单独折；Ctrl+点箭头连子节点一起）")
        b.setAutoRaise(True)
        b.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        b.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        menu = QMenu(b)
        menu.addAction("全部展开", self.expand_all)
        menu.addAction("只看骨架（组合子从第二层起折成摘要）", self.collapse_to_skeleton)
        menu.addAction("全部折叠成一行摘要", self.collapse_all)
        b.setMenu(menu)
        self._fold_menu_button = b
        bar.addWidget(b)
        return bar

    def root_node(self) -> ConditionExprNodeEditor:
        return self._root

    # ---- 单行叶子并排：整棵树一个口径 ---------------------------------------------

    def resizeEvent(self, event) -> None:  # noqa: N802 - Qt API
        super().resizeEvent(event)
        self.schedule_inline_policy()

    def schedule_inline_policy(self) -> None:
        if getattr(self, "_inline_pending", False):
            return
        self._inline_pending = True
        QTimer.singleShot(0, self, self.apply_inline_policy)

    def apply_inline_policy(self) -> None:
        self._inline_pending = False
        nodes = [self._root, *self._root.findChildren(ConditionExprNodeEditor)]
        leaves = [n for n in nodes if n._active_kind in ConditionExprNodeEditor._INLINE_KINDS]
        currently = bool(leaves) and all(n.is_inline() for n in leaves)
        # 放不下的叶子里挑最挤的判：只要有一个放不下，整棵树都上下排。
        fits = bool(leaves) and all(n.inline_fits(currently) for n in leaves)
        for n in nodes:
            n.set_inline(fits and n._active_kind in ConditionExprNodeEditor._INLINE_KINDS)
        self._sync_height_to_content()

    def expand_all(self) -> None:
        self._root.set_collapsed_recursive(False)

    def collapse_all(self) -> None:
        self._root.set_collapsed_recursive(False)
        self._root.set_collapsed(True)

    def collapse_to_skeleton(self) -> None:
        self._root.collapse_below_depth(1)

    def _sync_height_to_content(self) -> None:
        """把可视高度顶到内容实际高度（封顶 MAX），由宿主那层滚动条接管。"""
        if self._scroll is None or self._root is None:
            self.updateGeometry()
            return
        need = self._root.sizeHint().height() + 12
        self._scroll.setMinimumHeight(
            max(
                _CONDITION_EXPR_TREE_SCROLL_MIN_HEIGHT,
                min(need, _CONDITION_EXPR_TREE_SCROLL_MAX_HEIGHT),
            )
        )
        self._scroll.updateGeometry()
        self.updateGeometry()

    def set_model_refresh(self) -> None:
        """清单变更后安全刷新；程序刷新不改值、不外发 changed。"""
        self._root.refresh_scenario_dropdowns()
        self._root.refresh_live_reference_fields()

    def set_expr(self, expr: dict[str, Any] | None) -> None:
        if expr is None:
            self._root.set_dict({"flag": ""})
        else:
            self._root.set_dict(expr)
        # set_dict 是程序化回填、刻意不发 changed，所以高度要在这里自己同步一次。
        self._sync_height_to_content()
        self.schedule_inline_policy()

    def get_expr(self) -> dict[str, Any] | None:
        d = self._root.to_dict()
        if not d:
            return None
        if _is_flag_atom(d) and not str(d.get("flag", "")).strip():
            return None
        if isinstance(d.get("scenario"), str) and not str(d.get("scenario", "")).strip():
            return None
        if isinstance(d.get("scenarioLine"), str) and not str(d.get("scenarioLine", "")).strip():
            return None
        return d
