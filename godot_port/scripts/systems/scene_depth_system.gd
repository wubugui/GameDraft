class_name RuntimeSceneDepthSystem
extends RuntimeSystem

const DEPTH_SHADER := preload("res://scripts/rendering/depth_occlusion.gdshader")

var asset_manager: RuntimeAssetManager
var scene_manager: RuntimeSceneManager
var player: RuntimePlayer
var enabled := false
var config: Dictionary = {}
var depth_texture: Texture2D
var collision_texture: Texture2D
var collision_image: Image
var scene_id := ""
var scene_size := Vector2.ONE
var world_to_pixel := Vector2.ONE
var depth_tolerance := 0.0
var floor_offset := 0.0
var occlusion_blend_factor := 0.28
var debug_mode := false
var lighting_enabled := false
var light_env: Dictionary = {}
var light_curve: Variant = null
var probe_texture: Texture2D
var pixel_density_match_enabled := false
var pixel_density_match_blur_scale := RuntimeEntityPixelDensityMatch.DEFAULT_BLUR_SCALE
var _lighting_config: Dictionary = {}
var _plane_light_override := false
var _condition_evaluator := Callable()
var _records: Dictionary = {}
var _shadow_records: Dictionary = {}
var _destroyed := false


func init(ctx: Dictionary) -> void:
	asset_manager = ctx.get("assetManager")


func bind_runtime(scenes: RuntimeSceneManager, next_player: RuntimePlayer, evaluate_conditions: Callable = Callable()) -> void:
	scene_manager = scenes
	player = next_player
	_condition_evaluator = evaluate_conditions
	if player != null:
		player.set_depth_collision(Callable(self, "is_collision"))


func load_scene(next_scene_id: String, scene: Dictionary, first_background: Texture2D = null) -> bool:
	unload()
	_configure_lighting(scene, first_background)
	var raw: Variant = scene.get("depthConfig")
	if not raw is Dictionary:
		scene_id = next_scene_id
		scene_size = Vector2(maxf(1.0, float(scene.get("worldWidth", 1.0))), maxf(1.0, float(scene.get("worldHeight", 1.0))))
		world_to_pixel = Vector2(first_background.get_width() / scene_size.x, first_background.get_height() / scene_size.y) if first_background != null else Vector2.ONE
		return lighting_enabled or pixel_density_match_enabled
	config = raw.duplicate(true)
	scene_id = next_scene_id
	scene_size = Vector2(maxf(1.0, float(scene.get("worldWidth", 1.0))), maxf(1.0, float(scene.get("worldHeight", 1.0))))
	if first_background != null:
		world_to_pixel = Vector2(first_background.get_width() / scene_size.x, first_background.get_height() / scene_size.y)
	else:
		world_to_pixel = Vector2.ONE
	var depth_path := asset_manager.locator.scene_runtime_asset_url(next_scene_id, str(config.get("depth_map", "")))
	var loaded_depth: Variant = asset_manager.load_texture(depth_path)
	if not loaded_depth is Texture2D:
		config.clear()
		return lighting_enabled or pixel_density_match_enabled
	depth_texture = loaded_depth
	var collision_name := str(config.get("collision_map", "")).strip_edges()
	if not collision_name.is_empty():
		var loaded_collision: Variant = asset_manager.load_texture(asset_manager.locator.scene_runtime_asset_url(next_scene_id, collision_name))
		if loaded_collision is Texture2D:
			collision_texture = loaded_collision
			collision_image = collision_texture.get_image()
	depth_tolerance = float(config.get("depth_tolerance", 0.0))
	floor_offset = float(config.get("floor_offset", 0.0))
	enabled = true
	return enabled or lighting_enabled or pixel_density_match_enabled


func unload() -> void:
	for record: Variant in _records.values():
		if not record is Dictionary:
			continue
		var sprite: Variant = record.get("sprite")
		if is_instance_valid(sprite) and sprite is Sprite2D and sprite.material == record.get("material"):
			sprite.material = record.get("previous")
	_records.clear()
	for shadow: Variant in _shadow_records.values():
		if shadow != null and shadow.has_method("destroy"): shadow.destroy()
	_shadow_records.clear()
	enabled = false
	lighting_enabled = false
	light_env.clear()
	light_curve = null
	_lighting_config.clear()
	_plane_light_override = false
	pixel_density_match_enabled = false
	pixel_density_match_blur_scale = RuntimeEntityPixelDensityMatch.DEFAULT_BLUR_SCALE
	probe_texture = null
	config.clear()
	depth_texture = null
	collision_texture = null
	collision_image = null
	scene_id = ""
	scene_size = Vector2.ONE
	world_to_pixel = Vector2.ONE


