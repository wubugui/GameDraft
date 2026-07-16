class_name RuntimePaperCraftMinigameScene
extends RefCounted

const DEFAULT_PART_IMAGE_ROOT := "/resources/runtime/images/minigames/paper_craft/parts/"
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")
const RuntimeFillTemplateScript := preload("res://scripts/utils/fill_template.gd")


class ColorSwatch:
	extends Control
	var tint := Color.WHITE

	func _draw() -> void:
		draw_circle(Vector2(12.0, 13.0), 6.0, tint, true)


# Direct fields, in PaperCraftMinigameScene.ts declaration order.
var root: Control
var renderer: RuntimeRenderer
var asset_manager: RuntimeAssetManager
var action_executor: RuntimeActionExecutor
var resolve_text: Callable
var on_result: Callable
var on_close: Callable

var instance: Dictionary = {}
var order: Dictionary = {}
var bg: Panel = Panel.new()
var background_sprite: TextureRect = null
var ui_layer: Control = Control.new()
var work_layer: Control = Control.new()
var palette_layer: Control = Control.new()
var feedback: Label = Label.new()
var selected_part: Variant = null
var selected_paper: Variant = null
var selected_finish: Variant = null
var placed: Dictionary = {}
var textures: Dictionary = {}
var drag: Variant = null
var unsub_resize: Variant = null
var closing := false
var destroyed := false
var order_index := 0
var finishing := false
var palette_content_h := 410.0
var action_gate: RuntimeMinigameActionPlaybackGate


func _init(
	next_renderer: RuntimeRenderer,
	next_asset_manager: RuntimeAssetManager,
	next_action_executor: RuntimeActionExecutor,
	next_resolve_text: Callable,
	next_on_result: Callable,
	next_on_close: Callable,
	restore_minigame_state_after_action: Callable = Callable(),
) -> void:
	renderer = next_renderer
	asset_manager = next_asset_manager
	action_executor = next_action_executor
	resolve_text = next_resolve_text
	on_result = next_on_result
	on_close = next_on_close

	action_gate = RuntimeMinigameActionPlaybackGate.new(
		Callable(action_executor, "execute_batch_await"),
		{
			"onLockChanged": Callable(self, "_set_input_locked"),
			"restoreMinigameState": restore_minigame_state_after_action,
		},
	)

	root = Control.new()
	root.name = "PaperCraftMinigameScene"
	root.position = Vector2.ZERO
	root.size = Vector2(renderer.screen_width, renderer.screen_height)
	root.mouse_filter = Control.MOUSE_FILTER_STOP

	bg.name = "BackgroundShade"
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	work_layer.name = "WorkLayer"
	palette_layer.name = "PaletteLayer"
	ui_layer.name = "UiLayer"
	ui_layer.mouse_filter = Control.MOUSE_FILTER_PASS
	feedback.name = "Feedback"
	feedback.text = ""
	feedback.add_theme_font_override("font", _system_ui_font(500, 101))
	feedback.add_theme_font_size_override("font_size", 15)
	feedback.add_theme_color_override("font_color", Color("f8fafc"))
	feedback.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	feedback.mouse_filter = Control.MOUSE_FILTER_IGNORE

	root.add_child(bg)
	root.add_child(work_layer)
	root.add_child(palette_layer)
	root.add_child(ui_layer)
	ui_layer.add_child(feedback)
	unsub_resize = renderer.subscribe_after_resize(Callable(self, "_on_resize"))


func is_actions_playback_locked() -> bool:
	return action_gate.is_locked()


