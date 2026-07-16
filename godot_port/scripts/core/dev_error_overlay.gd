class_name RuntimeDevErrorOverlay
extends RefCounted

static var container: CanvasLayer
static var list_el: VBoxContainer
static var seen: Dictionary = {}


static func _ensure_overlay() -> void:
	if not OS.is_debug_build() or DisplayServer.get_name() == "headless" or (container != null and is_instance_valid(container)):
		return
	var main_loop := Engine.get_main_loop()
	if not main_loop is SceneTree or main_loop.root == null:
		return
	container = CanvasLayer.new()
	container.name = "GameDraftDevErrorOverlay"
	container.layer = 2147483647

	var panel := PanelContainer.new()
	panel.set_anchors_preset(Control.PRESET_TOP_WIDE)
	panel.offset_bottom = minf(320.0, main_loop.root.size.y * 0.4)
	panel.mouse_filter = Control.MOUSE_FILTER_STOP
	var panel_style := StyleBoxFlat.new()
	panel_style.bg_color = Color(0.47, 0.0, 0.0, 0.92)
	panel_style.border_color = Color("ff5555")
	panel_style.border_width_bottom = 2
	panel_style.content_margin_left = 8.0
	panel_style.content_margin_right = 8.0
	panel_style.content_margin_top = 4.0
	panel_style.content_margin_bottom = 4.0
	panel.add_theme_stylebox_override("panel", panel_style)
	container.add_child(panel)

	var body := VBoxContainer.new()
	panel.add_child(body)
	var header := HBoxContainer.new()
	body.add_child(header)
	var title := Label.new()
	title.text = "⚠ 运行时问题 (dev) — 不应静默"
	title.add_theme_font_size_override("font_size", 12)
	title.add_theme_color_override("font_color", Color.WHITE)
	header.add_child(title)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	header.add_child(spacer)
	var clear_button := Button.new()
	clear_button.text = "清除"
	clear_button.pressed.connect(func() -> void: clear_dev_errors())
	header.add_child(clear_button)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	body.add_child(scroll)
	list_el = VBoxContainer.new()
	list_el.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(list_el)
	main_loop.root.add_child(container)


static func report_dev_error(message: String, console_tag: String = "[load-failure]") -> void:
	if not OS.is_debug_build():
		return
	push_error(console_tag + " " + message)
	_ensure_overlay()
	if list_el == null or not is_instance_valid(list_el):
		return
	var existing: Variant = seen.get(message)
	if existing is Dictionary:
		existing.count = int(existing.count) + 1
		existing.row.text = "×%s  %s" % [existing.count, message]
		return
	var row := Label.new()
	row.text = message
	row.autowrap_mode = TextServer.AUTOWRAP_ARBITRARY
	row.add_theme_font_size_override("font_size", 12)
	row.add_theme_color_override("font_color", Color.WHITE)
	list_el.add_child(row)
	seen[message] = {"count": 1, "row": row}


static func describe_error(error: Variant) -> String:
	if error is Dictionary or error is Array:
		return JSON.stringify(error)
	return str(error)


static func clear_dev_errors() -> void:
	seen.clear()
	if container != null and is_instance_valid(container):
		if container.get_parent() != null:
			container.get_parent().remove_child(container)
		container.free()
	container = null
	list_el = null
