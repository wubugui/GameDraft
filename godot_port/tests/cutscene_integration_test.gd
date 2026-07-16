extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")

var started: Array = []
var ended: Array = []


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	await get_tree().process_frame
	assert(bootstrap.cutscene_manager != null and bootstrap.audio_manager != null and bootstrap.emote_bubble_manager != null and bootstrap.signal_cue_manager != null)
	assert(bootstrap.cutscene_manager.get_cutscene_def("说书-李天狗大战旱魃") != null and bootstrap.audio_manager.has_audio("sfx", "sfx_jingju_luogu"))
	assert(bootstrap.action_executor.has_handler("startCutscene") and bootstrap.action_executor.has_handler("moveEntityTo") and bootstrap.action_executor.has_handler("showEmoteAndWait") and bootstrap.action_executor.has_handler("playSignalCue"))
	bootstrap.runtime_root.event_bus.on("cutscene:start", Callable(self, "_on_started"))
	bootstrap.runtime_root.event_bus.on("cutscene:end", Callable(self, "_on_ended"))
	bootstrap.cutscene_renderer.set_time_scale(0.0)
	bootstrap.action_executor.execute_await({"type": "startCutscene", "params": {"id": "说书-李天狗大战旱魃"}})
	var guard := 0
	while bootstrap.cutscene_manager.is_playing() and guard < 600:
		guard += 1
		bootstrap.cutscene_manager.wait_click_not_before = 0; bootstrap.cutscene_manager.dialogue_advance_not_before = 0; InputManagerProbe.pointer_down(bootstrap.input_manager)
		await get_tree().process_frame
	assert(guard < 600 and not bootstrap.cutscene_manager.is_playing())
	assert(started == ["说书-李天狗大战旱魃"] and ended == ["说书-李天狗大战旱魃"])
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)
	assert(bootstrap.action_executor.get_policy_depth() == 0 and bootstrap.cutscene_renderer.get_active_image_handles().is_empty())
	# 这些 actor 原语的生产契约是过场内执行；TS 也只在 Cutscene tick 临时 actor。
	bootstrap.state_controller.set_state(RuntimeDataTypes.CUTSCENE)
	bootstrap.emote_bubble_manager.set_time_scale(0.0)
	await bootstrap.action_executor.execute_await({"type": "cutsceneSpawnActor", "params": {"id": "_probe", "name": "探针", "x": 100, "y": 100}})
	var actor: Variant = bootstrap.cutscene_manager.get_temp_actors().get("_probe")
	assert(actor is RuntimeNpc)
	await bootstrap.action_executor.execute_await({"type": "faceEntity", "params": {"target": "_probe", "direction": "left"}})
	assert(actor.get_facing() == -1)
	await bootstrap.action_executor.execute_await({"type": "moveEntityTo", "params": {"target": "_probe", "x": 104, "y": 100, "speed": 1000}})
	assert(actor.get_x() == 104)
	await bootstrap.action_executor.execute_await({"type": "showEmoteAndWait", "params": {"target": "_probe", "emote": "!", "duration": 1000}})
	assert(bootstrap.emote_bubble_manager.active_bubbles.is_empty())
	await bootstrap.action_executor.execute_await({"type": "cutsceneRemoveActor", "params": {"id": "_probe"}})
	assert(bootstrap.cutscene_manager.get_temp_actors().get("_probe") == null)
	await bootstrap.action_executor.execute_await({"type": "playSignalCue", "params": {"id": "axiu_full"}})
	assert(bootstrap.cutscene_renderer.get_active_image_handles().is_empty())
	bootstrap.state_controller.set_state(RuntimeDataTypes.EXPLORING)
	bootstrap.runtime_root.event_bus.off("cutscene:start", Callable(self, "_on_started"))
	bootstrap.runtime_root.event_bus.off("cutscene:end", Callable(self, "_on_ended"))
	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	await get_tree().process_frame
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("Real teahouse cutscene Action/audio/present/state integration test: PASS")
	get_tree().quit(0)


func _on_started(payload: Variant) -> void:
	if payload is Dictionary: started.push_back(str(payload.get("id", "")))


func _on_ended(payload: Variant) -> void:
	if payload is Dictionary: ended.push_back(str(payload.get("id", "")))