func get_debug_visual_state() -> Dictionary:
	var placed_state: Dictionary = {}
	for slot_id: Variant in placed:
		var part: Variant = placed[slot_id]
		placed_state[str(slot_id)] = str(part.get("id", "")) if part is Dictionary else ""
	return {
		"instanceId": str(instance.get("id", "")),
		"orderId": str(order.get("id", "")),
		"orderIndex": order_index,
		"selectedPartId": str(selected_part.get("id", "")) if selected_part is Dictionary else "",
		"selectedPaperId": str(selected_paper.get("id", "")) if selected_paper is Dictionary else "",
		"selectedFinishId": str(selected_finish.get("id", "")) if selected_finish is Dictionary else "",
		"placed": placed_state,
		"feedbackText": feedback.text,
		"actionsPlaybackLocked": is_actions_playback_locked(),
		"finishing": finishing,
	}


func _set_input_locked(locked: bool) -> void:
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE if locked else Control.MOUSE_FILTER_STOP
	_set_gui_input_enabled(root, not locked)


func load(next_instance: Dictionary) -> Variant:
	instance = next_instance
	if not instance.get("orders") is Array or instance.orders.is_empty():
		push_error("paperCraft: instance has no orders")
		return false
	for next_order: Variant in instance.orders:
		if not next_order is Dictionary:
			push_error("paperCraft: order is not an object")
			return false
		if not next_order.get("paperOptions") is Array or next_order.paperOptions.is_empty():
			push_error("paperCraft: order \"%s\" 缺少 paperOptions（纸色选项须由数据声明）" % str(next_order.get("id", "")))
			return false
		if not next_order.get("finishOptions") is Array or next_order.finishOptions.is_empty():
			push_error("paperCraft: order \"%s\" 缺少 finishOptions（收尾选项须由数据声明）" % str(next_order.get("id", "")))
			return false

	var background_image: Variant = instance.get("backgroundImage")
	if background_image is String and not background_image.is_empty():
		var background_texture: Variant = asset_manager.load_texture(background_image)
		await RuntimeMicrotaskQueueScript.yield_turn()
		if background_texture is Texture2D:
			background_sprite = TextureRect.new()
			background_sprite.name = "PaperCraftBackground"
			background_sprite.texture = background_texture
			background_sprite.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
			background_sprite.stretch_mode = TextureRect.STRETCH_SCALE
			background_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
			background_sprite.mouse_filter = Control.MOUSE_FILTER_IGNORE
			root.add_child(background_sprite)
			root.move_child(background_sprite, 1)
		else:
			background_sprite = null
	await _enter_order(0)
	return null


func _enter_order(index: int) -> void:
	order_index = index
	order = instance.orders[index]
	placed.clear()
	selected_part = null
	var paper_options := _get_paper_options()
	var finish_options := _get_finish_options()
	selected_paper = paper_options[0] if not paper_options.is_empty() else null
	selected_finish = finish_options[0] if not finish_options.is_empty() else null
	await _load_textures()
	if closing or destroyed:
		return
	_rebuild()


func update(_dt: float) -> void:
	# Interaction is event driven.
	return


func _on_resize() -> void:
	if not order.is_empty():
		_rebuild()
	else:
		_layout()


func abort() -> void:
	if closing:
		return
	closing = true
	if on_close.is_valid():
		on_close.call()


func destroy() -> void:
	if destroyed:
		return
	destroyed = true
	if unsub_resize is Callable and unsub_resize.is_valid():
		unsub_resize.call()
	unsub_resize = null
	if is_instance_valid(root):
		root.free()


func _load_textures() -> void:
	for part: Variant in order.get("parts", []):
		if not part is Dictionary:
			continue
		var image := _part_image(part)
		var texture: Variant = asset_manager.load_texture(image)
		if texture is Texture2D:
			textures[str(part.get("id", ""))] = texture
	# Promise.all, including Promise.all([]), resumes on a microtask.
	await RuntimeMicrotaskQueueScript.yield_turn()


func _rebuild() -> void:
	_clear_layer(work_layer)
	_clear_layer(palette_layer)
	_clear_layer(ui_layer, feedback)
	ui_layer.add_child(feedback)
	_build_slots()
	_build_palette()
	_build_paper_buttons()
	_build_finish_buttons()
	_build_top_chrome()
	_update_feedback()
	_layout()


