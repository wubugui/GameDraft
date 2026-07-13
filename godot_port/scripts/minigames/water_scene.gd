class_name RuntimeWaterMinigameScene
extends RefCounted

const SEARCH := "search"
const PULL := "pull"
const SURFACE_SHADER := preload("res://scripts/minigames/water_surface.gdshader")

var renderer: RuntimeRenderer
var asset_manager: RuntimeAssetManager
var action_executor: RuntimeActionExecutor
var resolve_text: Callable
var get_hold: Callable
var on_finish: Callable
var on_consumed: Callable
var root := Control.new()
var background := ColorRect.new()
var color_viewport := SubViewport.new()
var params_viewport := SubViewport.new()
var color_world := Node2D.new()
var params_world := Node2D.new()
var bottom_layer := Node2D.new()
var entity_layer := Node2D.new()
var surface_display := TextureRect.new()
var surface_layer := Node2D.new()
var shore_layer := Node2D.new()
var ui_layer := Control.new()
var surface_material := ShaderMaterial.new()
var bottom_texture_rect: Sprite2D
var shore_sprites: Array[Sprite2D] = []
var entities: Array[RuntimeWaterEntity] = []
var phase := SEARCH
var pull_panel: RuntimeWaterPullPanel
var active_pull_entity: RuntimeWaterEntity
var feedback := Label.new()
var exit_button := Button.new()
var exit_panel := Panel.new()
var exit_title := Label.new()
var exit_hint := Label.new()
var elapsed_time := 0.0
var degraded := false
var instance: Dictionary = {}
var action_gate: RuntimeMinigameActionPlaybackGate
var _unsubscribe_resize := Callable()
var _destroyed := false
var _water_scale := 1.0
var _water_offset := Vector2.ZERO
var _random_state := 1


func _init(next_renderer: RuntimeRenderer, assets: RuntimeAssetManager, actions: RuntimeActionExecutor, text_resolver: Callable, hold_provider: Callable, finish_callback: Callable, consumed_callback: Callable = Callable(), restore_state: Callable = Callable()) -> void:
	renderer = next_renderer; asset_manager = assets; action_executor = actions; resolve_text = text_resolver; get_hold = hold_provider; on_finish = finish_callback; on_consumed = consumed_callback
	root.name = "WaterMinigameScene"; root.mouse_filter = Control.MOUSE_FILTER_STOP; root.gui_input.connect(Callable(self, "_on_root_gui_input")); background.color = Color("0b1220"); background.mouse_filter = Control.MOUSE_FILTER_IGNORE
	color_viewport.name = "WaterColorViewport"; color_viewport.disable_3d = true; color_viewport.transparent_bg = false; color_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS; color_viewport.add_child(color_world); color_world.add_child(bottom_layer); color_world.add_child(entity_layer)
	params_viewport.name = "WaterParamsViewport"; params_viewport.disable_3d = true; params_viewport.transparent_bg = true; params_viewport.render_target_update_mode = SubViewport.UPDATE_ALWAYS; params_viewport.add_child(params_world)
	surface_display.name = "WaterSurface"; surface_display.expand_mode = TextureRect.EXPAND_IGNORE_SIZE; surface_display.stretch_mode = TextureRect.STRETCH_SCALE; surface_display.mouse_filter = Control.MOUSE_FILTER_IGNORE; surface_material.shader = SURFACE_SHADER; surface_display.material = surface_material
	surface_layer.name = "FloatingEntities"; shore_layer.name = "ShoreForeground"; ui_layer.name = "WaterUI"; ui_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	feedback.name = "Feedback"; feedback.visible = false; feedback.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; feedback.add_theme_font_size_override("font_size", 15); feedback.add_theme_color_override("font_color", Color("dbeafe")); feedback.mouse_filter = Control.MOUSE_FILTER_IGNORE
	exit_button.name = "Exit"; exit_button.text = ""; exit_button.flat = true; exit_button.size = Vector2(95, 54); exit_button.pressed.connect(Callable(self, "abort")); exit_button.mouse_filter = Control.MOUSE_FILTER_STOP
	var exit_style := StyleBoxFlat.new(); exit_style.bg_color = Color("130f0a", 0.8); exit_style.border_color = Color("574733"); exit_style.set_border_width_all(1); exit_style.set_corner_radius_all(4); exit_panel.add_theme_stylebox_override("panel", exit_style); exit_panel.size = exit_button.size; exit_panel.mouse_filter = Control.MOUSE_FILTER_IGNORE; exit_button.add_child(exit_panel)
	var exit_font := SystemFont.new(); exit_font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"])
	exit_title.text = _text("[tag:string:waterMinigame:exit]"); exit_title.position = Vector2(14, 8); exit_title.size = Vector2(67, 20); exit_title.add_theme_font_override("font", exit_font); exit_title.add_theme_font_size_override("font_size", 15); exit_title.add_theme_color_override("font_color", Color("f1f5f9")); exit_title.mouse_filter = Control.MOUSE_FILTER_IGNORE; exit_button.add_child(exit_title)
	exit_hint.text = _text("[tag:string:waterMinigame:exitEscHint]"); exit_hint.position = Vector2(14, 32); exit_hint.size = Vector2(67, 16); exit_hint.add_theme_font_override("font", exit_font); exit_hint.add_theme_font_size_override("font_size", 11); exit_hint.add_theme_color_override("font_color", Color("94a3b8")); exit_hint.mouse_filter = Control.MOUSE_FILTER_IGNORE; exit_button.add_child(exit_hint)
	ui_layer.add_child(feedback); ui_layer.add_child(exit_button); root.add_child(background); root.add_child(color_viewport); root.add_child(params_viewport); root.add_child(surface_display); root.add_child(surface_layer); root.add_child(shore_layer); root.add_child(ui_layer)
	action_gate = RuntimeMinigameActionPlaybackGate.new(Callable(action_executor, "execute_batch_await"), {"onLockChanged": Callable(self, "_set_input_locked"), "restoreMinigameState": restore_state})
	_unsubscribe_resize = renderer.subscribe_after_resize(Callable(self, "layout"))


