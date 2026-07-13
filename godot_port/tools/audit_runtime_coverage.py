#!/usr/bin/env python3
"""Audit Godot runtime parity against the authoritative TypeScript runtime.

The TypeScript source and shipped content are read on every run.  The Godot
capability manifest may only claim a capability after its semantics and tests
match the source runtime.  `--strict` is the final completion gate.
"""

from __future__ import annotations

import argparse
from collections import Counter
from fnmatch import fnmatchcase
import hashlib
import json
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable


PORT_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = PORT_ROOT.parent
CAPABILITY_PATH = PORT_ROOT / "compatibility" / "capabilities.json"
SCENE_FIELD_CONTRACT_PATH = PORT_ROOT / "compatibility" / "scene-field-contract.json"
DATA_CATALOG_OWNERSHIP_PATH = PORT_ROOT / "compatibility" / "data-catalog-ownership.json"
RUNTIME_CONTRACT_TOOL = PORT_ROOT / "tools" / "build_runtime_contracts.py"
RUNTIME_COMMAND_CONTRACT_PATH = PORT_ROOT / "compatibility" / "runtime-command-contract.json"
RUNTIME_SNAPSHOT_SCHEMA_PATH = PORT_ROOT / "compatibility" / "runtime-snapshot-schema.json"

CONDITION_NODES = {"all", "any", "not", "flag", "quest", "scenario", "scenarioLine", "narrative", "plane"}
MINIGAMES = {"water", "sugarWheel", "paperCraft", "pressureHold"}


@dataclass(frozen=True)
class Contract:
    actions: set[str]
    condition_nodes: set[str]
    dialogue_nodes: set[str]
    cutscene_present_steps: set[str]
    systems: set[str]
    ui_classes: set[str]
    rendering_classes: set[str]
    entity_classes: set[str]
    minigames: set[str]

    def as_dict(self) -> dict[str, set[str]]:
        return {name: set(value) for name, value in vars(self).items()}


def read_text(path: str) -> str:
    return (REPO_ROOT / path).read_text(encoding="utf-8")


def assert_runtime_contracts_current() -> None:
    result = subprocess.run(
        ["python3", str(RUNTIME_CONTRACT_TOOL)],
        cwd=REPO_ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stdout + result.stderr).strip()
        raise RuntimeError(f"Runtime parity contracts are stale or invalid: {detail}")


def exported_classes(directory: str) -> set[str]:
    result: set[str] = set()
    for path in (REPO_ROOT / directory).rglob("*.ts"):
        if path.name.endswith(".test.ts"):
            continue
        result.update(re.findall(r"^export class\s+([A-Za-z][A-Za-z0-9_]*)", path.read_text(encoding="utf-8"), re.M))
    return result


def action_types() -> set[str]:
    manifest = read_text("src/core/actionParamManifest.ts").split("ACTION_PARAM_MANIFEST", 1)[1]
    declared = set(re.findall(r"^  ([A-Za-z][A-Za-z0-9_]*):\s*\{", manifest, re.M))
    registered: set[str] = set()
    for source in ("src/core/ActionExecutor.ts", "src/core/ActionRegistry.ts"):
        registered.update(
            re.findall(r"(?:this\.|executor\.)register\(\s*['\"]([^'\"]+)", read_text(source))
        )
    if declared != registered:
        missing_runtime = sorted(declared - registered)
        missing_manifest = sorted(registered - declared)
        raise RuntimeError(
            "TypeScript action authority is internally inconsistent: "
            f"missing runtime={missing_runtime}, missing manifest={missing_manifest}"
        )
    return declared


def _quoted_list_from_field(chunk: str, field: str) -> list[str]:
    match = re.search(rf"\b{re.escape(field)}\s*:\s*\[([^\]]*)\]", chunk, re.S)
    if not match:
        return []
    values: list[str] = []
    for single, double in re.findall(r"'([^']*)'|\"([^\"]*)\"", match.group(1)):
        values.append(single or double)
    return values


