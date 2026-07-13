class_name RuntimeZoneSystem
extends RuntimeSystem

const STAY_INTERVAL_SEC := 0.25

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var rule_offer_registry: RuntimeRuleOfferRegistry
var zones: Array = []
var _active_zone_ids: Dictionary = {}
var _stay_next_at: Dictionary = {}
var _action_queues: Dictionary = {}
var _action_running: Dictionary = {}
var _condition_context_factory := Callable()
var _player_position_getter := Callable()
var _update_enabled_getter := Callable()
var _clock := Callable()
var _epoch := 0


func _init(events: RuntimeEventBus, flags: RuntimeFlagStore, actions: RuntimeActionExecutor, offers: RuntimeRuleOfferRegistry) -> void:
	event_bus = events; flag_store = flags; action_executor = actions; rule_offer_registry = offers; _clock = func() -> float: return Time.get_ticks_msec() / 1000.0


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void: _condition_context_factory = factory
func set_player_position_getter(getter: Callable = Callable()) -> void: _player_position_getter = getter
func set_update_enabled_getter(getter: Callable = Callable()) -> void: _update_enabled_getter = getter
func set_clock_for_test(clock: Callable) -> void: _clock = clock


func set_zones(next_zones: Array) -> void:
	var next_ids: Dictionary = {}
	for zone: Variant in next_zones:
		if zone is Dictionary: next_ids[str(zone.get("id", ""))] = true
	for id: String in _active_zone_ids.keys():
		if next_ids.has(id): continue
		var old: Variant = _find_zone(id)
		if old is Dictionary: _exit_zone(old)
		else: _active_zone_ids.erase(id)
	var had_offers := not rule_offer_registry.get_aggregated_slots().is_empty()
	for old: Variant in zones:
		if old is Dictionary and not next_ids.has(str(old.get("id", ""))): rule_offer_registry.unregister(str(old.get("id", "")))
	if had_offers != (not rule_offer_registry.get_aggregated_slots().is_empty()): _emit_rule_availability()
	zones = next_zones.duplicate(true)
	for id: String in _stay_next_at.keys():
		if not next_ids.has(id): _stay_next_at.erase(id)


func update(_dt: float) -> void:
	if not _update_enabled_getter.is_null() and _update_enabled_getter.is_valid() and not bool(_update_enabled_getter.call()): return
	if _player_position_getter.is_null() or not _player_position_getter.is_valid(): return
	var position: Variant = _player_position_getter.call()
	if not position is Dictionary: return
	var context: Variant = _condition_context_factory.call() if not _condition_context_factory.is_null() and _condition_context_factory.is_valid() else null; var now := float(_clock.call())
	for zone: Variant in zones:
		if not zone is Dictionary or zone.get("zoneKind") == "depth_floor": continue
		var id := str(zone.get("id", "")); var conditions_ok := _eval_conditions(zone.get("conditions"), context)
		if not conditions_ok:
			if _active_zone_ids.has(id): _exit_zone(zone)
			continue
		var inside := is_valid_polygon(zone.get("polygon")) and is_point_in_polygon(zone.polygon, float(position.get("x", 0)), float(position.get("y", 0)))
		if inside and not _active_zone_ids.has(id): _enter_zone(zone)
		if not inside and _active_zone_ids.has(id): _exit_zone(zone)
		if inside and _active_zone_ids.has(id) and zone.get("onStay") is Array and not zone.onStay.is_empty() and now >= float(_stay_next_at.get(id, 0.0)): _stay_next_at[id] = now + STAY_INTERVAL_SEC; _enqueue_actions(id, zone.onStay)


static func is_valid_polygon(polygon: Variant) -> bool:
	if not polygon is Array or polygon.size() < 3: return false
	for point: Variant in polygon:
		if not point is Dictionary or not (point.get("x") is int or point.get("x") is float) or not (point.get("y") is int or point.get("y") is float) or not is_finite(float(point.x)) or not is_finite(float(point.y)): return false
	return true


