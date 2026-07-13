class_name RuntimeSugarWheelMinigameScene
extends RefCounted

const IDLE := "idle"
const CHARGING := "charging"
const LAUNCHING := "launching"
const SPINNING := "spinning"
const LANDING := "landing"
const RESULT := "result"
const DEBUG_ALERT_ACTION_PARAMS := "debugAlertActionParams"
const ART_COMPOSITE_SHADER := preload("res://scripts/rendering/pixi_half_pixel_composite.gdshader")

class WheelOverlay:
	extends Node2D
	var scene_owner: Variant
	func _draw() -> void:
		if scene_owner != null: scene_owner.draw_wheel_overlay(self)


var renderer: RuntimeRenderer
var asset_manager: RuntimeAssetManager
var action_executor: RuntimeActionExecutor
var resolve_text: Callable
var on_result: Callable
var on_close: Callable
var debug_log: Callable
var evaluate_condition: Callable
var play_sfx: Callable

var root := Control.new()
var art_stack := CanvasGroup.new()
var background: TextureRect
var foreground: TextureRect
var wheel_layer := Node2D.new()
var wheel_sprite := Sprite2D.new()
var pointer_sprite := Sprite2D.new()
var wheel_overlay := WheelOverlay.new()
var ui_layer := Control.new()
var charge_button := Button.new()
var close_button := Button.new()
var hint_label := Label.new()
var result_banner := PanelContainer.new()
var result_label := Label.new()
var speech_layer := Control.new()
var confirm_layer := Control.new()
var confirm_panel := Panel.new()
var confirm_yes := Button.new()
var confirm_no := Button.new()
var debug_hud := Label.new()

var instance: Dictionary = {}
var phase := IDLE
var charge_elapsed := 0.0
var spin_omega := 0.0
var spin_alpha := 0.0
var spin_settle_accum := 0.0
var last_result: Variant = null
var dragging_pointer := false
var geom_debug_visible := false
var wheel_geom_radius_px := 0.0
var confirm_visible := false
var charge_press_requested := false
var charge_pointer_held := false
var charge_release_requested := false
var launch_in_progress := false
var pending_charge_pass_actions: Array = []
var last_spin_tick_sector_index := -1
var last_spin_tick_at_ms := 0
var result_banner_elapsed := 0.0
var speech_entries: Array[Dictionary] = []
var atmosphere: RuntimeSugarWheelAtmosphereScheduler
var last_atmosphere_phase: Variant = null
var action_gate: RuntimeMinigameActionPlaybackGate
var _unsubscribe_resize := Callable()
var _destroyed := false