func _layout() -> void:
	var screen_width := float(renderer.screen_width)
	var screen_height := float(renderer.screen_height)
	root.position = Vector2.ZERO
	root.size = Vector2(screen_width, screen_height)
	bg.position = Vector2.ZERO
	bg.size = root.size
	bg.add_theme_stylebox_override("panel", _panel_style("15100b", 0.94, "3b2c1f", 0, 2))

	if background_sprite != null and background_sprite.texture != null:
		var texture_width := float(background_sprite.texture.get_width())
		var texture_height := float(background_sprite.texture.get_height())
		var scale_value := maxf(screen_width / texture_width, screen_height / texture_height)
		background_sprite.size = Vector2(texture_width, texture_height)
		background_sprite.scale = Vector2.ONE * scale_value
		background_sprite.position = Vector2(
			(screen_width - texture_width * scale_value) / 2.0,
			(screen_height - texture_height * scale_value) / 2.0,
		)
		background_sprite.modulate.a = 0.35

	var top_strip := 80.0
	var bottom_strip := 46.0
	var margin := 24.0
	var gap := 24.0
	var max_scale := 1.4
	var region_height := maxf(160.0, screen_height - top_strip - bottom_strip)
	var inner_width := maxf(240.0, screen_width - margin * 2.0 - gap)
	var palette_region_width := minf(inner_width * 0.34, 250.0 * max_scale)
	var work_region_width := inner_width - palette_region_width
	var work_scale := minf(minf(work_region_width / 560.0, region_height / 410.0), max_scale)
	var palette_scale := minf(minf(palette_region_width / 250.0, region_height / palette_content_h), max_scale)

	var work_width := 560.0 * work_scale
	var work_height := 410.0 * work_scale
	var palette_width := 250.0 * palette_scale
	var palette_height := palette_content_h * palette_scale
	var total_width := work_width + gap + palette_width
	var start_x := maxf(margin, (screen_width - total_width) / 2.0)
	var middle_y := top_strip + region_height / 2.0

	work_layer.size = Vector2(560.0, 410.0)
	work_layer.scale = Vector2.ONE * work_scale
	work_layer.position = Vector2(start_x, middle_y - work_height / 2.0)
	palette_layer.size = Vector2(250.0, palette_content_h)
	palette_layer.scale = Vector2.ONE * palette_scale
	palette_layer.position = Vector2(start_x + work_width + gap, middle_y - palette_height / 2.0)
	ui_layer.position = Vector2.ZERO
	ui_layer.size = root.size
	feedback.position = Vector2(margin, screen_height - 30.0)
	feedback.size = Vector2(screen_width - margin * 2.0, 26.0)


func _build_slots() -> void:
	var table := Panel.new()
	table.name = "WorkTablePanel"
	table.size = Vector2(560.0, 410.0)
	table.mouse_filter = Control.MOUSE_FILTER_IGNORE
	table.add_theme_stylebox_override("panel", _panel_style("17120d", 0.95, "6b5a3e", 4, 1))
	work_layer.add_child(table)

	var title := _label(_resolve(str(order.get("title", ""))), 20, "f8e7c0", true)
	title.position = Vector2(18.0, 12.0)
	title.size = Vector2(520.0, 28.0)
	work_layer.add_child(title)

	var description := _label(_resolve(str(order.get("description", "[tag:string:paperCraft:orderDescDefault]"))), 12, "d8c4a4")
	description.position = Vector2(18.0, 43.0)
	description.size = Vector2(510.0, 36.0)
	description.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	work_layer.add_child(description)

	for slot: Variant in order.get("slots", []):
		if slot is Dictionary:
			work_layer.add_child(_make_slot(slot))


