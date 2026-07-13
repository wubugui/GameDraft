extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")

var bootstrap: Node
var debug_probes: Array[Dictionary] = []
var results: Array[Dictionary] = []
var zodiac_checks := false
var folk_checks := false
var fail_checks := false


func _ready() -> void:
	bootstrap = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	var manager: RuntimeSugarWheelMinigameManager = bootstrap.sugar_wheel_minigame_manager
	assert(manager.get_instance_list() == [{"id": "sugar_zodiac", "label": "十二生肖转盘"}, {"id": "sugar_chongqing_folk", "label": "重庆糖关刀转盘"}])
	bootstrap.runtime_root.event_bus.on("minigame:sugarWheelResult", Callable(self, "_capture_result")); bootstrap.action_executor.register_debug_alert_handler(Callable(self, "_capture_debug_probe"))
	var inventory: RuntimeInventoryManager = bootstrap.runtime_root.get_system("inventoryManager"); assert(inventory.add_coins(20) and inventory.get_coins() == 20)
	_schedule_second_frame(Callable(self, "_exercise_zodiac"))
	await bootstrap.action_executor.execute_await({"type": "startSugarWheelMinigame", "params": {"id": "sugar_zodiac"}})
	assert(zodiac_checks and results.size() == 1 and results[0].sectorId == "rat" and results[0].sectorIndex == 11 and inventory.get_coins() == 15)
	assert(bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING and not manager.active)
	_schedule_second_frame(Callable(self, "_exercise_folk"))
	await manager.run_until_done("sugar_chongqing_folk")
	assert(folk_checks and results.size() == 2 and results[1].sectorId == "dragon" and results[1].sectorIndex == 0 and results[1].sectorPayload.tier == "grand")
	assert(inventory.remove_coins(15) and inventory.get_coins() == 0)
	_schedule_second_frame(Callable(self, "_exercise_fail_condition"))
	await manager.run_until_done("sugar_zodiac")
	assert(fail_checks and inventory.get_coins() == 0 and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING)
	for action_type: String in ["startSugarWheelMinigame", "sugarWheelShowSpeech", "sugarWheelDismissSpeech", "sugarWheelDismissAllSpeech", "sugarWheelResetPointer"]: assert(bootstrap.action_executor.has_handler(action_type))
	bootstrap.runtime_root.event_bus.off("minigame:sugarWheelResult", Callable(self, "_capture_result")); bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame
	remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout
	print("SugarWheel 2-instance/drag/charge/condition/physics/actions/speech/session integration test: PASS"); get_tree().quit(0)


func _schedule_second_frame(callback: Callable) -> void:
	get_tree().process_frame.connect(func() -> void: get_tree().process_frame.connect(callback, CONNECT_ONE_SHOT), CONNECT_ONE_SHOT)


