class_name RuntimeBookshelfUI
extends RefCounted

const PANEL_W := 700.0
const PANEL_H := 520.0
const PADDING := 20.0
const BOOK_W := 100.0
const BOOK_H := 140.0
const BOOK_GAP := 16.0

var renderer: RuntimeRenderer
var archive_data: Variant
var container: Control = null
var _is_open := false
var active_sub_panel: Variant = null
var on_open_rules: Callable
var on_open_book: Callable
var on_open_characters: Callable
var on_open_lore: Callable
var on_open_documents: Callable
var strings: RuntimeStringsProvider


func _init(
	next_renderer: RuntimeRenderer,
	next_archive_data: Variant,
	next_on_open_rules: Callable,
	next_on_open_book: Callable,
	next_on_open_characters: Callable,
	next_on_open_lore: Callable,
	next_on_open_documents: Callable,
	next_strings: RuntimeStringsProvider,
) -> void:
	renderer = next_renderer
	archive_data = next_archive_data
	on_open_rules = next_on_open_rules
	on_open_book = next_on_open_book
	on_open_characters = next_on_open_characters
	on_open_lore = next_on_open_lore
	on_open_documents = next_on_open_documents
	strings = next_strings


func is_open() -> bool:
	return _is_open


func open() -> void:
	if _is_open:
		return
	_is_open = true
	_build_shelf()


func close() -> void:
	if not _is_open:
		return
	_is_open = false
	_close_sub_panel()
	_destroy_ui()


func _build_shelf() -> void:
	_destroy_ui()
	container = Control.new()
	container.name = "RuntimeBookshelfUI"
	container.mouse_filter = Control.MOUSE_FILTER_STOP
	container.set_anchors_and_offsets_preset(Control.PRESET_TOP_LEFT)

	var screen_width := renderer.screen_width
	var screen_height := renderer.screen_height
	container.size = Vector2(screen_width, screen_height)
	var panel_x := (screen_width - PANEL_W) / 2.0
	var panel_y := (screen_height - PANEL_H) / 2.0

	var overlay := ColorRect.new()
	overlay.color = Color(0.0, 0.0, 0.0, 0.68)
	overlay.position = Vector2.ZERO
	overlay.size = Vector2(screen_width, screen_height)
	overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(overlay)

	var background := Panel.new()
	background.position = Vector2(panel_x, panel_y)
	background.size = Vector2(PANEL_W, PANEL_H)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var background_style := StyleBoxFlat.new()
	background_style.bg_color = Color("101722")
	background_style.border_color = Color("6f5b39")
	background_style.set_border_width_all(2)
	background_style.set_corner_radius_all(7)
	background.add_theme_stylebox_override("panel", background_style)
	container.add_child(background)

	var title := Label.new()
	title.text = strings.get_text("bookshelf", "title")
	title.position = Vector2(panel_x + PADDING, panel_y + 14.0)
	title.size = Vector2(PANEL_W - 40.0, 30.0)
	title.add_theme_font_size_override("font_size", 20)
	title.add_theme_color_override("font_color", Color("e8cf8e"))
	title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(title)

	var hint := Label.new()
	hint.text = strings.get_text("bookshelf", "closeHint")
	hint.position = Vector2(panel_x + PANEL_W - 80.0, panel_y + PANEL_H - 24.0)
	hint.size = Vector2(70.0, 18.0)
	hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	hint.add_theme_font_size_override("font_size", 11)
	hint.add_theme_color_override("font_color", Color("918b84"))
	hint.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(hint)

	var fixed_books: Array[Dictionary] = [
		{"id": "rules", "label": strings.get_text("bookshelf", "rules"), "color": Color("8b4513"), "hasUnread": false},
		{"id": "character", "label": strings.get_text("bookshelf", "characters"), "color": Color("2e4057"), "hasUnread": archive_data.has_unread("character")},
		{"id": "lore", "label": strings.get_text("bookshelf", "lore"), "color": Color("3e5641"), "hasUnread": archive_data.has_unread("lore")},
		{"id": "document", "label": strings.get_text("bookshelf", "documents"), "color": Color("5c4033"), "hasUnread": archive_data.has_unread("document")},
	]
	var dynamic_books: Array = archive_data.get_unlocked_books()
	var start_x := panel_x + PADDING + 20.0
	var start_y := panel_y + 70.0

	for index in fixed_books.size():
		_draw_book_slot(fixed_books[index], start_x + index * (BOOK_W + BOOK_GAP), start_y)

	for index in dynamic_books.size():
		var book: Dictionary = dynamic_books[index]
		var slot_index := fixed_books.size() + index
		var column := slot_index % 5
		var row := floori(float(slot_index) / 5.0)
		_draw_book_slot(
			{
				"id": "book_%s" % str(book.get("id", "")),
				"label": archive_data.resolve_line(book.get("title", "")),
				"color": Color("4a3728"),
				"hasUnread": false,
			},
			start_x + column * (BOOK_W + BOOK_GAP),
			start_y + row * (BOOK_H + 30.0),
		)

	renderer.ui_layer.add_child(container)
	container.modulate = Color(1.0, 1.0, 1.0, 0.0)
	var tween := container.create_tween()
	tween.tween_property(container, "modulate:a", 1.0, 0.15)


