class_name RuntimeDevRuntimeCommands
extends RefCounted

const RuntimeJavaScriptRuntimeAdapterScript := preload("res://scripts/runtime/javascript_runtime_adapter.gd")

static func apply_dev_runtime_command(raw_command: Variant, deps: Dictionary) -> Dictionary:
	var command := normalize_runtime_command(raw_command)
	if command.has("__error"):
		return RuntimeJavaScriptRuntimeAdapterScript.failure_result("", "unknown", str(command.__error))
	var id := str(command.id)
	var type := str(command.type)

	match type:
		"captureSnapshot":
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:captureSnapshot"))
			return _ok(id, type, "snapshot captured")
		"debugClearEventTrace":
			deps.clearEventTrace.call()
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugClearEventTrace"))
			return _ok(id, type, "event trace cleared")
		"debugExecuteAction":
			var raw_action: Variant = command.get("action")
			if not raw_action is Dictionary:
				return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "runtime command action must be an object")
			var action_type := _optional_string(raw_action.get("type"))
			if action_type.is_empty():
				return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "runtime command action missing type")
			var params: Variant = raw_action.get("params", {})
			await deps.debugExecuteAction.call({"type": action_type, "params": params if params is Dictionary else {}})
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugExecuteAction"))
			return _ok(id, type, "action executed: %s" % action_type)
		"debugSetFixedTickMode":
			var enabled := _coerce_bool(command.get("enabled"), command.has("enabled"), true)
			deps.debugSetFixedTickMode.call(enabled)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugSetFixedTickMode"))
			return _ok(id, type, "fixed tick mode %s" % ("enabled" if enabled else "disabled"))
		"debugStepTicks":
			var ticks := _coerce_positive_int(command.get("ticks"), command.has("ticks"), 1)
			var dt_ms := minf(100.0, _coerce_positive_number(command.get("dtMs"), command.has("dtMs"), 1000.0 / 60.0))
			await deps.debugStepTicks.call(ticks, dt_ms)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugStepTicks"))
			return _ok(id, type, "stepped %s fixed tick(s) at %sms" % [ticks, dt_ms])
		"clearNarrativeTrace":
			deps.clearNarrativeTrace.call()
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:clearNarrativeTrace"))
			return _ok(id, type, "narrative trace cleared")
		"emitNarrativeSignal":
			var source_type := _required_string(command.get("sourceType"), "sourceType")
			if not source_type.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, source_type.message)
			var source_id := _required_string(command.get("sourceId"), "sourceId")
			if not source_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, source_id.message)
			var signal_name := _required_string(command.get("signal"), "signal")
			if not signal_name.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, signal_name.message)
			await deps.emitNarrativeSignal.call({"sourceType": source_type.value, "sourceId": source_id.value, "signal": signal_name.value})
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:emitNarrativeSignal"))
			return _ok(id, type, "signal emitted")
		"debugSetNarrativeState":
			var graph_id := _required_string(command.get("graphId"), "graphId")
			if not graph_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, graph_id.message)
			var state_id := _required_string(command.get("stateId"), "stateId")
			if not state_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, state_id.message)
			await deps.debugSetNarrativeState.call(graph_id.value, state_id.value)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugSetNarrativeState"))
			return _ok(id, type, "narrative state set for debug")
		"setFlag":
			var flag_key := _required_string(command.get("key"), "key")
			if not flag_key.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, flag_key.message)
			if deps.isFlagAllowed.call(flag_key.value) != true:
				return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "flag is not registered: %s" % flag_key.value)
			var flag_value := _coerce_flag_value(command.get("value"), str(deps.getFlagValueKind.call(flag_key.value)))
			if not flag_value.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, flag_value.message)
			deps.setFlag.call(flag_key.value, flag_value.value)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:setFlag"))
			return _ok(id, type, "flag set")
		"debugSetQuestStatus":
			var quest_id := _required_string(command.get("questId"), "questId")
			if not quest_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, quest_id.message)
			var quest_status := _coerce_quest_status(command.get("status"))
			if not quest_status.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, quest_status.message)
			deps.debugSetQuestStatus.call(quest_id.value, quest_status.value)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugSetQuestStatus"))
			return _ok(id, type, "quest status set for debug")
		"debugSetScenarioPhase":
			var scenario_id := _required_string(command.get("scenarioId"), "scenarioId")
			if not scenario_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, scenario_id.message)
			var phase := _required_string(command.get("phase"), "phase")
			if not phase.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, phase.message)
			var phase_status := _required_string(command.get("status"), "status")
			if not phase_status.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, phase_status.message)
			var payload := {"status": phase_status.value}
			if command.has("outcome"): payload["outcome"] = _coerce_scenario_outcome(command.outcome)
			deps.debugSetScenarioPhase.call(scenario_id.value, phase.value, payload)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugSetScenarioPhase"))
			return _ok(id, type, "scenario phase set for debug")
		"debugSetScenarioLineLifecycle":
			var lifecycle_scenario_id := _required_string(command.get("scenarioId"), "scenarioId")
			if not lifecycle_scenario_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, lifecycle_scenario_id.message)
			var lifecycle := _coerce_scenario_lifecycle(command.get("state"))
			if not lifecycle.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, lifecycle.message)
			deps.debugSetScenarioLineLifecycle.call(lifecycle_scenario_id.value, lifecycle.value)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugSetScenarioLineLifecycle"))
			return _ok(id, type, "scenario line lifecycle set for debug")
		"debugResetScenarioProgress":
			var reset_scenario_id := _required_string(command.get("scenarioId"), "scenarioId")
			if not reset_scenario_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, reset_scenario_id.message)
			deps.debugResetScenarioProgress.call(reset_scenario_id.value)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugResetScenarioProgress"))
			return _ok(id, type, "scenario progress reset for debug")
		"debugStartDialogueGraph":
			var dialogue_graph_id := _required_string(command.get("graphId"), "graphId")
			if not dialogue_graph_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, dialogue_graph_id.message)
			var request := {"graphId": dialogue_graph_id.value, "npcName": _optional_string(command.get("npcName"))}
			if str(request.npcName).is_empty(): request.npcName = dialogue_graph_id.value
			for field: String in ["entry", "npcId", "ownerType", "ownerId"]:
				var value := _optional_string(command.get(field))
				if not value.is_empty(): request[field] = value
			await deps.debugStartDialogueGraph.call(request)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugStartDialogueGraph"))
			return _ok(id, type, "dialogue graph started for debug")
		"debugAdvanceDialogue":
			var max_steps := _coerce_positive_int(command.get("maxSteps"), command.has("maxSteps"), 24)
			await deps.debugAdvanceDialogue.call(max_steps)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugAdvanceDialogue"))
			return _ok(id, type, "dialogue advanced for debug")
		"debugChooseDialogueOption":
			var choice := {}
			if command.has("index"):
				var choice_index := _coerce_non_negative_int(command.index, "index")
				if not choice_index.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, choice_index.message)
				choice["index"] = choice_index.value
			var choice_text := _optional_string(command.get("text"))
			if not choice_text.is_empty(): choice["text"] = choice_text
			if choice.is_empty(): return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "runtime command missing index or text")
			if await deps.debugChooseDialogueOption.call(choice) != true:
				return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "dialogue option did not match or is not enabled")
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugChooseDialogueOption"))
			return _ok(id, type, "dialogue option chosen for debug")
		"debugSwitchScene":
			var target_scene := _required_string(command.get("sceneId"), "sceneId")
			if not target_scene.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, target_scene.message)
			await deps.debugSwitchScene.call(target_scene.value, _optional_string(command.get("spawnPoint")))
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugSwitchScene"))
			return _ok(id, type, "scene switched for debug")
		"debugTriggerHotspot":
			var hotspot_id := _required_string(command.get("hotspotId"), "hotspotId")
			if not hotspot_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, hotspot_id.message)
			if await deps.debugTriggerHotspot.call(hotspot_id.value) != true:
				return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "hotspot not found or not triggerable: %s" % hotspot_id.value)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugTriggerHotspot"))
			return _ok(id, type, "hotspot triggered for debug")
		"debugInteractNpc":
			var npc_id := _required_string(command.get("npcId"), "npcId")
			if not npc_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, npc_id.message)
			if await deps.debugInteractNpc.call(npc_id.value) != true:
				return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "npc not found or not interactable: %s" % npc_id.value)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugInteractNpc"))
			return _ok(id, type, "npc interacted for debug")
		"debugWait":
			var wait_ms := _coerce_duration_ms(command.get("durationMs"), command.has("durationMs"), 500)
			await deps.debugWait.call(wait_ms)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugWait"))
			return _ok(id, type, "waited for debug")
		"debugSetPlayerPosition":
			var player_x := _coerce_finite_number(command.get("x"), "x")
			if not player_x.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, player_x.message)
			var player_y := _coerce_finite_number(command.get("y"), "y")
			if not player_y.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, player_y.message)
			var snap_camera := _coerce_bool(command.get("snapCamera"), command.has("snapCamera"), true)
			await deps.debugSetPlayerPosition.call(player_x.value, player_y.value, snap_camera)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugSetPlayerPosition"))
			return _ok(id, type, "player position set for debug")
		"debugMovePlayerTo":
			var move_x := _coerce_finite_number(command.get("x"), "x")
			if not move_x.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, move_x.message)
			var move_y := _coerce_finite_number(command.get("y"), "y")
			if not move_y.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, move_y.message)
			var move_speed := _coerce_positive_number(command.get("speed"), command.has("speed"), 180.0)
			var move_snap := _coerce_bool(command.get("snapCamera"), command.has("snapCamera"), true)
			await deps.debugMovePlayerTo.call(move_x.value, move_y.value, move_speed, move_snap)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugMovePlayerTo"))
			return _ok(id, type, "player moved for debug")
		"debugClick":
			var click_x := _coerce_finite_number(command.get("x"), "x")
			if not click_x.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, click_x.message)
			var click_y := _coerce_finite_number(command.get("y"), "y")
			if not click_y.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, click_y.message)
			await deps.debugClick.call(click_x.value, click_y.value)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugClick"))
			return _ok(id, type, "click dispatched for debug")
		"debugDrag":
			var from_x := _coerce_finite_number(command.get("fromX"), "fromX")
			if not from_x.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, from_x.message)
			var from_y := _coerce_finite_number(command.get("fromY"), "fromY")
			if not from_y.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, from_y.message)
			var to_x := _coerce_finite_number(command.get("toX"), "toX")
			if not to_x.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, to_x.message)
			var to_y := _coerce_finite_number(command.get("toY"), "toY")
			if not to_y.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, to_y.message)
			var drag_ms := _coerce_duration_ms(command.get("durationMs"), command.has("durationMs"), 350)
			await deps.debugDrag.call(from_x.value, from_y.value, to_x.value, to_y.value, drag_ms)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugDrag"))
			return _ok(id, type, "drag dispatched for debug")
		"debugSaveGame":
			var save_slot := _coerce_save_slot(command.get("slot"), command.has("slot"), 2)
			if not save_slot.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, save_slot.message)
			if deps.debugSaveGame.call(save_slot.value) != true:
				return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "save slot failed to write: %s" % save_slot.value)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugSaveGame:%s" % save_slot.value))
			return _ok(id, type, "game saved to slot %s" % save_slot.value)
		"debugLoadGame":
			var load_slot := _coerce_save_slot(command.get("slot"), command.has("slot"), 2)
			if not load_slot.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, load_slot.message)
			if await deps.debugLoadGame.call(load_slot.value) != true:
				return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "save slot not found or failed to load: %s" % load_slot.value)
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugLoadGame:%s" % load_slot.value))
			return _ok(id, type, "game loaded from slot %s" % load_slot.value)
		"debugReloadScene":
			await deps.debugReloadScene.call(_optional_string(command.get("sceneId")))
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:debugReloadScene"))
			return _ok(id, type, "scene reloaded for debug")
		"playerInteract":
			deps.playerInteract.call()
			await deps.captureSnapshot.call("runtime-command:playerInteract")
			return _ok(id, type, "player interact (E) injected")
		"playerAdvance":
			deps.playerAdvance.call()
			await deps.captureSnapshot.call("runtime-command:playerAdvance")
			return _ok(id, type, "player advance injected")
		"playerChoose":
			var player_choice := RuntimeJavaScriptRuntimeAdapterScript.number_direct(command.get("index")) if command.has("index") else {"ok": false}
			if not player_choice.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "index must be a non-negative number")
			player_choice.value = int(float(player_choice.value))
			if player_choice.value < 0: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "index must be a non-negative number")
			deps.playerChoose.call(player_choice.value)
			await deps.captureSnapshot.call("runtime-command:playerChoose")
			return _ok(id, type, "player choose option %s injected" % player_choice.value)
		"playerMoveTo":
			var nav_x := RuntimeJavaScriptRuntimeAdapterScript.number_direct(command.get("x")) if command.has("x") else {"ok": false}
			var nav_y := RuntimeJavaScriptRuntimeAdapterScript.number_direct(command.get("y")) if command.has("y") else {"ok": false}
			if not nav_x.ok or not nav_y.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "x and y must be numbers")
			deps.playerMoveTo.call(nav_x.value, nav_y.value)
			await deps.captureSnapshot.call("runtime-command:playerMoveTo")
			return _ok(id, type, "player move target set")
		"playerTap":
			deps.playerTap.call()
			await deps.captureSnapshot.call("runtime-command:playerTap")
			return _ok(id, type, "player tap (click/continue) injected")
		"setPlayerCollisions":
			var collisions_enabled: bool = command.get("enabled") != false
			deps.setPlayerCollisions.call(collisions_enabled)
			await deps.captureSnapshot.call("runtime-command:setPlayerCollisions")
			return _ok(id, type, "player collisions %s" % ("enabled" if collisions_enabled else "disabled (noclip)"))
		"activatePlane":
			var plane_id := _required_string(command.get("planeId"), "planeId")
			if not plane_id.ok: return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, plane_id.message)
			var applied: bool = deps.activatePlane.call(plane_id.value) == true
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:activatePlane"))
			if not applied:
				return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "plane rejected（未注册/无效 id）: %s" % plane_id.value)
			return _ok(id, type, "plane manual override set: %s" % plane_id.value)
		"deactivatePlane":
			deps.deactivatePlane.call()
			await deps.captureSnapshot.call(RuntimeJavaScriptRuntimeAdapterScript.truthy_string_or(command.get("reason"), "runtime-command:deactivatePlane"))
			return _ok(id, type, "plane manual override cleared")
		_:
			return RuntimeJavaScriptRuntimeAdapterScript.failure_result(id, type, "unsupported runtime command: %s" % type)


