from __future__ import annotations

import argparse
import csv
import json
import subprocess
import re
import sys
import time
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
AUTHORING = ROOT / "authoring"
ARTIFACT = ROOT / "artifact" / "content_pipeline"

Json = dict[str, Any]


@dataclass
class Diagnostic:
    severity: str
    code: str
    message: str
    file: str = ""
    line: int = 0
    column: int = 0
    suggestion: str = ""

    def to_dict(self) -> Json:
        return {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
            "source": {"file": self.file, "line": self.line, "column": self.column},
            "suggestion": self.suggestion,
        }

    def format(self) -> str:
        loc = f"{self.file}:{self.line}:{self.column}" if self.file else "<pipeline>"
        return f"{loc}: {self.severity} {self.code} {self.message}"


@dataclass
class BuildContext:
    diagnostics: list[Diagnostic] = field(default_factory=list)
    yaml_locations: dict[str, dict[str, Json]] = field(default_factory=dict)
    document_overrides: dict[str, str] = field(default_factory=dict)
    source_map: dict[str, Any] = field(default_factory=lambda: {
        "version": 2,
        "sources": {},
        "runtimeToSource": {},
    })
    index: dict[str, Any] = field(default_factory=lambda: {
        "flags": {},
        "signals": {},
        "quests": {},
        "narrativeGraphs": {},
        "narrativeStates": {},
        "dialogueGraphs": {},
        "dialogueNodes": {},
        "dialogueEdges": {},
        "conditions": {},
        "actions": {},
        "scenarios": {},
        "sceneRefs": {},
        "items": {},
        "rules": {},
        "archive": {},
        "audio": {},
    })

    def warn(self, code: str, message: str, file: str = "", line: int = 0, column: int = 0, suggestion: str = "") -> None:
        self.diagnostics.append(Diagnostic("warning", code, message, file, line, column, suggestion))

    def error(self, code: str, message: str, file: str = "", line: int = 0, column: int = 0, suggestion: str = "") -> None:
        self.diagnostics.append(Diagnostic("error", code, message, file, line, column, suggestion))

    def source(self, path: Path, loc_path: tuple[Any, ...] = ()) -> Json:
        rel = _rel(path)
        locs = self.yaml_locations.get(rel, {})
        loc = locs.get(_loc_key(loc_path)) or locs.get("")
        return {"file": rel, "line": int(loc.get("line", 1)), "column": int(loc.get("column", 1))}

    def source_id(self, prefix: str, raw: Any, *, source: Json, kind: str) -> str:
        if isinstance(raw, dict) and isinstance(raw.get("id"), str) and raw["id"].strip():
            return f"{prefix}.{_slug(raw['id'])}"
        fallback = f"{prefix}._line{int(source.get('line', 1))}_col{int(source.get('column', 1))}"
        self.warn(
            "source_id.implicit",
            f"{kind} missing stable id; generated fallback sourceId {fallback}",
            str(source.get("file", "")),
            int(source.get("line", 0) or 0),
            int(source.get("column", 0) or 0),
            "Add an authoring-only id field to keep trace/source mapping stable after reordering.",
        )
        return fallback

    def add_source_map(self, source_id: str, *, runtime_ref: str, source: Json, kind: str, runtime_path: str = "") -> None:
        self.source_map["sources"][source_id] = {
            "kind": kind,
            "runtimePath": runtime_path,
            **source,
        }
        self.source_map["runtimeToSource"][runtime_ref] = source_id


def _rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except Exception:
        return path.as_posix()


def _loc_key(path: tuple[Any, ...]) -> str:
    return ".".join(str(p) for p in path)


def _slug(value: Any) -> str:
    text = str(value).strip()
    text = re.sub(r"[^0-9A-Za-z_.-]+", "_", text)
    return text.strip("._-") or "unnamed"


def display_name(data: Json, *keys: str) -> str:
    """Return the first non-empty author-facing display name field."""
    for key in keys:
        value = data.get(key)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _condition_id(raw: Any) -> str:
    if isinstance(raw, dict) and isinstance(raw.get("id"), str):
        return raw["id"]
    if isinstance(raw, list) and raw and isinstance(raw[0], dict) and isinstance(raw[0].get("id"), str):
        return str(raw[0]["id"])
    return ""


def ensure_dir(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)


def write_json(path: Path, data: Any) -> None:
    ensure_dir(path)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    ensure_dir(path)
    path.write_text(text, encoding="utf-8")


# Logical runtime output keys -> their canonical real runtime path (used for ownership lookup).
_DEFAULT_RUNTIME_OUTPUTS = {
    "flagRegistry": "public/assets/data/flag_registry.json",
    "narrativeGraphs": "public/assets/data/narrative_graphs.json",
    "quests": "public/assets/data/quests.json",
    "dialogueGraphs": "public/assets/dialogues/graphs",
}
_DEFAULT_PREVIEW_OUTPUTS = {
    "flagRegistry": "artifact/content_pipeline/runtime_preview/public/assets/data/flag_registry.json",
    "narrativeGraphs": "artifact/content_pipeline/runtime_preview/public/assets/data/narrative_graphs.json",
    "quests": "artifact/content_pipeline/runtime_preview/public/assets/data/quests.json",
    "dialogueGraphs": "artifact/content_pipeline/runtime_preview/public/assets/dialogues/graphs",
}
_DEFAULT_OWNERSHIP = {
    "public/assets/data/flag_registry.json": "legacy_editor",
    "public/assets/data/narrative_graphs.json": "legacy_editor",
    "public/assets/data/quests.json": "legacy_editor",
    "public/assets/dialogues/graphs/*": "legacy_editor",
}


def _default_config() -> Json:
    return {
        "publishRuntime": False,
        "artifactRoot": ARTIFACT,
        "previewRoot": ARTIFACT / "runtime_preview",
        "runtimeOutputs": dict(_DEFAULT_RUNTIME_OUTPUTS),
        "previewOutputs": dict(_DEFAULT_PREVIEW_OUTPUTS),
        "ownership": dict(_DEFAULT_OWNERSHIP),
    }


def load_project_config(ctx: BuildContext) -> Json:
    cfg = _default_config()
    path = AUTHORING / "project.yaml"
    if not path.exists():
        ctx.warn("project.missing", "authoring/project.yaml not found; using safe preview defaults")
        return cfg
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        ctx.error("project.parse", f"failed to parse project.yaml: {e}", _rel(path))
        return cfg
    if not isinstance(raw, dict):
        ctx.warn("project.invalid", "project.yaml is not a mapping; using safe defaults", _rel(path))
        return cfg
    if isinstance(raw.get("publishRuntime"), bool):
        cfg["publishRuntime"] = raw["publishRuntime"]
    for key in ("runtimeOutputs", "previewOutputs", "ownership"):
        if isinstance(raw.get(key), dict):
            cfg[key] = {**cfg[key], **{k: v for k, v in raw[key].items() if isinstance(v, str)}}
    return cfg


def owner_for(real_path: str, ownership: dict[str, str]) -> str:
    """Resolve the owner of a runtime path. Unlisted paths default to pipeline-owned."""
    if real_path in ownership:
        return ownership[real_path]
    for pattern, owner in ownership.items():
        if pattern.endswith("/*") and (real_path == pattern[:-2] or real_path.startswith(pattern[:-1])):
            return owner
        if fnmatch(real_path, pattern):
            return owner
    return "pipeline"


KNOWN_FLAG_VALUE_TYPES = frozenset({"bool", "boolean", "int", "float", "number", "string", "str", "any"})
KNOWN_QUEST_TYPES = frozenset({"main", "side", "optional", "hidden"})


def ownership_status(real_path: str, cfg: Json) -> Json:
    owner = owner_for(real_path, cfg["ownership"])
    return {
        "owner": owner,
        "pipelineOwned": owner == "pipeline",
        "legacyOwned": owner == "legacy_editor",
        "canPublish": owner == "pipeline",
        "readonlySource": owner == "legacy_editor",
    }


def collect_generated_output_paths(cfg: Json) -> set[str]:
    """Return relative paths that are pipeline-generated outputs (not for hand-editing)."""
    out: set[str] = set()
    preview_root = cfg.get("previewRoot")
    if isinstance(preview_root, Path):
        for key, path_str in cfg.get("previewOutputs", {}).items():
            out.add(path_str)
    for key, real_path_str in cfg.get("runtimeOutputs", {}).items():
        if owner_for(real_path_str, cfg.get("ownership", {})) == "pipeline":
            out.add(real_path_str)
    return out


def validate_mixed_ownership(ctx: BuildContext, cfg: Json) -> None:
    """Warn when pipeline-authored IDs collide with IDs in legacy-owned runtime files."""
    checks: list[tuple[str, str, str, str]] = [
        ("narrativeGraphs", cfg["runtimeOutputs"].get("narrativeGraphs", _DEFAULT_RUNTIME_OUTPUTS["narrativeGraphs"]), "narrativeGraphs", "narrativeGraph"),
        ("quests", cfg["runtimeOutputs"].get("quests", _DEFAULT_RUNTIME_OUTPUTS["quests"]), "quests", "quest"),
    ]
    for bucket, real_path_str, data_key, label in checks:
        real_path = ROOT / real_path_str
        if not real_path.exists():
            continue
        if owner_for(real_path_str, cfg["ownership"]) != "legacy_editor":
            continue
        try:
            legacy_raw = json.loads(real_path.read_text(encoding="utf-8-sig"))
        except Exception:
            continue
        if data_key == "narrativeGraphs":
            legacy_ids: set[str] = set()
            for comp in legacy_raw.get("compositions", []) if isinstance(legacy_raw, dict) else []:
                g = comp.get("mainGraph") if isinstance(comp, dict) else None
                if isinstance(g, dict) and g.get("id"):
                    legacy_ids.add(str(g["id"]))
        elif data_key == "quests":
            legacy_ids = {str(q["id"]) for q in (legacy_raw if isinstance(legacy_raw, list) else []) if isinstance(q, dict) and q.get("id")}
        else:
            continue
        pipeline_ids = set(ctx.index.get(bucket, {}).keys())
        for cid in sorted(pipeline_ids & legacy_ids):
            rec = ctx.index[bucket][cid]
            loc = first_index_location(rec, "declaredAt")
            ctx.warn(
                "ownership.legacyConflict",
                f"{label} {cid!r} exists in pipeline authoring AND in legacy runtime {real_path_str}; "
                "publishing pipeline output will replace the legacy version",
                str(loc.get("file", "") or ""),
                int(loc.get("line", 0) or 0),
            )

    # Check dialogue graphs against legacy dialogue directory
    dlg_dir = ROOT / cfg["runtimeOutputs"].get("dialogueGraphs", _DEFAULT_RUNTIME_OUTPUTS["dialogueGraphs"])
    dlg_path_str = cfg["runtimeOutputs"].get("dialogueGraphs", _DEFAULT_RUNTIME_OUTPUTS["dialogueGraphs"])
    if dlg_dir.is_dir() and owner_for(dlg_path_str + "/x.json", cfg["ownership"]) == "legacy_editor":
        legacy_dlg_ids = {p.stem for p in dlg_dir.glob("*.json")}
        pipeline_dlg_ids = set(ctx.index.get("dialogueGraphs", {}).keys())
        for cid in sorted(pipeline_dlg_ids & legacy_dlg_ids):
            rec = ctx.index["dialogueGraphs"][cid]
            loc = first_index_location(rec, "declaredAt")
            ctx.warn(
                "ownership.legacyConflict",
                f"dialogue graph {cid!r} exists in pipeline authoring AND in legacy runtime {dlg_path_str}/; "
                "publishing pipeline output will replace the legacy version",
                str(loc.get("file", "") or ""),
                int(loc.get("line", 0) or 0),
            )


def resolve_output_target(cfg: Json, key: str, publish: bool) -> tuple[Path, bool]:
    """Return (absolute_path, published). Publishes to the real runtime path only when
    publish is requested AND the target is not owned by the legacy editor."""
    real = cfg["runtimeOutputs"].get(key, _DEFAULT_RUNTIME_OUTPUTS[key])
    owner = owner_for(real, cfg["ownership"])
    if publish and owner != "legacy_editor":
        return (ROOT / real, True)
    preview = cfg["previewOutputs"].get(key, _DEFAULT_PREVIEW_OUTPUTS[key])
    return (ROOT / preview, False)


def read_csv_rows(path: Path, ctx: BuildContext) -> list[dict[str, str]]:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        rows = []
        for i, row in enumerate(reader, start=2):
            clean = {str(k or "").strip(): str(v or "").strip() for k, v in row.items()}
            clean["__file"] = _rel(path)
            clean["__line"] = str(i)
            rows.append(clean)
        return rows


def parse_scalar(raw: str) -> Any:
    s = raw.strip()
    if s == "":
        return None
    if s.lower() in {"true", "yes"}:
        return True
    if s.lower() in {"false", "no"}:
        return False
    if s.lower() in {"null", "none"}:
        return None
    try:
        if re.fullmatch(r"-?\d+", s):
            return int(s)
        if re.fullmatch(r"-?\d+\.\d+", s):
            return float(s)
    except Exception:
        pass
    return s


def parse_simple_yaml(path: Path, ctx: BuildContext) -> Any:
    """Parse YAML and retain source locations for source maps and trace lookup."""
    rel = _rel(path)
    override = ctx.document_overrides.get(rel)
    if override is not None:
        text = override
    elif not path.exists():
        ctx.error("yaml.missing", f"missing YAML file: {rel}", rel)
        return {}
    else:
        text = path.read_text(encoding="utf-8")
    try:
        root_node = yaml.compose(text)
        data = yaml.safe_load(text)
    except yaml.YAMLError as e:
        mark = getattr(e, "problem_mark", None)
        ctx.error("yaml.parse", str(e), rel, int(getattr(mark, "line", 0)) + 1, int(getattr(mark, "column", 0)) + 1)
        return {}

    locs: dict[str, Json] = {}

    def remember(loc_path: tuple[Any, ...], node: yaml.Node | None) -> None:
        if node is None:
            return
        locs[_loc_key(loc_path)] = {
            "file": rel,
            "line": int(node.start_mark.line) + 1,
            "column": int(node.start_mark.column) + 1,
        }

    def scalar_key(node: yaml.Node) -> Any:
        if isinstance(node, yaml.ScalarNode):
            return node.value
        return "<complex>"

    def walk(node: yaml.Node | None, loc_path: tuple[Any, ...] = ()) -> None:
        remember(loc_path, node)
        if isinstance(node, yaml.MappingNode):
            for key_node, value_node in node.value:
                key = scalar_key(key_node)
                remember(loc_path + (key,), key_node)
                walk(value_node, loc_path + (key,))
        elif isinstance(node, yaml.SequenceNode):
            for i, item in enumerate(node.value):
                walk(item, loc_path + (i,))

    walk(root_node)
    ctx.yaml_locations[rel] = locs
    return data if data is not None else {}


