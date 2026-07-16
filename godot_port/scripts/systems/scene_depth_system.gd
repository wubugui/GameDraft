class_name RuntimeSceneDepthSystem
extends RuntimeSystem

var enabled := false
var config: Variant = null
var depth_texture: Texture2D
var collision_data: Variant = null
var collision_texture: Texture2D
var collision_w := 0
var collision_h := 0
var filters: Array = []
var shadows: Dictionary = {}

var lighting_enabled := false
var probe_source: Texture2D
var light_env: Variant = null

var _depth_tolerance := 0.0
var _floor_offset := 0.0
var _occlusion_blend_factor := 0.28

var r00 := 0.0
var r01 := 0.0
var r02 := 0.0
var r10 := 0.0
var r11 := 0.0
var r12 := 0.0
var r20 := 0.0
var r21 := 0.0
var r22 := 0.0
var ppu := 1.0
var cx := 0.0
var cy := 0.0
var col_x_min := 0.0
var col_z_min := 0.0
var col_cell_size := 1.0
var col_height_offset := 0.0
var floor_a := 0.0
var floor_b := 0.0

var scene_w := 0.0
var scene_h := 0.0
var scene_id := ""
var world_to_pixel_x := 1.0
var world_to_pixel_y := 1.0

var depth_tolerance: float:
	get:
		return _depth_tolerance
	set(value):
		_depth_tolerance = value
		for filter: Variant in filters:
			filter.set_tolerance(value)
		_broadcast_depth_params_to_shadows()

var floor_offset: float:
	get:
		return _floor_offset
	set(value):
		_floor_offset = value
		for filter: Variant in filters:
			filter.set_floor_offset(value)
		_broadcast_depth_params_to_shadows()

var occlusion_blend_factor: float:
	get:
		return _occlusion_blend_factor
	set(value):
		var clamped := clampf(value, 0.0, 1.0)
		_occlusion_blend_factor = clamped
		for filter: Variant in filters:
			filter.set_occlusion_blend_factor(clamped)
		_broadcast_depth_params_to_shadows()


func register_shadow(shadow: Variant) -> void:
	if shadow == null:
		return
	shadows[shadow.get_instance_id()] = shadow
	if shadow.has_method("set_depth_params"):
		shadow.set_depth_params(_depth_tolerance, _floor_offset, _occlusion_blend_factor)


func unregister_shadow(shadow: Variant) -> void:
	if shadow != null:
		shadows.erase(shadow.get_instance_id())


func _broadcast_depth_params_to_shadows() -> void:
	for shadow: Variant in shadows.values():
		if shadow != null and shadow.has_method("set_depth_params"):
			shadow.set_depth_params(_depth_tolerance, _floor_offset, _occlusion_blend_factor)


func init(_ctx: Dictionary) -> void:
	return


func update(_dt: float) -> void:
	return


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	return


var is_enabled: bool:
	get:
		return enabled

var is_active: bool:
	get:
		return enabled or lighting_enabled

var is_lighting_enabled: bool:
	get:
		return lighting_enabled

var current_light_env: Variant:
	get:
		return light_env

var current_config: Variant:
	get:
		return config

var current_depth_texture: Texture2D:
	get:
		return depth_texture

var current_scene_id: String:
	get:
		return scene_id


