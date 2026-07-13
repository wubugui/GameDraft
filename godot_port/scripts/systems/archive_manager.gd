class_name RuntimeArchiveManager
extends RuntimeSystem

const ARCHIVE_DIR := "/assets/data/archive"

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _asset_manager: RuntimeAssetManager
var _strings: RuntimeStringsProvider
var _character_defs: Dictionary = {}
var _lore_defs: Dictionary = {}
var _document_defs: Dictionary = {}
var _book_defs: Dictionary = {}
var _book_entry_ids: Dictionary = {}
var _item_display_names: Dictionary = {}
var _unlocked_characters: Dictionary = {}
var _unlocked_lore: Dictionary = {}
var _unlocked_documents: Dictionary = {}
var _unlocked_books: Dictionary = {}
var _read_entries: Dictionary = {}
var _first_view_fired: Dictionary = {}
var _lore_category_names: Dictionary = {}
var _condition_context_factory := Callable()
var _resolve_for_display := Callable()
var _restoring := false
var _seeding := false
var _unlock_eval_scheduled := false
var _unlock_eval_running := false
var _unlock_eval_dirty := false
var _destroyed := false


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore) -> void:
	_event_bus = event_bus
	_flag_store = flag_store


func init(ctx: Dictionary) -> void:
	_destroyed = false
	_strings = ctx.strings
	_asset_manager = ctx.assetManager
	_event_bus.on("flag:changed", Callable(self, "_on_state_changed"))
	_event_bus.on("narrative:stateChanged", Callable(self, "_on_state_changed"))


func get_asset_manager() -> RuntimeAssetManager: return _asset_manager


func update(_dt: float) -> void: return
func set_condition_eval_context_factory(factory: Callable = Callable()) -> void: _condition_context_factory = factory
func set_restoring(value: bool) -> void: _restoring = value
func set_resolve_for_display(callback: Callable = Callable()) -> void: _resolve_for_display = callback


func resolve_line(raw: Variant) -> String:
	if not _resolve_for_display.is_null() and _resolve_for_display.is_valid(): return str(_resolve_for_display.call("" if raw == null else str(raw)))
	return "" if raw == null else str(raw)


func get_item_display_names() -> Dictionary: return _item_display_names.duplicate(true)


func load_defs() -> bool:
	_character_defs = _load_list("%s/characters.json" % ARCHIVE_DIR)
	var lore_data: Variant = _asset_manager.load_json("%s/lore.json" % ARCHIVE_DIR)
	_lore_defs.clear(); _lore_category_names.clear()
	var lore_list: Variant = lore_data if lore_data is Array else (lore_data.get("entries", []) if lore_data is Dictionary else [])
	if lore_data is Dictionary and lore_data.get("categories") is Dictionary: _lore_category_names = lore_data.categories.duplicate(true)
	if lore_list is Array:
		for entry: Variant in lore_list:
			if entry is Dictionary and not str(entry.get("id", "")).is_empty(): _lore_defs[str(entry.id)] = entry
	_document_defs = _load_list("%s/documents.json" % ARCHIVE_DIR)
	_book_defs = _load_list("%s/books.json" % ARCHIVE_DIR)
	_book_entry_ids.clear()
	for book: Dictionary in _book_defs.values():
		for page: Variant in book.get("pages", []):
			if page is Dictionary:
				for entry: Variant in page.get("entries", []):
					if entry is Dictionary and not str(entry.get("id", "")).is_empty(): _book_entry_ids[str(entry.id)] = true
	_item_display_names.clear()
	var items: Variant = _asset_manager.load_json("/assets/data/items.json")
	if items is Array:
		for item: Variant in items:
			if item is Dictionary and not str(item.get("id", "")).is_empty(): _item_display_names[str(item.id)] = str(item.get("name", item.id))
	_seeding = true
	_run_unlock_eval_to_convergence(true)
	_seeding = false
	_sync_unlocked_books_from_flags()
	return not _character_defs.is_empty() or not _lore_defs.is_empty() or not _document_defs.is_empty() or not _book_defs.is_empty()


