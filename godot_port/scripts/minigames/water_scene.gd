class_name RuntimeWaterMinigameScene
extends RefCounted

const SEARCH := "search"
const PULL := "pull"
const SURFACE_SHADER := preload("res://scripts/minigames/water_surface.gdshader")
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")


class GraphicsLayer:
	extends Control
	var draw_callback: Callable
	func _init(callback: Callable) -> void:
		draw_callback = callback
		mouse_filter = Control.MOUSE_FILTER_IGNORE
	func _draw() -> void:
		if draw_callback.is_valid():
			draw_callback.call(self)


# Direct fields, in WaterMinigameScene.ts declaration order.
var root: Control
var renderer: RuntimeRenderer
var app: RuntimeRenderer
var instance: Dictionary = {}
var bottom_layer: Node2D
var bottom_fill: GraphicsLayer
var bottom_texture_sprite: Sprite2D
var water_layer: Node2D
var underwater_rt_root: Node2D
var surface_layer: Node2D
var shore_layer: Node2D
var ui_layer: Control
var bottom_mrt: SubViewport
var params_mrt: SubViewport
var underwater_hit_zone: Control
var bottom_mrt_sprite: TextureRect
var water_filter: ShaderMaterial
var bg: ColorRect
var shore_sprites: Array[Sprite2D] = []
var entities: Array[RuntimeWaterEntity] = []
var phase := SEARCH
var pull_panel: RuntimeWaterPullPanel
var feedback: Label
var exit_chrome: Button
var time := 0.0
var search_horizon_sec := 25.0
var unsub_resize: Variant = null
var degraded := false
var random: Callable = RuntimeDeterministicRandom.create_deterministic_random("")

var on_finish: Callable
var on_consumed: Variant = null
var resolve_text: Callable
var action_executor: RuntimeActionExecutor
var asset_manager: RuntimeAssetManager
var get_key_hold: Callable
var action_gate: RuntimeMinigameActionPlaybackGate

# Godot engine adapters. Pixi renders one subtree twice; Godot keeps two
# SubViewport-resident trees and mirrors only the parameter-pass geometry.
var params_rt_root: Node2D
var exit_panel: Panel
var exit_title: Label
var exit_hint: Label
var bottom_tint := 0x18324a


func _init(
	next_renderer: RuntimeRenderer,
	next_asset_manager: RuntimeAssetManager,
	next_action_executor: RuntimeActionExecutor,
	next_resolve_text: Callable,
	next_get_key_hold: Callable,
	next_on_finish: Callable,
	next_on_consumed: Callable = Callable(),
	restore_minigame_state_after_action: Callable = Callable(),
) -> void:
	renderer = next_renderer
	app = renderer
	asset_manager = next_asset_manager
	action_executor = next_action_executor
	resolve_text = next_resolve_text
	get_key_hold = next_get_key_hold
	on_finish = next_on_finish
	on_consumed = next_on_consumed if next_on_consumed.is_valid() else null

	action_gate = RuntimeMinigameActionPlaybackGate.new(
		Callable(action_executor, "execute_batch_await"),
		{
			"onLockChanged": Callable(self, "_set_input_locked"),
			"restoreMinigameState": restore_minigame_state_after_action,
		},
	)

	root = Control.new()
	root.name = "WaterMinigameScene"
	root.mouse_filter = Control.MOUSE_FILTER_PASS

	bg = ColorRect.new()
	bg.name = "Background"
	bg.color = Color("0b1220")
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE

	bottom_layer = Node2D.new()
	bottom_layer.name = "BottomLayer"
	bottom_fill = GraphicsLayer.new(Callable(self, "_draw_bottom_fill"))
	bottom_fill.name = "BottomFill"
	bottom_layer.add_child(bottom_fill)

	water_layer = Node2D.new()
	water_layer.name = "WaterLayer"
	underwater_rt_root = Node2D.new()
	underwater_rt_root.name = "UnderwaterRtRoot"
	bottom_layer.z_index = 0
	water_layer.z_index = 1
	underwater_rt_root.add_child(bottom_layer)
	underwater_rt_root.add_child(water_layer)

	surface_layer = Node2D.new()
	surface_layer.name = "SurfaceLayer"
	shore_layer = Node2D.new()
	shore_layer.name = "ShoreLayer"
	ui_layer = Control.new()
	ui_layer.name = "UiLayer"
	ui_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE

	bottom_mrt = SubViewport.new()
	bottom_mrt.name = "BottomMrt"
	bottom_mrt.size = Vector2i(4, 4)
	bottom_mrt.disable_3d = true
	bottom_mrt.transparent_bg = false
	bottom_mrt.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	bottom_mrt.add_child(underwater_rt_root)

	params_mrt = SubViewport.new()
	params_mrt.name = "ParamsMrt"
	params_mrt.size = Vector2i(4, 4)
	params_mrt.disable_3d = true
	params_mrt.transparent_bg = true
	params_mrt.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	params_rt_root = Node2D.new()
	params_rt_root.name = "ParamsRtRoot"
	params_mrt.add_child(params_rt_root)

	bottom_mrt_sprite = TextureRect.new()
	bottom_mrt_sprite.name = "BottomMrtSprite"
	bottom_mrt_sprite.texture = bottom_mrt.get_texture()
	bottom_mrt_sprite.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	bottom_mrt_sprite.stretch_mode = TextureRect.STRETCH_SCALE
	bottom_mrt_sprite.mouse_filter = Control.MOUSE_FILTER_IGNORE

	water_filter = ShaderMaterial.new()
	water_filter.shader = SURFACE_SHADER
	water_filter.set_shader_parameter("params_texture", params_mrt.get_texture())
	bottom_mrt_sprite.material = water_filter

	underwater_hit_zone = Control.new()
	underwater_hit_zone.name = "UnderwaterHitZone"
	underwater_hit_zone.mouse_filter = Control.MOUSE_FILTER_STOP
	underwater_hit_zone.gui_input.connect(Callable(self, "_on_pointer_input"))

	root.add_child(bottom_mrt)
	root.add_child(params_mrt)
	root.add_child(bg)
	root.add_child(bottom_mrt_sprite)
	root.add_child(underwater_hit_zone)
	root.add_child(surface_layer)
	root.add_child(shore_layer)
	root.add_child(ui_layer)


