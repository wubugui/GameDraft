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
	var planar := RuntimePlanarEntityShadow.new(layer, shadow_context); planar.update(source, env, field)
	assert(planar._cast_mesh.visible and planar._contact_mesh.visible and planar._cast_positions == PackedVector2Array([Vector2(80, 120), Vector2(120, 120), Vector2(120, 60), Vector2(80, 60)]))
	assert(planar._contact_positions == PackedVector2Array([Vector2(74, 108), Vector2(126, 108), Vector2(126, 132), Vector2(74, 132)]) and planar._contact_mesh.texture != texture)
	assert(planar._cast_uvs == PackedVector2Array([Vector2(0, 1), Vector2(1, 1), Vector2(1, 0), Vector2(0, 0)]))
	assert(float(planar._cast_shader.get_shader_parameter("collision_enabled")) == 1.0 and planar._cast_shader.get_shader_parameter("matrix_row2") == Vector3(-1, 0, 0))
	var planar_blur: RuntimeShadowBlurFilter = planar._blur
	assert(planar_blur != null and planar_blur.quality == 2 and planar_blur.is_mounted() and is_equal_approx(planar_blur.strength, 4.0))
	env.shadow.softness = 1.0005; planar.update(source, env, field); assert(planar._blur == planar_blur and is_equal_approx(planar_blur.strength, 4.0), "softness epsilon must preserve BlurFilter state and strength")
	env.shadow.softness = 0.5; planar.update(source, env, field); assert(planar._blur == planar_blur and is_equal_approx(planar_blur.strength, 2.0))
	var atlas_image := Image.create_empty(16, 8, false, Image.FORMAT_RGBA8); atlas_image.fill(Color.WHITE); var atlas_source := ImageTexture.create_from_image(atlas_image); var atlas_texture := AtlasTexture.new(); atlas_texture.atlas = atlas_source; atlas_texture.region = Rect2(4, 0, 8, 8)
	source.texture = atlas_texture; source.facing = -1.0; planar.update(source, env, field)
	assert(planar._bound_source == atlas_source and planar._cast_uvs == PackedVector2Array([Vector2(0.75, 1), Vector2(0.25, 1), Vector2(0.25, 0), Vector2(0.75, 0)]), "atlas frame/facing UV translation drift")
	planar.set_depth_params(0.1, -0.2, 0.3); assert(planar._cast_shader.get_shader_parameter("tolerance") == 0.1 and planar._cast_shader.get_shader_parameter("floor_offset") == -0.2 and planar._cast_shader.get_shader_parameter("occlusion_blend") == 0.3)
	env.shadow.darkness = 0.0; planar.update(source, env, field); assert(not planar._cast_mesh.visible and planar._contact_mesh.visible)
	source.visible = false; planar.update(source, env, field); assert(not planar._cast_mesh.visible and not planar._contact_mesh.visible)
	source.visible = true; source.texture = texture; source.facing = 1.0; env.shadow.darkness = 0.4; env.shadow.softness = 1.0; planar.update(source, env, field)

	var deferred := RuntimeDeferredEntityShadow.new(layer, shadow_context); deferred.update(source, env)
	assert(deferred._mesh.visible and deferred._positions == PackedVector2Array([Vector2(-20, 0), Vector2(220, 0), Vector2(220, 240), Vector2(-20, 240)]))
	assert(deferred._shader.get_shader_parameter("depth_map") == texture and deferred._bound_silhouette == texture)
	assert(is_equal_approx(float(deferred._shader.get_shader_parameter("height_m")), 80.0 * 3.0 / (409.0 * 0.85)) and is_equal_approx(float(deferred._shader.get_shader_parameter("width_m")), 40.0 * 2.0 / 409.0))
	assert(deferred._shader.get_shader_parameter("light_direction").is_equal_approx(Vector3(0, sqrt(0.5), sqrt(0.5))) and not deferred.has_method("set_depth_params"))
	var first_deferred_blur: RuntimeShadowBlurFilter = deferred._blur
	assert(first_deferred_blur != null and first_deferred_blur.quality == 2 and first_deferred_blur.is_mounted())
	source.texture = atlas_texture; source.facing = -1.0; deferred.update(source, env); assert(deferred._bound_silhouette == atlas_source and deferred._shader.get_shader_parameter("silhouette_frame") == Vector4(0.25, 0, 0.5, 1))
	env.shadow.softness = 0.0; deferred.update(source, env); assert(deferred._blur == null and deferred._last_softness == -1.0 and first_deferred_blur.destroyed and deferred._mesh.get_parent() == layer)
	env.shadow.softness = 1.0; source.texture = texture; source.facing = 1.0; deferred.update(source, env); assert(deferred._blur != null and not is_same(deferred._blur, first_deferred_blur))
	var target := CanvasGroup.new(); add_child(target); var pipeline := RuntimeWorldFilterPipeline.new(target); pipeline.push_filter(debug.material); pipeline.push_filter(lighting.material); assert(pipeline.has_filters() and pipeline.get_filters().size() == 2 and target.material == debug.material and target.get_parent().material == lighting.material); assert(pipeline.pop_filter() == lighting.material and target.material == debug.material and target.get_parent() == self); pipeline.clear(); assert(not pipeline.has_filters() and target.material == null)
	if DisplayServer.get_name() != "headless": await _assert_shadow_blur_pixels()
	var retained_planar_blur: RuntimeShadowBlurFilter = planar._blur; var retained_planar_cast_geometry: RuntimeShadowMeshGeometry = planar._cast_geometry; var retained_planar_contact_geometry: RuntimeShadowMeshGeometry = planar._contact_geometry
	var retained_deferred_blur: RuntimeShadowBlurFilter = deferred._blur; var retained_deferred_geometry: RuntimeShadowMeshGeometry = deferred._geometry
	planar.destroy(); deferred.destroy(); await get_tree().process_frame
	assert(retained_planar_blur.destroyed and retained_planar_cast_geometry.destroyed and retained_planar_contact_geometry.destroyed and planar._cast_mesh == null and planar._contact_mesh == null)
	assert(retained_deferred_blur.destroyed and retained_deferred_geometry.destroyed and deferred._mesh == null)

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


