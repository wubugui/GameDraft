extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")

var bootstrap: Node
var debug_probes: Array[Dictionary] = []
var results: Array[Dictionary] = []
var zodiac_checks := false
var folk_checks := false
var fail_checks := false


func _ready() -> void:
	bootstrap = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	await get_tree().process_frame
	var manager: RuntimeSugarWheelMinigameManager = bootstrap.sugar_wheel_minigame_manager
	assert(manager.get_instance_list() == [
		{"id": "sugar_zodiac", "label": "十二生肖转盘"},
		{"id": "sugar_chongqing_folk", "label": "重庆糖关刀转盘"},
	])
	assert(manager.index_url == "/assets/data/sugar_wheel/index.json")
	assert(manager.data_subdir == "sugar_wheel")
	assert(manager.scope_prefix == "minigame:sugarWheel")
	assert(manager.system_label == "SugarWheelMinigameManager")
	assert(manager.build_instance_manifest_refs({
		"id": "probe",
		"backgroundImage": " bg.png ",
		"foregroundImage": null,
		"wheelImage": "wheel.png",
		"pointerImage": "",
	}) == [
		{"type": "texture", "path": " bg.png ", "label": "糖画背景: probe"},
		{"type": "texture", "path": "wheel.png", "label": "糖画转盘: probe"},
	])

	bootstrap.runtime_root.event_bus.on("minigame:sugarWheelResult", Callable(self, "_capture_result"))
	bootstrap.action_executor.register(
		"debugAlertActionParams",
		func(params: Dictionary, _zone: Variant) -> void: _capture_debug_probe(params),
		["title"],
	)
	var inventory: RuntimeInventoryManager = bootstrap.inventory_manager
	inventory.add_coins(20)
	assert(inventory.get_coins() == 20)

	_schedule_second_frame(Callable(self, "_exercise_zodiac"))
	await bootstrap.action_executor.execute_await({"type": "startSugarWheelMinigame", "params": {"id": "sugar_zodiac"}})
	assert(zodiac_checks)
	assert(results.size() == 1 and results[0].sectorId == "rat" and results[0].sectorIndex == 11)
	assert(inventory.get_coins() == 15)
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING and not manager.active)

	_schedule_second_frame(Callable(self, "_exercise_folk"))
	await manager.run_until_done("sugar_chongqing_folk")
	assert(folk_checks)
	assert(results.size() == 2 and results[1].sectorId == "dragon" and results[1].sectorIndex == 0)
	assert(results[1].sectorPayload.tier == "grand")
	assert(inventory.remove_coins(15) and inventory.get_coins() == 0)

	_schedule_second_frame(Callable(self, "_exercise_fail_condition"))
	await manager.run_until_done("sugar_zodiac")
	assert(fail_checks)
	assert(inventory.get_coins() == 0)
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)

	for action_type: String in [
		"startSugarWheelMinigame",
		"sugarWheelShowSpeech",
		"sugarWheelDismissSpeech",
		"sugarWheelDismissAllSpeech",
		"sugarWheelResetPointer",
	]:
		assert(bootstrap.action_executor.has_handler(action_type))
	bootstrap.runtime_root.event_bus.off("minigame:sugarWheelResult", Callable(self, "_capture_result"))
	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	await get_tree().process_frame
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("SugarWheel direct-field/layer/input/charge/condition/physics/actions/speech/session integration test: PASS")
	get_tree().quit(0)


func _schedule_second_frame(callback: Callable) -> void:
	get_tree().process_frame.connect(
		func() -> void: get_tree().process_frame.connect(callback, CONNECT_ONE_SHOT),
		CONNECT_ONE_SHOT,
	)


