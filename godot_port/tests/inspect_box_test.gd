extends Node


func _ready() -> void:
	var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.init_renderer(); renderer.set_viewport_size(800, 600); var strings := RuntimeStringsProvider.new(); var input := RuntimeInputManager.new(); add_child(input); var box := RuntimeInspectBox.new(renderer, strings, input); box.set_resolve_display(func(text: String) -> String: return text.replace("[name]", "阿明"))
	box.show("你好 [name]"); assert(box.is_open()); var body: Label = box.root.get_child(1); assert(body.text == "你好 阿明")
	await get_tree().create_timer(0.12).timeout; input.debug_key_down("KeyE"); await get_tree().process_frame; assert(not box.is_open() and input.subscriber_count() == 0); input.debug_key_up("KeyE")
	# Re-show closes and resolves the previous waiter instead of leaking it.
	box.show("first"); await get_tree().process_frame; box.show("second"); await get_tree().process_frame; assert(box.is_open() and (box.root.get_child(1) as Label).text == "second"); box.close(); await get_tree().process_frame; assert(not box.is_open())
	box.show("这是一段很长的检查文字。".repeat(80)); await get_tree().process_frame; var long_panel: Panel = box.root.get_child(0); assert(long_panel.size.y > 120.0 and long_panel.size.y <= 520.0); box.close(); await get_tree().process_frame
	box.destroy(); input.destroy(); remove_child(input); input.free(); renderer.destroy_renderer(); remove_child(renderer); renderer.free()
	print("InspectBox show/re-show/input-close contract test: PASS"); get_tree().quit(0)
