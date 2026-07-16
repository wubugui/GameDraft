extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

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
	assert(manager.index_url == "/assets/data/water_minigames/index.json" and manager.data_subdir == "water_minigames" and manager.scope_prefix == "minigame:water" and manager.system_label == "WaterMinigameManager")
	assert(manager.build_instance_manifest_refs({
		"id": "probe", "waterBottom": {"texture": " bottom.png "},
		"shoreForeground": {"banks": [{"sprite": null}, {"sprite": "bank.png"}]},
		"entities": [{"id": "empty", "sprite": ""}, {"id": "fish", "sprite": " fish.png "}],
	}) == [
		{"type": "texture", "path": " bottom.png ", "label": "水域底图: probe"},
		{"type": "texture", "path": "bank.png", "label": "水域岸边: probe"},
		{"type": "texture", "path": " fish.png ", "label": "水域实体: fish"},
	])
	var original_entity := {"id": "probe_entity", "consumeOnSuccess": false, "sprite": null}
	var owned_day_manager := manager.day_manager
	manager.day_manager = null
	bootstrap.flag_store.set_value(RuntimeFlagKeys.CURRENT_DAY, 0.0)
	var prepared := manager.prepare_instance({"id": "probe", "spotId": null, "entities": [original_entity]})
	assert(manager.session_use_key == "probe|0" and is_same(prepared.entities[0], original_entity))
	manager.day_manager = owned_day_manager
	bootstrap.flag_store.set_value(RuntimeFlagKeys.CURRENT_DAY, 1.0)
	_schedule_second_frame(Callable(self, "_exercise_primary"))
	await bootstrap.action_executor.execute_await({"type": "startWaterMinigame", "params": {"id": "dev_pond"}})
	assert(primary_checks and not manager.active and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING, "primary=%s active=%s state=%s details=%s" % [primary_checks, manager.active, bootstrap.state_controller.current_state, smoke_checks.get("primaryDetails", {})])
	assert(manager.consumed_pull_entities.has("dev_pond::junk_float"))
	var saved := manager.serialize()
	manager.deserialize({})
	assert(not manager.consumed_pull_entities.has("dev_pond::junk_float"))
	manager.deserialize(saved)
	assert(manager.consumed_pull_entities.has("dev_pond::junk_float"))

	for id: String in ["wild_morning", "dock_rain", "grave_night", "dock_crate_tutorial"]:
		_schedule_second_frame(Callable(self, "_smoke_and_abort").bind(id, false))
		await manager.run_until_done(id)
		assert(smoke_checks.get(id) == true)
	# dock_rain and dock_crate_tutorial share dock_wharf, so the smoke pass used the
	# spot twice. One more normal session reaches the cap; the next is degraded.
	for _index: int in 1:
		_schedule_second_frame(Callable(self, "_smoke_and_abort").bind("dock_rain", false))
		await manager.run_until_done("dock_rain")
	assert(int(manager.uses_by_spot_day.get("dock_wharf|1", 0)) == 3)
	_schedule_second_frame(Callable(self, "_smoke_and_abort").bind("dock_rain", true))
	await manager.run_until_done("dock_rain")
	assert(int(manager.uses_by_spot_day.get("dock_wharf|1", 0)) == 4 and smoke_checks.get("dock_rain:degraded") == true)
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
	var inventory: RuntimeInventoryManager = bootstrap.inventory_manager
	var bottom_scale_ok: bool = scene.bottom_texture_sprite != null and scene.bottom_texture_sprite.texture != null and scene.bottom_texture_sprite.scale.is_equal_approx(Vector2(float(scene.instance.bounds.width) / scene.bottom_texture_sprite.texture.get_width(), float(scene.instance.bounds.height) / scene.bottom_texture_sprite.texture.get_height()))
	var params_pass_has_entity := _params_pass_has_entity(scene)
	var expected_rt_size := _expected_rt_size(scene)
	var render_ok: bool = scene != null \
		and scene.root.get_parent() == bootstrap.renderer.cutscene_overlay \
		and scene.entities.size() == 5 \
		and scene.bottom_mrt.size == expected_rt_size \
		and scene.params_mrt.size == expected_rt_size \
		and scene.bottom_mrt_sprite.texture != null \
		and scene.water_filter.get_shader_parameter("params_texture") != null \
		and is_equal_approx(float(scene.water_filter.get_shader_parameter("murk")), 0.32) \
		and scene.water_filter.get_shader_parameter("filter_uv_scale") == Vector2(float(expected_rt_size.x) / 1024.0, float(expected_rt_size.y) / 1024.0) \
		and scene.exit_chrome.position == Vector2(1024.0 - scene.exit_chrome.size.x - 12.0, 12.0) and scene.exit_title.text == "退出" and scene.exit_hint.text == "Esc 也可退出" \
		and bottom_scale_ok \
		and params_pass_has_entity
	await _tap_entity(scene, "junk_float")
	var pick_ok := inventory.get_item_count("copper_coins") == 1 \
		and not _entity(scene, "junk_float").container.visible \
		and manager.consumed_pull_entities.has("dev_pond::junk_float")
	await _tap_entity(scene, "crate_heavy")
	var pull_started: bool = scene.phase == RuntimeWaterMinigameScene.PULL and scene.pull_panel != null
	InputManagerProbe.key_down(bootstrap.input_manager, "Space")
	scene.update(0.016, Vector2.ZERO)
	var key_down_ok: bool = manager.session_pull_space_held and scene.pull_panel._lift_held()
	var key_down_details := {"held": manager.session_pull_space_held, "lift": scene.pull_panel._lift_held(), "processing": manager.is_processing_input(), "attached": manager.bound_pull_space_key_down is Callable and manager.bound_pull_space_key_up is Callable and manager.bound_pull_window_blur is Callable}
	InputManagerProbe.focus_lost(bootstrap.input_manager); scene.update(0.016, Vector2.ZERO); var focus_lost_ok: bool = not manager.session_pull_space_held and not scene.pull_panel._lift_held()
	InputManagerProbe.key_down(bootstrap.input_manager, "Space")
	InputManagerProbe.key_up(bootstrap.input_manager, "Space")
	scene.update(0.016, Vector2.ZERO)
	var key_up_ok: bool = not manager.session_pull_space_held and not scene.pull_panel._lift_held()
	scene.pull_panel._finish("success")
	await _wait_for_search(scene)
	var success_ok: bool = inventory.get_item_count("copper_coins") == 4 and _feedback_text(scene).contains("箱")
	await _tap_entity(scene, "spasm_fish")
	scene.pull_panel._finish("fail_bite")
	await _wait_for_search(scene)
	var bite_ok: bool = bootstrap.flag_store.get_value("水边拉扯咬伤") == true and _feedback_text(scene).contains("咬")
	smoke_checks.primaryDetails = {"render": render_ok, "pick": pick_ok, "pull": pull_started, "keyDown": key_down_ok, "keyDownDetails": key_down_details, "focusLost": focus_lost_ok, "keyUp": key_up_ok, "success": success_ok, "bite": bite_ok}
	primary_checks = render_ok and pick_ok and pull_started and key_down_ok and focus_lost_ok and key_up_ok and success_ok and bite_ok
	scene.abort()


