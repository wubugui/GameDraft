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
    StateRead,
    derived_signal_key,
    is_derived,
    parse_derived,
)
from .phrases import SKIP_KEYS, condition_parts, join_trail, pending_label
from .sources import XrefSource

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

# 反应式转移不吃信号（靠条件自动评估），它的 signal 字段是编辑器占位，不算监听。
REACTIVE_TRIGGERS = frozenset({"reactive", "reactiveAll", "reactiveAny"})


def _text(value: Any) -> str:
    return str(value or "").strip()


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

    @property
    def where(self) -> str:
        return join_trail(self.trail)

    @property
    def outer_id(self) -> str:
        return self.anchors[0][1] if self.anchors else ""


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
        self.state_commands: dict[tuple[str, str], list[Emitter]] = {}
        self.state_reads: dict[tuple[str, str], list[StateRead]] = {}
        self.registry: dict[str, dict[str, Any]] = {}
        self._pending_conditions: list[tuple[Listener, Any]] = []
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

        这类行的正确跳法是**画布定位**：它本来就在叙事状态机这一页，走宿主文件跳转要
        绕一圈切页，而且宿主对 narrative_graphs.json 的兜底分支只要页面打开就报"已定位"
        （main_window `_nav_hit_generic`），面板会照着它说假话。
        """
        prefixes = sorted(
            ((meta.pointer, meta) for meta in self.graphs.values() if meta.pointer),
            key=lambda item: len(item[0]), reverse=True,
        )
        for rows in self.emitters.values():
            for row in rows:
                if row.file != self.narrative_file or row.graph_id or not row.pointer:
                    continue
                for prefix, meta in prefixes:
                    if not row.pointer.startswith(prefix + "/"):
                        continue
                    segs = [x.replace("~1", "/").replace("~0", "~")
                            for x in row.pointer[len(prefix):].split("/")[1:]]
                    row.composition_id = meta.composition_id
                    row.element_id = meta.element_id
                    row.graph_id = meta.graph_id
                    if len(segs) >= 2 and segs[0] == "states":
                        row.state_id = segs[1]
                    break

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
            }

    def _iter_graphs(self, narrative: Any) -> Iterator[tuple[dict[str, Any], str, dict[str, Any], str]]:
        """(图, 图指针, 所属编排, 元素 id)；覆盖 mainGraph / elements[].graph / 顶层 graphs。"""
        if not isinstance(narrative, dict):
            return
        for ci, comp in enumerate(narrative.get("compositions") or []):
            if not isinstance(comp, dict):
                continue
            main = comp.get("mainGraph")
            if isinstance(main, dict):
                yield main, f"/compositions/{ci}/mainGraph", comp, ""
            for ei, element in enumerate(comp.get("elements") or []):
                if not isinstance(element, dict):
                    continue
                graph = element.get("graph")
                if isinstance(graph, dict):
                    yield graph, f"/compositions/{ci}/elements/{ei}/graph", comp, _text(element.get("id"))
        for gi, graph in enumerate(narrative.get("graphs") or []):
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
                composition_label=_text(comp.get("label")) or _text(comp.get("id")),
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
        for ti, transition in enumerate(graph.get("transitions") or []):
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
            if to_state:
                self.transitions_into.setdefault((meta.graph_id, to_state), []).append(row)
            # 条件原文先留着，人话等全部图扫完再渲染（见 _render_conditions）
            self._pending_conditions.append((row, transition.get("conditions") or []))

    def _scan_declarations(self, narrative: Any) -> None:
        if not isinstance(narrative, dict):
            return
        for ci, comp in enumerate(narrative.get("compositions") or []):
            if not isinstance(comp, dict):
                continue
            for ei, element in enumerate(comp.get("elements") or []):
                if not isinstance(element, dict):
                    continue
                meta = element.get("meta")
                emits = meta.get("emits") if isinstance(meta, dict) else None
                if not isinstance(emits, list):
                    continue
                for si, raw in enumerate(emits):
                    signal = _text(raw)
                    if not signal:
                        continue
                    self.declarations.setdefault(signal, []).append(Declaration(
                        signal=signal,
                        composition_id=_text(comp.get("id")),
                        composition_label=_text(comp.get("label")) or _text(comp.get("id")),
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
            return container_id or hit.outer_id

        def on_emit(signal: str, hit: _Hit) -> None:
            if not collect_emits:
                # 条件面（地图/物品/规矩…）只扫引用：把它们算进发射会与
                # narrative_catalog.emitted_signal_ids 的权威口径打架。
                return
            self.emitters.setdefault(signal, []).append(Emitter(
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
            self.state_reads.setdefault((graph_id, state_id), []).append(StateRead(
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
            ))

        _walk(root, pointer_prefix, [], "", None, [], on_emit, on_command, on_condition)

    def _sort_all(self) -> None:
        """稳定排序：同一份数据每次扫出的顺序必须一致，否则界面每次刷新都在跳。"""
        for erows in self.emitters.values():
            erows.sort(key=lambda e: (_CHANNEL_ORDER.get(e.channel, 9), e.container_kind, e.container_id, e.pointer))
        for drows in self.declarations.values():
            drows.sort(key=lambda d: (d.composition_id, d.element_id, d.pointer))
        for lrows in self.listeners.values():
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
            registered=sid in self.registry,
            emitters=list(self.emitters.get(sid, [])),
            declarations=list(self.declarations.get(sid, [])),
            listeners=list(self.listeners.get(sid, [])),
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
            card.source_state_label = meta.state_label(state_id)
        card.state_reads = list(self.state_reads.get((graph_id, state_id), []))

        upstream: list[Emitter] = []
        for row in self.transitions_into.get((graph_id, state_id), []):
            if row.trigger in REACTIVE_TRIGGERS:
                trigger_text = "条件满足就自动走"
            elif row.signal:
                trigger_text = f"收到信号「{row.signal}」时走"
            else:
                trigger_text = "没接触发条件"
            if row.conditions:
                trigger_text += "；还要满足：" + " 且 ".join(row.conditions)
            upstream.append(Emitter(
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

    def overview(self) -> list[SignalCard]:
        return [self.card(sid) for sid in self.all_signal_ids()]

    def to_dict(self) -> dict[str, Any]:
        cards = self.overview()
        return {
            "origin": self.origin,
            "stats": {
                "dialogues": self.stats.dialogues,
                "assets": self.stats.assets,
                "graphs": self.stats.graphs,
                "transitions": self.stats.transitions,
                "signals": len(cards),
            },
            "signals": [c.to_dict() for c in cards],
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
    prefix = f"「{container_id}」"
    if where == prefix:
        return ""
    if where.startswith(prefix + " · "):
        return where[len(prefix) + 3:]
    return where


def _source_note(node: dict[str, Any]) -> str:
    """emitNarrativeSignal 的 sourceType/sourceId 只是留痕参数，标一句省得被当成接线。"""
    params = node.get("params") if isinstance(node, dict) else None
    if not isinstance(params, dict):
        return ""
    source_id = _text(params.get("sourceId"))
    source_type = _text(params.get("sourceType"))
    if source_id and source_type:
        return f"留痕来源：{source_type}:{source_id}"
    return f"留痕来源：{source_type or source_id}" if (source_type or source_id) else ""


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


def _walk(
    node: Any,
    pointer: str,
    anchors: list[list[str]],
    container: str,
    pending: str | None,
    trail: list[str],
    on_emit: EmitHandler,
    on_command: StateRefHandler,
    on_condition: StateRefHandler,
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
    """
    if isinstance(node, dict):
        node_id = node.get("id")
        my_anchors = anchors
        if isinstance(node_id, str) and node_id:
            my_anchors = anchors + [[container, node_id]]
        node_type = _text(node.get("type"))
        params = node.get("params")
        if node_type == EMIT_ACTION and isinstance(params, dict):
            signal = _text(params.get("signal"))
            if signal:
                on_emit(signal, _Hit(pointer, [list(a) for a in my_anchors], list(trail), node))
        elif node_type == STATE_COMMAND_ACTION and isinstance(params, dict):
            graph_id = _text(params.get("graphId"))
            state_id = _text(params.get("stateId"))
            if graph_id and state_id:
                on_command(graph_id, state_id, _Hit(pointer, [list(a) for a in my_anchors], list(trail), node))
        # 引用形状五选一，口径与 signal_refactor._walk_narrative_refs 完全一致
        # （漏一种 = 面板少算成"没人读"，策划据此去"修"一个本来正常的广播）。
        hit = None
        narrative_ref = node.get("narrative")
        # 判据要求 state 也是字符串：encounters 里的 `narrative` 是旁白正文，
        # 只看 narrative 会把整段文案当成图 id 记进来。
        if isinstance(narrative_ref, str) and narrative_ref.strip() and isinstance(node.get("state"), str):
            hit = hit or _Hit(pointer, [list(a) for a in my_anchors], list(trail), node)
            on_condition(narrative_ref.strip(), _text(node.get("state")), hit)
        count_ref = node.get("narrativeCount")
        if isinstance(count_ref, str) and count_ref.strip():
            hit = hit or _Hit(pointer, [list(a) for a in my_anchors], list(trail), node)
            on_condition(count_ref.strip(), _text(node.get("exitState")), hit)
        if node_type in GRAPH_PARAM_ACTIONS and isinstance(params, dict) and node_type != STATE_COMMAND_ACTION:
            gid = _text(params.get("graphId"))
            if gid:
                hit = hit or _Hit(pointer, [list(a) for a in my_anchors], list(trail), node)
                on_condition(gid, _text(params.get("stateId")), hit)
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
                        list(trail) + [f"分支 第 {ci + 1} 个"], node,
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
                child_trail = trail + [skey]
                child_pending = None
            _walk(value, f"{pointer}/{_esc(skey)}", my_anchors, skey, child_pending, child_trail,
                  on_emit, on_command, on_condition)
    elif isinstance(node, list):
        for i, item in enumerate(node):
            ident = item.get("id") if isinstance(item, dict) else None
            ident = ident if isinstance(ident, str) and ident.strip() else ""
            if pending:
                part = f"{pending}「{ident}」" if ident else f"{pending} 第 {i + 1} 个"
            else:
                part = f"「{ident}」" if ident else f"第 {i + 1} 项"
            _walk(item, f"{pointer}/{i}", anchors, container, None, trail + [part],
                  on_emit, on_command, on_condition)


def build_index(source: XrefSource) -> SignalIndex:
    return SignalIndex(source)
