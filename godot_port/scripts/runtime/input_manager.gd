class_name RuntimeInputManager
extends Node

signal focus_lost

var _keys_down: Dictionary = {}
var _key_just_pressed: Dictionary = {}
var _game_keyboard_blocked := false
var _mouse_pos := Vector2.ZERO
var _mouse_down := false
var _mouse_just_clicked := false
var _touch_move_x := 0
var _touch_move_y := 0
var _touch_run_held := false
var _key_down_subscribers: Array[Callable] = []
var _key_up_subscribers: Array[Callable] = []
var _any_input_subscribers: Array[Callable] = []
var _pointer_down_subscribers: Array[Callable] = []
var _destroyed := false


func _ready() -> void:
	set_process_input(true)


func _process(_delta: float) -> void:
	# RuntimeRoot precedes InputManager in the bootstrap tree; systems consume
	# edge-triggered input before this end-of-frame reset.
	end_frame()


func _input(event: InputEvent) -> void:
	if _destroyed:
		return
	if event is InputEventKey:
		var code := _dom_code(event)
		if event.pressed:
			_handle_key_down(code, event.echo, Callable(self, "_mark_input_handled"))
		else:
			_handle_key_up(code)
	elif event is InputEventMouseMotion:
		_mouse_pos = event.position
	elif event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		_mouse_pos = event.position
		if event.pressed:
			_handle_pointer_down()
		else:
			_handle_pointer_up()


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT \
		or what == NOTIFICATION_WM_WINDOW_FOCUS_OUT \
		or what == NOTIFICATION_APPLICATION_PAUSED:
		on_focus_lost()


func on_focus_lost() -> void:
	_keys_down.clear()
	_key_just_pressed.clear()
	_mouse_down = false
	_mouse_just_clicked = false
	focus_lost.emit()


func is_key_down(code: String) -> bool:
	return false if _game_keyboard_blocked else _keys_down.has(code)


func was_key_just_pressed(code: String) -> bool:
	return false if _game_keyboard_blocked else _key_just_pressed.has(code)


func is_mouse_down() -> bool:
	return _mouse_down


func was_mouse_just_clicked() -> bool:
	return _mouse_just_clicked


func get_mouse_pos() -> Vector2:
	return _mouse_pos


func end_frame() -> void:
	_key_just_pressed.clear()
	_mouse_just_clicked = false


func get_movement_direction() -> Vector2:
	if _game_keyboard_blocked:
		return Vector2.ZERO
	var dx := 0
	var dy := 0
	if is_key_down("KeyW") or is_key_down("ArrowUp"):
		dy -= 1
	if is_key_down("KeyS") or is_key_down("ArrowDown"):
		dy += 1
	if is_key_down("KeyA") or is_key_down("ArrowLeft"):
		dx -= 1
	if is_key_down("KeyD") or is_key_down("ArrowRight"):
		dx += 1
	dx = clampi(dx + _touch_move_x, -1, 1)
	dy = clampi(dy + _touch_move_y, -1, 1)
	var direction := Vector2(dx, dy)
	return direction.normalized() if dx != 0 and dy != 0 else direction


func is_running() -> bool:
	if _game_keyboard_blocked:
		return false
	return _keys_down.has("ShiftLeft") or _keys_down.has("ShiftRight") or _touch_run_held


func inject_key_just_pressed(code: String) -> void:
	if not _game_keyboard_blocked:
		_key_just_pressed[code] = true


func inject_pointer_down() -> void:
	_mouse_just_clicked = true
	_notify_no_arg(_any_input_subscribers)
	_notify_no_arg(_pointer_down_subscribers)


func set_touch_move_axes(x: int, y: int) -> void:
	_touch_move_x = clampi(x, -1, 1)
	_touch_move_y = clampi(y, -1, 1)


func set_touch_run_held(held: bool) -> void:
	_touch_run_held = held


func set_game_keyboard_blocked(blocked: bool) -> void:
	_game_keyboard_blocked = blocked


func subscribe_key_down(callback: Callable) -> Callable:
	_key_down_subscribers.push_back(callback)
	return func() -> void: _remove_first(_key_down_subscribers, callback)


func subscribe_key_up(callback: Callable) -> Callable:
	_key_up_subscribers.push_back(callback)
	return func() -> void: _remove_first(_key_up_subscribers, callback)


