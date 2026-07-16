class_name RuntimeFlagStore
extends RefCounted

const RuntimeConditionEvalBridgeScript := preload("res://scripts/runtime/condition_eval_bridge.gd")

var _flags: Dictionary = {}
var _event_bus: RuntimeEventBus
var _registry_runtime: Variant = null
var _condition_ctx_factory := Callable()
var _warned_invalid_ops: Dictionary = {}


func _init(event_bus: RuntimeEventBus) -> void:
	_event_bus = event_bus


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void:
	_condition_ctx_factory = factory


func configure_registry(data: Variant) -> void:
	if data == null or not data is Dictionary:
		_registry_runtime = null
		return
	var runtime: Variant = data.get("runtime")
	if not runtime is Dictionary:
		runtime = {}
	var static_list: Variant = data.get("static")
	if not static_list is Array:
		static_list = []
	var static_keys := {}
	var static_types := {}
	for entry: Variant in static_list:
		if entry is String:
			if not entry.is_empty():
				static_keys[entry] = true
				static_types[entry] = "bool"
		elif entry is Dictionary and entry.get("key") is String and not entry.key.is_empty():
			static_keys[entry.key] = true
			static_types[entry.key] = _norm_static_value_type(entry.get("valueType"))
	var patterns: Array = []
	var raw_patterns: Variant = data.get("patterns")
	if raw_patterns is Array:
		for pattern: Variant in raw_patterns:
			if pattern is Dictionary:
				patterns.push_back({
					"prefix": pattern.get("prefix"),
					"suffix": pattern.get("suffix"),
					"valueType": _norm_static_value_type(pattern.get("valueType")),
				})
	var migrations: Variant = data.get("migrations")
	if not migrations is Dictionary:
		migrations = {}
	_registry_runtime = {
		"staticKeys": static_keys,
		"staticTypes": static_types,
		"patterns": patterns,
		"migrations": migrations,
		"stripUnknown": _js_boolean(runtime.get("stripUnknown")),
		"warnUnknown": runtime.get("warnUnknownInDev") != false,
	}


func _pattern_defines_key(key: String, pattern: Dictionary) -> bool:
	var prefix := _nullish_string(pattern.get("prefix"))
	var suffix: Variant = pattern.get("suffix")
	if _js_boolean(suffix):
		var suffix_text := str(suffix)
		return key.begins_with(prefix) and key.ends_with(suffix_text) and key.length() > prefix.length() + suffix_text.length()
	return key.begins_with(prefix) and key.length() > prefix.length()


func _is_key_allowed(key: String, registry: Dictionary) -> bool:
	if registry.staticKeys.has(key):
		return true
	for pattern: Dictionary in registry.patterns:
		if _pattern_defines_key(key, pattern):
			return true
	return false


func is_key_allowed_by_registry(key: String) -> bool:
	var registry: Variant = _registry_runtime
	if registry == null:
		return true
	return _is_key_allowed(key.strip_edges(), registry)


func get_debug_pickable_keys() -> Array[String]:
	var keys := {}
	if _registry_runtime != null:
		for key: String in _registry_runtime.staticKeys:
			keys[key] = true
	for key: String in _flags:
		keys[key] = true
	var result: Array[String] = []
	result.assign(keys.keys())
	result.sort()
	return result


func get_debug_value_kind(key: String) -> String:
	var registry: Variant = _registry_runtime
	if registry != null and registry.staticTypes.has(key):
		return str(registry.staticTypes[key])
	if registry != null:
		for pattern: Dictionary in registry.patterns:
			if _pattern_defines_key(key, pattern):
				return str(pattern.valueType)
	var value: Variant = _flags.get(key)
	if value is int or value is float:
		return "float"
	if value is String:
		return "string"
	return "bool"


func get_registry_value_type(key: String) -> Variant:
	var registry: Variant = _registry_runtime
	if registry == null:
		return null
	if registry.staticTypes.has(key):
		return registry.staticTypes[key]
	for pattern: Dictionary in registry.patterns:
		if _pattern_defines_key(key, pattern):
			return pattern.valueType
	return null


