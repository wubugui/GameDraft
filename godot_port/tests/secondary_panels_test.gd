extends Node
const BootstrapScript := preload("res://scripts/bootstrap.gd")
var bootstrap: Node
func _ready() -> void:
	bootstrap = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	get_tree().process_frame.connect(func() -> void: bootstrap.input_manager.debug_key_down("Numpad2"), CONNECT_ONE_SHOT)
	var picked: Variant = await bootstrap.action_choice_ui.choose("选一个", [{"text": "甲"}, {"text": "乙"}], true); assert(picked == 1 and not bootstrap.action_choice_ui.is_open())
	bootstrap.runtime_root.event_bus.emit("dialogue:line", {"speaker": "掌柜", "text": "慢走"}); bootstrap.runtime_root.event_bus.emit("dialogue:choiceSelected:log", {"text": "告辞"}); bootstrap.input_manager.debug_key_down("KeyL"); bootstrap.input_manager.debug_key_up("KeyL"); assert(bootstrap.dialogue_log_ui.is_open() and bootstrap.dialogue_log_ui.content.text.contains("掌柜: 慢走") and bootstrap.dialogue_log_ui.serialize().entries.size() == 2); bootstrap.input_manager.debug_key_down("Escape"); bootstrap.input_manager.debug_key_up("Escape")
	await bootstrap.action_executor.execute_await({"type": "giveRule", "params": {"id": "rule_no_go_night"}}); await bootstrap.action_executor.execute_await({"type": "enableRuleOffers", "params": {"slots": [{"ruleId": "rule_no_go_night", "resultActions": [{"type": "setFlag", "params": {"key": "rule_ui_probe", "value": true}}], "resultText": "用了规矩"}]}}, {"zoneId": "probe"})
	bootstrap.input_manager.debug_key_down("KeyF"); bootstrap.input_manager.debug_key_up("KeyF"); assert(bootstrap.rule_use_ui.is_open() and bootstrap.rule_use_ui.resolved_slots.size() == 1)
	assert(bootstrap.rule_use_ui.get_action_button_count() == 1); bootstrap.rule_use_ui.action_buttons[0].pressed.emit()
	await get_tree().create_timer(0.15).timeout
	bootstrap.input_manager.debug_key_down("Space"); bootstrap.input_manager.debug_key_up("Space")
	await get_tree().process_frame; await get_tree().process_frame
	assert(not bootstrap.rule_use_ui.is_open() and bootstrap.flag_store.get_value("rule_ui_probe") == true and bootstrap.flag_store.get_value("rule_used_rule_no_go_night") == true and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING)
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout; print("ActionChoice/DialogueLog/RuleUse UI input/data/action lifecycle test: PASS"); get_tree().quit(0)
