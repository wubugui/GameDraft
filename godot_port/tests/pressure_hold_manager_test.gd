extends Node


class AssetManagerStub extends RuntimeAssetManager:
	var responses: Array = []
	var load_count := 0

	func load_json(_path: String) -> Variant:
		var response: Variant = responses[load_count] if load_count < responses.size() else null
		load_count += 1
		return response


var manager: RuntimePressureHoldManager
var segments: Array[Dictionary] = []
var outcomes: Array[Variant] = []


func _ready() -> void:
	await _run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var real_assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var events := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(events)
	var actions := RuntimeActionExecutor.new(events, flags)
	actions.register("reject", Callable(self, "_reject"), [])
	manager = RuntimePressureHoldManager.new(actions)
	add_child(manager)
	manager.init({"assetManager": real_assets})
	var runtime_binding := {
		"runSegment": Callable(self, "_run_segment"),
		"resolveDisplayText": func(raw: String) -> String: return "resolved:%s" % raw,
	}
	manager.bind_runtime(runtime_binding)
	assert(is_same(manager.binding, runtime_binding))

	await manager.load_defs()
	assert(manager.defs.size() == 12 and manager.defs.has("carry_ordinary_corpse"))
	assert(RuntimePressureHoldManager.parse_hex_color("#6e1f1f") == 0x6e1f1f)
	assert(RuntimePressureHoldManager.parse_hex_color("6e1f1f") == null and RuntimePressureHoldManager.parse_hex_color("#fff") == null)
	assert(not manager._validate_def({"id": "bad", "prompt": "p", "fillSeconds": 0}))
	assert(not manager._validate_def({"id": "bad_release", "prompt": "p", "fillSeconds": 1, "abortOnReleaseFromRatio": 1}))
	assert(not manager._validate_def({"id": "bad_reset", "prompt": "p", "fillSeconds": 1, "interrupts": [{"atRatio": 0.5, "resetToRatio": 1}]}))
	assert(not manager._validate_def({"id": "bad_interrupt_shape", "prompt": "p", "fillSeconds": 1, "interrupts": {"atRatio": 0.5}}))
	assert(manager._validate_def({"id": "hex_fill", "prompt": "p", "fillSeconds": "0x2"}))

	# loadDefs keeps prior definitions, the untrimmed Map key, and the exact
	# definition object. Invalid entries are skipped individually; a failed later
	# load does not clear previously loaded definitions.
	var first_definition := {"id": " first ", "prompt": "p", "fillSeconds": 1.0}
	var second_definition := {"id": "second", "prompt": "p", "fillSeconds": 1.0}
	var stub_assets := AssetManagerStub.new()
	stub_assets.responses = [
		[first_definition, null, {"id": "", "prompt": "p", "fillSeconds": 1.0}, {"id": "wrong_interrupts", "prompt": "p", "fillSeconds": 1.0, "interrupts": {}}],
		[second_definition],
		null,
	]
	manager.init({"assetManager": stub_assets})
	await manager.load_defs()
	assert(manager.defs.has(" first ") and not manager.defs.has("first"))
	assert(is_same(manager.defs[" first "], first_definition))
	first_definition.note = "same-object"
	assert(manager.defs[" first "].note == "same-object")
	await manager.load_defs()
	assert(manager.defs.has("carry_ordinary_corpse") and manager.defs.has(" first ") and manager.defs.has("second"))
	await manager.load_defs()
	assert(manager.defs.has("second"))

	var reset_probe := {
		"id": "reset_probe", "prompt": "[tag]", "fillSeconds": 2.0, "barColor": "#112233",
		"interrupts": [{"atRatio": 0.5, "resetToRatio": 0.2, "actions": [{"type": "setFlag", "params": {"key": "pressure_mid", "value": true}}]}],
		"onComplete": [{"type": "setFlag", "params": {"key": "pressure_done", "value": true}}],
	}
	assert(manager._validate_def(reset_probe)); manager.defs[reset_probe.id] = reset_probe
	var preview: Dictionary = manager.get_debug_preview_request("reset_probe")
	assert(preview.prompt == "resolved:[tag]" and preview.stopRatio == 0.5 and preview.barColor == 0x112233)
	assert(not preview.has("releaseHint") and not preview.has("abortOnReleaseFromRatio"))
	segments.clear(); outcomes = ["reached", "reached"]
	assert(await manager.run_until_done("reset_probe") == "completed")
	assert(segments.size() == 2 and segments[0].startRatio == 0.0 and segments[0].stopRatio == 0.5 and segments[1].startRatio == 0.2 and segments[1].stopRatio == 1.0)
	assert(segments[0].prompt == "resolved:[tag]" and segments[0].barColor == 0x112233)
	assert(segments[0].has("releaseHint") and segments[0].releaseHint == null)
	assert(segments[0].has("abortOnReleaseFromRatio") and segments[0].abortOnReleaseFromRatio == null)
	assert(flags.get_value("pressure_mid") == true and flags.get_value("pressure_done") == true)

	var release_probe := {
		"id": "release_probe", "prompt": "p", "fillSeconds": 1.0, "abortOnReleaseFromRatio": 0.72,
		"interrupts": [{"atRatio": 0.45, "resetToRatio": 0.38, "actions": [{"type": "setFlag", "params": {"key": "pressure_beat", "value": true}}]}],
		"onComplete": [{"type": "setFlag", "params": {"key": "pressure_held", "value": true}}],
		"onAborted": [{"type": "setFlag", "params": {"key": "pressure_aborted", "value": true}}],
	}
	assert(manager._validate_def(release_probe)); manager.defs[release_probe.id] = release_probe
	segments.clear(); outcomes = ["reached", "released"]
	assert(await manager.run_until_done("release_probe") == "aborted")
	assert(segments.size() == 2 and segments[0].abortOnReleaseFromRatio == 0.72 and segments[1].abortOnReleaseFromRatio == 0.72)
	assert(flags.get_value("pressure_beat") == true and flags.get_value("pressure_aborted") == true and flags.get_value("pressure_held") == null)

	var interrupt_abort := {
		"id": "interrupt_abort", "prompt": "p", "fillSeconds": 1.0,
		"interrupts": [{"atRatio": 0.8, "abort": true, "actions": [{"type": "setFlag", "params": {"key": "pressure_interrupt_abort", "value": true}}]}],
		"onComplete": [{"type": "setFlag", "params": {"key": "pressure_should_not_complete", "value": true}}],
	}
	assert(manager._validate_def(interrupt_abort)); manager.defs[interrupt_abort.id] = interrupt_abort
	segments.clear(); outcomes = ["reached"]
	assert(await manager.run_until_done("interrupt_abort") == "aborted")
	assert(flags.get_value("pressure_interrupt_abort") == true and flags.get_value("pressure_should_not_complete") == null)

	# `false` is the engine translation of a rejected runSegment/action Promise.
	# Both paths must propagate the rejection and release the source `finally` guard.
	manager.defs.segment_reject = {"id": "segment_reject", "prompt": "p", "fillSeconds": 1.0}
	segments.clear(); outcomes = [false]
	assert(await manager.run_until_done("segment_reject") == false and not manager.running)
	manager.defs.action_reject = {"id": "action_reject", "prompt": "p", "fillSeconds": 1.0, "onComplete": [{"type": "reject", "params": {}}]}
	segments.clear(); outcomes = ["reached"]
	assert(await manager.run_until_done("action_reject") == false and not manager.running)

	assert(await manager.run_until_done("unknown") == "completed")
	manager.binding = null
	assert(await manager.run_until_done("reset_probe") == "completed")
	manager.binding = runtime_binding
	manager.running = true
	assert(await manager.run_until_done("reset_probe") == "completed")
	var defs_before_deserialize := manager.defs.size()
	manager.deserialize({"running": false})
	assert(manager.running and manager.defs.size() == defs_before_deserialize and is_same(manager.binding, runtime_binding))
	manager.running = false

	var owned_assets := manager.asset_manager
	manager.destroy()
	assert(manager.defs.is_empty() and manager.binding == null and not manager.running and manager.asset_manager == owned_assets)
	remove_child(manager); manager.free()
	actions.destroy(); flags.destroy(); events.clear(); real_assets.dispose(); stub_assets.dispose()
	print("PressureHoldManager field/load/request/flow/finally direct-translation test: PASS")
	get_tree().quit(0)


func _run_segment(request: Dictionary) -> Variant:
	segments.push_back(request.duplicate(true))
	await get_tree().process_frame
	return outcomes.pop_front() if not outcomes.is_empty() else "reached"


func _reject(_params: Dictionary, _zone_context: Variant) -> bool:
	return false
