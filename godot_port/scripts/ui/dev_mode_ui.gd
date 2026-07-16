class_name RuntimeDevModeUI
extends RefCounted

const CATEGORY_WIDTH := 178.0
const HEADER_HEIGHT := 48.0
const ITEM_HEIGHT := 36.0
const SCROLL_SPEED := 30.0
const TAB_H := 40.0
const SECTIONS := ["cutscene", "scene", "minigames", "narrative"]

const COLOR_PANEL_BG := Color("17120d")
const COLOR_PANEL_BG_ALT := Color("201811")
const COLOR_PANEL_BORDER := Color("4a3a24")
const COLOR_FRAME := Color("6b5a3e")
const COLOR_ROW_BG := Color("241d13")
const COLOR_ROW_HOVER := Color("342713")
const COLOR_BORDER_MID := Color("3a2e1e")
const COLOR_BORDER_ACTIVE := Color("6b5636")
const COLOR_TITLE := Color("ffcc88")
const COLOR_BODY := Color("dddddd")
const COLOR_SUBTLE := Color("aaaacc")
const COLOR_HINT := Color("555566")
const COLOR_BUTTON_TEXT := Color("ccccdd")

var renderer: RuntimeRenderer
var callbacks: Dictionary
var container: Control
var _is_open := false
var scroll_y := 0.0
var max_scroll_y := 0.0
var content_mask: Control
var content_container: Control
var bound_wheel := Callable()
var section := "cutscene"


func _init(next_renderer: RuntimeRenderer, next_callbacks: Dictionary) -> void:
	renderer = next_renderer
	callbacks = next_callbacks
	container = Control.new()
	container.name = "DevModeUI"
	container.visible = false
	container.mouse_filter = Control.MOUSE_FILTER_STOP
	renderer.ui_layer.add_child(container)


func is_open() -> bool:
	return _is_open


func open() -> void:
	if _is_open:
		return
	_is_open = true
	scroll_y = 0.0
	section = "cutscene"
	rebuild()
	container.visible = true
	bound_wheel = Callable(self, "on_wheel")
	container.gui_input.connect(bound_wheel)


func close() -> void:
	if not _is_open:
		return
	_is_open = false
	container.visible = false
	clear_children()
	if bound_wheel.is_valid() and container.gui_input.is_connected(bound_wheel):
		container.gui_input.disconnect(bound_wheel)
	bound_wheel = Callable()


func destroy() -> void:
	close()
	if container != null and is_instance_valid(container):
		if container.get_parent() != null:
			container.get_parent().remove_child(container)
		container.free()
	container = null
	content_mask = null
	content_container = null


func clear_children() -> void:
	content_mask = null
	content_container = null
	for child: Node in container.get_children():
		container.remove_child(child)
		child.free()


