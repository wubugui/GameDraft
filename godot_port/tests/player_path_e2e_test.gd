extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")
const SceneQueries := preload("res://tests/support/scene_queries.gd")

var bootstrap: Node


func _ready() -> void:
	bootstrap = BootstrapScript.new()
	add_child(bootstrap)
	await get_tree().process_frame
	await get_tree().process_frame
	assert(bootstrap.scene_manager.get_current_scene_id() == "teahouse")
	assert(bootstrap.cutscene_manager.is_playing() and bootstrap.state_controller.current_state == RuntimeDataTypes.CUTSCENE)
	_send_key(KEY_ESCAPE)
	assert(await _wait_until(func() -> bool:
		return not bootstrap.cutscene_manager.is_playing() \
			and bootstrap.state_controller.current_state == RuntimeDataTypes.DIALOGUE \
			and bootstrap.graph_dialogue_manager.is_active()
	, 120))

	# 当前权威场景的 onEnter 会自动启动听书图；其首个 runActions 播放上面的
	# cutscene，跳过后必须恢复到同一图对话，而不是另行点击说书人。
	assert(bootstrap.graph_dialogue_manager.get_dialogue_view_debug().graphId == "寻狗_听书开场")
	assert(await _drive_active_dialogue(240))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s01_tingshu")
	assert(bootstrap.quest_manager.get_status("xg01_tingshu") == RuntimeQuestManager.COMPLETED)

	# Traverse the first production loop exclusively through transition hotspots:
	# 茶馆 -> 雾津街头 -> 码头 -> 雾津街头 -> 茶馆. Each hop validates the
	# real condition gate, ActionExecutor switchScene handler and target spawn.
	assert(await _take_transition("exit_to_street", "雾津街头"))
	assert(await _take_transition("T_去码头", "码头白天"))
	assert(await _take_transition("T码头到街巷", "雾津街头"))
	assert(await _take_transition("T_进茶馆", "teahouse"))
	assert(bootstrap.scene_manager.serialize().currentSceneId == "teahouse")
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)
	assert(not bootstrap.graph_dialogue_manager.is_active() and not bootstrap.cutscene_manager.is_playing())

	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.6).timeout
	print("No-debug new-game/dialogue/production-transition player path E2E: PASS")
	get_tree().quit(0)


func _take_transition(hotspot_id: String, expected_scene: String) -> bool:
	var hotspot: RuntimeHotspot = SceneQueries.hotspot(bootstrap.scene_manager, hotspot_id)
	if hotspot == null:
		return false
	bootstrap.player.set_x(hotspot.get_center_x())
	bootstrap.player.set_y(hotspot.get_center_y())
	await _press_interact()
	# 浏览器里下一次真实按键只能发生在 Promise continuation 释放
	# ActionSequence 之后；测试直接串行注入按键，也必须等待同一个可交互边界。
	return await _wait_until(func() -> bool:
		return bootstrap.scene_manager.get_current_scene_id() == expected_scene \
			and not bootstrap.scene_manager.is_switching() \
			and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING
	, 120)


func _press_interact() -> void:
	bootstrap.interaction_system.update(0.0)
	_key_event(KEY_E, true)
	bootstrap.interaction_system.update(0.0)
	_key_event(KEY_E, false)
	bootstrap.input_manager.end_frame()
	await get_tree().process_frame


func _drive_active_dialogue(limit: int) -> bool:
	var steps := 0
	while bootstrap.graph_dialogue_manager.is_active() and steps < limit:
		steps += 1
		var view: Dictionary = bootstrap.graph_dialogue_manager.get_dialogue_view_debug()
		if view.get("choiceStage") == "options":
			var selected := -1
			for choice: Dictionary in view.get("choices", []):
				if choice.get("enabled") == true:
					selected = int(choice.get("index", -1))
					break
			if selected < 0 or selected > 8:
				return false
			_send_key(KEY_1 + selected)
		else:
			_send_key(KEY_ENTER)
		await get_tree().process_frame
	return not bootstrap.graph_dialogue_manager.is_active()


func _send_key(keycode: Key) -> void:
	_key_event(keycode, true)
	_key_event(keycode, false)


func _key_event(keycode: Key, pressed: bool) -> void:
	var event := InputEventKey.new()
	event.keycode = keycode
	event.physical_keycode = keycode
	event.pressed = pressed
	bootstrap.input_manager._input(event)


func _wait_until(predicate: Callable, max_frames: int) -> bool:
	for _frame in max_frames:
		if predicate.call():
			return true
		await get_tree().process_frame
	return bool(predicate.call())
