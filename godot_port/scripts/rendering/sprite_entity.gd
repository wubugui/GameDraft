class_name RuntimeSpriteEntity
extends Node2D

# Godot adapter: this Node2D is the source `container`; Pixi Container filters
# are bound to the drawable child by SceneEntityFilterBinding because Godot
# CanvasGroup cannot compose nested per-entity filters without corrupting alpha.
var container: Node2D
var x := 0.0
var y := 0.0

var sprite: Sprite2D
var _base_texture: Texture2D = null
var _anim_def: Dictionary = {}
var _frames: Dictionary = {}
var _facing_x := 1.0

var _world_width := 0.0
var _world_height := 0.0

var _current_state := ""
var _current_frames: Array = []
var _current_frame_def: Variant = null
var _frame_index := 0
var _frame_timer := 0.0
var _playing := false
var _on_complete_callback: Variant = null
var _logical_to_clip: Dictionary = {}

var _pixel_density_blur: RefCounted = null
var _pixel_density_match_active := false
var _pixel_density_blur_mounted := false


func _init() -> void:
	container = self
	sprite = Sprite2D.new()
	sprite.name = "Sprite"
	sprite.centered = true
	add_child(sprite)


func load_from_def(texture: Texture2D, animation_def: Dictionary) -> void:
	_dispose_frame_textures()
	_base_texture = texture
	_anim_def = animation_def
	_world_width = float(animation_def.worldWidth)
	_world_height = float(animation_def.worldHeight)

	var cols := int(animation_def.cols)
	var rows := int(animation_def.rows)
	var raw_cell_width: Variant = animation_def.get("cellWidth")
	var raw_cell_height: Variant = animation_def.get("cellHeight")
	var stride_width := float(raw_cell_width) \
		if (raw_cell_width is int or raw_cell_width is float) and float(raw_cell_width) > 0.0 \
		else float(texture.get_width()) / cols
	var stride_height := float(raw_cell_height) \
		if (raw_cell_height is int or raw_cell_height is float) and float(raw_cell_height) > 0.0 \
		else float(texture.get_height()) / rows

	for state_name: String in animation_def.states:
		var state_definition: Dictionary = animation_def.states[state_name]
		var textures: Array = []
		for raw_frame_index: Variant in state_definition.frames:
			var frame_index := int(raw_frame_index)
			var column := frame_index % cols
			var row := floori(float(frame_index) / cols)
			var box: Variant = null
			var atlas_frames: Variant = animation_def.get("atlasFrames")
			if atlas_frames is Array and frame_index >= 0 and frame_index < atlas_frames.size():
				box = atlas_frames[frame_index]
			var region_width := float(box.width) if box is Dictionary and float(box.get("width", 0.0)) > 0.0 else stride_width
			var region_height := float(box.height) if box is Dictionary and float(box.get("height", 0.0)) > 0.0 else stride_height
			var frame_texture := AtlasTexture.new()
			frame_texture.atlas = texture
			frame_texture.region = Rect2(column * stride_width, row * stride_height, region_width, region_height)
			textures.push_back(frame_texture)
		_frames[state_name] = textures

	_apply_sprite_scale()


func _dispose_frame_textures() -> void:
	if sprite != null:
		sprite.texture = null
	_frames.clear()
	_current_frames = []
	_current_frame_def = null
	_frame_index = 0
	_frame_timer = 0.0
	_playing = false
	_on_complete_callback = null
	_current_state = ""


func destroy() -> void:
	_clear_pixel_density_blur()
	_dispose_frame_textures()
	_base_texture = null
	_anim_def = {}
	_logical_to_clip.clear()
	material = null
	if sprite != null and is_instance_valid(sprite):
		remove_child(sprite)
		sprite.free()
		sprite = null


func set_logical_state_map(map: Variant = null) -> void:
	_logical_to_clip.clear()
	if not map is Dictionary:
		return
	for logical: Variant in map:
		var clip: Variant = map[logical]
		if not str(logical).is_empty() and not str(clip).is_empty():
			_logical_to_clip[str(logical)] = str(clip)


