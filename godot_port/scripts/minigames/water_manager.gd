class_name RuntimeWaterMinigameManager
extends RuntimeMinigameSessionManagerBase

const INDEX_URL := "/assets/data/water_minigames/index.json"
const DAILY_SOFT_CAP := 3

var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor = null
var day_manager: RuntimeDayManager = null
var resolve_text_fn: Variant = null
var pending_use_key: Variant = null
var session_degraded := false
var session_use_key: Variant = null
var uses_by_spot_day: Dictionary = {}
var consumed_pull_entities: Dictionary = {}
var session_pull_space_held := false
var bound_pull_space_key_down: Variant = null
var bound_pull_space_key_up: Variant = null
var bound_pull_window_blur: Variant = null


func _init() -> void:
	index_url = INDEX_URL
	data_subdir = "water_minigames"
	scope_prefix = "minigame:water"
	system_label = "WaterMinigameManager"
	set_process_input(false)


func init(ctx: Dictionary) -> void:
	super.init(ctx)
	flag_store = ctx.get("flagStore")


func bind_runtime(deps: Dictionary) -> void:
	renderer = deps.get("renderer")
	input_manager = deps.get("inputManager")
	state_controller = deps.get("stateController")
	action_executor = deps.get("actionExecutor")
	day_manager = deps.get("dayManager")
	resolve_text_fn = deps.get("resolveDisplayText")


func runtime_ready() -> bool:
	return super.runtime_ready() and action_executor != null and resolve_text_fn is Callable and resolve_text_fn.is_valid()


func serialize() -> Dictionary:
	return {
		"usesBySpotDay": uses_by_spot_day.duplicate(true),
		"consumedPullEntities": consumed_pull_entities.keys(),
	}


func get_debug_visual_state() -> Dictionary:
	return {"active": active, "scene": scene.get_debug_visual_state() if scene != null else null}


func deserialize(data: Dictionary) -> void:
	uses_by_spot_day = data.get("usesBySpotDay", {}).duplicate(true) if data.get("usesBySpotDay") is Dictionary else {}
	consumed_pull_entities = {}
	var consumed: Variant = data.get("consumedPullEntities", [])
	if consumed is Array:
		for value: Variant in consumed:
			consumed_pull_entities[value] = true


func destroy() -> void:
	pending_use_key = null
	_detach_session_pull_space_bridge()
	super.destroy()


func prepare_instance(original: Dictionary) -> Dictionary:
	var prepared := original.duplicate(false)
	var entities: Array = []
	for entity: Variant in original.entities:
		if entity.get("consumeOnSuccess") != true or not consumed_pull_entities.has("%s::%s" % [original.id, entity.id]):
			entities.push_back(entity)
	prepared.entities = entities

	var spot: Variant = prepared.get("spotId")
	if spot == null:
		spot = prepared.id
	var day_raw: Variant = day_manager.get_current_day() if day_manager != null else flag_store.get_value(RuntimeFlagKeys.CURRENT_DAY)
	var day: Variant = day_raw if (day_raw is int or day_raw is float) and is_finite(float(day_raw)) else 1
	var day_text := str(int(day)) if day is float and day == floorf(day) else str(day)
	var key := "%s|%s" % [spot, day_text]
	session_use_key = key
	session_degraded = int(uses_by_spot_day.get(key, 0)) >= DAILY_SOFT_CAP
	return prepared


func on_session_active(_instance: Dictionary) -> void:
	_attach_session_pull_space_bridge()


func create_scene(next_instance: Dictionary) -> Variant:
	return RuntimeWaterMinigameScene.new(
		renderer,
		asset_manager,
		action_executor,
		resolve_text_fn,
		func() -> bool: return session_pull_space_held or (input_manager != null and input_manager.is_mouse_down()),
		func(_reason: String) -> void: teardown_session(),
		func(_instance_id: String, entity_id: String) -> void: _mark_consumed(str(next_instance.id), entity_id),
		Callable(self, "restore_minigame_state_after_action")
	)


func load_scene_content(next_scene: Variant, next_instance: Dictionary) -> Variant:
	return await next_scene.load(next_instance, {"degraded": session_degraded})


func on_scene_loaded(_instance: Dictionary) -> void:
	pending_use_key = session_use_key


func tick_scene(next_scene: Variant, dt: float) -> void:
	if input_manager == null:
		return
	next_scene.update(dt, input_manager.get_mouse_pos())


func on_teardown() -> void:
	_detach_session_pull_space_bridge()
	if pending_use_key is String and not pending_use_key.is_empty():
		var key: String = pending_use_key
		pending_use_key = null
		uses_by_spot_day[key] = int(uses_by_spot_day.get(key, 0)) + 1


func build_instance_manifest_refs(next_instance: Dictionary) -> Array:
	var refs: Array = []
	var add_texture := func(path: Variant, label: String) -> void:
		if path is String and not path.strip_edges().is_empty():
			refs.push_back({"type": "texture", "path": path, "label": label})
	var water_bottom: Variant = next_instance.get("waterBottom")
	add_texture.call(water_bottom.get("texture") if water_bottom is Dictionary else null, "水域底图: %s" % next_instance.id)
	var shore: Variant = next_instance.get("shoreForeground")
	var banks: Array = shore.get("banks", []) if shore is Dictionary and shore.get("banks") is Array else []
	for bank: Variant in banks:
		add_texture.call(bank.get("sprite"), "水域岸边: %s" % next_instance.id)
	for entity: Variant in next_instance.entities:
		add_texture.call(entity.get("sprite"), "水域实体: %s" % entity.id)
	return refs


func _mark_consumed(instance_id: String, entity_id: String) -> void:
	consumed_pull_entities["%s::%s" % [instance_id, entity_id]] = true


func _attach_session_pull_space_bridge() -> void:
	_detach_session_pull_space_bridge()
	session_pull_space_held = false
	bound_pull_space_key_down = func(event: InputEventKey) -> void:
		if not active or event.keycode != KEY_SPACE:
			return
		get_viewport().set_input_as_handled()
		session_pull_space_held = true
	bound_pull_space_key_up = func(event: InputEventKey) -> void:
		if event.keycode == KEY_SPACE:
			session_pull_space_held = false
	bound_pull_window_blur = func() -> void:
		session_pull_space_held = false
	set_process_input(true)


func _detach_session_pull_space_bridge() -> void:
	bound_pull_space_key_down = null
	bound_pull_space_key_up = null
	bound_pull_window_blur = null
	set_process_input(false)
	session_pull_space_held = false


# Godot platform adapter: the translated class still owns the three callbacks;
# engine notifications only normalize and forward browser key/blur equivalents.
func _input(event: InputEvent) -> void:
	if not event is InputEventKey:
		return
	if event.pressed:
		if bound_pull_space_key_down is Callable:
			bound_pull_space_key_down.call(event)
	elif bound_pull_space_key_up is Callable:
		bound_pull_space_key_up.call(event)


func _notification(what: int) -> void:
	if what in [NOTIFICATION_APPLICATION_FOCUS_OUT, NOTIFICATION_WM_WINDOW_FOCUS_OUT, NOTIFICATION_APPLICATION_PAUSED]:
		if bound_pull_window_blur is Callable:
			bound_pull_window_blur.call()
