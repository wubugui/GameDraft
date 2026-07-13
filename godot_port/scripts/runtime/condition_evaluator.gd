class_name RuntimeConditionEvaluator
extends RefCounted

const MAX_CONDITION_DEPTH := 32
const QUEST_STATUS := {"Inactive": 0, "Active": 1, "Completed": 2}
const SCENARIO_LINE_STATUSES := ["inactive", "active", "completed"]


func evaluate(expr: Variant, context: Dictionary, depth: int = 0) -> bool:
	if depth > MAX_CONDITION_DEPTH or not expr is Dictionary:
		return false
	if expr.get("all") is Array:
		for child: Variant in expr.all:
			if not evaluate(child, context, depth + 1): return false
		return true
	if expr.get("any") is Array:
		for child: Variant in expr.any:
			if evaluate(child, context, depth + 1): return true
		return false
	if expr.has("not") and expr.get("not") != null and (expr.get("not") is Dictionary or expr.get("not") is Array):
		return not evaluate(expr.not, context, depth + 1)
	if _is_scenario_leaf(expr):
		return _eval_scenario(expr, context)
	if _is_scenario_line_leaf(expr):
		return _eval_scenario_line(expr, context)
	if _is_narrative_leaf(expr):
		return _eval_narrative(expr, context)
	if _is_plane_leaf(expr):
		return _eval_plane(expr, context)
	if _is_quest_leaf(expr):
		return _eval_quest(expr, context)
	if _is_flag_leaf(expr):
		return _eval_flag(expr, context)
	return false


func evaluate_list(conditions: Variant, context: Dictionary) -> bool:
	if conditions == null or not conditions is Array or conditions.is_empty():
		return true
	for condition: Variant in conditions:
		if not evaluate(condition, context):
			return false
	return true


func evaluate_with_trace(expr: Variant, context: Dictionary, depth: int = 0) -> Dictionary:
	if depth > MAX_CONDITION_DEPTH or not expr is Dictionary:
		return {"result": false, "trace": {"kind": "unknown", "result": false, "label": "嵌套超过 %s 或形状无效" % MAX_CONDITION_DEPTH}}
	if expr.get("all") is Array:
		var items: Array = []
		var result := true
		for child: Variant in expr.all:
			var child_result := evaluate_with_trace(child, context, depth + 1)
			items.push_back(child_result.trace)
			if not child_result.result: result = false
		return {"result": result, "trace": {"kind": "all", "result": result, "items": items}}
	if expr.get("any") is Array:
		var items: Array = []
		var result := false
		for child: Variant in expr.any:
			var child_result := evaluate_with_trace(child, context, depth + 1)
			items.push_back(child_result.trace)
			if child_result.result: result = true
		return {"result": result, "trace": {"kind": "any", "result": result, "items": items}}
	if expr.has("not") and expr.get("not") != null and (expr.get("not") is Dictionary or expr.get("not") is Array):
		var child_result := evaluate_with_trace(expr.not, context, depth + 1)
		return {"result": not child_result.result, "trace": {"kind": "not", "result": not child_result.result, "inner": child_result.trace}}
	var kind := _leaf_kind(expr)
	var result := evaluate(expr, context, depth)
	return {"result": result, "trace": {"kind": kind, "result": result, "label": JSON.stringify(expr)}}


func evaluate_preconditions_with_trace(conditions: Variant, context: Dictionary) -> Dictionary:
	if conditions == null or not conditions is Array or conditions.is_empty():
		return {"result": true, "trace": {"kind": "all", "result": true, "items": []}}
	if conditions.size() == 1:
		return evaluate_with_trace(conditions[0], context)
	return evaluate_with_trace({"all": conditions}, context)


func format_trace(trace: Dictionary, depth: int = 0) -> String:
	var prefix := "  ".repeat(depth)
	match str(trace.get("kind", "unknown")):
		"all", "any":
			var lines := ["%s[%s] => %s" % [prefix, trace.kind, trace.result]]
			for child: Dictionary in trace.get("items", []): lines.push_back(format_trace(child, depth + 1))
			return "\n".join(lines)
		"not":
			return "%s[not] => %s\n%s" % [prefix, trace.result, format_trace(trace.inner, depth + 1)]
	return "%s%s => %s" % [prefix, trace.get("label", ""), trace.get("result", false)]


func resolve_narrative_graph_ref(token: String, context: Dictionary) -> String:
	var raw := token.strip_edges()
	if not raw.begins_with("@"):
		return raw
	var narrative: Variant = context.get("narrativeState")
	if narrative == null or not narrative.has_method("get_primary_graph_by_owner"):
		return ""
	if raw == "@owner":
		var owner: Variant = context.get("currentOwner")
		if not owner is Dictionary or str(owner.get("ownerType", "")).is_empty() or str(owner.get("ownerId", "")).is_empty():
			return ""
		var graph: Variant = narrative.call("get_primary_graph_by_owner", owner.ownerType, owner.ownerId)
		return str(graph.get("id", "")) if graph is Dictionary else ""
	if raw == "@scene":
		var scene_id := str(context.get("currentSceneId", "")).strip_edges()
		if scene_id.is_empty(): return ""
		var graph: Variant = narrative.call("get_primary_graph_by_owner", "scene", scene_id)
		return str(graph.get("id", "")) if graph is Dictionary else ""
	return ""


