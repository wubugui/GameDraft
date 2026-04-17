"""Central data model that holds every JSON asset in memory."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, Signal
from PySide6.QtGui import QUndoStack, QUndoCommand

from .file_io import read_json, write_json, list_json_files


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
        self.overlay_images: dict[str, str] = {}
        self.scenarios_catalog: dict = {}
        self.document_reveals: list = []

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
    def animation_bundles_path(self) -> Path:
        """每个子目录含 anim.json +图集，与 video_to_atlas 导出一致。"""
        return self.assets_path / "animation"

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
        anim_root = self.animation_bundles_path
        if anim_root.is_dir():
            for sub in sorted(anim_root.iterdir()):
                if sub.is_dir():
                    aj = sub / "anim.json"
                    if aj.is_file():
                        self.animations[sub.name] = self._load(aj, {})

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

        self.overlay_images = self._load(dp / "overlay_images.json", {})
        raw_sc = self._load(dp / "scenarios.json", {})
        self.scenarios_catalog = raw_sc if isinstance(raw_sc, dict) else {}
        raw_dr = self._load(dp / "document_reveals.json", [])
        self.document_reveals = raw_dr if isinstance(raw_dr, list) else []

        self._dirty.clear()
        self.undo_stack.clear()
        self.dirty_changed.emit(False)
        if self._rebuild_dialogue_graph_ids_from_graph_files():
            self.mark_dirty("scenarios")

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

    def reload_animations_from_disk(self) -> None:
        """重读 public/assets/animation/*/anim.json（不标脏；导出/外部工具改盘后用于同步内存）。"""
        if self.project_path is None:
            return
        self.animations = {}
        anim_root = self.animation_bundles_path
        if anim_root.is_dir():
            for sub in sorted(anim_root.iterdir()):
                if sub.is_dir():
                    aj = sub / "anim.json"
                    if aj.is_file():
                        self.animations[sub.name] = self._load(aj, {})
        self.data_changed.emit("animation", "")

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
        for sid, data in self.scenes.items():
            write_json(sp / f"{sid}.json", data)
        from .flag_registry import flag_registry_path
        write_json(flag_registry_path(self.assets_path), self.flag_registry)
        write_json(dp / "overlay_images.json", self.overlay_images)
        from .scenarios_catalog_validate import validate_scenarios_catalog_for_save

        sc_err = validate_scenarios_catalog_for_save(
            self.scenarios_catalog,
            flag_registry=self.flag_registry,
            model=self,
        )
        if sc_err:
            raise ValueError(sc_err)
        write_json(dp / "scenarios.json", self.scenarios_catalog)
        write_json(dp / "document_reveals.json", self.document_reveals)
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
        if book_type == "bookEntry":
            out: list[tuple[str, str]] = []
            for b in self.archive_books:
                if not isinstance(b, dict):
                    continue
                for pg in b.get("pages") or []:
                    if not isinstance(pg, dict):
                        continue
                    for ent in pg.get("entries") or []:
                        if not isinstance(ent, dict):
                            continue
                        eid = ent.get("id")
                        if eid:
                            label = (ent.get("title") or eid)[:40]
                            out.append((str(eid), str(label)))
            return out
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
        """动画包目录名（与 `animation/<id>/anim.json` 的 id 一致）。"""
        return list(self.animations.keys())

    def all_dialogue_graph_ids(self) -> list[str]:
        """`dialogues/graphs/<id>.json` 的 id（不含扩展名）。"""
        if self.project_path is None:
            return []
        gp = self.dialogues_path / "graphs"
        if not gp.is_dir():
            return []
        return sorted(p.stem for p in gp.glob("*.json"))

    def scenario_ids_ordered(self) -> list[str]:
        """scenarios.json 中 ``scenarios[].id``，按文件内数组顺序。"""
        raw = self.scenarios_catalog.get("scenarios") or []
        if not isinstance(raw, list):
            return []
        out: list[str] = []
        for e in raw:
            if isinstance(e, dict):
                sid = e.get("id")
                if sid is not None and str(sid).strip():
                    out.append(str(sid).strip())
        return out

    def phases_for_scenario(self, scenario_id: str) -> list[str]:
        """某 scenario 的 ``phases`` 键名列表（与 scenarios.json 中对象键顺序一致）。"""
        sid = (scenario_id or "").strip()
        if not sid:
            return []
        raw = self.scenarios_catalog.get("scenarios") or []
        if not isinstance(raw, list):
            return []
        for e in raw:
            if not isinstance(e, dict):
                continue
            if str(e.get("id", "")).strip() != sid:
                continue
            ph = e.get("phases")
            if isinstance(ph, dict):
                return [str(k) for k in ph.keys()]
            return []
        return []

    def _rebuild_dialogue_graph_ids_from_graph_files(self) -> bool:
        """按各图根级 meta.scenarioId 汇总到 scenarios[].dialogueGraphIds；有变化返回 True。"""
        from .file_io import read_json

        links: dict[str, list[str]] = {}
        for stem in self.all_dialogue_graph_ids():
            p = self.dialogues_path / "graphs" / f"{stem}.json"
            try:
                data = read_json(p)
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            gid = str(data.get("id", stem)).strip() or stem
            meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
            sid = str(meta.get("scenarioId", "")).strip()
            if sid:
                links.setdefault(sid, [])
                if gid not in links[sid]:
                    links[sid].append(gid)
        for ids in links.values():
            ids.sort(key=lambda x: (x.lower(), x))
        raw = self.scenarios_catalog.get("scenarios")
        if not isinstance(raw, list):
            return False
        changed = False
        for e in raw:
            if not isinstance(e, dict):
                continue
            sid = str(e.get("id", "")).strip()
            new_arr = list(links.get(sid, []))
            old_raw = e.get("dialogueGraphIds")
            if not isinstance(old_raw, list):
                old_norm: list[str] = []
            else:
                old_norm = [str(x).strip() for x in old_raw if str(x).strip()]
            if old_norm != new_arr:
                changed = True
                if new_arr:
                    e["dialogueGraphIds"] = new_arr
                elif "dialogueGraphIds" in e:
                    del e["dialogueGraphIds"]
        return changed

    def relink_dialogue_graph_to_scenarios(self, graph_id: str, scenario_id: str | None) -> bool:
        """图 meta.scenarioId 变化时：从所有 scenario 的 dialogueGraphIds 去掉本图，再挂到目标 scenario。有改动返回 True。"""
        gid = (graph_id or "").strip()
        if not gid:
            return False
        raw = self.scenarios_catalog.get("scenarios")
        if not isinstance(raw, list):
            return False

        def _dg_snapshot() -> str:
            snap: list[Any] = []
            for e in raw:
                if isinstance(e, dict):
                    snap.append(e.get("dialogueGraphIds"))
                else:
                    snap.append(None)
            return json.dumps(snap, ensure_ascii=False)

        before = _dg_snapshot()
        for e in raw:
            if not isinstance(e, dict):
                continue
            arr = e.get("dialogueGraphIds")
            if not isinstance(arr, list):
                continue
            narr = [str(x).strip() for x in arr if str(x).strip() and str(x).strip() != gid]
            if narr:
                e["dialogueGraphIds"] = narr
            elif "dialogueGraphIds" in e:
                del e["dialogueGraphIds"]
        new_s = (scenario_id or "").strip()
        if new_s:
            for e in raw:
                if not isinstance(e, dict):
                    continue
                if str(e.get("id", "")).strip() != new_s:
                    continue
                arr = e.get("dialogueGraphIds")
                if not isinstance(arr, list):
                    arr = []
                else:
                    arr = [str(x).strip() for x in arr if str(x).strip()]
                if gid not in arr:
                    arr.append(gid)
                    arr.sort(key=lambda x: (x.lower(), x))
                e["dialogueGraphIds"] = arr
                break
        if _dg_snapshot() != before:
            self.mark_dirty("scenarios")
            return True
        return False

    def rename_dialogue_graph_in_scenarios_catalog(self, old_id: str, new_id: str) -> None:
        """图根 id 重命名时，替换各 scenario.dialogueGraphIds 中的引用。"""
        o = (old_id or "").strip()
        n = (new_id or "").strip()
        if not o or not n or o == n:
            return
        raw = self.scenarios_catalog.get("scenarios")
        if not isinstance(raw, list):
            return
        changed = False
        for e in raw:
            if not isinstance(e, dict):
                continue
            arr = e.get("dialogueGraphIds")
            if not isinstance(arr, list):
                continue
            old_norm = [str(x).strip() for x in arr if str(x).strip()]
            repl: list[str] = [n if x == o else x for x in old_norm]
            seen: set[str] = set()
            dedup: list[str] = []
            for x in repl:
                if x not in seen:
                    seen.add(x)
                    dedup.append(x)
            if dedup != old_norm:
                changed = True
                if dedup:
                    e["dialogueGraphIds"] = dedup
                elif "dialogueGraphIds" in e:
                    del e["dialogueGraphIds"]
        if changed:
            self.mark_dirty("scenarios")

    def document_reveal_ids(self) -> list[str]:
        """document_reveals.json 各条目的 ``id``（去空白，保持列表顺序）。"""
        out: list[str] = []
        for d in self.document_reveals or []:
            if isinstance(d, dict):
                i = d.get("id")
                if i is not None and str(i).strip():
                    out.append(str(i).strip())
        return out

    def all_archive_document_ids(self) -> list[tuple[str, str]]:
        """archive/documents.json 条目 ``(id, name)``，供文档揭示等选择 documentId。"""
        out: list[tuple[str, str]] = []
        for d in self.archive_documents or []:
            if not isinstance(d, dict):
                continue
            i = d.get("id")
            if i is None or not str(i).strip():
                continue
            rid = str(i).strip()
            out.append((rid, str(d.get("name", rid))))
        return out

    def anim_asset_path_choices(self) -> list[tuple[str, str]]:
        """(runtime path /assets/animation/<id>/anim.json, 显示名) for npc animFile."""
        return [
            (f"/assets/animation/{stem}/anim.json", stem)
            for stem in self.all_anim_files()
        ]

    def overlay_short_id_entries(self) -> list[tuple[str, str]]:
        """overlay_images.json 的短 id 键，供 show/hide/blend 叠图动作 id 下拉。"""
        if not isinstance(self.overlay_images, dict):
            return []
        out: list[tuple[str, str]] = []
        for k in sorted(self.overlay_images.keys(), key=lambda x: (str(x).lower(), str(x))):
            ks = str(k).strip()
            if ks:
                out.append((ks, ks))
        return out

    def actor_id_items_for_scene(self, scene_id: str | None) -> list[tuple[str, str]]:
        """与 Game.resolveActor 一致：过场临时演员 + 当前场景 NPC + player。"""
        items: list[tuple[str, str]] = []
        for tid, disp in self.collect_cutscene_temp_actor_ids():
            items.append((tid, disp))
        for nid, label in self.npc_ids_for_scene(scene_id):
            items.append((nid, label))
        items.append(("player", "player"))
        return items

    def npc_actor_items_for_scene(self, scene_id: str | None) -> list[tuple[str, str]]:
        """仅场景 NPC（persistNpc* / stopNpcPatrol 等，不含 player 与 _cut_）。"""
        return list(self.npc_ids_for_scene(scene_id))

    def collect_cutscene_temp_actor_ids(self) -> list[tuple[str, str]]:
        """从过场 steps 收集 cutsceneSpawnActor 的 _cut_* id。"""
        found: set[str] = set()

        def walk(steps: list) -> None:
            for step in steps or []:
                if not isinstance(step, dict):
                    continue
                if step.get("kind") == "action" and step.get("type") == "cutsceneSpawnActor":
                    p = step.get("params") or {}
                    i = str(p.get("id") or "").strip()
                    if i.startswith("_cut_"):
                        found.add(i)
                tr = step.get("tracks")
                if isinstance(tr, list):
                    for sub in tr:
                        if isinstance(sub, dict):
                            walk([sub])

        for cs in self.cutscenes:
            walk(cs.get("steps") or [])
        ordered = sorted(found, key=lambda x: (x.lower(), x))
        return [(i, i) for i in ordered]

    def animation_state_names_for_manifest(self, manifest_path: str) -> list[str]:
        """anim.json 内 states 的键名列表（有序）。"""
        p = (manifest_path or "").strip()
        if not p.startswith("/assets/animation/"):
            return []
        rel = p[len("/assets/animation/"):]
        stem = rel.split("/", 1)[0]
        if not stem:
            return []
        data = self.animations.get(stem)
        if not isinstance(data, dict):
            return []
        st = data.get("states")
        if not isinstance(st, dict):
            return []
        return [str(k) for k in st.keys()]

    def npc_anim_manifest_for_scene(self, scene_id: str | None, npc_id: str) -> str:
        """某场景 NPC 的 animFile 路径；找不到则返回空字符串。"""
        nid = (npc_id or "").strip()
        if not nid or not scene_id:
            return ""
        sc = self.scenes.get(scene_id) or {}
        for npc in sc.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            raw = npc.get("id") or npc.get("npcId")
            if raw is None or str(raw).strip() != nid:
                continue
            af = npc.get("animFile")
            if af is not None and str(af).strip():
                return str(af).strip()
        return ""

    def player_avatar_anim_manifest(self) -> str:
        """game_config.playerAvatar.animManifest（默认玩家动画包）。"""
        pa = self.game_config.get("playerAvatar") if isinstance(self.game_config, dict) else None
        if not isinstance(pa, dict):
            return ""
        am = pa.get("animManifest")
        return str(am).strip() if am is not None else ""

    def animation_state_names_for_actor(self, scene_id: str | None, actor_id: str) -> list[str]:
        """resolveActor 目标当前可用的动画 state 名（player 用配置 animManifest，NPC 用 animFile）。"""
        aid = (actor_id or "").strip()
        if not aid:
            return []
        if aid == "player":
            return self.animation_state_names_for_manifest(self.player_avatar_anim_manifest())
        mf = self.npc_anim_manifest_for_scene(scene_id, aid)
        return self.animation_state_names_for_manifest(mf)

    def dialogue_graph_node_ids(self, graph_id: str) -> list[str]:
        """对话图 JSON nodes 的键名（与 entry 一致）。"""
        gid = (graph_id or "").strip()
        if not gid:
            return []
        p = self.dialogues_path / "graphs" / f"{gid}.json"
        data = self._load(p, {})
        if not isinstance(data, dict):
            return []
        nodes = data.get("nodes")
        if not isinstance(nodes, dict):
            return []
        return sorted((str(k) for k in nodes.keys()), key=lambda x: (x.lower(), x))

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
        # Cutscene 使用新 steps schema（无副作用，不含 set_flag）
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
            for act in item.get("acceptActions", []):
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
