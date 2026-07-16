extends Node

var flags: RuntimeFlagStore


func _ready() -> void:
	await _run()


func _run() -> void:
	var bus := RuntimeEventBus.new()
	flags = RuntimeFlagStore.new(bus)
	var executor := RuntimeActionExecutor.new(bus, flags)
	var narrative := RuntimeNarrativeStateManager.new(bus, flags, executor)
	narrative.init({"eventBus": bus, "flagStore": flags, "strings": null, "assetManager": null})
	narrative.set_condition_eval_context_factory(func() -> Dictionary:
		return {"flagStore": flags, "narrativeState": narrative}
	)
	narrative.register_graphs([
		_graph("plain", [{"id": "plain_go", "from": "a", "to": "b", "trigger": "reactive", "conditions": [{"flag": "r_plain"}]}]),
		_graph("all", [{"id": "all_go", "from": "a", "to": "b", "trigger": "reactiveAll", "conditions": [{"flag": "r_all_1"}, {"flag": "r_all_2"}]}]),
		_graph("any", [{"id": "any_go", "from": "a", "to": "b", "trigger": "reactiveAny", "conditions": [{"flag": "r_any_1"}, {"flag": "r_any_2"}]}]),
		_graph("priority", [
			{"id": "low", "from": "a", "to": "b", "trigger": "reactive", "priority": 1, "conditions": [{"flag": "r_priority"}]},
			{"id": "high", "from": "a", "to": "c", "trigger": "reactive", "priority": 9, "conditions": [{"flag": "r_priority"}]},
		]),
		_graph("empty", [{"id": "never", "from": "a", "to": "b", "trigger": "reactive", "conditions": []}]),
		{"id": "after_signal", "ownerType": "flow", "initialState": "a", "states": {"a": {"id": "a"}, "b": {"id": "b"}, "c": {"id": "c"}}, "transitions": [
			{"id": "signal", "from": "a", "to": "b", "signal": "go"},
			{"id": "react", "from": "b", "to": "c", "trigger": "reactive", "conditions": [{"flag": "r_after"}]},
		]},
	])
	for key in ["r_plain", "r_all_1", "r_all_2", "r_any_2", "r_priority"]:
		flags.set_value(key, true)
	await get_tree().process_frame
	await get_tree().process_frame
	assert(narrative.get_active_state("plain") == "b")
	assert(narrative.get_active_state("all") == "b")
	assert(narrative.get_active_state("any") == "b")
	assert(narrative.get_active_state("priority") == "c")
	assert(narrative.get_active_state("empty") == "a")

	flags.set_value("r_after", true)
	await get_tree().process_frame
	await narrative.emit_narrative_signal({"signal": "go"})
	assert(narrative.get_active_state("after_signal") == "c")

	# An oscillating reactive graph is stopped by the same 128-step fail-loud guard.
	flags.set_value("r_loop", true)
	narrative.register_graphs([{"id": "loop", "ownerType": "flow", "initialState": "a", "states": {"a": {"id": "a"}, "b": {"id": "b"}}, "transitions": [
		{"id": "ab", "from": "a", "to": "b", "trigger": "reactive", "conditions": [{"flag": "r_loop"}]},
		{"id": "ba", "from": "b", "to": "a", "trigger": "reactive", "conditions": [{"flag": "r_loop"}]},
	]}])
	await get_tree().process_frame
	await get_tree().process_frame
	assert(narrative.debug_snapshot().recentIssues.any(func(issue: Dictionary) -> bool: return issue.code == "drain.loop.guard"))
	assert(narrative.debug_snapshot().queued == 0)

	narrative.destroy(); narrative.free()
	executor.destroy(); flags.destroy(); bus.clear()
	print("Narrative reactive contract test: PASS")
	get_tree().quit(0)


func _graph(id: String, transitions: Array) -> Dictionary:
	return {"id": id, "ownerType": "flow", "initialState": "a", "states": {"a": {"id": "a"}, "b": {"id": "b"}, "c": {"id": "c"}}, "transitions": transitions}
