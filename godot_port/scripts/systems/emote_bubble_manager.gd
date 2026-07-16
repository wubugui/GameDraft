class_name RuntimeEmoteBubbleManager
extends RuntimeSystem


const QUAD_ABOVE_GAP := 8.0


# Direct fields, in EmoteBubbleManager.ts declaration order.
var active_bubbles: Array[Dictionary] = []
var pending_timers: Dictionary = {}
var entity_attach_layer: Node2D = null
var debug_panel_log: Variant = null

# Godot test-clock adapter. Production leaves this at the source value 1.
var _time_scale := 1.0


func set_entity_attach_layer(layer: Node2D) -> void:
	entity_attach_layer = layer


func set_debug_panel_log(callback: Variant) -> void:
	debug_panel_log = callback if callback is Callable and callback.is_valid() else null


func _dbg(message: String) -> void:
	if debug_panel_log is Callable and debug_panel_log.is_valid():
		debug_panel_log.call("[EmoteBubble] %s" % message)


func init(_ctx: Dictionary) -> void:
	return


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	cleanup()


func _build_and_mount_bubble(anchor: Variant, emote: String, options: Variant = null) -> Dictionary:
	var display_obj: Node2D = anchor.get_display_object()
	_dbg(
		"mount 开始 anchor=%s emoteLen=%d entityAttachLayer=%s" % [
			anchor.get_class() if anchor != null else "?",
			emote.length(),
			"ok" if entity_attach_layer != null else "(null)",
		]
	)
	_dbg(
		"  displayObj parent=%s visible=%s renderable=%s alpha=%s y=%s" % [
			"yes" if display_obj.get_parent() != null else "no",
			str(display_obj.visible),
			str(display_obj.is_visible_in_tree()),
			str(display_obj.modulate.a),
			"%.1f" % display_obj.position.y if is_finite(display_obj.position.y) else str(display_obj.position.y),
		]
	)

	var bubble := Node2D.new()
	bubble.name = "EmoteBubble"

	var text := Label.new()
	text.text = emote
	text.add_theme_font_size_override("font_size", 20)
	text.add_theme_color_override("font_color", Color("222222"))
	var bold_font := SystemFont.new()
	bold_font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"])
	bold_font.font_weight = 700
	text.add_theme_font_override("font", bold_font)
	text.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var padding_x := 8.0
	var padding_y := 4.0
	var text_size := text.get_minimum_size()
	# Pixi Text measures its final glyph run immediately. Keep the same 20 px
	# CJK advance/23 px line-height when Godot's fallback font reports narrower.
	var bubble_width := maxf(text_size.x, emote.length() * 20.0) + padding_x * 2.0
	var bubble_height := maxf(text_size.y, 23.0) + padding_y * 2.0

	var background := Panel.new()
	background.position = Vector2.ZERO
	background.size = Vector2(bubble_width, bubble_height)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = Color(1.0, 1.0, 1.0, 0.95)
	style.border_color = Color("888888")
	style.set_border_width_all(1)
	style.set_corner_radius_all(6)
	background.add_theme_stylebox_override("panel", style)
	bubble.add_child(background)

	text.position = Vector2(padding_x, padding_y)
	text.size = Vector2(bubble_width - padding_x * 2.0, bubble_height - padding_y * 2.0)
	bubble.add_child(text)

	var offset_x := float(options.get("anchorOffsetX", 0.0)) if options is Dictionary else 0.0
	var offset_y := float(options.get("anchorOffsetY", 0.0)) if options is Dictionary else 0.0
	var attach_parent: Node2D = display_obj
	var bubble_x := -bubble_width / 2.0 + offset_x
	var bubble_y := float(anchor.get_emote_bubble_anchor_local_y()) + offset_y - bubble_height
	var follow: Variant = null

	if entity_attach_layer != null and anchor is RuntimeHotspot:
		attach_parent = entity_attach_layer
		bubble.set_meta("entitySortBand", "front")
		var quad: Dictionary = anchor.get_emote_world_quad()
		bubble_x = float(quad.left) + float(quad.width) / 2.0 - bubble_width / 2.0 + offset_x
		bubble_y = float(quad.top) - QUAD_ABOVE_GAP - bubble_height + offset_y
		_dbg(
			"  热点 worldQuad→entityLayer quad xywh=(%.1f,%.1f) %.1f×%.1f bubble=(%.1f,%.1f) band=front" % [
				float(quad.left), float(quad.top), float(quad.width), float(quad.height), bubble_x, bubble_y,
			]
		)
	elif entity_attach_layer != null and display_obj.get_parent() == entity_attach_layer:
		attach_parent = entity_attach_layer
		bubble.set_meta("entitySortBand", "front")
		bubble_x = display_obj.position.x - bubble_width / 2.0 + offset_x
		bubble_y = display_obj.position.y + float(anchor.get_emote_bubble_anchor_local_y()) + offset_y - bubble_height
		follow = {
			"anchor": anchor,
			"displayObj": display_obj,
			"bw": bubble_width,
			"bh": bubble_height,
			"ox": offset_x,
			"oy": offset_y,
		}
		_dbg("  实体气泡→entityLayer 跟随 bubble=(%.1f,%.1f) band=front" % [bubble_x, bubble_y])
	elif anchor is RuntimeHotspot and entity_attach_layer == null:
		_dbg("  警告: Hotspot 但 entityAttachLayer 未设置，气泡仅在热点容器内（易被遮挡）")

	bubble.position = Vector2(bubble_x, bubble_y)
	attach_parent.add_child(bubble)
	_dbg(
		"  已 addChild: 父=%s bubble.xy=(%.1f,%.1f) bw×bh=%.0f×%.0f bubble.visible=%s bubble.renderable=%s" % [
			"entityLayer" if attach_parent == entity_attach_layer else "anchor本地",
			bubble_x, bubble_y, bubble_width, bubble_height,
			str(bubble.visible), str(bubble.is_visible_in_tree()),
		]
	)
	return {
		"bubble": bubble,
		"parent": attach_parent,
		"bw": bubble_width,
		"bh": bubble_height,
		"follow": follow,
	}


