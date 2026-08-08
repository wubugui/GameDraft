"""测试用的"假游戏页签"。

hub 对游戏那一侧的要求只有两条：能收 `_on_message(socket, raw)`，能被
`sendTextMessage(raw)` 写回去。用真 QWebSocket 起服务再连回来，会把每条断言都变成
异步等待——这层替身让 hub 的路由（谁是当前调试对象、命令发给了谁）能同步断言。
"""
from __future__ import annotations

import json
from typing import Any


class FakeGameSocket:
    """收命令的一端：hub 发给这个页签的每条命令都留在 `sent` 里。"""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []
        self.closed = False

    def sendTextMessage(self, raw: str) -> None:  # noqa: N802 (Qt 命名)
        self.sent.append(json.loads(raw))

    def close(self) -> None:
        self.closed = True

    def deleteLater(self) -> None:
        """Qt 侧回收钩子；替身里什么都不用做。"""

    def commands(self) -> list[str]:
        return [str(m.get("command") or "") for m in self.sent]


def connect_game(hub: Any, client_id: str = "tab-1", href: str = "http://localhost:5173/?ndbg=1") -> FakeGameSocket:
    """让一个游戏页签连上来（走真正的 hello 路径）。"""
    socket = FakeGameSocket()
    hub._on_message(
        socket,
        json.dumps({"type": "hello", "role": "game", "clientId": client_id, "href": href}),
    )
    return socket


def send_batch(hub: Any, socket: FakeGameSocket, *items: dict[str, Any]) -> None:
    hub._on_message(socket, json.dumps({"type": "batch", "items": list(items)}))


def disconnect_game(hub: Any, socket: FakeGameSocket) -> None:
    hub._on_disconnected(socket)


def snapshot_item(scene_id: str, active_states: dict[str, str] | None = None) -> dict[str, Any]:
    return {
        "kind": "state",
        "reason": "test",
        "sceneId": scene_id,
        "canSave": True,
        "snapshot": {"narrativeState": {"activeStates": active_states or {}}},
    }