func _init(next_renderer: RuntimeRenderer, assets: RuntimeAssetManager, actions: RuntimeActionExecutor, text_resolver: Callable, result_callback: Callable, close_callback: Callable, next_debug_log: Callable = Callable(), condition_callback: Callable = Callable(), sfx_callback: Callable = Callable(), restore_state: Callable = Callable()) -> void:
	renderer = next_renderer; asset_manager = assets; action_executor = actions; resolve_text = text_resolver; on_result = result_callback; on_close = close_callback; debug_log = next_debug_log; evaluate_condition = condition_callback; play_sfx = sfx_callback
	root.name = "SugarWheelMinigameScene"; root.mouse_filter = Control.MOUSE_FILTER_STOP; root.gui_input.connect(Callable(self, "_on_root_gui_input"))
	art_stack.name = "ArtStack"
	art_stack.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	art_stack.fit_margin = 1.0
	art_stack.clear_margin = 1.0
	var art_material := ShaderMaterial.new()
	art_material.shader = ART_COMPOSITE_SHADER
	art_stack.material = art_material
	wheel_layer.name = "WheelLayer"; wheel_sprite.name = "Wheel"; pointer_sprite.name = "Pointer"; wheel_overlay.name = "WheelOverlay"; wheel_overlay.scene_owner = self
	# Pixi sprites use linear texture sampling.  Do not inherit the project-wide
	# CanvasItem default here: high-frequency wheel/background art otherwise uses
	# nearest sampling in Godot and the same source PNG renders with higher contrast.
	wheel_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	pointer_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	wheel_layer.add_child(wheel_sprite); wheel_layer.add_child(wheel_overlay); wheel_layer.add_child(pointer_sprite)
	ui_layer.name = "SugarWheelUI"; ui_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var bold_ui_font := _system_ui_font(700)
	var regular_ui_font := _system_ui_font(400)
	charge_button.name = "ChargeButton"; charge_button.text = _text("[tag:string:sugarWheel:chargeGlyph]"); charge_button.add_theme_font_override("font", bold_ui_font); charge_button.gui_input.connect(Callable(self, "_on_charge_gui_input")); charge_button.mouse_filter = Control.MOUSE_FILTER_STOP
	close_button.name = "CloseButton"; close_button.text = "×"; close_button.add_theme_font_override("font", bold_ui_font); close_button.pressed.connect(Callable(self, "request_close")); close_button.mouse_filter = Control.MOUSE_FILTER_STOP
	hint_label.text = _text("[tag:string:sugarWheel:hint]") + (" · D 调试(几何+气泡测试)" if OS.is_debug_build() else ""); hint_label.add_theme_font_override("font", regular_ui_font); hint_label.add_theme_font_size_override("font_size", 13); hint_label.add_theme_color_override("font_color", Color("aaaacc")); hint_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_style_circle_button(charge_button, 52.0, "3a2e1e", "6b5636", 0.88, 17)
	_style_circle_button(close_button, 32.0, "222233", "553333", 0.72, 22)
	result_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; result_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER; result_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; result_label.add_theme_font_size_override("font_size", 22); result_label.add_theme_color_override("font_color", Color("e2b96f")); result_banner.add_child(result_label); result_banner.visible = false; result_banner.mouse_filter = Control.MOUSE_FILTER_IGNORE
	speech_layer.name = "SpeechLayer"; speech_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	debug_hud.name = "GeometryDebugHUD"; debug_hud.visible = false; debug_hud.add_theme_font_size_override("font_size", 12); debug_hud.add_theme_color_override("font_color", Color("ccffee")); debug_hud.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_build_confirm_dialog()
	ui_layer.add_child(result_banner); ui_layer.add_child(charge_button); ui_layer.add_child(close_button); ui_layer.add_child(hint_label); ui_layer.add_child(speech_layer); ui_layer.add_child(debug_hud); ui_layer.add_child(confirm_layer)
	art_stack.add_child(wheel_layer); root.add_child(art_stack); root.add_child(ui_layer)
	action_gate = RuntimeMinigameActionPlaybackGate.new(Callable(action_executor, "execute_batch_await"), {"onLockChanged": Callable(self, "_on_actions_lock_changed"), "restoreMinigameState": restore_state})
	atmosphere = RuntimeSugarWheelAtmosphereScheduler.new({"showSpeech": Callable(self, "show_speech"), "getWheelGeomAngleMod": Callable(self, "get_wheel_geom_angle_mod"), "getSpinOmega": Callable(self, "get_spin_omega"), "getInstance": Callable(self, "get_instance")})
	_unsubscribe_resize = renderer.subscribe_after_resize(Callable(self, "layout"))


func get_root() -> Control: return root
func get_phase() -> String: return phase
func get_spin_omega() -> float: return spin_omega
func get_instance() -> Dictionary: return instance
func get_last_result() -> Variant: return last_result
func get_speech_count() -> int: return speech_entries.size()
func is_confirm_visible() -> bool: return confirm_visible
func is_actions_playback_locked() -> bool: return action_gate.is_locked()


func get_debug_visual_state() -> Dictionary:
	return {
		"instanceId": str(instance.get("id", "")),
		"phase": phase,
		"sectorCount": instance.get("sectors", []).size(),
		"pointerGeomAngleRad": get_wheel_geom_angle_mod() if pointer_sprite.texture != null else 0.0,
		"spinOmega": spin_omega,
		"spinAlpha": spin_alpha,
		"chargeElapsed": charge_elapsed,
		"speechCount": speech_entries.size(),
		"confirmVisible": confirm_visible,
		"actionsPlaybackLocked": is_actions_playback_locked(),
		"geomDebugVisible": geom_debug_visible,
		"lastResult": last_result,
	}


func load(next_instance: Dictionary) -> bool:
	if not next_instance.get("sectors") is Array or next_instance.sectors.is_empty(): return false
	instance = next_instance.duplicate(true); phase = IDLE; charge_elapsed = 0.0; spin_omega = 0.0; spin_alpha = 0.0; spin_settle_accum = 0.0; last_result = null; dragging_pointer = false; confirm_visible = false; charge_press_requested = false; charge_pointer_held = false; charge_release_requested = false; launch_in_progress = false; pending_charge_pass_actions.clear(); dismiss_all_speech(); _clear_result_banner()
	if background != null and is_instance_valid(background): art_stack.remove_child(background); background.free(); background = null
	if foreground != null and is_instance_valid(foreground): art_stack.remove_child(foreground); foreground.free(); foreground = null
	var background_path := str(instance.get("backgroundImage", "")).strip_edges()
	if not background_path.is_empty(): background = _make_image_layer(asset_manager.load_texture(background_path), str(instance.get("backgroundFit", "cover"))); art_stack.add_child(background); art_stack.move_child(background, 0)
	var wheel_texture: Variant = asset_manager.load_texture(str(instance.get("wheelImage", ""))); var pointer_texture: Variant = asset_manager.load_texture(str(instance.get("pointerImage", "")))
	if not wheel_texture is Texture2D or not pointer_texture is Texture2D: return false
	wheel_sprite.texture = wheel_texture; wheel_sprite.centered = true
	pointer_sprite.texture = pointer_texture; pointer_sprite.centered = false
	pointer_sprite.offset = -Vector2(pointer_texture.get_width() * clampf(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerAnchorX"), 0.5), 0.0, 1.0), pointer_texture.get_height() * clampf(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerAnchorY"), 0.9), 0.55, 1.0))
	pointer_sprite.rotation = _pointer_art_offset()
	var foreground_path := str(instance.get("foregroundImage", "")).strip_edges()
	if not foreground_path.is_empty(): foreground = _make_image_layer(asset_manager.load_texture(foreground_path), str(instance.get("foregroundFit", "cover"))); art_stack.add_child(foreground)
	atmosphere.select_group(instance); last_atmosphere_phase = null; layout(); await Engine.get_main_loop().process_frame
	return not _destroyed