func subscribe_any_input(callback: Callable) -> Callable:
	_any_input_subscribers.push_back(callback)
	return func() -> void: _remove_first(_any_input_subscribers, callback)


func subscribe_pointer_down(callback: Callable) -> Callable:
	_pointer_down_subscribers.push_back(callback)
	return func() -> void: _remove_first(_pointer_down_subscribers, callback)


func destroy() -> void:
	if _destroyed:
		return
	_destroyed = true
	set_process_input(false)
	_key_down_subscribers.clear()
	_key_up_subscribers.clear()
	_any_input_subscribers.clear()
	_pointer_down_subscribers.clear()


func subscriber_count() -> int:
	return _key_down_subscribers.size() + _key_up_subscribers.size() + _any_input_subscribers.size() + _pointer_down_subscribers.size()


func debug_key_down(code: String, repeat: bool = false) -> void:
	_handle_key_down(code, repeat, Callable())


func debug_key_up(code: String) -> void:
	_handle_key_up(code)


func debug_pointer_move(position: Vector2) -> void:
	_mouse_pos = position


func debug_pointer_down() -> void:
	_handle_pointer_down()


func debug_pointer_up() -> void:
	_handle_pointer_up()


func _handle_key_down(code: String, repeat: bool, prevent_default: Callable) -> void:
	if not _game_keyboard_blocked:
		if not _keys_down.has(code):
			_key_just_pressed[code] = true
		_keys_down[code] = true
		if not repeat:
			_notify_no_arg(_any_input_subscribers)
	var record := {"code": code, "repeat": repeat, "preventDefault": prevent_default}
	for callback: Callable in _key_down_subscribers.duplicate():
		if callback.is_valid():
			callback.call(record)


func _handle_key_up(code: String) -> void:
	_keys_down.erase(code)
	var record := {"code": code}
	for callback: Callable in _key_up_subscribers.duplicate():
		if callback.is_valid(): callback.call(record)


func _handle_pointer_down() -> void:
	_mouse_down = true
	_mouse_just_clicked = true
	_notify_no_arg(_any_input_subscribers)
	_notify_no_arg(_pointer_down_subscribers)


func _handle_pointer_up() -> void:
	_mouse_down = false


func _notify_no_arg(subscribers: Array[Callable]) -> void:
	for callback: Callable in subscribers.duplicate():
		if callback.is_valid():
			callback.call()


func _remove_first(subscribers: Array[Callable], callback: Callable) -> void:
	var index := subscribers.find(callback)
	if index >= 0:
		subscribers.remove_at(index)


func _mark_input_handled() -> void:
	if is_inside_tree():
		get_viewport().set_input_as_handled()


func _dom_code(event: InputEventKey) -> String:
	var key := event.physical_keycode if event.physical_keycode != 0 else event.keycode
	if key >= KEY_A and key <= KEY_Z:
		return "Key" + char(key)
	if key >= KEY_0 and key <= KEY_9:
		return "Digit" + char(key)
	match key:
		KEY_KP_0: return "Numpad0"
		KEY_KP_1: return "Numpad1"
		KEY_KP_2: return "Numpad2"
		KEY_KP_3: return "Numpad3"
		KEY_KP_4: return "Numpad4"
		KEY_KP_5: return "Numpad5"
		KEY_KP_6: return "Numpad6"
		KEY_KP_7: return "Numpad7"
		KEY_KP_8: return "Numpad8"
		KEY_KP_9: return "Numpad9"
		KEY_KP_ENTER: return "NumpadEnter"
		KEY_UP: return "ArrowUp"
		KEY_DOWN: return "ArrowDown"
		KEY_LEFT: return "ArrowLeft"
		KEY_RIGHT: return "ArrowRight"
		KEY_ESCAPE: return "Escape"
		KEY_TAB: return "Tab"
		KEY_SPACE: return "Space"
		KEY_ENTER: return "Enter"
		KEY_SHIFT:
			return "ShiftRight" if event.location == KeyLocation.KEY_LOCATION_RIGHT else "ShiftLeft"
		KEY_F1, KEY_F2, KEY_F3, KEY_F4, KEY_F5, KEY_F6, KEY_F7, KEY_F8, KEY_F9, KEY_F10, KEY_F11, KEY_F12:
			return "F%s" % (key - KEY_F1 + 1)
	return event.as_text_physical_keycode()