func append_string_flag(key: String, fragment: Variant) -> void:
	var value_type: Variant = get_registry_value_type(key)
	if value_type != "string":
		if _registry_runtime != null:
			push_warning("[appendFlag] key %s 在登记表中不是 string 类型（%s），已跳过" % [JSON.stringify(key), value_type if value_type != null else "未登记"])
		else:
			push_warning("[appendFlag] 未配置 flag 登记表，无法校验 string 类型，已跳过")
		return
	var addition := "" if fragment == null else _js_string(fragment)
	var current: Variant = get_value(key)
	var base: String = current if current is String else ("" if current == null else _js_string(current))
	set_value(key, base + addition)


func add_numeric_flag(key: String, delta: Variant) -> void:
	var value_type: Variant = get_registry_value_type(key)
	if value_type != "float":
		if _registry_runtime != null:
			push_warning("[addFlagValue] key %s 在登记表中不是数值类型（%s），已跳过" % [JSON.stringify(key), value_type if value_type != null else "未登记"])
		else:
			push_warning("[addFlagValue] 未配置 flag 登记表，无法校验数值类型，已跳过")
		return
	if not (delta is int or delta is float) or not is_finite(float(delta)):
		push_warning("[addFlagValue] delta 须为有限数字: %s" % _js_string(delta))
		return
	var current: Variant = get_value(key)
	var base := float(current) if (current is int or current is float) and is_finite(float(current)) else 0.0
	set_value(key, base + float(delta))


func set_value(key: Variant, value: Variant) -> void:
	if not key is String or key.strip_edges().is_empty():
		push_warning("FlagStore.set: 忽略空 flag 键（value=%s）" % JSON.stringify(value))
		return
	var existed := _flags.has(key)
	var previous: Variant = _flags.get(key)
	_flags[key] = value
	if not existed or not _strict_equal(previous, value):
		_event_bus.emit("flag:changed", {"key": key, "value": value})


func get_value(key: String) -> Variant:
	return _flags.get(key)


func eval_pure_flag_conjunction(conditions: Array) -> bool:
	for condition: Dictionary in conditions:
		var raw: Variant = _flags.get(condition.get("flag"))
		var raw_operator: Variant = condition.get("op")
		var operator := "==" if raw_operator == null else str(raw_operator)
		var has_explicit := condition.has("value") and condition.value != null
		var expected: Variant = condition.value if has_explicit else true
		var actual: Variant = raw if _flags.has(condition.get("flag")) else _default_actual_for(expected)
		match operator:
			"==":
				if not _loose_equal(actual, expected):
					return false
			"!=":
				if _loose_equal(actual, expected):
					return false
			">", "<", ">=", "<=":
				if not _compare_order(actual, expected, operator):
					return false
			_:
				if not _warned_invalid_ops.has(operator):
					_warned_invalid_ops[operator] = true
					push_warning("[FlagStore] 条件包含未知运算符 %s（flag=%s），该条件按不满足处理" % [JSON.stringify(operator), condition.get("flag")])
				return false
	return true


func _is_flag_only_atom(value: Variant) -> bool:
	if not value is Dictionary or not value.get("flag") is String:
		return false
	for key: Variant in value:
		if key not in ["flag", "op", "value"]:
			return false
	return true


func check_conditions(conditions: Array) -> bool:
	if conditions.is_empty():
		return true
	var context: Variant = _condition_ctx_factory.call() if _condition_ctx_factory.is_valid() else null
	if context is Dictionary:
		return RuntimeConditionEvalBridgeScript.evaluate_condition_expr_list(conditions, context)
	for condition: Variant in conditions:
		if not _is_flag_only_atom(condition):
			if OS.is_debug_build():
				push_warning("[FlagStore.checkConditions] 缺少 ConditionEvalContext，无法对非 flag 条件求值 %s" % [condition])
			return false
	return eval_pure_flag_conjunction(conditions)