func update(dt: float) -> void:
	if _destroyed: return
	_update_result_banner(dt); _update_speech(dt); _process_charge_input()
	if phase == CHARGING:
		charge_elapsed += maxf(0.0, dt); _process_charge_release(); wheel_overlay.queue_redraw(); return
	var step := clampf(dt, 0.0, 0.05)
	if phase != SPINNING:
		atmosphere.tick(step); return
	var output := RuntimeSugarWheelSpinPhysics.advance_step(instance, spin_omega, spin_alpha, get_wheel_geom_angle_mod(), step)
	spin_omega = output.omega; spin_alpha = output.alpha; pointer_sprite.rotation = float(output.phiGeom) + _pointer_art_offset(); _maybe_play_spin_tick()
	var stop_epsilon := maxf(1e-3, RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinStopSpeedRadPerSec"), 0.06)); var settle_need := maxf(0.0, RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinStopSettleSec"), 0.085))
	if absf(spin_omega) < stop_epsilon:
		spin_settle_accum += step
		if spin_settle_accum >= settle_need: _finish_spin()
	else: spin_settle_accum = 0.0
	var atmos_phase: Variant = RuntimeSugarWheelAtmosphereScheduler.resolve_atmosphere_phase(phase, absf(spin_omega))
	if atmos_phase != null and atmos_phase != last_atmosphere_phase: atmosphere.notify_phase(str(atmos_phase)); last_atmosphere_phase = atmos_phase
	atmosphere.tick(step); wheel_overlay.queue_redraw(); _update_debug_hud()


func abort() -> void:
	if is_actions_playback_locked(): return
	if confirm_visible: dismiss_close(); return
	request_close()


func request_close() -> void:
	if is_actions_playback_locked() or confirm_visible: return
	if phase == CHARGING: _cancel_charge()
	confirm_visible = true; confirm_layer.visible = true


func accept_close() -> void:
	if not confirm_visible: return
	confirm_visible = false; confirm_layer.visible = false
	if on_close.is_valid(): on_close.call()


func dismiss_close() -> void:
	if not confirm_visible: return
	confirm_visible = false; confirm_layer.visible = false


func show_speech(role: String, text: String, duration_ms: Variant = null) -> void:
	if instance.is_empty(): return
	var resolved := _text(text)
	if resolved.strip_edges().is_empty(): _debug("showSpeech: 解析后文案为空（role=%s）" % role); return
	dismiss_speech(role)
	var anchor := _resolve_speech_anchor(role); var panel := PanelContainer.new(); panel.name = "Speech_%s" % role; panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var box := VBoxContainer.new(); var label_name := str(anchor.get("label", ""));
	if not label_name.is_empty() and role != "protagonist": var name_label := Label.new(); name_label.text = _text(label_name); name_label.add_theme_font_size_override("font_size", 11); name_label.add_theme_color_override("font_color", Color("ead9cb")); box.add_child(name_label)
	var body := Label.new(); body.text = resolved; body.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART; body.custom_minimum_size.x = 240 if role == "protagonist" else 160; body.add_theme_font_size_override("font_size", 15 if role == "protagonist" else 13); box.add_child(body); panel.add_child(box)
	panel.position = Vector2(renderer.get_screen_width() * RuntimeSugarWheelSpinPhysics.finite_or(anchor.get("xRatio"), 0.5), renderer.get_screen_height() * RuntimeSugarWheelSpinPhysics.finite_or(anchor.get("yRatio"), 0.85)); speech_layer.add_child(panel)
	var hold := maxf(500.0, float(duration_ms) if (duration_ms is int or duration_ms is float) and is_finite(float(duration_ms)) else RuntimeSugarWheelSpinPhysics.finite_or(instance.get("speechDurationMs"), 3000.0))
	panel.modulate.a = 0.0; panel.scale = Vector2(0.9, 0.9); speech_entries.push_back({"role": role, "node": panel, "elapsed": 0.0, "holdMs": hold})


func dismiss_speech(role: String) -> void:
	for index: int in range(speech_entries.size() - 1, -1, -1):
		if str(speech_entries[index].role) == role: _remove_speech(index)


