class_name RuntimeSceneManager
extends RuntimeSystem

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const RuntimeAsyncTailScript := preload("res://scripts/runtime/async_tail.gd")
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")
const RuntimeCharacterRegistryScript := preload("res://scripts/data/character_registry.gd")

var asset_manager: RuntimeAssetManager
var event_bus: RuntimeEventBus
var renderer: RuntimeRenderer

var current_scene: Dictionary = {}
var current_hotspots: Array[RuntimeHotspot] = []
var current_npcs: Array[RuntimeNpc] = []
var scene_background: Node2D
var _primary_background_texture: Texture2D
var scene_memory: Dictionary = {}
var cutscene_staging: Variant = null
var character_registry: Dictionary = {}
var zone_session_disabled: Dictionary = {}
var entity_session_overrides: Dictionary = {}
var _scene_epoch := 0
var _scene_enter_batch_depth := 0
var _pending_reentrant_switch: Variant = null
var _transition_overlay: Control
var _transition_bar_fill: ColorRect
var _transition_bar_width := 0.0
var _transition_bar_height := 8.0
var _transition_debug_label: Label
var _switching := false
var _scene_switch_tail: RuntimeAsyncTail
var _animation_tween: Tween
var active_cutscene_binding_id: Variant = null
var _active_plane_getter := Callable()
var _player_position_setter := Callable()
var _camera_setter := Callable()
var _bounds_only_setter := Callable()
var _audio_applier := Callable()
var _audio_manifest_resolver := Callable()
var _zone_setter := Callable()
var _interaction_setter := Callable()
var _entity_filter_releaser := Callable()
var _depth_loader := Callable()
var _depth_unloader := Callable()
var _scene_enter_runner := Callable()
var _current_scene_scope_id: Variant = null
var _on_hotspot_pickup: Callable
var _on_hotspot_inspected: Callable


func set_character_registry(registry: Dictionary) -> void:
	character_registry = registry


func _init(next_assets: RuntimeAssetManager, next_events: RuntimeEventBus, next_renderer: RuntimeRenderer) -> void:
	asset_manager = next_assets; event_bus = next_events; renderer = next_renderer
	_scene_switch_tail = RuntimeAsyncTailScript.new()
	_on_hotspot_pickup = func(payload: Variant) -> void:
		if payload is Dictionary: _mark_hotspot_picked_up(str(payload.get("hotspotId", "")))
	_on_hotspot_inspected = func(payload: Variant) -> void:
		if payload is Dictionary: _mark_hotspot_inspected(str(payload.get("hotspotId", "")))


func init(_ctx: Dictionary) -> void:
	event_bus.on("hotspot:pickup:done", _on_hotspot_pickup)
	event_bus.on("hotspot:inspected", _on_hotspot_inspected)


func update(_dt: float) -> void:
	# Game/bootstrap owns NPC animation and patrol sessions, matching Game.ts.
	return


func set_player_position_setter(callback: Callable = Callable()) -> void: _player_position_setter = callback


func set_camera_setter(callback: Callable = Callable()) -> void: _camera_setter = callback


func set_bounds_only_setter(callback: Callable = Callable()) -> void: _bounds_only_setter = callback


func set_audio_applier(callback: Callable = Callable()) -> void: _audio_applier = callback


func set_audio_manifest_resolver(callback: Callable = Callable()) -> void: _audio_manifest_resolver = callback


func set_zone_setter(callback: Callable = Callable()) -> void: _zone_setter = callback


func set_interaction_setter(callback: Callable = Callable()) -> void: _interaction_setter = callback


func set_entity_filter_releaser(callback: Callable = Callable()) -> void: _entity_filter_releaser = callback


func _release_hotspot_filters(hotspot: RuntimeHotspot) -> void:
	var filter: Variant = hotspot.detach_depth_occlusion_filter()
	if filter == null: return
	if _entity_filter_releaser.is_valid(): _entity_filter_releaser.call([filter])
	else: filter.destroy()


func _release_npc_filters(npc: RuntimeNpc) -> void:
	if npc.container == null: return
	var filter: Variant = RuntimeSceneEntityFilterBinding.detach(npc.container)
	if filter == null: return
	if _entity_filter_releaser.is_valid(): _entity_filter_releaser.call([filter])
	else: filter.destroy()


func set_depth_loader(callback: Callable = Callable()) -> void: _depth_loader = callback


func set_depth_unloader(callback: Callable = Callable()) -> void: _depth_unloader = callback


func set_scene_enter_runner(callback: Callable = Callable()) -> void: _scene_enter_runner = callback


func get_current_scene_data() -> Dictionary: return current_scene


func get_current_scene_id() -> String: return str(current_scene.get("id", ""))


func get_npc_by_id(id: String) -> Variant:
	for npc: RuntimeNpc in current_npcs:
		if npc.get_id() == id: return npc
	return null


func get_current_npcs() -> Array[RuntimeNpc]: return current_npcs


func get_current_hotspots() -> Array[RuntimeHotspot]: return current_hotspots


func set_active_cutscene_binding_id(id: Variant) -> void:
	var normalized := str(id).strip_edges() if id != null else ""
	active_cutscene_binding_id = normalized if not normalized.is_empty() else null


func get_active_cutscene_binding_id() -> Variant: return active_cutscene_binding_id


func set_active_plane_getter(callback: Callable = Callable()) -> void: _active_plane_getter = callback


func _entity_in_plane(definition: Dictionary) -> bool:
	var active: Variant = _active_plane_getter.call() if _active_plane_getter.is_valid() else {"id": "normal", "membership": "shared"}
	if not active is Dictionary: active = {"id": "normal", "membership": "shared"}
	var planes: Variant = definition.get("planes")
	if not planes is Array or planes.is_empty(): return str(active.get("membership", "shared")) == "shared"
	return planes.has(str(active.get("id", "normal")))


func is_entity_in_active_plane(definition: Dictionary) -> bool:
	return _entity_in_plane(definition)


func _refresh_cutscene_bound_entity_visibility() -> void:
	for hotspot: RuntimeHotspot in current_hotspots: hotspot.set_derived_base_enabled(get_hotspot_base_enabled_for_interaction(hotspot))
	for npc: RuntimeNpc in current_npcs: npc.set_derived_base_visible(get_npc_base_visible_for_interaction(npc))


func refresh_for_plane_change(scene_id: String) -> void:
	refresh_entities_for_plane_change(scene_id)
	refresh_zones_for_plane_change(scene_id)


func refresh_entities_for_plane_change(scene_id: String) -> void:
	if scene_id.strip_edges() != get_current_scene_id(): return
	_refresh_cutscene_bound_entity_visibility()


func refresh_zones_for_plane_change(scene_id: String) -> void: _refresh_zones_after_runtime_change(scene_id.strip_edges())