func get_root() -> Control: return root
func get_phase() -> String: return phase
func get_feedback_text() -> String: return feedback.text if feedback.visible else ""
func is_actions_playback_locked() -> bool: return action_gate.is_locked()
func is_degraded() -> bool: return degraded
func get_entity_count() -> int: return entities.size()


func get_debug_visual_state() -> Dictionary:
	var bounds := Vector2(float(instance.get("bounds", {}).get("width", 0)), float(instance.get("bounds", {}).get("height", 0)))
	var filter_width := maxi(256, mini(960, int(floor(bounds.x * _water_scale))))
	var filter_height := maxi(192, mini(720, int(floor(bounds.y * _water_scale))))
	var time_of_day := str(instance.get("surface", {}).get("time", "day")); var weather := str(instance.get("surface", {}).get("weather", "clear")); var murk := 0.32; var rain := 0.0; var darkness := 0.0
	if weather == "rain": murk = 0.62; rain = 1.0
	elif weather == "fog": murk = 0.88
	if time_of_day == "night": darkness = 0.38
	elif time_of_day == "morning": darkness = 0.08
	var sigma32 := PackedFloat32Array([0.85, 1.25, 1.75])
	return {
		"phase": phase,
		"bounds": {"width": int(bounds.x), "height": int(bounds.y)},
		"renderTexture": {"width": filter_width, "height": filter_height},
		"surface": {
			"time": elapsed_time,
			"murk": murk,
			"darkness": darkness,
			"rain": rain,
			"sigma": [sigma32[0], sigma32[1], sigma32[2]],
			"minAlpha": 0.18 if weather == "fog" else 0.1,
			"waterBottomDepth": maxf(0.0, float(instance.get("waterBottom", {}).get("depth", 1.0))),
		},
	}


