extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	await get_tree().process_frame
	await get_tree().process_frame
	var depth: RuntimeSceneDepthSystem = bootstrap.scene_depth_system
	assert(depth.enabled and depth.scene_id == "teahouse" and depth.depth_texture != null and depth.collision_image != null)
	assert(depth.config.get("depth_map") == "raw_depth_rg.png" and depth.scene_size.x == 700.0 and depth.world_to_pixel.x > 0.0)
	assert(depth.get_material_count() >= 1 and depth.get_shadow_count() >= 1 and bootstrap.player.sprite.sprite.material is ShaderMaterial)
	var material: ShaderMaterial = bootstrap.player.sprite.sprite.material
	assert(material.shader == RuntimeEntityLightingFilter.SHADER and material.get_shader_parameter("depth_map") == depth.depth_texture and float(material.get_shader_parameter("depth_enabled")) == 1.0)
	await bootstrap.action_executor.execute_await({"type": "setSceneDepthFloorOffset", "params": {"floor_offset": "-0.45"}})
	assert(is_equal_approx(depth.floor_offset, -0.45) and is_equal_approx(float(material.get_shader_parameter("floor_offset")), -0.45))
	await bootstrap.action_executor.execute_await({"type": "resetSceneDepthFloorOffset", "params": {}})
	assert(is_equal_approx(depth.floor_offset, float(depth.config.floor_offset)))
	var zones := [
		{"zoneKind": "depth_floor", "floorOffsetBoost": 0.2, "polygon": _box(0, 0, 20, 20)},
		{"zoneKind": "depth_floor", "floorOffsetBoost": -0.8, "polygon": _box(5, 5, 15, 15)},
		{"zoneKind": "standard", "floorOffsetBoost": 9.0, "polygon": _box(0, 0, 20, 20)},
	]
	assert(is_equal_approx(depth.resolve_floor_offset_boost(zones, 10, 10), -0.8))
	assert(is_equal_approx(depth.resolve_floor_offset_boost(zones, 2, 2), 0.2))
	assert(is_equal_approx(depth.resolve_floor_offset_boost(zones, 30, 30), 0.0))
	var found_collision := false
	for y: int in range(0, int(depth.scene_size.y) + 1, 12):
		for x: int in range(0, int(depth.scene_size.x) + 1, 12):
			if depth.is_collision(x, y):
				found_collision = true
				break
		if found_collision:
			break
	assert(found_collision and not depth.is_collision(-10000, -10000))
	assert(bootstrap.scene_manager.load_scene("test_room_b", "", null, null, false))
	await get_tree().process_frame
	assert(not depth.enabled and depth.is_lighting_enabled())
	await get_tree().process_frame
	assert(depth.get_material_count() >= 1 and bootstrap.player.sprite.sprite.material is ShaderMaterial and float(bootstrap.player.sprite.sprite.material.get_shader_parameter("depth_enabled")) == 0.0)
	assert(bootstrap.action_executor.has_handler("setSceneDepthFloorOffset") and bootstrap.action_executor.has_handler("resetSceneDepthFloorOffset"))
	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	await get_tree().process_frame
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("SceneDepth load/shader/collision/floor-zone/actions/unload contract test: PASS")
	get_tree().quit(0)


func _box(left: float, top: float, right: float, bottom: float) -> Array:
	return [{"x": left, "y": top}, {"x": right, "y": top}, {"x": right, "y": bottom}, {"x": left, "y": bottom}]
