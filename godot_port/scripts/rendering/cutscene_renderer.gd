class_name RuntimeCutsceneRenderer
extends RefCounted

const ANON_SHOT_ID := "__anonShot"

var renderer: RuntimeRenderer
var camera: RuntimeCamera
var asset_manager: RuntimeAssetManager
var fade_overlay: ColorRect
var world_fade_overlay: ColorRect
var title_root: Control
var movie_bars: Control
var images: Dictionary = {}
var anim_layers: Dictionary = {}
var active_dialogue: Control
var active_subtitles: Array[Control] = []
var _resolve_display := Callable()
var _op_epoch := 0
var _request_seq: Dictionary = {}
var _time_scale := 1.0
var overlay_images: Dictionary = {}


func _init(next_renderer: RuntimeRenderer, next_camera: RuntimeCamera, assets: RuntimeAssetManager) -> void: renderer = next_renderer; camera = next_camera; asset_manager = assets
func set_resolve_display(callback: Callable = Callable()) -> void: _resolve_display = callback
func set_time_scale(value: float) -> void: _time_scale = maxf(0.0, value)
func load_overlay_defs() -> bool:
	var raw: Variant = asset_manager.load_json("/assets/data/overlay_images.json")
	overlay_images = raw.duplicate(true) if raw is Dictionary else {}
	return not overlay_images.is_empty()
func get_active_image_handles() -> Array: return images.keys()
func has_movie_bars() -> bool: return movie_bars != null
func has_fade_overlay() -> bool: return fade_overlay != null


func update(dt: float) -> void:
	for entry: Dictionary in anim_layers.values():
		var sprite: Variant = entry.get("sprite")
		if sprite is RuntimeSpriteEntity: sprite.update(dt)


func abort_cutscene_ops() -> void: _op_epoch += 1


func wait_ms(duration_ms: float) -> void:
	var epoch := _op_epoch; var duration := _scaled_ms(duration_ms)
	if duration <= 0: await Engine.get_main_loop().process_frame; return
	var start := Time.get_ticks_msec()
	while _op_epoch == epoch and Time.get_ticks_msec() - start < duration: await Engine.get_main_loop().process_frame


func fade_to_black(duration_ms: float) -> void:
	var overlay := _ensure_fade_overlay(); await _animate_alpha(overlay, overlay.color.a, 1.0, duration_ms)
func fade_from_black(duration_ms: float) -> void:
	var overlay := _ensure_fade_overlay(); await _animate_alpha(overlay, overlay.color.a, 0.0, duration_ms)
func fade_world_to_black(duration_ms: float) -> void:
	var overlay := _ensure_world_fade_overlay(); await _animate_alpha(overlay, overlay.color.a, 1.0, duration_ms)
func fade_world_from_black(duration_ms: float) -> void:
	var overlay := _ensure_world_fade_overlay(); await _animate_alpha(overlay, overlay.color.a, 0.0, duration_ms)


func set_debug_world_fade_alpha(alpha: float) -> void:
	var overlay := _ensure_world_fade_overlay(); var color := overlay.color
	color.a = clampf(alpha, 0.0, 1.0); overlay.color = color


func settle_fade_overlays_before_cleanup(duration_ms: float) -> void:
	var fade_start := fade_overlay.color.a if fade_overlay != null else 0.0; var world_start := world_fade_overlay.color.a if world_fade_overlay != null else 0.0
	if fade_start <= 0.01 and world_start <= 0.01: return
	await _animate(maxf(1.0, duration_ms), func(t: float) -> void:
		if fade_overlay != null: var color := fade_overlay.color; color.a = lerpf(fade_start, 0.0, t); fade_overlay.color = color
		if world_fade_overlay != null: var color := world_fade_overlay.color; color.a = lerpf(world_start, 0.0, t); world_fade_overlay.color = color
	)


func flash_white(duration_ms: float) -> void:
	var flash := ColorRect.new(); flash.name = "CutsceneFlash"; flash.position = Vector2.ZERO; flash.size = Vector2(renderer.get_screen_width(), renderer.get_screen_height()); flash.color = Color.WHITE; flash.mouse_filter = Control.MOUSE_FILTER_IGNORE; renderer.ui_layer.add_child(flash); await _animate_alpha(flash, 1.0, 0.0, duration_ms)
	_free_node(flash)


