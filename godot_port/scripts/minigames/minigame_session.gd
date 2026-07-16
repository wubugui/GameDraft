class_name RuntimeMinigameSessionManagerBase
extends RuntimeSystem

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")

var asset_manager: RuntimeAssetManager
var renderer: RuntimeRenderer = null
var input_manager: RuntimeInputManager = null
var state_controller: RuntimeGameStateController = null
var index: Array = []
var instance_cache: Dictionary = {}
var scene: Variant = null
var active_scope_id: Variant = null
var active := false
var prev_state := RuntimeDataTypes.EXPLORING
var unsub_key: Variant = null
var session_resolve: Variant = null
var last_result: Variant = null
var on_session_end: Variant = null
var start_in_flight := false
var session_epoch := 0

# GDScript has no abstract fields. Subclass _init methods assign these four
# source-declared abstract readonly properties before any public API is called.
var index_url := ""
var data_subdir := ""
var scope_prefix := ""
var system_label := ""


func is_active() -> bool:
	return active


func build_instance_manifest_refs(_instance: Dictionary) -> Array:
	return []


func create_scene(_instance: Dictionary) -> Variant:
	return null


func load_scene_content(_next_scene: Variant, _instance: Dictionary) -> Variant:
	return true


func tick_scene(_next_scene: Variant, _dt: float) -> void:
	return


func validate_instance(_instance: Dictionary) -> bool:
	return true


func prepare_instance(instance: Dictionary) -> Dictionary:
	return instance


func on_session_active(_instance: Dictionary) -> void:
	return


func on_scene_loaded(_instance: Dictionary) -> void:
	return


func on_teardown() -> void:
	return


func on_session_key_down(_record: Dictionary) -> void:
	return


func runtime_ready() -> bool:
	return renderer != null and input_manager != null and state_controller != null


func warn_session(message: String, detail: Variant = null) -> void:
	if detail != null:
		push_warning("%s: %s %s" % [system_label, message, str(detail)])
	else:
		push_warning("%s: %s" % [system_label, message])


func init(ctx: Dictionary) -> void:
	asset_manager = ctx.get("assetManager")


func update(dt: float) -> void:
	if scene == null or not active:
		return
	tick_scene(scene, dt)


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	return


func destroy() -> void:
	session_epoch += 1
	if active:
		teardown_session()
	else:
		if unsub_key is Callable and unsub_key.is_valid():
			unsub_key.call()
		unsub_key = null
		if input_manager != null:
			input_manager.set_game_keyboard_blocked(false)
		_release_active_scope()
		_remove_scene()
		resolve_session()
	instance_cache.clear()
	index = []


func set_on_session_end(callback: Variant) -> void:
	on_session_end = callback


func load_index() -> void:
	var raw: Variant = asset_manager.load_json(index_url)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if raw is Array:
		index = raw
		return
	warn_session("failed to load index", asset_manager.get_last_error())
	index = []


func get_instance_list() -> Array[Dictionary]:
	var result: Array[Dictionary] = []
	for entry: Variant in index:
		if entry is Dictionary:
			result.push_back({"id": entry.get("id"), "label": entry.get("label")})
	return result


func run_until_done(id: String) -> Variant:
	if active or start_in_flight or session_resolve != null:
		warn_session("已有小游戏会话进行中，忽略重复启动 \"%s\"" % id)
		return null
	var latch := RuntimeAsyncLatch.new()
	session_resolve = latch
	start(id)
	await latch.wait()
	return last_result


