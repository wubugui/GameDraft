extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")

var bootstrap: Node
var primary_checks := false
var smoke_checks: Dictionary = {}


func _ready() -> void:
	bootstrap = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	await get_tree().process_frame
	var manager: RuntimeWaterMinigameManager = bootstrap.water_minigame_manager
	assert(manager.get_instance_list() == [
		{"id": "dev_pond", "label": "Dev 占位池塘"},
		{"id": "wild_morning", "label": "野外河湾 · 清晨 · 晴"},
		{"id": "dock_rain", "label": "雾津码头 · 雨后 · 雾"},
		{"id": "grave_night", "label": "义冢浅滩 · 夜里 · 雾"},
		{"id": "dock_crate_tutorial", "label": "码头捞箱教学"},
	])
	_schedule_second_frame(Callable(self, "_exercise_primary"))
	await bootstrap.action_executor.execute_await({"type": "startWaterMinigame", "params": {"id": "dev_pond"}})
	assert(primary_checks and not manager.active and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING)
	assert(manager.is_entity_consumed("dev_pond", "junk_float"))
	var saved := manager.serialize()
	manager.deserialize({})
	assert(not manager.is_entity_consumed("dev_pond", "junk_float"))
	manager.deserialize(saved)
	assert(manager.is_entity_consumed("dev_pond", "junk_float"))

	for id: String in ["wild_morning", "dock_rain", "grave_night", "dock_crate_tutorial"]:
		_schedule_second_frame(Callable(self, "_smoke_and_abort").bind(id, false))
		await manager.run_until_done(id)
		assert(smoke_checks.get(id) == true)
	# dock_rain and dock_crate_tutorial share dock_wharf, so the smoke pass used the
	# spot twice. One more normal session reaches the cap; the next is degraded.
	for _index: int in 1:
		_schedule_second_frame(Callable(self, "_smoke_and_abort").bind("dock_rain", false))
		await manager.run_until_done("dock_rain")
	assert(manager.get_use_count("dock_wharf|1") == 3)
	_schedule_second_frame(Callable(self, "_smoke_and_abort").bind("dock_rain", true))
	await manager.run_until_done("dock_rain")
	assert(manager.get_use_count("dock_wharf|1") == 4 and smoke_checks.get("dock_rain:degraded") == true)
	assert(bootstrap.action_executor.has_handler("startWaterMinigame"))
	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	await get_tree().process_frame
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("Water five-instance/render/pick/pull/failure/degrade/save/action integration test: PASS")
	get_tree().quit(0)


func _schedule_second_frame(callback: Callable) -> void:
	get_tree().process_frame.connect(func() -> void: get_tree().process_frame.connect(callback, CONNECT_ONE_SHOT), CONNECT_ONE_SHOT)


