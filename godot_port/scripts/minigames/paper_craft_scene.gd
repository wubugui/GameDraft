class_name RuntimePaperCraftMinigameScene
extends RefCounted

const DEFAULT_PART_IMAGE_ROOT := "/resources/runtime/images/minigames/paper_craft/parts/"
const PIXI_COMPOSITE_SHADER := preload("res://scripts/rendering/pixi_half_pixel_composite.gdshader")

class PartButton:
	extends Button
	var part_id := ""
	var preview_texture: Texture2D

	func _get_drag_data(_position: Vector2) -> Variant:
		var preview := TextureRect.new(); preview.texture = preview_texture; preview.expand_mode = TextureRect.EXPAND_IGNORE_SIZE; preview.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED; preview.custom_minimum_size = Vector2(72, 72); preview.mouse_filter = Control.MOUSE_FILTER_IGNORE; set_drag_preview(preview)
		return {"paperPartId": part_id}


class SlotButton:
	extends Button
	var slot_id := ""
	var drop_callback := Callable()

	func _can_drop_data(_position: Vector2, data: Variant) -> bool:
		return data is Dictionary and data.get("paperPartId") is String

	func _drop_data(_position: Vector2, data: Variant) -> void:
		if drop_callback.is_valid(): drop_callback.call(slot_id, str(data.paperPartId))


class ColorSwatch:
	extends Control
	var tint := Color.WHITE

	func _draw() -> void:
		draw_circle(Vector2(6, 6), 6.0, tint, true)


var renderer: RuntimeRenderer
var asset_manager: RuntimeAssetManager
var action_executor: RuntimeActionExecutor
var resolve_text: Callable
var on_result: Callable
var on_close: Callable
var root := Control.new()
var instance: Dictionary = {}
var order: Dictionary = {}
var order_index := 0
var selected_part_id := ""
var selected_paper_id := ""
var selected_finish_id := ""
var placed: Dictionary = {}
var part_textures: Dictionary = {}
var background_texture: Texture2D
var feedback_label: Label
var action_gate: RuntimeMinigameActionPlaybackGate
var closing := false
var destroyed := false
var finishing := false
var _unsubscribe_resize := Callable()


func _init(next_renderer: RuntimeRenderer, assets: RuntimeAssetManager, actions: RuntimeActionExecutor, text_resolver: Callable, result_callback: Callable, close_callback: Callable, restore_state: Callable) -> void:
	renderer = next_renderer; asset_manager = assets; action_executor = actions; resolve_text = text_resolver; on_result = result_callback; on_close = close_callback
	root.name = "PaperCraftMinigameScene"; root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); root.mouse_filter = Control.MOUSE_FILTER_STOP
	action_gate = RuntimeMinigameActionPlaybackGate.new(Callable(action_executor, "execute_batch_await"), {"onLockChanged": Callable(self, "_set_input_locked"), "restoreMinigameState": restore_state})
	_unsubscribe_resize = renderer.subscribe_after_resize(Callable(self, "_rebuild"))


func get_root() -> Control:
	return root


func is_actions_playback_locked() -> bool:
	return action_gate.is_locked()


func load(next_instance: Dictionary) -> bool:
	if not next_instance.get("orders") is Array or next_instance.orders.is_empty():
		return false
	for value: Variant in next_instance.orders:
		if not value is Dictionary or not value.get("paperOptions") is Array or value.paperOptions.is_empty() or not value.get("finishOptions") is Array or value.finishOptions.is_empty():
			return false
	instance = next_instance.duplicate(true)
	await _enter_order(0)
	return true


func update(_dt: float) -> void:
	# Pointer/callback driven; this scene owns no continuous simulation.
	return


func abort() -> void:
	if closing: return
	closing = true
	if on_close.is_valid(): on_close.call()


func destroy() -> void:
	if destroyed: return
	destroyed = true
	if not _unsubscribe_resize.is_null() and _unsubscribe_resize.is_valid(): _unsubscribe_resize.call()
	_unsubscribe_resize = Callable()
	if is_instance_valid(root): root.free()


