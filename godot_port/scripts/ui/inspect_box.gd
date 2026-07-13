class_name RuntimeInspectBox
extends RefCounted

signal close_progress

var renderer: RuntimeRenderer
var strings: RuntimeStringsProvider
var input_manager: RuntimeInputManager
var root: Control
var _resolve_display := Callable()
var _unsubscribe_input := Callable()
var _generation := 0
var _completed: Dictionary = {}


func _init(next_renderer: RuntimeRenderer, next_strings: RuntimeStringsProvider, next_input: RuntimeInputManager) -> void: renderer = next_renderer; strings = next_strings; input_manager = next_input
func set_resolve_display(callback: Callable = Callable()) -> void: _resolve_display = callback
func is_open() -> bool: return root != null


func show(text: String) -> void:
	if is_open(): close()
	_generation += 1; var token := _generation
	root = Control.new(); root.name = "InspectBox"; root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); root.mouse_filter = Control.MOUSE_FILTER_STOP
	var screen_width := renderer.get_screen_width(); var screen_height := renderer.get_screen_height(); var width := minf(screen_width - 40.0, 600.0); var display_text := str(_resolve_display.call(text)) if not _resolve_display.is_null() and _resolve_display.is_valid() else text; var font := ThemeDB.fallback_font; var measured := font.get_multiline_string_size(display_text, HORIZONTAL_ALIGNMENT_LEFT, width - 40.0, 16); var height := minf(maxf(100.0, measured.y + 60.0), screen_height - 80.0); var position := Vector2((screen_width - width) / 2.0, screen_height - height - 30.0)
	var panel := Panel.new(); panel.position = position; panel.size = Vector2(width, height); var style := StyleBoxFlat.new(); style.bg_color = Color(0.055, 0.075, 0.11, 0.94); style.border_color = Color(0.35, 0.75, 0.95); style.set_border_width_all(1); style.set_corner_radius_all(6); panel.add_theme_stylebox_override("panel", style); root.add_child(panel)
	var body := Label.new(); body.position = position + Vector2(20, 16); body.size = Vector2(width - 40, height - 48); body.text = display_text; body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; body.clip_text = true; body.add_theme_font_size_override("font_size", 16); body.add_theme_color_override("font_color", Color("d8e3f0")); root.add_child(body)
	var hint := Label.new(); hint.position = position + Vector2(20, height - 28); hint.size = Vector2(width - 40, 20); hint.text = strings.get_text("inspectBox", "closeHint"); hint.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; hint.add_theme_font_size_override("font_size", 11); hint.add_theme_color_override("font_color", Color("8796a8")); root.add_child(hint)
	renderer.ui_layer.add_child(root); _arm_input_after_delay(token)
	while not _completed.has(token): await close_progress
	await Engine.get_main_loop().process_frame


func close() -> void:
	if not _unsubscribe_input.is_null() and _unsubscribe_input.is_valid(): _unsubscribe_input.call()
	_unsubscribe_input = Callable()
	if root != null and is_instance_valid(root):
		if root.get_parent() != null: root.get_parent().remove_child(root)
		root.free()
	root = null
	if _generation > 0 and not _completed.has(_generation): _completed[_generation] = true; close_progress.emit()


func destroy() -> void: close(); _generation += 1; _resolve_display = Callable(); _completed.clear()


func _arm_input_after_delay(token: int) -> void:
	await Engine.get_main_loop().create_timer(0.1).timeout
	if token != _generation or _completed.has(token) or not is_open(): return
	_unsubscribe_input = input_manager.subscribe_any_input(Callable(self, "close"))