func _make_slot(slot: Dictionary) -> Control:
	var wrap := Button.new()
	wrap.name = "Slot_%s" % str(slot.get("id", ""))
	wrap.position = Vector2(float(slot.get("x", 0.0)), float(slot.get("y", 0.0)))
	wrap.size = Vector2(float(slot.get("width", 0.0)), float(slot.get("height", 0.0)))
	wrap.text = ""
	wrap.focus_mode = Control.FOCUS_NONE
	wrap.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	var border := "806744" if slot.get("optional") == true else "c4a35a"
	_apply_button_style(wrap, "1c160e", 0.9, border, 3, 1)

	var placed_part: Variant = placed.get(str(slot.get("id", "")))
	if placed_part is Dictionary:
		var art := _make_part_visual(
			placed_part,
			minf(float(slot.get("width", 0.0)) * 0.84, 88.0),
			minf(float(slot.get("height", 0.0)) * 0.78, 96.0),
		)
		art.position = Vector2(float(slot.get("width", 0.0)) / 2.0, float(slot.get("height", 0.0)) / 2.0 + 6.0)
		wrap.add_child(art)

	var suffix := _resolve("[tag:string:paperCraft:slotOptionalSuffix]") if slot.get("optional") == true else ""
	var slot_label := _label("%s%s" % [str(slot.get("label", "")), suffix], 11, "f1d99c")
	slot_label.position = Vector2(0.0, 5.0)
	slot_label.size = Vector2(float(slot.get("width", 0.0)), 21.0)
	slot_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	wrap.add_child(slot_label)
	wrap.pressed.connect(Callable(self, "_on_slot_pressed_adapter").bind(slot))
	return wrap


func _build_palette() -> void:
	var columns := 2
	var rows := maxi(1, ceili(float(order.get("parts", []).size()) / float(columns)))
	var background_height := 46.0 + float(rows) * 74.0 + 10.0
	palette_content_h = background_height

	var background := Panel.new()
	background.size = Vector2(250.0, background_height)
	background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	background.add_theme_stylebox_override("panel", _panel_style("201811", 0.95, "6b5a3e", 4, 1))
	palette_layer.add_child(background)

	var title := _label(_resolve("[tag:string:paperCraft:paletteTitle]"), 17, "f8e7c0", true)
	title.position = Vector2(14.0, 12.0)
	title.size = Vector2(220.0, 27.0)
	palette_layer.add_child(title)

	var parts: Array = order.get("parts", [])
	for index: int in parts.size():
		var part: Variant = parts[index]
		if not part is Dictionary:
			continue
		var item := _make_palette_item(part)
		item.position = Vector2(14.0 + float(index % columns) * 112.0, 46.0 + float(index / columns) * 74.0)
		palette_layer.add_child(item)


func _make_palette_item(part: Dictionary) -> Control:
	var wrap := Button.new()
	wrap.name = "Part_%s" % str(part.get("id", ""))
	wrap.size = Vector2(100.0, 64.0)
	wrap.text = ""
	wrap.focus_mode = Control.FOCUS_NONE
	wrap.mouse_default_cursor_shape = Control.CURSOR_DRAG
	var active := selected_part is Dictionary and str(selected_part.get("id", "")) == str(part.get("id", ""))
	_apply_button_style(wrap, "573b1b" if active else "31251a", 0.98, "ffd166" if active else "765b38", 6, 2)

	var art := _make_part_visual(part, 44.0, 36.0)
	art.position = Vector2(50.0, 24.0)
	wrap.add_child(art)
	var part_label := _label(str(part.get("label", "")), 10, "f3dfba")
	part_label.position = Vector2(5.0, 43.0)
	part_label.size = Vector2(90.0, 18.0)
	part_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	part_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	wrap.add_child(part_label)

	wrap.pressed.connect(Callable(self, "_on_part_pressed_adapter").bind(part))
	wrap.gui_input.connect(Callable(self, "_on_part_gui_input_adapter").bind(part))
	return wrap


