class_name RuntimeInteractionCoordinator
extends RefCounted

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const RuntimeHotspotInteractionScript := preload("res://scripts/runtime/hotspot_interaction.gd")
const NPC_DIALOGUE_CAMERA_ZOOM_MS := 550.0

var _event_bus: RuntimeEventBus
var _deps: Dictionary
var _bound_callbacks: Array[Dictionary] = []
var _hotspot_chain := RuntimeAsyncTail.new()


func _init(event_bus: RuntimeEventBus, deps: Dictionary) -> void:
	_event_bus = event_bus
	_deps = deps


func init() -> void:
	_listen("hotspot:triggered", func(payload: Variant) -> void:
		if not payload is Dictionary or not payload.get("hotspot") is RuntimeHotspot:
			return
		var job := func() -> void:
			await _handle_hotspot(payload.hotspot, payload.get("def", payload.hotspot.def))
		_hotspot_chain.then(job)
	)
	_listen("npc:interact", func(payload: Variant) -> void:
		if payload is Dictionary and payload.get("npc") is RuntimeNpc:
			_handle_npc(payload.npc)
	)


func _listen(event: String, callback: Callable) -> void:
	_event_bus.on(event, callback)
	_bound_callbacks.push_back({"event": event, "fn": callback})


func _handle_hotspot(hotspot: RuntimeHotspot, definition: Dictionary) -> void:
	var state_controller: RuntimeGameStateController = _deps.stateController
	var scene_manager: RuntimeSceneManager = _deps.sceneManager
	if state_controller.current_state != RuntimeDataTypes.EXPLORING:
		return
	if scene_manager.is_switching():
		return
	_event_bus.emit("hotspot:interact", {"hotspotId": str(definition.get("id", "")), "type": str(definition.get("type", ""))})
	var data: Variant = definition.get("data", {})
	if not data is Dictionary:
		return
	match str(definition.get("type", "")):
		"inspect":
			await _handle_inspect(hotspot, data)
		"pickup":
			await _handle_pickup(hotspot, data)
		"transition":
			await _handle_transition(data)
		"encounter":
			await _handle_encounter_trigger(hotspot, data)


func _handle_npc(npc: RuntimeNpc) -> void:
	var state_controller: RuntimeGameStateController = _deps.stateController
	var scene_manager: RuntimeSceneManager = _deps.sceneManager
	var dialogue_manager: RuntimeDialogueManager = _deps.dialogueManager
	var graph_dialogue_manager: Variant = _deps.graphDialogueManager
	var event_bus: RuntimeEventBus = _deps.eventBus
	if state_controller.current_state != RuntimeDataTypes.EXPLORING:
		return
	if dialogue_manager.is_active() or graph_dialogue_manager.is_active():
		return
	var graph_id := str(npc.def.get("dialogueGraphId", "")).strip_edges()
	if graph_id.is_empty():
		return
	_deps.preparePlayerForNpcDialogue.call(npc)
	var position: Dictionary = _deps.getPlayerWorldPos.call()
	npc.pause_patrol_and_face_for_dialogue(float(position.get("x", 0.0)), float(position.get("y", 0.0)))
	var raw_zoom: Variant = npc.def.get("dialogueCameraZoom")
	var scene_data := scene_manager.get_current_scene_data()
	var camera_config: Variant = scene_data.get("camera") if scene_data is Dictionary else null
	var scene_zoom: Variant = camera_config.get("zoom") if camera_config is Dictionary else null
	var scene_baseline := float(scene_zoom) if (scene_zoom is int or scene_zoom is float) and is_finite(float(scene_zoom)) and float(scene_zoom) > 0.0 else 1.0
	var candidate := float(raw_zoom) if (raw_zoom is int or raw_zoom is float) and is_finite(float(raw_zoom)) and float(raw_zoom) > 0.0 else 1.0
	var current_zoom := float(_deps.getCameraZoom.call())
	var target_zoom := maxf(current_zoom, maxf(candidate, scene_baseline))
	var dialogue_cleanup_done := [false]
	var on_dialogue_end: Callable
	var cleanup_dialogue_zoom_and_npc: Callable
	cleanup_dialogue_zoom_and_npc = func() -> void:
		if dialogue_cleanup_done[0]:
			return
		dialogue_cleanup_done[0] = true
		npc.on_dialogue_end()
		event_bus.off("dialogue:end", on_dialogue_end)
		_deps.fadingRestoreSceneCameraZoom.call(NPC_DIALOGUE_CAMERA_ZOOM_MS)
	on_dialogue_end = func(payload: Variant = null) -> void:
		if not payload is Dictionary or payload.get("source") != "graph" or payload.get("willContinue") == true:
			return
		cleanup_dialogue_zoom_and_npc.call()
	event_bus.on("dialogue:end", on_dialogue_end)
	if target_zoom != current_zoom:
		_deps.fadingDialogueCameraZoom.call(target_zoom, NPC_DIALOGUE_CAMERA_ZOOM_MS)
	state_controller.set_state(RuntimeDataTypes.DIALOGUE)
	var request := {
		"graphId": graph_id,
		"entry": str(npc.def.get("dialogueGraphEntry", "")).strip_edges(),
		"npcName": str(npc.def.get("name", "")),
		"npcId": npc.get_id(),
		"ownerType": "npc",
		"ownerId": npc.get_id(),
	}
	await graph_dialogue_manager.start_dialogue_graph(request)
	if not graph_dialogue_manager.is_active() and not graph_dialogue_manager.has_pending_chain_continuation():
		cleanup_dialogue_zoom_and_npc.call()
		state_controller.set_state(RuntimeDataTypes.EXPLORING)


