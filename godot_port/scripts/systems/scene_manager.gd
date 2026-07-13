class_name RuntimeSceneManager
extends RuntimeSystem

const BACKGROUND_RESAMPLE_SHADER := preload("res://scripts/rendering/background_resample.gdshader")
const BACKGROUND_RESAMPLE_RADIUS_SCALE := 1.0

signal scene_entry_completed(scene_id: String, epoch: int)

var asset_manager: RuntimeAssetManager
var event_bus: RuntimeEventBus
var renderer: RuntimeRenderer
var player: RuntimePlayer
var camera: RuntimeCamera

var current_scene: Dictionary = {}
var current_hotspots: Array[RuntimeHotspot] = []
var current_npcs: Array[RuntimeNpc] = []
var scene_background: Node2D
var character_registry: Dictionary = {}
var diagnostics := {"backgroundFailures": [], "npcSpriteFailures": [], "hotspotImageFailures": []}
var scene_memory: Dictionary = {}
var entity_session_overrides: Dictionary = {}
var _switching := false
var _interaction_setter := Callable()
var _zone_setter := Callable()
var _audio_applier := Callable()
var _patrol_states: Dictionary = {}
var zone_session_disabled: Dictionary = {}
var _destroyed := false
var _scene_enter_runner := Callable()
var _scene_reveal_runner := Callable()
var _zone_actions_waiter := Callable()
var _scene_enter_batch_depth := 0
var _pending_reentrant_switch: Variant = null
var _scene_entry_epoch := 0
var _scene_entry_running_epoch := 0
var _scene_switch_queue: Array[Dictionary] = []
var _scene_switch_queue_running := false
var _active_scene_switch_request: Variant = null
var active_cutscene_binding_id: Variant = null
var cutscene_staging: Variant = null
var scene_depth_system: RuntimeSceneDepthSystem
var _active_plane_getter := Callable()


func _init(next_assets: RuntimeAssetManager, next_events: RuntimeEventBus, next_renderer: RuntimeRenderer, next_player: RuntimePlayer, next_camera: RuntimeCamera) -> void:
	asset_manager = next_assets; event_bus = next_events; renderer = next_renderer; player = next_player; camera = next_camera


func init(_ctx: Dictionary) -> void:
	var raw: Variant = asset_manager.load_json("/assets/data/character_registry.json")
	character_registry = RuntimeNpc.build_character_registry(raw)
	event_bus.on("hotspot:pickup:done", Callable(self, "_on_hotspot_picked_up"))
	event_bus.on("hotspot:inspected", Callable(self, "_on_hotspot_inspected"))


func load_scene(scene_id: String, spawn_point_id := "", camera_position: Variant = null, from_scene_id: Variant = null, run_entry: bool = true, already_unloaded: bool = false) -> bool:
	var id := scene_id.strip_edges()
	if id.is_empty(): return false
	var raw: Variant = asset_manager.load_json(asset_manager.locator.scene_json_url(id))
	if not raw is Dictionary: return false
	var scene: Dictionary = raw.duplicate(true)
	if str(scene.get("id", "")) != id: return false
	var backgrounds: Variant = scene.get("backgrounds", [])
	if not backgrounds is Array: return false
	if not backgrounds.is_empty() and str(backgrounds[0].get("image", "")) != "background.png": return false
	if not already_unloaded: unload_scene()
	diagnostics = {"backgroundFailures": [], "npcSpriteFailures": [], "hotspotImageFailures": []}
	current_scene = scene
	var committed_memory := _ensure_committed_memory(id)
	var staging_memory: Variant = cutscene_staging.memory if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == id else null
	scene_background = Node2D.new(); scene_background.name = "SceneBackground:%s" % id; renderer.background_layer.add_child(scene_background)
	var first_texture: Texture2D
	for index in backgrounds.size():
		var layer: Variant = backgrounds[index]
		if not layer is Dictionary: continue
		var path := asset_manager.locator.scene_runtime_asset_url(id, str(layer.get("image", "")))
		layer.image = path
		var texture: Variant = asset_manager.load_texture(path)
		if not texture is Texture2D:
			diagnostics.backgroundFailures.push_back({"sceneId": id, "path": path}); continue
		if index == 0: first_texture = texture
	_resolve_world_size(scene, first_texture)
	_mount_background_layers(scene, backgrounds)
	if backgrounds.is_empty(): _mount_placeholder_background(scene)
	if scene_depth_system != null:
		scene_depth_system.load_scene(id, scene, first_texture)
	var filter_id := str(scene.get("filterId", "")).strip_edges()
	if filter_id.is_empty() or not renderer.load_and_set_world_filter(filter_id):
		renderer.clear_world_filter()
	for definition: Variant in scene.get("hotspots", []):
		if not definition is Dictionary: continue
		var bound := _is_bound_to_cutscene(definition, active_cutscene_binding_id); if _is_cutscene_only(definition) and not bound: continue
		var memory: Dictionary = staging_memory if bound and staging_memory is Dictionary else committed_memory
		var hotspot_id := str(definition.get("id", "")); if not bound and memory.pickedUpHotspots.has(hotspot_id): continue
		var override: Variant = memory.entityOverrides.hotspots.get(hotspot_id)
		if override is Dictionary and override.get("enabled") == false: continue
		var effective := RuntimeHotspot.apply_runtime_override(definition, override); var hotspot := RuntimeHotspot.new(effective); _apply_session_override("hotspot", hotspot_id, hotspot); renderer.entity_layer.add_child(hotspot.container)
		if effective.get("displayImage") is Dictionary and not hotspot.load_display_image(asset_manager): diagnostics.hotspotImageFailures.push_back({"sceneId": id, "id": hotspot_id})
		current_hotspots.push_back(hotspot)
	for definition: Variant in scene.get("npcs", []):
		if not definition is Dictionary: continue
		var bound := _is_bound_to_cutscene(definition, active_cutscene_binding_id); if _is_cutscene_only(definition) and not bound: continue
		var memory: Dictionary = staging_memory if bound and staging_memory is Dictionary else committed_memory
		var npc_id := str(definition.get("id", "")); var override: Variant = memory.entityOverrides.npcs.get(npc_id)
		var merged := RuntimeNpc.apply_runtime_override(RuntimeNpc.apply_character_defaults(definition, character_registry), override); var npc := RuntimeNpc.new(merged); _apply_session_override("npc", npc_id, npc)
		if override is Dictionary and override.get("enabled") == false: npc.set_derived_base_visible(false)
		if not str(merged.get("animFile", "")).is_empty() and not npc.load_sprite_from_path(str(merged.animFile), asset_manager, str(merged.get("initialAnimState", ""))): diagnostics.npcSpriteFailures.push_back({"sceneId": id, "id": str(merged.get("id", "")), "error": asset_manager.last_error})
		if override is Dictionary and not str(override.get("animState", "")).strip_edges().is_empty(): npc.play_animation(str(override.animState))
		renderer.entity_layer.add_child(npc.container); current_npcs.push_back(npc)
	for npc: RuntimeNpc in current_npcs:
		if npc.container.visible and not is_npc_patrol_persistently_disabled(npc.get_id()) and not (active_cutscene_binding_id != null and _is_bound_to_cutscene(npc.def, active_cutscene_binding_id)): start_npc_patrol(npc.get_id())
	_apply_spawn_and_camera(scene, spawn_point_id, camera_position)
	# TypeScript 在 scene:loaded 装配实体滤镜；固定时钟下不能等下一次自然帧，
	# 因此场景提交时立即用 dt=0 落地同一份像素密度/光照材质状态。
	if scene_depth_system != null: scene_depth_system.update(0.0)
	if not _audio_applier.is_null() and _audio_applier.is_valid(): _audio_applier.call(scene.get("bgm"), scene.get("ambientSounds", []))
	if not _interaction_setter.is_null() and _interaction_setter.is_valid(): _interaction_setter.call(current_hotspots, current_npcs)
	if not _zone_setter.is_null() and _zone_setter.is_valid(): _zone_setter.call(_effective_zones(scene))
	event_bus.emit("scene:enter", {"sceneId": id, "fromSceneId": from_scene_id, "sceneName": str(scene.get("name", id))})
	event_bus.emit("scene:ready")
	if run_entry: _start_scene_entry(id, scene.get("onEnter"))
	return true


