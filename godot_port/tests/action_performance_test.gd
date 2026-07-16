extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame; bootstrap.cutscene_renderer.set_time_scale(0.0); bootstrap.emote_bubble_manager.set_time_scale(0.0)
	await bootstrap.action_executor.execute_await({"type": "playBgm", "params": {"id": "bgm_placeholder_low_tension", "fadeMs": 0}}); assert(bootstrap.audio_manager.get_current_bgm_id() == "bgm_placeholder_low_tension"); await bootstrap.action_executor.execute_await({"type": "stopBgm", "params": {"fadeMs": 0}}); assert(bootstrap.audio_manager.get_current_bgm_id() == null)
	bootstrap.audio_manager.add_ambient("night_alley_wind"); await get_tree().process_frame; await bootstrap.action_executor.execute_await({"type": "stopSceneAmbient", "params": {"id": "night_alley_wind", "fadeMs": 0}}); assert(not bootstrap.audio_manager.get_active_ambient_ids().has("night_alley_wind")); await bootstrap.action_executor.execute_await({"type": "stopSceneAmbient", "params": {"fadeMs": 0}}); assert(bootstrap.audio_manager.get_active_ambient_ids().is_empty())
	for action: Dictionary in [{"type": "showEmote", "params": {"target": "player", "emote": "!", "duration": 1000}}, {"type": "showSpeechBubble", "params": {"target": "player", "text": "[tag:string:dialogue:narratorLabel]", "duration": 1000}}, {"type": "showSpeechBubbleAndWait", "params": {"target": "player", "text": "测试", "duration": 1000}}]: await bootstrap.action_executor.execute_await(action); await get_tree().process_frame
	assert(bootstrap.emote_bubble_manager.active_bubbles.is_empty())
	await bootstrap.action_executor.execute_await({"type": "fadeWorldToBlack", "params": {"durationMs": 0}}); assert(bootstrap.cutscene_renderer.world_fade_overlay != null and bootstrap.cutscene_renderer.world_fade_overlay.color.a == 1.0); await bootstrap.action_executor.execute_await({"type": "fadeWorldFromBlack", "params": {"durationMs": 0}}); assert(bootstrap.cutscene_renderer.world_fade_overlay.color.a == 0.0)
	assert(bootstrap.plane_reconciler.activate_plane_manually("背尸")); await bootstrap.action_executor.execute_await({"type": "fadingZoom", "params": {"zoom": 1.75, "durationMs": 0}}); assert(bootstrap.camera.get_zoom() == 1.75); await bootstrap.action_executor.execute_await({"type": "fadingRestoreSceneCameraZoom", "params": {"duration": 0}}); assert(bootstrap.camera.get_zoom() == 1.25); bootstrap.plane_reconciler.deactivate_manual_plane()
	await bootstrap.action_executor.execute_await({"type": "blendOverlayImage", "params": {"id": "blend_probe", "fromImage": "axiu_cue", "toImage": "axiu_lamp_cue", "xPercent": 50, "yPercent": 50, "widthPercent": 30, "durationMs": 0, "delayMs": 0}}); assert(bootstrap.cutscene_renderer.get_active_image_handles().has("blend_probe")); bootstrap.cutscene_renderer.hide_img("blend_probe")
	bootstrap.action_executor.execute_await({"type": "waitClickContinue", "params": {"text": "继续测试"}}); await get_tree().create_timer(0.15).timeout; assert(bootstrap.renderer.ui_layer.get_node_or_null("ClickContinuePrompt") != null); InputManagerProbe.pointer_down(bootstrap.input_manager); await get_tree().process_frame; await get_tree().process_frame; assert(bootstrap.renderer.ui_layer.get_node_or_null("ClickContinuePrompt") == null and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)
	var default_slug: String = bootstrap.current_player_portrait_slug
	assert(default_slug == "player_anim")
	assert(bootstrap.player_anim_def.cellWidth == 219 and bootstrap.player_anim_def.cellHeight == 204)
	assert(bootstrap.player.sprite.get_world_size() == {"width": 148.214286, "height": 150.0})
	await bootstrap.action_executor.execute_await({"type": "setPlayerAvatar", "params": {"bundleId": "player_taoist_anim_v1", "stateMap": {"idle": "idle"}}})
	assert(bootstrap.current_player_portrait_slug == "player_taoist_anim_v1" and bootstrap.player.sprite.get_state_names().has("idle"))
	assert(bootstrap.player_anim_def.cellWidth == 208 and bootstrap.player_anim_def.cellHeight == 204)
	assert(bootstrap.player.sprite.get_world_size() == {"width": 142.235294, "height": 155.0})
	await bootstrap.action_executor.execute_await({"type": "resetPlayerAvatar", "params": {}})
	assert(bootstrap.current_player_portrait_slug == default_slug)
	assert(bootstrap.player.sprite.get_world_size() == {"width": 148.214286, "height": 150.0})
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout; print("Audio/emote/fade/blend/wait-click/avatar Action contract test: PASS"); get_tree().quit(0)
