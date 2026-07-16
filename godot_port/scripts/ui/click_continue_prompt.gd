class_name RuntimeClickContinuePrompt
extends RefCounted

const BOTTOM_MARGIN := 28.0
const TEXT_HEIGHT := 24.0


static func _layout_hint_text(text: Label, renderer: RuntimeRenderer) -> void:
	text.position = Vector2(0.0, renderer.screen_height - BOTTOM_MARGIN - TEXT_HEIGHT)
	text.size = Vector2(renderer.screen_width, TEXT_HEIGHT)


static func wait_click_continue_with_hint(
	renderer: RuntimeRenderer,
	input_manager: RuntimeInputManager,
	label: String,
) -> void:
	var container := Control.new()
	container.name = "ClickContinuePrompt"
	container.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var text := Label.new()
	text.name = "HintText"
	text.text = label
	text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	text.vertical_alignment = VERTICAL_ALIGNMENT_BOTTOM
	text.mouse_filter = Control.MOUSE_FILTER_IGNORE
	text.add_theme_font_size_override("font_size", 16)
	text.add_theme_color_override("font_color", Color("aaaacc"))
	_layout_hint_text(text, renderer)
	container.add_child(text)
	renderer.ui_layer.add_child(container)

	var layout := func() -> void: _layout_hint_text(text, renderer)
	var unresize := renderer.subscribe_after_resize(layout)
	var completion := RuntimeAsyncLatch.new()
	var state := {
		"finished": false,
		"unsubInput": Callable(),
	}
	var finish := func() -> void:
		if state.finished:
			return
		state.finished = true
		if unresize.is_valid():
			unresize.call()
		var unsub_input: Callable = state.unsubInput
		if unsub_input.is_valid():
			unsub_input.call()
		state.unsubInput = Callable()
		if is_instance_valid(container):
			if container.get_parent() != null:
				container.get_parent().remove_child(container)
			container.free()
		completion.resolve()

	await renderer.get_tree().process_frame
	await renderer.get_tree().process_frame
	var not_before := Time.get_ticks_msec() + 120
	state.unsubInput = input_manager.subscribe_any_input(func() -> void:
		if Time.get_ticks_msec() < not_before:
			return
		finish.call()
	)
	await completion.wait()
