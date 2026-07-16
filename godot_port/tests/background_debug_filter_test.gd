extends SceneTree


func _init() -> void:
	var image := Image.create_empty(8, 8, false, Image.FORMAT_RGBA8)
	image.fill(Color.WHITE)
	var texture := ImageTexture.create_from_image(image)
	var config := {
		"depth_mapping": {"invert": true, "scale": 2.0, "offset": -1.0},
		"M": {"ppu": 409.0, "cx": 600.0, "cy": 448.0, "R": [[0.0, -0.53, -0.85], [0.0, 0.85, -0.53], [-1.0, 0.0, 0.0]]},
		"shader": {"floor_depth_A": -0.004, "floor_depth_B": 1.75},
		"collision": {"x_min": -1.4, "z_min": -1.5, "cell_size": 0.02, "grid_width": 8, "grid_height": 8},
	}
	assert(RuntimeBackgroundDebugFilter.warm_up_background_debug_gl_program_for_diagnostics() == RuntimeBackgroundDebugFilter.SHADER)
	var filter := RuntimeBackgroundDebugFilter.new()
	assert(filter.get_mode() == 0.0 and filter.material.get_shader_parameter("depth_map") is Texture2D and filter.material.get_shader_parameter("collision_map") is Texture2D)
	filter.load_scene_data(texture, 8.0, 8.0, config)
	assert(filter.material.get_shader_parameter("depth_map") == texture)
	assert(filter.material.get_shader_parameter("texture_size") == Vector2(8, 8))
	assert(filter.material.get_shader_parameter("depth_invert") == 1.0)
	assert(filter.material.get_shader_parameter("depth_scale") == 2.0 and filter.material.get_shader_parameter("depth_offset") == -1.0)
	assert(filter.material.get_shader_parameter("debug_depth_range").is_equal_approx(Vector2(-1.24, 1.24)))
	assert(filter.material.get_shader_parameter("matrix_ppu") == 409.0 and filter.material.get_shader_parameter("matrix_cx") == 600.0 and filter.material.get_shader_parameter("matrix_cy") == 448.0)
	assert(filter.material.get_shader_parameter("matrix_r00") == 0.0 and filter.material.get_shader_parameter("matrix_r21") == 0.0 and filter.material.get_shader_parameter("matrix_r22") == 0.0)
	assert(filter.material.get_shader_parameter("floor_a") == -0.004 and filter.material.get_shader_parameter("floor_b") == 1.75)
	assert(filter.material.get_shader_parameter("collision_x_min") == -1.4 and filter.material.get_shader_parameter("collision_grid_width") == 8.0)
	filter.set_world_container_pos(10.0, 20.0)
	filter.set_scene_size(700.0, 500.0)
	filter.set_collision_texture(texture)
	filter.set_mode(2.0)
	assert(filter.get_mode() == 2.0 and filter.material.get_shader_parameter("world_container_pos") == Vector2(10, 20))
	assert(filter.material.get_shader_parameter("scene_size") == Vector2(700, 500) and filter.material.get_shader_parameter("collision_map") == texture)

	print("BackgroundDebugFilter uniforms/depth-range/collision-projection engine translation test: PASS")
	quit(0)