func set_floor_offset(value: float) -> void:
	if not is_finite(value):
		return
	floor_offset = value
	_broadcast_uniform("floor_offset", value)
	_broadcast_shadow_depth()


func reset_floor_offset() -> void:
	set_floor_offset(float(config.get("floor_offset", 0.0)))


func set_depth_tolerance(value: float) -> void:
	if not is_finite(value):
		return
	depth_tolerance = value
	_broadcast_uniform("tolerance", value)
	_broadcast_shadow_depth()


func set_occlusion_blend_factor(value: float) -> void:
	occlusion_blend_factor = clampf(value, 0.0, 1.0)
	_broadcast_uniform("occlusion_blend_factor", occlusion_blend_factor)
	_broadcast_shadow_depth()


func set_debug_mode(value: bool) -> void:
	debug_mode = value
	_broadcast_uniform("debug_mode", 1.0 if value else 0.0)


func apply_light_env_override(partial: Variant = null) -> void:
	if not lighting_enabled or asset_manager == null: return
	var game_config: Variant = asset_manager.load_json("/assets/data/game_config.json")
	var lighting: Dictionary = game_config.get("entityLighting", {}) if game_config is Dictionary and game_config.get("entityLighting") is Dictionary else {}
	_plane_light_override = partial is Dictionary
	var scene_env: Variant = partial if _plane_light_override else (scene_manager.get_current_scene_data().get("lightEnv", {}) if scene_manager != null else {})
	_apply_resolved_light_env(_resolve_light_env(scene_env, lighting))


func is_collision(world_x: float, world_y: float) -> bool:
	if not enabled or collision_image == null or config.is_empty():
		return false
	var matrix: Variant = config.get("M")
	var collision: Variant = config.get("collision")
	var shader: Variant = config.get("shader")
	if not matrix is Dictionary or not collision is Dictionary or not shader is Dictionary or not matrix.get("R") is Array or matrix.R.size() < 3:
		return false
	var sx := world_x * world_to_pixel.x
	var sy := world_y * world_to_pixel.y
	var floor_depth := float(shader.get("floor_depth_A", 0.0)) * sy + float(shader.get("floor_depth_B", 0.0))
	var ppu := maxf(0.000001, float(matrix.get("ppu", 1.0)))
	var px := (sx - float(matrix.get("cx", 0.0))) / ppu
	var py := (float(matrix.get("cy", 0.0)) - sy) / ppu
	var row0: Array = matrix.R[0]
	var row2: Array = matrix.R[2]
	if row0.size() < 3 or row2.size() < 3:
		return false
	var wx := float(row0[0]) * px + float(row0[1]) * py + float(row0[2]) * floor_depth
	var wz := float(row2[0]) * px + float(row2[1]) * py + float(row2[2]) * floor_depth
	var cell := maxf(0.000001, float(collision.get("cell_size", 1.0)))
	var gx := int(floor((wx - float(collision.get("x_min", 0.0))) / cell))
	var gz := int(floor((wz - float(collision.get("z_min", 0.0))) / cell))
	var grid_w := int(collision.get("grid_width", collision_image.get_width()))
	var grid_h := int(collision.get("grid_height", collision_image.get_height()))
	if gx < 0 or gx >= grid_w or gz < 0 or gz >= grid_h or gx >= collision_image.get_width() or gz >= collision_image.get_height():
		return false
	return collision_image.get_pixel(gx, gz).r > 0.5


