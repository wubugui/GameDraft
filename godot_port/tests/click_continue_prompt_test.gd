extends Node

const ClickContinuePromptScript := preload("res://scripts/ui/click_continue_prompt.gd")

var completed := false


func _ready() -> void:
	var renderer := RuntimeRenderer.new()
	add_child(renderer)
	renderer.init()
	renderer.set_viewport_size(640, 360)
	var input_manager := RuntimeInputManager.new()
	add_child(input_manager)

	_wait_for_continue(renderer, input_manager)
	var prompt := renderer.ui_layer.get_node_or_null("ClickContinuePrompt")
	assert(prompt != null)
	var hint: Label = prompt.get_node("HintText")
	assert(hint.text == "继续测试")
	assert(hint.position == Vector2(0, 308) and hint.size == Vector2(640, 24))

	renderer.set_viewport_size(800, 600)
	assert(hint.position == Vector2(0, 548) and hint.size == Vector2(800, 24))
	await get_tree().process_frame
	await get_tree().process_frame
	InputManagerProbe.pointer_down(input_manager)
	await get_tree().process_frame
	assert(renderer.ui_layer.get_node_or_null("ClickContinuePrompt") != null)
	assert(not completed)

	await get_tree().create_timer(0.13).timeout
	InputManagerProbe.pointer_down(input_manager)
	await get_tree().process_frame
	assert(renderer.ui_layer.get_node_or_null("ClickContinuePrompt") == null)
	assert(completed and InputManagerProbe.subscriber_count(input_manager) == 0)

	input_manager.destroy()
	remove_child(input_manager)
	input_manager.free()
	renderer.destroy()
	remove_child(renderer)
	renderer.free()
	print("ClickContinuePrompt layout/debounce/cleanup direct-translation test: PASS")
	get_tree().quit(0)


func _wait_for_continue(renderer: RuntimeRenderer, input_manager: RuntimeInputManager) -> void:
	await ClickContinuePromptScript.wait_click_continue_with_hint(renderer, input_manager, "继续测试")
	completed = true
