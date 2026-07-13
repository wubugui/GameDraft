class_name RuntimeWaterMinigameManager
extends RuntimeMinigameSessionManagerBase

const INDEX_URL := "/assets/data/water_minigames/index.json"
const DAILY_SOFT_CAP := 3

var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var day_manager: RuntimeDayManager
var resolve_display_text := Callable()
var pending_use_key: Variant = null
var session_degraded := false
var session_use_key: Variant = null
var uses_by_spot_day: Dictionary = {}
var consumed_pull_entities: Dictionary = {}
var session_pull_space_held := false
var _unsubscribe_pull_down := Callable()
var _unsubscribe_pull_up := Callable()


func init(ctx: Dictionary) -> void:
	super.init(ctx); flag_store = ctx.get("flagStore")


func bind_runtime(deps: Dictionary) -> void:
	bind_session_runtime(deps); action_executor = deps.get("actionExecutor"); day_manager = deps.get("dayManager"); resolve_display_text = deps.get("resolveDisplayText", Callable())
	if input_manager != null and not input_manager.focus_lost.is_connected(Callable(self, "_on_pull_focus_lost")): input_manager.focus_lost.connect(Callable(self, "_on_pull_focus_lost"))


func runtime_ready() -> bool: return super.runtime_ready() and action_executor != null and resolve_display_text.is_valid()
func get_index_url() -> String: return INDEX_URL
func get_data_subdir() -> String: return "water_minigames"
func get_scope_prefix() -> String: return "minigame:water"


func serialize() -> Dictionary: return {"usesBySpotDay": uses_by_spot_day.duplicate(true), "consumedPullEntities": consumed_pull_entities.keys()}


func deserialize(data: Dictionary) -> void:
	uses_by_spot_day = data.get("usesBySpotDay", {}).duplicate(true) if data.get("usesBySpotDay") is Dictionary else {}
	consumed_pull_entities.clear()
	var consumed: Variant = data.get("consumedPullEntities")
	if consumed is Array:
		for value: Variant in consumed:
			consumed_pull_entities[str(value)] = true


func prepare_instance(original: Dictionary) -> Dictionary:
	var prepared := original.duplicate(true)
	var filtered: Array = []
	for value: Variant in original.get("entities", []):
		if value is Dictionary and (value.get("consumeOnSuccess") != true or not consumed_pull_entities.has("%s::%s" % [original.id, value.id])):
			filtered.push_back(value.duplicate(true))
	prepared.entities = filtered
	var spot := str(prepared.get("spotId", prepared.id))
	var day := day_manager.get_current_day() if day_manager != null else int(flag_store.get_value("current_day"))
	if day <= 0:
		day = 1
	var key := "%s|%s" % [spot, day]
	session_use_key = key
	session_degraded = int(uses_by_spot_day.get(key, 0)) >= DAILY_SOFT_CAP
	return prepared


func on_session_active(_instance: Dictionary) -> void: _attach_pull_space_bridge()


func create_scene(next_instance: Dictionary) -> Variant:
	return RuntimeWaterMinigameScene.new(renderer, asset_manager, action_executor, resolve_display_text, Callable(self, "_is_pull_held"), Callable(self, "_on_scene_finish"), Callable(self, "_mark_consumed"), Callable(self, "restore_minigame_state_after_action"))


func load_scene_content(next_scene: Variant, next_instance: Dictionary) -> void: await next_scene.load(next_instance, {"degraded": session_degraded})
func on_scene_loaded(_instance: Dictionary) -> void: pending_use_key = session_use_key
func tick_scene(next_scene: Variant, dt: float) -> void: next_scene.update(dt, input_manager.get_mouse_pos())


func on_teardown() -> void:
	_detach_pull_space_bridge()
	if pending_use_key != null: var key := str(pending_use_key); pending_use_key = null; uses_by_spot_day[key] = int(uses_by_spot_day.get(key, 0)) + 1


func build_instance_manifest_refs(next_instance: Dictionary) -> Array:
	var refs: Array = []; var bottom := str(next_instance.get("waterBottom", {}).get("texture", "")).strip_edges(); if not bottom.is_empty(): refs.push_back({"type": "texture", "path": bottom, "label": "水域底图: %s" % next_instance.id})
	var shore: Variant = next_instance.get("shoreForeground")
	if shore is Dictionary and shore.get("banks") is Array: for value: Variant in shore.banks: if value is Dictionary and not str(value.get("sprite", "")).strip_edges().is_empty(): refs.push_back({"type": "texture", "path": str(value.sprite), "label": "水域岸边: %s" % next_instance.id})
	for value: Variant in next_instance.get("entities", []): if value is Dictionary and not str(value.get("sprite", "")).strip_edges().is_empty(): refs.push_back({"type": "texture", "path": str(value.sprite), "label": "水域实体: %s" % value.id})
	return refs


func get_use_count(key: String) -> int: return int(uses_by_spot_day.get(key, 0))
func is_entity_consumed(instance_id: String, entity_id: String) -> bool: return consumed_pull_entities.has("%s::%s" % [instance_id, entity_id])
func is_session_degraded() -> bool: return session_degraded
func get_debug_visual_state() -> Dictionary: return {"active": active, "scene": scene.get_debug_visual_state() if scene != null else null}


func destroy() -> void:
	pending_use_key = null; _detach_pull_space_bridge(); if input_manager != null and input_manager.focus_lost.is_connected(Callable(self, "_on_pull_focus_lost")): input_manager.focus_lost.disconnect(Callable(self, "_on_pull_focus_lost")); super.destroy()


func _on_scene_finish(_reason: String) -> void: teardown_session()
func _mark_consumed(instance_id: String, entity_id: String) -> void: consumed_pull_entities["%s::%s" % [instance_id, entity_id]] = true
func _is_pull_held() -> bool: return session_pull_space_held or (input_manager != null and input_manager.is_mouse_down())


func _attach_pull_space_bridge() -> void:
	_detach_pull_space_bridge(); session_pull_space_held = false; _unsubscribe_pull_down = input_manager.subscribe_key_down(Callable(self, "_on_pull_key_down")); _unsubscribe_pull_up = input_manager.subscribe_key_up(Callable(self, "_on_pull_key_up"))


func _detach_pull_space_bridge() -> void:
	if _unsubscribe_pull_down.is_valid(): _unsubscribe_pull_down.call()
	if _unsubscribe_pull_up.is_valid(): _unsubscribe_pull_up.call()
	_unsubscribe_pull_down = Callable(); _unsubscribe_pull_up = Callable(); session_pull_space_held = false


func _on_pull_key_down(record: Dictionary) -> void: if active and str(record.get("code", "")) == "Space": session_pull_space_held = true
func _on_pull_key_up(record: Dictionary) -> void: if str(record.get("code", "")) == "Space": session_pull_space_held = false
func _on_pull_focus_lost() -> void: session_pull_space_held = false
