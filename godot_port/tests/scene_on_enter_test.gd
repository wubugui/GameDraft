extends Node

var trace: Array[String] = []
var manager: RuntimeSceneManager
var enable_reentrant := true
var queued_results: Array[String] = []


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository)); var events := RuntimeEventBus.new(); var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.set_asset_manager(assets); renderer.init_renderer(); var camera := RuntimeCamera.new(renderer.world_container); camera.set_screen_size(800, 600); var input := RuntimeInputManager.new(); add_child(input); var player := RuntimePlayer.new(input); renderer.entity_layer.add_child(player.sprite)
	manager = RuntimeSceneManager.new(assets, events, renderer, player, camera); add_child(manager); manager.init({}); events.on("scene:enter", func(_payload: Variant) -> void: trace.push_back("enter")); events.on("scene:ready", func(_payload: Variant) -> void: trace.push_back("ready")); manager.set_scene_reveal_runner(Callable(self, "_reveal")); manager.set_scene_enter_runner(Callable(self, "_run_enter"))
	assert(manager.load_scene("梦_里屋")); assert(trace == ["enter", "ready", "reveal:begin"] and manager.get_current_scene_id() == "梦_里屋")
	var guard := 0
	while (manager.get_current_scene_id() != "梦_饭屋" or manager.is_scene_enter_running()) and guard < 30:
		guard += 1; await get_tree().process_frame
	assert(guard < 30 and manager.get_current_scene_id() == "梦_饭屋")
	assert(trace.slice(0, 6) == ["enter", "ready", "reveal:begin", "reveal:end:梦_里屋", "onEnter:begin:梦_里屋", "onEnter:end:梦_里屋"])
	assert(trace.slice(6, 9) == ["enter", "ready", "reveal:begin"] and trace.has("onEnter:begin:梦_饭屋"))
	while manager.is_scene_enter_running(): await get_tree().process_frame
	enable_reentrant = false; trace.clear(); queued_results.clear(); manager.set_zone_actions_waiter(Callable(self, "_wait_zone_actions")); manager.event_bus.on("scene:beforeUnload", func(_payload: Variant) -> void: trace.push_back("beforeUnload")); call_deferred("_queued_switch", "梦_里屋"); call_deferred("_queued_switch", "梦_饭屋")
	guard = 0
	while queued_results.size() < 2 and guard < 60: guard += 1; await get_tree().process_frame
	assert(queued_results == ["梦_里屋", "梦_饭屋"] and manager.get_current_scene_id() == "梦_饭屋")
	var first_end := trace.find("onEnter:end:梦_里屋"); var second_enter := trace.find("onEnter:begin:梦_饭屋"); assert(first_end >= 0 and second_enter > first_end)
	var unload_index := trace.find("beforeUnload"); var drain_begin := trace.find("zoneActions:begin"); var drain_end := trace.find("zoneActions:end"); var next_enter := trace.find("enter"); assert(unload_index >= 0 and drain_begin > unload_index and drain_end > drain_begin and next_enter > drain_end)
	manager.destroy(); remove_child(manager); manager.free(); player.destroy_player(); input.destroy(); remove_child(input); input.free(); assets.dispose(); renderer.destroy_renderer(); remove_child(renderer); renderer.free(); events.clear(); print("Scene ready/reveal/onEnter/reentrant-switch contract test: PASS"); get_tree().quit(0)


func _reveal(scene_id: String) -> void:
	trace.push_back("reveal:begin")
	await get_tree().process_frame
	trace.push_back("reveal:end:%s" % scene_id)


func _run_enter(_actions: Array, scene_id: String) -> void:
	trace.push_back("onEnter:begin:%s" % scene_id)
	if enable_reentrant and scene_id == "梦_里屋":
		assert(manager.switch_scene("梦_饭屋"))
		assert(manager.get_current_scene_id() == "梦_里屋")
	await get_tree().process_frame
	trace.push_back("onEnter:end:%s" % scene_id)


func _queued_switch(scene_id: String) -> void:
	if await manager.switch_scene_and_wait(scene_id): queued_results.push_back(scene_id)


func _wait_zone_actions() -> void:
	trace.push_back("zoneActions:begin")
	await get_tree().process_frame
	trace.push_back("zoneActions:end")