func dismiss_all_speech() -> void:
	while not speech_entries.is_empty(): _remove_speech(0)


func reset_pointer_geom_angle_deg(angle_deg: float) -> void:
	if pointer_sprite.texture == null or not is_finite(angle_deg) or phase not in [IDLE, RESULT]: return
	pointer_sprite.rotation = RuntimeSugarWheelSpinPhysics.normalize_angle(RuntimeSugarWheelSpinPhysics.deg_to_rad(angle_deg)) + _pointer_art_offset(); wheel_overlay.queue_redraw(); _update_debug_hud()


func get_wheel_geom_angle_mod() -> float:
	return RuntimeSugarWheelSpinPhysics.normalize_angle(pointer_sprite.rotation - _pointer_art_offset())


func toggle_geom_debug_overlay() -> void:
	if is_actions_playback_locked(): return
	geom_debug_visible = not geom_debug_visible; debug_hud.visible = geom_debug_visible; wheel_overlay.queue_redraw(); _update_debug_hud()


func draw_wheel_overlay(canvas: Node2D) -> void:
	if phase == CHARGING and wheel_geom_radius_px > 0:
		var power := _current_power()
		if power > 1e-4: canvas.draw_arc(Vector2.ZERO, wheel_geom_radius_px * 1.12, -PI / 2.0, -PI / 2.0 + power * RuntimeSugarWheelSpinPhysics.TAU, 96, Color(0.89, 0.73, 0.44, 0.88), 6.0, true)
	if not geom_debug_visible or instance.is_empty() or wheel_geom_radius_px <= 0: return
	var layout_data := RuntimeSugarWheelSpinPhysics.sector_layout(instance); var count := int(layout_data.n); var radius := wheel_geom_radius_px * 1.08
	for index: int in count:
		var angle := float(layout_data.left0) + index * float(layout_data.step); var point := _geom_point(radius, angle); canvas.draw_line(Vector2.ZERO, point, Color(1, 1, 1, 0.45), 1.0)
	var pointer_point := _geom_point(radius * 1.12, get_wheel_geom_angle_mod()); canvas.draw_line(Vector2.ZERO, pointer_point, Color(0, 1, 0.6, 0.95), 3.0)


func debug_drag_pointer(angle_deg: float) -> void:
	reset_pointer_geom_angle_deg(angle_deg); await _after_pointer_drag_release_actions()


func debug_press_charge() -> void:
	charge_pointer_held = true; charge_press_requested = true; charge_release_requested = false; _process_charge_input()


func debug_release_charge() -> void:
	charge_pointer_held = false; charge_release_requested = true; _process_charge_release()


func debug_spin_to_completion(power: float, max_steps: int = 20000) -> Variant:
	if phase in [IDLE, RESULT]: phase = LAUNCHING; _begin_physics_spin(power)
	elif phase != SPINNING: return null
	for _index: int in max_steps:
		if phase != SPINNING: break
		update(0.05)
	for _index: int in 8:
		await Engine.get_main_loop().process_frame
		if phase == RESULT: break
	return last_result


func debug_accept_close() -> void: accept_close()


func destroy() -> void:
	if _destroyed: return
	_destroyed = true; charge_press_requested = false; charge_pointer_held = false; charge_release_requested = false; pending_charge_pass_actions.clear(); atmosphere.cancel(); dismiss_all_speech(); _clear_result_banner()
	if not _unsubscribe_resize.is_null() and _unsubscribe_resize.is_valid(): _unsubscribe_resize.call()
	_unsubscribe_resize = Callable()
	if is_instance_valid(root): root.free()


