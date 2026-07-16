extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")
const SceneQueries := preload("res://tests/support/scene_queries.gd")


class ShadowSourceStub:
	extends RefCounted
	var texture: Texture2D
	var visible := true
	var foot_x := 100.0
	var foot_y := 120.0
	var width := 40.0
	var height := 80.0
	var facing := 1.0
	func get_texture() -> Texture2D: return texture
	func is_visible() -> bool: return visible
	func get_foot_x() -> float: return foot_x
	func get_foot_y() -> float: return foot_y
	func get_world_width() -> float: return width
	func get_world_height() -> float: return height
	func get_facing() -> float: return facing


func _ready() -> void:
	var image := Image.create_empty(8, 8, false, Image.FORMAT_RGBA8); image.fill(Color.WHITE); var texture := ImageTexture.create_from_image(image)
	var depth_cfg := {"depth_mapping": {"invert": true, "scale": 2.0, "offset": -1.0}, "shader": {"floor_depth_A": -0.004, "floor_depth_B": 1.75}, "M": {"ppu": 409.0, "cx": 600.0, "cy": 448.0, "R": [[0.0, -0.53, -0.85], [0.0, 0.85, -0.53], [-1.0, 0.0, 0.0]]}, "collision": {"x_min": -1.4, "z_min": -1.5, "cell_size": 0.02, "grid_width": 8, "grid_height": 8}}
	var debug := RuntimeBackgroundDebugFilter.new(); debug.load_scene_data(texture, 8, 8, depth_cfg); debug.set_collision_texture(texture); debug.set_mode(2.0)
	assert(debug.get_mode() == 2.0 and debug.material.shader == RuntimeBackgroundDebugFilter.SHADER and debug.material.get_shader_parameter("collision_map") == texture)
	var lighting := RuntimeEntityLightingFilter.create_for_entity({"depthTexture": texture, "cfg": depth_cfg, "probeSource": texture, "lightEnv": {"key": {"color": [1.0, 0.8, 0.6], "intensity": 0.7}, "ambient": {"color": [0.3, 0.4, 0.5], "intensity": 0.8}, "toneStrength": 0.6, "ao": {"contact": 0.2, "form": 0.1}}, "sampleLiftWorld": 24.0})
	lighting.set_scene_size(700, 500); lighting.set_world_to_pixel(2, 3); lighting.set_entity_foot_x(40); lighting.set_entity_foot_y(80); lighting.set_floor_offset(-0.2); lighting.set_floor_offset_extra(0.1); lighting.set_tolerance(0.05); lighting.set_occlusion_blend_factor(0.3); lighting.set_tone(0.6); lighting.set_ao(0.2, 0.1); lighting.set_key_light([1.0, 0.8, 0.6], 0.7); lighting.set_ambient([0.3, 0.4, 0.5], 0.8); lighting.set_debug(true)
	assert(lighting.material.shader == RuntimeEntityLightingFilter.SHADER and lighting.material.get_shader_parameter("scene_size") == Vector2(700, 500) and is_equal_approx(float(lighting.material.get_shader_parameter("tone_strength")), 0.6))

	var env := {"key": {"azimuthDeg": 90.0, "elevationDeg": 45.0}, "shadow": {"enabled": true, "darkness": 0.4, "softness": 1.0, "length": 0.75, "contact": 0.5, "contactSize": 1.0, "softSamples": 4, "softRadius": 0.05, "billboard": "light"}}
	var field := RuntimeUniformShadowField.new(env); var projection := field.sample(10, 20); assert(is_equal_approx(float(projection.angleRad), deg_to_rad(270.0)) and is_equal_approx(float(projection.length), 0.75))
	var layer := Node2D.new(); add_child(layer); var source := ShadowSourceStub.new(); source.texture = texture
	var shadow_context := {
		"depthTexture": texture, "collisionTexture": texture,
		"sceneW": 800.0, "sceneH": 600.0, "worldToPixelX": 2.0, "worldToPixelY": 3.0,
		"invert": 1.0, "scale": 2.0, "offset": -1.0,
		"floorA": -0.004, "floorB": 1.75, "floorOffset": 0.0, "tolerance": 0.0, "occlusionBlendFactor": 0.28,
		"ppu": 409.0, "cx": 600.0, "cy": 448.0,
		"r00": 0.0, "r01": -0.53, "r02": -0.85,
		"r10": 0.0, "r11": 0.85, "r12": -0.53,
		"r20": -1.0, "r21": 0.0, "r22": 0.0,
		"colXMin": -1.4, "colZMin": -1.5, "colCellSize": 0.02, "colGridW": 8, "colGridH": 8,
	}
	var planar := RuntimePlanarEntityShadow.new(layer, shadow_context); planar.update(source, env, field); assert(planar._cast_mesh.visible and planar._cast_mesh.polygon.size() == 4 and planar._contact_mesh.visible and planar._contact_mesh.polygon.size() == 4 and planar._contact_mesh.texture != texture and planar._blur != null); assert(float(planar._cast_shader.get_shader_parameter("collision_enabled")) == 1.0 and planar._cast_shader.get_shader_parameter("matrix_row2") == Vector3(-1, 0, 0)); planar.set_depth_params(0.1, -0.2, 0.3); assert(planar._cast_shader.get_shader_parameter("floor_offset") == -0.2 and planar._cast_shader.get_shader_parameter("occlusion_blend") == 0.3)
	var deferred := RuntimeDeferredEntityShadow.new(layer, shadow_context); deferred.update(source, env); assert(deferred._mesh.visible and deferred._positions.size() == 4 and deferred._shader.get_shader_parameter("depth_map") == texture and deferred._blur != null); assert(is_equal_approx(float(deferred._shader.get_shader_parameter("height_m")), 80.0 * 3.0 / (409.0 * 0.85)) and not deferred.has_method("set_depth_params"))
	var target := CanvasGroup.new(); add_child(target); var pipeline := RuntimeWorldFilterPipeline.new(target); pipeline.push_filter(debug.material); pipeline.push_filter(lighting.material); assert(pipeline.has_filters() and pipeline.get_filters().size() == 2 and target.material == debug.material and target.get_parent().material == lighting.material); assert(pipeline.pop_filter() == lighting.material and target.material == debug.material and target.get_parent() == self); pipeline.clear(); assert(not pipeline.has_filters() and target.material == null)
	planar.destroy(); deferred.destroy(); await get_tree().process_frame

	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame; await get_tree().process_frame
	assert(bootstrap.scene_depth_system.is_lighting_enabled and bootstrap.game_config.get("entityPixelDensityMatch") == true and bootstrap.entity_shadows.size() >= 1)
	var player_filter: Variant = bootstrap.player_depth_filter; assert(player_filter != null and player_filter.material.has_method("get_shader_parameter"))
	assert(float(player_filter.material.get_shader_parameter("pixel_blur_strength")) >= 0.0 and bootstrap.current_probe.get_width() <= 96)
	var player_size: Dictionary = bootstrap.player.sprite.get_world_size(); assert(is_equal_approx(float(player_filter.material.get_shader_parameter("sample_lift_world")), float(player_size.height) * 0.4))
	assert(await bootstrap.scene_manager.switch_scene("码头白天")); bootstrap._update_scene_depth_runtime(); var crowd: RuntimeHotspot = SceneQueries.hotspot(bootstrap.scene_manager, "new_hotspot_人群"); var crowd_filter: Variant = crowd.get_depth_occlusion_filter(); assert(crowd_filter is RuntimeDepthOcclusionFilter and not crowd_filter.has_method("set_tone"))
	assert(await bootstrap.scene_manager.switch_scene("dev_teahouse_alive")); await get_tree().process_frame; await get_tree().process_frame
	assert(bootstrap.current_light_env.get("shadow", {}).get("mode") == "planar" and bootstrap.entity_shadows.size() >= 1)
	bootstrap.scene_manager.set_audio_applier()
	assert(await bootstrap.scene_manager.switch_scene("梦_夜路")); bootstrap.player.set_x(936.24); bootstrap.player.set_y(1588.38); bootstrap.update_light_env_from_curve(); var first_intensity := float(bootstrap.current_light_env.key.intensity); bootstrap.player.set_x(1981.23); bootstrap.player.set_y(627.92); bootstrap.update_light_env_from_curve(); assert(first_intensity > float(bootstrap.current_light_env.key.intensity) and bootstrap.current_light_curve != null)
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout
	print("Advanced rendering filter/pipeline/lighting/planar/deferred/shadow-field integration test: PASS"); get_tree().quit(0)