func add_entry(book_type: String, entry_id: String) -> void:
	match book_type:
		"character": _unlock_defined(_character_defs, _unlocked_characters, entry_id, "archive_character_%s" % entry_id, "character")
		"lore": _unlock_defined(_lore_defs, _unlocked_lore, entry_id, "archive_lore_%s" % entry_id, "lore")
		"document": _unlock_defined(_document_defs, _unlocked_documents, entry_id, "archive_document_%s" % entry_id, "document")
		"book": _unlock_defined(_book_defs, _unlocked_books, entry_id, "archive_book_%s" % entry_id, "book")
		"bookEntry":
			if _book_entry_ids.has(entry_id) and _flag_store.get_value("archive_book_entry_%s" % entry_id) != true:
				_flag_store.set_value("archive_book_entry_%s" % entry_id, true)
				_emit_update("book", entry_id)


func mark_read(key: String) -> void: _read_entries[key] = true
func is_read(key: String) -> bool: return _read_entries.has(key)


func trigger_first_view_if_needed(qualified_key: String, actions: Variant) -> void:
	if not actions is Array or actions.is_empty() or _first_view_fired.has(qualified_key): return
	_first_view_fired[qualified_key] = true
	_event_bus.emit("archive:firstView", {"actions": actions.duplicate(true)})


func trigger_book_slice_first_view(book_id: String, slice: Dictionary) -> void:
	var book: Variant = _book_defs.get(book_id)
	if not book is Dictionary: return
	var page: Variant = _find_by(book.get("pages", []), "pageNum", slice.get("pageNum"))
	if not page is Dictionary: return
	if slice.get("kind") == "page":
		if _check_conditions(page.get("unlockConditions", [])): trigger_first_view_if_needed("bookpage_%s_%s" % [book_id, slice.get("pageNum")], page.get("firstViewActions"))
		return
	var entry: Variant = _find_by(page.get("entries", []), "id", slice.get("entryId"))
	if entry is Dictionary: trigger_first_view_if_needed("bookentry_%s_%s" % [book_id, slice.get("entryId")], entry.get("firstViewActions"))


func get_lore_category_name(key: String) -> String: return str(_lore_category_names.get(key, key))


func has_unread(book_type: String) -> bool:
	var source: Dictionary; var prefix := ""
	match book_type:
		"character": source = _unlocked_characters; prefix = "char_"
		"lore": source = _unlocked_lore; prefix = "lore_"
		"document": source = _unlocked_documents; prefix = "doc_"
		_: return false
	for id: String in source:
		if not _read_entries.has(prefix + id): return true
	return false


func get_unlocked_characters() -> Array: return _resolved_defs(_unlocked_characters, _character_defs)
func get_unlocked_lore() -> Array: return _resolved_defs(_unlocked_lore, _lore_defs)
func get_unlocked_documents() -> Array: return _resolved_defs(_unlocked_documents, _document_defs)
func get_books() -> Array: return _book_defs.values()
func get_unlocked_books() -> Array: return _resolved_defs(_unlocked_books, _book_defs)


func get_character_visible_impressions(entry: Dictionary) -> Array[String]:
	var result: Array[String] = []
	for item: Variant in entry.get("impressions", []):
		if item is Dictionary and _check_conditions(item.get("conditions", [])): result.push_back(resolve_line(item.get("text")))
	return result


func get_character_visible_info(entry: Dictionary) -> Array[String]:
	var result: Array[String] = []
	for item: Variant in entry.get("knownInfo", []):
		if item is Dictionary and _check_conditions(item.get("conditions", [])): result.push_back(resolve_line(item.get("text")))
	return result


func get_book_toc_chapters(book: Dictionary) -> Array:
	var pages: Array = book.get("pages", []).duplicate(true); pages.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return int(a.pageNum) < int(b.pageNum))
	var result: Array = []
	for page: Dictionary in pages:
		var entries: Array = []
		for entry: Variant in page.get("entries", []):
			if entry is Dictionary and not str(entry.get("id", "")).is_empty():
				var title := str(entry.get("title", "")).strip_edges()
				entries.push_back({"id": entry.id, "title": resolve_line(title if not title.is_empty() else _strings.get_text("bookReader", "untitledEntry")), "unlocked": _flag_store.get_value("archive_book_entry_%s" % entry.id) == true})
		result.push_back({"pageNum": page.pageNum, "title": resolve_line(page.title) if page.has("title") else null, "unlocked": _check_conditions(page.get("unlockConditions", [])), "entries": entries})
	return result