func debug_trigger_hotspot_by_id(hotspot_id: String) -> bool:
	var id := hotspot_id.strip_edges()
	if id.is_empty():
		return false
	var hotspot: Variant = null
	for candidate: RuntimeHotspot in _deps.sceneManager.get_current_hotspots():
		if candidate.get_id() == id:
			hotspot = candidate
			break
	if hotspot == null:
		return false
	await _handle_hotspot(hotspot, hotspot.def)
	return true


func debug_interact_npc_by_id(npc_id: String) -> bool:
	var id := npc_id.strip_edges()
	if id.is_empty():
		return false
	var npc: Variant = _deps.sceneManager.get_npc_by_id(id)
	if npc == null:
		return false
	await _handle_npc(npc)
	return true


func _handle_inspect(hotspot: RuntimeHotspot, data: Dictionary) -> void:
	if not RuntimeHotspotInteractionScript.inspect_data_has_interactable_payload(data):
		return
	var graph_id := str(data.get("graphId", "")).strip_edges() if data.get("graphId") is String else ""
	if not graph_id.is_empty():
		await _handle_inspect_graph(hotspot, data, graph_id)
		return
	var state_controller: RuntimeGameStateController = _deps.stateController
	var inspect_box: RuntimeInspectBox = _deps.inspectBox
	var event_bus: RuntimeEventBus = _deps.eventBus
	var action_executor: RuntimeActionExecutor = _deps.actionExecutor
	var text := str(data.get("text", "")) if data.get("text") is String else ""
	if not text.strip_edges().is_empty():
		state_controller.set_state(RuntimeDataTypes.UI_OVERLAY)
		await inspect_box.show(text)
	event_bus.emit("hotspot:inspected", {"hotspotId": hotspot.get_id()})
	if data.get("actions") is Array:
		await action_executor.execute_batch_await(data.actions)
	if state_controller.current_state == RuntimeDataTypes.UI_OVERLAY:
		state_controller.set_state(RuntimeDataTypes.EXPLORING)


