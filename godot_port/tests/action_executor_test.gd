extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

var calls: Array = []
var contexts: Array = []
var executor_ref: RuntimeActionExecutor
var launched_nested_zone := false
var debug_params_capture: Dictionary = {}


func _ready() -> void:
	await _run()


func _run() -> void:
	var bus := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(bus)
	flags.configure_registry({"static": [
		{"key": "toggle", "valueType": "bool"},
		{"key": "n", "valueType": "float"},
		{"key": "note", "valueType": "string"},
	]})
	var input := RuntimeInputManager.new()
	add_child(input)
	var state := RuntimeGameStateController.new(input, bus)
	var executor := RuntimeActionExecutor.new(bus, flags, state)
	executor_ref = executor
	preload("res://tests/support/action_registry_fixture.gd").register(executor, {"stateController": state})
	var notifications: Array = []
	bus.on("notification:show", func(payload: Variant) -> void: notifications.push_back(payload))
	executor.set_resolve_notification_text(func(text: String) -> String: return "R:" + text)
	for type: String in ["setFlag", "appendFlag", "addFlagValue", "showNotification", "runActions", "chooseAction", "randomBranch"]:
		assert(executor.has_handler(type))
	assert(executor.get_param_names("﻿ setFlag ") == ["key", "value"])
	assert(executor.has_handler(" setFlag "))
	await executor.execute_await({"type": "debugAlertActionParams", "params": {"title": "探针", "value": 7}})
	assert(executor.get_param_names("debugAlertActionParams") == [])

	await executor.execute_batch_await([
		{"type": "setFlag", "params": {"key": "toggle", "value": true}},
		{"type": "addFlagValue", "params": {"key": "n", "delta": "2"}},
		{"type": "appendFlag", "params": {"key": "note", "text": "甲"}},
		{"type": "showNotification", "params": {"text": "完成", "type": "info"}},
	])
	assert(flags.get_value("toggle") == true and flags.get_value("n") == 2.0 and flags.get_value("note") == "甲")
	assert(notifications == [{"text": "R:完成", "type": "info"}])
	assert(state.current_state == RuntimeDataTypes.EXPLORING)

	executor.register("delayed", Callable(self, "_delayed"), ["label", "delay"])
	await executor.execute_batch_await([
		{"type": "delayed", "params": {"label": "a", "delay": 0.02}},
		{"type": "delayed", "params": {"label": "b", "delay": 0.001}},
	])
	assert(calls == ["start:a", "end:a", "start:b", "end:b"])
	assert(state.current_state == RuntimeDataTypes.EXPLORING)

	executor.register("nested", func(params: Dictionary, zone: Variant) -> void:
		await executor.execute_batch_await(params.get("actions", []), zone)
	)
	executor.push_action_policy(["setFlag"], "cutscene:test")
	await executor.execute_await({"type": "nested", "params": {"actions": [{"type": "setFlag", "params": {"key": "toggle", "value": false}}]}})
	assert(flags.get_value("toggle") == true)
	executor.pop_action_policy()
	assert(executor.get_policy_depth() == 0)

	executor.register("captureZone", Callable(self, "_capture_zone"))
	await executor.execute_batch_in_zone_context([{"type": "captureZone", "params": {"delay": 0.02}}], {"zoneId": "A"})
	contexts.sort()
	assert(contexts == ["A", "B"])

	state.set_state(RuntimeDataTypes.EXPLORING)
	executor.register("opensDialogue", func(_params: Dictionary, _zone: Variant) -> void: state.set_state(RuntimeDataTypes.DIALOGUE))
	await executor.execute_await({"type": "opensDialogue", "params": {}})
	assert(state.current_state == RuntimeDataTypes.DIALOGUE)
	state.set_state(RuntimeDataTypes.EXPLORING)
	await executor.execute_await({"type": "unknown", "params": {}})
	assert(state.current_state == RuntimeDataTypes.EXPLORING)
	executor.destroy()
	executor_ref = null
	await executor.execute_await({"type": "setFlag", "params": {"key": "toggle", "value": false}})
	assert(flags.get_value("toggle") == true)
	flags.destroy()
	state.destroy()
	bus.clear()
	remove_child(input)
	input.free()
	await get_tree().process_frame
	print("ActionExecutor queue/policy test: PASS")
	get_tree().quit(0)


func _delayed(params: Dictionary, _zone: Variant) -> void:
	var label := str(params.get("label", ""))
	calls.push_back("start:" + label)
	await get_tree().create_timer(float(params.get("delay", 0.0))).timeout
	calls.push_back("end:" + label)


func _capture_zone(params: Dictionary, zone: Variant) -> void:
	if zone is Dictionary and zone.get("zoneId") == "A" and not launched_nested_zone:
		launched_nested_zone = true
		executor_ref.call("execute_batch_in_zone_context", [{"type": "captureZone", "params": {"delay": 0.001}}], {"zoneId": "B"})
	await get_tree().create_timer(float(params.get("delay", 0.0))).timeout
	contexts.push_back(str(zone.get("zoneId", "")) if zone is Dictionary else "")


func _capture_debug_params(params: Dictionary) -> void:
	debug_params_capture = params