func show_title(text: String, duration_ms: float) -> void:
	if title_root != null: _free_node(title_root)
	title_root = Control.new(); title_root.name = "CutsceneTitle"; title_root.position = Vector2.ZERO; title_root.size = Vector2(renderer.get_screen_width(), renderer.get_screen_height()); title_root.modulate.a = 0.0
	var bg := ColorRect.new(); bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); bg.color = Color(0, 0, 0, 0.8); bg.mouse_filter = Control.MOUSE_FILTER_IGNORE; title_root.add_child(bg)
	var label := Label.new(); label.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); label.text = _r(text); label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER; label.add_theme_font_size_override("font_size", 36); label.add_theme_color_override("font_color", Color("ffeecc")); label.mouse_filter = Control.MOUSE_FILTER_IGNORE; title_root.add_child(label); renderer.ui_layer.add_child(title_root)
	var fade := minf(300.0, maxf(0.0, duration_ms) / 4.0); await _animate_modulate_alpha(title_root, 0.0, 1.0, fade); await wait_ms(maxf(0.0, duration_ms - fade * 2.0)); await _animate_modulate_alpha(title_root, title_root.modulate.a if title_root != null else 1.0, 0.0, fade)
	if title_root != null: _free_node(title_root); title_root = null


func show_dialogue_box(text: String, speaker: String = "") -> Control:
	if active_dialogue != null: dismiss_dialogue_box(active_dialogue)
	var root := Control.new(); root.name = "CutsceneDialogue"; root.position = Vector2.ZERO; root.size = Vector2(renderer.get_screen_width(), renderer.get_screen_height())
	var panel := Panel.new(); panel.position = Vector2(0, renderer.get_screen_height() - 140); panel.size = Vector2(renderer.get_screen_width(), 140); var style := StyleBoxFlat.new(); style.bg_color = Color(0.03, 0.035, 0.07, 0.94); style.border_color = Color(0.35, 0.35, 0.55); style.set_border_width_all(2); panel.add_theme_stylebox_override("panel", style); root.add_child(panel)
	if not speaker.strip_edges().is_empty(): var name_label := Label.new(); name_label.position = Vector2(30, renderer.get_screen_height() - 132); name_label.size = Vector2(renderer.get_screen_width() - 60, 28); name_label.text = _r(speaker); name_label.add_theme_font_size_override("font_size", 16); name_label.add_theme_color_override("font_color", Color("ffcc88")); root.add_child(name_label)
	var body := Label.new(); body.position = Vector2(30, renderer.get_screen_height() - 102); body.size = Vector2(renderer.get_screen_width() - 60, 88); body.text = _r(text); body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; body.clip_text = true; body.add_theme_font_size_override("font_size", 16); body.add_theme_color_override("font_color", Color("dddddd")); root.add_child(body); renderer.ui_layer.add_child(root); active_dialogue = root; return root


func dismiss_dialogue_box(root: Control) -> void:
	if active_dialogue == root: active_dialogue = null
	_free_node(root)


func show_subtitle(text: String, layout: Variant = "bottom") -> Control:
	var root := Control.new(); root.name = "CutsceneSubtitle"; root.position = Vector2.ZERO; root.size = Vector2(renderer.get_screen_width(), renderer.get_screen_height()); root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var label := Label.new(); label.text = _r(text); label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; label.add_theme_font_size_override("font_size", 18); label.add_theme_color_override("font_color", Color.WHITE); label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER; label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var y := renderer.get_screen_height() * 0.82; var align := "center"
	if layout is Dictionary:
		y = renderer.get_screen_height() * (0.08 if layout.get("subtitleBand") == "movieTop" else 0.92); align = str(layout.get("subtitleAlign", "center"))
	elif layout is String: y = renderer.get_screen_height() * (0.18 if layout == "top" else (0.5 if layout == "center" else 0.82))
	elif layout is int or layout is float: y = renderer.get_screen_height() * (1.0 - clampf(float(layout), 0.0, 1.0))
	label.position = Vector2(renderer.get_screen_width() * 0.1, y - 40); label.size = Vector2(renderer.get_screen_width() * 0.8, 80); label.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT if align == "left" else (HORIZONTAL_ALIGNMENT_RIGHT if align == "right" else HORIZONTAL_ALIGNMENT_CENTER); root.add_child(label); renderer.ui_layer.add_child(root); active_subtitles.push_back(root); return root


