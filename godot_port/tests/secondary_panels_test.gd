extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")
const BootstrapScript := preload("res://scripts/bootstrap.gd")
var bootstrap: Node
func _ready() -> void:
	bootstrap = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	get_tree().process_frame.connect(func() -> void: InputManagerProbe.key_down(bootstrap.input_manager, "Numpad2"), CONNECT_ONE_SHOT)
	var picked: Variant = await bootstrap.action_choice_ui.choose("选一个", [{"text": "甲"}, {"text": "乙"}], true); assert(picked == 1 and not bootstrap.action_choice_ui.is_open())
	bootstrap.runtime_root.event_bus.emit("dialogue:line", {"speaker": "掌柜", "text": "慢走"}); bootstrap.runtime_root.event_bus.emit("dialogue:choiceSelected:log", {"text": "告辞"}); InputManagerProbe.key_down(bootstrap.input_manager, "KeyL"); InputManagerProbe.key_up(bootstrap.input_manager, "KeyL"); assert(bootstrap.dialogue_log_ui.is_open() and bootstrap.dialogue_log_ui.content.text.contains("掌柜: 慢走") and bootstrap.dialogue_log_ui.serialize().entries.size() == 2); InputManagerProbe.key_down(bootstrap.input_manager, "Escape"); InputManagerProbe.key_up(bootstrap.input_manager, "Escape")
	await bootstrap.action_executor.execute_await({"type": "giveRule", "params": {"id": "rule_no_go_night"}}); await bootstrap.action_executor.execute_await({"type": "enableRuleOffers", "params": {"slots": [{"ruleId": "rule_no_go_night", "resultActions": [{"type": "setFlag", "params": {"key": "rule_ui_probe", "value": true}}], "resultText": "用了规矩"}]}}, {"zoneId": "probe"})
	InputManagerProbe.key_down(bootstrap.input_manager, "KeyF"); InputManagerProbe.key_up(bootstrap.input_manager, "KeyF"); assert(bootstrap.rule_use_ui.is_open() and bootstrap.rule_use_ui.resolved_slots.size() == 1)
	assert(bootstrap.rule_use_ui.get_action_button_count() == 1); bootstrap.rule_use_ui.action_buttons[0].pressed.emit()
	await get_tree().create_timer(0.15).timeout
	InputManagerProbe.key_down(bootstrap.input_manager, "Space"); InputManagerProbe.key_up(bootstrap.input_manager, "Space")
	var settle_guard := 0
	while settle_guard < 120 and (
		bootstrap.rule_use_ui.is_open()
		or bootstrap.flag_store.get_value("rule_ui_probe") != true
		or bootstrap.flag_store.get_value("rule_used_rule_no_go_night") != true
		or bootstrap.state_controller.current_state != RuntimeDataTypes.EXPLORING
	):
		settle_guard += 1
		await get_tree().process_frame
	assert(settle_guard < 120)
	assert(not bootstrap.rule_use_ui.is_open() and bootstrap.flag_store.get_value("rule_ui_probe") == true and bootstrap.flag_store.get_value("rule_used_rule_no_go_night") == true and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout; print("ActionChoice/DialogueLog/RuleUse UI input/data/action lifecycle test: PASS"); get_tree().quit(0)