func layout() -> void:
	if _destroyed or instance.is_empty(): return
	var width := renderer.get_screen_width(); var height := renderer.get_screen_height(); root.position = Vector2.ZERO; root.size = Vector2(width, height); ui_layer.size = root.size; speech_layer.size = root.size; confirm_layer.size = root.size
	if background != null: background.size = root.size
	if foreground != null: foreground.size = root.size
	var top_reserve := 96.0; var bottom_reserve := 126.0; var usable_height := maxf(260.0, height - top_reserve - bottom_reserve); var base_size := maxf(220.0, minf(minf(width * clampf(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelMaxSizePercent"), 0.72), 0.2, 1.0), usable_height), RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelMaxSizePx"), 660.0))); var size := base_size * clampf(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelScale"), 1.0), 0.1, 3.0)
	var center := Vector2(width / 2.0 + RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelCenterOffsetXPx"), 0.0), top_reserve + usable_height / 2.0 + RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelCenterOffsetYPx"), 0.0)); wheel_layer.position = center; wheel_geom_radius_px = size / 2.0
	var wheel_scale := size / maxf(1.0, maxf(wheel_sprite.texture.get_width(), wheel_sprite.texture.get_height())); wheel_sprite.scale = Vector2.ONE * wheel_scale
	pointer_sprite.scale = Vector2.ONE * wheel_scale * clampf(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerScale"), 1.0), 0.1, 3.0); pointer_sprite.position = Vector2(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerOffsetXPx"), 0.0), RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerOffsetYPx"), 0.0))
	var diameter := clampf(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("chargeButtonDiameterPx"), 52.0), 28.0, 160.0); _style_circle_button(charge_button, diameter, "3a2e1e", "6b5636", 0.88, clampi(roundi(17.0 * diameter / 52.0), 12, 30)); charge_button.size = Vector2.ONE * diameter; charge_button.position = center + Vector2(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("chargeButtonWheelOffsetXPx"), wheel_geom_radius_px * 0.72), RuntimeSugarWheelSpinPhysics.finite_or(instance.get("chargeButtonWheelOffsetYPx"), wheel_geom_radius_px * 0.72)) - charge_button.size / 2.0
	close_button.position = Vector2(width - 46, 14); close_button.size = Vector2(32, 32); var hint_height := ceilf(hint_label.get_combined_minimum_size().y); hint_label.position = Vector2(18, height - hint_height - 6); hint_label.size = Vector2(width - 36, hint_height)
	result_banner.position = Vector2(width / 2.0 - 200, height / 2.0 - 45); result_banner.size = Vector2(400, 90); result_label.custom_minimum_size = result_banner.size
	confirm_panel.position = Vector2(width / 2.0 - 180, height / 2.0 - 90); confirm_panel.size = Vector2(360, 180); var confirm_text: Label = confirm_panel.get_node("Text"); confirm_text.position = Vector2(20, 24); confirm_text.size = Vector2(320, 54); confirm_no.position = Vector2(26, 112); confirm_yes.position = Vector2(202, 112)
	wheel_overlay.queue_redraw(); _update_debug_hud()


func _build_confirm_dialog() -> void:
	confirm_layer.name = "CloseConfirm"; confirm_layer.visible = false; confirm_layer.mouse_filter = Control.MOUSE_FILTER_STOP
	var shade := ColorRect.new(); shade.color = Color(0, 0, 0, 0.72); shade.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT); shade.mouse_filter = Control.MOUSE_FILTER_STOP; confirm_layer.add_child(shade)
	confirm_panel.name = "Panel"; var text := Label.new(); text.name = "Text"; text.text = _text("[tag:string:sugarWheel:confirmClose]"); text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; text.vertical_alignment = VERTICAL_ALIGNMENT_CENTER; text.add_theme_font_size_override("font_size", 18); confirm_panel.add_child(text)
	confirm_no.text = _text("[tag:string:sugarWheel:confirmNo]"); confirm_no.size = Vector2(132, 40); confirm_no.pressed.connect(Callable(self, "dismiss_close")); confirm_panel.add_child(confirm_no)
	confirm_yes.text = _text("[tag:string:sugarWheel:confirmYes]"); confirm_yes.size = Vector2(132, 40); confirm_yes.pressed.connect(Callable(self, "accept_close")); confirm_panel.add_child(confirm_yes); confirm_layer.add_child(confirm_panel)


func _make_image_layer(texture: Variant, fit: String) -> TextureRect:
	var layer := TextureRect.new(); layer.texture = texture if texture is Texture2D else null; layer.expand_mode = TextureRect.EXPAND_IGNORE_SIZE; layer.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED if fit == "contain" else TextureRect.STRETCH_KEEP_ASPECT_COVERED; layer.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR; layer.mouse_filter = Control.MOUSE_FILTER_IGNORE; return layer


func _system_ui_font(weight: int) -> SystemFont:
	var font := SystemFont.new()
	font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"])
	font.font_weight = weight
	return font


func _style_circle_button(button: Button, diameter: float, normal_hex: String, hover_hex: String, alpha: float, font_size: int) -> void:
	button.add_theme_font_size_override("font_size", font_size)
	for state: String in ["font_color", "font_hover_color", "font_pressed_color", "font_focus_color"]: button.add_theme_color_override(state, Color("ccccdd"))
	button.add_theme_stylebox_override("normal", _circle_style(normal_hex, alpha, diameter))
	button.add_theme_stylebox_override("hover", _circle_style(hover_hex, alpha, diameter))
	button.add_theme_stylebox_override("pressed", _circle_style(hover_hex, alpha, diameter))
	button.add_theme_stylebox_override("focus", StyleBoxEmpty.new())


func _circle_style(color_hex: String, alpha: float, diameter: float) -> StyleBoxFlat:
	var style := StyleBoxFlat.new()
	style.bg_color = Color(color_hex, alpha)
	style.border_color = Color("4a3a24")
	style.set_border_width_all(1)
	style.set_corner_radius_all(ceili(diameter / 2.0))
	style.anti_aliasing = true
	return style