func load(next_instance: Dictionary, options: Dictionary) -> void:
	instance = next_instance
	random = RuntimeDeterministicRandom.create_deterministic_random(str(instance.id))
	degraded = options.degraded
	time = 0.0
	phase = SEARCH
	_release_entities_for_reload()
	entities = []
	_clear_pull()
	_clear_feedback()
	_clear_exit_ui()

	_water_filter_apply_surface(str(instance.surface.time), str(instance.surface.weather))
	var water_bottom: Variant = instance.get("waterBottom")
	var raw_depth: Variant = water_bottom.get("depth") if water_bottom is Dictionary else null
	var water_bottom_depth := maxf(0.0, float(raw_depth)) \
		if (raw_depth is int or raw_depth is float) and is_finite(float(raw_depth)) else 1.0
	_water_filter_set_water_bottom_depth(water_bottom_depth)

	await _setup_bottom_layer()
	await _setup_shore_layer()
	_remove_all_children(water_layer)
	_remove_all_children(params_rt_root)
	_remove_all_children(surface_layer)

	var definitions := _filter_defs(instance.entities)
	for definition: Dictionary in definitions:
		var texture := await RuntimeWaterEntity.load_entity_texture(asset_manager, str(definition.sprite))
		var entity := RuntimeWaterEntity.new(
			definition,
			texture,
			asset_manager,
			{
				"paramsEncode": definition.category != "floating",
				"random": random,
			},
		)
		if definition.category == "floating":
			surface_layer.add_child(entity.container)
		else:
			water_layer.add_child(entity.container)
			if entity.params_container != null:
				params_rt_root.add_child(entity.params_container)
		entity.set_flee_deadline(search_horizon_sec)
		if definition.category == "floating":
			entity.on_pointer_tap(Callable(self, "_on_entity_tap"))
		entities.push_back(entity)

	_build_exit_ui()
	_layout()
	if unsub_resize is Callable and unsub_resize.is_valid():
		unsub_resize.call()
	unsub_resize = renderer.subscribe_after_resize(Callable(self, "_layout"))


