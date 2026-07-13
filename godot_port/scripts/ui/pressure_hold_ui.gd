class_name RuntimePressureHoldUI
extends RefCounted

const BAR_WIDTH := 420.0
const BAR_HEIGHT := 18.0
const HINT_FLASH_MS := 900

var renderer: RuntimeRenderer
var strings: RuntimeStringsProvider
var input_manager: RuntimeInputManager
var root: Control
var fill_bar: Panel
var hint_text: Label
var current_ratio := 0.0
var current_request: Dictionary = {}
var _active_serial := 0
var _debug_holding: Variant = null
var _debug_step_seconds := 0.0
var _destroyed := false


func _init(next_renderer: RuntimeRenderer, next_strings: RuntimeStringsProvider, input: RuntimeInputManager) -> void:
	renderer = next_renderer
	strings = next_strings
	input_manager = input


func run_segment(request: Dictionary) -> String:
	cancel()
	if _destroyed or not _valid_request(request):
		return "invalid"
	_active_serial += 1
	var serial := _active_serial
	current_ratio = clampf(float(request.startRatio), 0.0, 1.0)
	current_request = request.duplicate(true)
	_build_view(request)
	_redraw_fill(current_ratio, request.get("barColor"))
	var require_initial_release := _is_holding()
	var previous_holding := false
	var last_ticks := Time.get_ticks_usec()
	var hint_shown_at := 0
	while serial == _active_serial and not _destroyed:
		await Engine.get_main_loop().process_frame
		if serial != _active_serial or _destroyed:
			return "reached"
		var now_ticks := Time.get_ticks_usec()
		var dt := _debug_step_seconds if _debug_step_seconds > 0 else clampf(float(now_ticks - last_ticks) / 1000000.0, 0.0, 0.1)
		last_ticks = now_ticks
		var raw_holding := _is_holding()
		if require_initial_release and not raw_holding: require_initial_release = false
		var holding := raw_holding and not require_initial_release
		if previous_holding and not holding:
			hint_shown_at = Time.get_ticks_msec()
			if request.has("abortOnReleaseFromRatio") and current_ratio >= float(request.abortOnReleaseFromRatio):
				_finish(serial)
				return "released"
		previous_holding = holding
		if holding:
			current_ratio = minf(float(request.stopRatio), current_ratio + dt / float(request.fillSeconds))
		else:
			current_ratio = maxf(0.0, current_ratio - dt * float(request.decayPerSecond))
		_redraw_fill(current_ratio, request.get("barColor"))
		if hint_text != null:
			hint_text.visible = hint_shown_at > 0 and Time.get_ticks_msec() - hint_shown_at < HINT_FLASH_MS
		if current_ratio >= float(request.stopRatio):
			_finish(serial)
			return "reached"
	return "reached"


func cancel() -> void:
	_active_serial += 1
	_clear_view()


func destroy() -> void:
	if _destroyed:
		return
	_destroyed = true
	cancel()
	renderer = null
	strings = null
	input_manager = null


func set_debug_input(holding: Variant, step_seconds: float = 0.0) -> void:
	_debug_holding = holding
	_debug_step_seconds = maxf(0.0, step_seconds)


func get_root() -> Control:
	return root


func show_debug_preview(request: Dictionary, ratio: float = 0.42) -> bool:
	cancel()
	if _destroyed or not _valid_request(request): return false
	current_request = request.duplicate(true)
	current_ratio = clampf(ratio, float(request.startRatio), float(request.stopRatio))
	_build_view(request)
	_redraw_fill(current_ratio, request.get("barColor"))
	return true


func is_active() -> bool: return root != null and is_instance_valid(root)


func get_debug_visual_state() -> Variant:
	if not is_active() or current_request.is_empty(): return null
	return {
		"active": true,
		"prompt": str(current_request.get("prompt", "")),
		"releaseHint": str(current_request.get("releaseHint", "")),
		"barColor": int(current_request.get("barColor", 0x6b5636)),
		"startRatio": float(current_request.startRatio),
		"stopRatio": float(current_request.stopRatio),
		"fillSeconds": float(current_request.fillSeconds),
		"decayPerSecond": float(current_request.decayPerSecond),
		"abortOnReleaseFromRatio": float(current_request.abortOnReleaseFromRatio) if current_request.has("abortOnReleaseFromRatio") else null,
		"currentRatio": current_ratio,
		"holding": false if _debug_holding == null else bool(_debug_holding),
		"hintVisible": hint_text.visible if hint_text != null else false,
	}


