extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); add_child(bootstrap)
	var init_guard := 0
	while init_guard < 60 and (
		bootstrap.scene_manager == null
		or bootstrap.scene_manager.get_current_scene_id() != "teahouse"
		or not bootstrap.cutscene_manager.is_playing()
	):
		init_guard += 1
		await get_tree().process_frame
	assert(init_guard < 60)
	assert(bootstrap.scene_manager.get_current_scene_id() == "teahouse")
	assert(bootstrap.cutscene_manager.is_playing())
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.CUTSCENE)
	assert(bootstrap.cutscene_manager.get_playback_hud_snapshot().cutsceneId == "说书-李天狗大战旱魃")
	bootstrap.cutscene_manager.skip()
	var guard := 0
	while (bootstrap.cutscene_manager.is_playing() or not bootstrap.graph_dialogue_manager.is_active()) and guard < 120:
		guard += 1; await get_tree().process_frame
	assert(
		guard < 120 \
			and bootstrap.state_controller.current_state == RuntimeDataTypes.DIALOGUE \
			and bootstrap.graph_dialogue_manager.get_dialogue_view_debug().get("graphId") == "寻狗_听书开场",
		"skip did not settle: guard=%s playing=%s state=%s" % [guard, bootstrap.cutscene_manager.is_playing(), bootstrap.state_controller.current_state]
	)
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("Bootstrap real scene onEnter-to-cutscene chain test: PASS"); get_tree().quit(0)
