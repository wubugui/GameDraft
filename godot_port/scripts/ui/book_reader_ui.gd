class_name RuntimeBookReaderUI
extends RefCounted

const PANEL_W := 820.0
const PANEL_H := 560.0
const PADDING := 20.0
const BOTTOM_BAR := 36.0
const TOC_W := 208.0
const TOC_GAP := 14.0

var renderer: RuntimeRenderer
var archive_data: Variant
var asset_manager: RuntimeAssetManager
var container: Control = null
var current_book: Variant = null
var nav_page_num := 1
var nav_entry_id: Variant = null
var on_close_cb: Variant = null
var on_wheel_bound: Callable
var strings: RuntimeStringsProvider
var content_container: Control = null
var content_scroll_offset := 0.0
var content_total_h := 0.0
var scroll_anchor_y := 0.0
var content_viewport_h := 0.0
var toc_container: Control = null
var toc_scroll_offset := 0.0
var toc_total_h := 0.0
var toc_viewport_h := 0.0
var toc_anchor_y := 0.0
var wheel_layout: Variant = null


func _init(
	next_renderer: RuntimeRenderer,
	next_archive_data: Variant,
	next_strings: RuntimeStringsProvider,
	next_asset_manager: RuntimeAssetManager,
) -> void:
	renderer = next_renderer
	archive_data = next_archive_data
	asset_manager = next_asset_manager
	on_wheel_bound = Callable(self, "_on_wheel")
	strings = next_strings


func open_book(book: Dictionary, on_close: Callable) -> void:
	current_book = book
	var toc: Array = archive_data.get_book_toc_chapters(book)
	var first: Variant = toc[0] if not toc.is_empty() else null
	nav_page_num = int(first.get("pageNum", 1)) if first is Dictionary else 1
	nav_entry_id = null
	on_close_cb = on_close
	_fire_slice_first_view()
	_build(true)


func _navigate(page_num: int, entry_id: Variant) -> void:
	nav_page_num = page_num
	nav_entry_id = entry_id
	_fire_slice_first_view()
	_build(false)


func _fire_slice_first_view() -> void:
	if not current_book is Dictionary:
		return
	var resolved := _resolve_slice(current_book)
	var slice: Variant = resolved.get("slice")
	if slice is Dictionary and slice.get("unlocked") == true:
		archive_data.trigger_book_slice_first_view(str(current_book.get("id", "")), slice)


func close() -> void:
	if container != null and is_instance_valid(container) and container.gui_input.is_connected(on_wheel_bound):
		container.gui_input.disconnect(on_wheel_bound)
	_destroy_ui()
	current_book = null
	on_close_cb = null


func destroy() -> void:
	close()


func _resolve_slice(book: Dictionary) -> Dictionary:
	if nav_entry_id != null and not str(nav_entry_id).is_empty():
		var slice: Variant = archive_data.get_book_entry_slice(book, nav_page_num, str(nav_entry_id))
		if slice != null:
			return {"slice": slice, "entryLocked": false}
		var toc: Array = archive_data.get_book_toc_chapters(book)
		var chapter: Variant = null
		for chapter_value: Variant in toc:
			if chapter_value is Dictionary and int(chapter_value.get("pageNum", 0)) == nav_page_num:
				chapter = chapter_value
				break
		var entry: Variant = null
		if chapter is Dictionary:
			for entry_value: Variant in chapter.get("entries", []):
				if entry_value is Dictionary and str(entry_value.get("id", "")) == str(nav_entry_id):
					entry = entry_value
					break
		return {"slice": null, "entryLocked": entry is Dictionary and entry.get("unlocked") != true}
	var page_slice: Variant = archive_data.get_book_page_slice(book, nav_page_num)
	return {"slice": page_slice, "entryLocked": false}