func dismiss_subtitle(root: Control) -> void: active_subtitles.erase(root); _free_node(root)


func show_img(path: String, handle: String = ANON_SHOT_ID, ken_burns: Variant = null, z_index: Variant = null) -> bool:
	var id := handle.strip_edges() if not handle.strip_edges().is_empty() else ANON_SHOT_ID
	if id == ANON_SHOT_ID: hide_img(ANON_SHOT_ID)
	var texture: Variant = _load_texture_safely(path)
	if not texture is Texture2D: return false
	var node := TextureRect.new(); node.name = "CutsceneImage:%s" % id; node.position = Vector2.ZERO; node.size = Vector2(renderer.get_screen_width(), renderer.get_screen_height()); node.texture = texture; node.expand_mode = TextureRect.EXPAND_IGNORE_SIZE; node.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED; node.mouse_filter = Control.MOUSE_FILTER_IGNORE; node.pivot_offset = node.size / 2.0; node.z_index = int(z_index) if z_index is int or z_index is float else 0; renderer.cutscene_overlay.add_child(node); images[id] = node; _request_seq[id] = int(_request_seq.get(id, 0)) + 1
	if ken_burns is Dictionary: _run_ken_burns(node.get_instance_id(), id, int(_request_seq[id]), ken_burns)
	return true


func show_percent_img(path: String, handle: String, x_percent: float, y_percent: float, width_percent: float) -> bool:
	var texture: Variant = _load_texture_safely(path); if not texture is Texture2D: return false
	hide_img(handle); var node := TextureRect.new(); node.name = "CutscenePercent:%s" % handle; node.texture = texture; node.expand_mode = TextureRect.EXPAND_IGNORE_SIZE; node.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED; var width := renderer.get_screen_width() * width_percent / 100.0; var height := width * float(texture.get_height()) / maxf(1.0, texture.get_width()); node.size = Vector2(width, height); node.position = Vector2(renderer.get_screen_width() * x_percent / 100.0 - width / 2.0, renderer.get_screen_height() * y_percent / 100.0 - height / 2.0); node.mouse_filter = Control.MOUSE_FILTER_IGNORE; renderer.cutscene_overlay.add_child(node); images[handle] = node; return true


func show_overlay_image(handle: String, image: String, x_percent: float, y_percent: float, width_percent: float) -> bool:
	var path := image if image.begins_with("/") else str(overlay_images.get(image, ""))
	return not path.is_empty() and show_percent_img(path, handle, x_percent, y_percent, width_percent)


func blend_overlay_image(handle: String, from_image: String, to_image: String, x_percent: float, y_percent: float, width_percent: float, duration_ms: float, delay_ms: float = 0.0) -> bool:
	var from_path := from_image if from_image.begins_with("/") else str(overlay_images.get(from_image, "")); var to_path := to_image if to_image.begins_with("/") else str(overlay_images.get(to_image, "")); var from_texture: Variant = _load_texture_safely(from_path); var to_texture: Variant = _load_texture_safely(to_path)
	if not from_texture is Texture2D or not to_texture is Texture2D: return false
	hide_img(handle); var root := Node2D.new(); root.name = "CutsceneBlend:%s" % handle; var width := renderer.get_screen_width() * width_percent / 100.0; var height := width * float(to_texture.get_height()) / maxf(1.0, to_texture.get_width()); root.position = Vector2(renderer.get_screen_width() * x_percent / 100.0 - width / 2.0, renderer.get_screen_height() * y_percent / 100.0 - height / 2.0); var from_node := TextureRect.new(); from_node.texture = from_texture; from_node.size = Vector2(width, height); from_node.expand_mode = TextureRect.EXPAND_IGNORE_SIZE; from_node.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED; var to_node := TextureRect.new(); to_node.texture = to_texture; to_node.size = Vector2(width, height); to_node.expand_mode = TextureRect.EXPAND_IGNORE_SIZE; to_node.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED; to_node.modulate.a = 0.0; root.add_child(from_node); root.add_child(to_node); renderer.cutscene_overlay.add_child(root); images[handle] = root
	await wait_ms(maxf(0.0, delay_ms)); var root_id := root.get_instance_id(); var from_id := from_node.get_instance_id(); var to_id := to_node.get_instance_id(); root = null; from_node = null; to_node = null; await _animate(maxf(0.0, duration_ms), func(t: float) -> void:
		var current_root: Variant = instance_from_id(root_id); var a: Variant = instance_from_id(from_id); var b: Variant = instance_from_id(to_id)
		if not current_root is Node2D or not a is TextureRect or not b is TextureRect or images.get(handle) != current_root: return
		a.modulate.a = 1.0 - t; b.modulate.a = t
	)
	var old_image: Variant = instance_from_id(from_id); if old_image is TextureRect: _free_node(old_image)
	var final_root: Variant = instance_from_id(root_id); return final_root is Node2D and images.get(handle) == final_root