func rebuild() -> void:
	clear_children()
	var sw := renderer.screen_width
	var sh := renderer.screen_height
	container.size = Vector2(sw, sh)
	var pad := 40.0
	var panel_w := minf(sw - pad * 2.0, 800.0)
	var panel_h := minf(sh - pad * 2.0, 660.0)
	var panel_x := (sw - panel_w) / 2.0
	var panel_y := (sh - panel_h) / 2.0

	var overlay := ColorRect.new()
	overlay.name = "Overlay"
	overlay.position = Vector2.ZERO
	overlay.size = Vector2(sw, sh)
	overlay.color = Color(0.0, 0.0, 0.0, 0.6)
	overlay.mouse_filter = Control.MOUSE_FILTER_STOP
	container.add_child(overlay)

	var panel := Panel.new()
	panel.name = "Panel"
	panel.position = Vector2(panel_x, panel_y)
	panel.size = Vector2(panel_w, panel_h)
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_theme_stylebox_override("panel", _style_box(COLOR_PANEL_BG, 0.95, COLOR_FRAME, 1.5, 4.0))
	container.add_child(panel)

	var title := Label.new()
	title.name = "Title"
	title.text = "Dev Mode"
	title.position = Vector2(panel_x + 16.0, panel_y)
	title.size = Vector2(panel_w - 132.0, HEADER_HEIGHT)
	title.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	title.add_theme_font_size_override("font_size", 20)
	title.add_theme_color_override("font_color", COLOR_TITLE)
	container.add_child(title)

	var refresh_button := make_button(
		"Reload", panel_x + panel_w - 100.0, panel_y + 8.0, 84.0, 32.0,
		Callable(self, "_invoke").bind("reload")
	)
	refresh_button.name = "ReloadButton"
	container.add_child(refresh_button)

	var divider := ColorRect.new()
	divider.name = "HeaderDivider"
	divider.position = Vector2(panel_x, panel_y + HEADER_HEIGHT)
	divider.size = Vector2(panel_w, 1.0)
	divider.color = COLOR_PANEL_BORDER
	divider.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(divider)

	var body_y := panel_y + HEADER_HEIGHT + 1.0
	var body_h := panel_h - HEADER_HEIGHT - 1.0

	var category_background := ColorRect.new()
	category_background.name = "CategoryBackground"
	category_background.position = Vector2(panel_x, body_y)
	category_background.size = Vector2(CATEGORY_WIDTH, body_h)
	category_background.color = Color(COLOR_PANEL_BG_ALT, 0.8)
	category_background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(category_background)

	var tab_y_0 := body_y + 8.0
	container.add_child(make_section_tab(
		"Cutscene", panel_x, tab_y_0, section == "cutscene",
		Callable(self, "_select_section_from_ui").bind("cutscene")
	))
	container.add_child(make_section_tab(
		"场景", panel_x, tab_y_0 + TAB_H + 4.0, section == "scene",
		Callable(self, "_select_section_from_ui").bind("scene")
	))
	container.add_child(make_section_tab(
		"Minigames", panel_x, tab_y_0 + (TAB_H + 4.0) * 2.0, section == "minigames",
		Callable(self, "_select_section_from_ui").bind("minigames")
	))
	container.add_child(make_section_tab(
		"叙事", panel_x, tab_y_0 + (TAB_H + 4.0) * 3.0, section == "narrative",
		Callable(self, "_select_section_from_ui").bind("narrative")
	))

	var category_divider := ColorRect.new()
	category_divider.name = "CategoryDivider"
	category_divider.position = Vector2(panel_x + CATEGORY_WIDTH, body_y)
	category_divider.size = Vector2(1.0, body_h)
	category_divider.color = COLOR_PANEL_BORDER
	category_divider.mouse_filter = Control.MOUSE_FILTER_IGNORE
	container.add_child(category_divider)

	var content_x := panel_x + CATEGORY_WIDTH + 1.0
	var content_w := panel_w - CATEGORY_WIDTH - 1.0
	if section == "cutscene":
		build_cutscene_list(content_x, body_y, content_w, body_h)
	elif section == "scene":
		build_scene_list(content_x, body_y, content_w, body_h)
	elif section == "narrative":
		build_narrative_list(content_x, body_y, content_w, body_h)
	else:
		build_minigame_list(content_x, body_y, content_w, body_h)


func build_cutscene_list(x: float, y: float, width: float, height: float) -> void:
	var ids: Variant = _invoke("getCutsceneIds")
	_create_content_viewport(x, y, width, height)
	var pad := 8.0
	var cy := 0.0

	if not ids is Array or ids.is_empty():
		content_container.add_child(_make_hint_label("No cutscenes defined.", Vector2(pad, pad), width - pad * 2.0))
		max_scroll_y = 0.0
		return

	for id: Variant in ids:
		var row := make_list_item(
			str(id), pad, cy, width - pad * 2.0, ITEM_HEIGHT,
			Callable(self, "_invoke").bind("playCutscene", str(id))
		)
		content_container.add_child(row)
		cy += ITEM_HEIGHT + 2.0

	var total_h := cy
	max_scroll_y = maxf(0.0, total_h - height)
	apply_scroll()