func unload_scene() -> void:
	_scene_entry_epoch += 1
	_scene_entry_running_epoch = 0
	if scene_depth_system != null: scene_depth_system.unload()
	if current_scene.is_empty() and scene_background == null:
		return
	if not current_scene.is_empty(): event_bus.emit("scene:beforeUnload")
	if not _interaction_setter.is_null() and _interaction_setter.is_valid(): _interaction_setter.call([], [])
	if not _zone_setter.is_null() and _zone_setter.is_valid(): _zone_setter.call([])
	for hotspot: RuntimeHotspot in current_hotspots: hotspot.destroy_hotspot()
	for npc: RuntimeNpc in current_npcs: npc.destroy_npc()
	current_hotspots.clear(); current_npcs.clear(); _patrol_states.clear()
	if scene_background != null and is_instance_valid(scene_background):
		if scene_background.get_parent() != null: scene_background.get_parent().remove_child(scene_background)
		scene_background.free()
	scene_background = null; current_scene.clear()


func get_current_scene_data() -> Dictionary: return current_scene
func get_current_scene_id() -> String: return str(current_scene.get("id", ""))


func get_debug_render_state() -> Dictionary:
	var backgrounds: Array = []
	if scene_background != null:
		for child: Node in scene_background.get_children():
			if not child is Sprite2D: continue
			var sprite: Sprite2D = child
			backgrounds.push_back({
				"x": sprite.position.x,
				"y": sprite.position.y,
				"scaleX": sprite.scale.x,
				"scaleY": sprite.scale.y,
				"textureWidth": sprite.texture.get_width() if sprite.texture != null else 0,
				"textureHeight": sprite.texture.get_height() if sprite.texture != null else 0,
			})
	return {"filterId": current_scene.get("filterId"), "backgrounds": backgrounds}


func get_debug_entity_visual_state() -> Array:
	var result: Array = []
	for npc: RuntimeNpc in current_npcs: result.push_back(npc.get_debug_visual_state())
	result.sort_custom(func(left: Dictionary, right: Dictionary) -> bool: return str(left.id) < str(right.id))
	return result


func reset_entity_animation_clocks() -> void:
	for npc: RuntimeNpc in current_npcs: npc.reset_animation_clock()


func get_current_npcs() -> Array[RuntimeNpc]: return current_npcs
func get_current_hotspots() -> Array[RuntimeHotspot]: return current_hotspots
func get_npc_by_id(id: String) -> Variant:
	for npc: RuntimeNpc in current_npcs:
		if npc.get_id() == id: return npc
	return null
func get_hotspot_by_id(id: String) -> Variant:
	for hotspot: RuntimeHotspot in current_hotspots:
		if hotspot.get_id() == id: return hotspot
	return null
func get_diagnostics() -> Dictionary: return diagnostics.duplicate(true)
func set_interaction_setter(callback: Callable = Callable()) -> void: _interaction_setter = callback
func set_zone_setter(callback: Callable = Callable()) -> void: _zone_setter = callback
func set_audio_applier(callback: Callable = Callable()) -> void: _audio_applier = callback
func set_scene_enter_runner(callback: Callable = Callable()) -> void: _scene_enter_runner = callback
func set_scene_reveal_runner(callback: Callable = Callable()) -> void: _scene_reveal_runner = callback
func set_zone_actions_waiter(callback: Callable = Callable()) -> void: _zone_actions_waiter = callback
func set_scene_depth_system(system: RuntimeSceneDepthSystem) -> void: scene_depth_system = system
func set_active_plane_getter(callback: Callable = Callable()) -> void: _active_plane_getter = callback
func is_scene_enter_running() -> bool: return _scene_entry_running_epoch != 0
func get_hotspot_base_enabled_for_interaction(hotspot: RuntimeHotspot) -> bool:
	if not is_entity_in_active_plane(hotspot.def): return false
	if _is_cutscene_only(hotspot.def): return _is_bound_to_cutscene(hotspot.def, active_cutscene_binding_id)
	var value: Variant = get_entity_runtime_override(get_current_scene_id(), "hotspot", hotspot.get_id()); return not (value is Dictionary and value.get("enabled") == false)
