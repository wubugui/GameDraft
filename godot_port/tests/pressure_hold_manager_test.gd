extends Node

var manager: RuntimePressureHoldManager
var segments: Array[Dictionary] = []
var outcomes: Array[String] = []


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var events := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(events)
	var actions := RuntimeActionExecutor.new(events, flags)
	manager = RuntimePressureHoldManager.new(actions)
	add_child(manager)
	manager.init({"assetManager": assets})
	manager.bind_runtime({"runSegment": Callable(self, "_run_segment"), "resolveDisplayText": func(raw: String) -> String: return "resolved:%s" % raw})
	assert(manager.load_defs() and manager.get_def_count() == 8 and manager.has_def("carry_ordinary_corpse"))
	assert(RuntimePressureHoldManager.parse_hex_color("#6e1f1f") == 0x6e1f1f)
	assert(RuntimePressureHoldManager.parse_hex_color("6e1f1f") == null and RuntimePressureHoldManager.parse_hex_color("#fff") == null)
	assert(not manager.register_def_for_test({"id": "bad", "prompt": "p", "fillSeconds": 0}))
	assert(not manager.register_def_for_test({"id": "bad_release", "prompt": "p", "fillSeconds": 1, "abortOnReleaseFromRatio": 1}))
	assert(not manager.register_def_for_test({"id": "bad_reset", "prompt": "p", "fillSeconds": 1, "interrupts": [{"atRatio": 0.5, "resetToRatio": 1}]}))
	assert(manager.register_def_for_test({
		"id": "reset_probe", "prompt": "[tag]", "fillSeconds": 2.0, "barColor": "#112233",
		"interrupts": [{"atRatio": 0.5, "resetToRatio": 0.2, "actions": [{"type": "setFlag", "params": {"key": "pressure_mid", "value": true}}]}],
		"onComplete": [{"type": "setFlag", "params": {"key": "pressure_done", "value": true}}],
	}))
	segments.clear(); outcomes = ["reached", "reached"]
	assert(await manager.run_until_done("reset_probe") == "completed")
	assert(segments.size() == 2 and segments[0].startRatio == 0.0 and segments[0].stopRatio == 0.5 and segments[1].startRatio == 0.2 and segments[1].stopRatio == 1.0)
	assert(segments[0].prompt == "resolved:[tag]" and segments[0].barColor == 0x112233)
	assert(flags.get_value("pressure_mid") == true and flags.get_value("pressure_done") == true)
	assert(manager.register_def_for_test({
		"id": "release_probe", "prompt": "p", "fillSeconds": 1.0, "abortOnReleaseFromRatio": 0.72,
		"interrupts": [{"atRatio": 0.45, "resetToRatio": 0.38, "actions": [{"type": "setFlag", "params": {"key": "pressure_beat", "value": true}}]}],
		"onComplete": [{"type": "setFlag", "params": {"key": "pressure_held", "value": true}}],
		"onAborted": [{"type": "setFlag", "params": {"key": "pressure_aborted", "value": true}}],
	}))
	segments.clear(); outcomes = ["reached", "released"]
	assert(await manager.run_until_done("release_probe") == "aborted")
	assert(segments.size() == 2 and segments[0].abortOnReleaseFromRatio == 0.72 and segments[1].abortOnReleaseFromRatio == 0.72)
	assert(flags.get_value("pressure_beat") == true and flags.get_value("pressure_aborted") == true and flags.get_value("pressure_held") == null)
	assert(manager.register_def_for_test({
		"id": "interrupt_abort", "prompt": "p", "fillSeconds": 1.0,
		"interrupts": [{"atRatio": 0.8, "abort": true, "actions": [{"type": "setFlag", "params": {"key": "pressure_interrupt_abort", "value": true}}]}],
		"onComplete": [{"type": "setFlag", "params": {"key": "pressure_should_not_complete", "value": true}}],
	}))
	segments.clear(); outcomes = ["reached"]
	assert(await manager.run_until_done("interrupt_abort") == "aborted")
	assert(flags.get_value("pressure_interrupt_abort") == true and flags.get_value("pressure_should_not_complete") == null)
	assert(await manager.run_until_done("unknown") == "completed")
	manager.destroy(); remove_child(manager); manager.free(); actions.destroy(); flags.destroy(); assets.dispose()
	print("PressureHoldManager 8-def/interrupt/reset/release/action contract test: PASS")
	get_tree().quit(0)


func _run_segment(request: Dictionary) -> String:
	segments.push_back(request.duplicate(true))
	await get_tree().process_frame
	return outcomes.pop_front() if not outcomes.is_empty() else "reached"
