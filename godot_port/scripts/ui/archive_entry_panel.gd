class_name RuntimeArchiveEntryPanel
extends RuntimeTextPanel

var archive: RuntimeArchiveManager
var mode := ""
var selected_id := ""


func _init(next_renderer: RuntimeRenderer, data: RuntimeArchiveManager, next_strings: RuntimeStringsProvider, next_mode: String) -> void:
	super._init(next_renderer, next_strings)
	archive = data
	mode = next_mode


func panel_title() -> String:
	return strings.get_text("characterBook" if mode == "character" else ("loreBook" if mode == "lore" else "documentBox"), "title")


func get_entries() -> Array:
	match mode:
		"character": return archive.get_unlocked_characters()
		"lore": return archive.get_unlocked_lore()
		_: return archive.get_unlocked_documents()


func refresh() -> void:
	if content == null: return
	title_label.text = panel_title()
	var lines: Array[String] = []
	var actions: Array = []
	var entries := get_entries()
	for index in entries.size():
		var entry: Dictionary = entries[index]
		var name_key := "name" if mode != "lore" else "title"
		var prefix := "* " if not archive.is_read(_qualified(str(entry.id))) else ""
		var label := "%s%s" % [prefix, archive.resolve_line(entry.get(name_key, entry.id))]; lines.push_back("%s. %s" % [index + 1, label]); actions.push_back({"label": label, "callback": Callable(self, "_select_entry").bind(str(entry.id))})
	if entries.is_empty(): lines.push_back(strings.get_text("characterBook" if mode == "character" else ("loreBook" if mode == "lore" else "documentBox"), "empty"))
	var selected: Variant = _find_selected(entries)
	if selected is Dictionary:
		lines.push_back("\n" + _detail(selected))
	set_rich_content("\n".join(lines), archive.get_asset_manager())
	set_action_rows(actions)


func debug_select(id: String) -> void:
	_select_entry(id)
func _select_entry(id: String) -> void:
	var entry: Variant = _find_by_id(get_entries(), id)
	if not entry is Dictionary: return
	selected_id = id
	archive.trigger_first_view_if_needed(_qualified(id), entry.get("firstViewActions"))
	archive.mark_read(_qualified(id))
	refresh()


func _detail(entry: Dictionary) -> String:
	if mode == "character":
		var lines: Array[String] = ["%s · %s" % [archive.resolve_line(entry.get("name")), archive.resolve_line(entry.get("title"))]]
		for text: String in archive.get_character_visible_impressions(entry): lines.push_back(text)
		for text: String in archive.get_character_visible_info(entry): lines.push_back(text)
		return "\n".join(lines)
	if mode == "lore": return "%s\n\n%s\n%s %s" % [archive.resolve_line(entry.get("title")), archive.resolve_line(entry.get("content")), strings.get_text("loreBook", "source"), archive.resolve_line(entry.get("source"))]
	return "%s\n\n%s%s" % [archive.resolve_line(entry.get("name")), archive.resolve_line(entry.get("content")), "\n\n%s %s" % [strings.get_text("documentBox", "note"), archive.resolve_line(entry.get("annotation"))] if entry.has("annotation") else ""]


func _qualified(id: String) -> String: return ("char_" if mode == "character" else ("lore_" if mode == "lore" else "doc_")) + id
func _find_selected(entries: Array) -> Variant: return _find_by_id(entries, selected_id)
func _find_by_id(entries: Array, id: String) -> Variant:
	for entry: Variant in entries:
		if entry is Dictionary and str(entry.get("id", "")) == id: return entry
	return null
