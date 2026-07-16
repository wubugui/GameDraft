class_name RuntimePlaneReconciler
extends RuntimeSystem

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")
const RuntimePromiseObserverScript := preload("res://scripts/runtime/promise_observer.gd")

const PLANES_URL := "/assets/data/planes.json"
const NORMAL_PLANE_ID := "normal"
const INHERITED_SLOT_KEYS := ["membership", "movement", "interaction", "camera", "lighting", "travel", "healthDrainPerSec"]

var event_bus: RuntimeEventBus
var asset_manager: RuntimeAssetManager
var binding: Variant = null

var defs: Dictionary = {}
var manual_override_plane_id: Variant = null
var manual_override_scope := "session"
var in_cutscene := false
var last_naming: Dictionary = {}
var active_plane_id := NORMAL_PLANE_ID

var camera_applied := false
var drain_accum := 0.0
var last_game_state: Variant = null
var warned_unknown_plane_ids: Dictionary = {}
var pending_zone_refresh := false

var on_narrative_state_changed: Callable
var on_scene_ready: Callable
var on_entities_rebuilt: Callable
var on_save_restoring: Callable
var on_cutscene_start: Callable
var on_cutscene_end: Callable


func _init(next_event_bus: RuntimeEventBus) -> void:
	event_bus = next_event_bus
	on_narrative_state_changed = func(payload: Variant = null) -> void:
		var graph_value: Variant = payload.get("graphId") if payload is Dictionary else null
		var graph_id := str(graph_value).strip_edges() if graph_value != null else ""
		if graph_id.is_empty():
			return
		var to_value: Variant = payload.get("to") if payload is Dictionary else null
		var to := str(to_value).strip_edges() if to_value != null else ""
		_note_graph_state(graph_id, to)
		_recompute_active_and_reconcile_if_changed()
	on_scene_ready = func(_payload: Variant = null) -> void:
		_recompute_naming_from_narrative()
		_recompute_active_plane_id()
		_reconcile()
	on_entities_rebuilt = func(_payload: Variant = null) -> void:
		if binding is Dictionary:
			var refresh_entities: Callable = binding.refreshEntitiesForPlaneChange
			refresh_entities.call()
	on_save_restoring = func(_payload: Variant = null) -> void:
		manual_override_plane_id = null
	on_cutscene_start = func(_payload: Variant = null) -> void:
		in_cutscene = true
	on_cutscene_end = func(_payload: Variant = null) -> void:
		in_cutscene = false
		if manual_override_plane_id != null and manual_override_scope == "cutscene":
			manual_override_plane_id = null
			_recompute_active_and_reconcile_if_changed()


func init(ctx: Dictionary) -> void:
	asset_manager = ctx.assetManager
	event_bus.off("narrative:stateChanged", on_narrative_state_changed)
	event_bus.off("scene:ready", on_scene_ready)
	event_bus.off("scene:entitiesRebuilt", on_entities_rebuilt)
	event_bus.off("save:restoring", on_save_restoring)
	event_bus.off("cutscene:start", on_cutscene_start)
	event_bus.off("cutscene:end", on_cutscene_end)
	event_bus.on("narrative:stateChanged", on_narrative_state_changed)
	event_bus.on("scene:ready", on_scene_ready)
	event_bus.on("scene:entitiesRebuilt", on_entities_rebuilt)
	event_bus.on("save:restoring", on_save_restoring)
	event_bus.on("cutscene:start", on_cutscene_start)
	event_bus.on("cutscene:end", on_cutscene_end)
	manual_override_plane_id = null
	manual_override_scope = "session"
	in_cutscene = false
	last_naming.clear()
	active_plane_id = NORMAL_PLANE_ID
	camera_applied = false
	drain_accum = 0.0
	last_game_state = null
	warned_unknown_plane_ids.clear()
	pending_zone_refresh = false


func bind_runtime(next_binding: Dictionary) -> void:
	binding = next_binding