func get_visible_entity_ids() -> Array[String]:
	var result: Array[String] = []
	for entity: RuntimeWaterEntity in entities: if entity.is_visible(): result.push_back(str(entity.def.id))
	return result


func get_entity(id: String) -> RuntimeWaterEntity:
	for entity: RuntimeWaterEntity in entities: if str(entity.def.get("id", "")) == id: return entity
	return null


func load(next_instance: Dictionary, options: Dictionary = {}) -> bool:
	if not next_instance.get("bounds") is Dictionary or not next_instance.get("surface") is Dictionary or not next_instance.get("entities") is Array: return false
	instance = next_instance.duplicate(true); _seed_random(str(instance.get("id", ""))); degraded = options.get("degraded") == true; elapsed_time = 0.0; phase = SEARCH; _clear_pull(); feedback.visible = false; feedback.text = ""
	for entity: RuntimeWaterEntity in entities:
		entity.destroy()
	entities.clear()
	for color_child: Node in entity_layer.get_children():
		entity_layer.remove_child(color_child)
		color_child.free()
	for params_child: Node in params_world.get_children():
		params_world.remove_child(params_child)
		params_child.free()
	for surface_child: Node in surface_layer.get_children():
		surface_layer.remove_child(surface_child)
		surface_child.free()
	await _setup_bottom(); await _setup_shores()
	var definitions: Array = instance.entities.filter(func(value: Variant) -> bool: return value is Dictionary and (not degraded or value.get("valueTier") != "premium"))
	for value: Variant in definitions:
		var definition: Dictionary = value; var texture := _load_texture_or_white(str(definition.get("sprite", ""))); var entity := RuntimeWaterEntity.new(definition, texture, definition.get("category") != "floating", Callable(self, "_next_random")); entity.set_flee_deadline(25.0)
		if definition.get("category") == "floating": surface_layer.add_child(entity.container)
		else:
			entity_layer.add_child(entity.container)
			if entity.params_container != null: params_world.add_child(entity.params_container)
		entities.push_back(entity)
	_apply_surface_shader(); layout(); await Engine.get_main_loop().process_frame
	return not _destroyed


func update(dt: float, mouse_screen: Vector2) -> void:
	if _destroyed or instance.is_empty(): return
	elapsed_time += maxf(0.0, dt); surface_material.set_shader_parameter("elapsed_time", elapsed_time); var ambient := {"time": str(instance.surface.get("time", "day")), "weather": str(instance.surface.get("weather", "clear"))}; var cursor := _screen_to_world(mouse_screen)
	for entity: RuntimeWaterEntity in entities: entity.update(dt, ambient, cursor)
	for grass: RuntimeWaterEntity in entities:
		if grass.category != "grass": continue
		for swimmer: RuntimeWaterEntity in entities:
			if swimmer.category == "swimming" and swimmer.container.position.distance_squared_to(grass.container.position) < 55.0 * 55.0: grass.react_grass(); break
	if phase == PULL and pull_panel != null:
		pull_panel.set_lift_held(bool(get_hold.call()) if get_hold.is_valid() else false); pull_panel.update(dt)


func abort() -> void:
	if is_actions_playback_locked(): return
	if phase == PULL and pull_panel != null: pull_panel.abort(); return
	if on_finish.is_valid(): on_finish.call("abort")


func debug_tap_entity(id: String) -> void:
	var entity := get_entity(id)
	if entity != null: await _on_entity_tap(entity)


func debug_finish_pull(result: String) -> void:
	if pull_panel != null: pull_panel.debug_finish(result)


func _on_root_gui_input(event: InputEvent) -> void:
	if phase != SEARCH or is_actions_playback_locked(): return
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
		var world := _screen_to_world(event.position); var bounds := Rect2(Vector2.ZERO, Vector2(float(instance.bounds.width), float(instance.bounds.height)))
		if not bounds.has_point(world): return
		for index: int in range(entities.size() - 1, -1, -1):
			var entity: RuntimeWaterEntity = entities[index]
			if entity.is_escaped() or not entity.is_visible(): continue
			if world.distance_squared_to(entity.hit_center()) <= pow(entity.hit_radius(), 2): get_tree_process_frame().connect(Callable(self, "_on_entity_tap").bind(entity), CONNECT_ONE_SHOT); return


