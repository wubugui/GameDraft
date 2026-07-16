class_name RuntimeArchiveManager
extends RuntimeSystem

const RuntimeConditionEvalBridgeScript := preload("res://scripts/runtime/condition_eval_bridge.gd")
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")

const ARCHIVE_DIR := "/assets/data/archive"

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore

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
var _strings: RuntimeStringsProvider
var _asset_manager: RuntimeAssetManager
var _condition_context_factory := Callable()

var _on_flag_changed := Callable()
var _resolve_for_display := Callable()
var _restoring := false
var _seeding := false
var _unlock_eval_scheduled := false
var _unlock_eval_running := false
var _unlock_eval_dirty := false
var _destroyed := false
var _preload_idle_handle: SceneTreeTimer = null


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore) -> void:
	_event_bus = event_bus
	_flag_store = flag_store
	_on_flag_changed = Callable(self, "_handle_flag_changed")


# Godot lowers the constructor-owned TypeScript callback to a bound method.
func _handle_flag_changed(_payload: Variant = null) -> void:
	if _restoring:
		return
	if _unlock_eval_running:
		_unlock_eval_dirty = true
		return
	_schedule_unlock_eval()


func _schedule_unlock_eval() -> void:
	if _unlock_eval_scheduled:
		return
	_unlock_eval_scheduled = true
	RuntimeMicrotaskQueueScript.queue_microtask(Callable(self, "_flush_unlock_eval"))


# Godot lowers the queueMicrotask closure to this bound continuation.
func _flush_unlock_eval() -> void:
	_unlock_eval_scheduled = false
	if _restoring:
		return
	_run_unlock_eval_to_convergence(_seeding)


func _run_unlock_eval_to_convergence(silent: bool) -> void:
	const MAX_ROUNDS := 16
	_unlock_eval_running = true
	var converged := false
	for _round: int in MAX_ROUNDS:
		_unlock_eval_dirty = false
		_evaluate_unlocks(silent)
		if not _unlock_eval_dirty:
			converged = true
			break
	if not converged:
		push_warning("ArchiveManager: 解锁重评 %s 轮未收敛，疑似条目解锁条件互相依赖成环" % MAX_ROUNDS)
	_unlock_eval_running = false


func init(ctx: Dictionary) -> void:
	_destroyed = false
	_strings = ctx.strings
	_asset_manager = ctx.assetManager
	_event_bus.on("flag:changed", _on_flag_changed)
	_event_bus.on("narrative:stateChanged", _on_flag_changed)


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void:
	_condition_context_factory = factory


func set_restoring(value: bool) -> void:
	_restoring = value


func set_resolve_for_display(callback: Callable = Callable()) -> void:
	_resolve_for_display = callback


func resolve_line(raw: Variant) -> String:
	if _resolve_for_display.is_valid():
		return str(_resolve_for_display.call("" if raw == null else str(raw)))
	return "" if raw == null else str(raw)


func get_item_display_names() -> Dictionary:
	return _item_display_names


func _rd(raw: Variant) -> String:
	return resolve_line(raw)


func update(_dt: float) -> void:
	return


func load_defs() -> void:
	_load_characters()
	_load_lore()
	_load_documents()
	_load_books()
	_load_item_display_names()
	_seeding = true
	_run_unlock_eval_to_convergence(true)
	_seeding = false
	_sync_unlocked_books_from_flags()
	_schedule_content_image_preload()


func _schedule_content_image_preload() -> void:
	if _destroyed:
		return
	var tree := Engine.get_main_loop() as SceneTree
	if tree == null:
		return
	# Godot has no requestIdleCallback. Its timer is the source setTimeout fallback.
	_preload_idle_handle = tree.create_timer(1.5)
	_preload_idle_handle.timeout.connect(Callable(self, "_run_scheduled_content_image_preload"), CONNECT_ONE_SHOT)


# Godot lowers the requestIdleCallback/setTimeout closure to this continuation.
func _run_scheduled_content_image_preload() -> void:
	_preload_idle_handle = null
	if _destroyed:
		return
	_preload_content_images()


func _sync_unlocked_books_from_flags() -> void:
	for id: String in _book_defs:
		if _flag_store.get_value("archive_book_%s" % id) == true:
			_unlocked_books[id] = true


