"""Build runtime debug commands from a story-unit acceptance script."""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from .runtime_command import new_runtime_command
from .story_units import StoryUnit


@dataclass(frozen=True)
class AcceptanceRuntimeCommandPlan:
    commands: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def build_acceptance_setup_runtime_commands(unit: StoryUnit) -> AcceptanceRuntimeCommandPlan:
    """Translate setup fields into DEV runtime commands.

    The acceptance script is intentionally planner-friendly free text. This
    parser supports the stable shorthand we document and reports anything it
    cannot safely translate instead of guessing.
    """
    script = unit.record.acceptance_script
    commands: list[dict[str, Any]] = []
    warnings: list[str] = []
    reason_prefix = f"acceptance-setup:{unit.record.composition_id}"

    for raw in script.setup_flags:
        parsed = parse_setup_flag(raw)
        if parsed is None:
            warnings.append(f"setupFlags 无法转 runtime 命令: {raw}")
            continue
        key, value = parsed
        commands.append(
            new_runtime_command(
                "setFlag",
                reason=f"{reason_prefix}:flag:{key}",
                payload={"key": key, "value": value},
            )
        )

    for raw in script.setup_narrative_states:
        parsed_state = parse_graph_state_ref(raw)
        if parsed_state is None:
            warnings.append(f"setupNarrativeStates 无法转 runtime 命令: {raw}")
            continue
        graph_id, state_id = parsed_state
        commands.append(
            new_runtime_command(
                "debugSetNarrativeState",
                reason=f"{reason_prefix}:state:{graph_id}.{state_id}",
                payload={"graphId": graph_id, "stateId": state_id},
            )
        )

    for raw in script.setup_quests:
        parsed_quest = parse_setup_quest(raw)
        if parsed_quest is None:
            warnings.append(f"setupQuests 无法转 runtime 命令: {raw}")
            continue
        quest_id, status = parsed_quest
        commands.append(
            new_runtime_command(
                "debugSetQuestStatus",
                reason=f"{reason_prefix}:quest:{quest_id}:{status}",
                payload={"questId": quest_id, "status": status},
            )
        )

    for raw in script.setup_scenarios:
        scenario_commands = build_setup_scenario_commands(raw, reason_prefix=reason_prefix)
        if scenario_commands is None:
            warnings.append(f"setupScenarios 无法转 runtime 命令: {raw}")
            continue
        commands.extend(scenario_commands)

    return AcceptanceRuntimeCommandPlan(commands=commands, warnings=warnings)


def build_acceptance_route_runtime_commands(unit: StoryUnit) -> AcceptanceRuntimeCommandPlan:
    script = unit.record.acceptance_script
    commands: list[dict[str, Any]] = []
    warnings: list[str] = []
    reason_prefix = f"acceptance-route:{unit.record.composition_id}"

    for raw in script.actions:
        parsed = build_action_runtime_commands(raw, reason_prefix=reason_prefix)
        if parsed is None:
            warnings.append(f"actions 无法转 runtime 命令: {raw}")
            continue
        commands.extend(parsed)

    for raw in script.option_choices:
        parsed = build_option_choice_runtime_commands(raw, reason_prefix=reason_prefix)
        if parsed is None:
            warnings.append(f"optionChoices 无法转 runtime 命令: {raw}")
            continue
        commands.extend(parsed)

    return AcceptanceRuntimeCommandPlan(commands=commands, warnings=warnings)


def build_acceptance_save_load_runtime_commands(unit: StoryUnit) -> AcceptanceRuntimeCommandPlan:
    text = unit.record.acceptance_script.save_load_check.strip()
    if not text:
        return AcceptanceRuntimeCommandPlan()
    if _has_any_marker(text, ["人工", "手动", "manual"]):
        return AcceptanceRuntimeCommandPlan()

    commands: list[dict[str, Any]] = []
    warnings: list[str] = []
    reason_prefix = f"acceptance-save-load:{unit.record.composition_id}"
    slot = save_slot_from_text(text) or 2

    if save_load_check_requests_save_load(text):
        commands.extend([
            new_runtime_command(
                "debugSaveGame",
                reason=f"{reason_prefix}:save:{slot}",
                payload={"slot": slot},
            ),
            new_runtime_command(
                "debugWait",
                reason=f"{reason_prefix}:wait-after-save",
                payload={"durationMs": 300},
            ),
            new_runtime_command(
                "debugLoadGame",
                reason=f"{reason_prefix}:load:{slot}",
                payload={"slot": slot},
            ),
        ])

    if save_load_check_requests_reload(text):
        payload: dict[str, Any] = {}
        scene_id = named_identifier(text, "scene") or named_identifier(text, "sceneId")
        if scene_id:
            payload["sceneId"] = scene_id
        commands.append(
            new_runtime_command(
                "debugReloadScene",
                reason=f"{reason_prefix}:reload-scene",
                payload=payload,
            )
        )

    if not commands:
        warnings.append(f"saveLoadCheck 无法转 runtime 命令: {text}")
    return AcceptanceRuntimeCommandPlan(commands=commands, warnings=warnings)


