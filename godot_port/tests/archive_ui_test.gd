extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	await get_tree().process_frame
	var archive: RuntimeArchiveManager = bootstrap.archive_manager
	archive.add_entry("character", "wang_grandpa")
	archive.add_entry("lore", "lore_li_tiangou_story")
	archive.add_entry("document", "doc_city_defense_notice")
	archive.add_entry("book", "book_erta_guide")
	archive.add_entry("bookEntry", "erta_geo_iron_ring")

	_open_bookshelf(bootstrap)
	assert(bootstrap.bookshelf_ui.is_open())
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.UI_OVERLAY)
	assert(_all_text(bootstrap.bookshelf_ui.container).contains(bootstrap.strings_provider.get_text("bookshelf", "lore")))

	_press_button(bootstrap.bookshelf_ui.container, bootstrap.strings_provider.get_text("bookshelf", "characters"))
	await get_tree().process_frame
	var first_character_panel: RuntimeCharacterBookUI = bootstrap.bookshelf_ui.active_sub_panel
	assert(first_character_panel != null and bootstrap.bookshelf_ui.is_open() and bootstrap.bookshelf_ui.container == null)
	var character: Dictionary = _find_by_id(archive.get_unlocked_characters(), "wang_grandpa")
	_press_button_containing(first_character_panel.container, archive.resolve_line(character.get("name", "")))
	await get_tree().process_frame
	assert(archive.is_read("char_wang_grandpa") and first_character_panel.detail_container != null)
	assert(_all_text(first_character_panel.detail_container).contains(bootstrap.strings_provider.get_text("characterBook", "impression")))
	_press_button(first_character_panel.container, bootstrap.strings_provider.get_text("characterBook", "back"))
	await get_tree().process_frame
	assert(bootstrap.bookshelf_ui.active_sub_panel == null and bootstrap.bookshelf_ui.container != null)
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.UI_OVERLAY)

	_press_button(bootstrap.bookshelf_ui.container, bootstrap.strings_provider.get_text("bookshelf", "characters"))
	await get_tree().process_frame
	var second_character_panel: RuntimeCharacterBookUI = bootstrap.bookshelf_ui.active_sub_panel
	assert(second_character_panel != first_character_panel)
	assert(second_character_panel.detail_container == null and second_character_panel.list_scroll_offset == 0.0 and second_character_panel.detail_scroll_offset == 0.0)
	_press_button(second_character_panel.container, bootstrap.strings_provider.get_text("characterBook", "back"))
	await get_tree().process_frame

	_press_button(bootstrap.bookshelf_ui.container, bootstrap.strings_provider.get_text("bookshelf", "lore"))
	await get_tree().process_frame
	var lore_panel: RuntimeLoreBookUI = bootstrap.bookshelf_ui.active_sub_panel
	var lore: Dictionary = _find_by_id(archive.get_unlocked_lore(), "lore_li_tiangou_story")
	var lore_title := archive.resolve_line(lore.get("title", ""))
	var lore_button := _find_button_containing(lore_panel.container, lore_title)
	assert(lore_button != null and lore_button.text.contains("[%s]" % archive.get_lore_category_name("legend")))
	lore_button.pressed.emit()
	await get_tree().process_frame
	assert(archive.is_read("lore_lore_li_tiangou_story") and lore_panel.content_container != null)
	assert(_all_text(lore_panel.content_container).contains(archive.resolve_line(lore.get("source", ""))))
	_press_button(lore_panel.container, bootstrap.strings_provider.get_text("loreBook", "back"))
	await get_tree().process_frame

	_press_button(bootstrap.bookshelf_ui.container, bootstrap.strings_provider.get_text("bookshelf", "documents"))
	await get_tree().process_frame
	var document_panel: RuntimeDocumentBoxUI = bootstrap.bookshelf_ui.active_sub_panel
	var document: Dictionary = _find_by_id(archive.get_unlocked_documents(), "doc_city_defense_notice")
	_press_button_containing(document_panel.container, archive.resolve_line(document.get("name", "")))
	await get_tree().process_frame
	var document_text := _all_text(document_panel.content_container)
	assert(archive.is_read("doc_doc_city_defense_notice") and document_panel.content_container != null)
	assert(document_text.length() > 10 and not document_text.contains("[img:") and document_text.contains(archive.resolve_line(document.get("annotation", ""))))
	_press_button(document_panel.container, bootstrap.strings_provider.get_text("documentBox", "back"))
	await get_tree().process_frame

	var book: Dictionary = _find_by_id(archive.get_unlocked_books(), "book_erta_guide")
	_press_button_containing(bootstrap.bookshelf_ui.container, archive.resolve_line(book.get("title", "")))
	await get_tree().process_frame
	assert(bootstrap.bookshelf_ui.active_sub_panel == bootstrap.book_reader_ui)
	assert(bootstrap.book_reader_ui.current_book == book and _all_text(bootstrap.book_reader_ui.container).contains("卷首"))
	_press_button_containing(bootstrap.book_reader_ui.container, "铁环")
	await get_tree().process_frame
	assert(bootstrap.book_reader_ui.nav_entry_id == "erta_geo_iron_ring")
	assert(_all_text(bootstrap.book_reader_ui.container).contains("铁环"))
	_press_button(bootstrap.book_reader_ui.container, bootstrap.strings_provider.get_text("bookReader", "back"))
	await get_tree().process_frame
	assert(bootstrap.bookshelf_ui.active_sub_panel == null and bootstrap.bookshelf_ui.container != null)

	_press_button(bootstrap.bookshelf_ui.container, bootstrap.strings_provider.get_text("bookshelf", "rules"))
	await get_tree().process_frame
	assert(not bootstrap.bookshelf_ui.is_open() and bootstrap.rules_panel_ui.is_open())
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.UI_OVERLAY)
	_escape(bootstrap)
	assert(not bootstrap.rules_panel_ui.is_open() and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)

	_open_bookshelf(bootstrap)
	_press_button(bootstrap.bookshelf_ui.container, bootstrap.strings_provider.get_text("bookshelf", "characters"))
	await get_tree().process_frame
	assert(bootstrap.bookshelf_ui.active_sub_panel is RuntimeCharacterBookUI)
	_escape(bootstrap)
	assert(not bootstrap.bookshelf_ui.is_open() and bootstrap.bookshelf_ui.active_sub_panel == null)
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)

	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	await get_tree().process_frame
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("Bookshelf factory/return/Rules and archive UI direct-translation test: PASS")
	get_tree().quit(0)


