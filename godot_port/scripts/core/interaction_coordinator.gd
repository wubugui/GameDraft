class_name RuntimeInteractionCoordinator
extends RefCounted

var event_bus: RuntimeEventBus
var state_controller: RuntimeGameStateController
var scene_manager: RuntimeSceneManager
var action_executor: RuntimeActionExecutor
var inspect_box: RuntimeInspectBox
var player: RuntimePlayer
var camera: RuntimeCamera
var _start_graph := Callable()
var _start_encounter := Callable()
var _hotspot_queue: Array = []
var _queue_running := false
var _bag_full := false
var _encounter_started := false
var _destroyed := false
var _dialogue_npc: RuntimeNpc
var _dialogue_camera_zoom: Variant = null
var _pending_graph_inspect: Dictionary = {}


func _init(events: RuntimeEventBus, state: RuntimeGameStateController, scenes: RuntimeSceneManager, actions: RuntimeActionExecutor, inspect: RuntimeInspectBox, next_player: RuntimePlayer, next_camera: RuntimeCamera) -> void:
	event_bus = events; state_controller = state; scene_manager = scenes; action_executor = actions; inspect_box = inspect; player = next_player; camera = next_camera


func init() -> void: event_bus.on("hotspot:triggered", Callable(self, "_on_hotspot_triggered")); event_bus.on("npc:interact", Callable(self, "_on_npc_interact")); event_bus.on("dialogue:end", Callable(self, "_on_dialogue_end"))
func set_graph_dialogue_starter(callback: Callable = Callable()) -> void: _start_graph = callback
func set_encounter_starter(callback: Callable = Callable()) -> void: _start_encounter = callback


func debug_trigger_hotspot_by_id(id: String) -> bool:
	var hotspot: Variant = scene_manager.get_hotspot_by_id(id.strip_edges()); if hotspot == null: return false
	await _handle_hotspot(hotspot, hotspot.def); return true


func debug_interact_npc_by_id(id: String) -> bool:
	var npc: Variant = scene_manager.get_npc_by_id(id.strip_edges()); if npc == null: return false
	await _handle_npc(npc); return true


func destroy() -> void:
	if _destroyed: return
	_destroyed = true; event_bus.off("hotspot:triggered", Callable(self, "_on_hotspot_triggered")); event_bus.off("npc:interact", Callable(self, "_on_npc_interact")); event_bus.off("dialogue:end", Callable(self, "_on_dialogue_end")); event_bus.off("inventory:full", Callable(self, "_on_inventory_full")); event_bus.off("encounter:start", Callable(self, "_on_encounter_started")); _cleanup_dialogue_npc(); _pending_graph_inspect.clear(); _hotspot_queue.clear(); _start_graph = Callable(); _start_encounter = Callable()


func _on_hotspot_triggered(payload: Variant) -> void:
	if not payload is Dictionary or not payload.get("hotspot") is RuntimeHotspot: return
	_hotspot_queue.push_back(payload)
	if not _queue_running: _drain_hotspot_queue()
func _drain_hotspot_queue() -> void:
	_queue_running = true
	while not _destroyed and not _hotspot_queue.is_empty():
		var payload: Dictionary = _hotspot_queue.pop_front(); await _handle_hotspot(payload.hotspot, payload.get("def", payload.hotspot.def))
	_queue_running = false


func _handle_hotspot(hotspot: RuntimeHotspot, definition: Dictionary) -> void:
	if state_controller.current_state != RuntimeGameStateController.EXPLORING or scene_manager.is_switching(): return
	event_bus.emit("hotspot:interact", {"hotspotId": str(definition.get("id", "")), "type": str(definition.get("type", ""))})
	var data: Variant = definition.get("data", {})
	if not data is Dictionary: return
	match str(definition.get("type", "")):
		"inspect": await _handle_inspect(hotspot, data)
		"pickup": await _handle_pickup(hotspot, data)
		"transition": await action_executor.execute_await({"type": "switchScene", "params": {"targetScene": data.get("targetScene"), "targetSpawnPoint": data.get("targetSpawnPoint")}})
		"encounter": await _handle_encounter(hotspot, data)


