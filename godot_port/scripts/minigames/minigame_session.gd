class_name RuntimeMinigameSessionManagerBase
extends RuntimeSystem

var asset_manager: RuntimeAssetManager
var renderer: RuntimeRenderer
var input_manager: RuntimeInputManager
var state_controller: RuntimeGameStateController
var index: Array = []
var scene: Variant = null
var active := false
var previous_state := RuntimeGameStateController.EXPLORING
var last_result: Variant = null

var _instance_cache: Dictionary = {}
var _active_scope_id := ""
var _unsubscribe_key := Callable()
var _on_session_end := Callable()
var _start_in_flight := false
var _session_waiting := false
var _session_epoch := 0
var _destroyed := false


func is_active() -> bool:
	return active


func init(ctx: Dictionary) -> void:
	asset_manager = ctx.get("assetManager")


func bind_session_runtime(deps: Dictionary) -> void:
	renderer = deps.get("renderer")
	input_manager = deps.get("inputManager")
	state_controller = deps.get("stateController")


func update(dt: float) -> void:
	if active and scene != null:
		tick_scene(scene, dt)


func set_on_session_end(callback: Callable = Callable()) -> void:
	_on_session_end = callback


func load_index() -> bool:
	var raw: Variant = asset_manager.load_json(get_index_url()) if asset_manager != null else null
	index = raw.duplicate(true) if raw is Array else []
	return raw is Array


func get_instance_list() -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for value: Variant in index:
		if value is Dictionary:
			result.push_back({"id": str(value.get("id", "")), "label": str(value.get("label", ""))})
	return result


func run_until_done(id: String) -> Variant:
	if active or _start_in_flight or _session_waiting or _destroyed:
		return null
	_session_waiting = true
	last_result = null
	await start(id)
	_session_waiting = false
	return last_result


func start(id: String) -> void:
	if not runtime_ready() or active or _start_in_flight or _destroyed:
		return
	_start_in_flight = true
	var epoch := _session_epoch
	var instance: Variant = load_instance(id)
	if epoch != _session_epoch or _destroyed:
		_start_in_flight = false
		return
	if not instance is Dictionary or not validate_instance(instance):
		_start_in_flight = false
		return
	instance = prepare_instance(instance)
	if not instance is Dictionary:
		_start_in_flight = false
		return
	_active_scope_id = "%s:%s" % [get_scope_prefix(), str(instance.get("id", ""))]
	asset_manager.preload_manifest({"scopeId": _active_scope_id, "refs": build_instance_manifest_refs(instance)}, {"mode": "stage", "tolerateErrors": true})
	if epoch != _session_epoch or _destroyed:
		_release_active_scope()
		_start_in_flight = false
		return
	previous_state = state_controller.current_state
	state_controller.set_state(RuntimeGameStateController.MINIGAME)
	input_manager.set_game_keyboard_blocked(true)
	active = true
	last_result = null
	on_session_active(instance)
	_unsubscribe_key = input_manager.subscribe_key_down(Callable(self, "_handle_session_key_down"))
	scene = create_scene(instance)
	if scene == null:
		_start_in_flight = false
		teardown_session()
		return
	await load_scene_content(scene, instance)
	if epoch != _session_epoch or not active or scene == null or _destroyed:
		_start_in_flight = false
		return
	var root := _scene_root(scene)
	if root == null:
		_start_in_flight = false
		teardown_session()
		return
	renderer.cutscene_overlay.add_child(root)
	on_scene_loaded(instance)
	_start_in_flight = false
	while active and epoch == _session_epoch and not _destroyed:
		await Engine.get_main_loop().process_frame


