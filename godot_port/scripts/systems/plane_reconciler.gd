class_name RuntimePlaneReconciler
extends RuntimeSystem

const PLANES_URL := "/assets/data/planes.json"
const NORMAL_PLANE_ID := "normal"
const INHERITED_SLOTS := ["membership", "movement", "interaction", "camera", "lighting", "travel", "healthDrainPerSec"]

var _event_bus: RuntimeEventBus
var _asset_manager: RuntimeAssetManager
var _binding: Dictionary = {}
var _defs: Dictionary = {}
var _manual_override: Variant = null
var _manual_scope := "session"
var _in_cutscene := false
var _last_naming: Dictionary = {}
var _active_plane_id := NORMAL_PLANE_ID
var _camera_applied := false
var _drain_accum := 0.0
var _last_game_state: Variant = null
var _pending_zone_refresh := false


func _init(event_bus: RuntimeEventBus) -> void:
	_event_bus = event_bus


func init(ctx: Dictionary) -> void:
	_asset_manager = ctx.assetManager
	for event in ["narrative:stateChanged", "scene:ready", "scene:entitiesRebuilt", "save:restoring", "cutscene:start", "cutscene:end"]:
		_event_bus.off(event, Callable(self, "_on_event").bind(event))
		_event_bus.on(event, Callable(self, "_on_event").bind(event))
	_manual_override = null
	_manual_scope = "session"
	_in_cutscene = false
	_last_naming.clear()
	_active_plane_id = NORMAL_PLANE_ID
	_camera_applied = false
	_drain_accum = 0.0
	_last_game_state = null
	_pending_zone_refresh = false


func bind_runtime(binding: Dictionary) -> void:
	_binding = binding


func load_defs() -> bool:
	var defs: Variant = _asset_manager.load_json(PLANES_URL)
	if not defs is Array:
		return false
	register_defs(defs)
	return true


func register_defs(defs: Array) -> void:
	_defs.clear()
	var raw := {}
	for value: Variant in defs:
		if value is Dictionary and _validate_def(value):
			var definition: Dictionary = value.duplicate(true)
			definition.id = str(definition.id).strip_edges()
			raw[definition.id] = definition
	var cycle_members := _find_cycle_members(raw)
	var resolving := {}
	for id: String in raw:
		_resolve_definition(id, raw, cycle_members, resolving)


func update(dt: float) -> void:
	if _binding.is_empty():
		return
	var state: Variant = _call_binding("getGameState", [], RuntimeGameStateController.EXPLORING)
	if state != _last_game_state:
		var entered_exploring: bool = state == RuntimeGameStateController.EXPLORING and _last_game_state != null
		_last_game_state = state
		if entered_exploring:
			_apply_camera_slot()
			_apply_lighting_slot()
			if _pending_zone_refresh:
				_pending_zone_refresh = false
				_call_binding("refreshZonesForPlaneChange")
	if state != RuntimeGameStateController.EXPLORING:
		return
	var definition: Variant = _active_def()
	var drain: Variant = definition.get("healthDrainPerSec") if definition is Dictionary else null
	if (drain is int or drain is float) and is_finite(float(drain)) and float(drain) > 0.0:
		_drain_accum += float(drain) * dt
		if _drain_accum >= 1.0:
			var whole := int(floor(_drain_accum))
			_drain_accum -= whole
			_call_binding("damagePlayer", [whole])
	else:
		_drain_accum = 0.0


func get_active_plane_id() -> String:
	return _active_plane_id


func get_active_plane_membership() -> String:
	if _active_plane_id == NORMAL_PLANE_ID:
		return "shared"
	var definition: Variant = _active_def()
	return "exclusive" if definition is Dictionary and definition.get("membership") == "exclusive" else "shared"


func is_map_travel_allowed() -> bool:
	var definition: Variant = _active_def()
	return not (definition is Dictionary and definition.get("travel") is Dictionary and definition.travel.get("allowMapTravel") == false)


func get_active_camera_zoom() -> Variant:
	var definition: Variant = _active_def()
	var zoom: Variant = definition.get("camera", {}).get("zoom") if definition is Dictionary else null
	return float(zoom) if (zoom is int or zoom is float) and is_finite(float(zoom)) and float(zoom) > 0.0 else null


func activate_plane_manually(plane_id: String) -> bool:
	var id := plane_id.strip_edges()
	if id.is_empty() or (id != NORMAL_PLANE_ID and not _defs.has(id)):
		return false
	_manual_override = id
	_manual_scope = "cutscene" if _in_cutscene else "session"
	_recompute_active_and_reconcile_if_changed()
	return true


func deactivate_manual_plane() -> void:
	if _manual_override == null:
		return
	_manual_override = null
	_recompute_active_and_reconcile_if_changed()