func _loose_equal(left: Variant, right: Variant) -> bool:
	if _strict_equal(left, right):
		return true
	if left is String or right is String:
		return _js_string(left) == _js_string(right)
	return _to_number(left) == _to_number(right)


func _to_number(value: Variant) -> float:
	if value is bool:
		return 1.0 if value else 0.0
	if value is int or value is float:
		return float(value)
	var text := str(value).strip_edges()
	if text.is_empty():
		return 0.0
	var lower := text.to_lower()
	if lower.begins_with("0x"):
		return _radix_number(text.substr(2), 16)
	if lower.begins_with("0b"):
		return _radix_number(text.substr(2), 2)
	if lower.begins_with("0o"):
		return _radix_number(text.substr(2), 8)
	return text.to_float() if text.is_valid_float() and is_finite(text.to_float()) else NAN


func _compare_order(left: Variant, right: Variant, operator: String) -> bool:
	var left_number := _to_number(left)
	var right_number := _to_number(right)
	if is_finite(left_number) and is_finite(right_number):
		match operator:
			">": return left_number > right_number
			"<": return left_number < right_number
			">=": return left_number >= right_number
			"<=": return left_number <= right_number
	var left_string := _js_string(left)
	var right_string := _js_string(right)
	var comparison := -1 if left_string < right_string else (1 if left_string > right_string else 0)
	match operator:
		">": return comparison > 0
		"<": return comparison < 0
		">=": return comparison >= 0
		"<=": return comparison <= 0
	return false


func serialize() -> Dictionary:
	return _flags.duplicate(true)


func deserialize(data: Dictionary) -> void:
	var registry: Variant = _registry_runtime
	_flags.clear()
	for raw_key: Variant in data:
		var key := str(raw_key)
		if key.strip_edges().is_empty():
			push_warning("[FlagStore] 存档含空 flag 键，已丢弃")
			continue
		if registry != null and registry.migrations.has(key):
			key = str(registry.migrations[key])
		if registry != null and not _is_key_allowed(key, registry):
			if registry.stripUnknown:
				continue
			if registry.warnUnknown and OS.is_debug_build():
				push_warning("[FlagStore] unknown flag key in save: %s" % key)
		_flags[key] = data[raw_key]


func destroy() -> void:
	_flags.clear()
	_warned_invalid_ops.clear()
	_registry_runtime = null
	_condition_ctx_factory = Callable()


static func _norm_static_value_type(raw: Variant) -> String:
	if raw in ["float", "int"]:
		return "float"
	if raw in ["string", "str"]:
		return "string"
	return "bool"


static func _default_actual_for(expected: Variant) -> Variant:
	if expected is bool:
		return false
	if expected is int or expected is float:
		return 0
	if expected is String:
		return ""
	return false


static func _strict_equal(left: Variant, right: Variant) -> bool:
	if left is bool or right is bool:
		return left is bool and right is bool and left == right
	if left is String or right is String:
		return left is String and right is String and left == right
	if (left is int or left is float) and (right is int or right is float):
		return float(left) == float(right)
	return left == right


static func _radix_number(digits: String, radix: int) -> float:
	if digits.is_empty():
		return NAN
	var result := 0.0
	for index: int in range(digits.length()):
		var code := digits.unicode_at(index)
		var digit := code - 48
		if code >= 65 and code <= 70:
			digit = code - 55
		elif code >= 97 and code <= 102:
			digit = code - 87
		if digit < 0 or digit >= radix:
			return NAN
		result = result * float(radix) + float(digit)
	return result if is_finite(result) else NAN


static func _js_string(value: Variant) -> String:
	if value == null:
		return "null"
	if value is bool:
		return "true" if value else "false"
	if value is float and is_finite(value) and value == floorf(value):
		return str(int(value))
	return str(value)


static func _nullish_string(value: Variant) -> String:
	return "" if value == null else str(value)


static func _js_boolean(value: Variant) -> bool:
	if value == null:
		return false
	if value is bool:
		return value
	if value is int or value is float:
		return is_finite(float(value)) and float(value) != 0.0
	if value is String:
		return not value.is_empty()
	return true
