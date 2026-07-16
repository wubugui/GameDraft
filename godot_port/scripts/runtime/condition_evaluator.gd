class_name RuntimeConditionEvaluator
extends RefCounted

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const QUEST_STATUS := RuntimeDataTypes.QUEST_STATUS_BY_NAME
const MAX_CONDITION_DEPTH := 32
const SCENARIO_LINE_STATUSES := ["inactive", "active", "completed"]

static var _checked_narrative_leaf_refs: Dictionary = {}


static func resolve_narrative_graph_ref(token: String, context: Dictionary) -> String:
	var raw := token.strip_edges()
	if not raw.begins_with("@"):
		return raw
	var narrative: Variant = context.get("narrativeState")
	if raw == "@owner":
		var owner: Variant = context.get("currentOwner")
		if not owner is Dictionary or str(owner.get("ownerType", "")).is_empty() \
			or str(owner.get("ownerId", "")).is_empty() \
			or narrative == null or not narrative.has_method("get_primary_graph_by_owner"):
			return ""
		var graph: Variant = narrative.call("get_primary_graph_by_owner", owner.ownerType, owner.ownerId)
		return str(graph.get("id", "")) if graph is Dictionary else ""
	if raw == "@scene":
		var scene_id := str(context.get("currentSceneId", "")).strip_edges()
		if scene_id.is_empty() or narrative == null or not narrative.has_method("get_primary_graph_by_owner"):
			return ""
		var graph: Variant = narrative.call("get_primary_graph_by_owner", "scene", scene_id)
		return str(graph.get("id", "")) if graph is Dictionary else ""
	return ""


static func _is_condition_leaf(expr: Variant) -> bool:
	return expr is Dictionary and expr.get("flag") is String


static func _is_quest_leaf(expr: Variant) -> bool:
	return expr is Dictionary and expr.get("quest") is String and not expr.has("scenario")


static func _is_scenario_leaf(expr: Variant) -> bool:
	return expr is Dictionary and not expr.get("scenarioLine") is String \
		and expr.get("scenario") is String and expr.get("phase") is String and expr.get("status") is String


static func _is_scenario_line_leaf(expr: Variant) -> bool:
	return expr is Dictionary and expr.get("scenarioLine") is String and expr.get("lineStatus") is String \
		and not expr.get("flag") is String and not expr.has("quest") \
		and SCENARIO_LINE_STATUSES.has(expr.lineStatus)


static func _is_plane_leaf(expr: Variant) -> bool:
	return expr is Dictionary and expr.get("plane") is String and not expr.get("flag") is String \
		and not expr.has("quest") and not expr.has("scenario") and not expr.has("narrative")


static func _is_narrative_leaf(expr: Variant) -> bool:
	return expr is Dictionary and expr.get("narrative") is String and expr.get("state") is String \
		and not expr.get("flag") is String and not expr.has("quest") and not expr.has("scenario")


static func _is_all_node(expr: Variant) -> bool:
	return expr is Dictionary and expr.get("all") is Array


static func _is_any_node(expr: Variant) -> bool:
	return expr is Dictionary and expr.get("any") is Array


static func _is_not_node(expr: Variant) -> bool:
	if not expr is Dictionary or not expr.has("not") or expr.get("not") == null:
		return false
	return expr.not is Dictionary or expr.not is Array


static func _apply_resolved_flag_condition_value(expr: Dictionary, context: Dictionary) -> Dictionary:
	var resolver: Variant = context.get("resolveConditionLiteral")
	if not expr.get("value") is String or not resolver is Callable or not resolver.is_valid():
		return expr
	var resolved := expr.duplicate(false)
	resolved.value = resolver.call(expr.value)
	return resolved


static func _eval_scenario_leaf(expr: Dictionary, context: Dictionary) -> bool:
	var scenario: Variant = context.get("scenarioState")
	if scenario == null or not scenario.has_method("phase_status_equals") \
		or scenario.call("phase_status_equals", expr.scenario, expr.phase, expr.status) != true:
		return false
	if expr.has("outcome") and expr.outcome != null:
		var phase: Variant = scenario.call("get_scenario_phase", expr.scenario, expr.phase)
		return phase is Dictionary and phase.has("outcome") and _strict_equal(phase.outcome, expr.outcome)
	return true