def action_parameter_contract() -> dict[str, dict[str, list[str]]]:
    text = read_text("src/core/actionParamManifest.ts")
    manifest = text.split("ACTION_PARAM_MANIFEST", 1)[1]
    entries = list(re.finditer(r"^  ([A-Za-z][A-Za-z0-9_]*):\s*\{", manifest, re.M))
    result: dict[str, dict[str, list[str]]] = {}
    for index, match in enumerate(entries):
        end = entries[index + 1].start() if index + 1 < len(entries) else len(manifest)
        chunk = manifest[match.start():end]
        result[match.group(1)] = {
            "required": _quoted_list_from_field(chunk, "required"),
            "nonEmpty": _quoted_list_from_field(chunk, "nonEmpty"),
            "optional": _quoted_list_from_field(chunk, "optional"),
        }
    if set(result) != action_types():
        raise RuntimeError("Failed to parse the complete action parameter manifest")
    return result


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def dialogue_node_types() -> set[str]:
    result: set[str] = set()
    for path in (REPO_ROOT / "public/assets/dialogues/graphs").glob("*.json"):
        graph = load_json(path)
        for node in graph.get("nodes", {}).values():
            if isinstance(node, dict) and isinstance(node.get("type"), str):
                result.add(node["type"])
    return result


def walk_cutscene_steps(steps: Iterable[object]) -> Iterable[dict]:
    for raw in steps:
        if not isinstance(raw, dict):
            continue
        yield raw
        for key in ("steps", "parallel"):
            nested = raw.get(key)
            if isinstance(nested, list):
                yield from walk_cutscene_steps(nested)


def cutscene_present_types() -> set[str]:
    index = load_json(REPO_ROOT / "public/assets/data/cutscenes/index.json")
    result: set[str] = set()
    for cutscene in index:
        for step in walk_cutscene_steps(cutscene.get("steps", [])):
            if step.get("kind") == "present" and isinstance(step.get("type"), str):
                result.add(step["type"])
    return result


def system_classes() -> set[str]:
    result: set[str] = set()
    for path in (REPO_ROOT / "src/systems").rglob("*.ts"):
        if path.name.endswith(".test.ts") or path.name == "types.ts":
            continue
        text = path.read_text(encoding="utf-8")
        result.update(re.findall(r"^export class\s+([A-Za-z][A-Za-z0-9_]*)\s+implements\s+IGameSystem", text, re.M))
        result.update(re.findall(r"^export class\s+([A-Za-z][A-Za-z0-9_]*MinigameManager)\s+extends", text, re.M))
    # Core-owned systems participate in the same lifecycle/save contract.
    for path in (REPO_ROOT / "src/core").glob("*.ts"):
        if path.name.endswith(".test.ts"):
            continue
        text = path.read_text(encoding="utf-8")
        result.update(re.findall(r"^export class\s+([A-Za-z][A-Za-z0-9_]*)\s+implements\s+IGameSystem", text, re.M))
    return result


def runtime_command_types() -> list[str]:
    source = read_text("src/core/devRuntimeCommands.ts").split("export type RuntimeCommandResult", 1)[0]
    return sorted(set(re.findall(r"type:\s*'([^']+)'", source)))


def save_system_keys() -> list[str]:
    source = read_text("src/core/Game.ts")
    block = source.split("this.registeredSystems = [", 1)[1].split("\n    ];", 1)[0]
    registered = re.findall(r"\{\s*name:\s*'([^']+)'", block)
    return ["flagStore", *registered, "dialogueLog", "game"]


def _counter_dict(counter: Counter[str]) -> dict[str, int]:
    return {key: counter[key] for key in sorted(counter)}