func _finish(serial: int) -> void:
	if serial != _active_serial:
		return
	_active_serial += 1
	_clear_view()


func _is_holding() -> bool:
	if _debug_holding is bool:
		return _debug_holding
	return input_manager != null and (input_manager.is_key_down("Space") or input_manager.is_mouse_down())


func _valid_request(request: Dictionary) -> bool:
	for key: String in ["startRatio", "stopRatio", "fillSeconds", "decayPerSecond"]:
		if not (request.get(key) is int or request.get(key) is float) or not is_finite(float(request.get(key))):
			return false
	return float(request.fillSeconds) > 0 and float(request.stopRatio) > float(request.startRatio)


func _build_view(request: Dictionary) -> void:
	root = Control.new()
	root.name = "PressureHoldUI"
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	renderer.ui_layer.add_child(root)
	var center_x := renderer.get_screen_width() / 2.0
	var bar_x := center_x - BAR_WIDTH / 2.0
	var bar_y := renderer.get_screen_height() - 120.0
	var prompt := Label.new()
	prompt.text = str(request.get("prompt", ""))
	prompt.position = Vector2(bar_x - 60.0, bar_y - 66.0)
	prompt.size = Vector2(BAR_WIDTH + 120.0, 32.0)
	prompt.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	prompt.vertical_alignment = VERTICAL_ALIGNMENT_BOTTOM
	prompt.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	prompt.add_theme_font_size_override("font_size", 16)
	prompt.add_theme_font_override("font", _system_ui_font(400))
	prompt.add_theme_color_override("font_color", Color("ffcc88"))
	prompt.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(prompt)
	var frame := Panel.new()
	frame.position = Vector2(bar_x - 3.0, bar_y - 3.0)
	frame.size = Vector2(BAR_WIDTH + 6.0, BAR_HEIGHT + 6.0)
	frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var style := StyleBoxFlat.new()
	style.bg_color = Color("201811", 0.95)
	style.border_color = Color("6b5636")
	style.set_border_width_all(1)
	style.set_corner_radius_all(4)
	style.anti_aliasing = true
	frame.add_theme_stylebox_override("panel", style)
	root.add_child(frame)
	fill_bar = Panel.new()
	fill_bar.position = Vector2(bar_x, bar_y)
	fill_bar.size = Vector2(0.0, BAR_HEIGHT)
	fill_bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(fill_bar)
	var key_hint := Label.new()
	key_hint.text = strings.get_text("pressureHold", "holdHint") if strings != null else "按住空格或鼠标"
	key_hint.position = Vector2(bar_x, bar_y + BAR_HEIGHT + 10.0)
	key_hint.size = Vector2(BAR_WIDTH, 20.0)
	key_hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	key_hint.add_theme_font_override("font", _system_ui_font(400))
	key_hint.add_theme_font_size_override("font_size", 11)
	key_hint.add_theme_color_override("font_color", Color("888888"))
	key_hint.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(key_hint)
	if request.has("releaseHint"):
		hint_text = Label.new()
		hint_text.text = str(request.releaseHint)
		hint_text.position = Vector2(bar_x, bar_y - 32.0)
		hint_text.size = Vector2(BAR_WIDTH, 22.0)
		hint_text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		hint_text.add_theme_font_override("font", _system_ui_font(400))
		hint_text.add_theme_font_size_override("font_size", 14)
		hint_text.add_theme_color_override("font_color", Color("ffcc88"))
		hint_text.mouse_filter = Control.MOUSE_FILTER_IGNORE
		hint_text.visible = false
		root.add_child(hint_text)


func _redraw_fill(ratio: float, raw_color: Variant) -> void:
	if fill_bar == null:
		return
	fill_bar.size.x = clampf(ratio, 0.0, 1.0) * BAR_WIDTH
	var color_value := int(raw_color) if raw_color is int else 0x6b5636
	var style := StyleBoxFlat.new(); style.bg_color = Color8((color_value >> 16) & 255, (color_value >> 8) & 255, color_value & 255, 235); style.set_corner_radius_all(4); style.anti_aliasing = true; fill_bar.add_theme_stylebox_override("panel", style)


func _clear_view() -> void:
	if root != null and is_instance_valid(root):
		if root.get_parent() != null:
			root.get_parent().remove_child(root)
		root.free()
	root = null
	fill_bar = null
	hint_text = null
	current_request.clear()


func _system_ui_font(weight: int) -> SystemFont:
	var font := SystemFont.new(); font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"]); font.font_weight = weight; return font