func load(
	next_scene_id: String,
	depth_config: Dictionary,
	asset_manager: RuntimeAssetManager,
	next_scene_w: float,
	next_scene_h: float,
	next_world_to_pixel_x: float,
	next_world_to_pixel_y: float,
) -> bool:
	RuntimeDepthLog.depth_log("DepthSystem", ["load() scene:", next_scene_id, "size:", next_scene_w, "x", next_scene_h])
	RuntimeDepthLog.depth_log("DepthSystem", ["depthConfig:", depth_config])

	unload()
	config = depth_config.duplicate(true)
	enabled = true
	scene_id = next_scene_id
	scene_w = next_scene_w
	scene_h = next_scene_h
	world_to_pixel_x = next_world_to_pixel_x
	world_to_pixel_y = next_world_to_pixel_y

	var depth_path := RuntimeResourceLocator.get_default().scene_runtime_asset_url(next_scene_id, str(depth_config.get("depth_map", "")))
	RuntimeDepthLog.depth_log("DepthSystem", ["loading depth texture:", depth_path])
	var loaded_depth: Variant = asset_manager.load_texture(depth_path)
	if not loaded_depth is Texture2D:
		RuntimeDepthLog.depth_error("DepthSystem", ["depth texture FAILED", asset_manager.get_last_error()])
		enabled = false
		return false
	depth_texture = loaded_depth
	RuntimeDepthLog.depth_log("DepthSystem", ["depth texture OK:", depth_texture.get_width(), "x", depth_texture.get_height()])

	if not str(depth_config.get("collision_map", "")).strip_edges().is_empty():
		var collision_path := RuntimeResourceLocator.get_default().scene_runtime_asset_url(next_scene_id, str(depth_config.collision_map))
		RuntimeDepthLog.depth_log("DepthSystem", ["loading collision:", collision_path])
		if load_collision_bitmap(collision_path, asset_manager):
			RuntimeDepthLog.depth_log("DepthSystem", ["collision OK:", collision_w, "x", collision_h])
			var loaded_collision_texture: Variant = asset_manager.load_texture(collision_path)
			collision_texture = loaded_collision_texture if loaded_collision_texture is Texture2D else null
		else:
			RuntimeDepthLog.depth_error("DepthSystem", ["collision FAILED", asset_manager.get_last_error()])

	var matrix: Dictionary = depth_config.get("M", {}) if depth_config.get("M") is Dictionary else {}
	var rows: Array = matrix.get("R", []) if matrix.get("R") is Array else []
	var row0: Array = rows[0] if rows.size() > 0 and rows[0] is Array else []
	var row1: Array = rows[1] if rows.size() > 1 and rows[1] is Array else []
	var row2: Array = rows[2] if rows.size() > 2 and rows[2] is Array else []
	r00 = float(row0[0]) if row0.size() > 0 else 0.0
	r01 = float(row0[1]) if row0.size() > 1 else 0.0
	r02 = float(row0[2]) if row0.size() > 2 else 0.0
	r10 = float(row1[0]) if row1.size() > 0 else 0.0
	r11 = float(row1[1]) if row1.size() > 1 else 0.0
	r12 = float(row1[2]) if row1.size() > 2 else 0.0
	r20 = float(row2[0]) if row2.size() > 0 else 0.0
	r21 = float(row2[1]) if row2.size() > 1 else 0.0
	r22 = float(row2[2]) if row2.size() > 2 else 0.0
	ppu = float(matrix.get("ppu", 1.0))
	cx = float(matrix.get("cx", 0.0))
	cy = float(matrix.get("cy", 0.0))

	var collision: Variant = depth_config.get("collision")
	if collision is Dictionary:
		col_x_min = float(collision.get("x_min", 0.0))
		col_z_min = float(collision.get("z_min", 0.0))
		col_cell_size = float(collision.get("cell_size", 1.0))
		collision_w = int(collision.get("grid_width", collision_w))
		collision_h = int(collision.get("grid_height", collision_h))
		col_height_offset = float(collision.get("height_offset", 0.0))
		RuntimeDepthLog.depth_log("DepthSystem", ["collision grid:", collision])

	var shader: Dictionary = depth_config.get("shader", {}) if depth_config.get("shader") is Dictionary else {}
	floor_a = float(shader.get("floor_depth_A", 0.0))
	floor_b = float(shader.get("floor_depth_B", 0.0))
	_depth_tolerance = float(depth_config.get("depth_tolerance", 0.0))
	_floor_offset = float(depth_config.get("floor_offset", 0.0))
	RuntimeDepthLog.depth_log("DepthSystem", ["load() done. enabled:", enabled, "depthTex:", depth_texture != null, "collisionData:", collision_data != null])
	return true