func show_anim_layer(anim_file: String, handle: String, options: Dictionary) -> bool:
	hide_img(handle); var sprite := RuntimeSpriteEntity.new(); if not sprite.load_from_paths(anim_file, asset_manager): sprite.free(); return false
	sprite.play_animation(str(options.get("state", "idle"))); var x := renderer.get_screen_width() * float(options.get("xPercent", 50.0)) / 100.0; var y := renderer.get_screen_height() * float(options.get("yPercent", 50.0)) / 100.0; sprite.position = Vector2(x, y); var wanted_width := renderer.get_screen_width() * float(options.get("widthPercent", 100.0)) / 100.0; var world := sprite.get_world_size(); var scale_value := wanted_width / maxf(1.0, float(world.width)); sprite.scale = Vector2(scale_value, scale_value); sprite.modulate.a = clampf(float(options.get("alpha", 1.0)), 0.0, 1.0); sprite.z_index = int(options.get("zIndex", 0)); renderer.cutscene_overlay.add_child(sprite); images[handle] = sprite; anim_layers[handle] = {"sprite": sprite}; return true


func show_parallax_scene(definition: Dictionary, handle: String = ANON_SHOT_ID) -> bool:
	var id := handle.strip_edges() if not handle.strip_edges().is_empty() else ANON_SHOT_ID
	hide_img(ANON_SHOT_ID); if id != ANON_SHOT_ID: hide_img(id)
	var container := Node2D.new(); container.name = "ParallaxScene:%s" % id; renderer.cutscene_overlay.add_child(container); images[id] = container; _request_seq[id] = int(_request_seq.get(id, 0)) + 1; var seq := int(_request_seq[id]); var width_ref := maxf(1.0, float(definition.get("widthRef", renderer.get_screen_width()))); var height_ref := maxf(1.0, float(definition.get("heightRef", renderer.get_screen_height()))); var cover := maxf(renderer.get_screen_width() / width_ref, renderer.get_screen_height() / height_ref); var origin := Vector2((renderer.get_screen_width() - width_ref * cover) / 2.0, (renderer.get_screen_height() - height_ref * cover) / 2.0); var loaded := 0
	for raw: Variant in definition.get("layers", []):
		if not raw is Dictionary: continue
		var texture: Variant = _load_texture_safely(str(raw.get("image", ""))); if not texture is Texture2D: continue
		var sprite := Sprite2D.new(); sprite.texture = texture; sprite.centered = true; sprite.z_index = int(raw.get("zIndex", 0)); container.add_child(sprite); var keys: Variant = raw.get("keyframes", []); if keys is Array and not keys.is_empty(): _apply_parallax_key(sprite, keys[0], cover, origin); _run_parallax_layer(sprite.get_instance_id(), id, seq, keys, cover, origin, str(raw.get("easing", "linear")), raw.get("loop") == true)
		loaded += 1
	if loaded == 0: hide_img(id); return false
	return true


func hide_img(handle: String = ANON_SHOT_ID) -> void:
	var id := handle.strip_edges() if not handle.strip_edges().is_empty() else ANON_SHOT_ID; _request_seq[id] = int(_request_seq.get(id, 0)) + 1; var node: Variant = images.get(id); images.erase(id); anim_layers.erase(id)
	if node is RuntimeSpriteEntity: node.destroy_entity()
	if node is Node: _free_node(node)


func show_movie_bar(height_percent: float = 0.1) -> void:
	hide_movie_bar(); movie_bars = Control.new(); movie_bars.name = "CutsceneMovieBars"; movie_bars.position = Vector2.ZERO; movie_bars.size = Vector2(renderer.get_screen_width(), renderer.get_screen_height()); movie_bars.z_index = 4095; var h := renderer.get_screen_height() * clampf(height_percent, 0.0, 0.45); var top := ColorRect.new(); top.position = Vector2.ZERO; top.size = Vector2(renderer.get_screen_width(), h); top.color = Color.BLACK; var bottom := ColorRect.new(); bottom.position = Vector2(0, renderer.get_screen_height() - h); bottom.size = Vector2(renderer.get_screen_width(), h); bottom.color = Color.BLACK; movie_bars.add_child(top); movie_bars.add_child(bottom); renderer.cutscene_overlay.add_child(movie_bars)