func get_book_page_slice(book: Dictionary, page_num: int) -> Variant:
	var page: Variant = _find_by(book.get("pages", []), "pageNum", page_num)
	if not page is Dictionary: return null
	return {"kind": "page", "pageNum": page.pageNum, "title": resolve_line(page.title) if page.has("title") else null, "content": resolve_line(page.get("content")), "illustration": page.get("illustration"), "unlocked": _check_conditions(page.get("unlockConditions", []))}


func get_book_entry_slice(book: Dictionary, page_num: int, entry_id: String) -> Variant:
	var page: Variant = _find_by(book.get("pages", []), "pageNum", page_num)
	if not page is Dictionary or not _check_conditions(page.get("unlockConditions", [])): return null
	var entry: Variant = _find_by(page.get("entries", []), "id", entry_id)
	if not entry is Dictionary or _flag_store.get_value("archive_book_entry_%s" % entry_id) != true: return null
	var title := str(entry.get("title", "")).strip_edges(); var content := str(entry.get("content", "")).strip_edges(); var annotation := str(entry.get("annotation", "")).strip_edges(); var illustration := str(entry.get("illustration", "")).strip_edges()
	if title.is_empty() and content.is_empty() and annotation.is_empty() and illustration.is_empty(): return null
	return {"kind": "entry", "pageNum": page.pageNum, "chapterTitle": resolve_line(page.title) if page.has("title") else null, "entryId": entry_id, "title": resolve_line(title if not title.is_empty() else _strings.get_text("bookReader", "untitledEntry")), "content": resolve_line(content), "annotation": resolve_line(annotation) if not annotation.is_empty() else null, "illustration": illustration if not illustration.is_empty() else null, "unlocked": true}


func serialize() -> Dictionary:
	return {"characters": _unlocked_characters.keys(), "lore": _unlocked_lore.keys(), "documents": _unlocked_documents.keys(), "books": _unlocked_books.keys(), "read": _read_entries.keys(), "firstViewFired": _first_view_fired.keys()}


func deserialize(data: Dictionary) -> void:
	_unlocked_characters = _set_from_array(data.get("characters")); _unlocked_lore = _set_from_array(data.get("lore")); _unlocked_documents = _set_from_array(data.get("documents")); _unlocked_books = _set_from_array(data.get("books")); _read_entries = _set_from_array(data.get("read")); _first_view_fired = _set_from_array(data.get("firstViewFired")); _sync_unlocked_books_from_flags()


func destroy() -> void:
	_destroyed = true
	_event_bus.off("flag:changed", Callable(self, "_on_state_changed")); _event_bus.off("narrative:stateChanged", Callable(self, "_on_state_changed"))
	_condition_context_factory = Callable(); _resolve_for_display = Callable(); _restoring = false; _seeding = false; _unlock_eval_running = false; _unlock_eval_dirty = false
	for dictionary in [_character_defs, _lore_defs, _document_defs, _book_defs, _book_entry_ids, _item_display_names, _unlocked_characters, _unlocked_lore, _unlocked_documents, _unlocked_books, _read_entries, _first_view_fired]: dictionary.clear()


func definition_counts() -> Dictionary: return {"characters": _character_defs.size(), "lore": _lore_defs.size(), "documents": _document_defs.size(), "books": _book_defs.size(), "bookEntries": _book_entry_ids.size(), "items": _item_display_names.size()}
func debug_snapshot_fragment() -> Dictionary: return {"archive": serialize()}


func _on_state_changed(_payload: Variant = null) -> void:
	if _restoring: return
	if _unlock_eval_running: _unlock_eval_dirty = true; return
	if _unlock_eval_scheduled: return
	_unlock_eval_scheduled = true; call_deferred("_flush_unlock_eval")