func _build(animate_open := false) -> void:
	var previous_toc_scroll := 0.0 if animate_open else toc_scroll_offset
	_destroy_ui()
	if not current_book is Dictionary:
		return

	content_scroll_offset = 0.0
	container = Control.new()
	container.name = "RuntimeBookReaderUI"
	container.mouse_filter = Control.MOUSE_FILTER_STOP
	container.set_anchors_and_offsets_preset(Control.PRESET_TOP_LEFT)

	var screen_width := renderer.screen_width
	var screen_height := renderer.screen_height
	container.size = Vector2(screen_width, screen_height)
	var panel_x := (screen_width - PANEL_W) / 2.0
	var panel_y := (screen_height - PANEL_H) / 2.0

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
	background_style.bg_color = Color("17130f")
	background_style.border_color = Color("8a7043")
	background_style.set_border_width_all(2)
	background_style.set_corner_radius_all(7)
	background.add_theme_stylebox_override("panel", background_style)
	container.add_child(background)

	var title := Label.new()
	title.text = archive_data.resolve_line(current_book.get("title", ""))
	title.position = Vector2(panel_x + PADDING, panel_y + 14.0)
	title.size = Vector2(PANEL_W - PADDING * 2.0, 28.0)
	title.add_theme_font_size_override("font_size", 18)
	title.add_theme_color_override("font_color", Color("e8cf8e"))
	title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(title)

	var back_button := Button.new()
	back_button.text = strings.get_text("bookReader", "back")
	back_button.flat = true
	back_button.position = Vector2(panel_x + PANEL_W - 100.0, panel_y + 8.0)
	back_button.size = Vector2(88.0, 34.0)
	back_button.mouse_filter = Control.MOUSE_FILTER_PASS
	back_button.add_theme_font_size_override("font_size", 13)
	back_button.add_theme_color_override("font_color", Color("c9aa67"))
	back_button.pressed.connect(func() -> void:
		if on_close_cb is Callable:
			on_close_cb.call()
	, CONNECT_DEFERRED)
	container.add_child(back_button)

	var toc_chapters: Array = archive_data.get_book_toc_chapters(current_book)
	var toc_title := Label.new()
	toc_title.text = strings.get_text("bookReader", "tocTitle")
	toc_title.position = Vector2(panel_x + PADDING, panel_y + 44.0)
	toc_title.size = Vector2(TOC_W, 18.0)
	toc_title.add_theme_font_size_override("font_size", 12)
	toc_title.add_theme_color_override("font_color", Color("c9aa67"))
	toc_title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(toc_title)

	toc_anchor_y = panel_y + 62.0
	toc_viewport_h = maxf(80.0, panel_y + PANEL_H - BOTTOM_BAR - toc_anchor_y)
	var toc_column_background := Panel.new()
	toc_column_background.position = Vector2(panel_x + PADDING - 4.0, toc_anchor_y - 4.0)
	toc_column_background.size = Vector2(TOC_W + 8.0, toc_viewport_h + 8.0)
	toc_column_background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var toc_style := StyleBoxFlat.new()
	toc_style.bg_color = Color(0.10, 0.08, 0.06, 0.8)
	toc_style.border_color = Color(0.35, 0.29, 0.20, 0.9)
	toc_style.set_border_width_all(1)
	toc_style.set_corner_radius_all(4)
	toc_column_background.add_theme_stylebox_override("panel", toc_style)
	container.add_child(toc_column_background)

	var toc_mask := Control.new()
	toc_mask.position = Vector2(panel_x + PADDING, toc_anchor_y)
	toc_mask.size = Vector2(TOC_W, toc_viewport_h)
	toc_mask.clip_contents = true
	toc_mask.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(toc_mask)
	toc_container = Control.new()
	toc_container.position = Vector2.ZERO
	toc_container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	toc_mask.add_child(toc_container)
	var toc_state := {"y": 0.0}
	var make_toc_line := func(
		label_text: String,
		page_num: int,
		entry_id: Variant,
		indent: float,
		muted: bool,
		selected: bool,
	) -> void:
		var line := Button.new()
		line.text = label_text
		line.flat = true
		line.alignment = HORIZONTAL_ALIGNMENT_LEFT
		line.position = Vector2(indent, float(toc_state.y))
		line.size = Vector2(TOC_W - 4.0 - indent, 28.0)
		line.mouse_filter = Control.MOUSE_FILTER_PASS
		line.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		line.add_theme_font_size_override("font_size", 12)
		line.add_theme_color_override("font_color", Color("d7b95f") if selected else (Color("736e66") if muted else Color("c6c1b8")))
		line.pressed.connect(func() -> void: _navigate(page_num, entry_id), CONNECT_DEFERRED)
		toc_container.add_child(line)
		toc_state.y = float(toc_state.y) + maxf(20.0, line.get_combined_minimum_size().y + 4.0)

	for chapter_value: Variant in toc_chapters:
		if not chapter_value is Dictionary:
			continue
		var chapter: Dictionary = chapter_value
		var chapter_page := int(chapter.get("pageNum", 1))
		var chapter_title := str(chapter.get("title", "")).strip_edges()
		if chapter_title.is_empty():
			chapter_title = strings.get_text("bookReader", "chapterFallback", {"n": str(chapter_page)})
		make_toc_line.call(chapter_title, chapter_page, null, 0.0, chapter.get("unlocked") != true, nav_page_num == chapter_page and nav_entry_id == null)
		for entry_value: Variant in chapter.get("entries", []):
			if not entry_value is Dictionary:
				continue
			var entry: Dictionary = entry_value
			var entry_id := str(entry.get("id", ""))
			var entry_unlocked: bool = entry.get("unlocked") == true
			var prefix := "· " if entry_unlocked else "○ "
			make_toc_line.call(prefix + str(entry.get("title", "")), chapter_page, entry_id, 14.0, not entry_unlocked, nav_page_num == chapter_page and str(nav_entry_id) == entry_id)

	toc_total_h = float(toc_state.y)
	var max_toc_scroll := maxf(0.0, toc_total_h - toc_viewport_h)
	toc_scroll_offset = clampf(previous_toc_scroll, 0.0, max_toc_scroll)
	toc_container.position.y = -toc_scroll_offset
	toc_container.size = Vector2(TOC_W, maxf(toc_viewport_h, toc_total_h))

	var divider := ColorRect.new()
	var divider_x := panel_x + PADDING + TOC_W + TOC_GAP / 2.0
	divider.color = Color(0.35, 0.29, 0.20, 0.9)
	divider.position = Vector2(divider_x, toc_anchor_y - 4.0)
	divider.size = Vector2(1.0, toc_viewport_h + 8.0)
	divider.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(divider)

	var content_left := panel_x + PADDING + TOC_W + TOC_GAP
	var content_width := PANEL_W - PADDING * 2.0 - TOC_W - TOC_GAP
	var resolved := _resolve_slice(current_book)
	var slice: Variant = resolved.get("slice")
	var entry_locked: bool = resolved.get("entryLocked") == true
	var title_block_end_y := toc_anchor_y

	if entry_locked:
		var locked := Label.new()
		locked.text = strings.get_text("bookReader", "entryLocked")
		locked.position = Vector2(content_left, toc_anchor_y)
		locked.size = Vector2(content_width, 36.0)
		locked.add_theme_font_size_override("font_size", 15)
		locked.add_theme_color_override("font_color", Color("6f6961"))
		locked.mouse_filter = Control.MOUSE_FILTER_IGNORE
		container.add_child(locked)
		title_block_end_y = toc_anchor_y + maxf(locked.get_combined_minimum_size().y, 20.0) + 16.0
	elif slice is Dictionary:
		if slice.get("unlocked") == true:
			if str(slice.get("kind", "")) == "page":
				var page_title := str(slice.get("title", ""))
				if not page_title.is_empty():
					var page_title_label := Label.new()
					page_title_label.text = page_title
					page_title_label.position = Vector2(content_left, toc_anchor_y)
					page_title_label.size = Vector2(content_width, 28.0)
					page_title_label.add_theme_font_size_override("font_size", 15)
					page_title_label.add_theme_color_override("font_color", Color("d7b95f"))
					page_title_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
					container.add_child(page_title_label)
					title_block_end_y = toc_anchor_y + maxf(page_title_label.get_combined_minimum_size().y, 18.0) + 10.0
			else:
				var chapter_name := str(slice.get("chapterTitle", "")).strip_edges()
				if not chapter_name.is_empty():
					var chapter_label := Label.new()
					chapter_label.text = strings.get_text("bookReader", "entryFromChapter", {"chapter": chapter_name})
					chapter_label.position = Vector2(content_left, toc_anchor_y)
					chapter_label.size = Vector2(content_width, 22.0)
					chapter_label.add_theme_font_size_override("font_size", 12)
					chapter_label.add_theme_color_override("font_color", Color("8e887d"))
					chapter_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
					container.add_child(chapter_label)
					title_block_end_y = toc_anchor_y + maxf(chapter_label.get_combined_minimum_size().y, 16.0) + 4.0
				var entry_title := Label.new()
				entry_title.text = str(slice.get("title", ""))
				entry_title.position = Vector2(content_left, title_block_end_y)
				entry_title.size = Vector2(content_width, 28.0)
				entry_title.add_theme_font_size_override("font_size", 15)
				entry_title.add_theme_color_override("font_color", Color("d7b95f"))
				entry_title.mouse_filter = Control.MOUSE_FILTER_IGNORE
				container.add_child(entry_title)
				title_block_end_y += maxf(entry_title.get_combined_minimum_size().y, 18.0) + 10.0
				var back_to_chapter := Button.new()
				back_to_chapter.text = strings.get_text("bookReader", "backToChapter")
				back_to_chapter.flat = true
				back_to_chapter.alignment = HORIZONTAL_ALIGNMENT_LEFT
				back_to_chapter.position = Vector2(content_left, title_block_end_y)
				back_to_chapter.size = Vector2(content_width, 24.0)
				back_to_chapter.mouse_filter = Control.MOUSE_FILTER_PASS
				back_to_chapter.add_theme_font_size_override("font_size", 11)
				back_to_chapter.add_theme_color_override("font_color", Color("c9aa67"))
				back_to_chapter.pressed.connect(func() -> void: _navigate(nav_page_num, null), CONNECT_DEFERRED)
				container.add_child(back_to_chapter)
				title_block_end_y += maxf(back_to_chapter.get_combined_minimum_size().y, 18.0) + 8.0

			var raw := str(slice.get("content", ""))
			var illustration_value: Variant = slice.get("illustration")
			var illustration: String = illustration_value.strip_edges() if illustration_value is String else ""
			if not illustration.is_empty():
				raw = "[img:%s]\n%s" % [illustration, raw]
			scroll_anchor_y = title_block_end_y
			content_viewport_h = maxf(80.0, panel_y + PANEL_H - BOTTOM_BAR - scroll_anchor_y)
			var content_mask := Control.new()
			content_mask.position = Vector2(content_left, scroll_anchor_y)
			content_mask.size = Vector2(content_width, content_viewport_h)
			content_mask.clip_contents = true
			content_mask.mouse_filter = Control.MOUSE_FILTER_IGNORE
			container.add_child(content_mask)
			content_container = Control.new()
			content_container.position = Vector2.ZERO
			content_container.size = Vector2(content_width, content_viewport_h)
			content_container.mouse_filter = Control.MOUSE_FILTER_IGNORE
			content_mask.add_child(content_container)

			var rich_content := RichTextLabel.new()
			rich_content.position = Vector2.ZERO
			rich_content.size = Vector2(content_width, 4096.0)
			rich_content.fit_content = true
			rich_content.bbcode_enabled = false
			rich_content.scroll_active = false
			rich_content.mouse_filter = Control.MOUSE_FILTER_IGNORE
			rich_content.add_theme_font_size_override("normal_font_size", 13)
			rich_content.add_theme_color_override("default_color", Color("c6c1b8"))
			content_container.add_child(rich_content)
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
							var scale := minf(minf(content_width / maxf(1.0, texture.get_width()), 260.0 / maxf(1.0, texture.get_height())), 1.0)
							rich_content.add_image(texture, maxi(1, int(round(texture.get_width() * scale))), maxi(1, int(round(texture.get_height() * scale))))
						else:
							rich_content.add_text("[%s]" % str(segment.get("path", "")))
					rich_content.add_text("\n\n")
			var main_height := maxf(float(rich_content.get_content_height()), rich_content.get_combined_minimum_size().y)
			rich_content.size.y = maxf(1.0, main_height)
			var inner_height := main_height
			if str(slice.get("kind", "")) == "entry" and not str(slice.get("annotation", "")).strip_edges().is_empty():
				var annotation := Label.new()
				annotation.text = "%s：%s" % [strings.get_text("bookReader", "annotationHeading"), str(slice.get("annotation", "")).strip_edges()]
				annotation.position = Vector2(0.0, main_height + 14.0)
				annotation.size = Vector2(content_width, 1000.0)
				annotation.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
				annotation.add_theme_font_size_override("font_size", 12)
				annotation.add_theme_color_override("font_color", Color("918b84"))
				annotation.mouse_filter = Control.MOUSE_FILTER_IGNORE
				content_container.add_child(annotation)
				inner_height = annotation.position.y + maxf(annotation.get_combined_minimum_size().y, 20.0)
			content_total_h = inner_height
			content_container.size.y = maxf(content_viewport_h, content_total_h)
		else:
			var missing := Label.new()
			missing.text = strings.get_text("bookReader", "pageMissing")
			missing.position = Vector2(content_left, panel_y + PANEL_H / 2.0 - 20.0)
			missing.size = Vector2(content_width, 32.0)
			missing.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
			missing.add_theme_font_size_override("font_size", 16)
			missing.add_theme_color_override("font_color", Color("6f6961"))
			missing.mouse_filter = Control.MOUSE_FILTER_IGNORE
			container.add_child(missing)

	var page_info := Label.new()
	page_info.text = _breadcrumb_text(toc_chapters)
	page_info.position = Vector2(panel_x + PADDING, panel_y + PANEL_H - 26.0)
	page_info.size = Vector2(PANEL_W - PADDING * 2.0, 18.0)
	page_info.add_theme_font_size_override("font_size", 11)
	page_info.add_theme_color_override("font_color", Color("8e887d"))
	page_info.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(page_info)

	wheel_layout = {
		"px": panel_x,
		"py": panel_y,
		"tocLeft": panel_x + PADDING,
		"tocRight": panel_x + PADDING + TOC_W,
		"contentLeft": content_left,
		"contentRight": panel_x + PANEL_W - PADDING,
		"scrollTop": toc_anchor_y,
		"scrollBottom": panel_y + PANEL_H - BOTTOM_BAR,
	}

	renderer.ui_layer.add_child(container)
	container.gui_input.connect(on_wheel_bound)
	if animate_open:
		container.modulate = Color(1.0, 1.0, 1.0, 0.0)
		var tween := container.create_tween()
		tween.tween_property(container, "modulate:a", 1.0, 0.15)
	else:
		container.modulate = Color.WHITE


