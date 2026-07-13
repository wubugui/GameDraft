class_name RuntimeTouchMobileControls
extends RefCounted

const PANEL_DEFS := [
	["quest", "quest"], ["inventory", "inventory"], ["rules", "rules"],
	["dialogueLog", "dialogueLog"], ["bookshelf", "bookshelf"], ["map", "map"],
	["ruleUse", "ruleUse"], ["shop", "shop"], ["menu", "menu"], ["debug", "debug"],
]

var renderer: RuntimeRenderer
var input_manager: RuntimeInputManager
var state_controller: RuntimeGameStateController
var strings: RuntimeStringsProvider
var root: Control
var explore_group: Control
var overlay_group: Control
var active_dirs: Dictionary = {}
var run_held := false
var destroyed := false
var force_mobile: Variant = null


func _init(next_renderer: RuntimeRenderer, input: RuntimeInputManager, state: RuntimeGameStateController, next_strings: RuntimeStringsProvider, mobile_override: Variant = null) -> void:
	renderer = next_renderer; input_manager = input; state_controller = state; strings = next_strings; force_mobile = mobile_override
	_build()


func update() -> void:
	if destroyed or root == null: return
	var mobile := bool(force_mobile) if force_mobile is bool else DisplayServer.is_touchscreen_available()
	var explore := mobile and state_controller.current_state == RuntimeGameStateController.EXPLORING
	var overlay := mobile and state_controller.current_state == RuntimeGameStateController.UI_OVERLAY
	root.visible = explore or overlay; explore_group.visible = explore; overlay_group.visible = overlay
	if not explore: clear_explore_input()


func debug_direction(dir: String, pressed: bool) -> void:
	if pressed: active_dirs[dir] = true
	else: active_dirs.erase(dir)
	_apply_axes()


func debug_run(pressed: bool) -> void:
	run_held = pressed; input_manager.set_touch_run_held(pressed)


func debug_interact() -> void: input_manager.inject_key_just_pressed("KeyE")
func debug_toggle_panel(name: String) -> void: state_controller.toggle_panel(name)
func debug_back() -> void: state_controller.trigger_escape_from_touch()


func clear_explore_input() -> void:
	active_dirs.clear(); input_manager.set_touch_move_axes(0, 0)
	if run_held: run_held = false; input_manager.set_touch_run_held(false)


func destroy() -> void:
	if destroyed: return
	destroyed = true; clear_explore_input()
	if root != null and is_instance_valid(root): root.queue_free()
	root = null; explore_group = null; overlay_group = null


func _build() -> void:
	root = Control.new(); root.name = "TouchMobileControls"; root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	explore_group = Control.new(); explore_group.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); root.add_child(explore_group)
	overlay_group = Control.new(); overlay_group.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); root.add_child(overlay_group)
	var menu := HBoxContainer.new(); menu.position = Vector2(12, 12); explore_group.add_child(menu)
	for pair: Array in PANEL_DEFS:
		var id := str(pair[0]); var button := Button.new(); button.text = _label(str(pair[1]), id); button.pressed.connect(func() -> void: debug_toggle_panel(id)); menu.add_child(button)
	var dpad := GridContainer.new(); dpad.columns = 3; dpad.position = Vector2(24, renderer.get_screen_height() - 190); explore_group.add_child(dpad)
	for definition: Array in [["", ""], ["u", "↑"], ["", ""], ["l", "←"], ["", ""], ["r", "→"], ["", ""], ["d", "↓"], ["", ""]]:
		if str(definition[0]).is_empty(): var spacer := Control.new(); spacer.custom_minimum_size = Vector2(54, 54); dpad.add_child(spacer)
		else:
			var dir := str(definition[0]); var button := Button.new(); button.text = str(definition[1]); button.custom_minimum_size = Vector2(54, 54); button.button_down.connect(func() -> void: debug_direction(dir, true)); button.button_up.connect(func() -> void: debug_direction(dir, false)); dpad.add_child(button)
	var actions := VBoxContainer.new(); actions.position = Vector2(renderer.get_screen_width() - 120, renderer.get_screen_height() - 150); explore_group.add_child(actions)
	var run := Button.new(); run.text = _label("run", "Run"); run.button_down.connect(func() -> void: debug_run(true)); run.button_up.connect(func() -> void: debug_run(false)); actions.add_child(run)
	var interact := Button.new(); interact.text = _label("interact", "Use"); interact.button_down.connect(debug_interact); actions.add_child(interact)
	var back := Button.new(); back.text = _label("back", "Back"); back.position = Vector2(18, renderer.get_screen_height() - 70); back.pressed.connect(debug_back); overlay_group.add_child(back)
	renderer.ui_layer.add_child(root); update()


func _apply_axes() -> void:
	var x := int(active_dirs.has("r")) - int(active_dirs.has("l")); var y := int(active_dirs.has("d")) - int(active_dirs.has("u"))
	input_manager.set_touch_move_axes(x, y)


func _label(key: String, fallback: String) -> String:
	var value := strings.get_text("touchControls", key) if strings != null else key
	return fallback if value == key or value.is_empty() else value