func _on_entity_tap(entity: RuntimeWaterEntity) -> void:
	if phase != SEARCH or is_actions_playback_locked() or not entity.is_visible(): return
	var definition := entity.def
	if entity.category == "grass": _show_feedback(str(definition.get("hint", "[tag:string:waterMinigame:grassDefault]"))); return
	if entity.category == "floating":
		await _run_actions(_action_list(definition.get("onPick")))
		if definition.get("consumeOnSuccess") == true: entity.set_visible(false); _mark_consumed(str(definition.id))
		_show_feedback(_text("[tag:string:waterMinigame:pickPrefix]").replace("{cue}", _text(str(definition.get("cue", definition.id))))); return
	if entity.category in ["swimming", "sunken"] and definition.get("pull") is Dictionary: _start_pull(entity); return
	_show_feedback(str(definition.get("hint", "[tag:string:waterMinigame:nothingToGrab]")))


func _start_pull(entity: RuntimeWaterEntity) -> void:
	phase = PULL; active_pull_entity = entity; var pull: Dictionary = entity.def.pull; var default_limit := 14.0 if pull.get("rhythm") == "heavy_sink" else (10.0 if pull.get("failurePolicy") == "snap" else 12.0); var limit := float(pull.get("timeLimitSec", default_limit)); _clear_pull()
	pull_panel = RuntimeWaterPullPanel.new({"zoneSize": float(pull.get("zoneSize", 0.18)), "sliderSpeed": float(pull.get("sliderSpeed", 0.75)), "rhythm": str(pull.get("rhythm", "stable")), "failurePolicy": str(pull.get("failurePolicy", "escape")), "timeLimitSec": limit, "resolveText": resolve_text, "onResult": Callable(self, "_on_pull_end").bind(entity)}, Callable(self, "_next_random")); ui_layer.add_child(pull_panel); layout()


func _seed_random(id: String) -> void:
	var hash := 0x811c9dc5
	for byte: int in id.to_utf8_buffer(): hash = ((hash ^ byte) * 0x01000193) & 0xffffffff
	_random_state = hash if hash != 0 else 1


func _next_random() -> float:
	var x: int = _random_state & 0xffffffff
	x = (x ^ ((x << 13) & 0xffffffff)) & 0xffffffff
	x = (x ^ (x >> 17)) & 0xffffffff
	x = (x ^ ((x << 5) & 0xffffffff)) & 0xffffffff
	_random_state = x
	return float(x) / 4294967296.0


func _on_pull_end(result: String, entity: RuntimeWaterEntity) -> void:
	_clear_pull(); phase = SEARCH; active_pull_entity = null
	if result == "abort": if on_finish.is_valid(): on_finish.call("abort"); return
	if result == "success":
		await _run_actions(_action_list(entity.def.get("onPullSuccess")))
		if entity.def.get("consumeOnSuccess") == true: entity.set_visible(false); _mark_consumed(str(entity.def.id))
		_show_feedback(_text("[tag:string:waterMinigame:pullSuccessPrefix]").replace("{cue}", _text(str(entity.def.get("cue", entity.def.id))))); return
	await _run_actions(_action_list(entity.def.get("onPullFail")))
	if result == "fail_escape": _show_feedback("[tag:string:waterMinigame:pullEscape]"); entity.set_visible(false)
	elif result == "fail_snap": _show_feedback("[tag:string:waterMinigame:pullSnap]")
	else: _show_feedback("[tag:string:waterMinigame:pullBite]")


