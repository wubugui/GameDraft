class_name RuntimeEntityLightingFilter
extends RefCounted

const SHADER := preload("res://scripts/rendering/entity_lighting_filter.gdshader")

static var _white_texture_cache: Texture2D = null

var _is_depth_occlusion := true
var material: ShaderMaterial = ShaderMaterial.new()
var destroyed := false


func _init(options: Dictionary) -> void:
	material.shader = SHADER
	var cfg: Variant = options.get("cfg")
	var depth_texture: Variant = options.get("depthTexture")
	var probe_source: Variant = options.get("probeSource")
	var light_env: Dictionary = options.get("lightEnv") if options.get("lightEnv") is Dictionary else {}
	var sample_lift_world := float(options.get("sampleLiftWorld", 0.0))
	var depth_on := cfg is Dictionary and depth_texture is Texture2D
	var depth_mapping: Dictionary = cfg.get("depth_mapping", {}) if cfg is Dictionary and cfg.get("depth_mapping") is Dictionary else {}
	var shader_config: Dictionary = cfg.get("shader", {}) if cfg is Dictionary and cfg.get("shader") is Dictionary else {}
	var key: Dictionary = light_env.get("key", {}) if light_env.get("key") is Dictionary else {}
	var ambient: Dictionary = light_env.get("ambient", {}) if light_env.get("ambient") is Dictionary else {}
	var ao: Dictionary = light_env.get("ao", {}) if light_env.get("ao") is Dictionary else {}

	material.set_shader_parameter("scene_size", Vector2.ZERO)
	material.set_shader_parameter("projection_scale", 1.0)
	material.set_shader_parameter("world_to_pixel_x", 1.0)
	material.set_shader_parameter("world_to_pixel_y", 1.0)
	material.set_shader_parameter("world_container_pos", Vector2.ZERO)
	material.set_shader_parameter("entity_foot_world_x", 0.0)
	material.set_shader_parameter("entity_foot_world_y", 0.0)
	material.set_shader_parameter("sample_lift_world", sample_lift_world)

	material.set_shader_parameter("depth_enabled", 1.0 if depth_on else 0.0)
	material.set_shader_parameter("depth_invert", 1.0 if depth_mapping.get("invert") == true else 0.0)
	material.set_shader_parameter("depth_scale", float(depth_mapping.get("scale", 1.0)))
	material.set_shader_parameter("depth_offset", float(depth_mapping.get("offset", 0.0)))
	material.set_shader_parameter("depth_per_sy", float(shader_config.get("depth_per_sy", 0.0)))
	material.set_shader_parameter("floor_a", float(shader_config.get("floor_depth_A", 0.0)))
	material.set_shader_parameter("floor_b", float(shader_config.get("floor_depth_B", 0.0)))
	material.set_shader_parameter("floor_offset", float(cfg.get("floor_offset", 0.0)) if cfg is Dictionary else 0.0)
	material.set_shader_parameter("floor_offset_extra", 0.0)
	material.set_shader_parameter("tolerance", float(cfg.get("depth_tolerance", 0.0)) if cfg is Dictionary else 0.0)
	material.set_shader_parameter("occlusion_blend_factor", 0.0)
	material.set_shader_parameter("debug_mode", 0.0)

	material.set_shader_parameter("key_color", _color_vec(key.get("color", [1.0, 1.0, 1.0])))
	material.set_shader_parameter("key_intensity", float(key.get("intensity", 1.0)))
	material.set_shader_parameter("ambient_color", _color_vec(ambient.get("color", [1.0, 1.0, 1.0])))
	material.set_shader_parameter("ambient_intensity", float(ambient.get("intensity", 1.0)))
	material.set_shader_parameter("tone_strength", float(light_env.get("toneStrength", 0.0)) if probe_source is Texture2D else 0.0)
	material.set_shader_parameter("ao_contact", float(ao.get("contact", 0.0)))
	material.set_shader_parameter("ao_form", float(ao.get("form", 0.0)))
	material.set_shader_parameter("depth_map", depth_texture if depth_texture is Texture2D else _white_texture())
	material.set_shader_parameter("probe_map", probe_source if probe_source is Texture2D else _white_texture())
	material.set_shader_parameter("pixel_blur_strength", 0.0)


static func create_for_entity(options: Dictionary) -> RuntimeEntityLightingFilter:
	return RuntimeEntityLightingFilter.new(options)


func set_scene_size(w: float, h: float) -> void:
	if material != null: material.set_shader_parameter("scene_size", Vector2(w, h))


func set_world_to_pixel(tx: float, ty: float) -> void:
	if material == null: return
	material.set_shader_parameter("world_to_pixel_x", tx)
	material.set_shader_parameter("world_to_pixel_y", ty)


func set_projection_scale(value: float) -> void:
	if material != null: material.set_shader_parameter("projection_scale", value)


func set_world_container_pos(x: float, y: float) -> void:
	if material != null: material.set_shader_parameter("world_container_pos", Vector2(x, y))


func set_entity_foot_y(world_y: float) -> void:
	if material != null: material.set_shader_parameter("entity_foot_world_y", world_y)


func set_entity_foot_x(world_x: float) -> void:
	if material != null: material.set_shader_parameter("entity_foot_world_x", world_x)


func set_floor_offset(value: float) -> void:
	if material != null: material.set_shader_parameter("floor_offset", value)


func set_floor_offset_extra(value: float) -> void:
	if material != null: material.set_shader_parameter("floor_offset_extra", value)


func set_tolerance(value: float) -> void:
	if material != null: material.set_shader_parameter("tolerance", value)


func set_occlusion_blend_factor(value: float) -> void:
	if material != null: material.set_shader_parameter("occlusion_blend_factor", clampf(value, 0.0, 1.0))


func set_tone(value: float) -> void:
	if material != null: material.set_shader_parameter("tone_strength", clampf(value, 0.0, 1.0))


func set_ao(contact: float, form: float) -> void:
	if material == null: return
	material.set_shader_parameter("ao_contact", clampf(contact, 0.0, 1.0))
	material.set_shader_parameter("ao_form", clampf(form, 0.0, 1.0))


func set_key_light(color: Array, intensity: float) -> void:
	if material == null: return
	material.set_shader_parameter("key_color", _color_vec(color))
	material.set_shader_parameter("key_intensity", intensity)


func set_ambient(color: Array, intensity: float) -> void:
	if material == null: return
	material.set_shader_parameter("ambient_color", _color_vec(color))
	material.set_shader_parameter("ambient_intensity", intensity)


func set_debug(on: bool) -> void:
	if material != null: material.set_shader_parameter("debug_mode", 1.0 if on else 0.0)


func set_collision_texture(_texture: Texture2D) -> void:
	return


func attach(target: CanvasItem) -> void:
	if target == null or material == null:
		return
	material.set_shader_parameter("canvas_group_target", 1.0 if target is CanvasGroup else 0.0)
	target.material = material


func destroy() -> void:
	destroyed = true
	material = null


static func _color_vec(value: Variant) -> Vector3:
	return Vector3(float(value[0]), float(value[1]), float(value[2])) if value is Array and value.size() >= 3 else Vector3.ONE


static func _white_texture() -> Texture2D:
	if _white_texture_cache == null:
		var image := Image.create_empty(1, 1, false, Image.FORMAT_RGBA8)
		image.fill(Color.WHITE)
		_white_texture_cache = ImageTexture.create_from_image(image)
	return _white_texture_cache
