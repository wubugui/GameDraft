extends Node

var narrative: RuntimeNarrativeStateManager
var observed := ""


func _ready() -> void:
	var bus := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(bus)
	var executor := RuntimeActionExecutor.new(bus, flags)
	narrative = RuntimeNarrativeStateManager.new(bus, flags, executor)
	assert(narrative._is_dev_runtime() == false)
	assert(narrative._default_runtime_validation_mode() == "off")
	narrative.set_condition_eval_context_factory(func() -> Dictionary:
		return {"flagStore": flags, "narrativeState": narrative}
	)
	executor.register("queueSetC", Callable(self, "_queue_set_c"), [])
	executor.register("rejectAction", func(_params: Dictionary, _zone: Variant) -> bool: return false, [])

	narrative.register_graphs([{
		"id": "g", "ownerType": "flow", "initialState": "a",
		"states": {
			"a": {"id": "a"},
			"b": {"id": "b", "onEnterActions": [{"type": "queueSetC", "params": {}}]},
			"c": {"id": "c"},
		},
		"transitions": [{"id": "go", "from": "a", "to": "b", "signal": "go"}],
	}])
	await narrative.emit_narrative_signal({"sourceType": "system", "sourceId": "test", "signal": "go"})
	assert(observed == "c")
	assert(narrative.get_active_state("g") == "c")
	var trace_types: Array = narrative.debug_snapshot().recentTrace.map(func(event: Dictionary) -> Variant: return event.type)
	assert(trace_types.has("trigger.enqueued") and trace_types.has("transition.applied") and trace_types.has("actions.start"))
	narrative.clear_debug_trace()
	assert(narrative.debug_snapshot().traceLength == 0)

	narrative.register_graphs([{
		"id": "failure", "ownerType": "flow", "initialState": "a",
		"states": {"a": {"id": "a"}, "b": {"id": "b", "onEnterActions": [{"type": "rejectAction", "params": {}}]}},
		"transitions": [{"id": "go", "from": "a", "to": "b", "signal": "fail"}],
	}])
	await narrative.emit_narrative_signal({"sourceType": "system", "sourceId": "test", "signal": "fail"})
	assert(narrative.get_active_state("failure") == "b")
	assert(narrative.debug_snapshot().recentTrace.any(func(event: Dictionary) -> bool: return event.type == "actions.failed"))

	var invalid_data := {
		"signals": [{"id": "go"}],
		"compositions": [{"id": "comp", "mainGraph": {
			"id": "flow", "ownerType": "flow", "initialState": "a",
			"states": {"a": {"id": "a"}, "b": {"id": "b"}},
			"transitions": [{"id": "bad", "from": "a", "to": "missing", "signal": "go"}],
		}, "elements": []}],
	}
	narrative.set_runtime_validation_mode("throw")
	assert(not narrative._validate_loaded_data(invalid_data, "fixture"))
	assert(narrative.debug_snapshot().recentIssues.any(func(issue: Dictionary) -> bool: return issue.code == "transition.to.missing"))

	var off := RuntimeNarrativeStateManager.new(bus, flags, executor)
	off.set_runtime_validation_mode("off")
	assert(off._validate_loaded_data(invalid_data, "fixture"))
	assert(not off.debug_snapshot().recentIssues.any(func(issue: Dictionary) -> bool: return issue.code == "transition.to.missing"))

	off.destroy(); off.free()
	narrative.destroy(); narrative.free()
	executor.destroy(); flags.destroy(); bus.clear()
	print("NarrativeStateManager direct architecture/async/validation test: PASS")
	get_tree().quit(0)


func _queue_set_c(_params: Dictionary, _zone: Variant) -> void:
	await narrative.debug_set_narrative_state("g", "c")
	observed = str(narrative.get_active_state("g"))
