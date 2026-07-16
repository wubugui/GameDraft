class_name RuntimeEntityPixelDensityMatch
extends RefCounted

const PIXEL_DENSITY_BLUR_SHADER := preload("res://scripts/rendering/pixel_density_blur.gdshader")
const DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE := 0.25


static func compute_pixel_density_k(
	frame_width: float,
	frame_height: float,
	world_width: float,
	world_height: float,
	background_density: Vector2,
) -> float:
	if world_width <= 0.0 or world_height <= 0.0 or background_density.x <= 0.0 or background_density.y <= 0.0:
		return 1.0
	var entity_density_x := frame_width / world_width
	var entity_density_y := frame_height / world_height
	var density_ratio_x := entity_density_x / background_density.x
	var density_ratio_y := entity_density_y / background_density.y
	return maxf(1.0, maxf(density_ratio_x, density_ratio_y))


const BLUR_STRENGTH_CAP := 12.0


static func blur_strength_from_pixel_density_k(density_k: float, strength_scale := 1.0) -> float:
	if density_k <= 1.0:
		return 0.0
	var scale := strength_scale if is_finite(strength_scale) and strength_scale > 0.0 else 1.0
	var excess := density_k - 1.0
	var curve_constant := 0.18
	var strength := curve_constant * sqrt(excess) * scale
	return minf(BLUR_STRENGTH_CAP, strength)


static func create_pixel_density_blur_filter(initial_strength: float) -> RefCounted:
	var strength := maxf(0.0, initial_strength)
	return _BlurFilterAdapter.new(strength, PIXEL_DENSITY_BLUR_SHADER)


class _BlurFilterAdapter:
	extends RefCounted

	var strength: float:
		set(value):
			strength = value
			if material != null:
				material.set_shader_parameter("strength", value)
	var quality := 3
	var material: ShaderMaterial
	var destroyed := false


	func _init(initial_strength: float, shader: Shader) -> void:
		material = ShaderMaterial.new()
		material.shader = shader
		strength = initial_strength


	func destroy() -> void:
		if destroyed:
			return
		destroyed = true
		material = null
