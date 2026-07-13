extends SceneTree

var input := RuntimeInputManager.new()
var calls: Array[String] = []
var unsubscribe_self := Callable()


func _init() -> void:
	root.add_child(input)
	var unsubscribe_key := input.subscribe_key_down(Callable(self, "_on_key"))
	var unsubscribe_key_up := input.subscribe_key_up(func(event: Dictionary) -> void: calls.push_back("up:%s" % event.code))
	unsubscribe_self = input.subscribe_any_input(Callable(self, "_on_any_self"))
	input.subscribe_any_input(func() -> void: calls.push_back("any:second"))
	input.subscribe_pointer_down(func() -> void: calls.push_back("pointer"))

	input.debug_key_down("KeyW")
	assert(input.is_key_down("KeyW") and input.was_key_just_pressed("KeyW"))
	assert(calls == ["any:self", "any:second", "key:KeyW:false"])
	input.debug_key_down("KeyW", true)
	assert(calls.slice(-1) == ["key:KeyW:true"])
	input.debug_key_up("KeyW")
	assert(calls.slice(-1) == ["up:KeyW"]); input.debug_key_down("KeyW")
	input.debug_key_down("KeyD")
	var direction := input.get_movement_direction()
	assert(is_equal_approx(direction.x, 0.70710678) and is_equal_approx(direction.y, -0.70710678))
	input.set_touch_move_axes(-1, 1)
	assert(input.get_movement_direction() == Vector2.ZERO)
	input.set_touch_move_axes(0, 0)
	input.debug_key_down("ShiftLeft")
	assert(input.is_running())

	input.debug_pointer_move(Vector2(12.0, 34.0))
	input.debug_pointer_down()
	assert(input.get_mouse_pos() == Vector2(12.0, 34.0))
	assert(input.is_mouse_down() and input.was_mouse_just_clicked())
	assert(calls.slice(-2) == ["any:second", "pointer"])
	input.debug_pointer_up()
	assert(not input.is_mouse_down())
	input.end_frame()
	assert(not input.was_key_just_pressed("KeyW") and not input.was_mouse_just_clicked())

	input.inject_key_just_pressed("KeyE")
	assert(input.was_key_just_pressed("KeyE"))
	input.inject_pointer_down()
	assert(input.was_mouse_just_clicked() and not input.is_mouse_down())
	input.set_game_keyboard_blocked(true)
	input.debug_key_down("KeyA")
	assert(not input.is_key_down("KeyA") and not input.was_key_just_pressed("KeyE"))
	assert(input.get_movement_direction() == Vector2.ZERO and not input.is_running())
	assert(calls.slice(-1) == ["key:KeyA:false"])
	input.set_game_keyboard_blocked(false)
	input.on_focus_lost()
	assert(not input.is_key_down("KeyW") and not input.is_running() and not input.was_mouse_just_clicked())
	input.set_touch_move_axes(1, -1)
	assert(input.get_movement_direction().is_equal_approx(Vector2(0.70710678, -0.70710678)))
	input.set_touch_run_held(true)
	assert(input.is_running())

	unsubscribe_key.call()
	unsubscribe_key_up.call()
	input.destroy()
	assert(input.subscriber_count() == 0)
	input.queue_free()
	print("InputManager parity test: PASS")
	quit(0)


func _on_key(event: Dictionary) -> void:
	calls.push_back("key:%s:%s" % [event.code, str(event.repeat).to_lower()])


func _on_any_self() -> void:
	calls.push_back("any:self")
	unsubscribe_self.call()