func debug_select_part(id: String) -> bool:
	if _find_by_id(order.get("parts"), id) == null: return false
	selected_part_id = id; _rebuild(); return true


func debug_select_paper(id: String) -> bool:
	if _find_by_id(order.get("paperOptions"), id) == null: return false
	selected_paper_id = id; _rebuild(); return true


func debug_select_finish(id: String) -> bool:
	if _find_by_id(order.get("finishOptions"), id) == null: return false
	selected_finish_id = id; _rebuild(); return true


func debug_place(slot_id: String, part_id: String) -> bool:
	return _place_part(slot_id, part_id)


func debug_submit() -> bool:
	return await _finish()


func calculate_result() -> Dictionary:
	var tags: Array[String] = []
	var score := 0
	var paper: Variant = _find_by_id(order.get("paperOptions"), selected_paper_id)
	var finish: Variant = _find_by_id(order.get("finishOptions"), selected_finish_id)
	if paper is Dictionary:
		score += int(paper.get("score", 0))
		if not str(order.get("correctPaper", "")).is_empty(): score += 12 if selected_paper_id == str(order.correctPaper) else -6
		_add_tags(tags, paper.get("tags"))
	if finish is Dictionary:
		score += int(finish.get("score", 0)); _add_tags(tags, finish.get("tags"))
	var placed_result: Array[Dictionary] = []
	for slot_id: String in placed:
		var part: Variant = _find_by_id(order.get("parts"), str(placed[slot_id]))
		if part is Dictionary:
			score += int(part.get("score", 0)); _add_tags(tags, part.get("tags")); placed_result.push_back({"slotId": slot_id, "partId": str(part.id), "partLabel": str(part.get("label", ""))})
	var success := int(order.get("successScore", 76)); var warn := int(order.get("warnScore", 50))
	return {"instanceId": str(instance.get("id", "")), "instanceLabel": str(instance.get("label", "")), "orderId": str(order.get("id", "")), "orderTitle": str(order.get("title", "")), "score": score, "level": "success" if score >= success else ("warn" if score >= warn else "bad"), "paperId": selected_paper_id, "finishId": selected_finish_id, "tags": tags, "placed": placed_result}


func get_feedback_text() -> String:
	return feedback_label.text if feedback_label != null else ""


func get_debug_visual_state() -> Dictionary:
	var placed_state: Dictionary = {}
	for slot_id: String in placed: placed_state[slot_id] = str(placed[slot_id])
	return {
		"instanceId": str(instance.get("id", "")),
		"orderId": str(order.get("id", "")),
		"orderIndex": order_index,
		"selectedPartId": selected_part_id,
		"selectedPaperId": selected_paper_id,
		"selectedFinishId": selected_finish_id,
		"placed": placed_state,
		"feedbackText": get_feedback_text(),
		"actionsPlaybackLocked": is_actions_playback_locked(),
		"finishing": finishing,
	}


func _enter_order(index_value: int) -> void:
	order_index = index_value; order = instance.orders[index_value]; placed.clear(); selected_part_id = ""
	selected_paper_id = str(order.paperOptions[0].get("id", "")); selected_finish_id = str(order.finishOptions[0].get("id", ""))
	part_textures.clear(); background_texture = null
	var background_path := str(instance.get("backgroundImage", "")).strip_edges()
	if not background_path.is_empty():
		var loaded_background: Variant = asset_manager.load_texture(background_path)
		if loaded_background is Texture2D: background_texture = loaded_background
	for part_value: Variant in order.parts:
		if part_value is Dictionary:
			var image_path := str(part_value.get("image", DEFAULT_PART_IMAGE_ROOT + str(part_value.get("id", "")) + ".png"))
			var texture: Variant = asset_manager.load_texture(image_path)
			if texture is Texture2D: part_textures[str(part_value.get("id", ""))] = texture
	await Engine.get_main_loop().process_frame
	if not closing and not destroyed: _rebuild()