def normalize_condition(expr: Any) -> Any:
    if expr is None:
        return []
    if isinstance(expr, list):
        return [normalize_condition(x) for x in expr]
    if isinstance(expr, dict):
        return {k: normalize_condition(v) if k in {"all", "any", "not"} else v for k, v in expr.items() if k != "id"}
    return expr


def normalize_action(raw: Any) -> Json:
    if isinstance(raw, dict) and "type" in raw:
        return {"type": str(raw.get("type", "")), "params": raw.get("params") or {}}
    if isinstance(raw, dict) and len(raw) == 1:
        k, v = next(iter(raw.items()))
        if k == "signal":
            return {"type": "emitNarrativeSignal", "params": {"signal": v}}
        if k == "setFlag" and isinstance(v, dict):
            return {"type": "setFlag", "params": v}
        return {"type": str(k), "params": v if isinstance(v, dict) else {"value": v}}
    return {"type": "unknown", "params": {"raw": raw}}


def strip_authoring_action_ids(value: Any) -> Any:
    if isinstance(value, list):
        return [strip_authoring_action_ids(item) for item in value]
    if not isinstance(value, dict):
        return value
    out = {k: strip_authoring_action_ids(v) for k, v in value.items() if not (k == "id" and "type" in value and "params" in value)}
    return out


def normalize_next_quests(raw: Any) -> list[Json]:
    if not isinstance(raw, list):
        return []
    out: list[Json] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        edge = {k: v for k, v in item.items() if k != "id"}
        if "conditions" in edge:
            edge["conditions"] = normalize_condition(edge.get("conditions"))
        out.append(edge)
    return out


def index_ref(bucket: dict[str, Any], key: str, role: str, item: Json) -> None:
    if not key:
        return
    rec = bucket.setdefault(key, {"declaredAt": [], "readers": [], "writers": [], "emitters": [], "listeners": []})
    rec.setdefault(role, []).append(item)


VALID_CONDITION_OPS = frozenset({"==", "!=", ">", "<", ">=", "<="})
VALID_QUEST_STATUSES = frozenset({"Inactive", "Active", "Completed"})
VALID_SCENARIO_STATUSES = frozenset({"pending", "active", "done", "locked", "completed"})

ACTION_PARAM_TYPES: dict[str, dict[str, str]] = {
    "runActions": {"actions": "actions"},
    "chooseAction": {"prompt": "str", "allowCancel": "bool", "options": "list"},
    "randomBranch": {"probability": "number", "aboveActions": "actions", "belowActions": "actions"},
    "setFlag": {"key": "str", "value": "any"},
    "appendFlag": {"key": "str", "text": "str", "value": "str"},
    "setNarrativeState": {"graphId": "str", "stateId": "str"},
    "setScenarioPhase": {"scenarioId": "str", "phase": "str", "status": "str", "outcome": "scalar"},
    "startScenario": {"scenarioId": "str"},
    "activateScenario": {"scenarioId": "str"},
    "completeScenario": {"scenarioId": "str"},
    "emitNarrativeSignal": {"signal": "str", "sourceType": "str", "sourceId": "str"},
    "giveItem": {"id": "str", "count": "int"},
    "removeItem": {"id": "str", "count": "int"},
    "giveCurrency": {"amount": "number"},
    "removeCurrency": {"amount": "scalar"},
    "giveRule": {"id": "str"},
    "grantRuleLayer": {"ruleId": "str", "layer": "str"},
    "giveFragment": {"id": "str"},
    "updateQuest": {"id": "str", "questId": "str"},
    "startEncounter": {"id": "str"},
    "playBgm": {"id": "str", "fadeMs": "int"},
    "stopBgm": {"fadeMs": "int"},
    "playSfx": {"id": "str"},
    "endDay": {},
    "addDelayedEvent": {"targetDay": "int", "actions": "actions"},
    "addArchiveEntry": {"bookType": "str", "entryId": "str"},
    "startCutscene": {"id": "str"},
    "startWaterMinigame": {"id": "str"},
    "startSugarWheelMinigame": {"id": "str"},
    "startPaperCraftMinigame": {"id": "str"},
    "sugarWheelShowSpeech": {"role": "str", "text": "str", "durationMs": "int"},
    "sugarWheelDismissSpeech": {"role": "str"},
    "sugarWheelDismissAllSpeech": {},
    "sugarWheelResetPointer": {"angleDeg": "number"},
    "debugAlertActionParams": {"title": "str"},
    "showEmote": {"target": "str", "emote": "str", "duration": "number", "anchorOffsetX": "number", "anchorOffsetY": "number"},
    "showSpeechBubble": {"target": "str", "text": "str", "duration": "number", "anchorOffsetX": "number", "anchorOffsetY": "number"},
    "showEmoteAndWait": {"target": "str", "emote": "str", "duration": "number", "anchorOffsetX": "number", "anchorOffsetY": "number"},
    "showSpeechBubbleAndWait": {"target": "str", "text": "str", "duration": "number", "anchorOffsetX": "number", "anchorOffsetY": "number"},
    "playNpcAnimation": {"target": "str", "state": "str"},
    "setEntityEnabled": {"target": "str", "enabled": "bool"},
    "openShop": {"shopId": "str"},
    "pickup": {"itemId": "str", "itemName": "str", "count": "int", "isCurrency": "bool"},
    "switchScene": {"targetScene": "str", "sceneId": "str", "targetSpawnPoint": "str"},
    "changeScene": {"targetScene": "str", "sceneId": "str", "targetSpawnPoint": "str"},
    "transitionScene": {"targetScene": "str", "sceneId": "str", "targetSpawnPoint": "str"},
    "showNotification": {"text": "str", "type": "str"},
    "stopNpcPatrol": {"npcId": "str"},
    "persistNpcDisablePatrol": {"npcId": "str"},
    "persistNpcEnablePatrol": {"npcId": "str"},
    "persistNpcEntityEnabled": {"target": "str", "enabled": "bool"},
    "persistHotspotEnabled": {"hotspotId": "str", "target": "str", "enabled": "bool"},
    "setZoneEnabled": {"sceneId": "str", "zoneId": "str", "enabled": "bool"},
    "persistZoneEnabled": {"sceneId": "str", "zoneId": "str", "enabled": "bool"},
    "setSceneEntityPosition": {"sceneId": "str", "entityKind": "str", "entityId": "str", "x": "number", "y": "number"},
    "persistNpcAt": {"target": "str", "x": "number", "y": "number"},
    "persistNpcAnimState": {"target": "str", "state": "str"},
    "persistPlayNpcAnimation": {"target": "str", "state": "str"},
    "shopPurchase": {"itemId": "str", "price": "int"},
    "inventoryDiscard": {"itemId": "str"},
    "setPlayerAvatar": {"manifestPath": "str", "stateMap": "object"},
    "resetPlayerAvatar": {},
    "setSceneDepthFloorOffset": {"floor_offset": "number"},
    "resetSceneDepthFloorOffset": {},
    "setCameraZoom": {"zoom": "number"},
    "restoreSceneCameraZoom": {},
    "fadingZoom": {"zoom": "number", "durationMs": "int"},
    "fadingRestoreSceneCameraZoom": {"durationMs": "int"},
    "fadeWorldToBlack": {"durationMs": "int", "duration": "int"},
    "fadeWorldFromBlack": {"durationMs": "int", "duration": "int"},
    "showOverlayImage": {"id": "str", "image": "str", "xPercent": "number", "yPercent": "number", "widthPercent": "number"},
    "setHotspotDisplayImage": {"sceneId": "str", "hotspotId": "str", "image": "str", "worldWidth": "number", "worldHeight": "number", "facing": "str"},
    "tempSetHotspotDisplayFacing": {"sceneId": "str", "hotspotId": "str", "facing": "str"},
    "setEntityField": {"sceneId": "str", "entityKind": "str", "entityId": "str", "fieldName": "str", "value": "any"},
    "hideOverlayImage": {"id": "str"},
    "blendOverlayImage": {"id": "str", "fromImage": "str", "toImage": "str", "durationMs": "int", "delayMs": "int", "xPercent": "number", "yPercent": "number", "widthPercent": "number"},
    "startDialogueGraph": {"graphId": "str", "entry": "str", "npcId": "str", "ownerType": "str", "ownerId": "str"},
    "waitClickContinue": {"text": "str"},
    "playScriptedDialogue": {"lines": "list", "scriptedNpcId": "str"},
    "waitMs": {"durationMs": "int"},
    "enableRuleOffers": {"slots": "list"},
    "disableRuleOffers": {},
    "moveEntityTo": {"target": "str", "sceneId": "str", "x": "number", "y": "number", "speed": "number", "waypoints": "list", "moveAnimState": "str", "faceTowardMovement": "bool"},
    "faceEntity": {"target": "str", "direction": "str", "faceTarget": "str"},
    "cutsceneSpawnActor": {"id": "str", "name": "str", "x": "number", "y": "number"},
    "cutsceneRemoveActor": {"id": "str"},
    "revealDocument": {"documentId": "str"},
}

ACTION_REQUIRED_PARAMS: dict[str, tuple[str, ...]] = {
    "setFlag": ("key", "value"),
    "appendFlag": ("key",),
    "setNarrativeState": ("graphId", "stateId"),
    "setScenarioPhase": ("scenarioId", "phase", "status"),
    "startScenario": ("scenarioId",),
    "activateScenario": ("scenarioId",),
    "completeScenario": ("scenarioId",),
    "emitNarrativeSignal": ("signal",),
    "giveItem": ("id",),
    "removeItem": ("id",),
    "giveCurrency": ("amount",),
    "removeCurrency": ("amount",),
    "giveRule": ("id",),
    "grantRuleLayer": ("ruleId", "layer"),
    "giveFragment": ("id",),
    "startEncounter": ("id",),
    "playBgm": ("id",),
    "playSfx": ("id",),
    "addArchiveEntry": ("bookType", "entryId"),
    "startCutscene": ("id",),
    "startWaterMinigame": ("id",),
    "startSugarWheelMinigame": ("id",),
    "startPaperCraftMinigame": ("id",),
    "sugarWheelShowSpeech": ("role", "text"),
    "sugarWheelDismissSpeech": ("role",),
    "showEmote": ("target", "emote"),
    "showSpeechBubble": ("target", "text"),
    "showEmoteAndWait": ("target", "emote"),
    "showSpeechBubbleAndWait": ("target", "text"),
    "playNpcAnimation": ("target", "state"),
    "setEntityEnabled": ("target", "enabled"),
    "openShop": ("shopId",),
    "stopNpcPatrol": ("npcId",),
    "persistNpcDisablePatrol": ("npcId",),
    "persistNpcEnablePatrol": ("npcId",),
    "persistNpcEntityEnabled": ("target", "enabled"),
    "setZoneEnabled": ("sceneId", "zoneId", "enabled"),
    "persistZoneEnabled": ("sceneId", "zoneId", "enabled"),
    "setSceneEntityPosition": ("sceneId", "entityKind", "entityId", "x", "y"),
    "persistNpcAt": ("target", "x", "y"),
    "persistNpcAnimState": ("target", "state"),
    "persistPlayNpcAnimation": ("target", "state"),
    "shopPurchase": ("itemId", "price"),
    "inventoryDiscard": ("itemId",),
    "setCameraZoom": ("zoom",),
    "fadingZoom": ("zoom",),
    "showOverlayImage": ("id", "image", "xPercent", "yPercent", "widthPercent"),
    "setHotspotDisplayImage": ("sceneId", "hotspotId", "image"),
    "tempSetHotspotDisplayFacing": ("sceneId", "hotspotId", "facing"),
    "setEntityField": ("sceneId", "entityKind", "entityId", "fieldName", "value"),
    "hideOverlayImage": ("id",),
    "blendOverlayImage": ("id", "fromImage", "toImage", "xPercent", "yPercent", "widthPercent"),
    "startDialogueGraph": ("graphId",),
    "playScriptedDialogue": ("lines",),
    "moveEntityTo": ("target", "x", "y"),
    "faceEntity": ("target",),
    "cutsceneSpawnActor": ("id", "x", "y"),
    "cutsceneRemoveActor": ("id",),
    "revealDocument": ("documentId",),
}


def flag_value_type(ctx: BuildContext, key: str) -> str:
    rec = ctx.index.get("flags", {}).get(key) or {}
    for item in rec.get("declaredAt") or []:
        if isinstance(item, dict) and item.get("valueType"):
            return str(item["valueType"])
    return ""


def value_matches_type(value: Any, value_type: str) -> bool:
    if value_type in {"", "any"}:
        return True
    if value_type in {"bool", "boolean"}:
        return isinstance(value, bool)
    if value_type in {"number", "float", "int"}:
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if value_type in {"string", "str"}:
        return isinstance(value, str)
    return True


def validate_flag_value(ctx: BuildContext, key: str, value: Any, loc: Json, code: str, label: str) -> None:
    value_type = flag_value_type(ctx, key)
    if not value_type or value is None:
        return
    if not value_matches_type(value, value_type):
        ctx.error(
            code,
            f"{label} for flag {key} must match registry type {value_type}; got {type(value).__name__}",
            str(loc.get("file", "")),
            int(loc.get("line", 0) or 0),
            int(loc.get("column", 0) or 0),
        )


def validate_required_param(ctx: BuildContext, typ: str, params: Json, name: str, loc: Json) -> bool:
    value = params.get(name)
    if value is None or (isinstance(value, str) and not value.strip()):
        ctx.error(
            "action.param.required",
            f"action {typ} requires params.{name}",
            str(loc.get("file", "")),
            int(loc.get("line", 0) or 0),
            int(loc.get("column", 0) or 0),
        )
        return False
    return True


def validate_number_param(ctx: BuildContext, typ: str, params: Json, name: str, loc: Json) -> None:
    if name not in params or params.get(name) is None:
        return
    if not isinstance(params.get(name), (int, float)) or isinstance(params.get(name), bool):
        ctx.error(
            "action.param.type",
            f"action {typ} params.{name} must be a number",
            str(loc.get("file", "")),
            int(loc.get("line", 0) or 0),
            int(loc.get("column", 0) or 0),
        )