func get_debug_state() -> Dictionary:
	var source := "manual" if _manual_override != null else ("narrative" if not _last_naming.is_empty() else "default")
	var named_by: Array = []
	for graph_id: String in _last_naming:
		named_by.push_back({"graphId": graph_id, "planeId": _last_naming[graph_id]})
	return {"activePlaneId": _active_plane_id, "source": source, "def": _active_def(), "namedBy": named_by}


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	_manual_override = null
	_recompute_naming_from_narrative()
	_recompute_active_plane_id()


func destroy() -> void:
	for event in ["narrative:stateChanged", "scene:ready", "scene:entitiesRebuilt", "save:restoring", "cutscene:start", "cutscene:end"]:
		_event_bus.off(event, Callable(self, "_on_event").bind(event))
	if not _binding.is_empty():
		_call_binding("setPlayerMovementModifier", [null])
		_call_binding("setPlaneInteractionPolicy", [null])
		_call_binding("applyPlaneLightEnvOverride", [null])
		if _camera_applied:
			_call_binding("restoreSceneCameraZoom")
	_binding.clear()
	_defs.clear()
	_last_naming.clear()
	_manual_override = null
	_manual_scope = "session"
	_in_cutscene = false
	_active_plane_id = NORMAL_PLANE_ID
	_camera_applied = false
	_drain_accum = 0.0
	_last_game_state = null
	_pending_zone_refresh = false


func definition_count() -> int:
	return _defs.size()


func debug_snapshot_fragment() -> Dictionary:
	return {"plane": get_debug_state()}


func _on_event(payload: Variant, event: String) -> void:
	match event:
		"narrative:stateChanged":
			if payload is Dictionary:
				var graph_id := str(payload.get("graphId", "")).strip_edges()
				if not graph_id.is_empty():
					_note_graph_state(graph_id, str(payload.get("to", "")).strip_edges())
					_recompute_active_and_reconcile_if_changed()
		"scene:ready":
			_recompute_naming_from_narrative()
			_recompute_active_plane_id()
			_reconcile()
		"scene:entitiesRebuilt":
			_call_binding("refreshEntitiesForPlaneChange")
		"save:restoring":
			_manual_override = null
		"cutscene:start":
			_in_cutscene = true
		"cutscene:end":
			_in_cutscene = false
			if _manual_override != null and _manual_scope == "cutscene":
				_manual_override = null
				_recompute_active_and_reconcile_if_changed()


func _note_graph_state(graph_id: String, state_id: String) -> void:
	var narrative: Variant = _binding.get("narrative")
	var plane := ""
	if narrative != null and narrative.has_method("get_graph"):
		var graph: Variant = narrative.call("get_graph", graph_id)
		if graph is Dictionary and graph.get("states") is Dictionary and graph.states.get(state_id) is Dictionary:
			plane = str(graph.states[state_id].get("activePlane", "")).strip_edges()
	_last_naming.erase(graph_id)
	if not plane.is_empty():
		_last_naming[graph_id] = plane


func _recompute_naming_from_narrative() -> void:
	_last_naming.clear()
	var narrative: Variant = _binding.get("narrative")
	if narrative == null or not narrative.has_method("get_graphs"):
		return
	for raw_graph: Variant in narrative.call("get_graphs"):
		if not raw_graph is Dictionary:
			continue
		var graph: Dictionary = raw_graph
		var state_id := str(narrative.call("get_active_state", graph.id))
		var state: Variant = graph.get("states", {}).get(state_id)
		var plane := str(state.get("activePlane", "")).strip_edges() if state is Dictionary else ""
		if not plane.is_empty():
			_last_naming[graph.id] = plane


func _recompute_active_plane_id() -> bool:
	var next := str(_manual_override) if _manual_override != null else ""
	if next.is_empty():
		for plane_id: Variant in _last_naming.values():
			next = str(plane_id)
	if next.is_empty():
		next = NORMAL_PLANE_ID
	if next == _active_plane_id:
		return false
	_active_plane_id = next
	_drain_accum = 0.0
	return true


func _recompute_active_and_reconcile_if_changed() -> void:
	if _recompute_active_plane_id():
		_reconcile()


func _active_def() -> Variant:
	return _defs.get(_active_plane_id)


func _reconcile() -> void:
	if _binding.is_empty():
		return
	_call_binding("refreshEntitiesForPlaneChange")
	if _call_binding("getGameState", [], RuntimeGameStateController.EXPLORING) == RuntimeGameStateController.EXPLORING:
		_pending_zone_refresh = false
		_call_binding("refreshZonesForPlaneChange")
	else:
		_pending_zone_refresh = true
	_apply_movement_slot()
	_apply_interaction_slot()
	_apply_camera_slot()
	_apply_lighting_slot()