func _rebuild() -> void:
	if destroyed or order.is_empty() or not is_instance_valid(root): return
	for child: Node in root.get_children(): root.remove_child(child); child.free()
	var screen_w := renderer.get_screen_width(); var screen_h := renderer.get_screen_height(); root.position = Vector2.ZERO
	var shade := Panel.new(); shade.position = Vector2.ZERO; shade.size = Vector2(screen_w, screen_h); shade.mouse_filter = Control.MOUSE_FILTER_IGNORE; var shade_style := StyleBoxFlat.new(); shade_style.bg_color = Color("16110c", 0.94); shade_style.border_color = Color("3b2c1f"); shade_style.set_border_width_all(2); shade.add_theme_stylebox_override("panel", shade_style); root.add_child(shade)
	if background_texture != null:
		var background := TextureRect.new(); background.name = "PaperCraftBackground"; background.position = Vector2.ZERO; background.size = Vector2(screen_w, screen_h); background.texture = background_texture; background.expand_mode = TextureRect.EXPAND_IGNORE_SIZE; background.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_COVERED; background.modulate.a = 0.35; background.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR; background.mouse_filter = Control.MOUSE_FILTER_IGNORE; root.add_child(background)
	var rows := maxi(1, ceili(order.get("parts", []).size() / 2.0)); var palette_content_h := 46.0 + rows * 74.0 + 10.0
	var top_strip := 80.0; var bottom_strip := 46.0; var margin := 24.0; var gap := 24.0; var max_scale := 1.4; var region_h := maxf(160.0, screen_h - top_strip - bottom_strip); var inner_w := maxf(240.0, screen_w - margin * 2.0 - gap)
	var palette_region_w := minf(inner_w * 0.34, 250.0 * max_scale); var work_region_w := inner_w - palette_region_w; var work_scale := minf(minf(work_region_w / 560.0, region_h / 410.0), max_scale); var palette_scale := minf(minf(palette_region_w / 250.0, region_h / palette_content_h), max_scale)
	var work_w := 560.0 * work_scale; var work_h := 410.0 * work_scale; var palette_w := 250.0 * palette_scale; var palette_h := palette_content_h * palette_scale; var total_w := work_w + gap + palette_w; var start_x := maxf(margin, (screen_w - total_w) / 2.0); var mid_y := top_strip + region_h / 2.0
	var work := Control.new(); work.name = "WorkTable"; work.position = Vector2(start_x, mid_y - work_h / 2.0); work.size = Vector2(560, 410); work.scale = Vector2.ONE * work_scale; root.add_child(work)
	var panel := Panel.new(); panel.size = Vector2(560, 410); panel.mouse_filter = Control.MOUSE_FILTER_IGNORE; panel.add_theme_stylebox_override("panel", _panel_style("17120d", 0.95, "6b5a3e", 4, 1)); work.add_child(panel)
	var title := _label(_text(str(order.get("title", ""))), 20, "f8e7c0", true); title.position = Vector2(18, 8); title.size = Vector2(520, 32); work.add_child(title)
	var desc := _label(_text(str(order.get("description", "[tag:string:paperCraft:orderDescDefault]"))), 12, "d8c4a4"); desc.position = Vector2(18, 40); desc.size = Vector2(510, 36); desc.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; work.add_child(desc)
	for value: Variant in order.get("slots", []):
		if not value is Dictionary: continue
		var slot: Dictionary = value; var button := SlotButton.new(); button.slot_id = str(slot.id); button.drop_callback = Callable(self, "_drop_part"); button.position = Vector2(float(slot.x), float(slot.y)); button.size = Vector2(float(slot.width), float(slot.height)); button.text = ""; button.focus_mode = Control.FOCUS_NONE; var slot_border := "806744" if slot.get("optional") == true else "c4a35a"; _apply_button_style(button, "1c160e", 0.9, slot_border, 3, 1); button.pressed.connect(Callable(self, "_slot_pressed").bind(slot)); work.add_child(button)
		var slot_label := _label("%s%s" % [str(slot.get("label", "")), _text("[tag:string:paperCraft:slotOptionalSuffix]") if slot.get("optional") == true else ""], 11, "f1d99c"); slot_label.position = Vector2(0, 2); slot_label.size = Vector2(float(slot.width), 21); slot_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; button.add_child(slot_label)
		var placed_id := str(placed.get(str(slot.id), "")); if not placed_id.is_empty(): _add_part_visual(button, placed_id, Vector2(float(slot.width) / 2.0, float(slot.height) / 2.0 + 6.0), minf(float(slot.width) * 0.84, 88.0), minf(float(slot.height) * 0.78, 96.0))
	var palette := Control.new(); palette.name = "PartPalette"; palette.position = Vector2(start_x + work_w + gap, mid_y - palette_h / 2.0); palette.size = Vector2(250, palette_content_h); palette.scale = Vector2.ONE * palette_scale; root.add_child(palette)
	var palette_panel := Panel.new(); palette_panel.size = Vector2(250, palette_content_h); palette_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE; palette_panel.add_theme_stylebox_override("panel", _panel_style("201811", 0.95, "6b5a3e", 4, 1)); palette.add_child(palette_panel)
	var palette_title := _label(_text("[tag:string:paperCraft:paletteTitle]"), 17, "f8e7c0", true); palette_title.position = Vector2(14, 9); palette_title.size = Vector2(220, 27); palette.add_child(palette_title)
	var part_index := 0
	for value: Variant in order.get("parts", []):
		if not value is Dictionary: continue
		var part: Dictionary = value; var button := PartButton.new(); button.part_id = str(part.id); button.preview_texture = part_textures.get(button.part_id); button.position = Vector2(14 + (part_index % 2) * 112, 46 + floori(part_index / 2.0) * 74); button.size = Vector2(100, 64); button.text = ""; button.focus_mode = Control.FOCUS_NONE; var selected := selected_part_id == button.part_id; _apply_button_style(button, "573b1b" if selected else "32261a", 0.98, "ffd166" if selected else "765b38", 6, 1); button.pressed.connect(Callable(self, "_select_part").bind(button.part_id)); palette.add_child(button); _add_part_visual(button, button.part_id, Vector2(50, 24), 44, 36); var part_label := _label(str(part.get("label", "")), 10, "f3dfba"); part_label.position = Vector2(5, 41); part_label.size = Vector2(90, 20); part_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; part_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; button.add_child(part_label); part_index += 1
	_build_top_controls(screen_w)
	feedback_label = _label(_target_hint(), 15, "f8fafc"); feedback_label.position = Vector2(margin, screen_h - 33); feedback_label.size = Vector2(screen_w - margin * 2.0, 27); root.add_child(feedback_label)
	_wrap_content_for_pixi_phase()