func _preload_content_images() -> void:
	var paths: Dictionary = {}
	var image_regex := RegEx.new()
	image_regex.compile("\\[img:([^\\]]+)\\]")
	var add_media := func(reference: Variant) -> void:
		if reference == null or str(reference).is_empty():
			return
		var path := RuntimeResourceLocator.get_default().media_url_from_short_path(str(reference))
		if not path.is_empty():
			paths[path] = true

	for book: Dictionary in _book_defs.values():
		for raw_page: Variant in book.get("pages", []):
			if not raw_page is Dictionary:
				continue
			var page: Dictionary = raw_page
			add_media.call(page.get("illustration"))
			for image_match: RegExMatch in image_regex.search_all(str(page.get("content", ""))):
				add_media.call(image_match.get_string(1))
			for raw_entry: Variant in page.get("entries", []):
				if not raw_entry is Dictionary:
					continue
				var entry: Dictionary = raw_entry
				add_media.call(entry.get("illustration"))
				for image_match: RegExMatch in image_regex.search_all(str(entry.get("content", ""))):
					add_media.call(image_match.get_string(1))
				if entry.get("annotation") != null:
					for image_match: RegExMatch in image_regex.search_all(str(entry.annotation)):
						add_media.call(image_match.get_string(1))
	for entry: Dictionary in _lore_defs.values():
		for image_match: RegExMatch in image_regex.search_all(str(entry.get("content", ""))):
			add_media.call(image_match.get_string(1))
	for document: Dictionary in _document_defs.values():
		for image_match: RegExMatch in image_regex.search_all(str(document.get("content", ""))):
			add_media.call(image_match.get_string(1))

	if _destroyed or paths.is_empty():
		return
	_load_textures_pooled(paths.keys(), 3)


func _load_textures_pooled(paths: Array, limit: int) -> void:
	var next := 0
	var pool_size := maxi(1, mini(limit, paths.size()))
	# AssetManager local reads are synchronous in Godot. Round-robin workers retain
	# the source pool's bounded start order while each Promise interval collapses.
	while not _destroyed and next < paths.size():
		for _worker: int in pool_size:
			if _destroyed or next >= paths.size():
				break
			_asset_manager.load_texture(str(paths[next]))
			next += 1


func _load_characters() -> void:
	var list: Variant = _asset_manager.load_json("%s/characters.json" % ARCHIVE_DIR)
	if list is Array:
		for entry: Variant in list:
			if entry is Dictionary:
				_character_defs[str(entry.get("id", ""))] = entry


func _load_lore() -> void:
	var data: Variant = _asset_manager.load_json("%s/lore.json" % ARCHIVE_DIR)
	var list: Variant = data if data is Array else (data.get("entries", []) if data is Dictionary else [])
	if list is Array:
		for entry: Variant in list:
			if entry is Dictionary:
				_lore_defs[str(entry.get("id", ""))] = entry
	if data is Dictionary and data.get("categories") is Dictionary:
		_lore_category_names = data.categories


func _load_documents() -> void:
	var list: Variant = _asset_manager.load_json("%s/documents.json" % ARCHIVE_DIR)
	if list is Array:
		for entry: Variant in list:
			if entry is Dictionary:
				_document_defs[str(entry.get("id", ""))] = entry


func _load_books() -> void:
	var list: Variant = _asset_manager.load_json("%s/books.json" % ARCHIVE_DIR)
	_book_entry_ids.clear()
	if not list is Array:
		return
	for raw_book: Variant in list:
		if not raw_book is Dictionary:
			continue
		var book: Dictionary = raw_book
		_book_defs[str(book.get("id", ""))] = book
		for raw_page: Variant in book.get("pages", []):
			if not raw_page is Dictionary:
				continue
			for entry: Variant in raw_page.get("entries", []):
				if entry is Dictionary and entry.get("id"):
					_book_entry_ids[str(entry.id)] = true


func _load_item_display_names() -> void:
	_item_display_names.clear()
	var list: Variant = _asset_manager.load_json("/assets/data/items.json")
	if list is Array:
		for item: Variant in list:
			if item is Dictionary and item.get("id"):
				_item_display_names[str(item.id)] = str(item.get("name", item.id))


