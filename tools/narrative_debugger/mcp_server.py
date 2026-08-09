"""MCP server：让 agent 也能读叙事状态、跳拍、发信号。

手写 JSON-RPC over stdio（与 tools/skill_workflow_governance 同套路），零新依赖。

它不自己连游戏——而是作为客户端连到**调试器进程**的同一个 WebSocket 端口。
好处是 agent 与策划共享一份状态：agent 跳一拍，策划屏幕上焦点跟着动。
调试器没开时，只读类工具仍可用（直接读 JSON 数据），操作类工具明确报"调试器没开"。
"""
from __future__ import annotations

import json
import socket
import sys
from base64 import b64encode
from hashlib import sha1
from pathlib import Path
from typing import Any

from tools.narrative_debugger.humanize import player_action_for, waiting_items
from tools.narrative_debugger.model import NarrativeIndex
from tools.narrative_xref import CHANNEL_UPSTREAM

PROTOCOL_VERSION = "2024-11-05"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
DEFAULT_PORT = 5211
SOCKET_TIMEOUT = 6.0

TOOLS: list[dict[str, Any]] = [
    {
        "name": "narrative_state",
        "description": "叙事状态机当前全貌：每张图停在哪个状态、当前活计、场景。调试器没开时返回静态结构。",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "narrative_waiting",
        "description": "当前这一拍在等什么，以及要让它走下去玩家具体该做什么动作（下钻到对话/区域）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "graphId": {"type": "string", "description": "不填则用运行时当前主线图"},
                "stateId": {"type": "string"},
            },
        },
    },
    {
        "name": "narrative_timeline",
        "description": "最近发生了什么（已译成人话）：哪一下被听见了、哪一下悬垂、哪一下被条件挡住。",
        "inputSchema": {
            "type": "object",
            "properties": {"limit": {"type": "integer", "description": "默认 30"}},
        },
    },
    {
        "name": "narrative_beats",
        "description": "列出所有拍子（策划口径的中文名），标注哪些有存档点可精确回溯。",
        "inputSchema": {
            "type": "object",
            "properties": {"compositionId": {"type": "string"}},
        },
    },
    {
        "name": "narrative_goto",
        "description": "回到某一拍。优先读该拍的全量存档（世界状态精确回溯）；没有存档时可选强推状态机。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "beat": {"type": "string", "description": "拍子 key，形如 graphId.stateId"},
                "forceSetState": {"type": "boolean", "description": "没有存档时是否强推状态机（默认 false）"},
            },
            "required": ["beat"],
        },
    },
    {
        "name": "narrative_emit",
        "description": (
            "补发一个叙事信号，模拟「那件事已经发生」。"
            "私有信号（scope:private）必须带 ownerType/ownerId 指明是哪个实体发的，"
            "否则运行时直接丢弃；不带时本工具会退回并列出可选的 owner。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "signal": {"type": "string"},
                "ownerType": {"type": "string", "description": "私有信号专用：发射方类型（npc/hotspot/zone…）"},
                "ownerId": {"type": "string", "description": "私有信号专用：发射方实体 id"},
            },
            "required": ["signal"],
        },
    },
    {
        "name": "narrative_capture",
        "description": "把此刻的世界状态存成一个可回溯的点。",
        "inputSchema": {
            "type": "object",
            "properties": {"label": {"type": "string"}},
        },
    },
    {
        "name": "narrative_signal_info",
        "description": "查一个信号：谁发它、谁听它、黑盒声明、两侧对不齐的诊断、是不是悬垂。",
        "inputSchema": {
            "type": "object",
            "properties": {"signal": {"type": "string"}},
            "required": ["signal"],
        },
    },
]


