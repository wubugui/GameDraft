class_name RuntimeSceneEntityFilterBinding
extends RefCounted

const META_KEY := &"gamedraft_scene_depth_filter"
const META_RENDER_TARGET_KEY := &"gamedraft_scene_depth_filter_render_target"


static func attach(target: CanvasItem, filter: Variant, render_target: CanvasItem = null) -> void:
	if target == null or filter == null:
		return
	var drawable := render_target if render_target != null else target
	target.set_meta(META_KEY, filter)
	target.set_meta(META_RENDER_TARGET_KEY, drawable)
	filter.attach(drawable)


static func get_filter(target: CanvasItem) -> Variant:
	return target.get_meta(META_KEY) if target != null and target.has_meta(META_KEY) else null


static func detach(target: CanvasItem) -> Variant:
	if target == null:
		return null
	var filter: Variant = target.get_meta(META_KEY) if target.has_meta(META_KEY) else null
	var drawable: Variant = target.get_meta(META_RENDER_TARGET_KEY) if target.has_meta(META_RENDER_TARGET_KEY) else target
	if filter != null and drawable is CanvasItem and drawable.material == filter.material:
		drawable.material = null
	if target.has_meta(META_KEY):
		target.remove_meta(META_KEY)
	if target.has_meta(META_RENDER_TARGET_KEY):
		target.remove_meta(META_RENDER_TARGET_KEY)
	return filter


static func get_render_target(target: CanvasItem) -> Variant:
	return target.get_meta(META_RENDER_TARGET_KEY) if target != null and target.has_meta(META_RENDER_TARGET_KEY) else target


static func configure_combined_pixel_blur(filter: Variant, texture: Texture2D, world_size: Vector2, pixel_match: bool, blur_scale: float, world_to_pixel: Vector2, projection_scale: float) -> void:
	if filter == null:
		return
	var frame_size := _texture_frame_size(texture)
	var density_k := RuntimeEntityPixelDensityMatch.compute_pixel_density_k(frame_size.x, frame_size.y, world_size.x, world_size.y, world_to_pixel) if pixel_match else 1.0
	var blur_radius := _blur_radius_texels(density_k, blur_scale, frame_size, world_size, projection_scale)
	filter.material.set_shader_parameter("pixel_blur_strength", blur_radius)


static func sync_sprite_entity_pixel_density_match(
	target: CanvasItem,
	entity: RuntimeSpriteEntity,
	filter: Variant,
	background_density: Variant,
	enabled: bool,
	blur_scale: float,
	projection_scale: float,
) -> void:
	if entity == null:
		return
	entity.set_pixel_density_match_active(enabled)
	entity.apply_pixel_density_match(background_density, blur_scale)
	if filter == null:
		return
	var density := Vector2(
		float(background_density.get("x", 0.0)),
		float(background_density.get("y", 0.0)),
	) if background_density is Dictionary else (background_density as Vector2 if background_density is Vector2 else Vector2.ZERO)
	var size := entity.get_world_size()
	configure_combined_pixel_blur(
		filter,
		entity.get_display_texture(),
		Vector2(float(size.width), float(size.height)),
		enabled,
		blur_scale,
		density,
		projection_scale,
	)
	# The translated Pixi graph owns two ordered filters. Godot's drawable has
	# one material slot, so the engine adapter folds BlurFilter into the entity
	# shader and restores that material after SpriteEntity updated its own state.
	filter.attach(entity.sprite)
	entity._unmount_pixel_density_blur()
	if target != null:
		target.set_meta(META_RENDER_TARGET_KEY, entity.sprite)


static func _blur_radius_texels(density_k: float, strength_scale: float, frame_size: Vector2, world_size: Vector2, projection_scale: float) -> float:
	var source_per_screen := maxf(frame_size.x / maxf(1.0, world_size.x * projection_scale), frame_size.y / maxf(1.0, world_size.y * projection_scale))
	return RuntimeEntityPixelDensityMatch.blur_strength_from_pixel_density_k(density_k, strength_scale) * source_per_screen


static func _texture_frame_size(texture: Variant) -> Vector2:
	if not texture is Texture2D:
		return Vector2.ONE
	if texture is AtlasTexture:
		return texture.region.size
	return Vector2(texture.get_width(), texture.get_height())