def scene_field_inventory() -> dict[str, object]:
    scene_paths = sorted((REPO_ROOT / "public/assets/scenes").glob("*.json"))
    scene_fields: Counter[str] = Counter()
    nested: dict[str, Counter[str]] = {
        "npcs": Counter(),
        "hotspots": Counter(),
        "zones": Counter(),
        "backgrounds": Counter(),
    }
    totals = {"scenes": len(scene_paths), "npcs": 0, "hotspots": 0, "zones": 0, "backgrounds": 0}
    per_scene: dict[str, dict[str, int]] = {}
    for path in scene_paths:
        data = load_json(path)
        scene_fields.update(data.keys())
        counts: dict[str, int] = {}
        for collection in nested:
            values = data.get(collection, [])
            if not isinstance(values, list):
                continue
            counts[collection] = len(values)
            totals[collection] += len(values)
            for value in values:
                if isinstance(value, dict):
                    nested[collection].update(value.keys())
        per_scene[str(data.get("id", path.stem))] = counts
    return {
        "totals": totals,
        "sceneFieldOccurrences": _counter_dict(scene_fields),
        "entityFieldOccurrences": {key: _counter_dict(value) for key, value in nested.items()},
        "perSceneEntityCounts": per_scene,
    }


def scene_field_contract() -> dict[str, object]:
    contract = load_json(SCENE_FIELD_CONTRACT_PATH)
    inventory = scene_field_inventory()
    groups = {
        "scene": inventory["sceneFieldOccurrences"],
        "npc": inventory["entityFieldOccurrences"]["npcs"],
        "hotspot": inventory["entityFieldOccurrences"]["hotspots"],
        "zone": inventory["entityFieldOccurrences"]["zones"],
        "background": inventory["entityFieldOccurrences"]["backgrounds"],
    }
    errors: list[str] = []
    for group, observed in groups.items():
        declared = contract.get(group)
        if not isinstance(declared, dict):
            errors.append(f"missing field-contract group {group}")
            continue
        missing = sorted(set(observed) - set(declared))
        if missing:
            errors.append(f"{group} has observed fields without disposition: {missing}")
        for field, descriptor in declared.items():
            if not isinstance(descriptor, dict):
                errors.append(f"{group}.{field} descriptor is not an object")
                continue
            if descriptor.get("disposition") not in {
                "runtime", "runtime_compat", "runtime_override", "editor_only", "deprecated_ignored"
            }:
                errors.append(f"{group}.{field} has invalid disposition")
            if not isinstance(descriptor.get("consumers"), list) or not descriptor["consumers"]:
                errors.append(f"{group}.{field} has no consumers/owner")
    if errors:
        raise RuntimeError("Scene field contract invalid: " + "; ".join(errors))
    return contract


def dialogue_inventory() -> dict[str, object]:
    graph_paths = sorted((REPO_ROOT / "public/assets/dialogues/graphs").glob("*.json"))
    node_counts: Counter[str] = Counter()
    total_nodes = 0
    for path in graph_paths:
        graph = load_json(path)
        for node in graph.get("nodes", {}).values():
            if not isinstance(node, dict) or not isinstance(node.get("type"), str):
                continue
            total_nodes += 1
            node_counts[node["type"]] += 1
    return {
        "graphs": len(graph_paths),
        "nodes": total_nodes,
        "nodeTypeOccurrences": _counter_dict(node_counts),
    }


def cutscene_inventory() -> dict[str, object]:
    index = load_json(REPO_ROOT / "public/assets/data/cutscenes/index.json")
    kinds: Counter[str] = Counter()
    present: Counter[str] = Counter()
    actions: Counter[str] = Counter()
    for cutscene in index:
        for step in walk_cutscene_steps(cutscene.get("steps", [])):
            kind = step.get("kind")
            if isinstance(kind, str):
                kinds[kind] += 1
            step_type = step.get("type")
            if kind == "present" and isinstance(step_type, str):
                present[step_type] += 1
            if kind == "action" and isinstance(step_type, str):
                actions[step_type] += 1
    return {
        "cutscenes": len(index),
        "kindOccurrences": _counter_dict(kinds),
        "presentTypeOccurrences": _counter_dict(present),
        "actionTypeOccurrences": _counter_dict(actions),
    }