func start(id: String) -> void:
	if not runtime_ready():
		warn_session("runtime not bound")
		resolve_session()
		return
	if active or start_in_flight:
		return
	start_in_flight = true
	var epoch := session_epoch
	var instance_zero: Variant = await load_instance(id)
	if epoch != session_epoch:
		resolve_session()
		start_in_flight = false
		return
	if instance_zero == null:
		warn_session("unknown instance \"%s\"" % id)
		resolve_session()
		start_in_flight = false
		return
	if not instance_zero is Dictionary or not validate_instance(instance_zero):
		resolve_session()
		start_in_flight = false
		return
	var instance := prepare_instance(instance_zero)

	var scope_id := "%s:%s" % [scope_prefix, instance.id]
	active_scope_id = scope_id
	asset_manager.preload_manifest(
		{"scopeId": scope_id, "refs": build_instance_manifest_refs(instance)},
		{"mode": "stage", "tolerateErrors": true}
	)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if epoch != session_epoch:
		_release_active_scope()
		resolve_session()
		start_in_flight = false
		return

	prev_state = state_controller.current_state
	state_controller.set_state(RuntimeDataTypes.MINIGAME)
	input_manager.set_game_keyboard_blocked(true)
	active = true
	last_result = null
	on_session_active(instance)

	unsub_key = input_manager.subscribe_key_down(Callable(self, "_handle_session_key_down"))
	var next_scene: Variant = create_scene(instance)
	scene = next_scene
	if next_scene == null:
		warn_session("start \"%s\" failed" % id)
		teardown_session()
		start_in_flight = false
		return
	var loaded: Variant = await load_scene_content(next_scene, instance)
	if loaded == false:
		warn_session("scene load failed")
		teardown_session()
		start_in_flight = false
		return
	if epoch != session_epoch or not active or scene != next_scene:
		start_in_flight = false
		return
	var root: Variant = next_scene.root
	if not root is Node:
		warn_session("start \"%s\" failed" % id)
		teardown_session()
		start_in_flight = false
		return
	renderer.cutscene_overlay.add_child(root)
	on_scene_loaded(instance)
	start_in_flight = false


func _handle_session_key_down(record: Dictionary) -> void:
	if not active or record.get("repeat") == true:
		return
	if scene != null and scene.has_method("is_actions_playback_locked") and scene.call("is_actions_playback_locked") == true:
		return
	if str(record.get("code", "")) == "Escape":
		var prevent_default: Variant = record.get("preventDefault")
		if prevent_default is Callable and prevent_default.is_valid():
			prevent_default.call()
		if scene != null:
			scene.abort()
		return
	on_session_key_down(record)


func load_instance(id: String) -> Variant:
	var cached: Variant = instance_cache.get(id)
	if cached != null:
		return cached
	var entry: Variant = null
	for candidate: Variant in index:
		if candidate is Dictionary and candidate.get("id") == id:
			entry = candidate
			break
	if entry == null:
		return null
	var path := RuntimeResourceLocator.get_default().data_subdir_json_url(data_subdir, str(entry.file))
	var data: Variant = asset_manager.load_json(path)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if data != null:
		instance_cache[id] = data
		return data
	warn_session("load instance failed (%s)" % id, asset_manager.get_last_error())
	return null


func teardown_session() -> void:
	if not active:
		return
	session_epoch += 1
	active = false
	on_teardown()

	if unsub_key is Callable and unsub_key.is_valid():
		unsub_key.call()
	unsub_key = null
	if input_manager != null:
		input_manager.set_game_keyboard_blocked(false)
	_release_active_scope()
	_remove_scene()
	if state_controller != null:
		state_controller.set_state(prev_state)
	resolve_session()
	if on_session_end is Callable and on_session_end.is_valid():
		on_session_end.call()


func restore_minigame_state_after_action() -> void:
	if not active or state_controller == null:
		return
	if state_controller.current_state != RuntimeDataTypes.MINIGAME:
		state_controller.set_state(RuntimeDataTypes.MINIGAME)


func _release_active_scope() -> void:
	if active_scope_id == null:
		return
	asset_manager.release_scope(str(active_scope_id))
	active_scope_id = null


func _remove_scene() -> void:
	if scene == null:
		return
	var root: Variant = scene.root
	if root is Node and is_instance_valid(root) and root.get_parent() != null:
		root.get_parent().remove_child(root)
	scene.destroy()
	scene = null


func resolve_session() -> void:
	var resolver: Variant = session_resolve
	session_resolve = null
	if resolver is RuntimeAsyncLatch:
		RuntimeMicrotaskQueueScript.queue_microtask(Callable(resolver, "resolve"))