func update(_dt: float) -> void:
	if (not enabled and not lighting_enabled and not pixel_density_match_enabled) or scene_manager == null or player == null:
		return
	_update_light_curve()
	_update_sprite_entity("player", player.sprite, player.get_x(), player.get_y(), _resolve_floor_boost(player.get_x(), player.get_y()), true)
	for npc: RuntimeNpc in scene_manager.get_current_npcs():
		if npc.sprite != null:
			_update_sprite_entity("npc:%s" % npc.get_id(), npc.sprite, npc.get_x(), npc.get_y(), _resolve_floor_boost(npc.get_x(), npc.get_y()), npc.def.get("castShadow") != false, npc.def.get("renderRaw") != true)
	for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():
		if hotspot.display_sprite != null and hotspot.has_depth_display_image():
			var size := hotspot.get_world_size()
			_update_sprite("hotspot:%s" % hotspot.get_id(), hotspot.display_sprite, Vector2(float(size.width), float(size.height)), hotspot.get_center_x(), hotspot.depth_occlusion_foot_world_y(), hotspot.get_facing(), _resolve_floor_boost(hotspot.get_center_x(), hotspot.depth_occlusion_foot_world_y()), hotspot.def.get("castShadow") != false, true, false)
	_prune_records()
	_prune_shadows()


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	reset_floor_offset()


func destroy() -> void:
	if _destroyed:
		return
	_destroyed = true
	unload()
	if player != null:
		player.set_depth_collision()
	scene_manager = null
	player = null
	_condition_evaluator = Callable()


func get_material_count() -> int:
	return _records.size()


func get_shadow_count() -> int: return _shadow_records.size()
func is_lighting_enabled() -> bool: return lighting_enabled
func is_pixel_density_match_active() -> bool: return pixel_density_match_enabled and world_to_pixel.x > 0.0 and world_to_pixel.y > 0.0


func resolve_floor_offset_boost(zones: Variant, x: float, y: float) -> float:
	if not zones is Array:
		return 0.0
	var best := 0.0
	var best_abs := -1.0
	for zone: Variant in zones:
		if not zone is Dictionary or zone.get("zoneKind") != "depth_floor":
			continue
		var raw: Variant = zone.get("floorOffsetBoost")
		if not (raw is int or raw is float) or not is_finite(float(raw)):
			continue
		if zone.get("conditions") is Array and not zone.conditions.is_empty() and _condition_evaluator.is_valid() and not bool(_condition_evaluator.call(zone.conditions)):
			continue
		if not RuntimeZoneSystem.is_valid_polygon(zone.get("polygon")) or not RuntimeZoneSystem.is_point_in_polygon(zone.polygon, x, y):
			continue
		var magnitude := absf(float(raw))
		if magnitude > best_abs:
			best_abs = magnitude
			best = float(raw)
	return best


func _resolve_floor_boost(x: float, y: float) -> float:
	var scene := scene_manager.get_current_scene_data()
	return resolve_floor_offset_boost(scene.get("zones"), x, y) if scene is Dictionary else 0.0


func _update_sprite_entity(key: String, entity: RuntimeSpriteEntity, foot_x: float, foot_y: float, extra: float, cast_shadow: bool, allow_pixel_match := true) -> void:
	if entity == null or entity.sprite == null:
		return
	entity.set_pixel_density_match_active(is_pixel_density_match_active() and allow_pixel_match)
	var size := entity.get_world_size()
	_update_sprite(key, entity.sprite, Vector2(float(size.width), float(size.height)), foot_x, foot_y, -1.0 if entity.get_facing_direction() == "left" else 1.0, extra, cast_shadow, allow_pixel_match)


func _update_sprite(key: String, sprite: Sprite2D, world_size: Vector2, foot_x: float, foot_y: float, facing: float, extra: float, cast_shadow: bool, allow_pixel_match := true, allow_lighting := true) -> void:
	if sprite == null or not is_instance_valid(sprite) or world_size.x <= 0 or world_size.y <= 0:
		return
	var material := _ensure_material(sprite)
	material.set_shader_parameter("entity_world_size", world_size)
	material.set_shader_parameter("entity_foot_x", foot_x)
	material.set_shader_parameter("entity_foot_y", foot_y)
	material.set_shader_parameter("entity_facing", facing)
	material.set_shader_parameter("sample_lift_world", world_size.y * 0.4)
	material.set_shader_parameter("entity_lighting_enabled", 1.0 if allow_lighting else 0.0)
	material.set_shader_parameter("floor_offset_extra", extra)
	var match_active := is_pixel_density_match_active() and allow_pixel_match
	var frame_size := RuntimeEntityPixelDensityMatch.texture_frame_size(sprite.texture)
	var density_k := RuntimeEntityPixelDensityMatch.compute_k(frame_size.x, frame_size.y, world_size.x, world_size.y, world_to_pixel) if match_active else 1.0
	# Pixi BlurFilter.strength 的单位是最终渲染像素；本 shader 的采样步长单位是源纹理 texel。
	# 高分辨率道具被缩小时必须乘以 source-texel/screen-pixel，否则低通半径会小一个数量级。
	var projection_scale := scene_manager.camera.get_projection_scale() if scene_manager != null and scene_manager.camera != null else 1.0
	var blur_radius_texels := RuntimeEntityPixelDensityMatch.blur_radius_texels(density_k, pixel_density_match_blur_scale, frame_size, world_size, projection_scale)
	material.set_shader_parameter("pixel_blur_strength", blur_radius_texels)
	# Pixi 在 pixel-density match 生效时仍以 linear 采样原纹理，
	# 额外低通只由 pixel_blur_strength 决定。
	sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR if match_active else CanvasItem.TEXTURE_FILTER_PARENT_NODE
	_update_shadow(key, sprite, world_size, foot_x, foot_y, facing, cast_shadow)