func apply_runtime_scene_size(next_scene_w: float, next_scene_h: float, next_world_to_pixel_x: float, next_world_to_pixel_y: float) -> void:
	if not is_active:
		return
	scene_w = next_scene_w
	scene_h = next_scene_h
	world_to_pixel_x = next_world_to_pixel_x
	world_to_pixel_y = next_world_to_pixel_y
	for filter: Variant in filters:
		filter.set_scene_size(next_scene_w, next_scene_h)
		filter.set_world_to_pixel(next_world_to_pixel_x, next_world_to_pixel_y)


func load_default() -> void:
	RuntimeDepthLog.depth_log("DepthSystem", ["loadDefault - disabled"])
	unload()
	enabled = false


func unload() -> void:
	depth_texture = null
	collision_data = null
	collision_texture = null
	collision_w = 0
	collision_h = 0
	config = null
	enabled = false
	filters = []
	shadows.clear()
	world_to_pixel_x = 1.0
	world_to_pixel_y = 1.0
	lighting_enabled = false
	probe_source = null
	light_env = null


func enable_lighting(next_probe_source: Texture2D, next_light_env: Dictionary, next_scene_w: float, next_scene_h: float, next_world_to_pixel_x: float, next_world_to_pixel_y: float) -> void:
	lighting_enabled = true
	probe_source = next_probe_source
	light_env = next_light_env
	scene_w = next_scene_w
	scene_h = next_scene_h
	world_to_pixel_x = next_world_to_pixel_x
	world_to_pixel_y = next_world_to_pixel_y


func disable_lighting() -> void:
	lighting_enabled = false
	probe_source = null
	light_env = null


func get_shadow_scene_context() -> Variant:
	if not enabled or depth_texture == null or not config is Dictionary:
		return null
	var mapping: Dictionary = config.get("depth_mapping", {}) if config.get("depth_mapping") is Dictionary else {}
	return {
		"depthTexture": depth_texture,
		"collisionTexture": collision_texture,
		"sceneW": scene_w,
		"sceneH": scene_h,
		"worldToPixelX": world_to_pixel_x,
		"worldToPixelY": world_to_pixel_y,
		"invert": 1.0 if mapping.get("invert") == true else 0.0,
		"scale": float(mapping.get("scale", 1.0)),
		"offset": float(mapping.get("offset", 0.0)),
		"floorA": floor_a,
		"floorB": floor_b,
		"floorOffset": _floor_offset,
		"tolerance": _depth_tolerance,
		"occlusionBlendFactor": _occlusion_blend_factor,
		"ppu": ppu,
		"cx": cx,
		"cy": cy,
		"r00": r00, "r01": r01, "r02": r02,
		"r10": r10, "r11": r11, "r12": r12,
		"r20": r20, "r21": r21, "r22": r22,
		"colXMin": col_x_min,
		"colZMin": col_z_min,
		"colCellSize": col_cell_size,
		"colGridW": collision_w,
		"colGridH": collision_h,
	}


func load_collision_bitmap(path: String, asset_manager: RuntimeAssetManager) -> bool:
	var bitmap: Variant = asset_manager.load_bitmap(path)
	if not bitmap is Image:
		return false
	var image: Image = bitmap.duplicate()
	image.convert(Image.FORMAT_RGBA8)
	var pixels := image.get_data()
	collision_data = PackedByteArray()
	collision_data.resize(image.get_width() * image.get_height())
	for index: int in collision_data.size():
		collision_data[index] = pixels[index * 4]
	collision_w = image.get_width()
	collision_h = image.get_height()
	return true


func is_collision(world_x: float, world_y: float) -> bool:
	if not enabled or collision_data == null:
		return false
	var sx := world_x * world_to_pixel_x
	var sy := world_y * world_to_pixel_y
	var floor_depth := floor_a * sy + floor_b
	var px := (sx - cx) / ppu
	var py := (cy - sy) / ppu
	var wx := r00 * px + r01 * py + r02 * floor_depth
	var wz := r20 * px + r21 * py + r22 * floor_depth
	var gx := int(floor((wx - col_x_min) / col_cell_size))
	var gz := int(floor((wz - col_z_min) / col_cell_size))
	if gx < 0 or gx >= collision_w or gz < 0 or gz >= collision_h:
		return false
	return collision_data[gz * collision_w + gx] > 127