static func normalize_runtime_command(raw_command: Variant) -> Dictionary:
	if not raw_command is Dictionary:
		return {"__error": "runtime command must be an object"}
	var command: Dictionary = raw_command.duplicate()
	var type := _optional_string(command.get("type"))
	if type.is_empty():
		return {"__error": "runtime command missing type"}
	var id_value: Variant = command.get("id") if command.has("id") else null
	var id := "%s:%s" % [type, int(Time.get_unix_time_from_system() * 1000.0)] if id_value == null else _optional_string(id_value)
	command["id"] = id
	command["type"] = type
	return command


static func _ok(id: String, type: String, message: String) -> Dictionary:
	return {"id": id, "type": type, "ok": true, "message": message}


static func _required_string(value: Variant, label: String) -> Dictionary:
	var text := _optional_string(value)
	return {"ok": true, "value": text} if not text.is_empty() else {"ok": false, "message": "runtime command missing %s" % label}


static func _optional_string(value: Variant) -> String:
	return "" if value == null else str(value).strip_edges()


static func _coerce_flag_value(value: Variant, kind: String) -> Dictionary:
	if kind == "string":
		return {"ok": true, "value": RuntimeJavaScriptRuntimeAdapterScript.string_value(value)}
	if kind == "float":
		var number := RuntimeJavaScriptRuntimeAdapterScript.number_from_trimmed_string(value)
		return {"ok": true, "value": number.value} if number.ok else {"ok": false, "message": "flag value is not a finite number: %s" % RuntimeJavaScriptRuntimeAdapterScript.string_value(value)}
	if value is bool:
		return {"ok": true, "value": value}
	if value is int or value is float:
		return {"ok": true, "value": float(value) != 0.0}
	var text := _optional_string(value).to_lower()
	if text in ["true", "1", "yes", "on"]: return {"ok": true, "value": true}
	if text in ["false", "0", "no", "off"]: return {"ok": true, "value": false}
	return {"ok": false, "message": "flag value is not a boolean: %s" % RuntimeJavaScriptRuntimeAdapterScript.string_value(value)}


