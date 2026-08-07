"""叙事因果图索引：把 narrative_graphs.json + 对话图/zone 摊平成"状态节点 + 因果边"。

这里刻意不 import 任何编辑器模块——本工具与 tools/editor 完全解耦，只认数据格式。
（`tools.narrative_xref` 不算编辑器模块：它是编辑器与调试器共用的纯 stdlib 扫描基建。）

三层数据事实（读代码得来，勿凭记忆改）：
- 信号 key 是**全局裸名**（NarrativeStateManager.normalizeSignal 只取 signal 字段，
  不拼 sourceType/sourceId）。
- 跨图广播 key 恒为 ``state:<graphId>:<stateId>``（NarrativeStateManager.ts:346），
  只有 ``broadcastOnEnter === true`` 的状态会发。
- composition.elements 里 wrapperGraph 带真图（``.graph``），dialogueBlackbox /
  zoneBlackbox 只是引用外部资产的占位，真实发射端要扫对话图 JSON。
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from tools.narrative_xref.phrases import condition_parts as xref_condition_parts
from tools.narrative_xref.phrases import describe_condition as xref_describe_condition
from tools.narrative_xref.phrases import describe_conditions as xref_describe_conditions

BROADCAST_PREFIX = "state:"
# 反应式触发：不吃信号，靠条件自动评估。这类转移的 signal 字段是编辑器占位，
# **恒为 __draft__ 且理应如此**——接线在 conditions 上。
REACTIVE_TRIGGERS = frozenset({"reactive", "reactiveAll", "reactiveAny"})
# 编辑器占位信号（与 NarrativeStateManager.DEFAULT_DRAFT_SIGNAL 对齐）：
# 它连出来的边不是真路，图上不画、清单里不排。
DRAFT_PLACEHOLDER = "__draft__"


def broadcast_key(graph_id: str, state_id: str) -> str:
    return f"{BROADCAST_PREFIX}{graph_id}:{state_id}"


@dataclass(frozen=True)
class StateNode:
    graph_id: str
    state_id: str
    label: str
    graph_label: str
    is_initial: bool
    broadcasts: bool
    package: str = ""
    on_enter_signals: tuple[str, ...] = ()

    @property
    def key(self) -> str:
        return f"{self.graph_id}.{self.state_id}"

    @property
    def display(self) -> str:
        return self.label or self.state_id


@dataclass(frozen=True)
class Transition:
    graph_id: str
    transition_id: str
    from_state: str
    to_state: str
    signal: str
    trigger: str = "signal"
    conditions: tuple[Any, ...] = ()

    @property
    def has_conditions(self) -> bool:
        return bool(self.conditions)

    @property
    def is_reactive(self) -> bool:
        return self.trigger in REACTIVE_TRIGGERS

    @property
    def is_unwired(self) -> bool:
        """真的没接线吗。

        ⚠ 只看 `signal == __draft__` 会把**反应式转移**一并冤枉掉：它压根不吃信号，
        signal 字段恒是占位，线接在 conditions 上。踩过：主线「闲逛A→闲逛B」明明写了
        条件，因果图上不画、「在等」框还写"这条路还没接线"，条件就打印在下一行。
        """
        return self.signal == DRAFT_PLACEHOLDER and not self.is_reactive

    @property
    def from_key(self) -> str:
        return f"{self.graph_id}.{self.from_state}"

    @property
    def to_key(self) -> str:
        return f"{self.graph_id}.{self.to_state}"


@dataclass(frozen=True)
class Emitter:
    """一个信号的发射端。kind 决定人话怎么说。

    scene / actor 是策划最要的两样："去哪儿、找谁"。对话本身不带这两样，
    要反查场景文件里是哪个 NPC / 热点 / 区域挂了这张对话图。
    """

    signal: str
    kind: str  # dialogue | zone | hotspot | pressureHold | minigame | stateAction | broadcast
    source_id: str
    label: str
    scene: str = ""
    detail: str = ""
    actor: str = ""
    line: str = ""
    line_kind: str = ""  # choice | line | before
    trigger_kind: str = ""  # npc | hotspot | zone


@dataclass(frozen=True)
class TriggerPoint:
    """世界里能触发某张对话图的地方：哪个场景、哪个人/物。"""

    scene: str
    actor: str
    kind: str  # npc | hotspot | zone


@dataclass(frozen=True)
class Beat:
    """主线/子图上的一"拍"——策划心智里的最小单位。"""

    composition_id: str
    composition_label: str
    graph_id: str
    state_id: str
    label: str
    order: int
    is_mainline: bool

    @property
    def key(self) -> str:
        return f"{self.graph_id}.{self.state_id}"


@dataclass
class Neighborhood:
    """焦点邻域：节点 + 边 + 每个节点相对焦点的跳数（负=前驱，正=后继）。"""

    focus: str
    nodes: dict[str, StateNode] = field(default_factory=dict)
    depth: dict[str, int] = field(default_factory=dict)
    edges: list[tuple[str, str, str, bool]] = field(default_factory=list)
    """(from_key, to_key, 人话标签, 是否跨图派生边)"""


class NarrativeIndex:
    """一次性加载全部叙事数据并建索引。630KB 量级，全量驻留内存无压力。"""

    def __init__(self, project_root: Path) -> None:
        self.root = Path(project_root)
        self.graphs: dict[str, dict[str, Any]] = {}
        self.graph_labels: dict[str, str] = {}
        self.graph_composition: dict[str, str] = {}
        self.states: dict[str, StateNode] = {}
        self.transitions: list[Transition] = []
        self.by_from: dict[str, list[Transition]] = {}
        self.by_to: dict[str, list[Transition]] = {}
        self.by_transition_id: dict[tuple[str, str], Transition] = {}
        self.listeners: dict[str, list[Transition]] = {}
        self.emitters: dict[str, list[Emitter]] = {}
        self.beats: list[Beat] = []
        self.compositions: list[dict[str, Any]] = []
        self.fingerprint: str = ""
        self.load_errors: list[str] = []
        self.dialogue_triggers: dict[str, list[TriggerPoint]] = {}
        self.scene_names: dict[str, str] = {}
        self.zone_scenes: dict[str, str] = {}
        self.pressure_hold_scenes: dict[str, str] = {}
        self.graph_fingerprints: dict[str, str] = {}
        self._scene_signal_cache: dict[str, set[str]] = {}

    # ---- 加载 ---------------------------------------------------------

    @property
    def narrative_path(self) -> Path:
        return self.root / "public/assets/data/narrative_graphs.json"

    @property
    def dialogue_dir(self) -> Path:
        return self.root / "public/assets/dialogues/graphs"

    @property
    def scenes_dir(self) -> Path:
        return self.root / "public/assets/scenes"

    @property
    def pressure_holds_path(self) -> Path:
        return self.root / "public/assets/data/pressure_holds.json"

    def load(self) -> None:
        raw = self._read_json(self.narrative_path)
        if raw is None:
            return
        self.fingerprint = self._fingerprint()
        self.compositions = list(raw.get("compositions") or [])
        for comp in self.compositions:
            self._ingest_composition(comp)
        self._index_transitions()
        self._scan_scene_triggers()
        self._scan_dialogue_emitters()
        self._scan_zone_emitters()
        self._scan_pressure_hold_sites()
        self._scan_pressure_holds()
        self._scan_minigames()
        self._build_beats()

    def _scan_scene_triggers(self) -> None:
        """先扫场景：对话图 → 是哪个场景的哪个人/物挂的。

        没有这一层，"在对话 X 里说到那一句"就答不上"去哪儿、找谁"——
        而那恰恰是策划卡住时唯一想知道的事。
        """
        if not self.scenes_dir.is_dir():
            return
        for path in sorted(self.scenes_dir.glob("*.json")):
            data = self._read_json(path)
            if not isinstance(data, dict):
                continue
            scene_name = str(data.get("name") or data.get("id") or path.stem)
            self.scene_names[str(data.get("id") or path.stem)] = scene_name

            # 场景 onEnter 是主线大头：进了这个场景那段戏就自己演
            # （见 agent_docs「进场演哪场戏＝场景 onEnter 拍板」）。
            for graph_id in _collect_dialogue_graphs(data.get("onEnter")):
                self.dialogue_triggers.setdefault(graph_id, []).append(
                    TriggerPoint(scene=scene_name, actor="", kind="sceneEnter")
                )

            for npc in data.get("npcs") or []:
                if not isinstance(npc, dict):
                    continue
                graph_id = str(npc.get("dialogueGraphId") or "").strip()
                if graph_id:
                    self.dialogue_triggers.setdefault(graph_id, []).append(
                        TriggerPoint(
                            scene=scene_name,
                            actor=_actor_name(npc),
                            kind="npc",
                        )
                    )
            for hotspot in data.get("hotspots") or []:
                if not isinstance(hotspot, dict):
                    continue
                label = str(hotspot.get("label") or hotspot.get("id") or "")
                # 热点挂对话有两种写法：动作树里 startDialogueGraph，或 data.graphId 直挂。
                # 只认前一种会漏掉一大半（茶馆吹牛、婆子家宣布这些主线拍都是后一种）。
                for graph_id in _collect_dialogue_graphs(hotspot) + _direct_graph_ids(hotspot):
                    self.dialogue_triggers.setdefault(graph_id, []).append(
                        TriggerPoint(scene=scene_name, actor=label, kind="hotspot")
                    )
            for zone in data.get("zones") or []:
                if not isinstance(zone, dict):
                    continue
                label = str(zone.get("id") or "")
                self.zone_scenes[f"{data.get('id') or path.stem}:{label}"] = scene_name
                for graph_id in _collect_dialogue_graphs(zone):
                    self.dialogue_triggers.setdefault(graph_id, []).append(
                        TriggerPoint(scene=scene_name, actor=label, kind="zone")
                    )
                for signal in _collect_emitted(zone):
                    self.emitters.setdefault(signal, []).append(
                        Emitter(
                            signal=signal,
                            kind="zone",
                            source_id=label,
                            label=label,
                            scene=scene_name,
                            detail=f"走进「{scene_name}」的「{label}」区域",
                        )
                    )

    def _scan_pressure_holds(self) -> None:
        """按住不放的压力条——背尸这条线上干活的核心动作，必须能说出在哪儿按。

        压力条本身不带场景，得回追一跳：是哪段对话/哪个场景 `startPressureHold`
        起的它，就在哪儿按。
        """
        data = self._read_json(self.pressure_holds_path)
        if not isinstance(data, list):
            return
        for entry in data:
            if not isinstance(entry, dict):
                continue
            hold_id = str(entry.get("id") or "")
            prompt = str(entry.get("prompt") or hold_id)
            scene = self.pressure_hold_scenes.get(hold_id, "")
            for signal in _collect_emitted(entry):
                self.emitters.setdefault(signal, []).append(
                    Emitter(
                        signal=signal,
                        kind="pressureHold",
                        source_id=hold_id,
                        label=prompt,
                        scene=scene,
                        detail=f"按住那个条：{prompt}",
                    )
                )

    # 玩家动手类动作 → 它的 id 参数键。都要能回追到"在哪个场景做的"。
    _SITE_ACTIONS = (
        ("startPressureHold", ("id", "holdId")),
        ("startWaterMinigame", ("id", "instanceId")),
        ("startSugarWheelMinigame", ("id", "instanceId")),
        ("startPaperCraftMinigame", ("id", "instanceId")),
        ("startObjectExamine", ("id", "instanceId")),
    )

    def _scan_pressure_hold_sites(self) -> None:
        """建 压力条/小游戏 id → 场景 的表。

        这些东西自己的 JSON 里没有场景，只能回追一跳：是哪段对话、哪个场景
        启动的它。不追的话，"按住那个条""捞箱子"就永远答不出在哪儿做。
        """
        sources: list[tuple[dict[str, Any], str]] = []
        if self.scenes_dir.is_dir():
            for path in sorted(self.scenes_dir.glob("*.json")):
                data = self._read_json(path)
                if isinstance(data, dict):
                    sources.append((data, str(data.get("name") or data.get("id") or path.stem)))
        if self.dialogue_dir.is_dir():
            for path in sorted(self.dialogue_dir.glob("*.json")):
                data = self._read_json(path)
                if not isinstance(data, dict):
                    continue
                dialogue_id = str(data.get("id") or path.stem)
                triggers = self.dialogue_triggers.get(dialogue_id) or []
                sources.append((data, triggers[0].scene if triggers else ""))
        for payload, scene in sources:
            if not scene:
                continue
            for action_type, keys in self._SITE_ACTIONS:
                for target_id in _collect_param_ids(payload, action_type, keys):
                    self.pressure_hold_scenes.setdefault(target_id, scene)

    def _scan_minigames(self) -> None:
        """小游戏（捞箱子、糖画、纸扎、物件检视）里的信号，同样是玩家真的动手那一下。"""
        for folder, kind_label in (
            ("water_minigames", "捞水里的东西"),
            ("paper_craft", "扎纸活"),
            ("object_examine", "翻看物件"),
            ("sugar_wheel", "转糖轮"),
        ):
            directory = self.root / "public/assets/data" / folder
            if not directory.is_dir():
                continue
            for path in sorted(directory.glob("*.json")):
                if path.name == "index.json":
                    continue
                data = self._read_json(path)
                if not isinstance(data, dict):
                    continue
                title = str(data.get("label") or data.get("name") or data.get("id") or path.stem)
                game_id = str(data.get("id") or path.stem)
                for signal in _collect_emitted(data):
                    self.emitters.setdefault(signal, []).append(
                        Emitter(
                            signal=signal,
                            kind="minigame",
                            source_id=game_id,
                            label=title,
                            scene=self.pressure_hold_scenes.get(game_id, ""),
                            detail=f"{kind_label}：{title}",
                        )
                    )

    def _fingerprint(self) -> str:
        h = hashlib.sha256()
        try:
            h.update(self.narrative_path.read_bytes())
        except OSError:
            return ""
        return h.hexdigest()[:16]

    def _read_json(self, path: Path) -> Any:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            self.load_errors.append(f"{path.name}: {exc}")
            return None

    def _ingest_composition(self, comp: dict[str, Any]) -> None:
        comp_id = str(comp.get("id") or "")
        main = comp.get("mainGraph")
        if isinstance(main, dict) and main.get("id"):
            self._ingest_graph(main, comp_id, package="")
        for element in comp.get("elements") or []:
            if not isinstance(element, dict):
                continue
            graph = element.get("graph")
            if isinstance(graph, dict) and graph.get("id"):
                self._ingest_graph(graph, comp_id, package=str(element.get("package") or ""))

    def _ingest_graph(self, graph: dict[str, Any], comp_id: str, package: str) -> None:
        gid = str(graph.get("id") or "")
        if not gid or gid in self.graphs:
            return
        self.graphs[gid] = graph
        self.graph_labels[gid] = str(graph.get("label") or gid)
        self.graph_composition[gid] = comp_id
        # 逐图指纹：改一个错别字不该让所有存档点集体变灰。
        # 只有这张图自己变了，它的档才可能对不上。
        self.graph_fingerprints[gid] = hashlib.sha256(
            json.dumps(graph, ensure_ascii=False, sort_keys=True).encode("utf-8")
        ).hexdigest()[:16]
        initial = str(graph.get("initialState") or "")
        states = graph.get("states") or {}
        if isinstance(states, dict):
            for sid, state in states.items():
                if not isinstance(state, dict):
                    continue
                node = StateNode(
                    graph_id=gid,
                    state_id=str(sid),
                    label=str(state.get("label") or ""),
                    graph_label=self.graph_labels[gid],
                    is_initial=str(sid) == initial,
                    broadcasts=state.get("broadcastOnEnter") is True,
                    package=package,
                    on_enter_signals=tuple(_collect_emitted(state.get("onEnterActions"))),
                )
                self.states[node.key] = node
        for raw in graph.get("transitions") or []:
            if not isinstance(raw, dict):
                continue
            conditions = raw.get("conditions") or []
            self.transitions.append(
                Transition(
                    graph_id=gid,
                    transition_id=str(raw.get("id") or ""),
                    from_state=str(raw.get("from") or ""),
                    to_state=str(raw.get("to") or ""),
                    signal=str(raw.get("signal") or ""),
                    trigger=str(raw.get("trigger") or "signal"),
                    conditions=tuple(conditions) if isinstance(conditions, list) else (),
                )
            )

    def _index_transitions(self) -> None:
        for t in self.transitions:
            self.by_from.setdefault(t.from_key, []).append(t)
            self.by_to.setdefault(t.to_key, []).append(t)
            self.by_transition_id[(t.graph_id, t.transition_id)] = t
            if t.signal:
                self.listeners.setdefault(t.signal, []).append(t)
        # 广播派生的信号也算发射端
        for node in self.states.values():
            if node.broadcasts:
                key = broadcast_key(node.graph_id, node.state_id)
                self.emitters.setdefault(key, []).append(
                    Emitter(
                        signal=key,
                        kind="broadcast",
                        source_id=node.key,
                        label=node.display,
                        detail=f"「{node.graph_label}」走到「{node.display}」时自动发出",
                    )
                )
            for sig in node.on_enter_signals:
                self.emitters.setdefault(sig, []).append(
                    Emitter(
                        signal=sig,
                        kind="stateAction",
                        source_id=node.key,
                        label=node.display,
                        detail=f"「{node.graph_label}」进入「{node.display}」时发出",
                    )
                )

    def _propagate_dialogue_triggers(self, docs: dict[str, dict[str, Any]]) -> None:
        """对话会跳对话（A 演完接 B）。下游那段的"在哪儿"要顺着链条继承上游的。

        不传播的话，主线上大半的戏都答不出地点——它们不是场景直接挂的，
        是被开场那段一路带过来的。
        """
        edges: dict[str, list[str]] = {}
        for dialogue_id, data in docs.items():
            for target in _collect_dialogue_graphs(data):
                if target != dialogue_id:
                    edges.setdefault(dialogue_id, []).append(target)
        # 迭代到收敛；对话链很浅，几轮就停，上限只是防数据成环
        for _ in range(6):
            changed = False
            for source, targets in edges.items():
                origin = self.dialogue_triggers.get(source)
                if not origin:
                    continue
                inherited = TriggerPoint(scene=origin[0].scene, actor="", kind="chained")
                for target in targets:
                    existing = self.dialogue_triggers.setdefault(target, [])
                    if any(t.scene == inherited.scene for t in existing):
                        continue
                    existing.append(inherited)
                    changed = True
            if not changed:
                break

    def _scan_dialogue_emitters(self) -> None:
        if not self.dialogue_dir.is_dir():
            return
        docs: dict[str, dict[str, Any]] = {}
        for path in sorted(self.dialogue_dir.glob("*.json")):
            data = self._read_json(path)
            if isinstance(data, dict):
                docs[str(data.get("id") or path.stem)] = data
        self._propagate_dialogue_triggers(docs)

        for dialogue_id, data in docs.items():
            triggers = self.dialogue_triggers.get(dialogue_id) or []
            # 优先级＝对策划的有用程度：找谁 > 点什么 > 走进哪 > 进场景自动演
            order = {"npc": 0, "hotspot": 1, "zone": 2, "sceneEnter": 3, "chained": 4}
            trigger = min(triggers, key=lambda t: order.get(t.kind, 9)) if triggers else None
            lines = _lines_near_signals(data.get("nodes"))
            for signal in _collect_emitted(data.get("nodes")):
                line_kind, line = lines.get(signal, ("", ""))
                self.emitters.setdefault(signal, []).append(
                    Emitter(
                        signal=signal,
                        kind="dialogue",
                        source_id=dialogue_id,
                        label=dialogue_id,
                        scene=trigger.scene if trigger else "",
                        actor=trigger.actor if trigger and trigger.kind != "zone" else "",
                        trigger_kind=trigger.kind if trigger else "",
                        line=line,
                        line_kind=line_kind,
                        detail=f"对话「{dialogue_id}」里说到某一句时发出",
                    )
                )

    def _scan_zone_emitters(self) -> None:
        """zoneBlackbox 只有声明（meta.emits），没有真实动作树可扫——声明即口径。"""
        for comp in self.compositions:
            for element in comp.get("elements") or []:
                if not isinstance(element, dict):
                    continue
                if element.get("kind") != "zoneBlackbox":
                    continue
                ref = str(element.get("refId") or element.get("label") or "")
                scene, _, zone = ref.partition(":")
                meta = element.get("meta") or {}
                for signal in meta.get("emits") or []:
                    sig = str(signal or "").strip()
                    if not sig:
                        continue
                    self.emitters.setdefault(sig, []).append(
                        Emitter(
                            signal=sig,
                            kind="zone",
                            source_id=ref,
                            label=zone or ref,
                            scene=scene,
                            detail=f"走进「{scene}」的「{zone or ref}」区域时发出",
                        )
                    )

    def _build_beats(self) -> None:
        """主线拍子 = mainGraph 的状态按迁移拓扑排序；子图状态作为二级拍子。"""
        order = 0
        for comp in self.compositions:
            comp_id = str(comp.get("id") or "")
            comp_label = str(comp.get("label") or comp_id)
            main = comp.get("mainGraph")
            if not isinstance(main, dict) or not main.get("id"):
                continue
            gid = str(main["id"])
            # 只收从起点走得到的状态：编辑器留下的孤立空壳（state_1 之类）
            # 混进正戏清单里，会让策划以为自己写错了。
            for sid in self._topological_states(gid, reachable_only=True):
                node = self.states.get(f"{gid}.{sid}")
                if node is None:
                    continue
                self.beats.append(
                    Beat(
                        composition_id=comp_id,
                        composition_label=comp_label,
                        graph_id=gid,
                        state_id=sid,
                        label=node.display,
                        order=order,
                        is_mainline=True,
                    )
                )
                order += 1

    def _topological_states(self, graph_id: str, *, reachable_only: bool = False) -> list[str]:
        graph = self.graphs.get(graph_id) or {}
        states = list((graph.get("states") or {}).keys())
        initial = str(graph.get("initialState") or "")
        edges: dict[str, list[str]] = {}
        for t in self.transitions:
            if t.graph_id != graph_id:
                continue
            edges.setdefault(t.from_state, []).append(t.to_state)
        ordered: list[str] = []
        seen: set[str] = set()
        queue = [initial] if initial in states else []
        while queue:
            cur = queue.pop(0)
            if cur in seen:
                continue
            seen.add(cur)
            ordered.append(cur)
            for nxt in edges.get(cur, []):
                if nxt not in seen:
                    queue.append(nxt)
        if not reachable_only:
            ordered.extend(s for s in states if s not in seen)
        return ordered

    # ---- 查询 ---------------------------------------------------------

    def state(self, graph_id: str, state_id: str) -> StateNode | None:
        return self.states.get(f"{graph_id}.{state_id}")

    def exits(self, graph_id: str, state_id: str) -> list[Transition]:
        """这个状态的出口转移（策划视角：现在在等什么）。"""
        return list(self.by_from.get(f"{graph_id}.{state_id}", []))

    def emitters_for(self, signal: str) -> list[Emitter]:
        return list(self.emitters.get(signal, []))

    def is_dangling(self, signal: str) -> bool:
        return signal not in self.listeners

    def successors(self, key: str) -> list[tuple[str, str, bool]]:
        """(目标节点 key, 边标签, 是否跨图派生)。"""
        out: list[tuple[str, str, bool]] = []
        for t in self.by_from.get(key, []):
            if t.is_unwired:
                continue
            # 反应式没有信号可标，标条件——边上写 __draft__ 等于告诉人"这没接"
            label = "条件满足自动走" if t.is_reactive else t.signal
            out.append((t.to_key, label, False))
        node = self.states.get(key)
        if node is not None and node.broadcasts:
            derived = broadcast_key(node.graph_id, node.state_id)
            for t in self.listeners.get(derived, []):
                out.append((t.to_key, derived, True))
        if node is not None:
            for sig in node.on_enter_signals:
                for t in self.listeners.get(sig, []):
                    out.append((t.to_key, sig, True))
        return out

    def predecessors(self, key: str) -> list[tuple[str, str, bool]]:
        out: list[tuple[str, str, bool]] = []
        for t in self.by_to.get(key, []):
            # 编辑器占位不是真路：画出来只会让人以为"开局前面还有一拍"。
            # 但**反应式转移不算占位**（见 Transition.is_unwired）。
            if t.is_unwired:
                continue
            out.append((t.from_key, "条件满足自动走" if t.is_reactive else t.signal, False))
            if t.signal.startswith(BROADCAST_PREFIX):
                body = t.signal[len(BROADCAST_PREFIX):]
                src_graph, _, src_state = body.rpartition(":")
                src_key = f"{src_graph}.{src_state}"
                if src_key in self.states:
                    out.append((src_key, t.signal, True))
            else:
                for emitter in self.emitters.get(t.signal, []):
                    if emitter.kind == "stateAction" and emitter.source_id in self.states:
                        out.append((emitter.source_id, t.signal, True))
        return out

    # ---- 按场景聚合 ---------------------------------------------------

    def scene_signals(self, scene: str) -> list[str]:
        """这个场景里能打出哪些信号（对话/区域/热点/压力条/小游戏都算）。"""
        if not self._scene_signal_cache:
            for signal, emitters in self.emitters.items():
                for emitter in emitters:
                    if emitter.scene:
                        self._scene_signal_cache.setdefault(emitter.scene, set()).add(signal)
        return sorted(self._scene_signal_cache.get(scene, set()))

    def scene_graphs(self, scene: str) -> list[tuple[str, list[StateNode]]]:
        """人一进这个场景，这儿能推动的**每一条线和它的每个状态**。

        策划站在雾津街头，脑子里的问题是"这儿都有什么戏"——只列主线那 12 拍
        远远不够（主线下面还挂着三十多张子图）。这里按线分组给全。
        """
        graph_ids: set[str] = set()
        for signal in self.scene_signals(scene):
            for t in self.listeners.get(signal, []):
                graph_ids.add(t.graph_id)
        out: list[tuple[str, list[StateNode]]] = []
        for graph_id in sorted(graph_ids, key=lambda g: self.graph_labels.get(g, g)):
            nodes = [
                self.states[f"{graph_id}.{sid}"]
                for sid in self._topological_states(graph_id, reachable_only=True)
                if f"{graph_id}.{sid}" in self.states
            ]
            if nodes:
                out.append((graph_id, nodes))
        return out

    def graph_states(self, graph_id: str) -> list[StateNode]:
        """一张图从起点走得到的全部状态（拓扑序）。"""
        return [
            self.states[f"{graph_id}.{sid}"]
            for sid in self._topological_states(graph_id, reachable_only=True)
            if f"{graph_id}.{sid}" in self.states
        ]

    def graphs_in_composition(self, composition_id: str) -> list[str]:
        """一条线下面挂的全部图（主图 + 它的子图），按标签排。"""
        ids = [g for g, comp in self.graph_composition.items() if comp == composition_id]
        return sorted(ids, key=lambda g: self.graph_labels.get(g, g))

    # ---- 条件翻译（索引建完后按需算，才能把 id 换成人话 label） ----------

    # 条件的人话渲染在 tools/narrative_xref/phrases.py（编辑器面板与调试器共用一份）——
    # 各写一遍的话，同一条条件在两个工具里读着不一样，策划就得学两套话。
    def describe_conditions(self, conditions: Iterable[Any]) -> str:
        return xref_describe_conditions(conditions, self._state_phrase)

    def condition_parts(self, conditions: Iterable[Any]) -> list[str]:
        return xref_condition_parts(conditions, self._state_phrase)

    def describe_condition(self, cond: Any) -> str:
        return xref_describe_condition(cond, self._state_phrase)

    def _state_phrase(self, graph_id: str, state_id: str, verb: str) -> str:
        return _state_phrase(self, graph_id, state_id, verb)

    def neighborhood(self, focus: str, hops: int = 2) -> Neighborhood:
        """焦点 ±hops 跳的因果邻域。节点数天然被跳数限制在几十以内。"""
        result = Neighborhood(focus=focus)
        node = self.states.get(focus)
        if node is None:
            return result
        result.nodes[focus] = node
        result.depth[focus] = 0
        seen_edges: set[tuple[str, str, str]] = set()

        def walk(direction: int) -> None:
            frontier = [focus]
            for step in range(1, hops + 1):
                nxt: list[str] = []
                for key in frontier:
                    links = self.successors(key) if direction > 0 else self.predecessors(key)
                    for other, label, derived in links:
                        target = self.states.get(other)
                        if target is None:
                            continue
                        edge = (key, other, label) if direction > 0 else (other, key, label)
                        if edge not in seen_edges:
                            seen_edges.add(edge)
                            result.edges.append((edge[0], edge[1], label, derived))
                        if other not in result.nodes:
                            result.nodes[other] = target
                            result.depth[other] = direction * step
                            nxt.append(other)
                        elif abs(result.depth.get(other, 99)) > step:
                            result.depth[other] = direction * step
                frontier = nxt
                if not frontier:
                    break

        walk(1)
        walk(-1)
        return result


def _state_phrase(index: "NarrativeIndex", graph_id: str, state_id: str, verb: str) -> str:
    """把 (图 id, 状态 id) 说成人话。查不到就退回原 id，绝不编。"""
    node = index.state(str(graph_id), str(state_id))
    if node is None:
        return f"「{graph_id}」{verb}「{state_id}」"
    return f"「{node.graph_label}」{verb}「{node.display}」"


def _collect_param_ids(payload: Any, action_type: str, keys: tuple[str, ...]) -> list[str]:
    """深扫动作树，捞出某类动作的 id 参数（如 startPressureHold 的 id）。"""
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == action_type:
                params = node.get("params")
                if isinstance(params, dict):
                    for key in keys:
                        value = params.get(key)
                        if isinstance(value, str) and value.strip():
                            found.append(value.strip())
                            break
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    return list(dict.fromkeys(found))


def _direct_graph_ids(container: dict[str, Any]) -> list[str]:
    """热点/区域上直挂的对话图字段（data.graphId、dialogueGraphId 等）。"""
    found: list[str] = []
    for key in ("graphId", "dialogueGraphId"):
        value = container.get(key)
        if isinstance(value, str) and value.strip():
            found.append(value.strip())
    data = container.get("data")
    if isinstance(data, dict):
        for key in ("graphId", "dialogueGraphId"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                found.append(value.strip())
    return list(dict.fromkeys(found))


def _actor_name(npc: dict[str, Any]) -> str:
    """NPC 显示名。少数 NPC 没配 name（数据缺口），至少把 npc_ 前缀去掉别露给策划。"""
    name = str(npc.get("name") or "").strip()
    if name:
        return name
    raw = str(npc.get("id") or "").strip()
    return raw[4:] if raw.startswith("npc_") else raw


def _collect_dialogue_graphs(payload: Any) -> list[str]:
    """从任意动作树里捞出 startDialogueGraph 的 graphId。"""
    found: list[str] = []

    def walk(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "startDialogueGraph":
                params = node.get("params")
                if isinstance(params, dict):
                    gid = str(params.get("graphId") or "").strip()
                    if gid:
                        found.append(gid)
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(payload)
    return list(dict.fromkeys(found))


def _lines_near_signals(nodes: Any) -> dict[str, tuple[str, str]]:
    """信号 → (那一下是什么性质, 原话)。

    发信号的节点几乎都是 ``runActions``，本身没台词。真正有意义的是它的**前驱**：
    如果前驱是 choice，说明是玩家选了某个选项——那句选项文案就是策划要的
    "我该干什么"；如果前驱是 line，就是听完那句话之后。取不到就留空，不编。
    """
    out: dict[str, tuple[str, str]] = {}
    if not isinstance(nodes, dict):
        return out

    # node id → [(前驱 node, 经由的选项文案)]
    incoming: dict[str, list[tuple[dict[str, Any], str]]] = {}
    for node in nodes.values():
        if not isinstance(node, dict):
            continue
        nxt = node.get("next")
        if isinstance(nxt, str) and nxt:
            incoming.setdefault(nxt, []).append((node, ""))
        for option in node.get("options") or []:
            if isinstance(option, dict) and isinstance(option.get("next"), str):
                incoming.setdefault(option["next"], []).append((node, str(option.get("text") or "")))
        for case in node.get("cases") or []:
            if isinstance(case, dict) and isinstance(case.get("next"), str):
                incoming.setdefault(case["next"], []).append((node, ""))

    for node_id, node in nodes.items():
        if not isinstance(node, dict):
            continue
        signals = _collect_emitted(node)
        if not signals:
            continue
        kind, text = "", ""
        for prev, option_text in incoming.get(str(node_id), []):
            if option_text:
                kind, text = "choice", option_text
                break
            prev_text = prev.get("text")
            if isinstance(prev_text, str) and prev_text.strip():
                kind, text = "line", prev_text.strip()
        if not text:
            nxt = node.get("next")
            follow = nodes.get(nxt) if isinstance(nxt, str) else None
            if isinstance(follow, dict) and isinstance(follow.get("text"), str):
                kind, text = "before", follow["text"].strip()
        if not text:
            text = _first_text(node)
            kind = "line" if text else ""
        for signal in signals:
            if text and signal not in out:
                out[signal] = (kind, _strip_quotes(text))
    return out


def _strip_quotes(text: str) -> str:
    return " ".join(text.split()).strip("「」\"'“”")


_TEXT_KEYS = ("text", "line", "say", "content", "label")


def _first_text(node: Any, depth: int = 0) -> str:
    if depth > 4:
        return ""
    if isinstance(node, dict):
        for key in _TEXT_KEYS:
            value = node.get(key)
            if isinstance(value, str) and value.strip() and not value.startswith("["):
                return value.strip()
        for value in node.values():
            found = _first_text(value, depth + 1)
            if found:
                return found
    elif isinstance(node, list):
        for item in node:
            found = _first_text(item, depth + 1)
            if found:
                return found
    return ""


def _collect_emitted(payload: Any) -> list[str]:
    """深扫任意动作树，捞出所有 emitNarrativeSignal 的 signal（含 randomBranch 等嵌套）。"""
    found: list[str] = []
    _walk_actions(payload, found)
    # 去重保序
    seen: set[str] = set()
    out: list[str] = []
    for sig in found:
        if sig and sig not in seen:
            seen.add(sig)
            out.append(sig)
    return out


def _walk_actions(payload: Any, out: list[str]) -> None:
    if isinstance(payload, dict):
        if payload.get("type") == "emitNarrativeSignal":
            params = payload.get("params")
            if isinstance(params, dict):
                sig = str(params.get("signal") or "").strip()
                if sig:
                    out.append(sig)
        for value in payload.values():
            _walk_actions(value, out)
    elif isinstance(payload, list):
        for item in payload:
            _walk_actions(item, out)
