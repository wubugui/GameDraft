class_name RuntimeDepthFloorZones
extends RefCounted


static func resolve(
	zones: Variant,
	foot_world_x: float,
	foot_world_y: float,
	flag_store: RuntimeFlagStore,
	condition_context: Variant = null,
) -> float:
	if not zones is Array or zones.is_empty(): return 0.0
	var best := 0.0
	var best_abs := -1.0
	for zone: Variant in zones:
		if not zone is Dictionary or zone.get("zoneKind") != "depth_floor": continue
		var raw: Variant = zone.get("floorOffsetBoost")
		if not (raw is int or raw is float) or not is_finite(float(raw)): continue
		if zone.get("conditions") is Array and not zone.conditions.is_empty():
			var conditions_match := RuntimeConditionEvalBridge.evaluate_condition_expr_list(zone.conditions, condition_context) \
				if condition_context is Dictionary else flag_store.check_conditions(zone.conditions)
			if not conditions_match: continue
		if not RuntimeZoneGeometry.is_valid_zone_polygon(zone.get("polygon")) or not RuntimeZoneGeometry.is_point_in_polygon(zone.polygon, foot_world_x, foot_world_y): continue
		var magnitude := absf(float(raw))
		if magnitude > best_abs:
			best_abs = magnitude
			best = float(raw)
	return best
