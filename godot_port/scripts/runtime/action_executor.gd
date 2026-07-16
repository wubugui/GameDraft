class_name RuntimeActionExecutor
extends RefCounted

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

# Direct translation of src/core/ActionExecutor.ts. Names are snake_case only;
# field ownership and method order intentionally follow the source class.

const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")

var _handlers: Dictionary = {}
var _param_names_map: Dictionary = {}
var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _game_state_controller: RuntimeGameStateController
var _action_policy_stack: Array[Dictionary] = []
var _resolve_notification_text := Callable()
var _destroyed := false
var _warned_after_destroy := false


static func normalize_action_type_key(raw: Variant) -> String:
	if raw == null:
		return ""
	return str(raw).trim_prefix("﻿").strip_edges()


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore, game_state_controller: RuntimeGameStateController = null) -> void:
	_event_bus = event_bus
	_flag_store = flag_store
	_game_state_controller = game_state_controller
	_register_builtin_handlers()


func set_resolve_notification_text(callback: Callable = Callable()) -> void:
	_resolve_notification_text = callback


func _register_builtin_handlers() -> void:
	register("setFlag", func(params: Dictionary, _zone_context: Variant) -> void:
		_flag_store.set_value(str(params.get("key", "")), params.get("value"))
	, ["key", "value"])

	register("appendFlag", func(params: Dictionary, _zone_context: Variant) -> void:
		_flag_store.append_string_flag(str(params.get("key", "")), _nullish_string(params.get("text")))
	, ["key", "text"])

	register("addFlagValue", func(params: Dictionary, _zone_context: Variant) -> void:
		var key := _nullish_string(params.get("key")).strip_edges()
		if key.is_empty():
			push_warning("addFlagValue: 需要 params.key")
			return
		if not params.has("delta"):
			push_warning("addFlagValue: delta 须为有限数字: null")
			return
		var delta: Variant = _js_finite_number(params.delta)
		if delta == null:
			push_warning("addFlagValue: delta 须为有限数字: %s" % _nullish_string(params.delta))
			return
		_flag_store.add_numeric_flag(key, delta)
	, ["key", "delta"])

	register("showNotification", func(params: Dictionary, _zone_context: Variant) -> void:
		var value := _nullish_string(params.get("text"))
		if _resolve_notification_text.is_valid():
			value = str(_resolve_notification_text.call(value))
		_event_bus.emit("notification:show", {"text": value, "type": params.get("type")})
	, ["text", "type"])


func register(type: String, handler: Callable, param_names: Variant = null) -> void:
	_handlers[type] = handler
	if param_names is Array:
		var names: Array[String] = []
		for name: Variant in param_names:
			names.push_back(str(name))
		_param_names_map[type] = names


func get_param_names(type: String) -> Variant:
	var key := normalize_action_type_key(type)
	return null if key.is_empty() else _param_names_map.get(key)


func get_registered_action_types() -> Array[String]:
	var result: Array[String] = []
	result.assign(_handlers.keys())
	return result


func get_policy_depth() -> int:
	return _action_policy_stack.size()


func push_action_policy(blocked_types: Array, label: String) -> void:
	var blocked := {}
	for type: Variant in blocked_types:
		blocked[normalize_action_type_key(type)] = true
	_action_policy_stack.push_back({"blockedTypes": blocked, "label": label})


func pop_action_policy() -> void:
	if not _action_policy_stack.is_empty():
		_action_policy_stack.pop_back()


func _find_blocking_policy(type_key: String) -> Variant:
	for index in range(_action_policy_stack.size() - 1, -1, -1):
		var policy: Dictionary = _action_policy_stack[index]
		if policy.blockedTypes.has(type_key):
			return policy
	return null


func has_handler(type: String) -> bool:
	var key := normalize_action_type_key(type)
	return not key.is_empty() and _handlers.has(key)


func execute(action: Dictionary) -> void:
	if _destroyed:
		return
	execute_await(action)


# GDScript has no exception channel. A false result is reserved as the mechanical
# equivalent of a rejected TypeScript Promise; ordinary translated handlers return
# null and therefore never alter batch control flow.
func execute_await(action: Dictionary, zone_context: Variant = null) -> bool:
	if _destroyed:
		if not _warned_after_destroy:
			_warned_after_destroy = true
			push_warning("ActionExecutor: 实例已销毁，仍收到动作请求（已忽略）")
		return true
	var type_key := normalize_action_type_key(action.get("type"))
	if type_key.is_empty():
		push_warning("ActionExecutor: action.type 无效，已跳过")
		return true
	var blocking: Variant = _find_blocking_policy(type_key)
	if blocking is Dictionary:
		push_warning("ActionExecutor: 动作 \"%s\" 命中执行策略「%s」黑名单，已跳过" % [type_key, blocking.label])
		return true

	return await _run_with_explore_action_lock(func() -> bool:
		var handler: Variant = _handlers.get(type_key)
		if not handler is Callable or not handler.is_valid():
			push_warning("ActionExecutor: unknown action type \"%s\"" % type_key)
			RuntimeDevErrorOverlay.report_dev_error(
				"ActionExecutor: 数据引用了未注册的动作类型 \"%s\"（已跳过）——检查拼写，或按 add-game-action 三件套补注册" % type_key
			)
			return true
		var params: Variant = action.get("params")
		var result: Variant = await handler.call(params if params is Dictionary else {}, zone_context)
		# 对应 `await Promise.resolve(handler(...))`：同步 handler 也必须让出一条
		# 微任务，且排在 handler 已经 queueMicrotask 的反应任务之后。
		await RuntimeMicrotaskQueueScript.yield_turn()
		return result != false
	)


func execute_batch_await(actions: Array, zone_context: Variant = null) -> bool:
	for action: Variant in actions:
		if action is Dictionary and not await execute_await(action, zone_context):
			return false
	return true


func execute_batch_in_zone_context(actions: Array, context: Dictionary) -> bool:
	return await execute_batch_await(actions, context)


func destroy() -> void:
	_destroyed = true
	_handlers.clear()
	_param_names_map.clear()
	_action_policy_stack.clear()


func _run_with_explore_action_lock(work: Callable) -> Variant:
	var state_controller := _game_state_controller
	if state_controller == null:
		return await work.call()
	var applied_explore_lock := false
	if state_controller.current_state == RuntimeDataTypes.EXPLORING:
		state_controller.set_state(RuntimeDataTypes.ACTION_SEQUENCE)
		applied_explore_lock = true
	var result: Variant = await work.call()
	if applied_explore_lock and state_controller.current_state == RuntimeDataTypes.ACTION_SEQUENCE:
		state_controller.set_state(RuntimeDataTypes.EXPLORING)
	return result


static func _nullish_string(value: Variant) -> String:
	return "" if value == null else str(value)


static func _js_finite_number(value: Variant) -> Variant:
	if value == null:
		return 0.0
	if value is bool:
		return 1.0 if value else 0.0
	if value is int or value is float:
		return float(value) if is_finite(float(value)) else null
	var text := str(value).strip_edges()
	if text.is_empty():
		return 0.0
	if text.to_lower().begins_with("0x") and text.substr(2).is_valid_hex_number():
		return float(text.substr(2).hex_to_int())
	return text.to_float() if text.is_valid_float() and is_finite(text.to_float()) else null
