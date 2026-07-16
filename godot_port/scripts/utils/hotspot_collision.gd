class_name RuntimeHotspotCollision
extends RefCounted

const RuntimeZoneGeometryScript := preload("res://scripts/runtime/zone_geometry.gd")


static func anchor_collision_polygon_to_world(
	anchor_x: float,
	anchor_y: float,
	definition: Dictionary,
) -> Variant:
	var polygon: Variant = definition.get("collisionPolygon")
	if polygon == null or not RuntimeZoneGeometryScript.is_valid_zone_polygon(polygon):
		return null
	var output: Array = []
	var local_value: Variant = definition.get("collisionPolygonLocal")
	var is_local: bool = local_value is bool and local_value == true
	if not is_local:
		for point: Dictionary in polygon:
			output.push_back({"x": point.x, "y": point.y})
		return output
	for point: Dictionary in polygon:
		output.push_back({"x": point.x + anchor_x, "y": point.y + anchor_y})
	return output


static func hotspot_collision_polygon_to_world(definition: Dictionary) -> Variant:
	return anchor_collision_polygon_to_world(definition.x, definition.y, definition)


static func npc_collision_polygon_to_world(npc: RuntimeNpc) -> Variant:
	return anchor_collision_polygon_to_world(npc.get_x(), npc.get_y(), npc.def)