func _on_root_gui_input(event: InputEvent) -> void:
	if is_actions_playback_locked() or pointer_sprite.texture == null: return
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed and phase in [IDLE, RESULT] and event.position.distance_to(wheel_layer.position) <= wheel_geom_radius_px: dragging_pointer = true; _clear_result_banner(); _sfx("sugar_wheel_pointer_pickup"); _rotate_pointer_to(event.position)
		elif not event.pressed and dragging_pointer: dragging_pointer = false; _sfx("sugar_wheel_pointer_set"); get_tree_process_frame().connect(Callable(self, "_after_pointer_drag_release_actions"), CONNECT_ONE_SHOT)
	elif event is InputEventMouseMotion and dragging_pointer: _rotate_pointer_to(event.position)


func _on_charge_gui_input(event: InputEvent) -> void:
	if is_actions_playback_locked(): return
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed: charge_pointer_held = true; charge_press_requested = true; charge_release_requested = false
		else: charge_pointer_held = false; charge_release_requested = true


func _process_charge_input() -> void:
	if not charge_press_requested or is_actions_playback_locked(): return
	charge_press_requested = false
	if phase not in [IDLE, RESULT]: return
	if _before_charge_passed(): pending_charge_pass_actions = _action_list(instance.get("beforeChargePassActions")); _enter_charge_phase(); return
	pending_charge_pass_actions.clear(); charge_release_requested = false; var actions := _action_list(instance.get("beforeChargeFailActions"))
	if not actions.is_empty(): get_tree_process_frame().connect(Callable(self, "_run_action_batch_safe").bind(actions, "beforeChargeFailActions"), CONNECT_ONE_SHOT)


func _process_charge_release() -> void:
	if phase != CHARGING or is_actions_playback_locked() or (not charge_release_requested and charge_pointer_held): return
	charge_release_requested = false; var power := _current_power(); phase = LAUNCHING; charge_elapsed = 0.0; wheel_overlay.queue_redraw(); get_tree_process_frame().connect(Callable(self, "_launch_after_charge_pass_actions").bind(power), CONNECT_ONE_SHOT)


func _launch_after_charge_pass_actions(power: float) -> void:
	if launch_in_progress: return
	launch_in_progress = true; var actions := pending_charge_pass_actions.duplicate(true); pending_charge_pass_actions.clear()
	if not actions.is_empty(): await _run_action_batch_safe(actions, "beforeChargePassActions")
	if phase == LAUNCHING and not _destroyed: _begin_physics_spin(power)
	launch_in_progress = false
	if phase == LAUNCHING: phase = IDLE; charge_elapsed = 0.0; layout()


func _enter_charge_phase() -> void:
	if phase not in [IDLE, RESULT]: return
	dragging_pointer = false; phase = CHARGING; charge_elapsed = 0.0; _clear_result_banner(); _sfx("sugar_wheel_charge_start"); wheel_overlay.queue_redraw()


func _cancel_charge() -> void:
	if phase != CHARGING: return
	phase = IDLE; charge_elapsed = 0.0; pending_charge_pass_actions.clear(); charge_press_requested = false; charge_release_requested = false; wheel_overlay.queue_redraw()


func _before_charge_passed() -> bool:
	var expression: Variant = instance.get("beforeChargeCondition")
	if expression == null or not evaluate_condition.is_valid(): return true
	return bool(evaluate_condition.call(expression))


func _current_power() -> float:
	if phase != CHARGING: return 0.0
	var charge_ms := maxf(250.0, RuntimeSugarWheelSpinPhysics.finite_or(instance.get("powerChargeMs"), 1200.0)); var t := clampf(charge_elapsed * 1000.0 / charge_ms, 0.0, 1.0); var curve := clampf(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("powerChargeCurve"), 1.0), 1.0, 3.0); var shaped := t if curve == 1.0 else pow(t, curve); var floor_value := clampf(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("minLaunchPower"), 0.0), 0.0, 1.0); return clampf(floor_value + (1.0 - floor_value) * shaped, 0.0, 1.0)


func _begin_physics_spin(power_value: float) -> void:
	if phase != LAUNCHING: return
	var power := clampf(power_value, 0.0, 1.0); var sign_value := -1.0 if instance.get("sectorDirection") == "counterclockwise" else 1.0
	spin_omega = sign_value * lerpf(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinChargeMinVelocityRadPerSec"), 0.0), RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinChargeMaxVelocityRadPerSec"), 11.0), power); spin_alpha = sign_value * lerpf(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinChargeMinAccelRadPerSec2"), 0.0), RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinChargeMaxAccelRadPerSec2"), 9.0), power); spin_settle_accum = 0.0; last_spin_tick_sector_index = _sector_index(); last_spin_tick_at_ms = Time.get_ticks_msec(); phase = SPINNING; last_result = null; _clear_result_banner(); _sfx("sugar_wheel_launch"); atmosphere.notify_phase("start"); last_atmosphere_phase = "start"