func set_entity_session_enabled(kind: String, entity_id: String, enabled: bool) -> bool:
	var scene_id := get_current_scene_id(); var id := entity_id.strip_edges()
	if scene_id.is_empty() or id.is_empty() or kind not in ["npc", "hotspot"]:
		push_warning("SceneManager.setEntitySessionEnabled: 无当前场景或空 entityId")
		return false
	var bucket: Dictionary = entity_session_overrides.get(scene_id, {"npcs": {}, "hotspots": {}}); var name := "npcs" if kind == "npc" else "hotspots"
	if enabled: bucket[name].erase(id)
	else: bucket[name][id] = true
	if bucket.npcs.is_empty() and bucket.hotspots.is_empty(): entity_session_overrides.erase(scene_id)
	else: entity_session_overrides[scene_id] = bucket
	var instance: Variant = get_npc_by_id(id) if kind == "npc" else null
	if kind == "hotspot":
		var index := current_hotspots.find_custom(func(hotspot: RuntimeHotspot) -> bool: return hotspot.get_id() == id)
		instance = current_hotspots[index] if index >= 0 else null
	if instance != null: instance.set_session_enabled_override(null if enabled else false)
	return true


func _apply_session_override_on_instantiate(kind: String, instance: Variant) -> void:
	var bucket: Variant = entity_session_overrides.get(get_current_scene_id())
	if bucket is Dictionary and bucket.get("npcs" if kind == "npc" else "hotspots", {}).has(str(instance.def.get("id", ""))): instance.set_session_enabled_override(false)


func get_hotspot_base_enabled_for_interaction(hotspot: RuntimeHotspot) -> bool:
	if not _entity_in_plane(hotspot.def): return false
	if RuntimeDataTypes.is_cutscene_only_entity(hotspot.def): return RuntimeDataTypes.is_entity_bound_to_cutscene(hotspot.def, active_cutscene_binding_id)
	var value: Variant = get_entity_runtime_override(get_current_scene_id(), "hotspot", hotspot.get_id()); return not (value is Dictionary and value.get("enabled") == false)


func get_npc_base_visible_for_interaction(npc: RuntimeNpc) -> bool:
	if not _entity_in_plane(npc.def): return false
	if RuntimeDataTypes.is_cutscene_only_entity(npc.def): return RuntimeDataTypes.is_entity_bound_to_cutscene(npc.def, active_cutscene_binding_id)
	var value: Variant = get_entity_runtime_override(get_current_scene_id(), "npc", npc.get_id()); return not (value is Dictionary and value.get("enabled") == false)


func set_zone_enabled_session(scene_id: String, zone_id: String, enabled: bool) -> void:
	var sid := scene_id.strip_edges(); var id := zone_id.strip_edges()
	if sid.is_empty() or id.is_empty():
		push_warning("setZoneEnabledSession: sceneId 与 zoneId 不能为空")
		return
	if _resolve_zone_kind(sid, id) == "depth_floor":
		push_warning("setZoneEnabledSession: zone \"%s\" 为 depth_floor，忽略" % id)
		return
	var bucket: Dictionary = zone_session_disabled.get(sid, {})
	if enabled: bucket.erase(id)
	else: bucket[id] = true
	if bucket.is_empty(): zone_session_disabled.erase(sid)
	else: zone_session_disabled[sid] = bucket
	_refresh_zones_after_runtime_change(sid)


func merge_persistent_zone_enabled(scene_id: String, zone_id: String, enabled: bool) -> void:
	var sid := scene_id.strip_edges(); var id := zone_id.strip_edges()
	if sid.is_empty() or id.is_empty():
		push_warning("mergePersistentZoneEnabled: sceneId 与 zoneId 不能为空")
		return
	if _resolve_zone_kind(sid, id) == "depth_floor":
		push_warning("mergePersistentZoneEnabled: zone \"%s\" 为 depth_floor，忽略" % id)
		return
	var memory: Variant = _get_writable_memory(sid)
	if not memory is Dictionary:
		push_warning("mergePersistentZoneEnabled: 无法写入 sceneMemory (%s)" % sid)
		return
	if enabled: memory.entityOverrides.zones.erase(id)
	else: memory.entityOverrides.zones[id] = {"enabled": false}
	_refresh_zones_after_runtime_change(sid)


func _resolve_zone_kind(scene_id: String, zone_id: String) -> Variant:
	var definition: Variant = _find_zone_definition(scene_id, zone_id)
	if not definition is Dictionary: return null
	return "depth_floor" if definition.get("zoneKind") == "depth_floor" else "standard"


func _find_zone_definition(scene_id: String, zone_id: String) -> Variant:
	var sid := scene_id.strip_edges(); var id := zone_id.strip_edges()
	if sid.is_empty() or id.is_empty() or sid != get_current_scene_id(): return null
	for zone: Variant in current_scene.get("zones", []):
		if zone is Dictionary and str(zone.get("id", "")).strip_edges() == id: return zone
	return null


func _merged_zone_override(scene_id: String, zone_id: String) -> Variant:
	var committed_memory: Variant = _get_committed_memory(scene_id)
	var committed: Variant = committed_memory.entityOverrides.zones.get(zone_id) if committed_memory is Dictionary else null
	var staged: Variant = cutscene_staging.memory.entityOverrides.zones.get(zone_id) if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == scene_id else null
	if not committed is Dictionary and not staged is Dictionary: return null
	var merged: Dictionary = committed.duplicate(true) if committed is Dictionary else {}
	if staged is Dictionary: merged.merge(staged, true)
	return merged


func _compute_effective_zones(scene_id: String, raw: Variant) -> Array:
	var output: Array = []
	var zones: Array = raw if raw is Array else []
	for zone: Variant in zones:
		if zone is Dictionary and _should_register_zone_with_zone_system(scene_id, zone): output.push_back(zone)
	return output


func _should_register_zone_with_zone_system(scene_id: String, zone: Dictionary) -> bool:
	if not _entity_in_plane(zone): return false
	if zone.get("zoneKind") == "depth_floor": return true
	var sid := scene_id.strip_edges(); var id := str(zone.get("id", "")).strip_edges()
	if id.is_empty() or zone_session_disabled.get(sid, {}).has(id): return false
	var override: Variant = _merged_zone_override(sid, id)
	return not (override is Dictionary and override.get("enabled") == false)


func _refresh_zones_after_runtime_change(scene_id: String) -> void:
	if scene_id == get_current_scene_id() and not _zone_setter.is_null() and _zone_setter.is_valid():
		_zone_setter.call(_compute_effective_zones(scene_id, current_scene.get("zones")))


func is_switching() -> bool: return _switching


func _empty_entity_overrides() -> Dictionary: return {"npcs": {}, "hotspots": {}, "zones": {}}


func _empty_memory() -> Dictionary: return {"inspectedHotspots": [], "pickedUpHotspots": [], "entityOverrides": _empty_entity_overrides()}


