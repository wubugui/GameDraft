class_name RuntimeActionChoiceUI
extends RefCounted

signal choice_progress
var renderer: RuntimeRenderer
var strings: RuntimeStringsProvider
var input: RuntimeInputManager
var root: Control
var _result: Variant = null
var _waiting := false
var _allow_cancel := false
var _count := 0
var _unsubscribe := Callable()

func _init(next_renderer: RuntimeRenderer, next_strings: RuntimeStringsProvider, next_input: RuntimeInputManager) -> void: renderer = next_renderer; strings = next_strings; input = next_input
func is_open() -> bool: return root != null
func choose(prompt: String, options: Array, allow_cancel: bool) -> Variant:
	close(null); var clean: Array[String] = []
	for option: Variant in options:
		var text := str(option.get("text", "")).strip_edges() if option is Dictionary else ""; if not text.is_empty(): clean.push_back(text)
	if clean.is_empty(): return null
	_waiting = true; _result = null; _allow_cancel = allow_cancel; _count = clean.size(); _build(prompt, clean); _unsubscribe = input.subscribe_key_down(Callable(self, "_on_key"))
	while _waiting: await choice_progress
	await Engine.get_main_loop().process_frame
	return _result
func debug_select(index: int) -> void: if index >= 0 and index < _count: close(index)
func close(result: Variant = null) -> void:
	if _unsubscribe.is_valid(): _unsubscribe.call()
	_unsubscribe = Callable(); _result = result; var was_waiting := _waiting; _waiting = false
	if root != null and is_instance_valid(root): root.free()
	root = null
	if was_waiting: choice_progress.emit()
func destroy() -> void: close(null)
func _build(prompt: String, options: Array[String]) -> void:
	root = Control.new(); root.name = "ActionChoiceUI"; root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); root.mouse_filter = Control.MOUSE_FILTER_STOP; var box := VBoxContainer.new(); box.position = Vector2(24, renderer.get_screen_height() - 90 - options.size() * 42); box.size = Vector2(renderer.get_screen_width() - 48, 70 + options.size() * 42); root.add_child(box)
	if not prompt.strip_edges().is_empty(): var title := Label.new(); title.text = prompt; title.add_theme_font_size_override("font_size", 16); box.add_child(title)
	for index in options.size(): var button := Button.new(); button.text = "%s. %s" % [index + 1, options[index]]; button.custom_minimum_size.y = 36; button.pressed.connect(Callable(self, "debug_select").bind(index)); box.add_child(button)
	if _allow_cancel: var hint := Label.new(); hint.text = strings.get_text("actionChoice", "cancelHint"); box.add_child(hint)
	renderer.ui_layer.add_child(root)
func _on_key(record: Dictionary) -> void:
	var code := str(record.get("code", "")); if code == "Escape" and _allow_cancel: close(null); return
	if code.begins_with("Digit"): debug_select(int(code.trim_prefix("Digit")) - 1)
	elif code.begins_with("Numpad"): debug_select(int(code.trim_prefix("Numpad")) - 1)