func layout() -> void:
	if _destroyed or instance.is_empty(): return
	var screen := Vector2(renderer.get_screen_width(), renderer.get_screen_height()); root.size = screen; background.size = screen; ui_layer.size = screen; var bounds := Vector2(float(instance.bounds.width), float(instance.bounds.height)); _water_scale = minf(screen.x / bounds.x, screen.y / bounds.y) * 0.92; _water_offset = (screen - bounds * _water_scale) / 2.0
	var filter_width := maxi(256, mini(960, int(floor(bounds.x * _water_scale)))); var filter_height := maxi(192, mini(720, int(floor(bounds.y * _water_scale)))); surface_material.set_shader_parameter("filter_uv_scale", Vector2(float(filter_width) / _next_power_of_two(filter_width), float(filter_height) / _next_power_of_two(filter_height)))
	surface_display.position = _water_offset; surface_display.size = bounds * _water_scale; surface_layer.position = _water_offset; surface_layer.scale = Vector2.ONE * _water_scale; shore_layer.position = _water_offset; shore_layer.scale = Vector2.ONE * _water_scale; _layout_shores()
	exit_button.position = Vector2(screen.x - exit_button.size.x - 12, 12); feedback.position = Vector2(24, screen.y - 72); feedback.size = Vector2(screen.x - 48, 52)
	if pull_panel != null: pull_panel.position = Vector2(screen.x - 120, screen.y / 2.0 - 140)


func _setup_bottom() -> void:
	for child: Node in bottom_layer.get_children(): bottom_layer.remove_child(child); child.free()
	bottom_texture_rect = null
	var bounds := Vector2(float(instance.bounds.width), float(instance.bounds.height)); var fill := ColorRect.new(); fill.color = Color.from_string(str(instance.get("waterBottom", {}).get("tint", "#18324a")), Color("18324a")); fill.size = bounds; fill.mouse_filter = Control.MOUSE_FILTER_IGNORE; bottom_layer.add_child(fill)
	var path := str(instance.get("waterBottom", {}).get("texture", "")).strip_edges()
	if not path.is_empty():
		bottom_texture_rect = Sprite2D.new(); bottom_texture_rect.texture = asset_manager.load_texture(path); bottom_texture_rect.position = Vector2.ZERO; bottom_texture_rect.centered = false; bottom_texture_rect.modulate.a = 0.9
		if bottom_texture_rect.texture != null:
			var texture_size := Vector2(bottom_texture_rect.texture.get_width(), bottom_texture_rect.texture.get_height()); bottom_texture_rect.scale = bounds / texture_size
		bottom_layer.add_child(bottom_texture_rect)
	color_viewport.size = Vector2i(maxi(1, int(bounds.x)), maxi(1, int(bounds.y))); params_viewport.size = color_viewport.size; surface_display.texture = color_viewport.get_texture(); surface_material.set_shader_parameter("params_texture", params_viewport.get_texture())
	await Engine.get_main_loop().process_frame


func _setup_shores() -> void:
	for sprite: Sprite2D in shore_sprites: if is_instance_valid(sprite): sprite.free()
	shore_sprites.clear(); for child: Node in shore_layer.get_children(): shore_layer.remove_child(child); child.free()
	var shore: Variant = instance.get("shoreForeground"); var banks: Array = shore.get("banks", []).slice(0, 2) if shore is Dictionary and shore.get("banks") is Array else []
	for value: Variant in banks:
		if not value is Dictionary: continue
		var texture: Variant = asset_manager.load_texture(str(value.get("sprite", "")))
		if texture is Texture2D: var sprite := Sprite2D.new(); sprite.texture = texture; sprite.centered = false; sprite.modulate.a = clampf(float(value.get("alpha", 1.0)), 0.0, 1.0); sprite.set_meta("bank", value.duplicate(true)); shore_layer.add_child(sprite); shore_sprites.push_back(sprite)
	await Engine.get_main_loop().process_frame