func add_entry(book_type: String, entry_id: String) -> void:
	match book_type:
		"character":
			if _character_defs.has(entry_id) and not _unlocked_characters.has(entry_id):
				_unlocked_characters[entry_id] = true
				_flag_store.set_value(RuntimeFlagKeys.archive_character(entry_id), true)
				_emit_update("character", entry_id)
		"lore":
			if _lore_defs.has(entry_id) and not _unlocked_lore.has(entry_id):
				_unlocked_lore[entry_id] = true
				_flag_store.set_value("archive_lore_%s" % entry_id, true)
				_emit_update("lore", entry_id)
		"document":
			if _document_defs.has(entry_id) and not _unlocked_documents.has(entry_id):
				_unlocked_documents[entry_id] = true
				_flag_store.set_value("archive_document_%s" % entry_id, true)
				_emit_update("document", entry_id)
		"book":
			if _book_defs.has(entry_id) and not _unlocked_books.has(entry_id):
				_unlocked_books[entry_id] = true
				_flag_store.set_value("archive_book_%s" % entry_id, true)
				_emit_update("book", entry_id)
		"bookEntry":
			if not _book_entry_ids.has(entry_id):
				push_warning("ArchiveManager: unknown book entry '%s'" % entry_id)
				return
			if _flag_store.get_value("archive_book_entry_%s" % entry_id) == true:
				return
			_flag_store.set_value("archive_book_entry_%s" % entry_id, true)
			_emit_update("book", entry_id)


func _emit_update(book_type: String, entry_id: String) -> void:
	_event_bus.emit("archive:updated", {"bookType": book_type, "entryId": entry_id})
	_event_bus.emit("notification:show", {
		"text": _strings.get_text("notifications", "archiveUpdated"),
		"type": "archive",
	})


func mark_read(key: String) -> void:
	_read_entries[key] = true


func is_read(key: String) -> bool:
	return _read_entries.has(key)


func trigger_first_view_if_needed(qualified_key: String, actions: Variant) -> void:
	if not actions is Array or actions.is_empty():
		return
	if _first_view_fired.has(qualified_key):
		return
	_first_view_fired[qualified_key] = true
	var copied_actions: Array = []
	for raw_action: Variant in actions:
		if not raw_action is Dictionary:
			continue
		var action: Dictionary = raw_action.duplicate(false)
		var params: Variant = raw_action.get("params")
		action["params"] = params.duplicate(false) if params is Dictionary else {}
		copied_actions.push_back(action)
	_event_bus.emit("archive:firstView", {"actions": copied_actions})


func trigger_book_slice_first_view(book_id: String, slice: Dictionary) -> void:
	var book: Variant = _book_defs.get(book_id)
	if not book is Dictionary:
		return
	if slice.get("kind") == "page":
		var raw: Variant = _find_by(book.get("pages", []), "pageNum", slice.get("pageNum"))
		if not raw is Dictionary:
			return
		if not _check_conditions(raw.get("unlockConditions", [])):
			return
		trigger_first_view_if_needed("bookpage_%s_%s" % [book_id, slice.get("pageNum")], raw.get("firstViewActions"))
		return
	var page: Variant = _find_by(book.get("pages", []), "pageNum", slice.get("pageNum"))
	var entry: Variant = _find_by(page.get("entries", []), "id", slice.get("entryId")) if page is Dictionary else null
	if not entry is Dictionary:
		return
	trigger_first_view_if_needed("bookentry_%s_%s" % [book_id, slice.get("entryId")], entry.get("firstViewActions"))


func get_lore_category_name(key: String) -> String:
	return str(_lore_category_names.get(key, key))


func has_unread(book_type: String) -> bool:
	match book_type:
		"character":
			for id: String in _unlocked_characters:
				if not _read_entries.has("char_%s" % id):
					return true
			return false
		"lore":
			for id: String in _unlocked_lore:
				if not _read_entries.has("lore_%s" % id):
					return true
			return false
		"document":
			for id: String in _unlocked_documents:
				if not _read_entries.has("doc_%s" % id):
					return true
			return false
		"book", "bookEntry":
			return false
	return false


