class_name RuntimeSpriteEntity
extends Node2D

var sprite: Sprite2D
var x := 0.0
var y := 0.0
var _base_texture: Texture2D
var _anim_def: Dictionary = {}
var _frames: Dictionary = {}
var _facing_x := 1.0
var _world_width := 0.0
var _world_height := 0.0
var _current_state := ""
var _current_frames: Array = []
var _current_frame_def: Dictionary = {}
var _frame_index := 0
var _frame_timer := 0.0
var _playing := false
var _on_complete := Callable()
var _logical_to_clip: Dictionary = {}
var _pixel_density_match_active := false


func _init() -> void:
	sprite = Sprite2D.new(); sprite.name = "Sprite"; sprite.centered = true; add_child(sprite)


func load_from_paths(manifest_path: String, asset_manager: RuntimeAssetManager) -> bool:
	var definition: Variant = asset_manager.load_json(manifest_path)
	if not definition is Dictionary: return false
	var sheet := str(definition.get("spritesheet", ""))
	if sheet.is_empty(): return false
	var texture: Variant = asset_manager.load_texture("%s/%s" % [manifest_path.get_base_dir(), sheet])
	if not texture is Texture2D: return false
	load_from_def(texture, definition); return true


func load_from_def(texture: Texture2D, definition: Dictionary) -> void:
	# AssetManager JSON values are shared cache entries.  SpriteEntity owns its
	# mutable animation cursor/teardown state, so never retain and clear that
	# shared dictionary directly when an entity leaves a scene.
	_dispose_frame_textures(); _base_texture = texture; _anim_def = definition.duplicate(true)
	var cols := maxi(1, int(definition.get("cols", 1))); var rows := maxi(1, int(definition.get("rows", 1)))
	var stride_w := float(definition.get("cellWidth", float(texture.get_width()) / cols)); var stride_h := float(definition.get("cellHeight", float(texture.get_height()) / rows))
	_world_height = float(definition.get("worldHeight", stride_h)); _world_width = float(definition.get("worldWidth", _world_height * stride_w / maxf(1.0, stride_h)))
	for state_name: String in definition.get("states", {}):
		var state: Variant = definition.states[state_name]
		if not state is Dictionary: continue
		var textures: Array = []
		for raw_index: Variant in state.get("frames", []):
			var frame_index := int(raw_index); var col := frame_index % cols; var row := frame_index / cols
			var frame_w := stride_w; var frame_h := stride_h
			var boxes: Variant = definition.get("atlasFrames")
			if boxes is Array and frame_index >= 0 and frame_index < boxes.size() and boxes[frame_index] is Dictionary:
				if float(boxes[frame_index].get("width", 0)) > 0: frame_w = float(boxes[frame_index].width)
				if float(boxes[frame_index].get("height", 0)) > 0: frame_h = float(boxes[frame_index].height)
			var atlas := AtlasTexture.new(); atlas.atlas = texture; atlas.region = Rect2(col * stride_w, row * stride_h, frame_w, frame_h); textures.push_back(atlas)
		_frames[state_name] = textures
	_apply_sprite_scale()


func set_logical_state_map(map: Variant) -> void:
	_logical_to_clip.clear()
	if map is Dictionary:
		for logical: Variant in map:
			if not str(logical).is_empty() and not str(map[logical]).is_empty(): _logical_to_clip[str(logical)] = str(map[logical])


func play_animation(state_name: String, on_complete: Callable = Callable()) -> void:
	var clip := str(_logical_to_clip.get(state_name, state_name))
	if _current_state == clip and _playing: return
	var frame_def: Variant = _anim_def.get("states", {}).get(clip); var textures: Variant = _frames.get(clip)
	if not frame_def is Dictionary or not textures is Array or textures.is_empty(): return
	_current_state = clip; _current_frames = textures; _current_frame_def = frame_def; _frame_index = 0; _frame_timer = 0.0; _playing = true; _on_complete = on_complete; sprite.texture = textures[0]; _apply_sprite_scale()


func set_direction(dx: float, _dy: float = 0.0) -> void:
	if dx > 0: _facing_x = 1.0
	elif dx < 0: _facing_x = -1.0
	_apply_sprite_scale()


