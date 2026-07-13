extends SceneTree

class QuestStub:
	extends RefCounted
	func get_status(id: String) -> int: return {"inactive": 0, "active": 1, "done": 2}.get(id, 0)

class ScenarioStub:
	extends RefCounted
	func phase_status_equals(scenario: String, phase: String, status: String) -> bool: return scenario == "s" and phase == "p" and status == "done"
	func get_scenario_phase(scenario: String, phase: String) -> Dictionary: return {"status": "done", "outcome": "good"} if scenario == "s" and phase == "p" else {}
	func get_line_lifecycle_state(id: String) -> String: return "completed" if id == "line" else "inactive"

class NarrativeStub:
	extends RefCounted
	var reached := true
	func is_state_active(graph: String, state: String) -> bool: return (graph == "flow" and state == "ready") or (graph == "owner_graph" and state == "owner_ready") or (graph == "scene_graph" and state == "scene_ready")
	func has_reached_state(graph: String, state: String) -> bool: return reached and graph == "flow" and state == "past"
	func get_primary_graph_by_owner(type: String, id: String) -> Dictionary:
		if type == "npc" and id == "npc": return {"id": "owner_graph"}
		if type == "scene" and id == "scene": return {"id": "scene_graph"}
		return {}


func _init() -> void:
	var bus := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(bus)
	flags.set_value("x", 5.0)
	flags.set_value("text", "yes")
	var narrative := NarrativeStub.new()
	var context := {
		"flagStore": flags,
		"questManager": QuestStub.new(),
		"scenarioState": ScenarioStub.new(),
		"narrativeState": narrative,
		"resolveConditionLiteral": func(raw: String) -> String: return "5" if raw == "[five]" else raw,
		"currentOwner": {"ownerType": "npc", "ownerId": "npc"},
		"currentSceneId": "scene",
		"getActivePlaneId": func() -> String: return "背尸",
	}
	var evaluator := RuntimeConditionEvaluator.new()
	assert(evaluator.evaluate({"all": [{"flag": "x", "value": 5.0}, {"not": {"flag": "x", "value": 4.0}}]}, context))
	assert(evaluator.evaluate({"any": [{"flag": "x", "value": 0.0}, {"flag": "text", "value": "yes"}]}, context))
	assert(evaluator.evaluate({"all": []}, context))
	assert(not evaluator.evaluate({"any": []}, context))
	assert(evaluator.evaluate({"not": []}, context))
	assert(evaluator.evaluate({"flag": "x", "value": "[five]"}, context))
	assert(evaluator.evaluate({"quest": "active", "questStatus": "Active"}, context))
	assert(evaluator.evaluate({"quest": "done", "status": "Completed"}, context))
	assert(not evaluator.evaluate({"quest": "done", "status": "completed"}, context))
	assert(evaluator.evaluate({"scenario": "s", "phase": "p", "status": "done", "outcome": "good"}, context))
	assert(not evaluator.evaluate({"scenario": "s", "phase": "p", "status": "done", "outcome": true}, context))
	assert(evaluator.evaluate({"scenarioLine": "line", "lineStatus": "completed"}, context))
	assert(not evaluator.evaluate({"scenarioLine": "line", "lineStatus": "done"}, context))
	assert(evaluator.evaluate({"narrative": "flow", "state": "ready"}, context))
	assert(evaluator.evaluate({"narrative": "flow", "state": "past", "reached": true}, context))
	assert(evaluator.evaluate({"narrative": "@owner", "state": "owner_ready"}, context))
	assert(evaluator.evaluate({"narrative": "@scene", "state": "scene_ready"}, context))
	assert(not evaluator.evaluate({"narrative": "@missing", "state": "ready"}, context))
	assert(evaluator.evaluate({"plane": "背尸"}, context))
	var default_plane_context := context.duplicate()
	default_plane_context.erase("getActivePlaneId")
	assert(evaluator.evaluate({"plane": "normal"}, default_plane_context))
	assert(not evaluator.evaluate({"plane": ""}, context))
	assert(not evaluator.evaluate({"mystery": true}, context))

	var nested: Dictionary = {"flag": "x", "value": 5.0}
	for _i in 34: nested = {"all": [nested]}
	assert(not evaluator.evaluate(nested, context))
	var traced := evaluator.evaluate_with_trace({"all": [{"plane": "背尸"}, {"quest": "active", "status": "Active"}]}, context)
	assert(traced.result and traced.result == evaluator.evaluate({"all": [{"plane": "背尸"}, {"quest": "active", "status": "Active"}]}, context))
	assert(evaluator.format_trace(traced.trace).contains("[all]"))
	assert(evaluator.evaluate_list([], context))
	assert(not evaluator.evaluate_list([{"flag": "x", "value": 5.0}, {"mystery": true}], context))
	flags.destroy()
	print("ConditionEvaluator 9-node contract test: PASS")
	quit(0)
