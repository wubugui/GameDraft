class_name RuntimeZoneSystem
extends RuntimeSystem

const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")
const RuntimeConditionEvalBridgeScript := preload("res://scripts/runtime/condition_eval_bridge.gd")
const STAY_INTERVAL_SEC := 0.25

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var rule_offer_registry: RuntimeRuleOfferRegistry
var condition_ctx_factory: Variant = null
var zones: Array = []
var active_zone_ids: Dictionary = {}
var player_pos_getter: Variant = null
var zone_stay_next_at: Dictionary = {}
var zone_action_tail: Dictionary = {}


func _init(next_event_bus: RuntimeEventBus, next_flag_store: RuntimeFlagStore, next_action_executor: RuntimeActionExecutor, next_rule_offer_registry: RuntimeRuleOfferRegistry) -> void:
	event_bus = next_event_bus
	flag_store = next_flag_store
	action_executor = next_action_executor
	rule_offer_registry = next_rule_offer_registry


func init(_ctx: Dictionary) -> void:
	return


func set_condition_eval_context_factory(factory: Variant) -> void:
	condition_ctx_factory = factory


func _eval_zone_conditions(conditions: Variant, context: Variant) -> bool:
	if not conditions is Array or conditions.is_empty():
		return true
	if context is Dictionary:
		return RuntimeConditionEvalBridgeScript.evaluate_condition_expr_list(conditions, context)
	return flag_store.check_conditions(conditions)


func set_player_position_getter(getter: Callable) -> void:
	player_pos_getter = getter


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	return


func set_zones(next_zones: Array) -> void:
	var next_ids: Dictionary = {}
	for zone: Dictionary in next_zones:
		next_ids[zone.id] = true

	for id: String in active_zone_ids.keys():
		if next_ids.has(id):
			continue
		var old_zone: Variant = null
		for zone: Dictionary in zones:
			if zone.id == id:
				old_zone = zone
				break
		if old_zone is Dictionary:
			_exit_zone(old_zone)
		else:
			active_zone_ids.erase(id)

	var slots_before := rule_offer_registry.get_aggregated_slots().size()
	for old_zone: Dictionary in zones:
		if not next_ids.has(old_zone.id):
			rule_offer_registry.unregister(old_zone.id)
	var slots_after := rule_offer_registry.get_aggregated_slots().size()
	if (slots_before > 0) != (slots_after > 0):
		_emit_rule_availability()

	zones = next_zones
	for id: String in zone_stay_next_at.keys():
		if not next_ids.has(id):
			zone_stay_next_at.erase(id)


func get_active_zones() -> Array:
	return zones.filter(func(zone: Dictionary) -> bool: return active_zone_ids.has(zone.id))


func clear_active_zones_for_restore() -> void:
	active_zone_ids.clear()
	zone_stay_next_at.clear()


func clear_zones() -> void:
	for id: String in active_zone_ids.keys():
		var zone_to_exit: Variant = null
		for zone: Dictionary in zones:
			if zone.id == id:
				zone_to_exit = zone
				break
		if zone_to_exit is Dictionary:
			_exit_zone(zone_to_exit)
	rule_offer_registry.clear()
	zones = []
	active_zone_ids.clear()
	zone_stay_next_at.clear()
	zone_action_tail.clear()


func update(_dt: float) -> void:
	if not player_pos_getter is Callable or not player_pos_getter.is_valid():
		return
	var position: Dictionary = player_pos_getter.call()
	var player_x := float(position.x)
	var player_y := float(position.y)
	var context: Variant = condition_ctx_factory.call() if condition_ctx_factory is Callable and condition_ctx_factory.is_valid() else null
	var now := float(Time.get_ticks_usec()) / 1000000.0

	for zone: Dictionary in zones:
		if zone.get("zoneKind") == "depth_floor":
			continue
		var conditions: Variant = zone.get("conditions")
		if conditions is Array and not conditions.is_empty() and not _eval_zone_conditions(conditions, context):
			if active_zone_ids.has(zone.id):
				_exit_zone(zone)
			continue
		var inside := RuntimeZoneGeometry.is_valid_zone_polygon(zone.get("polygon")) and RuntimeZoneGeometry.is_point_in_polygon(zone.polygon, player_x, player_y)
		if inside and not active_zone_ids.has(zone.id):
			_enter_zone(zone)
		if not inside and active_zone_ids.has(zone.id):
			_exit_zone(zone)

		if inside and active_zone_ids.has(zone.id):
			var stay: Variant = zone.get("onStay")
			if stay is Array and not stay.is_empty():
				var next := float(zone_stay_next_at.get(zone.id, 0.0))
				if now >= next:
					zone_stay_next_at[zone.id] = now + STAY_INTERVAL_SEC
					_enqueue_zone_actions(zone.id, Callable(action_executor, "execute_batch_in_zone_context").bind(stay, {"zoneId": zone.id}))


func _enqueue_zone_actions(zone_id: String, task: Callable) -> void:
	var tail: RuntimeAsyncTail = zone_action_tail.get(zone_id)
	if tail == null:
		tail = RuntimeAsyncTail.new()
		zone_action_tail[zone_id] = tail
	RuntimeMicrotaskQueueScript.queue_microtask(
		Callable(tail, "then").bind(task, "ZoneSystem: zone \"%s\" actions failed" % zone_id),
		false,
	)


func _enter_zone(zone: Dictionary) -> void:
	active_zone_ids[zone.id] = true
	zone_stay_next_at.erase(zone.id)
	var enter: Variant = zone.get("onEnter")
	if enter is Array and not enter.is_empty():
		_enqueue_zone_actions(zone.id, Callable(action_executor, "execute_batch_in_zone_context").bind(enter, {"zoneId": zone.id}))
	event_bus.emit("zone:enter", {"zoneId": zone.id, "zone": zone})
	_emit_rule_availability()


func _exit_zone(zone: Dictionary) -> void:
	active_zone_ids.erase(zone.id)
	zone_stay_next_at.erase(zone.id)
	var exit: Variant = zone.get("onExit")
	if exit is Array and not exit.is_empty():
		_enqueue_zone_actions(zone.id, Callable(action_executor, "execute_batch_in_zone_context").bind(exit, {"zoneId": zone.id}))
	event_bus.emit("zone:exit", {"zoneId": zone.id, "zone": zone})
	_emit_rule_availability()


func _emit_rule_availability() -> void:
	var slots := get_current_rule_slots()
	if not slots.is_empty():
		event_bus.emit("zone:ruleAvailable", {})
	else:
		event_bus.emit("zone:ruleUnavailable", {})


func get_current_rule_slots() -> Array:
	return rule_offer_registry.get_aggregated_slots()


func is_in_any_zone() -> bool:
	return not active_zone_ids.is_empty()


func get_active_zone_ids() -> Dictionary:
	return active_zone_ids


func destroy() -> void:
	rule_offer_registry.clear()
	zones = []
	active_zone_ids.clear()
	zone_stay_next_at.clear()
	zone_action_tail.clear()