func _on_drag_move(event: Variant) -> void:
	if not drag is Dictionary:
		return
	var sprite: Variant = drag.get("sprite")
	if not sprite is Control or not is_instance_valid(sprite):
		return
	var global_position := _event_global_position(event)
	sprite.position = _root_local_from_global(global_position) + Vector2(float(drag.get("dx", 0.0)), float(drag.get("dy", 0.0)))


func _on_drag_end(event: Variant) -> void:
	if not drag is Dictionary:
		return
	var global_position := _event_global_position(event)
	var local := work_layer.get_global_transform_with_canvas().affine_inverse() * global_position
	var matched_slot: Variant = null
	for candidate: Variant in order.get("slots", []):
		if not candidate is Dictionary:
			continue
		if local.x >= float(candidate.get("x", 0.0)) \
			and local.x <= float(candidate.get("x", 0.0)) + float(candidate.get("width", 0.0)) \
			and local.y >= float(candidate.get("y", 0.0)) \
			and local.y <= float(candidate.get("y", 0.0)) + float(candidate.get("height", 0.0)):
			matched_slot = candidate
			break
	var dragged_part: Variant = drag.get("part")
	if matched_slot is Dictionary and dragged_part is Dictionary and matched_slot.get("accepts") is Array and matched_slot.accepts.has(str(dragged_part.get("id", ""))):
		placed[str(matched_slot.get("id", ""))] = dragged_part
		selected_part = null
	elif matched_slot is Dictionary and dragged_part is Dictionary:
		feedback.text = _slot_rejects_text(str(matched_slot.get("label", "")), str(dragged_part.get("label", "")))
	var sprite: Variant = drag.get("sprite")
	if sprite is Node and is_instance_valid(sprite):
		if sprite.get_parent() != null:
			sprite.get_parent().remove_child(sprite)
		sprite.queue_free()
	drag = null
	var root_callback := Callable(self, "_on_root_gui_input_adapter")
	if root.gui_input.is_connected(root_callback):
		root.gui_input.disconnect(root_callback)
	_rebuild()


func _build_paper_buttons() -> void:
	var options := _get_paper_options()
	var title := _label(_resolve("[tag:string:paperCraft:paperTitle]"), 13, "e7d5b6", true)
	title.position = Vector2(28.0, 18.0)
	title.size = Vector2(48.0, 25.0)
	ui_layer.add_child(title)
	for index: int in options.size():
		var option: Dictionary = options[index]
		var active := selected_paper is Dictionary and str(option.get("id", "")) == str(selected_paper.get("id", ""))
		var button := _make_small_button(str(option.get("label", "")), 72.0, active, Callable(self, "_select_paper_adapter").bind(option))
		button.name = "Paper_%s" % str(option.get("id", ""))
		button.position = Vector2(78.0 + float(index) * 82.0, 14.0)
		var swatch := ColorSwatch.new()
		swatch.size = Vector2(24.0, 26.0)
		swatch.tint = _color_from_rgb(_parse_color(option.get("tint"), 0xf4ecd8))
		swatch.mouse_filter = Control.MOUSE_FILTER_IGNORE
		button.add_child(swatch)
		ui_layer.add_child(button)


func _build_finish_buttons() -> void:
	var options := _get_finish_options()
	var title := _label(_resolve(str(order.get("finishQuestion", "[tag:string:paperCraft:finishTitleDefault]"))), 13, "e7d5b6", true)
	title.position = Vector2(28.0, 48.0)
	title.size = Vector2(78.0, 25.0)
	ui_layer.add_child(title)
	for index: int in options.size():
		var option: Dictionary = options[index]
		var active := selected_finish is Dictionary and str(option.get("id", "")) == str(selected_finish.get("id", ""))
		var button := _make_small_button(str(option.get("label", "")), 108.0, active, Callable(self, "_select_finish_adapter").bind(option))
		button.name = "Finish_%s" % str(option.get("id", ""))
		button.position = Vector2(108.0 + float(index) * 120.0, 44.0)
		ui_layer.add_child(button)


