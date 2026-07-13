class_name RuntimeEventBus
extends RefCounted

var _listeners: Dictionary = {}
var _debug_trace_enabled := false
var _debug_trace_limit := 1000
var _debug_trace_seq := 0
var _debug_trace: Array = []


func on(event: String, callback: Callable) -> void:
	if not callback.is_valid():
		push_warning("EventBus: ignored invalid listener for %s" % event)
		return
	var callbacks: Array = _listeners.get(event, [])
	if not callbacks.has(callback):
		callbacks.push_back(callback)
	_listeners[event] = callbacks


func off(event: String, callback: Callable) -> void:
	var callbacks: Array = _listeners.get(event, [])
	callbacks.erase(callback)
	if callbacks.is_empty():
		_listeners.erase(event)
	else:
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


func listener_count(event: String = "") -> int:
	if not event.is_empty():
		return _listeners.get(event, []).size()
	var total := 0
	for callbacks: Array in _listeners.values():
		total += callbacks.size()
	return total


func enable_debug_trace(limit: int = 1000) -> void:
	_debug_trace_enabled = true
	_debug_trace_limit = clampi(limit, 1, 10000)
	if _debug_trace.size() > _debug_trace_limit:
		_debug_trace = _debug_trace.slice(_debug_trace.size() - _debug_trace_limit)


func disable_debug_trace() -> void:
	_debug_trace_enabled = false


func clear_debug_trace() -> void:
	_debug_trace_seq = 0
	_debug_trace.clear()


func get_debug_trace() -> Array:
	return _debug_trace.duplicate(true)


func _record_debug_trace(event: String, payload: Variant) -> void:
	if not _debug_trace_enabled:
		return
	_debug_trace_seq += 1
	_debug_trace.push_back({"seq": _debug_trace_seq, "event": event, "payload": _canonical_trace_value(payload, 8)})
	if _debug_trace.size() > _debug_trace_limit:
		_debug_trace.pop_front()


func _canonical_trace_value(value: Variant, depth: int) -> Variant:
	if value == null:
		return null
	if value is bool or value is int or value is String:
		return value
	if value is float:
		return value if is_finite(value) else str(value)
	if depth <= 0:
		return "<max-depth>"
	if value is Array:
		var output: Array = []
		for item: Variant in value:
			output.push_back(_canonical_trace_value(item, depth - 1))
		return output
	if value is Dictionary:
		var output := {}
		var keys: Array = value.keys()
		keys.sort_custom(func(a: Variant, b: Variant) -> bool: return str(a) < str(b))
		for key: Variant in keys:
			output[str(key)] = _canonical_trace_value(value[key], depth - 1)
		return output
	if value is Vector2:
		return {"x": value.x, "y": value.y}
	return str(value)
