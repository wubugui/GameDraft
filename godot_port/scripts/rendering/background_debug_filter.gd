class_name RuntimeBackgroundDebugFilter
extends RefCounted

const SHADER := preload("res://scripts/rendering/background_debug_filter.gdshader")
var material := ShaderMaterial.new()


func _init() -> void: material.shader = SHADER
func set_mode(value: float) -> void: material.set_shader_parameter("mode", value)
func get_mode() -> float: return float(material.get_shader_parameter("mode"))
func set_collision_texture(texture: Texture2D) -> void: material.set_shader_parameter("collision_map", texture)
func attach(target: CanvasItem) -> void: if target != null: target.material = material


func load_scene_data(depth_texture: Texture2D, width: float, height: float, cfg: Dictionary) -> void:
	material.set_shader_parameter("depth_map", depth_texture)
	material.set_shader_parameter("texture_size", Vector2(width, height))
	var mapping: Variant = cfg.get("depth_mapping", {})
	var invert: bool = mapping is Dictionary and mapping.get("invert") == true
	var scale := float(mapping.get("scale", 1.0)) if mapping is Dictionary else 1.0
	var offset := float(mapping.get("offset", 0.0)) if mapping is Dictionary else 0.0
	material.set_shader_parameter("depth_invert", 1.0 if invert else 0.0)
	material.set_shader_parameter("depth_scale", scale); material.set_shader_parameter("depth_offset", offset)
	var lo := minf(offset, offset + scale); var hi := maxf(offset, offset + scale); var span := hi - lo
	var pad := maxf(maxf(span * 0.12, absf(scale) * 0.05), 0.001)
	if span < 0.00000001: lo = offset - 1.0; hi = offset + 1.0
	else: lo -= pad; hi += pad
	material.set_shader_parameter("debug_depth_range", Vector2(lo, hi))
