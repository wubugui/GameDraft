extends SceneTree

class QuestStub:
	extends RefCounted
	var calls := 0
	func get_status(id: String) -> int:
		calls += 1
		return {"inactive": 0, "active": 1, "done": 2}.get(id, 0)

class ScenarioStub:
	extends RefCounted
	var phase_status_calls := 0
	var phase_read_calls := 0
	func phase_status_equals(scenario: String, phase: String, status: String) -> bool:
		phase_status_calls += 1
		return scenario == "s" and phase == "p" and status == "done"
	func get_scenario_phase(scenario: String, phase: String) -> Dictionary:
		phase_read_calls += 1
		return {"status": "done", "outcome": "good"} if scenario == "s" and phase == "p" else {}
	func get_line_lifecycle_state(id: String) -> String:
		return "completed" if id == "line" else "inactive"

class NarrativeStub:
	extends RefCounted
	var reached := true
	var classification := "ok"
	var classification_calls := 0
	func get_active_state(graph: String) -> Variant:
		return {
			"flow": "ready",
			"owner_graph": "owner_ready",
			"scene_graph": "scene_ready",
		}.get(graph)
	func is_state_active(graph: String, state: String) -> bool:
		return get_active_state(graph) == state
	func has_reached_state(graph: String, state: String) -> bool:
		return reached and graph == "flow" and state == "past"
	func get_primary_graph_by_owner(type: String, id: String) -> Dictionary:
		if type == "npc" and id == "npc": return {"id": "owner_graph"}
		if type == "scene" and id == "scene": return {"id": "scene_graph"}
		return {}
	func classify_state_ref(_graph: String, _state: String) -> String:
		classification_calls += 1
		return classification


