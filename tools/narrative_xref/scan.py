"""单遍扫描全工程，建出「每条信号的两侧」索引。

为什么是**一遍建全部**而不是「查一条扫一次」：面板要能列全表（哪些信号没人发、哪些
发了没人听），逐条扫就得扫 N 遍；而全量扫一次只读一遍盘（百来张对话图 + 场景 + 数据
文件），换来切换信号零延迟。索引是**只读快照**，不持有任何模型引用、不改任何数据。

口径与 `agent_docs/editor-tools/mechanisms/emitted-signal-catalog.md` 一致：
实发四源（对话图 / 内容资产动作树 / 叙事图 state 动作 / broadcastOnEnter 派生）算发射，
黑盒 `meta.emits` 只算声明。parity 测试拿 `narrative_catalog.emitted_signal_ids` 逐条对账，
漂了就红。

**接收方只有转移**：运行时把信号排进 NarrativeStateManager 的队列，只有 transition 的
`signal` 会被匹配；别的系统听的是 `narrative:stateChanged`（状态变了），不是信号本身。
所以"接收方"这一栏天然完备，不必再去别处找。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

from .model import (
    CHANNEL_ASSET,
    CHANNEL_BROADCAST,
    CHANNEL_DIALOGUE,
    CHANNEL_NARRATIVE_ACTION,
    CHANNEL_UPSTREAM,
    DIAG_BROADCAST_OFF,
    DIAG_DECLARED_ONLY,
    DIAG_DRAFT,
    DIAG_NO_EMITTER,
    DIAG_NO_LISTENER,
    DIAG_ORPHAN,
    DIAG_REACTIVE_ONLY,
    DIAG_STATE_DEAD_END,
    DIAG_STATE_MISSING,
    DIAG_STATE_NO_WAY_IN,
    DIAG_STATE_UNUSED,
    DIAG_UNREACHABLE,
    DIAG_UNREGISTERED,
    DRAFT_SIGNAL,
    Declaration,
    Diagnostic,
    Emitter,
    KIND_AUTHOR,
    KIND_DERIVED,
    KIND_DRAFT,
    KIND_UNKNOWN,
    Listener,
    SignalCard,
    StateCard,
    StateRead,
    derived_signal_key,
    is_derived,
    parse_derived,
    REACTIVE_TRIGGERS,
    transition_is_unwired,
)
from .phrases import CONTAINER_KEYS, SKIP_KEYS, condition_parts, join_trail, pending_label, plain_label
from .sources import XrefSource

# 递归兜底闸：真实数据最深十几层，200 层只可能是环或病态数据。
_MAX_WALK_DEPTH = 200

EMIT_ACTION = "emitNarrativeSignal"
STATE_COMMAND_ACTION = "setNarrativeState"

# params 带 graphId 的动作（镜像 signal_refactor._GRAPH_PARAM_ACTION_TYPES，parity 测试锁定）。
# 只有 setNarrativeState 真的 enterState（会广播）；活计四件套只改 activeStates，
# **不走 enterState、不广播**（NarrativeStateManager.applyStartRun/applyResetRun/applyRevertRun）
# ——所以它们算"引用了这个状态"，不算"能让它广播的路"。
GRAPH_PARAM_ACTIONS = frozenset({
    "setNarrativeState", "startNarrativeRun", "resetNarrativeRun",
    "revertNarrativeRun", "activateNarrativeRun",
})

# 图对话里直接读叙事状态的两类节点：节点自身带图引用，cases[].state 是状态引用
# （镜像 signal_refactor._DIALOGUE_STATE_NODE_TYPES）。
DIALOGUE_STATE_NODES: dict[str, str] = {
    "ownerState": "wrapperGraphId",
    "contextState": "graphId",
}



def _as_list(value: Any) -> list:
    """把外部 JSON 里"应该是数组"的字段安全取成 list。

    编辑器里半截数据是常态（手改坏了、被别的工具写坏了、老格式）。`x or []` 只挡得住
    None/空，遇到 `{"compositions": 5}` 会当场 `TypeError: 'int' object is not iterable`
    —— 面板整块空白、调试器一点按钮就抛。fail-safe 不 fail-open：读不出来就当没有。
    """
    return value if isinstance(value, list) else []


def _text(value: Any) -> str:
    return str(value or "").strip()


def _comp_label(comp: Any) -> str:
    """这条线叫什么：自己的 label > 主图的 label > 原始 id。

    编辑器新建的线不写 label 是常态（`composition_3`），四处清单里摆一串原始 id，
    人根本认不出哪条线装着自己刚画的图。口径与调试器索引同款
    （tools/narrative_debugger/model.py 的 `_composition_display`）。
    """
    if not isinstance(comp, dict):
        return ""
    label = _text(comp.get("label"))
    if label:
        return label
    main = comp.get("mainGraph")
    if isinstance(main, dict):
        main_label = _text(main.get("label")) or _text(main.get("id"))
        if main_label:
            return main_label
    return _text(comp.get("id"))


def _esc(seg: Any) -> str:
    """JSON Pointer 段转义（RFC 6901），与 tools/json_lang/search.py 同款。"""
    return str(seg).replace("~", "~0").replace("/", "~1")


@dataclass
class GraphMeta:
    """一张叙事图的身份与标签，供两侧清单说人话。"""

    graph_id: str
    label: str = ""
    composition_id: str = ""
    composition_label: str = ""
    element_id: str = ""
    pointer: str = ""                       # 该图在 narrative_graphs.json 内的指针
    initial_state: str = ""
    # 活计图（有 run 声明）：运行时只有"当前激活的那一个"才吃信号，挂起的一个都不接
    is_run: bool = False
    state_labels: dict[str, str] = field(default_factory=dict)
    broadcast_states: set[str] = field(default_factory=set)

    def state_label(self, state_id: str) -> str:
        return self.state_labels.get(state_id, "") or state_id


@dataclass
class ScanStats:
    dialogues: int = 0
    assets: int = 0
    graphs: int = 0
    transitions: int = 0


@dataclass
class _Hit:
    """一处命中：指针（跳转用）、anchors（跳转用）、人话路径（给人看）。"""

    pointer: str
    anchors: list[list[str]]
    trail: list[str]
    node: dict[str, Any]
    # 与 anchors 平行的「显示名链」：anchors 只收 id（宿主按 id 跳转），这条收人看的名字，
    # 于是没有 id 的条目（map_config 的节点）也能在标题里认得出是哪一个。
    labels: list[str] = field(default_factory=list)
    # 「主体链」：(容器键, id, 人看的名字, 那个 dict 本身)，由外到内。
    # 策划盯的是实体和流程——命中处要能回答"这管的是世界里的哪个东西"，
    # 而不是甩一串 npcs[3].conditions[0]。
    subjects: list[tuple[str, str, str, dict[str, Any]]] = field(default_factory=list)

    @property
    def where(self) -> str:
        return join_trail(self.trail)

    @property
    def outer_id(self) -> str:
        return self.anchors[0][1] if self.anchors else ""

    @property
    def outer_label(self) -> str:
        return self.labels[0] if self.labels else ""

    @property
    def subject(self) -> tuple[str, str, str, dict[str, Any]] | None:
        """最里面那个"真东西"。条件叶自己不算主体（它没有 id、也不是世界里的东西）。"""
        return self.subjects[-1] if self.subjects else None


class SignalIndex:
    """全工程信号两侧的只读索引。建好之后所有查询都是内存操作。"""

    def __init__(self, source: XrefSource) -> None:
        self.origin = source.origin
        self.narrative_file = source.narrative_file
        self.graphs: dict[str, GraphMeta] = {}
        self.emitters: dict[str, list[Emitter]] = {}
        self.declarations: dict[str, list[Declaration]] = {}
        self.listeners: dict[str, list[Listener]] = {}
        self.transitions_into: dict[tuple[str, str], list[Listener]] = {}
        self.transitions_out: dict[tuple[str, str], list[Listener]] = {}
        # 反应式转移的 signal 字段里填了真信号名的那些。运行时**根本不看**这个字段
        # （reactive 靠条件自评估），所以它不算监听；但策划确实在那儿写了名字，
        # 不说一声，卡上就只有一句"没人听"，人会以为"我明明接了啊"。
        self.reactive_refs: dict[str, list[Listener]] = {}
        self.state_commands: dict[tuple[str, str], list[Emitter]] = {}
        self.state_reads: dict[tuple[str, str], list[StateRead]] = {}
        self.registry: dict[str, dict[str, Any]] = {}
        self._pending_conditions: list[tuple[Listener, Any]] = []
        # 图**指针** → 该图 transitions 的 id 列表（按原始下标对齐）。读状态行的指针里
        # 只有下标，要翻成 transition id 才能在画布上定位。
        # ⚠ 两处坑：① 非 dict 元素也必须占位（否则后面每条都错位一格，跳到别的转移上——
        # 比跳不过去更坏）；② 按图 id 建键会让同 id 的两张图串成一条列表。
        self._graph_transitions: dict[str, list[str]] = {}
        self.stats = ScanStats()
        self._build(source)

    # ------------------------------------------------------------------ 建索引
    def _build(self, source: XrefSource) -> None:
        self._scan_registry(source.narrative)
        self._scan_graphs(source.narrative)
        self._scan_declarations(source.narrative)
        # 叙事图自身：整份文件扫一遍（口径必须等于 emitted_signal_ids 的全文件扫描），
        # 命中再按人话路径归属到图/状态。
        self._scan_container(
            source.narrative, self.narrative_file, CHANNEL_NARRATIVE_ACTION,
            "narrativeGraph", "", "叙事状态机",
        )
        for doc in source.dialogues:
            self.stats.dialogues += 1
            self._scan_container(
                doc.doc, doc.file, CHANNEL_DIALOGUE, "dialogue", doc.graph_id, "对话图",
            )
        for asset in source.assets:
            self.stats.assets += 1
            self._scan_container(
                asset.root, asset.file, CHANNEL_ASSET, asset.kind, asset.item_id, asset.label,
                readonly=asset.readonly, collect_emits=asset.scan_emits,
                pointer_prefix=asset.pointer_prefix,
            )
        self._attach_narrative_coords()
        self._render_conditions()
        self._sort_all()

    def _attach_narrative_coords(self) -> None:
        """给叙事文件内的发射行补上画布坐标（编排/图/状态）。

        这类行的正确跳法是**画布定位**：它本来就在叙事状态机这一页。走宿主文件跳转的话，
        narrative_graphs.json 那条分支只认 `states/<id>`，转移/条件的指针落不到点，只会
        退化成 `_nav_hit_generic("叙事状态机")`——回执如实写着「未逐条定位」（宿主不谎报），
        但画面纹丝不动：人本来就在这一页，看起来就是按钮坏了。
        """
        prefixes = sorted(
            ((meta.pointer, meta) for meta in self.graphs.values() if meta.pointer),
            key=lambda item: len(item[0]), reverse=True,
        )
        def attach(row: Any, keep_graph: bool) -> None:
            """把叙事文件内的一行定位翻成画布坐标。keep_graph=True 的行（读状态）自带
            graph_id（那是"被读的那张图"），不能拿它当"这行在哪张图里"的判据。"""
            if row.file != self.narrative_file or not row.pointer:
                return
            if not keep_graph and row.graph_id:
                return
            for prefix, meta in prefixes:
                if not row.pointer.startswith(prefix + "/"):
                    continue
                segs = [x.replace("~1", "/").replace("~0", "~")
                        for x in row.pointer[len(prefix):].split("/")[1:]]
                row.composition_id = meta.composition_id
                row.element_id = meta.element_id
                if not keep_graph:
                    row.graph_id = meta.graph_id
                    if len(segs) >= 2 and segs[0] == "states":
                        row.state_id = segs[1]
                else:
                    row.host_graph_id = meta.graph_id
                    # 主体链最里层是 transitions/states 这种**容器**，直接用会渲染成
                    # 「叙事图「t_2」」——既没说是哪张图，t_2 也不是图（审查坐实 24/371）。
                    if row.subject_kind == "narrative":
                        row.subject_id = meta.graph_id
                        row.subject_name = meta.label
                    if len(segs) >= 2 and segs[0] == "transitions":
                        idx = int(segs[1]) if segs[1].isdigit() else -1
                        rows_ = _as_list(self._graph_transitions.get(meta.pointer))
                        if 0 <= idx < len(rows_):
                            row.host_transition_id = rows_[idx]
                break

        for rows in self.emitters.values():
            for row in rows:
                attach(row, keep_graph=False)
        for srows in self.state_reads.values():
            for row in srows:
                attach(row, keep_graph=True)

    def _render_conditions(self) -> None:
        """条件的人话渲染必须等**所有图都扫完**：急着在扫描途中渲染，前向引用的图还没
        进目录，同一块面板上就会一半说中文名、一半甩原始 id。"""
        for row, raw in self._pending_conditions:
            row.conditions = [p for p in condition_parts(raw, self._state_phrase) if p]
        self._pending_conditions = []

    def _scan_registry(self, narrative: Any) -> None:
        rows = narrative.get("signals") if isinstance(narrative, dict) else None
        if not isinstance(rows, list):
            return
        for i, row in enumerate(rows):
            if not isinstance(row, dict):
                continue
            sid = _text(row.get("id"))
            if not sid or sid in self.registry:
                continue
            self.registry[sid] = {
                "index": i,
                "label": _text(row.get("label")),
                "notes": _text(row.get("notes")) or _text(row.get("description")),
                # 作用域原样带出（'private' / 'global' / 空=缺省全局）。丢掉它，界面上
                # 私有信号与全局信号长得一模一样，而两者的投递面差着天——私有那条只到
                # 发射方 owner 自己的 wrapper 图，缺 owner 直接丢弃（不回落成广播）。
                "scope": _text(row.get("scope")),
            }

    def _iter_graphs(self, narrative: Any) -> Iterator[tuple[dict[str, Any], str, dict[str, Any], str]]:
        """(图, 图指针, 所属编排, 元素 id)；覆盖 mainGraph / elements[].graph / 顶层 graphs。"""
        if not isinstance(narrative, dict):
            return
        for ci, comp in enumerate(_as_list(narrative.get("compositions"))):
            if not isinstance(comp, dict):
                continue
            main = comp.get("mainGraph")
            if isinstance(main, dict):
                yield main, f"/compositions/{ci}/mainGraph", comp, ""
            for ei, element in enumerate(_as_list(comp.get("elements"))):
                if not isinstance(element, dict):
                    continue
                graph = element.get("graph")
                if isinstance(graph, dict):
                    yield graph, f"/compositions/{ci}/elements/{ei}/graph", comp, _text(element.get("id"))
        for gi, graph in enumerate(_as_list(narrative.get("graphs"))):
            if isinstance(graph, dict):
                yield graph, f"/graphs/{gi}", {}, ""

    def _scan_graphs(self, narrative: Any) -> None:
        for graph, pointer, comp, element_id in self._iter_graphs(narrative):
            gid = _text(graph.get("id"))
            if not gid:
                continue
            meta = GraphMeta(
                graph_id=gid,
                label=_text(graph.get("label")) or gid,
                composition_id=_text(comp.get("id")),
                composition_label=_comp_label(comp),
                element_id=element_id,
                pointer=pointer,
                initial_state=_text(graph.get("initialState")),
                is_run=isinstance(graph.get("run"), dict),
            )
            states = graph.get("states")
            if isinstance(states, dict):
                for sid, state in states.items():
                    key = _text(sid)
                    if not key:
                        continue
                    meta.state_labels[key] = _text(state.get("label")) if isinstance(state, dict) else ""
                    if isinstance(state, dict) and state.get("broadcastOnEnter") is True:
                        meta.broadcast_states.add(key)
            # 同 id 图重复登记时目录以先出现者为准（校验另有 error 报重复 id），但转移仍按
            # **它自己那张图**的标签渲染——不然重名图的清单会指到另一张图的状态名上。
            self.graphs.setdefault(gid, meta)
            self.stats.graphs += 1
            self._scan_transitions(graph, meta, pointer)
            for sid in sorted(meta.broadcast_states):
                signal = derived_signal_key(gid, sid)
                self.emitters.setdefault(signal, []).append(Emitter(
                    signal=signal,
                    channel=CHANNEL_BROADCAST,
                    container_kind="narrativeGraph",
                    container_id=gid,
                    container_label=meta.label,
                    kind_label="叙事图",
                    where=f"状态「{meta.state_label(sid)}」",
                    context=f"进入这一拍就自动广播（{meta.composition_label or meta.composition_id}）",
                    file=self.narrative_file,
                    pointer=f"{pointer}/states/{_esc(sid)}",
                    composition_id=meta.composition_id,
                    element_id=meta.element_id,
                    graph_id=gid,
                    state_id=sid,
                ))

    def _scan_transitions(self, graph: dict[str, Any], meta: GraphMeta, pointer: str) -> None:
        # 先按原始下标登记 id（含非 dict 的占位空串），再逐条扫——两件事的下标必须同源。
        self._graph_transitions[pointer] = [
            _text(t.get("id")) if isinstance(t, dict) else ""
            for t in _as_list(graph.get("transitions"))
        ]
        for ti, transition in enumerate(_as_list(graph.get("transitions"))):
            if not isinstance(transition, dict):
                continue
            self.stats.transitions += 1
            trigger = _text(transition.get("trigger"))
            signal = _text(transition.get("signal"))
            from_state = _text(transition.get("from"))
            to_state = _text(transition.get("to"))
            try:
                priority = int(transition.get("priority") or 0)
            except (TypeError, ValueError):
                priority = 0
            row = Listener(
                signal=signal,
                how=_transition_how(signal, trigger),
                composition_id=meta.composition_id,
                composition_label=meta.composition_label,
                graph_id=meta.graph_id,
                graph_label=meta.label,
                element_id=meta.element_id,
                transition_id=_text(transition.get("id")),
                from_state=from_state,
                from_label=meta.state_label(from_state),
                to_state=to_state,
                to_label=meta.state_label(to_state),
                run_graph=meta.is_run,
                priority=priority,
                trigger=trigger,
                file=self.narrative_file,
                pointer=f"{pointer}/transitions/{ti}",
            )
            # 反应式转移不吃信号：它的 signal 字段是占位，登记成监听就是造假的接收方。
            if signal and trigger not in REACTIVE_TRIGGERS:
                self.listeners.setdefault(signal, []).append(row)
            elif signal and signal != DRAFT_SIGNAL:
                self.reactive_refs.setdefault(signal, []).append(row)
            if to_state:
                self.transitions_into.setdefault((meta.graph_id, to_state), []).append(row)
            if from_state:
                self.transitions_out.setdefault((meta.graph_id, from_state), []).append(row)
            # 条件原文先留着，人话等全部图扫完再渲染（见 _render_conditions）
            self._pending_conditions.append((row, transition.get("conditions") or []))

    def _scan_declarations(self, narrative: Any) -> None:
        if not isinstance(narrative, dict):
            return
        for ci, comp in enumerate(_as_list(narrative.get("compositions"))):
            if not isinstance(comp, dict):
                continue
            for ei, element in enumerate(_as_list(comp.get("elements"))):
                if not isinstance(element, dict):
                    continue
                meta = element.get("meta")
                emits = meta.get("emits") if isinstance(meta, dict) else None
                if not isinstance(emits, list):
                    continue
                for si, raw in enumerate(_as_list(emits)):
                    signal = _text(raw)
                    if not signal:
                        continue
                    self.declarations.setdefault(signal, []).append(Declaration(
                        signal=signal,
                        composition_id=_text(comp.get("id")),
                        composition_label=_comp_label(comp),
                        element_id=_text(element.get("id")),
                        element_label=_text(element.get("label")) or _text(element.get("id")),
                        element_kind=_text(element.get("kind")),
                        ref_id=_text(element.get("refId")),
                        file=self.narrative_file,
                        pointer=f"/compositions/{ci}/elements/{ei}/meta/emits/{si}",
                    ))

    def _scan_container(
        self,
        root: Any,
        file: str,
        channel: str,
        container_kind: str,
        container_id: str,
        kind_label: str,
        readonly: bool = False,
        collect_emits: bool = True,
        pointer_prefix: str = "",
    ) -> None:
        """扫一份文档，收「发射 / 强制设状态 / 条件读状态」三类命中。

        `container_id` 为空 = 这份文件装的是一堆条目（quests.json 之类），此时具体条目
        id 从 anchors 的最外层取——那正是主编辑器跳转引擎认的 `outer_id`。

        `readonly` = 主编辑器只加载不保存的数据面：命中照收（目录要诚实），但要打上标记，
        界面据此说明"跳不过去"，而不是给一颗按下去必然失败的按钮。
        """

        def owner(hit: _Hit) -> str:
            # 没有 id 的条目（map_config 节点）退到显示名：标题写「地图节点「」」
            # 等于让人去十几个节点里自己猜是哪一个。
            return container_id or hit.outer_id or hit.outer_label

        def on_emit(signal: str, hit: _Hit) -> None:
            if not collect_emits:
                # 条件面（地图/物品/规矩…）只扫引用：把它们算进发射会与
                # narrative_catalog.emitted_signal_ids 的权威口径打架。
                return
            owner_type, owner_id = _owner_binding(hit.node)
            self.emitters.setdefault(signal, []).append(Emitter(
                owner_type=owner_type,
                owner_id=owner_id,
                signal=signal,
                channel=channel,
                container_kind=container_kind,
                container_id=owner(hit),
                container_label=owner(hit),
                kind_label=kind_label,
                where=_trim_container_prefix(hit.where, owner(hit)),
                context=_context_for(channel, root, hit),
                note=_source_note(hit.node),
                file=file,
                pointer=hit.pointer,
                anchors=hit.anchors,
                readonly=readonly,
            ))

        def on_command(graph_id: str, state_id: str, hit: _Hit) -> None:
            self.state_commands.setdefault((graph_id, state_id), []).append(Emitter(
                signal="",
                channel=CHANNEL_UPSTREAM,
                container_kind=container_kind,
                container_id=owner(hit),
                container_label=owner(hit),
                kind_label=kind_label,
                where=_trim_container_prefix(hit.where, owner(hit)),
                context="强制设状态",
                note="调试专用动作（setNarrativeState），正式内容不该依赖它",
                file=file,
                pointer=hit.pointer,
                anchors=hit.anchors,
                readonly=readonly,
            ))

        def on_condition(graph_id: str, state_id: str, hit: _Hit) -> None:
            row = StateRead(
                graph_id=graph_id,
                state_id=state_id,
                container_kind=container_kind,
                container_id=owner(hit),
                kind_label=kind_label,
                where=_trim_container_prefix(hit.where, owner(hit)),
                file=file,
                pointer=hit.pointer,
                readonly=readonly,
                anchors=hit.anchors,
            )
            # 判据对齐运行时 evaluateGraphCondition.ts（`=== true`）与仓库其余六处（`is True`）：
            # 写 "reached": false 是合法数据，用 `is not None` 会把它说成「到过」。
            row.reached = isinstance(hit.node, dict) and hit.node.get("reached") is True
            # 「不满足」是 phrases.CONDITION_KEYS['not'] 的译名——走查时已经写进人话路径，
            # 这里按它反查，省得再解析一遍条件树（两处解析必然漂）。
            # 嵌套 not 要按**奇偶**算：双重否定等于没否定，判成取反会把结论说反。
            row.negated = sum(1 for seg in hit.trail if seg == "不满足") % 2 == 1
            _fill_subject(row, hit, container_kind, container_id)
            self.state_reads.setdefault((graph_id, state_id), []).append(row)

        _walk(root, pointer_prefix, [], [], [], "", None, [], on_emit, on_command, on_condition)

    def _sort_all(self) -> None:
        """稳定排序：同一份数据每次扫出的顺序必须一致，否则界面每次刷新都在跳。"""
        for erows in self.emitters.values():
            erows.sort(key=lambda e: (_CHANNEL_ORDER.get(e.channel, 9), e.container_kind, e.container_id, e.pointer))
        for drows in self.declarations.values():
            drows.sort(key=lambda d: (d.composition_id, d.element_id, d.pointer))
        for lrows in self.listeners.values():
            lrows.sort(key=lambda l: (l.composition_id, l.graph_id, l.transition_id))
        for lrows in self.reactive_refs.values():
            lrows.sort(key=lambda l: (l.composition_id, l.graph_id, l.transition_id))
        for lrows in self.transitions_out.values():
            lrows.sort(key=lambda l: (l.composition_id, l.graph_id, l.transition_id))
        for lrows in self.transitions_into.values():
            lrows.sort(key=lambda l: (l.composition_id, l.graph_id, l.transition_id))
        for erows in self.state_commands.values():
            erows.sort(key=lambda e: (e.container_kind, e.container_id, e.pointer))
        for srows in self.state_reads.values():
            srows.sort(key=lambda s: (s.container_kind, s.container_id, s.pointer))

    # ------------------------------------------------------------------ 查询
    def _state_phrase(self, graph_id: str, state_id: str, verb: str) -> str:
        meta = self.graphs.get(graph_id)
        if meta is None:
            return f"「{graph_id}」{verb}「{state_id}」"
        return f"「{meta.label}」{verb}「{meta.state_label(state_id)}」"

    def all_signal_ids(self) -> list[str]:
        """出现过的全部信号：注册表 ∪ 监听 ∪ 实发 ∪ 声明（草稿信号排最后）。"""
        ids = set(self.registry) | set(self.listeners) | set(self.emitters) | set(self.declarations)
        ids.discard("")
        return sorted(ids, key=lambda s: (s == DRAFT_SIGNAL, s))

    def kind_of(self, signal: str) -> str:
        if signal == DRAFT_SIGNAL:
            return KIND_DRAFT
        if is_derived(signal):
            return KIND_DERIVED
        return KIND_AUTHOR if signal in self.registry else KIND_UNKNOWN

    def card(self, signal: str) -> SignalCard:
        sid = _text(signal)
        kind = self.kind_of(sid)
        row = self.registry.get(sid, {})
        card = SignalCard(
            signal=sid,
            kind=kind,
            label=row.get("label", ""),
            notes=row.get("notes", ""),
            scope=row.get("scope", ""),
            registered=sid in self.registry,
            emitters=list(self.emitters.get(sid, [])),
            declarations=list(self.declarations.get(sid, [])),
            listeners=list(self.listeners.get(sid, [])),
            reactive_refs=list(self.reactive_refs.get(sid, [])),
        )
        if kind == KIND_DERIVED:
            self._fill_derived(card)
        card.diagnostics = self._diagnose(card)
        return card

    def _fill_derived(self, card: SignalCard) -> None:
        """派生信号：补上「谁让这一拍发生」——只说"进入时自动发"等于没回答。"""
        parsed = parse_derived(card.signal)
        if parsed is None:
            return
        graph_id, state_id = parsed
        card.source_graph_id = graph_id
        card.source_state_id = state_id
        meta = self.graphs.get(graph_id)
        if meta is not None:
            card.source_graph_label = meta.label
            card.source_state_label = meta.state_label(state_id)
        card.state_reads = list(self.state_reads.get((graph_id, state_id), []))

        upstream: list[Emitter] = []
        for row in self.transitions_into.get((graph_id, state_id), []):
            # 「还没接线」的判据走共享层（model.transition_is_unwired）：占位信号运行时
            # 明确拒发，说成"收到信号 __draft__ 时走"就是给人一条走不通的路。
            wired = not transition_is_unwired(row.signal, row.trigger)
            if row.trigger in REACTIVE_TRIGGERS:
                trigger_text = "条件满足就自动走"
            elif not wired:
                trigger_text = "这条路还没接线（占位信号，运行时不会发）"
            elif row.signal:
                trigger_text = f"收到信号「{row.signal}」时走"
            else:
                trigger_text = "没接触发条件"
            if row.conditions:
                trigger_text += "；还要满足：" + " 且 ".join(row.conditions)
            upstream.append(Emitter(
                wired=wired,
                signal=card.signal,
                channel=CHANNEL_UPSTREAM,
                container_kind="narrativeGraph",
                container_id=row.graph_id,
                container_label=row.graph_label,
                kind_label="上游转移",
                where=f"{row.from_label} → {row.to_label}",
                context=trigger_text,
                file=row.file,
                pointer=row.pointer,
                composition_id=row.composition_id,
                element_id=row.element_id,
                graph_id=row.graph_id,
                transition_id=row.transition_id,
            ))
        for cmd in self.state_commands.get((graph_id, state_id), []):
            upstream.append(Emitter(
                signal=card.signal,
                channel=cmd.channel,
                container_kind=cmd.container_kind,
                container_id=cmd.container_id,
                container_label=cmd.container_label,
                kind_label=cmd.kind_label,
                where=cmd.where,
                context=cmd.context,
                note=cmd.note,
                file=cmd.file,
                pointer=cmd.pointer,
                anchors=cmd.anchors,
            ))
        card.emitters = list(card.emitters) + upstream

    def _diagnose(self, card: SignalCard) -> list[Diagnostic]:
        out: list[Diagnostic] = []
        real_emits = card.real_emitter_count
        listeners = len(card.listeners)
        if card.signal == DRAFT_SIGNAL:
            out.append(Diagnostic(
                DIAG_DRAFT, "info",
                "草稿占位信号：运行时拒绝发出。转移接在它上面 = 这条路还没接线（编辑器合法占位）",
            ))
            return out
        if card.kind == KIND_DERIVED:
            ups = [e for e in card.emitters if e.channel == CHANNEL_UPSTREAM]
            broadcasting = any(e.channel == CHANNEL_BROADCAST for e in card.emitters)
            meta_src = self.graphs.get(card.source_graph_id)
            # 初始状态本来就没有上游转移，且下面已有一条专门的诊断说明"开局停在这儿不算广播"——
            # 这里再报一次就是两条话说同一件事。
            is_initial = meta_src is not None and meta_src.initial_state == card.source_state_id
            if broadcasting and not ups and not is_initial:
                out.append(Diagnostic(
                    DIAG_UNREACHABLE, "warning",
                    "没有任何路能进到这一拍（没有转移指向它、也没有强制设状态），"
                    "所以这条广播发不出来",
                ))
            elif ups and not any(e.wired for e in ups):
                out.append(Diagnostic(
                    DIAG_UNREACHABLE, "warning",
                    f"能进这一拍的 {len(ups)} 条路全都还没接线（占位信号运行时不会发），"
                    "所以这条广播现在发不出来",
                ))
            parsed = parse_derived(card.signal)
            if parsed is None:
                out.append(Diagnostic(
                    DIAG_BROADCAST_OFF, "error",
                    "派生信号名不合法：应形如 state:<图 id>:<状态 id>",
                ))
            else:
                meta = self.graphs.get(parsed[0])
                if meta is None or parsed[1] not in meta.state_labels:
                    out.append(Diagnostic(
                        DIAG_BROADCAST_OFF, "error",
                        f"派生信号指向不存在的状态：{parsed[0]}.{parsed[1]}",
                    ))
                elif parsed[1] not in meta.broadcast_states:
                    out.append(Diagnostic(
                        DIAG_BROADCAST_OFF, "error",
                        f"状态「{meta.state_label(parsed[1])}」没勾「进入时广播」，这条信号永远不会发出",
                    ))
                # 初始状态勾了「进入时广播」= 白勾：注册图/start/reset 都是直接 set
                # activeStates，**不走 enterState、不广播**（NarrativeStateManager
                # registerGraphs / applyStartRun / applyResetRun）。只有真的走一条转移
                # 进来才广播——不说清楚，这条信号会被当成"开局就发"。
                if meta is not None and meta.initial_state == parsed[1]:
                    out.append(Diagnostic(
                        DIAG_BROADCAST_OFF, "warning",
                        # 界面直出纯文本（Qt QLabel / React 文本节点都不认 markdown），
                        # 写 **强调** 只会原样显示成星号。
                        f"这是「{meta.label}」的初始状态：开局停在这一拍并不会广播"
                        "（运行时只有真的走一条转移进来才广播）",
                    ))
        elif card.kind == KIND_UNKNOWN and (real_emits or listeners or card.declarations):
            # 两侧全空时不报这条：下面那条「查无此名」把同一件事说得更清楚，
            # 两条并排等于同一件事说两遍。
            out.append(Diagnostic(
                DIAG_UNREGISTERED, "warning",
                "这条信号没在信号注册表里登记过（校验会一直报未登记；"
                "运行时照样按名字触发，只是没有可维护的中文名和注释）",
            ))
        if listeners and real_emits == 0:
            if card.declarations:
                out.append(Diagnostic(
                    DIAG_DECLARED_ONLY, "warning",
                    f"只有 {len(card.declarations)} 处黑盒声明说会发它，没有任何地方真的发——"
                    "声明只是画布上的标注，运行时不执行",
                ))
            else:
                out.append(Diagnostic(
                    DIAG_NO_EMITTER, "warning",
                    f"{listeners} 处在等它，全工程却没有任何地方发出它（先接线后写戏时这是正常的）",
                ))
        if card.reactive_refs and listeners == 0:
            out.append(Diagnostic(
                DIAG_REACTIVE_ONLY, "warning",
                f"有 {len(card.reactive_refs)} 条反应式转移的信号字段填了它，但**反应式不吃信号**"
                "（它靠条件自动走），所以这条信号实际没人听——要么把那些转移改成信号触发，"
                "要么这个名字只是备注".replace("**", "「").replace("「反应式不吃信号「", "「反应式不吃信号」"),
            ))
        if real_emits and listeners == 0:
            note = ""
            if card.kind == KIND_DERIVED and card.state_reads:
                note = f"；不过有 {len(card.state_reads)} 处条件在读这个状态，多半不是漏接"
            out.append(Diagnostic(
                DIAG_NO_LISTENER, "warning",
                f"{real_emits} 处会发出它，却没有任何转移在等它（发了没人接）{note}",
            ))
        if not real_emits and not listeners and not card.declarations and card.kind != KIND_DERIVED:
            # 没登记的信号别说"登记了却没人用"——同一张卡上一句说没登记、下一句说登记了，
            # 策划只会觉得这工具在胡说。
            out.append(Diagnostic(
                DIAG_ORPHAN, "warning",
                "登记了却没人发、也没人听" if card.registered
                else "工程里查无此名：既没登记，也没人发、没人听——多半是名字打错了，或者已经删掉了",
            ))
        return out

    # ------------------------------------------------------------------ 状态维度
    def all_state_keys(self) -> list[tuple[str, str]]:
        """全工程状态 (图, 态)；被引用但图里没有的"幽灵态"也列出来（那正是要查的）。"""
        keys = {
            (meta.graph_id, sid)
            for meta in self.graphs.values() for sid in meta.state_labels
        }
        keys |= set(self.state_reads)
        keys |= set(self.state_commands)
        return sorted(keys)

    def _ways_into_state(self, graph_id: str, state_id: str) -> list[Emitter]:
        """怎么进这一拍：上游转移 + 强制设状态。与派生信号卡共用同一段口径。"""
        rows: list[Emitter] = []
        for row in self.transitions_into.get((graph_id, state_id), []):
            wired = not transition_is_unwired(row.signal, row.trigger)
            how = row.how or _transition_how(row.signal, row.trigger)
            if row.conditions:
                how += "；还要满足：" + " 且 ".join(row.conditions)
            rows.append(Emitter(
                signal=row.signal, channel=CHANNEL_UPSTREAM, container_kind="narrativeGraph",
                container_id=row.graph_id, container_label=row.graph_label, kind_label="上游转移",
                where=f"{row.from_label} → {row.to_label}", context=how, wired=wired,
                file=row.file, pointer=row.pointer, composition_id=row.composition_id,
                element_id=row.element_id, graph_id=row.graph_id, transition_id=row.transition_id,
            ))
        rows.extend(self.state_commands.get((graph_id, state_id), []))
        return rows

    def state_card(self, graph_id: str, state_id: str) -> StateCard:
        gid, sid = _text(graph_id), _text(state_id)
        meta = self.graphs.get(gid)
        card = StateCard(
            graph_id=gid, state_id=sid,
            graph_label=meta.label if meta else gid,
            state_label=meta.state_label(sid) if meta else sid,
            composition_id=meta.composition_id if meta else "",
            composition_label=meta.composition_label if meta else "",
            element_id=meta.element_id if meta else "",
            exists=meta is not None and sid in meta.state_labels,
            is_initial=meta is not None and meta.initial_state == sid,
            broadcasts=meta is not None and sid in meta.broadcast_states,
            run_graph=meta.is_run if meta else False,
        )
        if card.broadcasts:
            card.broadcast_signal = derived_signal_key(gid, sid)
        card.ways_in = self._ways_into_state(gid, sid)
        card.ways_out = list(self.transitions_out.get((gid, sid), []))
        card.readers = list(self.state_reads.get((gid, sid), []))
        # 进/出这一拍会发的信号：状态动作树里的发射 + 广播派生。发射行在扫描时已经
        # 补过画布坐标（graph_id/state_id），按它归属，别再解析一遍指针。
        emits = [
            row for rows in self.emitters.values() for row in rows
            if row.graph_id == gid and row.state_id == sid
        ]
        if card.broadcasts:
            # 广播行由 _scan_graphs 造、并已带 graph_id/state_id，上面那段推导式**已经收进来了**；
            # 再 extend 一次就会整整重复一行（13 个广播拍无一幸免）。按指针去重兜底。
            seen = {(e.file, e.pointer, e.signal) for e in emits}
            emits.extend(
                row for row in self.emitters.get(card.broadcast_signal, [])
                if row.channel == CHANNEL_BROADCAST and (row.file, row.pointer, row.signal) not in seen
            )
        card.emits = sorted(emits, key=lambda e: (_CHANNEL_ORDER.get(e.channel, 9), e.pointer))
        card.diagnostics = self._diagnose_state(card)
        return card

    def _diagnose_state(self, card: StateCard) -> list[Diagnostic]:
        out: list[Diagnostic] = []
        if not card.exists:
            out.append(Diagnostic(
                DIAG_STATE_MISSING, "error",
                f"图「{card.graph_label}」里没有这个状态——引用它的地方会永远判不成立",
            ))
            return out
        if not card.is_initial and not card.ways_in:
            out.append(Diagnostic(
                DIAG_STATE_NO_WAY_IN, "warning",
                "没有任何路能进到这一拍（没有转移指向它，也不是初始状态）",
            ))
        elif card.ways_in and not any(e.wired for e in card.ways_in):
            out.append(Diagnostic(
                DIAG_STATE_NO_WAY_IN, "warning",
                f"能进这一拍的 {len(card.ways_in)} 条路全都还没接线（占位信号运行时不会发）",
            ))
        if not card.ways_out:
            out.append(Diagnostic(
                DIAG_STATE_DEAD_END, "info",
                "从这一拍没有出口——末态是正常的，中间拍就是断了",
            ))
        if not card.readers and not card.broadcasts and not card.emits:
            out.append(Diagnostic(
                DIAG_STATE_UNUSED, "info",
                "没人读它、也不广播、进出不发信号：改它不牵连任何别的地方",
            ))
        return out

    def state_overview(self) -> list[StateCard]:
        return [self.state_card(gid, sid) for gid, sid in self.all_state_keys()]

    def overview(self) -> list[SignalCard]:
        return [self.card(sid) for sid in self.all_signal_ids()]

    def to_dict(self) -> dict[str, Any]:
        cards = self.overview()
        states = self.state_overview()
        return {
            "origin": self.origin,
            "stats": {
                "dialogues": self.stats.dialogues,
                "assets": self.stats.assets,
                "graphs": self.stats.graphs,
                "transitions": self.stats.transitions,
                "signals": len(cards),
                "states": len(states),
            },
            "signals": [c.to_dict() for c in cards],
            # 状态维度与信号维度一起交付：一次扫描（约 110ms / 759KB）换两边切换零延迟，
            # 而按需再问一次要么多一趟往返、要么得在宿主里缓存索引（两者都更容易漂）。
            "states": [c.to_dict() for c in states],
        }


_CHANNEL_ORDER = {
    CHANNEL_DIALOGUE: 0,
    CHANNEL_ASSET: 1,
    CHANNEL_NARRATIVE_ACTION: 2,
    CHANNEL_BROADCAST: 3,
    CHANNEL_UPSTREAM: 4,
}


def _trim_container_prefix(where: str, container_id: str) -> str:
    """位置串开头那截若就是容器自己（`临场长按「x」 —— 「x」· 完成时…`），去掉它。

    整份文件装一堆条目时（quests / pressure_holds / cutscenes…），人话路径的第一段正是
    那个条目 id，而行首标题已经写过一遍了——留着就是每行都把同一个 id 说两遍。
    """
    if not container_id:
        return where
    # 第一段可能是裸的「id」，也可能已经带上了容器类别（章节包「id」）——两种都要剥，
    # 否则加一个 CONTAINER_KEYS 条目就会让那一域的每行把名字说两遍。
    for prefix in (f"「{container_id}」", *(f"{label}「{container_id}」" for label in CONTAINER_KEYS.values())):
        if where == prefix:
            return ""
        if where.startswith(prefix + " · "):
            return where[len(prefix) + 3:]
    return where


def _owner_binding(node: Any) -> tuple[str, str]:
    """这一发**显式钉死**的宿主身份（`emitNarrativeSignal` 的 ownerType/ownerId）。

    ⚠ 判据必须是"两个都填了"，与运行时逐字一致（ActionRegistry 的
    ``paramOwnerType && paramOwnerId ? … : origin…``）：只填一个的时候运行时**整对丢弃**、
    退回来源上下文那一档。界面照单显示半对参数，等于告诉作者"定向已经钉好了"，
    而私有信号的投递面恰恰会因此落到另一个 owner 上（或缺 owner 直接被丢）。
    """
    params = node.get("params") if isinstance(node, dict) else None
    if not isinstance(params, dict):
        return "", ""
    owner_type = _text(params.get("ownerType"))
    owner_id = _text(params.get("ownerId"))
    return (owner_type, owner_id) if (owner_type and owner_id) else ("", "")


def _source_note(node: dict[str, Any]) -> str:
    """发射行的附注：留痕来源（不是接线）+ 显式宿主身份（私有信号的定向依据）。"""
    params = node.get("params") if isinstance(node, dict) else None
    if not isinstance(params, dict):
        return ""
    parts: list[str] = []
    source_id = _text(params.get("sourceId"))
    source_type = _text(params.get("sourceType"))
    if source_id and source_type:
        parts.append(f"留痕来源：{source_type}:{source_id}")
    elif source_type or source_id:
        parts.append(f"留痕来源：{source_type or source_id}")
    owner_type, owner_id = _owner_binding(node)
    if owner_type:
        # 私有信号靠 owner 定向：这一句是全项目唯一**静态看得见**的宿主身份，
        # 不标出来，xref 上一条私有发射与普通发射长得一模一样。
        parts.append(f"带宿主身份：{owner_type}:{owner_id}（发射点显式指定，覆盖来源上下文）")
    return "；".join(parts)


def _context_for(channel: str, root: Any, hit: "_Hit") -> str:
    """给一行上下文：对话图取那句台词（策划靠台词认路），别的留空由界面配类别名。"""
    if channel == CHANNEL_DIALOGUE:
        return _dialogue_line(root, hit.pointer)
    return ""


def _dialogue_line(root: Any, pointer: str) -> str:
    """从命中指针回溯它所在的对话节点，取一句能认出来的正文。"""
    if not isinstance(root, dict):
        return ""
    segs = [s.replace("~1", "/").replace("~0", "~") for s in str(pointer).split("/")[1:]]
    if len(segs) < 2 or segs[0] != "nodes":
        return ""
    nodes = root.get("nodes")
    node = nodes.get(segs[1]) if isinstance(nodes, dict) else None
    if not isinstance(node, dict):
        return ""
    text = _text(node.get("text"))
    if not text:
        lines = node.get("lines")
        if isinstance(lines, list):
            for item in lines:
                if isinstance(item, dict) and _text(item.get("text")):
                    text = _text(item.get("text"))
                    break
    if len(text) > 40:
        text = text[:40] + "…"
    if text:
        return f"“{text}”"
    return ""


EmitHandler = Callable[[str, _Hit], None]
StateRefHandler = Callable[[str, str, _Hit], None]


def _display_name(node: Any) -> str:
    """这个条目在界面上叫什么。

    优先 id（那是数据身份），没有 id 就退到 name/label/title/sceneId——map_config 的
    节点就没有 id，只认 id 的话标题会显示成「地图节点「」」，等于让人去十几个节点里
    自己猜是哪个（2026-08-07 审查实测）。**anchors 仍然只收 id**：宿主的跳转引擎按 id
    定位，把名字塞进去会让它找一个不存在的 id。
    """
    if not isinstance(node, dict):
        return ""
    for key in ("id", "name", "label", "title", "sceneId"):
        value = node.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


# 引用长在什么容器键下 → 世界里那是个什么东西 + 这一拍决定它什么。
# 「决定它什么」是策划真正要的那句话：不是"conditions[0]"，是"这个人出不出现"。
# 这些容器键下的东西不是"世界里的东西"，只是数据结构的一层。
_NOT_A_SUBJECT = frozenset({"transitions", "states", "compositions", "elements", "conditions", "cases"})

_SUBJECT_BY_CONTAINER: dict[str, tuple[str, str]] = {
    "npcs": ("npc", "出不出现"),
    "hotspots": ("hotspot", "点不点得到"),
    "zones": ("zone", "走进去有没有反应"),
    "nodes": ("dialogueNode", "对话走哪一支"),
    "cases": ("dialogueNode", "对话走哪一支"),
    # 气泡台词本：主体是那一组台词（自带 id），不是整份 bubble_lines.json
    "lineSets": ("bubbleLineSet", "这组台词说不说"),
}
# 整份文件装一堆条目的（容器键为空/顶层数组）→ 按数据域给说法
_SUBJECT_BY_KIND: dict[str, tuple[str, str]] = {
    "quest": ("quest", "任务算不算数"),
    "package": ("package", "这一章开不开"),
    "mapNode": ("mapNode", "地图上解不解锁"),
    "archiveLore": ("archive", "见闻能不能看到"),
    "archiveCharacter": ("archive", "人物档案能不能看到"),
    "archiveBook": ("archive", "书能不能看到"),
    "archiveDocument": ("archive", "文书能不能看到"),
    "archiveSlang": ("archive", "行话能不能解锁"),
    "dialogue": ("dialogueNode", "对话走哪一支"),
    "scene": ("sceneEntity", "场景里这东西的显隐"),
    "encounter": ("encounter", "遭遇触不触发"),
    "rule": ("rule", "这条规矩算不算"),
    "item": ("item", "这件东西的行为"),
    "narrativePackage": ("package", "这一章开不开"),
    "documentReveal": ("document", "这份文书揭不揭示"),
    "narrativeGraph": ("narrative", "另一条线的岔路"),
    "pressureHold": ("pressureHold", "这根压力条的走向"),
    "signalCue": ("cue", "这段表现放不放"),
    "minigame": ("minigame", "小游戏里的分支"),
    "cutscene": ("cutscene", "这段过场的分支"),
    "bubbleLineSet": ("bubbleLineSet", "这组台词说不说"),
}

# 主体类别的中文名。界面上说「NPC「庄家来人」」而不是「场景「庄家来人」」——
# 后者把容器当成了东西本身，策划一眼看不出那是个人还是个门。
SUBJECT_KIND_LABELS: dict[str, str] = {
    "npc": "NPC",
    "hotspot": "热点",
    "zone": "区域",
    "sceneEntity": "场景实体",
    "dialogueNode": "对话",
    "quest": "任务",
    "package": "章节包",
    "mapNode": "地图节点",
    "archive": "档案",
    "document": "文档揭示",
    "narrative": "叙事图",
    "pressureHold": "临场长按",
    "cue": "信号 Cue",
    "minigame": "小游戏",
    "cutscene": "过场",
    "encounter": "遭遇",
    "rule": "规矩",
    "item": "物品",
    "bubbleLineSet": "气泡台词",
}


def _fill_subject(row: StateRead, hit: _Hit, container_kind: str, container_id: str) -> None:
    """把一条引用落到**世界里的那个东西**上。

    策划盯的是实体与流程：他要听的是"雾津街头那个挑空担的汉子出不出现"，
    而不是 `npcs[3].conditions[0]`。名字取 name/label/title，取不到才退回 id。
    """
    # transitions / states 是**容器**不是"世界里的东西"：拿它当主体会渲染成
    # 「叙事图「t_2」」。跳过它们，让主体退回数据域口径（随后 _attach_narrative_coords
    # 会把它改写成那张图的名字）。
    subject = next(
        (row for row in reversed(hit.subjects) if row[0] not in _NOT_A_SUBJECT), None,
    )
    kind, effect = "", ""
    if subject is not None:
        container, ident, human, node = subject
        kind, effect = _SUBJECT_BY_CONTAINER.get(container, ("", ""))
        row.subject_id = ident
        row.subject_name = human
        # 场景实体的显隐语义写在它自己身上：conditionHidesEntity=true＝条件不满足就藏起来
        if kind in ("npc", "hotspot") and node.get("conditionHidesEntity") is True:
            effect = "出不出现"
        elif kind in ("npc", "hotspot"):
            effect = "能不能互动"
    if not kind:
        kind, effect = _SUBJECT_BY_KIND.get(container_kind, ("", ""))
        if not row.subject_id:
            row.subject_id = container_id or row.container_id
    row.subject_kind = kind
    row.subject_kind_label = SUBJECT_KIND_LABELS.get(kind, "")
    row.subject_effect = effect
    if container_kind == "scene":
        row.subject_scene = container_id or row.container_id


def _transition_how(signal: str, trigger: str) -> str:
    """这条转移**怎么才会走**——一句人话，三个界面共用。

    以前编辑器/调试器/CLI 各拼各的，出口那栏就把占位路说成「收到「__draft__」时走」——
    而运行时明确拒发占位信号，那条路根本走不到（`transition_is_unwired` 的文档原话）。
    """
    if trigger in REACTIVE_TRIGGERS:
        return "条件满足就自动走"
    if transition_is_unwired(signal, trigger):
        return "这条路还没接线（占位信号，运行时不会发）"
    if signal:
        return f"收到信号「{signal}」时走"
    return "没接触发条件"


def _human_name(node: Any) -> str:
    """人看的名字（不是 id）：NPC 用 name，热点用 label，任务用 title…"""
    if not isinstance(node, dict):
        return ""
    for key in ("name", "label", "title", "displayName"):
        value = node.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _walk(
    node: Any,
    pointer: str,
    anchors: list[list[str]],
    labels: list[str],
    subjects: list[tuple[str, str, str, dict[str, Any]]],
    container: str,
    pending: str | None,
    trail: list[str],
    on_emit: EmitHandler,
    on_command: StateRefHandler,
    on_condition: StateRefHandler,
    depth: int = 0,
) -> None:
    """深度遍历任意 JSON，捞三类命中。

    三件事同时往下带：
    - `pointer` / `anchors`：形状与 `tools/json_lang/search.py` 完全一致，可以直接喂给
      主编辑器的 `navigate_to_search_hit()` 跳转（复用既有路由，不再造一套）。
    - `trail`：一路攒的**人话路径**（节点「c_jie」· 动作 第 1 个）。之所以在下降途中攒
      而不是事后解析指针：只有下降时才同时知道「这层的键叫什么」和「这层的条目 id 是
      什么」，事后解析必须靠猜。

    容器无关（runActions / chooseAction / randomBranch / 小游戏分支…一律命中），
    与 `narrative_catalog._collect_emitted_signal_ids` 同款递归范式。

    `depth` 是**兜底闸**：真实数据最深不过十几层，但内存里的结构可能被别处写成自引用
    （编辑器里手滑就能造出来）。撞到闸就停在那一枝，绝不让整块面板变成 RecursionError。
    """
    if depth > _MAX_WALK_DEPTH:
        return
    if isinstance(node, dict):
        node_id = node.get("id")
        my_anchors = anchors
        if isinstance(node_id, str) and node_id:
            my_anchors = anchors + [[container, node_id]]
        display = _display_name(node)
        my_labels = labels + [display] if display else labels
        human = _human_name(node)
        my_subjects = subjects
        if (isinstance(node_id, str) and node_id) or human:
            my_subjects = subjects + [(container, _text(node_id), human, node)]
        node_type = _text(node.get("type"))
        params = node.get("params")
        if node_type == EMIT_ACTION and isinstance(params, dict):
            signal = _text(params.get("signal"))
            if signal:
                on_emit(signal, _Hit(pointer, [list(a) for a in my_anchors], list(trail), node, list(my_labels), list(my_subjects)))
        elif node_type == STATE_COMMAND_ACTION and isinstance(params, dict):
            graph_id = _text(params.get("graphId"))
            state_id = _text(params.get("stateId"))
            if graph_id and state_id:
                on_command(graph_id, state_id, _Hit(pointer, [list(a) for a in my_anchors], list(trail), node, list(my_labels), list(my_subjects)))
        # 引用形状五选一，口径与 signal_refactor._walk_narrative_refs 完全一致
        # （漏一种 = 面板少算成"没人读"，策划据此去"修"一个本来正常的广播）。
        hit = None
        narrative_ref = node.get("narrative")
        # 判据要求 state 也是字符串：encounters 里的 `narrative` 是旁白正文，
        # 只看 narrative 会把整段文案当成图 id 记进来。
        if isinstance(narrative_ref, str) and narrative_ref.strip() and isinstance(node.get("state"), str):
            hit = hit or _Hit(pointer, [list(a) for a in my_anchors], list(trail), node, list(my_labels), list(my_subjects))
            on_condition(narrative_ref.strip(), _text(node.get("state")), hit)
        count_ref = node.get("narrativeCount")
        if isinstance(count_ref, str) and count_ref.strip():
            hit = hit or _Hit(pointer, [list(a) for a in my_anchors], list(trail), node, list(my_labels), list(my_subjects))
            on_condition(count_ref.strip(), _text(node.get("exitState")), hit)
        if node_type in GRAPH_PARAM_ACTIONS and isinstance(params, dict) and node_type != STATE_COMMAND_ACTION:
            gid = _text(params.get("graphId"))
            sid_param = _text(params.get("stateId"))
            # 活计四件套（start/reset/revert/activate）压根没有 stateId：登记成状态引用会造出
            # 一个 id 为空的幽灵拍，还给它挂一条假 error「图里没有这个状态」。
            if gid and sid_param:
                hit = hit or _Hit(pointer, [list(a) for a in my_anchors], list(trail), node, list(my_labels), list(my_subjects))
                on_condition(gid, sid_param, hit)
        graph_field = DIALOGUE_STATE_NODES.get(node_type)
        if graph_field:
            gid = _text(node.get(graph_field))
            if gid:
                for ci, case in enumerate(node.get("cases") or []):
                    if not isinstance(case, dict):
                        continue
                    state_id = _text(case.get("state"))
                    if not state_id:
                        continue
                    case_hit = _Hit(
                        f"{pointer}/cases/{ci}", [list(a) for a in my_anchors],
                        list(trail) + [f"分支 第 {ci + 1} 个"], node, list(my_labels), list(my_subjects),
                    )
                    on_condition(gid, state_id, case_hit)
        for key, value in node.items():
            skey = str(key)
            child_pending = pending_label(skey)
            if child_pending is not None:
                # 容器/动作面本身不进路径，等下一层拿到 id 或序号再一起说
                child_trail = trail
            elif skey in SKIP_KEYS:
                child_pending = pending
                child_trail = trail
            elif pending:
                child_trail = trail + [f"{pending}「{skey}」"]
                child_pending = None
            else:
                # 认得的结构键译成词；认不得的才退回原文（退回也比编一个假名字强）
                child_trail = trail + [plain_label(skey) or skey]
                child_pending = None
            _walk(value, f"{pointer}/{_esc(skey)}", my_anchors, my_labels, my_subjects, skey, child_pending, child_trail,
                                    on_emit, on_command, on_condition, depth + 1)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            ident = _display_name(item)
            if pending:
                part = f"{pending}「{ident}」" if ident else f"{pending} 第 {i + 1} 个"
            else:
                part = f"「{ident}」" if ident else f"第 {i + 1} 项"
            _walk(item, f"{pointer}/{i}", anchors, labels, subjects, container, None, trail + [part],
                                    on_emit, on_command, on_condition, depth + 1)


def build_index(source: XrefSource) -> SignalIndex:
    return SignalIndex(source)