func _resolve_clip(state_name: String) -> String:
	return str(_logical_to_clip.get(state_name, state_name))


func play_animation(state_name: String, on_complete: Variant = null) -> void:
	var clip := _resolve_clip(state_name)
	if _current_state == clip and _playing:
		return

	var frame_definition: Variant = _anim_def.get("states", {}).get(clip)
	var textures: Variant = _frames.get(clip)
	if not frame_definition is Dictionary or not textures is Array or textures.is_empty():
		return

	_current_state = clip
	_current_frames = textures
	_current_frame_def = frame_definition
	_frame_index = 0
	_frame_timer = 0.0
	_playing = true
	_on_complete_callback = on_complete
	sprite.texture = textures[0]


func set_direction(dx: float, _dy: float) -> void:
	if dx > 0.0:
		_facing_x = 1.0
	elif dx < 0.0:
		_facing_x = -1.0
	_apply_sprite_scale()


func update(dt: float) -> void:
	if not _playing or not _current_frame_def is Dictionary or _current_frames.size() <= 1:
		_sync_position()
		return

	_frame_timer += dt
	var raw_frame_rate: Variant = _current_frame_def.get("frameRate")
	var frame_rate := float(raw_frame_rate) \
		if (raw_frame_rate is int or raw_frame_rate is float) and is_finite(float(raw_frame_rate)) and float(raw_frame_rate) > 0.0 \
		else 8.0
	var frame_duration := 1.0 / frame_rate

	while _frame_timer >= frame_duration:
		_frame_timer -= frame_duration
		_frame_index += 1
		if _frame_index >= _current_frames.size():
			if _current_frame_def.get("loop") == true:
				_frame_index = 0
			else:
				_frame_index = _current_frames.size() - 1
				_playing = false
				if _on_complete_callback is Callable and _on_complete_callback.is_valid():
					_on_complete_callback.call()
				break

	sprite.texture = _current_frames[_frame_index]
	_apply_sprite_scale()
	_sync_position()


func _sync_position() -> void:
	position = Vector2(x, y)


func get_current_state() -> String:
	return _current_state


func get_frame_count() -> int:
	return _current_frames.size()


func get_frame_index() -> int:
	return _frame_index


func get_debug_visual_state() -> Dictionary:
	var frame: Variant = null
	if sprite != null and sprite.texture != null:
		var region := Rect2(Vector2.ZERO, Vector2(sprite.texture.get_width(), sprite.texture.get_height()))
		if sprite.texture is AtlasTexture:
			region = sprite.texture.region
		frame = {
			"x": region.position.x,
			"y": region.position.y,
			"width": region.size.x,
			"height": region.size.y,
		}
	return {
		"state": _current_state,
		"frameIndex": _frame_index,
		"frameTimer": _frame_timer,
		"playing": _playing,
		"facing": get_facing_direction(),
		"worldWidth": _world_width,
		"worldHeight": _world_height,
		"frame": frame,
		"pixelDensityMatchActive": _pixel_density_match_active,
	}


func reset_animation_clock() -> void:
	_frame_index = 0
	_frame_timer = 0.0
	if not _current_frames.is_empty():
		sprite.texture = _current_frames[0]
		_apply_sprite_scale()


func set_frame_index(index: int) -> void:
	if _current_frames.is_empty():
		return
	var count := _current_frames.size()
	_frame_index = posmod(index, count)
	_frame_timer = 0.0
	sprite.texture = _current_frames[_frame_index]
	_apply_sprite_scale()
	_sync_position()


func set_playing(playing: bool) -> void:
	if playing and not _playing and not _current_frames.is_empty():
		if _frame_index >= _current_frames.size() - 1 and not (_current_frame_def is Dictionary and _current_frame_def.get("loop") == true):
			_frame_index = 0
	_playing = playing and not _current_frames.is_empty()


func get_state_names() -> Array:
	return _anim_def.states.keys() if _anim_def.has("states") else []


func get_world_size() -> Dictionary:
	return {"width": _world_width, "height": _world_height}


func get_display_texture() -> Variant:
	return sprite.texture if sprite != null and sprite.texture != null else null


