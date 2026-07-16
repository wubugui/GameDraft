class_name RuntimeConditionEvalBridge
extends RefCounted

const RuntimeConditionEvaluatorScript := preload("res://scripts/runtime/condition_evaluator.gd")


# Stateless counterpart of conditionEvalBridge.evaluateConditionExprList.
# Consumers receive only ConditionEvalContext data; the evaluator is not hidden
# inside a callback field that can vary by caller.
static func evaluate_condition_expr_list(conditions: Variant, context: Dictionary) -> bool:
	if conditions == null or (conditions is Array and conditions.is_empty()):
		return true
	if not conditions is Array:
		push_warning("evaluateConditionExprList: conditions must be an array")
		return false
	for condition: Variant in conditions:
		if not RuntimeConditionEvaluatorScript.evaluate(condition, context):
			return false
	return true
