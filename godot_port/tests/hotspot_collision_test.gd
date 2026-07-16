extends Node

const RuntimeHotspotCollisionScript := preload("res://scripts/utils/hotspot_collision.gd")


func _ready() -> void:
	var local := {
		"x": 100.0,
		"y": 200.0,
		"collisionPolygon": [{"x": -10, "y": -20}, {"x": 10, "y": -20}, {"x": 0, "y": 0}],
		"collisionPolygonLocal": true,
	}
	assert(RuntimeHotspotCollisionScript.anchor_collision_polygon_to_world(100.0, 200.0, local) == [
		{"x": 90.0, "y": 180.0}, {"x": 110.0, "y": 180.0}, {"x": 100.0, "y": 200.0},
	])
	assert(RuntimeHotspotCollisionScript.hotspot_collision_polygon_to_world(local) == [
		{"x": 90.0, "y": 180.0}, {"x": 110.0, "y": 180.0}, {"x": 100.0, "y": 200.0},
	])
	var world := local.duplicate(true)
	world.collisionPolygonLocal = false
	var copied: Array = RuntimeHotspotCollisionScript.hotspot_collision_polygon_to_world(world)
	assert(copied == world.collisionPolygon)
	copied[0].x = 999
	assert(world.collisionPolygon[0].x == -10)
	world.collisionPolygonLocal = 1
	assert(RuntimeHotspotCollisionScript.hotspot_collision_polygon_to_world(world) == world.collisionPolygon)
	assert(RuntimeHotspotCollisionScript.anchor_collision_polygon_to_world(0, 0, {}) == null)
	assert(RuntimeHotspotCollisionScript.anchor_collision_polygon_to_world(0, 0, {"collisionPolygon": [{"x": 0, "y": 0}]}) == null)

	var npc := RuntimeNpc.new({
		"id": "moving",
		"x": 5.0,
		"y": 6.0,
		"collisionPolygon": [{"x": -1, "y": -2}, {"x": 1, "y": -2}, {"x": 0, "y": 0}],
		"collisionPolygonLocal": true,
	})
	assert(RuntimeHotspotCollisionScript.npc_collision_polygon_to_world(npc)[0] == {"x": 4.0, "y": 4.0})
	npc.set_x(20.0)
	npc.set_y(30.0)
	assert(RuntimeHotspotCollisionScript.npc_collision_polygon_to_world(npc)[0] == {"x": 19.0, "y": 28.0})
	npc.destroy_npc()

	print("Hotspot collision anchor/hotspot/runtime-NPC translation test: PASS")
	get_tree().quit(0)