def build_acceptance_entry_runtime_commands(unit: StoryUnit) -> AcceptanceRuntimeCommandPlan:
    rec = unit.record
    raw = rec.acceptance_script.start_entry.strip() or rec.entry.strip()
    if not raw:
        return AcceptanceRuntimeCommandPlan()
    reason_prefix = f"acceptance-entry:{rec.composition_id}"
    commands = build_action_runtime_commands(raw, reason_prefix=reason_prefix)
    if commands is None:
        return AcceptanceRuntimeCommandPlan(warnings=[f"startEntry 无法转 runtime 命令: {raw}"])
    return AcceptanceRuntimeCommandPlan(commands=commands)


def build_acceptance_runtime_commands(unit: StoryUnit) -> AcceptanceRuntimeCommandPlan:
    setup = build_acceptance_setup_runtime_commands(unit)
    entry = build_acceptance_entry_runtime_commands(unit)
    route = build_acceptance_route_runtime_commands(unit)
    save_load = build_acceptance_save_load_runtime_commands(unit)
    return AcceptanceRuntimeCommandPlan(
        commands=[*setup.commands, *entry.commands, *route.commands, *save_load.commands],
        warnings=[*setup.warnings, *entry.warnings, *route.warnings, *save_load.warnings],
    )


def parse_graph_state_ref(raw: str) -> tuple[str, str] | None:
    text = str(raw or "").strip()
    if not text:
        return None
    match = re.search(r"([0-9A-Za-z_\-\u4e00-\u9fff]+)\.([0-9A-Za-z_\-\u4e00-\u9fff]+)", text)
    if match:
        return match.group(1), match.group(2)
    match = re.search(
        r"graph\s*=\s*([0-9A-Za-z_\-\u4e00-\u9fff]+)\s+state\s*=\s*([0-9A-Za-z_\-\u4e00-\u9fff]+)",
        text,
        re.IGNORECASE,
    )
    if match:
        return match.group(1), match.group(2)
    return None


def parse_setup_flag(raw: str) -> tuple[str, Any] | None:
    text = str(raw or "").strip()
    if not text:
        return None
    match = re.match(
        r"^([0-9A-Za-z_.\-\u4e00-\u9fff]+)\s*(?:==|=|:)\s*(.+)$",
        text,
    )
    if not match:
        match = re.match(r"^([0-9A-Za-z_.\-\u4e00-\u9fff]+)\s+(.+)$", text)
    if not match:
        return None
    key = match.group(1).strip(" .:-")
    value = parse_scalar_value(match.group(2).strip())
    if not key:
        return None
    return key, value


def parse_setup_quest(raw: str) -> tuple[str, int] | None:
    text = str(raw or "").strip()
    quest_id = first_identifier(text)
    if not quest_id:
        return None
    status = quest_status_from_text(text)
    return quest_id, status if status is not None else 1


def build_setup_scenario_commands(raw: str, *, reason_prefix: str) -> list[dict[str, Any]] | None:
    text = str(raw or "").strip()
    scenario_id = first_identifier(text)
    if not scenario_id:
        return None

    phase = ""
    if "." in scenario_id:
        scenario_id, phase = scenario_id.split(".", 1)
    explicit_phase = re.search(r"(?:phase|阶段)\s*[:=]\s*([0-9A-Za-z_\-\u4e00-\u9fff]+)", text, re.IGNORECASE)
    if explicit_phase:
        phase = explicit_phase.group(1).strip()

    status = scenario_status_from_text(text)
    outcome = parse_named_scalar(text, "outcome")
    if phase:
        return [
            new_runtime_command(
                "debugSetScenarioPhase",
                reason=f"{reason_prefix}:scenario:{scenario_id}.{phase}:{status or 'active'}",
                payload={
                    "scenarioId": scenario_id,
                    "phase": phase,
                    "status": status or "active",
                    **({"outcome": outcome} if outcome is not None else {}),
                },
            )
        ]

    lifecycle = scenario_lifecycle_from_text(text)
    if lifecycle == "inactive":
        return [
            new_runtime_command(
                "debugResetScenarioProgress",
                reason=f"{reason_prefix}:scenario:{scenario_id}:inactive",
                payload={"scenarioId": scenario_id},
            )
        ]
    if lifecycle in {"active", "completed"}:
        return [
            new_runtime_command(
                "debugSetScenarioLineLifecycle",
                reason=f"{reason_prefix}:scenario:{scenario_id}:{lifecycle}",
                payload={"scenarioId": scenario_id, "state": lifecycle},
            )
        ]
    if status in {"pending", "locked"}:
        return [
            new_runtime_command(
                "debugResetScenarioProgress",
                reason=f"{reason_prefix}:scenario:{scenario_id}:{status}",
                payload={"scenarioId": scenario_id},
            )
        ]
    return None