static func _eval_scenario_line_leaf(expr: Dictionary, context: Dictionary) -> bool:
	var scenario_id := str(expr.scenarioLine).strip_edges()
	if scenario_id.is_empty():
		return false
	var scenario: Variant = context.get("scenarioState")
	return scenario != null and scenario.has_method("get_line_lifecycle_state") \
		and scenario.call("get_line_lifecycle_state", scenario_id) == expr.lineStatus


static func _dev_report_dangling_narrative_leaf(graph_id: String, state_id: String, context: Dictionary) -> void:
	if not OS.is_debug_build():
		return
	var narrative: Variant = context.get("narrativeState")
	if narrative == null or not narrative.has_method("classify_state_ref"):
		return
	var checked_states: Variant = _checked_narrative_leaf_refs.get(graph_id)
	if checked_states is Dictionary and checked_states.has(state_id):
		return
	var verdict := str(narrative.call("classify_state_ref", graph_id, state_id))
	if verdict == "unavailable":
		return
	if not checked_states is Dictionary:
		checked_states = {}
		_checked_narrative_leaf_refs[graph_id] = checked_states
	checked_states[state_id] = true
	if verdict == "ok":
		return
	RuntimeDevErrorOverlay.report_dev_error(
		('条件引用不存在的叙事图 "%s"（state "%s"）——该条件恒为 false，疑似图改名/删除后的悬垂引用' % [graph_id, state_id])
		if verdict == "missingGraph" else
		('条件引用叙事图 "%s" 中不存在的状态 "%s"——该条件恒为 false，疑似状态改名/删除后的悬垂引用' % [graph_id, state_id]),
		"[narrative]",
	)


static func _eval_narrative_leaf(
	graph_id: String,
	state_id: String,
	reached: bool,
	context: Dictionary,
) -> bool:
	var narrative: Variant = context.get("narrativeState")
	if graph_id.is_empty() or state_id.is_empty() or narrative == null:
		return false
	_dev_report_dangling_narrative_leaf(graph_id, state_id, context)
	if reached:
		if narrative.has_method("has_reached_state"):
			return narrative.call("has_reached_state", graph_id, state_id) == true
		return narrative.has_method("is_state_active") \
			and narrative.call("is_state_active", graph_id, state_id) == true
	return narrative.has_method("is_state_active") \
		and narrative.call("is_state_active", graph_id, state_id) == true


static func _narrative_leaf_reached(expr: Dictionary) -> bool:
	return expr.get("reached") == true


static func _eval_quest_leaf(quest: String, raw_status: Variant, context: Dictionary) -> bool:
	if not raw_status is String:
		return false
	var wanted: Variant = QUEST_STATUS.get(raw_status)
	if wanted == null:
		return false
	var manager: Variant = context.get("questManager")
	return manager != null and manager.has_method("get_status") \
		and manager.call("get_status", quest) == wanted


static func _eval_flag_leaf(expr: Dictionary, context: Dictionary) -> bool:
	var condition := _apply_resolved_flag_condition_value(expr, context)
	var flags: Variant = context.get("flagStore")
	return flags != null and flags.has_method("eval_pure_flag_conjunction") \
		and flags.call("eval_pure_flag_conjunction", [condition]) == true


static func _eval_plane_leaf(expr: Dictionary, context: Dictionary) -> bool:
	var wanted := str(expr.plane).strip_edges()
	if wanted.is_empty():
		return false
	var provider: Variant = context.get("getActivePlaneId")
	var active: Variant = provider.call() if provider is Callable and provider.is_valid() else "normal"
	return active == wanted


static func evaluate(expr: Variant, context: Dictionary, depth: int = 0) -> bool:
	if depth > MAX_CONDITION_DEPTH:
		push_warning("evaluateConditionExpr: depth exceeded %s" % MAX_CONDITION_DEPTH)
		return false

	if _is_all_node(expr):
		for child: Variant in expr.all:
			if not evaluate(child, context, depth + 1):
				return false
		return true
	if _is_any_node(expr):
		for child: Variant in expr.any:
			if evaluate(child, context, depth + 1):
				return true
		return false
	if _is_not_node(expr):
		return not evaluate(expr.not, context, depth + 1)
	if _is_scenario_leaf(expr):
		return _eval_scenario_leaf(expr, context)
	if _is_scenario_line_leaf(expr):
		return _eval_scenario_line_leaf(expr, context)
	if _is_narrative_leaf(expr):
		var graph_id := resolve_narrative_graph_ref(expr.narrative, context)
		var state_id := str(expr.state).strip_edges()
		return _eval_narrative_leaf(graph_id, state_id, _narrative_leaf_reached(expr), context)
	if _is_plane_leaf(expr):
		return _eval_plane_leaf(expr, context)
	if _is_quest_leaf(expr):
		var raw_status: Variant = expr.get("questStatus") if expr.get("questStatus") != null else expr.get("status")
		return _eval_quest_leaf(expr.quest, raw_status, context)
	if _is_condition_leaf(expr):
		return _eval_flag_leaf(expr, context)

	push_warning("evaluateConditionExpr: unrecognized shape %s" % JSON.stringify(expr))
	return false