func get_npc_base_visible_for_interaction(npc: RuntimeNpc) -> bool:
	if not is_entity_in_active_plane(npc.def): return false
	if _is_cutscene_only(npc.def): return _is_bound_to_cutscene(npc.def, active_cutscene_binding_id)
	var value: Variant = get_entity_runtime_override(get_current_scene_id(), "npc", npc.get_id()); return not (value is Dictionary and value.get("enabled") == false)
func is_switching() -> bool: return _switching
func get_active_cutscene_binding_id() -> Variant: return active_cutscene_binding_id


func is_entity_in_active_plane(definition: Dictionary) -> bool:
	var active: Variant = _active_plane_getter.call() if _active_plane_getter.is_valid() else {"id": "normal", "membership": "shared"}
	if not active is Dictionary: active = {"id": "normal", "membership": "shared"}
	var planes: Variant = definition.get("planes")
	if not planes is Array or planes.is_empty(): return str(active.get("membership", "shared")) == "shared"
	return planes.has(str(active.get("id", "normal")))


func refresh_entities_for_plane_change(scene_id: String) -> void:
	if scene_id.strip_edges() != get_current_scene_id(): return
	for hotspot: RuntimeHotspot in current_hotspots: hotspot.set_derived_base_enabled(get_hotspot_base_enabled_for_interaction(hotspot))
	for npc: RuntimeNpc in current_npcs: npc.set_derived_base_visible(get_npc_base_visible_for_interaction(npc))
	if _interaction_setter.is_valid(): _interaction_setter.call(current_hotspots, current_npcs)


func refresh_zones_for_plane_change(scene_id: String) -> void: _refresh_zones(scene_id.strip_edges())


func begin_cutscene_staging(cutscene_id: String, scene_id: String) -> bool:
	var cid := cutscene_id.strip_edges(); var sid := scene_id.strip_edges(); if cid.is_empty() or sid.is_empty(): return false
	cutscene_staging = {"cutsceneId": cid, "sceneId": sid, "memory": _empty_memory()}; active_cutscene_binding_id = cid; return true


func end_cutscene_staging() -> void:
	cutscene_staging = null; active_cutscene_binding_id = null


func enter_cutscene_instances_for_current(cutscene_id: String) -> bool:
	if not _scene_has_cutscene_binding(current_scene, cutscene_id): return true
	var scene_id := get_current_scene_id(); var rebuilt_hotspots: Array[String] = []; var rebuilt_npcs: Array[String] = []
	var staging_memory: Dictionary = cutscene_staging.memory if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == scene_id else _empty_memory()
	for definition: Variant in current_scene.get("hotspots", []):
		if not definition is Dictionary or not _is_bound_to_cutscene(definition, cutscene_id): continue
		_remove_hotspot_instance(str(definition.get("id", "")))
		var hotspot: Variant = _instantiate_hotspot_from_memory(definition, staging_memory, false)
		if hotspot != null: rebuilt_hotspots.push_back(hotspot.get_id())
	for definition: Variant in current_scene.get("npcs", []):
		if not definition is Dictionary or not _is_bound_to_cutscene(definition, cutscene_id): continue
		_remove_npc_instance(str(definition.get("id", "")))
		var npc: Variant = _instantiate_npc_from_memory(definition, staging_memory)
		if npc != null: rebuilt_npcs.push_back(npc.get_id())
	_finish_cutscene_entity_rebuild(cutscene_id, "enter", rebuilt_hotspots, rebuilt_npcs)
	return true


func exit_cutscene_instances_for_current(cutscene_id: String) -> bool:
	if not _scene_has_cutscene_binding(current_scene, cutscene_id): return true
	var scene_id := get_current_scene_id(); var committed_memory := _ensure_committed_memory(scene_id); var rebuilt_hotspots: Array[String] = []; var rebuilt_npcs: Array[String] = []
	active_cutscene_binding_id = null
	for definition: Variant in current_scene.get("hotspots", []):
		if not definition is Dictionary or not _is_bound_to_cutscene(definition, cutscene_id): continue
		_remove_hotspot_instance(str(definition.get("id", "")))
		if not _is_cutscene_only(definition):
			var hotspot: Variant = _instantiate_hotspot_from_memory(definition, committed_memory, true)
			if hotspot != null: rebuilt_hotspots.push_back(hotspot.get_id())
	for definition: Variant in current_scene.get("npcs", []):
		if not definition is Dictionary or not _is_bound_to_cutscene(definition, cutscene_id): continue
		_remove_npc_instance(str(definition.get("id", "")))
		if not _is_cutscene_only(definition):
			var npc: Variant = _instantiate_npc_from_memory(definition, committed_memory)
			if npc != null: rebuilt_npcs.push_back(npc.get_id())
	_finish_cutscene_entity_rebuild(cutscene_id, "exit", rebuilt_hotspots, rebuilt_npcs)
	return true


func switch_scene(scene_id: String, spawn_point_id := "", camera_position: Variant = null) -> bool:
	var target := scene_id.strip_edges()
	if target.is_empty(): return false
	if _scene_enter_batch_depth > 0:
		_pending_reentrant_switch = {"targetSceneId": target, "spawnPointId": spawn_point_id, "cameraPosition": camera_position}
		return true
	if target == get_current_scene_id():
		if spawn_point_id.strip_edges().is_empty() and not camera_position is Dictionary: return true
		_apply_spawn_and_camera(current_scene, spawn_point_id, camera_position); return true
	if _switching: return false
	_switching = true; var from_id: Variant = get_current_scene_id() if not current_scene.is_empty() else null
	event_bus.emit("scene:transition", {"fromSceneId": from_id, "toSceneId": target})
	var ok := load_scene(target, spawn_point_id, camera_position, from_id); _switching = false; return ok


func switch_scene_and_wait(scene_id: String, spawn_point_id := "", camera_position: Variant = null) -> bool:
	var reentrant := _scene_enter_batch_depth > 0
	if reentrant: return switch_scene(scene_id, spawn_point_id, camera_position)
	var request := {"sceneId": scene_id, "spawnPointId": spawn_point_id, "cameraPosition": camera_position, "done": false, "ok": false}
	_scene_switch_queue.push_back(request)
	if not _scene_switch_queue_running: call_deferred("_drain_scene_switch_queue")
	while request.done != true: await Engine.get_main_loop().process_frame
	return request.ok == true


