class_name RuntimeDebugPanelUI
extends RuntimeTextPanel

const LOG_MAX_LINES := 50
const TABS := ["quick", "system", "tools", "narrative", "flags", "log"]

var system_info_provider := Callable()
var sections: Dictionary = {}
var log_lines: Array[String] = []
var active_tab := "tools"


func _init(next_renderer: RuntimeRenderer, next_strings: RuntimeStringsProvider, provider: Callable = Callable()) -> void:
	super._init(next_renderer, next_strings)
	system_info_provider = provider


func panel_title() -> String: return "Debug · %s" % active_tab


func add_section(id: String, getter: Callable) -> void:
	if id.strip_edges().is_empty() or not getter.is_valid(): return
	sections[id] = getter
	if is_open(): refresh()


func remove_section(id: String) -> void:
	sections.erase(id)
	if is_open(): refresh()


func log(message: String) -> void:
	log_lines.push_back(message)
	while log_lines.size() > LOG_MAX_LINES: log_lines.pop_front()
	if is_open() and active_tab == "log": refresh()


func clear_logs() -> void:
	log_lines.clear()
	if is_open(): refresh()


func select_tab(id: String) -> bool:
	if not TABS.has(id): return false
	active_tab = id
	if is_open(): refresh()
	return true


func refresh() -> void:
	if content == null: return
	title_label.text = panel_title()
	var lines: Array[String] = []
	match active_tab:
		"system":
			var info: Variant = system_info_provider.call() if system_info_provider.is_valid() else {}
			lines.push_back(JSON.stringify(info, "  "))
		"log":
			lines.assign(log_lines)
		"quick", "tools", "narrative", "flags":
			for id: String in sections:
				var value: Variant = sections[id].call()
				var text := str(value.get("text", "")) if value is Dictionary else str(value)
				lines.push_back("[%s]\n%s" % [id, text])
	content.text = "\n\n".join(lines) if not lines.is_empty() else "(empty)"


func debug_snapshot() -> Dictionary:
	return {"open": is_open(), "tab": active_tab, "sections": sections.keys(), "logs": log_lines.duplicate()}


func destroy() -> void:
	super.destroy()
	sections.clear(); log_lines.clear(); system_info_provider = Callable()
