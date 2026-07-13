class_name RuntimeMinigameScriptRunner
extends RefCounted

var registry: Dictionary
var context: Dictionary
var unknown_ops: Array[String] = []
var _stack: Array[Dictionary] = []
var _wait_remaining := 0.0


func _init(next_registry: Dictionary = {}, next_context: Dictionary = {}) -> void:
	registry = next_registry.duplicate()
	context = next_context
	if not context.get("vars") is Dictionary: context.vars = {}
	if not context.get("slots") is Dictionary: context.slots = {}
	if not context.get("rng") is Callable: context.rng = func() -> float: return randf()


func run_phase(steps: Array) -> void:
	cancel()
	_stack.push_back({"steps": steps.duplicate(true), "index": 0})
	_pump()


func tick(dt: float) -> void:
	if _stack.is_empty(): return
	_wait_remaining -= dt
	if _wait_remaining <= 0: _pump()


func cancel() -> void:
	_stack.clear(); _wait_remaining = 0.0


func is_running() -> bool:
	return not _stack.is_empty()


func _pump() -> void:
	while not _stack.is_empty() and _wait_remaining <= 0:
		var frame: Dictionary = _stack[-1]
		var steps: Array = frame.steps
		var index := int(frame.index)
		if index >= steps.size():
			_stack.pop_back()
			continue
		_stack[-1].index = index + 1
		var raw: Variant = steps[index]
		if not raw is Dictionary: continue
		var step: Dictionary = raw
		var op := str(step.get("op", ""))
		var result: Variant
		var handler: Variant = registry.get(op)
		if handler is Callable and handler.is_valid():
			result = handler.call(step, context, Callable(self, "_child_block"))
		else:
			result = _run_core_opcode(op, step)
			if result is Dictionary and result.get("__unknown") == true:
				if not unknown_ops.has(op): unknown_ops.push_back(op)
				continue
		if result is Dictionary and result.get("__children") is Array:
			_stack.push_back({"steps": result.__children.duplicate(true), "index": 0})
		elif result is int or result is float:
			var wait := float(result)
			if wait > 0: _wait_remaining += wait


func _run_core_opcode(op: String, step: Dictionary) -> Variant:
	match op:
		"pick":
			var pool := str(step.get("pool", "")); var slot := str(step.get("slot", "_line")); var values: Variant = context.vars.get(pool)
			context.slots[slot] = _pick(values)
			return null
		"wait":
			return maxf(0.0, float(step.get("sec", 0)))
		"chance":
			var rng: Callable = context.rng; var branch: Variant = step.get("then") if float(rng.call()) < float(step.get("p", 0)) else step.get("else")
			return _child_block(branch) if branch is Array and not branch.is_empty() else null
	return {"__unknown": true}


func _pick(values: Variant) -> String:
	if not values is Array or values.is_empty(): return ""
	var rng: Callable = context.rng
	var index := clampi(int(floor(float(rng.call()) * values.size())), 0, values.size() - 1)
	return str(values[index])


func _child_block(steps: Variant) -> Dictionary:
	return {"__children": steps if steps is Array else []}