func _evaluate_unlocks(silent := false) -> void:
	for id: String in _lore_defs:
		var definition: Dictionary = _lore_defs[id]
		if not _unlocked_lore.has(id) and _check_conditions(definition.get("unlockConditions", [])):
			_unlocked_lore[id] = true
			_flag_store.set_value("archive_lore_%s" % id, true)
			if not silent:
				_emit_update("lore", id)

	for id: String in _document_defs:
		var definition: Dictionary = _document_defs[id]
		if not _unlocked_documents.has(id) and _check_conditions(definition.get("discoverConditions", [])):
			_unlocked_documents[id] = true
			_flag_store.set_value("archive_document_%s" % id, true)
			if not silent:
				_emit_update("document", id)

	for book: Dictionary in _book_defs.values():
		for raw_page: Variant in book.get("pages", []):
			if not raw_page is Dictionary:
				continue
			for raw_entry: Variant in raw_page.get("entries", []):
				if not raw_entry is Dictionary:
					continue
				var entry: Dictionary = raw_entry
				var id := str(entry.get("id", ""))
				if id.is_empty():
					continue
				if _flag_store.get_value("archive_book_entry_%s" % id) == true:
					continue
				var conditions: Variant = entry.get("discoverConditions")
				if conditions is Array and not conditions.is_empty() and _check_conditions(conditions):
					_flag_store.set_value("archive_book_entry_%s" % id, true)
					if not silent:
						_emit_update("book", id)


func _check_conditions(conditions: Variant) -> bool:
	if not conditions is Array or conditions.is_empty():
		return true
	if _condition_context_factory.is_valid():
		var context: Variant = _condition_context_factory.call()
		if context is Dictionary:
			return RuntimeConditionEvalBridgeScript.evaluate_condition_expr_list(conditions, context)
	return _flag_store.check_conditions(conditions)


func get_unlocked_characters() -> Array:
	return _resolved_defs(_unlocked_characters, _character_defs)


func get_character_visible_impressions(entry: Dictionary) -> Array[String]:
	var result: Array[String] = []
	for item: Variant in entry.get("impressions", []):
		if item is Dictionary and _check_conditions(item.get("conditions", [])):
			result.push_back(_rd(item.get("text")))
	return result


func get_character_visible_info(entry: Dictionary) -> Array[String]:
	var result: Array[String] = []
	for item: Variant in entry.get("knownInfo", []):
		if item is Dictionary and _check_conditions(item.get("conditions", [])):
			result.push_back(_rd(item.get("text")))
	return result


func get_unlocked_lore() -> Array:
	return _resolved_defs(_unlocked_lore, _lore_defs)


func get_unlocked_documents() -> Array:
	return _resolved_defs(_unlocked_documents, _document_defs)


func get_books() -> Array:
	return _book_defs.values()


func get_unlocked_books() -> Array:
	return _resolved_defs(_unlocked_books, _book_defs)


func get_book_toc_chapters(book: Dictionary) -> Array:
	var pages: Array = book.get("pages", []).duplicate(false)
	pages.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return int(a.pageNum) < int(b.pageNum))
	var result: Array = []
	for page: Dictionary in pages:
		var unlocked := _check_conditions(page.get("unlockConditions", []))
		var entries: Array = []
		for raw_entry: Variant in page.get("entries", []):
			if not raw_entry is Dictionary or not raw_entry.get("id"):
				continue
			var entry: Dictionary = raw_entry
			var title := str(entry.get("title", "")).strip_edges()
			entries.push_back({
				"id": entry.id,
				"title": _rd(title if not title.is_empty() else _strings.get_text("bookReader", "untitledEntry")),
				"unlocked": _flag_store.get_value("archive_book_entry_%s" % entry.id) == true,
			})
		result.push_back({
			"pageNum": page.pageNum,
			"title": _rd(page.title) if page.has("title") else null,
			"unlocked": unlocked,
			"entries": entries,
		})
	return result


