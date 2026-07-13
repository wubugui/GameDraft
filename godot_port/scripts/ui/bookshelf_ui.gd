class_name RuntimeBookshelfUI
extends RuntimeTextPanel

var archive: RuntimeArchiveManager
var character_ui: RuntimeCharacterBookUI
var lore_ui: RuntimeLoreBookUI
var document_ui: RuntimeDocumentBoxUI
var book_reader: RuntimeBookReaderUI
var open_rules := Callable()
var active_subpanel: Variant = null

func _init(renderer: RuntimeRenderer, data: RuntimeArchiveManager, strings: RuntimeStringsProvider, characters: RuntimeCharacterBookUI, lore: RuntimeLoreBookUI, documents: RuntimeDocumentBoxUI, reader: RuntimeBookReaderUI, rules_callback: Callable) -> void: super._init(renderer, strings); archive = data; character_ui = characters; lore_ui = lore; document_ui = documents; book_reader = reader; open_rules = rules_callback
func panel_title() -> String: return strings.get_text("bookshelf", "title")
func is_open() -> bool: return root != null or active_subpanel != null
func refresh() -> void:
	if content == null: return
	title_label.text = panel_title(); var rows := [{"id": "rules", "label": strings.get_text("bookshelf", "rules")}, {"id": "character", "label": "%s%s" % [strings.get_text("bookshelf", "characters"), " *" if archive.has_unread("character") else ""]}, {"id": "lore", "label": "%s%s" % [strings.get_text("bookshelf", "lore"), " *" if archive.has_unread("lore") else ""]}, {"id": "document", "label": "%s%s" % [strings.get_text("bookshelf", "documents"), " *" if archive.has_unread("document") else ""]}]; var books := archive.get_unlocked_books(); for book: Dictionary in books: rows.push_back({"id": str(book.id), "label": archive.resolve_line(book.title)}); var lines: Array[String] = []; var actions: Array = []; for index in rows.size(): lines.push_back("%s. %s" % [index + 1, rows[index].label]); actions.push_back({"label": rows[index].label, "callback": Callable(self, "_open_section").bind(rows[index].id)}); content.text = "\n".join(lines); set_action_rows(actions)
func debug_open(id: String) -> void:
	_open_section(id)
func _open_section(id: String) -> void:
	if active_subpanel != null: active_subpanel.close()
	match id:
		"rules": close(); if open_rules.is_valid(): open_rules.call(); return
		"character": active_subpanel = character_ui
		"lore": active_subpanel = lore_ui
		"document": active_subpanel = document_ui
		_:
			for book: Dictionary in archive.get_unlocked_books():
				if str(book.id) == id: active_subpanel = book_reader; book_reader.open_book(book); break
	if active_subpanel != null and active_subpanel != book_reader: active_subpanel.open()
	if active_subpanel != null: super.close()
func close() -> void:
	if active_subpanel != null: active_subpanel.close(); active_subpanel = null
	super.close()