func _breadcrumb_text(toc_chapters: Array) -> String:
	var chapter: Variant = null
	for chapter_value: Variant in toc_chapters:
		if chapter_value is Dictionary and int(chapter_value.get("pageNum", 0)) == nav_page_num:
			chapter = chapter_value
			break
	var chapter_name := str(chapter.get("title", "")).strip_edges() if chapter is Dictionary else ""
	if chapter_name.is_empty():
		chapter_name = strings.get_text("bookReader", "chapterFallback", {"n": str(nav_page_num)})
	if nav_entry_id == null or str(nav_entry_id).is_empty():
		return "%s  ·  %s" % [chapter_name, strings.get_text("bookReader", "pageHint")]
	var entry_title := ""
	if chapter is Dictionary:
		for entry_value: Variant in chapter.get("entries", []):
			if entry_value is Dictionary and str(entry_value.get("id", "")) == str(nav_entry_id):
				entry_title = str(entry_value.get("title", ""))
				break
	return "%s / %s  ·  %s" % [chapter_name, entry_title, strings.get_text("bookReader", "pageHint")]


func _on_wheel(event: InputEvent) -> void:
	if not wheel_layout is Dictionary:
		return
	if not event is InputEventMouseButton or not event.pressed:
		return
	if event.button_index != MOUSE_BUTTON_WHEEL_UP and event.button_index != MOUSE_BUTTON_WHEEL_DOWN:
		return
	var mouse_event := event as InputEventMouseButton
	var mouse_x: float = mouse_event.position.x
	var mouse_y: float = mouse_event.position.y
	if mouse_y < float(wheel_layout.get("scrollTop", 0.0)) or mouse_y > float(wheel_layout.get("scrollBottom", 0.0)):
		return
	var delta_y := (-1.0 if mouse_event.button_index == MOUSE_BUTTON_WHEEL_UP else 1.0) * maxf(1.0, mouse_event.factor) * 24.0
	if mouse_x >= float(wheel_layout.get("tocLeft", 0.0)) and mouse_x <= float(wheel_layout.get("tocRight", 0.0)) and toc_container != null:
		var max_toc_scroll := maxf(0.0, toc_total_h - toc_viewport_h)
		if max_toc_scroll <= 0.0:
			return
		container.accept_event()
		toc_scroll_offset = clampf(toc_scroll_offset + delta_y, 0.0, max_toc_scroll)
		toc_container.position.y = -toc_scroll_offset
		return
	if mouse_x >= float(wheel_layout.get("contentLeft", 0.0)) and mouse_x <= float(wheel_layout.get("contentRight", 0.0)) and content_container != null:
		var max_content_scroll := maxf(0.0, content_total_h - content_viewport_h)
		if max_content_scroll <= 0.0:
			return
		container.accept_event()
		content_scroll_offset = clampf(content_scroll_offset + delta_y, 0.0, max_content_scroll)
		content_container.position.y = -content_scroll_offset


func _destroy_ui() -> void:
	content_container = null
	toc_container = null
	wheel_layout = null
	if container != null and is_instance_valid(container):
		if container.get_parent() != null:
			container.get_parent().remove_child(container)
		container.free()
	container = null