func _apply_movement_slot() -> void:
	var definition: Variant = _active_def()
	var movement: Variant = definition.get("movement") if definition is Dictionary else null
	if not movement is Dictionary:
		_call_binding("setPlayerMovementModifier", [null])
		return
	var scale := _finite_number(movement.get("speedScale"), 1.0)
	var modifier := {
		"driftX": _finite_number(movement.get("driftX"), 0.0),
		"driftY": _finite_number(movement.get("driftY"), 0.0),
		"speedScale": scale if scale > 0.0 else 1.0,
		"allowRun": movement.get("allowRun") != false,
	}
	_call_binding("setPlayerMovementModifier", [func() -> Dictionary: return modifier])


func _apply_interaction_slot() -> void:
	var definition: Variant = _active_def()
	var interaction: Variant = definition.get("interaction") if definition is Dictionary else null
	if not interaction is Dictionary:
		_call_binding("setPlaneInteractionPolicy", [null])
		return
	var policy := {
		"canPickup": interaction.get("canPickup") != false,
		"canInteractHotspots": interaction.get("canInteractHotspots") != false,
		"canTalkNpcs": interaction.get("canTalkNpcs") != false,
	}
	_call_binding("setPlaneInteractionPolicy", [func() -> Dictionary: return policy])


func _apply_camera_slot() -> void:
	if _call_binding("getGameState", [], RuntimeGameStateController.EXPLORING) != RuntimeGameStateController.EXPLORING:
		return
	var zoom: Variant = get_active_camera_zoom()
	if zoom != null:
		_call_binding("setCameraZoom", [zoom])
		_camera_applied = true
	elif _camera_applied:
		_call_binding("restoreSceneCameraZoom")
		_camera_applied = false


func _apply_lighting_slot() -> void:
	var definition: Variant = _active_def()
	_call_binding("applyPlaneLightEnvOverride", [definition.get("lighting") if definition is Dictionary else null])


func _call_binding(name: String, args: Array = [], fallback: Variant = null) -> Variant:
	var callback: Variant = _binding.get(name)
	return callback.callv(args) if callback is Callable and callback.is_valid() else fallback


func _finite_number(value: Variant, fallback: float) -> float:
	return float(value) if (value is int or value is float) and is_finite(float(value)) else fallback


func _validate_def(definition: Dictionary) -> bool:
	var id := str(definition.get("id", "")).strip_edges()
	if id.is_empty(): return false
	if definition.has("extends") and (not definition.extends is String or definition.extends.strip_edges().is_empty()): return false
	if definition.has("membership") and definition.membership not in ["shared", "exclusive"]: return false
	if id == NORMAL_PLANE_ID and definition.get("membership") == "exclusive": return false
	var movement: Variant = definition.get("movement")
	if movement is Dictionary:
		for key in ["driftX", "driftY", "speedScale"]:
			if movement.has(key) and (not (movement[key] is int or movement[key] is float) or not is_finite(float(movement[key]))): return false
		if movement.has("speedScale") and float(movement.speedScale) <= 0.0: return false
		if movement.has("allowRun") and not movement.allowRun is bool: return false
	var zoom: Variant = definition.get("camera", {}).get("zoom") if definition.get("camera") is Dictionary else null
	if zoom != null and (not (zoom is int or zoom is float) or not is_finite(float(zoom)) or float(zoom) <= 0.0): return false
	var drain: Variant = definition.get("healthDrainPerSec")
	if drain != null and (not (drain is int or drain is float) or not is_finite(float(drain)) or float(drain) < 0.0): return false
	var travel: Variant = definition.get("travel")
	if travel != null and (not travel is Dictionary or (travel.has("allowMapTravel") and not travel.allowMapTravel is bool)): return false
	return true


func _find_cycle_members(raw: Dictionary) -> Dictionary:
	var result := {}
	for start: String in raw:
		var path: Array[String] = []
		var positions := {}
		var current := start
		while not current.is_empty() and raw.has(current) and not positions.has(current):
			positions[current] = path.size()
			path.push_back(current)
			current = str(raw[current].get("extends", "")).strip_edges()
		if positions.has(current):
			for index in range(int(positions[current]), path.size()):
				result[path[index]] = true
	return result


func _resolve_definition(id: String, raw: Dictionary, cycle_members: Dictionary, resolving: Dictionary) -> Variant:
	if _defs.has(id): return _defs[id]
	if not raw.has(id) or resolving.has(id): return null
	resolving[id] = true
	var flat: Dictionary = raw[id].duplicate(true)
	var parent_id := "" if cycle_members.has(id) else str(flat.get("extends", "")).strip_edges()
	if not parent_id.is_empty():
		var parent: Variant = _resolve_definition(parent_id, raw, cycle_members, resolving)
		if parent is Dictionary:
			for key: String in INHERITED_SLOTS:
				if not flat.has(key) and parent.has(key):
					flat[key] = parent[key]
	resolving.erase(id)
	_defs[id] = flat
	return flat