func _parse_color(raw: Variant, fallback: int) -> int:
	if not raw is String or raw.is_empty():
		return fallback
	var text: String = raw.strip_edges()
	if text.is_empty():
		return fallback
	var hex: String = text.substr(1) if text.begins_with("#") else text
	var full := ""
	if hex.length() == 3:
		for character_index: int in hex.length():
			var character: String = hex.substr(character_index, 1)
			full += character + character
	else:
		full = hex
	full = full.strip_edges(true, false)
	var sign := 1.0
	var index := 0
	if full.begins_with("-"):
		sign = -1.0
		index = 1
	elif full.begins_with("+"):
		index = 1
	if full.substr(index, 2).to_lower() == "0x":
		index += 2
	var number := 0.0
	var parsed := false
	var digits := "0123456789abcdef"
	while index < full.length():
		var digit := digits.find(full.substr(index, 1).to_lower())
		if digit < 0:
			break
		number = number * 16.0 + float(digit)
		if not is_finite(number):
			return fallback
		parsed = true
		index += 1
	if not parsed:
		return fallback
	return int(fposmod(number * sign, 4294967296.0))


func _setup_bottom_layer() -> void:
	if bottom_texture_sprite != null:
		bottom_texture_sprite.free()
		bottom_texture_sprite = null
	var bounds := Vector2(float(instance.bounds.width), float(instance.bounds.height))
	bottom_tint = _parse_color(instance.get("waterBottom", {}).get("tint"), 0x18324a)
	bottom_fill.size = bounds
	bottom_fill.queue_redraw()

	var path_value: Variant = instance.get("waterBottom", {}).get("texture")
	var texture_path: String = path_value.strip_edges() if path_value is String else ""
	if texture_path.is_empty():
		await RuntimeMicrotaskQueueScript.yield_turn()
		return

	var normalized: String = texture_path.substr(1) if texture_path.begins_with("/") else texture_path
	var texture: Variant = asset_manager.load_texture(normalized)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if not texture is Texture2D:
		return
	var sprite := Sprite2D.new()
	sprite.texture = texture
	sprite.centered = false
	sprite.position = Vector2.ZERO
	sprite.scale = bounds / Vector2(texture.get_width(), texture.get_height())
	sprite.modulate.a = 0.9
	bottom_texture_sprite = sprite
	bottom_layer.add_child(sprite)


func _setup_shore_layer() -> void:
	for sprite: Sprite2D in shore_sprites:
		if is_instance_valid(sprite):
			sprite.free()
	shore_sprites = []
	_remove_all_children(shore_layer)

	var shore: Variant = instance.get("shoreForeground")
	var banks: Array = shore.get("banks", []).slice(0, 2) \
		if shore is Dictionary and shore.get("banks") is Array else []
	var yielded := false
	for bank: Dictionary in banks:
		var path_value: Variant = bank.get("sprite")
		var texture_path: String = path_value.strip_edges() if path_value is String else ""
		if texture_path.is_empty():
			continue
		var normalized: String = texture_path.substr(1) if texture_path.begins_with("/") else texture_path
		var texture: Variant = asset_manager.load_texture(normalized)
		await RuntimeMicrotaskQueueScript.yield_turn()
		yielded = true
		if not texture is Texture2D:
			continue
		var sprite := Sprite2D.new()
		sprite.texture = texture
		sprite.centered = false
		var alpha_value: Variant = bank.get("alpha")
		var alpha := float(alpha_value) if alpha_value is int or alpha_value is float else 1.0
		sprite.modulate.a = _clamp01(alpha)
		shore_layer.add_child(sprite)
		shore_sprites.push_back(sprite)
	if not yielded:
		await RuntimeMicrotaskQueueScript.yield_turn()


func _clamp01(value: float) -> float:
	return maxf(0.0, minf(1.0, value)) if is_finite(value) else 1.0


func _filter_defs(definitions: Array) -> Array:
	if not degraded:
		return definitions
	return definitions.filter(func(definition: Dictionary) -> bool: return definition.get("valueTier") != "premium")


func _ambient() -> Dictionary:
	return {"time": instance.surface.time, "weather": instance.surface.weather}