func _flush_unlock_eval() -> void:
	_unlock_eval_scheduled = false
	if not _restoring and not _destroyed: _run_unlock_eval_to_convergence(_seeding)


func flush_scheduled_unlock_evaluation() -> void:
	if not _unlock_eval_scheduled: return
	_unlock_eval_scheduled = false
	if not _restoring and not _destroyed: _run_unlock_eval_to_convergence(_seeding)


func _run_unlock_eval_to_convergence(silent: bool) -> void:
	_unlock_eval_running = true
	for _round in 16:
		_unlock_eval_dirty = false; _evaluate_unlocks(silent)
		if not _unlock_eval_dirty: break
	_unlock_eval_running = false


func _evaluate_unlocks(silent: bool) -> void:
	for id: String in _lore_defs:
		if not _unlocked_lore.has(id) and _check_conditions(_lore_defs[id].get("unlockConditions", [])): _unlock_auto(_unlocked_lore, id, "archive_lore_%s" % id, "lore", silent)
	for id: String in _document_defs:
		if not _unlocked_documents.has(id) and _check_conditions(_document_defs[id].get("discoverConditions", [])): _unlock_auto(_unlocked_documents, id, "archive_document_%s" % id, "document", silent)
	for book: Dictionary in _book_defs.values():
		for page: Variant in book.get("pages", []):
			if page is Dictionary:
				for entry: Variant in page.get("entries", []):
					if entry is Dictionary and not str(entry.get("id", "")).is_empty() and _flag_store.get_value("archive_book_entry_%s" % entry.id) != true and entry.get("discoverConditions") is Array and not entry.discoverConditions.is_empty() and _check_conditions(entry.discoverConditions):
						_flag_store.set_value("archive_book_entry_%s" % entry.id, true); _unlock_eval_dirty = true
						if not silent: _emit_update("book", entry.id)


func _check_conditions(conditions: Variant) -> bool:
	if not conditions is Array or conditions.is_empty(): return true
	if not _condition_context_factory.is_null() and _condition_context_factory.is_valid():
		var context: Variant = _condition_context_factory.call()
		if context is Dictionary and context.get("evaluateList") is Callable: return context.evaluateList.call(conditions) == true
	return _flag_store.check_conditions(conditions)


func _unlock_defined(defs: Dictionary, unlocked: Dictionary, id: String, flag: String, type: String) -> void:
	if defs.has(id) and not unlocked.has(id): unlocked[id] = true; _flag_store.set_value(flag, true); _emit_update(type, id)
func _unlock_auto(unlocked: Dictionary, id: String, flag: String, type: String, silent: bool) -> void:
	unlocked[id] = true; _flag_store.set_value(flag, true); _unlock_eval_dirty = true
	if not silent: _emit_update(type, id)
func _emit_update(type: String, id: String) -> void:
	_event_bus.emit("archive:updated", {"bookType": type, "entryId": id}); _event_bus.emit("notification:show", {"text": _strings.get_text("notifications", "archiveUpdated"), "type": "archive"})
func _sync_unlocked_books_from_flags() -> void:
	for id: String in _book_defs:
		if _flag_store.get_value("archive_book_%s" % id) == true: _unlocked_books[id] = true
func _load_list(path: String) -> Dictionary:
	var result := {}; var list: Variant = _asset_manager.load_json(path)
	if list is Array:
		for entry: Variant in list:
			if entry is Dictionary and not str(entry.get("id", "")).is_empty(): result[str(entry.id)] = entry
	return result
func _resolved_defs(ids: Dictionary, defs: Dictionary) -> Array:
	var result: Array = []
	for id: String in ids:
		if defs.has(id): result.push_back(defs[id])
	return result
func _find_by(list: Variant, key: String, value: Variant) -> Variant:
	if list is Array:
		for item: Variant in list:
			if item is Dictionary and item.get(key) == value: return item
	return null
func _set_from_array(value: Variant) -> Dictionary:
	var result := {}
	if value is Array:
		for item: Variant in value: result[str(item)] = true
	return result