def build_action_runtime_commands(raw: str, *, reason_prefix: str) -> list[dict[str, Any]] | None:
    text = str(raw or "").strip()
    if not text:
        return None
    path_commands = player_path_runtime_commands_from_text(text, reason_prefix=reason_prefix)
    if path_commands is not None:
        return path_commands

    wait_ms = wait_duration_from_text(text)
    if wait_ms is not None:
        return [
            new_runtime_command(
                "debugWait",
                reason=f"{reason_prefix}:wait:{wait_ms}",
                payload={"durationMs": wait_ms},
            )
        ]

    move_payload = player_move_payload_from_text(text)
    if move_payload is not None:
        return [
            new_runtime_command(
                "debugMovePlayerTo",
                reason=f"{reason_prefix}:player-move",
                payload=move_payload,
            )
        ]

    drag_payload = drag_payload_from_text(text)
    if drag_payload is not None:
        return [
            new_runtime_command(
                "debugDrag",
                reason=f"{reason_prefix}:drag",
                payload=drag_payload,
            )
        ]

    click_payload = click_payload_from_text(text)
    if click_payload is not None:
        return [
            new_runtime_command(
                "debugClick",
                reason=f"{reason_prefix}:click",
                payload=click_payload,
            )
        ]

    position_payload = player_position_payload_from_text(text)
    if position_payload is not None:
        return [
            new_runtime_command(
                "debugSetPlayerPosition",
                reason=f"{reason_prefix}:player-position",
                payload=position_payload,
            )
        ]

    signal_id = prefixed_value(text, ["signal", "emitSignal", "narrativeSignal"])
    if signal_id:
        return [
            new_runtime_command(
                "emitNarrativeSignal",
                reason=f"{reason_prefix}:signal:{signal_id}",
                payload={
                    "sourceType": "system",
                    "sourceId": "production-workbench",
                    "signal": signal_id,
                },
            )
        ]

    scene_id = prefixed_value(text, ["scene", "switchScene", "changeScene"])
    if scene_id:
        payload: dict[str, Any] = {"sceneId": scene_id}
        spawn = named_identifier(text, "spawn") or named_identifier(text, "spawnPoint")
        if spawn:
            payload["spawnPoint"] = spawn
        return [
            new_runtime_command(
                "debugSwitchScene",
                reason=f"{reason_prefix}:scene:{scene_id}",
                payload=payload,
            )
        ]

    npc_id = prefixed_value(text, ["npc", "interactNpc"])
    if npc_id:
        return [
            new_runtime_command(
                "debugInteractNpc",
                reason=f"{reason_prefix}:npc:{npc_id}",
                payload={"npcId": npc_id},
            )
        ]

    hotspot_id = prefixed_value(text, ["hotspot", "interact", "inspect", "pickup"])
    if hotspot_id:
        return [
            new_runtime_command(
                "debugTriggerHotspot",
                reason=f"{reason_prefix}:hotspot:{hotspot_id}",
                payload={"hotspotId": hotspot_id},
            )
        ]

    graph_id = prefixed_value(text, ["dialogue", "dialogueGraph", "graph"])
    if graph_id:
        entry = named_identifier(text, "entry")
        npc_id = named_identifier(text, "npc") or named_identifier(text, "npcId")
        owner_type = named_identifier(text, "ownerType")
        owner_id = named_identifier(text, "ownerId")
        payload: dict[str, Any] = {
            "graphId": graph_id,
            "npcName": npc_id or graph_id,
        }
        if entry:
            payload["entry"] = entry
        if npc_id:
            payload["npcId"] = npc_id
        if owner_type:
            payload["ownerType"] = owner_type
        if owner_id:
            payload["ownerId"] = owner_id
        return [
            new_runtime_command(
                "debugStartDialogueGraph",
                reason=f"{reason_prefix}:dialogue:{graph_id}",
                payload=payload,
            )
        ]

    if is_advance_instruction(text):
        return [
            new_runtime_command(
                "debugAdvanceDialogue",
                reason=f"{reason_prefix}:advance",
                payload={"maxSteps": advance_count_from_text(text)},
            )
        ]

    return None


