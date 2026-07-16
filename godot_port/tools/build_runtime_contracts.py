#!/usr/bin/env python3
"""Build/check the shared runtime-command and snapshot contracts.

The TypeScript union remains authoritative for command names and accepted
fields.  This tool adds the runtime coercion/default semantics that cannot be
expressed by that deliberately-unknown union, and fails when the source union
drifts without a matching contract update.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Any


PORT_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PORT_ROOT.parent
COMMAND_SOURCE = REPO_ROOT / "src/core/devRuntimeCommands.ts"
COMMAND_OUTPUT = PORT_ROOT / "compatibility/runtime-command-contract.json"
SNAPSHOT_OUTPUT = PORT_ROOT / "compatibility/runtime-snapshot-schema.json"


# These are semantic facts from applyDevRuntimeCommand, not a second list of
# accepted fields.  Accepted fields are always extracted from RuntimeCommand.
COMMAND_SEMANTICS: dict[str, dict[str, Any]] = {
    "captureSnapshot": {},
    "debugClearEventTrace": {},
    "debugExecuteAction": {"required": ["action"]},
    "debugSetFixedTickMode": {"defaults": {"enabled": True}, "coercion": {"enabled": "boolean alias"}},
    "debugStepTicks": {"defaults": {"ticks": 1, "dtMs": 16.6666666667}, "bounds": {"ticks": [1, 200], "dtMs": [1, 100]}},
    "clearNarrativeTrace": {},
    "emitNarrativeSignal": {"required": ["sourceType", "sourceId", "signal"]},
    "debugSetNarrativeState": {"required": ["graphId", "stateId"]},
    "setFlag": {"required": ["key"], "coercion": {"value": "registered flag kind"}},
    "debugSetQuestStatus": {"required": ["questId", "status"], "coercion": {"status": "quest status alias -> 0|1|2"}},
    "debugSetScenarioPhase": {"required": ["scenarioId", "phase", "status"]},
    "debugSetScenarioLineLifecycle": {
        "required": ["scenarioId", "state"],
        "coercion": {"state": "lifecycle alias -> inactive|active|completed"},
    },
    "debugResetScenarioProgress": {"required": ["scenarioId"]},
    "debugStartDialogueGraph": {
        "required": ["graphId"],
        "defaults": {"npcName": "$graphId"},
    },
    "debugAdvanceDialogue": {"defaults": {"maxSteps": 24}, "bounds": {"maxSteps": [1, 200]}},
    "debugChooseDialogueOption": {
        "requiredAny": [["index", "text"]],
        "coercion": {"index": "non-negative integer", "text": "trimmed non-empty string"},
    },
    "debugSwitchScene": {"required": ["sceneId"]},
    "debugTriggerHotspot": {"required": ["hotspotId"]},
    "debugInteractNpc": {"required": ["npcId"]},
    "debugWait": {"defaults": {"durationMs": 500}, "bounds": {"durationMs": [1, 60000]}},
    "debugSetPlayerPosition": {
        "required": ["x", "y"],
        "defaults": {"snapCamera": True},
        "coercion": {"x": "finite number", "y": "finite number", "snapCamera": "boolean alias"},
    },
    "debugMovePlayerTo": {
        "required": ["x", "y"],
        "defaults": {"speed": 180, "snapCamera": True},
        "coercion": {"x": "finite number", "y": "finite number", "speed": "positive number", "snapCamera": "boolean alias"},
    },
    "debugClick": {
        "required": ["x", "y"],
        "coercion": {"x": "finite number", "y": "finite number"},
    },
    "debugDrag": {
        "required": ["fromX", "fromY", "toX", "toY"],
        "defaults": {"durationMs": 350},
        "bounds": {"durationMs": [1, 60000]},
    },
    "debugSaveGame": {"defaults": {"slot": 2}, "enum": {"slot": [0, 1, 2]}},
    "debugLoadGame": {"defaults": {"slot": 2}, "enum": {"slot": [0, 1, 2]}},
    "debugReloadScene": {},
    "playerInteract": {},
    "playerAdvance": {},
    "playerChoose": {"required": ["index"], "coercion": {"index": "non-negative integer"}},
    "playerMoveTo": {
        "required": ["x", "y"],
        "coercion": {"x": "finite number", "y": "finite number"},
    },
    "playerTap": {},
    "setPlayerCollisions": {"defaults": {"enabled": True}, "coercion": {"enabled": "false only when literal false"}},
    "activatePlane": {"required": ["planeId"]},
    "deactivatePlane": {},
}


def _read_command_union() -> tuple[str, dict[str, list[str]]]:
    source = COMMAND_SOURCE.read_text(encoding="utf-8")
    block = source.split("export type RuntimeCommand =", 1)[1].split("export type RuntimeCommandResult", 1)[0]
    chunks = re.split(r"\n\s*\|\s*", block)
    commands: dict[str, list[str]] = {}
    for chunk in chunks:
        type_match = re.search(r"\btype:\s*'([^']+)'", chunk)
        if not type_match:
            continue
        command_type = type_match.group(1)
        optional_fields = re.findall(r"\b([A-Za-z][A-Za-z0-9_]*)\?:\s*unknown\s*;", chunk)
        fields = sorted(set(["type", *optional_fields]))
        if command_type in commands:
            raise RuntimeError(f"duplicate RuntimeCommand variant: {command_type}")
        commands[command_type] = fields
    if not commands:
        raise RuntimeError("failed to extract RuntimeCommand variants")
    return source, commands


def _command_contract() -> dict[str, Any]:
    source, commands = _read_command_union()
    source_names = set(commands)
    semantic_names = set(COMMAND_SEMANTICS)
    if source_names != semantic_names:
        raise RuntimeError(
            "runtime command semantics drift: "
            f"missing={sorted(source_names - semantic_names)}, stale={sorted(semantic_names - source_names)}"
        )
    command_entries: dict[str, Any] = {}
    for name in sorted(commands):
        semantics = COMMAND_SEMANTICS[name]
        accepted = commands[name]
        referenced = {
            field
            for key in ("required",)
            for field in semantics.get(key, [])
        }
        referenced.update(field for group in semantics.get("requiredAny", []) for field in group)
        for key in ("defaults", "coercion", "bounds", "enum"):
            referenced.update(semantics.get(key, {}).keys())
        unknown = sorted(referenced - set(accepted))
        if unknown:
            raise RuntimeError(f"{name} semantics reference undeclared fields: {unknown}")
        command_entries[name] = {
            "acceptedFields": accepted,
            "required": semantics.get("required", []),
            "requiredAny": semantics.get("requiredAny", []),
            "defaults": semantics.get("defaults", {}),
            "coercion": semantics.get("coercion", {}),
            "bounds": semantics.get("bounds", {}),
            "enum": semantics.get("enum", {}),
            "captureAfterExecution": True,
        }
    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "contractVersion": 1,
        "authority": {
            "commandUnion": "src/core/devRuntimeCommands.ts#RuntimeCommand",
            "executionSemantics": "src/core/devRuntimeCommands.ts#applyDevRuntimeCommand",
            "sourceSha256": digest,
        },
        "transport": {
            "batchLimit": 50,
            "resultRequiredFields": ["id", "type", "ok", "message"],
            "transportOnlyFields": ["targetBootId", "createdAt", "source", "enqueuedAt"],
            "unknownCommand": "return ok=false; never throw out of the batch",
        },
        "parityControl": {
            "protocolVersion": 1,
            "operations": ["ping", "runtimeCommand", "captureSnapshot"],
            "pingResult": {"ok": True, "message": "pong"},
        },
        "commands": command_entries,
    }


def _object(additional: bool = True) -> dict[str, Any]:
    return {"type": "object", "additionalProperties": additional}


def _snapshot_schema() -> dict[str, Any]:
    result = {
        "type": "object",
        "additionalProperties": False,
        "required": ["id", "type", "ok", "message"],
        "properties": {
            "id": {"type": "string"},
            "type": {"type": "string"},
            "ok": {"type": "boolean"},
            "message": {"type": "string"},
        },
    }
    player = {
        "type": "object",
        "additionalProperties": True,
        "required": ["x", "y", "facing"],
        "properties": {
            "x": {"type": "number"},
            "y": {"type": "number"},
            "facing": {"type": "string"},
        },
    }
    player_view = {
        "type": "object",
        "additionalProperties": True,
        "required": ["mode", "scene", "player", "entities", "interactionPrompt", "dialogue", "hud", "navTargetActive"],
        "properties": {
            "mode": {"type": "string"},
            "scene": {"type": ["string", "null"]},
            "player": player,
            "entities": {"type": "array"},
            "interactionPrompt": {"type": ["object", "string", "null"]},
            "dialogue": {"type": ["object", "null"]},
            "hud": _object(),
            "navTargetActive": {"type": "boolean"},
        },
    }
    required = [
        "reason", "capturedAt", "currentSceneId", "gameState", "previousGameState",
        "flags", "questState", "scenarioState", "narrativeEval", "narrativeState",
        "documentReveals", "eventTrace", "saveData", "runtimeRandomState", "activeZones", "uiState",
        "hudVisualState", "renderState", "entityVisualState", "audioState", "inFlight", "dialogue", "dialogueView", "minigameDebug", "player", "planes", "inventory",
        "interactables", "playerView", "runtimeCommands", "recentPageErrors", "bootId",
    ]
    properties: dict[str, Any] = {
        "reason": {"type": "string"},
        "capturedAt": {"type": "string", "format": "date-time"},
        "currentSceneId": {"type": ["string", "null"]},
        "gameState": {"type": "string"},
        "previousGameState": {"type": ["string", "null"]},
        "flags": _object(),
        "questState": _object(),
        "scenarioState": _object(),
        "narrativeEval": _object(),
        "narrativeState": _object(),
        "documentReveals": _object(),
        "eventTrace": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["seq", "event", "payload"],
                "properties": {
                    "seq": {"type": "integer"},
                    "event": {"type": "string"},
                    "payload": {},
                },
            },
        },
        "saveData": _object(),
        "runtimeRandomState": {"type": "integer"},
        "activeZones": {"type": "array", "items": {"type": "string"}},
        "uiState": _object(),
        "hudVisualState": {"type": ["object", "null"], "additionalProperties": True},
        "renderState": _object(),
        "entityVisualState": {"type": ["object", "null"], "additionalProperties": True},
        "audioState": _object(),
        "inFlight": _object(),
        "dialogue": _object(),
        "dialogueView": _object(),
        "minigameDebug": _object(),
        "player": player,
        "planes": _object(),
        "inventory": _object(),
        "interactables": {"type": "array"},
        "playerView": player_view,
        "runtimeCommands": {
            "type": "object",
            "additionalProperties": True,
            "required": ["lastResults"],
            "properties": {"lastResults": {"type": "array", "items": result}},
        },
        "recentPageErrors": {"type": "array"},
        "bootId": {"type": "string", "minLength": 1},
    }
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "gamedraft://godot/runtime-snapshot-schema-v1",
        "title": "GameDraft cross-runtime debug snapshot",
        "type": "object",
        "additionalProperties": True,
        "required": required,
        "properties": properties,
        "x-authority": "src/core/Game.ts#buildRuntimeDebugSnapshot",
        "x-parity": {
            "ignoredValuePaths": [
                "/reason", "/capturedAt", "/bootId", "/runtimeCommands/lastResults",
                "/saveData/game/playTimeMs",
            ],
            "ignoredObjectKeysAtPaths": [
                {"path": "/narrativeState/recentTrace", "keys": ["at"]},
                {"path": "/narrativeEval", "keys": ["traceText", "summaryText"]},
            ],
            "numericTolerance": 0.0001,
            "unorderedObjectKeys": True,
            "arraysRemainOrdered": True,
        },
    }


def _serialized(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def _write_or_check(path: Path, value: Any, write: bool) -> bool:
    expected = _serialized(value)
    actual = path.read_text(encoding="utf-8") if path.is_file() else ""
    if actual == expected:
        print(f"OK {path.relative_to(REPO_ROOT)}")
        return True
    if write:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(expected, encoding="utf-8")
        print(f"WROTE {path.relative_to(REPO_ROOT)}")
        return True
    print(f"STALE {path.relative_to(REPO_ROOT)} (run with --write)")
    return False


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true", help="refresh generated contracts")
    args = parser.parse_args()
    ok = _write_or_check(COMMAND_OUTPUT, _command_contract(), args.write)
    ok = _write_or_check(SNAPSHOT_OUTPUT, _snapshot_schema(), args.write) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