func _wait_for_search(scene: RuntimeWaterMinigameScene) -> void:
	for _index: int in 120:
		await get_tree().process_frame
		if scene.phase == RuntimeWaterMinigameScene.SEARCH and not scene.is_actions_playback_locked():
			return
	assert(false, "water action playback did not return to search")


func _params_pass_has_entity(scene: RuntimeWaterMinigameScene) -> bool:
	if DisplayServer.get_name() == "headless" or RenderingServer.get_current_rendering_driver_name() == "dummy":
		var mirror_count := 0
		for entity: RuntimeWaterEntity in scene.entities:
			if entity.params_sprite == null: continue
			mirror_count += 1
			if not entity.params_sprite.visible or not entity.params_container.visible:
				return false
		return mirror_count > 0
	var image: Image = scene.params_mrt.get_texture().get_image()
	for y: int in range(0, image.get_height(), 2):
		for x: int in range(0, image.get_width(), 2):
			var pixel: Color = image.get_pixel(x, y)
			if pixel.a > 0.01 and pixel.b > 0.9:
				return true
	return false


func _wait_scene_ready(manager: RuntimeWaterMinigameManager, expected_count: int) -> void:
	for _index: int in 120:
		await get_tree().process_frame
		if manager.scene != null \
			and manager.scene.root.get_parent() == bootstrap.renderer.cutscene_overlay \
			and manager.scene.entities.size() == expected_count:
			return
	assert(false, "water scene did not finish loading")


