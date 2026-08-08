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
    #: 局部机专用：只在**这一台实例**进入该状态时断（形如
    #: `lm_可拾取物@雾津街头/hotspot:hs_铁箱`）。
    #: **空＝这个原型的所有实例都断**——1000 个箱子里只有一个不对时用前者，
    #: "到底有没有哪个箱子走到过这一步"用后者。graph_id 此时是**原型 id**。
    instance_key: str = ""

    @property
    def key(self) -> str:
        # 实例级断点与"整个原型"的断点必须能共存（前者是后者的加细，不是替代），
        # 所以键上带实例段；不带实例时形状与从前逐字节一致（老文件照读）。
        base = f"{self.graph_id}#{self.state_id}"
        return f"{base}#{self.instance_key}" if self.instance_key else base

    @property
    def is_local(self) -> bool:
        return bool(self.instance_key)

    def to_wire(self) -> dict:
        wire = {
            "graphId": self.graph_id,
            "stateId": self.state_id,
            "enabled": self.enabled,
            "triggerContains": self.trigger_contains,
        }
        # 只有实例级断点才多这一个字段：普通断点的线上形状一字不改，
        # 游戏侧老代码照收（它只认前四个键）。
        if self.instance_key:
            wire["instanceKey"] = self.instance_key
        return wire


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
                instance_key=str(e.get("instance_key") or e.get("instanceKey") or "").strip(),
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
        return sorted(self._items.values(), key=lambda b: (b.graph_id, b.state_id, b.instance_key))

    @staticmethod
    def _key(graph_id: str, state_id: str, instance_key: str = "") -> str:
        base = f"{graph_id}#{state_id}"
        return f"{base}#{instance_key}" if instance_key else base

    def has(self, graph_id: str, state_id: str, instance_key: str = "") -> bool:
        return self._key(graph_id, state_id, instance_key) in self._items

    def has_any_for_state(self, graph_id: str, state_id: str) -> bool:
        """这个（原型/图的）状态上有没有断点——含加细到某一台实例的那些。

        左栏行首的 ⏻ 靠它：只查"整原型"那一条的话，明明下了实例断点的那一拍上
        看不到任何标记，人会以为断点没存上。
        """
        prefix = f"{graph_id}#{state_id}"
        return any(k == prefix or k.startswith(prefix + "#") for k in self._items)

    def toggle(self, graph_id: str, state_id: str, instance_key: str = "") -> bool:
        """有就删、没有就加。返回操作后是否存在。"""
        key = self._key(graph_id, state_id, instance_key)
        if key in self._items:
            del self._items[key]
            self.save()
            return False
        self._items[key] = Breakpoint(graph_id, state_id, instance_key=instance_key)
        self.save()
        return True

    def remove(self, graph_id: str, state_id: str, instance_key: str = "") -> None:
        self._items.pop(self._key(graph_id, state_id, instance_key), None)
        self.save()

    def set_enabled(self, graph_id: str, state_id: str, enabled: bool, instance_key: str = "") -> None:
        bp = self._items.get(self._key(graph_id, state_id, instance_key))
        if bp is None:
            return
        bp.enabled = enabled
        self.save()

    def set_trigger_filter(self, graph_id: str, state_id: str, text: str, instance_key: str = "") -> None:
        bp = self._items.get(self._key(graph_id, state_id, instance_key))
        if bp is None:
            return
        bp.trigger_contains = text.strip()
        self.save()

    def clear(self) -> None:
        self._items = {}
        self.save()

    def to_wire(self) -> list[dict]:
        return [b.to_wire() for b in self.items()]