func _build_top_controls(screen_w: float) -> void:
	var paper_title := _label(_text("[tag:string:paperCraft:paperTitle]"), 13, "e7d5b6", true); paper_title.position = Vector2(28, 15); paper_title.size = Vector2(48, 25); root.add_child(paper_title)
	var paper_index := 0
	for value: Variant in order.paperOptions:
		var option: Dictionary = value; var option_id := str(option.id); var button := _small_button(str(option.get("label", "")), Vector2(78 + paper_index * 82, 14), Vector2(72, 26), option_id == selected_paper_id); button.pressed.connect(Callable(self, "_select_paper").bind(option_id)); root.add_child(button); var swatch := ColorSwatch.new(); swatch.position = Vector2(6, 7); swatch.size = Vector2(12, 12); swatch.tint = Color(str(option.get("tint", "#f4ecd8"))); swatch.mouse_filter = Control.MOUSE_FILTER_IGNORE; button.add_child(swatch); paper_index += 1
	var finish_title := _label(_text(str(order.get("finishQuestion", "[tag:string:paperCraft:finishTitleDefault]"))), 13, "e7d5b6", true); finish_title.position = Vector2(28, 45); finish_title.size = Vector2(78, 25); root.add_child(finish_title)
	var finish_index := 0
	for value: Variant in order.finishOptions:
		var option: Dictionary = value; var option_id := str(option.id); var button := _small_button(str(option.get("label", "")), Vector2(108 + finish_index * 120, 44), Vector2(108, 26), option_id == selected_finish_id); button.pressed.connect(Callable(self, "_select_finish").bind(option_id)); root.add_child(button); finish_index += 1
	var submit := _small_button(_text("[tag:string:paperCraft:submit]"), Vector2(screen_w - 190, 18), Vector2(86, 26), true); submit.name = "Submit"; submit.pressed.connect(Callable(self, "_finish")); root.add_child(submit)
	var exit := _small_button(_text("[tag:string:paperCraft:exit]"), Vector2(screen_w - 94, 18), Vector2(74, 26), false); exit.name = "Exit"; exit.pressed.connect(Callable(self, "abort")); root.add_child(exit)