func _build_top_chrome() -> void:
	var submit := _make_small_button(_resolve("[tag:string:paperCraft:submit]"), 86.0, true, Callable(self, "_finish"))
	submit.name = "Submit"
	submit.position = Vector2(float(renderer.screen_width) - 190.0, 18.0)
	ui_layer.add_child(submit)
	var close := _make_small_button(_resolve("[tag:string:paperCraft:exit]"), 74.0, false, Callable(self, "abort"))
	close.name = "Exit"
	close.position = Vector2(float(renderer.screen_width) - 94.0, 18.0)
	ui_layer.add_child(close)


func _make_small_button(label: String, width: float, active: bool, callback: Callable) -> Control:
	var wrap := Button.new()
	wrap.text = label
	wrap.size = Vector2(width, 26.0)
	wrap.focus_mode = Control.FOCUS_NONE
	wrap.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND
	wrap.add_theme_font_override("font", _system_ui_font(500))
	wrap.add_theme_font_size_override("font_size", 12)
	for state: String in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]:
		wrap.add_theme_color_override(state, Color("fff4d6"))
	_apply_button_style(wrap, "805b24" if active else "2d241b", 0.98, "ffd166" if active else "6b5436", 6, 1)
	wrap.pressed.connect(callback)
	return wrap


func _finish() -> void:
	if finishing:
		return
	var missing: Array = order.get("slots", []).filter(func(slot: Variant) -> bool:
		return slot is Dictionary and slot.get("optional") != true and not placed.has(str(slot.get("id", ""))))
	if not missing.is_empty():
		var labels: Array[String] = []
		for slot: Dictionary in missing:
			labels.push_back(str(slot.get("label", "")))
		feedback.text = RuntimeFillTemplateScript.fill_token(
			_resolve("[tag:string:paperCraft:missingParts]"),
			"{parts}",
			"、".join(labels),
		)
		return
	finishing = true
	var result := _calculate_result()
	if on_result.is_valid():
		on_result.call(result)
	var actions: Variant = order.get("onSuccessActions") if result.level == "success" \
		else order.get("onWarnActions") if result.level == "warn" \
		else order.get("onBadActions")
	await action_gate.run(actions)
	if closing or destroyed:
		finishing = false
		return
	if order_index < instance.orders.size() - 1:
		await _enter_order(order_index + 1)
	else:
		abort()
	finishing = false


func _calculate_result() -> Dictionary:
	var tags: Array[String] = []
	var score: Variant = 0
	var paper: Variant = selected_paper
	var finish: Variant = selected_finish
	if paper is Dictionary:
		var paper_score: Variant = paper.get("score", 0)
		if paper_score is int or paper_score is float:
			score += paper_score
		if order.get("correctPaper") is String and not str(order.correctPaper).is_empty():
			score += 12 if str(paper.get("id", "")) == str(order.correctPaper) else -6
		for tag: Variant in paper.get("tags", []):
			var text := str(tag)
			if not tags.has(text):
				tags.push_back(text)
	if finish is Dictionary:
		var finish_score: Variant = finish.get("score", 0)
		if finish_score is int or finish_score is float:
			score += finish_score
		for tag: Variant in finish.get("tags", []):
			var text := str(tag)
			if not tags.has(text):
				tags.push_back(text)
	for part: Variant in placed.values():
		if not part is Dictionary:
			continue
		var part_score: Variant = part.get("score", 0)
		if part_score is int or part_score is float:
			score += part_score
		for tag: Variant in part.get("tags", []):
			var text := str(tag)
			if not tags.has(text):
				tags.push_back(text)
	var success: Variant = order.get("successScore", 76)
	var warn: Variant = order.get("warnScore", 50)
	var level := "success" if score >= success else "warn" if score >= warn else "bad"
	var placed_result: Array[Dictionary] = []
	for slot_id: Variant in placed:
		var part: Variant = placed[slot_id]
		if part is Dictionary:
			placed_result.push_back({
				"slotId": str(slot_id),
				"partId": str(part.get("id", "")),
				"partLabel": str(part.get("label", "")),
			})
	return {
		"instanceId": str(instance.get("id", "")),
		"instanceLabel": str(instance.get("label", "")),
		"orderId": str(order.get("id", "")),
		"orderTitle": str(order.get("title", "")),
		"score": score,
		"level": level,
		"paperId": str(paper.get("id", "")) if paper is Dictionary else "",
		"finishId": str(finish.get("id", "")) if finish is Dictionary else "",
		"tags": tags,
		"placed": placed_result,
	}