func _layout() -> void:
	var screen_width := float(renderer.screen_width)
	var screen_height := float(renderer.screen_height)
	var screen := Vector2(screen_width, screen_height)
	root.position = Vector2.ZERO
	root.size = screen
	bg.size = screen

	var bounds_width := float(instance.bounds.width)
	var bounds_height := float(instance.bounds.height)
	var bounds := Vector2(bounds_width, bounds_height)
	var scale := minf(screen_width / bounds_width, screen_height / bounds_height) * 0.92
	var offset_x := (screen_width - bounds_width * scale) / 2.0
	var offset_y := (screen_height - bounds_height * scale) / 2.0
	var offset := Vector2(offset_x, offset_y)

	var texture_width := maxi(256, mini(960, int(floor(bounds_width * scale))))
	var texture_height := maxi(192, mini(720, int(floor(bounds_height * scale))))
	if bottom_mrt.size != Vector2i(texture_width, texture_height):
		bottom_mrt.size = Vector2i(texture_width, texture_height)
	if params_mrt.size != Vector2i(texture_width, texture_height):
		params_mrt.size = Vector2i(texture_width, texture_height)

	var mrt_scale_x := float(texture_width) / maxf(1.0, bounds_width)
	var mrt_scale_y := float(texture_height) / maxf(1.0, bounds_height)
	bottom_layer.scale = Vector2.ONE
	bottom_layer.position = Vector2.ZERO
	water_layer.scale = Vector2.ONE
	water_layer.position = Vector2.ZERO
	underwater_rt_root.scale = Vector2(mrt_scale_x, mrt_scale_y)
	underwater_rt_root.position = Vector2.ZERO
	params_rt_root.scale = Vector2(mrt_scale_x, mrt_scale_y)
	params_rt_root.position = Vector2.ZERO

	bottom_mrt_sprite.texture = bottom_mrt.get_texture()
	bottom_mrt_sprite.position = offset
	bottom_mrt_sprite.size = bounds * scale
	water_filter.set_shader_parameter(
		"filter_uv_scale",
		Vector2(
			float(texture_width) / float(_next_power_of_two(texture_width)),
			float(texture_height) / float(_next_power_of_two(texture_height)),
		),
	)

	underwater_hit_zone.position = offset
	underwater_hit_zone.size = bounds * scale
	surface_layer.scale = Vector2.ONE * scale
	surface_layer.position = offset
	shore_layer.scale = Vector2.ONE * scale
	shore_layer.position = offset
	_layout_shore_banks()
	ui_layer.position = Vector2.ZERO
	ui_layer.size = screen

	if pull_panel != null:
		pull_panel.position = Vector2(screen_width - 120.0, screen_height / 2.0 - 140.0)
	if feedback != null:
		feedback.position = Vector2(24.0, screen_height - 72.0)
		feedback.size = Vector2(screen_width - 48.0, 52.0)
	if exit_chrome != null:
		exit_chrome.position = Vector2(screen_width - exit_chrome.size.x - 12.0, 12.0)

	underwater_hit_zone.mouse_filter = Control.MOUSE_FILTER_IGNORE \
		if phase == PULL or root.mouse_filter == Control.MOUSE_FILTER_IGNORE else Control.MOUSE_FILTER_STOP


func _layout_shore_banks() -> void:
	var shore: Variant = instance.get("shoreForeground")
	var banks: Array = shore.get("banks", []).slice(0, 2) \
		if shore is Dictionary and shore.get("banks") is Array else []
	var bounds_width := float(instance.bounds.width)
	var bounds_height := float(instance.bounds.height)
	for index: int in shore_sprites.size():
		var sprite := shore_sprites[index]
		var bank: Variant = banks[index] if index < banks.size() else null
		if not bank is Dictionary:
			sprite.visible = false
			continue
		_layout_shore_bank(sprite, bank, bounds_width, bounds_height)


func _layout_shore_bank(sprite: Sprite2D, bank: Dictionary, bounds_width: float, bounds_height: float) -> void:
	var edge := str(bank.edge)
	var raw_overhang: Variant = bank.get("overhang")
	var overhang := maxf(0.0, float(raw_overhang)) \
		if (raw_overhang is int or raw_overhang is float) and is_finite(float(raw_overhang)) else 40.0
	var raw_inset: Variant = bank.get("inset")
	var inset := float(raw_inset) \
		if (raw_inset is int or raw_inset is float) and is_finite(float(raw_inset)) else 0.0
	var default_thickness := maxf(96.0, bounds_width * 0.18) \
		if edge == "left" or edge == "right" else maxf(96.0, bounds_height * 0.22)
	var raw_thickness: Variant = bank.get("thickness")
	var thickness := float(raw_thickness) \
		if (raw_thickness is int or raw_thickness is float) and is_finite(float(raw_thickness)) and float(raw_thickness) > 0.0 \
		else default_thickness
	var texture_size := Vector2(sprite.texture.get_width(), sprite.texture.get_height())

	if edge == "top" or edge == "bottom":
		sprite.scale = Vector2(bounds_width + overhang * 2.0, thickness) / texture_size
		sprite.position = Vector2(-overhang, inset if edge == "top" else bounds_height - inset)
		sprite.scale.y = absf(sprite.scale.y) * (-1.0 if edge == "top" else 1.0)
		return

	sprite.scale = Vector2(thickness, bounds_height + overhang * 2.0) / texture_size
	sprite.position = Vector2(inset if edge == "left" else bounds_width - inset, -overhang)
	sprite.scale.x = absf(sprite.scale.x) * (-1.0 if edge == "left" else 1.0)


