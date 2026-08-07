"""WebSocket 中枢：调试器是服务端，游戏与 MCP 都是客户端。

这样安排的三个理由：
- 谁先起都行（游戏连不上会退避重连，调试器起来就自动接上）。
- 调试器没开 = 游戏连不上 = 探针整条链路休眠，运行时零负担。
- agent（经 MCP）与策划（GUI）共享同一份状态：agent 跳一拍，GUI 上焦点跟着动。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable

from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtNetwork import QHostAddress
from PySide6.QtWebSockets import QWebSocket, QWebSocketServer

from tools.narrative_debugger.humanize import TimelineEntry, TraceTranslator
from tools.narrative_debugger.model import NarrativeIndex

DEFAULT_PORT = 5211
MAX_TIMELINE = 400
ROLE_GAME = "game"
ROLE_TOOL = "tool"
# 玩家动手之后等多久还没信号，就判定"这一下没往叙事里传"
ACTION_SILENCE_MS = 1200
_ACTION_ANSWERED_TYPES = {"signal.received", "signal.processed", "transition.blocked", "state.changed"}


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


class DebugHub(QObject):
    stateChanged = Signal()
    timelineAppended = Signal(object)
    timelineReplaced = Signal(int, object)
    timelineTrimmed = Signal(int)
    connectionChanged = Signal(bool)
    savepointCaptured = Signal(str, str, str, bool)  # key, label, payload, drifted
    savepointMissed = Signal(str, str)  # key, label
    breakpointHit = Signal(object)  # {graphId, stateId, fromStateId, triggerKey, transitionId}
    replyReceived = Signal(object)
    logged = Signal(str)

    def __init__(self, index: NarrativeIndex, port: int = DEFAULT_PORT, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.index = index
        self.translator = TraceTranslator(index)
        self.state = RuntimeState()
        self.timeline: list[TimelineEntry] = []
        self._port = port
        self._server = QWebSocketServer("gamedraft-narrative-debugger", QWebSocketServer.SslMode.NonSecureMode, self)
        self._clients: dict[QWebSocket, str] = {}
        self._game: QWebSocket | None = None
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
        self._game = None
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
        if client is self._game:
            self._game = None
            self.state.connected = False
            self.connectionChanged.emit(False)
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
                # ⚠ 调试器与游戏是 1:1（`_game` 单槽，命令只发给它）。又开一个游戏页签时
                # 必须把旧的**踢掉**：不踢的话旧页签若正断在断点上，`paused` 照样上报到面板、
                # 「继续」却发给了新页签，旧页签的 socket 一直开着 → 它自己的 onclose 自救
                # 永远不触发 → 那个页签冻死到关掉为止（实测复现过）。
                # 踢掉会触发旧页签的 onclose，那条路会强制放行并解冻。
                if self._game is not None and self._game is not client:
                    old = self._game
                    self._game = None
                    self.logged.emit("又一个游戏页签连上了，踢掉旧的（调试器与游戏是一对一）")
                    try:
                        old.close()
                    except RuntimeError:
                        pass
                self._game = client
                self.state.connected = True
                self.connectionChanged.emit(True)
                self.logged.emit("游戏已连上")
            return

        if kind == "batch":
            for item in message.get("items") or []:
                if isinstance(item, dict):
                    self._ingest(item)
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

    def _ingest(self, item: dict[str, Any]) -> None:
        kind = str(item.get("kind") or "")
        if kind == "state":
            self._apply_snapshot(item)
        elif kind == "trace":
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

    def _apply_snapshot(self, item: dict[str, Any]) -> None:
        snapshot = item.get("snapshot")
        if not isinstance(snapshot, dict):
            return
        self.state.snapshot = snapshot
        self.state.scene_id = str(item.get("sceneId") or "")
        self.state.can_save = item.get("canSave") is True
        narrative = snapshot.get("narrativeState")
        if isinstance(narrative, dict):
            active = narrative.get("activeStates")
            if isinstance(active, dict):
                self.state.active_states = {str(k): str(v) for k, v in active.items()}
            runs = narrative.get("runArchetypes")
            self.state.run_archetypes = [str(x) for x in runs] if isinstance(runs, list) else []
            self.state.activated_archetype = str(narrative.get("activatedArchetype") or "")
        self.state.last_update = datetime.now().strftime("%H:%M:%S")
        self.stateChanged.emit()

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

    # ---- 出站命令 -----------------------------------------------------

    def send_command(
        self,
        payload: dict[str, Any],
        on_reply: Callable[[dict[str, Any]], None] | None = None,
    ) -> bool:
        if self._game is None:
            if on_reply is not None:
                on_reply({"ok": False, "detail": "游戏没连上"})
            return False
        self._request_seq += 1
        request_id = self._request_seq
        if on_reply is not None:
            self._pending[request_id] = on_reply
        message = {"id": request_id, **payload}
        try:
            self._game.sendTextMessage(json.dumps(message, ensure_ascii=False))
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
