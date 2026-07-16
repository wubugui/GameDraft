class_name RuntimeDocumentBoxUI
extends RefCounted

const PANEL_W := 650.0
const PANEL_H := 500.0
const PADDING := 20.0
const ENTRY_H := 28.0
const CONTENT_X_OFFSET := 200.0
const CONTENT_AREA_W := PANEL_W - CONTENT_X_OFFSET - PADDING
const CONTENT_AREA_H := PANEL_H - 70.0

var renderer: RuntimeRenderer
var archive_data: Variant
var asset_manager: RuntimeAssetManager
var container: Control = null
var content_container: Control = null
var content_mask: Control = null
var content_scroll_offset := 0.0
var content_total_h := 0.0
var list_scroll_offset := 0.0
var list_content_h := 0.0
var list_container: Control = null
var on_wheel_bound: Callable
var on_close: Callable
var strings: RuntimeStringsProvider
var panel_x := 0.0


func _init(
	next_renderer: RuntimeRenderer,
	next_archive_data: Variant,
	next_on_close: Callable,
	next_strings: RuntimeStringsProvider,
	next_asset_manager: RuntimeAssetManager,
) -> void:
	renderer = next_renderer
	archive_data = next_archive_data
	asset_manager = next_asset_manager
	on_close = next_on_close
	strings = next_strings
	on_wheel_bound = Callable(self, "_on_wheel")


func destroy() -> void:
	close()


func open() -> void:
	list_scroll_offset = 0.0
	content_scroll_offset = 0.0
	_build()


func close() -> void:
	if container != null and is_instance_valid(container) and container.gui_input.is_connected(on_wheel_bound):
		container.gui_input.disconnect(on_wheel_bound)
	_destroy_ui()


func _build() -> void:
	_destroy_ui()
	list_scroll_offset = 0.0
	content_scroll_offset = 0.0
	container = Control.new()
	container.name = "RuntimeDocumentBoxUI"
	container.mouse_filter = Control.MOUSE_FILTER_STOP
	container.set_anchors_and_offsets_preset(Control.PRESET_TOP_LEFT)

	var screen_width := renderer.screen_width
	var screen_height := renderer.screen_height
	container.size = Vector2(screen_width, screen_height)
	var panel_y := (screen_height - PANEL_H) / 2.0
	panel_x = (screen_width - PANEL_W) / 2.0

	var overlay := ColorRect.new()
	overlay.color = Color(0.0, 0.0, 0.0, 0.68)
	overlay.size = Vector2(screen_width, screen_height)
	overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(overlay)

	var background := Panel.new()
	background.position = Vector2(panel_x, panel_y)
	background.size = Vector2(PANEL_W, PANEL_H)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var background_style := StyleBoxFlat.new()
	background_style.bg_color = Color("121823")
	background_style.border_color = Color("78633d")
	background_style.set_border_width_all(2)
	background_style.set_corner_radius_all(7)
	background.add_theme_stylebox_override("panel", background_style)
	container.add_child(background)

	var title := Label.new()
	title.text = strings.get_text("documentBox", "title")
	title.position = Vector2(panel_x + PADDING, panel_y + 12.0)
	title.size = Vector2(PANEL_W - 40.0, 28.0)
	title.add_theme_font_size_override("font_size", 18)
	title.add_theme_color_override("font_color", Color("e8cf8e"))
	title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(title)

	var back_button := Button.new()
	back_button.text = strings.get_text("documentBox", "back")
	back_button.flat = true
	back_button.position = Vector2(panel_x + PANEL_W - 100.0, panel_y + 8.0)
	back_button.size = Vector2(88.0, 34.0)
	back_button.mouse_filter = Control.MOUSE_FILTER_PASS
	back_button.add_theme_font_size_override("font_size", 13)
	back_button.add_theme_color_override("font_color", Color("c9aa67"))
	back_button.pressed.connect(func() -> void: on_close.call(), CONNECT_DEFERRED)
	container.add_child(back_button)

	var documents: Array = archive_data.get_unlocked_documents()
	var list_y := panel_y + 50.0
	var list_mask := Control.new()
	list_mask.position = Vector2(panel_x, list_y)
	list_mask.size = Vector2(180.0, CONTENT_AREA_H)
	list_mask.clip_contents = true
	list_mask.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(list_mask)

	list_container = Control.new()
	list_container.position = Vector2.ZERO
	list_container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	list_mask.add_child(list_container)

	if documents.is_empty():
		var empty := Label.new()
		empty.text = strings.get_text("documentBox", "empty")
		empty.position = Vector2(PADDING, 0.0)
		empty.size = Vector2(160.0, 24.0)
		empty.add_theme_font_size_override("font_size", 12)
		empty.add_theme_color_override("font_color", Color("918b84"))
		empty.mouse_filter = Control.MOUSE_FILTER_IGNORE
		list_container.add_child(empty)
	else:
		var cursor_y := 0.0
		for document_value: Variant in documents:
			if not document_value is Dictionary:
				continue
			var document: Dictionary = document_value
			var document_id := str(document.get("id", ""))
			var is_new: bool = not archive_data.is_read("doc_%s" % document_id)
			var label := Button.new()
			label.text = ("* " if is_new else "") + archive_data.resolve_line(document.get("name", ""))
			label.flat = true
			label.alignment = HORIZONTAL_ALIGNMENT_LEFT
			label.position = Vector2(PADDING, cursor_y)
			label.size = Vector2(160.0, ENTRY_H)
			label.mouse_filter = Control.MOUSE_FILTER_PASS
			label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
			label.add_theme_font_size_override("font_size", 13)
			label.add_theme_color_override("font_color", Color("e8cf8e") if is_new else Color("c6c1b8"))
			var select_document := func(selected: Dictionary, selected_id: String, content_x: float, content_y: float) -> void:
				archive_data.trigger_first_view_if_needed("doc_%s" % selected_id, selected.get("firstViewActions"))
				archive_data.mark_read("doc_%s" % selected_id)
				_show_content(
					archive_data.resolve_line(selected.get("content", "")),
					archive_data.resolve_line(selected.get("annotation", "")) if selected.has("annotation") else null,
					content_x,
					content_y,
				)
			label.pressed.connect(select_document.bind(document, document_id, panel_x + CONTENT_X_OFFSET, panel_y + 50.0))
			list_container.add_child(label)
			cursor_y += ENTRY_H
		list_content_h = cursor_y

	list_container.size = Vector2(180.0, maxf(CONTENT_AREA_H, list_content_h))
	renderer.ui_layer.add_child(container)
	container.gui_input.connect(on_wheel_bound)
	container.modulate = Color(1.0, 1.0, 1.0, 0.0)
	var tween := container.create_tween()
	tween.tween_property(container, "modulate:a", 1.0, 0.15)


