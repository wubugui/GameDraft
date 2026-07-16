class_name RuntimeDialogueManager
extends RuntimeSystem

var _event_bus: RuntimeEventBus
var _scripted_remaining: Variant = null
var _active := false
var _current_npc_name := ""
var _nested_in_graph := false


func _init(event_bus: RuntimeEventBus) -> void:
	_event_bus = event_bus


func init(_ctx: Dictionary) -> void:
	return


func update(_dt: float) -> void:
	return


func serialize() -> Dictionary:
	if not _active:
		return {"active": false}
	return {"active": true, "npcName": _current_npc_name, "scripted": true}


func deserialize(_data: Variant) -> void:
	if _active:
		end_dialogue()
	_active = false
	_scripted_remaining = null
	_current_npc_name = ""


func start_scripted_dialogue(lines: Array, nested_in_graph: bool = false) -> void:
	if lines.is_empty():
		return
	var first: Dictionary = lines[0]
	_scripted_remaining = lines.slice(1)
	_active = true
	_nested_in_graph = nested_in_graph
	_current_npc_name = str(first.get("speaker", "")).strip_edges()
	_event_bus.emit("dialogue:start", {
		"npcName": _current_npc_name,
		"source": "scripted",
	})
	var payload := first.duplicate()
	if not payload.has("tags") or payload.tags == null:
		payload.tags = []
	_event_bus.emit("dialogue:line", payload)
	if lines.size() == 1:
		_schedule_end()


func advance() -> void:
	if not _active:
		return
	_event_bus.emit("dialogue:prepareBeat", {})
	if _scripted_remaining == null:
		end_dialogue()
		return
	if _scripted_remaining.is_empty():
		_scripted_remaining = null
		end_dialogue()
		return
	var line: Variant = _scripted_remaining.pop_front()
	_event_bus.emit("dialogue:line", line)
	if _scripted_remaining.is_empty():
		_schedule_end()


func choose_option(_index: int) -> void:
	return


func _schedule_end() -> void:
	_event_bus.emit("dialogue:willEnd", {})


func end_dialogue() -> void:
	if not _active:
		return
	var nested := _nested_in_graph
	_active = false
	_scripted_remaining = null
	_current_npc_name = ""
	_nested_in_graph = false
	_event_bus.emit("dialogue:end", {
		"source": "scripted",
		"nestedInGraph": nested,
	})


func is_active() -> bool:
	return _active


func destroy() -> void:
	_scripted_remaining = null
	_active = false
	_current_npc_name = ""
	_nested_in_graph = false
