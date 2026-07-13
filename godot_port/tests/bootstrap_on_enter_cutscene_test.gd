extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); add_child(bootstrap)
	await get_tree().process_frame
	assert(bootstrap.scene_manager.get_current_scene_id() == "teahouse")
	assert(bootstrap.cutscene_manager.is_playing() and bootstrap.scene_manager.is_scene_enter_running())
	assert(bootstrap.state_controller.current_state == RuntimeGameStateController.CUTSCENE)
	assert(bootstrap.cutscene_manager.get_playback_hud_snapshot().cutsceneId == "说书-李天狗大战旱魃")
	bootstrap.cutscene_manager.skip()
	var guard := 0
	while (bootstrap.cutscene_manager.is_playing() or bootstrap.scene_manager.is_scene_enter_running()) and guard < 30:
		guard += 1; await get_tree().process_frame
	assert(guard < 30 and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING)
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("Bootstrap real scene onEnter-to-cutscene chain test: PASS"); get_tree().quit(0)
