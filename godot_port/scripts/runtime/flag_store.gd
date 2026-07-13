class_name RuntimeFlagStore
extends RefCounted

var _flags: Dictionary = {}
var _event_bus: RuntimeEventBus
var _registry: Dictionary = {}
var _condition_context_factory := Callable()
var _warned_invalid_ops: Dictionary = {}


func _init(event_bus: RuntimeEventBus) -> void:
	_event_bus = event_bus


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void:
	_condition_context_factory = factory


func configure_registry(data: Variant) -> void:
	if not data is Dictionary:
		_registry.clear()
		return
	var static_keys := {}
	var static_types := {}
	for entry: Variant in data.get("static", []):
		if entry is String and not entry.is_empty():
			static_keys[entry] = true
			static_types[entry] = "bool"
		elif entry is Dictionary and entry.get("key") is String and not str(entry.key).is_empty():
			static_keys[entry.key] = true
			static_types[entry.key] = _normalize_value_type(entry.get("valueType"))
	var patterns: Array = []
	for raw_pattern: Variant in data.get("patterns", []):
		if raw_pattern is Dictionary:
			patterns.push_back({
				"prefix": str(raw_pattern.get("prefix", "")),
				"suffix": str(raw_pattern.get("suffix", "")),
				"valueType": _normalize_value_type(raw_pattern.get("valueType")),
			})
	var runtime: Variant = data.get("runtime", {})
	_registry = {
		"staticKeys": static_keys,
		"staticTypes": static_types,
		"patterns": patterns,
		"migrations": data.get("migrations", {}).duplicate(),
		"stripUnknown": bool(runtime.get("stripUnknown", false)) if runtime is Dictionary else false,
		"warnUnknown": runtime.get("warnUnknownInDev", true) != false if runtime is Dictionary else true,
	}


func is_key_allowed_by_registry(key: String) -> bool:
	return true if _registry.is_empty() else _is_key_allowed(key.strip_edges())


func get_debug_pickable_keys() -> Array[String]:
	var result: Array[String] = []
	var seen := {}
	if not _registry.is_empty():
		for key: String in _registry.staticKeys:
			seen[key] = true
	for key: String in _flags:
		seen[key] = true
	result.assign(seen.keys())
	result.sort()
	return result


func get_debug_value_kind(key: String) -> String:
	var registered := get_registry_value_type(key)
	if not registered.is_empty():
		return registered
	var value: Variant = _flags.get(key)
	if value is float or value is int:
		return "float"
	if value is String:
		return "string"
	return "bool"


func get_registry_value_type(key: String) -> String:
	if _registry.is_empty():
		return ""
	if _registry.staticTypes.has(key):
		return str(_registry.staticTypes[key])
	for pattern: Dictionary in _registry.patterns:
		if _pattern_defines_key(key, pattern):
			return str(pattern.valueType)
	return ""


func append_string_flag(key: String, fragment: Variant) -> bool:
	if get_registry_value_type(key) != "string":
		return false
	var current: Variant = get_value(key)
	var base := "" if current == null else _js_string(current)
	set_value(key, base + _js_string(fragment))
	return true


func add_numeric_flag(key: String, delta: Variant) -> bool:
	if get_registry_value_type(key) != "float" or not (delta is int or delta is float) or not is_finite(float(delta)):
		return false
	var current: Variant = get_value(key)
	var base := float(current) if (current is int or current is float) and is_finite(float(current)) else 0.0
	set_value(key, base + float(delta))
	return true


func set_value(key: String, value: Variant) -> bool:
	if key.strip_edges().is_empty() or not _valid_flag_value(value):
		return false
	var existed := _flags.has(key)
	var previous: Variant = _flags.get(key)
	_flags[key] = value
	if not existed or not _strict_equal(previous, value):
		_event_bus.emit("flag:changed", {"key": key, "value": value})
	return true


func get_value(key: String) -> Variant:
	return _flags.get(key)


func has_value(key: String) -> bool:
	return _flags.has(key)


func eval_pure_flag_conjunction(conditions: Array) -> bool:
	for raw_condition: Variant in conditions:
		if not raw_condition is Dictionary:
			return false
		var condition: Dictionary = raw_condition
		var expected: Variant = condition.get("value", true)
		if expected == null:
			expected = true
		if not _valid_flag_value(expected):
			return false
		var actual: Variant = _flags.get(str(condition.get("flag", "")), _default_for(expected))
		match str(condition.get("op", "==")):
			"==":
				if not _loose_equal(actual, expected): return false
			"!=":
				if _loose_equal(actual, expected): return false
			">", "<", ">=", "<=":
				if not _compare_order(actual, expected, str(condition.get("op"))): return false
			var invalid_op:
				_warned_invalid_ops[str(invalid_op)] = true
				return false
	return true