func _normalize_memory(memory: Dictionary) -> Dictionary:
	if not memory.get("inspectedHotspots") is Array: memory.inspectedHotspots = []
	if not memory.get("pickedUpHotspots") is Array: memory.pickedUpHotspots = []
	if not memory.get("entityOverrides") is Dictionary: memory.entityOverrides = {"npcs": {}, "hotspots": {}, "zones": {}}
	for name: String in ["npcs", "hotspots", "zones"]:
		if not memory.entityOverrides.get(name) is Dictionary: memory.entityOverrides[name] = {}
	return memory


func _ensure_scene_memory(scene_id: String) -> Dictionary:
	if not scene_memory.get(scene_id) is Dictionary: scene_memory[scene_id] = _empty_memory()
	return _normalize_memory(scene_memory[scene_id])


func begin_cutscene_staging(cutscene_id: String, scene_id: String) -> void:
	var cid := cutscene_id.strip_edges(); var sid := scene_id.strip_edges()
	if cid.is_empty() or sid.is_empty():
		push_warning("SceneManager.beginCutsceneStaging: cutsceneId/sceneId 不能为空")
		return
	cutscene_staging = {"cutsceneId": cid, "sceneId": sid, "memory": _empty_memory()}; set_active_cutscene_binding_id(cid)


func end_cutscene_staging() -> void:
	cutscene_staging = null; set_active_cutscene_binding_id(null)


func enter_cutscene_instances_for_current(cutscene_id: String) -> void:
	if current_scene.is_empty(): return
	var scene_id := get_current_scene_id(); var epoch := _scene_epoch; var rebuilt_hotspots: Array[String] = []; var rebuilt_npcs: Array[String] = []
	for definition: Variant in current_scene.get("hotspots", []):
		if not definition is Dictionary or not RuntimeDataTypes.is_entity_bound_to_cutscene(definition, cutscene_id): continue
		var id := str(definition.get("id", ""))
		var existing_index := current_hotspots.find_custom(func(hotspot: RuntimeHotspot) -> bool: return hotspot.get_id() == id)
		if existing_index >= 0:
			var existing := current_hotspots[existing_index]
			_release_hotspot_filters(existing)
			existing.destroy_hotspot()
			current_hotspots.remove_at(existing_index)
		var override: Variant = _runtime_override_for_context(scene_id, "hotspot", id, "cutscene")
		var hotspot := _instantiate_hotspot(definition, override)
		if _commit_rebuilt_entity_or_discard(hotspot, epoch, current_hotspots, rebuilt_hotspots, id): return
	for definition: Variant in current_scene.get("npcs", []):
		if not definition is Dictionary or not RuntimeDataTypes.is_entity_bound_to_cutscene(definition, cutscene_id): continue
		var id := str(definition.get("id", ""))
		var existing_index := current_npcs.find_custom(func(npc: RuntimeNpc) -> bool: return npc.get_id() == id)
		if existing_index >= 0:
			var existing := current_npcs[existing_index]
			_release_npc_filters(existing)
			existing.destroy_npc()
			current_npcs.remove_at(existing_index)
		var override: Variant = _runtime_override_for_context(scene_id, "npc", id, "cutscene")
		var npc := _instantiate_npc(definition, override)
		if _commit_rebuilt_entity_or_discard(npc, epoch, current_npcs, rebuilt_npcs, id): return
	if _interaction_setter.is_valid(): _interaction_setter.call(current_hotspots, current_npcs)
	_emit_entities_rebuilt(cutscene_id, "enter", rebuilt_hotspots, rebuilt_npcs)


func exit_cutscene_instances_for_current(cutscene_id: String) -> void:
	if current_scene.is_empty(): return
	var scene_id := get_current_scene_id(); var committed_memory: Variant = _get_committed_memory(scene_id); var epoch := _scene_epoch; var rebuilt_hotspots: Array[String] = []; var rebuilt_npcs: Array[String] = []
	for definition: Variant in current_scene.get("hotspots", []):
		if not definition is Dictionary or not RuntimeDataTypes.is_entity_bound_to_cutscene(definition, cutscene_id): continue
		var id := str(definition.get("id", ""))
		var existing_index := current_hotspots.find_custom(func(hotspot: RuntimeHotspot) -> bool: return hotspot.get_id() == id)
		if existing_index >= 0:
			var existing := current_hotspots[existing_index]
			_release_hotspot_filters(existing)
			existing.destroy_hotspot()
			current_hotspots.remove_at(existing_index)
		if not RuntimeDataTypes.is_cutscene_only_entity(definition):
			if committed_memory is Dictionary and committed_memory.pickedUpHotspots.has(id): continue
			var override: Variant = _runtime_override_for_context(scene_id, "hotspot", id, "outer")
			if override is Dictionary and override.get("enabled") == false: continue
			var hotspot := _instantiate_hotspot(definition, override)
			if _commit_rebuilt_entity_or_discard(hotspot, epoch, current_hotspots, rebuilt_hotspots, id): return
	for definition: Variant in current_scene.get("npcs", []):
		if not definition is Dictionary or not RuntimeDataTypes.is_entity_bound_to_cutscene(definition, cutscene_id): continue
		var id := str(definition.get("id", ""))
		var existing_index := current_npcs.find_custom(func(npc: RuntimeNpc) -> bool: return npc.get_id() == id)
		if existing_index >= 0:
			var existing := current_npcs[existing_index]
			_release_npc_filters(existing)
			existing.destroy_npc()
			current_npcs.remove_at(existing_index)
		if not RuntimeDataTypes.is_cutscene_only_entity(definition):
			var override: Variant = _runtime_override_for_context(scene_id, "npc", id, "outer")
			var npc := _instantiate_npc(definition, override)
			if _commit_rebuilt_entity_or_discard(npc, epoch, current_npcs, rebuilt_npcs, id): return
	if _interaction_setter.is_valid(): _interaction_setter.call(current_hotspots, current_npcs)
	_emit_entities_rebuilt(cutscene_id, "exit", rebuilt_hotspots, rebuilt_npcs)


func _commit_rebuilt_entity_or_discard(entity: Variant, epoch: int, sink: Array, id_sink: Array[String], id: String) -> bool:
	if _scene_epoch != epoch:
		if entity is RuntimeHotspot: entity.destroy_hotspot()
		elif entity is RuntimeNpc: entity.destroy_npc()
		return true
	sink.push_back(entity)
	id_sink.push_back(id)
	return false


func _emit_entities_rebuilt(cutscene_id: String, phase: String, hotspot_ids: Array[String], npc_ids: Array[String]) -> void:
	if hotspot_ids.is_empty() and npc_ids.is_empty(): return
	event_bus.emit("scene:entitiesRebuilt", {"cutsceneId": cutscene_id, "phase": phase, "hotspotIds": hotspot_ids, "npcIds": npc_ids})


func is_cutscene_staging_active() -> bool: return cutscene_staging is Dictionary


func get_active_cutscene_staging_scene_id() -> Variant:
	return str(cutscene_staging.sceneId) if cutscene_staging is Dictionary else null


func get_active_cutscene_staging_id() -> Variant:
	return str(cutscene_staging.cutsceneId) if cutscene_staging is Dictionary else null


