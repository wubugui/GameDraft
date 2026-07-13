class_name RuntimeTextPanel
extends RefCounted

var renderer: RuntimeRenderer
var strings: RuntimeStringsProvider
var root: Control
var panel: Panel
var title_label: Label
var content: RichTextLabel
var action_scroll: ScrollContainer
var action_list: VBoxContainer
var action_buttons: Array[Button] = []
var _resolve_display := Callable()
var rich_image_count := 0


func _init(next_renderer: RuntimeRenderer, next_strings: RuntimeStringsProvider) -> void:
	renderer = next_renderer
	strings = next_strings


func set_resolve_display(callback: Callable = Callable()) -> void: _resolve_display = callback
func is_open() -> bool: return root != null
func open() -> void:
	if is_open(): return
	_build_shell()
	refresh()
func close() -> void:
	if root != null and is_instance_valid(root):
		if root.get_parent() != null: root.get_parent().remove_child(root)
		root.free()
	root = null; panel = null; title_label = null; content = null; action_scroll = null; action_list = null; action_buttons.clear(); rich_image_count = 0
func destroy() -> void: close(); _resolve_display = Callable()
func refresh() -> void: return
func panel_title() -> String: return ""
func body_text() -> String: return ""
func resolve(raw: String) -> String: return str(_resolve_display.call(raw)) if _resolve_display.is_valid() else raw


func set_action_rows(rows: Array) -> void:
	if action_list == null or content == null: return
	for child: Node in action_list.get_children(): child.queue_free()
	action_buttons.clear()
	for raw: Variant in rows:
		if not raw is Dictionary: continue
		var row: Dictionary = raw; var button := Button.new(); button.text = str(row.get("label", "")); button.disabled = row.get("enabled", true) != true; button.tooltip_text = str(row.get("tooltip", "")); button.focus_mode = Control.FOCUS_ALL; button.custom_minimum_size = Vector2(190, 32)
		if row.has("id"): button.set_meta("action_id", row.id)
		var callback: Variant = row.get("callback"); if callback is Callable and callback.is_valid(): button.pressed.connect(callback, CONNECT_DEFERRED)
		action_list.add_child(button); action_buttons.push_back(button)
	action_scroll.visible = not action_buttons.is_empty()
	if action_scroll.visible:
		content.position.x = 230; content.size.x = panel.size.x - 250
	else:
		content.position.x = 20; content.size.x = panel.size.x - 40


func get_action_button_count() -> int: return action_buttons.size()
func get_rich_image_count() -> int: return rich_image_count


func set_rich_content(raw: String, asset_manager: RuntimeAssetManager) -> void:
	if content == null: return
	content.clear(); rich_image_count = 0
	var segments := RuntimeTextResolver.new().parse_rich_segments(raw, asset_manager.locator)
	var has_image := false
	for segment: Variant in segments:
		if segment is Dictionary and segment.get("type") == "image": has_image = true; break
	if not has_image: content.text = raw; return
	for segment: Variant in segments:
		if not segment is Dictionary: continue
		if segment.get("type") == "text":
			content.add_text(str(segment.get("text", "")))
		else:
			var texture: Variant = asset_manager.load_texture(str(segment.get("url", "")))
			if texture is Texture2D:
				var scale := minf(minf(content.size.x / maxf(1.0, texture.get_width()), 200.0 / maxf(1.0, texture.get_height())), 1.0)
				content.add_image(texture, maxi(1, int(round(texture.get_width() * scale))), maxi(1, int(round(texture.get_height() * scale))))
				rich_image_count += 1
			else: content.add_text("[%s]" % str(segment.get("path", "")))
		content.add_text("\n\n")


func _build_shell() -> void:
	var screen := Vector2(renderer.get_screen_width(), renderer.get_screen_height()); var width := minf(640, screen.x - 40); var height := minf(620, screen.y - 40); var origin := (screen - Vector2(width, height)) / 2.0
	root = Control.new(); root.name = get_script().get_global_name(); root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); root.mouse_filter = Control.MOUSE_FILTER_STOP
	var shade := ColorRect.new(); shade.color = Color(0, 0, 0, 0.68); shade.size = screen; shade.mouse_filter = Control.MOUSE_FILTER_STOP; root.add_child(shade)
	panel = Panel.new(); panel.position = origin; panel.size = Vector2(width, height); var style := StyleBoxFlat.new(); style.bg_color = Color("121823"); style.border_color = Color("78633d"); style.set_border_width_all(2); style.set_corner_radius_all(7); panel.add_theme_stylebox_override("panel", style); root.add_child(panel)
	title_label = Label.new(); title_label.position = Vector2(20, 12); title_label.size = Vector2(width - 40, 30); title_label.add_theme_font_size_override("font_size", 18); title_label.add_theme_color_override("font_color", Color("e8cf8e")); panel.add_child(title_label)
	content = RichTextLabel.new(); content.position = Vector2(20, 48); content.size = Vector2(width - 40, height - 80); content.bbcode_enabled = false; content.fit_content = false; content.scroll_active = true; content.add_theme_font_size_override("normal_font_size", 13); content.add_theme_color_override("default_color", Color("d8dde8")); panel.add_child(content)
	action_scroll = ScrollContainer.new(); action_scroll.position = Vector2(20, 48); action_scroll.size = Vector2(200, height - 80); action_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED; action_scroll.visible = false; panel.add_child(action_scroll)
	action_list = VBoxContainer.new(); action_list.custom_minimum_size = Vector2(190, 0); action_list.add_theme_constant_override("separation", 6); action_scroll.add_child(action_list)
	renderer.ui_layer.add_child(root)