func load_defs() -> void:
	if asset_manager == null:
		push_warning("PlaneReconciler: loadDefs 前未 init（无 AssetManager）")
		return
	var definitions: Variant = asset_manager.load_json(PLANES_URL)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if definitions is Array:
		register_defs(definitions)
	elif not asset_manager.get_last_error().is_empty():
		push_warning("PlaneReconciler: planes.json not found")
	else:
		# Promise fulfilled with a non-array value: Array.isArray(defs) ? defs : [].
		register_defs([])


func register_defs(definitions: Array) -> void:
	defs.clear()
	var raw: Dictionary = {}
	for definition: Variant in definitions:
		if not _validate_def(definition):
			var display_id: Variant = definition.get("id") if definition is Dictionary else null
			push_warning("PlaneReconciler: 位面配置 \"%s\" 非法，已跳过" % str(display_id))
			continue
		raw[definition.id] = definition
	var expanded := _expand_extends(raw)
	for id: Variant in expanded:
		defs[id] = expanded[id]


static func _find_extends_cycle_members(raw: Dictionary) -> Dictionary:
	var on_cycle: Dictionary = {}
	var state: Dictionary = {}
	for raw_start: Variant in raw:
		var start := str(raw_start)
		if state.has(start):
			continue
		var path: Array[String] = []
		var current := start
		while not current.is_empty() and raw.has(current) and not state.has(current):
			state[current] = "visiting"
			path.push_back(current)
			var definition: Dictionary = raw[current]
			current = definition.extends.strip_edges() if definition.get("extends") is String else ""
		if not current.is_empty() and state.get(current) == "visiting":
			var cycle_start := path.find(current)
			if cycle_start >= 0:
				for index: int in range(cycle_start, path.size()):
					on_cycle[path[index]] = true
		for id: String in path:
			state[id] = "done"
	return on_cycle


func _expand_extends(raw: Dictionary) -> Dictionary:
	var cycle_members := _find_extends_cycle_members(raw)
	for raw_id: Variant in cycle_members:
		push_warning("PlaneReconciler: 位面 \"%s\" 的 extends 链存在环，已忽略继承" % str(raw_id))
	var output: Dictionary = {}
	# GDScript captures a local Callable by value, so a lambda cannot recursively
	# call the variable that receives it after construction. The box preserves the
	# source-local `resolve` function identity without promoting it to a class API.
	var resolve_box := {"callable": Callable()}
	resolve_box.callable = func(id: String, trail: Dictionary) -> Variant:
		var cached: Variant = output.get(id)
		if cached is Dictionary:
			return cached
		var definition: Variant = raw.get(id)
		if not definition is Dictionary:
			return null
		var flat: Dictionary = definition.duplicate(false)
		var parent_id := ""
		if not cycle_members.has(id) and definition.get("extends") is String:
			parent_id = definition.extends.strip_edges()
		if not parent_id.is_empty():
			if trail.has(id):
				push_warning("PlaneReconciler: 位面 \"%s\" 的 extends 链存在环，已忽略继承" % id)
			else:
				trail[id] = true
				var recursive_resolve: Callable = resolve_box.callable
				var parent: Variant = recursive_resolve.call(parent_id, trail)
				if not parent is Dictionary:
					push_warning("PlaneReconciler: 位面 \"%s\" extends 的父位面 \"%s\" 不存在，已忽略继承" % [id, parent_id])
				else:
					for key: String in INHERITED_SLOT_KEYS:
						if not flat.has(key) and parent.has(key):
							flat[key] = parent[key]
		output[id] = flat
		return flat
	var resolve: Callable = resolve_box.callable
	for raw_id: Variant in raw:
		resolve.call(str(raw_id), {})
	resolve = Callable()
	resolve_box.callable = Callable()
	return output