def build_option_choice_runtime_commands(raw: str, *, reason_prefix: str) -> list[dict[str, Any]] | None:
    text = str(raw or "").strip()
    if not text:
        return None
    payload: dict[str, Any] = {}
    option_text = prefixed_free_text_value(text, ["option", "choice", "选项"])
    option_index = option_index_from_text(text)
    if option_index is not None:
        payload["index"] = option_index
    elif option_text:
        payload["text"] = option_text
    else:
        return None
    return [
        new_runtime_command(
            "debugChooseDialogueOption",
            reason=f"{reason_prefix}:option",
            payload=payload,
        ),
        new_runtime_command(
            "debugAdvanceDialogue",
            reason=f"{reason_prefix}:after-option",
            payload={"maxSteps": advance_count_from_text(text)},
        ),
    ]


def parse_scalar_value(raw: str) -> Any:
    text = str(raw or "").strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        return text[1:-1]
    lower = text.lower()
    if lower in {"true", "yes", "on"}:
        return True
    if lower in {"false", "no", "off"}:
        return False
    if lower in {"null", "none"}:
        return ""
    try:
        if re.match(r"^-?\d+$", text):
            return int(text)
        if re.match(r"^-?(?:\d+\.\d*|\d*\.\d+)$", text):
            return float(text)
    except ValueError:
        pass
    return text


def first_identifier(raw: str) -> str:
    text = str(raw or "").strip()
    if not text:
        return ""
    match = re.match(r"([0-9A-Za-z_.\-\u4e00-\u9fff]+)", text)
    return match.group(1).strip(" .:-") if match else ""


def quest_status_from_text(raw: str) -> int | None:
    text = str(raw or "").lower()
    if any(word in text for word in ["completed", "complete", "done", "完成", "已完成"]):
        return 2
    if any(word in text for word in ["inactive", "pending", "未接", "未激活", "关闭"]):
        return 0
    if any(word in text for word in ["accepted", "accept", "active", "接取", "进行", "激活"]):
        return 1
    return None


def scenario_status_from_text(raw: str) -> str | None:
    text = str(raw or "").lower()
    explicit = re.search(r"(?:status|状态)\s*[:=]\s*([0-9A-Za-z_\-\u4e00-\u9fff]+)", text)
    if explicit:
        candidate = explicit.group(1).strip()
        if candidate in {"pending", "active", "done", "locked", "completed"}:
            return candidate
    if any(word in text for word in ["inactive", "pending", "未激活", "未开始", "待定"]):
        return "pending"
    if any(word in text for word in ["completed", "complete", "完成", "已完成"]):
        return "completed"
    if any(word in text for word in ["done", "达成"]):
        return "done"
    if any(word in text for word in ["active", "进行", "激活"]):
        return "active"
    if any(word in text for word in ["locked", "锁定"]):
        return "locked"
    return None


def scenario_lifecycle_from_text(raw: str) -> str | None:
    status = scenario_status_from_text(raw)
    if status in {"pending", "inactive"}:
        return "inactive"
    if status == "active":
        return "active"
    if status == "completed":
        return "completed"
    return None


def parse_named_scalar(raw: str, name: str) -> Any | None:
    match = re.search(rf"{re.escape(name)}\s*[:=]\s*([^,;]+)", str(raw or ""), re.IGNORECASE)
    if not match:
        return None
    return parse_scalar_value(match.group(1).strip())


def prefixed_value(raw: str, prefixes: list[str]) -> str:
    prefix_re = "|".join(re.escape(prefix) for prefix in prefixes)
    match = re.search(rf"(?:{prefix_re})\s*[:=]\s*([0-9A-Za-z_.\-\u4e00-\u9fff]+)", str(raw or ""), re.IGNORECASE)
    return match.group(1).strip() if match else ""