func _draw_book_slot(slot: Dictionary, x: float, y: float) -> void:
	var book_button := Button.new()
	book_button.text = str(slot.get("label", ""))
	book_button.position = Vector2(x, y)
	book_button.size = Vector2(BOOK_W, BOOK_H)
	book_button.mouse_filter = Control.MOUSE_FILTER_PASS
	book_button.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	book_button.add_theme_font_size_override("font_size", 12)
	book_button.add_theme_color_override("font_color", Color("f1e5ca"))
	var normal_style := StyleBoxFlat.new()
	normal_style.bg_color = slot.get("color", Color("4a3728"))
	normal_style.border_color = Color("a58a61")
	normal_style.set_border_width_all(1)
	normal_style.set_corner_radius_all(4)
	book_button.add_theme_stylebox_override("normal", normal_style)
	var hover_style := normal_style.duplicate()
	hover_style.bg_color = normal_style.bg_color.lightened(0.12)
	book_button.add_theme_stylebox_override("hover", hover_style)
	book_button.add_theme_stylebox_override("pressed", hover_style)
	book_button.pressed.connect(func() -> void: _on_book_click(str(slot.get("id", ""))), CONNECT_DEFERRED)
	container.add_child(book_button)

	if slot.get("hasUnread") == true:
		var unread_dot := Label.new()
		unread_dot.text = "●"
		unread_dot.position = Vector2(x + BOOK_W - 17.0, y + 1.0)
		unread_dot.size = Vector2(16.0, 16.0)
		unread_dot.add_theme_font_size_override("font_size", 12)
		unread_dot.add_theme_color_override("font_color", Color("d84a45"))
		unread_dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
		container.add_child(unread_dot)


func _on_book_click(book_id: String) -> void:
	_close_sub_panel()

	if book_id == "rules":
		close()
		on_open_rules.call()
		return

	if book_id == "character":
		active_sub_panel = on_open_characters.call(func() -> void:
			_close_sub_panel()
			_build_shelf()
		)
		_destroy_shelf_only()
		return

	if book_id == "lore":
		active_sub_panel = on_open_lore.call(func() -> void:
			_close_sub_panel()
			_build_shelf()
		)
		_destroy_shelf_only()
		return

	if book_id == "document":
		active_sub_panel = on_open_documents.call(func() -> void:
			_close_sub_panel()
			_build_shelf()
		)
		_destroy_shelf_only()
		return

	if book_id.begins_with("book_"):
		var real_id := book_id.substr(5)
		var books: Array = archive_data.get_books()
		for book_value: Variant in books:
			if not book_value is Dictionary:
				continue
			var book: Dictionary = book_value
			if str(book.get("id", "")) == real_id:
				active_sub_panel = on_open_book.call(book, func() -> void:
					_close_sub_panel()
					_build_shelf()
				)
				_destroy_shelf_only()
				break


func _close_sub_panel() -> void:
	if active_sub_panel != null:
		active_sub_panel.call("close")
		active_sub_panel = null


func _destroy_shelf_only() -> void:
	if container != null and is_instance_valid(container):
		if container.get_parent() != null:
			container.get_parent().remove_child(container)
		container.free()
	container = null


func _destroy_ui() -> void:
	_destroy_shelf_only()


func destroy() -> void:
	close()
