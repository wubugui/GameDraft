class_name RuntimeCharacterBookUI
extends RefCounted

const PANEL_W := 650.0
const PANEL_H := 500.0
const PADDING := 20.0
const ENTRY_H := 30.0
const LIST_WIDTH := 180.0
const DETAIL_AREA_W := PANEL_W - LIST_WIDTH - PADDING * 2.0
const DETAIL_AREA_H := PANEL_H - 70.0

var renderer: RuntimeRenderer
var archive_data: Variant
var asset_manager: RuntimeAssetManager
var container: Control = null
var detail_container: Control = null
var detail_mask: Control = null
var detail_scroll_offset := 0.0
var detail_total_h := 0.0
var on_close: Callable
var strings: RuntimeStringsProvider
var list_scroll_offset := 0.0
var list_content_h := 0.0
var list_container: Control = null
var on_wheel_bound: Callable
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
	detail_scroll_offset = 0.0
	_build()


func close() -> void:
	if container != null and is_instance_valid(container) and container.gui_input.is_connected(on_wheel_bound):
		container.gui_input.disconnect(on_wheel_bound)
	_destroy_ui()


func _build() -> void:
	_destroy_ui()
	container = Control.new()
	container.name = "RuntimeCharacterBookUI"
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
	title.text = strings.get_text("characterBook", "title")
	title.position = Vector2(panel_x + PADDING, panel_y + 12.0)
	title.size = Vector2(PANEL_W - 40.0, 28.0)
	title.add_theme_font_size_override("font_size", 18)
	title.add_theme_color_override("font_color", Color("e8cf8e"))
	title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(title)

	var back_button := Button.new()
	back_button.text = strings.get_text("characterBook", "back")
	back_button.flat = true
	back_button.position = Vector2(panel_x + PANEL_W - 100.0, panel_y + 8.0)
	back_button.size = Vector2(88.0, 34.0)
	back_button.mouse_filter = Control.MOUSE_FILTER_PASS
	back_button.add_theme_font_size_override("font_size", 13)
	back_button.add_theme_color_override("font_color", Color("c9aa67"))
	back_button.pressed.connect(func() -> void: on_close.call(), CONNECT_DEFERRED)
	container.add_child(back_button)

	var characters: Array = archive_data.get_unlocked_characters()
	var list_mask := Control.new()
	list_mask.position = Vector2(panel_x, panel_y + 50.0)
	list_mask.size = Vector2(LIST_WIDTH, DETAIL_AREA_H)
	list_mask.clip_contents = true
	list_mask.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(list_mask)

	list_container = Control.new()
	list_container.position = Vector2.ZERO
	list_container.size = Vector2(LIST_WIDTH, maxf(DETAIL_AREA_H, 50.0 + characters.size() * ENTRY_H))
	list_container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	list_mask.add_child(list_container)

	if characters.is_empty():
		var empty := Label.new()
		empty.text = strings.get_text("characterBook", "empty")
		empty.position = Vector2(PADDING, 0.0)
		empty.size = Vector2(160.0, 24.0)
		empty.add_theme_font_size_override("font_size", 12)
		empty.add_theme_color_override("font_color", Color("918b84"))
		empty.mouse_filter = Control.MOUSE_FILTER_IGNORE
		list_container.add_child(empty)

	for index in characters.size():
		var character: Dictionary = characters[index]
		var character_id := str(character.get("id", ""))
		var is_new: bool = not archive_data.is_read("char_%s" % character_id)
		var label := Button.new()
		label.text = ("* " if is_new else "") + archive_data.resolve_line(character.get("name", ""))
		label.flat = true
		label.alignment = HORIZONTAL_ALIGNMENT_LEFT
		label.position = Vector2(PADDING, index * ENTRY_H)
		label.size = Vector2(160.0, ENTRY_H)
		label.mouse_filter = Control.MOUSE_FILTER_PASS
		label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		label.add_theme_font_size_override("font_size", 13)
		label.add_theme_color_override("font_color", Color("e8cf8e") if is_new else Color("c6c1b8"))
		var select_character := func(entry: Dictionary, entry_id: String, detail_x: float, detail_y: float) -> void:
			archive_data.trigger_first_view_if_needed("char_%s" % entry_id, entry.get("firstViewActions"))
			archive_data.mark_read("char_%s" % entry_id)
			_show_detail(entry_id, detail_x, detail_y)
		label.pressed.connect(select_character.bind(character, character_id, panel_x + PADDING + LIST_WIDTH, panel_y + 50.0))
		list_container.add_child(label)

	list_content_h = 50.0 + characters.size() * ENTRY_H
	renderer.ui_layer.add_child(container)
	container.gui_input.connect(on_wheel_bound)
	container.modulate = Color(1.0, 1.0, 1.0, 0.0)
	var tween := container.create_tween()
	tween.tween_property(container, "modulate:a", 1.0, 0.15)


