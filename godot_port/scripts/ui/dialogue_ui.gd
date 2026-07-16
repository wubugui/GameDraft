class_name RuntimeDialogueUI
extends RefCounted

const BOX_HEIGHT := 140.0
const BOX_MARGIN := 20.0
const TYPEWRITER_SPEED := 30.0
const PORTRAIT_SIZE := 240.0
const PORTRAIT_INSET := 248.0

var renderer: RuntimeRenderer
var event_bus: RuntimeEventBus
var strings: RuntimeStringsProvider
var asset_manager: RuntimeAssetManager
var input_manager: RuntimeInputManager
var root: Control
var body: Label
var speaker: Label
var speaker_plate: Panel
var continue_arrow: Polygon2D
var choices_box: Control
var portrait: TextureRect
var scene_dim: ColorRect
var full_text := ""
var displayed_chars := 0
var typewriter_time := 0.0
var showing_full_text := false
var waiting_for_advance := false
var waiting_for_choice := false
var will_end_after_advance := false
var current_choices: Array = []
var current_inset := 0.0
var _unsubscribe_pointer := Callable()
var _unsubscribe_key := Callable()
var _destroyed := false


func _init(next_renderer: RuntimeRenderer, events: RuntimeEventBus, next_strings: RuntimeStringsProvider, assets: RuntimeAssetManager, input: RuntimeInputManager) -> void:
	renderer = next_renderer; event_bus = events; strings = next_strings; asset_manager = assets; input_manager = input
	event_bus.on("dialogue:line", Callable(self, "_show_line")); event_bus.on("dialogue:choices", Callable(self, "_show_choices")); event_bus.on("dialogue:willEnd", Callable(self, "_on_will_end")); event_bus.on("dialogue:end", Callable(self, "_on_dialogue_end")); event_bus.on("dialogue:prepareBeat", Callable(self, "_on_prepare_beat")); event_bus.on("dialogue:hidePanel", Callable(self, "_on_hide_panel"))


func is_open() -> bool: return root != null
func get_visible_text() -> String: return body.text if body != null else ""
func get_choice_button_count() -> int: return choices_box.get_child_count() if choices_box != null else 0


func update(dt: float) -> void:
	if root == null: return
	if continue_arrow != null:
		continue_arrow.visible = waiting_for_advance and not waiting_for_choice
		if continue_arrow.visible: continue_arrow.modulate.a = 0.4 + 0.6 * (0.5 + 0.5 * sin(Time.get_ticks_msec() / 250.0))
	if showing_full_text or waiting_for_advance or waiting_for_choice: return
	typewriter_time += dt
	displayed_chars = mini(full_text.length(), int(floor(typewriter_time * TYPEWRITER_SPEED)))
	body.text = full_text.left(displayed_chars)
	if displayed_chars >= full_text.length(): showing_full_text = true; waiting_for_advance = true


func debug_advance() -> void: _handle_advance()
func debug_complete_text() -> void:
	if root != null and not waiting_for_choice and not showing_full_text: _handle_advance()
func debug_select_choice(display_index: int) -> void:
	if display_index >= 0 and display_index < current_choices.size(): _select_choice(current_choices[display_index])


func hide() -> void:
	_clear_choices()
	if not _unsubscribe_pointer.is_null() and _unsubscribe_pointer.is_valid(): _unsubscribe_pointer.call()
	if not _unsubscribe_key.is_null() and _unsubscribe_key.is_valid(): _unsubscribe_key.call()
	_unsubscribe_pointer = Callable(); _unsubscribe_key = Callable()
	if root != null and is_instance_valid(root):
		if root.get_parent() != null: root.get_parent().remove_child(root)
		root.free()
	root = null; body = null; speaker = null; speaker_plate = null; continue_arrow = null; portrait = null; scene_dim = null; current_inset = 0.0
	full_text = ""; displayed_chars = 0; typewriter_time = 0.0; showing_full_text = false; waiting_for_advance = false; waiting_for_choice = false; will_end_after_advance = false