func wait_for_current_scene_entry() -> void:
	var epoch := _scene_entry_epoch
	while _scene_entry_running_epoch == epoch and _scene_entry_epoch == epoch:
		await Engine.get_main_loop().process_frame


func set_entity_session_enabled(kind: String, entity_id: String, enabled: bool) -> bool:
	var scene_id := get_current_scene_id(); var id := entity_id.strip_edges()
	if scene_id.is_empty() or id.is_empty() or kind not in ["npc", "hotspot"]: return false
	var bucket: Dictionary = entity_session_overrides.get(scene_id, {"npcs": {}, "hotspots": {}}); var name := "npcs" if kind == "npc" else "hotspots"
	if enabled: bucket[name].erase(id)
	else: bucket[name][id] = true
	if bucket.npcs.is_empty() and bucket.hotspots.is_empty(): entity_session_overrides.erase(scene_id)
	else: entity_session_overrides[scene_id] = bucket
	var instance: Variant = get_npc_by_id(id) if kind == "npc" else get_hotspot_by_id(id)
	if instance != null: instance.set_session_enabled_override(null if enabled else false)
	return true


func set_entity_runtime_field(scene_id: String, kind: String, entity_id: String, field: String, value: Variant) -> Dictionary:
	var sid := scene_id.strip_edges(); var id := entity_id.strip_edges(); var key := field.strip_edges()
	if sid.is_empty() or id.is_empty() or kind not in ["npc", "hotspot"]: return {"ok": false, "error": "invalid scene/entity"}
	if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) != sid: return {"ok": false, "error": "cutscene staging rejected cross-scene write"}
	var allowed := ["x", "y", "enabled", "animFile", "initialAnimState", "animState", "patrolDisabled", "portraitSlug"] if kind == "npc" else ["x", "y", "enabled", "displayImage"]
	if key not in allowed: return {"ok": false, "error": "%s.%s is not persistent" % [kind, key]}
	var normalized: Variant = value
	if key in ["x", "y"]:
		if not (value is int or value is float) or not is_finite(float(value)): return {"ok": false, "error": "%s requires finite number" % key}
		normalized = float(value)
	elif key in ["enabled", "patrolDisabled"]:
		if not value is bool: return {"ok": false, "error": "%s requires boolean" % key}
	elif key == "displayImage" and value != null and not RuntimeHotspot.is_valid_display_image(value): return {"ok": false, "error": "invalid displayImage"}
	elif key in ["animFile", "initialAnimState", "animState", "portraitSlug"] and value != null:
		normalized = str(value).strip_edges(); if normalized.is_empty(): return {"ok": false, "error": "%s requires non-empty string" % key}
	var memory := _ensure_memory(sid); var bucket: Dictionary = memory.entityOverrides.npcs if kind == "npc" else memory.entityOverrides.hotspots; var previous: Dictionary = bucket.get(id, {}); previous[key] = normalized; bucket[id] = previous
	if sid == get_current_scene_id(): _apply_runtime_field_to_live(kind, id, key, normalized)
	return {"ok": true, "value": normalized}


func get_entity_runtime_override(scene_id: String, kind: String, entity_id: String) -> Variant:
	var memory: Variant = cutscene_staging.memory if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == scene_id else scene_memory.get(scene_id)
	if not memory is Dictionary: return null
	return memory.entityOverrides.get("npcs" if kind == "npc" else "hotspots", {}).get(entity_id)


func merge_persistent_npc_state(npc_id: String, patch: Dictionary) -> void:
	var sid := get_current_scene_id(); var id := npc_id.strip_edges()
	if sid.is_empty() or id.is_empty(): return
	var memory := _ensure_memory(sid); var previous: Dictionary = memory.entityOverrides.npcs.get(id, {}); previous.merge(patch, true); memory.entityOverrides.npcs[id] = previous
	for key: Variant in patch: _apply_runtime_field_to_live("npc", id, str(key), patch[key])


func is_npc_patrol_persistently_disabled(npc_id: String) -> bool:
	var value: Variant = get_entity_runtime_override(get_current_scene_id(), "npc", npc_id)
	return value is Dictionary and value.get("patrolDisabled") == true


func stop_npc_patrol(npc_id: String) -> void:
	var id := npc_id.strip_edges(); var npc: Variant = get_npc_by_id(id)
	if npc != null: npc.cancel_active_move()
	_patrol_states.erase(id)


func start_npc_patrol(npc_id: String) -> void:
	var id := npc_id.strip_edges(); var npc: Variant = get_npc_by_id(id)
	if npc == null or not npc.def.get("patrol") is Dictionary: return
	var patrol: Dictionary = npc.def.patrol; var points: Array = []
	for raw: Variant in patrol.get("route", []):
		if not raw is Dictionary: continue
		var point := Vector2(float(raw.get("x", 0)), float(raw.get("y", 0)))
		if points.is_empty() or Vector2(float(points[-1].x), float(points[-1].y)).distance_to(point) > 0.001: points.push_back({"x": point.x, "y": point.y})
	if points.is_empty(): return
	stop_npc_patrol(id)
	var index := 0
	var first: Dictionary = points[0]
	if Vector2(npc.get_x(), npc.get_y()).distance_to(Vector2(float(first.x), float(first.y))) <= 0.001:
		# TS 的首个 moveTo 在同点时立即 resolve，并在首个 runtime tick 前进入下一段。
		if points.size() == 1: return
		index = 1
	var state := {"npc": npc, "points": points, "index": index, "step": 1, "targetStarted": true, "singleDone": false, "speed": float(patrol.get("speed", 60)), "moveAnimState": str(patrol.get("moveAnimState", ""))}
	var target: Dictionary = points[index]
	npc.begin_move_to(float(target.x), float(target.y), float(state.speed), str(state.moveAnimState))
	_patrol_states[id] = state