func show(
	anchor: Variant,
	emote: String,
	duration_ms: float = 1500.0,
	options: Variant = null,
	owner: Variant = null,
) -> void:
	var mounted := _build_and_mount_bubble(anchor, emote, options)
	_dbg("show 定时消失 durMs=%s%s" % [str(duration_ms), " owner=%s" % owner if owner != null else ""])
	active_bubbles.push_back({
		"bubble": mounted.bubble,
		"parent": mounted.parent,
		"remainingMs": duration_ms * _time_scale,
		"noAutoExpire": false,
		"owner": owner,
		"follow": mounted.follow,
	})


func show_sticky(
	anchor: Variant,
	emote: String,
	options: Variant = null,
	owner: Variant = null,
) -> Callable:
	var mounted := _build_and_mount_bubble(anchor, emote, options)
	_dbg("showSticky 无自动消失，须与字幕等同生命周期 dismiss")
	var entry := {
		"bubble": mounted.bubble,
		"parent": mounted.parent,
		"remainingMs": 0.0,
		"noAutoExpire": true,
		"owner": owner,
		"follow": mounted.follow,
	}
	active_bubbles.push_back(entry)
	return func() -> void:
		var index := -1
		for current_index: int in active_bubbles.size():
			if is_same(active_bubbles[current_index], entry):
				index = current_index
				break
		if index < 0:
			return
		_remove_bubble(entry)
		active_bubbles.remove_at(index)


func show_and_wait(
	anchor: Variant,
	emote: String,
	duration_ms: float = 1500.0,
	options: Variant = null,
	owner: Variant = null,
) -> void:
	show(anchor, emote, duration_ms, options, owner)
	var timer := Timer.new()
	timer.one_shot = true
	timer.wait_time = maxf(duration_ms * _time_scale / 1000.0, 0.000001)
	add_child(timer)
	pending_timers[timer] = true
	timer.start()
	await timer.timeout
	pending_timers.erase(timer)
	timer.queue_free()


func update(dt: float) -> void:
	for index: int in range(active_bubbles.size() - 1, -1, -1):
		var entry := active_bubbles[index]
		var follow: Variant = entry.get("follow")
		if follow is Dictionary:
			var anchor: Variant = follow.anchor
			var display_obj: Variant = follow.displayObj
			if not display_obj is Node2D or not is_instance_valid(display_obj) or display_obj.get_parent() == null:
				_remove_bubble(entry)
				active_bubbles.remove_at(index)
				continue
			entry.bubble.position.x = display_obj.position.x - float(follow.bw) / 2.0 + float(follow.ox)
			entry.bubble.position.y = display_obj.position.y \
				+ float(anchor.get_emote_bubble_anchor_local_y()) + float(follow.oy) - float(follow.bh)
		if entry.get("noAutoExpire") == true:
			continue
		entry.remainingMs = float(entry.remainingMs) - dt * 1000.0
		if float(entry.remainingMs) <= 0.0:
			_remove_bubble(entry)
			active_bubbles.remove_at(index)


func _remove_bubble(entry: Dictionary) -> void:
	var bubble: Variant = entry.bubble
	if bubble is Node and is_instance_valid(bubble):
		if bubble.get_parent() != null:
			bubble.get_parent().remove_child(bubble)
		bubble.free()


func cleanup_by_owner(owner: String) -> void:
	for index: int in range(active_bubbles.size() - 1, -1, -1):
		var entry := active_bubbles[index]
		if entry.get("owner") != owner:
			continue
		_remove_bubble(entry)
		active_bubbles.remove_at(index)


func cleanup() -> void:
	for timer: Variant in pending_timers.keys():
		if timer is Timer and is_instance_valid(timer):
			timer.stop()
			timer.free()
	pending_timers.clear()
	for entry: Dictionary in active_bubbles:
		_remove_bubble(entry)
	active_bubbles.clear()


func destroy() -> void:
	cleanup()
	entity_attach_layer = null
	debug_panel_log = null


# ---- Godot test-clock adapter ----

func set_time_scale(value: float) -> void:
	_time_scale = maxf(0.0, value)
