class_name RuntimeCamera
extends RefCounted

## Pixi/WebGL 与 Godot CanvasItem 对纹理像素中心的 X 采样相位相差半像素。
## 只作用于最终栅格化；逻辑投影、screen_to_world 与调试快照仍使用未补偿平移。
const RASTER_PHASE := Vector2(-0.5, 0.0)

var _world_container: Node2D
var _pixels_per_unit := 1.0
var _zoom := 1.0
var _world_scale := 1.0
var _target := Vector2.ZERO
var _current := Vector2.ZERO
var _smoothing := 0.1
var _bounds := Vector2.ZERO
var _screen := Vector2.ZERO
var _pixel_snap_translation := false
var _pixel_snap_last_projection_scale: Variant = null


func _init(world_container: Node2D) -> void: _world_container = world_container
func set_screen_size(width: float, height: float) -> void: _screen = Vector2(width, height); _sync_bounds_into_state(); _apply_transform()
func set_bounds(width: float, height: float) -> void: _bounds = Vector2(width, height); _sync_bounds_into_state(); _apply_transform()
func set_pixels_per_unit(value: float) -> void: _pixels_per_unit = value; _sync_bounds_into_state(); _apply_transform()
func set_zoom(value: float) -> void: _zoom = value; _sync_bounds_into_state(); _apply_transform()
func set_world_scale(value: float) -> void: _world_scale = value; _sync_bounds_into_state(); _apply_transform()


func follow(x: float, y: float) -> void: _target = _clamp_center_world(Vector2(x, y))
func snap_to(x: float, y: float) -> void: _target = _clamp_center_world(Vector2(x, y)); _current = _target; _apply_transform()


func update(dt: float) -> void:
	var base := clampf(_smoothing, 0.0, 1.0)
	var alpha := 1.0 if base <= 0.0 else 1.0 - pow(1.0 - base, dt * 60.0)
	_current += (_target - _current) * alpha
	_current = _clamp_center_world(_current)
	_apply_transform()


func get_x() -> float: return _current.x
func get_y() -> float: return _current.y
func get_zoom() -> float: return _zoom
func get_world_scale() -> float: return _world_scale
func get_pixels_per_unit() -> float: return _pixels_per_unit
func get_projection_scale() -> float: return _pixels_per_unit * _zoom * _world_scale
func get_view_width() -> float: return _screen.x / get_projection_scale()
func get_view_height() -> float: return _screen.y / get_projection_scale()


func set_pixel_snap_translation(enabled: bool) -> void:
	if _pixel_snap_translation == enabled: return
	_pixel_snap_translation = enabled; _pixel_snap_last_projection_scale = null; _apply_transform()


func screen_to_world(screen_x: float, screen_y: float) -> Vector2:
	var scale := get_projection_scale()
	var logical_translation := _world_container.position - RASTER_PHASE
	return Vector2((screen_x - logical_translation.x) / scale, (screen_y - logical_translation.y) / scale)


func _clamp_center_world(point: Vector2) -> Vector2:
	if _bounds.x <= 0.0 or _bounds.y <= 0.0: return point
	var view := Vector2(get_view_width(), get_view_height()); var half := view / 2.0
	var minimum := half; var maximum := _bounds - half
	if maximum.x < minimum.x: minimum.x = _bounds.x / 2.0; maximum.x = minimum.x
	if maximum.y < minimum.y: minimum.y = _bounds.y / 2.0; maximum.y = minimum.y
	return Vector2(clampf(point.x, minimum.x, maximum.x), clampf(point.y, minimum.y, maximum.y))


func _sync_bounds_into_state() -> void: _current = _clamp_center_world(_current); _target = _clamp_center_world(_target)


func _apply_transform() -> void:
	if _world_container == null: return
	var scale := get_projection_scale(); _world_container.scale = Vector2(scale, scale)
	var translation := -_current * scale + _screen / 2.0
	if _pixel_snap_translation:
		var stable := _pixel_snap_last_projection_scale != null and absf(scale - float(_pixel_snap_last_projection_scale)) < 0.00001
		# JavaScript Math.round 对负半整数向 +∞（-19.5→-19），Godot round 则为 -20。
		# 明写 floor(v+0.5)，否则部分地图整张画面会稳定错开 1px。
		if stable: translation = Vector2(floorf(translation.x + 0.5), floorf(translation.y + 0.5))
		_pixel_snap_last_projection_scale = scale
	else: _pixel_snap_last_projection_scale = null
	_world_container.position = translation + RASTER_PHASE