func create_filter_for_entity() -> Variant:
	RuntimeDepthLog.depth_log("DepthSystem", ["createFilter: enabled=", enabled, "depthTex=", depth_texture != null, "config=", config != null])
	if not enabled or depth_texture == null or not config is Dictionary:
		return null
	var filter := RuntimeDepthOcclusionFilter.create_for_entity(depth_texture, config)
	filter.set_scene_size(scene_w, scene_h)
	filter.set_world_to_pixel(world_to_pixel_x, world_to_pixel_y)
	filter.set_occlusion_blend_factor(_occlusion_blend_factor)
	filters.push_back(filter)
	RuntimeDepthLog.depth_log("DepthSystem", ["filter created, sceneSize (rendered):", scene_w, "x", scene_h, "total:", filters.size()])
	return filter


func create_lighting_filter_for_entity(sample_lift_world: float) -> Variant:
	if not lighting_enabled or not light_env is Dictionary:
		return null
	var filter := RuntimeEntityLightingFilter.create_for_entity({
		"depthTexture": depth_texture if enabled else null,
		"cfg": config if enabled else null,
		"probeSource": probe_source,
		"lightEnv": light_env,
		"sampleLiftWorld": sample_lift_world,
	})
	filter.set_scene_size(scene_w, scene_h)
	filter.set_world_to_pixel(world_to_pixel_x, world_to_pixel_y)
	if enabled:
		filter.set_occlusion_blend_factor(_occlusion_blend_factor)
	filters.push_back(filter)
	return filter


func remove_filter(filter: Variant) -> void:
	var index := filters.find(filter)
	if index >= 0:
		filters.remove_at(index)


func set_collision_texture_on_filters(texture: Texture2D) -> void:
	for filter: Variant in filters:
		filter.set_collision_texture(texture)


func set_debug_on_filters(on: bool) -> void:
	for filter: Variant in filters:
		filter.set_debug(on)


func apply_shadow_filter_tone_ao(tone: float, ao_contact: float, ao_form: float) -> void:
	for filter: Variant in filters:
		if filter.has_method("set_tone"):
			filter.set_tone(tone)
		if filter.has_method("set_ao"):
			filter.set_ao(ao_contact, ao_form)


func apply_key_ambient(key_color: Array, key_intensity: float, ambient_color: Array, ambient_intensity: float) -> void:
	for filter: Variant in filters:
		if filter.has_method("set_key_light"):
			filter.set_key_light(key_color, key_intensity)
		if filter.has_method("set_ambient"):
			filter.set_ambient(ambient_color, ambient_intensity)


var _last_foot_log_ms := -INF


func update_per_frame(world_container_x: float, world_container_y: float, projection_scale: float) -> void:
	if not is_active:
		return
	for filter: Variant in filters:
		filter.set_world_container_pos(world_container_x, world_container_y)
		filter.set_projection_scale(projection_scale)


func update_entity_depth_occlusion(filter: Variant, foot_world_x: float, foot_world_y: float, floor_offset_extra: float) -> void:
	filter.set_entity_foot_y(foot_world_y)
	if filter.has_method("set_entity_foot_x"):
		filter.set_entity_foot_x(foot_world_x)
	filter.set_floor_offset_extra(floor_offset_extra)
	var now := Time.get_ticks_msec()
	if now - _last_foot_log_ms >= 5000.0:
		_last_foot_log_ms = now
		var sy_texture := foot_world_y * world_to_pixel_y
		var depth_base := floor_a * sy_texture + floor_b + _floor_offset + floor_offset_extra
		RuntimeDepthLog.depth_log("DepthSystem", ["foot:", "%.2f" % foot_world_x, "%.2f" % foot_world_y, "syTex:", "%.2f" % sy_texture, "d_base:", "%.4f" % depth_base])


func destroy() -> void:
	unload()