def prefixed_free_text_value(raw: str, prefixes: list[str]) -> str:
    prefix_re = "|".join(re.escape(prefix) for prefix in prefixes)
    match = re.search(rf"(?:{prefix_re})\s*[:=：]\s*(.+)$", str(raw or ""), re.IGNORECASE)
    return match.group(1).strip() if match else ""


def named_identifier(raw: str, name: str) -> str:
    match = re.search(rf"{re.escape(name)}\s*[:=]\s*([0-9A-Za-z_.\-\u4e00-\u9fff]+)", str(raw or ""), re.IGNORECASE)
    return match.group(1).strip() if match else ""


def save_slot_from_text(raw: str) -> int | None:
    match = re.search(r"(?:slot|槽位|存档位)\s*[:=]?\s*([0-2])", str(raw or ""), re.IGNORECASE)
    return int(match.group(1)) if match else None


def save_load_check_requests_save_load(raw: str) -> bool:
    text = str(raw or "").lower()
    if _has_any_marker(text, ["保存读档", "存读档", "save/load", "saveload"]):
        return True
    has_save = _has_any_marker(text, ["save", "保存", "存档"])
    has_load = _has_any_marker(text, ["load", "读档", "加载存档"])
    return has_save and has_load


def save_load_check_requests_reload(raw: str) -> bool:
    return _has_any_marker(
        str(raw or "").lower(),
        ["re-enter", "reenter", "reloadscene", "reload scene", "重进", "重新进入", "重载场景"],
    )


def wait_duration_from_text(raw: str) -> int | None:
    text = str(raw or "").strip()
    if not text or not any(word in text.lower() for word in ["wait", "delay", "等待", "停顿", "暂停"]):
        return None
    match = re.search(
        r"(?:wait|delay|等待|停顿|暂停)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)?",
        text,
        re.IGNORECASE,
    )
    if not match:
        return None
    value = float(match.group(1))
    unit = (match.group(2) or "ms").lower()
    if unit in {"s", "秒"}:
        value *= 1000
    return max(1, min(60_000, round(value)))


def player_path_runtime_commands_from_text(raw: str, *, reason_prefix: str) -> list[dict[str, Any]] | None:
    text = str(raw or "").strip()
    if not _has_any_marker(text, ["path", "route", "patrol", "waypoints", "巡路", "路径", "路线"]):
        return None
    points = xy_points_from_text(text)
    if len(points) < 2:
        return None

    speed = named_number(text, "speed")
    snap = first_named_bool(text, ["snapCamera", "snap"])
    wait_between = named_duration_ms(text, ["waitBetween", "pauseBetween", "间隔", "停顿"])
    commands: list[dict[str, Any]] = []
    last_idx = len(points) - 1
    for idx, (x, y) in enumerate(points):
        payload: dict[str, Any] = {"x": x, "y": y}
        if speed is not None:
            payload["speed"] = speed
        payload["snapCamera"] = snap if snap is not None else idx == last_idx
        commands.append(
            new_runtime_command(
                "debugMovePlayerTo",
                reason=f"{reason_prefix}:player-path:{idx + 1}/{len(points)}",
                payload=payload,
            )
        )
        if wait_between is not None and idx < last_idx:
            commands.append(
                new_runtime_command(
                    "debugWait",
                    reason=f"{reason_prefix}:player-path-wait:{idx + 1}",
                    payload={"durationMs": wait_between},
                )
            )
    return commands


def player_position_payload_from_text(raw: str) -> dict[str, Any] | None:
    text = str(raw or "").strip()
    if not _has_any_marker(text, ["player", "position", "teleport", "setPlayer", "玩家", "坐标", "传送"]):
        return None
    xy = xy_from_text(text)
    if xy is None:
        return None
    x, y = xy
    payload: dict[str, Any] = {"x": x, "y": y}
    snap = first_named_bool(text, ["snapCamera", "snap"])
    if snap is not None:
        payload["snapCamera"] = snap
    return payload


def player_move_payload_from_text(raw: str) -> dict[str, Any] | None:
    text = str(raw or "").strip()
    if not _has_any_marker(text, ["moveTo", "walkTo", "move", "走到", "移动到"]):
        return None
    xy = xy_from_text(text)
    if xy is None:
        return None
    x, y = xy
    payload: dict[str, Any] = {"x": x, "y": y}
    speed = named_number(text, "speed")
    if speed is not None:
        payload["speed"] = speed
    snap = first_named_bool(text, ["snapCamera", "snap"])
    if snap is not None:
        payload["snapCamera"] = snap
    return payload


