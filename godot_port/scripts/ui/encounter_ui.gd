class_name RuntimeEncounterUI
extends RefCounted

const INACTIVE := "Inactive"
const NARRATIVE := "Narrative"
const OPTIONS := "Options"
const RESULT := "Result"
const TYPEWRITER_SPEED := 35.0

var renderer: RuntimeRenderer
var event_bus: RuntimeEventBus
var strings: RuntimeStringsProvider
var input_manager: RuntimeInputManager
var root: Control
var text_label: Label
var options_box: VBoxContainer
var phase := INACTIVE
var full_text := ""
var displayed_chars := 0
var typewriter_time := 0.0
var text_complete := false
var current_options: Array = []
var choice_locked := false
var _unsubscribe_pointer := Callable()
var _unsubscribe_key := Callable()
var _destroyed := false


func _init(next_renderer: RuntimeRenderer, events: RuntimeEventBus, next_strings: RuntimeStringsProvider, input: RuntimeInputManager) -> void:
	renderer = next_renderer; event_bus = events; strings = next_strings; input_manager = input
	event_bus.on("encounter:narrative", Callable(self, "_show_narrative")); event_bus.on("encounter:options", Callable(self, "_show_options")); event_bus.on("encounter:result", Callable(self, "_show_result")); event_bus.on("encounter:end", Callable(self, "_on_end"))


func is_open() -> bool: return root != null
func get_phase() -> String: return phase
func get_visible_text() -> String: return text_label.text if text_label != null else ""
func get_option_count() -> int: return current_options.size()


func update(dt: float) -> void:
	if phase not in [NARRATIVE, RESULT] or text_complete or text_label == null: return
	typewriter_time += dt; displayed_chars = mini(full_text.length(), int(floor(typewriter_time * TYPEWRITER_SPEED))); text_label.text = full_text.left(displayed_chars)
	if displayed_chars >= full_text.length(): text_complete = true


func debug_advance() -> void: _handle_advance()
func debug_select_option(display_index: int) -> void:
	if display_index >= 0 and display_index < current_options.size(): _select_option(current_options[display_index])


func hide() -> void:
	if not _unsubscribe_pointer.is_null() and _unsubscribe_pointer.is_valid(): _unsubscribe_pointer.call()
	if not _unsubscribe_key.is_null() and _unsubscribe_key.is_valid(): _unsubscribe_key.call()
	_unsubscribe_pointer = Callable(); _unsubscribe_key = Callable()
	if root != null and is_instance_valid(root):
		if root.get_parent() != null:
			root.get_parent().remove_child(root)
		root.free()
	root = null; text_label = null; options_box = null; phase = INACTIVE; full_text = ""; displayed_chars = 0; typewriter_time = 0.0; text_complete = false; current_options.clear(); choice_locked = false


func destroy() -> void:
	if _destroyed: return
	_destroyed = true; hide(); event_bus.off("encounter:narrative", Callable(self, "_show_narrative")); event_bus.off("encounter:options", Callable(self, "_show_options")); event_bus.off("encounter:result", Callable(self, "_show_result")); event_bus.off("encounter:end", Callable(self, "_on_end"))


func _ensure_root() -> void:
	if root != null: return
	root = Control.new(); root.name = "EncounterUI"; root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); root.mouse_filter = Control.MOUSE_FILTER_PASS; renderer.ui_layer.add_child(root)
	_unsubscribe_pointer = input_manager.subscribe_pointer_down(Callable(self, "_handle_advance")); _unsubscribe_key = input_manager.subscribe_key_down(Callable(self, "_on_key_down"))


func _clear_content() -> void:
	if root == null: return
	for child: Node in root.get_children():
		root.remove_child(child)
		child.free()
	text_label = null; options_box = null; current_options.clear()


func _make_panel(height: float) -> Panel:
	var panel := Panel.new(); panel.position = Vector2(20, renderer.screen_height - height - 20); panel.size = Vector2(renderer.screen_width - 40, height); panel.mouse_filter = Control.MOUSE_FILTER_IGNORE; var style := StyleBoxFlat.new(); style.bg_color = Color(0.09, 0.045, 0.055, 0.97); style.border_color = Color(0.82, 0.43, 0.34); style.set_border_width_all(2); style.set_corner_radius_all(7); panel.add_theme_stylebox_override("panel", style); root.add_child(panel); return panel