func _label(text: String, font_size: int, color_hex: String, bold: bool = false) -> Label:
	var label := Label.new(); label.text = text; label.add_theme_font_override("font", _system_ui_font(900 if bold else 500, 100 if bold else 101)); label.add_theme_font_size_override("font_size", font_size); label.add_theme_color_override("font_color", Color(color_hex)); label.add_theme_color_override("font_shadow_color", Color(color_hex, 0.65)); label.add_theme_constant_override("shadow_offset_x", 0); label.add_theme_constant_override("shadow_offset_y", 0); label.add_theme_constant_override("shadow_outline_size", 0); label.mouse_filter = Control.MOUSE_FILTER_IGNORE; return label


func _system_ui_font(weight: int, stretch: int = 100) -> SystemFont:
	var font := SystemFont.new(); font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"]); font.font_weight = weight; font.font_stretch = stretch; return font


func _panel_style(background_hex: String, alpha: float, border_hex: String, radius: int, border_width: int) -> StyleBoxFlat:
	var style := StyleBoxFlat.new(); style.bg_color = Color(background_hex, alpha); style.border_color = Color(border_hex); style.set_border_width_all(border_width); style.set_corner_radius_all(radius); style.anti_aliasing = true; return style


func _apply_button_style(button: Button, background_hex: String, alpha: float, border_hex: String, radius: int, border_width: int) -> void:
	var style := _panel_style(background_hex, alpha, border_hex, radius, border_width); button.add_theme_stylebox_override("normal", style); button.add_theme_stylebox_override("hover", style); button.add_theme_stylebox_override("pressed", style); button.add_theme_stylebox_override("focus", StyleBoxEmpty.new())


func _small_button(text: String, position: Vector2, size: Vector2, active: bool) -> Button:
	var button := Button.new(); button.text = text; button.position = position; button.size = size; button.focus_mode = Control.FOCUS_NONE; button.add_theme_font_override("font", _system_ui_font(500)); button.add_theme_font_size_override("font_size", 12)
	for state: String in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]: button.add_theme_color_override(state, Color("fff4d6"))
	button.add_theme_color_override("font_shadow_color", Color("fff4d6", 0.65)); button.add_theme_constant_override("shadow_offset_x", 0); button.add_theme_constant_override("shadow_offset_y", 0); button.add_theme_constant_override("shadow_outline_size", 0)
	_apply_button_style(button, "805b24" if active else "2d241b", 0.98, "ffd166" if active else "6b5436", 6, 1)
	return button


func _add_part_visual(parent: Control, part_id: String, position: Vector2, max_width: float, max_height: float) -> void:
	var texture: Variant = part_textures.get(part_id)
	if texture is Texture2D:
		var sprite := Sprite2D.new(); sprite.texture = texture; sprite.centered = true; sprite.position = position; sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR; var scale_value := minf(minf(max_width / maxf(1.0, texture.get_width()), max_height / maxf(1.0, texture.get_height())), 1.0); sprite.scale = Vector2.ONE * scale_value; parent.add_child(sprite); return
	var fallback := Panel.new(); fallback.position = position - Vector2(max_width, max_height) / 2.0; fallback.size = Vector2(max_width, max_height); fallback.mouse_filter = Control.MOUSE_FILTER_IGNORE; fallback.add_theme_stylebox_override("panel", _panel_style("e9ddc3", 0.95, "5e4630", 8, 2)); parent.add_child(fallback); var part: Variant = _find_by_id(order.get("parts"), part_id); var fallback_label := _label(str(part.get("label", "")) if part is Dictionary else "", 10, "2b2118"); fallback_label.size = fallback.size; fallback_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; fallback_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER; fallback.add_child(fallback_label)


