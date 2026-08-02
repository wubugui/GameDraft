"""Pure-GUI high-level authoring surface over existing GameDraft data."""
from __future__ import annotations

import copy
import re
from typing import Any, Callable, Iterable

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSplitter,
    QTabWidget,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from tools.editor.shared.action_editor import ActionEditor
from tools.editor.shared.id_ref_selector import IdRefSelector
from tools.editor.shared.reference_picker import ReferencePickerField

from .compiler import (
    BindingRow,
    CompileError,
    CompilationPlan,
    EventBindingSpec,
    apply_compilation_plan,
    build_event_plan,
    commit_model_documents,
    create_flow,
    create_state,
    delete_event_spine,
    find_composition,
    find_graph,
    plan_text,
    remove_event_binding,
    scan_event_bindings,
    update_flow_text,
    update_state,
)


_ROLE_ID = Qt.ItemDataRole.UserRole


def _clean(value: object) -> str:
    return str(value or "").strip()


def _dialogue_rows(model: Any) -> list[tuple[str, str, str]]:
    from tools.editor.shared.dialogue_graph_refs import dialogue_graph_reference_rows

    return dialogue_graph_reference_rows(model)


class _NewFlowDialog(QDialog):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("新建任务流")
        form = QFormLayout(self)
        self.composition_id = QLineEdit(self)
        self.composition_id.setPlaceholderText("例如：event_old_temple")
        self.graph_id = QLineEdit(self)
        self.graph_id.setPlaceholderText("例如：flow_event_old_temple")
        self.label = QLineEdit(self)
        self.description = QLineEdit(self)
        self.initial_id = QLineEdit("initial", self)
        self.initial_label = QLineEdit("未开始", self)
        self._graph_id_auto = True
        self.composition_id.textEdited.connect(self._sync_graph_id)
        self.graph_id.textEdited.connect(lambda _text: setattr(self, "_graph_id_auto", False))
        form.addRow("任务流 ID", self.composition_id)
        form.addRow("主图 ID", self.graph_id)
        form.addRow("显示名", self.label)
        form.addRow("说明", self.description)
        form.addRow("初始阶段 ID", self.initial_id)
        form.addRow("初始阶段名", self.initial_label)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)

    def _sync_graph_id(self, value: str) -> None:
        if not self._graph_id_auto:
            return
        safe = re.sub(r"[^0-9A-Za-z_一-鿿]+", "_", str(value or "")).strip("_")
        self.graph_id.setText(f"flow_{safe}" if safe else "")


class _NewStateDialog(QDialog):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("新建阶段")
        form = QFormLayout(self)
        self.state_id = QLineEdit(self)
        self.label = QLineEdit(self)
        self.description = QLineEdit(self)
        form.addRow("阶段 ID", self.state_id)
        form.addRow("显示名", self.label)
        form.addRow("说明", self.description)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)