func _cursor_world(screen: Vector2) -> Vector2:
	var bounds_width := float(instance.bounds.width)
	var bounds_height := float(instance.bounds.height)
	var screen_width := float(renderer.screen_width)
	var screen_height := float(renderer.screen_height)
	var scale := minf(screen_width / bounds_width, screen_height / bounds_height) * 0.92
	var offset_x := (screen_width - bounds_width * scale) / 2.0
	var offset_y := (screen_height - bounds_height * scale) / 2.0
	return Vector2((screen.x - offset_x) / scale, (screen.y - offset_y) / scale)


func _on_underwater_pointer_tap(event: InputEventMouseButton) -> void:
	if phase != SEARCH:
		return
	if action_gate.is_locked():
		return
	var cursor := _cursor_world(event.global_position)
	var bounds_width := float(instance.bounds.width)
	var bounds_height := float(instance.bounds.height)
	if cursor.x < 0.0 or cursor.y < 0.0 or cursor.x > bounds_width or cursor.y > bounds_height:
		return

	for index: int in range(entities.size() - 1, -1, -1):
		var entity := entities[index]
		if entity.def.category == "floating":
			continue
		if entity.is_escaped() or not entity.container.visible:
			continue
		var center_x := entity.container.position.x
		var center_y := entity.container.position.y + entity.sprite.position.y
		var radius := entity.hit_radius()
		var delta_x := cursor.x - center_x
		var delta_y := cursor.y - center_y
		if delta_x * delta_x + delta_y * delta_y <= radius * radius:
			_on_entity_tap(entity, event)
			return


func _prepare_underwater_pass(pass_name: String) -> void:
	var color_pass := pass_name == "color"
	bottom_fill.visible = color_pass
	if bottom_texture_sprite != null:
		bottom_texture_sprite.visible = color_pass
	for entity: RuntimeWaterEntity in entities:
		if entity.params_sprite == null:
			continue
		entity.sprite.visible = color_pass
		entity.params_sprite.visible = not color_pass


func is_actions_playback_locked() -> bool:
	return action_gate.is_locked()


func get_debug_visual_state() -> Dictionary:
	return {
		"phase": phase,
		"bounds": instance.get("bounds"),
		"renderTexture": {"width": bottom_mrt.size.x, "height": bottom_mrt.size.y},
		"surface": _water_filter_debug_uniform_state(),
	}


func _set_input_locked(locked: bool) -> void:
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE if locked else Control.MOUSE_FILTER_PASS
	underwater_hit_zone.mouse_filter = Control.MOUSE_FILTER_IGNORE \
		if locked or phase == PULL else Control.MOUSE_FILTER_STOP
	if exit_chrome != null:
		exit_chrome.disabled = locked


func _run_actions(actions: Variant) -> void:
	await action_gate.run(actions)


func _show_feedback(message: String) -> void:
	if feedback == null:
		feedback = Label.new()
		feedback.name = "Feedback"
		feedback.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		feedback.add_theme_font_size_override("font_size", 15)
		feedback.add_theme_color_override("font_color", Color("dbeafe"))
		feedback.mouse_filter = Control.MOUSE_FILTER_IGNORE
		ui_layer.add_child(feedback)
	feedback.text = _resolve_text_value(message)
	_layout()


func _clear_feedback() -> void:
	if feedback != null:
		feedback.free()
		feedback = null


func _clear_exit_ui() -> void:
	if exit_chrome != null:
		exit_chrome.free()
		exit_chrome = null
		exit_panel = null
		exit_title = null
		exit_hint = null