func _get_committed_memory(scene_id: String) -> Variant:
	var memory: Variant = scene_memory.get(scene_id)
	return _normalize_memory(memory) if memory is Dictionary else null


func _get_writable_memory(scene_id: String) -> Variant:
	if cutscene_staging is Dictionary:
		if scene_id != str(cutscene_staging.sceneId):
			push_warning("SceneManager: 过场中忽略跨场景 sceneMemory 写入 \"%s\"（当前过场场景 \"%s\"）" % [scene_id, str(cutscene_staging.sceneId)])
			return null
		cutscene_staging.memory = _normalize_memory(cutscene_staging.memory)
		return cutscene_staging.memory
	return _ensure_scene_memory(scene_id)


func _find_entity_definition(scene_id: String, kind: String, entity_id: String) -> Variant:
	if scene_id != get_current_scene_id(): return null
	var collection := "npcs" if kind == "npc" else "hotspots"
	for definition: Variant in current_scene.get(collection, []):
		if definition is Dictionary and str(definition.get("id", "")) == entity_id: return definition
	return null


func _is_current_cutscene_only_entity(scene_id: String, kind: String, entity_id: String) -> bool:
	var definition: Variant = _find_entity_definition(scene_id, kind, entity_id)
	return definition is Dictionary and RuntimeDataTypes.is_cutscene_only_entity(definition)


func _entity_runtime_override_for_definition(scene_id: String, kind: String, entity_id: String, definition: Dictionary) -> Variant:
	var bucket := "npcs" if kind == "npc" else "hotspots"
	var committed_memory: Variant = _get_committed_memory(scene_id)
	var committed: Variant = null
	if not RuntimeDataTypes.is_cutscene_only_entity(definition) and committed_memory is Dictionary:
		committed = committed_memory.entityOverrides[bucket].get(entity_id)
	var staged: Variant = null
	if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == scene_id:
		staged = cutscene_staging.memory.entityOverrides[bucket].get(entity_id)
	if not committed is Dictionary and not staged is Dictionary: return null
	var merged: Dictionary = committed.duplicate(true) if committed is Dictionary else {}
	if staged is Dictionary: merged.merge(staged, true)
	return merged


func _runtime_override_for_context(scene_id: String, kind: String, entity_id: String, context: String) -> Variant:
	var bucket := "npcs" if kind == "npc" else "hotspots"
	if context == "outer":
		var committed: Variant = scene_memory.get(scene_id)
		return committed.entityOverrides[bucket].get(entity_id) if committed is Dictionary else null
	if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == scene_id:
		return cutscene_staging.memory.entityOverrides[bucket].get(entity_id)
	return null


func merge_hotspot_display_image_override(scene_id: String, hotspot_id: String, display_image: Dictionary) -> void:
	set_entity_runtime_field(scene_id, "hotspot", hotspot_id, "displayImage", display_image)


func set_entity_runtime_field(scene_id: String, kind: String, entity_id: String, field: String, value: Variant) -> Dictionary:
	var sid := scene_id.strip_edges(); var id := entity_id.strip_edges(); var key := field.strip_edges()
	if sid.is_empty() or id.is_empty() or key.is_empty(): return {"ok": false, "error": "setEntityRuntimeField: sceneId/entityId/fieldName 不能为空"}
	var checked: Dictionary = RuntimeEntityRuntimeFieldSchema.coerce_value(kind, key, value)
	if checked.get("ok") != true: return checked
	if not cutscene_staging is Dictionary and _is_current_cutscene_only_entity(sid, kind, id):
		return {"ok": false, "error": "setEntityRuntimeField: %s.%s 是仅过场实体，普通上下文不写 committed sceneMemory" % [kind, id]}
	var memory: Variant = _get_writable_memory(sid)
	if not memory is Dictionary: return {"ok": false, "error": "setEntityRuntimeField: 过场中忽略跨场景写入 %s" % sid}
	var bucket: Dictionary = memory.entityOverrides.npcs if kind == "npc" else memory.entityOverrides.hotspots; var previous: Dictionary = bucket.get(id, {}); previous[key] = checked.value; bucket[id] = previous
	return {"ok": true, "value": checked.value}


func get_entity_runtime_override(scene_id: String, kind: String, entity_id: String) -> Variant:
	var definition: Variant = _find_entity_definition(scene_id, kind, entity_id)
	if definition is Dictionary:
		return _entity_runtime_override_for_definition(scene_id, kind, entity_id, definition)
	var bucket := "npcs" if kind == "npc" else "hotspots"
	var committed_memory: Variant = _get_committed_memory(scene_id)
	var staging_memory: Variant = cutscene_staging.memory if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == scene_id else null
	var committed: Variant = committed_memory.entityOverrides[bucket].get(entity_id) if committed_memory is Dictionary else null
	var staged: Variant = staging_memory.entityOverrides[bucket].get(entity_id) if staging_memory is Dictionary else null
	if not committed is Dictionary and not staged is Dictionary: return null
	var merged: Dictionary = committed.duplicate(true) if committed is Dictionary else {}
	if staged is Dictionary: merged.merge(staged, true)
	return merged


func merge_persistent_npc_state(npc_id: String, patch: Dictionary) -> void:
	var sid := get_current_scene_id(); var id := npc_id.strip_edges()
	if sid.is_empty():
		push_warning("SceneManager.mergePersistentNpcState: 无当前场景")
		return
	if id.is_empty():
		push_warning("SceneManager.mergePersistentNpcState: 空 npcId")
		return
	if not cutscene_staging is Dictionary and _is_current_cutscene_only_entity(sid, "npc", id):
		push_warning("SceneManager.mergePersistentNpcState: \"%s\" 是仅过场 NPC，普通上下文不写 committed sceneMemory" % id)
		return
	var memory: Variant = _get_writable_memory(sid)
	if not memory is Dictionary: return
	var previous: Dictionary = memory.entityOverrides.npcs.get(id, {}); previous.merge(patch, true); memory.entityOverrides.npcs[id] = previous


func is_npc_patrol_persistently_disabled(npc_id: String) -> bool:
	var memory: Variant = _get_committed_memory(get_current_scene_id())
	var value: Variant = memory.entityOverrides.npcs.get(npc_id) if memory is Dictionary else null
	return value is Dictionary and value.get("patrolDisabled") == true