class DebuggerLink:
    """极简 WebSocket 客户端（同步、短连接）。只发一条命令收一条回复，够用且无依赖。"""

    def __init__(self, port: int) -> None:
        self.port = port

    def request(self, payload: dict[str, Any]) -> dict[str, Any]:
        try:
            sock = socket.create_connection(("127.0.0.1", self.port), timeout=SOCKET_TIMEOUT)
        except OSError as exc:
            return {"ok": False, "detail": f"调试器没开（127.0.0.1:{self.port}）：{exc}"}
        try:
            sock.settimeout(SOCKET_TIMEOUT)
            if not self._handshake(sock):
                return {"ok": False, "detail": "WebSocket 握手失败"}
            self._send(sock, json.dumps({"type": "hello", "role": "tool"}, ensure_ascii=False))
            self._send(sock, json.dumps({"type": "command", "id": 1, "payload": payload}, ensure_ascii=False))
            while True:
                raw = self._recv(sock)
                if raw is None:
                    return {"ok": False, "detail": "调试器没有回复"}
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if isinstance(message, dict) and message.get("type") == "reply":
                    return {k: v for k, v in message.items() if k != "type"}
        finally:
            try:
                sock.close()
            except OSError:
                pass

    def _handshake(self, sock: socket.socket) -> bool:
        key = b64encode(b"gamedraft-mcp-0001").decode()
        request = (
            f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        )
        sock.sendall(request.encode())
        buffer = b""
        while b"\r\n\r\n" not in buffer:
            chunk = sock.recv(4096)
            if not chunk:
                return False
            buffer += chunk
            if len(buffer) > 65536:
                return False
        header = buffer.split(b"\r\n\r\n", 1)[0].decode(errors="replace")
        expected = b64encode(sha1((key + WS_GUID).encode()).digest()).decode()
        self._tail = buffer.split(b"\r\n\r\n", 1)[1]
        return "101" in header.split("\r\n")[0] and expected in header

    def _send(self, sock: socket.socket, text: str) -> None:
        data = text.encode("utf-8")
        header = bytearray([0x81])
        length = len(data)
        if length < 126:
            header.append(0x80 | length)
        elif length < (1 << 16):
            header.append(0x80 | 126)
            header += length.to_bytes(2, "big")
        else:
            header.append(0x80 | 127)
            header += length.to_bytes(8, "big")
        mask = b"\x37\xfa\x21\x3d"
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        sock.sendall(bytes(header) + masked)

    def _recv(self, sock: socket.socket) -> str | None:
        buffer = getattr(self, "_tail", b"")
        self._tail = b""

        def need(n: int) -> bytes | None:
            nonlocal buffer
            while len(buffer) < n:
                try:
                    chunk = sock.recv(4096)
                except OSError:
                    return None
                if not chunk:
                    return None
                buffer += chunk
            out, buffer = buffer[:n], buffer[n:]
            return out

        head = need(2)
        if head is None:
            return None
        length = head[1] & 0x7F
        if length == 126:
            ext = need(2)
            if ext is None:
                return None
            length = int.from_bytes(ext, "big")
        elif length == 127:
            ext = need(8)
            if ext is None:
                return None
            length = int.from_bytes(ext, "big")
        masked = bool(head[1] & 0x80)
        mask = need(4) if masked else b""
        if masked and mask is None:
            return None
        payload = need(length) if length else b""
        if payload is None:
            return None
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._tail = buffer
        return payload.decode("utf-8", errors="replace")