func hide_movie_bar() -> void:
	if movie_bars != null: _free_node(movie_bars); movie_bars = null


func camera_move(x: float, y: float, duration_ms: float) -> void:
	var start := Vector2(camera.get_x(), camera.get_y()); await _animate(duration_ms, func(t: float) -> void: var p := start.lerp(Vector2(x, y), t); camera.snap_to(p.x, p.y))
func camera_zoom(scale_value: float, duration_ms: float) -> void:
	var start := camera.get_zoom(); await _animate(duration_ms, func(t: float) -> void: camera.set_zoom(lerpf(start, scale_value, t)))


func cleanup() -> void:
	abort_cutscene_ops()
	for id: String in images.keys().duplicate(): hide_img(id)
	for subtitle: Control in active_subtitles.duplicate(): dismiss_subtitle(subtitle)
	if active_dialogue != null: dismiss_dialogue_box(active_dialogue)
	if title_root != null: _free_node(title_root); title_root = null
	hide_movie_bar()
	if fade_overlay != null: _free_node(fade_overlay); fade_overlay = null
	if world_fade_overlay != null: _free_node(world_fade_overlay); world_fade_overlay = null


func destroy() -> void: cleanup(); overlay_images.clear(); _resolve_display = Callable()


func _ensure_fade_overlay() -> ColorRect:
	if fade_overlay == null: fade_overlay = ColorRect.new(); fade_overlay.name = "CutsceneFade"; fade_overlay.position = Vector2.ZERO; fade_overlay.size = Vector2(renderer.get_screen_width(), renderer.get_screen_height()); fade_overlay.color = Color(0, 0, 0, 0); fade_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE; fade_overlay.z_index = 4096; renderer.ui_layer.add_child(fade_overlay)
	return fade_overlay
func _ensure_world_fade_overlay() -> ColorRect:
	if world_fade_overlay == null: world_fade_overlay = ColorRect.new(); world_fade_overlay.name = "WorldFade"; world_fade_overlay.position = Vector2.ZERO; world_fade_overlay.size = Vector2(renderer.get_screen_width(), renderer.get_screen_height()); world_fade_overlay.color = Color(0, 0, 0, 0); world_fade_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE; world_fade_overlay.z_index = 4096; renderer.cutscene_overlay.add_child(world_fade_overlay)
	return world_fade_overlay
func _animate_alpha(node: ColorRect, from: float, to: float, duration: float) -> void: await _animate(duration, func(t: float) -> void: if is_instance_valid(node): var c := node.color; c.a = lerpf(from, to, t); node.color = c)
func _animate_modulate_alpha(node: CanvasItem, from: float, to: float, duration: float) -> void: await _animate(duration, func(t: float) -> void: if is_instance_valid(node): var c := node.modulate; c.a = lerpf(from, to, t); node.modulate = c)
func _animate(duration_ms: float, callback: Callable) -> void:
	var epoch := _op_epoch; var duration := _scaled_ms(duration_ms); callback.call(0.0)
	if duration <= 0: callback.call(1.0); await Engine.get_main_loop().process_frame; return
	var start := Time.get_ticks_msec()
	while _op_epoch == epoch:
		var t := clampf(float(Time.get_ticks_msec() - start) / duration, 0.0, 1.0); callback.call(t)
		if t >= 1.0: break
		await Engine.get_main_loop().process_frame
func _scaled_ms(value: float) -> float: return maxf(0.0, value) * _time_scale
func _load_texture_safely(path: String) -> Variant:
	var resolved := asset_manager.locator.resolve_url(path, RuntimeResourceLocator.MEDIA); return asset_manager.load_texture(path) if FileAccess.file_exists(resolved) else null
func _free_node(node: Node) -> void:
	if node == null or not is_instance_valid(node): return
	if node.get_parent() != null: node.get_parent().remove_child(node)
	node.free()
func _r(text: String) -> String: return str(_resolve_display.call(text)) if not _resolve_display.is_null() and _resolve_display.is_valid() else text