func build_minigame_list(x: float, y: float, width: float, height: float) -> void:
	var entries: Variant = _invoke("getMinigameEntries")
	_create_content_viewport(x, y, width, height)
	var pad := 8.0
	var cy := 0.0

	if not entries is Array or entries.is_empty():
		content_container.add_child(_make_hint_label("未加载 water_minigames/index.json 或无条目。", Vector2(pad, pad), width - pad * 2.0))
		max_scroll_y = 0.0
		return

	for entry: Variant in entries:
		if not entry is Dictionary:
			continue
		var prefix := "[转盘] " if entry.get("kind") == "sugarWheel" else "[水域] "
		var row := make_list_item(
			prefix + str(entry.get("label", "")), pad, cy, width - pad * 2.0, ITEM_HEIGHT,
			Callable(self, "_invoke").bind("launchMinigame", entry)
		)
		content_container.add_child(row)
		cy += ITEM_HEIGHT + 2.0

	var total_h := cy
	max_scroll_y = maxf(0.0, total_h - height)
	apply_scroll()


func build_narrative_list(x: float, y: float, width: float, height: float) -> void:
	var entries: Variant = _invoke("getNarrativeWarps")
	_create_content_viewport(x, y, width, height)
	var pad := 8.0
	var cy := 0.0

	if not entries is Array or entries.is_empty():
		content_container.add_child(_make_hint_label("无叙事编排（缺 data/dev_narrative_warps.json）。", Vector2(pad, pad), width - pad * 2.0))
		max_scroll_y = 0.0
		return

	for entry: Variant in entries:
		if not entry is Dictionary:
			continue
		var row := make_list_item(
			str(entry.get("label", "")), pad, cy, width - pad * 2.0, ITEM_HEIGHT,
			Callable(self, "_invoke").bind("enterNarrativeWarp", str(entry.get("id", "")))
		)
		content_container.add_child(row)
		cy += ITEM_HEIGHT + 2.0

	var total_h := cy
	max_scroll_y = maxf(0.0, total_h - height)
	apply_scroll()


func build_scene_list(x: float, y: float, width: float, height: float) -> void:
	_create_content_viewport(x, y, width, height)
	var pad := 8.0
	content_container.add_child(_make_hint_label("加载场景列表…", Vector2(pad, pad), width - pad * 2.0))
	max_scroll_y = 0.0

	var entries: Variant = _invoke("getScenes")
	Callable(self, "_complete_scene_list").call_deferred(entries, width, height, pad)


func make_list_item(text: String, x: float, y: float, width: float, height: float, on_click: Callable) -> Control:
	var item := Control.new()
	item.position = Vector2(x, y)
	item.size = Vector2(width, height)
	item.mouse_filter = Control.MOUSE_FILTER_PASS

	var background := Panel.new()
	background.name = "Background"
	background.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	background.add_theme_stylebox_override("panel", _style_box(COLOR_ROW_BG, 0.6, Color.TRANSPARENT, 0.0, 4.0))
	item.add_child(background)

	var label := Label.new()
	label.name = "Label"
	label.text = text
	label.position = Vector2(12.0, 0.0)
	label.size = Vector2(maxf(0.0, width - 54.0), height)
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	label.add_theme_font_size_override("font_size", 14)
	label.add_theme_color_override("font_color", COLOR_BODY)
	item.add_child(label)

	var play_icon := Label.new()
	play_icon.name = "PlayIcon"
	play_icon.text = ">>"
	play_icon.position = Vector2(width - 38.0, 0.0)
	play_icon.size = Vector2(26.0, height)
	play_icon.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT
	play_icon.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	play_icon.mouse_filter = Control.MOUSE_FILTER_IGNORE
	play_icon.add_theme_font_size_override("font_size", 12)
	play_icon.add_theme_color_override("font_color", COLOR_SUBTLE)
	item.add_child(play_icon)

	var hit_area := Button.new()
	hit_area.name = "HitArea"
	hit_area.flat = true
	hit_area.focus_mode = Control.FOCUS_NONE
	hit_area.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	hit_area.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	hit_area.mouse_entered.connect(Callable(self, "_set_list_item_hovered").bind(background, true))
	hit_area.mouse_exited.connect(Callable(self, "_set_list_item_hovered").bind(background, false))
	if on_click.is_valid():
		hit_area.pressed.connect(on_click)
	item.add_child(hit_area)
	return item


