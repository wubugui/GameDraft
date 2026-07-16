extends SceneTree


func _initialize() -> void:
	call_deferred("_run")


func _run() -> void:
	var depth_image := Image.create_empty(8, 8, false, Image.FORMAT_RGBA8)
	depth_image.fill(Color.WHITE)
	var depth_texture := ImageTexture.create_from_image(depth_image)
	var probe_image := Image.create_empty(8, 8, false, Image.FORMAT_RGBA8)
	probe_image.fill(Color(1, 0, 0, 1))
	var probe_texture := ImageTexture.create_from_image(probe_image)
	var cfg := {
		"depth_mapping": {"invert": true, "scale": 2.0, "offset": -1.0},
		"shader": {"depth_per_sy": 0.01, "floor_depth_A": -0.004, "floor_depth_B": 1.75},
		"floor_offset": 0.2,
		"depth_tolerance": 0.05,
		"M": {"ppu": 409.0, "cx": 600.0, "cy": 448.0, "R": [[1.0, 2.0, 3.0], [0.0, 1.0, 0.0], [4.0, 5.0, 6.0]]},
		"collision": {"x_min": -1.4, "z_min": -1.5, "cell_size": 0.02, "grid_width": 8, "grid_height": 9},
	}

	var depth := RuntimeDepthOcclusionFilter.create_for_entity(depth_texture, cfg)
	assert(depth._is_depth_occlusion and depth.material.shader == RuntimeDepthOcclusionFilter.SHADER)
	assert(depth.material.get_shader_parameter("depth_map") == depth_texture)
	assert(depth.material.get_shader_parameter("collision_map") == depth_texture)
	assert(depth.material.get_shader_parameter("matrix_row0") == Vector3(1, 2, 3))
	assert(depth.material.get_shader_parameter("matrix_row2") == Vector3(4, 5, 6))
	assert(not depth.has_method("set_entity_foot_x"), "DepthOcclusionFilter must preserve the optional foot-X surface")
	depth.set_scene_size(128, 96)
	depth.set_world_container_pos(10, 20)
	depth.set_projection_scale(2)
	depth.set_world_to_pixel(3, 4)
	depth.set_entity_foot_y(50)
	depth.set_tolerance(0.2)
	depth.set_floor_offset(0.3)
	depth.set_floor_offset_extra(0.4)
	depth.set_debug(true)
	depth.set_collision_texture(probe_texture)
	depth.set_occlusion_blend_factor(2.0)
	assert(depth.material.get_shader_parameter("scene_size") == Vector2(128, 96))
	assert(depth.material.get_shader_parameter("world_container_pos") == Vector2(10, 20))
	assert(depth.material.get_shader_parameter("projection_scale") == 2.0)
	assert(depth.material.get_shader_parameter("world_to_pixel_x") == 3.0 and depth.material.get_shader_parameter("world_to_pixel_y") == 4.0)
	assert(depth.material.get_shader_parameter("entity_foot_world_y") == 50.0)
	assert(depth.material.get_shader_parameter("tolerance") == 0.2 and depth.material.get_shader_parameter("floor_offset") == 0.3 and depth.material.get_shader_parameter("floor_offset_extra") == 0.4)
	assert(depth.material.get_shader_parameter("debug_mode") == 1.0 and depth.material.get_shader_parameter("collision_map") == probe_texture and depth.material.get_shader_parameter("occlusion_blend_factor") == 1.0)

	var light_env := {
		"key": {"color": [1.0, 0.8, 0.6], "intensity": 0.7},
		"ambient": {"color": [0.3, 0.4, 0.5], "intensity": 0.8},
		"toneStrength": 0.6,
		"ao": {"contact": 0.2, "form": 0.1},
	}
	var lighting := RuntimeEntityLightingFilter.create_for_entity({
		"depthTexture": depth_texture,
		"cfg": cfg,
		"probeSource": probe_texture,
		"lightEnv": light_env,
		"sampleLiftWorld": 24.0,
	})
	assert(lighting._is_depth_occlusion and lighting.material.shader == RuntimeEntityLightingFilter.SHADER)
	assert(lighting.material.get_shader_parameter("depth_enabled") == 1.0)
	assert(lighting.material.get_shader_parameter("depth_map") == depth_texture and lighting.material.get_shader_parameter("probe_map") == probe_texture)
	assert(lighting.material.get_shader_parameter("sample_lift_world") == 24.0 and lighting.material.get_shader_parameter("tone_strength") == 0.6)
	assert(lighting.material.get_shader_parameter("ao_contact") == 0.2 and lighting.material.get_shader_parameter("ao_form") == 0.1)
	lighting.set_scene_size(128, 128)
	lighting.set_world_to_pixel(2, 3)
	lighting.set_projection_scale(1.5)
	lighting.set_world_container_pos(4, 5)
	lighting.set_entity_foot_y(80)
	lighting.set_entity_foot_x(40)
	lighting.set_floor_offset(-0.2)
	lighting.set_floor_offset_extra(0.1)
	lighting.set_tolerance(0.15)
	lighting.set_occlusion_blend_factor(-1.0)
	lighting.set_tone(2.0)
	lighting.set_ao(-1.0, 2.0)
	lighting.set_key_light([0.1, 0.2, 0.3], 0.4)
	lighting.set_ambient([0.5, 0.6, 0.7], 0.8)
	lighting.set_debug(true)
	assert(lighting.material.get_shader_parameter("world_to_pixel_x") == 2.0 and lighting.material.get_shader_parameter("world_to_pixel_y") == 3.0)
	assert(lighting.material.get_shader_parameter("projection_scale") == 1.5 and lighting.material.get_shader_parameter("world_container_pos") == Vector2(4, 5))
	assert(lighting.material.get_shader_parameter("entity_foot_world_y") == 80.0 and lighting.material.get_shader_parameter("entity_foot_world_x") == 40.0)
	assert(lighting.material.get_shader_parameter("occlusion_blend_factor") == 0.0 and lighting.material.get_shader_parameter("tone_strength") == 1.0)
	assert(lighting.material.get_shader_parameter("ao_contact") == 0.0 and lighting.material.get_shader_parameter("ao_form") == 1.0)
	assert(lighting.material.get_shader_parameter("key_color") == Vector3(0.1, 0.2, 0.3) and lighting.material.get_shader_parameter("ambient_color") == Vector3(0.5, 0.6, 0.7))
	assert(lighting.material.get_shader_parameter("debug_mode") == 1.0)

	if DisplayServer.get_name() != "headless":
		var white_image := Image.create_empty(32, 32, false, Image.FORMAT_RGBA8)
		white_image.fill(Color.WHITE)
		var sprite := Sprite2D.new()
		sprite.centered = false
		sprite.position = Vector2(32, 32)
		sprite.texture = ImageTexture.create_from_image(white_image)
		root.add_child(sprite)
		var tone_filter := RuntimeEntityLightingFilter.create_for_entity({
			"depthTexture": null,
			"cfg": null,
			"probeSource": probe_texture,
			"lightEnv": {"key": {"color": [0.0, 0.0, 0.0], "intensity": 0.0}, "ambient": {"color": [1.0, 1.0, 1.0], "intensity": 1.0}, "toneStrength": 1.0, "ao": {"contact": 0.0, "form": 0.0}},
			"sampleLiftWorld": 0.0,
		})
		tone_filter.set_scene_size(128, 128)
		tone_filter.set_entity_foot_x(48)
		tone_filter.set_entity_foot_y(64)
		tone_filter.attach(sprite)
		RenderingServer.force_draw(true)
		await process_frame
		RenderingServer.force_draw(true)
		var rendered := root.get_texture().get_image().get_pixel(48, 48)
		assert(rendered.r > 0.9 and rendered.g < 0.65 and rendered.b < 0.65, "probe tone pass must execute on the rendered entity")

		var group := CanvasGroup.new()
		var group_swatch := ColorRect.new()
		group_swatch.position = Vector2(80, 32)
		group_swatch.size = Vector2(32, 32)
		group_swatch.color = Color.WHITE
		group.add_child(group_swatch)
		root.add_child(group)
		var group_filter := RuntimeEntityLightingFilter.create_for_entity({
			"depthTexture": null,
			"cfg": null,
			"probeSource": probe_texture,
			"lightEnv": {"key": {"color": [0.0, 0.0, 0.0], "intensity": 0.0}, "ambient": {"color": [1.0, 1.0, 1.0], "intensity": 1.0}, "toneStrength": 1.0, "ao": {"contact": 0.0, "form": 0.0}},
			"sampleLiftWorld": 0.0,
		})
		group_filter.set_scene_size(128, 128)
		group_filter.set_entity_foot_x(96)
		group_filter.set_entity_foot_y(64)
		group_filter.attach(group)
		assert(group.material == group_filter.material and group_filter.material.get_shader_parameter("canvas_group_target") == 1.0)
		RenderingServer.force_draw(true)
		await process_frame
		RenderingServer.force_draw(true)
		var group_rendered := root.get_texture().get_image().get_pixel(96, 48)
		assert(group_rendered.r > 0.9 and group_rendered.g < 0.65 and group_rendered.b < 0.65, "CanvasGroup entity filter must sample the translated outer-container pass")
		root.remove_child(sprite)
		sprite.free()
		tone_filter.destroy()
		root.remove_child(group)
		group.free()
		group_filter.destroy()

	depth.destroy()
	lighting.destroy()
	assert(depth.destroyed and depth.material == null and lighting.destroyed and lighting.material == null)
	print("DepthOcclusion/EntityLighting direct-class/uniform/shader test: PASS")
	quit(0)