func set_zone_enabled_session(scene_id: String, zone_id: String, enabled: bool) -> void:
	var sid := scene_id.strip_edges(); var id := zone_id.strip_edges(); if sid.is_empty() or id.is_empty() or _zone_kind(id) == "depth_floor": return
	var bucket: Dictionary = zone_session_disabled.get(sid, {})
	if enabled: bucket.erase(id)
	else: bucket[id] = true
	if bucket.is_empty(): zone_session_disabled.erase(sid)
	else: zone_session_disabled[sid] = bucket
	_refresh_zones(sid)


func merge_persistent_zone_enabled(scene_id: String, zone_id: String, enabled: bool) -> void:
	var sid := scene_id.strip_edges(); var id := zone_id.strip_edges(); if sid.is_empty() or id.is_empty() or _zone_kind(id) == "depth_floor": return
	if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) != sid: return
	var memory := _ensure_memory(sid)
	if enabled: memory.entityOverrides.zones.erase(id)
	else: memory.entityOverrides.zones[id] = {"enabled": false}
	_refresh_zones(sid)


func set_hotspot_display_image(scene_id: String, hotspot_id: String, image_path: String, world_width: Variant = null, world_height: Variant = null, facing: Variant = null) -> bool:
	var sid := scene_id.strip_edges(); var id := hotspot_id.strip_edges(); var path := image_path.strip_edges()
	if sid.is_empty() or id.is_empty() or path.is_empty(): return false
	if not path.begins_with("/"): path = asset_manager.locator.scene_runtime_asset_url(sid, path)
	var texture: Variant = asset_manager.load_texture(path); if not texture is Texture2D: return false
	var current: Variant = get_hotspot_by_id(id) if sid == get_current_scene_id() else null; var previous: Variant = current.def.get("displayImage") if current != null else null
	if not previous is Dictionary:
		var raw_scene: Variant = asset_manager.load_json(asset_manager.locator.scene_json_url(sid))
		if raw_scene is Dictionary:
			for definition: Variant in raw_scene.get("hotspots", []):
				if definition is Dictionary and str(definition.get("id", "")) == id: previous = definition.get("displayImage"); break
	var width := float(world_width) if (world_width is int or world_width is float) and float(world_width) > 0 else (float(previous.get("worldWidth")) if previous is Dictionary and float(previous.get("worldWidth", 0)) > 0 else 0.0)
	var height := float(world_height) if (world_height is int or world_height is float) and float(world_height) > 0 else (float(previous.get("worldHeight")) if previous is Dictionary and float(previous.get("worldHeight", 0)) > 0 else 0.0)
	var ratio := float(texture.get_height()) / maxf(1.0, texture.get_width())
	if width <= 0 and height <= 0: width = 100; height = roundf(width * ratio * 10.0) / 10.0
	elif width <= 0: width = maxf(0.1, roundf(height / ratio * 10.0) / 10.0)
	elif height <= 0: height = maxf(0.1, roundf(width * ratio * 10.0) / 10.0)
	var display := {"image": path, "worldWidth": width, "worldHeight": height}
	if facing in ["left", "right"]: display.facing = facing
	elif previous is Dictionary and previous.has("facing"): display.facing = previous.facing
	if previous is Dictionary and previous.has("spriteSort"): display.spriteSort = previous.spriteSort
	return set_entity_runtime_field(sid, "hotspot", id, "displayImage", display).ok


func temp_set_hotspot_display_facing(scene_id: String, hotspot_id: String, facing: String) -> bool:
	if scene_id.strip_edges() != get_current_scene_id(): return false
	var hotspot: Variant = get_hotspot_by_id(hotspot_id.strip_edges()); if hotspot == null or facing not in ["left", "right", "restore"]: return false
	hotspot.set_runtime_display_facing(null if facing == "restore" else facing); return true


func resolve_scene_display_name(id: String) -> Variant:
	if current_scene.get("id") == id: return current_scene.get("name")
	var raw: Variant = asset_manager.load_json(asset_manager.locator.scene_json_url(id))
	return raw.get("name") if raw is Dictionary else null


func serialize() -> Dictionary:
	var output: Dictionary = {}
	for scene_id: String in scene_memory:
		var memory: Dictionary = _normalize_memory(scene_memory[scene_id]); output[scene_id] = {"inspected": memory.inspectedHotspots.duplicate(), "pickedUp": memory.pickedUpHotspots.duplicate(), "entityOverrides": memory.entityOverrides.duplicate(true)}
	return {"currentSceneId": get_current_scene_id() if not current_scene.is_empty() else null, "memory": output}


func deserialize(data: Dictionary) -> void:
	scene_memory.clear(); entity_session_overrides.clear(); zone_session_disabled.clear()
	var all_memory: Variant = data.get("memory", {})
	if not all_memory is Dictionary: return
	for scene_id: String in all_memory:
		var raw: Variant = all_memory[scene_id]
		if not raw is Dictionary: continue
		var memory := _empty_memory(); memory.inspectedHotspots = raw.get("inspected", []).duplicate(); memory.pickedUpHotspots = raw.get("pickedUp", []).duplicate()
		if raw.get("entityOverrides") is Dictionary: memory.entityOverrides = raw.entityOverrides.duplicate(true)
		memory = _normalize_memory(memory)
		if raw.get("npcSnapshots") is Dictionary: memory.entityOverrides.npcs.merge(raw.npcSnapshots, true)
		if raw.get("hotspotDisplayImageOverrides") is Dictionary:
			for id: String in raw.hotspotDisplayImageOverrides:
				var previous: Dictionary = memory.entityOverrides.hotspots.get(id, {}); previous.displayImage = raw.hotspotDisplayImageOverrides[id]; memory.entityOverrides.hotspots[id] = previous
		scene_memory[scene_id] = memory


func destroy() -> void:
	if _destroyed: return
	_destroyed = true
	for request: Dictionary in _scene_switch_queue: request.ok = false; request.done = true
	_scene_switch_queue.clear()
	if _active_scene_switch_request is Dictionary: _active_scene_switch_request.ok = false; _active_scene_switch_request.done = true
	event_bus.off("hotspot:pickup:done", Callable(self, "_on_hotspot_picked_up")); event_bus.off("hotspot:inspected", Callable(self, "_on_hotspot_inspected")); unload_scene(); _interaction_setter = Callable(); _zone_setter = Callable(); _audio_applier = Callable(); _scene_enter_runner = Callable(); _scene_reveal_runner = Callable(); _zone_actions_waiter = Callable(); _pending_reentrant_switch = null; active_cutscene_binding_id = null; cutscene_staging = null; character_registry.clear(); scene_memory.clear(); entity_session_overrides.clear(); zone_session_disabled.clear(); diagnostics = {"backgroundFailures": [], "npcSpriteFailures": [], "hotspotImageFailures": []}


