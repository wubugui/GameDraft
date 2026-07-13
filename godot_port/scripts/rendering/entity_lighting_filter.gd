class_name RuntimeEntityLightingFilter
extends RefCounted

const SHADER := preload("res://scripts/rendering/entity_lighting_filter.gdshader")
var material := ShaderMaterial.new()


func _init(options: Dictionary = {}) -> void:
	material.shader = SHADER
	for key: String in options: material.set_shader_parameter(key, options[key])


static func create_for_entity(options: Dictionary = {}) -> RuntimeEntityLightingFilter: return RuntimeEntityLightingFilter.new(options)
func attach(target: CanvasItem) -> void: if target != null: target.material = material
func set_scene_size(w: float, h: float) -> void: material.set_shader_parameter("scene_size", Vector2(w, h))
func set_world_to_pixel(_x: float, y: float) -> void: material.set_shader_parameter("world_to_pixel_y", y)
# Godot reconstructs world position from local UV and entity world size, so the
# Pixi screen-to-world uniforms do not have shader state to update here.
func set_projection_scale(_value: float) -> void: return
func set_world_container_pos(_x: float, _y: float) -> void: return
func set_entity_foot_x(value: float) -> void: material.set_shader_parameter("entity_foot_x", value)
func set_entity_foot_y(value: float) -> void: material.set_shader_parameter("entity_foot_y", value)
func set_floor_offset(value: float) -> void: material.set_shader_parameter("floor_offset", value)
func set_floor_offset_extra(value: float) -> void: material.set_shader_parameter("floor_offset_extra", value)
func set_tolerance(value: float) -> void: material.set_shader_parameter("tolerance", value)
func set_occlusion_blend_factor(value: float) -> void: material.set_shader_parameter("occlusion_blend_factor", clampf(value, 0.0, 1.0))
func set_tone(value: float) -> void: material.set_shader_parameter("tone_strength", clampf(value, 0.0, 1.0))
func set_ao(contact: float, form: float) -> void: material.set_shader_parameter("ao_contact", clampf(contact, 0.0, 1.0)); material.set_shader_parameter("ao_form", clampf(form, 0.0, 1.0))
func set_key_light(color: Array, intensity: float) -> void: material.set_shader_parameter("key_color", _color_vec(color)); material.set_shader_parameter("key_intensity", intensity)
func set_ambient(color: Array, intensity: float) -> void: material.set_shader_parameter("ambient_color", _color_vec(color)); material.set_shader_parameter("ambient_intensity", intensity)
func set_debug(value: bool) -> void: material.set_shader_parameter("debug_mode", 1.0 if value else 0.0)
# Matches the source filter: collision belongs to depth debug, not lighting.
func set_collision_texture(_texture: Texture2D) -> void: return
func _color_vec(value: Array) -> Vector3: return Vector3(float(value[0]), float(value[1]), float(value[2])) if value.size() >= 3 else Vector3.ONE