func _show_narrative(payload: Variant) -> void:
	if not payload is Dictionary: return
	_ensure_root(); _clear_content(); phase = NARRATIVE; _make_panel(120)
	text_label = _make_text_label(120); full_text = str(payload.get("text", "")); displayed_chars = 0; typewriter_time = 0.0; text_complete = full_text.is_empty()


func _show_result(payload: Variant) -> void:
	if not payload is Dictionary: return
	_ensure_root(); _clear_content(); phase = RESULT; _make_panel(100)
	text_label = _make_text_label(100); full_text = str(payload.get("text", "")); displayed_chars = 0; typewriter_time = 0.0; text_complete = full_text.is_empty()


func _make_text_label(height: float) -> Label:
	var label := Label.new(); label.position = Vector2(40, renderer.screen_height - height); label.size = Vector2(renderer.screen_width - 80, height - 40); label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; label.clip_text = true; label.add_theme_font_size_override("font_size", 16); label.add_theme_color_override("font_color", Color("e4d8d4")); label.mouse_filter = Control.MOUSE_FILTER_IGNORE; root.add_child(label); return label


func _show_options(payload: Variant) -> void:
	if not payload is Dictionary or not payload.get("options") is Array: return
	_ensure_root(); _clear_content(); phase = OPTIONS; current_options = payload.options.duplicate(true); choice_locked = false
	var height := current_options.size() * 40.0 + 20.0; _make_panel(height); options_box = VBoxContainer.new(); options_box.position = Vector2(30, renderer.screen_height - height - 10); options_box.size = Vector2(renderer.screen_width - 60, height - 20); root.add_child(options_box)
	for option: Variant in current_options:
		if not option is Dictionary: continue
		var row := Label.new(); row.custom_minimum_size = Vector2(options_box.size.x, 35); row.vertical_alignment = VERTICAL_ALIGNMENT_CENTER; row.add_theme_font_size_override("font_size", 14); row.mouse_filter = Control.MOUSE_FILTER_STOP; var tag := strings.get_text("encounter", "ruleTag") if option.get("type") == "rule" else (strings.get_text("encounter", "specialTag") if option.get("type") == "special" else ""); var suffix := " (%s)" % option.disableReason if option.get("enabled") != true and not str(option.get("disableReason", "")).is_empty() else ""; row.text = "  %s. %s%s%s" % [int(option.get("index", 0)) + 1, (tag + " ") if not tag.is_empty() else "", str(option.get("text", "")), suffix]; row.add_theme_color_override("font_color", Color("e5ddd4") if option.get("enabled") == true else Color("8d8784")); var style := StyleBoxFlat.new(); style.bg_color = Color(0.16, 0.08, 0.09, 0.94); style.set_corner_radius_all(4); row.add_theme_stylebox_override("normal", style); row.gui_input.connect(Callable(self, "_on_option_gui_input").bind(option)); options_box.add_child(row)


func _select_option(option: Dictionary) -> void:
	if phase != OPTIONS or choice_locked: return
	if option.get("enabled") != true:
		var reason := str(option.get("disableReason", "")); if not reason.is_empty(): event_bus.emit("notification:show", {"text": reason, "type": "warning"})
		return
	choice_locked = true; event_bus.emit("encounter:choiceSelected", {"index": int(option.get("index", -1))})


func _on_option_gui_input(event: InputEvent, option: Dictionary) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed: _select_option(option)


func _handle_advance() -> void:
	if phase not in [NARRATIVE, RESULT]: return
	if not text_complete:
		displayed_chars = full_text.length(); if text_label != null: text_label.text = full_text; text_complete = true; return
	if phase == NARRATIVE: event_bus.emit("encounter:narrativeDone", {})
	else: event_bus.emit("encounter:resultDone", {})


func _on_key_down(record: Dictionary) -> void:
	if record.get("repeat") == true: return
	var code := str(record.get("code", ""))
	if phase == OPTIONS and code.begins_with("Digit"): debug_select_option(int(code.trim_prefix("Digit")) - 1); return
	if code in ["Space", "Enter", "NumpadEnter"]: _handle_advance()
func _on_end(_payload: Variant = null) -> void: hide()