func _smoke_and_abort(id: String, expect_degraded: bool) -> void:
	var expected_counts := {"wild_morning": 6, "dock_rain": 5, "grave_night": 4, "dock_crate_tutorial": 4}
	await _wait_scene_ready(bootstrap.water_minigame_manager, 3 if expect_degraded else int(expected_counts.get(id, 0)))
	var scene: RuntimeWaterMinigameScene = bootstrap.water_minigame_manager.scene
	scene.update(1.0 / 60.0, Vector2.ZERO)
	var visible := _visible_entity_ids(scene)
	var ok: bool = scene != null \
		and scene.root.get_parent() == bootstrap.renderer.cutscene_overlay \
		and scene.entities.size() == (3 if expect_degraded else int(expected_counts.get(id, 0))) \
		and scene.degraded == expect_degraded \
		and scene.bottom_mrt_sprite.texture != null
	if id == "dock_crate_tutorial" and not expect_degraded:
		ok = ok and scene.shore_sprites.size() == 2
	if id == "wild_morning" and not expect_degraded:
		var leaf: RuntimeWaterEntity = _entity(scene, "floater_leaf"); ok = ok and leaf != null and leaf.sprite.modulate.r < 0.05 and leaf.sprite.modulate.g > 0.8
	if expect_degraded:
		ok = ok and visible == ["murk_grass", "wet_paper", "ledger_sink"]
		smoke_checks["%s:degraded" % id] = ok
	else:
		smoke_checks[id] = ok
	scene.abort()


func _entity(scene: RuntimeWaterMinigameScene, id: String) -> RuntimeWaterEntity:
	for entity: RuntimeWaterEntity in scene.entities:
		if str(entity.def.id) == id:
			return entity
	return null


func _tap_entity(scene: RuntimeWaterMinigameScene, id: String) -> void:
	var entity := _entity(scene, id)
	assert(entity != null)
	if entity.def.category == "floating":
		await scene._run_floating_pick(entity)
	else:
		scene._on_entity_tap(entity)


func _feedback_text(scene: RuntimeWaterMinigameScene) -> String:
	return scene.feedback.text if scene.feedback != null else ""


func _visible_entity_ids(scene: RuntimeWaterMinigameScene) -> Array[String]:
	var result: Array[String] = []
	for entity: RuntimeWaterEntity in scene.entities:
		if entity.container.visible:
			result.push_back(str(entity.def.id))
	return result


func _expected_rt_size(scene: RuntimeWaterMinigameScene) -> Vector2i:
	var width := float(scene.instance.bounds.width)
	var height := float(scene.instance.bounds.height)
	var scale := minf(float(scene.renderer.screen_width) / width, float(scene.renderer.screen_height) / height) * 0.92
	return Vector2i(
		maxi(256, mini(960, int(floor(width * scale)))),
		maxi(192, mini(720, int(floor(height * scale)))),
	)