func destroy() -> void:
	if _destroyed: return
	_destroyed = true; hide()
	event_bus.off("dialogue:line", Callable(self, "_show_line")); event_bus.off("dialogue:choices", Callable(self, "_show_choices")); event_bus.off("dialogue:willEnd", Callable(self, "_on_will_end")); event_bus.off("dialogue:end", Callable(self, "_on_dialogue_end")); event_bus.off("dialogue:prepareBeat", Callable(self, "_on_prepare_beat")); event_bus.off("dialogue:hidePanel", Callable(self, "_on_hide_panel"))


func _ensure_root() -> void:
	if root != null: return
	root = Control.new(); root.name = "DialogueUI"; root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); root.mouse_filter = Control.MOUSE_FILTER_PASS
	var width := renderer.screen_width; var height := renderer.screen_height; var box_width := width - BOX_MARGIN * 2.0; var box_y := height - BOX_HEIGHT - BOX_MARGIN
	scene_dim = ColorRect.new(); scene_dim.position = Vector2.ZERO; scene_dim.size = Vector2(width, height); scene_dim.color = Color(0, 0, 0, 0.25); scene_dim.mouse_filter = Control.MOUSE_FILTER_IGNORE; scene_dim.visible = false; root.add_child(scene_dim)
	var panel := Panel.new(); panel.position = Vector2(BOX_MARGIN, box_y); panel.size = Vector2(box_width, BOX_HEIGHT); panel.mouse_filter = Control.MOUSE_FILTER_IGNORE; panel.add_theme_stylebox_override("panel", _panel_style(Color("130f0a", 0.92), Color("6b5a3e"), 1.5, 4)); root.add_child(panel)
	portrait = TextureRect.new(); portrait.position = Vector2(BOX_MARGIN, height - PORTRAIT_SIZE + 4.0); portrait.size = Vector2(PORTRAIT_SIZE, PORTRAIT_SIZE); portrait.expand_mode = TextureRect.EXPAND_IGNORE_SIZE; portrait.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED; portrait.mouse_filter = Control.MOUSE_FILTER_IGNORE; portrait.visible = false; root.add_child(portrait)
	speaker_plate = Panel.new(); speaker_plate.mouse_filter = Control.MOUSE_FILTER_IGNORE; speaker_plate.visible = false; speaker_plate.add_theme_stylebox_override("panel", _panel_style(Color("201811", 0.95), Color("6b5a3e"), 1.5, 4)); root.add_child(speaker_plate)
	speaker = Label.new(); speaker.add_theme_font_size_override("font_size", 15); speaker.add_theme_color_override("font_color", Color("ffcc88")); var bold_font := SystemFont.new(); bold_font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"]); bold_font.font_weight = 700; speaker.add_theme_font_override("font", bold_font); speaker.mouse_filter = Control.MOUSE_FILTER_IGNORE; speaker.visible = false; root.add_child(speaker)
	body = Label.new(); body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; body.clip_text = true; body.add_theme_font_size_override("font_size", 15); body.add_theme_color_override("font_color", Color("dddddd")); body.add_theme_constant_override("line_spacing", 7); var body_font := SystemFont.new(); body_font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"]); body.add_theme_font_override("font", body_font); body.mouse_filter = Control.MOUSE_FILTER_IGNORE; root.add_child(body)
	continue_arrow = Polygon2D.new(); continue_arrow.polygon = PackedVector2Array([Vector2(0, 0), Vector2(15, 0), Vector2(7.5, 10)]); continue_arrow.color = Color("ffcc66"); continue_arrow.position = Vector2(BOX_MARGIN + box_width - 34, box_y + BOX_HEIGHT - 26); continue_arrow.visible = false; root.add_child(continue_arrow)
	_layout_speaker(); _relayout_text()
	renderer.ui_layer.add_child(root)
	_unsubscribe_pointer = input_manager.subscribe_pointer_down(Callable(self, "_handle_advance")); _unsubscribe_key = input_manager.subscribe_key_down(Callable(self, "_on_key_down"))


