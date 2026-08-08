"""WebSocket 中枢：调试器是服务端，游戏与 MCP 都是客户端。

这样安排的三个理由：
- 谁先起都行（游戏连不上会退避重连，调试器起来就自动接上）。
- 调试器没开 = 游戏连不上 = 探针整条链路休眠，运行时零负担。
- agent（经 MCP）与策划（GUI）共享同一份状态：agent 跳一拍，GUI 上焦点跟着动。

**可以同时挂多个游戏页签**（一个开着码头、一个开着义庄），但任一时刻只调其中一个
（顶栏「调试对象」下拉切）。命令、断点、自动记点一律只发给当前那个；切走的那个
会被立刻放行并撤掉断点——否则它可能停在某一拍上冻死，而「继续」发给了另一个页签。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from datetime import datetime
from typing import Any, Callable
from urllib.parse import parse_qs, urlsplit

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtNetwork import QHostAddress
from PySide6.QtWebSockets import QWebSocket, QWebSocketServer

from tools.narrative_debugger import local_machines
from tools.narrative_debugger.humanize import TimelineEntry, TraceTranslator
from tools.narrative_debugger.local_machines import LocalInstance
from tools.narrative_debugger.model import NarrativeIndex

DEFAULT_PORT = 5211
MAX_TIMELINE = 400
ROLE_GAME = "game"
ROLE_TOOL = "tool"
# 玩家动手之后等多久还没信号，就判定"这一下没往叙事里传"
ACTION_SILENCE_MS = 1200
# 局部机那两条也算"系统听见了"：踢一脚箱子只动它自己那台私有机器时，全局图一动不动，
# 漏掉的话时间线会把这一下判成"没往叙事里传"——恰恰说反。
_ACTION_ANSWERED_TYPES = {
    "signal.received", "signal.processed", "transition.blocked", "state.changed",
    "local.state.changed", "local.var",
}
# 这三条 trace 带着实例键与增量，够本地把实例表推一格——引擎侧目前只在
# `state.changed` 之后重发快照（见 narrativeDebugBridge.onTrace），
# 干等快照的话，踢完箱子面板还写着旧状态。快照到了会覆盖回权威值。
_LOCAL_TRACE_TYPES = {"local.bound", "local.state.changed", "local.var"}


@dataclass
class RuntimeState:
    connected: bool = False
    scene_id: str = ""
    can_save: bool = False
    active_states: dict[str, str] = field(default_factory=dict)
    run_archetypes: list[str] = field(default_factory=list)
    activated_archetype: str = ""
    snapshot: dict[str, Any] = field(default_factory=dict)
    last_update: str = ""
    # 最近一次真正发生迁移的图——镜头跟着它走
    last_changed_graph: str = ""
    # 局部机层。**与 active_states 严格分表**——后者是全局图的表，1000 台私有机器混进去
    # 会把"戏走到哪"那一栏冲垮（运行时那边同理，见 NarrativeStateManager.localInstances）。
    local_instances: dict[str, LocalInstance] = field(default_factory=dict)
    local_machine_ids: list[str] = field(default_factory=list)

    def locals_list(self) -> list[LocalInstance]:
        """按实例键稳定排序：刷新之间行不跳动，人才盯得住某一行。"""
        return sorted(
            self.local_instances.values(),
            key=lambda i: (i.machine_id, i.scene_id, i.entity_id),
        )

    def primary_focus(self, index: NarrativeIndex) -> str:
        """镜头该对准哪儿。

        顺序很关键：**刚刚动过的那张图**优先——50 张图几乎全都常驻在某个状态上，
        按清单顺序挑会永远停在第一张图上（实测就踩过：戏走到听书了，镜头还杵在码头）。
        没有动静时才退回活计图 / 主线图。
        """
        if self.last_changed_graph:
            state_id = self.active_states.get(self.last_changed_graph)
            if state_id:
                return f"{self.last_changed_graph}.{state_id}"
        for graph_id in self.run_archetypes:
            state_id = self.active_states.get(graph_id)
            if state_id:
                return f"{graph_id}.{state_id}"
        for beat in index.beats:
            state_id = self.active_states.get(beat.graph_id)
            if state_id:
                return f"{beat.graph_id}.{state_id}"
        for graph_id, state_id in self.active_states.items():
            return f"{graph_id}.{state_id}"
        return ""


@dataclass
class GameTarget:
    """一个连上来的游戏页签。

    每个页签自带一份世界状态与时间线：切回去时还是你离开时那一屏，而不是被另一个
    页签的事件搅成一锅（两边同时在跑的时候，混在一起的时间线读不出任何东西）。
    **后台页签只更新自己的状态（用来在下拉里显示它在哪个场景），不记时间线**——
    没人看的那段路记下来只会让人以为自己漏了什么。
    """

    socket: Any
    client_id: str
    seq: int
    href: str = ""
    title: str = ""
    joined_at: str = ""
    state: RuntimeState = field(default_factory=RuntimeState)
    timeline: list[TimelineEntry] = field(default_factory=list)

    def entry_hint(self) -> str:
        """从地址栏认出这个页签是怎么进去的（直达哪一拍 / 哪个场景）。"""
        try:
            query = parse_qs(urlsplit(self.href).query)
        except ValueError:
            return ""
        for key in ("narrativeWarp", "narrative_warp"):
            if query.get(key):
                return f"直达 {query[key][0]}"
        for key in ("devScene", "dev_scene"):
            if query.get(key):
                return f"场景 {query[key][0]}"
        if query.get("play_cutscene"):
            return f"过场 {query['play_cutscene'][0]}"
        if query.get("screen_title"):
            return "标题界面"
        return ""


class DebugHub(QObject):
    stateChanged = Signal()
    timelineAppended = Signal(object)
    timelineReplaced = Signal(int, object)
    timelineTrimmed = Signal(int)
    connectionChanged = Signal(bool)
    savepointCaptured = Signal(str, str, str, bool)  # key, label, payload, drifted
    savepointMissed = Signal(str, str)  # key, label
    breakpointHit = Signal(object)  # {graphId, stateId, fromStateId, triggerKey, transitionId}
    # 局部机实例表变了。**单开一条**而不是复用 stateChanged：后者会带着左栏拍子清单、
    # 焦点图、信号关系窗一起重画，而局部机一条信号能让 1000 台机器同时动。
    localsChanged = Signal()
    replyReceived = Signal(object)
    logged = Signal(str)
    # 连上的游戏页签清单变了（新连 / 断开 / 换了场景 → 标签要重画）
    targetsChanged = Signal()
    # 换了调试对象：界面要整块换过去（时间线、拍子、焦点、断点下发）
    activeTargetChanged = Signal()

    def __init__(self, index: NarrativeIndex, port: int = DEFAULT_PORT, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.index = index
        self.translator = TraceTranslator(index)
        # 没有游戏连上时对外给一份"断开"的空状态，界面不用到处判 None
        self._idle_state = RuntimeState()
        self._idle_timeline: list[TimelineEntry] = []
        self._targets: list[GameTarget] = []
        self._active: GameTarget | None = None
        self._target_seq = 0
        self._port = port
        self._server = QWebSocketServer("gamedraft-narrative-debugger", QWebSocketServer.SslMode.NonSecureMode, self)
        self._clients: dict[QWebSocket, str] = {}
        self._request_seq = 0
        self._pending: dict[int, Callable[[dict[str, Any]], None]] = {}
        self._listen_error = ""
        self._stopping = False
        # 由主窗注入：处理"调试器自己能答"的 MCP 命令（档案库/拍子/焦点）。
        # 返回 None 表示这条命令该转给游戏。
        self.tool_handler: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None
        self._pending_action: tuple[int, TimelineEntry] | None = None
        self._action_timer = QTimer(self)
        self._action_timer.setSingleShot(True)
        self._action_timer.timeout.connect(self._on_action_silence)

    # ---- 调试对象（可能挂着多个游戏页签） -------------------------------

    @property
    def state(self) -> RuntimeState:
        """当前调试对象的世界状态；一个都没连上时是一份"断开"的空状态。"""
        return self._active.state if self._active is not None else self._idle_state

    @property
    def timeline(self) -> list[TimelineEntry]:
        return self._active.timeline if self._active is not None else self._idle_timeline

    @property
    def active_target_id(self) -> str:
        return self._active.client_id if self._active is not None else ""

    def targets(self) -> list[dict[str, Any]]:
        return [
            {"id": t.client_id, "label": self.target_label(t), "active": t is self._active}
            for t in self._targets
        ]

    def target_label(self, target: GameTarget) -> str:
        """下拉里那一行：认得出是哪个页签就行——场景名优先，其次看它是怎么进去的。"""
        scene_id = target.state.scene_id
        scene = self.index.scene_names.get(scene_id, scene_id)
        hint = target.entry_hint()
        # 已经走到入口指的那个场景了就不再重复一遍（"dock_day · 场景 dock_day" 白占宽度）
        if hint and scene_id and hint.endswith(scene_id):
            hint = ""
        parts = [p for p in (scene or "", hint) if p]
        tail = " · ".join(parts) if parts else "刚连上"
        return f"游戏 {target.seq} · {tail}"

    def set_active_target(self, client_id: str) -> bool:
        """换人调。切走的那个必须当场解除武装，否则会留下一个冻死的页签。"""
        target = next((t for t in self._targets if t.client_id == client_id), None)
        if target is None or target is self._active:
            return False
        self._release(self._active)
        self._active = target
        self._forget_pending_action()
        self.logged.emit(f"改调 {self.target_label(target)}")
        self.targetsChanged.emit()
        self.activeTargetChanged.emit()
        self.stateChanged.emit()
        return True

    def _forget_pending_action(self) -> None:
        """「刚才那一下有没有人应」的等待是**跟着当前页签**的。

        换人还留着的话，那个下标指的是上一条时间线里的位置——轻则把新页签的某一行
        改写成"没传进去"，重则指到一条根本不是它的行上。
        """
        self._pending_action = None
        self._action_timer.stop()

    def _release(self, target: GameTarget | None) -> None:
        """把一个页签放回"没人调"的状态：撤断点、解除单步、放行、停掉自动记点。

        ⚠ 这三条缺一不可。断点表不撤，它会在没人看的时候停住；不放行，它可能**正**停着，
        而「继续」按钮此刻指向的是另一个页签——那个页签就只能关掉重开（实测踩过）。
        """
        if target is None:
            return
        self._send_to(target, {"command": "setBreakpoints", "breakpoints": []})
        self._send_to(target, {"command": "disarmStep"})
        self._send_to(target, {"command": "continue"})
        self._send_to(target, {"command": "setAutoSavepoints", "enabled": False})

    # ---- 生命周期 -----------------------------------------------------

    def start(self) -> bool:
        if not self._server.listen(QHostAddress("127.0.0.1"), self._port):
            self._listen_error = self._server.errorString()
            return False
        self._server.newConnection.connect(self._on_new_connection)
        return True

    @property
    def port(self) -> int:
        return self._port

    @property
    def listen_error(self) -> str:
        return self._listen_error

    def stop(self) -> None:
        self._stopping = True
        for client in list(self._clients):
            try:
                client.close()
            except RuntimeError:
                pass
        self._clients.clear()
        self._targets.clear()
        self._active = None
        self._server.close()

    # ---- 连接 ---------------------------------------------------------

    def _on_new_connection(self) -> None:
        while True:
            client = self._server.nextPendingConnection()
            if client is None:
                break
            self._clients[client] = ""
            client.textMessageReceived.connect(lambda msg, c=client: self._on_message(c, msg))
            client.disconnected.connect(lambda c=client: self._on_disconnected(c))

    def _on_disconnected(self, client: QWebSocket) -> None:
        if self._stopping:
            return
        role = self._clients.pop(client, "")
        target = next((t for t in self._targets if t.socket is client), None)
        if target is not None:
            self._targets.remove(target)
            if target is self._active:
                # 换成还连着的里面最近连上的那个：手上有别的页签就别把界面清空
                self._active = self._targets[-1] if self._targets else None
                self._forget_pending_action()
                if self._active is None:
                    self.connectionChanged.emit(False)
                else:
                    self.logged.emit(f"刚才那个页签断了，改调 {self.target_label(self._active)}")
                    self.activeTargetChanged.emit()
                    self.stateChanged.emit()
            self.targetsChanged.emit()
        if role:
            self.logged.emit(f"{role} 断开")
        try:
            client.deleteLater()
        except RuntimeError:
            # 关窗竞态：Qt 侧已回收该 socket，忽略即可
            pass

    def _on_message(self, client: QWebSocket, raw: str) -> None:
        try:
            message = json.loads(raw)
        except json.JSONDecodeError:
            return
        if not isinstance(message, dict):
            return
        kind = str(message.get("type") or "")

        if kind == "hello":
            role = str(message.get("role") or ROLE_TOOL)
            self._clients[client] = role
            if role == ROLE_GAME:
                self._on_game_hello(client, message)
            return

        if kind == "batch":
            target = next((t for t in self._targets if t.socket is client), None)
            if target is None:
                return
            for item in message.get("items") or []:
                if isinstance(item, dict):
                    self._ingest(item, target)
            return

        if kind == "reply":
            self._on_reply(message)
            return

        if kind == "command":
            payload = dict(message.get("payload") or {})
            request_id = message.get("id")
            # 调试器自己能答的（档案库、拍子清单、当前焦点）就地回答，不打扰游戏。
            if self.tool_handler is not None:
                handled = self.tool_handler(payload)
                if handled is not None:
                    self._forward_reply(client, request_id, handled)
                    return
            self.send_command(
                payload,
                lambda reply, c=client, rid=request_id: self._forward_reply(c, rid, reply),
            )
            return

    def _on_game_hello(self, client: QWebSocket, message: dict[str, Any]) -> None:
        """一个游戏页签报到。

        同一个 clientId 再来一次＝那个页签重连（调试器刚重启之类），沿用原来那一条，
        不在清单里多冒出一个"新页签"，也不抢走当前正调的那个。
        """
        client_id = str(message.get("clientId") or "") or f"anon-{id(client)}"
        href = str(message.get("href") or "")
        title = str(message.get("title") or "")
        existing = next((t for t in self._targets if t.client_id == client_id), None)
        if existing is not None:
            existing.socket = client
            existing.href = href or existing.href
            existing.title = title or existing.title
            existing.state.connected = True
            self.targetsChanged.emit()
            if existing is self._active:
                self.connectionChanged.emit(True)
            return

        self._target_seq += 1
        target = GameTarget(
            socket=client,
            client_id=client_id,
            seq=self._target_seq,
            href=href,
            title=title,
            joined_at=datetime.now().strftime("%H:%M:%S"),
        )
        target.state.connected = True
        self._targets.append(target)
        previous = self._active
        # 新开的页签就是人正看着的那个：自动切过去（切错了顶栏一下就能切回来）
        self._release(previous)
        self._active = target
        self.targetsChanged.emit()
        if previous is None:
            self.logged.emit("游戏已连上")
            self.connectionChanged.emit(True)
        else:
            self.logged.emit("又开了一个游戏页签，已切过去调它（顶栏「调试对象」可切回）")
            self.activeTargetChanged.emit()
            self.stateChanged.emit()

    def _forward_reply(self, client: QWebSocket, request_id: Any, reply: dict[str, Any]) -> None:
        try:
            client.sendTextMessage(json.dumps({"type": "reply", "id": request_id, **reply}, ensure_ascii=False))
        except RuntimeError:
            pass

    def _on_reply(self, message: dict[str, Any]) -> None:
        handler = self._pending.pop(_as_int(message.get("id")), None)
        if handler is not None:
            handler(message)
        self.replyReceived.emit(message)

    # ---- 入站数据 -----------------------------------------------------

    def _ingest(self, item: dict[str, Any], target: GameTarget) -> None:
        kind = str(item.get("kind") or "")
        if kind == "state":
            # 后台页签的快照也收：下拉里得说得出它在哪个场景。但只有当前这个才通知界面。
            self._apply_snapshot(item, target)
            return
        if target is not self._active:
            # 没人在调的页签不记时间线，也不许它的存档点/断点命中冒出来（它的断点早撤了）
            return
        if kind == "trace":
            self._apply_trace(item.get("event") or {})
        elif kind == "playerAction":
            self._apply_player_action(str(item.get("action") or ""), str(item.get("label") or ""))
        elif kind == "savepoint":
            self.savepointCaptured.emit(
                str(item.get("key") or ""),
                str(item.get("label") or ""),
                str(item.get("payload") or ""),
                item.get("drifted") is True,
            )
        elif kind == "paused":
            hit = item.get("hit")
            if isinstance(hit, dict):
                self.breakpointHit.emit(hit)
        elif kind == "savepointMissed":
            # 存不上要说出来。只报"存了 N 个点"的话，等策划要回去的时候
            # 才发现最想改的那几拍恰好一个都没有。
            self.savepointMissed.emit(str(item.get("key") or ""), str(item.get("label") or ""))

    def _apply_snapshot(self, item: dict[str, Any], target: GameTarget) -> None:
        snapshot = item.get("snapshot")
        if not isinstance(snapshot, dict):
            return
        state = target.state
        scene_before = state.scene_id
        state.snapshot = snapshot
        state.scene_id = str(item.get("sceneId") or "")
        state.can_save = item.get("canSave") is True
        narrative = snapshot.get("narrativeState")
        if isinstance(narrative, dict):
            active = narrative.get("activeStates")
            if isinstance(active, dict):
                state.active_states = {str(k): str(v) for k, v in active.items()}
            runs = narrative.get("runArchetypes")
            state.run_archetypes = [str(x) for x in runs] if isinstance(runs, list) else []
            state.activated_archetype = str(narrative.get("activatedArchetype") or "")
            machines = narrative.get("localMachineIds")
            state.local_machine_ids = [str(x) for x in machines] if isinstance(machines, list) else []
            # 快照是权威：整表换掉，把此前按 trace 推的乐观值全部对齐回去
            if "localInstances" in narrative:
                state.local_instances = {
                    inst.key: inst for inst in local_machines.read_instances(narrative, self.index)
                }
        state.last_update = datetime.now().strftime("%H:%M:%S")
        if target is self._active:
            self.stateChanged.emit()
            self.localsChanged.emit()
        if scene_before != state.scene_id:
            # 下拉里那一行认的是场景名，换场景就得重画（后台页签也一样）
            self.targetsChanged.emit()

    def _apply_player_action(self, action: str, label: str) -> None:
        """玩家动手了。先记一行，再等一会儿看有没有信号跟上。

        没跟上就把这行改成"这一下没往叙事里传"——这正是策划最常遇到、
        而工具过去全程沉默的那个场景（点了人，什么都没发生）。
        """
        entry = self.translator.player_action_entry(action, label, datetime.now().strftime("%H:%M:%S"))
        if entry is None:
            return
        self.timeline.append(entry)
        index = len(self.timeline) - 1
        self.timelineAppended.emit(entry)
        self._pending_action = (index, entry)
        self._action_timer.start(ACTION_SILENCE_MS)

    def _on_action_silence(self) -> None:
        pending = self._pending_action
        self._pending_action = None
        if pending is None:
            return
        index, entry = pending
        if index >= len(self.timeline) or self.timeline[index] is not entry:
            return
        updated = self.translator.silent_action_entry(entry)
        self.timeline[index] = updated
        self.timelineReplaced.emit(index, updated)

    def _apply_trace(self, event: dict[str, Any]) -> None:
        at = datetime.now().strftime("%H:%M:%S")
        # 有信号跟上来了，说明刚才那一下被系统认了——撤掉"没传进去"的判定
        if str(event.get("type") or "") in _ACTION_ANSWERED_TYPES:
            self._pending_action = None
            self._action_timer.stop()
        if str(event.get("type") or "") == "state.changed":
            graph_id = str(event.get("graphId") or "")
            if graph_id:
                self.state.last_changed_graph = graph_id
        if str(event.get("type") or "") in _LOCAL_TRACE_TYPES:
            self._apply_local_trace(event)
        entry = self.translator.translate(event, at)
        if entry is None:
            return
        # merge_key：同一个玩家动作的"发出"与"结果"合成一行，不让策划读两条技术事件。
        if entry.merge_key:
            for i in range(len(self.timeline) - 1, max(-1, len(self.timeline) - 12), -1):
                if self.timeline[i].merge_key == entry.merge_key:
                    self.timeline[i] = entry
                    self.timelineReplaced.emit(i, entry)
                    return
        self.timeline.append(entry)
        if len(self.timeline) > MAX_TIMELINE:
            trimmed = len(self.timeline) - MAX_TIMELINE
            del self.timeline[:trimmed]
            self.timelineTrimmed.emit(trimmed)
        self.timelineAppended.emit(entry)

    def _apply_local_trace(self, event: dict[str, Any]) -> None:
        """按 trace 把实例表推一格（乐观更新，下一份快照到达时会被覆盖成权威值）。

        为什么要这么做：引擎侧只在 `state.changed` 之后重发快照，而局部机走的是
        `local.state.changed`——干等的话，踢完箱子面板还写着上一态，"看着没生效"
        与"真没生效"当场分不开，那正是这个面板存在的理由。
        """
        kind = str(event.get("type") or "")
        key = str(event.get("label") or "")
        if not key:
            return
        table = self.state.local_instances
        inst = table.get(key)

        if kind == "local.bound":
            if inst is None:
                parsed = local_machines.parse_instance_key(key)
                if parsed is None:
                    return
                table[key] = LocalInstance(
                    key=key,
                    machine_id=parsed.machine_id,
                    scene_id=parsed.scene_id,
                    entity_kind=parsed.entity_kind,
                    entity_id=parsed.entity_id,
                    active=str(event.get("stateId") or ""),
                    loaded=True,   # 绑定发生在场景装载时，天然在场
                )
        elif inst is None:
            # 没见过这个键（快照还没到）：也建一条，宁可先显示出来再被快照修正，
            # 也不要让面板对刚发生的事装聋
            parsed = local_machines.parse_instance_key(key)
            if parsed is None:
                return
            inst = LocalInstance(
                key=key,
                machine_id=parsed.machine_id,
                scene_id=parsed.scene_id,
                entity_kind=parsed.entity_kind,
                entity_id=parsed.entity_id,
                active="",
            )
            table[key] = inst

        if kind == "local.state.changed":
            # 预告那一条（宿主不在场）没有 stateId，只有 to；两者都认
            to_state = str(event.get("to") or event.get("stateId") or "")
            if to_state:
                table[key] = replace(table[key], active=to_state)
        elif kind == "local.var":
            payload = event.get("payload") or {}
            var_key = str(payload.get("key") or "")
            if var_key:
                merged = dict(table[key].overrides)
                merged[var_key] = payload.get("value")
                table[key] = replace(table[key], overrides=merged)

        self.localsChanged.emit()

    # ---- 出站命令 -----------------------------------------------------

    def send_command(
        self,
        payload: dict[str, Any],
        on_reply: Callable[[dict[str, Any]], None] | None = None,
    ) -> bool:
        """发给**当前调试对象**。别的页签一条都收不到（断点、跳拍都只作用于眼前这个）。"""
        if self._active is None:
            if on_reply is not None:
                on_reply({"ok": False, "detail": "游戏没连上"})
            return False
        return self._send_to(self._active, payload, on_reply)

    def _send_to(
        self,
        target: GameTarget,
        payload: dict[str, Any],
        on_reply: Callable[[dict[str, Any]], None] | None = None,
    ) -> bool:
        self._request_seq += 1
        request_id = self._request_seq
        if on_reply is not None:
            self._pending[request_id] = on_reply
        message = {"id": request_id, **payload}
        try:
            target.socket.sendTextMessage(json.dumps(message, ensure_ascii=False))
        except RuntimeError:
            self._pending.pop(request_id, None)
            if on_reply is not None:
                on_reply({"ok": False, "detail": "发送失败"})
            return False
        return True

    def clear_timeline(self) -> None:
        self.timeline.clear()


def _as_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1