func _finish_spin() -> void:
	if phase != SPINNING: return
	var index := _sector_index(); var sector: Dictionary = instance.sectors[index]; var result := {"instanceId": str(instance.id), "instanceLabel": str(instance.get("label", "")), "sectorId": str(sector.id), "sectorLabel": str(sector.get("label", "")), "sectorIndex": index}
	if sector.get("payload") is Dictionary: result.sectorPayload = sector.payload.duplicate(true)
	phase = LANDING; spin_omega = 0.0; spin_alpha = 0.0; _sfx("sugar_wheel_prize_chime" if sector.get("payload") is Dictionary and sector.payload.get("tier") == "jackpot" else "sugar_wheel_stop")
	var actions := _with_debug_probe(_action_list(sector.get("actionsOnSpinLanding")), "actionsOnSpinLanding", index, sector, get_wheel_geom_angle_mod())
	get_tree_process_frame().connect(Callable(self, "_finish_landing_after_actions").bind(actions, result, sector), CONNECT_ONE_SHOT)


func _finish_landing_after_actions(actions: Array, result: Dictionary, sector: Dictionary) -> void:
	if not actions.is_empty(): await _run_action_batch_safe(actions, "actionsOnSpinLanding")
	if _destroyed or instance.is_empty(): return
	atmosphere.notify_phase("stop"); last_atmosphere_phase = "stop"; phase = RESULT; last_result = result; _start_result_banner(str(sector.get("label", ""))); layout()
	if on_result.is_valid(): on_result.call(result)


func _after_pointer_drag_release_actions() -> void:
	if is_actions_playback_locked() or phase not in [IDLE, RESULT]: return
	var index := _sector_index(); var sector: Dictionary = instance.sectors[index]; var actions := _with_debug_probe(_action_list(sector.get("actionsOnPointerDrag")), "actionsOnPointerDrag", index, sector, get_wheel_geom_angle_mod())
	if not actions.is_empty(): await _run_action_batch_safe(actions, "actionsOnPointerDrag")


func _run_action_batch_safe(actions: Array, label: String) -> void:
	if actions.is_empty(): return
	await action_gate.run(actions)
	if _destroyed: return
	_debug("%s 完成" % label)


func _with_debug_probe(actions: Array, callback_kind: String, sector_index: int, sector: Dictionary, phi: float) -> Array:
	var output: Array = []
	var probe := {"sugarWheelCallback": callback_kind, "sugarWheelInstanceId": str(instance.id), "sugarWheelInstanceLabel": str(instance.get("label", "")), "sugarWheelSectorIndex": sector_index, "sugarWheelSectorId": str(sector.id), "sugarWheelSectorLabel": str(sector.get("label", "")), "sugarWheelPhiGeomRad": phi}
	for value: Variant in actions:
		if not value is Dictionary: continue
		var action: Dictionary = value.duplicate(true)
		if action.get("type") == DEBUG_ALERT_ACTION_PARAMS: var params: Dictionary = action.get("params", {}) if action.get("params") is Dictionary else {}; params.merge(probe, true); action.params = params
		output.push_back(action)
	return output


func _action_list(raw: Variant) -> Array:
	var output: Array = []
	if not raw is Array: return output
	for value: Variant in raw:
		if value is Dictionary and not str(value.get("type", "")).strip_edges().is_empty(): output.push_back({"type": str(value.type).strip_edges(), "params": value.get("params", {}).duplicate(true) if value.get("params") is Dictionary else {}})
	return output