func check_conditions(conditions: Array) -> bool:
	if conditions.is_empty():
		return true
	if not _condition_context_factory.is_null() and _condition_context_factory.is_valid():
		var context: Variant = _condition_context_factory.call()
		if context is Dictionary and context.get("evaluateList") is Callable:
			return bool(context.evaluateList.call(conditions))
	for condition: Variant in conditions:
		if not _is_flag_only_atom(condition):
			return false
	return eval_pure_flag_conjunction(conditions)


func serialize() -> Dictionary:
	return _flags.duplicate(true)


func deserialize(data: Dictionary) -> void:
	_flags.clear()
	for raw_key: Variant in data:
		var key := str(raw_key)
		if key.strip_edges().is_empty():
			continue
		if not _registry.is_empty() and _registry.migrations.has(key):
			key = str(_registry.migrations[key])
		if not _registry.is_empty() and not _is_key_allowed(key) and bool(_registry.stripUnknown):
			continue
		var value: Variant = data[raw_key]
		if _valid_flag_value(value):
			_flags[key] = value


func destroy() -> void:
	_flags.clear()
	_warned_invalid_ops.clear()
	_registry.clear()
	_condition_context_factory = Callable()


func registry_counts() -> Dictionary:
	return {"static": _registry.get("staticKeys", {}).size(), "patterns": _registry.get("patterns", []).size()}


func _pattern_defines_key(key: String, pattern: Dictionary) -> bool:
	var prefix := str(pattern.get("prefix", ""))
	var suffix := str(pattern.get("suffix", ""))
	if not suffix.is_empty():
		return key.begins_with(prefix) and key.ends_with(suffix) and key.length() > prefix.length() + suffix.length()
	return key.begins_with(prefix) and key.length() > prefix.length()


func _is_key_allowed(key: String) -> bool:
	if _registry.staticKeys.has(key):
		return true
	for pattern: Dictionary in _registry.patterns:
		if _pattern_defines_key(key, pattern):
			return true
	return false


func _normalize_value_type(raw: Variant) -> String:
	if raw in ["float", "int"]:
		return "float"
	if raw in ["string", "str"]:
		return "string"
	return "bool"


func _valid_flag_value(value: Variant) -> bool:
	return value is bool or value is int or value is float or value is String


func _default_for(expected: Variant) -> Variant:
	if expected is bool: return false
	if expected is int or expected is float: return 0.0
	if expected is String: return ""
	return false


func _strict_equal(left: Variant, right: Variant) -> bool:
	if left is bool or right is bool:
		return left is bool and right is bool and left == right
	if left is String or right is String:
		return left is String and right is String and left == right
	if (left is int or left is float) and (right is int or right is float):
		return float(left) == float(right)
	return left == right


func _loose_equal(left: Variant, right: Variant) -> bool:
	if _strict_equal(left, right):
		return true
	if left is String or right is String:
		return _js_string(left) == _js_string(right)
	return _to_number(left) == _to_number(right)


func _compare_order(left: Variant, right: Variant, op: String) -> bool:
	var left_number := _to_number(left)
	var right_number := _to_number(right)
	if is_finite(left_number) and is_finite(right_number):
		match op:
			">": return left_number > right_number
			"<": return left_number < right_number
			">=": return left_number >= right_number
			"<=": return left_number <= right_number
	var left_string := _js_string(left)
	var right_string := _js_string(right)
	match op:
		">": return left_string > right_string
		"<": return left_string < right_string
		">=": return left_string >= right_string
		"<=": return left_string <= right_string
	return false


func _to_number(value: Variant) -> float:
	if value is bool:
		return 1.0 if value else 0.0
	if value is int or value is float:
		return float(value)
	var text := str(value).strip_edges()
	if text.is_empty():
		return 0.0
	if text.to_lower().begins_with("0x") and text.substr(2).is_valid_hex_number():
		return float(text.substr(2).hex_to_int())
	return text.to_float() if text.is_valid_float() else NAN


func _js_string(value: Variant) -> String:
	if value == null: return "null"
	if value is bool: return "true" if value else "false"
	if value is float and is_finite(value) and value == floor(value): return str(int(value))
	return str(value)


func _is_flag_only_atom(value: Variant) -> bool:
	if not value is Dictionary or not value.get("flag") is String:
		return false
	for key: Variant in value:
		if key not in ["flag", "op", "value"]:
			return false
	return true