func _build_exit_ui() -> void:
	_clear_exit_ui()
	var padding_x := 14.0
	var padding_y := 10.0
	var gap := 5.0
	var font := SystemFont.new()
	font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"])

	exit_title = Label.new()
	exit_title.text = _resolve_text_value("[tag:string:waterMinigame:exit]")
	exit_title.add_theme_font_override("font", font)
	exit_title.add_theme_font_size_override("font_size", 15)
	exit_title.add_theme_color_override("font_color", Color("f1f5f9"))
	exit_title.mouse_filter = Control.MOUSE_FILTER_IGNORE
	exit_hint = Label.new()
	exit_hint.text = _resolve_text_value("[tag:string:waterMinigame:exitEscHint]")
	exit_hint.add_theme_font_override("font", font)
	exit_hint.add_theme_font_size_override("font_size", 11)
	exit_hint.add_theme_color_override("font_color", Color("94a3b8"))
	exit_hint.mouse_filter = Control.MOUSE_FILTER_IGNORE

	var title_size := font.get_string_size(exit_title.text, HORIZONTAL_ALIGNMENT_LEFT, -1, 15)
	var hint_size := font.get_string_size(exit_hint.text, HORIZONTAL_ALIGNMENT_LEFT, -1, 11)
	var inner_width := maxf(title_size.x, hint_size.x)
	var width := inner_width + padding_x * 2.0
	var height := padding_y * 2.0 + font.get_height(15) + gap + font.get_height(11)

	exit_panel = Panel.new()
	var style := StyleBoxFlat.new()
	style.bg_color = Color("130f0a", 0.8)
	style.border_color = Color("574733")
	style.set_border_width_all(1)
	style.set_corner_radius_all(4)
	exit_panel.add_theme_stylebox_override("panel", style)
	exit_panel.size = Vector2(width, height)
	exit_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	exit_title.position = Vector2(padding_x, padding_y)
	exit_title.size = Vector2(inner_width, font.get_height(15))
	exit_hint.position = Vector2(padding_x, padding_y + font.get_height(15) + gap)
	exit_hint.size = Vector2(inner_width, font.get_height(11))

	exit_chrome = Button.new()
	exit_chrome.name = "ExitChrome"
	exit_chrome.text = ""
	exit_chrome.flat = true
	exit_chrome.size = Vector2(width, height)
	exit_chrome.mouse_filter = Control.MOUSE_FILTER_STOP
	exit_chrome.pressed.connect(Callable(self, "abort"))
	exit_chrome.add_child(exit_panel)
	exit_chrome.add_child(exit_title)
	exit_chrome.add_child(exit_hint)
	ui_layer.add_child(exit_chrome)


func _clear_pull() -> void:
	if pull_panel != null:
		if pull_panel.get_parent() != null:
			pull_panel.get_parent().remove_child(pull_panel)
		pull_panel.queue_free()
		pull_panel = null


func _on_entity_tap(entity: RuntimeWaterEntity, _event: Variant = null) -> void:
	if phase != SEARCH:
		return
	if action_gate.is_locked():
		return
	var definition := entity.def

	if definition.category == "grass":
		_show_feedback(_resolve_text_value(str(definition.get("hint", "[tag:string:waterMinigame:grassDefault]"))))
		return

	if definition.category == "floating":
		_run_floating_pick(entity)
		return

	if (definition.category == "swimming" or definition.category == "sunken") and definition.get("pull") is Dictionary:
		_start_pull(entity)
		return

	_show_feedback(_resolve_text_value(str(definition.get("hint", "[tag:string:waterMinigame:nothingToGrab]"))))


func _start_pull(entity: RuntimeWaterEntity) -> void:
	phase = PULL
	var pull: Dictionary = entity.def.pull
	var raw_time_limit: Variant = pull.get("timeLimitSec")
	var time_limit := float(raw_time_limit) \
		if (raw_time_limit is int or raw_time_limit is float) and float(raw_time_limit) > 0.0 \
		else (14.0 if pull.rhythm == "heavy_sink" else (10.0 if pull.failurePolicy == "snap" else 12.0))

	_clear_pull()
	pull_panel = RuntimeWaterPullPanel.new({
		"zoneSize": float(pull.zoneSize),
		"sliderSpeed": float(pull.sliderSpeed),
		"rhythm": str(pull.rhythm),
		"failurePolicy": str(pull.failurePolicy),
		"timeLimitSec": time_limit,
		"resolveText": resolve_text,
		"random": random,
		"onResult": func(result: String) -> void: _on_pull_end(entity, result),
	})
	ui_layer.add_child(pull_panel)
	_layout()


