extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

class FakeScene:
	extends RefCounted
	var root := Control.new()
	var close_callback: Callable
	var destroyed := false
	var locked := false

	func _init(on_close: Callable) -> void:
		close_callback = on_close
		root.name = "FakeMinigameScene"

	func get_root() -> Control:
		return root

	func abort() -> void:
		if close_callback.is_valid():
			close_callback.call()

	func destroy() -> void:
		destroyed = true
		if is_instance_valid(root):
			root.free()

	func is_actions_playback_locked() -> bool:
		return locked


class FakeManager:
	extends RuntimeMinigameSessionManagerBase
	var load_calls := 0
	var ticks := 0
	var active_hooks := 0
	var loaded_hooks := 0
	var teardown_hooks := 0
	var fail_scene_load := false

	func _init() -> void:
		index_url = "/assets/data/paper_craft/index.json"
		data_subdir = "paper_craft"
		scope_prefix = "minigame:test"
		system_label = "FakeMinigameManager"

	func build_instance_manifest_refs(instance: Dictionary) -> Array:
		return [{"type": "json", "path": "/assets/data/paper_craft/wujin_paper_servant_daywork.json", "label": str(instance.id)}]

	func validate_instance(instance: Dictionary) -> bool:
		return instance.get("orders") is Array and not instance.orders.is_empty()

	func create_scene(_instance: Dictionary) -> Variant:
		return FakeScene.new(Callable(self, "teardown_session"))

	func load_scene_content(_next_scene: Variant, _instance: Dictionary) -> Variant:
		load_calls += 1
		await Engine.get_main_loop().process_frame
		return not fail_scene_load

	func tick_scene(_next_scene: Variant, _dt: float) -> void:
		ticks += 1

	func on_session_active(_instance: Dictionary) -> void:
		active_hooks += 1

	func on_scene_loaded(_instance: Dictionary) -> void:
		loaded_hooks += 1

	func on_teardown() -> void:
		teardown_hooks += 1


var manager: FakeManager
var input: RuntimeInputManager
var state: RuntimeGameStateController
var renderer: RuntimeRenderer
var duplicate_returned_null := false
var saw_scene_attached := false
var saw_gate_locked := false
var gate_lock_changes: Array[bool] = []
var gate_restore_count := 0


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	input = RuntimeInputManager.new(); add_child(input)
	state = RuntimeGameStateController.new(input, RuntimeEventBus.new())
	renderer = RuntimeRenderer.new(); add_child(renderer); renderer.set_asset_manager(assets); renderer.init()
	manager = FakeManager.new(); add_child(manager); manager.init({"assetManager": assets}); manager.renderer = renderer; manager.input_manager = input; manager.state_controller = state
	await manager.load_index()
	assert(manager.get_instance_list() == [{"id": "wujin_paper_servant_daywork", "label": "雾津纸扎铺：糊纸人日工"}])
	_schedule_second_frame(Callable(self, "_complete_session"))
	var completed: Variant = await manager.run_until_done("wujin_paper_servant_daywork")
	assert(completed is Dictionary and completed.get("status") == "success")
	assert(saw_scene_attached and not manager.active and state.current_state == RuntimeDataTypes.EXPLORING and not input.is_key_down("Space"))
	assert(manager.active_hooks == 1 and manager.loaded_hooks == 1 and manager.teardown_hooks == 1 and manager.load_calls == 1)
	_schedule_second_frame(Callable(self, "_duplicate_then_escape"))
	var escaped: Variant = await manager.run_until_done("wujin_paper_servant_daywork")
	assert(escaped == null and duplicate_returned_null and state.current_state == RuntimeDataTypes.EXPLORING and not manager.active)
	assert(manager.load_calls == 2 and manager.teardown_hooks == 2)
	assert(await manager.run_until_done("unknown") == null and state.current_state == RuntimeDataTypes.EXPLORING)

	# start() itself resolves after the scene is attached; only runUntilDone waits
	# for teardown. deserialize is the source no-op and must not kill the session.
	await manager.start("wujin_paper_servant_daywork")
	assert(manager.active and manager.scene.root.get_parent() == renderer.cutscene_overlay)
	manager.deserialize({"ignored": true})
	assert(manager.active)
	manager.teardown_session()
	assert(not manager.active and state.current_state == RuntimeDataTypes.EXPLORING)

	manager.fail_scene_load = true
	assert(await manager.run_until_done("wujin_paper_servant_daywork") == null)
	assert(not manager.active and manager.scene == null and assets.get_stats().json.pinned == 0)
	manager.fail_scene_load = false

	var unbound := FakeManager.new()
	unbound.init({"assetManager": assets})
	assert(await unbound.run_until_done("wujin_paper_servant_daywork") == null)
	unbound.destroy(); unbound.free()
	var gate := RuntimeMinigameActionPlaybackGate.new(Callable(self, "_execute_gate_batch"), {"onLockChanged": Callable(self, "_gate_lock_changed"), "restoreMinigameState": Callable(self, "_restore_gate_state")})
	state.set_state(RuntimeDataTypes.MINIGAME)
	get_tree().process_frame.connect(Callable(self, "_capture_gate_lock").bind(gate), CONNECT_ONE_SHOT)
	await gate.run([{"type": "probe"}])
	assert(saw_gate_locked and not gate.is_locked() and gate_lock_changes == [true, false] and gate_restore_count == 1 and state.current_state == RuntimeDataTypes.MINIGAME)
	state.set_state(RuntimeDataTypes.EXPLORING)
	_schedule_second_frame(Callable(self, "_destroy_active_manager"))
	assert(await manager.run_until_done("wujin_paper_servant_daywork") == null)
	assert(not manager.active and state.current_state == RuntimeDataTypes.EXPLORING and manager.scene == null and assets.get_stats().json.pinned == 0)
	remove_child(manager); manager.free(); state.destroy(); input.destroy(); renderer.destroy(); remove_child(input); input.free(); remove_child(renderer); renderer.free(); assets.dispose()
	print("MinigameSession Promise/lifecycle/order/action-gate direct-translation test: PASS")
	get_tree().quit(0)


func _schedule_second_frame(callback: Callable) -> void:
	get_tree().process_frame.connect(func() -> void: get_tree().process_frame.connect(callback, CONNECT_ONE_SHOT), CONNECT_ONE_SHOT)


func _complete_session() -> void:
	saw_scene_attached = manager.scene != null and manager.scene.get_root().get_parent() == renderer.cutscene_overlay
	manager.last_result = {"status": "success"}
	manager.teardown_session()


func _duplicate_then_escape() -> void:
	var duplicate: Variant = await manager.run_until_done("wujin_paper_servant_daywork")
	duplicate_returned_null = duplicate == null
	InputManagerProbe.key_down(input, "Escape")
	InputManagerProbe.key_up(input, "Escape")


func _execute_gate_batch(_actions: Array) -> void:
	state.set_state(RuntimeDataTypes.EXPLORING)
	await get_tree().process_frame


func _gate_lock_changed(locked: bool) -> void:
	gate_lock_changes.push_back(locked)


func _restore_gate_state() -> void:
	gate_restore_count += 1
	state.set_state(RuntimeDataTypes.MINIGAME)


func _capture_gate_lock(gate: RuntimeMinigameActionPlaybackGate) -> void:
	saw_gate_locked = gate.is_locked()


func _destroy_active_manager() -> void:
	manager.destroy()