func _exercise_zodiac() -> void:
	var manager: RuntimeSugarWheelMinigameManager = bootstrap.sugar_wheel_minigame_manager
	var scene: RuntimeSugarWheelMinigameScene = manager.scene
	var inventory: RuntimeInventoryManager = bootstrap.inventory_manager
	var graph_ok: bool = (
		scene.root.get_parent() == bootstrap.renderer.cutscene_overlay
		and is_same(scene.instance, manager.instance_cache.sugar_zodiac)
		and _children_are(scene.root, [scene.bg, scene.background_sprite, scene.wheel_layer, scene.foreground_sprite, scene.ui_layer])
		and _children_are(scene.wheel_layer, [scene.wheel_sprite, scene.arc_power_ring, scene.pointer_sprite, scene.geom_debug_gfx, scene.geom_debug_rim_container, scene.geom_debug_hud])
		and _children_are(scene.ui_layer, [scene.result_banner, scene.charge_button, scene.close_icon_button, scene.hint_text, scene.speech_layer, scene.speech_debug_layer, scene.confirm_layer, scene.action_input_shield])
	)
	var art_ok: bool = (
		scene.instance.sectors.size() == 12
		and scene.wheel_sprite.texture != null
		and scene.pointer_sprite.texture != null
		and scene.background_sprite.texture != null
		and scene.foreground_sprite.texture != null
		and scene.close_icon_button.position == Vector2(978.0, 14.0)
		and scene.close_icon_button.size == Vector2(32.0, 32.0)
		and scene.charge_button.size == Vector2(52.0, 52.0)
		and (not OS.is_debug_build() or scene.hint_text.text.ends_with(" · D 调试(几何+气泡测试)"))
	)

	_emit_pointer_drag(scene, 45.0)
	await _wait_for_action_unlock(scene)
	var drag_probe_ok: bool = (
		not debug_probes.is_empty()
		and debug_probes[-1].sugarWheelCallback == "actionsOnPointerDrag"
		and debug_probes[-1].sugarWheelSectorId == "tiger"
		and debug_probes[-1].sugarWheelSectorIndex == 1
	)

	await bootstrap.action_executor.execute_await({"type": "sugarWheelShowSpeech", "params": {"role": "child_a", "text": "动作气泡", "durationMs": 1200}})
	var speech_show: bool = scene.speech_entries.size() == 1 and scene.speech_entries[0].role == "child_a" and scene.speech_entries[0].container.get_parent() == scene.speech_layer
	await bootstrap.action_executor.execute_await({"type": "sugarWheelDismissSpeech", "params": {"role": "child_a"}})
	var speech_dismiss := scene.speech_entries.is_empty()
	scene.show_speech("child_b", "一")
	scene.show_speech("child_c", "二")
	await bootstrap.action_executor.execute_await({"type": "sugarWheelDismissAllSpeech", "params": {}})
	var speech_all := scene.speech_entries.is_empty()

	await bootstrap.action_executor.execute_await({"type": "sugarWheelResetPointer", "params": {"angleDeg": rad_to_deg(0.1)}})
	var reset_ok := is_equal_approx(scene._wheel_geom_angle_mod(), 0.1)
	_emit_charge_button(scene, true)
	scene.update(0.0)
	var charging_ok: bool = scene.phase == "charging" and scene.pending_charge_pass_actions is Array and scene.pending_charge_pass_actions.size() == 1
	scene.update(1.3)
	_emit_charge_button(scene, false)
	scene.update(0.0)
	for _index: int in 12:
		await get_tree().process_frame
		if scene.phase == "spinning":
			break
	var charge_paid: bool = scene.phase == "spinning" and inventory.get_coins() == 15 and bootstrap.state_controller.current_state == RuntimeDataTypes.MINIGAME
	var result: Variant = await _advance_spin_to_result(scene)
	var landing_probe_ok := debug_probes.any(func(value: Dictionary) -> bool:
		return value.get("sugarWheelCallback") == "actionsOnSpinLanding" and value.get("sugarWheelSectorId") == "rat"
	)
	zodiac_checks = graph_ok and art_ok and drag_probe_ok and speech_show and speech_dismiss and speech_all and reset_ok and charging_ok and charge_paid and result is Dictionary and result.sectorId == "rat" and landing_probe_ok

	InputManagerProbe.key_down(bootstrap.input_manager, "Escape")
	InputManagerProbe.key_up(bootstrap.input_manager, "Escape")
	await get_tree().process_frame
	assert(scene.confirm_visible and scene.confirm_layer.visible)
	_emit_button(scene.confirm_yes_button)


