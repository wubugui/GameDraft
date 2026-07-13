class_name RuntimeInventoryUI
extends RuntimeTextPanel

var event_bus: RuntimeEventBus
var inventory: RuntimeInventoryManager
var selected_id := ""


func _init(next_renderer: RuntimeRenderer, events: RuntimeEventBus, data: RuntimeInventoryManager, next_strings: RuntimeStringsProvider) -> void: super._init(next_renderer, next_strings); event_bus = events; inventory = data
func panel_title() -> String: return "%s    %s %s" % [strings.get_text("inventory", "title"), strings.get_text("inventory", "coins"), inventory.get_coins()]
func refresh() -> void:
	if content == null: return
	title_label.text = panel_title(); var lines: Array[String] = []; var actions: Array = []; var items := inventory.get_all_items()
	for index in maxi(12, items.size()):
		if index < items.size():
			var item: Dictionary = items[index]; var definition: Variant = item.get("def"); var label := resolve(str(definition.get("name", item.id) if definition is Dictionary else item.id)); lines.push_back("[%02d] %s%s" % [index + 1, label, " ×%s" % item.count if item.count > 1 else ""]); actions.push_back({"label": "%s%s" % [label, " ×%s" % item.count if item.count > 1 else ""], "callback": Callable(self, "_select").bind(str(item.id))})
		else: lines.push_back("[%02d] —" % [index + 1])
	if not selected_id.is_empty(): lines.push_back("\n%s\n%s" % [resolve(str(inventory.get_item_def(selected_id).get("name", selected_id))), resolve(inventory.get_item_description(selected_id))])
	content.text = "\n".join(lines)
	if not selected_id.is_empty(): actions.push_back({"label": strings.get_text("inventory", "discard"), "enabled": inventory.can_discard(selected_id), "callback": Callable(self, "_discard_selected")})
	set_action_rows(actions)
func debug_select(id: String) -> void: _select(id)
func _select(id: String) -> void: selected_id = id; refresh()
func debug_discard_selected() -> void:
	_discard_selected()
func _discard_selected() -> void:
	if selected_id.is_empty() or not inventory.can_discard(selected_id): return
	event_bus.emit("inventory:discard", {"itemId": selected_id}); selected_id = ""; refresh()