func update(dt: float) -> void:
	for npc: RuntimeNpc in current_npcs: npc.cutscene_update(dt)
	var remove_ids: Array[String] = []
	for id: String in _patrol_states:
		var state: Dictionary = _patrol_states[id]; var npc: RuntimeNpc = state.npc
		if npc.is_destroyed(): remove_ids.push_back(id); continue
		if npc.is_patrol_paused_for_dialogue() or npc.is_moving_to_target(): continue
		if state.points.size() == 1 and state.targetStarted:
			state.singleDone = true; remove_ids.push_back(id); continue
		if state.targetStarted:
			if not npc.consume_patrol_skip_waypoint_advance():
				state.index = int(state.index) + int(state.step)
				if int(state.index) >= state.points.size(): state.index = state.points.size() - 2; state.step = -1
				elif int(state.index) < 0: state.index = 1; state.step = 1
		state.targetStarted = true; var target: Dictionary = state.points[int(state.index)]; npc.begin_move_to(float(target.x), float(target.y), float(state.speed), str(state.moveAnimState)); _patrol_states[id] = state
	for id: String in remove_ids: _patrol_states.erase(id)


func _start_scene_entry(scene_id: String, raw_actions: Variant) -> void:
	_scene_entry_epoch += 1
	var epoch := _scene_entry_epoch
	_scene_entry_running_epoch = epoch
	var actions: Array = raw_actions.duplicate(true) if raw_actions is Array else []
	_run_scene_entry(scene_id, actions, epoch)


func _run_scene_entry(scene_id: String, actions: Array, epoch: int) -> void:
	if not _scene_reveal_runner.is_null() and _scene_reveal_runner.is_valid():
		await _scene_reveal_runner.call(scene_id)
	if _destroyed or epoch != _scene_entry_epoch or scene_id != get_current_scene_id():
		if _scene_entry_running_epoch == epoch: _scene_entry_running_epoch = 0
		scene_entry_completed.emit(scene_id, epoch)
		return
	if not actions.is_empty() and not _scene_enter_runner.is_null() and _scene_enter_runner.is_valid():
		_scene_enter_batch_depth += 1
		await _scene_enter_runner.call(actions, scene_id)
		_scene_enter_batch_depth = maxi(0, _scene_enter_batch_depth - 1)
	if _scene_entry_running_epoch == epoch: _scene_entry_running_epoch = 0
	scene_entry_completed.emit(scene_id, epoch)
	if not _destroyed and epoch == _scene_entry_epoch and _scene_enter_batch_depth == 0 and not _switching and _pending_reentrant_switch is Dictionary:
		call_deferred("_consume_pending_reentrant_switch")


func _consume_pending_reentrant_switch() -> void:
	if _destroyed or _scene_enter_batch_depth > 0 or not _pending_reentrant_switch is Dictionary:
		return
	var request: Dictionary = _pending_reentrant_switch
	_pending_reentrant_switch = null
	await switch_scene_and_wait(str(request.get("targetSceneId", "")), str(request.get("spawnPointId", "")), request.get("cameraPosition"))


func _drain_scene_switch_queue() -> void:
	if _scene_switch_queue_running: return
	_scene_switch_queue_running = true
	while not _destroyed and not _scene_switch_queue.is_empty():
		var request: Dictionary = _scene_switch_queue.pop_front()
		_active_scene_switch_request = request
		var ok := await _switch_scene_for_queue(str(request.get("sceneId", "")), str(request.get("spawnPointId", "")), request.get("cameraPosition"))
		if ok: await wait_for_current_scene_entry()
		request.ok = ok and not _destroyed; request.done = true; _active_scene_switch_request = null
	_scene_switch_queue_running = false


func _switch_scene_for_queue(scene_id: String, spawn_point_id: String, camera_position: Variant) -> bool:
	var target := scene_id.strip_edges()
	if target.is_empty(): return false
	if target == get_current_scene_id():
		if spawn_point_id.strip_edges().is_empty() and not camera_position is Dictionary: return true
		_apply_spawn_and_camera(current_scene, spawn_point_id, camera_position)
		return true
	if _switching: return false
	# 与 TS 的异步切场边界一致：旧场景 zone:onExit 动作必须在新场景 enter/ready 前完成。
	# 先验证目标，避免无效目标把当前场景卸掉。
	var raw: Variant = asset_manager.load_json(asset_manager.locator.scene_json_url(target))
	if not raw is Dictionary or str(raw.get("id", "")) != target: return false
	var backgrounds: Variant = raw.get("backgrounds", [])
	if not backgrounds is Array or (not backgrounds.is_empty() and str(backgrounds[0].get("image", "")) != "background.png"): return false
	_switching = true
	var from_id: Variant = get_current_scene_id() if not current_scene.is_empty() else null
	event_bus.emit("scene:transition", {"fromSceneId": from_id, "toSceneId": target})
	unload_scene()
	if not _zone_actions_waiter.is_null() and _zone_actions_waiter.is_valid():
		await _zone_actions_waiter.call()
	if _destroyed:
		_switching = false
		return false
	var ok := load_scene(target, spawn_point_id, camera_position, from_id, true, true)
	_switching = false
	return ok


func _remove_hotspot_instance(id: String) -> void:
	var hotspot: Variant = get_hotspot_by_id(id)
	if hotspot == null: return
	current_hotspots.erase(hotspot)
	hotspot.destroy_hotspot()


func _remove_npc_instance(id: String) -> void:
	var npc: Variant = get_npc_by_id(id)
	if npc == null: return
	stop_npc_patrol(id)
	current_npcs.erase(npc)
	npc.destroy_npc()