def param_matches_schema_type(value: Any, expected: str) -> bool:
    if expected == "any":
        return True
    if expected == "scalar":
        return value is None or isinstance(value, (str, int, float, bool))
    if expected == "str":
        return isinstance(value, str)
    if expected == "int":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "bool":
        return isinstance(value, bool)
    if expected in {"list", "actions"}:
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    return True


def validate_action_param_registry(ctx: BuildContext, typ: str, params: Json, loc: Json) -> None:
    schema = ACTION_PARAM_TYPES.get(typ)
    if schema is None:
        ctx.error(
            "action.type.unknown",
            f"unknown action type: {typ}",
            str(loc.get("file", "")),
            int(loc.get("line", 0) or 0),
            int(loc.get("column", 0) or 0),
        )
        return
    for name in ACTION_REQUIRED_PARAMS.get(typ, ()):
        validate_required_param(ctx, typ, params, name, loc)
    for name, value in params.items():
        if name == "id":
            continue
        expected = schema.get(name)
        if expected is None:
            ctx.warn(
                "action.param.unknown",
                f"action {typ} has unknown params.{name}",
                str(loc.get("file", "")),
                int(loc.get("line", 0) or 0),
                int(loc.get("column", 0) or 0),
            )
            continue
        if not param_matches_schema_type(value, expected):
            ctx.error(
                "action.param.type",
                f"action {typ} params.{name} must be {expected}; got {type(value).__name__}",
                str(loc.get("file", "")),
                int(loc.get("line", 0) or 0),
                int(loc.get("column", 0) or 0),
            )


def validate_action_schema(action: Json, ctx: BuildContext, loc: Json) -> None:
    typ = str(action.get("type", ""))
    params = action.get("params") if isinstance(action.get("params"), dict) else {}
    validate_action_param_registry(ctx, typ, params, loc)
    if typ == "setFlag":
        if validate_required_param(ctx, typ, params, "key", loc):
            key = str(params.get("key", ""))
            if "value" not in params:
                ctx.error("action.param.required", f"action {typ} requires params.value", str(loc.get("file", "")), int(loc.get("line", 0) or 0), int(loc.get("column", 0) or 0))
            else:
                validate_flag_value(ctx, key, params.get("value"), loc, "action.flag.valueType", "setFlag.value")
    elif typ == "appendFlag":
        if validate_required_param(ctx, typ, params, "key", loc):
            key = str(params.get("key", ""))
            value_type = flag_value_type(ctx, key)
            if value_type and value_type not in {"string", "str"}:
                ctx.error("action.flag.appendType", f"appendFlag requires a string flag, but {key} is {value_type}", str(loc.get("file", "")), int(loc.get("line", 0) or 0), int(loc.get("column", 0) or 0))
        if "text" not in params and "value" not in params:
            ctx.error("action.param.required", f"action {typ} requires params.text or params.value", str(loc.get("file", "")), int(loc.get("line", 0) or 0), int(loc.get("column", 0) or 0))
    elif typ == "emitNarrativeSignal":
        validate_required_param(ctx, typ, params, "signal", loc)
    elif typ == "updateQuest":
        if not params.get("id") and not params.get("questId"):
            ctx.error("action.param.required", f"action {typ} requires params.id", str(loc.get("file", "")), int(loc.get("line", 0) or 0), int(loc.get("column", 0) or 0))
    elif typ == "startDialogueGraph":
        validate_required_param(ctx, typ, params, "graphId", loc)
    elif typ in {"switchScene", "transitionScene"}:
        if not params.get("targetScene") and not params.get("sceneId"):
            ctx.error("action.param.required", f"action {typ} requires params.targetScene or params.sceneId", str(loc.get("file", "")), int(loc.get("line", 0) or 0), int(loc.get("column", 0) or 0))
    elif typ in {"moveEntityTo", "persistEntityPosition", "setEntityPosition"}:
        validate_number_param(ctx, typ, params, "x", loc)
        validate_number_param(ctx, typ, params, "y", loc)
    elif typ == "setScenarioPhase":
        validate_required_param(ctx, typ, params, "scenarioId", loc)
        validate_required_param(ctx, typ, params, "phase", loc)
        if validate_required_param(ctx, typ, params, "status", loc) and str(params.get("status")) not in VALID_SCENARIO_STATUSES:
            ctx.error("action.scenario.status.invalid", f"setScenarioPhase status should be one of {sorted(VALID_SCENARIO_STATUSES)}", str(loc.get("file", "")), int(loc.get("line", 0) or 0), int(loc.get("column", 0) or 0))
    elif typ in {"activateScenario", "completeScenario", "startScenario"}:
        validate_required_param(ctx, typ, params, "scenarioId", loc)


def validate_condition_schema(expr: Any, ctx: BuildContext, loc: Json) -> None:
    if isinstance(expr, list):
        for item in expr:
            validate_condition_schema(item, ctx, loc)
    elif isinstance(expr, dict):
        if isinstance(expr.get("flag"), str):
            key = expr["flag"]
            op = str(expr.get("op", "=="))
            if op not in VALID_CONDITION_OPS:
                ctx.error("condition.flag.op.invalid", f"flag condition op must be one of {sorted(VALID_CONDITION_OPS)}; got {op}", str(loc.get("file", "")), int(loc.get("line", 0) or 0), int(loc.get("column", 0) or 0))
            if "value" in expr:
                validate_flag_value(ctx, key, expr.get("value"), loc, "condition.flag.valueType", "condition value")
            value_type = flag_value_type(ctx, key)
            if op in {">", "<", ">=", "<="} and value_type and value_type not in {"number", "float", "int"}:
                ctx.error("condition.flag.op.type", f"ordered flag comparison requires numeric flag type; {key} is {value_type}", str(loc.get("file", "")), int(loc.get("line", 0) or 0), int(loc.get("column", 0) or 0))
        if isinstance(expr.get("quest"), str):
            status = expr.get("questStatus", expr.get("status"))
            if status not in VALID_QUEST_STATUSES:
                ctx.error("condition.quest.status.invalid", f"quest condition status must be one of {sorted(VALID_QUEST_STATUSES)}", str(loc.get("file", "")), int(loc.get("line", 0) or 0), int(loc.get("column", 0) or 0))
        if isinstance(expr.get("scenario"), str) and isinstance(expr.get("status"), str):
            if str(expr.get("status")) not in VALID_SCENARIO_STATUSES:
                ctx.error("condition.scenario.status.invalid", f"scenario status should be one of {sorted(VALID_SCENARIO_STATUSES)}", str(loc.get("file", "")), int(loc.get("line", 0) or 0), int(loc.get("column", 0) or 0))
        for k in ("all", "any"):
            if k in expr:
                validate_condition_schema(expr[k], ctx, loc)
        if "not" in expr:
            validate_condition_schema(expr["not"], ctx, loc)


def scan_condition_refs(expr: Any, ctx: BuildContext, loc: Json, mode: str = "readers", *, validate: bool = True) -> None:
    if validate:
        validate_condition_schema(expr, ctx, loc)
    if isinstance(expr, list):
        for item in expr:
            scan_condition_refs(item, ctx, loc, mode, validate=False)
    elif isinstance(expr, dict):
        if isinstance(expr.get("flag"), str):
            index_ref(ctx.index["flags"], expr["flag"], mode, loc)
        if isinstance(expr.get("quest"), str):
            index_ref(ctx.index["quests"], expr["quest"], "readers", loc)
        if isinstance(expr.get("narrative"), str) and isinstance(expr.get("state"), str):
            key = f"{expr['narrative']}.{expr['state']}"
            index_ref(ctx.index["narrativeStates"], key, "readers", loc)
        if isinstance(expr.get("scenario"), str):
            key = str(expr["scenario"])
            if isinstance(expr.get("phase"), str):
                key = f"{key}.{expr['phase']}"
            index_ref(ctx.index["scenarios"], key, "readers", loc)
        if isinstance(expr.get("scenarioLine"), str):
            index_ref(ctx.index["scenarios"], str(expr["scenarioLine"]), "readers", loc)
        for k in ("all", "any"):
            if k in expr:
                scan_condition_refs(expr[k], ctx, loc, mode, validate=False)
        if "not" in expr:
            scan_condition_refs(expr["not"], ctx, loc, mode, validate=False)


def scan_action_refs(actions: list[Any], ctx: BuildContext, loc_base: Json) -> None:
    for i, raw in enumerate(actions or []):
        action = normalize_action(raw)
        typ = action.get("type", "")
        params = action.get("params") or {}
        base_path = str(loc_base.get("path", "") or "")
        item_path = f"{base_path}[{i}]" if base_path else f"actions[{i}]"
        loc = {**loc_base, "path": item_path, "actionType": typ}
        validate_action_schema(action, ctx, loc)
        index_ref(ctx.index["actions"], typ, "readers", loc)
        if typ in {"setFlag", "appendFlag"}:
            index_ref(ctx.index["flags"], str(params.get("key", "")), "writers", loc)
        if typ == "emitNarrativeSignal":
            index_ref(ctx.index["signals"], str(params.get("signal", "")), "emitters", loc)
        if typ == "updateQuest":
            qid = str(params.get("id") or params.get("questId") or "")
            index_ref(ctx.index["quests"], qid, "writers", loc)
        if typ == "setNarrativeState":
            graph_id = str(params.get("graphId", ""))
            state_id = str(params.get("stateId", ""))
            if graph_id:
                index_ref(ctx.index["narrativeGraphs"], graph_id, "writers", loc)
            if graph_id and state_id:
                index_ref(ctx.index["narrativeStates"], f"{graph_id}.{state_id}", "writers", loc)
        if typ == "startDialogueGraph":
            graph_id = str(params.get("graphId", ""))
            index_ref(ctx.index["dialogueGraphs"], graph_id, "readers", loc)
        if typ in {"switchScene", "transitionScene", "changeScene"}:
            scene_id = str(params.get("targetScene") or params.get("sceneId") or "")
            index_ref(ctx.index["sceneRefs"], scene_id, "readers", loc)
        if typ in {"moveEntityTo", "persistEntityPosition", "setEntityPosition"}:
            scene_id = str(params.get("sceneId", ""))
            if scene_id:
                index_ref(ctx.index["sceneRefs"], scene_id, "writers", loc)
        if typ in {"giveItem", "removeItem"}:
            item_id = str(params.get("id", ""))
            if item_id:
                index_ref(ctx.index["items"], item_id, "readers", loc)
        if typ == "pickup":
            item_id = str(params.get("itemId", ""))
            if item_id:
                index_ref(ctx.index["items"], item_id, "readers", loc)
        if typ == "giveRule":
            rule_id = str(params.get("id", ""))
            if rule_id:
                index_ref(ctx.index["rules"], rule_id, "readers", loc)
        if typ == "grantRuleLayer":
            rule_id = str(params.get("ruleId", ""))
            if rule_id:
                index_ref(ctx.index["rules"], rule_id, "readers", loc)
        if typ == "addArchiveEntry":
            entry_id = str(params.get("entryId", ""))
            if entry_id:
                index_ref(ctx.index["archive"], entry_id, "readers", loc)
        if typ in {"playBgm", "playSfx"}:
            audio_id = str(params.get("id", ""))
            if audio_id:
                index_ref(ctx.index["audio"], audio_id, "readers", loc)
        if typ in {"startScenario", "activateScenario", "completeScenario"}:
            scid = str(params.get("scenarioId", ""))
            if scid:
                index_ref(ctx.index["scenarios"], scid, "writers", loc)
        if typ == "setScenarioPhase":
            scid = str(params.get("scenarioId", ""))
            phase = str(params.get("phase", ""))
            key = f"{scid}.{phase}" if scid and phase else scid
            if key:
                index_ref(ctx.index["scenarios"], key, "writers", loc)
        if typ == "runActions" and isinstance(params.get("actions"), list):
            scan_action_refs(params["actions"], ctx, loc)


def compile_flags(ctx: BuildContext) -> Json:
    rows = read_csv_rows(AUTHORING / "tables" / "flags.csv", ctx)
    static = []
    seen = set()
    for row in rows:
        key = row.get("key", "")
        typ = row.get("type", "bool") or "bool"
        if not key:
            ctx.error("flag.key.empty", "flag key is required", row.get("__file", ""), int(row.get("__line", "0") or 0), 1)
            continue
        if key in seen:
            ctx.error("flag.duplicate", f"duplicate flag key: {key}", row.get("__file", ""), int(row.get("__line", "0") or 0), 1)
            continue
        seen.add(key)
        static.append({"key": key, "valueType": "float" if typ in {"number", "float"} else typ})
        source = {"file": row.get("__file"), "line": int(row.get("__line", "1") or 1), "column": 1}
        index_ref(ctx.index["flags"], key, "declaredAt", {**source, "owner": row.get("owner"), "meaning": row.get("meaning"), "valueType": "float" if typ in {"number", "float"} else typ})
        ctx.add_source_map(f"flag.{_slug(key)}", runtime_ref=f"flag:{key}", source=source, kind="flag", runtime_path=f"flag_registry.static.{key}")
    return {"static": static, "patterns": [], "runtime": {"warnUnknownInDev": True}}


def load_scene_refs(ctx: BuildContext) -> None:
    scene_dir = ROOT / "public" / "assets" / "scenes"
    if not scene_dir.exists():
        return
    for path in sorted(scene_dir.glob("*.json")):
        scene_id = path.stem
        try:
            raw = json.loads(path.read_text(encoding="utf-8-sig"))
            if isinstance(raw, dict) and isinstance(raw.get("id"), str) and raw["id"].strip():
                scene_id = raw["id"].strip()
        except Exception:
            pass
        index_ref(ctx.index["sceneRefs"], scene_id, "declaredAt", {"file": _rel(path), "symbol": f"scene:{scene_id}"})


def load_signals(ctx: BuildContext) -> None:
    rows = read_csv_rows(AUTHORING / "tables" / "signals.csv", ctx)
    for row in rows:
        key = row.get("key", "")
        if not key:
            continue
        source = {"file": row.get("__file"), "line": int(row.get("__line", "1") or 1), "column": 1}
        index_ref(ctx.index["signals"], key, "declaredAt", {**source, "owner": row.get("owner"), "meaning": row.get("meaning")})
        ctx.add_source_map(f"signal.{_slug(key)}", runtime_ref=f"signal:{key}", source=source, kind="signal", runtime_path=f"signals.{key}")


