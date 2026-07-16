class_name RuntimeInputManager
extends Node

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
var _any_input_subscribers: Array[Callable] = []
var _pointer_down_subscribers: Array[Callable] = []


func _ready() -> void:
	set_process_input(true)


func _input(event: InputEvent) -> void:
	if event is InputEventKey:
		var code := _dom_code(event)
		if event.pressed:
			_on_key_down(code, event.echo, Callable(self, "_mark_input_handled"))
		else:
			_on_key_up(code)
	elif event is InputEventMouseMotion:
		_on_pointer_move(event.position)
	elif event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		_mouse_pos = event.position
		if event.pressed:
			_on_pointer_down()
		else:
			_on_pointer_up()


func _notification(what: int) -> void:
	if not is_processing_input():
		return
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT \
		or what == NOTIFICATION_WM_WINDOW_FOCUS_OUT \
		or what == NOTIFICATION_APPLICATION_PAUSED:
		_on_focus_lost()


func _on_focus_lost() -> void:
	_keys_down.clear()
	_key_just_pressed.clear()
	_mouse_down = false
	_mouse_just_clicked = false


func _on_key_down(code: String, repeat: bool, prevent_default: Callable) -> void:
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


func _on_key_up(code: String) -> void:
	_keys_down.erase(code)


func _on_pointer_move(position: Vector2) -> void:
	_mouse_pos = position


func _on_pointer_down() -> void:
	_mouse_down = true
	_mouse_just_clicked = true
	_notify_no_arg(_any_input_subscribers)
	_notify_no_arg(_pointer_down_subscribers)


func _on_pointer_up() -> void:
	_mouse_down = false


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
	dx = maxi(-1, mini(1, dx + _touch_move_x))
	dy = maxi(-1, mini(1, dy + _touch_move_y))
	if dx != 0 and dy != 0:
		var length := sqrt(float(dx * dx + dy * dy))
		return Vector2(dx / length, dy / length)
	return Vector2(dx, dy)


func is_running() -> bool:
	if _game_keyboard_blocked:
		return false
	return _keys_down.has("ShiftLeft") or _keys_down.has("ShiftRight") or _touch_run_held


func inject_key_just_pressed(code: String) -> void:
	if _game_keyboard_blocked:
		return
	_key_just_pressed[code] = true


func inject_pointer_down() -> void:
	_mouse_just_clicked = true
	_notify_no_arg(_any_input_subscribers)
	_notify_no_arg(_pointer_down_subscribers)


func set_touch_move_axes(x: int, y: int) -> void:
	_touch_move_x = x
	_touch_move_y = y


func set_touch_run_held(held: bool) -> void:
	_touch_run_held = held


func set_game_keyboard_blocked(blocked: bool) -> void:
	_game_keyboard_blocked = blocked


func subscribe_key_down(callback: Callable) -> Callable:
	_key_down_subscribers.push_back(callback)
	return func() -> void: _remove_first(_key_down_subscribers, callback)


func subscribe_any_input(callback: Callable) -> Callable:
	_any_input_subscribers.push_back(callback)
	return func() -> void: _remove_first(_any_input_subscribers, callback)


func subscribe_pointer_down(callback: Callable) -> Callable:
	_pointer_down_subscribers.push_back(callback)
	return func() -> void: _remove_first(_pointer_down_subscribers, callback)


func destroy() -> void:
	set_process_input(false)
	_key_down_subscribers.clear()
	_any_input_subscribers.clear()
	_pointer_down_subscribers.clear()


static func _notify_no_arg(subscribers: Array[Callable]) -> void:
	for callback: Callable in subscribers.duplicate():
		if callback.is_valid():
			callback.call()


static func _remove_first(subscribers: Array[Callable], callback: Callable) -> void:
	var index := subscribers.find(callback)
	if index >= 0:
		subscribers.remove_at(index)


func _mark_input_handled() -> void:
	if is_inside_tree():
		get_viewport().set_input_as_handled()


static func _dom_code(event: InputEventKey) -> String:
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