func _instantiate_hotspot_from_memory(definition: Dictionary, memory: Dictionary, honor_outer_absence: bool) -> Variant:
	var id := str(definition.get("id", ""))
	if honor_outer_absence and memory.pickedUpHotspots.has(id): return null
	var override: Variant = memory.entityOverrides.hotspots.get(id)
	if honor_outer_absence and override is Dictionary and override.get("enabled") == false: return null
	var effective := RuntimeHotspot.apply_runtime_override(definition, override)
	var hotspot := RuntimeHotspot.new(effective)
	_apply_session_override("hotspot", id, hotspot)
	renderer.entity_layer.add_child(hotspot.container)
	if effective.get("displayImage") is Dictionary and not hotspot.load_display_image(asset_manager): diagnostics.hotspotImageFailures.push_back({"sceneId": get_current_scene_id(), "id": id})
	current_hotspots.push_back(hotspot)
	return hotspot


func _instantiate_npc_from_memory(definition: Dictionary, memory: Dictionary) -> RuntimeNpc:
	var id := str(definition.get("id", "")); var override: Variant = memory.entityOverrides.npcs.get(id)
	var merged := RuntimeNpc.apply_runtime_override(RuntimeNpc.apply_character_defaults(definition, character_registry), override)
	var npc := RuntimeNpc.new(merged)
	_apply_session_override("npc", id, npc)
	if override is Dictionary and override.get("enabled") == false: npc.set_derived_base_visible(false)
	if not str(merged.get("animFile", "")).is_empty() and not npc.load_sprite_from_path(str(merged.animFile), asset_manager, str(merged.get("initialAnimState", ""))): diagnostics.npcSpriteFailures.push_back({"sceneId": get_current_scene_id(), "id": id, "error": asset_manager.last_error})
	if override is Dictionary and not str(override.get("animState", "")).strip_edges().is_empty(): npc.play_animation(str(override.animState))
	renderer.entity_layer.add_child(npc.container)
	current_npcs.push_back(npc)
	return npc


func _finish_cutscene_entity_rebuild(cutscene_id: String, phase: String, hotspot_ids: Array[String], npc_ids: Array[String]) -> void:
	if not _interaction_setter.is_null() and _interaction_setter.is_valid(): _interaction_setter.call(current_hotspots, current_npcs)
	if hotspot_ids.is_empty() and npc_ids.is_empty(): return
	event_bus.emit("scene:entitiesRebuilt", {"cutsceneId": cutscene_id, "phase": phase, "hotspotIds": hotspot_ids, "npcIds": npc_ids})
	if phase == "exit":
		for id: String in npc_ids:
			var npc: Variant = get_npc_by_id(id)
			if npc != null and npc.container.visible and not is_npc_patrol_persistently_disabled(id): start_npc_patrol(id)


func _resolve_world_size(scene: Dictionary, first_texture: Texture2D) -> void:
	var width := float(scene.get("worldWidth", 0.0)) if scene.get("worldWidth") != null else 0.0
	var height := float(scene.get("worldHeight", 0.0)) if scene.get("worldHeight") != null else 0.0
	if width > 0 and height > 0: return
	if first_texture != null:
		var ratio := float(first_texture.get_height()) / maxf(1.0, first_texture.get_width())
		if width > 0: height = roundf(width * ratio)
		elif height > 0: width = roundf(height / ratio)
		else: width = first_texture.get_width(); height = first_texture.get_height()
	else:
		if width <= 0: width = 800
		if height <= 0: height = 600
	scene.worldWidth = width; scene.worldHeight = height


func _mount_background_layers(scene: Dictionary, backgrounds: Array) -> void:
	var layers := backgrounds.duplicate(true); layers.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return float(a.get("z", 0)) < float(b.get("z", 0)))
	var camera_config: Variant = scene.get("camera")
	var projection_scale := maxf(0.000001, (float(camera_config.get("zoom", 1.0)) * float(camera_config.get("pixelsPerUnit", 1.0)) if camera_config is Dictionary else 1.0) * float(scene.get("worldScale", 1.0)))
	for layer: Variant in layers:
		if not layer is Dictionary: continue
		var texture: Variant = asset_manager.load_texture(str(layer.get("image", "")))
		if not texture is Texture2D: continue
		var image := Sprite2D.new(); image.centered = false; image.texture = texture; image.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR; image.position = Vector2(float(layer.get("x", 0)), float(layer.get("y", 0))); image.scale = Vector2(float(scene.worldWidth) / maxf(1.0, texture.get_width()), float(scene.worldHeight) / maxf(1.0, texture.get_height())); image.z_index = clampi(int(layer.get("z", 0)), -4096, 4096)
		var source_per_screen_x := float(texture.get_width()) / maxf(1.0, float(scene.worldWidth) * projection_scale)
		var source_per_screen_y := float(texture.get_height()) / maxf(1.0, float(scene.worldHeight) * projection_scale)
		var radius_texels := Vector2(maxf(0.0, source_per_screen_x - 1.0), maxf(0.0, source_per_screen_y - 1.0)) * BACKGROUND_RESAMPLE_RADIUS_SCALE
		if radius_texels.x > 0.0001 or radius_texels.y > 0.0001:
			var material := ShaderMaterial.new(); material.shader = BACKGROUND_RESAMPLE_SHADER
			material.set_shader_parameter("radius_texels", radius_texels.clamp(Vector2.ZERO, Vector2(2.0, 2.0)))
			image.material = material
		scene_background.add_child(image)


func _mount_placeholder_background(scene: Dictionary) -> void:
	var placeholder := Polygon2D.new(); placeholder.name = "PlaceholderBackground"; placeholder.polygon = PackedVector2Array([Vector2.ZERO, Vector2(float(scene.worldWidth), 0), Vector2(float(scene.worldWidth), float(scene.worldHeight)), Vector2(0, float(scene.worldHeight))]); placeholder.color = Color("202638"); scene_background.add_child(placeholder)