def index_embedded_narrative_graph(ctx: BuildContext, path: Path, graph: Json, comp_index: int, element_index: int, seen_graph_ids: set[str]) -> None:
    gid = str(graph.get("id", "") or "")
    graph_source_path: tuple[Any, ...] = ("elements", element_index, "graph")
    graph_path = f"narrative_graphs.compositions[{comp_index}].elements[{element_index}].graph"
    if not gid:
        src = ctx.source(path, graph_source_path)
        ctx.error("narrative.embedded.id.missing", "embedded wrapper graph id is required", src["file"], src["line"], src["column"])
        return
    if gid in seen_graph_ids:
        src = ctx.source(path, (*graph_source_path, "id"))
        ctx.error("narrative.duplicate", f"duplicate narrative graph id: {gid}", src["file"], src["line"], src["column"])
        return
    seen_graph_ids.add(gid)
    owner_type = str(graph.get("ownerType", "") or "")
    owner_id = str(graph.get("ownerId", "") or "")
    ctx.add_source_map(
        f"narrative.{_slug(gid)}",
        runtime_ref=f"narrative:{gid}",
        source=ctx.source(path, (*graph_source_path, "id")),
        kind="narrativeGraph",
        runtime_path=graph_path,
    )
    index_ref(ctx.index["narrativeGraphs"], gid, "declaredAt", {
        "file": _rel(path),
        "symbol": f"narrative:{gid}",
        "ownerType": owner_type,
        "ownerId": owner_id,
    })
    states = graph.get("states") if isinstance(graph.get("states"), dict) else {}
    for sid, sdef in states.items():
        sdef = sdef if isinstance(sdef, dict) else {}
        ctx.add_source_map(
            f"narrative.{_slug(gid)}.state.{_slug(str(sid))}",
            runtime_ref=f"narrative:{gid}.state:{sid}",
            source=ctx.source(path, (*graph_source_path, "states", sid)),
            kind="narrativeState",
            runtime_path=f"{graph_path}.states.{sid}",
        )
        index_ref(ctx.index["narrativeStates"], f"{gid}.{sid}", "declaredAt", {
            "file": _rel(path),
            "symbol": f"narrative:{gid}.state:{sid}",
            "graphId": gid,
            "ownerType": owner_type,
            "ownerId": owner_id,
        })
        if sdef.get("broadcastOnEnter") is True:
            source = ctx.source(path, (*graph_source_path, "states", sid, "broadcastOnEnter"))
            state_signal = f"state:{gid}:{sid}"
            signal_loc = {**source, "symbol": f"narrative:{gid}.state:{sid}.broadcastOnEnter", "owner": f"{owner_type}:{owner_id}"}
            index_ref(ctx.index["signals"], state_signal, "declaredAt", signal_loc)
            index_ref(ctx.index["signals"], state_signal, "emitters", signal_loc)
            ctx.add_source_map(
                f"narrative.{_slug(gid)}.state.{_slug(str(sid))}.broadcastOnEnter",
                runtime_ref=f"narrative:{gid}.state:{sid}.broadcastOnEnter",
                source=source,
                kind="signal",
                runtime_path=f"{graph_path}.states.{sid}.broadcastOnEnter",
            )
        for action_key in ("onEnterActions", "onExitActions"):
            actions = sdef.get(action_key)
            if not isinstance(actions, list):
                continue
            loc = {
                **ctx.source(path, (*graph_source_path, "states", sid, action_key)),
                "symbol": f"narrative:{gid}.state:{sid}",
                "path": f"elements[{element_index}].graph.states.{sid}.{action_key}",
            }
            scan_action_refs(actions, ctx, loc)
            for i, raw_action in enumerate(actions):
                source = ctx.source(path, (*graph_source_path, "states", sid, action_key, i))
                source_id = ctx.source_id(f"narrative.{_slug(gid)}.state.{_slug(str(sid))}.{action_key}", raw_action, source=source, kind="action")
                ctx.add_source_map(
                    source_id,
                    runtime_ref=f"narrative:{gid}.state:{sid}.{action_key}[{i}]",
                    source=source,
                    kind="action",
                    runtime_path=f"{graph_path}.states.{sid}.{action_key}[{i}]",
                )
    transitions = graph.get("transitions") if isinstance(graph.get("transitions"), list) else []
    for ti, transition in enumerate(transitions):
        if not isinstance(transition, dict):
            continue
        tid = str(transition.get("id", "") or ti)
        frm = str(transition.get("from", "") or "")
        to = str(transition.get("to", "") or "")
        if frm and frm not in states:
            src = ctx.source(path, (*graph_source_path, "transitions", ti, "from"))
            ctx.error("narrative.transition.from_missing", f"transition {tid} source state missing: {frm}", src["file"], src["line"], src["column"])
        if to and to not in states:
            src = ctx.source(path, (*graph_source_path, "transitions", ti, "to"))
            ctx.error("narrative.transition.to_missing", f"transition {tid} target state missing: {to}", src["file"], src["line"], src["column"])
        transition_ref = f"narrative:{gid}.transition:{tid}"
        ctx.add_source_map(
            f"narrative.{_slug(gid)}.transition.{_slug(tid)}",
            runtime_ref=transition_ref,
            source=ctx.source(path, (*graph_source_path, "transitions", ti)),
            kind="narrativeTransition",
            runtime_path=f"{graph_path}.transitions[{ti}]",
        )
        if transition.get("signal") is not None:
            index_ref(ctx.index["signals"], str(transition.get("signal")), "listeners", {
                **ctx.source(path, (*graph_source_path, "transitions", ti, "signal")),
                "symbol": f"narrative:{gid}.transition:{tid}",
            })
        if isinstance(transition.get("conditions"), list):
            source = ctx.source(path, (*graph_source_path, "transitions", ti, "conditions"))
            scan_condition_refs(normalize_condition(transition.get("conditions")), ctx, {
                **source,
                "symbol": f"narrative:{gid}.transition:{tid}",
                "path": f"elements[{element_index}].graph.transitions.{tid}.conditions",
            })
            ctx.add_source_map(
                ctx.source_id(f"narrative.{_slug(gid)}.transition.{_slug(tid)}.condition", {"id": _condition_id(transition.get("conditions"))}, source=source, kind="condition"),
                runtime_ref=f"{transition_ref}.conditions",
                source=source,
                kind="condition",
                runtime_path=f"{graph_path}.transitions[{ti}].conditions",
            )


def compile_narrative(ctx: BuildContext) -> Json:
    graphs = []
    compositions: list[Json] = []
    seen_graph_ids: set[str] = set()
    for path in sorted((AUTHORING / "narrative").glob("**/*.yaml")):
        data = parse_simple_yaml(path, ctx)
        if not isinstance(data, dict) or not data.get("id"):
            ctx.error("narrative.id.missing", "narrative graph id is required", _rel(path), 1, 1)
            continue
        gid = str(data["id"])
        if gid in seen_graph_ids:
            src = ctx.source(path, ("id",))
            ctx.error("narrative.duplicate", f"duplicate narrative graph id: {gid}", src["file"], src["line"], src["column"])
            continue
        seen_graph_ids.add(gid)
        comp_index = len(graphs)
        comp_path = f"narrative_graphs.compositions[{comp_index}].mainGraph"
        ctx.add_source_map(
            f"narrative.{_slug(gid)}",
            runtime_ref=f"narrative:{gid}",
            source=ctx.source(path, ("id",)),
            kind="narrativeGraph",
            runtime_path=comp_path,
        )
        owner = data.get("owner") if isinstance(data.get("owner"), dict) else {}
        layout = data.get("layout") if isinstance(data.get("layout"), dict) else {}
        states_src = data.get("states") if isinstance(data.get("states"), dict) else {}
        transitions_src = data.get("transitions") if isinstance(data.get("transitions"), list) else []
        states: Json = {}
        for sid, sdef in states_src.items():
            sdef = sdef if isinstance(sdef, dict) else {}
            out: Json = {"id": sid}
            if sdef.get("label") is not None:
                out["label"] = str(sdef.get("label"))
            pos = layout.get(sid) if isinstance(layout.get(sid), dict) else None
            if pos is not None and (pos.get("x") is not None or pos.get("y") is not None):
                out["meta"] = {"editor": {"x": pos.get("x", 0), "y": pos.get("y", 0)}}
            ctx.add_source_map(
                f"narrative.{_slug(gid)}.state.{_slug(sid)}",
                runtime_ref=f"narrative:{gid}.state:{sid}",
                source=ctx.source(path, ("states", sid)),
                kind="narrativeState",
                runtime_path=f"{comp_path}.states.{sid}",
            )
            if sdef.get("broadcastOnEnter") is not None:
                out["broadcastOnEnter"] = bool(sdef.get("broadcastOnEnter"))
                if sdef.get("broadcastOnEnter") is True:
                    source = ctx.source(path, ("states", sid, "broadcastOnEnter"))
                    state_signal = f"state:{gid}:{sid}"
                    signal_loc = {**source, "symbol": f"narrative:{gid}.state:{sid}.broadcastOnEnter", "owner": f"{owner.get('type', data.get('ownerType', ''))}:{owner.get('id', data.get('ownerId', ''))}"}
                    index_ref(ctx.index["signals"], state_signal, "declaredAt", signal_loc)
                    index_ref(ctx.index["signals"], state_signal, "emitters", signal_loc)
                    ctx.add_source_map(
                        f"narrative.{_slug(gid)}.state.{_slug(str(sid))}.broadcastOnEnter",
                        runtime_ref=f"narrative:{gid}.state:{sid}.broadcastOnEnter",
                        source=source,
                        kind="signal",
                        runtime_path=f"{comp_path}.states.{sid}.broadcastOnEnter",
                    )
            if isinstance(sdef.get("onEnterActions"), list):
                out["onEnterActions"] = [normalize_action(a) for a in sdef["onEnterActions"]]
                scan_action_refs(sdef["onEnterActions"], ctx, {**ctx.source(path, ("states", sid, "onEnterActions")), "symbol": f"narrative:{gid}.state:{sid}", "path": f"states.{sid}.onEnterActions"})
                for i, raw_action in enumerate(sdef["onEnterActions"]):
                    source = ctx.source(path, ("states", sid, "onEnterActions", i))
                    source_id = ctx.source_id(f"narrative.{_slug(gid)}.state.{_slug(sid)}.onEnterAction", raw_action, source=source, kind="action")
                    ctx.add_source_map(
                        source_id,
                        runtime_ref=f"narrative:{gid}.state:{sid}.onEnterActions[{i}]",
                        source=source,
                        kind="action",
                        runtime_path=f"{comp_path}.states.{sid}.onEnterActions[{i}]",
                    )
            if isinstance(sdef.get("onExitActions"), list):
                out["onExitActions"] = [normalize_action(a) for a in sdef["onExitActions"]]
                scan_action_refs(sdef["onExitActions"], ctx, {**ctx.source(path, ("states", sid, "onExitActions")), "symbol": f"narrative:{gid}.state:{sid}", "path": f"states.{sid}.onExitActions"})
                for i, raw_action in enumerate(sdef["onExitActions"]):
                    source = ctx.source(path, ("states", sid, "onExitActions", i))
                    source_id = ctx.source_id(f"narrative.{_slug(gid)}.state.{_slug(sid)}.onExitAction", raw_action, source=source, kind="action")
                    ctx.add_source_map(
                        source_id,
                        runtime_ref=f"narrative:{gid}.state:{sid}.onExitActions[{i}]",
                        source=source,
                        kind="action",
                        runtime_path=f"{comp_path}.states.{sid}.onExitActions[{i}]",
                    )
            states[str(sid)] = out
            index_ref(ctx.index["narrativeStates"], f"{gid}.{sid}", "declaredAt", {
                "file": _rel(path),
                "symbol": f"narrative:{gid}.state:{sid}",
                "graphId": gid,
                "ownerType": str(owner.get("type", data.get("ownerType", "")) or ""),
                "ownerId": str(owner.get("id", data.get("ownerId", "")) or ""),
            })
        transitions = []
        for ti, t in enumerate(transitions_src):
            if not isinstance(t, dict):
                continue
            tid = str(t.get("id", ""))
            frm = str(t.get("from", ""))
            to = str(t.get("to", ""))
            if frm and frm not in states:
                ctx.error("narrative.transition.from_missing", f"transition {tid} source state missing: {frm}", _rel(path), 1, 1)
            if to and to not in states:
                ctx.error("narrative.transition.to_missing", f"transition {tid} target state missing: {to}", _rel(path), 1, 1)
            out = {"id": tid, "from": frm, "to": to}
            transition_ref = f"narrative:{gid}.transition:{tid or ti}"
            ctx.add_source_map(
                f"narrative.{_slug(gid)}.transition.{_slug(tid or ti)}",
                runtime_ref=transition_ref,
                source=ctx.source(path, ("transitions", ti)),
                kind="narrativeTransition",
                runtime_path=f"{comp_path}.transitions[{ti}]",
            )
            if t.get("signal") is not None:
                out["signal"] = str(t.get("signal"))
                index_ref(ctx.index["signals"], out["signal"], "listeners", {**ctx.source(path, ("transitions", ti, "signal")), "symbol": f"narrative:{gid}.transition:{tid}"})
            if t.get("priority") is not None:
                out["priority"] = t.get("priority")
            if isinstance(t.get("conditions"), list):
                out["conditions"] = normalize_condition(t.get("conditions"))
                source = ctx.source(path, ("transitions", ti, "conditions"))
                scan_condition_refs(out["conditions"], ctx, {**source, "symbol": f"narrative:{gid}.transition:{tid}", "path": f"transitions.{tid}.conditions"})
                source_id = ctx.source_id(f"narrative.{_slug(gid)}.transition.{_slug(tid or ti)}.condition", {"id": _condition_id(t.get("conditions"))}, source=source, kind="condition")
                ctx.add_source_map(
                    source_id,
                    runtime_ref=f"{transition_ref}.conditions",
                    source=source,
                    kind="condition",
                    runtime_path=f"{comp_path}.transitions[{ti}].conditions",
                )
            transitions.append(out)
        graph = {
            "id": gid,
            "ownerType": str(owner.get("type", data.get("ownerType", "")) or ""),
            "ownerId": str(owner.get("id", data.get("ownerId", "")) or ""),
            "initialState": str(data.get("initialState", "")),
            "states": states,
            "transitions": transitions,
        }
        label = display_name(data, "graphLabel", "title", "name")
        if label:
            graph["label"] = label
        graphs.append(graph)
        elements = data.get("elements") if isinstance(data.get("elements"), list) else []
        for element_index, element in enumerate(elements):
            if not isinstance(element, dict):
                continue
            element_symbol = f"narrative:{gid}.element:{element.get('id', element_index)}"
            meta = element.get("meta") if isinstance(element.get("meta"), dict) else {}
            for emit_index, signal in enumerate(meta.get("emits", []) if isinstance(meta.get("emits"), list) else []):
                index_ref(ctx.index["signals"], str(signal), "emitters", {
                    **ctx.source(path, ("elements", element_index, "meta", "emits", emit_index)),
                    "symbol": element_symbol,
                    "path": f"elements[{element_index}].meta.emits[{emit_index}]",
                })
            for read_index, graph_id in enumerate(meta.get("reads", []) if isinstance(meta.get("reads"), list) else []):
                index_ref(ctx.index["narrativeGraphs"], str(graph_id), "readers", {
                    **ctx.source(path, ("elements", element_index, "meta", "reads", read_index)),
                    "symbol": element_symbol,
                    "path": f"elements[{element_index}].meta.reads[{read_index}]",
                })
            if element.get("kind") == "dialogueBlackbox" and element.get("refId") is not None:
                index_ref(ctx.index["dialogueGraphs"], str(element.get("refId")), "readers", {
                    **ctx.source(path, ("elements", element_index, "refId")),
                    "symbol": element_symbol,
                    "path": f"elements[{element_index}].refId",
                })
            if isinstance(element.get("graph"), dict):
                index_embedded_narrative_graph(ctx, path, element["graph"], comp_index, element_index, seen_graph_ids)
        composition: Json = {"id": str(data.get("compositionId", gid)), "mainGraph": graph, "elements": strip_authoring_action_ids(elements)}
        if data.get("label") is not None:
            composition["label"] = str(data.get("label"))
        if data.get("description") is not None:
            composition["description"] = str(data.get("description"))
        compositions.append(composition)
        owner_type = str(owner.get("type", data.get("ownerType", "")) or "")
        owner_id = str(owner.get("id", data.get("ownerId", "")) or "")
        index_ref(ctx.index["narrativeGraphs"], gid, "declaredAt", {
            "file": _rel(path),
            "symbol": f"narrative:{gid}",
            "ownerType": owner_type,
            "ownerId": owner_id,
            "title": label,
        })
    return {"schemaVersion": 3, "compositions": compositions}