func _run_ken_burns(node_instance_id: int, id: String, seq: int, config: Dictionary) -> void:
	var from_scale := maxf(1.0, float(config.get("fromScale", 1.0))); var to_scale := maxf(1.0, float(config.get("toScale", from_scale))); var from_pos := Vector2(float(config.get("fromX", 0)), float(config.get("fromY", 0))); var to_pos := Vector2(float(config.get("toX", from_pos.x)), float(config.get("toY", from_pos.y))); var center := Vector2(renderer.get_screen_width(), renderer.get_screen_height()) / 2.0
	await _animate(float(config.get("durationMs", 12000)), func(t: float) -> void:
		var current: Variant = instance_from_id(node_instance_id)
		if not current is TextureRect or images.get(id) != current or int(_request_seq.get(id, -1)) != seq: return
		var scale_value := lerpf(from_scale, to_scale, t); current.scale = Vector2(scale_value, scale_value); var percent := from_pos.lerp(to_pos, t); var texture: Texture2D = current.texture as Texture2D; var tex_width: float = float(texture.get_width()) if texture != null else current.size.x; var tex_height: float = float(texture.get_height()) if texture != null else current.size.y; var cover := maxf(renderer.get_screen_width() / maxf(1.0, tex_width), renderer.get_screen_height() / maxf(1.0, tex_height)); var max_offset := Vector2(maxf(0.0, (tex_width * cover * scale_value - renderer.get_screen_width()) / 2.0), maxf(0.0, (tex_height * cover * scale_value - renderer.get_screen_height()) / 2.0)); var wanted := Vector2(renderer.get_screen_width() * percent.x / 100.0, renderer.get_screen_height() * percent.y / 100.0); var offset := Vector2(clampf(wanted.x, -max_offset.x, max_offset.x), clampf(wanted.y, -max_offset.y, max_offset.y)); current.position = center - current.size * scale_value / 2.0 + offset
	)
func _apply_parallax_key(sprite: Sprite2D, key: Dictionary, cover: float, origin: Vector2) -> void: sprite.position = origin + Vector2(float(key.get("x", 0)), float(key.get("y", 0))) * cover; var scale_value := cover * float(key.get("scale", 1.0)); sprite.scale = Vector2(scale_value, scale_value); sprite.rotation_degrees = float(key.get("rotation", 0)); sprite.modulate.a = clampf(float(key.get("alpha", 1.0)), 0.0, 1.0)
func _run_parallax_layer(sprite_instance_id: int, id: String, seq: int, raw_keys: Array, cover: float, origin: Vector2, easing: String, loop: bool) -> void:
	var keys: Array = raw_keys.duplicate(true); keys.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return float(a.get("atMs", 0)) < float(b.get("atMs", 0)))
	if keys.size() < 2: return
	while images.has(id) and int(_request_seq.get(id, -1)) == seq:
		for index in keys.size() - 1:
			var a: Dictionary = keys[index]; var b: Dictionary = keys[index + 1]; var span := maxf(0.0, float(b.get("atMs", 0)) - float(a.get("atMs", 0))); await _animate(span, func(t: float) -> void:
				var current: Variant = instance_from_id(sprite_instance_id)
				if not current is Sprite2D or images.get(id) == null or int(_request_seq.get(id, -1)) != seq: return
				var u := t
				if easing == "easeIn": u = t * t
				elif easing == "easeOut": u = 1.0 - (1.0 - t) * (1.0 - t)
				elif easing == "easeInOut": u = 2.0 * t * t if t < 0.5 else 1.0 - pow(-2.0 * t + 2.0, 2.0) / 2.0
				var key := {"x": lerpf(float(a.get("x", 0)), float(b.get("x", a.get("x", 0))), u), "y": lerpf(float(a.get("y", 0)), float(b.get("y", a.get("y", 0))), u), "scale": lerpf(float(a.get("scale", 1.0)), float(b.get("scale", a.get("scale", 1.0))), u), "rotation": lerpf(float(a.get("rotation", 0)), float(b.get("rotation", a.get("rotation", 0))), u), "alpha": lerpf(float(a.get("alpha", 1.0)), float(b.get("alpha", a.get("alpha", 1.0))), u)}; _apply_parallax_key(current, key, cover, origin)
			)
			if images.get(id) == null or int(_request_seq.get(id, -1)) != seq: return
		if not loop: return