func _exercise_zodiac() -> void:
	var scene: RuntimeSugarWheelMinigameScene = bootstrap.sugar_wheel_minigame_manager.scene
	var inventory: RuntimeInventoryManager = bootstrap.runtime_root.get_system("inventoryManager")
	var close_style: StyleBoxFlat = scene.close_button.get_theme_stylebox("normal")
	var charge_style: StyleBoxFlat = scene.charge_button.get_theme_stylebox("normal")
	var ui_skin_ok := scene.close_button.position == Vector2(978, 14) and scene.close_button.size == Vector2(32, 32) and close_style.bg_color.is_equal_approx(Color("222233", 0.72)) and close_style.border_color.is_equal_approx(Color("4a3a24")) and scene.charge_button.size == Vector2(52, 52) and charge_style.bg_color.is_equal_approx(Color("3a2e1e", 0.88)) and scene.hint_label.get_theme_color("font_color").is_equal_approx(Color("aaaacc")) and (not OS.is_debug_build() or scene.hint_label.text.ends_with(" · D 调试(几何+气泡测试)"))
	var attached: bool = scene != null and scene.get_root().get_parent() == bootstrap.renderer.cutscene_overlay and scene.get_instance().sectors.size() == 12 and scene.wheel_sprite.texture != null and scene.pointer_sprite.texture != null and scene.art_stack.material is ShaderMaterial and ui_skin_ok
	await scene.debug_drag_pointer(45.0)
	var drag_probe_ok: bool = not debug_probes.is_empty() and debug_probes[-1].sugarWheelCallback == "actionsOnPointerDrag" and debug_probes[-1].sugarWheelSectorId == "tiger" and debug_probes[-1].sugarWheelSectorIndex == 1
	await bootstrap.action_executor.execute_await({"type": "sugarWheelShowSpeech", "params": {"role": "child_a", "text": "动作气泡", "durationMs": 1200}}); var speech_show := scene.get_speech_count() == 1
	await bootstrap.action_executor.execute_await({"type": "sugarWheelDismissSpeech", "params": {"role": "child_a"}}); var speech_dismiss := scene.get_speech_count() == 0
	scene.show_speech("child_b", "一"); scene.show_speech("child_c", "二"); await bootstrap.action_executor.execute_await({"type": "sugarWheelDismissAllSpeech", "params": {}}); var speech_all := scene.get_speech_count() == 0
	await bootstrap.action_executor.execute_await({"type": "sugarWheelResetPointer", "params": {"angleDeg": rad_to_deg(0.1)}}); var reset_ok := is_equal_approx(scene.get_wheel_geom_angle_mod(), 0.1)
	scene.debug_press_charge(); var charging_ok := scene.get_phase() == RuntimeSugarWheelMinigameScene.CHARGING; scene.update(1.3); scene.debug_release_charge()
	for _index: int in 8:
		await get_tree().process_frame
		if scene.get_phase() == RuntimeSugarWheelMinigameScene.SPINNING: break
	var charge_paid: bool = scene.get_phase() == RuntimeSugarWheelMinigameScene.SPINNING and inventory.get_coins() == 15 and bootstrap.state_controller.current_state == RuntimeGameStateController.MINIGAME
	var result: Variant = await scene.debug_spin_to_completion(0.0)
	var landing_probe_ok := debug_probes.any(func(value: Dictionary) -> bool: return value.get("sugarWheelCallback") == "actionsOnSpinLanding" and value.get("sugarWheelSectorId") == "rat")
	zodiac_checks = attached and drag_probe_ok and speech_show and speech_dismiss and speech_all and reset_ok and charging_ok and charge_paid and result is Dictionary and result.sectorId == "rat" and landing_probe_ok
	bootstrap.input_manager.debug_key_down("Escape"); bootstrap.input_manager.debug_key_up("Escape"); await get_tree().process_frame
	assert(scene.is_confirm_visible()); scene.debug_accept_close()


func _exercise_folk() -> void:
	var scene: RuntimeSugarWheelMinigameScene = bootstrap.sugar_wheel_minigame_manager.scene
	scene.reset_pointer_geom_angle_deg(rad_to_deg(0.1)); var result: Variant = await scene.debug_spin_to_completion(0.2)
	folk_checks = result is Dictionary and result.sectorId == "dragon" and result.sectorPayload.tier == "grand" and scene.get_instance().atmosphereGroups.size() == 3
	scene.abort(); assert(scene.is_confirm_visible()); scene.debug_accept_close()


func _exercise_fail_condition() -> void:
	var scene: RuntimeSugarWheelMinigameScene = bootstrap.sugar_wheel_minigame_manager.scene
	scene.debug_press_charge(); var rejected := scene.get_phase() == RuntimeSugarWheelMinigameScene.IDLE
	for _index: int in 40:
		await get_tree().process_frame
		if bootstrap.dialogue_ui.is_open(): bootstrap.dialogue_ui.debug_advance()
		if not scene.is_actions_playback_locked() and bootstrap.state_controller.current_state == RuntimeGameStateController.MINIGAME: break
	fail_checks = rejected and scene.get_phase() == RuntimeSugarWheelMinigameScene.IDLE and not scene.is_actions_playback_locked() and bootstrap.state_controller.current_state == RuntimeGameStateController.MINIGAME
	scene.abort(); assert(scene.is_confirm_visible()); scene.debug_accept_close()


func _capture_result(payload: Variant) -> void:
	if payload is Dictionary: results.push_back(payload.duplicate(true))


func _capture_debug_probe(params: Dictionary) -> void:
	debug_probes.push_back(params.duplicate(true))