class NarrativeMcpServer:
    def __init__(self, root: Path, port: int) -> None:
        self.root = root
        self.index = NarrativeIndex(root)
        self.index.load()
        self.link = DebuggerLink(port)
        self._xref_index = None  # 懒建：只有真问信号关系时才扫全工程
        self._xref_stamp: tuple = ()

    # ---- JSON-RPC 壳 ---------------------------------------------------

    def serve(self) -> int:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            self._handle(message)
        return 0

    def _handle(self, message: Any) -> None:
        if not isinstance(message, dict):
            return
        request_id = message.get("id")
        method = str(message.get("method") or "")
        params = message.get("params") or {}
        if request_id is None:
            return  # 通知类消息无需回复
        try:
            result = self._dispatch(method, params if isinstance(params, dict) else {})
        except Exception as exc:  # noqa: BLE001 - 协议层兜底，错误要回给调用方而不是崩掉
            self._write({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32603, "message": str(exc)}})
            return
        self._write({"jsonrpc": "2.0", "id": request_id, "result": result})

    def _dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "initialize":
            return {
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "gamedraft-narrative-debugger", "version": "1.0.0"},
            }
        if method == "tools/list":
            return {"tools": TOOLS}
        if method == "tools/call":
            name = str(params.get("name") or "")
            arguments = params.get("arguments") or {}
            payload = self._call(name, arguments if isinstance(arguments, dict) else {})
            return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, indent=1)}]}
        raise ValueError(f"unknown method: {method}")

    def _write(self, payload: dict[str, Any]) -> None:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    # ---- 工具实现 -----------------------------------------------------

    def _call(self, name: str, args: dict[str, Any]) -> dict[str, Any]:
        if name == "narrative_state":
            return self._state()
        if name == "narrative_waiting":
            return self._waiting(str(args.get("graphId") or ""), str(args.get("stateId") or ""))
        if name == "narrative_timeline":
            return self._timeline(int(args.get("limit") or 30))
        if name == "narrative_beats":
            return self._beats(str(args.get("compositionId") or ""))
        if name == "narrative_goto":
            return self._goto(str(args.get("beat") or ""), args.get("forceSetState") is True)
        if name == "narrative_emit":
            return self.link.request({
                "command": "emitNarrativeSignalByName",
                "signal": str(args.get("signal") or ""),
                "ownerType": str(args.get("ownerType") or ""),
                "ownerId": str(args.get("ownerId") or ""),
            })
        if name == "narrative_capture":
            return self.link.request({"command": "captureSavepointNamed", "label": str(args.get("label") or "")})
        if name == "narrative_signal_info":
            return self._signal_info(str(args.get("signal") or ""))
        return {"ok": False, "detail": f"unknown tool: {name}"}

    def _state(self) -> dict[str, Any]:
        reply = self.link.request({"command": "debuggerState"})
        if not reply.get("ok"):
            return {
                "ok": False,
                "detail": reply.get("detail"),
                "static": {
                    "graphs": len(self.index.graphs),
                    "states": len(self.index.states),
                    "beats": [b.key for b in self.index.beats],
                },
            }
        return reply

    def _waiting(self, graph_id: str, state_id: str) -> dict[str, Any]:
        if not graph_id or not state_id:
            reply = self.link.request({"command": "debuggerState"})
            focus = str(reply.get("focus") or "") if reply.get("ok") else ""
            if not focus:
                return {"ok": False, "detail": reply.get("detail") or "不知道当前在哪一拍，请显式给 graphId/stateId"}
            graph_id, _, state_id = focus.rpartition(".")
        node = self.index.state(graph_id, state_id)
        items = waiting_items(self.index, graph_id, state_id)
        return {
            "ok": True,
            "beat": f"{graph_id}.{state_id}",
            "label": node.display if node else state_id,
            "waiting": [i.as_dict() for i in items],
        }

    def _timeline(self, limit: int) -> dict[str, Any]:
        reply = self.link.request({"command": "debuggerTimeline", "limit": max(1, min(limit, 200))})
        return reply if reply.get("ok") else {"ok": False, "detail": reply.get("detail")}

    def _beats(self, composition_id: str) -> dict[str, Any]:
        reply = self.link.request({"command": "debuggerSavepoints"})
        saved = set(reply.get("keys") or []) if reply.get("ok") else set()
        rows = []
        for beat in self.index.beats:
            if composition_id and beat.composition_id != composition_id:
                continue
            rows.append({
                "key": beat.key,
                "label": beat.label,
                "composition": beat.composition_label,
                "hasSavepoint": beat.key in saved,
            })
        return {"ok": True, "beats": rows, "savepointsKnown": bool(reply.get("ok"))}

    def _goto(self, beat: str, force: bool) -> dict[str, Any]:
        if not beat:
            return {"ok": False, "detail": "缺 beat"}
        return self.link.request({"command": "debuggerGoto", "beat": beat, "force": force})

    def _signal_info(self, signal: str) -> dict[str, Any]:
        """一条信号的两侧。口径走共享扫描 `tools.narrative_xref`——**必须**与策划屏幕上
        那个「信号关系」窗、以及主编辑器那块面板说同一件事。

        （旧实现用调试器自己的索引，把黑盒 `meta.emits` 的**声明**也算成 emitters，
        agent 于是会看到一个界面上不存在的"发射端"。声明现在单列 declarations。）
        """
        if not signal:
            return {"ok": False, "detail": "缺 signal"}
        card = self._xref().card(signal)
        action, where = player_action_for(self.index, signal)
        return {
            "ok": True,
            "signal": signal,
            "kind": card.kind,
            "label": card.label,
            "registered": card.registered,
            # dangling 保持原义：没人听。发射侧另有 emitters 为空这一情况，看 diagnostics。
            "dangling": not card.listeners,
            # **只列真发射**：派生信号的"上游因果"是"谁让那一拍发生"，不是"谁发出信号"。
            # 混进来会让 agent 数出 2 而策划屏幕上写「发 1」，当场对不上。
            "emitterCount": card.real_emitter_count,
            "emitters": [
                {
                    "kind": e.container_kind,
                    "source": e.container_id,
                    "detail": " · ".join(p for p in (e.kind_label, e.where, e.context) if p),
                    "channel": e.channel,
                    "file": e.file,
                    "pointer": e.pointer,
                }
                for e in card.emitters if e.channel != CHANNEL_UPSTREAM
            ],
            # 派生信号专属：能让那一拍发生的路（上游转移 / 强制设状态）
            "upstream": [
                {
                    "kind": e.kind_label,
                    "source": e.container_id,
                    "detail": " · ".join(p for p in (e.where, e.context) if p),
                }
                for e in card.emitters if e.channel == CHANNEL_UPSTREAM
            ],
            "listeners": [
                {"graph": l.graph_id, "from": l.from_state, "to": l.to_state, "transition": l.transition_id,
                 "conditions": l.conditions}
                for l in card.listeners
            ],
            "declarations": [
                {"composition": d.composition_id, "element": d.element_id, "refId": d.ref_id}
                for d in card.declarations
            ],
            "diagnostics": [d.to_dict() for d in card.diagnostics],
            "playerAction": action,
            "where": where,
        }

    def _xref(self):
        """扫描一次就缓存；但**数据变了要重扫**——agent 会话动辄几小时，
        缓存永不失效等于对着一份旧关系回答（策划那边早就改过并存盘了）。
        指纹取叙事文件与对话图目录的 mtime，代价可忽略。
        """
        from tools.narrative_xref import build_index, from_disk

        stamp = self._data_stamp()
        if getattr(self, "_xref_index", None) is None or self._xref_stamp != stamp:
            self._xref_index = build_index(from_disk(self.root))
            self._xref_stamp = stamp
        return self._xref_index

    def _data_stamp(self) -> tuple:
        """扫描面的整体新鲜度指纹。

        **必须覆盖全部扫描面**：发射端有三成在场景/任务/过场/压力条/小游戏里，只盯
        narrative + 对话图的话，改了那些文件 agent 照旧拿旧关系（docstring 承诺了会重扫，
        覆盖面对不上就是假承诺）。几百次 stat 的代价可忽略，且只在问信号关系时才算。
        """
        newest = 0.0
        for pattern in (
            "public/assets/data/narrative_graphs.json",
            "public/assets/dialogues/graphs/*.json",
            "public/assets/scenes/*.json",
            "public/assets/data/*.json",
            "public/assets/data/*/*.json",
        ):
            for child in self.root.glob(pattern):
                try:
                    newest = max(newest, child.stat().st_mtime)
                except OSError:
                    continue
        return (newest,)


def main(argv: list[str] | None = None) -> int:
    args = list(argv if argv is not None else sys.argv[1:])
    port = DEFAULT_PORT
    root = Path(__file__).resolve().parents[2]
    if "--port" in args:
        port = int(args[args.index("--port") + 1])
    if "--root" in args:
        root = Path(args[args.index("--root") + 1])
    return NarrativeMcpServer(root, port).serve()


if __name__ == "__main__":
    raise SystemExit(main())