def compile_quests(ctx: BuildContext) -> list[Json]:
    base_rows = {r.get("id", ""): r for r in read_csv_rows(AUTHORING / "tables" / "quests.csv", ctx) if r.get("id")}
    for qid, row in base_rows.items():
        source = {"file": row.get("__file"), "line": int(row.get("__line", "1") or 1), "column": 1}
        index_ref(ctx.index["quests"], qid, "declaredAt", {**source, "group": row.get("group"), "title": row.get("title")})
    out: list[Json] = []
    seen_quest_ids: set[str] = set()
    for path in sorted((AUTHORING / "quests").glob("**/*.yaml")):
        data = parse_simple_yaml(path, ctx)
        if not isinstance(data, dict) or not data.get("id"):
            continue
        qid = str(data["id"])
        if qid in seen_quest_ids:
            src = ctx.source(path, ("id",))
            ctx.error("quest.duplicate", f"duplicate quest id: {qid}", src["file"], src["line"], src["column"])
            continue
        seen_quest_ids.add(qid)
        base = base_rows.get(qid, {})
        ctx.add_source_map(
            f"quest.{_slug(qid)}",
            runtime_ref=f"quest:{qid}",
            source=ctx.source(path, ("id",)),
            kind="quest",
            runtime_path=f"quests.{qid}",
        )
        q = {
            "id": qid,
            "group": base.get("group") or data.get("group") or "default",
            "type": base.get("type") or data.get("type") or "side",
            "title": base.get("title") or display_name(data, "title", "name") or qid,
            "description": base.get("description") or data.get("description") or "",
            "preconditions": normalize_condition(data.get("preconditions") or []),
            "completionConditions": normalize_condition(data.get("completionConditions") or []),
            "rewards": [normalize_action(a) for a in data.get("rewards") or []],
            "nextQuests": normalize_next_quests(data.get("nextQuests")),
        }
        if "acceptActions" in data:
            q["acceptActions"] = [normalize_action(a) for a in data.get("acceptActions") or []]
        if base.get("sideType"):
            q["sideType"] = base["sideType"]
        loc = {"file": _rel(path), "symbol": f"quest:{qid}", "title": q["title"]}
        index_ref(ctx.index["quests"], qid, "declaredAt", loc)
        scan_condition_refs(q["preconditions"], ctx, {**loc, **ctx.source(path, ("preconditions",)), "path": "preconditions"})
        scan_condition_refs(q["completionConditions"], ctx, {**loc, **ctx.source(path, ("completionConditions",)), "path": "completionConditions"})
        scan_action_refs(data.get("acceptActions") or [], ctx, {**loc, **ctx.source(path, ("acceptActions",)), "path": "acceptActions"})
        scan_action_refs(data.get("rewards") or [], ctx, {**loc, **ctx.source(path, ("rewards",)), "path": "rewards"})
        for i, edge in enumerate(q.get("nextQuests") or []):
            if isinstance(edge, dict):
                index_ref(ctx.index["quests"], str(edge.get("questId", "")), "readers", {**loc, "path": f"nextQuests[{i}].questId"})
                scan_condition_refs(edge.get("conditions"), ctx, {**loc, **ctx.source(path, ("nextQuests", i, "conditions")), "path": f"nextQuests[{i}].conditions"})
        if data.get("preconditions") is not None:
            source = ctx.source(path, ("preconditions",))
            ctx.add_source_map(
                ctx.source_id(f"quest.{_slug(qid)}.preconditions", {"id": "root"}, source=source, kind="condition"),
                runtime_ref=f"quest:{qid}.preconditions",
                source=source,
                kind="condition",
                runtime_path=f"quests.{qid}.preconditions",
            )
        if data.get("completionConditions") is not None:
            source = ctx.source(path, ("completionConditions",))
            ctx.add_source_map(
                ctx.source_id(f"quest.{_slug(qid)}.completionConditions", {"id": "root"}, source=source, kind="condition"),
                runtime_ref=f"quest:{qid}.completionConditions",
                source=source,
                kind="condition",
                runtime_path=f"quests.{qid}.completionConditions",
            )
        for i, raw_action in enumerate(data.get("acceptActions") or []):
            source = ctx.source(path, ("acceptActions", i))
            ctx.add_source_map(
                ctx.source_id(f"quest.{_slug(qid)}.acceptAction", raw_action, source=source, kind="action"),
                runtime_ref=f"quest:{qid}.acceptActions[{i}]",
                source=source,
                kind="action",
                runtime_path=f"quests.{qid}.acceptActions[{i}]",
            )
        for i, raw_action in enumerate(data.get("rewards") or []):
            source = ctx.source(path, ("rewards", i))
            ctx.add_source_map(
                ctx.source_id(f"quest.{_slug(qid)}.reward", raw_action, source=source, kind="action"),
                runtime_ref=f"quest:{qid}.rewards[{i}]",
                source=source,
                kind="action",
                runtime_path=f"quests.{qid}.rewards[{i}]",
            )
        for i, edge in enumerate(data.get("nextQuests") or []):
            if isinstance(edge, dict) and edge.get("conditions") is not None:
                target = str(edge.get("questId", i))
                source = ctx.source(path, ("nextQuests", i, "conditions"))
                ctx.add_source_map(
                    ctx.source_id(f"quest.{_slug(qid)}.nextQuest.{_slug(target)}.conditions", {"id": _condition_id(edge.get("conditions"))}, source=source, kind="condition"),
                    runtime_ref=f"quest:{qid}.nextQuest:{target}.conditions",
                    source=source,
                    kind="condition",
                    runtime_path=f"quests.{qid}.nextQuests[{i}].conditions",
                )
        out.append(q)
    return out


def normalize_speaker(speaker: Any) -> Json:
    if isinstance(speaker, str):
        kind = "npc" if speaker == "npc" else "player" if speaker == "player" else "literal"
        return {"kind": kind, "name": speaker}
    if isinstance(speaker, dict):
        return speaker
    return {"kind": "literal", "name": "旁白"}


KNOWN_DIALOGUE_NODE_TYPES = frozenset({"line", "choice", "switch", "runActions", "end", "ownerState", "contextState"})


def normalize_switch_cases(raw: Any) -> list[Json]:
    if not isinstance(raw, list):
        return []
    out: list[Json] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        case: Json = {"next": str(item.get("next", ""))}
        if item.get("condition") is not None:
            case["condition"] = normalize_condition(item.get("condition"))
        if item.get("conditions") is not None:
            case["conditions"] = normalize_condition(item.get("conditions"))
        out.append(case)
    return out


def normalize_state_cases(raw: Any) -> list[Json]:
    if not isinstance(raw, list):
        return []
    out: list[Json] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        out.append({"state": str(item.get("state", "")), "next": str(item.get("next", ""))})
    return out


def dialogue_edge_slots(node: Json) -> list[tuple[str, str, int, str]]:
    ntype = str(node.get("type", ""))
    if ntype in {"line", "runActions"}:
        return [("next", str(node.get("next", "")), 0, "next")]
    if ntype == "choice":
        return [
            ("choice", str(opt.get("next", "")), i, str(opt.get("id") or opt.get("text") or i))
            for i, opt in enumerate(node.get("options") or [])
            if isinstance(opt, dict)
        ]
    if ntype == "switch":
        slots = [
            ("switchCase", str(case.get("next", "")), i, f"case[{i}]")
            for i, case in enumerate(node.get("cases") or [])
            if isinstance(case, dict)
        ]
        slots.append(("switchDefault", str(node.get("defaultNext", "")), -1, "default"))
        return slots
    if ntype == "ownerState":
        slots = [
            ("ownerStateCase", str(case.get("next", "")), i, str(case.get("state") or i))
            for i, case in enumerate(node.get("cases") or [])
            if isinstance(case, dict)
        ]
        slots.append(("ownerStateDefault", str(node.get("defaultNext", "")), -1, "default"))
        slots.append(("ownerStateMissing", str(node.get("missingWrapperNext", "")), -2, "missingWrapper"))
        return slots
    if ntype == "contextState":
        slots = [
            ("contextStateCase", str(case.get("next", "")), i, str(case.get("state") or i))
            for i, case in enumerate(node.get("cases") or [])
            if isinstance(case, dict)
        ]
        slots.append(("contextStateDefault", str(node.get("defaultNext", "")), -1, "default"))
        return slots
    return []


def validate_dialogue_topology(ctx: BuildContext, path: Path, gid: str, entry: str, nodes: dict[str, Json]) -> None:
    rel = _rel(path)
    if not nodes:
        ctx.error("dialogue.nodes.empty", f"dialogue graph {gid} has no nodes", rel, 1, 1)
        return
    if not entry:
        ctx.error("dialogue.entry.empty", f"dialogue graph {gid} entry is required", rel, 1, 1)
    elif entry not in nodes:
        src = ctx.source(path, ("entry",))
        ctx.error("dialogue.entry.missing", f"dialogue graph {gid} entry points to missing node: {entry}", src["file"], src["line"], src["column"])

    adjacency: dict[str, list[str]] = {nid: [] for nid in nodes}
    for nid, node in nodes.items():
        ntype = str(node.get("type", ""))
        if ntype not in KNOWN_DIALOGUE_NODE_TYPES:
            continue
        if ntype == "choice" and not node.get("options"):
            src = ctx.source(path, ("nodes", nid, "options"))
            ctx.error("dialogue.choice.empty", f"choice node {gid}.{nid} must have at least one option", src["file"], src["line"], src["column"])
        if ntype == "runActions" and not isinstance(node.get("actions"), list):
            src = ctx.source(path, ("nodes", nid, "actions"))
            ctx.error("dialogue.runActions.actions.invalid", f"runActions node {gid}.{nid} actions must be a list", src["file"], src["line"], src["column"])
        if ntype == "ownerState" and not str(node.get("defaultNext", "")).strip():
            src = ctx.source(path, ("nodes", nid, "defaultNext"))
            ctx.error("dialogue.ownerState.defaultMissing", f"ownerState node {gid}.{nid} requires defaultNext", src["file"], src["line"], src["column"])
        if ntype == "contextState":
            if not str(node.get("graphId", "")).strip():
                src = ctx.source(path, ("nodes", nid, "graphId"))
                ctx.error("dialogue.contextState.graphMissing", f"contextState node {gid}.{nid} requires graphId", src["file"], src["line"], src["column"])
            if not str(node.get("defaultNext", "")).strip():
                src = ctx.source(path, ("nodes", nid, "defaultNext"))
                ctx.error("dialogue.contextState.defaultMissing", f"contextState node {gid}.{nid} requires defaultNext", src["file"], src["line"], src["column"])

        non_empty_targets = 0
        for kind, target, index, label in dialogue_edge_slots(node):
            if not target:
                continue
            non_empty_targets += 1
            edge_key = f"{gid}.{nid}.{kind}.{index}"
            index_ref(ctx.index["dialogueEdges"], edge_key, "declaredAt", {
                "file": rel,
                "symbol": f"dialogue:{gid}.node:{nid}.{kind}:{label}",
                "from": nid,
                "to": target,
                "kind": kind,
            })
            if target not in nodes:
                src_path: tuple[Any, ...] = ("nodes", nid)
                if kind == "next":
                    src_path = ("nodes", nid, "next")
                elif kind == "choice":
                    src_path = ("nodes", nid, "options", index, "next")
                elif kind == "switchCase":
                    src_path = ("nodes", nid, "cases", index, "next")
                elif kind == "switchDefault":
                    src_path = ("nodes", nid, "defaultNext")
                elif kind == "ownerStateCase":
                    src_path = ("nodes", nid, "cases", index, "next")
                elif kind == "ownerStateDefault":
                    src_path = ("nodes", nid, "defaultNext")
                elif kind == "ownerStateMissing":
                    src_path = ("nodes", nid, "missingWrapperNext")
                elif kind == "contextStateCase":
                    src_path = ("nodes", nid, "cases", index, "next")
                elif kind == "contextStateDefault":
                    src_path = ("nodes", nid, "defaultNext")
                src = ctx.source(path, src_path)
                ctx.error("dialogue.edge.targetMissing", f"dialogue edge {gid}.{nid} -> {target} points to a missing node", src["file"], src["line"], src["column"])
            else:
                adjacency[nid].append(target)
        if ntype != "end" and non_empty_targets == 0:
            src = ctx.source(path, ("nodes", nid))
            ctx.warn("dialogue.node.deadEnd", f"non-end dialogue node {gid}.{nid} has no outgoing target", src["file"], src["line"], src["column"])

    if entry in nodes:
        reachable: set[str] = {entry}
        queue = [entry]
        while queue:
            cur = queue.pop(0)
            for nxt in adjacency.get(cur, []):
                if nxt not in reachable:
                    reachable.add(nxt)
                    queue.append(nxt)
        for nid in sorted(set(nodes) - reachable):
            src = ctx.source(path, ("nodes", nid))
            ctx.warn("dialogue.node.unreachable", f"dialogue node {gid}.{nid} is unreachable from entry {entry}", src["file"], src["line"], src["column"])