func _ensure_material(sprite: Sprite2D) -> ShaderMaterial:
	var id := sprite.get_instance_id()
	var record: Variant = _records.get(id)
	if record is Dictionary and record.get("material") is ShaderMaterial:
		return record.material
	var lighting_filter := RuntimeEntityLightingFilter.create_for_entity()
	var material := lighting_filter.material
	material.set_shader_parameter("depth_map", depth_texture)
	material.set_shader_parameter("probe_map", probe_texture)
	material.set_shader_parameter("depth_enabled", 1.0 if enabled else 0.0)
	material.set_shader_parameter("scene_size", scene_size)
	material.set_shader_parameter("world_to_pixel_y", world_to_pixel.y)
	material.set_shader_parameter("depth_invert", 1.0 if config.get("depth_mapping", {}).get("invert") == true else 0.0)
	material.set_shader_parameter("depth_scale", float(config.get("depth_mapping", {}).get("scale", 1.0)))
	material.set_shader_parameter("depth_offset", float(config.get("depth_mapping", {}).get("offset", 0.0)))
	material.set_shader_parameter("depth_per_sy", float(config.get("shader", {}).get("depth_per_sy", 0.0)))
	material.set_shader_parameter("floor_a", float(config.get("shader", {}).get("floor_depth_A", 0.0)))
	material.set_shader_parameter("floor_b", float(config.get("shader", {}).get("floor_depth_B", 0.0)))
	material.set_shader_parameter("floor_offset", floor_offset)
	material.set_shader_parameter("tolerance", depth_tolerance)
	material.set_shader_parameter("occlusion_blend_factor", occlusion_blend_factor)
	material.set_shader_parameter("debug_mode", 1.0 if debug_mode else 0.0)
	material.set_shader_parameter("pixel_blur_strength", 0.0)
	_apply_light_env_to_material(material)
	_records[id] = {"sprite": sprite, "material": material, "filter": lighting_filter, "previous": sprite.material}
	sprite.material = material
	return material


func _broadcast_uniform(name: String, value: Variant) -> void:
	for record: Variant in _records.values():
		if record is Dictionary and record.get("material") is ShaderMaterial:
			record.material.set_shader_parameter(name, value)


func _prune_records() -> void:
	for id: Variant in _records.keys():
		var sprite: Variant = _records[id].get("sprite")
		if not is_instance_valid(sprite) or not sprite is Sprite2D:
			_records.erase(id)


func _configure_lighting(scene: Dictionary, first_background: Texture2D) -> void:
	var game_config: Variant = asset_manager.load_json("/assets/data/game_config.json") if asset_manager != null else {}
	var lighting: Variant = game_config.get("entityLighting", {}) if game_config is Dictionary else {}
	lighting_enabled = lighting is Dictionary and lighting.get("enabled") == true
	_lighting_config = lighting.duplicate(true) if lighting is Dictionary else {}
	pixel_density_match_enabled = game_config is Dictionary and game_config.get("entityPixelDensityMatch") == true
	var blur_value: Variant = game_config.get("entityPixelDensityMatchBlurScale") if game_config is Dictionary else null
	pixel_density_match_blur_scale = float(blur_value) if (blur_value is int or blur_value is float) and is_finite(float(blur_value)) and float(blur_value) > 0.0 else RuntimeEntityPixelDensityMatch.DEFAULT_BLUR_SCALE
	probe_texture = _build_probe_texture(first_background)
	light_env = _resolve_light_env(scene.get("lightEnv", {}), lighting if lighting is Dictionary else {}) if lighting_enabled else {}
	light_curve = RuntimeLightEnvCurve.prepare(scene.get("lightEnvCurve")) if lighting_enabled else null
	_plane_light_override = false


