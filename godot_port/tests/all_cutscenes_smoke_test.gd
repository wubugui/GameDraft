extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	bootstrap.cutscene_manager.set_time_scale(0.0); bootstrap.emote_bubble_manager.set_time_scale(0.0)
	var ids: Array = bootstrap.cutscene_manager.get_cutscene_ids(); assert(ids.size() == 20)
	for id: String in ids:
		var definition: Dictionary = bootstrap.cutscene_manager.get_cutscene_def(id); _assert_action_closure(definition.get("steps", []), bootstrap.action_executor)
		bootstrap.cutscene_manager.start_cutscene(id)
		if id == "洋人第一次出场":
			var staging_guard := 0
			while (bootstrap.scene_manager.get_current_scene_id() != "码头白天" or bootstrap.scene_manager.get_npc_by_id("new_npc_3") == null) and staging_guard < 120: staging_guard += 1; await get_tree().process_frame
			assert(staging_guard < 120)
			assert(bootstrap.scene_manager.get_current_scene_id() == "码头白天" and bootstrap.scene_manager.get_npc_by_id("new_npc_3") != null)
			assert(bootstrap.scene_manager.get_hotspot_by_id("new_hotspot_6") != null and bootstrap.scene_manager.get_active_cutscene_binding_id() == id)
		var guard := 0
		while bootstrap.cutscene_manager.is_playing() and guard < 900:
			guard += 1; bootstrap.cutscene_manager.debug_advance(); bootstrap.player.cutscene_update(10.0); bootstrap.scene_manager.update(10.0); bootstrap.cutscene_manager.update(10.0); bootstrap.emote_bubble_manager.update(10.0); await get_tree().process_frame
		assert(guard < 900 and not bootstrap.cutscene_manager.is_playing() and bootstrap.action_executor.policy_depth() == 0)
		assert(bootstrap.cutscene_renderer.get_active_image_handles().is_empty() and bootstrap.emote_bubble_manager.active_bubbles.is_empty())
		assert(bootstrap.scene_manager.cutscene_staging == null and bootstrap.scene_manager.get_active_cutscene_binding_id() == null)
		if id == "洋人第一次出场":
			var dock_memory: Variant = bootstrap.scene_manager.serialize().memory.get("码头白天")
			assert(dock_memory is Dictionary and dock_memory.entityOverrides.hotspots.is_empty() and dock_memory.entityOverrides.npcs.is_empty())
		bootstrap.audio_manager.stop_all_playback()
	var stats: Dictionary = bootstrap.asset_manager.get_stats(); assert(stats.texture.errors == 0 and stats.audio.errors == 0 and stats.json.errors == 0)
	bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout
	print("All 20 cutscene definitions executable/cleanup closure test: PASS"); get_tree().quit(0)


func _assert_action_closure(raw: Variant, executor: RuntimeActionExecutor) -> void:
	if not raw is Array: return
	for step: Variant in raw:
		if not step is Dictionary: continue
		if step.get("kind") == "action": assert(executor.has_handler(step.get("type")))
		elif step.get("kind") == "parallel": _assert_action_closure(step.get("tracks"), executor)