func load_instance(id: String) -> Variant:
	var key := id.strip_edges()
	if _instance_cache.has(key):
		return _instance_cache[key]
	var entry: Variant = null
	for value: Variant in index:
		if value is Dictionary and str(value.get("id", "")).strip_edges() == key:
			entry = value
			break
	if not entry is Dictionary:
		return null
	var path := asset_manager.locator.data_subdir_json_url(get_data_subdir(), str(entry.get("file", "")))
	var loaded: Variant = asset_manager.load_json(path)
	if loaded is Dictionary:
		_instance_cache[key] = loaded
		return loaded
	return null


func teardown_session() -> void:
	if not active:
		return
	_session_epoch += 1
	active = false
	on_teardown()
	_unsubscribe_input()
	if input_manager != null:
		input_manager.set_game_keyboard_blocked(false)
	_release_active_scope()
	_remove_scene()
	if state_controller != null:
		state_controller.set_state(previous_state)
	if not _on_session_end.is_null() and _on_session_end.is_valid():
		_on_session_end.call()


func restore_minigame_state_after_action() -> void:
	if active and state_controller != null and state_controller.current_state != RuntimeGameStateController.MINIGAME:
		state_controller.set_state(RuntimeGameStateController.MINIGAME)


func publish_result(result: Variant) -> void:
	last_result = result


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	if active:
		teardown_session()


func destroy() -> void:
	if _destroyed:
		return
	_destroyed = true
	_session_epoch += 1
	if active:
		teardown_session()
	else:
		_unsubscribe_input()
		if input_manager != null:
			input_manager.set_game_keyboard_blocked(false)
		_release_active_scope()
		_remove_scene()
	_instance_cache.clear()
	index.clear()
	_start_in_flight = false
	_session_waiting = false
	_on_session_end = Callable()


func runtime_ready() -> bool:
	return renderer != null and input_manager != null and state_controller != null and asset_manager != null


func get_index_url() -> String:
	return ""


func get_data_subdir() -> String:
	return ""


func get_scope_prefix() -> String:
	return "minigame"


func build_instance_manifest_refs(_instance: Dictionary) -> Array:
	return []


func validate_instance(_instance: Dictionary) -> bool:
	return true


func prepare_instance(instance: Dictionary) -> Dictionary:
	return instance


func create_scene(_instance: Dictionary) -> Variant:
	return null


func load_scene_content(_next_scene: Variant, _instance: Dictionary) -> void:
	return


func tick_scene(_next_scene: Variant, _dt: float) -> void:
	return


func on_session_active(_instance: Dictionary) -> void:
	return


func on_scene_loaded(_instance: Dictionary) -> void:
	return


func on_teardown() -> void:
	return


func on_session_key_down(_record: Dictionary) -> void:
	return


func _handle_session_key_down(record: Dictionary) -> void:
	if not active or record.get("repeat") == true:
		return
	if scene != null and scene.has_method("is_actions_playback_locked") and scene.call("is_actions_playback_locked") == true:
		return
	if str(record.get("code", "")) == "Escape":
		var prevent: Variant = record.get("preventDefault")
		if prevent is Callable and not prevent.is_null() and prevent.is_valid():
			prevent.call()
		if scene != null and scene.has_method("abort"):
			scene.call("abort")
		return
	on_session_key_down(record)


func _scene_root(target: Variant) -> Node:
	if target != null and target.has_method("get_root"):
		var value: Variant = target.call("get_root")
		return value if value is Node else null
	return null


func _remove_scene() -> void:
	if scene == null:
		return
	var root := _scene_root(scene)
	if root != null and is_instance_valid(root) and root.get_parent() != null:
		root.get_parent().remove_child(root)
	if scene.has_method("destroy"):
		scene.call("destroy")
	scene = null


func _release_active_scope() -> void:
	if _active_scope_id.is_empty():
		return
	if asset_manager != null:
		asset_manager.release_scope(_active_scope_id)
	_active_scope_id = ""


func _unsubscribe_input() -> void:
	if not _unsubscribe_key.is_null() and _unsubscribe_key.is_valid():
		_unsubscribe_key.call()
	_unsubscribe_key = Callable()
