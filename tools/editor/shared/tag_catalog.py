"""Project-level tag catalog for [tag:…] insert UI and validation."""
from __future__ import annotations

from dataclasses import dataclass

from ..flag_registry import validate_flag_key_loose
from ..project_model import ProjectModel


@dataclass
class TagItem:
    kind: str
    ref_id: str
    label: str
    hint: str = ""


class TagCatalog:
    """Builds pick lists from ProjectModel (single source of truth with runtime resolveText)."""

    def __init__(self, model: ProjectModel) -> None:
        self._model = model

    def list_string_keys(self) -> list[TagItem]:
        out: list[TagItem] = []
        data = self._model.strings
        if not isinstance(data, dict):
            return out
        for cat in sorted(data.keys(), key=str):
            sub = data.get(cat)
            if not isinstance(sub, dict):
                continue
            for key in sorted(sub.keys(), key=str):
                preview = str(sub[key])[:48]
                out.append(TagItem("string", f"{cat}:{key}", f"{cat}.{key}", preview))
        return out

    def list_flags(self) -> list[TagItem]:
        reg = self._model.flag_registry
        out: list[TagItem] = []
        static = reg.get("static") if isinstance(reg, dict) else None
        if isinstance(static, list):
            for e in static:
                if isinstance(e, dict) and e.get("key"):
                    k = str(e["key"])
                    vt = e.get("valueType", "")
                    out.append(TagItem("flag", k, k, str(vt)))
        return sorted(out, key=lambda x: x.ref_id.lower())

    def list_items(self) -> list[TagItem]:
        return [
            TagItem("item", it.get("id", ""), f'{it.get("name", "")} ({it.get("id", "")})', "")
            for it in self._model.items
            if it.get("id")
        ]

    def list_npcs(self) -> list[TagItem]:
        items: list[TagItem] = [
            TagItem("npc", "@context", "当前对话上下文 NPC (@context)", ""),
        ]
        seen: set[str] = set()
        for npc_id, label in self._model.all_npc_ids_global():
            if npc_id in seen:
                continue
            seen.add(npc_id)
            items.append(TagItem("npc", npc_id, label, ""))
        return items

    def list_quests(self) -> list[TagItem]:
        return [
            TagItem("quest", q.get("id", ""), f'{q.get("title", "")} ({q.get("id", "")})', "")
            for q in self._model.quests
            if q.get("id")
        ]

    def list_rules(self) -> list[TagItem]:
        rules = self._model.rules_data.get("rules", []) if isinstance(self._model.rules_data, dict) else []
        return [
            TagItem("rule", r.get("id", ""), f'{r.get("name", "")} ({r.get("id", "")})', "")
            for r in rules
            if isinstance(r, dict) and r.get("id")
        ]

    def list_scenes(self) -> list[TagItem]:
        return [
            TagItem("scene", sid, sid, self._model.scenes.get(sid, {}).get("name", "") or "")
            for sid in sorted(self._model.all_scene_ids())
        ]

    def list_by_kind(self, kind: str) -> list[TagItem]:
        if kind == "string":
            return self.list_string_keys()
        if kind == "flag":
            return self.list_flags()
        if kind == "item":
            return self.list_items()
        if kind == "npc":
            return self.list_npcs()
        if kind == "player":
            return [TagItem("player", "", "玩家显示名", "")]
        if kind == "quest":
            return self.list_quests()
        if kind == "rule":
            return self.list_rules()
        if kind == "scene":
            return self.list_scenes()
        return []

    def search(self, query: str, kinds: list[str] | None = None) -> list[TagItem]:
        q = (query or "").strip().lower()
        kinds = kinds or ["string", "flag", "item", "npc", "player", "quest", "rule", "scene"]
        out: list[TagItem] = []
        for k in kinds:
            for it in self.list_by_kind(k):
                hay = f"{it.ref_id} {it.label} {it.hint}".lower()
                if not q or q in hay:
                    out.append(it)
        return out

    def marker_for(self, item: TagItem) -> str:
        if item.kind == "string":
            cat, _, key = item.ref_id.partition(":")
            return f"[tag:string:{cat}:{key}]"
        if item.kind == "flag":
            return f"[tag:flag:{item.ref_id}]"
        if item.kind == "item":
            return f"[tag:item:{item.ref_id}]"
        if item.kind == "npc":
            return f"[tag:npc:{item.ref_id}]"
        if item.kind == "player":
            return "[tag:player]"
        if item.kind == "quest":
            return f"[tag:quest:{item.ref_id}]"
        if item.kind == "rule":
            return f"[tag:rule:{item.ref_id}]"
        if item.kind == "scene":
            return f"[tag:scene:{item.ref_id}]"
        return ""

    def validate_exists(self, kind: str, raw: str) -> bool:
        """Return True if ref target exists in model (npc @context always True)."""
        raw = (raw or "").strip()
        if kind == "string":
            parts = raw.split(":", 1)
            if len(parts) != 2:
                return False
            cat, key = parts
            sub = self._model.strings.get(cat) if isinstance(self._model.strings, dict) else None
            return isinstance(sub, dict) and key in sub
        if kind == "flag":
            return validate_flag_key_loose(raw, self._model.flag_registry)
        if kind == "item":
            return raw in {it["id"] for it in self._model.items if it.get("id")}
        if kind == "npc":
            if raw in ("", "@context"):
                return True
            return raw in {p[0] for p in self._model.all_npc_ids_global()}
        if kind == "player":
            return True
        if kind == "quest":
            return raw in {q["id"] for q in self._model.quests if q.get("id")}
        if kind == "rule":
            rules = self._model.rules_data.get("rules", []) if isinstance(self._model.rules_data, dict) else []
            return raw in {r["id"] for r in rules if isinstance(r, dict) and r.get("id")}
        if kind == "scene":
            return raw in set(self._model.all_scene_ids())
        return False
