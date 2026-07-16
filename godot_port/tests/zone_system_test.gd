extends Node

var events_seen: Array[String] = []
var action_log: Array = []


func _ready() -> void:
	var events := RuntimeEventBus.new(); var flags := RuntimeFlagStore.new(events); var actions := RuntimeActionExecutor.new(events, flags); var offers := RuntimeRuleOfferRegistry.new(); var system := RuntimeZoneSystem.new(events, flags, actions, offers); add_child(system); system.init({})
	events.on("zone:enter", func(payload: Variant) -> void: events_seen.push_back("enter:%s" % payload.zoneId)); events.on("zone:exit", func(payload: Variant) -> void: events_seen.push_back("exit:%s" % payload.zoneId)); events.on("zone:ruleAvailable", func(_payload: Variant) -> void: events_seen.push_back("rule:on")); events.on("zone:ruleUnavailable", func(_payload: Variant) -> void: events_seen.push_back("rule:off"))
	actions.register("record", func(params: Dictionary, context: Variant) -> void: action_log.push_back("start:%s:%s" % [params.id, context.zoneId]); await get_tree().process_frame; action_log.push_back("end:%s:%s" % [params.id, context.zoneId]), ["id"])
	var position := {"x": -5.0, "y": 5.0}; system.set_player_position_getter(func() -> Dictionary: return position); system.set_condition_eval_context_factory(func() -> Dictionary: return {"flagStore": flags})
	var zone := {"id": "z", "polygon": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 10}, {"x": 0, "y": 10}], "onEnter": [{"type": "record", "params": {"id": "enter"}}], "onStay": [{"type": "record", "params": {"id": "stay"}}], "onExit": [{"type": "record", "params": {"id": "exit"}}], "smell": {"scent": "incense"}}
	var depth := {"id": "floor", "zoneKind": "depth_floor", "floorOffsetBoost": 2, "polygon": zone.polygon}
	assert(RuntimeZoneGeometry.is_valid_zone_polygon(zone.polygon) and RuntimeZoneGeometry.is_point_in_polygon(zone.polygon, 5, 5) and not RuntimeZoneGeometry.is_point_in_polygon(zone.polygon, -1, 5)); assert(not RuntimeZoneGeometry.is_valid_zone_polygon([{"x": 0, "y": 0}]))
	assert(RuntimeZoneGeometry.point_polygon_vertical_side(zone.polygon, 0, -1) == "above" and RuntimeZoneGeometry.point_polygon_vertical_side(zone.polygon, 0, 11) == "below" and RuntimeZoneGeometry.point_polygon_vertical_side(zone.polygon, 20, 5) == null)
	var zone_list := [zone, depth]
	system.set_zones(zone_list); assert(is_same(system.zones, zone_list)); system.update(0); assert(not system.is_in_any_zone())
	position.x = 5; system.update(0); assert(system.get_active_zone_ids().keys() == ["z"] and events_seen[0] == "enter:z")
	await _wait_for_actions_idle(system); assert(action_log == ["start:enter:z", "end:enter:z", "start:stay:z", "end:stay:z"])
	system.zone_stay_next_at.z = INF; system.update(0); assert(action_log.size() == 4)
	system.zone_stay_next_at.z = 0.0; system.update(0); await _wait_for_actions_idle(system); assert(action_log.slice(4) == ["start:stay:z", "end:stay:z"])
	# Replacing an active definition with the same id does not replay exit/enter.
	system.set_zones([zone.duplicate(true), depth]); assert(events_seen.count("enter:z") == 1 and events_seen.count("exit:z") == 0)
	position.x = 20; system.update(0); await _wait_for_actions_idle(system); assert(events_seen.has("exit:z") and action_log.slice(-2) == ["start:exit:z", "end:exit:z"])
	# Condition failure exits an active zone; depth_floor never enters.
	zone.conditions = [{"flag": "allow_zone", "value": true}]; system.set_zones([zone, depth]); position.x = 5; system.update(0); assert(not system.is_in_any_zone()); flags.set_value("allow_zone", true); system.update(0); assert(system.is_in_any_zone()); await _wait_for_actions_idle(system)
	# Removing a zone also withdraws any rule offers registered under its id.
	offers.register("z", [{"ruleId": "r", "resultActions": []}]); system.set_zones([]); assert(system.get_current_rule_slots().is_empty() and events_seen.has("rule:off"))
	# Restore clearing is silent: subsequent set_zones([]) produces no exit event.
	system.set_zones([zone]); system.update(0); var exits_before := events_seen.count("exit:z"); system.clear_active_zones_for_restore(); system.set_zones([]); assert(events_seen.count("exit:z") == exits_before)

	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var files: Array[String] = []; _collect_json("%s/public/assets/scenes" % repository, files); var total := 0; var depth_count := 0; var conditions := 0; var enter := 0; var stay := 0; var exit := 0
	for path: String in files:
		var scene: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path))
		for definition: Variant in scene.get("zones", []): total += 1; depth_count += int(definition.get("zoneKind") == "depth_floor"); conditions += int(definition.has("conditions")); enter += int(definition.has("onEnter")); stay += int(definition.has("onStay")); exit += int(definition.has("onExit")); assert(RuntimeZoneGeometry.is_valid_zone_polygon(definition.polygon))
	assert(total == 42 and depth_count == 7 and conditions == 26 and enter == 29 and stay == 2 and exit == 1)
	await _wait_for_actions_idle(system)
	system.destroy(); remove_child(system); system.free(); actions.destroy(); flags.destroy(); offers.clear(); events.clear()
	print("ZoneSystem diff/tail/reference/geometry direct-translation test: PASS"); get_tree().quit(0)


func _wait_for_actions_idle(system: RuntimeZoneSystem) -> void:
	await RuntimeMicrotaskQueue.yield_turn()
	for tail: Variant in system.zone_action_tail.values():
		if tail is RuntimeAsyncTail:
			await tail.wait_until_idle()
	await RuntimeMicrotaskQueue.yield_turn()


func _collect_json(path: String, output: Array[String]) -> void:
	var dir := DirAccess.open(path); assert(dir != null); dir.list_dir_begin(); var name := dir.get_next()
	while not name.is_empty():
		if name.ends_with(".json") and not dir.current_is_dir(): output.push_back("%s/%s" % [path, name])
		name = dir.get_next()
	dir.list_dir_end(); output.sort()