def compile_dialogues(ctx: BuildContext) -> dict[str, Json]:
    graphs: dict[str, Json] = {}
    seen_dialogue_ids: set[str] = set()
    for path in sorted((AUTHORING / "dialogues").glob("**/*.yaml")):
        data = parse_simple_yaml(path, ctx)
        if not isinstance(data, dict) or not data.get("id"):
            continue
        gid = str(data["id"])
        if gid in seen_dialogue_ids:
            src = ctx.source(path, ("id",))
            ctx.error("dialogue.duplicate", f"duplicate dialogue graph id: {gid}", src["file"], src["line"], src["column"])
            continue
        seen_dialogue_ids.add(gid)
        ctx.add_source_map(
            f"dialogue.{_slug(gid)}",
            runtime_ref=f"dialogue:{gid}",
            source=ctx.source(path, ("id",)),
            kind="dialogueGraph",
            runtime_path=f"dialogues/graphs/{gid}.json",
        )
        nodes = data.get("nodes") if isinstance(data.get("nodes"), dict) else {}
        out_nodes: Json = {}
        for nid, node in nodes.items():
            node = node if isinstance(node, dict) else {}
            explicit_type = node.get("type")
            ntype = str(explicit_type or ("end" if node.get("end") else "line"))
            node_ref = f"dialogue:{gid}.node:{nid}"
            ctx.add_source_map(
                f"dialogue.{_slug(gid)}.node.{_slug(nid)}",
                runtime_ref=node_ref,
                source=ctx.source(path, ("nodes", nid)),
                kind="dialogueNode",
                runtime_path=f"dialogues/graphs/{gid}.json.nodes.{nid}",
            )
            index_ref(ctx.index["dialogueNodes"], f"{gid}.{nid}", "declaredAt", {
                "file": _rel(path),
                "symbol": node_ref,
                "graphId": gid,
                "nodeId": str(nid),
                "nodeType": ntype,
            })
            if ntype == "runActions":
                out_nodes[nid] = {"type": "runActions", "actions": [normalize_action(a) for a in node.get("actions") or []], "next": str(node.get("next", ""))}
                scan_action_refs(node.get("actions") or [], ctx, {**ctx.source(path, ("nodes", nid, "actions")), "symbol": f"dialogue:{gid}.node:{nid}", "path": f"nodes.{nid}.actions"})
                for i, raw_action in enumerate(node.get("actions") or []):
                    source = ctx.source(path, ("nodes", nid, "actions", i))
                    ctx.add_source_map(
                        ctx.source_id(f"dialogue.{_slug(gid)}.node.{_slug(nid)}.action", raw_action, source=source, kind="action"),
                        runtime_ref=f"{node_ref}.actions[{i}]",
                        source=source,
                        kind="action",
                        runtime_path=f"dialogues/graphs/{gid}.json.nodes.{nid}.actions[{i}]",
                    )
            elif ntype == "choice":
                out_nodes[nid] = {"type": "choice", "options": node.get("options") or []}
                if node.get("promptLine"):
                    out_nodes[nid]["promptLine"] = node["promptLine"]
                for oi, opt in enumerate(node.get("options") or []):
                    if isinstance(opt, dict) and opt.get("requireCondition"):
                        source = ctx.source(path, ("nodes", nid, "options", oi, "requireCondition"))
                        scan_condition_refs(opt["requireCondition"], ctx, {**source, "symbol": f"dialogue:{gid}.node:{nid}.option:{opt.get('id','')}"})
                        condition_source_id = ctx.source_id(f"dialogue.{_slug(gid)}.node.{_slug(nid)}.option.{_slug(opt.get('id', oi))}.requireCondition", opt.get("requireCondition"), source=source, kind="condition")
                        ctx.add_source_map(
                            condition_source_id,
                            runtime_ref=f"{node_ref}.option:{opt.get('id', oi)}.requireCondition",
                            source=source,
                            kind="condition",
                            runtime_path=f"dialogues/graphs/{gid}.json.nodes.{nid}.options[{oi}].requireCondition",
                        )
                        index_ref(ctx.index["conditions"], condition_source_id, "declaredAt", {**source, "symbol": f"{node_ref}.option:{opt.get('id', oi)}.requireCondition"})
            elif ntype == "switch":
                out_nodes[nid] = {"type": "switch", "cases": normalize_switch_cases(node.get("cases")), "defaultNext": str(node.get("defaultNext", ""))}
                for ci, case in enumerate(node.get("cases") or []):
                    if isinstance(case, dict):
                        source = ctx.source(path, ("nodes", nid, "cases", ci, "condition"))
                        scan_condition_refs(case.get("condition") or case.get("conditions"), ctx, {**source, "symbol": f"dialogue:{gid}.node:{nid}.switch"})
                        condition_source_id = ctx.source_id(f"dialogue.{_slug(gid)}.node.{_slug(nid)}.case", case, source=source, kind="condition")
                        ctx.add_source_map(
                            condition_source_id,
                            runtime_ref=f"{node_ref}.case[{ci}].condition",
                            source=source,
                            kind="condition",
                            runtime_path=f"dialogues/graphs/{gid}.json.nodes.{nid}.cases[{ci}].condition",
                        )
                        index_ref(ctx.index["conditions"], condition_source_id, "declaredAt", {**source, "symbol": f"{node_ref}.case[{ci}].condition"})
            elif ntype == "ownerState":
                on: Json = {"type": "ownerState", "cases": normalize_state_cases(node.get("cases"))}
                if node.get("wrapperGraphId") is not None:
                    on["wrapperGraphId"] = str(node.get("wrapperGraphId"))
                    index_ref(ctx.index["narrativeGraphs"], str(node.get("wrapperGraphId")), "readers", {"file": _rel(path), "symbol": node_ref, "path": f"nodes.{nid}.wrapperGraphId"})
                if node.get("defaultNext") is not None:
                    on["defaultNext"] = str(node.get("defaultNext"))
                if node.get("missingWrapperNext") is not None:
                    on["missingWrapperNext"] = str(node.get("missingWrapperNext"))
                out_nodes[nid] = on
            elif ntype == "contextState":
                graph_id = str(node.get("graphId", ""))
                on = {"type": "contextState", "graphId": graph_id, "cases": normalize_state_cases(node.get("cases")), "defaultNext": str(node.get("defaultNext", ""))}
                out_nodes[nid] = on
                index_ref(ctx.index["narrativeGraphs"], graph_id, "readers", {"file": _rel(path), "symbol": node_ref, "path": f"nodes.{nid}.graphId"})
                for ci, case in enumerate(on["cases"]):
                    state_id = str(case.get("state", ""))
                    if graph_id and state_id:
                        index_ref(ctx.index["narrativeStates"], f"{graph_id}.{state_id}", "readers", {"file": _rel(path), "symbol": f"{node_ref}.case[{ci}]", "path": f"nodes.{nid}.cases[{ci}].state"})
            elif ntype == "end":
                out_nodes[nid] = {"type": "end"}
            elif ntype == "line":
                speaker = normalize_speaker(node.get("speaker"))
                line_out: Json = {"type": "line", "speaker": speaker, "next": str(node.get("next", ""))}
                raw_lines = node.get("lines")
                if isinstance(raw_lines, list) and raw_lines:
                    beats: list[Json] = []
                    first_text = ""
                    for ln in raw_lines:
                        if not isinstance(ln, dict):
                            continue
                        text = str(ln.get("text", ""))
                        beats.append({"speaker": normalize_speaker(ln.get("speaker")), "text": text})
                        if not first_text:
                            first_text = text
                    line_out["lines"] = beats
                    line_out["text"] = str(node.get("text", first_text))
                else:
                    line_out["text"] = str(node.get("text", ""))
                out_nodes[nid] = line_out
            else:
                # Unknown explicit node type: do NOT silently downgrade to a line.
                src = ctx.source(path, ("nodes", nid))
                ctx.error(
                    "dialogue.node.unknownType",
                    f"unknown dialogue node type '{ntype}' in graph {gid} node {nid}; emitted as passthrough",
                    src["file"], src["line"], src["column"],
                    "Add an emitter for this node type, or use a supported type (line/choice/switch/runActions/ownerState/end).",
                )
                out_nodes[nid] = {k: v for k, v in node.items() if k != "id"}
        graph = {"schemaVersion": 1, "id": gid, "entry": str(data.get("entry", "start")), "nodes": out_nodes}
        meta = dict(data["meta"]) if isinstance(data.get("meta"), dict) else {}
        title = display_name(data, "title", "name")
        if title and not meta.get("title"):
            meta["title"] = title
        if meta:
            graph["meta"] = meta
        if "preconditions" in data:
            graph["preconditions"] = normalize_condition(data.get("preconditions"))
        if data.get("preconditions"):
            scan_condition_refs(graph["preconditions"], ctx, {**ctx.source(path, ("preconditions",)), "symbol": f"dialogue:{gid}", "path": "preconditions"})
        validate_dialogue_topology(ctx, path, gid, str(graph["entry"]), out_nodes)
        graphs[gid] = graph
        index_ref(ctx.index["dialogueGraphs"], gid, "declaredAt", {"file": _rel(path), "symbol": f"dialogue:{gid}", "title": meta.get("title", "")})
    return graphs


def render_narrative_mermaid(narrative: Json) -> dict[str, str]:
    rendered: dict[str, str] = {}
    for comp in narrative.get("compositions", []):
        g = comp.get("mainGraph") or {}
        gid = g.get("id", "graph")
        lines = ["stateDiagram-v2", f"  [*] --> {g.get('initialState','')}"]
        for t in g.get("transitions", []):
            label = t.get("signal") or t.get("trigger") or t.get("id")
            cond = t.get("conditions")
            if cond:
                label = f"{label} [cond]"
            lines.append(f"  {t.get('from','')} --> {t.get('to','')}: {label}")
        rendered[str(gid)] = "\n".join(lines) + "\n"
    return rendered


def first_index_location(rec: Json, *roles: str) -> Json:
    for role in roles:
        values = rec.get(role)
        if isinstance(values, list):
            for item in values:
                if isinstance(item, dict) and item.get("file"):
                    return item
    return {}


def warn_from_index(ctx: BuildContext, rec: Json, roles: tuple[str, ...], code: str, message: str) -> None:
    loc = first_index_location(rec, *roles)
    ctx.warn(
        code,
        message,
        str(loc.get("file", "") or ""),
        int(loc.get("line", 0) or 0),
        int(loc.get("column", 0) or 0),
    )


def validate_refs(ctx: BuildContext) -> None:
    for key, rec in ctx.index.get("flags", {}).items():
        if not rec.get("declaredAt"):
            warn_from_index(ctx, rec, ("readers", "writers"), "flag.undeclared", f"flag used but not declared: {key}")
        if rec.get("readers") and not rec.get("writers"):
            warn_from_index(ctx, rec, ("readers",), "flag.no_writer", f"flag has readers but no writer: {key}")
        if rec.get("writers") and not rec.get("readers"):
            warn_from_index(ctx, rec, ("writers",), "flag.no_reader", f"flag is written but never read: {key}")
    for key, rec in ctx.index.get("signals", {}).items():
        if not rec.get("declaredAt"):
            warn_from_index(ctx, rec, ("emitters", "listeners"), "signal.undeclared", f"signal used but not declared: {key}")
        if rec.get("emitters") and not rec.get("listeners"):
            warn_from_index(ctx, rec, ("emitters",), "signal.no_listener", f"signal has emitters but no listeners: {key}")
        if rec.get("listeners") and not rec.get("emitters"):
            warn_from_index(ctx, rec, ("listeners",), "signal.no_emitter", f"signal has listeners but no emitters: {key}")
    for key, rec in ctx.index.get("quests", {}).items():
        if (rec.get("readers") or rec.get("writers")) and not rec.get("declaredAt"):
            warn_from_index(ctx, rec, ("readers", "writers"), "quest.undeclared", f"quest referenced but not declared: {key}")
    for key, rec in ctx.index.get("narrativeGraphs", {}).items():
        if rec.get("readers") and not rec.get("declaredAt"):
            warn_from_index(ctx, rec, ("readers",), "narrativeGraph.undeclared", f"narrative graph referenced but not declared: {key}")
    for key, rec in ctx.index.get("narrativeStates", {}).items():
        if rec.get("readers") and not rec.get("declaredAt"):
            warn_from_index(ctx, rec, ("readers",), "narrativeState.undeclared", f"narrative state referenced but not declared: {key}")
    for key, rec in ctx.index.get("dialogueGraphs", {}).items():
        if rec.get("readers") and not rec.get("declaredAt"):
            warn_from_index(ctx, rec, ("readers",), "dialogueGraph.undeclared", f"dialogue graph referenced but not declared: {key}")
    for key, rec in ctx.index.get("sceneRefs", {}).items():
        if rec.get("readers") and not rec.get("declaredAt"):
            warn_from_index(ctx, rec, ("readers",), "scene.undeclared", f"scene referenced but not found: {key}")