static func _coerce_quest_status(value: Variant) -> Dictionary:
	var text := _optional_string(value).to_lower()
	var numeric := float(value) if value is int or value is float else NAN
	if numeric == 2.0 or text in ["2", "completed", "complete", "done"]: return {"ok": true, "value": 2}
	if numeric == 1.0 or text in ["1", "active", "accepted", "accept"]: return {"ok": true, "value": 1}
	if numeric == 0.0 or text in ["0", "inactive", "pending", "none"]: return {"ok": true, "value": 0}
	return {"ok": false, "message": "quest status is not supported: %s" % RuntimeJavaScriptRuntimeAdapterScript.string_value(value)}


static func _coerce_scenario_lifecycle(value: Variant) -> Dictionary:
	var text := _optional_string(value).to_lower()
	if text in ["inactive", "pending", "none"]: return {"ok": true, "value": "inactive"}
	if text == "active": return {"ok": true, "value": "active"}
	if text in ["completed", "complete", "done"]: return {"ok": true, "value": "completed"}
	return {"ok": false, "message": "scenario lifecycle is not supported: %s" % RuntimeJavaScriptRuntimeAdapterScript.string_value(value)}


static func _coerce_scenario_outcome(value: Variant) -> Variant:
	if value == null or value is String or value is int or value is float or value is bool:
		return value
	return RuntimeJavaScriptRuntimeAdapterScript.string_value(value)