func _exercise_primary() -> void:
	var manager: RuntimeWaterMinigameManager = bootstrap.water_minigame_manager
	await _wait_scene_ready(manager, 5)
	var scene: RuntimeWaterMinigameScene = manager.scene
	var inventory: RuntimeInventoryManager = bootstrap.runtime_root.get_system("inventoryManager")
	var bottom_scale_ok := scene.bottom_texture_rect != null and scene.bottom_texture_rect.texture != null and scene.bottom_texture_rect.scale.is_equal_approx(Vector2(float(scene.instance.bounds.width) / scene.bottom_texture_rect.texture.get_width(), float(scene.instance.bounds.height) / scene.bottom_texture_rect.texture.get_height()))
	var render_ok: bool = scene != null \
		and scene.get_root().get_parent() == bootstrap.renderer.cutscene_overlay \
		and scene.get_entity_count() == 5 \
		and scene.color_viewport.size == Vector2i(720, 520) \
		and scene.params_viewport.size == Vector2i(720, 520) \
		and scene.surface_display.texture != null \
		and scene.surface_material.get_shader_parameter("params_texture") != null \
		and is_equal_approx(float(scene.surface_material.get_shader_parameter("murk")), 0.32) \
		and scene.surface_material.get_shader_parameter("filter_uv_scale") == Vector2(942.0 / 1024.0, 680.0 / 1024.0) \
		and scene.exit_button.size == Vector2(95, 54) and scene.exit_button.position == Vector2(917, 12) and scene.exit_title.text == "退出" and scene.exit_hint.text == "Esc 也可退出" \
		and bottom_scale_ok
	await scene.debug_tap_entity("junk_float")
	var pick_ok := inventory.get_item_count("copper_coins") == 1 \
		and not scene.get_entity("junk_float").is_visible() \
		and manager.is_entity_consumed("dev_pond", "junk_float")
	await scene.debug_tap_entity("crate_heavy")
	var pull_started := scene.get_phase() == RuntimeWaterMinigameScene.PULL and scene.pull_panel != null
	bootstrap.input_manager.debug_key_down("Space")
	scene.update(0.016, Vector2.ZERO)
	var key_down_ok := manager.session_pull_space_held and scene.pull_panel.lift_held
	bootstrap.input_manager.on_focus_lost(); scene.update(0.016, Vector2.ZERO); var focus_lost_ok := not manager.session_pull_space_held and not scene.pull_panel.lift_held
	bootstrap.input_manager.debug_key_down("Space")
	bootstrap.input_manager.debug_key_up("Space")
	scene.update(0.016, Vector2.ZERO)
	var key_up_ok := not manager.session_pull_space_held and not scene.pull_panel.lift_held
	scene.debug_finish_pull("success")
	await _wait_for_search(scene)
	var success_ok := inventory.get_item_count("copper_coins") == 4 and scene.get_feedback_text().contains("箱")
	await scene.debug_tap_entity("spasm_fish")
	scene.debug_finish_pull("fail_bite")
	await _wait_for_search(scene)
	var bite_ok: bool = bootstrap.flag_store.get_value("水边拉扯咬伤") == true and scene.get_feedback_text().contains("咬")
	primary_checks = render_ok and pick_ok and pull_started and key_down_ok and focus_lost_ok and key_up_ok and success_ok and bite_ok
	scene.abort()


func _wait_for_search(scene: RuntimeWaterMinigameScene) -> void:
	for _index: int in 120:
		await get_tree().process_frame
		if scene.get_phase() == RuntimeWaterMinigameScene.SEARCH and not scene.is_actions_playback_locked():
			return
	assert(false, "water action playback did not return to search")


func _wait_scene_ready(manager: RuntimeWaterMinigameManager, expected_count: int) -> void:
	for _index: int in 120:
		await get_tree().process_frame
		if manager.scene != null \
			and manager.scene.get_root().get_parent() == bootstrap.renderer.cutscene_overlay \
			and manager.scene.get_entity_count() == expected_count:
			return
	assert(false, "water scene did not finish loading")


func _smoke_and_abort(id: String, expect_degraded: bool) -> void:
	var expected_counts := {"wild_morning": 6, "dock_rain": 5, "grave_night": 4, "dock_crate_tutorial": 4}
	await _wait_scene_ready(bootstrap.water_minigame_manager, 3 if expect_degraded else int(expected_counts.get(id, 0)))
	var scene: RuntimeWaterMinigameScene = bootstrap.water_minigame_manager.scene
	scene.update(1.0 / 60.0, Vector2.ZERO)
	var visible := scene.get_visible_entity_ids()
	var ok: bool = scene != null \
		and scene.get_root().get_parent() == bootstrap.renderer.cutscene_overlay \
		and scene.get_entity_count() == (3 if expect_degraded else int(expected_counts.get(id, 0))) \
		and scene.is_degraded() == expect_degraded \
		and scene.surface_display.texture != null
	if id == "dock_crate_tutorial" and not expect_degraded:
		ok = ok and scene.shore_sprites.size() == 2
	if id == "wild_morning" and not expect_degraded:
		var leaf := scene.get_entity("floater_leaf"); ok = ok and leaf != null and leaf.sprite.modulate.r < 0.05 and leaf.sprite.modulate.g > 0.8
	if expect_degraded:
		ok = ok and visible == ["murk_grass", "wet_paper", "ledger_sink"]
		smoke_checks["%s:degraded" % id] = ok
	else:
		smoke_checks[id] = ok
	scene.abort()