func apply_debug_world_size(width: float, height: float) -> Dictionary:
	if current_scene.is_empty() or scene_background == null or not is_finite(width) or not is_finite(height):
		return {"ok": false}
	var next_width := clampf(width, 50.0, 10000000.0)
	var next_height := clampf(height, 50.0, 10000000.0)
	var old_width := float(current_scene.get("worldWidth", 0.0))
	var old_height := float(current_scene.get("worldHeight", 0.0))
	if old_width <= 0.0 or old_height <= 0.0:
		return {"ok": false}
	current_scene.worldWidth = next_width
	current_scene.worldHeight = next_height

	var world_to_pixel_x := 1.0
	var world_to_pixel_y := 1.0
	var first_sprite: Sprite2D
	for child: Node in scene_background.get_children():
		if not child is Sprite2D or child.texture == null or child.texture.get_width() <= 0 or child.texture.get_height() <= 0:
			continue
		if first_sprite == null:
			first_sprite = child
		child.scale = Vector2(next_width / child.texture.get_width(), next_height / child.texture.get_height())
	if first_sprite == null:
		scene_background.scale *= Vector2(next_width / old_width, next_height / old_height)
	else:
		world_to_pixel_x = float(first_sprite.texture.get_width()) / next_width
		world_to_pixel_y = float(first_sprite.texture.get_height()) / next_height
	if _bounds_only_setter.is_valid():
		_bounds_only_setter.call(next_width, next_height)
	return {"ok": true, "worldToPixelX": world_to_pixel_x, "worldToPixelY": world_to_pixel_y}


func get_background_texels_per_world() -> Variant:
	if current_scene.is_empty() or scene_background == null:
		return null
	var width := float(current_scene.get("worldWidth", 0.0))
	var height := float(current_scene.get("worldHeight", 0.0))
	if width <= 0.0 or height <= 0.0:
		return null
	for child: Node in scene_background.get_children():
		if child is Sprite2D and child.texture != null and child.texture.get_width() > 0 and child.texture.get_height() > 0:
			return {"x": float(child.texture.get_width()) / width, "y": float(child.texture.get_height()) / height}
	return null


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


func get_primary_background_texture() -> Variant:
	return _primary_background_texture


func _instantiate_hotspot(definition: Dictionary, override: Variant) -> RuntimeHotspot:
	var effective := RuntimeHotspot.apply_runtime_override(definition, override)
	var hotspot := RuntimeHotspot.new(effective)
	_apply_session_override_on_instantiate("hotspot", hotspot)
	renderer.entity_layer.add_child(hotspot.container)
	var display_image: Variant = effective.get("displayImage")
	if display_image is Dictionary and not hotspot.load_display_image(asset_manager):
		push_warning("SceneManager: hotspot \"%s\" displayImage failed: %s" % [str(definition.get("id", "")), str(display_image.get("image", ""))])
	return hotspot


func _instantiate_npc(definition: Dictionary, override: Variant) -> RuntimeNpc:
	var effective := RuntimeNpc.apply_runtime_override(RuntimeCharacterRegistryScript.apply_character_defaults(definition, character_registry), override)
	var npc := RuntimeNpc.new(effective)
	_apply_session_override_on_instantiate("npc", npc)
	if not str(effective.get("animFile", "")).is_empty(): npc.load_sprite_from_path(str(effective.animFile), asset_manager, str(effective.get("initialAnimState", "")))
	if override is Dictionary and not str(override.get("animState", "")).strip_edges().is_empty(): npc.play_animation(str(override.animState))
	renderer.entity_layer.add_child(npc.container)
	return npc


func _count_scene_instantiate_work(scene_data: Dictionary, scene_id: String, committed_memory: Variant, active_cutscene_id: String) -> Dictionary:
	var hotspot_count := 0
	for definition: Variant in scene_data.get("hotspots", []):
		if not definition is Dictionary: continue
		var bound := not active_cutscene_id.is_empty() and RuntimeDataTypes.is_entity_bound_to_cutscene(definition, active_cutscene_id)
		if bound:
			hotspot_count += 1
		else:
			if RuntimeDataTypes.is_cutscene_only_entity(definition): continue
			if committed_memory is Dictionary and committed_memory.pickedUpHotspots.has(str(definition.get("id", ""))): continue
			var override: Variant = _runtime_override_for_context(scene_id, "hotspot", str(definition.get("id", "")), "outer")
			if override is Dictionary and override.get("enabled") == false: continue
			hotspot_count += 1
	var npc_count := 0
	for definition: Variant in scene_data.get("npcs", []):
		if not definition is Dictionary: continue
		var bound := not active_cutscene_id.is_empty() and RuntimeDataTypes.is_entity_bound_to_cutscene(definition, active_cutscene_id)
		if bound or not RuntimeDataTypes.is_cutscene_only_entity(definition): npc_count += 1
	return {"bgLayers": scene_data.get("backgrounds", []).size(), "hotspots": hotspot_count, "npcs": npc_count}


func _build_scene_resource_manifest(scene_id: String, scene_data: Dictionary) -> Dictionary:
	var refs: Array = []
	for layer: Variant in scene_data.get("backgrounds", []):
		if layer is Dictionary and not str(layer.get("image", "")).strip_edges().is_empty():
			refs.push_back({"type": "texture", "path": str(layer.image), "label": "背景: %s" % layer.image})
	var committed_memory: Variant = scene_memory.get(scene_id)
	var active_cutscene_id := str(cutscene_staging.cutsceneId) if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == scene_id else ""
	for definition: Variant in scene_data.get("hotspots", []):
		if not definition is Dictionary: continue
		var id := str(definition.get("id", ""))
		var bound := not active_cutscene_id.is_empty() and RuntimeDataTypes.is_entity_bound_to_cutscene(definition, active_cutscene_id)
		if not bound:
			if RuntimeDataTypes.is_cutscene_only_entity(definition): continue
			if committed_memory is Dictionary and committed_memory.get("pickedUpHotspots", []).has(id): continue
		var override: Variant = _runtime_override_for_context(scene_id, "hotspot", id, "cutscene" if bound else "outer")
		if not bound and override is Dictionary and override.get("enabled") == false: continue
		var effective := RuntimeHotspot.apply_runtime_override(definition, override)
		var display_image: Variant = effective.get("displayImage")
		if display_image is Dictionary and not str(display_image.get("image", "")).strip_edges().is_empty():
			refs.push_back({"type": "texture", "path": str(display_image.image), "label": "Hotspot: %s" % id})
	for definition: Variant in scene_data.get("npcs", []):
		if not definition is Dictionary: continue
		var id := str(definition.get("id", ""))
		var bound := not active_cutscene_id.is_empty() and RuntimeDataTypes.is_entity_bound_to_cutscene(definition, active_cutscene_id)
		if not bound and RuntimeDataTypes.is_cutscene_only_entity(definition): continue
		var override: Variant = _runtime_override_for_context(scene_id, "npc", id, "cutscene" if bound else "outer")
		var effective := RuntimeNpc.apply_runtime_override(RuntimeCharacterRegistryScript.apply_character_defaults(definition, character_registry), override)
		var anim_file := str(effective.get("animFile", "")).strip_edges()
		if anim_file.is_empty(): continue
		refs.push_back({"type": "json", "path": anim_file, "label": "NPC 动画清单: %s" % id})
		var animation: Variant = asset_manager.load_json(anim_file)
		if animation is Dictionary and not str(animation.get("spritesheet", "")).strip_edges().is_empty():
			refs.push_back({
				"type": "texture",
				"path": RuntimeResourceLocator.get_default().resolve_anim_relative(anim_file, str(animation.spritesheet)),
				"label": "NPC 图集: %s" % id,
			})
	var depth_config: Variant = scene_data.get("depthConfig")
	if depth_config is Dictionary:
		var base_path := "/resources/runtime/scenes/%s/" % scene_id
		if not str(depth_config.get("depth_map", "")).is_empty():
			refs.push_back({"type": "texture", "path": base_path + str(depth_config.depth_map), "label": "深度图: %s" % scene_id})
		if not str(depth_config.get("collision_map", "")).is_empty():
			refs.push_back({"type": "bitmap", "path": base_path + str(depth_config.collision_map), "label": "碰撞图: %s" % scene_id})
	var filter_id := str(scene_data.get("filterId", "")).strip_edges()
	if not filter_id.is_empty(): refs.push_back({"type": "filter", "path": filter_id, "label": "滤镜: %s" % filter_id})
	if _audio_manifest_resolver.is_valid():
		var audio_refs: Variant = _audio_manifest_resolver.call(scene_data.get("bgm"), scene_data.get("ambientSounds"))
		if audio_refs is Array: refs.append_array(audio_refs)
	return {"scopeId": "scene:%s" % scene_id, "refs": refs}