def content_action_occurrences(authoritative_actions: set[str]) -> dict[str, int]:
    counts: Counter[str] = Counter()

    def walk(value: object) -> None:
        if isinstance(value, dict):
            action_type = value.get("type")
            if action_type in authoritative_actions and isinstance(value.get("params"), dict):
                counts[action_type] += 1
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    for path in sorted((REPO_ROOT / "public/assets").rglob("*.json")):
        walk(load_json(path))
    return _counter_dict(counts)


def media_inventory() -> dict[str, object]:
    root = REPO_ROOT / "public/resources/runtime"
    extensions: Counter[str] = Counter()
    total_bytes = 0
    files = 0
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        files += 1
        total_bytes += path.stat().st_size
        extensions[path.suffix.lower() or "<none>"] += 1
    return {
        "files": files,
        "bytes": total_bytes,
        "extensionOccurrences": _counter_dict(extensions),
        "animationManifests": len(list((root / "animation").glob("*/anim.json"))),
    }


def data_catalog_inventory() -> dict[str, object]:
    data_root = REPO_ROOT / "public/assets/data"
    paths = sorted(data_root.rglob("*.json"))
    result: dict[str, object] = {}
    for path in paths:
        relative = path.relative_to(REPO_ROOT).as_posix()
        value = load_json(path)
        if isinstance(value, list):
            result[relative] = {"shape": "array", "entries": len(value)}
        elif isinstance(value, dict):
            result[relative] = {
                "shape": "object",
                "topLevelKeys": sorted(value),
                "topLevelSizes": {
                    key: len(child)
                    for key, child in value.items()
                    if isinstance(child, (dict, list))
                },
            }
        else:
            result[relative] = {"shape": type(value).__name__}
    return result


def _json_pointer_segment(raw: object) -> str:
    return str(raw).replace("~", "~0").replace("/", "~1")


def json_field_paths(value: object, pointer: str = "") -> set[str]:
    result: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            child_pointer = f"{pointer}/{_json_pointer_segment(key)}"
            result.add(child_pointer)
            result.update(json_field_paths(child, child_pointer))
    elif isinstance(value, list):
        child_pointer = f"{pointer}/[]"
        result.add(child_pointer)
        for child in value:
            result.update(json_field_paths(child, child_pointer))
    return result


def data_catalog_field_contract() -> dict[str, object]:
    ownership = load_json(DATA_CATALOG_OWNERSHIP_PATH)
    rules = ownership.get("rules")
    if not isinstance(rules, list):
        raise RuntimeError("data-catalog-ownership.json must contain rules[]")
    for index, rule in enumerate(rules):
        if not isinstance(rule, dict):
            raise RuntimeError(f"data catalog ownership rule #{index} is not an object")
        if rule.get("disposition") not in {"runtime", "dev_only", "editor_only"}:
            raise RuntimeError(f"data catalog ownership rule #{index} has invalid disposition")
        if not isinstance(rule.get("consumers"), list) or not rule["consumers"]:
            raise RuntimeError(f"data catalog ownership rule #{index} has no consumers")

    result: dict[str, object] = {}
    paths = sorted((REPO_ROOT / "public/assets/data").rglob("*.json"))
    for path in paths:
        relative = path.relative_to(REPO_ROOT).as_posix()
        matches = [rule for rule in rules if fnmatchcase(relative, str(rule.get("pattern", "")))]
        if len(matches) != 1:
            raise RuntimeError(
                f"data catalog {relative} must have exactly one ownership rule, got {len(matches)}"
            )
        rule = matches[0]
        fields = sorted(json_field_paths(load_json(path)))
        result[relative] = {
            "disposition": rule["disposition"],
            "consumers": rule["consumers"],
            "fieldPathCount": len(fields),
            "fieldPaths": fields,
        }
    unused_rules = [
        rule["pattern"]
        for rule in rules
        if not any(fnmatchcase(path, str(rule.get("pattern", ""))) for path in result)
    ]
    if unused_rules:
        raise RuntimeError(f"data catalog ownership rules match no files: {unused_rules}")
    return result