func _handle_inspect(hotspot: RuntimeHotspot, data: Dictionary) -> void:
	if not RuntimeInteractionSystem.hotspot_offers_player_interaction(hotspot.def): return
	var graph_id := str(data.get("graphId", "")).strip_edges()
	if not graph_id.is_empty():
		if _start_graph.is_null() or not _start_graph.is_valid(): return
		_pending_graph_inspect = {"hotspotId": hotspot.get_id(), "actions": data.get("actions", []).duplicate(true) if data.get("actions") is Array else []}
		state_controller.set_state(RuntimeGameStateController.DIALOGUE); var started: Variant = await _start_graph.call({"graphId": graph_id, "entry": str(data.get("entry", "")), "npcName": "旁白", "ownerType": "hotspot", "ownerId": hotspot.get_id(), "preferGraphMetaTitle": true})
		if started == false:
			_pending_graph_inspect.clear(); state_controller.set_state(RuntimeGameStateController.EXPLORING)
		return
	else:
		var text := str(data.get("text", ""))
		if not text.strip_edges().is_empty(): state_controller.set_state(RuntimeGameStateController.UI_OVERLAY); await inspect_box.show(text)
	event_bus.emit("hotspot:inspected", {"hotspotId": hotspot.get_id()}); await action_executor.execute_batch_await(data.get("actions", []) if data.get("actions") is Array else [])
	if state_controller.current_state in [RuntimeGameStateController.UI_OVERLAY, RuntimeGameStateController.DIALOGUE]: state_controller.set_state(RuntimeGameStateController.EXPLORING)


func _handle_pickup(hotspot: RuntimeHotspot, data: Dictionary) -> void:
	_bag_full = false; event_bus.on("inventory:full", Callable(self, "_on_inventory_full"))
	await action_executor.execute_await({"type": "pickup", "params": {"itemId": data.get("itemId"), "itemName": data.get("itemName"), "count": data.get("count"), "isCurrency": data.get("isCurrency")}})
	event_bus.off("inventory:full", Callable(self, "_on_inventory_full")); if _bag_full: return
	await action_executor.execute_await({"type": "setFlag", "params": {"key": "picked_up_%s" % hotspot.get_id(), "value": true}}); event_bus.emit("hotspot:pickup:done", {"hotspotId": hotspot.get_id()})


func _handle_encounter(hotspot: RuntimeHotspot, data: Dictionary) -> void:
	_encounter_started = false; event_bus.on("encounter:start", Callable(self, "_on_encounter_started"))
	if not _start_encounter.is_null() and _start_encounter.is_valid(): await _start_encounter.call(str(data.get("encounterId", "")))
	else: await action_executor.execute_await({"type": "startEncounter", "params": {"id": data.get("encounterId")}})
	event_bus.off("encounter:start", Callable(self, "_on_encounter_started")); if _encounter_started: event_bus.emit("hotspot:pickup:done", {"hotspotId": hotspot.get_id()})


func _handle_npc(npc: RuntimeNpc) -> void:
	if state_controller.current_state != RuntimeGameStateController.EXPLORING or _start_graph.is_null() or not _start_graph.is_valid(): return
	var graph_id := str(npc.def.get("dialogueGraphId", "")).strip_edges(); if graph_id.is_empty(): return
	player.play_animation("idle")
	player.set_facing(npc.get_x() - player.get_x(), npc.get_y() - player.get_y())
	npc.pause_patrol_and_face_for_dialogue(player.get_x(), player.get_y())
	_dialogue_npc = npc
	_dialogue_camera_zoom = camera.get_zoom()
	var requested_zoom: Variant = npc.def.get("dialogueCameraZoom")
	if (requested_zoom is int or requested_zoom is float) and float(requested_zoom) > camera.get_zoom():
		camera.set_zoom(float(requested_zoom))
	state_controller.set_state(RuntimeGameStateController.DIALOGUE)
	var started: Variant = await _start_graph.call({"graphId": graph_id, "entry": str(npc.def.get("dialogueGraphEntry", "")), "npcName": str(npc.def.get("name", "")), "npcId": npc.get_id(), "ownerType": "npc", "ownerId": npc.get_id()})
	if started == false: _cleanup_dialogue_npc(); state_controller.set_state(RuntimeGameStateController.EXPLORING)


func _on_npc_interact(payload: Variant) -> void:
	if payload is Dictionary and payload.get("npc") is RuntimeNpc: _handle_npc(payload.npc)
func _on_dialogue_end(payload: Variant) -> void:
	if not payload is Dictionary or payload.get("source") != "graph" or payload.get("willContinue") == true: return
	_cleanup_dialogue_npc()
	if not _pending_graph_inspect.is_empty():
		var pending := _pending_graph_inspect.duplicate(true); _pending_graph_inspect.clear(); event_bus.emit("hotspot:inspected", {"hotspotId": pending.hotspotId}); await action_executor.execute_batch_await(pending.actions)
	if state_controller.current_state == RuntimeGameStateController.DIALOGUE: state_controller.set_state(RuntimeGameStateController.EXPLORING)
func _cleanup_dialogue_npc() -> void:
	if _dialogue_npc != null and is_instance_valid(_dialogue_npc): _dialogue_npc.on_dialogue_end()
	_dialogue_npc = null
	if (_dialogue_camera_zoom is int or _dialogue_camera_zoom is float) and camera != null: camera.set_zoom(float(_dialogue_camera_zoom))
	_dialogue_camera_zoom = null
func _on_inventory_full(_payload: Variant = null) -> void: _bag_full = true
func _on_encounter_started(_payload: Variant = null) -> void: _encounter_started = true