func get_book_page_slice(book: Dictionary, page_num: int) -> Variant:
	var page: Variant = _find_by(book.get("pages", []), "pageNum", page_num)
	if not page is Dictionary:
		return null
	var unlocked := _check_conditions(page.get("unlockConditions", []))
	return {
		"kind": "page",
		"pageNum": page.pageNum,
		"title": _rd(page.title) if page.has("title") else null,
		"content": _rd(page.get("content")),
		"illustration": page.get("illustration"),
		"unlocked": unlocked,
	}


func get_book_entry_slice(book: Dictionary, page_num: int, entry_id: String) -> Variant:
	var page: Variant = _find_by(book.get("pages", []), "pageNum", page_num)
	if not page is Dictionary:
		return null
	if not _check_conditions(page.get("unlockConditions", [])):
		return null
	var entry: Variant = _find_by(page.get("entries", []), "id", entry_id)
	if not entry is Dictionary:
		return null
	if _flag_store.get_value("archive_book_entry_%s" % entry.id) != true:
		return null
	var title_trim := str(entry.get("title", "")).strip_edges()
	var content_trim := str(entry.get("content", "")).strip_edges()
	var annotation_raw := str(entry.get("annotation", "")).strip_edges()
	var illustration := str(entry.get("illustration", "")).strip_edges()
	if title_trim.is_empty() and content_trim.is_empty() and annotation_raw.is_empty() and illustration.is_empty():
		return null
	var annotation: Variant = _rd(annotation_raw) if not annotation_raw.is_empty() else null
	return {
		"kind": "entry",
		"pageNum": page.pageNum,
		"chapterTitle": _rd(page.title) if page.has("title") else null,
		"entryId": entry.id,
		"title": _rd(title_trim if not title_trim.is_empty() else _strings.get_text("bookReader", "untitledEntry")),
		"content": _rd(content_trim),
		"annotation": annotation,
		"illustration": illustration if not illustration.is_empty() else null,
		"unlocked": true,
	}


func serialize() -> Dictionary:
	return {
		"characters": _unlocked_characters.keys(),
		"lore": _unlocked_lore.keys(),
		"documents": _unlocked_documents.keys(),
		"books": _unlocked_books.keys(),
		"read": _read_entries.keys(),
		"firstViewFired": _first_view_fired.keys(),
	}


func deserialize(data: Dictionary) -> void:
	_unlocked_characters = _set_from_array(data.get("characters"))
	_unlocked_lore = _set_from_array(data.get("lore"))
	_unlocked_documents = _set_from_array(data.get("documents"))
	_unlocked_books = _set_from_array(data.get("books"))
	_read_entries = _set_from_array(data.get("read"))
	_first_view_fired = _set_from_array(data.get("firstViewFired"))
	_sync_unlocked_books_from_flags()


func destroy() -> void:
	_destroyed = true
	if _preload_idle_handle != null:
		var callback := Callable(self, "_run_scheduled_content_image_preload")
		if _preload_idle_handle.timeout.is_connected(callback):
			_preload_idle_handle.timeout.disconnect(callback)
		_preload_idle_handle = null
	_event_bus.off("flag:changed", _on_flag_changed)
	_event_bus.off("narrative:stateChanged", _on_flag_changed)
	_condition_context_factory = Callable()
	_resolve_for_display = Callable()
	_restoring = false
	_seeding = false
	_unlock_eval_running = false
	_unlock_eval_dirty = false
	_character_defs.clear()
	_lore_defs.clear()
	_document_defs.clear()
	_book_defs.clear()
	_book_entry_ids.clear()
	_item_display_names.clear()
	_unlocked_characters.clear()
	_unlocked_lore.clear()
	_unlocked_documents.clear()
	_unlocked_books.clear()
	_read_entries.clear()
	_first_view_fired.clear()


# Map.find and Set construction language adapters.
func _find_by(list: Variant, key: String, value: Variant) -> Variant:
	if list is Array:
		for item: Variant in list:
			if item is Dictionary and item.get(key) == value:
				return item
	return null


func _resolved_defs(ids: Dictionary, defs: Dictionary) -> Array:
	var result: Array = []
	for id: String in ids:
		if defs.has(id):
			result.push_back(defs[id])
	return result


func _set_from_array(value: Variant) -> Dictionary:
	var result := {}
	if value is Array:
		for item: Variant in value:
			result[str(item)] = true
	return result