def _tree_digest(paths: Iterable[Path]) -> dict[str, object]:
    files = sorted({path for path in paths if path.is_file()}, key=lambda path: path.relative_to(REPO_ROOT).as_posix())
    digest = hashlib.sha256()
    total_bytes = 0
    for path in files:
        relative = path.relative_to(REPO_ROOT).as_posix().encode("utf-8")
        payload = path.read_bytes()
        total_bytes += len(payload)
        digest.update(len(relative).to_bytes(4, "big"))
        digest.update(relative)
        digest.update(len(payload).to_bytes(8, "big"))
        digest.update(payload)
    return {"sha256": digest.hexdigest(), "files": len(files), "bytes": total_bytes}


def source_baseline() -> dict[str, object]:
    behavior_paths: list[Path] = []
    for directory in ("src/core", "src/systems", "src/rendering", "src/entities", "src/ui", "src/debug"):
        behavior_paths.extend(
            path
            for path in (REPO_ROOT / directory).rglob("*")
            if path.suffix in {".ts", ".json"} and not path.name.endswith(".test.ts")
        )
    content_paths = list((REPO_ROOT / "public/assets").rglob("*.json"))
    config_paths = [
        REPO_ROOT / "src/data/types.ts",
        REPO_ROOT / "src/data/runtime_field_schema.json",
        REPO_ROOT / "public/resources/runtime.dvc",
    ]
    try:
        git_head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, text=True, stderr=subprocess.DEVNULL
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        git_head = ""
    return {
        "gitHead": git_head,
        "behaviorRuntime": _tree_digest(behavior_paths),
        "contentJson": _tree_digest(content_paths),
        "schemaAndMediaPointer": _tree_digest(config_paths),
    }


def authoritative_contract(contract: Contract) -> dict[str, object]:
    actions = action_parameter_contract()
    runtime_command_contract = load_json(RUNTIME_COMMAND_CONTRACT_PATH)
    runtime_snapshot_schema = load_json(RUNTIME_SNAPSHOT_SCHEMA_PATH)
    return {
        "authority": {
            "actions": ["src/core/ActionExecutor.ts", "src/core/ActionRegistry.ts", "src/core/actionParamManifest.ts"],
            "conditions": ["src/systems/graphDialogue/evaluateGraphCondition.ts"],
            "dialogue": ["src/data/types.ts", "src/systems/GraphDialogueManager.ts", "public/assets/dialogues/graphs"],
            "cutscenes": ["src/systems/CutsceneManager.ts", "src/rendering/CutsceneRenderer.ts", "public/assets/data/cutscenes/index.json"],
            "save": ["src/core/SaveManager.ts", "src/core/Game.ts"],
            "runtimeCommands": ["src/core/devRuntimeCommands.ts", "godot_port/compatibility/runtime-command-contract.json"],
            "runtimeSnapshot": ["src/core/Game.ts#buildRuntimeDebugSnapshot", "godot_port/compatibility/runtime-snapshot-schema.json"],
        },
        "capabilitySets": {key: sorted(value) for key, value in contract.as_dict().items()},
        "actionParameters": actions,
        "runtimeCommands": runtime_command_types(),
        "runtimeProtocol": {
            "contractVersion": runtime_command_contract["contractVersion"],
            "commandCount": len(runtime_command_contract["commands"]),
            "parityOperations": runtime_command_contract["parityControl"]["operations"],
            "snapshotSchemaId": runtime_snapshot_schema["$id"],
            "snapshotRequiredFields": runtime_snapshot_schema["required"],
        },
        "saveSystemKeys": save_system_keys(),
        "sourceBaseline": source_baseline(),
        "content": {
            "scenes": scene_field_inventory(),
            "sceneFieldDisposition": scene_field_contract(),
            "dialogue": dialogue_inventory(),
            "cutscenes": cutscene_inventory(),
            "actionTypeOccurrences": content_action_occurrences(set(actions)),
            "dataCatalogs": data_catalog_inventory(),
            "dataCatalogFieldContract": data_catalog_field_contract(),
            "media": media_inventory(),
        },
    }