func _show_detail(character_id: String, detail_x: float, detail_y: float) -> void:
	if detail_container != null and is_instance_valid(detail_container):
		if detail_container.get_parent() != null:
			detail_container.get_parent().remove_child(detail_container)
		detail_container.free()
	detail_container = null
	if detail_mask != null and is_instance_valid(detail_mask):
		if detail_mask.get_parent() != null:
			detail_mask.get_parent().remove_child(detail_mask)
		detail_mask.free()
	detail_mask = null
	detail_scroll_offset = 0.0

	var characters: Array = archive_data.get_unlocked_characters()
	var character: Variant = null
	for value: Variant in characters:
		if value is Dictionary and str(value.get("id", "")) == character_id:
			character = value
			break
	if not character is Dictionary:
		return

	var parts: Array[String] = []
	parts.push_back("%s - %s" % [archive_data.resolve_line(character.get("name", "")), archive_data.resolve_line(character.get("title", ""))])
	var impressions: Array = archive_data.get_character_visible_impressions(character)
	if not impressions.is_empty():
		parts.push_back("\n%s" % strings.get_text("characterBook", "impression"))
		for impression: Variant in impressions:
			parts.push_back("  %s" % str(impression))
	var infos: Array = archive_data.get_character_visible_info(character)
	if not infos.is_empty():
		parts.push_back("\n%s" % strings.get_text("characterBook", "knownIntel"))
		for info: Variant in infos:
			parts.push_back("  %s" % str(info))
	var raw := "\n".join(parts)

	detail_mask = Control.new()
	detail_mask.position = Vector2(detail_x, detail_y)
	detail_mask.size = Vector2(DETAIL_AREA_W, DETAIL_AREA_H)
	detail_mask.clip_contents = true
	detail_mask.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(detail_mask)
	detail_container = Control.new()
	detail_container.position = Vector2.ZERO
	detail_container.size = Vector2(DETAIL_AREA_W, DETAIL_AREA_H)
	detail_container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	detail_mask.add_child(detail_container)

	var rich_content := RichTextLabel.new()
	rich_content.position = Vector2.ZERO
	rich_content.size = Vector2(DETAIL_AREA_W, 4096.0)
	rich_content.fit_content = true
	rich_content.bbcode_enabled = false
	rich_content.scroll_active = false
	rich_content.mouse_filter = Control.MOUSE_FILTER_IGNORE
	rich_content.add_theme_font_size_override("normal_font_size", 12)
	rich_content.add_theme_color_override("default_color", Color("c6c1b8"))
	detail_container.add_child(rich_content)
	var segments: Array = RuntimeRichContent.parse_segments(raw)
	var has_image := false
	for segment: Variant in segments:
		if segment is Dictionary and segment.get("type") == "image":
			has_image = true
			break
	if not has_image:
		rich_content.text = raw
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
					var scale := minf(minf(DETAIL_AREA_W / maxf(1.0, texture.get_width()), 200.0 / maxf(1.0, texture.get_height())), 1.0)
					rich_content.add_image(texture, maxi(1, int(round(texture.get_width() * scale))), maxi(1, int(round(texture.get_height() * scale))))
				else:
					rich_content.add_text("[%s]" % str(segment.get("path", "")))
			rich_content.add_text("\n\n")
	detail_total_h = maxf(float(rich_content.get_content_height()), rich_content.get_combined_minimum_size().y)
	rich_content.size.y = maxf(DETAIL_AREA_H, detail_total_h)
	detail_container.size.y = rich_content.size.y


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
	var mouse_in_detail_area: bool = mouse_event.position.x > panel_x + PADDING + LIST_WIDTH

	if mouse_in_detail_area and detail_container != null:
		var max_scroll := maxf(0.0, detail_total_h - DETAIL_AREA_H)
		if max_scroll <= 0.0:
			return
		detail_scroll_offset = clampf(detail_scroll_offset + delta_y, 0.0, max_scroll)
		detail_container.position.y = -detail_scroll_offset
	elif list_container != null:
		var max_scroll := maxf(0.0, list_content_h - DETAIL_AREA_H)
		if max_scroll <= 0.0:
			return
		list_scroll_offset = clampf(list_scroll_offset + delta_y, 0.0, max_scroll)
		list_container.position.y = -list_scroll_offset


func _destroy_ui() -> void:
	if detail_container != null and is_instance_valid(detail_container):
		if detail_container.get_parent() != null:
			detail_container.get_parent().remove_child(detail_container)
		detail_container.free()
	detail_container = null
	detail_mask = null
	list_container = null
	if container != null and is_instance_valid(container):
		if container.get_parent() != null:
			container.get_parent().remove_child(container)
		container.free()
	container = null
