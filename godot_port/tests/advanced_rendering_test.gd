extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var image := Image.create_empty(8, 8, false, Image.FORMAT_RGBA8); image.fill(Color.WHITE); var texture := ImageTexture.create_from_image(image)
	var depth_cfg := {"depth_mapping": {"invert": true, "scale": 2.0, "offset": -1.0}}
	var debug := RuntimeBackgroundDebugFilter.new(); debug.load_scene_data(texture, 8, 8, depth_cfg); debug.set_collision_texture(texture); debug.set_mode(2.0)
	assert(debug.get_mode() == 2.0 and debug.material.shader == RuntimeBackgroundDebugFilter.SHADER and debug.material.get_shader_parameter("collision_map") == texture)
	var lighting := RuntimeEntityLightingFilter.create_for_entity({"depth_map": texture, "probe_map": texture, "depth_enabled": 1.0})
	lighting.set_scene_size(700, 500); lighting.set_world_to_pixel(2, 3); lighting.set_entity_foot_x(40); lighting.set_entity_foot_y(80); lighting.set_floor_offset(-0.2); lighting.set_floor_offset_extra(0.1); lighting.set_tolerance(0.05); lighting.set_occlusion_blend_factor(0.3); lighting.set_tone(0.6); lighting.set_ao(0.2, 0.1); lighting.set_key_light([1.0, 0.8, 0.6], 0.7); lighting.set_ambient([0.3, 0.4, 0.5], 0.8); lighting.set_debug(true)
	assert(lighting.material.shader == RuntimeEntityLightingFilter.SHADER and lighting.material.get_shader_parameter("scene_size") == Vector2(700, 500) and is_equal_approx(float(lighting.material.get_shader_parameter("tone_strength")), 0.6))

	var env := {"key": {"azimuthDeg": 90.0, "elevationDeg": 45.0}, "shadow": {"enabled": true, "darkness": 0.4, "softness": 1.0, "length": 0.75, "contact": 0.5, "contactSize": 1.0}}
	var field := RuntimeUniformShadowField.new(env); var projection := field.sample(10, 20); assert(is_equal_approx(float(projection.angleRad), deg_to_rad(270.0)) and is_equal_approx(float(projection.length), 0.75))
	var layer := Node2D.new(); add_child(layer); var source := {"texture": texture, "visible": true, "footX": 100.0, "footY": 120.0, "width": 40.0, "height": 80.0, "facing": 1.0}
	var shadow_context := {"sceneSize": Vector2(800, 600), "worldToPixel": Vector2(2, 3), "depthTexture": texture, "collisionTexture": texture, "config": {"depth_mapping": {"invert": true, "scale": 2.0, "offset": -1.0}, "shader": {"floor_depth_A": -0.004, "floor_depth_B": 1.75}, "M": {"ppu": 409.0, "cx": 600.0, "cy": 448.0, "R": [[0.0, -0.53, -0.85], [0.0, 0.85, -0.53], [-1.0, 0.0, 0.0]]}, "collision": {"x_min": -1.4, "z_min": -1.5, "cell_size": 0.02, "grid_width": 8, "grid_height": 8}}}
	var planar := RuntimePlanarEntityShadow.new(layer, shadow_context); planar.update(source, env, field); assert(planar.root.visible and planar.cast.polygon.size() == 4 and planar.contact.polygon.size() == 4 and planar.contact.texture != texture); assert(float(planar.cast_material.get_shader_parameter("collision_enabled")) == 1.0 and planar.cast_material.get_shader_parameter("matrix_row2") == Vector3(-1, 0, 0)); planar.set_depth_params(0.1, -0.2, 0.3); assert(planar.depth_params.floorOffset == -0.2 and planar.cast_material.get_shader_parameter("occlusion_blend") == 0.3)
	var deferred := RuntimeDeferredEntityShadow.new(layer, shadow_context); deferred.update(source, env); assert(deferred.root.visible and deferred.silhouette.polygon.size() == 4 and deferred.material.get_shader_parameter("depth_map") == texture); assert(is_equal_approx(float(deferred.material.get_shader_parameter("height_m")), 80.0 * 3.0 / (409.0 * 0.85))); deferred.set_depth_params(0.1, -0.2, 0.3)
	var target := Node2D.new(); add_child(target); var pipeline := RuntimeWorldFilterPipeline.new(target); pipeline.push_filter(debug.material); pipeline.push_filter(lighting.material); assert(pipeline.has_filters() and pipeline.get_filters().size() == 2 and target.material == lighting.material); assert(pipeline.pop_filter() == lighting.material and target.material == debug.material); pipeline.clear(); assert(not pipeline.has_filters() and target.material == null)
	planar.destroy(); deferred.destroy(); await get_tree().process_frame

	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame; await get_tree().process_frame
	assert(bootstrap.scene_depth_system.is_lighting_enabled() and bootstrap.scene_depth_system.is_pixel_density_match_active() and bootstrap.scene_depth_system.get_shadow_count() >= 1)
	var player_record: Variant = bootstrap.scene_depth_system._records.values()[0]; assert(player_record is Dictionary and player_record.material.has_method("get_shader_parameter"))
	assert(float(player_record.material.get_shader_parameter("pixel_blur_strength")) >= 0.0 and bootstrap.scene_depth_system.probe_texture.get_width() <= 96)
	var player_size: Dictionary = bootstrap.player.sprite.get_world_size(); assert(is_equal_approx(float(player_record.material.get_shader_parameter("sample_lift_world")), float(player_size.height) * 0.4))
	assert(bootstrap.scene_manager.load_scene("码头白天", "", null, null, false)); bootstrap.scene_depth_system.update(0.0); var crowd: RuntimeHotspot = bootstrap.scene_manager.get_hotspot_by_id("new_hotspot_人群"); var crowd_record: Dictionary = bootstrap.scene_depth_system._records.get(crowd.display_sprite.get_instance_id()); assert(float(crowd_record.material.get_shader_parameter("entity_lighting_enabled")) == 0.0)
	assert(bootstrap.scene_manager.load_scene("dev_teahouse_alive", "", null, null, false)); await get_tree().process_frame; await get_tree().process_frame
	assert(bootstrap.scene_depth_system.light_env.get("shadow", {}).get("mode") == "planar" and bootstrap.scene_depth_system.get_shadow_count() >= 1)
	bootstrap.scene_manager.set_audio_applier()
	assert(bootstrap.scene_manager.load_scene("梦_夜路", "", null, null, false)); bootstrap.player.set_x(936.24); bootstrap.player.set_y(1588.38); bootstrap.scene_depth_system.update(0.0); var first_intensity := float(bootstrap.scene_depth_system.light_env.key.intensity); bootstrap.player.set_x(1981.23); bootstrap.player.set_y(627.92); bootstrap.scene_depth_system.update(0.0); assert(first_intensity > float(bootstrap.scene_depth_system.light_env.key.intensity) and bootstrap.scene_depth_system.light_curve != null)
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout
	print("Advanced rendering filter/pipeline/lighting/planar/deferred/shadow-field integration test: PASS"); get_tree().quit(0)