func _slot_rejects_text(slot_label: String, part_label: String) -> String:
	return RuntimeFillTemplateScript.fill_template(_resolve("[tag:string:paperCraft:slotRejects]"), {
		"{slot}": slot_label,
		"{part}": part_label,
	})


func _update_feedback() -> void:
	var total: int = instance.orders.size()
	var progress: String = RuntimeFillTemplateScript.fill_template(_resolve("[tag:string:paperCraft:progressPrefix]"), {
		"{i}": str(order_index + 1),
		"{n}": str(total),
	}) if total > 1 else ""
	var target_hint: Variant = order.get("targetHint")
	var hint := _resolve(str(target_hint)) if target_hint is String and not target_hint.strip_edges().is_empty() \
		else _resolve("[tag:string:paperCraft:targetHintDefault]")
	feedback.text = progress + hint


func _make_part_visual(part: Dictionary, max_width: float, max_height: float) -> Control:
	var wrap := Control.new()
	wrap.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var texture: Variant = textures.get(str(part.get("id", "")))
	if texture is Texture2D:
		var sprite := Sprite2D.new()
		sprite.texture = texture
		sprite.centered = true
		sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
		var scale_value := minf(minf(max_width / float(texture.get_width()), max_height / float(texture.get_height())), 1.0)
		sprite.scale = Vector2.ONE * scale_value
		wrap.add_child(sprite)
		return wrap
	var fallback := Panel.new()
	fallback.position = -Vector2(max_width, max_height) / 2.0
	fallback.size = Vector2(max_width, max_height)
	fallback.mouse_filter = Control.MOUSE_FILTER_IGNORE
	fallback.add_theme_stylebox_override("panel", _panel_style("e9ddc3", 0.95, "5e4630", 8, 2))
	wrap.add_child(fallback)
	var label := _label(str(part.get("label", "")), 10, "2b2118")
	label.size = fallback.size
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	fallback.add_child(label)
	return wrap


func _part_image(part: Dictionary) -> String:
	var image: Variant = part.get("image")
	if image is String and not image.is_empty():
		return image
	return "%s%s.png" % [DEFAULT_PART_IMAGE_ROOT, str(part.get("id", ""))]


func _get_paper_options() -> Array:
	return order.get("paperOptions", [])


func _get_finish_options() -> Array:
	return order.get("finishOptions", [])


func _parse_color(raw: Variant, fallback: int) -> int:
	var text := str(raw if raw != null else "").strip_edges()
	if text.begins_with("#"):
		text = text.substr(1)
	if text.length() != 6:
		return fallback
	var digits := "0123456789abcdef"
	var value := 0
	for index: int in text.length():
		var digit := digits.find(text.substr(index, 1).to_lower())
		if digit < 0:
			return fallback
		value = value * 16 + digit
	return value


