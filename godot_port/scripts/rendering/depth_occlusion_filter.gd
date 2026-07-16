class_name RuntimeDepthOcclusionFilter
extends RefCounted

const SHADER := preload("res://scripts/rendering/depth_occlusion.gdshader")

var _is_depth_occlusion := true
var material: ShaderMaterial = ShaderMaterial.new()
var destroyed := false


func _init(depth_texture: Texture2D, cfg: Dictionary) -> void:
	material.shader = SHADER
	var depth_mapping: Dictionary = cfg.get("depth_mapping", {})
	var shader_config: Dictionary = cfg.get("shader", {})
	var matrix: Dictionary = cfg.get("M", {})
	var rows: Array = matrix.get("R", [])
	var row0: Array = rows[0] if rows.size() > 0 and rows[0] is Array else []
	var row2: Array = rows[2] if rows.size() > 2 and rows[2] is Array else []
	var collision: Dictionary = cfg.get("collision", {}) if cfg.get("collision") is Dictionary else {}
	material.set_shader_parameter("scene_size", Vector2.ZERO)
	material.set_shader_parameter("projection_scale", 1.0)
	material.set_shader_parameter("world_to_pixel_x", 1.0)
	material.set_shader_parameter("world_to_pixel_y", 1.0)
	material.set_shader_parameter("depth_invert", 1.0 if depth_mapping.get("invert") == true else 0.0)
	material.set_shader_parameter("depth_scale", float(depth_mapping.get("scale", 1.0)))
	material.set_shader_parameter("depth_offset", float(depth_mapping.get("offset", 0.0)))
	material.set_shader_parameter("depth_per_sy", float(shader_config.get("depth_per_sy", 0.0)))
	material.set_shader_parameter("floor_a", float(shader_config.get("floor_depth_A", 0.0)))
	material.set_shader_parameter("floor_b", float(shader_config.get("floor_depth_B", 0.0)))
	material.set_shader_parameter("floor_offset", float(cfg.get("floor_offset", 0.0)))
	material.set_shader_parameter("floor_offset_extra", 0.0)
	material.set_shader_parameter("tolerance", float(cfg.get("depth_tolerance", 0.0)))
	material.set_shader_parameter("world_container_pos", Vector2.ZERO)
	material.set_shader_parameter("entity_foot_world_y", 0.0)
	material.set_shader_parameter("debug_mode", 0.0)
	material.set_shader_parameter("occlusion_blend_factor", 0.0)
	material.set_shader_parameter("matrix_ppu", float(matrix.get("ppu", 1.0)))
	material.set_shader_parameter("matrix_cx", float(matrix.get("cx", 0.0)))
	material.set_shader_parameter("matrix_cy", float(matrix.get("cy", 0.0)))
	material.set_shader_parameter("matrix_row0", _row3(row0))
	material.set_shader_parameter("matrix_row2", _row3(row2))
	material.set_shader_parameter("collision_x_min", float(collision.get("x_min", 0.0)))
	material.set_shader_parameter("collision_z_min", float(collision.get("z_min", 0.0)))
	material.set_shader_parameter("collision_cell_size", float(collision.get("cell_size", 1.0)))
	material.set_shader_parameter("collision_grid_width", float(collision.get("grid_width", 0.0)))
	material.set_shader_parameter("collision_grid_height", float(collision.get("grid_height", 0.0)))
	material.set_shader_parameter("depth_map", depth_texture)
	material.set_shader_parameter("collision_map", depth_texture)
	material.set_shader_parameter("pixel_blur_strength", 0.0)


static func warm_up_depth_occlusion_gl_program_for_diagnostics() -> Shader:
	return SHADER


static func create_for_entity(depth_texture: Texture2D, cfg: Dictionary) -> RuntimeDepthOcclusionFilter:
	return RuntimeDepthOcclusionFilter.new(depth_texture, cfg)


func set_scene_size(w: float, h: float) -> void:
	if material != null: material.set_shader_parameter("scene_size", Vector2(w, h))


func set_world_container_pos(x: float, y: float) -> void:
	if material != null: material.set_shader_parameter("world_container_pos", Vector2(x, y))


func set_projection_scale(value: float) -> void:
	if material != null: material.set_shader_parameter("projection_scale", value)


func set_world_to_pixel(tx: float, ty: float) -> void:
	if material == null: return
	material.set_shader_parameter("world_to_pixel_x", tx)
	material.set_shader_parameter("world_to_pixel_y", ty)


func set_entity_foot_y(world_y: float) -> void:
	if material != null: material.set_shader_parameter("entity_foot_world_y", world_y)


func set_tolerance(value: float) -> void:
	if material != null: material.set_shader_parameter("tolerance", value)


func set_floor_offset(value: float) -> void:
	if material != null: material.set_shader_parameter("floor_offset", value)


func set_floor_offset_extra(value: float) -> void:
	if material != null: material.set_shader_parameter("floor_offset_extra", value)


func set_debug(on: bool) -> void:
	if material != null: material.set_shader_parameter("debug_mode", 1.0 if on else 0.0)


func set_collision_texture(texture: Texture2D) -> void:
	if material != null: material.set_shader_parameter("collision_map", texture)


func set_occlusion_blend_factor(value: float) -> void:
	if material != null: material.set_shader_parameter("occlusion_blend_factor", clampf(value, 0.0, 1.0))


func attach(target: CanvasItem) -> void:
	if target == null or material == null:
		return
	material.set_shader_parameter("canvas_group_target", 1.0 if target is CanvasGroup else 0.0)
	target.material = material


func destroy() -> void:
	destroyed = true
	material = null


static func _row3(row: Array) -> Vector3:
	return Vector3(float(row[0]), float(row[1]), float(row[2])) if row.size() >= 3 else Vector3.ZERO
