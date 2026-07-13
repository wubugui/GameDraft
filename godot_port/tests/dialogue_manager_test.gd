extends Node

var events_log: Array = []


func _ready() -> void:
	var events := RuntimeEventBus.new(); var manager := RuntimeDialogueManager.new(events); manager.init({})
	for event: String in ["dialogue:start", "dialogue:line", "dialogue:prepareBeat", "dialogue:willEnd", "dialogue:end"]: events.on(event, func(payload: Variant) -> void: events_log.push_back({"event": event, "payload": payload.duplicate(true) if payload is Dictionary else payload}))
	assert(not manager.start_scripted_dialogue([]) and not manager.is_active())
	assert(manager.start_scripted_dialogue([{"speaker": "甲", "text": "一", "portrait": {"slug": "a", "emotion": "x"}}, {"speaker": "乙", "text": "二", "speakerEntity": {"kind": "player"}, "dim": true}], true)); assert(manager.is_active() and manager.serialize() == {"active": true, "npcName": "甲", "scripted": true})
	assert(events_log[0] == {"event": "dialogue:start", "payload": {"npcName": "甲", "source": "scripted"}} and events_log[1].payload.portrait.slug == "a")
	manager.advance(); assert(events_log[-2].event == "dialogue:line" and events_log[-2].payload.text == "二" and events_log[-1].event == "dialogue:willEnd")
	manager.end_dialogue(); assert(not manager.is_active() and events_log[-1] == {"event": "dialogue:end", "payload": {"source": "scripted", "nestedInGraph": true}})
	assert(manager.start_scripted_dialogue([{"speaker": "单", "text": "尾"}])); assert(events_log[-1].event == "dialogue:willEnd"); manager.advance(); assert(not manager.is_active() and events_log[-1].payload.nestedInGraph == false)
	assert(manager.start_scripted_dialogue([{"speaker": "旧", "text": "旧一"}, {"speaker": "旧", "text": "旧二"}])); var ends_before_overwrite := events_log.filter(func(v: Dictionary) -> bool: return v.event == "dialogue:end").size(); assert(manager.start_scripted_dialogue([{"speaker": "新", "text": "覆盖"}]) and events_log[-3].payload.npcName == "新" and events_log[-2].payload.text == "覆盖" and events_log.filter(func(v: Dictionary) -> bool: return v.event == "dialogue:end").size() == ends_before_overwrite); manager.advance(); assert(not manager.is_active())
	assert(manager.start_scripted_dialogue([{"speaker": "读档", "text": "丢弃"}])); manager.deserialize({}); assert(not manager.is_active() and events_log[-1].event == "dialogue:end")
	manager.destroy(); manager.free(); events.clear(); print("DialogueManager scripted/nested/end contract test: PASS"); get_tree().quit(0)