def validate_duplicate_runtime_ids(ctx: BuildContext) -> None:
    """Detect duplicate runtime IDs that would collide across pipeline and legacy content."""
    # Narrative graph IDs vs dialogue graph IDs can collide in runtime lookups.
    narrative_ids = set(ctx.index.get("narrativeGraphs", {}).keys())
    dialogue_ids = set(ctx.index.get("dialogueGraphs", {}).keys())
    for gid in narrative_ids & dialogue_ids:
        ng_rec = ctx.index["narrativeGraphs"][gid]
        dg_rec = ctx.index["dialogueGraphs"][gid]
        ng_loc = first_index_location(ng_rec, "declaredAt")
        dg_loc = first_index_location(dg_rec, "declaredAt")
        ctx.warn(
            "runtime.id.collision",
            f"id {gid!r} is used by both a narrative graph and a dialogue graph; they may collide at runtime",
            str(dg_loc.get("file", "") or ng_loc.get("file", "") or ""),
            int(dg_loc.get("line", 0) or ng_loc.get("line", 0) or 0),
        )

    # Flag keys vs signal keys collision warning (both referenced by string at runtime)
    flag_ids = set(ctx.index.get("flags", {}).keys())
    signal_ids = set(ctx.index.get("signals", {}).keys())
    for kid in flag_ids & signal_ids:
        flag_rec = ctx.index["flags"][kid]
        sig_rec = ctx.index["signals"][kid]
        flag_loc = first_index_location(flag_rec, "declaredAt")
        sig_loc = first_index_location(sig_rec, "declaredAt")
        ctx.warn(
            "runtime.id.flagSignalCollision",
            f"id {kid!r} is declared as both a flag and a signal",
            str(flag_loc.get("file", "") or sig_loc.get("file", "") or ""),
            int(flag_loc.get("line", 0) or sig_loc.get("line", 0) or 0),
        )


def _owner_key(item: Json) -> tuple[str, str]:
    return (str(item.get("ownerType", "") or ""), str(item.get("ownerId", "") or ""))


def validate_cross_owner_risks(ctx: BuildContext) -> None:
    """Warn when setNarrativeState writes to a state owned by a different entity."""
    ng_index = ctx.index.get("narrativeGraphs", {})
    ns_index = ctx.index.get("narrativeStates", {})

    graph_owners: dict[str, tuple[str, str]] = {}
    for gid, rec in ng_index.items():
        for item in rec.get("declaredAt") or []:
            if isinstance(item, dict) and (item.get("ownerType") or item.get("ownerId")):
                graph_owners[str(gid)] = _owner_key(item)
                break

    for state_key, rec in ns_index.items():
        writers = rec.get("writers")
        if not isinstance(writers, list) or not writers:
            continue
        decl_items = rec.get("declaredAt") or []
        if not decl_items:
            continue
        target_owner = _owner_key(decl_items[0] if isinstance(decl_items[0], dict) else {})
        if not any(target_owner):
            graph_id = str((decl_items[0] if isinstance(decl_items[0], dict) else {}).get("graphId", ""))
            target_owner = graph_owners.get(graph_id, ("", ""))
        if not any(target_owner):
            continue
        for writer in writers:
            if not isinstance(writer, dict):
                continue
            symbol = str(writer.get("symbol", ""))
            writer_graph = symbol.split(".")[0].split(":")[-1] if symbol else ""
            if not writer_graph:
                continue
            for owned_gid, owner in graph_owners.items():
                if owned_gid == writer_graph:
                    if owner != target_owner and any(owner) and any(target_owner):
                        ctx.warn(
                            "ownership.crossOwnerWrite",
                            f"setNarrativeState writes to {state_key} (owner {target_owner[0]}:{target_owner[1]}) "
                            f"from graph {writer_graph} (owner {owner[0]}:{owner[1]})",
                            str(writer.get("file", "") or ""),
                            int(writer.get("line", 0) or 0),
                            int(writer.get("column", 0) or 0),
                        )
                    break


def load_json_file(path: str | None) -> Any:
    if not path:
        return {}
    p = Path(path)
    if not p.is_absolute():
        p = ROOT / p
    return json.loads(p.read_text(encoding="utf-8-sig"))


def state_file_for_runner(case_path: str | None) -> Path:
    if case_path:
        p = Path(case_path)
        return p if p.is_absolute() else ROOT / p
    p = ARTIFACT / "empty_state.json"
    write_json(p, {"flags": {}, "quests": {}, "scenarios": {}, "scenarioLines": {}, "narrative": {}, "literals": {}})
    return p


def run_explain_runtime(case_path: str | None = None, *, echo: bool = True) -> Json:
    state_path = state_file_for_runner(case_path)
    out_path = ARTIFACT / "condition_explain.json"
    tsx = ROOT / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
    cmd = [
        str(tsx),
        "tools/content_pipeline/explain_runtime.ts",
        str(ARTIFACT / "runtime_preview"),
        str(state_path),
        str(ARTIFACT / "source_map.json"),
        str(out_path),
    ]
    proc = subprocess.run(cmd, cwd=ROOT, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if echo and proc.stdout.strip():
        print(proc.stdout, end="" if proc.stdout.endswith("\n") else "\n")
    if proc.returncode != 0:
        if proc.stderr.strip():
            print(proc.stderr, file=sys.stderr)
        raise RuntimeError(f"runtime explain failed with exit code {proc.returncode}")
    return load_json_file(str(out_path))


def run_simulate_runtime(case_path: str | None = None, *, echo: bool = True) -> Json:
    state_path = state_file_for_runner(case_path)
    out_path = ARTIFACT / "simulation_result.json"
    tsx = ROOT / "node_modules" / ".bin" / ("tsx.cmd" if sys.platform == "win32" else "tsx")
    cmd = [
        str(tsx),
        "tools/content_pipeline/simulate_runtime.ts",
        str(ARTIFACT / "runtime_preview"),
        str(state_path),
        str(ARTIFACT / "source_map.json"),
        str(out_path),
    ]
    proc = subprocess.run(cmd, cwd=ROOT, text=True, encoding="utf-8", errors="replace", capture_output=True)
    if echo and proc.stdout.strip():
        print(proc.stdout, end="" if proc.stdout.endswith("\n") else "\n")
    if proc.returncode != 0:
        if proc.stderr.strip():
            print(proc.stderr, file=sys.stderr)
        raise RuntimeError(f"runtime simulate failed with exit code {proc.returncode}")
    return load_json_file(str(out_path))


def explain(case_path: str | None = None) -> int:
    ctx, _ = build_all()
    try:
        out = run_explain_runtime(case_path)
    except RuntimeError:
        return 1
    out["ok"] = out.get("ok") is True and not any(d.severity == "error" for d in ctx.diagnostics)
    out["diagnostics"] = [d.to_dict() for d in ctx.diagnostics]
    write_json(ARTIFACT / "condition_explain.json", out)
    return 1 if any(d.severity == "error" for d in ctx.diagnostics) else 0


def resolve_trace_ref(event: Json, source_map: Json) -> str | None:
    payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
    runtime_ref = payload.get("runtimeRef")
    if isinstance(runtime_ref, str) and runtime_ref:
        return runtime_ref
    typ = event.get("type")
    phase = event.get("phase")
    if typ == "dialogue":
        graph_id = payload.get("graphId")
        node_id = payload.get("nodeId") or payload.get("currentNodeId")
        if graph_id and node_id:
            return f"dialogue:{graph_id}.node:{node_id}"
        if graph_id:
            return f"dialogue:{graph_id}"
    if typ == "narrative" and payload.get("graphId"):
        graph_id = payload.get("graphId")
        to_state = payload.get("to")
        if phase == "change" and to_state:
            return f"narrative:{graph_id}.state:{to_state}"
        return f"narrative:{graph_id}"
    if typ == "quest" and payload.get("questId"):
        return f"quest:{payload['questId']}"
    return None


def trace_resolve(path: str) -> int:
    ctx, _ = build_all()
    trace = load_json_file(path)
    events = trace.get("events") if isinstance(trace, dict) else trace
    if not isinstance(events, list):
        print("trace file must be an event array or {\"events\": [...]}", file=sys.stderr)
        return 2
    resolved = []
    for event in events:
        if not isinstance(event, dict):
            continue
        ref = resolve_trace_ref(event, ctx.source_map)
        source_id = ctx.source_map.get("runtimeToSource", {}).get(ref or "")
        source = ctx.source_map.get("sources", {}).get(source_id or "")
        resolved.append({**event, "runtimeRef": ref, "sourceId": source_id, "source": source})
    out = {"events": resolved}
    write_json(ARTIFACT / "runtime_trace/resolved_trace.json", out)
    for item in resolved:
        src = item.get("source") or {}
        where = f"{src.get('file')}:{src.get('line')}:{src.get('column')}" if src else "<unmapped>"
        print(f"#{item.get('id', '?')} [{item.get('type')}:{item.get('phase', '')}] {item.get('label', '')} -> {where}")
    return 1 if any(d.severity == "error" for d in ctx.diagnostics) else 0


def _lsp_frame(payload: Json) -> bytes:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return f"Content-Length: {len(data)}\r\n\r\n".encode("ascii") + data


def _read_lsp_response(stream: Any) -> Json:
    headers: dict[str, str] = {}
    while True:
        line = stream.readline()
        if not line:
            raise RuntimeError("LSP server closed stdout")
        if line in (b"\r\n", b"\n"):
            break
        text = line.decode("ascii", errors="replace").strip()
        if ":" in text:
            key, value = text.split(":", 1)
            headers[key.lower()] = value.strip()
    length = int(headers.get("content-length", "0") or "0")
    if length <= 0:
        raise RuntimeError("LSP response missing Content-Length")
    return json.loads(stream.read(length).decode("utf-8"))


def lsp_smoke() -> int:
    proc = subprocess.Popen(
        [sys.executable, "-m", "tools.content_pipeline.lsp_server"],
        cwd=ROOT,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    assert proc.stdin is not None and proc.stdout is not None
    try:
        init = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "processId": None,
                "rootUri": ROOT.as_uri(),
                "capabilities": {},
            },
        }
        proc.stdin.write(_lsp_frame(init))
        proc.stdin.flush()
        response = _read_lsp_response(proc.stdout)
        capabilities = response.get("result", {}).get("capabilities", {})
        required = (
            "textDocumentSync",
            "completionProvider",
            "hoverProvider",
            "definitionProvider",
            "referencesProvider",
            "renameProvider",
            "codeActionProvider",
            "documentSymbolProvider",
            "workspaceSymbolProvider",
            "semanticTokensProvider",
        )
        missing = [key for key in required if key not in capabilities]
        if missing:
            print(f"LSP smoke failed: missing capabilities {missing}", file=sys.stderr)
            return 1
        proc.stdin.write(_lsp_frame({"jsonrpc": "2.0", "id": 2, "method": "shutdown", "params": {}}))
        proc.stdin.write(_lsp_frame({"jsonrpc": "2.0", "method": "exit", "params": {}}))
        proc.stdin.flush()
        try:
            _read_lsp_response(proc.stdout)
        except Exception:
            pass
        print("LSP smoke OK")
        return 0
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.wait(timeout=5)


# Artifact categories a command may choose to emit.
#   preview    -> compiled runtime JSON (to preview path, or real path when published)
#   render     -> mermaid graph renders
#   index      -> content_index.json
#   sourcemap  -> source_map.json / runtime_debug_map.json
#   report     -> content_report.md / diagnostics.json
EMIT_ALL = frozenset({"preview", "render", "index", "sourcemap", "report"})


def build_all(*, publish: bool = False, emit: frozenset[str] | set[str] | None = None, document_overrides: dict[str, str] | None = None) -> tuple[BuildContext, dict[str, Any]]:
    selected = EMIT_ALL if emit is None else frozenset(emit)
    ctx = BuildContext(document_overrides=document_overrides or {})
    cfg = load_project_config(ctx)
    load_signals(ctx)
    load_scene_refs(ctx)
    flags = compile_flags(ctx)
    narrative = compile_narrative(ctx)
    quests = compile_quests(ctx)
    dialogues = compile_dialogues(ctx)
    validate_refs(ctx)
    validate_duplicate_runtime_ids(ctx)
    validate_cross_owner_risks(ctx)
    validate_mixed_ownership(ctx, cfg)

    published: list[str] = []
    if "preview" in selected:
        for key, payload in (("flagRegistry", flags), ("narrativeGraphs", narrative), ("quests", quests)):
            target, did_publish = resolve_output_target(cfg, key, publish)
            write_json(target, payload)
            if did_publish:
                published.append(_rel(target))
        dialogue_dir, dlg_published = resolve_output_target(cfg, "dialogueGraphs", publish)
        dialogue_dir.mkdir(parents=True, exist_ok=True)
        for gid, graph in dialogues.items():
            write_json(dialogue_dir / f"{gid}.json", graph)
            if dlg_published:
                published.append(_rel(dialogue_dir / f"{gid}.json"))

    if "render" in selected:
        for gid, text in render_narrative_mermaid(narrative).items():
            write_text(ARTIFACT / "rendered_graphs/narrative" / f"{gid}.mmd", text)

    if "index" in selected:
        write_json(ARTIFACT / "content_index.json", ctx.index)

    if "sourcemap" in selected:
        write_json(ARTIFACT / "source_map.json", ctx.source_map)
        write_json(ARTIFACT / "runtime_debug_map.json", ctx.source_map)

    if "report" in selected:
        report = ["# Content Pipeline Report", "", f"Diagnostics: {len(ctx.diagnostics)}", ""]
        for d in ctx.diagnostics:
            report.append(f"- **{d.severity}** `{d.code}` {d.message}")
        write_text(ARTIFACT / "content_report.md", "\n".join(report) + "\n")
        write_json(ARTIFACT / "diagnostics.json", [d.to_dict() for d in ctx.diagnostics])

    generated_paths = collect_generated_output_paths(cfg)

    if "index" in selected:
        ownership_manifest: Json = {
            "authoringRoot": _rel(AUTHORING),
            "previewRoot": _rel(ARTIFACT / "runtime_preview"),
            "generatedPaths": sorted(generated_paths),
            "ownership": cfg["ownership"],
            "graphViewReadonly": True,
            "editViaAuthoring": _rel(AUTHORING),
        }
        write_json(ARTIFACT / "ownership_manifest.json", ownership_manifest)

    return ctx, {
        "flags": flags,
        "narrative": narrative,
        "quests": quests,
        "dialogues": dialogues,
        "published": published,
        "config": cfg,
        "generatedPaths": sorted(generated_paths),
    }