func _wrap_content_for_pixi_phase() -> void:
	var content := CanvasGroup.new(); content.name = "PixiComposite"; content.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR; content.fit_margin = 1.0; content.clear_margin = 1.0; var material := ShaderMaterial.new(); material.shader = PIXI_COMPOSITE_SHADER; content.material = material
	var children := root.get_children()
	root.add_child(content)
	for child: Node in children: root.remove_child(child); content.add_child(child)


func _select_part(id: String) -> void:
	selected_part_id = id; _rebuild()


func _select_paper(id: String) -> void:
	selected_paper_id = id; _rebuild()


func _select_finish(id: String) -> void:
	selected_finish_id = id; _rebuild()


func _slot_pressed(slot: Dictionary) -> void:
	var slot_id := str(slot.id)
	if selected_part_id.is_empty():
		if placed.has(slot_id): placed.erase(slot_id); _rebuild()
		return
	_place_part(slot_id, selected_part_id)


func _drop_part(slot_id: String, part_id: String) -> void:
	_place_part(slot_id, part_id)


func _place_part(slot_id: String, part_id: String) -> bool:
	var slot: Variant = _find_by_id(order.get("slots"), slot_id); var part: Variant = _find_by_id(order.get("parts"), part_id)
	if not slot is Dictionary or not part is Dictionary: return false
	if not slot.get("accepts") is Array or not slot.accepts.has(part_id):
		if feedback_label != null: feedback_label.text = "%s 放不上 %s" % [str(slot.get("label", "")), str(part.get("label", ""))]
		return false
	placed[slot_id] = part_id; selected_part_id = ""; _rebuild(); return true


func _finish() -> bool:
	if finishing: return false
	var missing: Array[String] = []
	for value: Variant in order.get("slots", []):
		if value is Dictionary and value.get("optional") != true and not placed.has(str(value.id)): missing.push_back(str(value.get("label", "")))
	if not missing.is_empty():
		if feedback_label != null: feedback_label.text = _text("[tag:string:paperCraft:missingParts]").replace("{parts}", "、".join(missing))
		return false
	finishing = true
	var result := calculate_result()
	if on_result.is_valid(): on_result.call(result)
	var action_key := "onSuccessActions" if result.level == "success" else ("onWarnActions" if result.level == "warn" else "onBadActions")
	var actions: Array = order.get(action_key, []) if order.get(action_key) is Array else []
	await action_gate.run(actions)
	if not closing and not destroyed:
		if order_index < instance.orders.size() - 1: await _enter_order(order_index + 1)
		else: abort()
	finishing = false
	return true


func _set_input_locked(locked: bool) -> void:
	_set_buttons_disabled(root, locked)


func _set_buttons_disabled(node: Node, disabled: bool) -> void:
	if node is BaseButton: node.disabled = disabled
	for child: Node in node.get_children(): _set_buttons_disabled(child, disabled)


func _target_hint() -> String:
	var prefix := "〔第 %d/%d 件〕 " % [order_index + 1, instance.orders.size()] if instance.orders.size() > 1 else ""
	return prefix + _text(str(order.get("targetHint", "[tag:string:paperCraft:targetHintDefault]")))


func _text(raw: String) -> String:
	return str(resolve_text.call(raw)) if resolve_text.is_valid() else raw


func _part_label(id: String) -> String:
	var part: Variant = _find_by_id(order.get("parts"), id)
	return str(part.get("label", "")) if part is Dictionary else ""


static func _find_by_id(values: Variant, id: String) -> Variant:
	if values is Array:
		for value: Variant in values:
			if value is Dictionary and str(value.get("id", "")) == id: return value
	return null


static func _add_tags(target: Array[String], values: Variant) -> void:
	if values is Array:
		for value: Variant in values:
			var tag := str(value)
			if not target.has(tag): target.push_back(tag)
