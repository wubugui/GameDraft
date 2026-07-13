class_name RuntimeDialogueLogUI
extends RuntimeTextPanel

const MAX_ENTRIES := 200
var event_bus: RuntimeEventBus
var entries: Array[Dictionary] = []

func _init(next_renderer: RuntimeRenderer, events: RuntimeEventBus, next_strings: RuntimeStringsProvider) -> void:
	super._init(next_renderer, next_strings); event_bus = events; event_bus.on("dialogue:line", Callable(self, "_on_line")); event_bus.on("dialogue:choiceSelected:log", Callable(self, "_on_choice"))
func panel_title() -> String: return strings.get_text("dialogueLog", "title")
func refresh() -> void:
	if content == null: return
	title_label.text = panel_title(); var lines: Array[String] = []
	for entry: Dictionary in entries: lines.push_back(("> " if entry.type == "choice" else (str(entry.get("speaker", "")) + ": " if not str(entry.get("speaker", "")).is_empty() else "")) + str(entry.text))
	content.text = "\n".join(lines) if not lines.is_empty() else strings.get_text("dialogueLog", "empty")
func serialize() -> Dictionary: return {"entries": entries.duplicate(true)}
func deserialize(data: Dictionary) -> void:
	entries.clear()
	var restored: Variant = data.get("entries")
	if restored is Array:
		for value: Variant in restored:
			if value is Dictionary: entries.push_back(value.duplicate(true))
func destroy() -> void: event_bus.off("dialogue:line", Callable(self, "_on_line")); event_bus.off("dialogue:choiceSelected:log", Callable(self, "_on_choice")); super.destroy()
func _add(entry: Dictionary) -> void: entries.push_back(entry); if entries.size() > MAX_ENTRIES: entries.pop_front(); if is_open(): refresh()
func _on_line(payload: Variant) -> void: if payload is Dictionary: _add({"type": "line", "speaker": str(payload.get("speaker", "")), "text": str(payload.get("text", ""))})
func _on_choice(payload: Variant) -> void: if payload is Dictionary and not str(payload.get("text", "")).is_empty(): _add({"type": "choice", "text": str(payload.text)})