func _apply_spawn_and_camera(scene: Dictionary, spawn_point_id: String, camera_position: Variant) -> void:
	var spawn: Variant = scene.get("spawnPoint", {"x": 0, "y": 0}); var key := spawn_point_id.strip_edges(); var named: Variant = scene.get("spawnPoints")
	if not key.is_empty() and named is Dictionary and named.get(key) is Dictionary: spawn = named[key]
	var x := float(camera_position.get("x", spawn.get("x", 0))) if camera_position is Dictionary else float(spawn.get("x", 0)); var y := float(camera_position.get("y", spawn.get("y", 0))) if camera_position is Dictionary else float(spawn.get("y", 0))
	player.sync_movement_from_scene(scene); player.set_x(x); player.set_y(y)
	camera.set_bounds(float(scene.worldWidth), float(scene.worldHeight)); var config: Variant = scene.get("camera"); camera.set_pixels_per_unit(float(config.get("pixelsPerUnit", 1.0)) if config is Dictionary else 1.0); camera.set_zoom(float(config.get("zoom", 1.0)) if config is Dictionary else 1.0); camera.set_world_scale(float(scene.get("worldScale", 1.0))); camera.snap_to(x, y)


func _is_cutscene_only(definition: Dictionary) -> bool:
	var ids: Variant = definition.get("cutsceneIds")
	return ids is Array and not ids.is_empty() and definition.get("cutsceneOnly") != false


func _is_bound_to_cutscene(definition: Dictionary, raw_id: Variant) -> bool:
	var id := str(raw_id).strip_edges() if raw_id != null else ""; var ids: Variant = definition.get("cutsceneIds")
	return not id.is_empty() and ids is Array and ids.has(id)


func _scene_has_cutscene_binding(scene: Dictionary, id: String) -> bool:
	for collection: String in ["hotspots", "npcs"]:
		for definition: Variant in scene.get(collection, []):
			if definition is Dictionary and _is_bound_to_cutscene(definition, id): return true
	return false


func _empty_memory() -> Dictionary: return {"inspectedHotspots": [], "pickedUpHotspots": [], "entityOverrides": {"npcs": {}, "hotspots": {}, "zones": {}}}
func _normalize_memory(memory: Dictionary) -> Dictionary:
	if not memory.get("inspectedHotspots") is Array: memory.inspectedHotspots = []
	if not memory.get("pickedUpHotspots") is Array: memory.pickedUpHotspots = []
	if not memory.get("entityOverrides") is Dictionary: memory.entityOverrides = {"npcs": {}, "hotspots": {}, "zones": {}}
	for name: String in ["npcs", "hotspots", "zones"]:
		if not memory.entityOverrides.get(name) is Dictionary: memory.entityOverrides[name] = {}
	return memory
func _ensure_memory(scene_id: String) -> Dictionary:
	if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == scene_id:
		cutscene_staging.memory = _normalize_memory(cutscene_staging.memory)
		return cutscene_staging.memory
	return _ensure_committed_memory(scene_id)
func _ensure_committed_memory(scene_id: String) -> Dictionary:
	if not scene_memory.get(scene_id) is Dictionary: scene_memory[scene_id] = _empty_memory()
	return _normalize_memory(scene_memory[scene_id])


func _apply_session_override(kind: String, id: String, instance: Variant) -> void:
	var bucket: Variant = entity_session_overrides.get(get_current_scene_id())
	if bucket is Dictionary and bucket.get("npcs" if kind == "npc" else "hotspots", {}).has(id): instance.set_session_enabled_override(false)


func _apply_runtime_field_to_live(kind: String, id: String, key: String, value: Variant) -> void:
	var instance: Variant = get_npc_by_id(id) if kind == "npc" else get_hotspot_by_id(id)
	if instance == null: return
	if value == null: instance.def.erase(key)
	else: instance.def[key] = value
	match key:
		"x":
			if kind == "npc": instance.set_x(float(value))
			else: instance.set_position(float(value), instance.get_center_y())
		"y":
			if kind == "npc": instance.set_y(float(value))
			else: instance.set_position(instance.get_center_x(), float(value))
		"enabled":
			if kind == "npc": instance.set_derived_base_visible(value == true)
			else: instance.set_derived_base_enabled(value == true)
		"animState":
			if kind == "npc" and value != null: instance.play_animation(str(value))
		"patrolDisabled":
			if kind == "npc":
				if value == true: stop_npc_patrol(id)
				else: start_npc_patrol(id)
		"animFile", "initialAnimState":
			if kind == "npc" and not str(instance.def.get("animFile", "")).is_empty(): instance.load_sprite_from_path(str(instance.def.animFile), asset_manager, str(instance.def.get("initialAnimState", "")))
		"displayImage":
			if kind == "hotspot":
				if value == null: instance.set_display_texture(null, 0, 0)
				elif value is Dictionary: instance.load_display_image(asset_manager)


func _on_hotspot_picked_up(payload: Variant) -> void:
	if not payload is Dictionary: return
	var id := str(payload.get("hotspotId", "")); var hotspot: Variant = get_hotspot_by_id(id)
	if hotspot != null: hotspot.mark_picked_up()
	if hotspot == null or str(hotspot.def.get("type", "")) != "pickup": return
	var memory := _ensure_memory(get_current_scene_id()); if not memory.pickedUpHotspots.has(id): memory.pickedUpHotspots.push_back(id)


func _on_hotspot_inspected(payload: Variant) -> void:
	if not payload is Dictionary: return
	var id := str(payload.get("hotspotId", "")); var memory := _ensure_memory(get_current_scene_id()); if not memory.inspectedHotspots.has(id): memory.inspectedHotspots.push_back(id)


func _effective_zones(scene: Dictionary) -> Array:
	var output: Array = []; var sid := str(scene.get("id", "")); var memory := _ensure_memory(sid); var session: Dictionary = zone_session_disabled.get(sid, {})
	for zone: Variant in scene.get("zones", []):
		if not zone is Dictionary: continue
		if not is_entity_in_active_plane(zone): continue
		var id := str(zone.get("id", ""))
		if zone.get("zoneKind") != "depth_floor" and (session.has(id) or (memory.entityOverrides.zones.get(id) is Dictionary and memory.entityOverrides.zones[id].get("enabled") == false)): continue
		output.push_back(zone)
	return output


func _refresh_zones(scene_id: String) -> void:
	if scene_id == get_current_scene_id() and not _zone_setter.is_null() and _zone_setter.is_valid(): _zone_setter.call(_effective_zones(current_scene))


func _zone_kind(zone_id: String) -> String:
	for zone: Variant in current_scene.get("zones", []):
		if zone is Dictionary and str(zone.get("id", "")) == zone_id: return str(zone.get("zoneKind", "standard"))
	return ""