func update(dt: float) -> void:
	if not binding is Dictionary:
		return
	var get_game_state: Callable = binding.getGameState
	var state: Variant = get_game_state.call()
	if state != last_game_state:
		var entered_exploring: bool = state == RuntimeDataTypes.EXPLORING and last_game_state != null
		last_game_state = state
		if entered_exploring:
			_apply_camera_slot()
			_apply_lighting_slot()
			if pending_zone_refresh:
				pending_zone_refresh = false
				var refresh_zones: Callable = binding.refreshZonesForPlaneChange
				refresh_zones.call()
	if state != RuntimeDataTypes.EXPLORING:
		return
	var definition: Variant = _active_def()
	var drain: Variant = definition.get("healthDrainPerSec") if definition is Dictionary else null
	if (drain is int or drain is float) and is_finite(float(drain)) and float(drain) > 0.0:
		drain_accum += float(drain) * dt
		if drain_accum >= 1.0:
			var whole := int(floor(drain_accum))
			drain_accum -= whole
			RuntimePromiseObserverScript.observe(binding.damagePlayer, [whole], "PlaneReconciler: 掉阳气 damage 失败")
	else:
		drain_accum = 0.0


func get_active_plane_id() -> String:
	return active_plane_id


func get_active_plane_membership() -> String:
	if active_plane_id == NORMAL_PLANE_ID:
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
	if id.is_empty():
		push_warning("PlaneReconciler: activatePlane 需要非空 id")
		return false
	if id != NORMAL_PLANE_ID and not defs.has(id):
		push_warning("PlaneReconciler: activatePlane 未注册的位面 \"%s\"（planes.json），已忽略" % id)
		return false
	manual_override_plane_id = id
	manual_override_scope = "cutscene" if in_cutscene else "session"
	_recompute_active_and_reconcile_if_changed()
	return true


func deactivate_manual_plane() -> void:
	if manual_override_plane_id == null:
		return
	manual_override_plane_id = null
	_recompute_active_and_reconcile_if_changed()


func get_debug_state() -> Dictionary:
	var source := "default"
	if manual_override_plane_id != null:
		source = "manual"
	elif not last_naming.is_empty():
		source = "narrative"
	var named_by: Array = []
	for raw_graph_id: Variant in last_naming:
		var graph_id := str(raw_graph_id)
		named_by.push_back({"graphId": graph_id, "planeId": last_naming[raw_graph_id]})
	return {"activePlaneId": active_plane_id, "source": source, "def": _active_def(), "namedBy": named_by}


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	manual_override_plane_id = null
	_recompute_naming_from_narrative()
	_recompute_active_plane_id()


func destroy() -> void:
	event_bus.off("narrative:stateChanged", on_narrative_state_changed)
	event_bus.off("scene:ready", on_scene_ready)
	event_bus.off("scene:entitiesRebuilt", on_entities_rebuilt)
	event_bus.off("save:restoring", on_save_restoring)
	event_bus.off("cutscene:start", on_cutscene_start)
	event_bus.off("cutscene:end", on_cutscene_end)
	var owned_binding: Variant = binding
	if owned_binding is Dictionary:
		var set_movement: Callable = owned_binding.setPlayerMovementModifier
		var set_interaction: Callable = owned_binding.setPlaneInteractionPolicy
		var set_lighting: Callable = owned_binding.applyPlaneLightEnvOverride
		set_movement.call(null)
		set_interaction.call(null)
		set_lighting.call(null)
		if camera_applied:
			var restore_camera: Callable = owned_binding.restoreSceneCameraZoom
			restore_camera.call()
	binding = null
	defs.clear()
	last_naming.clear()
	manual_override_plane_id = null
	manual_override_scope = "session"
	in_cutscene = false
	active_plane_id = NORMAL_PLANE_ID
	camera_applied = false
	drain_accum = 0.0
	last_game_state = null
	warned_unknown_plane_ids.clear()
	pending_zone_refresh = false


