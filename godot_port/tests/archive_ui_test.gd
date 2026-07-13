extends Node
const BootstrapScript := preload("res://scripts/bootstrap.gd")
func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	var archive: RuntimeArchiveManager = bootstrap.archive_manager; archive.add_entry("character", "wang_grandpa"); archive.add_entry("lore", "lore_li_tiangou_story"); archive.add_entry("document", "doc_city_defense_notice"); archive.add_entry("book", "book_erta_guide"); archive.add_entry("bookEntry", "erta_geo_iron_ring")
	bootstrap.input_manager.debug_key_down("KeyB"); bootstrap.input_manager.debug_key_up("KeyB"); assert(bootstrap.bookshelf_ui.is_open() and bootstrap.bookshelf_ui.content.text.contains("风物志"))
	bootstrap.bookshelf_ui.action_buttons[1].pressed.emit(); await get_tree().process_frame; assert(bootstrap.character_book_ui.is_open() and bootstrap.bookshelf_ui.is_open()); bootstrap.character_book_ui.action_buttons[0].pressed.emit(); await get_tree().process_frame; assert(archive.is_read("char_wang_grandpa") and bootstrap.character_book_ui.content.text.length() > 10); bootstrap.input_manager.debug_key_down("Escape"); bootstrap.input_manager.debug_key_up("Escape"); assert(not bootstrap.bookshelf_ui.is_open() and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING)
	bootstrap.input_manager.debug_key_down("KeyB"); bootstrap.input_manager.debug_key_up("KeyB"); bootstrap.bookshelf_ui.action_buttons[2].pressed.emit(); await get_tree().process_frame; bootstrap.lore_book_ui.action_buttons[0].pressed.emit(); await get_tree().process_frame; assert(archive.is_read("lore_lore_li_tiangou_story") and bootstrap.lore_book_ui.content.text.contains("来源")); bootstrap.input_manager.debug_key_down("Escape"); bootstrap.input_manager.debug_key_up("Escape")
	bootstrap.input_manager.debug_key_down("KeyB"); bootstrap.input_manager.debug_key_up("KeyB"); bootstrap.bookshelf_ui.action_buttons[3].pressed.emit(); await get_tree().process_frame; bootstrap.document_box_ui.action_buttons[0].pressed.emit(); await get_tree().process_frame; assert(archive.is_read("doc_doc_city_defense_notice") and bootstrap.document_box_ui.content.get_parsed_text().length() > 10 and bootstrap.document_box_ui.get_rich_image_count() == 1 and not bootstrap.document_box_ui.content.get_parsed_text().contains("[img:")); bootstrap.input_manager.debug_key_down("Escape"); bootstrap.input_manager.debug_key_up("Escape")
	bootstrap.input_manager.debug_key_down("KeyB"); bootstrap.input_manager.debug_key_up("KeyB"); bootstrap.bookshelf_ui.action_buttons[4].pressed.emit(); await get_tree().process_frame
	assert(bootstrap.book_reader_ui.is_open())
	assert(bootstrap.book_reader_ui.content.text.contains("卷首"))
	for button: Button in bootstrap.book_reader_ui.action_buttons:
		if button.text.contains("铁环"): button.pressed.emit(); break
	await get_tree().process_frame
	assert(bootstrap.book_reader_ui.content.text.contains("铁环"))
	bootstrap.input_manager.debug_key_down("Escape"); bootstrap.input_manager.debug_key_up("Escape")
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout; print("Bookshelf/Character/Lore/Document/BookReader archive JSON/read/navigation lifecycle test: PASS"); get_tree().quit(0)