def derive_contract() -> Contract:
    return Contract(
        actions=action_types(),
        condition_nodes=set(CONDITION_NODES),
        dialogue_nodes=dialogue_node_types(),
        cutscene_present_steps=cutscene_present_types(),
        systems=system_classes(),
        ui_classes=exported_classes("src/ui"),
        rendering_classes=exported_classes("src/rendering"),
        entity_classes=exported_classes("src/entities"),
        minigames=set(MINIGAMES),
    )


def load_capabilities() -> dict[str, set[str]]:
    raw = load_json(CAPABILITY_PATH)
    return {key: set(value) for key, value in raw.items()}


def markdown_report(contract: Contract, capabilities: dict[str, set[str]]) -> str:
    lines = [
        "# Godot 运行时兼容矩阵",
        "",
        "> 本文件由 `tools/audit_runtime_coverage.py --write-report` 生成。完成度只统计已经按 TypeScript 语义实现并有测试的能力。",
        "",
        "| 能力面 | 权威总数 | 已验证 | 未完成 |",
        "|---|---:|---:|---:|",
    ]
    missing_by_group: dict[str, list[str]] = {}
    for group, required in contract.as_dict().items():
        claimed = capabilities.get(group, set())
        missing = sorted(required - claimed)
        missing_by_group[group] = missing
        lines.append(f"| `{group}` | {len(required)} | {len(required & claimed)} | {len(missing)} |")
    lines.extend(["", "## 未完成项", ""])
    for group, missing in missing_by_group.items():
        lines.extend([f"### {group}", "", ", ".join(f"`{item}`" for item in missing) or "无", ""])
    return "\n".join(lines).rstrip() + "\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="return non-zero while any capability is missing")
    parser.add_argument("--write-report", action="store_true", help="refresh compatibility/runtime-coverage.md")
    parser.add_argument("--write-contract", action="store_true", help="refresh compatibility/authoritative-contract.json")
    args = parser.parse_args()

    assert_runtime_contracts_current()

    contract = derive_contract()
    capabilities = load_capabilities()
    groups = contract.as_dict()

    unknown_groups = sorted(set(capabilities) - set(groups))
    if unknown_groups:
        raise RuntimeError(f"Unknown capability groups: {unknown_groups}")

    has_error = False
    for group, required in groups.items():
        claimed = capabilities.get(group, set())
        false_claims = sorted(claimed - required)
        missing = sorted(required - claimed)
        if false_claims:
            has_error = True
            print(f"ERROR {group}: claims absent from TypeScript authority: {false_claims}")
        print(f"{group}: {len(required & claimed)}/{len(required)} verified; {len(missing)} missing")
        if args.strict and missing:
            has_error = True

    if args.write_report:
        output = PORT_ROOT / "compatibility" / "runtime-coverage.md"
        output.write_text(markdown_report(contract, capabilities), encoding="utf-8")
        print(f"wrote {output.relative_to(REPO_ROOT)}")

    if args.write_contract:
        output = PORT_ROOT / "compatibility" / "authoritative-contract.json"
        output.write_text(
            json.dumps(authoritative_contract(contract), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"wrote {output.relative_to(REPO_ROOT)}")

    if args.strict and has_error:
        print("Godot runtime parity: INCOMPLETE")
        return 1
    if has_error:
        return 1
    print("Godot runtime parity: COMPLETE" if args.strict else "Godot runtime parity inventory: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
