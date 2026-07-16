class_name RuntimeCamera
extends RefCounted

## Pixi/WebGL 与 Godot CanvasItem 对纹理像素中心的 X 采样相位相差半像素。
## 只作用于最终栅格化；逻辑投影、screen_to_world 与调试快照仍使用未补偿平移。
const RASTER_PHASE := Vector2(-0.5, 0.0)

var _world_container: Node2D

var _pixels_per_unit := 1.0
var _zoom := 1.0
var _world_scale := 1.0

var _target_x := 0.0
var _target_y := 0.0
var _current_x := 0.0
var _current_y := 0.0
var _smoothing := 0.1

var _bounds_width := 0.0
var _bounds_height := 0.0

var _screen_width := 0.0
var _screen_height := 0.0

var _pixel_snap_translation := false
var _pixel_snap_last_projection_scale: Variant = null


func _init(world_container: Node2D) -> void:
	_world_container = world_container


func set_screen_size(width: float, height: float) -> void:
	_screen_width = width
	_screen_height = height
	_sync_bounds_into_state()
	_apply_transform()


func set_bounds(width: float, height: float) -> void:
	_bounds_width = width
	_bounds_height = height
	_sync_bounds_into_state()
	_apply_transform()


func set_pixels_per_unit(value: float) -> void:
	_pixels_per_unit = value
	_sync_bounds_into_state()
	_apply_transform()


func set_zoom(value: float) -> void:
	_zoom = value
	_sync_bounds_into_state()
	_apply_transform()


func set_world_scale(value: float) -> void:
	_world_scale = value
	_sync_bounds_into_state()
	_apply_transform()


func follow(x: float, y: float) -> void:
	var point := _clamp_center_world(x, y)
	_target_x = point.x
	_target_y = point.y


func snap_to(x: float, y: float) -> void:
	var point := _clamp_center_world(x, y)
	_target_x = point.x
	_target_y = point.y
	_current_x = point.x
	_current_y = point.y
	_apply_transform()


func update(delta_time: float) -> void:
	var base := minf(1.0, maxf(0.0, _smoothing))
	var reference_fps := 60.0
	var alpha := 1.0 if base <= 0.0 else 1.0 - pow(1.0 - base, delta_time * reference_fps)
	_current_x += (_target_x - _current_x) * alpha
	_current_y += (_target_y - _current_y) * alpha
	var point := _clamp_center_world(_current_x, _current_y)
	_current_x = point.x
	_current_y = point.y
	_apply_transform()


func get_x() -> float: return _current_x
func get_y() -> float: return _current_y
func get_zoom() -> float: return _zoom
func get_world_scale() -> float: return _world_scale
func get_pixels_per_unit() -> float: return _pixels_per_unit


func get_projection_scale() -> float:
	return _pixels_per_unit * _zoom * _world_scale


func set_pixel_snap_translation(enabled: bool) -> void:
	if _pixel_snap_translation == enabled:
		return
	_pixel_snap_translation = enabled
	_pixel_snap_last_projection_scale = null
	_apply_transform()


func get_view_width() -> float:
	return _screen_width / get_projection_scale()


func get_view_height() -> float:
	return _screen_height / get_projection_scale()


func screen_to_world(screen_x: float, screen_y: float) -> Vector2:
	var projection_scale := get_projection_scale()
	var logical_translation := _world_container.position - RASTER_PHASE
	return Vector2(
		(screen_x - logical_translation.x) / projection_scale,
		(screen_y - logical_translation.y) / projection_scale,
	)


func _clamp_center_world(x: float, y: float) -> Vector2:
	if _bounds_width <= 0.0 or _bounds_height <= 0.0:
		return Vector2(x, y)
	var projection_scale := get_projection_scale()
	var view_world_width := _screen_width / projection_scale
	var view_world_height := _screen_height / projection_scale
	var half_width := view_world_width / 2.0
	var half_height := view_world_height / 2.0
	var minimum_x := half_width
	var maximum_x := _bounds_width - half_width
	var minimum_y := half_height
	var maximum_y := _bounds_height - half_height
	if maximum_x < minimum_x:
		var center_x := _bounds_width / 2.0
		minimum_x = center_x
		maximum_x = center_x
	if maximum_y < minimum_y:
		var center_y := _bounds_height / 2.0
		minimum_y = center_y
		maximum_y = center_y
	return Vector2(
		maxf(minimum_x, minf(x, maximum_x)),
		maxf(minimum_y, minf(y, maximum_y)),
	)


func _sync_bounds_into_state() -> void:
	var current := _clamp_center_world(_current_x, _current_y)
	var target := _clamp_center_world(_target_x, _target_y)
	_current_x = current.x
	_current_y = current.y
	_target_x = target.x
	_target_y = target.y


func _apply_transform() -> void:
	if _world_container == null:
		return
	var projection_scale := get_projection_scale()
	var camera_x := _current_x
	var camera_y := _current_y
	_world_container.scale = Vector2(projection_scale, projection_scale)
	var translation_x := -camera_x * projection_scale + _screen_width / 2.0
	var translation_y := -camera_y * projection_scale + _screen_height / 2.0
	if _pixel_snap_translation:
		var previous: Variant = _pixel_snap_last_projection_scale
		var scale_stable := previous != null and absf(projection_scale - float(previous)) < 0.00001
		if scale_stable:
			# JavaScript Math.round 对负半整数向 +∞（-19.5→-19），Godot round 则为 -20。
			translation_x = floorf(translation_x + 0.5)
			translation_y = floorf(translation_y + 0.5)
		_pixel_snap_last_projection_scale = projection_scale
	else:
		_pixel_snap_last_projection_scale = null
	_world_container.position = Vector2(translation_x, translation_y) + RASTER_PHASE