func _show_line(payload: Variant) -> void:
	if not payload is Dictionary: return
	_ensure_root(); _clear_choices(); will_end_after_advance = false
	speaker.text = str(payload.get("speaker", "")); full_text = str(payload.get("text", "")); body.text = ""; displayed_chars = 0; typewriter_time = 0.0; showing_full_text = full_text.is_empty(); waiting_for_advance = full_text.is_empty(); waiting_for_choice = false; scene_dim.visible = payload.get("dim") == true
	current_inset = 0.0; var ref: Variant = payload.get("portrait")
	if ref is Dictionary and not str(ref.get("slug", "")).is_empty() and not str(ref.get("emotion", "")).is_empty():
		var path := "/resources/runtime/images/dialogue_portraits/%s/%s_%s.png" % [ref.slug, ref.slug, ref.emotion]; var resolved_path := RuntimeResourceLocator.get_default().resolve_url(path, RuntimeResourceLocator.MEDIA); var texture: Variant = asset_manager.load_texture(path) if FileAccess.file_exists(resolved_path) else null
		if texture is Texture2D: portrait.texture = texture; portrait.visible = true; current_inset = PORTRAIT_INSET
		else: portrait.visible = false
	else: portrait.visible = false
	_layout_speaker(); _relayout_text()


func _show_choices(payload: Variant) -> void:
	if not payload is Array: return
	_ensure_root(); _clear_choices(); waiting_for_choice = true; waiting_for_advance = false; current_choices = payload.duplicate(true)
	var box_width := renderer.screen_width - BOX_MARGIN * 2.0; var row_width := box_width - current_inset; var box_y := renderer.screen_height - BOX_HEIGHT - BOX_MARGIN
	choices_box = Control.new(); choices_box.name = "DialogueChoices"; choices_box.position = Vector2(BOX_MARGIN + current_inset, box_y - payload.size() * 36.0 - 10.0); choices_box.size = Vector2(row_width, payload.size() * 36.0); root.add_child(choices_box)
	for display_index: int in range(current_choices.size()):
		var choice_value: Variant = current_choices[display_index]
		if not choice_value is Dictionary: continue
		var choice: Dictionary = choice_value
		var row := Control.new(); row.position = Vector2(0, display_index * 36.0); row.size = Vector2(row_width, 32.0); choices_box.add_child(row)
		var enabled: bool = choice.get("enabled") == true; var rule_hint: bool = not str(choice.get("ruleHintId", "")).is_empty()
		var background := Panel.new(); background.position = Vector2.ZERO; background.size = row.size; background.mouse_filter = Control.MOUSE_FILTER_IGNORE; background.add_theme_stylebox_override("panel", _panel_style(Color("1c160e", 0.9), Color("6b5636") if enabled else Color("342a1c"), 1.0, 3)); row.add_child(background)
		var prefix := "%s. " % (int(choice.get("index", display_index)) + 1)
		if rule_hint:
			var rule_tag := strings.get_text("dialogue", "ruleTag"); prefix = "%s %s. " % [rule_tag if rule_tag != "ruleTag" else "〔规则〕", int(choice.get("index", display_index)) + 1]
		var label := Label.new(); label.position = Vector2(14, 7); label.size = Vector2(row_width - 40.0, 24.0); label.text = prefix + str(choice.get("text", "")); label.clip_text = true; label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; label.add_theme_font_size_override("font_size", 14); label.add_theme_color_override("font_color", Color("ffaa44") if rule_hint and enabled else (Color("886633") if rule_hint else (Color("dddddd") if enabled else Color("666666")))); var label_font := SystemFont.new(); label_font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"]); label.add_theme_font_override("font", label_font); label.mouse_filter = Control.MOUSE_FILTER_IGNORE; row.add_child(label)
		var button := Button.new(); button.position = Vector2.ZERO; button.size = row.size; button.flat = true; button.text = ""; button.disabled = not enabled; button.tooltip_text = str(choice.get("disableHint", "")); button.pressed.connect(Callable(self, "_select_choice").bind(choice)); row.add_child(button)


