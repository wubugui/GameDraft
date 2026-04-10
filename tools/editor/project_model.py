"""Central data model that holds every JSON asset in memory."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, Signal
from PySide6.QtGui import QUndoStack, QUndoCommand

from .file_io import read_json, write_json, list_json_files, list_ink_files


# ---------------------------------------------------------------------------
# Undo helpers
# ---------------------------------------------------------------------------

class DataEditCommand(QUndoCommand):
    """Generic undo command that swaps a value inside ProjectModel."""

    def __init__(self, model: ProjectModel, data_type: str, key: str,
                 old_value: Any, new_value: Any, description: str = ""):
        super().__init__(description or f"Edit {data_type}.{key}")
        self._model = model
        self._data_type = data_type
        self._key = key
        self._old = old_value
        self._new = new_value

    def redo(self) -> None:
        self._model._apply(self._data_type, self._key, self._new)

    def undo(self) -> None:
        self._model._apply(self._data_type, self._key, self._old)


# ---------------------------------------------------------------------------
# ProjectModel
# ---------------------------------------------------------------------------

class ProjectModel(QObject):
    data_changed = Signal(str, str)  # (data_type, item_id_or_empty)
    dirty_changed = Signal(bool)

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self.project_path: Path | None = None
        self.undo_stack = QUndoStack(self)

        self.game_config: dict = {}
        self.items: list[dict] = []
        self.quests: list[dict] = []
        self.quest_groups: list[dict] = []
        self.encounters: list[dict] = []
        self.rules_data: dict = {}
        self.shops: list[dict] = []
        self.map_nodes: list[dict] = []
        self.cutscenes: list[dict] = []
        self.audio_config: dict = {}
        self.strings: dict = {}
        self.archive_characters: list[dict] = []
        self.archive_lore: dict = {}
        self.archive_books: list[dict] = []
        self.archive_documents: list[dict] = []
        self.animations: dict[str, dict] = {}
        self.scenes: dict[str, dict] = {}
        self.filter_defs: dict[str, dict] = {}
        self.flag_registry: dict = {}

        self._dirty: set[str] = set()

    # ---- properties -------------------------------------------------------

    @property
    def is_dirty(self) -> bool:
        return len(self._dirty) > 0

    @property
    def assets_path(self) -> Path:
        assert self.project_path is not None
        return self.project_path / "public" / "assets"

    @property
    def data_path(self) -> Path:
        return self.assets_path / "data"

    @property
    def scenes_path(self) -> Path:
        return self.assets_path / "scenes"

    @property
    def dialogues_path(self) -> Path:
        return self.assets_path / "dialogues"

    # ---- loading ----------------------------------------------------------

    def load_project(self, project_path: Path) -> None:
        self.project_path = project_path
        dp = self.data_path
        sp = self.scenes_path

        self.game_config = self._load(dp / "game_config.json", {})
        self.items = self._load(dp / "items.json", [])
        self.quests = self._load(dp / "quests.json", [])
        self.quest_groups = self._load(dp / "questGroups.json", [])
        self.encounters = self._load(dp / "encounters.json", [])
        self.rules_data = self._load(dp / "rules.json", {})
        self.shops = self._load(dp / "shops.json", [])
        self.map_nodes = self._load(dp / "map_config.json", [])
        self.cutscenes = self._load(dp / "cutscenes" / "index.json", [])
        self.audio_config = self._load(dp / "audio_config.json", {})
        self.strings = self._load(dp / "strings.json", {})
        self.archive_characters = self._load(dp / "archive" / "characters.json", [])
        self.archive_lore = self._load(dp / "archive" / "lore.json", {})
        self.archive_books = self._load(dp / "archive" / "books.json", [])
        self.archive_documents = self._load(dp / "archive" / "documents.json", [])

        self.animations = {}
        for p in list_json_files(dp, "*_anim.json"):
            self.animations[p.stem] = self._load(p, {})

        self.scenes = {}
        for p in list_json_files(sp, "*.json"):
            if p.parent == sp:
                data = self._load(p, {})
                sid = data.get("id", p.stem)
                self.scenes[sid] = data

        self.filter_defs = {}
        filters_dir = dp / "filters"
        if filters_dir.is_dir():
            for p in list_json_files(filters_dir):
                self.filter_defs[p.stem] = self._load(p, {})

        from .flag_registry import flag_registry_path, load_flag_registry
        self.flag_registry = load_flag_registry(flag_registry_path(self.assets_path))

        from .editors.ink_parser import discover_ink_externals, INK_EXTERNALS as _ink_ext
        _ink_ext.clear()
        _ink_ext.update(discover_ink_externals(
            project_path / "src" / "data" / "inkExternals.ts",
        ))

        self._dirty.clear()
        self.undo_stack.clear()
        self.dirty_changed.emit(False)

    def reload_filters_from_disk(self) -> None:
        """重读 public/assets/data/filters，与 tools.filter_tool 写入目录一致（不标脏）。"""
        if self.project_path is None:
            return
        self.filter_defs = {}
        filters_dir = self.data_path / "filters"
        if filters_dir.is_dir():
            for p in list_json_files(filters_dir):
                self.filter_defs[p.stem] = self._load(p, {})
        self.data_changed.emit("filter", "")

    @staticmethod
    def _load(path: Path, default: Any) -> Any:
        if path.exists():
            try:
                return read_json(path)
            except Exception:
                return default
        return default

    # ---- saving -----------------------------------------------------------

    def save_all(self) -> None:
        dp = self.data_path
        sp = self.scenes_path
        write_json(dp / "game_config.json", self.game_config)
        write_json(dp / "items.json", self.items)
        write_json(dp / "quests.json", self.quests)
        write_json(dp / "questGroups.json", self.quest_groups)
        write_json(dp / "encounters.json", self.encounters)
        write_json(dp / "rules.json", self.rules_data)
        write_json(dp / "shops.json", self.shops)
        write_json(dp / "map_config.json", self.map_nodes)
        write_json(dp / "cutscenes" / "index.json", self.cutscenes)
        write_json(dp / "audio_config.json", self.audio_config)
        write_json(dp / "strings.json", self.strings)
        write_json(dp / "archive" / "characters.json", self.archive_characters)
        write_json(dp / "archive" / "lore.json", self.archive_lore)
        write_json(dp / "archive" / "books.json", self.archive_books)
        write_json(dp / "archive" / "documents.json", self.archive_documents)
        for name, data in self.animations.items():
            write_json(dp / f"{name}.json", data)
        keep_anim = set(self.animations.keys())
        for p in list(dp.glob("*_anim.json")):
            if p.stem not in keep_anim:
                p.unlink()
        for sid, data in self.scenes.items():
            write_json(sp / f"{sid}.json", data)
        from .flag_registry import flag_registry_path
        write_json(flag_registry_path(self.assets_path), self.flag_registry)
        filters_dir = dp / "filters"
        filters_dir.mkdir(parents=True, exist_ok=True)
        keep = set(self.filter_defs.keys())
        if filters_dir.is_dir():
            for p in list(filters_dir.glob("*.json")):
                if p.stem not in keep:
                    p.unlink()
        for stem, data in self.filter_defs.items():
            write_json(filters_dir / f"{stem}.json", data)
        self._dirty.clear()
        self.dirty_changed.emit(False)

    def mark_dirty(self, data_type: str, item_id: str = "") -> None:
        was_dirty = self.is_dirty
        self._dirty.add(data_type)
        self.data_changed.emit(data_type, item_id)
        if not was_dirty:
            self.dirty_changed.emit(True)

    # ---- undo integration -------------------------------------------------

    def _apply(self, data_type: str, key: str, value: Any) -> None:
        setattr(self, key, value)
        self.mark_dirty(data_type)

    def push_edit(self, data_type: str, attr_name: str,
                  old_value: Any, new_value: Any, desc: str = "") -> None:
        cmd = DataEditCommand(self, data_type, attr_name,
                              old_value, new_value, desc)
        self.undo_stack.push(cmd)

    # ---- id helpers -------------------------------------------------------

    def all_scene_ids(self) -> list[str]:
        return list(self.scenes.keys())

    def spawn_point_keys_for_scene(self, scene_id: str) -> list[str]:
        """Spawn point id strings from scene JSON ``spawnPoints`` (empty first = default)."""
        sc = self.scenes.get(scene_id) or {}
        raw = sc.get("spawnPoints") or {}
        if not isinstance(raw, dict):
            return [""]
        keys = sorted(str(k) for k in raw.keys())
        return [""] + keys

    def archive_entry_ids_for_book_type(self, book_type: str) -> list[tuple[str, str]]:
        """Ids for addArchiveEntry ``entryId`` picker by ``bookType``."""
        if book_type == "character":
            return [(ch["id"], ch.get("name", ch["id"])) for ch in self.archive_characters]
        if book_type == "lore":
            entries = self.archive_lore
            if isinstance(entries, dict):
                entries = entries.get("entries", [])
            return [
                (e["id"], (e.get("title") or e["id"])[:40])
                for e in entries
                if isinstance(e, dict) and e.get("id")
            ]
        if book_type == "document":
            return [
                (d["id"], (d.get("name") or d.get("title") or d["id"])[:40])
                for d in self.archive_documents
                if isinstance(d, dict) and d.get("id")
            ]
        if book_type == "book":
            return [
                (b["id"], (b.get("title") or b["id"])[:40])
                for b in self.archive_books
                if isinstance(b, dict) and b.get("id")
            ]
        return []

    def all_npc_ids_global(self) -> list[tuple[str, str]]:
        """All NPC ids across all scenes, deduplicated."""
        seen: dict[str, str] = {}
        for sc in self.scenes.values():
            if not isinstance(sc, dict):
                continue
            for npc in sc.get("npcs") or []:
                if not isinstance(npc, dict):
                    continue
                nid = npc.get("id") or npc.get("npcId")
                if nid and str(nid) not in seen:
                    label = npc.get("label") or npc.get("name") or str(nid)
                    seen[str(nid)] = str(label)[:40]
        return [(k, v) for k, v in sorted(seen.items())]

    def all_npc_names(self) -> list[str]:
        """All unique NPC display names across all scenes."""
        names: set[str] = set()
        for sc in self.scenes.values():
            if not isinstance(sc, dict):
                continue
            for npc in sc.get("npcs") or []:
                if not isinstance(npc, dict):
                    continue
                name = npc.get("name") or npc.get("label") or npc.get("id")
                if name:
                    names.add(str(name))
        return sorted(names)

    def npc_ids_for_scene(self, scene_id: str | None) -> list[tuple[str, str]]:
        """NPC ids in a scene (for hotspot / emote targets)."""
        if not scene_id:
            return []
        sc = self.scenes.get(scene_id) or {}
        out: list[tuple[str, str]] = []
        for npc in sc.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            nid = npc.get("id") or npc.get("npcId")
            if nid:
                label = npc.get("label") or npc.get("name") or str(nid)
                out.append((str(nid), str(label)[:40]))
        return out

    def scene_transitions(self) -> list[dict]:
        """All transition edges between scenes, derived from hotspot data.

        Returns list of {from_scene, to_scene, label, conditional}.
        """
        edges: list[dict] = []
        for sid, sc in self.scenes.items():
            if not isinstance(sc, dict):
                continue
            for hs in sc.get("hotspots") or []:
                if not isinstance(hs, dict):
                    continue
                if hs.get("type") != "transition":
                    continue
                data = hs.get("data") or {}
                target = data.get("targetScene")
                if not target:
                    continue
                edges.append({
                    "from_scene": str(sid),
                    "to_scene": str(target),
                    "label": str(hs.get("label", "")),
                    "conditional": bool(hs.get("conditions")),
                })
        return edges

    def all_item_ids(self) -> list[tuple[str, str]]:
        return [(it["id"], it.get("name", it["id"])) for it in self.items]

    def all_quest_ids(self) -> list[tuple[str, str]]:
        return [(q["id"], q.get("title", q["id"])) for q in self.quests]

    def all_quest_group_ids(self) -> list[tuple[str, str]]:
        return [(g["id"], g.get("name", g["id"])) for g in self.quest_groups]

    def all_encounter_ids(self) -> list[tuple[str, str]]:
        return [(e["id"], e.get("narrative", e["id"])[:30]) for e in self.encounters]

    def all_rule_ids(self) -> list[tuple[str, str]]:
        rules = self.rules_data.get("rules", [])
        return [(r["id"], r.get("name", r["id"])) for r in rules]

    def all_fragment_ids(self) -> list[tuple[str, str]]:
        frags = self.rules_data.get("fragments", [])
        return [(f["id"], f.get("text", f["id"])[:30]) for f in frags]

    def all_cutscene_ids(self) -> list[tuple[str, str]]:
        return [(c["id"], c["id"]) for c in self.cutscenes]

    def all_shop_ids(self) -> list[tuple[str, str]]:
        return [(s["id"], s.get("name", s["id"])) for s in self.shops]

    def all_filter_ids(self) -> list[str]:
        return list(self.filter_defs.keys())

    def all_audio_ids(self, channel: str) -> list[str]:
        return list(self.audio_config.get(channel, {}).keys())

    def all_anim_files(self) -> list[str]:
        return list(self.animations.keys())

    def all_ink_files(self) -> list[str]:
        if self.project_path is None:
            return []
        return [p.name for p in list_ink_files(self.dialogues_path)]

    def dialogue_asset_path_choices(self) -> list[tuple[str, str]]:
        """(runtime path under /assets/dialogues/, basename) for NPC dialogueFile."""
        return [(f"/assets/dialogues/{name}", name) for name in self.all_ink_files()]

    def anim_asset_path_choices(self) -> list[tuple[str, str]]:
        """(runtime path /assets/data/<stem>.json, stem) for npc animFile."""
        return [(f"/assets/data/{stem}.json", stem) for stem in self.all_anim_files()]

    def illustration_asset_choices(self) -> list[tuple[str, str]]:
        """Known illustration paths under /assets/images/illustrations/."""
        root = self.assets_path / "images" / "illustrations"
        if not root.is_dir():
            return []
        out: list[tuple[str, str]] = []
        for pat in ("*.png", "*.jpg", "*.webp"):
            for p in sorted(root.glob(pat)):
                out.append((f"/assets/images/illustrations/{p.name}", p.name))
        return out

    def audio_src_choices(self) -> list[tuple[str, str]]:
        """Existing wav under assets/audio for audio_config src."""
        root = self.assets_path / "audio"
        if not root.is_dir():
            return []
        return [(f"/assets/audio/{p.name}", p.name) for p in sorted(root.glob("*.wav"))]

    def all_flags(self) -> set[str]:
        """Collect every flag name referenced across the project data."""
        flags: set[str] = set()
        self._collect_flags_from_conditions(self.quests, flags)
        self._collect_flags_from_conditions(self.encounters, flags)
        self._collect_flags_from_conditions(self.map_nodes, flags)
        for sc in self.scenes.values():
            self._collect_flags_from_scene(sc, flags)
        for c in self.cutscenes:
            for cmd in c.get("commands", []):
                if cmd.get("type") == "set_flag" and "key" in cmd:
                    flags.add(cmd["key"])
        for it in self.items:
            for dd in it.get("dynamicDescriptions", []):
                for cond in dd.get("conditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
        for ch in self.archive_characters:
            for cond in ch.get("unlockConditions", []):
                if "flag" in cond:
                    flags.add(cond["flag"])
            for imp in ch.get("impressions", []):
                for cond in imp.get("conditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
            for ki in ch.get("knownInfo", []):
                for cond in ki.get("conditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
        entries = self.archive_lore
        if isinstance(entries, dict):
            entries = entries.get("entries", [])
        for le in entries:
            for cond in le.get("unlockConditions", []):
                if "flag" in cond:
                    flags.add(cond["flag"])
        for doc in self.archive_documents:
            for cond in doc.get("discoverConditions", []):
                if "flag" in cond:
                    flags.add(cond["flag"])
        for bk in self.archive_books:
            for pg in bk.get("pages", []):
                for cond in pg.get("unlockConditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
        return flags

    def registry_flag_choices(self, scene_id: str | None = None) -> list[str]:
        """Editor-only: static + pattern-expanded keys from flag_registry (single source)."""
        from .flag_registry import expand_registry_flag_keys
        return expand_registry_flag_keys(self.flag_registry, self, scene_id=scene_id)

    # ---- private helpers --------------------------------------------------

    @staticmethod
    def _collect_flags_from_conditions(items: list[dict], flags: set[str]) -> None:
        for item in items:
            for key in ("preconditions", "completionConditions", "conditions",
                        "unlockConditions", "discoverConditions"):
                for cond in item.get(key, []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
            for opt in item.get("options", []):
                for cond in opt.get("conditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
                for act in opt.get("resultActions", []):
                    p = act.get("params", {})
                    if act.get("type") == "setFlag" and "key" in p:
                        flags.add(p["key"])
            for act in item.get("rewards", []):
                p = act.get("params", {})
                if act.get("type") == "setFlag" and "key" in p:
                    flags.add(p["key"])
            for edge in item.get("nextQuests", []):
                for cond in edge.get("conditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])

    @staticmethod
    def _collect_flags_from_scene(sc: dict, flags: set[str]) -> None:
        for hs in sc.get("hotspots", []):
            for cond in hs.get("conditions", []):
                if "flag" in cond:
                    flags.add(cond["flag"])
            data = hs.get("data", {})
            for act in data.get("actions", []):
                p = act.get("params", {})
                if act.get("type") == "setFlag" and "key" in p:
                    flags.add(p["key"])
        for zone in sc.get("zones", []):
            for cond in zone.get("conditions", []):
                if "flag" in cond:
                    flags.add(cond["flag"])
            for ev in ("onEnter", "onStay", "onExit"):
                for act in zone.get(ev, []) or []:
                    p = act.get("params", {}) or {}
                    at = act.get("type")
                    if at == "setFlag" and "key" in p:
                        flags.add(p["key"])
                    elif at == "enableRuleOffers":
                        for slot in (p.get("slots") or []):
                            if not isinstance(slot, dict):
                                continue
                            for ract in slot.get("resultActions", []) or []:
                                rp = ract.get("params", {}) or {}
                                if ract.get("type") == "setFlag" and "key" in rp:
                                    flags.add(rp["key"])