func _init() -> void:
	var bus := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(bus)
	flags.set_value("x", 5.0)
	flags.set_value("text", "yes")
	var quests := QuestStub.new()
	var scenarios := ScenarioStub.new()
	var narrative := NarrativeStub.new()
	var context := {
		"flagStore": flags,
		"questManager": quests,
		"scenarioState": scenarios,
		"narrativeState": narrative,
		"resolveConditionLiteral": func(raw: String) -> String: return "5" if raw == "[five]" else raw,
		"currentOwner": {"ownerType": "npc", "ownerId": "npc"},
		"currentSceneId": "scene",
		"getActivePlaneId": func() -> String: return "背尸",
	}

	# evaluateConditionExpr: source branch order and short-circuit behavior.
	assert(RuntimeConditionEvaluator.evaluate({"all": [{"flag": "x", "value": 5.0}, {"not": {"flag": "x", "value": 4.0}}]}, context))
	assert(RuntimeConditionEvaluator.evaluate({"any": [{"flag": "x", "value": 0.0}, {"flag": "text", "value": "yes"}]}, context))
	assert(RuntimeConditionEvaluator.evaluate({"all": []}, context))
	assert(not RuntimeConditionEvaluator.evaluate({"any": []}, context))
	assert(RuntimeConditionEvaluator.evaluate({"flag": "x", "value": "[five]"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"quest": "active", "questStatus": "Active"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"quest": "done", "status": "Completed"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"quest": "done", "questStatus": null, "status": "Completed"}, context))
	assert(not RuntimeConditionEvaluator.evaluate({"quest": "done", "status": "completed"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"scenario": "s", "phase": "p", "status": "done", "outcome": "good"}, context))
	assert(not RuntimeConditionEvaluator.evaluate({"scenario": "s", "phase": "p", "status": "done", "outcome": true}, context))
	assert(RuntimeConditionEvaluator.evaluate({"scenarioLine": "line", "lineStatus": "completed"}, context))
	assert(not RuntimeConditionEvaluator.evaluate({"scenarioLine": "line", "lineStatus": "done"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"narrative": "flow", "state": "ready"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"narrative": "flow", "state": "past", "reached": true}, context))
	assert(RuntimeConditionEvaluator.evaluate({"narrative": "@owner", "state": "owner_ready"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"narrative": "@scene", "state": "scene_ready"}, context))
	assert(not RuntimeConditionEvaluator.evaluate({"narrative": "@missing", "state": "ready"}, context))
	var classification_calls_before_dangling := narrative.classification_calls
	narrative.classification = "unavailable"
	assert(not RuntimeConditionEvaluator.evaluate({"narrative": "dangling", "state": "lost"}, context))
	assert(narrative.classification_calls == classification_calls_before_dangling + 1)
	narrative.classification = "missingGraph"
	assert(not RuntimeConditionEvaluator.evaluate({"narrative": "dangling", "state": "lost"}, context))
	assert(narrative.classification_calls == classification_calls_before_dangling + 2)
	assert(not RuntimeConditionEvaluator.evaluate({"narrative": "dangling", "state": "lost"}, context))
	assert(narrative.classification_calls == classification_calls_before_dangling + 2)
	assert(RuntimeConditionEvaluator.evaluate({"plane": "背尸"}, context))
	var default_plane_context := context.duplicate(false)
	default_plane_context.erase("getActivePlaneId")
	assert(RuntimeConditionEvaluator.evaluate({"plane": "normal"}, default_plane_context))
	assert(not RuntimeConditionEvaluator.evaluate({"plane": ""}, context))

	# Non-trace all/any and the list bridge short-circuit exactly like every/some/for-of.
	scenarios.phase_status_calls = 0
	assert(not RuntimeConditionEvaluator.evaluate({"all": [
		{"flag": "x", "value": 0.0},
		{"scenario": "s", "phase": "p", "status": "done"},
	]}, context))
	assert(scenarios.phase_status_calls == 0)
	assert(not RuntimeConditionEvalBridge.evaluate_condition_expr_list([
		{"flag": "x", "value": 0.0},
		{"scenario": "s", "phase": "p", "status": "done"},
	], context))
	assert(scenarios.phase_status_calls == 0)
	assert(RuntimeConditionEvalBridge.evaluate_condition_expr_list(null, context))
	assert(RuntimeConditionEvalBridge.evaluate_condition_expr_list([], context))
	assert(not RuntimeConditionEvalBridge.evaluate_condition_expr_list({"flag": "x"}, context))

	# Trace all/any deliberately evaluates every child so the debug tree is complete.
	scenarios.phase_status_calls = 0
	var complete_trace := RuntimeConditionEvaluator.evaluate_with_trace({"all": [
		{"flag": "x", "value": 0.0},
		{"scenario": "s", "phase": "p", "status": "done"},
	]}, context)
	assert(not complete_trace.result)
	assert(scenarios.phase_status_calls == 1)

	var traced := RuntimeConditionEvaluator.evaluate_with_trace({"all": [
		{"plane": "背尸"},
		{"quest": "active", "status": "Active"},
	]}, context)
	assert(traced.result == RuntimeConditionEvaluator.evaluate({"all": [
		{"plane": "背尸"},
		{"quest": "active", "status": "Active"},
	]}, context))
	assert(RuntimeConditionEvaluator.format_trace(traced.trace) == "[all] => true\n  plane 期望=背尸实际=背尸 => true\n  quest「active」：期望 Active，实际 Active => true")

	# evaluatePreconditionsWithTrace preserves the source's empty/single/multi topology.
	var empty_preconditions := RuntimeConditionEvaluator.evaluate_preconditions_with_trace([], context)
	assert(empty_preconditions == {"result": true, "trace": {"kind": "all", "result": true, "items": []}})
	var single_precondition := RuntimeConditionEvaluator.evaluate_preconditions_with_trace([{"plane": "背尸"}], context)
	assert(single_precondition.trace.kind == "plane")
	var multi_preconditions := RuntimeConditionEvaluator.evaluate_preconditions_with_trace([{"plane": "背尸"}, {"flag": "x", "value": 5.0}], context)
	assert(multi_preconditions.trace.kind == "all" and multi_preconditions.trace.items.size() == 2)

	# depth=32 is accepted; depth=33 fails closed in both evaluator variants.
	var at_limit: Variant = {"flag": "x", "value": 5.0}
	for _index: int in range(RuntimeConditionEvaluator.MAX_CONDITION_DEPTH):
		at_limit = {"all": [at_limit]}
	assert(RuntimeConditionEvaluator.evaluate(at_limit, context))
	var over_limit: Variant = {"all": [at_limit]}
	assert(not RuntimeConditionEvaluator.evaluate(over_limit, context))
	assert(not RuntimeConditionEvaluator.evaluate_with_trace(over_limit, context).result)

	assert(not RuntimeConditionEvaluator.evaluate({"mystery": true}, context))
	flags.destroy()
	print("ConditionEvaluator module-function/order/short-circuit/trace direct-translation test: PASS")
	quit(0)