func _show_content(content_text: String, annotation: Variant, x: float, y: float) -> void:
	if content_container != null and is_instance_valid(content_container):
		if content_container.get_parent() != null:
			content_container.get_parent().remove_child(content_container)
		content_container.free()
	content_container = null
	if content_mask != null and is_instance_valid(content_mask):
		if content_mask.get_parent() != null:
			content_mask.get_parent().remove_child(content_mask)
		content_mask.free()
	content_mask = null
	content_scroll_offset = 0.0

	var annotation_text := str(annotation) if annotation != null else ""
	var full_text := "%s\n\n%s %s" % [content_text, strings.get_text("documentBox", "note"), annotation_text] if not annotation_text.is_empty() else content_text
	content_mask = Control.new()
	content_mask.position = Vector2(x, y)
	content_mask.size = Vector2(CONTENT_AREA_W, CONTENT_AREA_H)
	content_mask.clip_contents = true
	content_mask.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(content_mask)
	content_container = Control.new()
	content_container.position = Vector2.ZERO
	content_container.size = Vector2(CONTENT_AREA_W, CONTENT_AREA_H)
	content_container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	content_mask.add_child(content_container)

	var rich_content := RichTextLabel.new()
	rich_content.position = Vector2.ZERO
	rich_content.size = Vector2(CONTENT_AREA_W, 4096.0)
	rich_content.fit_content = true
	rich_content.bbcode_enabled = false
	rich_content.scroll_active = false
	rich_content.mouse_filter = Control.MOUSE_FILTER_IGNORE
	rich_content.add_theme_font_size_override("normal_font_size", 12)
	rich_content.add_theme_color_override("default_color", Color("c6c1b8"))
	content_container.add_child(rich_content)
	var segments: Array = RuntimeRichContent.parse_segments(full_text)
	var has_image := false
	for segment: Variant in segments:
		if segment is Dictionary and segment.get("type") == "image":
			has_image = true
			break
	if not has_image:
		rich_content.text = full_text
	else:
		for segment: Variant in segments:
			if not segment is Dictionary:
				continue
			if segment.get("type") == "text":
				rich_content.add_text(str(segment.get("text", "")))
			else:
				var url := RuntimeRichContent.resolve_content_image_url(str(segment.get("path", "")), RuntimeResourceLocator.get_default())
				var texture: Variant = asset_manager.load_texture(url)
				if texture is Texture2D:
					var scale := minf(minf(CONTENT_AREA_W / maxf(1.0, texture.get_width()), 200.0 / maxf(1.0, texture.get_height())), 1.0)
					rich_content.add_image(texture, maxi(1, int(round(texture.get_width() * scale))), maxi(1, int(round(texture.get_height() * scale))))
				else:
					rich_content.add_text("[%s]" % str(segment.get("path", "")))
			rich_content.add_text("\n\n")
	content_total_h = maxf(float(rich_content.get_content_height()), rich_content.get_combined_minimum_size().y)
	rich_content.size.y = maxf(CONTENT_AREA_H, content_total_h)
	content_container.size.y = rich_content.size.y


func _on_wheel(event: InputEvent) -> void:
	if not event is InputEventMouseButton or not event.pressed:
		return
	if event.button_index != MOUSE_BUTTON_WHEEL_UP and event.button_index != MOUSE_BUTTON_WHEEL_DOWN:
		return
	if container == null:
		return
	var mouse_event := event as InputEventMouseButton
	container.accept_event()
	var delta_y := (-1.0 if mouse_event.button_index == MOUSE_BUTTON_WHEEL_UP else 1.0) * maxf(1.0, mouse_event.factor) * 24.0
	var mouse_in_content_area: bool = mouse_event.position.x > panel_x + CONTENT_X_OFFSET

	if mouse_in_content_area and content_container != null:
		var max_scroll := maxf(0.0, content_total_h - CONTENT_AREA_H)
		if max_scroll <= 0.0:
			return
		content_scroll_offset = clampf(content_scroll_offset + delta_y, 0.0, max_scroll)
		content_container.position.y = -content_scroll_offset
	elif list_container != null:
		var max_scroll := maxf(0.0, list_content_h - CONTENT_AREA_H)
		if max_scroll <= 0.0:
			return
		list_scroll_offset = clampf(list_scroll_offset + delta_y, 0.0, max_scroll)
		list_container.position.y = -list_scroll_offset


func _destroy_ui() -> void:
	content_container = null
	content_mask = null
	list_container = null
	if container != null and is_instance_valid(container):
		if container.get_parent() != null:
			container.get_parent().remove_child(container)
		container.free()
	container = null