static func _coerce_positive_int(value: Variant, exists: bool, fallback: int) -> int:
	if not exists or value == null or _optional_string(value).is_empty(): return fallback
	var number := RuntimeJavaScriptRuntimeAdapterScript.number_from_trimmed_string(value)
	if not number.ok or float(number.value) <= 0.0: return fallback
	return clampi(int(float(number.value)), 1, 200)


static func _coerce_non_negative_int(value: Variant, label: String) -> Dictionary:
	var number := RuntimeJavaScriptRuntimeAdapterScript.number_from_trimmed_string(value)
	if not number.ok or float(number.value) < 0.0:
		return {"ok": false, "message": "runtime command %s is not a non-negative integer: %s" % [label, RuntimeJavaScriptRuntimeAdapterScript.string_value(value)]}
	return {"ok": true, "value": int(float(number.value))}


static func _coerce_finite_number(value: Variant, label: String) -> Dictionary:
	var number := RuntimeJavaScriptRuntimeAdapterScript.number_from_trimmed_string(value)
	return number if number.ok else {"ok": false, "message": "runtime command %s is not a finite number: %s" % [label, RuntimeJavaScriptRuntimeAdapterScript.string_value(value)]}


static func _coerce_positive_number(value: Variant, exists: bool, fallback: float) -> float:
	if not exists or value == null or _optional_string(value).is_empty(): return fallback
	var number := RuntimeJavaScriptRuntimeAdapterScript.number_from_trimmed_string(value)
	if not number.ok or float(number.value) <= 0.0: return fallback
	return minf(5000.0, float(number.value))


static func _coerce_duration_ms(value: Variant, exists: bool, fallback: int) -> int:
	return clampi(int(_coerce_positive_number(value, exists, float(fallback))), 1, 60000)


static func _coerce_save_slot(value: Variant, exists: bool, fallback: int) -> Dictionary:
	if not exists or value == null or _optional_string(value).is_empty(): return {"ok": true, "value": fallback}
	var number := RuntimeJavaScriptRuntimeAdapterScript.number_from_trimmed_string(value)
	if not number.ok or float(number.value) < 0.0 or float(number.value) > 2.0:
		return {"ok": false, "message": "save slot must be 0, 1, or 2: %s" % RuntimeJavaScriptRuntimeAdapterScript.string_value(value)}
	return {"ok": true, "value": int(float(number.value))}


static func _coerce_bool(value: Variant, exists: bool, fallback: bool) -> bool:
	if not exists or value == null or _optional_string(value).is_empty(): return fallback
	if value is bool: return value
	if value is int or value is float: return float(value) != 0.0
	var text := _optional_string(value).to_lower()
	if text in ["true", "1", "yes", "on"]: return true
	if text in ["false", "0", "no", "off"]: return false
	return fallback