func _open_bookshelf(bootstrap: Node) -> void:
	InputManagerProbe.key_down(bootstrap.input_manager, "KeyB")
	InputManagerProbe.key_up(bootstrap.input_manager, "KeyB")


func _escape(bootstrap: Node) -> void:
	InputManagerProbe.key_down(bootstrap.input_manager, "Escape")
	InputManagerProbe.key_up(bootstrap.input_manager, "Escape")


func _find_by_id(values: Array, id: String) -> Dictionary:
	for value: Variant in values:
		if value is Dictionary and str(value.get("id", "")) == id:
			return value
	assert(false, "missing archive definition: %s" % id)
	return {}


func _press_button(root: Node, text: String) -> void:
	var button := _find_button(root, text, false)
	assert(button != null, "missing button: %s" % text)
	button.pressed.emit()


func _press_button_containing(root: Node, text: String) -> void:
	var button := _find_button(root, text, true)
	assert(button != null, "missing button containing: %s" % text)
	button.pressed.emit()


func _find_button_containing(root: Node, text: String) -> Button:
	return _find_button(root, text, true)


func _find_button(root: Node, text: String, contains: bool) -> Button:
	if root is Button:
		var button := root as Button
		if (button.text.contains(text) if contains else button.text == text):
			return button
	for child: Node in root.get_children():
		var found := _find_button(child, text, contains)
		if found != null:
			return found
	return null


func _all_text(root: Node) -> String:
	if root == null:
		return ""
	var output := ""
	if root is RichTextLabel:
		output += (root as RichTextLabel).get_parsed_text()
	elif root is Label:
		output += (root as Label).text
	elif root is Button:
		output += (root as Button).text
	for child: Node in root.get_children():
		output += "\n" + _all_text(child)
	return output
