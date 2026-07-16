extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")

var bootstrap_under_test: Node
var saw_overlay := false


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new()
	bootstrap_under_test = bootstrap
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	while not bootstrap.runtime_ready:
		await get_tree().process_frame
	assert(bootstrap.pressure_hold_manager.defs.size() == 12)
	var probe_definition := {
		"id": "godot_integration_probe", "prompt": "[tag:string:pressureHold:holdHint]", "fillSeconds": 1.0,
		"interrupts": [{"atRatio": 0.4, "resetToRatio": 0.25, "actions": [{"type": "setFlag", "params": {"key": "pressure_integration_mid", "value": true}}]}],
		"onComplete": [{"type": "setFlag", "params": {"key": "pressure_integration_done", "value": true}}],
	}
	assert(bootstrap.pressure_hold_manager._validate_def(probe_definition))
	bootstrap.pressure_hold_manager.defs[probe_definition.id] = probe_definition
	bootstrap.pressure_hold_ui.set_debug_input(true, 0.25)
	get_tree().process_frame.connect(Callable(self, "_capture_overlay_and_drive"), CONNECT_ONE_SHOT)
	await bootstrap.action_executor.execute_await({"type": "startPressureHold", "params": {"id": "godot_integration_probe"}})
	assert(saw_overlay and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)
	assert(bootstrap.flag_store.get_value("pressure_integration_mid") == true and bootstrap.flag_store.get_value("pressure_integration_done") == true)
	assert(bootstrap.pressure_hold_ui.get_root() == null and bootstrap.action_executor.has_handler("startPressureHold"))
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame
	remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout
	print("PressureHold Action/UIOverlay/JSON/state direct-translation integration test: PASS")
	get_tree().quit(0)


func _capture_overlay_and_drive() -> void:
	saw_overlay = bootstrap_under_test.state_controller.current_state == RuntimeDataTypes.UI_OVERLAY and bootstrap_under_test.pressure_hold_ui.get_root() != null
	_drive_segment_edges()


func _drive_segment_edges() -> void:
	var handled_serial := -1
	for _index: int in 120:
		var ui: RuntimePressureHoldUI = bootstrap_under_test.pressure_hold_ui
		if ui.get_root() != null and ui._active_serial != handled_serial:
			handled_serial = ui._active_serial
			ui.set_debug_input(false, 0.25)
			await get_tree().process_frame
			ui.set_debug_input(true, 0.25)
		if not bootstrap_under_test.pressure_hold_manager.running: return
		await get_tree().process_frame
