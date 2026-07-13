extends Node

var emitted: Array = []


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository)); var strings := RuntimeStringsProvider.new(); assert(strings.load(assets)); var events := RuntimeEventBus.new(); var input := RuntimeInputManager.new(); add_child(input); var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.init_renderer(); renderer.set_viewport_size(800, 600); var ui := RuntimeEncounterUI.new(renderer, events, strings, input)
	for event: String in ["encounter:narrativeDone", "encounter:choiceSelected", "encounter:resultDone", "notification:show"]: events.on(event, func(payload: Variant) -> void: emitted.push_back({"event": event, "payload": payload}))
	events.emit("encounter:narrative", {"text": "遭遇叙事"}); assert(ui.is_open() and ui.get_phase() == RuntimeEncounterUI.NARRATIVE); ui.debug_advance(); assert(ui.get_visible_text() == "遭遇叙事"); ui.debug_advance(); assert(emitted[-1].event == "encounter:narrativeDone")
	events.emit("encounter:options", {"options": [{"index": 0, "text": "可选", "type": "general", "enabled": true}, {"index": 1, "text": "锁定", "type": "rule", "enabled": false, "disableReason": "缺条件"}]}); assert(ui.get_phase() == RuntimeEncounterUI.OPTIONS and ui.get_option_count() == 2); ui.debug_select_option(1); assert(emitted[-1] == {"event": "notification:show", "payload": {"text": "缺条件", "type": "warning"}}); ui.debug_select_option(0); ui.debug_select_option(0); assert(emitted.filter(func(value: Dictionary) -> bool: return value.event == "encounter:choiceSelected").size() == 1)
	events.emit("encounter:result", {"text": "结算结果"}); ui.update(1.0); assert(ui.get_visible_text() == "结算结果"); ui.debug_advance(); assert(emitted[-1].event == "encounter:resultDone"); events.emit("encounter:end", {}); assert(not ui.is_open() and input.subscriber_count() == 0); await get_tree().process_frame; await get_tree().process_frame
	ui.destroy(); input.destroy(); remove_child(input); input.free(); renderer.destroy_renderer(); remove_child(renderer); renderer.free(); events.clear(); assets.dispose(); print("EncounterUI four-phase/input/choice-lock lifecycle test: PASS"); get_tree().quit(0)