func get_facing_direction() -> String:
	return "left" if _facing_x < 0.0 else "right"


func set_pixel_density_match_active(active: bool) -> void:
	if _pixel_density_match_active == active:
		return
	_pixel_density_match_active = active
	if sprite != null:
		sprite.set_meta("roundPixels", active)
	if not active:
		_clear_pixel_density_blur()


func get_pixel_density_match_active() -> bool:
	return _pixel_density_match_active


func apply_pixel_density_match(background_density: Variant, strength_scale := 1.0) -> void:
	if not _pixel_density_match_active:
		return
	var density: Variant = background_density
	if background_density is Dictionary:
		density = Vector2(float(background_density.get("x", 0.0)), float(background_density.get("y", 0.0)))
	if not density is Vector2 or _base_texture == null or _anim_def.is_empty():
		_clear_pixel_density_blur()
		return
	var frame_size := _get_current_frame_pixel_size()
	var density_k := RuntimeEntityPixelDensityMatch.compute_pixel_density_k(
		frame_size.x,
		frame_size.y,
		_world_width,
		_world_height,
		density,
	)
	var strength := RuntimeEntityPixelDensityMatch.blur_strength_from_pixel_density_k(density_k, strength_scale)
	if strength <= 0.0:
		_unmount_pixel_density_blur()
		return
	if _pixel_density_blur == null:
		_pixel_density_blur = RuntimeEntityPixelDensityMatch.create_pixel_density_blur_filter(strength)
	else:
		_pixel_density_blur.strength = strength
	if not _pixel_density_blur_mounted:
		sprite.material = _pixel_density_blur.material
		_pixel_density_blur_mounted = true


func _unmount_pixel_density_blur() -> void:
	if not _pixel_density_blur_mounted:
		return
	if sprite != null and _pixel_density_blur != null and sprite.material == _pixel_density_blur.material:
		sprite.material = null
	_pixel_density_blur_mounted = false


func _clear_pixel_density_blur() -> void:
	_unmount_pixel_density_blur()
	if _pixel_density_blur != null:
		_pixel_density_blur.destroy()
		_pixel_density_blur = null


func _get_current_frame_pixel_size() -> Vector2:
	if _base_texture == null or _anim_def.is_empty():
		return Vector2.ONE
	var cols := int(_anim_def.cols)
	var rows := int(_anim_def.rows)
	var raw_cell_width: Variant = _anim_def.get("cellWidth")
	var raw_cell_height: Variant = _anim_def.get("cellHeight")
	var stride_width := float(raw_cell_width) \
		if (raw_cell_width is int or raw_cell_width is float) and float(raw_cell_width) > 0.0 \
		else float(_base_texture.get_width()) / cols
	var stride_height := float(raw_cell_height) \
		if (raw_cell_height is int or raw_cell_height is float) and float(raw_cell_height) > 0.0 \
		else float(_base_texture.get_height()) / rows
	var frame_width := stride_width
	var frame_height := stride_height
	var atlas_frames: Variant = _anim_def.get("atlasFrames")
	if _current_frame_def is Dictionary and atlas_frames is Array and not atlas_frames.is_empty():
		var sequence: Variant = _current_frame_def.get("frames")
		if sequence is Array and not sequence.is_empty():
			var slot := int(sequence[_frame_index % sequence.size()])
			var box: Variant = atlas_frames[slot] if slot >= 0 and slot < atlas_frames.size() else null
			if box is Dictionary and float(box.get("width", 0.0)) > 0.0 and float(box.get("height", 0.0)) > 0.0:
				frame_width = float(box.width)
				frame_height = float(box.height)
	return Vector2(frame_width, frame_height)


func _apply_sprite_scale() -> void:
	if sprite == null:
		return
	if _base_texture == null or _anim_def.is_empty():
		sprite.scale = Vector2(_facing_x, 1.0)
		return
	var frame_size := _get_current_frame_pixel_size()
	sprite.scale = Vector2(
		(_world_width / frame_size.x) * _facing_x,
		_world_height / frame_size.y,
	)
	sprite.position = Vector2(0.0, -_world_height / 2.0)