func _mount_background_layer(scene: Dictionary, layer: Dictionary, texture: Texture2D) -> void:
	var image := Sprite2D.new(); image.centered = false; image.texture = texture; image.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR; image.position = Vector2(float(layer.get("x", 0)), float(layer.get("y", 0))); image.scale = Vector2(float(scene.worldWidth) / maxf(1.0, texture.get_width()), float(scene.worldHeight) / maxf(1.0, texture.get_height())); image.z_index = clampi(int(layer.get("z", 0)), -4096, 4096)
	scene_background.add_child(image)
	if _primary_background_texture == null:
		_primary_background_texture = texture


func _mount_placeholder_background(scene: Dictionary) -> void:
	var placeholder := Polygon2D.new(); placeholder.name = "PlaceholderBackground"; placeholder.polygon = PackedVector2Array([Vector2.ZERO, Vector2(float(scene.worldWidth), 0), Vector2(float(scene.worldWidth), float(scene.worldHeight)), Vector2(0, float(scene.worldHeight))]); placeholder.color = Color("202638"); scene_background.add_child(placeholder)


func load_scene(
	scene_id: String,
	spawn_point_id := "",
	camera_position: Variant = null,
	from_scene_id: Variant = null,
	on_load_progress: Callable = Callable(),
	on_reveal: Callable = Callable(),
) -> bool:
	var id := scene_id.strip_edges()
	if id.is_empty(): return false
	if on_load_progress.is_valid(): on_load_progress.call(0.0, "场景 JSON · %s" % id)
	var scene := asset_manager.load_scene_data(id)
	# Direct counterpart of `await assetManager.loadSceneData(sceneId)`. Local
	# filesystem reads finish synchronously, but queued zone-exit work must retain
	# the source Promise ordering before the new scene is committed. The nested
	# `loadSceneData -> await loadJson` continuation is a second microtask layer.
	await RuntimeMicrotaskQueueScript.yield_turn()
	await RuntimeMicrotaskQueueScript.yield_turn()
	if scene.is_empty() or str(scene.get("id", "")) != id: return false
	current_scene = scene
	var manifest := _build_scene_resource_manifest(id, scene)
	var committed_memory: Variant = _get_committed_memory(id)
	var active_cutscene_id := str(cutscene_staging.cutsceneId) if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == id else ""
	var progress := {"done": 0, "total": 1}
	var report := func(label: String) -> void:
		if on_load_progress.is_valid(): on_load_progress.call(minf(1.0, float(progress.done) / float(progress.total)), label)
	var advance := func(label: String) -> void:
		if not on_load_progress.is_valid(): return
		progress.done += 1
		on_load_progress.call(minf(1.0, float(progress.done) / float(progress.total)), label)
	if on_load_progress.is_valid():
		var work := _count_scene_instantiate_work(scene, id, committed_memory, active_cutscene_id)
		progress.total = 1 + manifest.refs.size() + int(work.bgLayers) + int(work.hotspots) + int(work.npcs) + int(_depth_loader.is_valid()) + int(not str(scene.get("filterId", "")).strip_edges().is_empty())
		advance.call("JSON ✓ · %s" % str(scene.get("name", id)))
	asset_manager.preload_manifest(manifest, {
		"mode": "stage",
		"tolerateErrors": true,
		"onProgress": func(ratio: float, label: String) -> void:
			if not on_load_progress.is_valid(): return
			progress.done = 1 + roundi(ratio * manifest.refs.size())
			on_load_progress.call(minf(1.0, float(progress.done) / float(progress.total)), label),
	})
	if on_load_progress.is_valid(): progress.done = 1 + manifest.refs.size()
	_current_scene_scope_id = str(manifest.scopeId)
	var backgrounds: Array = scene.get("backgrounds", [])
	var committed_for_read: Dictionary = committed_memory if committed_memory is Dictionary else _empty_memory()
	var staging_memory: Variant = cutscene_staging.memory if cutscene_staging is Dictionary and str(cutscene_staging.sceneId) == id else null
	scene_background = Node2D.new(); scene_background.name = "SceneBackground:%s" % id
	_primary_background_texture = null
	var layers := backgrounds.duplicate(true)
	layers.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return float(a.get("z", 0)) < float(b.get("z", 0)))
	var first_texture: Texture2D
	for index in layers.size():
		var layer: Variant = layers[index]
		if not layer is Dictionary: continue
		report.call("背景 %d/%d: %s" % [index + 1, layers.size(), str(layer.get("image", ""))])
		var texture: Variant = asset_manager.load_texture(str(layer.get("image", "")))
		if texture is Texture2D:
			if index == 0: first_texture = texture
			_mount_background_layer(scene, layer, texture)
		advance.call("背景层 %d/%d ✓" % [index + 1, layers.size()])
	if backgrounds.is_empty(): _mount_placeholder_background(scene)
	renderer.background_layer.add_child(scene_background)
	for definition: Variant in scene.get("hotspots", []):
		if not definition is Dictionary: continue
		var bound := RuntimeDataTypes.is_entity_bound_to_cutscene(definition, active_cutscene_binding_id); if RuntimeDataTypes.is_cutscene_only_entity(definition) and not bound: continue
		var memory: Dictionary = staging_memory if bound and staging_memory is Dictionary else committed_for_read
		var hotspot_id := str(definition.get("id", "")); if not bound and memory.pickedUpHotspots.has(hotspot_id): continue
		var override: Variant = memory.entityOverrides.hotspots.get(hotspot_id)
		if not bound and override is Dictionary and override.get("enabled") == false: continue
		report.call("Hotspot %s%s" % [hotspot_id, " · cutscene" if bound else ""])
		var hotspot := _instantiate_hotspot(definition, override)
		current_hotspots.push_back(hotspot)
		advance.call("Hotspot %s ✓" % hotspot_id)
	for definition: Variant in scene.get("npcs", []):
		if not definition is Dictionary: continue
		var bound := RuntimeDataTypes.is_entity_bound_to_cutscene(definition, active_cutscene_binding_id); if RuntimeDataTypes.is_cutscene_only_entity(definition) and not bound: continue
		var memory: Dictionary = staging_memory if bound and staging_memory is Dictionary else committed_for_read
		var npc_id := str(definition.get("id", "")); var override: Variant = memory.entityOverrides.npcs.get(npc_id)
		report.call("NPC %s%s" % [npc_id, " · cutscene" if bound else ""])
		var npc := _instantiate_npc(definition, override)
		current_npcs.push_back(npc)
		advance.call("NPC %s ✓" % npc_id)
	if not _interaction_setter.is_null() and _interaction_setter.is_valid(): _interaction_setter.call(current_hotspots, current_npcs)
	_apply_spawn_and_camera(scene, spawn_point_id, camera_position)
	if not _audio_applier.is_null() and _audio_applier.is_valid(): _audio_applier.call(scene.get("bgm"), scene.get("ambientSounds", []))
	if not _zone_setter.is_null() and _zone_setter.is_valid(): _zone_setter.call(_compute_effective_zones(id, scene.get("zones")))
	var world_to_pixel_x := float(first_texture.get_width()) / maxf(1.0, float(scene.get("worldWidth", 1.0))) if first_texture != null else 1.0
	var world_to_pixel_y := float(first_texture.get_height()) / maxf(1.0, float(scene.get("worldHeight", 1.0))) if first_texture != null else 1.0
	if not _depth_loader.is_null() and _depth_loader.is_valid():
		report.call("深度图 · %s" % id)
		await _depth_loader.call(id, scene, world_to_pixel_x, world_to_pixel_y)
		advance.call("深度图 ✓")
	var filter_id := str(scene.get("filterId", "")).strip_edges()
	if not filter_id.is_empty(): report.call("世界滤镜 · %s" % filter_id)
	if filter_id.is_empty() or not renderer.load_and_set_world_filter(filter_id):
		renderer.clear_world_filter()
	if not filter_id.is_empty(): advance.call("世界滤镜 ✓")
	if on_load_progress.is_valid(): on_load_progress.call(1.0, "就绪 · %s" % id)
	event_bus.emit("scene:enter", {"sceneId": id, "fromSceneId": from_scene_id, "sceneName": str(scene.get("name", id))})
	event_bus.emit("scene:ready")
	if on_reveal.is_valid(): await on_reveal.call()
	var root_enter: Variant = scene.get("onEnter")
	if root_enter is Array and not root_enter.is_empty() and _scene_enter_runner.is_valid():
		_scene_enter_batch_depth += 1
		await _scene_enter_runner.call(root_enter)
		_scene_enter_batch_depth -= 1
	if not _switching: _consume_pending_reentrant_switch()
	return true