static func evaluate_with_trace(expr: Variant, context: Dictionary, depth: int = 0) -> Dictionary:
	if depth > MAX_CONDITION_DEPTH:
		push_warning("evaluateConditionExprWithTrace: depth exceeded %s" % MAX_CONDITION_DEPTH)
		return {
			"result": false,
			"trace": {"kind": "unknown", "result": false, "label": "嵌套超过 %s" % MAX_CONDITION_DEPTH},
		}

	if _is_all_node(expr):
		var items: Array = []
		var ok := true
		for child: Variant in expr.all:
			var child_result := evaluate_with_trace(child, context, depth + 1)
			items.push_back(child_result.trace)
			if child_result.result != true:
				ok = false
		return {"result": ok, "trace": {"kind": "all", "result": ok, "items": items}}
	if _is_any_node(expr):
		var items: Array = []
		var ok := false
		for child: Variant in expr.any:
			var child_result := evaluate_with_trace(child, context, depth + 1)
			items.push_back(child_result.trace)
			if child_result.result == true:
				ok = true
		return {"result": ok, "trace": {"kind": "any", "result": ok, "items": items}}
	if _is_not_node(expr):
		var child_result := evaluate_with_trace(expr.not, context, depth + 1)
		var result: bool = child_result.result != true
		return {"result": result, "trace": {"kind": "not", "result": result, "inner": child_result.trace}}
	if _is_scenario_leaf(expr):
		var ok := _eval_scenario_leaf(expr, context)
		var scenario: Variant = context.get("scenarioState")
		var current: Variant = scenario.call("get_scenario_phase", expr.scenario, expr.phase)
		var label := "scenario「%s」·「%s」期望 status=%s" % [expr.scenario, expr.phase, expr.status]
		if not current is Dictionary or not current.has("status"):
			label += "（当前无记录，按 pending 比较）"
		else:
			label += "，实际 status=%s" % current.status
		if expr.has("outcome") and expr.outcome != null:
			var actual_outcome := JSON.stringify(current.outcome) \
				if current is Dictionary and current.has("outcome") else "undefined"
			label += "；期望 outcome=%s实际=%s" % [JSON.stringify(expr.outcome), actual_outcome]
		return {"result": ok, "trace": {"kind": "scenario", "result": ok, "label": label}}
	if _is_scenario_line_leaf(expr):
		var ok := _eval_scenario_line_leaf(expr, context)
		var scenario_id := str(expr.scenarioLine).strip_edges()
		var scenario: Variant = context.get("scenarioState")
		var got: Variant = scenario.call("get_line_lifecycle_state", scenario_id) if not scenario_id.is_empty() else "inactive"
		var label := "scenarioLine「%s」期望=%s实际=%s" % [expr.scenarioLine, expr.lineStatus, got]
		return {"result": ok, "trace": {"kind": "scenarioLine", "result": ok, "label": label}}
	if _is_narrative_leaf(expr):
		var graph_id := resolve_narrative_graph_ref(expr.narrative, context)
		var state_id := str(expr.state).strip_edges()
		var reached := _narrative_leaf_reached(expr)
		var ok := _eval_narrative_leaf(graph_id, state_id, reached, context)
		var narrative: Variant = context.get("narrativeState")
		var got: Variant = narrative.call("get_active_state", graph_id) \
			if not graph_id.is_empty() and narrative != null and narrative.has_method("get_active_state") else null
		var raw_ref := str(expr.narrative)
		var ref := "%s→%s" % [raw_ref.strip_edges(), graph_id if not graph_id.is_empty() else "—"] \
			if raw_ref.strip_edges().begins_with("@") else raw_ref
		var label := "narrative「%s」期望 reached=%s，当前=%s" % [ref, state_id if not state_id.is_empty() else "—", got if got != null else "—"] \
			if reached else "narrative「%s」期望=%s实际=%s" % [ref, state_id if not state_id.is_empty() else "—", got if got != null else "—"]
		return {"result": ok, "trace": {"kind": "narrative", "result": ok, "label": label}}
	if _is_plane_leaf(expr):
		var ok := _eval_plane_leaf(expr, context)
		var provider: Variant = context.get("getActivePlaneId")
		var active: Variant = provider.call() if provider is Callable and provider.is_valid() else "normal"
		var wanted := str(expr.plane).strip_edges()
		var label := "plane 期望=%s实际=%s" % [wanted if not wanted.is_empty() else "—", active]
		return {"result": ok, "trace": {"kind": "plane", "result": ok, "label": label}}
	if _is_quest_leaf(expr):
		var raw_status: Variant = expr.get("questStatus") if expr.get("questStatus") != null else expr.get("status")
		var ok := _eval_quest_leaf(expr.quest, raw_status, context)
		var wanted: Variant = QUEST_STATUS.get(raw_status) if raw_status is String else null
		var manager: Variant = context.get("questManager")
		var got: Variant = manager.call("get_status", expr.quest)
		var label := "quest「%s」" % expr.quest
		if wanted == null:
			label += "：无效状态字段 %s" % JSON.stringify(raw_status)
		else:
			label += "：期望 %s，实际 %s" % [raw_status, RuntimeDataTypes.QUEST_STATUS_NAME.get(got, got)]
		return {"result": ok, "trace": {"kind": "quest", "result": ok, "label": label}}
	if _is_condition_leaf(expr):
		var ok := _eval_flag_leaf(expr, context)
		var operator: Variant = expr.get("op") if expr.get("op") != null else "=="
		var value_text := JSON.stringify(expr.value) if expr.has("value") else ""
		var label := "flag %s %s %s" % [expr.flag, operator, value_text]
		return {"result": ok, "trace": {"kind": "flag", "result": ok, "label": label}}

	push_warning("evaluateConditionExprWithTrace: unrecognized shape %s" % JSON.stringify(expr))
	var text := JSON.stringify(expr)
	return {
		"result": false,
		"trace": {"kind": "unknown", "result": false, "label": "无法识别：%s" % text.substr(0, 120)},
	}


