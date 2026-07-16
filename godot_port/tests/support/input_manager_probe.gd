class_name InputManagerProbe
extends RefCounted


static func key_down(input: RuntimeInputManager, code: String, repeat: bool = false) -> void:
	if not input.is_inside_tree():
		input.call("_on_key_down", code, repeat, Callable())
		return
	var event := _key_event(code, true)
	event.echo = repeat
	input.get_tree().root.propagate_call("_input", [event])


static func key_up(input: RuntimeInputManager, code: String) -> void:
	if not input.is_inside_tree():
		input.call("_on_key_up", code)
		return
	input.get_tree().root.propagate_call("_input", [_key_event(code, false)])


static func pointer_move(input: RuntimeInputManager, position: Vector2) -> void:
	if not input.is_inside_tree():
		input.call("_on_pointer_move", position)
		return
	var event := InputEventMouseMotion.new()
	event.position = position
	input.get_tree().root.propagate_call("_input", [event])


static func pointer_down(input: RuntimeInputManager) -> void:
	_pointer_button(input, true)


static func pointer_up(input: RuntimeInputManager) -> void:
	_pointer_button(input, false)


static func focus_lost(input: RuntimeInputManager) -> void:
	if input.is_inside_tree():
		input.get_tree().root.propagate_notification(Node.NOTIFICATION_APPLICATION_FOCUS_OUT)
	else:
		input.call("_on_focus_lost")


static func subscriber_count(input: RuntimeInputManager) -> int:
	return input.get("_key_down_subscribers").size() \
		+ input.get("_any_input_subscribers").size() \
		+ input.get("_pointer_down_subscribers").size()


static func _pointer_button(input: RuntimeInputManager, pressed: bool) -> void:
	if not input.is_inside_tree():
		input.call("_on_pointer_down" if pressed else "_on_pointer_up")
		return
	var event := InputEventMouseButton.new()
	event.button_index = MOUSE_BUTTON_LEFT
	event.pressed = pressed
	event.position = input.get_mouse_pos()
	input.get_tree().root.propagate_call("_input", [event])


static func _key_event(code: String, pressed: bool) -> InputEventKey:
	var event := InputEventKey.new()
	event.pressed = pressed
	var key := _keycode(code)
	event.keycode = key
	event.physical_keycode = key
	if code == "ShiftRight":
		event.location = KeyLocation.KEY_LOCATION_RIGHT
	return event


static func _keycode(code: String) -> Key:
	if code.begins_with("Key") and code.length() == 4:
		return code.unicode_at(3) as Key
	if code.begins_with("Digit") and code.length() == 6:
		return code.unicode_at(5) as Key
	if code.begins_with("F") and code.substr(1).is_valid_int():
		return (KEY_F1 + int(code.substr(1)) - 1) as Key
	if code.begins_with("Numpad") and code.substr(6).is_valid_int():
		return (KEY_KP_0 + int(code.substr(6))) as Key
	return {
		"NumpadEnter": KEY_KP_ENTER,
		"ArrowUp": KEY_UP,
		"ArrowDown": KEY_DOWN,
		"ArrowLeft": KEY_LEFT,
		"ArrowRight": KEY_RIGHT,
		"Escape": KEY_ESCAPE,
		"Tab": KEY_TAB,
		"Space": KEY_SPACE,
		"Enter": KEY_ENTER,
		"ShiftLeft": KEY_SHIFT,
		"ShiftRight": KEY_SHIFT,
	}.get(code, KEY_NONE)