# Godot signal/rendering adapters. They translate Pixi display-object and
# FederatedPointerEvent operations without owning PaperCraft domain state.
func _on_slot_pressed_adapter(slot: Dictionary) -> void:
	var slot_id := str(slot.get("id", ""))
	if selected_part == null:
		if placed.has(slot_id):
			placed.erase(slot_id)
			_rebuild()
		return
	if not selected_part is Dictionary:
		return
	if not slot.get("accepts") is Array or not slot.accepts.has(str(selected_part.get("id", ""))):
		feedback.text = _slot_rejects_text(str(slot.get("label", "")), str(selected_part.get("label", "")))
		return
	placed[slot_id] = selected_part
	selected_part = null
	_rebuild()


func _on_part_pressed_adapter(part: Dictionary) -> void:
	selected_part = part
	_rebuild()


func _on_part_gui_input_adapter(event: InputEvent, part: Dictionary) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed:
			selected_part = part
			var sprite := _make_part_visual(part, 72.0, 72.0)
			sprite.position = _root_local_from_global(event.global_position)
			root.add_child(sprite)
			drag = {"part": part, "sprite": sprite, "dx": 0.0, "dy": 0.0}
			var root_callback := Callable(self, "_on_root_gui_input_adapter")
			if not root.gui_input.is_connected(root_callback):
				root.gui_input.connect(root_callback)
		elif drag is Dictionary:
			_on_drag_end({"global": event.global_position})
	elif event is InputEventMouseMotion and drag is Dictionary:
		_on_drag_move({"global": event.global_position})


func _on_root_gui_input_adapter(event: InputEvent) -> void:
	if event is InputEventMouseMotion:
		_on_drag_move({"global": event.global_position})
	elif event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and not event.pressed:
		_on_drag_end({"global": event.global_position})


func _select_paper_adapter(option: Dictionary) -> void:
	selected_paper = option
	_rebuild()


func _select_finish_adapter(option: Dictionary) -> void:
	selected_finish = option
	_rebuild()


func _clear_layer(layer: Node, preserved: Node = null) -> void:
	for child: Node in layer.get_children():
		layer.remove_child(child)
		if child != preserved:
			child.queue_free()


func _set_gui_input_enabled(node: Node, enabled: bool) -> void:
	if node is BaseButton:
		node.disabled = not enabled
	for child: Node in node.get_children():
		_set_gui_input_enabled(child, enabled)


func _event_global_position(event: Variant) -> Vector2:
	if event is Dictionary and event.get("global") is Vector2:
		return event.global
	if event is InputEventMouse:
		return event.global_position
	return Vector2.ZERO


func _root_local_from_global(global_position: Vector2) -> Vector2:
	return root.get_global_transform_with_canvas().affine_inverse() * global_position


func _resolve(raw: String) -> String:
	return str(resolve_text.call(raw)) if resolve_text.is_valid() else raw


func _label(text: String, font_size: int, color_hex: String, bold: bool = false) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_override("font", _system_ui_font(900 if bold else 500, 100 if bold else 101))
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", Color(color_hex))
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return label


func _system_ui_font(weight: int, stretch: int = 100) -> SystemFont:
	var font := SystemFont.new()
	font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"])
	font.font_weight = weight
	font.font_stretch = stretch
	return font


func _panel_style(background_hex: String, alpha: float, border_hex: String, radius: int, border_width: int) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color(background_hex, alpha)
	style.border_color = Color(border_hex)
	style.set_border_width_all(border_width)
	style.set_corner_radius_all(radius)
	style.anti_aliasing = true
	return style


func _apply_button_style(button: Button, background_hex: String, alpha: float, border_hex: String, radius: int, border_width: int) -> void:
	var style := _panel_style(background_hex, alpha, border_hex, radius, border_width)
	button.add_theme_stylebox_override("normal", style)
	button.add_theme_stylebox_override("hover", style)
	button.add_theme_stylebox_override("pressed", style)
	button.add_theme_stylebox_override("focus", StyleBoxEmpty.new())


func _color_from_rgb(value: int) -> Color:
	return Color(
		float((value >> 16) & 255) / 255.0,
		float((value >> 8) & 255) / 255.0,
		float(value & 255) / 255.0,
		1.0,
	)