static func is_point_in_polygon(polygon: Array, px: float, py: float) -> bool:
	if polygon.size() < 3: return false
	var inside := false; var previous := polygon.size() - 1
	for index in polygon.size():
		var a: Dictionary = polygon[index]; var b: Dictionary = polygon[previous]; var dy := float(b.y) - float(a.y)
		if absf(dy) >= 0.000000000001:
			var x_intersection := float(a.x) + (float(b.x) - float(a.x)) * (py - float(a.y)) / dy
			if (float(a.y) > py) != (float(b.y) > py) and px < x_intersection: inside = not inside
		previous = index
	return inside


func get_active_zones() -> Array: return zones.filter(func(zone: Variant) -> bool: return zone is Dictionary and _active_zone_ids.has(str(zone.get("id", ""))))
func get_active_zone_ids() -> Array: return _active_zone_ids.keys()
func get_current_rule_slots() -> Array: return rule_offer_registry.get_aggregated_slots()
func is_in_any_zone() -> bool: return not _active_zone_ids.is_empty()
func clear_active_zones_for_restore() -> void: _active_zone_ids.clear(); _stay_next_at.clear()


func clear_zones() -> void:
	for id: String in _active_zone_ids.keys():
		var zone: Variant = _find_zone(id)
		if zone is Dictionary: _exit_zone(zone)
	rule_offer_registry.clear(); zones.clear(); _active_zone_ids.clear(); _stay_next_at.clear(); _action_queues.clear(); _action_running.clear(); _epoch += 1


func destroy() -> void: clear_zones(); _condition_context_factory = Callable(); _player_position_getter = Callable(); _update_enabled_getter = Callable(); _clock = Callable()


func _eval_conditions(conditions: Variant, context: Variant) -> bool:
	if not conditions is Array or conditions.is_empty(): return true
	if context is Dictionary and context.get("evaluateList") is Callable: return bool(context.evaluateList.call(conditions))
	return flag_store.check_conditions(conditions)
func _find_zone(id: String) -> Variant:
	for zone: Variant in zones:
		if zone is Dictionary and str(zone.get("id", "")) == id: return zone
	return null
func _enter_zone(zone: Dictionary) -> void:
	var id := str(zone.get("id", "")); _active_zone_ids[id] = true; _stay_next_at.erase(id)
	if zone.get("onEnter") is Array and not zone.onEnter.is_empty(): _enqueue_actions(id, zone.onEnter)
	event_bus.emit("zone:enter", {"zoneId": id, "zone": zone}); _emit_rule_availability()
func _exit_zone(zone: Dictionary) -> void:
	var id := str(zone.get("id", "")); _active_zone_ids.erase(id); _stay_next_at.erase(id)
	if zone.get("onExit") is Array and not zone.onExit.is_empty(): _enqueue_actions(id, zone.onExit)
	event_bus.emit("zone:exit", {"zoneId": id, "zone": zone}); _emit_rule_availability()
func _emit_rule_availability() -> void: event_bus.emit("zone:ruleAvailable" if not get_current_rule_slots().is_empty() else "zone:ruleUnavailable", {})


func _enqueue_actions(zone_id: String, actions: Array) -> void:
	var queue: Array = _action_queues.get(zone_id, []); queue.push_back(actions.duplicate(true)); _action_queues[zone_id] = queue
	if not _action_running.has(zone_id):
		_action_running[zone_id] = true
		call_deferred("_drain_actions", zone_id, _epoch)
func _drain_actions(zone_id: String, epoch: int) -> void:
	while epoch == _epoch and _action_queues.get(zone_id, []).size() > 0:
		var batch: Array = _action_queues[zone_id].pop_front(); await action_executor.execute_batch_in_zone_context(batch, {"zoneId": zone_id})
	_action_running.erase(zone_id)
	if _action_queues.get(zone_id, []).is_empty(): _action_queues.erase(zone_id)


func wait_for_actions_idle(max_frames: int = 120) -> bool:
	var frames := 0
	while (not _action_running.is_empty() or _has_queued_actions()) and frames < maxi(1, max_frames):
		frames += 1
		await get_tree().process_frame
	return _action_running.is_empty() and not _has_queued_actions()


func _has_queued_actions() -> bool:
	for queue: Variant in _action_queues.values():
		if queue is Array and not queue.is_empty(): return true
	return false
