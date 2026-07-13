class_name RuntimeDialogueManager
extends RuntimeSystem

signal scripted_finished

var event_bus: RuntimeEventBus
var scripted_remaining: Array = []
var active := false
var current_npc_name := ""
var nested_in_graph := false


func _init(events: RuntimeEventBus) -> void: event_bus = events
func is_active() -> bool: return active


func start_scripted_dialogue(lines: Array, nested: bool = false) -> bool:
	if lines.is_empty(): return false
	var first: Variant = lines[0]
	if not first is Dictionary: return false
	scripted_remaining = lines.slice(1).duplicate(true); active = true; nested_in_graph = nested; current_npc_name = str(first.get("speaker", "")).strip_edges()
	event_bus.emit("dialogue:start", {"npcName": current_npc_name, "source": "scripted"})
	var payload: Dictionary = first.duplicate(true); if not payload.get("tags") is Array: payload.tags = []
	event_bus.emit("dialogue:line", payload)
	if lines.size() == 1: event_bus.emit("dialogue:willEnd", {})
	return true


func play_and_wait(lines: Array, nested: bool = false) -> bool:
	if not start_scripted_dialogue(lines, nested): return false
	while active: await scripted_finished
	return true


func advance() -> void:
	if not active: return
	event_bus.emit("dialogue:prepareBeat", {})
	if scripted_remaining.is_empty(): end_dialogue(); return
	var line: Variant = scripted_remaining.pop_front()
	if line is Dictionary:
		var payload: Dictionary = line.duplicate(true); if not payload.get("tags") is Array: payload.tags = []
		event_bus.emit("dialogue:line", payload)
	if scripted_remaining.is_empty(): event_bus.emit("dialogue:willEnd", {})


func choose_option(_index: int) -> bool: return false


func end_dialogue() -> void:
	if not active: return
	var nested := nested_in_graph; active = false; scripted_remaining.clear(); current_npc_name = ""; nested_in_graph = false
	event_bus.emit("dialogue:end", {"source": "scripted", "nestedInGraph": nested}); scripted_finished.emit()


func serialize() -> Dictionary:
	return {"active": true, "npcName": current_npc_name, "scripted": true} if active else {"active": false}


func deserialize(_data: Dictionary) -> void:
	if active: end_dialogue()
	active = false; scripted_remaining.clear(); current_npc_name = ""; nested_in_graph = false


func destroy() -> void:
	active = false; scripted_remaining.clear(); current_npc_name = ""; nested_in_graph = false