func _layout_shores() -> void:
	var bounds := Vector2(float(instance.bounds.width), float(instance.bounds.height))
	for sprite: Sprite2D in shore_sprites:
		var bank: Dictionary = sprite.get_meta("bank"); var edge := str(bank.get("edge", "top")); var overhang := maxf(0.0, float(bank.get("overhang", 40.0))); var inset := float(bank.get("inset", 0.0)); var default_thickness := maxf(96.0, bounds.x * 0.18) if edge in ["left", "right"] else maxf(96.0, bounds.y * 0.22); var thickness := float(bank.get("thickness", default_thickness)); var texture_size := Vector2(sprite.texture.get_width(), sprite.texture.get_height())
		if edge in ["top", "bottom"]:
			var horizontal_size := Vector2(bounds.x + overhang * 2.0, thickness)
			sprite.scale = horizontal_size / texture_size
			sprite.position = Vector2(-overhang, inset if edge == "top" else bounds.y - inset)
			if edge == "top":
				sprite.scale.y *= -1
		else:
			var vertical_size := Vector2(thickness, bounds.y + overhang * 2.0)
			sprite.scale = vertical_size / texture_size
			sprite.position = Vector2(inset if edge == "left" else bounds.x - inset, -overhang)
			if edge == "left":
				sprite.scale.x *= -1


func _apply_surface_shader() -> void:
	var time_of_day := str(instance.surface.get("time", "day")); var weather := str(instance.surface.get("weather", "clear")); var murk := 0.32; var rain := 0.0; var darkness := 0.0
	if weather == "rain": murk = 0.62; rain = 1.0
	elif weather == "fog": murk = 0.88
	if time_of_day == "night": darkness = 0.38
	elif time_of_day == "morning": darkness = 0.08
	surface_material.set_shader_parameter("murk", murk); surface_material.set_shader_parameter("rain", rain); surface_material.set_shader_parameter("darkness", darkness); surface_material.set_shader_parameter("min_alpha", 0.18 if weather == "fog" else 0.1); surface_material.set_shader_parameter("water_bottom_depth", maxf(0.0, float(instance.get("waterBottom", {}).get("depth", 1.0))))


func _screen_to_world(position: Vector2) -> Vector2: return (position - _water_offset) / maxf(1e-6, _water_scale)
func _next_power_of_two(value: int) -> int:
	var result := 1
	while result < maxi(1, value): result <<= 1
	return result
func _show_feedback(raw: String) -> void: feedback.text = _text(raw); feedback.visible = true; layout()
func _mark_consumed(entity_id: String) -> void: if on_consumed.is_valid(): on_consumed.call(str(instance.id), entity_id)
func _set_input_locked(locked: bool) -> void: exit_button.disabled = locked; root.mouse_filter = Control.MOUSE_FILTER_IGNORE if locked else Control.MOUSE_FILTER_STOP
func _run_actions(actions: Array) -> void: if not actions.is_empty(): await action_gate.run(actions)
func _action_list(raw: Variant) -> Array: return raw if raw is Array else []
func _text(raw: String) -> String: return str(resolve_text.call(raw)) if resolve_text.is_valid() else raw
func get_tree_process_frame() -> Signal: return Engine.get_main_loop().process_frame


func _load_texture_or_white(path: String) -> Texture2D:
	var texture: Variant = asset_manager.load_texture(path)
	if texture is Texture2D: return texture
	var image := Image.create_empty(2, 2, false, Image.FORMAT_RGBA8); image.fill(Color.WHITE); return ImageTexture.create_from_image(image)


func _clear_pull() -> void:
	if pull_panel != null and is_instance_valid(pull_panel):
		if pull_panel.get_parent() != null:
			pull_panel.get_parent().remove_child(pull_panel)
		pull_panel.queue_free()
	pull_panel = null


func destroy() -> void:
	if _destroyed: return
	_destroyed = true; _clear_pull()
	if not _unsubscribe_resize.is_null() and _unsubscribe_resize.is_valid(): _unsubscribe_resize.call()
	_unsubscribe_resize = Callable()
	for entity: RuntimeWaterEntity in entities: entity.destroy()
	entities.clear(); surface_display.material = null; surface_material = null
	if is_instance_valid(root): root.free()