def runtime_compatibility_issues(data: dict[str, Any]) -> list[Json]:
    issues: list[Json] = []

    def add(code: str, message: str, runtime_ref: str = "") -> None:
        issues.append({"severity": "error", "code": code, "message": message, "runtimeRef": runtime_ref})

    flags_obj = data.get("flags", {})
    schema_ver = flags_obj.get("schemaVersion") if isinstance(flags_obj, dict) else None
    # flag registry has no schemaVersion field currently; skip version check
    flags = flags_obj.get("static", []) if isinstance(flags_obj, dict) else []
    seen_flags: set[str] = set()
    for item in flags if isinstance(flags, list) else []:
        if not isinstance(item, dict):
            add("runtime.flag.invalid", "flag registry static entry must be an object")
            continue
        key = str(item.get("key", ""))
        if not key:
            add("runtime.flag.keyMissing", "flag registry entry is missing key")
        elif key in seen_flags:
            add("runtime.flag.duplicate", f"duplicate runtime flag id: {key}", f"flag:{key}")
        seen_flags.add(key)
        vtype = str(item.get("valueType", "bool") or "bool")
        if vtype not in KNOWN_FLAG_VALUE_TYPES:
            add("runtime.flag.valueType", f"flag {key!r} has unknown valueType {vtype!r}; expected one of {sorted(KNOWN_FLAG_VALUE_TYPES)}", f"flag:{key}")

    quests = data.get("quests", [])
    seen_quests: set[str] = set()
    for quest in quests if isinstance(quests, list) else []:
        if not isinstance(quest, dict):
            add("runtime.quest.invalid", "quest runtime entry must be an object")
            continue
        qid = str(quest.get("id", ""))
        if not qid:
            add("runtime.quest.idMissing", "quest runtime entry is missing id")
        elif qid in seen_quests:
            add("runtime.quest.duplicate", f"duplicate runtime quest id: {qid}", f"quest:{qid}")
        seen_quests.add(qid)
        qtype = str(quest.get("type", "") or "")
        if qtype and qtype not in KNOWN_QUEST_TYPES:
            add("runtime.quest.type", f"quest {qid!r} has unknown type {qtype!r}; expected one of {sorted(KNOWN_QUEST_TYPES)}", f"quest:{qid}")

    narrative = data.get("narrative", {})
    if isinstance(narrative, dict):
        nav_ver = narrative.get("schemaVersion")
        if nav_ver is not None and nav_ver != 3:
            add("runtime.narrative.schemaVersion", f"narrative_graphs.json schemaVersion is {nav_ver!r}; runtime expects 3")
    graph_ids: set[str] = set()
    def check_narrative_graph(graph: Any, label: str) -> None:
        if not isinstance(graph, dict):
            add("runtime.narrative.mainGraphMissing", f"{label} is missing a graph object")
            return
        gid = str(graph.get("id", ""))
        if not gid:
            add("runtime.narrative.graphIdMissing", f"{label} is missing id")
            return
        if gid in graph_ids:
            add("runtime.narrative.graphDuplicate", f"duplicate runtime narrative graph id: {gid}", f"narrative:{gid}")
        graph_ids.add(gid)
        if not graph.get("ownerType") and not graph.get("ownerId"):
            issues.append({"severity": "warning", "code": "runtime.narrative.ownerMissing",
                           "message": f"narrative graph {gid} has no ownerType/ownerId; ownership cannot be resolved",
                           "runtimeRef": f"narrative:{gid}"})
        states = graph.get("states")
        if not isinstance(states, dict) or not states:
            add("runtime.narrative.statesMissing", f"narrative graph {gid} has no states", f"narrative:{gid}")
            return
        initial = str(graph.get("initialState", ""))
        if initial not in states:
            add("runtime.narrative.initialMissing", f"narrative graph {gid} initialState {initial!r} is not in states", f"narrative:{gid}")
        transition_ids: set[str] = set()
        for transition in graph.get("transitions", []) if isinstance(graph.get("transitions", []), list) else []:
            if not isinstance(transition, dict):
                add("runtime.narrative.transitionInvalid", f"narrative graph {gid} has a non-object transition", f"narrative:{gid}")
                continue
            tid = str(transition.get("id", ""))
            if not tid:
                add("runtime.narrative.transitionIdMissing", f"narrative graph {gid} has a transition without id", f"narrative:{gid}")
            elif tid in transition_ids:
                add("runtime.narrative.transitionDuplicate", f"duplicate transition id {gid}.{tid}", f"narrative:{gid}.transition:{tid}")
            transition_ids.add(tid)
            for field in ("from", "to"):
                sid = transition.get(field)
                if not isinstance(sid, str) or sid not in states:
                    add("runtime.narrative.transitionEndpointMissing", f"{gid}.{tid} {field} state {sid!r} does not exist", f"narrative:{gid}.transition:{tid}")

    for comp_index, comp in enumerate(narrative.get("compositions", []) if isinstance(narrative, dict) else []):
        if not isinstance(comp, dict):
            add("runtime.narrative.compositionInvalid", f"composition {comp_index} must be an object")
            continue
        check_narrative_graph(comp.get("mainGraph"), f"composition {comp_index} mainGraph")
        for element_index, element in enumerate(comp.get("elements", []) if isinstance(comp.get("elements"), list) else []):
            if isinstance(element, dict) and isinstance(element.get("graph"), dict):
                check_narrative_graph(element["graph"], f"composition {comp_index} element {element_index} graph")

    dialogues = data.get("dialogues", {})
    dialogue_ids: set[str] = set()
    for gid, graph in (dialogues.items() if isinstance(dialogues, dict) else []):
        if not isinstance(graph, dict):
            add("runtime.dialogue.invalid", f"dialogue {gid} runtime entry must be an object", f"dialogue:{gid}")
            continue
        graph_id = str(graph.get("id", gid))
        if graph_id in dialogue_ids:
            add("runtime.dialogue.duplicate", f"duplicate runtime dialogue graph id: {graph_id}", f"dialogue:{graph_id}")
        dialogue_ids.add(graph_id)
        dlg_ver = graph.get("schemaVersion")
        if dlg_ver is not None and dlg_ver != 1:
            add("runtime.dialogue.schemaVersion", f"dialogue {graph_id} schemaVersion is {dlg_ver!r}; runtime expects 1", f"dialogue:{graph_id}")
        nodes = graph.get("nodes")
        if not isinstance(nodes, dict) or not nodes:
            add("runtime.dialogue.nodesMissing", f"dialogue graph {graph_id} has no nodes", f"dialogue:{graph_id}")
            continue
        entry = str(graph.get("entry", ""))
        if entry not in nodes:
            add("runtime.dialogue.entryMissing", f"dialogue graph {graph_id} entry {entry!r} is not in nodes", f"dialogue:{graph_id}")

    return issues


def runtime_compatibility() -> int:
    ctx, data = build_all()
    issues = runtime_compatibility_issues(data)
    payload = {
        "ok": not issues and not any(d.severity == "error" for d in ctx.diagnostics),
        "issues": issues,
        "diagnostics": [d.to_dict() for d in ctx.diagnostics if d.severity == "error"],
    }
    write_json(ARTIFACT / "runtime_compatibility.json", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 1 if not payload["ok"] else 0


def simulate(path: str | None = None) -> int:
    ctx, data = build_all()
    try:
        simulation_result = run_simulate_runtime(path, echo=False)
    except RuntimeError:
        simulation_result = {"ok": False, "events": [], "route": [], "blocked": [{"reason": "runtimeSimulatorFailed"}], "conditions": []}
    result = {
        **simulation_result,
        "ok": simulation_result.get("ok") is True and not any(d.severity == "error" for d in ctx.diagnostics),
        "diagnostics": [d.to_dict() for d in ctx.diagnostics],
        "summary": {
            "narrativeGraphs": len(data["narrative"].get("compositions", [])),
            "quests": len(data["quests"]),
            "dialogues": len(data["dialogues"]),
        },
    }
    write_json(ARTIFACT / "simulation_result.json", result)
    write_text(ARTIFACT / "simulation_report.md", format_simulation_report(result))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if any(d.severity == "error" for d in ctx.diagnostics) else 0


def format_simulation_report(result: Json) -> str:
    lines = ["# Content Simulation Report", ""]
    lines.append(f"OK: {bool(result.get('ok'))}")
    summary = result.get("summary") if isinstance(result.get("summary"), dict) else {}
    if summary:
        lines.extend([
            "",
            "## Summary",
            "",
            f"- Narrative graphs: {summary.get('narrativeGraphs', 0)}",
            f"- Quests: {summary.get('quests', 0)}",
            f"- Dialogues: {summary.get('dialogues', 0)}",
        ])
    route = result.get("route") if isinstance(result.get("route"), list) else []
    if route:
        lines.extend(["", "## Dialogue Route", ""])
        for step in route:
            if not isinstance(step, dict):
                continue
            choice = step.get("choice") if isinstance(step.get("choice"), dict) else {}
            choice_text = f" choice={choice.get('id') or choice.get('text')}" if choice else ""
            lines.append(f"- {step.get('step')}: {step.get('graphId')}.{step.get('nodeId')} `{step.get('type')}`{choice_text}")
    events = result.get("events") if isinstance(result.get("events"), list) else []
    if events:
        lines.extend(["", "## Events", ""])
        for event in events:
            if not isinstance(event, dict):
                continue
            payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
            diff = payload.get("diff") if isinstance(payload.get("diff"), dict) else {}
            suffix = f" diff={','.join(sorted(diff.keys()))}" if diff else ""
            lines.append(f"- {event.get('type')}:{event.get('phase')} {event.get('label')}{suffix}")
    blocked = result.get("blocked") if isinstance(result.get("blocked"), list) else []
    if blocked:
        lines.extend(["", "## Blocked", ""])
        for item in blocked:
            lines.append(f"- {json.dumps(item, ensure_ascii=False)}")
    diagnostics = result.get("diagnostics") if isinstance(result.get("diagnostics"), list) else []
    if diagnostics:
        lines.extend(["", "## Diagnostics", ""])
        for diag in diagnostics:
            if not isinstance(diag, dict):
                continue
            source = diag.get("source") if isinstance(diag.get("source"), dict) else {}
            loc = f"{source.get('file', '')}:{source.get('line', 0)}:{source.get('column', 0)}"
            lines.append(f"- {diag.get('severity')} `{diag.get('code')}` {loc} {diag.get('message')}")
    return "\n".join(lines) + "\n"


def diagnostics_json() -> int:
    ctx, _ = build_all(emit=frozenset())
    payload = {"diagnostics": [d.to_dict() for d in ctx.diagnostics]}
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 1 if any(d.severity == "error" for d in ctx.diagnostics) else 0


def new_file(kind: str, ident: str, owner: str | None = None) -> int:
    if kind == "narrative":
        owner_type, _, owner_id = (owner or "system:").partition(":")
        path = AUTHORING / "narrative" / f"{ident}.yaml"
        text = f"id: {ident}\nkind: narrativeGraph\nowner:\n  type: {owner_type or 'system'}\n  id: {owner_id or ident}\ninitialState: start\nstates:\n  start:\n    label: 起始\ntransitions: []\n"
    elif kind == "quest":
        path = AUTHORING / "quests" / f"{ident}.yaml"
        text = f"id: {ident}\npreconditions: []\ncompletionConditions: []\nacceptActions: []\nrewards: []\nnextQuests: []\n"
    elif kind == "dialogue":
        path = AUTHORING / "dialogues" / f"{ident}.yaml"
        text = f"id: {ident}\nkind: dialogueGraph\nentry: start\nnodes:\n  start:\n    type: line\n    speaker:\n      kind: literal\n      name: 旁白\n    text: ''\n    next: end\n  end:\n    type: end\n"
    else:
        print(f"unknown kind: {kind}", file=sys.stderr)
        return 2
    if path.exists():
        print(f"exists: {_rel(path)}", file=sys.stderr)
        return 1
    write_text(path, text)
    print(f"created {_rel(path)}")
    return 0


def watch() -> int:
    print("content pipeline watch started; press Ctrl+C to stop")
    last = 0.0
    while True:
        newest = max((p.stat().st_mtime for p in AUTHORING.glob("**/*") if p.is_file()), default=0.0)
        if newest > last:
            last = newest
            ctx, _ = build_all()
            print(f"built with {len(ctx.diagnostics)} diagnostics")
        time.sleep(1.0)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="content_pipeline")
    sub = parser.add_subparsers(dest="cmd")
    build_parser = sub.add_parser("build")
    build_parser.add_argument(
        "--publish",
        action="store_true",
        help="write pipeline-owned outputs to real runtime paths (legacy_editor-owned files are never published)",
    )
    for name in ("validate", "index", "render"):
        sub.add_parser(name)
    sub.add_parser("diagnostics-json")
    sub.add_parser("runtime-compatibility")
    sim = sub.add_parser("simulate")
    sim.add_argument("case", nargs="?")
    exp = sub.add_parser("explain")
    exp.add_argument("case", nargs="?")
    tr = sub.add_parser("trace-resolve")
    tr.add_argument("trace")
    sub.add_parser("lsp-smoke")
    nf = sub.add_parser("new")
    nf.add_argument("kind", choices=["narrative", "quest", "dialogue"])
    nf.add_argument("id")
    nf.add_argument("--owner")
    sub.add_parser("watch")
    args = parser.parse_args(argv)
    if args.cmd in {"build", "validate", "index", "render", None}:
        if args.cmd == "validate":
            emit: frozenset[str] = frozenset()  # compile + diagnose only, no artifacts
        elif args.cmd == "index":
            emit = frozenset({"index"})
        elif args.cmd == "render":
            emit = frozenset({"render"})
        else:  # build / default
            emit = EMIT_ALL
        publish = bool(getattr(args, "publish", False))
        ctx, data = build_all(publish=publish, emit=emit)
        for d in ctx.diagnostics:
            print(d.format())
        for path in data.get("published", []):
            print(f"published -> {path}")
        return 1 if any(d.severity == "error" for d in ctx.diagnostics) else 0
    if args.cmd == "simulate":
        return simulate(args.case)
    if args.cmd == "diagnostics-json":
        return diagnostics_json()
    if args.cmd == "runtime-compatibility":
        return runtime_compatibility()
    if args.cmd == "explain":
        return explain(args.case)
    if args.cmd == "trace-resolve":
        return trace_resolve(args.trace)
    if args.cmd == "lsp-smoke":
        return lsp_smoke()
    if args.cmd == "new":
        return new_file(args.kind, args.id, args.owner)
    if args.cmd == "watch":
        return watch()
    parser.print_help()
    return 2