func _state_plane_of(graph: Dictionary, state_id: String) -> Variant:
	var states: Variant = graph.get("states")
	var state: Variant = states.get(state_id) if states is Dictionary else null
	var raw_plane: Variant = state.get("activePlane") if state is Dictionary else null
	var plane: String = raw_plane.strip_edges() if raw_plane is String else ""
	return plane if not plane.is_empty() else null


func _note_graph_state(graph_id: String, state_id: String) -> void:
	var narrative: Variant = binding.get("narrative") if binding is Dictionary else null
	var graph: Variant = null
	if narrative != null:
		for candidate: Variant in narrative.get_graphs():
			if candidate is Dictionary and candidate.get("id") == graph_id:
				graph = candidate
				break
	var plane: Variant = _state_plane_of(graph, state_id) if graph is Dictionary and not state_id.is_empty() else null
	last_naming.erase(graph_id)
	if plane != null:
		last_naming[graph_id] = plane


func _recompute_naming_from_narrative() -> void:
	last_naming.clear()
	var narrative: Variant = binding.get("narrative") if binding is Dictionary else null
	if narrative == null:
		return
	var named: Array = []
	for raw_graph: Variant in narrative.get_graphs():
		if not raw_graph is Dictionary:
			continue
		var graph: Dictionary = raw_graph
		var state_id: Variant = narrative.get_active_state(str(graph.id))
		if state_id == null or str(state_id).is_empty():
			continue
		var plane: Variant = _state_plane_of(graph, str(state_id))
		if plane == null:
			continue
		named.push_back({"graphId": graph.id, "stateId": state_id, "planeId": plane})
		last_naming[graph.id] = plane
	var distinct_planes: Dictionary = {}
	for entry: Dictionary in named:
		distinct_planes[entry.planeId] = true
	if distinct_planes.size() > 1:
		push_error("PlaneReconciler: 多个叙事图同时点名了不同位面（后进者胜，请确认这些图互斥）：%s" % str(named))


func _recompute_active_plane_id() -> bool:
	var next: Variant = manual_override_plane_id
	if next == null or str(next).is_empty():
		next = null
		for plane_id: Variant in last_naming.values():
			next = plane_id
	var resolved := str(next) if next != null and not str(next).is_empty() else NORMAL_PLANE_ID
	if resolved != NORMAL_PLANE_ID and not defs.has(resolved) and not warned_unknown_plane_ids.has(resolved):
		warned_unknown_plane_ids[resolved] = true
		push_warning("PlaneReconciler: 激活位面 \"%s\" 未在 planes.json 注册（各槽按无配置处理）" % resolved)
	if resolved == active_plane_id:
		return false
	active_plane_id = resolved
	drain_accum = 0.0
	return true


func _recompute_active_and_reconcile_if_changed() -> void:
	if _recompute_active_plane_id():
		_reconcile()


func _active_def() -> Variant:
	return defs.get(active_plane_id)


func _reconcile() -> void:
	if not binding is Dictionary:
		return
	var refresh_entities: Callable = binding.refreshEntitiesForPlaneChange
	refresh_entities.call()
	var get_game_state: Callable = binding.getGameState
	if get_game_state.call() == RuntimeDataTypes.EXPLORING:
		pending_zone_refresh = false
		var refresh_zones: Callable = binding.refreshZonesForPlaneChange
		refresh_zones.call()
	else:
		pending_zone_refresh = true
	_apply_movement_slot()
	_apply_interaction_slot()
	_apply_camera_slot()
	_apply_lighting_slot()


