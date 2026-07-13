class_name RuntimeEntityPixelDensityMatch
extends RefCounted

const DEFAULT_BLUR_SCALE := 0.25
const BLUR_STRENGTH_CAP := 12.0


static func compute_k(frame_width: float, frame_height: float, world_width: float, world_height: float, background_density: Vector2) -> float:
	if world_width <= 0.0 or world_height <= 0.0 or background_density.x <= 0.0 or background_density.y <= 0.0:
		return 1.0
	var entity_x := frame_width / world_width
	var entity_y := frame_height / world_height
	return maxf(1.0, maxf(entity_x / background_density.x, entity_y / background_density.y))


static func blur_strength(k: float, strength_scale := 1.0) -> float:
	if k <= 1.0:
		return 0.0
	var scale := strength_scale if is_finite(strength_scale) and strength_scale > 0.0 else 1.0
	return minf(BLUR_STRENGTH_CAP, 0.18 * sqrt(k - 1.0) * scale)


static func blur_radius_texels(k: float, strength_scale: float, frame_size: Vector2, world_size: Vector2, projection_scale: float) -> float:
	var source_per_screen := maxf(frame_size.x / maxf(1.0, world_size.x * projection_scale), frame_size.y / maxf(1.0, world_size.y * projection_scale))
	return blur_strength(k, strength_scale) * source_per_screen


static func texture_frame_size(texture: Variant) -> Vector2:
	if not texture is Texture2D:
		return Vector2.ONE
	if texture is AtlasTexture:
		return texture.region.size
	return Vector2(texture.get_width(), texture.get_height())
