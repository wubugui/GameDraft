class_name RuntimeDebugPanelUI
extends RuntimeTextPanel

const LOG_MAX_LINES := 50
const TABS := ["quick", "system", "tools", "narrative", "flags", "log"]

var system_info_provider := Callable()
var sections: Dictionary = {}
var log_lines: Array[String] = []
var active_tab := "tools"
var extra_scroll: ScrollContainer
var extra_list: VBoxContainer
var rendered_action_count := 0
var rendered_extra_count := 0


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


func attach_flag_debug(flag_store: RuntimeFlagStore, _event_bus: RuntimeEventBus) -> void:
	if sections.has("Flag 调试"):
		return
	add_section("Flag 调试", func() -> String: return JSON.stringify(flag_store.serialize(), "  "))


func select_tab(id: String) -> bool:
	if not TABS.has(id): return false
	active_tab = id
	if is_open(): refresh()
	return true


func refresh() -> void:
	if content == null: return
	title_label.text = panel_title()
	_ensure_extra_host()
	_clear_extra_host()
	var action_rows: Array = []
	var lines: Array[String] = []
	match active_tab:
		"system":
			var info: Variant = system_info_provider.call() if system_info_provider.is_valid() else {}
			lines.push_back(JSON.stringify(info, "  "))
		"log":
			lines.assign(log_lines)
		"quick", "tools", "narrative", "flags":
			for id: String in sections:
				if active_tab == "narrative" and id != "叙事调试": continue
				if active_tab == "tools" and id == "叙事调试": continue
				var value: Variant = sections[id].call()
				var text := str(value.get("text", "")) if value is Dictionary else str(value)
				lines.push_back("[%s]\n%s" % [id, text])
				if value is Dictionary:
					var actions: Variant = value.get("actions")
					if actions is Array:
						for raw_action: Variant in actions:
							if not raw_action is Dictionary: continue
							var source: Dictionary = raw_action
							var callback: Variant = source.get("fn")
							if not callback is Callable or not callback.is_valid(): continue
							var no_refresh: bool = source.get("noRefresh") == true
							action_rows.push_back({
								"id": "%s:%s" % [id, source.get("label", "")],
								"label": "%s · %s" % [id, source.get("label", "")],
								"enabled": source.get("enabled", true),
								"tooltip": source.get("tooltip", ""),
							"callback": Callable(self, "_invoke_section_action").bind(callback, no_refresh),
							})
					var extra: Variant = value.get("extra")
					if extra is Control:
						var header := Label.new(); header.text = id; header.add_theme_color_override("font_color", Color("e8cf8e")); header.add_theme_font_size_override("font_size", 14)
						extra_list.add_child(header)
						extra.custom_minimum_size.x = maxf(extra.custom_minimum_size.x, 300.0)
						extra_list.add_child(extra)
						rendered_extra_count += 1
	set_action_rows(action_rows)
	rendered_action_count = action_rows.size()
	_sync_extra_layout()
	content.text = "\n\n".join(lines) if not lines.is_empty() else "(empty)"


func _invoke_section_action(callback: Callable, no_refresh: bool) -> void:
	callback.call()
	if not no_refresh:
		refresh()


func debug_snapshot() -> Dictionary:
	return {"open": is_open(), "tab": active_tab, "sections": sections.keys(), "logs": log_lines.duplicate(), "actions": rendered_action_count, "extras": rendered_extra_count}


func destroy() -> void:
	super.destroy()
	sections.clear(); log_lines.clear(); system_info_provider = Callable(); extra_scroll = null; extra_list = null; rendered_action_count = 0; rendered_extra_count = 0


func _ensure_extra_host() -> void:
	if panel == null: return
	if extra_scroll != null and is_instance_valid(extra_scroll): return
	extra_scroll = null
	extra_list = null
	extra_scroll = ScrollContainer.new(); extra_scroll.name = "DebugSectionExtras"; extra_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED; panel.add_child(extra_scroll)
	extra_list = VBoxContainer.new(); extra_list.custom_minimum_size = Vector2(300, 0); extra_list.add_theme_constant_override("separation", 10); extra_scroll.add_child(extra_list)


func _clear_extra_host() -> void:
	rendered_extra_count = 0
	if extra_list == null or not is_instance_valid(extra_list): return
	for child: Node in extra_list.get_children():
		extra_list.remove_child(child)
		child.free()


func _sync_extra_layout() -> void:
	if panel == null or content == null or extra_scroll == null: return
	var has_extra := rendered_extra_count > 0
	extra_scroll.visible = has_extra
	if has_extra:
		var x := 230.0 if rendered_action_count > 0 else 20.0
		content.position = Vector2(x, 48)
		content.size = Vector2(panel.size.x - x - 20, 210)
		extra_scroll.position = Vector2(x, 268)
		extra_scroll.size = Vector2(panel.size.x - x - 20, panel.size.y - 288)
	else:
		content.position.y = 48
		content.size.y = panel.size.y - 80