func _on_pull_end(entity: RuntimeWaterEntity, result: String) -> void:
	_clear_pull()
	phase = SEARCH

	if result == "abort":
		on_finish.call("abort")
		return

	if result == "success":
		await _run_actions(entity.def.get("onPullSuccess"))
		if entity.def.get("consumeOnSuccess") == true:
			_set_entity_visible(entity, false)
			if on_consumed is Callable:
				on_consumed.call(str(instance.id), str(entity.def.id))
		_show_feedback(_fill_token(
			_resolve_text_value("[tag:string:waterMinigame:pullSuccessPrefix]"),
			"{cue}",
			_resolve_text_value(str(entity.def.get("cue", entity.def.id))),
		))
		return

	await _run_actions(entity.def.get("onPullFail"))
	if result == "fail_escape":
		_show_feedback(_resolve_text_value("[tag:string:waterMinigame:pullEscape]"))
		_set_entity_visible(entity, false)
	elif result == "fail_snap":
		_show_feedback(_resolve_text_value("[tag:string:waterMinigame:pullSnap]"))
	else:
		_show_feedback(_resolve_text_value("[tag:string:waterMinigame:pullBite]"))


func abort() -> void:
	if phase == PULL and pull_panel != null:
		pull_panel.abort()
		return
	on_finish.call("abort")


func update(dt: float, mouse_screen: Vector2) -> void:
	time += dt
	_water_filter_set_time(time)
	var ambient := _ambient()
	var cursor := _cursor_world(mouse_screen)

	for entity: RuntimeWaterEntity in entities:
		entity.update(dt, ambient, cursor)

	for grass: RuntimeWaterEntity in entities:
		if grass.def.category != "grass":
			continue
		var magnitude := 0.0
		for swimmer: RuntimeWaterEntity in entities:
			if swimmer.def.category != "swimming":
				continue
			var delta_x := swimmer.container.position.x - grass.container.position.x
			var delta_y := swimmer.container.position.y - grass.container.position.y
			if delta_x * delta_x + delta_y * delta_y < 55.0 * 55.0:
				magnitude += 1.0
		if magnitude > 0.0:
			grass.react_grass(magnitude, 0.0, 0.0)

	if phase == PULL and pull_panel != null:
		pull_panel.set_lift_held(bool(get_key_hold.call()))
		pull_panel.update(dt)

	# Source call order is retained. The Godot host then restores both resident
	# trees because its two SubViewports render automatically rather than on call.
	_prepare_underwater_pass("color")
	_prepare_underwater_pass("params")
	_prepare_underwater_pass("color")
	_restore_separate_pass_visibility()


func destroy() -> void:
	if unsub_resize is Callable and unsub_resize.is_valid():
		unsub_resize.call()
	unsub_resize = null
	_clear_pull()
	_clear_feedback()
	_clear_exit_ui()
	for sprite: Sprite2D in shore_sprites:
		if is_instance_valid(sprite):
			sprite.free()
	shore_sprites = []
	for entity: RuntimeWaterEntity in entities:
		entity.destroy()
	entities = []
	bottom_mrt_sprite.material = null
	water_filter = null
	if is_instance_valid(root):
		root.free()


# ---- Godot-only engine adapters (no independent game-domain state) ----

func _on_pointer_input(event: InputEvent) -> void:
	if not event is InputEventMouseButton or event.button_index != MOUSE_BUTTON_LEFT or not event.pressed:
		return
	var cursor := _cursor_world(event.global_position)
	for index: int in range(entities.size() - 1, -1, -1):
		var entity := entities[index]
		if entity.def.category != "floating" or entity.is_escaped() or not entity.container.visible:
			continue
		if _floating_sprite_contains(entity, cursor):
			entity._emit_pointer_tap(event)
			return
	_on_underwater_pointer_tap(event)


func _floating_sprite_contains(entity: RuntimeWaterEntity, point: Vector2) -> bool:
	var texture := entity.sprite.texture
	if texture == null:
		return false
	var size := Vector2(texture.get_width(), texture.get_height()) * entity.sprite.scale.abs()
	var center := entity.container.position + entity.sprite.position
	return Rect2(center - size * 0.5, size).has_point(point)


