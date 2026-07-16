extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository)); var events := RuntimeEventBus.new(); var flags := RuntimeFlagStore.new(events); var input := RuntimeInputManager.new(); var state := RuntimeGameStateController.new(input, events); var executor := RuntimeActionExecutor.new(events, flags, state); var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.set_asset_manager(assets); renderer.init(); var camera := RuntimeCamera.new(renderer.world_container); camera.set_screen_size(800, 600); var player := RuntimePlayer.new(input); renderer.entity_layer.add_child(player.sprite); var scenes := RuntimeSceneManager.new(assets, events, renderer); add_child(scenes); scenes.init({}); preload("res://tests/support/scene_manager_wiring.gd").bind(scenes, player, camera)
	preload("res://tests/support/action_registry_fixture.gd").register(executor, {
		"sceneManager": scenes,
		"stateController": state,
		"setCameraZoom": Callable(camera, "set_zoom"),
		"restoreSceneCameraZoom": func() -> void:
			var config: Variant = scenes.get_current_scene_data().get("camera")
			camera.set_zoom(float(config.get("zoom", 1.0)) if config is Dictionary else 1.0),
	})
	assert(await scenes.load_scene("teahouse")); await executor.execute_await({"type": "setCameraZoom", "params": {"zoom": 2.25}}); assert(camera.get_zoom() == 2.25); await executor.execute_await({"type": "restoreSceneCameraZoom", "params": {}}); assert(camera.get_zoom() == 1.5)
	await executor.execute_await({"type": "switchScene", "params": {"targetScene": "test_room_b"}}); assert(scenes.get_current_scene_id() == "test_room_b" and state.current_state == RuntimeDataTypes.EXPLORING)
	await executor.execute_await({"type": "changeScene", "params": {"targetScene": "teahouse", "targetSpawnPoint": "from_street", "cameraX": 222, "cameraY": 111}}); assert(scenes.get_current_scene_id() == "teahouse" and player.get_x() == 222 and player.get_y() == 111 and is_equal_approx(camera.get_x(), 800.0 / 1.5 / 2.0) and state.current_state == RuntimeDataTypes.EXPLORING)
	# Camera clamps its center in a 700x525 world at zoom 1.5; player position still uses explicit override.
	assert(camera.get_y() > 0); await executor.execute_await({"type": "changeScene", "params": {"targetScene": "test_room_b"}}); await executor.execute_await({"type": "changeScene", "params": {"targetScene": "teahouse", "targetSpawnPoint": "from_street"}}); assert(is_equal_approx(player.get_x(), 151.9) and is_equal_approx(player.get_y(), 171.4)); await executor.execute_await({"type": "setCameraZoom", "params": {"zoom": -1}}); assert(camera.get_zoom() == 1.5)
	for type: String in ["switchScene", "changeScene", "setCameraZoom", "restoreSceneCameraZoom"]: assert(executor.has_handler(type))
	scenes.destroy(); remove_child(scenes); scenes.free(); player.destroy_player(); input.destroy(); input.free(); assets.dispose(); renderer.destroy(); remove_child(renderer); renderer.free(); executor.destroy(); state.destroy(); flags.destroy(); events.clear()
	print("Scene switch/camera Action contract test: PASS"); get_tree().quit(0)