func make_button(text: String, x: float, y: float, width: float, height: float, on_click: Callable) -> Button:
	var button := Button.new()
	button.text = text
	button.position = Vector2(x, y)
	button.size = Vector2(width, height)
	button.focus_mode = Control.FOCUS_NONE
	button.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	button.add_theme_font_size_override("font_size", 13)
	button.add_theme_color_override("font_color", COLOR_BUTTON_TEXT)
	button.add_theme_stylebox_override("normal", _style_box(COLOR_BORDER_MID, 0.8, Color.TRANSPARENT, 0.0, 4.0))
	button.add_theme_stylebox_override("hover", _style_box(COLOR_BORDER_ACTIVE, 0.9, Color.TRANSPARENT, 0.0, 4.0))
	button.add_theme_stylebox_override("pressed", _style_box(COLOR_BORDER_ACTIVE, 0.9, Color.TRANSPARENT, 0.0, 4.0))
	if on_click.is_valid():
		button.pressed.connect(on_click)
	return button


func make_section_tab(text: String, panel_x: float, body_y: float, active: bool, on_select: Callable) -> Button:
	var tab := Button.new()
	tab.text = text
	tab.position = Vector2(panel_x, body_y)
	tab.size = Vector2(CATEGORY_WIDTH, TAB_H)
	tab.alignment = HORIZONTAL_ALIGNMENT_LEFT
	tab.add_theme_constant_override("outline_size", 0)
	tab.add_theme_constant_override("h_separation", 16)
	tab.add_theme_font_size_override("font_size", 14)
	tab.add_theme_color_override("font_color", COLOR_TITLE if active else COLOR_SUBTLE)
	tab.add_theme_color_override("font_disabled_color", COLOR_TITLE)
	tab.add_theme_stylebox_override("normal", _style_box(COLOR_PANEL_BG_ALT, 0.5, Color.TRANSPARENT, 0.0, 0.0))
	tab.add_theme_stylebox_override("hover", _style_box(COLOR_ROW_HOVER, 0.35, Color.TRANSPARENT, 0.0, 0.0))
	tab.add_theme_stylebox_override("pressed", _style_box(COLOR_ROW_HOVER, 0.35, Color.TRANSPARENT, 0.0, 0.0))
	tab.add_theme_stylebox_override("disabled", _style_box(COLOR_PANEL_BG, 1.0, Color.TRANSPARENT, 0.0, 0.0))
	tab.disabled = active
	if not active and on_select.is_valid():
		tab.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
		tab.pressed.connect(on_select)
	return tab


func on_wheel(event: InputEvent) -> void:
	if not _is_open or content_container == null:
		return
	if not event is InputEventMouseButton or not event.pressed:
		return
	if event.button_index != MOUSE_BUTTON_WHEEL_UP and event.button_index != MOUSE_BUTTON_WHEEL_DOWN:
		return
	scroll_y = clampf(
		scroll_y + (SCROLL_SPEED if event.button_index == MOUSE_BUTTON_WHEEL_DOWN else -SCROLL_SPEED),
		0.0,
		max_scroll_y
	)
	apply_scroll()
	container.accept_event()


func apply_scroll() -> void:
	if content_container == null:
		return
	content_container.position.y = -scroll_y


# Godot-only test adapter. It drives the same UI section transition but owns no
# gameplay/domain state; list data remains owned by the injected callbacks.
func select_section(id: String) -> bool:
	if not SECTIONS.has(id):
		return false
	section = id
	if is_open():
		rebuild()
	return true


