class_name RuntimeQuestPanelUI
extends RuntimeTextPanel

var quests: RuntimeQuestManager
func _init(next_renderer: RuntimeRenderer, data: RuntimeQuestManager, next_strings: RuntimeStringsProvider) -> void: super._init(next_renderer, next_strings); quests = data
func panel_title() -> String: return strings.get_text("quest", "title")
func refresh() -> void:
	if content == null: return
	title_label.text = panel_title()
	var lines: Array[String] = [strings.get_text("quest", "mainline")]
	var main: Variant = quests.get_current_main_quest()
	lines.push_back(_quest_line(main) if main is Dictionary else strings.get_text("quest", "empty"))
	var active := quests.get_active_quests().filter(func(v: Variant) -> bool: return v is Dictionary and v.def.get("type") != "main")
	lines.push_back("\n" + strings.get_text("quest", "sideline", {"count": active.size()}))
	for active_entry: Dictionary in active: lines.push_back(_quest_line(active_entry.def))
	var completed := quests.get_completed_quests()
	lines.push_back("\n" + strings.get_text("quest", "completed", {"count": completed.size()}))
	for completed_entry: Dictionary in completed: lines.push_back("%s %s" % [strings.get_text("quest", "done"), _quest_line(completed_entry.def)])
	content.text = "\n".join(lines)
func _quest_line(definition: Dictionary) -> String: return "%s\n  %s" % [resolve(str(definition.get("title", ""))), resolve(str(definition.get("description", "")))]