func _run_floating_pick(entity: RuntimeWaterEntity) -> void:
	await _run_actions(entity.def.get("onPick"))
	if entity.def.get("consumeOnSuccess") == true:
		_set_entity_visible(entity, false)
		if on_consumed is Callable:
			on_consumed.call(str(instance.id), str(entity.def.id))
	_show_feedback(_fill_token(
		_resolve_text_value("[tag:string:waterMinigame:pickPrefix]"),
		"{cue}",
		_resolve_text_value(str(entity.def.get("cue", entity.def.id))),
	))


func _release_entities_for_reload() -> void:
	for entity: RuntimeWaterEntity in entities:
		entity.destroy()


func _remove_all_children(parent: Node) -> void:
	for child: Node in parent.get_children():
		parent.remove_child(child)
		child.free()


func _set_entity_visible(entity: RuntimeWaterEntity, visible: bool) -> void:
	entity.container.visible = visible
	if entity.params_container != null:
		entity.params_container.visible = visible


func _restore_separate_pass_visibility() -> void:
	bottom_fill.visible = true
	if bottom_texture_sprite != null:
		bottom_texture_sprite.visible = true
	for entity: RuntimeWaterEntity in entities:
		entity.sprite.visible = true
		if entity.params_sprite != null:
			entity.params_sprite.visible = entity.params_container.visible


func _water_filter_set_time(value: float) -> void:
	water_filter.set_shader_parameter("elapsed_time", value)


func _water_filter_apply_surface(time_of_day: String, weather: String) -> void:
	var murk := 0.32
	var rain := 0.0
	var darkness := 0.0
	if weather == "rain":
		murk = 0.62
		rain = 1.0
	elif weather == "fog":
		murk = 0.88
	if time_of_day == "night":
		darkness = 0.38
	elif time_of_day == "morning":
		darkness = 0.08
	water_filter.set_shader_parameter("murk", murk)
	water_filter.set_shader_parameter("rain", rain)
	water_filter.set_shader_parameter("darkness", darkness)
	water_filter.set_shader_parameter("sigma", Vector3(0.85, 1.25, 1.75))
	water_filter.set_shader_parameter("min_alpha", 0.18 if weather == "fog" else 0.1)


func _water_filter_set_water_bottom_depth(depth: float) -> void:
	if is_finite(depth):
		water_filter.set_shader_parameter("water_bottom_depth", maxf(0.0, depth))


func _water_filter_debug_uniform_state() -> Dictionary:
	var sigma: Vector3 = water_filter.get_shader_parameter("sigma")
	return {
		"time": water_filter.get_shader_parameter("elapsed_time"),
		"murk": water_filter.get_shader_parameter("murk"),
		"darkness": water_filter.get_shader_parameter("darkness"),
		"rain": water_filter.get_shader_parameter("rain"),
		"sigma": [sigma.x, sigma.y, sigma.z],
		"minAlpha": water_filter.get_shader_parameter("min_alpha"),
		"waterBottomDepth": water_filter.get_shader_parameter("water_bottom_depth"),
	}


func _draw_bottom_fill(layer: GraphicsLayer) -> void:
	var width := float(instance.get("bounds", {}).get("width", 0.0))
	var height := float(instance.get("bounds", {}).get("height", 0.0))
	layer.draw_rect(Rect2(0.0, 0.0, width, height), _color_from_int(bottom_tint), true)
	var y := 0.0
	while y < height:
		var ratio := y / maxf(1.0, height)
		layer.draw_rect(Rect2(0.0, y, width, 24.0), Color("071421", 0.06 + ratio * 0.16), true)
		y += 48.0
	var x := 0.0
	while x < width:
		layer.draw_line(Vector2(x, 0.0), Vector2(x + 34.0, height), Color("2f5266", 0.16), 1.0)
		x += 64.0


func _color_from_int(value: int) -> Color:
	return Color(
		float((value >> 16) & 255) / 255.0,
		float((value >> 8) & 255) / 255.0,
		float(value & 255) / 255.0,
		1.0,
	)


func _resolve_text_value(raw: String) -> String:
	return str(resolve_text.call(raw))


func _fill_token(text: String, token: String, value: String) -> String:
	var index := text.find(token)
	if index < 0:
		return text
	return text.substr(0, index) + value + text.substr(index + token.length())


func _next_power_of_two(value: int) -> int:
	var result := 1
	while result < maxi(1, value):
		result <<= 1
	return result