func _update_light_curve() -> void:
	if not lighting_enabled or light_curve == null or _plane_light_override or player == null:
		return
	var partial := RuntimeLightEnvCurve.interpolate(light_curve, RuntimeLightEnvCurve.project_to_t(light_curve, player.get_x(), player.get_y()))
	_apply_resolved_light_env(_resolve_light_env(partial, _lighting_config))


func _build_probe_texture(background: Texture2D) -> Texture2D:
	if background == null: return null
	var image := background.get_image()
	if image == null or image.is_empty(): return background
	var target_width := mini(96, image.get_width()); var target_height := maxi(1, int(round(float(image.get_height()) * target_width / maxf(1.0, image.get_width()))))
	image.resize(target_width, target_height, Image.INTERPOLATE_LANCZOS)
	image.generate_mipmaps()
	return ImageTexture.create_from_image(image)


func _apply_resolved_light_env(next_env: Dictionary) -> void:
	if next_env == light_env:
		return
	var previous_mode := str(light_env.get("shadow", {}).get("mode", "off"))
	RuntimeLightEnvCurve.copy_resolved_into(light_env, next_env)
	for record: Variant in _records.values():
		if record is Dictionary and record.get("material") is ShaderMaterial: _apply_light_env_to_material(record.material)
	if str(light_env.get("shadow", {}).get("mode", "off")) != previous_mode:
		for key: String in _shadow_records.keys(): _destroy_shadow(key)


func _resolve_light_env(scene_value: Variant, global_config: Dictionary) -> Dictionary:
	var base := {
		"key": {"azimuthDeg": 125.0, "elevationDeg": 55.0, "color": [1.0, 0.97, 0.92], "intensity": 1.0},
		"ambient": {"color": [0.55, 0.6, 0.72], "intensity": 1.0},
		"shadow": {"mode": "real", "enabled": true, "darkness": 0.4, "softness": 1.0, "length": 0.0, "contact": 0.5, "contactSize": 1.0, "softSamples": 1, "softRadius": 0.05, "billboard": "light"},
		"toneStrength": 0.45, "toneEnabled": true, "ao": {"contact": 0.45, "form": 0.25},
	}
	_merge_light_layer(base, global_config.get("defaultLightEnv", {}))
	_merge_light_layer(base, scene_value)
	var scene_env: Dictionary = scene_value if scene_value is Dictionary else {}
	if not str(global_config.get("shadowMode", "")).is_empty(): base.shadow.mode = global_config.shadowMode
	if scene_env.get("shadow") is Dictionary and scene_env.shadow.has("mode"): base.shadow.mode = scene_env.shadow.mode
	if global_config.has("toneEnabled"): base.toneEnabled = global_config.toneEnabled
	if scene_env.has("toneEnabled"): base.toneEnabled = scene_env.toneEnabled
	var explicit_length: Variant = null
	if global_config.get("defaultLightEnv") is Dictionary and global_config.defaultLightEnv.get("shadow") is Dictionary and global_config.defaultLightEnv.shadow.get("length") is int or global_config.defaultLightEnv.shadow.get("length") is float: explicit_length = global_config.defaultLightEnv.shadow.length
	if scene_env.get("shadow") is Dictionary and (scene_env.shadow.get("length") is int or scene_env.shadow.get("length") is float): explicit_length = scene_env.shadow.length
	if explicit_length == null:
		var elevation := clampf(float(base.key.elevationDeg), 8.0, 85.0); base.shadow.length = clampf(cos(deg_to_rad(elevation)) / maxf(sin(deg_to_rad(elevation)), 0.001), 0.3, 1.6)
	else: base.shadow.length = float(explicit_length)
	return base


