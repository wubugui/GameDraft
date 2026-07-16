extends Node

var trace: Array[String] = []
var assembly_trace: Array[String] = []
var manager: RuntimeSceneManager
var enable_reentrant := true
var queued_results: Array[String] = []
var testing_initial_load := false
var initial_enter_saw_overlay := true


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository)); var events := RuntimeEventBus.new(); var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.set_asset_manager(assets); renderer.init(); var camera := RuntimeCamera.new(renderer.world_container); camera.set_screen_size(800, 600); var input := RuntimeInputManager.new(); add_child(input); var player := RuntimePlayer.new(input); renderer.entity_layer.add_child(player.sprite)
	manager = RuntimeSceneManager.new(assets, events, renderer); add_child(manager); manager.init({}); preload("res://tests/support/scene_manager_wiring.gd").bind(manager, player, camera)
	manager.set_interaction_setter(func(hotspots: Array, npcs: Array) -> void: if not hotspots.is_empty() or not npcs.is_empty(): assembly_trace.push_back("interaction"))
	manager.set_player_position_setter(func(x: float, y: float) -> void: player.set_x(x); player.set_y(y); assembly_trace.push_back("spawn"))
	manager.set_audio_applier(func(_bgm: Variant, _ambient: Variant) -> void: assembly_trace.push_back("audio"))
	manager.set_zone_setter(func(zones: Array) -> void: if not zones.is_empty(): assembly_trace.push_back("zones"))
	manager.set_depth_loader(func(_scene_id: String, _scene: Dictionary, _world_to_pixel_x: float, _world_to_pixel_y: float) -> void: assembly_trace.push_back("depth"))
	events.on("scene:enter", func(_payload: Variant) -> void: trace.push_back("enter"); assembly_trace.push_back("enter")); events.on("scene:ready", func(_payload: Variant) -> void: trace.push_back("ready"); assembly_trace.push_back("ready")); manager.set_scene_enter_runner(Callable(self, "_run_enter"))
	assert(await manager.load_scene("梦_里屋", "", null, null, Callable(), Callable(self, "_reveal"))); assert(trace == ["enter", "ready", "reveal:begin", "reveal:end:梦_里屋", "onEnter:begin:梦_里屋", "onEnter:end:梦_里屋"] and manager.get_current_scene_id() == "梦_里屋")
	assert(assembly_trace == ["interaction", "spawn", "audio", "zones", "depth", "enter", "ready"], "scene assembly commit order must match SceneManager.ts")
	var guard := 0
	while (manager.get_current_scene_id() != "梦_饭屋" or not trace.has("onEnter:begin:梦_饭屋")) and guard < 120:
		guard += 1; await get_tree().process_frame
	assert(guard < 120 and manager.get_current_scene_id() == "梦_饭屋")
	assert(trace.slice(0, 6) == ["enter", "ready", "reveal:begin", "reveal:end:梦_里屋", "onEnter:begin:梦_里屋", "onEnter:end:梦_里屋"])
	assert(trace.slice(6, 8) == ["enter", "ready"] and trace.has("onEnter:begin:梦_饭屋"))
	enable_reentrant = false; trace.clear(); queued_results.clear(); manager.event_bus.on("scene:beforeUnload", func(_payload: Variant) -> void: trace.push_back("beforeUnload")); call_deferred("_queued_switch", "梦_里屋"); call_deferred("_queued_switch", "梦_饭屋")
	guard = 0
	while queued_results.size() < 2 and guard < 240: guard += 1; await get_tree().process_frame
	assert(queued_results == ["梦_里屋", "梦_饭屋"] and manager.get_current_scene_id() == "梦_饭屋")
	var first_end := trace.find("onEnter:end:梦_里屋"); var second_enter := trace.find("onEnter:begin:梦_饭屋"); assert(first_end >= 0 and second_enter > first_end)
	var unload_index := trace.find("beforeUnload"); var next_enter := trace.find("enter"); assert(unload_index >= 0 and next_enter > unload_index)
	manager.unload_scene(); trace.clear(); testing_initial_load = true
	assert(await manager.load_initial_scene("梦_里屋"))
	assert(trace == ["enter", "ready", "onEnter:begin:梦_里屋", "onEnter:end:梦_里屋"])
	assert(not initial_enter_saw_overlay and manager.get("_transition_overlay") == null)
	manager.destroy(); remove_child(manager); manager.free(); player.destroy_player(); input.destroy(); remove_child(input); input.free(); assets.dispose(); renderer.destroy(); remove_child(renderer); renderer.free(); events.clear(); print("Scene ready/reveal/onEnter/reentrant-switch contract test: PASS"); get_tree().quit(0)


func _reveal() -> void:
	trace.push_back("reveal:begin")
	await get_tree().process_frame
	trace.push_back("reveal:end:%s" % manager.get_current_scene_id())


func _run_enter(_actions: Array) -> void:
	var scene_id := manager.get_current_scene_id()
	if testing_initial_load:
		initial_enter_saw_overlay = manager.get("_transition_overlay") != null
	trace.push_back("onEnter:begin:%s" % scene_id)
	if enable_reentrant and scene_id == "梦_里屋":
		assert(await manager.switch_scene("梦_饭屋"))
		assert(manager.get_current_scene_id() == "梦_里屋")
	await get_tree().process_frame
	trace.push_back("onEnter:end:%s" % scene_id)


func _queued_switch(scene_id: String) -> void:
	if await manager.switch_scene(scene_id): queued_results.push_back(scene_id)
