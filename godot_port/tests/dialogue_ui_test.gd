extends Node

var emitted: Array = []


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository)); var events := RuntimeEventBus.new(); var strings := RuntimeStringsProvider.new(); assert(strings.load(assets)); var input := RuntimeInputManager.new(); add_child(input); var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.set_asset_manager(assets); renderer.init_renderer(); renderer.set_viewport_size(800, 600)
	var ui := RuntimeDialogueUI.new(renderer, events, strings, assets, input)
	for name: String in ["dialogue:advance", "dialogue:advanceEnd", "dialogue:choiceSelected", "notification:show"]: events.on(name, func(payload: Variant) -> void: emitted.push_back({"event": name, "payload": payload}))
	events.emit("dialogue:line", {"speaker": "掌柜", "text": "一段完整的测试台词", "dim": true}); assert(ui.is_open() and ui.get_visible_text() == "")
	ui.update(1.0); assert(ui.get_visible_text() == "一段完整的测试台词"); ui.debug_advance(); assert(emitted[-1].event == "dialogue:advance")
	events.emit("dialogue:line", {"speaker": "旁白", "text": "终句"}); ui.update(1.0); events.emit("dialogue:willEnd", {}); ui.debug_advance(); assert(emitted[-1].event == "dialogue:advanceEnd")
	events.emit("dialogue:choices", [{"index": 3, "text": "可选", "enabled": true}, {"index": 8, "text": "锁定", "enabled": false, "disableHint": "条件不足"}]); assert(ui.get_choice_button_count() == 2); ui.debug_select_choice(1); assert(emitted[-1] == {"event": "notification:show", "payload": {"text": "条件不足", "type": "warning"}}); ui.debug_select_choice(0); assert(emitted[-1] == {"event": "dialogue:choiceSelected", "payload": {"index": 3}})
	events.emit("dialogue:choices", [{"index": 0, "text": "真实按钮", "enabled": true}]); events.on("dialogue:choiceSelected", func(_payload: Variant) -> void: events.emit("dialogue:hidePanel", {})); var choice_row: Control = ui.choices_box.get_child(0); var real_button: Button = choice_row.get_child(2); real_button.emit_signal("pressed"); assert(not ui.is_open()); await get_tree().process_frame
	events.emit("dialogue:end", {"source": "graph", "willContinue": false}); assert(not ui.is_open() and input.subscriber_count() == 0)
	ui.destroy(); assets.dispose(); input.destroy(); remove_child(input); input.free(); renderer.destroy_renderer(); remove_child(renderer); renderer.free(); events.clear()
	print("DialogueUI typewriter/advance/choice lifecycle test: PASS"); get_tree().quit(0)
