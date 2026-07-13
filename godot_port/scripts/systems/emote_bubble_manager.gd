class_name RuntimeEmoteBubbleManager
extends RuntimeSystem


signal bubble_progress

var entity_attach_layer: Node2D
var active_bubbles: Array[Dictionary] = []
var _next_id := 0
var _time_scale := 1.0


func set_entity_attach_layer(layer: Node2D) -> void:
	entity_attach_layer = layer


func set_time_scale(value: float) -> void:
	_time_scale = maxf(0.0, value)


func show(anchor: Variant, text: String, duration_ms: float = 1500.0, options: Dictionary = {}, owner: String = "") -> int:
	var display: Variant = anchor.get_display_object() if anchor != null and anchor.has_method("get_display_object") else null
	if not display is Node2D or entity_attach_layer == null:
		return -1
	_next_id += 1
	var bubble := _build_bubble(text)
	entity_attach_layer.add_child(bubble)
	var entry := {"id": _next_id, "bubble": bubble, "anchor": anchor, "display": display, "remainingMs": maxf(0.0, duration_ms) * _time_scale, "sticky": false, "owner": owner, "offsetX": float(options.get("anchorOffsetX", 0.0)), "offsetY": float(options.get("anchorOffsetY", 0.0))}
	active_bubbles.push_back(entry)
	_position_entry(entry)
	if entry.remainingMs <= 0:
		call_deferred("_expire_by_id", _next_id)
	return _next_id


func show_sticky(anchor: Variant, text: String, options: Dictionary = {}, owner: String = "") -> int:
	var id := show(anchor, text, 1.0, options, owner)
	var entry: Variant = _find_entry(id)
	if entry is Dictionary:
		entry.sticky = true
	return id


func show_and_wait(anchor: Variant, text: String, duration_ms: float = 1500.0, options: Dictionary = {}, owner: String = "") -> bool:
	var id := show(anchor, text, duration_ms, options, owner)
	if id < 0:
		return false
	while _find_entry(id) != null:
		await bubble_progress
	await Engine.get_main_loop().process_frame
	return true


func dismiss(id: int) -> void:
	_remove_by_id(id)


func cleanup_by_owner(owner: String) -> void:
	for entry: Dictionary in active_bubbles.duplicate():
		if str(entry.owner) == owner:
			_remove_entry(entry)
	call_deferred("_emit_bubble_progress")


func update(dt: float) -> void:
	var changed := false
	for entry: Dictionary in active_bubbles.duplicate():
		var display: Variant = entry.display
		if not display is Node2D or not is_instance_valid(display) or display.get_parent() == null:
			_remove_entry(entry)
			changed = true
			continue
		_position_entry(entry)
		if entry.sticky == true:
			continue
		entry.remainingMs = float(entry.remainingMs) - dt * 1000.0
		if float(entry.remainingMs) <= 0:
			_remove_entry(entry)
			changed = true
	if changed:
		call_deferred("_emit_bubble_progress")


func deserialize(_data: Dictionary) -> void:
	cleanup()


func cleanup() -> void:
	for entry: Dictionary in active_bubbles.duplicate():
		_remove_entry(entry)
	active_bubbles.clear()
	call_deferred("_emit_bubble_progress")


func destroy() -> void:
	cleanup()
	entity_attach_layer = null


func _build_bubble(text: String) -> Node2D:
	var root := Node2D.new()
	root.name = "EmoteBubble"
	root.z_index = 4094
	var label := Label.new()
	label.text = text
	label.add_theme_font_size_override("font_size", 20)
	label.add_theme_color_override("font_color", Color("222222"))
	var bold_font := SystemFont.new(); bold_font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"]); bold_font.font_weight = 700; label.add_theme_font_override("font", bold_font)
	var text_size := label.get_minimum_size()
	# Pixi Text 的 20px CJK advance/默认行高约为 20/23；SystemFont 的 minimum_size
	# 在同一字体回退链上会偏窄偏高。保留实测下限，确保世界尺寸与 TS 气泡一致。
	var width := maxf(text_size.x + 16.0, text.length() * 20.0 + 16.0); var height := 31.0
	var bg := Panel.new(); bg.position = Vector2.ZERO; bg.size = Vector2(width, height); bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new(); style.bg_color = Color(1, 1, 1, 0.95); style.border_color = Color("888888"); style.set_border_width_all(1); style.set_corner_radius_all(6); bg.add_theme_stylebox_override("panel", style); root.add_child(bg)
	label.position = Vector2(8, 4); label.size = Vector2(width - 16.0, height - 8.0); label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.set_meta("bubbleWidth", width)
	root.set_meta("bubbleHeight", height)
	root.add_child(label)
	return root


func _position_entry(entry: Dictionary) -> void:
	var bubble: Node2D = entry.bubble
	var anchor: Variant = entry.anchor
	var display: Node2D = entry.display
	var width := float(bubble.get_meta("bubbleWidth", 38.0))
	var height := float(bubble.get_meta("bubbleHeight", 34.0))
	var x := display.position.x - width / 2.0 + float(entry.offsetX)
	var local_y := float(anchor.get_emote_bubble_anchor_local_y()) if anchor.has_method("get_emote_bubble_anchor_local_y") else -24.0
	var y := display.position.y + local_y - height + float(entry.offsetY)
	if anchor is RuntimeHotspot and anchor.has_method("get_emote_world_quad"):
		var quad: Dictionary = anchor.get_emote_world_quad()
		x = float(quad.left) + float(quad.width) / 2.0 - width / 2.0 + float(entry.offsetX)
		y = float(quad.top) - 8.0 - height + float(entry.offsetY)
	bubble.position = Vector2(x, y)


func _find_entry(id: int) -> Variant:
	for entry: Dictionary in active_bubbles:
		if int(entry.id) == id:
			return entry
	return null


func _expire_by_id(id: int) -> void:
	var entry: Variant = _find_entry(id)
	if entry is Dictionary and entry.get("sticky") != true: _remove_by_id(id)


func _remove_by_id(id: int) -> void:
	var entry: Variant = _find_entry(id)
	if entry is Dictionary:
		_remove_entry(entry)
		call_deferred("_emit_bubble_progress")


func _emit_bubble_progress() -> void:
	bubble_progress.emit()


func _remove_entry(entry: Dictionary) -> void:
	active_bubbles.erase(entry)
	var bubble: Variant = entry.get("bubble")
	if bubble is Node and is_instance_valid(bubble):
		if bubble.get_parent() != null:
			bubble.get_parent().remove_child(bubble)
		bubble.free()