func _assert_shadow_blur_pixels() -> void:
	var viewport := SubViewport.new()
	viewport.size = Vector2i(128, 128)
	viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	viewport.transparent_bg = false
	add_child(viewport)
	var canvas := Node2D.new(); viewport.add_child(canvas)
	var background := Polygon2D.new(); background.polygon = PackedVector2Array([Vector2.ZERO, Vector2(128, 0), Vector2(128, 128), Vector2(0, 128)]); background.color = Color(0.12, 0.24, 0.36, 1); canvas.add_child(background)
	var shadow := Polygon2D.new(); shadow.polygon = PackedVector2Array([Vector2(48, 48), Vector2(80, 48), Vector2(80, 80), Vector2(48, 80)]); shadow.color = Color(0, 0, 0, 0.9); canvas.add_child(shadow)
	var blur := RuntimeShadowBlurFilter.new(shadow, 4.0, 2)
	RenderingServer.force_draw(true); await get_tree().process_frame; RenderingServer.force_draw(true); await get_tree().process_frame
	var rendered := viewport.get_texture().get_image()
	var corner := rendered.get_pixel(8, 8)
	var center := rendered.get_pixel(64, 64)
	var blurred_edge := rendered.get_pixel(44, 64)
	assert(corner.r < 0.5 and corner.g < 0.5 and corner.b < 0.6, "transparent shadow bounds must not become an opaque white rectangle: %s" % corner)
	assert(center.get_luminance() < corner.get_luminance() * 0.5, "four-pass blur must preserve the opaque shadow core: %s" % center)
	assert(blurred_edge.get_luminance() < corner.get_luminance() - 0.01, "four-pass BlurFilter edge must remain visible: %s" % blurred_edge)
	blur.destroy(); canvas.remove_child(shadow); shadow.free(); remove_child(viewport); viewport.free()
