class_name RuntimeBackgroundDebugFilter
extends RefCounted

const SHADER := preload("res://scripts/rendering/background_debug_filter.gdshader")

var material := ShaderMaterial.new()


static func warm_up_background_debug_gl_program_for_diagnostics() -> Shader:
	return SHADER


func _init() -> void:
	material.shader = SHADER
	var image := Image.create_empty(1, 1, false, Image.FORMAT_RGBA8)
	image.fill(Color.WHITE)
	var placeholder := ImageTexture.create_from_image(image)
	material.set_shader_parameter("depth_map", placeholder)
	material.set_shader_parameter("collision_map", placeholder)


func set_mode(mode: float) -> void:
	material.set_shader_parameter("mode", mode)


func get_mode() -> float:
	var value: Variant = material.get_shader_parameter("mode")
	return float(value) if value is int or value is float else 0.0


func load_scene_data(depth_texture: Texture2D, texture_width: float, texture_height: float, config: Dictionary) -> void:
	material.set_shader_parameter("depth_map", depth_texture)
	material.set_shader_parameter("texture_size", Vector2(texture_width, texture_height))
	var depth_mapping: Dictionary = config.depth_mapping
	material.set_shader_parameter("depth_invert", 1.0 if depth_mapping.invert else 0.0)
	material.set_shader_parameter("depth_scale", depth_mapping.scale)
	material.set_shader_parameter("depth_offset", depth_mapping.offset)
	var offset := float(depth_mapping.offset)
	var scale := float(depth_mapping.scale)
	var low := minf(offset, scale + offset)
	var high := maxf(offset, scale + offset)
	if low > high:
		var swap := low
		low = high
		high = swap
	var span := high - low
	var padding := maxf(maxf(span * 0.12, maxf(absf(scale), 0.000001) * 0.05), 0.001)
	var normalized_low := low - padding
	var normalized_high := high + padding
	if span < 0.00000001:
		normalized_low = offset - 1.0
		normalized_high = offset + 1.0
	if normalized_high - normalized_low < 0.000001:
		normalized_low -= 1.0
		normalized_high += 1.0
	material.set_shader_parameter("debug_depth_range", Vector2(normalized_low, normalized_high))
	var matrix: Dictionary = config.M
	material.set_shader_parameter("matrix_ppu", matrix.ppu)
	material.set_shader_parameter("matrix_cx", matrix.cx)
	material.set_shader_parameter("matrix_cy", matrix.cy)
	material.set_shader_parameter("matrix_r00", matrix.R[0][0])
	material.set_shader_parameter("matrix_r01", matrix.R[0][1])
	material.set_shader_parameter("matrix_r02", matrix.R[0][2])
	material.set_shader_parameter("matrix_r20", matrix.R[2][0])
	material.set_shader_parameter("matrix_r21", matrix.R[2][1])
	material.set_shader_parameter("matrix_r22", matrix.R[2][2])
	material.set_shader_parameter("floor_a", config.shader.floor_depth_A)
	material.set_shader_parameter("floor_b", config.shader.floor_depth_B)
	var collision: Variant = config.get("collision")
	if collision is Dictionary:
		material.set_shader_parameter("collision_x_min", collision.x_min)
		material.set_shader_parameter("collision_z_min", collision.z_min)
		material.set_shader_parameter("collision_cell_size", collision.cell_size)
		material.set_shader_parameter("collision_grid_width", collision.grid_width)
		material.set_shader_parameter("collision_grid_height", collision.grid_height)


func set_world_container_pos(x: float, y: float) -> void:
	material.set_shader_parameter("world_container_pos", Vector2(x, y))


func set_scene_size(width: float, height: float) -> void:
	material.set_shader_parameter("scene_size", Vector2(width, height))


func set_collision_texture(texture: Texture2D) -> void:
	material.set_shader_parameter("collision_map", texture)