# Godot-only test adapter. It resolves the current callback result on demand;
# unlike the removed TextPanel shell it does not retain a second entries model.
func debug_select(index: int) -> bool:
	var values := _entries_for_section(section)
	if index < 0 or index >= values.size():
		return false
	var entry: Variant = values[index]
	match section:
		"cutscene":
			_invoke("playCutscene", str(entry))
		"scene":
			_invoke("loadScene", str(entry.get("id", "")) if entry is Dictionary else str(entry))
		"minigames":
			_invoke("launchMinigame", entry)
		"narrative":
			_invoke("enterNarrativeWarp", str(entry.get("id", "")) if entry is Dictionary else str(entry))
	return true


func _create_content_viewport(x: float, y: float, width: float, height: float) -> void:
	content_mask = Control.new()
	content_mask.name = "ContentMask"
	content_mask.position = Vector2(x, y)
	content_mask.size = Vector2(width, height)
	content_mask.clip_contents = true
	content_mask.mouse_filter = Control.MOUSE_FILTER_PASS
	container.add_child(content_mask)

	content_container = Control.new()
	content_container.name = "ContentContainer"
	content_container.size = Vector2(width, height)
	content_container.mouse_filter = Control.MOUSE_FILTER_PASS
	content_mask.add_child(content_container)


func _complete_scene_list(entries: Variant, width: float, height: float, pad: float) -> void:
	if not _is_open or section != "scene" or content_container == null:
		return
	for child: Node in content_container.get_children():
		content_container.remove_child(child)
		child.free()
	var cy := 0.0

	if not entries is Array or entries.is_empty():
		content_container.add_child(_make_hint_label("No scenes in list (check map_config / game_config).", Vector2(pad, pad), width - pad * 2.0))
		max_scroll_y = 0.0
		return

	for entry: Variant in entries:
		if not entry is Dictionary:
			continue
		var row := make_list_item(
			str(entry.get("name", "")), pad, cy, width - pad * 2.0, ITEM_HEIGHT,
			Callable(self, "_invoke").bind("loadScene", str(entry.get("id", "")))
		)
		content_container.add_child(row)
		cy += ITEM_HEIGHT + 2.0

	var total_h := cy
	max_scroll_y = maxf(0.0, total_h - height)
	apply_scroll()


func _select_section_from_ui(id: String) -> void:
	section = id
	rebuild()


func _entries_for_section(id: String) -> Array:
	var callback_key: String = {
		"cutscene": "getCutsceneIds",
		"scene": "getScenes",
		"minigames": "getMinigameEntries",
		"narrative": "getNarrativeWarps",
	}.get(id, "")
	var value: Variant = _invoke(callback_key)
	return value if value is Array else []


func _invoke(key: String, argument: Variant = null) -> Variant:
	var callback: Variant = callbacks.get(key)
	if not callback is Callable or callback.is_null() or not callback.is_valid():
		return null
	return callback.call() if argument == null else callback.call(argument)


func _make_hint_label(text: String, position: Vector2, width: float) -> Label:
	var label := Label.new()
	label.text = text
	label.position = position
	label.size = Vector2(width, 24.0)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	label.add_theme_font_size_override("font_size", 14)
	label.add_theme_color_override("font_color", COLOR_HINT)
	return label


func _set_list_item_hovered(background: Panel, hovered: bool) -> void:
	if background == null or not is_instance_valid(background):
		return
	background.add_theme_stylebox_override(
		"panel",
		_style_box(COLOR_ROW_HOVER if hovered else COLOR_ROW_BG, 0.9 if hovered else 0.6, Color.TRANSPARENT, 0.0, 4.0)
	)


func _style_box(fill: Color, fill_alpha: float, border: Color, border_width: float, radius: float) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color(fill, fill_alpha)
	style.border_color = border
	style.set_border_width_all(int(round(border_width)))
	style.set_corner_radius_all(int(round(radius)))
	return style
