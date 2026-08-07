"""叙事断点的存取（落工程文件，不落 localStorage）。

与调试面板其它偏好同一范式（agent_docs: debug-ui-persistence）——断点是策划一天里
反复用的东西，重开一次调试器就全丢的话没人会用。
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass
from pathlib import Path

REL_PATH = Path("resources/editor_projects/editor_data/narrative_debugger_breakpoints.json")


@dataclass
class Breakpoint:
    graph_id: str
    state_id: str
    enabled: bool = True
    #: 只在触发键包含这段文字时才断（空＝任何来源都断）。
    #: 用来问"到底是哪条路把它推过去的"——同一个状态可能被好几条线推到。
    trigger_contains: str = ""

    @property
    def key(self) -> str:
        return f"{self.graph_id}#{self.state_id}"

    def to_wire(self) -> dict:
        return {
            "graphId": self.graph_id,
            "stateId": self.state_id,
            "enabled": self.enabled,
            "triggerContains": self.trigger_contains,
        }


class BreakpointStore:
    def __init__(self, project_root: Path) -> None:
        self._path = Path(project_root) / REL_PATH
        self._items: dict[str, Breakpoint] = {}
        self.load()

    @property
    def path(self) -> Path:
        return self._path

    def load(self) -> None:
        self._items = {}
        try:
            raw = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return
        for e in raw if isinstance(raw, list) else []:
            if not isinstance(e, dict):
                continue
            gid = str(e.get("graph_id") or e.get("graphId") or "").strip()
            sid = str(e.get("state_id") or e.get("stateId") or "").strip()
            if not gid or not sid:
                continue
            bp = Breakpoint(
                gid, sid,
                enabled=e.get("enabled") is not False,
                trigger_contains=str(e.get("trigger_contains") or e.get("triggerContains") or ""),
            )
            self._items[bp.key] = bp

    def save(self) -> None:
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            self._path.write_text(
                json.dumps([asdict(b) for b in self.items()], ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except OSError:
            # 存不下去不该把调试器搞崩——断点在本次会话里仍然有效
            pass

    def items(self) -> list[Breakpoint]:
        return sorted(self._items.values(), key=lambda b: (b.graph_id, b.state_id))

    def has(self, graph_id: str, state_id: str) -> bool:
        return f"{graph_id}#{state_id}" in self._items

    def toggle(self, graph_id: str, state_id: str) -> bool:
        """有就删、没有就加。返回操作后是否存在。"""
        key = f"{graph_id}#{state_id}"
        if key in self._items:
            del self._items[key]
            self.save()
            return False
        self._items[key] = Breakpoint(graph_id, state_id)
        self.save()
        return True

    def remove(self, graph_id: str, state_id: str) -> None:
        self._items.pop(f"{graph_id}#{state_id}", None)
        self.save()

    def set_enabled(self, graph_id: str, state_id: str, enabled: bool) -> None:
        bp = self._items.get(f"{graph_id}#{state_id}")
        if bp is None:
            return
        bp.enabled = enabled
        self.save()

    def set_trigger_filter(self, graph_id: str, state_id: str, text: str) -> None:
        bp = self._items.get(f"{graph_id}#{state_id}")
        if bp is None:
            return
        bp.trigger_contains = text.strip()
        self.save()

    def clear(self) -> None:
        self._items = {}
        self.save()

    def to_wire(self) -> list[dict]:
        return [b.to_wire() for b in self.items()]