func _eval_scenario(expr: Dictionary, context: Dictionary) -> bool:
	var scenario: Variant = context.get("scenarioState")
	if scenario == null or not scenario.has_method("phase_status_equals") or not scenario.call("phase_status_equals", expr.scenario, expr.phase, expr.status):
		return false
	if expr.has("outcome") and expr.outcome != null:
		var phase: Variant = scenario.call("get_scenario_phase", expr.scenario, expr.phase)
		return phase is Dictionary and phase.has("outcome") and _strict_equal(phase.outcome, expr.outcome)
	return true


func _eval_scenario_line(expr: Dictionary, context: Dictionary) -> bool:
	var id := str(expr.scenarioLine).strip_edges()
	var scenario: Variant = context.get("scenarioState")
	return not id.is_empty() and scenario != null and scenario.has_method("get_line_lifecycle_state") and scenario.call("get_line_lifecycle_state", id) == expr.lineStatus


func _eval_narrative(expr: Dictionary, context: Dictionary) -> bool:
	var graph_id := resolve_narrative_graph_ref(str(expr.narrative), context)
	var state_id := str(expr.state).strip_edges()
	var narrative: Variant = context.get("narrativeState")
	if graph_id.is_empty() or state_id.is_empty() or narrative == null:
		return false
	if expr.get("reached", false) == true and narrative.has_method("has_reached_state"):
		return bool(narrative.call("has_reached_state", graph_id, state_id))
	return narrative.has_method("is_state_active") and bool(narrative.call("is_state_active", graph_id, state_id))


func _eval_plane(expr: Dictionary, context: Dictionary) -> bool:
	var wanted := str(expr.plane).strip_edges()
	if wanted.is_empty(): return false
	var provider: Variant = context.get("getActivePlaneId")
	var active := str(provider.call()) if provider is Callable and provider.is_valid() else "normal"
	return active == wanted


func _eval_quest(expr: Dictionary, context: Dictionary) -> bool:
	var raw_status: Variant = expr.get("questStatus", expr.get("status"))
	if not raw_status is String or not QUEST_STATUS.has(raw_status):
		return false
	var manager: Variant = context.get("questManager")
	return manager != null and manager.has_method("get_status") and int(manager.call("get_status", expr.quest)) == int(QUEST_STATUS[raw_status])


func _eval_flag(expr: Dictionary, context: Dictionary) -> bool:
	var condition := expr.duplicate(true)
	var resolver: Variant = context.get("resolveConditionLiteral")
	if condition.get("value") is String and resolver is Callable and resolver.is_valid():
		condition.value = str(resolver.call(condition.value))
	var flags: Variant = context.get("flagStore")
	return flags != null and flags.has_method("eval_pure_flag_conjunction") and flags.call("eval_pure_flag_conjunction", [condition])


func _is_scenario_leaf(expr: Dictionary) -> bool:
	return not expr.get("scenarioLine") is String and expr.get("scenario") is String and expr.get("phase") is String and expr.get("status") is String


func _is_scenario_line_leaf(expr: Dictionary) -> bool:
	return expr.get("scenarioLine") is String and expr.get("lineStatus") is String and SCENARIO_LINE_STATUSES.has(expr.lineStatus) and not expr.get("flag") is String and not expr.has("quest")


func _is_narrative_leaf(expr: Dictionary) -> bool:
	return expr.get("narrative") is String and expr.get("state") is String and not expr.get("flag") is String and not expr.has("quest") and not expr.has("scenario")


func _is_plane_leaf(expr: Dictionary) -> bool:
	return expr.get("plane") is String and not expr.get("flag") is String and not expr.has("quest") and not expr.has("scenario") and not expr.has("narrative")


func _is_quest_leaf(expr: Dictionary) -> bool:
	return expr.get("quest") is String and not expr.has("scenario")


func _is_flag_leaf(expr: Dictionary) -> bool:
	return expr.get("flag") is String


func _leaf_kind(expr: Dictionary) -> String:
	if _is_scenario_leaf(expr): return "scenario"
	if _is_scenario_line_leaf(expr): return "scenarioLine"
	if _is_narrative_leaf(expr): return "narrative"
	if _is_plane_leaf(expr): return "plane"
	if _is_quest_leaf(expr): return "quest"
	if _is_flag_leaf(expr): return "flag"
	return "unknown"


func _strict_equal(left: Variant, right: Variant) -> bool:
	if left is bool or right is bool: return left is bool and right is bool and left == right
	if left is String or right is String: return left is String and right is String and left == right
	if (left is int or left is float) and (right is int or right is float): return float(left) == float(right)
	return left == right
