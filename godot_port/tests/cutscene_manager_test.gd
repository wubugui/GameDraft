extends Node

var probe_log: Array = []
var cutscene_manager: RuntimeCutsceneManager
var scene_manager: RuntimeSceneManager
var test_player: RuntimePlayer


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var events := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(events)
	flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	var input := RuntimeInputManager.new(); add_child(input)
	var state := RuntimeGameStateController.new(input, events)
	var actions := RuntimeActionExecutor.new(events, flags, state)
	actions.register("playSfx", Callable(self, "_parallel_probe"), ["id"])
	var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.init(); renderer.set_viewport_size(800, 600)
	var camera := RuntimeCamera.new(renderer.world_container); camera.set_screen_size(800, 600)
	test_player = RuntimePlayer.new(input); renderer.entity_layer.add_child(test_player.sprite)
	scene_manager = RuntimeSceneManager.new(assets, events, renderer); add_child(scene_manager); scene_manager.init({})
	preload("res://tests/support/scene_manager_wiring.gd").bind(scene_manager, test_player, camera)
	assert(await scene_manager.load_scene("teahouse"))
	var presentation := RuntimeCutsceneRenderer.new(renderer, camera, assets); presentation.set_time_scale(0.0)
	cutscene_manager = RuntimeCutsceneManager.new(events, flags, actions, presentation)
	cutscene_manager.init({"assetManager": assets})
	cutscene_manager.set_input_manager(input)
	cutscene_manager.set_entity_resolver(Callable(self, "_resolve_actor"))
	cutscene_manager.set_scene_switcher(Callable(self, "_switch_scene"))
	cutscene_manager.set_scene_id_getter(func() -> String: return scene_manager.get_current_scene_id())
	cutscene_manager.set_player_position_getter(func() -> Dictionary: return {"x": test_player.get_x(), "y": test_player.get_y()})
	cutscene_manager.set_player_position_setter(func(x: float, y: float) -> void: test_player.set_x(x); test_player.set_y(y))
	cutscene_manager.set_camera_accessor(camera)
	cutscene_manager.set_scene_manager(scene_manager)
	cutscene_manager.set_spawn_point_resolver(Callable(self, "_resolve_spawn_point"))
	var manager := cutscene_manager; var scenes := scene_manager; var player := test_player
	manager.load_defs(); assert(manager.get_cutscene_ids().size() == 20 and manager.get_cutscene_def("说书-李天狗大战旱魃") != null)
	manager.cutscene_defs.synthetic = {"id": "synthetic", "restoreState": true, "steps": [{"kind": "action", "type": "setFlag", "params": {"key": "cutscene_forbidden", "value": true}}, {"kind": "parallel", "tracks": [{"kind": "action", "type": "playSfx", "params": {"id": "a"}}, {"kind": "action", "type": "playSfx", "params": {"id": "b"}}]}, {"kind": "present", "type": "showTitle", "text": "并行完", "duration": 20}, {"kind": "present", "type": "showDialogue", "speaker": "旁白", "text": "掌柜：继续"}, {"kind": "present", "type": "showMovieBar", "heightPercent": 0.1}, {"kind": "present", "type": "showSubtitle", "text": "字幕", "subtitleAutoAdvance": 10}, {"kind": "present", "type": "hideMovieBar"}]}
	var original := Vector2(player.get_x(), player.get_y()); manager.start_cutscene("synthetic"); var guard := 0
	while manager.is_playing() and guard < 50: guard += 1; manager.wait_click_not_before = 0; manager.dialogue_advance_not_before = 0; InputManagerProbe.pointer_down(input); await get_tree().process_frame
	assert(guard < 50 and not manager.is_playing() and flags.get_value("cutscene_forbidden") != true and actions.get_policy_depth() == 0); assert(probe_log.slice(0, 2) == ["start:a", "start:b"] and probe_log.has("end:a") and probe_log.has("end:b")); assert(Vector2(player.get_x(), player.get_y()) == original)
	presentation.set_time_scale(1.0); manager.cutscene_defs.long = {"id": "long", "steps": [{"kind": "present", "type": "waitTime", "duration": 10000}, {"kind": "action", "type": "playSfx", "params": {"id": "must_not_run"}}]}; manager.start_cutscene("long"); await get_tree().process_frame; assert(manager.is_playing()); manager.skip(); await get_tree().process_frame; await get_tree().process_frame; assert(not manager.is_playing() and not probe_log.has("start:must_not_run"))
	manager.cutscene_defs.arming = {"id": "arming", "steps": [{"kind": "present", "type": "waitClick"}, {"kind": "action", "type": "playSfx", "params": {"id": "after_armed_click"}}]}; manager.start_cutscene("arming"); InputManagerProbe.pointer_down(input); await get_tree().process_frame; await get_tree().process_frame; await get_tree().process_frame; assert(manager.is_playing() and not probe_log.has("start:after_armed_click")); await get_tree().create_timer(0.14).timeout; InputManagerProbe.pointer_down(input)
	for _index in 10:
		await get_tree().process_frame
		if not manager.is_playing(): break
	assert(not manager.is_playing() and probe_log.has("start:after_armed_click"))
	manager.destroy(); manager.free(); scenes.destroy(); remove_child(scenes); scenes.free(); player.destroy_player(); state.destroy(); input.destroy(); remove_child(input); input.free(); actions.destroy(); flags.destroy(); events.clear(); assets.dispose(); renderer.destroy(); remove_child(renderer); renderer.free(); print("CutsceneManager session/parallel/policy/skip contract test: PASS"); get_tree().quit(0)


func _parallel_probe(params: Dictionary, _zone: Variant) -> void:
	var id := str(params.get("id", "")); probe_log.push_back("start:%s" % id); await get_tree().process_frame; probe_log.push_back("end:%s" % id)


func _resolve_actor(id: String) -> Variant:
	var actor: Variant = cutscene_manager.get_temp_actors().get(id)
	if actor != null: return actor
	actor = scene_manager.get_npc_by_id(id)
	if actor != null: return actor
	return test_player if id == "player" else null


func _switch_scene(params: Dictionary) -> void:
	await scene_manager.switch_scene(str(params.get("targetScene", "")), str(params.get("targetSpawnPoint", "")))


func _resolve_spawn_point(key: String) -> Variant:
	var scene := scene_manager.get_current_scene_data()
	return scene.get("spawnPoint") if key.is_empty() else scene.get("spawnPoints", {}).get(key)