func load_initial_scene(scene_id: String, spawn_point_id := "") -> bool:
	_ensure_transition_overlay()
	_transition_overlay.modulate.a = 1.0
	var reveal := func() -> void: await _fade_in(400.0)
	var loaded := await load_scene(
		scene_id,
		spawn_point_id,
		null,
		null,
		Callable(self, "_set_transition_overlay_progress"),
		reveal,
	)
	if not loaded:
		_remove_transition_overlay()
	return loaded


func _apply_spawn_and_camera(scene: Dictionary, spawn_point_id: String, camera_position: Variant) -> void:
	var spawn: Variant = scene.get("spawnPoint", {"x": 0, "y": 0}); var key := spawn_point_id.strip_edges(); var named: Variant = scene.get("spawnPoints")
	if not key.is_empty() and named is Dictionary and named.get(key) is Dictionary: spawn = named[key]
	var x := float(camera_position.get("x", spawn.get("x", 0))) if camera_position is Dictionary else float(spawn.get("x", 0)); var y := float(camera_position.get("y", spawn.get("y", 0))) if camera_position is Dictionary else float(spawn.get("y", 0))
	if _player_position_setter.is_valid(): _player_position_setter.call(x, y)
	if _camera_setter.is_valid(): _camera_setter.call(float(scene.worldWidth), float(scene.worldHeight), x, y, scene.get("camera"), float(scene.get("worldScale", 1.0)))


func unload_scene() -> void:
	_scene_epoch += 1
	event_bus.emit("scene:beforeUnload")
	if not _interaction_setter.is_null() and _interaction_setter.is_valid(): _interaction_setter.call([], [])
	if _current_scene_scope_id != null:
		asset_manager.release_scope(str(_current_scene_scope_id))
		_current_scene_scope_id = null
	for hotspot: RuntimeHotspot in current_hotspots:
		_release_hotspot_filters(hotspot)
		hotspot.destroy_hotspot()
	for npc: RuntimeNpc in current_npcs:
		_release_npc_filters(npc)
		npc.destroy_npc()
	current_hotspots.clear(); current_npcs.clear()
	if scene_background != null and is_instance_valid(scene_background):
		if scene_background.get_parent() != null: scene_background.get_parent().remove_child(scene_background)
		scene_background.free()
	scene_background = null
	_primary_background_texture = null
	if not _depth_unloader.is_null() and _depth_unloader.is_valid(): _depth_unloader.call()
	if not _zone_setter.is_null() and _zone_setter.is_valid(): _zone_setter.call([])
	current_scene.clear()


func switch_scene(target_scene_id: String, spawn_point_id := "", camera_position: Variant = null) -> bool:
	if _scene_enter_batch_depth > 0:
		if _pending_reentrant_switch is Dictionary:
			push_warning("SceneManager: onEnter 批内多次 changeScene，丢弃 \"%s\"、保留 \"%s\"" % [str(_pending_reentrant_switch.get("targetSceneId", "")), target_scene_id])
		_pending_reentrant_switch = {"targetSceneId": target_scene_id, "spawnPointId": spawn_point_id, "cameraPosition": camera_position}
		return true
	var result := {"ok": false}
	var job := func() -> void:
		var target := target_scene_id.strip_edges()
		if target.is_empty(): return
		var current_id := get_current_scene_id().strip_edges()
		if current_id == target:
			var wants_spawn_override := not spawn_point_id.strip_edges().is_empty()
			var wants_camera_override: bool = camera_position is Dictionary and (camera_position.has("x") or camera_position.has("y"))
			if not wants_spawn_override and not wants_camera_override:
				result.ok = true
				return
			if current_scene.is_empty(): return
			if not cutscene_staging is Dictionary: _save_current_scene_memory()
			_apply_spawn_and_camera(current_scene, spawn_point_id, camera_position)
			result.ok = true
			return
		_switching = true
		event_bus.emit("scene:transition", {"fromSceneId": current_id if not current_id.is_empty() else null, "toSceneId": target})
		_save_current_scene_memory()
		await _fade_out(300.0)
		var from_scene_id: Variant = current_id if not current_id.is_empty() else null
		unload_scene()
		var reveal := func() -> void: await _fade_in(300.0)
		var loaded := await load_scene(target, spawn_point_id, camera_position, from_scene_id, Callable(self, "_set_transition_overlay_progress"), reveal)
		if not loaded:
			unload_scene()
			var recovered := false
			if from_scene_id != null:
				recovered = await load_scene(str(from_scene_id), "", null, target, Callable(self, "_set_transition_overlay_progress"), reveal)
			event_bus.emit("notification:show", {
				"text": "无法进入「%s」，已退回原场景" % target if recovered else "场景「%s」加载失败" % target,
				"type": "warning",
			})
			if not recovered: _remove_transition_overlay()
			result.ok = recovered
		else:
			result.ok = true
		_switching = false
	await _scene_switch_tail.then(job)
	_consume_pending_reentrant_switch()
	return result.ok == true