class _StateDialog(QDialog):
    """Edit only native state fields; the state ID itself stays immutable."""

    def __init__(self, model: Any, graph: dict[str, Any], state_id: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle(f"编辑阶段 · {state_id}")
        self.resize(760, 680)
        state = (graph.get("states") or {}).get(state_id) or {}
        root = QVBoxLayout(self)
        form = QFormLayout()
        state_id_view = QLineEdit(state_id, self)
        state_id_view.setReadOnly(True)
        self.label = QLineEdit(_clean(state.get("label")), self)
        self.description = QLineEdit(_clean(state.get("description")), self)
        self.initial = QCheckBox("这是图加载时的初始阶段", self)
        self.initial.setChecked(_clean(graph.get("initialState")) == state_id)
        self.exit_state = QCheckBox("这是任务流出口阶段", self)
        self.exit_state.setChecked(state_id in [str(x) for x in graph.get("exitStates") or []])
        self.broadcast = QCheckBox("进入时广播 state:图:阶段（供其它图监听）", self)
        self.broadcast.setChecked(state.get("broadcastOnEnter") is True)
        form.addRow("阶段 ID", state_id_view)
        form.addRow("显示名", self.label)
        form.addRow("说明", self.description)
        form.addRow("初始阶段", self.initial)
        form.addRow("出口阶段", self.exit_state)
        form.addRow("跨图广播", self.broadcast)
        root.addLayout(form)

        tabs = QTabWidget(self)
        self.enter_actions = ActionEditor("进入阶段动作", self)
        self.enter_actions.set_project_context(model, None)
        self.enter_actions.set_data(copy.deepcopy(state.get("onEnterActions") or []))
        self.exit_actions = ActionEditor("离开阶段动作", self)
        self.exit_actions.set_project_context(model, None)
        self.exit_actions.set_data(copy.deepcopy(state.get("onExitActions") or []))
        for title, editor in (("进入动作", self.enter_actions), ("离开动作", self.exit_actions)):
            scroll = QScrollArea(self)
            scroll.setWidgetResizable(True)
            host = QWidget(scroll)
            layout = QVBoxLayout(host)
            layout.addWidget(editor)
            layout.addStretch(1)
            scroll.setWidget(host)
            tabs.addTab(scroll, title)
        root.addWidget(tabs, 1)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        root.addWidget(buttons)


class TaskOrchestrationEditor(QWidget):
    """Task-flow GUI whose durable representation is the old native data only."""

    NATIVE_DIRTY_BUCKETS = frozenset({
        "narrative_graphs",
        "scene",
        "quest",
        "dialogue_stubs",
        "dialogue_graph_edits",
    })
    status_message = Signal(str)
    scene_layout_requested = Signal(str, str, str)
    dialogue_catalog_changed = Signal()
    native_domains_changed = Signal(object)

    def __init__(self, model: Any, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._model = model
        self._current_composition_id = ""
        self._selected_transition_id = ""
        self._flow_text_pending = False
        self._event_form_pending = False
        self._loading = False
        self._unsafe_load_anomalies = tuple(
            str(row) for row in (getattr(model, "load_anomalies", None) or [])
        )
        self._mutated_native_domains: set[str] = set()
        self._host_prepare_native_mutation: Callable[[], bool] | None = None
        self._host_native_publish_failure: (
            Callable[[set[str], Exception], None] | None
        ) = None
        self._native_publish_failure_domains: set[str] = set()
        self._native_publish_failure_error = ""
        self._last_plan: CompilationPlan | None = None
        self._binding_rows: list[BindingRow] = []
        self._build_ui()
        self.reload_from_model()
        if self._unsafe_load_anomalies:
            self._notice.setText(
                "任务编排已锁定：工程载入时存在数据异常，当前内存不能证明是磁盘的完整映像。"
                "请先修复异常并重新打开工程；本页不会编译、应用或保存任务数据。\n\n"
                + "\n".join(self._unsafe_load_anomalies[:8])
            )
            self.setEnabled(False)

    # ------------------------------------------------------------------ UI

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)
        root.setContentsMargins(8, 8, 8, 8)
        notice = QLabel(
            "这里不保存任务脚本：界面内容直接来自现有叙事图、场景、图对话和 Quest。"
            "应用只进入 ProjectModel 内存；使用主编辑器或独立窗口的“全部保存”后才原子写盘。",
            self,
        )
        notice.setWordWrap(True)
        notice.setFrameShape(QFrame.Shape.StyledPanel)
        self._notice = notice
        root.addWidget(notice)

        split = QSplitter(Qt.Orientation.Horizontal, self)
        root.addWidget(split, 1)

        left = QWidget(split)
        left_lay = QVBoxLayout(left)
        left_lay.setContentsMargins(0, 0, 0, 0)
        search = QLineEdit(left)
        search.setPlaceholderText("筛选任务流…")
        search.setClearButtonEnabled(True)
        search.textChanged.connect(self._filter_flows)
        self._flow_search = search
        left_lay.addWidget(search)
        self._flows = QListWidget(left)
        self._flows.setAlternatingRowColors(True)
        self._flows.currentItemChanged.connect(self._on_flow_selected)
        left_lay.addWidget(self._flows, 1)
        flow_buttons = QHBoxLayout()
        add_flow = QPushButton("新建", left)
        add_flow.setToolTip("创建一个旧叙事状态机编辑器可直接打开的 composition/mainGraph")
        add_flow.clicked.connect(self._new_flow)
        delete_flow = QPushButton("删空流", left)
        delete_flow.setToolTip("只允许删除无事件、无元素、无外部引用的空任务流")
        delete_flow.clicked.connect(self._delete_empty_flow)
        flow_buttons.addWidget(add_flow)
        flow_buttons.addWidget(delete_flow)
        left_lay.addLayout(flow_buttons)

        right = QWidget(split)
        right_lay = QVBoxLayout(right)
        right_lay.setContentsMargins(0, 0, 0, 0)
        header = QGroupBox("任务流（原生 composition + mainGraph）", right)
        header_form = QFormLayout(header)
        self._flow_id = QLineEdit(header)
        self._flow_id.setReadOnly(True)
        self._graph_id = QLineEdit(header)
        self._graph_id.setReadOnly(True)
        self._flow_label = QLineEdit(header)
        self._flow_description = QLineEdit(header)
        self._flow_label.textEdited.connect(self._mark_flow_text_pending)
        self._flow_description.textEdited.connect(self._mark_flow_text_pending)
        apply_header = QPushButton("应用名称与说明", header)
        apply_header.clicked.connect(self._apply_flow_text)
        header_form.addRow("任务流 ID", self._flow_id)
        header_form.addRow("主图 ID", self._graph_id)
        header_form.addRow("显示名", self._flow_label)
        header_form.addRow("说明", self._flow_description)
        header_form.addRow("", apply_header)
        right_lay.addWidget(header)

        self._tabs = QTabWidget(right)
        self._tabs.addTab(self._build_flow_tab(), "阶段与事件")
        self._tabs.addTab(self._build_event_tab(), "事件编排")
        self._tabs.addTab(self._build_binding_tab(), "原生接线")
        self._tabs.addTab(self._build_preview_tab(), "编译预览")
        right_lay.addWidget(self._tabs, 1)
        split.addWidget(left)
        split.addWidget(right)
        split.setSizes([280, 1080])

    def _build_flow_tab(self) -> QWidget:
        page = QWidget(self)
        layout = QVBoxLayout(page)
        state_group = QGroupBox("阶段", page)
        state_layout = QVBoxLayout(state_group)
        self._states = QTreeWidget(state_group)
        self._states.setHeaderLabels(["阶段 ID", "显示名", "初始", "出口", "进入动作", "离开动作"])
        self._states.setRootIsDecorated(False)
        self._states.setAlternatingRowColors(True)
        self._states.itemDoubleClicked.connect(lambda *_: self._edit_state())
        state_layout.addWidget(self._states)
        state_buttons = QHBoxLayout()
        for text, slot in (("新增阶段", self._new_state), ("编辑阶段", self._edit_state), ("安全删除", self._delete_state)):
            button = QPushButton(text, state_group)
            button.clicked.connect(slot)
            state_buttons.addWidget(button)
        state_buttons.addStretch(1)
        state_layout.addLayout(state_buttons)
        layout.addWidget(state_group, 1)

        transition_group = QGroupBox("事件（主图 transition）", page)
        transition_layout = QVBoxLayout(transition_group)
        self._transitions = QTreeWidget(transition_group)
        self._transitions.setHeaderLabels(["事件 ID", "发生前", "发生后", "完成信号", "接线数"])
        self._transitions.setRootIsDecorated(False)
        self._transitions.setAlternatingRowColors(True)
        self._transitions.currentItemChanged.connect(self._on_transition_selected)
        self._transitions.itemDoubleClicked.connect(lambda *_: self._open_selected_event())
        transition_layout.addWidget(self._transitions)
        transition_buttons = QHBoxLayout()
        new_event = QPushButton("编排新事件", transition_group)
        new_event.clicked.connect(self._new_event)
        edit_event = QPushButton("查看 / 追加接线", transition_group)
        edit_event.clicked.connect(self._open_selected_event)
        delete_event = QPushButton("安全删除事件", transition_group)
        delete_event.setToolTip("仅在信号没有其它监听/发射，且不存在反向接线时允许删除")
        delete_event.clicked.connect(self._delete_transition)
        transition_buttons.addWidget(new_event)
        transition_buttons.addWidget(edit_event)
        transition_buttons.addWidget(delete_event)
        transition_buttons.addStretch(1)
        transition_layout.addLayout(transition_buttons)
        layout.addWidget(transition_group, 1)
        return page

    def _build_event_tab(self) -> QWidget:
        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        page = QWidget(scroll)
        layout = QVBoxLayout(page)

        transition = QGroupBox("1. 推进哪两个阶段", page)
        tf = QFormLayout(transition)
        self._event_transition_id = QLineEdit(transition)
        self._event_from = IdRefSelector(transition, allow_empty=False)
        self._event_to = IdRefSelector(transition, allow_empty=False)
        self._event_signal = QLineEdit(transition)
        self._event_signal.setReadOnly(True)
        self._event_signal.setPlaceholderText("由任务流 ID + 事件 ID 自动生成")
        self._event_scenario_element = QLineEdit(transition)
        self._event_scenario_element.setReadOnly(True)
        self._event_scenario_graph = QLineEdit(transition)
        self._event_scenario_graph.setReadOnly(True)
        self._event_main_signal = QLineEdit(transition)
        self._event_main_signal.setReadOnly(True)
        self._event_transition_id.textEdited.connect(self._sync_generated_event_ids)
        self._event_transition_id.textEdited.connect(self._mark_event_pending)
        self._event_from.value_changed.connect(self._mark_event_pending)
        self._event_from.value_changed.connect(self._sync_followed_prerequisite)
        self._event_to.value_changed.connect(self._mark_event_pending)
        self._event_gate_follows = QCheckBox("前置条件跟随“发生前阶段”", transition)
        self._event_gate_follows.setChecked(True)
        self._event_gate_follows.toggled.connect(self._sync_prerequisite_controls)
        self._event_gate_follows.toggled.connect(self._mark_event_pending)
        self._event_gate_graph = ReferencePickerField(
            self._prerequisite_graph_rows,
            transition,
            allow_empty=False,
            title="选择作为事件解锁条件的叙事图",
            geometry_key="task_orchestration_prerequisite_graph",
        )
        self._event_gate_graph.value_changed.connect(self._on_prerequisite_graph_changed)
        self._event_gate_graph.value_changed.connect(self._mark_event_pending)
        self._event_gate_state = IdRefSelector(transition, allow_empty=False)
        self._event_gate_state.value_changed.connect(self._mark_event_pending)
        tf.addRow("事件 / transition ID", self._event_transition_id)
        tf.addRow("发生前阶段", self._event_from)
        tf.addRow("发生后阶段", self._event_to)
        tf.addRow("解锁方式", self._event_gate_follows)
        tf.addRow("外部前置叙事图", self._event_gate_graph)
        tf.addRow("外部前置阶段", self._event_gate_state)
        tf.addRow("内容完成信号", self._event_signal)
        tf.addRow("事件 scenario 子图", self._event_scenario_graph)
        tf.addRow("子图原生元素", self._event_scenario_element)
        tf.addRow("主图监听的末态广播", self._event_main_signal)
        layout.addWidget(transition)

        trigger = QGroupBox("2. 玩家怎么触发", page)
        trigger_form = QFormLayout(trigger)
        self._trigger_kind = QComboBox(trigger)
        self._trigger_kind.addItem("进入 Zone → 播放对话 → 完成", "zone_dialogue")
        self._trigger_kind.addItem("进入 Zone → 立即完成", "zone_instant")
        self._trigger_kind.addItem("与 NPC 交谈 → 完成", "npc_dialogue")
        self._trigger_kind.addItem("点击 Hotspot 对话 → 完成", "hotspot_dialogue")
        self._trigger_kind.currentIndexChanged.connect(self._on_trigger_kind_changed)
        self._trigger_kind.currentIndexChanged.connect(self._mark_event_pending)
        self._event_scene = ReferencePickerField(
            lambda: [(sid, _clean((self._model.scenes.get(sid) or {}).get("name")) or sid, "")
                     for sid in self._model.all_scene_ids()],
            trigger,
            allow_empty=False,
            title="选择场景",
            geometry_key="task_orchestration_scene",
        )
        self._event_scene.value_changed.connect(self._on_event_scene_changed)
        self._event_scene.value_changed.connect(self._mark_event_pending)
        self._event_entity = ReferencePickerField(
            self._event_entity_rows,
            trigger,
            allow_empty=False,
            title="选择触发实体",
            geometry_key="task_orchestration_entity",
        )
        self._event_entity.value_changed.connect(self._mark_event_pending)
        self._edit_on_map_button = QPushButton("在地图中布置 / 编辑实体…", trigger)
        self._edit_on_map_button.clicked.connect(self._request_scene_layout)
        trigger_form.addRow("触发方式", self._trigger_kind)
        trigger_form.addRow("场景", self._event_scene)
        trigger_form.addRow("触发实体", self._event_entity)
        trigger_form.addRow("空间数据", self._edit_on_map_button)
        layout.addWidget(trigger)

        dialogue = QGroupBox("3. 对话完成点", page)
        dialogue_form = QFormLayout(dialogue)
        self._event_dialogue = ReferencePickerField(
            lambda: _dialogue_rows(self._model),
            dialogue,
            allow_empty=False,
            title="选择源对话图",
            geometry_key="task_orchestration_dialogue",
        )
        self._event_dialogue.value_changed.connect(self._mark_event_pending)
        self._clone_dialogue = QCheckBox("复制为任务专用图后再插入完成信号（不会污染共享对话）", dialogue)
        self._clone_dialogue.setChecked(True)
        self._clone_dialogue.toggled.connect(self._sync_dialogue_controls)
        self._clone_dialogue.toggled.connect(self._mark_event_pending)
        self._dialogue_copy_id = QLineEdit(dialogue)
        self._dialogue_copy_id.setPlaceholderText("新的普通对话图文件 ID")
        self._dialogue_copy_id_manual = False
        self._dialogue_copy_id.textEdited.connect(lambda _text: setattr(self, "_dialogue_copy_id_manual", True))
        self._dialogue_copy_id.textEdited.connect(self._mark_event_pending)
        self._replace_existing_dialogue = QCheckBox(
            "明确替换触发实体当前绑定的对话（会改变该实体原有语义）",
            dialogue,
        )
        self._replace_existing_dialogue.toggled.connect(self._mark_event_pending)
        dialogue_form.addRow("源图对话", self._event_dialogue)
        dialogue_form.addRow("安全副本", self._clone_dialogue)
        dialogue_form.addRow("副本 ID", self._dialogue_copy_id)
        dialogue_form.addRow("已有绑定", self._replace_existing_dialogue)
        layout.addWidget(dialogue)
        self._dialogue_group = dialogue

        visibility = QGroupBox("4. 这个阶段才存在的实体", page)
        visibility_layout = QVBoxLayout(visibility)
        hint = QLabel(
            "勾选 NPC / Hotspot 后会写 conditions + conditionHidesEntity；Zone 只写 conditions。"
            "若实体已有旧 conditions 但尚未开启隐藏语义，工具会要求先到场景页人工确认。事件推进后条件失效。",
            visibility,
        )
        hint.setWordWrap(True)
        visibility_layout.addWidget(hint)
        self._visible_entities = QTreeWidget(visibility)
        self._visible_entities.setHeaderLabels(["实体", "类型", "当前条件"])
        self._visible_entities.setRootIsDecorated(False)
        self._visible_entities.setAlternatingRowColors(True)
        self._visible_entities.itemChanged.connect(self._mark_event_pending)
        visibility_layout.addWidget(self._visible_entities)
        layout.addWidget(visibility)

        quest = QGroupBox("5. Quest 镜像（可选，进度真相仍是叙事图）", page)
        quest_form = QFormLayout(quest)
        self._quest = ReferencePickerField(
            lambda: [(qid, title, "") for qid, title in self._model.quest_status_target_ids()],
            quest,
            allow_empty=True,
            title="选择现有 Quest",
            geometry_key="task_orchestration_quest",
        )
        self._quest.value_changed.connect(self._mark_event_pending)
        self._new_quest = QCheckBox("新建普通 Quest", quest)
        self._new_quest.toggled.connect(self._sync_quest_controls)
        self._new_quest.toggled.connect(self._mark_event_pending)
        self._new_quest_id = QLineEdit(quest)
        self._new_quest_group = ReferencePickerField(
            lambda: [(qid, name, "") for qid, name in self._model.all_quest_group_ids()],
            quest,
            allow_empty=True,
            title="选择 Quest 分组",
            geometry_key="task_orchestration_quest_group",
        )
        self._new_quest_type = QComboBox(quest)
        self._new_quest_type.addItem("支线", "side")
        self._new_quest_type.addItem("主线", "main")
        self._new_quest_title = QLineEdit(quest)
        self._new_quest_description = QLineEdit(quest)
        self._new_quest_id.textEdited.connect(self._mark_event_pending)
        self._new_quest_group.value_changed.connect(self._mark_event_pending)
        self._new_quest_type.currentIndexChanged.connect(self._mark_event_pending)
        self._new_quest_title.textEdited.connect(self._mark_event_pending)
        self._new_quest_description.textEdited.connect(self._mark_event_pending)
        quest_form.addRow("绑定现有 Quest", self._quest)
        quest_form.addRow("或", self._new_quest)
        quest_form.addRow("新 Quest ID", self._new_quest_id)
        quest_form.addRow("分组", self._new_quest_group)
        quest_form.addRow("类型", self._new_quest_type)
        quest_form.addRow("标题", self._new_quest_title)
        quest_form.addRow("描述", self._new_quest_description)
        layout.addWidget(quest)

        buttons = QHBoxLayout()
        preview = QPushButton("生成编译预览", page)
        preview.clicked.connect(self._preview_event)
        apply = QPushButton("应用到内存", page)
        apply.setToolTip("只更新 ProjectModel 原生数据；不会直接写盘")
        apply.clicked.connect(self._apply_event)
        discard = QPushButton("放弃表单改动", page)
        discard.clicked.connect(self._discard_event_form)
        buttons.addStretch(1)
        buttons.addWidget(discard)
        buttons.addWidget(preview)
        buttons.addWidget(apply)
        layout.addLayout(buttons)
        layout.addStretch(1)
        scroll.setWidget(page)
        self._sync_dialogue_controls()
        self._sync_quest_controls()
        self._sync_prerequisite_controls()
        return scroll

    def _build_binding_tab(self) -> QWidget:
        page = QWidget(self)
        layout = QVBoxLayout(page)
        label = QLabel(
            "这里每一行都是从当前原生 JSON 反向扫描出来的引用，不依赖生成标记。"
            "同一事件有多条接线时逐行显示，工具不会猜哪一条属于自己。",
            page,
        )
        label.setWordWrap(True)
        layout.addWidget(label)
        self._bindings = QTreeWidget(page)
        self._bindings.setHeaderLabels(["类别", "宿主", "原生路径", "含义"])
        self._bindings.setRootIsDecorated(False)
        self._bindings.setAlternatingRowColors(True)
        self._bindings.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        layout.addWidget(self._bindings, 1)
        refresh = QPushButton("重新扫描", page)
        refresh.clicked.connect(self._refresh_bindings)
        unbind = QPushButton("解绑所选原生接线", page)
        unbind.setToolTip("只移除当前选中的一条精确原生接线；事件子图需用“安全删除事件”整体删除")
        unbind.clicked.connect(self._remove_selected_binding)
        buttons = QHBoxLayout()
        buttons.addStretch(1)
        buttons.addWidget(refresh)
        buttons.addWidget(unbind)
        layout.addLayout(buttons)
        return page

    def _build_preview_tab(self) -> QWidget:
        page = QWidget(self)
        layout = QVBoxLayout(page)
        self._preview = QPlainTextEdit(page)
        self._preview.setReadOnly(True)
        self._preview.setPlaceholderText("在“事件编排”中点击“生成编译预览”。")
        layout.addWidget(self._preview, 1)
        return page

    # ------------------------------------------------------------ model view

    def flush_to_model(self, for_save_all: bool = False) -> bool:
        if self._native_publish_failure_domains:
            raise CompileError(
                "任务编排原生数据已应用，但旧编辑页重载通知失败；为避免旧表单覆盖，"
                "当前保存已锁定。" + (
                    f"\n\n{self._native_publish_failure_error}"
                    if self._native_publish_failure_error else ""
                ),
            )
        if for_save_all and self._event_form_pending:
            raise CompileError("事件编排表单还有未点击“应用到内存”的改动；请先应用或放弃表单。")
        if self.has_pending_changes() and self._unsafe_load_anomalies:
            raise CompileError(self.unsafe_load_block_reason())
        if self._flow_text_pending:
            self._apply_flow_text(silent=True)
        return True

    def has_pending_changes(self) -> bool:
        return bool(self._flow_text_pending or self._event_form_pending)

    @property
    def unsafe_load_anomalies(self) -> tuple[str, ...]:
        return self._unsafe_load_anomalies

    def unsafe_native_dirty_buckets(self) -> set[str]:
        if not self._unsafe_load_anomalies:
            return set()
        return (
            set(getattr(self._model, "_dirty", set()) or set())
            & self._mutated_native_domains
            & set(self.NATIVE_DIRTY_BUCKETS)
        )

    def unsafe_load_block_reason(self) -> str:
        preview = "；".join(self._unsafe_load_anomalies[:4])
        return "工程载入异常，任务编排已锁定；请修复并重新打开工程。" + (
            f"\n\n{preview}" if preview else ""
        )

    def _block_unsafe_action(self) -> bool:
        if not self._unsafe_load_anomalies:
            return False
        QMessageBox.critical(self, "任务编排已锁定", self.unsafe_load_block_reason())
        return True

    def _emit_native_domains_changed(self, *domains: str) -> None:
        changed = {str(domain) for domain in domains if str(domain)}
        if changed:
            self._mutated_native_domains.update(changed)
            self.native_domains_changed.emit(changed)

    def _finish_native_mutation(
        self,
        domains: Iterable[str],
        refresh_ui: Callable[[], object],
        *,
        dialogue_catalog_changed: bool = False,
        status: str = "",
    ) -> bool:
        """Rebase old pages before any fallible local widget refresh.

        At this point the ProjectModel mutation has committed.  Publishing its
        domains first guarantees MainWindow can reload or stale-lock old pages
        even if this page's own refresh raises afterward.
        """
        changed = tuple(str(domain) for domain in domains if str(domain))
        try:
            self._emit_native_domains_changed(*changed)
        except Exception as error:  # noqa: BLE001 — authoritative model already changed
            failed_domains = set(changed)
            self._mutated_native_domains.update(failed_domains)
            self._native_publish_failure_domains.update(failed_domains)
            self._native_publish_failure_error = str(error)
            self.setEnabled(False)
            callback = self._host_native_publish_failure
            if callback is not None:
                try:
                    callback(failed_domains, error)
                except Exception:
                    # MainWindow also reads the sticky failure state in every
                    # save/close/replace guard, so callback failure cannot
                    # silently reopen the unsafe path.
                    pass
            QMessageBox.critical(
                self,
                "任务编排数据发布失败",
                "原生数据已经应用，但无法确认旧编辑页已重载。任务编排和主编辑器"
                f"保存生命周期必须保持锁定，避免旧表单覆盖新数据。\n\n{error}",
            )
            return False
        if dialogue_catalog_changed:
            self.dialogue_catalog_changed.emit()
        try:
            refresh_ui()
        except Exception as error:  # noqa: BLE001 — model is already committed
            self.setEnabled(False)
            QMessageBox.critical(
                self,
                "任务编排页面刷新失败",
                "原生数据已经安全应用，旧编辑页也已收到重载通知；但任务编排页面自身"
                "刷新失败，已锁定以避免继续使用过期控件。可以保存当前原生数据，随后"
                f"修复并重新打开工程。\n\n{error}",
            )
            return False
        if status:
            self.status_message.emit(status)
        return True

    def set_host_prepare_native_mutation(self, callback: Callable[[], bool] | None) -> None:
        """Install a synchronous host gate for cross-editor rebase safety."""
        self._host_prepare_native_mutation = callback

    def set_host_native_publish_failure(
        self,
        callback: Callable[[set[str], Exception], None] | None,
    ) -> None:
        """Install host fail-closed hook for a post-commit rebase publish failure."""
        self._host_native_publish_failure = callback

    def native_publish_failure_domains(self) -> set[str]:
        return set(self._native_publish_failure_domains)

    def native_publish_failure_reason(self) -> str:
        return self._native_publish_failure_error or "旧编辑页重载通知失败"

    def _prepare_host_native_mutation(self) -> bool:
        callback = self._host_prepare_native_mutation
        if callback is None:
            return True
        try:
            return bool(callback())
        except Exception as error:
            QMessageBox.critical(self, "任务编排准备失败", str(error))
            return False

    def confirm_close(self, parent: QWidget | None = None) -> bool:
        """Resolve UI-only drafts before close or project replacement."""
        if not self.has_pending_changes():
            return True
        answer = QMessageBox.question(
            parent or self,
            "任务编排尚有表单改动",
            "“保存”会先把表单编译并应用到 ProjectModel 内存；"
            "“放弃”只丢弃尚未应用的表单草稿。",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if answer == QMessageBox.StandardButton.Save:
            try:
                if self._flow_text_pending:
                    self._apply_flow_text(silent=True)
            except Exception as error:
                QMessageBox.warning(parent or self, "任务流应用失败", str(error))
                return False
            if self._event_form_pending:
                self._apply_event()
            return not self.has_pending_changes()
        if answer == QMessageBox.StandardButton.Discard:
            self._flow_text_pending = False
            self._event_form_pending = False
            self._last_plan = None
            self.reload_from_model()
            return True
        return False

    def reload_refs_from_model(self) -> None:
        """Main-editor page hook: refresh catalogs without erasing a draft."""
        if self.has_pending_changes():
            self.refresh_reference_candidates_preserving_draft()
            return
        self.reload_from_model()

    def reload_from_model(self) -> None:
        """Rebuild the whole page from native ProjectModel data."""
        current = self._current_composition_id
        self._loading = True
        try:
            self._flows.clear()
            narrative = getattr(self._model, "narrative_graphs", None) or {}
            for comp in narrative.get("compositions") or []:
                if not isinstance(comp, dict):
                    continue
                cid = _clean(comp.get("id"))
                if not cid:
                    continue
                label = _clean(comp.get("label")) or cid
                item = QListWidgetItem(label if label == cid else f"{label}\n{cid}")
                item.setData(_ROLE_ID, cid)
                self._flows.addItem(item)
                if cid == current:
                    self._flows.setCurrentItem(item)
            if self._flows.currentItem() is None and self._flows.count():
                self._flows.setCurrentRow(0)
        finally:
            self._loading = False
        current_item = self._flows.currentItem()
        if current_item is not None:
            self._current_composition_id = _clean(current_item.data(_ROLE_ID))
        self._load_current_flow()
        self._event_scene.refresh_display()
        self._event_entity.refresh_display()
        self._event_dialogue.refresh_display()
        self._event_gate_graph.refresh_display()
        self._refresh_prerequisite_states()
        self._quest.refresh_display()

    def refresh_reference_candidates_preserving_draft(self) -> None:
        """Refresh cross-domain pickers without clearing an event form draft."""
        gate_state = self._event_gate_state.current_id()
        self._event_scene.refresh_display()
        self._event_entity.refresh_display()
        self._event_dialogue.refresh_display()
        self._event_gate_graph.refresh_display()
        self._refresh_prerequisite_states(preferred=gate_state)
        self._quest.refresh_display()
        self._refresh_visible_entities()

    def _filter_flows(self, text: str) -> None:
        query = _clean(text).casefold()
        for index in range(self._flows.count()):
            item = self._flows.item(index)
            item.setHidden(bool(query and query not in item.text().casefold()))

    def _current_comp(self) -> dict[str, Any] | None:
        return find_composition(
            getattr(self._model, "narrative_graphs", None) or {},
            self._current_composition_id,
        )

    def _current_graph(self) -> dict[str, Any] | None:
        comp = self._current_comp()
        graph = comp.get("mainGraph") if isinstance(comp, dict) else None
        return graph if isinstance(graph, dict) else None

    def _on_flow_selected(self, current: QListWidgetItem | None, previous: QListWidgetItem | None) -> None:
        if self._loading:
            return
        if current is not previous and not self._resolve_event_form_before_context_change("切换任务流"):
            self._loading = True
            try:
                self._flows.setCurrentItem(previous)
            finally:
                self._loading = False
            return
        if previous is not None and self._flow_text_pending:
            self._apply_flow_text(silent=True)
        self._current_composition_id = _clean(current.data(_ROLE_ID)) if current else ""
        self._load_current_flow()

    def _load_current_flow(self) -> None:
        comp = self._current_comp()
        graph = self._current_graph()
        self._loading = True
        try:
            self._flow_id.setText(_clean(comp.get("id")) if comp else "")
            self._graph_id.setText(_clean(graph.get("id")) if graph else "")
            self._flow_label.setText(_clean(comp.get("label")) if comp else "")
            self._flow_description.setText(_clean(comp.get("description")) if comp else "")
            self._flow_text_pending = False
            self._refresh_states()
            self._refresh_transitions()
            self._reset_event_form()
        finally:
            self._loading = False

    def _mark_flow_text_pending(self) -> None:
        if not self._loading and self._current_composition_id:
            self._flow_text_pending = True

    def _apply_flow_text(self, _checked: bool = False, *, silent: bool = False) -> None:
        if self._unsafe_load_anomalies:
            if silent:
                raise CompileError(self.unsafe_load_block_reason())
            self._block_unsafe_action()
            return
        if not self._prepare_host_native_mutation():
            if silent:
                raise CompileError("其它原生编辑页尚未安全提交，任务流文本没有应用。")
            return
        if not self._current_composition_id:
            return
        try:
            update_flow_text(
                self._model,
                self._current_composition_id,
                self._flow_label.text(),
                self._flow_description.text(),
            )
            self._flow_text_pending = False
        except Exception as error:
            if silent:
                raise
            QMessageBox.warning(self, "无法应用", str(error))
            return
        self._finish_native_mutation(
            ("narrative_graphs",),
            self._replace_flow_item_text,
            status="" if silent else "名称与说明已应用到内存",
        )

    def _replace_flow_item_text(self) -> None:
        item = self._flows.currentItem()
        if item is None:
            return
        cid = self._current_composition_id
        label = _clean(self._flow_label.text()) or cid
        item.setText(label if label == cid else f"{label}\n{cid}")

    def _refresh_states(self) -> None:
        graph = self._current_graph()
        selected = _clean(self._states.currentItem().data(0, _ROLE_ID)) if self._states.currentItem() else ""
        self._states.clear()
        if graph is None:
            return
        initial = _clean(graph.get("initialState"))
        exits = {str(x) for x in graph.get("exitStates") or []}
        states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
        for state_id, state in states.items():
            state = state if isinstance(state, dict) else {}
            item = QTreeWidgetItem([
                str(state_id),
                _clean(state.get("label")),
                "✓" if str(state_id) == initial else "",
                "✓" if str(state_id) in exits else "",
                str(len(state.get("onEnterActions") or [])),
                str(len(state.get("onExitActions") or [])),
            ])
            item.setData(0, _ROLE_ID, str(state_id))
            self._states.addTopLevelItem(item)
            if str(state_id) == selected:
                self._states.setCurrentItem(item)
        self._states.resizeColumnToContents(0)

    def _refresh_transitions(self) -> None:
        graph = self._current_graph()
        selected = self._selected_transition_id
        self._transitions.clear()
        if graph is None:
            return
        for transition in graph.get("transitions") or []:
            if not isinstance(transition, dict):
                continue
            tid = _clean(transition.get("id"))
            count = len(scan_event_bindings(self._model, self._current_composition_id, tid))
            item = QTreeWidgetItem([
                tid,
                _clean(transition.get("from")),
                _clean(transition.get("to")),
                _clean(transition.get("signal")),
                str(count),
            ])
            item.setData(0, _ROLE_ID, tid)
            self._transitions.addTopLevelItem(item)
            if tid == selected:
                self._transitions.setCurrentItem(item)
        self._transitions.resizeColumnToContents(0)

    # -------------------------------------------------------------- flow CRUD

    def _new_flow(self) -> None:
        if self._block_unsafe_action():
            return
        if not self._resolve_event_form_before_context_change("新建任务流"):
            return
        dialog = _NewFlowDialog(self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        if not self._prepare_host_native_mutation():
            return
        try:
            comp = create_flow(
                self._model,
                composition_id=dialog.composition_id.text(),
                graph_id=dialog.graph_id.text(),
                label=dialog.label.text(),
                description=dialog.description.text(),
                initial_state_id=dialog.initial_id.text(),
                initial_state_label=dialog.initial_label.text(),
            )
        except Exception as error:
            QMessageBox.warning(self, "无法新建任务流", str(error))
            return
        self._current_composition_id = _clean(comp.get("id"))
        self._finish_native_mutation(
            ("narrative_graphs",),
            self.reload_refs_from_model,
            status="已创建原生任务流；尚未写盘",
        )

    def _delete_empty_flow(self) -> None:
        if self._block_unsafe_action():
            return
        if not self._resolve_event_form_before_context_change("删除任务流"):
            return
        comp = self._current_comp()
        graph = self._current_graph()
        if not isinstance(comp, dict) or not isinstance(graph, dict):
            return
        states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
        transitions = graph.get("transitions") if isinstance(graph.get("transitions"), list) else []
        elements = comp.get("elements") if isinstance(comp.get("elements"), list) else []
        if len(states) > 1 or transitions or elements:
            QMessageBox.warning(
                self,
                "拒绝删除",
                "无托管清单时不能猜测哪些接线属于工具。这里只允许删除“单一初始阶段、无事件、无元素”的空流。",
            )
            return
        from tools.editor.shared.signal_refactor import scan_graph_usages

        usages = scan_graph_usages(self._model, _clean(graph.get("id")))
        if usages.get("totalRefs"):
            QMessageBox.warning(self, "拒绝删除", f"主图仍有 {usages['totalRefs']} 处原生引用，请先在旧编辑器逐项处理。")
            return
        if QMessageBox.question(self, "删除空任务流", f"删除 {_clean(comp.get('id'))!r}？") != QMessageBox.StandardButton.Yes:
            return
        if not self._prepare_host_native_mutation():
            return
        narrative = copy.deepcopy(self._model.narrative_graphs)
        narrative["compositions"] = [
            row for row in narrative.get("compositions") or []
            if not (isinstance(row, dict) and _clean(row.get("id")) == self._current_composition_id)
        ]
        try:
            commit_model_documents(
                self._model,
                {"narrative_graphs": narrative},
                (("narrative_graphs", ""),),
            )
        except Exception as error:
            QMessageBox.warning(self, "无法删除任务流", str(error))
            return
        self._current_composition_id = ""
        self._finish_native_mutation(
            ("narrative_graphs",),
            self.reload_refs_from_model,
        )

    def _new_state(self) -> None:
        if self._block_unsafe_action():
            return
        if not self._current_composition_id:
            return
        dialog = _NewStateDialog(self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        if not self._prepare_host_native_mutation():
            return
        try:
            create_state(
                self._model,
                self._current_composition_id,
                state_id=dialog.state_id.text(),
                label=dialog.label.text(),
                description=dialog.description.text(),
            )
        except Exception as error:
            QMessageBox.warning(self, "无法新建阶段", str(error))
            return
        self._finish_native_mutation(
            ("narrative_graphs",),
            lambda: (
                self._refresh_states(),
                self._refresh_event_state_candidates_preserving_values(),
            ),
        )

    def _edit_state(self) -> None:
        if self._block_unsafe_action():
            return
        graph = self._current_graph()
        item = self._states.currentItem()
        if graph is None or item is None:
            return
        state_id = _clean(item.data(0, _ROLE_ID))
        dialog = _StateDialog(self._model, graph, state_id, self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        if not self._prepare_host_native_mutation():
            return
        try:
            update_state(
                self._model,
                self._current_composition_id,
                state_id,
                label=dialog.label.text(),
                description=dialog.description.text(),
                initial=dialog.initial.isChecked(),
                exit_state=dialog.exit_state.isChecked(),
                broadcast_on_enter=dialog.broadcast.isChecked(),
                on_enter_actions=dialog.enter_actions.to_list(),
                on_exit_actions=dialog.exit_actions.to_list(),
            )
        except Exception as error:
            QMessageBox.warning(self, "无法更新阶段", str(error))
            return
        self._finish_native_mutation(
            ("narrative_graphs",),
            self._refresh_states,
        )

    def _delete_state(self) -> None:
        if self._block_unsafe_action():
            return
        if not self._resolve_event_form_before_context_change("删除阶段"):
            return
        graph = self._current_graph()
        item = self._states.currentItem()
        if graph is None or item is None:
            return
        state_id = _clean(item.data(0, _ROLE_ID))
        if _clean(graph.get("initialState")) == state_id:
            QMessageBox.warning(self, "拒绝删除", "初始阶段不能删除；请先把另一个阶段设为初始阶段。")
            return
        from tools.editor.shared.signal_refactor import scan_state_usages

        usage = scan_state_usages(self._model, _clean(graph.get("id")), state_id)
        if usage.get("totalRefs") or usage.get("relativeTokenSuspects", {}).get("total"):
            QMessageBox.warning(
                self,
                "拒绝删除",
                f"阶段仍有 {usage.get('totalRefs', 0)} 处明确引用；相对状态引用也可能命中。"
                "请用旧叙事状态机编辑器的重构能力逐项处理。",
            )
            return
        if QMessageBox.question(self, "删除阶段", f"删除阶段 {state_id!r}？") != QMessageBox.StandardButton.Yes:
            return
        if not self._prepare_host_native_mutation():
            return
        narrative = copy.deepcopy(self._model.narrative_graphs)
        comp = find_composition(narrative, self._current_composition_id)
        target = comp.get("mainGraph") if isinstance(comp, dict) else None
        del target["states"][state_id]
        if isinstance(target.get("exitStates"), list):
            target["exitStates"] = [x for x in target["exitStates"] if str(x) != state_id]
            if not target["exitStates"]:
                target.pop("exitStates", None)
        try:
            commit_model_documents(
                self._model,
                {"narrative_graphs": narrative},
                (("narrative_graphs", ""),),
            )
        except Exception as error:
            QMessageBox.warning(self, "无法删除阶段", str(error))
            return
        self._finish_native_mutation(
            ("narrative_graphs",),
            self._refresh_states,
        )

    # ------------------------------------------------------------- event form

    def _reset_event_form(self) -> None:
        graph = self._current_graph()
        states = list((graph.get("states") or {}).keys()) if graph else []
        pairs = [(str(value), _clean((graph.get("states") or {}).get(value, {}).get("label")) or str(value)) for value in states]
        self._event_from.set_items(pairs)
        self._event_to.set_items(pairs)
        self._event_from.set_current(states[0] if states else "")
        self._event_to.set_current(states[1] if len(states) > 1 else "")
        self._event_gate_follows.setChecked(True)
        self._sync_prerequisite_controls()
        self._event_transition_id.clear()
        self._event_signal.clear()
        self._event_scenario_element.clear()
        self._event_scenario_graph.clear()
        self._event_main_signal.clear()
        self._event_entity.set_value("")
        self._event_dialogue.set_value("")
        self._clone_dialogue.setChecked(True)
        self._dialogue_copy_id.clear()
        self._dialogue_copy_id_manual = False
        self._replace_existing_dialogue.setChecked(False)
        self._quest.set_value("")
        self._new_quest.setChecked(False)
        self._last_plan = None
        self._preview.clear()
        self._refresh_visible_entities()
        self._refresh_bindings()
        self._event_form_pending = False

    def _new_event(self) -> None:
        if self._block_unsafe_action():
            return
        if not self._resolve_event_form_before_context_change("编排另一个新事件"):
            return
        self._selected_transition_id = ""
        self._reset_event_form()
        graph = self._current_graph()
        states = list((graph.get("states") or {}).keys()) if graph else []
        if len(states) >= 2:
            self._event_from.set_current(states[-2])
            self._event_to.set_current(states[-1])
            target = re.sub(r"[^0-9A-Za-z_一-鿿]+", "_", str(states[-1])).strip("_")
            self._event_transition_id.setText(f"t_{target}" if target else "t_event")
            self._sync_generated_event_ids()
        self._event_form_pending = True
        self._tabs.setCurrentIndex(1)

    def _on_transition_selected(self, current: QTreeWidgetItem | None, _previous: QTreeWidgetItem | None) -> None:
        self._selected_transition_id = _clean(current.data(0, _ROLE_ID)) if current else ""
        self._refresh_bindings()

    def _open_selected_event(self) -> None:
        graph = self._current_graph()
        if graph is None or not self._selected_transition_id:
            return
        target_transition_id = self._selected_transition_id
        if not self._resolve_event_form_before_context_change("打开另一个事件"):
            return
        self._selected_transition_id = target_transition_id
        transition = next((
            row for row in graph.get("transitions") or []
            if isinstance(row, dict) and _clean(row.get("id")) == target_transition_id
        ), None)
        if not isinstance(transition, dict):
            return
        previous_loading = self._loading
        self._loading = True
        try:
            self._event_transition_id.setText(target_transition_id)
            self._event_from.set_current(_clean(transition.get("from")))
            self._event_to.set_current(_clean(transition.get("to")))
            main_signal = _clean(transition.get("signal"))
            scenario_graph_id = ""
            scenario_element_id = ""
            content_signal = main_signal
            prerequisite_graph_id = _clean(graph.get("id"))
            prerequisite_state_id = _clean(transition.get("from"))
            if main_signal.startswith("state:") and ":" in main_signal[len("state:"):]:
                scenario_graph_id, exit_state = main_signal[len("state:"):].rsplit(":", 1)
                comp = self._current_comp() or {}
                for element in comp.get("elements") or []:
                    scenario_graph = element.get("graph") if isinstance(element, dict) else None
                    if isinstance(scenario_graph, dict) and _clean(scenario_graph.get("id")) == scenario_graph_id:
                        scenario_element_id = _clean(element.get("id"))
                        candidates = [
                            row for row in scenario_graph.get("transitions") or []
                            if isinstance(row, dict)
                            and _clean(row.get("to")) == exit_state
                            and _clean(row.get("signal"))
                        ]
                        if len(candidates) == 1:
                            content_signal = _clean(candidates[0].get("signal"))
                        unlock = next((
                            row for row in scenario_graph.get("transitions") or []
                            if isinstance(row, dict) and _clean(row.get("id")) == "unlock"
                        ), None)
                        conditions = unlock.get("conditions") if isinstance(unlock, dict) else None
                        target_leaf = {
                            "narrative": _clean(graph.get("id")),
                            "state": _clean(transition.get("from")),
                        }
                        leaves = [
                            leaf for leaf in (conditions if isinstance(conditions, list) else [])
                            if isinstance(leaf, dict)
                        ]
                        external = [leaf for leaf in leaves if leaf != target_leaf]
                        leaf = external[0] if len(external) == 1 else (target_leaf if not external else None)
                        if isinstance(leaf, dict):
                            prerequisite_graph_id = _clean(leaf.get("narrative"))
                            prerequisite_state_id = _clean(leaf.get("state"))
                        break
            self._event_signal.setText(content_signal)
            self._event_scenario_graph.setText(scenario_graph_id)
            self._event_scenario_element.setText(scenario_element_id)
            self._event_main_signal.setText(main_signal)
            follows = (
                prerequisite_graph_id == _clean(graph.get("id"))
                and prerequisite_state_id == _clean(transition.get("from"))
            )
            self._event_gate_follows.setChecked(follows)
            self._event_gate_graph.set_value(prerequisite_graph_id)
            self._refresh_prerequisite_states(preferred=prerequisite_state_id)
            self._sync_prerequisite_controls()
            self._clone_dialogue.setChecked(False)
            trigger = next((row for row in self._binding_rows if row.kind == "trigger"), None)
            if trigger:
                self._event_scene.set_value(trigger.scene_id)
                if trigger.entity_kind == "zone":
                    kind = "zone_instant" if "直接发内容信号" in trigger.detail else "zone_dialogue"
                else:
                    kind = f"{trigger.entity_kind}_dialogue"
                index = self._trigger_kind.findData(kind)
                if index >= 0:
                    self._trigger_kind.setCurrentIndex(index)
                self._event_entity.set_value(trigger.entity_id)
                entity = self._lookup_entity(trigger.scene_id, trigger.entity_kind, trigger.entity_id)
                dialogue_id = ""
                if trigger.entity_kind == "npc" and entity:
                    dialogue_id = _clean(entity.get("dialogueGraphId"))
                elif trigger.entity_kind == "hotspot" and entity:
                    data = entity.get("data") if isinstance(entity.get("data"), dict) else {}
                    dialogue_id = _clean(data.get("graphId"))
                elif trigger.entity_kind == "zone" and entity:
                    for action in entity.get("onEnter") or []:
                        if isinstance(action, dict) and _clean(action.get("type")) == "startDialogueGraph":
                            dialogue_id = _clean((action.get("params") or {}).get("graphId"))
                            break
                self._event_dialogue.set_value(dialogue_id)
            self._refresh_visible_entities()
            for index in range(self._visible_entities.topLevelItemCount()):
                item = self._visible_entities.topLevelItem(index)
                key = item.data(0, _ROLE_ID)
                if any(
                    row.kind == "availability" and (row.entity_kind, row.entity_id) == key
                    for row in self._binding_rows
                ):
                    item.setCheckState(0, Qt.CheckState.Checked)
        finally:
            self._loading = previous_loading
        self._event_form_pending = False
        self._tabs.setCurrentIndex(1)

    def _sync_generated_event_ids(self) -> None:
        transition_id = self._event_transition_id.text().strip()
        if self._selected_transition_id and transition_id == self._selected_transition_id:
            return
        comp = re.sub(
            r"[^0-9A-Za-z_一-鿿]+",
            "_",
            self._current_composition_id,
        ).strip("_")
        transition = re.sub(r"[^0-9A-Za-z_一-鿿]+", "_", transition_id).strip("_")
        if not comp or not transition:
            self._event_signal.clear()
            self._event_scenario_element.clear()
            self._event_scenario_graph.clear()
            self._event_main_signal.clear()
            if not self._dialogue_copy_id_manual:
                self._dialogue_copy_id.clear()
            return
        base = f"{comp}__{transition}"
        scenario_graph = f"scenario_{base}"
        self._event_signal.setText(f"{base}__content_completed")
        self._event_scenario_element.setText(f"event_{transition}")
        self._event_scenario_graph.setText(scenario_graph)
        self._event_main_signal.setText(f"state:{scenario_graph}:done")
        if not self._dialogue_copy_id_manual:
            self._dialogue_copy_id.setText(f"{base}__dialogue")

    def _mark_event_pending(self, *_args: object) -> None:
        if not self._loading:
            self._event_form_pending = True

    def _resolve_event_form_before_context_change(self, action: str) -> bool:
        if not self._event_form_pending:
            return True
        answer = QMessageBox.question(
            self,
            action,
            "事件编排表单还有尚未应用的改动。\n\n"
            "“保存”表示先编译并应用到 ProjectModel 内存；“放弃”只丢弃这份表单草稿。",
            QMessageBox.StandardButton.Save
            | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel,
        )
        if answer == QMessageBox.StandardButton.Save:
            self._apply_event()
            return not self._event_form_pending
        if answer == QMessageBox.StandardButton.Discard:
            self._event_form_pending = False
            self._last_plan = None
            return True
        return False

    def _refresh_event_state_candidates_preserving_values(self) -> None:
        graph = self._current_graph()
        states = graph.get("states") if isinstance(graph, dict) else None
        rows = [
            (str(state_id), _clean(state.get("label")) or str(state_id))
            for state_id, state in (states.items() if isinstance(states, dict) else [])
            if isinstance(state, dict)
        ]
        from_state = self._event_from.current_id()
        to_state = self._event_to.current_id()
        self._event_from.set_items(rows)
        self._event_to.set_items(rows)
        ids = {state_id for state_id, _label in rows}
        self._event_from.set_current(from_state if from_state in ids else "")
        self._event_to.set_current(to_state if to_state in ids else "")
        if self._event_gate_follows.isChecked():
            self._sync_prerequisite_controls()

    def _sync_followed_prerequisite(self, *_args: object) -> None:
        graph = self._current_graph()
        if (
            self._event_gate_follows.isChecked()
            or self._event_gate_graph.current_value() == (_clean(graph.get("id")) if graph else "")
        ):
            self._sync_prerequisite_controls()

    def _sync_prerequisite_controls(self, *_args: object) -> None:
        follows = self._event_gate_follows.isChecked()
        graph = self._current_graph()
        main_graph_id = _clean(graph.get("id")) if graph else ""
        if follows:
            self._event_gate_graph.set_value(main_graph_id)
        same_main = self._event_gate_graph.current_value() == main_graph_id
        if follows or same_main:
            self._refresh_prerequisite_states(preferred=self._event_from.current_id())
        self._event_gate_graph.setEnabled(not follows)
        self._event_gate_state.setEnabled(not follows and not same_main)
        self._event_gate_state.setToolTip(
            "同一主图只有一个当前阶段；前置阶段必须与“发生前阶段”一致。"
            if same_main else ""
        )

    def _on_prerequisite_graph_changed(self, _graph_id: str) -> None:
        self._sync_prerequisite_controls()

    def _prerequisite_graph_rows(self) -> list[tuple[str, str, str]]:
        own_scenario = self._event_scenario_graph.text().strip()
        return [
            (gid, gid, "原生叙事图")
            for gid in self._model.narrative_graph_ids_ordered()
            if gid != own_scenario
        ]

    def _refresh_prerequisite_states(self, *, preferred: str = "") -> None:
        graph = find_graph(
            getattr(self._model, "narrative_graphs", None) or {},
            self._event_gate_graph.current_value(),
        )
        states = graph.get("states") if isinstance(graph, dict) else None
        rows = []
        if isinstance(states, dict):
            rows = [
                (str(state_id), _clean(state.get("label")) or str(state_id))
                for state_id, state in states.items()
                if isinstance(state, dict)
            ]
        current = preferred or self._event_gate_state.current_id()
        self._event_gate_state.set_items(rows)
        ids = {state_id for state_id, _label in rows}
        self._event_gate_state.set_current(current if current in ids else (rows[0][0] if rows else ""))

    def _discard_event_form(self) -> None:
        if self._event_form_pending:
            answer = QMessageBox.question(
                self,
                "放弃表单改动",
                "只清空尚未应用的事件表单；已经应用到 ProjectModel 的改动不会撤销。继续吗？",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
            )
            if answer != QMessageBox.StandardButton.Yes:
                return
        self._reset_event_form()
        self._event_form_pending = False

    def _delete_transition(self) -> None:
        if self._block_unsafe_action():
            return
        target_composition_id = self._current_composition_id
        tid = self._selected_transition_id
        if not self._resolve_event_form_before_context_change("安全删除事件"):
            return
        self._selected_transition_id = tid
        graph = self._current_graph()
        if graph is None or not tid:
            return
        if QMessageBox.question(
            self,
            "安全删除事件",
            f"删除主图事件 {tid!r} 及其标准四阶段 scenario 子图？\n\n"
            "玩家触发、阶段门闸和 Quest 镜像必须先在“原生接线”页逐条解绑；"
            "作者信号、对话资产和黑盒元素会保留；只精确清理随 Zone 触发解绑的投影条目。",
        ) != QMessageBox.StandardButton.Yes:
            return
        if not self._prepare_host_native_mutation():
            return
        try:
            delete_event_spine(self._model, target_composition_id, tid)
        except Exception as error:
            QMessageBox.warning(self, "拒绝删除", str(error))
            return
        self._selected_transition_id = ""
        self._finish_native_mutation(
            (
                "narrative_graphs",
                "scene",
                "quest",
                "dialogue_stubs",
                "dialogue_graph_edits",
            ),
            lambda: (self._refresh_transitions(), self._refresh_bindings()),
        )

    def _on_trigger_kind_changed(self) -> None:
        if self._loading:
            return
        self._event_entity.set_value("")
        self._event_entity.refresh_display()
        self._sync_dialogue_controls()

    def _on_event_scene_changed(self, _scene_id: str) -> None:
        self._event_entity.set_value("")
        self._event_entity.refresh_display()
        self._refresh_visible_entities()

    def _request_scene_layout(self) -> None:
        trigger = _clean(self._trigger_kind.currentData())
        if trigger.startswith("zone_"):
            kind = "zone"
        elif trigger == "npc_dialogue":
            kind = "npc"
        else:
            kind = "hotspot"
        self.scene_layout_requested.emit(
            self._event_scene.current_value(),
            kind,
            self._event_entity.current_value(),
        )

    def _event_entity_rows(self) -> list[tuple[str, str, str]]:
        scene_id = self._event_scene.current_value()
        kind = _clean(self._trigger_kind.currentData())
        if kind.startswith("zone_"):
            rows = self._model.standard_zone_ids_for_scene(scene_id)
            entity_kind = "Zone"
        elif kind == "npc_dialogue":
            rows = self._model.npc_ids_for_scene(scene_id)
            entity_kind = "NPC"
        else:
            rows = [
                (value, label)
                for value, label in self._model.hotspot_ids_for_scene(scene_id)
                if _clean((self._lookup_entity(scene_id, "hotspot", value) or {}).get("type")) == "inspect"
            ]
            entity_kind = "Hotspot"
        return [(value, label, f"{entity_kind} · {scene_id}") for value, label in rows]

    def _sync_dialogue_controls(self) -> None:
        instant = _clean(self._trigger_kind.currentData()) == "zone_instant"
        self._dialogue_group.setEnabled(not instant)
        self._dialogue_copy_id.setEnabled(not instant and self._clone_dialogue.isChecked())

    def _sync_quest_controls(self) -> None:
        enabled = self._new_quest.isChecked()
        self._quest.setEnabled(not enabled)
        for widget in (
            self._new_quest_id,
            self._new_quest_group,
            self._new_quest_type,
            self._new_quest_title,
            self._new_quest_description,
        ):
            widget.setEnabled(enabled)

    def _refresh_visible_entities(self) -> None:
        checked: set[tuple[str, str]] = set()
        for index in range(self._visible_entities.topLevelItemCount()):
            item = self._visible_entities.topLevelItem(index)
            if item.checkState(0) == Qt.CheckState.Checked:
                checked.add(item.data(0, _ROLE_ID))
        self._visible_entities.clear()
        scene_id = self._event_scene.current_value()
        scene = (self._model.scenes or {}).get(scene_id) or {}
        for key, kind, title in (("npcs", "npc", "NPC"), ("hotspots", "hotspot", "Hotspot"), ("zones", "zone", "Zone")):
            for entity in scene.get(key) or []:
                if not isinstance(entity, dict) or not _clean(entity.get("id")):
                    continue
                entity_id = _clean(entity.get("id"))
                label = _clean(entity.get("name") or entity.get("label")) or entity_id
                item = QTreeWidgetItem([label, title, str(len(entity.get("conditions") or []))])
                item.setData(0, _ROLE_ID, (kind, entity_id))
                item.setFlags(item.flags() | Qt.ItemFlag.ItemIsUserCheckable)
                item.setCheckState(0, Qt.CheckState.Checked if (kind, entity_id) in checked else Qt.CheckState.Unchecked)
                self._visible_entities.addTopLevelItem(item)

    def _event_spec(self) -> EventBindingSpec:
        visible: list[tuple[str, str]] = []
        for index in range(self._visible_entities.topLevelItemCount()):
            item = self._visible_entities.topLevelItem(index)
            if item.checkState(0) == Qt.CheckState.Checked:
                visible.append(item.data(0, _ROLE_ID))
        new_quest: dict[str, Any] | None = None
        quest_id = self._quest.current_value()
        if self._new_quest.isChecked():
            quest_id = ""
            new_quest = {
                "id": self._new_quest_id.text().strip(),
                "group": self._new_quest_group.current_value(),
                "type": _clean(self._new_quest_type.currentData()) or "side",
                "title": self._new_quest_title.text().strip(),
                "description": self._new_quest_description.text().strip(),
            }
        return EventBindingSpec(
            composition_id=self._current_composition_id,
            transition_id=self._event_transition_id.text().strip(),
            from_state=self._event_from.current_id(),
            to_state=self._event_to.current_id(),
            signal_id=self._event_signal.text().strip(),
            scenario_element_id=self._event_scenario_element.text().strip(),
            scenario_graph_id=self._event_scenario_graph.text().strip(),
            prerequisite_graph_id=self._event_gate_graph.current_value(),
            prerequisite_state_id=self._event_gate_state.current_id(),
            trigger_kind=_clean(self._trigger_kind.currentData()),  # type: ignore[arg-type]
            scene_id=self._event_scene.current_value(),
            trigger_entity_id=self._event_entity.current_value(),
            dialogue_graph_id=self._event_dialogue.current_value(),
            clone_dialogue=self._clone_dialogue.isChecked(),
            dialogue_copy_id=self._dialogue_copy_id.text().strip(),
            visible_entities=tuple(visible),  # type: ignore[arg-type]
            quest_id=quest_id,
            new_quest=new_quest,
            replace_existing_dialogue=self._replace_existing_dialogue.isChecked(),
        )

    def _preview_event(self) -> None:
        if self._block_unsafe_action():
            return
        try:
            plan = build_event_plan(self._model, self._event_spec())
        except Exception as error:
            self._last_plan = None
            self._preview.setPlainText(f"编译被阻断：\n{error}")
            self._tabs.setCurrentIndex(3)
            return
        self._last_plan = plan
        self._preview.setPlainText(plan_text(plan))
        self._tabs.setCurrentIndex(3)

    def _apply_event(self) -> None:
        if self._block_unsafe_action():
            return
        if not self._prepare_host_native_mutation():
            return
        try:
            plan = build_event_plan(self._model, self._event_spec())
            if plan.warnings:
                answer = QMessageBox.question(
                    self,
                    "编译预览有警告",
                    plan_text(plan) + "\n\n仍应用到内存吗？",
                    QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.Cancel,
                )
                if answer != QMessageBox.StandardButton.Yes:
                    return
            apply_compilation_plan(self._model, plan)
        except Exception as error:
            QMessageBox.warning(self, "事件编译失败", str(error))
            return
        self._last_plan = plan
        self._selected_transition_id = self._event_transition_id.text().strip()
        self._event_form_pending = False
        changed_domains: list[str] = []
        if plan.narrative_changed:
            changed_domains.append("narrative_graphs")
        if plan.changed_scene_ids:
            changed_domains.append("scene")
        if plan.quests_changed:
            changed_domains.append("quest")
        if plan.dialogue_stubs:
            changed_domains.append("dialogue_stubs")
        if plan.dialogue_edits:
            changed_domains.append("dialogue_graph_edits")

        def refresh_after_apply() -> None:
            self._preview.setPlainText(plan_text(plan))
            self._refresh_states()
            self._refresh_transitions()
            self._refresh_bindings()
            self._event_dialogue.refresh_display()
            self._quest.refresh_display()

        self._finish_native_mutation(
            changed_domains,
            refresh_after_apply,
            dialogue_catalog_changed=bool(plan.dialogue_stubs or plan.dialogue_edits),
            status="事件已编译进现有原生数据；尚未写盘",
        )

    # ---------------------------------------------------------- reverse scan

    def _refresh_bindings(self) -> None:
        self._bindings.clear()
        self._binding_rows = []
        if not self._current_composition_id or not self._selected_transition_id:
            return
        self._binding_rows = scan_event_bindings(
            self._model,
            self._current_composition_id,
            self._selected_transition_id,
        )
        labels = {
            "scenario": "事件子图",
            "availability": "主线阶段门闸",
            "trigger": "玩家触发",
            "quest": "Quest 镜像",
        }
        for index, row in enumerate(self._binding_rows):
            item = QTreeWidgetItem([
                labels.get(row.kind, row.kind),
                row.owner,
                row.path,
                row.detail,
            ])
            item.setData(0, _ROLE_ID, index)
            self._bindings.addTopLevelItem(item)
        for column in range(3):
            self._bindings.resizeColumnToContents(column)

    def _remove_selected_binding(self) -> None:
        if self._block_unsafe_action():
            return
        item = self._bindings.currentItem()
        if item is None:
            return
        try:
            index = int(item.data(0, _ROLE_ID))
            binding = self._binding_rows[index]
        except (TypeError, ValueError, IndexError):
            QMessageBox.warning(self, "无法解绑", "所选接线已失效，请重新扫描。")
            return
        target_composition_id = self._current_composition_id
        target_transition_id = self._selected_transition_id
        if not self._resolve_event_form_before_context_change("解绑原生接线"):
            return
        self._selected_transition_id = target_transition_id
        if QMessageBox.question(
            self,
            "解绑原生接线",
            f"只移除这一条接线？\n\n{binding.path}\n{binding.detail}",
        ) != QMessageBox.StandardButton.Yes:
            return
        if not self._prepare_host_native_mutation():
            return
        try:
            remove_event_binding(
                self._model,
                target_composition_id,
                target_transition_id,
                binding,
            )
        except Exception as error:
            QMessageBox.warning(self, "无法解绑", str(error))
            return
        binding_domains = {
            "scenario": ("narrative_graphs",),
            "availability": ("scene",),
            # Removing a Zone trigger can also remove the matching blackbox
            # projection from narrative_graphs.
            "trigger": (
                ("scene", "narrative_graphs")
                if binding.entity_kind == "zone"
                else ("scene",)
            ),
            "quest": ("quest",),
        }.get(binding.kind, ())
        self._finish_native_mutation(
            binding_domains,
            lambda: (self._refresh_bindings(), self._refresh_transitions()),
            status="已解绑一条明确选中的原生接线；尚未写盘",
        )

    def _lookup_entity(self, scene_id: str, kind: str, entity_id: str) -> dict[str, Any] | None:
        scene = (self._model.scenes or {}).get(scene_id) or {}
        key = {"npc": "npcs", "hotspot": "hotspots", "zone": "zones"}.get(kind, "")
        for row in scene.get(key) or []:
            if isinstance(row, dict) and _clean(row.get("id")) == entity_id:
                return row
        return None