func update(dt: float) -> void:
	if _playing and not _current_frame_def.is_empty() and _current_frames.size() > 1:
		_frame_timer += dt
		var fps_raw: Variant = _current_frame_def.get("frameRate"); var fps := float(fps_raw) if (fps_raw is int or fps_raw is float) and is_finite(float(fps_raw)) and float(fps_raw) > 0 else 8.0
		var frame_duration := 1.0 / fps
		while _frame_timer >= frame_duration:
			_frame_timer -= frame_duration; _frame_index += 1
			if _frame_index >= _current_frames.size():
				if _current_frame_def.get("loop") == true: _frame_index = 0
				else:
					_frame_index = _current_frames.size() - 1; _playing = false
					if not _on_complete.is_null() and _on_complete.is_valid(): _on_complete.call()
					break
		sprite.texture = _current_frames[_frame_index]; _apply_sprite_scale()
	position = Vector2(x, y)


func get_current_state() -> String: return _current_state
func get_frame_count() -> int: return _current_frames.size()
func get_frame_index() -> int: return _frame_index
func get_state_names() -> Array: return _anim_def.get("states", {}).keys()
func get_world_size() -> Dictionary: return {"width": _world_width, "height": _world_height}
func get_display_texture() -> Variant: return sprite.texture
func get_facing_direction() -> String: return "left" if _facing_x < 0 else "right"


func get_debug_visual_state() -> Dictionary:
	var frame: Variant = null
	if sprite.texture is AtlasTexture:
		var region: Rect2 = sprite.texture.region
		frame = {"x": region.position.x, "y": region.position.y, "width": region.size.x, "height": region.size.y}
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
	if _current_frames.is_empty(): return
	_frame_index = posmod(index, _current_frames.size()); _frame_timer = 0.0; sprite.texture = _current_frames[_frame_index]; _apply_sprite_scale(); position = Vector2(x, y)


func set_playing(value: bool) -> void:
	if value and not _playing and not _current_frames.is_empty() and _frame_index >= _current_frames.size() - 1 and _current_frame_def.get("loop") != true: _frame_index = 0
	_playing = value and not _current_frames.is_empty()


func set_pixel_density_match_active(active: bool) -> void:
	_pixel_density_match_active = active
	# Pixi 的 pixel-density match 只开启 roundPixels/可选 BlurFilter，
	# 底层纹理仍使用默认线性采样；不能在无额外模糊时退成 nearest。
	sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR if active else CanvasItem.TEXTURE_FILTER_PARENT_NODE
func get_pixel_density_match_active() -> bool: return _pixel_density_match_active


func destroy_entity() -> void:
	_dispose_frame_textures(); _base_texture = null; _anim_def.clear(); _logical_to_clip.clear()
	if sprite != null and is_instance_valid(sprite): remove_child(sprite); sprite.free(); sprite = null


func _dispose_frame_textures() -> void:
	_frames.clear(); _current_frames.clear(); _current_frame_def.clear(); _frame_index = 0; _frame_timer = 0; _playing = false; _on_complete = Callable(); _current_state = ""
	if sprite != null: sprite.texture = null


func _current_frame_pixel_size() -> Vector2:
	if _base_texture == null or _anim_def.is_empty(): return Vector2.ONE
	var cols := maxi(1, int(_anim_def.get("cols", 1))); var rows := maxi(1, int(_anim_def.get("rows", 1)))
	var size := Vector2(float(_anim_def.get("cellWidth", float(_base_texture.get_width()) / cols)), float(_anim_def.get("cellHeight", float(_base_texture.get_height()) / rows)))
	if not _current_frame_def.is_empty() and _anim_def.get("atlasFrames") is Array and not _current_frame_def.get("frames", []).is_empty():
		var slot := int(_current_frame_def.frames[_frame_index % _current_frame_def.frames.size()]); var boxes: Array = _anim_def.atlasFrames
		if slot >= 0 and slot < boxes.size() and boxes[slot] is Dictionary and float(boxes[slot].get("width", 0)) > 0 and float(boxes[slot].get("height", 0)) > 0: size = Vector2(float(boxes[slot].width), float(boxes[slot].height))
	return size


func _apply_sprite_scale() -> void:
	if sprite == null: return
	var frame_size := _current_frame_pixel_size(); sprite.scale = Vector2((_world_width / maxf(1.0, frame_size.x)) * _facing_x, _world_height / maxf(1.0, frame_size.y)); sprite.position = Vector2(0, -_world_height / 2.0)