func _consume_pending_reentrant_switch() -> void:
	if _scene_enter_batch_depth > 0 or not _pending_reentrant_switch is Dictionary:
		return
	var request: Dictionary = _pending_reentrant_switch
	_pending_reentrant_switch = null
	switch_scene(str(request.get("targetSceneId", "")), str(request.get("spawnPointId", "")), request.get("cameraPosition"))


func _save_current_scene_memory() -> void:
	if current_scene.is_empty() or cutscene_staging is Dictionary: return
	_ensure_scene_memory(get_current_scene_id())


func _mark_hotspot_picked_up(id: String) -> void:
	var index := current_hotspots.find_custom(func(candidate: RuntimeHotspot) -> bool: return candidate.get_id() == id)
	var hotspot: Variant = current_hotspots[index] if index >= 0 else null
	if hotspot != null: hotspot.mark_picked_up()
	var definition: Variant = hotspot.def if hotspot != null else _find_entity_definition(get_current_scene_id(), "hotspot", id)
	if not definition is Dictionary or str(definition.get("type", "")) != "pickup": return
	var memory: Variant = _get_writable_memory(get_current_scene_id()); if memory is Dictionary and not memory.pickedUpHotspots.has(id): memory.pickedUpHotspots.push_back(id)


func _mark_hotspot_inspected(id: String) -> void:
	var memory: Variant = _get_writable_memory(get_current_scene_id()); if memory is Dictionary and not memory.inspectedHotspots.has(id): memory.inspectedHotspots.push_back(id)


func _fade_out(duration_ms: float) -> void:
	_ensure_transition_overlay()
	_transition_overlay.modulate.a = 0.0
	await _animate_alpha(_transition_overlay, 0.0, 1.0, duration_ms)


func _fade_in(duration_ms: float) -> void:
	_ensure_transition_overlay()
	_transition_overlay.modulate.a = 1.0
	await _animate_alpha(_transition_overlay, 1.0, 0.0, duration_ms)
	_remove_transition_overlay()


func _ensure_transition_overlay() -> void:
	if _transition_overlay != null and is_instance_valid(_transition_overlay): return
	var screen_width := renderer.screen_width
	var screen_height := renderer.screen_height
	var root := Control.new()
	root.name = "SceneTransitionOverlay"
	root.position = Vector2(-100.0, -100.0)
	root.size = Vector2(screen_width + 200.0, screen_height + 200.0)
	root.mouse_filter = Control.MOUSE_FILTER_STOP
	var background := ColorRect.new()
	background.color = Color.BLACK
	background.size = root.size
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(background)
	var bar_width := minf(480.0, maxf(200.0, roundf(screen_width * 0.72)))
	var bar_height := maxf(6.0, roundf(screen_height * 0.014))
	var bar_x := 100.0 + (screen_width - bar_width) / 2.0
	var bar_y := 100.0 + roundf(screen_height * 0.88)
	if OS.is_debug_build():
		var debug_label := Label.new()
		debug_label.position = Vector2(bar_x, bar_y - 24.0)
		debug_label.size = Vector2(bar_width, 16.0)
		debug_label.add_theme_font_size_override("font_size", 10)
		debug_label.add_theme_color_override("font_color", Color("a8b8cf"))
		root.add_child(debug_label)
		_transition_debug_label = debug_label
	var track := ColorRect.new()
	track.position = Vector2(bar_x, bar_y)
	track.size = Vector2(bar_width, bar_height)
	track.color = Color(0.118, 0.161, 0.231, 0.92)
	root.add_child(track)
	var fill := ColorRect.new()
	fill.position = Vector2(bar_x, bar_y)
	fill.size = Vector2(0.0, bar_height)
	fill.color = Color("38bdf8")
	root.add_child(fill)
	_transition_overlay = root
	_transition_bar_fill = fill
	_transition_bar_width = bar_width
	_transition_bar_height = bar_height
	renderer.ui_layer.add_child(root)
	_set_transition_overlay_progress(0.0, "")


func _set_transition_overlay_progress(ratio_01: float, debug_label: String) -> void:
	var ratio := clampf(ratio_01, 0.0, 1.0)
	if _transition_bar_fill != null and is_instance_valid(_transition_bar_fill):
		_transition_bar_fill.size = Vector2(maxf(0.0, ratio * _transition_bar_width), _transition_bar_height)
	if _transition_debug_label != null and is_instance_valid(_transition_debug_label):
		_transition_debug_label.text = "[%d%%] %s" % [roundi(ratio * 100.0), debug_label]


func _remove_transition_overlay() -> void:
	if _transition_overlay != null and is_instance_valid(_transition_overlay):
		if _transition_overlay.get_parent() != null: _transition_overlay.get_parent().remove_child(_transition_overlay)
		_transition_overlay.queue_free()
	_transition_overlay = null
	_transition_bar_fill = null
	_transition_debug_label = null


func _animate_alpha(target: CanvasItem, from: float, to: float, duration_ms: float) -> void:
	if _animation_tween != null and _animation_tween.is_valid(): _animation_tween.kill()
	target.modulate.a = from
	_animation_tween = create_tween()
	_animation_tween.tween_property(target, "modulate:a", to, maxf(0.0, duration_ms) / 1000.0)
	await _animation_tween.finished


func serialize() -> Dictionary:
	_save_current_scene_memory()
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
	if _animation_tween != null and _animation_tween.is_valid(): _animation_tween.kill()
	zone_session_disabled.clear()
	entity_session_overrides.clear()
	_pending_reentrant_switch = null
	event_bus.off("hotspot:pickup:done", _on_hotspot_pickup)
	event_bus.off("hotspot:inspected", _on_hotspot_inspected)
	unload_scene()
	_remove_transition_overlay()
	scene_memory.clear()
	cutscene_staging = null
	_player_position_setter = Callable()
	_camera_setter = Callable()
	_bounds_only_setter = Callable()
	_audio_applier = Callable()
	_zone_setter = Callable()
	_interaction_setter = Callable()
	_depth_loader = Callable()
	_depth_unloader = Callable()