static func format_trace(trace: Dictionary, depth: int = 0) -> String:
	var padding := "  ".repeat(depth)
	match str(trace.get("kind", "unknown")):
		"all", "any":
			var lines := ["%s[%s] => %s" % [padding, trace.kind, trace.result]]
			for child: Dictionary in trace.get("items", []):
				lines.push_back(format_trace(child, depth + 1))
			return "\n".join(lines)
		"not":
			return "%s[not] => %s\n%s" % [padding, trace.result, format_trace(trace.inner, depth + 1)]
	return "%s%s => %s" % [padding, trace.get("label", ""), trace.get("result", false)]


static func evaluate_graph_condition(
	expr: Variant,
	flag_store: RuntimeFlagStore,
	quest_manager: Variant,
	scenario_state: Variant,
) -> bool:
	return evaluate(expr, {"flagStore": flag_store, "questManager": quest_manager, "scenarioState": scenario_state})


static func evaluate_all_graph_conditions(
	conditions: Variant,
	flag_store: RuntimeFlagStore,
	quest_manager: Variant,
	scenario_state: Variant,
) -> bool:
	if conditions == null or (conditions is Array and conditions.is_empty()):
		return true
	if not conditions is Array:
		return false
	var context := {"flagStore": flag_store, "questManager": quest_manager, "scenarioState": scenario_state}
	for condition: Variant in conditions:
		if not evaluate(condition, context):
			return false
	return true


static func evaluate_preconditions_with_trace(conditions: Variant, context: Dictionary) -> Dictionary:
	if conditions == null or (conditions is Array and conditions.is_empty()):
		return {"result": true, "trace": {"kind": "all", "result": true, "items": []}}
	if conditions is Array and conditions.size() == 1:
		return evaluate_with_trace(conditions[0], context)
	return evaluate_with_trace({"all": conditions}, context)


static func _strict_equal(left: Variant, right: Variant) -> bool:
	if left is bool or right is bool:
		return left is bool and right is bool and left == right
	if left is String or right is String:
		return left is String and right is String and left == right
	if (left is int or left is float) and (right is int or right is float):
		return float(left) == float(right)
	return left == right