func _sector_index() -> int: return RuntimeSugarWheelSpinPhysics.sector_index(get_wheel_geom_angle_mod(), RuntimeSugarWheelSpinPhysics.sector_layout(instance))
func _pointer_art_offset() -> float: return RuntimeSugarWheelSpinPhysics.deg_to_rad(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerArtOffsetDeg"), 0.0))
func _rotate_pointer_to(screen_position: Vector2) -> void: var point := screen_position - wheel_layer.position; pointer_sprite.rotation = atan2(point.x, -point.y) + _pointer_art_offset(); wheel_overlay.queue_redraw(); _update_debug_hud()
func _geom_point(radius: float, angle: float) -> Vector2: return Vector2(radius * sin(angle), -radius * cos(angle))


func _maybe_play_spin_tick() -> void:
	var index := _sector_index()
	if index == last_spin_tick_sector_index: return
	var now := Time.get_ticks_msec(); var speed := absf(spin_omega); var gap := 64 if speed > 5 else (86 if speed > 2 else 122)
	if now - last_spin_tick_at_ms < gap: return
	last_spin_tick_sector_index = index; last_spin_tick_at_ms = now; _sfx("sugar_wheel_tick_fast" if speed > 2.6 else "sugar_wheel_tick_slow")


func _start_result_banner(label: String) -> void:
	result_label.text = _text("[tag:string:sugarWheel:resultBanner]").replace("{label}", _text(label)); result_banner.visible = true; result_banner_elapsed = 0.0; result_banner.modulate.a = 0.0; result_banner.scale = Vector2(0.7, 0.7)


func _update_result_banner(dt: float) -> void:
	if not result_banner.visible: return
	result_banner_elapsed += maxf(0.0, dt)
	if result_banner_elapsed < 0.2: var ease := 1.0 - pow(1.0 - result_banner_elapsed / 0.2, 2); result_banner.modulate.a = ease; result_banner.scale = Vector2.ONE * (0.7 + 0.3 * ease)
	elif result_banner_elapsed < 3.2: result_banner.modulate.a = 1.0; result_banner.scale = Vector2.ONE
	elif result_banner_elapsed < 4.0: result_banner.modulate.a = 1.0 - (result_banner_elapsed - 3.2) / 0.8
	else: _clear_result_banner()


func _clear_result_banner() -> void: result_banner.visible = false; result_label.text = ""; result_banner_elapsed = 0.0


func _update_speech(dt: float) -> void:
	for index: int in range(speech_entries.size() - 1, -1, -1):
		var entry: Dictionary = speech_entries[index]; entry.elapsed = float(entry.elapsed) + maxf(0.0, dt); speech_entries[index] = entry; var node: Control = entry.node; var elapsed_ms := float(entry.elapsed) * 1000.0; var hold := float(entry.holdMs)
		if elapsed_ms < 150: var amount := elapsed_ms / 150.0; node.modulate.a = amount; node.scale = Vector2.ONE * (0.9 + 0.1 * amount)
		elif elapsed_ms < 150 + hold: node.modulate.a = 1.0; node.scale = Vector2.ONE
		elif elapsed_ms < 950 + hold: node.modulate.a = 1.0 - (elapsed_ms - 150 - hold) / 800.0
		else: _remove_speech(index)


func _remove_speech(index: int) -> void:
	if index < 0 or index >= speech_entries.size(): return
	var node: Variant = speech_entries[index].get("node"); speech_entries.remove_at(index)
	if node is Node and is_instance_valid(node): if node.get_parent() != null: node.get_parent().remove_child(node); node.free()


func _resolve_speech_anchor(role: String) -> Dictionary:
	var defaults := {"child_a": {"label": "小孩", "xRatio": 0.08, "yRatio": 0.72, "tailDirection": "down"}, "child_b": {"label": "小孩", "xRatio": 0.25, "yRatio": 0.7, "tailDirection": "down"}, "child_c": {"label": "小孩", "xRatio": 0.62, "yRatio": 0.72, "tailDirection": "down"}, "child_d": {"label": "小孩", "xRatio": 0.82, "yRatio": 0.7, "tailDirection": "down"}, "protagonist": {"xRatio": 0.5, "yRatio": 0.92, "tailDirection": "none"}, "stall_owner": {"label": "摊主", "xRatio": 0.22, "yRatio": 0.12, "tailDirection": "up"}}
	var result: Dictionary = defaults.get(role, {"label": role, "xRatio": 0.5, "yRatio": 0.5, "tailDirection": "none"}).duplicate(true); result.role = role
	for value: Variant in instance.get("speechAnchors", []): if value is Dictionary and str(value.get("role", "")) == role: result.merge(value, true); break
	return result


func _on_actions_lock_changed(locked: bool) -> void:
	if locked: dragging_pointer = false
	charge_button.disabled = locked; close_button.disabled = locked; confirm_yes.disabled = locked; confirm_no.disabled = locked


func _update_debug_hud() -> void:
	if not geom_debug_visible or instance.is_empty(): return
	var layout_data := RuntimeSugarWheelSpinPhysics.sector_layout(instance); var phi := get_wheel_geom_angle_mod(); var index := _sector_index(); var sector: Dictionary = instance.sectors[index]
	debug_hud.text = "φ %.2f° · θ %.2f° · ω %.3f\nleft0 %.2f° · step %.2f°\n#%d %s · %s" % [rad_to_deg(phi), rad_to_deg(pointer_sprite.rotation), spin_omega, rad_to_deg(float(layout_data.left0)), rad_to_deg(float(layout_data.step)), index, str(sector.id), str(sector.get("label", ""))]; debug_hud.position = Vector2(renderer.get_screen_width() / 2.0 - 180, 14); debug_hud.size = Vector2(360, 70); debug_hud.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER


func _text(raw: String) -> String: return str(resolve_text.call(raw)) if resolve_text.is_valid() else raw
func _sfx(id: String) -> void: if play_sfx.is_valid(): play_sfx.call(id)
func _debug(message: String) -> void: if debug_log.is_valid(): debug_log.call("[糖画转盘] %s" % message)
func get_tree_process_frame() -> Signal: return Engine.get_main_loop().process_frame
