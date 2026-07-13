class_name RuntimeBookReaderUI
extends RuntimeTextPanel

var archive: RuntimeArchiveManager
var current_book: Dictionary = {}
var page_num := 1
var entry_id := ""

func _init(renderer: RuntimeRenderer, data: RuntimeArchiveManager, strings: RuntimeStringsProvider) -> void: super._init(renderer, strings); archive = data
func panel_title() -> String: return archive.resolve_line(current_book.get("title"))
func open_book(book: Dictionary) -> void:
	current_book = book.duplicate(true); var toc := archive.get_book_toc_chapters(current_book); page_num = int(toc[0].pageNum) if not toc.is_empty() else 1; entry_id = ""; super.open(); refresh()
func close() -> void: super.close(); current_book.clear(); entry_id = ""
func refresh() -> void:
	if content == null:
		return
	title_label.text = panel_title()
	var slice: Variant = archive.get_book_entry_slice(current_book, page_num, entry_id) if not entry_id.is_empty() else archive.get_book_page_slice(current_book, page_num)
	if not slice is Dictionary or slice.get("unlocked") != true:
		content.text = strings.get_text("bookReader", "pageMissing")
		return
	archive.trigger_book_slice_first_view(str(current_book.id), slice)
	var lines: Array[String] = []; var actions: Array = []
	for chapter: Dictionary in archive.get_book_toc_chapters(current_book):
		lines.push_back("%s%s" % ["▶ " if int(chapter.pageNum) == page_num else "  ", chapter.get("title", strings.get_text("bookReader", "chapterFallback", {"n": chapter.pageNum}))])
		actions.push_back({"label": str(chapter.get("title", chapter.pageNum)), "callback": Callable(self, "_navigate").bind(int(chapter.pageNum), "")})
		for entry: Dictionary in chapter.entries:
			lines.push_back("    %s%s" % ["✓ " if entry.unlocked else "× ", entry.title])
			actions.push_back({"label": "    %s" % entry.title, "enabled": entry.unlocked, "callback": Callable(self, "_navigate").bind(int(chapter.pageNum), str(entry.id))})
	lines.push_back("\n%s\n\n%s" % [slice.get("title", slice.get("chapterTitle", "")), slice.get("content", "")])
	if slice.get("annotation") != null:
		lines.push_back("\n%s\n%s" % [strings.get_text("bookReader", "annotationHeading"), slice.annotation])
	set_rich_content("\n".join(lines), archive.get_asset_manager())
	set_action_rows(actions)
func debug_navigate(next_page: int, next_entry_id: String = "") -> void: _navigate(next_page, next_entry_id)
func _navigate(next_page: int, next_entry_id: String = "") -> void: page_num = next_page; entry_id = next_entry_id; refresh()
