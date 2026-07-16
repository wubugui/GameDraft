class_name RuntimeEventBus
extends RefCounted

var _listeners: Dictionary = {}
var _debug_trace_enabled := false
var _debug_trace_limit := 1000
var _debug_trace_seq := 0
var _debug_trace: Array = []


func on(event: String, callback: Callable) -> void:
	var callbacks: Array = _listeners.get(event, [])
	if not callbacks.has(callback):
		callbacks.push_back(callback)
	_listeners[event] = callbacks


func off(event: String, callback: Callable) -> void:
	var callbacks: Array = _listeners.get(event, [])
	callbacks.erase(callback)
	if _listeners.has(event):
		_listeners[event] = callbacks


func emit(event: String, payload: Variant = null) -> void:
	_record_debug_trace(event, payload)
	# TypeScript copies the Set before dispatch.  Add/remove during an emit only
	# affects later emits, while nested emits observe the current registry.
	var callbacks: Array = _listeners.get(event, []).duplicate()
	for callback: Callable in callbacks:
		if not callback.is_valid():
			continue
		callback.call(payload)


func clear() -> void:
	_listeners.clear()


func enable_debug_trace(limit: Variant = 1000) -> void:
	_debug_trace_enabled = true
	var numeric_limit := int(float(limit)) if (limit is int or limit is float) and is_finite(float(limit)) else 0
	_debug_trace_limit = clampi(numeric_limit if numeric_limit != 0 else 1000, 1, 10000)
	if _debug_trace.size() > _debug_trace_limit:
		_debug_trace = _debug_trace.slice(_debug_trace.size() - _debug_trace_limit)


func disable_debug_trace() -> void:
	_debug_trace_enabled = false


func clear_debug_trace() -> void:
	_debug_trace_seq = 0
	_debug_trace.clear()


func get_debug_trace() -> Array:
	var result: Array = []
	for entry: Variant in _debug_trace:
		result.push_back({
			"seq": entry.seq,
			"event": entry.event,
			"payload": _clone_trace_value(entry.payload),
		})
	return result


func _record_debug_trace(event: String, payload: Variant) -> void:
	if not _debug_trace_enabled:
		return
	_debug_trace_seq += 1
	_debug_trace.push_back({"seq": _debug_trace_seq, "event": event, "payload": _canonicalize_trace_value(payload)})
	if _debug_trace.size() > _debug_trace_limit:
		_debug_trace.pop_front()


# 单条 trace 条目 canonical 形态的字符预算上限（兜底安全阀，防超大纯数据数组/字符串）。
# 与 src/core/EventBus.ts#TRACE_ENTRY_MAX_CHARS 对齐：真正的根治是「拒绝深拷贝活对象」——
# 活对象只走 to_trace_json() 投影接口，否则退化成 {__class, id} 紧凑标签，绝不摊开其对象图。
const TRACE_ENTRY_MAX_CHARS := 4000


static func _canonicalize_trace_value(value: Variant, depth: int = 8, seen: Array = [], budget: Dictionary = {}) -> Variant:
	if not budget.has("left"):
		budget["left"] = TRACE_ENTRY_MAX_CHARS
	if value == null:
		return null
	if value is String:
		var text: String = value
		if text.length() > int(budget.left):
			var slice := text.substr(0, maxi(0, int(budget.left)))
			budget["left"] = 0
			return "%s…<truncated %d chars>" % [slice, text.length()]
		budget["left"] = int(budget.left) - text.length()
		return text
	if value is bool or value is int:
		return value
	if value is float:
		return value if is_finite(value) else str(value)
	if value is Callable:
		return null
	if depth <= 0:
		return "<max-depth>"
	if int(budget.left) <= 0:
		return "<truncated>"
	if value is Array:
		var output: Array = []
		for item: Variant in value:
			if int(budget.left) <= 0:
				output.push_back("<truncated>")
				break
			output.push_back(_canonicalize_trace_value(item, depth - 1, seen, budget))
		return output
	if value is Dictionary:
		for prior: Variant in seen:
			if is_same(prior, value):
				return "<circular>"
		seen.push_back(value)
		var output := {}
		var keys: Array = value.keys()
		keys.sort_custom(func(a: Variant, b: Variant) -> bool: return str(a) < str(b))
		for key: Variant in keys:
			if int(budget.left) <= 0:
				output["<truncated>"] = true
				break
			var child: Variant = value[key]
			if child is Callable:
				continue
			budget["left"] = int(budget.left) - str(key).length()
			output[str(key)] = _canonicalize_trace_value(child, depth - 1, seen, budget)
		seen.pop_back()
		return output
	if value is Vector2:
		return {"x": value.x, "y": value.y}
	if value is Object:
		# 活对象不是“数据”：禁止深拷贝其对象图（与 TS 端同语义）。
		# 走它声明的 to_trace_json() 投影；没有就退化成 {__class, id?} 紧凑标签。
		for prior: Variant in seen:
			if is_same(prior, value):
				return "<circular>"
		if value.has_method("to_trace_json"):
			seen.push_back(value)
			var projected: Variant = _canonicalize_trace_value(value.to_trace_json(), depth - 1, seen, budget)
			seen.pop_back()
			return projected
		var script: Variant = value.get_script()
		var cls: String = str(script.get_global_name()) if script != null and str(script.get_global_name()) != "" else value.get_class()
		var tag := {"__class": cls}
		var id_value: Variant = value.get("id")
		if id_value is String or id_value is int:
			tag["id"] = id_value
		return tag
	return str(value)


static func _clone_trace_value(value: Variant) -> Variant:
	return _canonicalize_trace_value(value)
