class_name RuntimeMinigameScriptRunner
extends RefCounted

var registry: Dictionary
var context: Dictionary
var stack: Array[Dictionary] = []
var wait_remain := 0.0


static func _pick_from_pool(ctx: Dictionary, pool_name: String) -> String:
	var values: Variant = ctx.vars.get(pool_name)
	if not values is Array or values.is_empty():
		return ""
	var rng: Callable = ctx.rng
	return str(values[int(floor(float(rng.call()) * values.size()))])


static func _field(step: Dictionary, key: String) -> Variant:
	return step.get(key)


static func core_opcodes() -> Dictionary:
	return {
		"pick": func(step: Dictionary, ctx: Dictionary, _run_children: Callable) -> void:
			var pool := _js_string(_field(step, "pool") if _field(step, "pool") != null else "")
			var slot := _js_string(_field(step, "slot") if _field(step, "slot") != null else "_line")
			ctx.slots[slot] = _pick_from_pool(ctx, pool) if not pool.is_empty() else "",
		"wait": func(step: Dictionary, _ctx: Dictionary, _run_children: Callable) -> float:
			var raw: Variant = _field(step, "sec")
			var seconds := _js_number(raw if raw != null else 0)
			return maxf(0.0, seconds),
		"chance": func(step: Dictionary, ctx: Dictionary, run_children: Callable) -> Variant:
			var raw: Variant = _field(step, "p")
			var probability := _js_number(raw if raw != null else 0)
			var rng: Callable = ctx.rng
			if float(rng.call()) < probability:
				var then_steps: Variant = _field(step, "then")
				if then_steps is Array and not then_steps.is_empty():
					return run_children.call(then_steps)
			else:
				var else_steps: Variant = _field(step, "else")
				if else_steps is Array and not else_steps.is_empty():
					return run_children.call(else_steps)
			return null,
	}


func _init(next_registry: Dictionary, next_context: Dictionary) -> void:
	registry = next_registry
	context = next_context


func run_phase(steps: Array) -> void:
	stack.clear()
	wait_remain = 0.0
	stack.push_back({"steps": steps, "index": 0})
	_pump()


func tick(dt: float) -> void:
	if stack.is_empty():
		return
	wait_remain -= dt
	while not stack.is_empty() and wait_remain <= 0.0:
		_pump()


func cancel() -> void:
	stack.clear()
	wait_remain = 0.0


func is_running() -> bool:
	return not stack.is_empty()


func _pump() -> void:
	while not stack.is_empty() and wait_remain <= 0.0:
		var frame: Dictionary = stack[-1]
		var steps: Array = frame.steps
		var index := int(frame.index)
		if index >= steps.size():
			stack.pop_back()
			continue
		stack[-1].index = index + 1
		var step: Dictionary = steps[index]
		var handler: Variant = registry.get(step.op)
		if not handler is Callable or not handler.is_valid():
			push_warning("[minigameScript] unknown op: %s" % step.op)
			continue
		var result: Variant = handler.call(step, context, Callable(self, "_child_block"))
		if result is Dictionary and result.has("__children"):
			stack.push_back({"steps": result.__children, "index": 0})
		elif result is int or result is float:
			if float(result) > 0.0:
				wait_remain += float(result)


func _child_block(steps: Array) -> Dictionary:
	return {"__children": steps.duplicate(false)}


static func _js_string(value: Variant) -> String:
	if value is bool:
		return "true" if value else "false"
	if value is float and is_finite(value) and value == floorf(value):
		return str(int(value))
	return str(value)


static func _js_number(value: Variant) -> float:
	if value == null:
		return 0.0
	if value is bool:
		return 1.0 if value else 0.0
	if value is int or value is float:
		return float(value)
	var text := str(value).strip_edges()
	if text.is_empty():
		return 0.0
	var lower := text.to_lower()
	if lower == "infinity" or lower == "+infinity":
		return INF
	if lower == "-infinity":
		return -INF
	if lower.begins_with("0x") and lower.substr(2).is_valid_hex_number():
		return float(lower.substr(2).hex_to_int())
	if lower.begins_with("0b"):
		return _parse_radix(lower.substr(2), 2)
	if lower.begins_with("0o"):
		return _parse_radix(lower.substr(2), 8)
	return text.to_float() if text.is_valid_float() else NAN


static func _parse_radix(text: String, radix: int) -> float:
	if text.is_empty():
		return NAN
	var result := 0.0
	for character: String in text:
		var digit := character.unicode_at(0) - 48
		if digit < 0 or digit >= radix:
			return NAN
		result = result * radix + digit
	return result