func _handle_inspect_graph(hotspot: RuntimeHotspot, data: Dictionary, graph_id: String) -> void:
	var state_controller: RuntimeGameStateController = _deps.stateController
	var graph_dialogue_manager: Variant = _deps.graphDialogueManager
	var event_bus: RuntimeEventBus = _deps.eventBus
	var action_executor: RuntimeActionExecutor = _deps.actionExecutor
	if state_controller.current_state != RuntimeDataTypes.EXPLORING:
		return
	if graph_dialogue_manager.is_active():
		return
	var cleanup_done := [false]
	var on_dialogue_end: Callable
	on_dialogue_end = func(payload: Variant = null) -> void:
		if not payload is Dictionary or payload.get("source") != "graph" or payload.get("willContinue") == true:
			return
		if cleanup_done[0]:
			return
		cleanup_done[0] = true
		event_bus.off("dialogue:end", on_dialogue_end)
		event_bus.emit("hotspot:inspected", {"hotspotId": hotspot.get_id()})
		var finish_inspect := func() -> void:
			if data.get("actions") is Array and not data.actions.is_empty():
				await action_executor.execute_batch_await(data.actions)
			if state_controller.current_state == RuntimeDataTypes.DIALOGUE:
				state_controller.set_state(RuntimeDataTypes.EXPLORING)
		finish_inspect.call()
	event_bus.on("dialogue:end", on_dialogue_end)
	state_controller.set_state(RuntimeDataTypes.DIALOGUE)
	var request := {
		"graphId": graph_id,
		"entry": str(data.get("entry", "")).strip_edges(),
		"npcName": "旁白",
		"ownerType": "hotspot",
		"ownerId": hotspot.get_id(),
		"preferGraphMetaTitle": true,
	}
	await graph_dialogue_manager.start_dialogue_graph(request)
	if not graph_dialogue_manager.is_active() and not graph_dialogue_manager.has_pending_chain_continuation():
		if not cleanup_done[0]:
			cleanup_done[0] = true
			event_bus.off("dialogue:end", on_dialogue_end)
		state_controller.set_state(RuntimeDataTypes.EXPLORING)


func _handle_pickup(hotspot: RuntimeHotspot, data: Dictionary) -> void:
	var action_executor: RuntimeActionExecutor = _deps.actionExecutor
	var event_bus: RuntimeEventBus = _deps.eventBus
	var bag_full := [false]
	var on_full := func(_payload: Variant = null) -> void: bag_full[0] = true
	event_bus.on("inventory:full", on_full)
	var picked_up: Variant = await action_executor.execute_await({
		"type": "pickup",
		"params": {"itemId": data.get("itemId"), "itemName": data.get("itemName"), "count": data.get("count"), "isCurrency": data.get("isCurrency")},
	})
	event_bus.off("inventory:full", on_full)
	if picked_up == false or bag_full[0]:
		return
	if not await action_executor.execute_await({"type": "setFlag", "params": {"key": RuntimeFlagKeys.hotspot_picked_up(hotspot.get_id()), "value": true}}):
		return
	event_bus.emit("hotspot:pickup:done", {"hotspotId": hotspot.get_id()})


func _handle_encounter_trigger(hotspot: RuntimeHotspot, data: Dictionary) -> void:
	var action_executor: RuntimeActionExecutor = _deps.actionExecutor
	var event_bus: RuntimeEventBus = _deps.eventBus
	var encounter_started := [false]
	var on_encounter_start := func(_payload: Variant = null) -> void: encounter_started[0] = true
	event_bus.on("encounter:start", on_encounter_start)
	await action_executor.execute_await({"type": "startEncounter", "params": {"id": data.get("encounterId")}})
	event_bus.off("encounter:start", on_encounter_start)
	if encounter_started[0]:
		event_bus.emit("hotspot:pickup:done", {"hotspotId": hotspot.get_id()})


func _handle_transition(data: Dictionary) -> void:
	await _deps.actionExecutor.execute_await({
		"type": "switchScene",
		"params": {"targetScene": data.get("targetScene"), "targetSpawnPoint": data.get("targetSpawnPoint")},
	})


func destroy() -> void:
	for binding: Dictionary in _bound_callbacks:
		_event_bus.off(str(binding.event), binding.fn)
	_bound_callbacks.clear()
	_hotspot_chain = RuntimeAsyncTail.new()