func _merge_light_layer(target: Dictionary, raw: Variant) -> void:
	if not raw is Dictionary: return
	for group: String in ["key", "ambient", "shadow", "ao"]:
		if raw.get(group) is Dictionary:
			for key: String in raw[group]: target[group][key] = raw[group][key]
	for key: String in ["toneStrength", "toneEnabled"]:
		if raw.has(key): target[key] = raw[key]
	target.shadow.darkness = clampf(float(target.shadow.darkness), 0.0, 1.0); target.shadow.contact = clampf(float(target.shadow.contact), 0.0, 1.0); target.shadow.contactSize = maxf(0.1, float(target.shadow.contactSize))
	target.toneStrength = clampf(float(target.toneStrength), 0.0, 1.0); target.ao.contact = clampf(float(target.ao.contact), 0.0, 1.0); target.ao.form = clampf(float(target.ao.form), 0.0, 1.0)


func _update_shadow(key: String, sprite: Sprite2D, world_size: Vector2, foot_x: float, foot_y: float, facing: float, cast_shadow: bool) -> void:
	var mode := str(light_env.get("shadow", {}).get("mode", "off")) if lighting_enabled else "off"
	if not cast_shadow or mode == "off" or sprite.texture == null:
		_destroy_shadow(key); return
	var wanted := "deferred" if mode == "real" and enabled else "planar"
	var shadow: Variant = _shadow_records.get(key)
	if shadow == null or str(shadow.get_script().get_global_name()).to_lower().contains(wanted) == false:
		_destroy_shadow(key)
		var layer := scene_manager.renderer.shadow_layer
		shadow = RuntimeDeferredEntityShadow.new(layer, _shadow_context()) if wanted == "deferred" else RuntimePlanarEntityShadow.new(layer, _shadow_context())
		_shadow_records[key] = shadow
		shadow.set_depth_params(depth_tolerance, floor_offset, occlusion_blend_factor)
	shadow.update({"texture": sprite.texture, "visible": sprite.visible and sprite.is_visible_in_tree(), "footX": foot_x, "footY": foot_y, "width": world_size.x, "height": world_size.y, "facing": facing}, light_env, RuntimeUniformShadowField.new(light_env))


func _shadow_context() -> Dictionary:
	return {"sceneSize": scene_size, "worldToPixel": world_to_pixel, "depthTexture": depth_texture, "collisionTexture": collision_texture, "collisionImage": collision_image, "occlusionBlendFactor": occlusion_blend_factor, "config": config.duplicate(true)}


func _destroy_shadow(key: String) -> void:
	var shadow: Variant = _shadow_records.get(key)
	if shadow != null and shadow.has_method("destroy"): shadow.destroy()
	_shadow_records.erase(key)


func _prune_shadows() -> void:
	var live := {"player": true}
	for npc: RuntimeNpc in scene_manager.get_current_npcs(): live["npc:%s" % npc.get_id()] = true
	for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots(): live["hotspot:%s" % hotspot.get_id()] = true
	for key: String in _shadow_records.keys():
		if not live.has(key): _destroy_shadow(key)


func _broadcast_shadow_depth() -> void:
	for shadow: Variant in _shadow_records.values():
		if shadow != null and shadow.has_method("set_depth_params"): shadow.set_depth_params(depth_tolerance, floor_offset, occlusion_blend_factor)


func _color_vector(value: Variant) -> Vector3:
	return Vector3(float(value[0]), float(value[1]), float(value[2])) if value is Array and value.size() >= 3 else Vector3.ONE


func _apply_light_env_to_material(material: ShaderMaterial) -> void:
	var key: Variant = light_env.get("key", {}); var ambient: Variant = light_env.get("ambient", {}); var ao: Variant = light_env.get("ao", {}); var shadow: Variant = light_env.get("shadow", {})
	material.set_shader_parameter("key_color", _color_vector(key.get("color", [1.0, 0.97, 0.92]))); material.set_shader_parameter("key_intensity", float(key.get("intensity", 1.0)))
	material.set_shader_parameter("ambient_color", _color_vector(ambient.get("color", [0.55, 0.6, 0.72]))); material.set_shader_parameter("ambient_intensity", float(ambient.get("intensity", 1.0)))
	material.set_shader_parameter("tone_strength", float(light_env.get("toneStrength", 0.0)) if light_env.get("toneEnabled", true) == true else 0.0)
	material.set_shader_parameter("ao_contact", float(ao.get("contact", 0.0)) if str(shadow.get("mode", "real")) == "off" else 0.0); material.set_shader_parameter("ao_form", float(ao.get("form", 0.0)) if str(shadow.get("mode", "real")) != "off" else 0.0)