func _apply_movement_slot() -> void:
	if not binding is Dictionary:
		return
	var definition: Variant = _active_def()
	var movement: Variant = definition.get("movement") if definition is Dictionary else null
	var set_movement: Callable = binding.setPlayerMovementModifier
	if not movement is Dictionary:
		set_movement.call(null)
		return
	var number := func(value: Variant, fallback: float) -> float:
		return float(value) if (value is int or value is float) and is_finite(float(value)) else fallback
	var scale: float = number.call(movement.get("speedScale"), 1.0)
	var modifier := {
		"driftX": number.call(movement.get("driftX"), 0.0),
		"driftY": number.call(movement.get("driftY"), 0.0),
		"speedScale": scale if scale > 0.0 else 1.0,
		"allowRun": movement.get("allowRun") != false,
	}
	set_movement.call(func() -> Dictionary: return modifier)


func _apply_interaction_slot() -> void:
	if not binding is Dictionary:
		return
	var definition: Variant = _active_def()
	var interaction: Variant = definition.get("interaction") if definition is Dictionary else null
	var set_interaction: Callable = binding.setPlaneInteractionPolicy
	if not interaction is Dictionary:
		set_interaction.call(null)
		return
	var policy := {
		"canPickup": interaction.get("canPickup") != false,
		"canInteractHotspots": interaction.get("canInteractHotspots") != false,
		"canTalkNpcs": interaction.get("canTalkNpcs") != false,
	}
	set_interaction.call(func() -> Dictionary: return policy)


func _apply_camera_slot() -> void:
	if not binding is Dictionary:
		return
	var get_game_state: Callable = binding.getGameState
	if get_game_state.call() != RuntimeDataTypes.EXPLORING:
		return
	var definition: Variant = _active_def()
	var zoom: Variant = definition.get("camera", {}).get("zoom") if definition is Dictionary else null
	if (zoom is int or zoom is float) and is_finite(float(zoom)) and float(zoom) > 0.0:
		var set_camera: Callable = binding.setCameraZoom
		set_camera.call(float(zoom))
		camera_applied = true
	elif camera_applied:
		var restore_camera: Callable = binding.restoreSceneCameraZoom
		restore_camera.call()
		camera_applied = false


func _apply_lighting_slot() -> void:
	if not binding is Dictionary:
		return
	var definition: Variant = _active_def()
	var lighting: Variant = definition.get("lighting") if definition is Dictionary else null
	var apply_lighting: Callable = binding.applyPlaneLightEnvOverride
	apply_lighting.call(lighting)


func _validate_def(definition: Variant) -> bool:
	if not definition is Dictionary:
		return false
	var raw_id: Variant = definition.get("id")
	if not raw_id is String or raw_id.strip_edges().is_empty():
		return false
	if definition.has("extends") and (not definition.extends is String or definition.extends.strip_edges().is_empty()):
		return false
	if definition.has("membership") and definition.membership not in ["shared", "exclusive"]:
		return false
	if raw_id.strip_edges() == NORMAL_PLANE_ID and definition.get("membership") == "exclusive":
		return false
	if definition.has("movement"):
		var movement: Variant = definition.get("movement")
		if not movement is Dictionary:
			return false
		for key: String in ["driftX", "driftY", "speedScale"]:
			var value: Variant = movement.get(key)
			if movement.has(key) and (not (value is int or value is float) or not is_finite(float(value))):
				return false
		if movement.has("speedScale") and float(movement.speedScale) <= 0.0:
			return false
		if movement.has("allowRun") and not movement.allowRun is bool:
			return false
	var camera: Variant = definition.get("camera")
	var zoom: Variant = camera.get("zoom") if camera is Dictionary else null
	if camera is Dictionary and camera.has("zoom") and (not (zoom is int or zoom is float) or not is_finite(float(zoom)) or float(zoom) <= 0.0):
		return false
	if definition.has("healthDrainPerSec"):
		var drain: Variant = definition.get("healthDrainPerSec")
		if not (drain is int or drain is float) or not is_finite(float(drain)) or float(drain) < 0.0:
			return false
	if definition.has("travel"):
		var travel: Variant = definition.get("travel")
		if not travel is Dictionary:
			return false
		if travel.has("allowMapTravel") and not travel.allowMapTravel is bool:
			return false
	return true