def click_payload_from_text(raw: str) -> dict[str, Any] | None:
    text = str(raw or "").strip()
    if not _has_any_marker(text, ["click", "tap", "点击", "点按"]):
        return None
    xy = xy_from_text(text)
    if xy is None:
        return None
    x, y = xy
    return {"x": x, "y": y}


def drag_payload_from_text(raw: str) -> dict[str, Any] | None:
    text = str(raw or "").strip()
    if not _has_any_marker(text, ["drag", "swipe", "拖拽", "拖动", "划动"]):
        return None
    points = xy_points_from_text(text)
    if len(points) < 2:
        return None
    duration = named_duration_ms(text, ["duration", "durationMs", "耗时", "时长"])
    (from_x, from_y), (to_x, to_y) = points[0], points[-1]
    payload: dict[str, Any] = {
        "fromX": from_x,
        "fromY": from_y,
        "toX": to_x,
        "toY": to_y,
    }
    if duration is not None:
        payload["durationMs"] = duration
    return payload


def xy_from_text(raw: str) -> tuple[float, float] | None:
    text = str(raw or "")
    x_match = re.search(r"(?:^|[\s,;])x\s*[:=]\s*(-?\d+(?:\.\d+)?)", text, re.IGNORECASE)
    y_match = re.search(r"(?:^|[\s,;])y\s*[:=]\s*(-?\d+(?:\.\d+)?)", text, re.IGNORECASE)
    if x_match and y_match:
        return float(x_match.group(1)), float(y_match.group(1))
    prefix_re = (
        r"(?:player|position|teleport|setPlayer|moveTo|walkTo|move|click|tap|玩家|坐标|传送|走到|移动到|点击|点按)"
        r"\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)"
    )
    match = re.search(prefix_re, text, re.IGNORECASE)
    if match:
        return float(match.group(1)), float(match.group(2))
    return None


def xy_points_from_text(raw: str) -> list[tuple[float, float]]:
    text = str(raw or "")
    points: list[tuple[float, float]] = []
    for match in re.finditer(r"(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)", text):
        points.append((float(match.group(1)), float(match.group(2))))
    return points


def named_number(raw: str, name: str) -> float | None:
    match = re.search(rf"{re.escape(name)}\s*[:=]\s*(-?\d+(?:\.\d+)?)", str(raw or ""), re.IGNORECASE)
    if not match:
        return None
    return float(match.group(1))


def named_duration_ms(raw: str, names: list[str]) -> int | None:
    text = str(raw or "")
    for name in names:
        match = re.search(
            rf"{re.escape(name)}\s*[:=]\s*(\d+(?:\.\d+)?)\s*(ms|毫秒|s|秒)?",
            text,
            re.IGNORECASE,
        )
        if not match:
            continue
        value = float(match.group(1))
        unit = (match.group(2) or "ms").lower()
        if unit in {"s", "秒"}:
            value *= 1000
        return max(1, min(60_000, round(value)))
    return None


def named_bool(raw: str, name: str) -> bool | None:
    match = re.search(
        rf"{re.escape(name)}\s*[:=]\s*(true|false|1|0|yes|no|on|off)",
        str(raw or ""),
        re.IGNORECASE,
    )
    if not match:
        return None
    return match.group(1).strip().lower() in {"true", "1", "yes", "on"}


def first_named_bool(raw: str, names: list[str]) -> bool | None:
    for name in names:
        value = named_bool(raw, name)
        if value is not None:
            return value
    return None


def _has_any_marker(raw: str, markers: list[str]) -> bool:
    lower = str(raw or "").lower()
    return any(marker.lower() in lower for marker in markers)


def is_advance_instruction(raw: str) -> bool:
    text = str(raw or "").lower()
    return any(word in text for word in ["advance", "continue", "走完", "推进", "继续", "点完", "跳到选项", "直到选项"])


def advance_count_from_text(raw: str) -> int:
    text = str(raw or "")
    match = re.search(r"(?:advance|continue|maxSteps|steps|推进|继续)\s*[:=]?\s*(\d+)", text, re.IGNORECASE)
    if match:
        return max(1, min(200, int(match.group(1))))
    return 24


def option_index_from_text(raw: str) -> int | None:
    text = str(raw or "")
    match = re.search(r"(?:option|choice|选项)\s*[:=]\s*(\d+)", text, re.IGNORECASE)
    if match:
        return max(0, int(match.group(1)) - 1)
    match = re.search(r"第\s*(\d+)\s*(?:个|项|个选项|项选项)", text)
    if match:
        return max(0, int(match.group(1)) - 1)
    return None