func _exercise_folk() -> void:
	var manager: RuntimeSugarWheelMinigameManager = bootstrap.sugar_wheel_minigame_manager
	var scene: RuntimeSugarWheelMinigameScene = manager.scene
	scene.reset_pointer_geom_angle_deg(rad_to_deg(0.1))
	scene.phase = "launching"
	scene._begin_physics_spin(0.2)
	var result: Variant = await _advance_spin_to_result(scene)
	folk_checks = (
		result is Dictionary
		and result.sectorId == "dragon"
		and result.sectorPayload.tier == "grand"
		and scene.instance.atmosphereGroups.size() == 3
		and is_same(scene.instance, manager.instance_cache.sugar_chongqing_folk)
	)
	scene.abort()
	assert(scene.confirm_visible)
	_emit_button(scene.confirm_yes_button)


func _exercise_fail_condition() -> void:
	var scene: RuntimeSugarWheelMinigameScene = bootstrap.sugar_wheel_minigame_manager.scene
	_emit_charge_button(scene, true)
	scene.update(0.0)
	var rejected := scene.phase == "idle" and scene.pending_charge_pass_actions == null
	for _index: int in 80:
		await get_tree().process_frame
		if bootstrap.dialogue_ui.is_open():
			bootstrap.dialogue_ui.debug_advance()
		if not scene.is_actions_playback_locked() and bootstrap.state_controller.current_state == RuntimeDataTypes.MINIGAME:
			break
	fail_checks = rejected and scene.phase == "idle" and not scene.is_actions_playback_locked() and bootstrap.state_controller.current_state == RuntimeDataTypes.MINIGAME
	scene.abort()
	assert(scene.confirm_visible)
	_emit_button(scene.confirm_yes_button)


func _emit_pointer_drag(scene: RuntimeSugarWheelMinigameScene, angle_degrees: float) -> void:
	var point := scene.wheel_layer.position + scene._geom_point_on_wheel(scene.wheel_geom_radius_px * 0.7, deg_to_rad(angle_degrees))
	var pressed := InputEventMouseButton.new()
	pressed.button_index = MOUSE_BUTTON_LEFT
	pressed.pressed = true
	pressed.position = point
	scene.root.gui_input.emit(pressed)
	var released := InputEventMouseButton.new()
	released.button_index = MOUSE_BUTTON_LEFT
	released.pressed = false
	released.position = point
	scene.root.gui_input.emit(released)


func _emit_charge_button(scene: RuntimeSugarWheelMinigameScene, pressed_value: bool) -> void:
	var input: Button = scene.charge_button.get_node("Input")
	var event := InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_LEFT
	event.pressed = pressed_value
	input.gui_input.emit(event)


func _emit_button(container: Control) -> void:
	var input: Button = container.get_node("Input")
	input.pressed.emit()


func _wait_for_action_unlock(scene: RuntimeSugarWheelMinigameScene) -> void:
	for _index: int in 40:
		await get_tree().process_frame
		if not scene.is_actions_playback_locked():
			return


func _advance_spin_to_result(scene: RuntimeSugarWheelMinigameScene) -> Variant:
	for index: int in 400000:
		if scene.phase != "spinning":
			break
		scene.update(0.05)
		if index % 2000 == 0:
			await get_tree().process_frame
	for _index: int in 40:
		await get_tree().process_frame
		if scene.phase == "result":
			break
	return scene.last_result


func _children_are(parent: Node, expected: Array) -> bool:
	var actual := parent.get_children()
	if actual.size() != expected.size():
		return false
	for index: int in expected.size():
		if not is_same(actual[index], expected[index]):
			return false
	return true


func _capture_result(payload: Variant) -> void:
	if payload is Dictionary:
		results.push_back(payload.duplicate(true))


func _capture_debug_probe(params: Dictionary) -> void:
	debug_probes.push_back(params.duplicate(true))