func _clear_choices() -> void:
	if choices_box != null and is_instance_valid(choices_box):
		var old_choices := choices_box
		if old_choices.get_parent() != null: old_choices.get_parent().remove_child(old_choices)
		old_choices.queue_free()
	choices_box = null; current_choices.clear(); waiting_for_choice = false


func _select_choice(choice: Dictionary) -> void:
	if not waiting_for_choice: return
	if choice.get("enabled") != true:
		var hint := str(choice.get("disableHint", "")); if not hint.is_empty(): event_bus.emit("notification:show", {"text": hint, "type": "warning"})
		return
	waiting_for_choice = false; event_bus.emit("dialogue:choiceSelected", {"index": int(choice.get("index", -1))})


func _on_key_down(record: Dictionary) -> void:
	if record.get("repeat") == true: return
	var code := str(record.get("code", ""))
	if waiting_for_choice and code.begins_with("Digit"):
		var index := int(code.trim_prefix("Digit")) - 1; debug_select_choice(index); return
	if code in ["Space", "Enter", "NumpadEnter"]: _handle_advance()


func _handle_advance() -> void:
	if root == null or waiting_for_choice: return
	if not showing_full_text: displayed_chars = full_text.length(); body.text = full_text; showing_full_text = true; waiting_for_advance = true; event_bus.emit("dialogue:advanceInput", {}); return
	if waiting_for_advance:
		waiting_for_advance = false; event_bus.emit("dialogue:advanceInput", {})
		if will_end_after_advance: will_end_after_advance = false; event_bus.emit("dialogue:advanceEnd", {})
		else: event_bus.emit("dialogue:advance", {})


func _on_will_end(_payload: Variant = null) -> void: will_end_after_advance = true
func _on_dialogue_end(_payload: Variant = null) -> void: hide()
func _on_hide_panel(_payload: Variant = null) -> void: hide()
func _on_prepare_beat(_payload: Variant = null) -> void:
	if root == null: return
	_clear_choices(); speaker.text = ""; _layout_speaker(); body.text = ""; full_text = ""; displayed_chars = 0; typewriter_time = 0.0; showing_full_text = false; waiting_for_advance = false; portrait.visible = false


func _layout_speaker() -> void:
	if speaker == null or speaker_plate == null: return
	if speaker.text.is_empty(): speaker.visible = false; speaker_plate.visible = false; return
	var box_y := renderer.screen_height - BOX_HEIGHT - BOX_MARGIN
	var plate_x := BOX_MARGIN + 12.0 + current_inset; var plate_y := box_y + 8.0
	var max_width := renderer.screen_width - BOX_MARGIN * 2.0 - 24.0 - current_inset
	var plate_width := minf(speaker.get_minimum_size().x + 24.0, max_width)
	speaker_plate.position = Vector2(plate_x, plate_y); speaker_plate.size = Vector2(plate_width, 26.0); speaker_plate.visible = true
	speaker.position = Vector2(plate_x + 12.0, plate_y + 5.0); speaker.size = Vector2(maxf(0.0, plate_width - 24.0), 21.0); speaker.visible = true


func _relayout_text() -> void:
	if body == null: return
	var box_width := renderer.screen_width - BOX_MARGIN * 2.0; var box_y := renderer.screen_height - BOX_HEIGHT - BOX_MARGIN
	var left := BOX_MARGIN + 20.0 + current_inset; var wrap_width := maxf(80.0, box_width - 40.0 - current_inset)
	body.position = Vector2(left, box_y + 46.0); body.size = Vector2(wrap_width, BOX_HEIGHT - 58.0)


func _panel_style(background: Color, border: Color, border_width: float, radius: int) -> StyleBoxFlat:
	var style := StyleBoxFlat.new(); style.bg_color = background; style.border_color = border
	style.set_border_width_all(int(round(border_width))); style.set_corner_radius_all(radius); style.anti_aliasing = true
	return style
