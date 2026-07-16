class_name RuntimeSugarWheelMinigameScene
extends RefCounted

const SPEECH_DEBUG_ROLE_ORDER := [
	"child_a",
	"child_b",
	"child_c",
	"child_d",
	"protagonist",
	"stall_owner",
]
const DEBUG_ALERT_ACTION_PARAMS := "debugAlertActionParams"
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")
const RuntimeFillTemplateScript := preload("res://scripts/utils/fill_template.gd")


class GraphicsLayer:
	extends Control
	var scene_owner: Variant = null
	var draw_kind := ""

	func _init(next_owner: Variant = null, next_kind: String = "") -> void:
		scene_owner = next_owner
		draw_kind = next_kind
		mouse_filter = Control.MOUSE_FILTER_IGNORE

	func _draw() -> void:
		if scene_owner != null:
			scene_owner._draw_graphics_adapter(draw_kind, self)


# Direct fields, in SugarWheelMinigameScene.ts declaration order.
var root: Control
var renderer: RuntimeRenderer
var asset_manager: RuntimeAssetManager
var action_executor: RuntimeActionExecutor
var resolve_text: Callable
var on_result: Callable
var on_close: Callable
var play_sfx: Callable

var instance: Dictionary = {}
var bg: GraphicsLayer
var wheel_layer: Node2D
var ui_layer: Control
var background_sprite: Sprite2D = null
var foreground_sprite: Sprite2D = null
var wheel_sprite: Sprite2D = null
var pointer_sprite: Sprite2D = null
var arc_power_ring: GraphicsLayer
var result_banner: Control
var result_banner_bg: GraphicsLayer
var result_banner_text: Label
var result_banner_anim: Variant = null
var hint_text: Label
var charge_button: Control
var charge_button_disk: GraphicsLayer
var charge_button_glyph: Label
var charge_button_hover := false
var close_icon_button: Control

var speech_layer: Control
var speech_entries: Array = []

var confirm_layer: Control
var confirm_shade: GraphicsLayer
var confirm_panel: GraphicsLayer
var confirm_text: Label
var confirm_yes_button: Control
var confirm_no_button: Control
var confirm_visible := false
var phase := "idle"
var charge_elapsed := 0.0
var spin_omega := 0.0
var spin_alpha := 0.0
var spin_settle_accum := 0.0
var last_result: Variant = null
var unsub_resize: Variant = null
var dragging_pointer := false
var geom_debug_gfx: GraphicsLayer
var geom_debug_visible := false
var speech_debug_layer: Control
var speech_debug_bg: GraphicsLayer
var speech_debug_title: Label
var speech_debug_button_area: Control
var wheel_geom_radius_px := 0.0
var geom_debug_rim_container: Node2D
var geom_debug_hud: Label

var atmosphere_scheduler: RuntimeSugarWheelAtmosphereScheduler
var last_atmosphere_phase: Variant = null
var action_gate: RuntimeMinigameActionPlaybackGate
var action_input_shield: GraphicsLayer
var debug_sugar_log: Callable
var evaluate_before_charge_condition: Callable

var charge_press_requested := false
var charge_pointer_held := false
var charge_release_requested := false
var launch_in_progress := false
var pending_charge_pass_actions: Variant = null
var last_spin_tick_sector_index := -1
var last_spin_tick_at_ms := 0.0


func _init(
	next_renderer: RuntimeRenderer,
	next_asset_manager: RuntimeAssetManager,
	next_action_executor: RuntimeActionExecutor,
	next_resolve_text: Callable,
	next_on_result: Callable,
	next_on_close: Callable,
	next_debug_sugar_log: Callable = Callable(),
	next_evaluate_before_charge_condition: Callable = Callable(),
	next_play_sfx: Callable = Callable(),
	restore_minigame_state_after_action: Callable = Callable(),
) -> void:
	renderer = next_renderer
	asset_manager = next_asset_manager
	action_executor = next_action_executor
	resolve_text = next_resolve_text
	on_result = next_on_result
	on_close = next_on_close
	play_sfx = next_play_sfx
	debug_sugar_log = next_debug_sugar_log
	evaluate_before_charge_condition = next_evaluate_before_charge_condition

	var atmosphere_host := {
		"showSpeech": Callable(self, "show_speech"),
		"getWheelGeomAngleMod": Callable(self, "_wheel_geom_angle_mod"),
		"getSpinOmega": func() -> float: return spin_omega,
		"getInstance": func() -> Dictionary: return instance,
	}
	atmosphere_scheduler = RuntimeSugarWheelAtmosphereScheduler.new(atmosphere_host)

	action_gate = RuntimeMinigameActionPlaybackGate.new(
		Callable(action_executor, "execute_batch_await"),
		{
			"onLockChanged": Callable(self, "_on_actions_lock_changed"),
			"restoreMinigameState": restore_minigame_state_after_action,
		},
	)

	geom_debug_gfx = GraphicsLayer.new(self, "geometry_debug")
	geom_debug_gfx.name = "GeometryDebugGraphics"

	geom_debug_rim_container = Node2D.new()
	geom_debug_rim_container.name = "GeometryDebugRim"
	geom_debug_rim_container.visible = false
	for index: int in 12:
		var tick_text := _make_label_adapter("%d°" % (index * 30), 11, Color("fff8e8"), true)
		tick_text.name = "Rim_%d" % (index * 30)
		tick_text.size = Vector2(52.0, 20.0)
		tick_text.position = -tick_text.size / 2.0
		tick_text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		tick_text.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		geom_debug_rim_container.add_child(tick_text)

	geom_debug_hud = _make_label_adapter("", 12, Color("ccffee"))
	geom_debug_hud.name = "GeometryDebugHUD"
	geom_debug_hud.visible = false
	geom_debug_hud.size = Vector2(720.0, 126.0)
	geom_debug_hud.position = Vector2(-360.0, 0.0)
	geom_debug_hud.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	geom_debug_hud.mouse_filter = Control.MOUSE_FILTER_IGNORE

	root = Control.new()
	root.name = "SugarWheelMinigameScene"
	root.mouse_filter = Control.MOUSE_FILTER_STOP
	root.gui_input.connect(Callable(self, "_on_root_gui_input_adapter"))

	bg = GraphicsLayer.new(self, "background")
	bg.name = "Background"
	wheel_layer = Node2D.new()
	wheel_layer.name = "WheelLayer"
	ui_layer = Control.new()
	ui_layer.name = "UiLayer"
	ui_layer.mouse_filter = Control.MOUSE_FILTER_PASS

	arc_power_ring = GraphicsLayer.new(self, "arc_power_ring")
	arc_power_ring.name = "ArcPowerRing"

	result_banner = Control.new()
	result_banner.name = "ResultBanner"
	result_banner.visible = false
	result_banner.mouse_filter = Control.MOUSE_FILTER_IGNORE
	result_banner_bg = GraphicsLayer.new(self, "result_banner")
	result_banner_bg.name = "ResultBannerBackground"
	result_banner_text = _make_label_adapter("", 22, Color("e2b96f"), true)
	result_banner_text.name = "ResultBannerText"
	result_banner_text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	result_banner_text.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	result_banner_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	result_banner.add_child(result_banner_bg)
	result_banner.add_child(result_banner_text)

	hint_text = _make_label_adapter(
		_resolve_adapter("[tag:string:sugarWheel:hint]")
		+ (" · D 调试(几何+气泡测试)" if OS.is_debug_build() else ""),
		13,
		Color("aaaacc"),
	)
	hint_text.name = "HintText"

	var charge := _make_circular_charge_button()
	charge_button = charge.container
	charge_button_disk = charge.disk
	charge_button_glyph = charge.glyph
	close_icon_button = _make_close_icon_button()

	speech_layer = Control.new()
	speech_layer.name = "SpeechLayer"
	speech_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE

	confirm_layer = Control.new()
	confirm_layer.name = "ConfirmLayer"
	confirm_layer.visible = false
	confirm_layer.mouse_filter = Control.MOUSE_FILTER_STOP
	confirm_shade = GraphicsLayer.new(self, "confirm_shade")
	confirm_shade.name = "ConfirmShade"
	confirm_shade.mouse_filter = Control.MOUSE_FILTER_STOP
	confirm_panel = GraphicsLayer.new(self, "confirm_panel")
	confirm_panel.name = "ConfirmPanel"
	confirm_text = _make_label_adapter(_resolve_adapter("[tag:string:sugarWheel:confirmClose]"), 18, Color("ccccdd"), true)
	confirm_text.name = "ConfirmText"
	confirm_text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	confirm_text.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	confirm_yes_button = _make_button(_resolve_adapter("[tag:string:sugarWheel:confirmYes]"), Callable(self, "_accept_close"), 132.0, 40.0)
	confirm_no_button = _make_button(_resolve_adapter("[tag:string:sugarWheel:confirmNo]"), Callable(self, "_dismiss_close"), 132.0, 40.0)
	confirm_layer.add_child(confirm_shade)
	confirm_layer.add_child(confirm_panel)
	confirm_layer.add_child(confirm_text)
	confirm_layer.add_child(confirm_yes_button)
	confirm_layer.add_child(confirm_no_button)

	speech_debug_layer = Control.new()
	speech_debug_layer.name = "SpeechDebugLayer"
	speech_debug_layer.visible = false
	speech_debug_layer.mouse_filter = Control.MOUSE_FILTER_PASS
	speech_debug_bg = GraphicsLayer.new(self, "speech_debug_panel")
	speech_debug_bg.name = "SpeechDebugBackground"
	speech_debug_title = _make_label_adapter(_resolve_adapter("调试 · 气泡测试 (再按 D 关闭)"), 13, Color("ead9cb"), true)
	speech_debug_title.name = "SpeechDebugTitle"
	speech_debug_button_area = Control.new()
	speech_debug_button_area.name = "SpeechDebugButtonArea"
	speech_debug_button_area.mouse_filter = Control.MOUSE_FILTER_PASS
	speech_debug_layer.add_child(speech_debug_bg)
	speech_debug_layer.add_child(speech_debug_title)
	speech_debug_layer.add_child(speech_debug_button_area)

	root.add_child(bg)
	root.add_child(wheel_layer)
	root.add_child(ui_layer)
	ui_layer.add_child(result_banner)
	ui_layer.add_child(charge_button)
	ui_layer.add_child(close_icon_button)
	ui_layer.add_child(hint_text)
	ui_layer.add_child(speech_layer)
	ui_layer.add_child(speech_debug_layer)
	ui_layer.add_child(confirm_layer)

	action_input_shield = GraphicsLayer.new(self, "action_input_shield")
	action_input_shield.name = "ActionInputShield"
	action_input_shield.mouse_filter = Control.MOUSE_FILTER_STOP
	action_input_shield.visible = false
	action_input_shield.gui_input.connect(Callable(self, "_on_action_input_shield_gui_input_adapter"))
	ui_layer.add_child(action_input_shield)


func is_actions_playback_locked() -> bool:
	return action_gate.is_locked()


func get_debug_visual_state() -> Dictionary:
	return {
		"instanceId": str(instance.get("id", "")),
		"phase": phase,
		"sectorCount": instance.get("sectors", []).size() if instance.get("sectors") is Array else 0,
		"pointerGeomAngleRad": _wheel_geom_angle_mod() if pointer_sprite != null and is_instance_valid(pointer_sprite) else 0.0,
		"spinOmega": spin_omega,
		"spinAlpha": spin_alpha,
		"chargeElapsed": charge_elapsed,
		"speechCount": speech_entries.size(),
		"confirmVisible": confirm_visible,
		"actionsPlaybackLocked": is_actions_playback_locked(),
		"geomDebugVisible": geom_debug_visible,
		"lastResult": last_result,
	}


func _sugar_dbg(message: String) -> void:
	if debug_sugar_log.is_valid():
		debug_sugar_log.call("[糖画转盘] %s" % message)


func _sugar_sfx(id: String) -> void:
	if play_sfx.is_valid():
		play_sfx.call(id)


func _mark_charge_pointer_down() -> void:
	charge_pointer_held = true
	charge_press_requested = true
	charge_release_requested = false


func _mark_charge_pointer_released() -> void:
	charge_pointer_held = false
	charge_release_requested = true


func _mark_charge_pointer_canceled() -> void:
	charge_pointer_held = false
	charge_release_requested = true


func _layout_action_input_shield() -> void:
	var screen_width := renderer.screen_width
	var screen_height := renderer.screen_height
	action_input_shield.position = Vector2.ZERO
	action_input_shield.size = Vector2(screen_width, screen_height)
	_set_graphics_data_adapter(action_input_shield, {"rect": Rect2(0.0, 0.0, screen_width, screen_height)})


func _refresh_wheel_layer_interactivity() -> void:
	var locked := is_actions_playback_locked()
	_set_control_tree_enabled_adapter(charge_button, not locked)
	_set_control_tree_enabled_adapter(close_icon_button, not locked)
	_set_control_tree_enabled_adapter(speech_debug_layer, not locked)
	_set_control_tree_enabled_adapter(confirm_layer, not locked)
	root.mouse_default_cursor_shape = Control.CURSOR_ARROW if locked else (Control.CURSOR_DRAG if dragging_pointer else Control.CURSOR_MOVE)
	charge_button.mouse_default_cursor_shape = Control.CURSOR_ARROW if locked else Control.CURSOR_POINTING_HAND
	close_icon_button.mouse_default_cursor_shape = Control.CURSOR_ARROW if locked else Control.CURSOR_POINTING_HAND


func _on_actions_lock_changed(locked: bool) -> void:
	if locked:
		_end_pointer_drag(null, false)
	action_input_shield.visible = false
	_graphics_clear_adapter(action_input_shield)
	_refresh_wheel_layer_interactivity()


func _run_sugar_wheel_action_batch(actions: Array) -> void:
	await action_gate.run(actions)


func load(next_instance: Dictionary) -> void:
	instance = next_instance
	action_input_shield.visible = false
	phase = "idle"
	charge_press_requested = false
	charge_pointer_held = false
	charge_release_requested = false
	launch_in_progress = false
	pending_charge_pass_actions = null
	charge_elapsed = 0.0
	dragging_pointer = false
	spin_omega = 0.0
	spin_alpha = 0.0
	spin_settle_accum = 0.0
	last_spin_tick_sector_index = -1
	last_spin_tick_at_ms = 0.0
	last_result = null
	_refresh_wheel_layer_interactivity()
	dismiss_all_speech()
	_clear_result_banner_immediate()

	_destroy_node_adapter(wheel_sprite)
	_destroy_node_adapter(pointer_sprite)
	_destroy_node_adapter(background_sprite)
	_destroy_node_adapter(foreground_sprite)
	wheel_sprite = null
	pointer_sprite = null
	background_sprite = null
	foreground_sprite = null

	var background_image := str(instance.get("backgroundImage", ""))
	if not background_image.strip_edges().is_empty():
		var background_texture: Variant = asset_manager.load_texture(background_image)
		await RuntimeMicrotaskQueueScript.yield_turn()
		background_sprite = Sprite2D.new()
		background_sprite.name = "BackgroundSprite"
		background_sprite.texture = background_texture if background_texture is Texture2D else null
		background_sprite.centered = false
		background_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
		root.add_child(background_sprite)
		root.move_child(background_sprite, 1)

	var wheel_texture: Variant = asset_manager.load_texture(str(instance.get("wheelImage", "")))
	await RuntimeMicrotaskQueueScript.yield_turn()
	var pointer_texture: Variant = asset_manager.load_texture(str(instance.get("pointerImage", "")))
	await RuntimeMicrotaskQueueScript.yield_turn()

	wheel_sprite = Sprite2D.new()
	wheel_sprite.name = "WheelSprite"
	wheel_sprite.texture = wheel_texture if wheel_texture is Texture2D else null
	wheel_sprite.centered = true
	wheel_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	pointer_sprite = Sprite2D.new()
	pointer_sprite.name = "PointerSprite"
	pointer_sprite.texture = pointer_texture if pointer_texture is Texture2D else null
	pointer_sprite.centered = false
	pointer_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	if pointer_sprite.texture != null:
		pointer_sprite.offset = -Vector2(
			float(pointer_sprite.texture.get_width()) * RuntimeSugarWheelSpinPhysics.clamp(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerAnchorX"), 0.5), 0.0, 1.0),
			float(pointer_sprite.texture.get_height()) * RuntimeSugarWheelSpinPhysics.clamp(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerAnchorY"), 0.9), 0.55, 1.0),
		)
	pointer_sprite.rotation = _pointer_art_offset_rad()

	_append_child_adapter(wheel_layer, wheel_sprite)
	_append_child_adapter(wheel_layer, arc_power_ring)
	_append_child_adapter(wheel_layer, pointer_sprite)
	_append_child_adapter(wheel_layer, geom_debug_gfx)
	_append_child_adapter(wheel_layer, geom_debug_rim_container)
	_append_child_adapter(wheel_layer, geom_debug_hud)

	var foreground_image := str(instance.get("foregroundImage", ""))
	if not foreground_image.strip_edges().is_empty():
		var foreground_texture: Variant = asset_manager.load_texture(foreground_image)
		await RuntimeMicrotaskQueueScript.yield_turn()
		foreground_sprite = Sprite2D.new()
		foreground_sprite.name = "ForegroundSprite"
		foreground_sprite.texture = foreground_texture if foreground_texture is Texture2D else null
		foreground_sprite.centered = false
		foreground_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
		root.add_child(foreground_sprite)
		root.move_child(foreground_sprite, ui_layer.get_index())

	atmosphere_scheduler.select_group(instance)
	last_atmosphere_phase = null

	_layout()
	_rebuild_speech_debug_buttons()
	if unsub_resize is Callable and unsub_resize.is_valid():
		unsub_resize.call()
	unsub_resize = renderer.subscribe_after_resize(Callable(self, "_layout"))


func _make_button(label_text: String, on_tap: Callable, width: float = 148.0, height: float = 40.0) -> Control:
	var container := Control.new()
	container.size = Vector2(width, height)
	container.mouse_filter = Control.MOUSE_FILTER_PASS
	var background := GraphicsLayer.new(self, "button")
	background.name = "Background"
	background.size = container.size
	var label := _make_label_adapter(label_text, 16, Color("ccccdd"), true)
	label.name = "Label"
	label.size = container.size
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	container.add_child(background)
	container.add_child(label)
	var input := _make_transparent_button_adapter(container)
	input.pressed.connect(Callable(self, "_invoke_callable_adapter").bind(on_tap))
	input.mouse_entered.connect(Callable(self, "_paint_button").bind(background, width, height, true))
	input.mouse_exited.connect(Callable(self, "_paint_button").bind(background, width, height, false))
	_paint_button(background, width, height, false)
	return container


func _make_circular_charge_button() -> Dictionary:
	var container := Control.new()
	container.name = "ChargeButton"
	container.mouse_filter = Control.MOUSE_FILTER_PASS
	var disk := GraphicsLayer.new(self, "charge_button")
	disk.name = "Disk"
	var glyph := _make_label_adapter(_resolve_adapter("[tag:string:sugarWheel:chargeGlyph]"), 17, Color("ccccdd"), true)
	glyph.name = "Glyph"
	glyph.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	glyph.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	container.add_child(disk)
	container.add_child(glyph)
	var input := _make_transparent_button_adapter(container)
	input.gui_input.connect(Callable(self, "_on_charge_button_gui_input_adapter"))
	input.mouse_entered.connect(Callable(self, "_on_charge_button_hover_adapter").bind(true))
	input.mouse_exited.connect(Callable(self, "_on_charge_button_hover_adapter").bind(false))
	return {"container": container, "disk": disk, "glyph": glyph}


func _charge_button_diameter() -> float:
	var diameter := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("chargeButtonDiameterPx"), 52.0) if not instance.is_empty() else 52.0
	return RuntimeSugarWheelSpinPhysics.clamp(diameter, 28.0, 160.0)


func _paint_charge_button_disk() -> void:
	var diameter := _charge_button_diameter()
	charge_button.size = Vector2(diameter, diameter)
	charge_button_disk.size = charge_button.size
	charge_button_glyph.size = charge_button.size
	charge_button_glyph.add_theme_font_size_override("font_size", clampi(roundi(17.0 * diameter / 52.0), 12, 30))
	_set_graphics_data_adapter(charge_button_disk, {
		"diameter": diameter,
		"hover": charge_button_hover,
	})


func _make_close_icon_button() -> Control:
	var size_value := 32.0
	var container := Control.new()
	container.name = "CloseIconButton"
	container.size = Vector2(size_value, size_value)
	container.mouse_filter = Control.MOUSE_FILTER_PASS
	var background := GraphicsLayer.new(self, "close_button")
	background.name = "Background"
	background.size = container.size
	var label := _make_label_adapter(_resolve_adapter("×"), 22, Color("ccccdd"), true)
	label.name = "Glyph"
	label.size = container.size
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	container.add_child(background)
	container.add_child(label)
	var input := _make_transparent_button_adapter(container)
	input.pressed.connect(Callable(self, "_request_close"))
	input.mouse_entered.connect(Callable(self, "_paint_close_button_adapter").bind(background, true))
	input.mouse_exited.connect(Callable(self, "_paint_close_button_adapter").bind(background, false))
	_paint_close_button_adapter(background, false)
	return container


func _make_debug_speech_test_button(label_text: String, on_tap: Callable) -> Control:
	var width := 164.0
	var height := 30.0
	var container := Control.new()
	container.size = Vector2(width, height)
	container.mouse_filter = Control.MOUSE_FILTER_PASS
	var background := GraphicsLayer.new(self, "button")
	background.name = "Background"
	background.size = container.size
	var label := _make_label_adapter(label_text, 11, Color("ccccdd"), true)
	label.name = "Label"
	label.size = container.size
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	container.add_child(background)
	container.add_child(label)
	var input := _make_transparent_button_adapter(container)
	input.pressed.connect(Callable(self, "_invoke_callable_adapter").bind(on_tap))
	input.mouse_entered.connect(Callable(self, "_paint_button").bind(background, width, height, true))
	input.mouse_exited.connect(Callable(self, "_paint_button").bind(background, width, height, false))
	_paint_button(background, width, height, false)
	return container


func _collect_speech_debug_roles() -> Array[String]:
	var role_set: Dictionary = {}
	for role: String in SPEECH_DEBUG_ROLE_ORDER:
		role_set[role] = true
	var anchors: Variant = instance.get("speechAnchors")
	if anchors is Array:
		for anchor: Variant in anchors:
			if not anchor is Dictionary:
				continue
			var role := str(anchor.get("role", "")).strip_edges()
			if not role.is_empty():
				role_set[role] = true
	var roles: Array[String] = []
	for role: Variant in role_set:
		roles.push_back(str(role))
	return _sort_debug_speech_roles(roles)


func _sort_debug_speech_roles(roles: Array[String]) -> Array[String]:
	var sorted_roles := roles.duplicate()
	sorted_roles.sort_custom(func(left: String, right: String) -> bool:
		var left_index := SPEECH_DEBUG_ROLE_ORDER.find(left)
		var right_index := SPEECH_DEBUG_ROLE_ORDER.find(right)
		if left_index != -1 and right_index != -1:
			return left_index < right_index
		if left_index != -1:
			return true
		if right_index != -1:
			return false
		return left < right
	)
	return sorted_roles


func _rebuild_speech_debug_buttons() -> void:
	for child: Node in speech_debug_button_area.get_children():
		speech_debug_button_area.remove_child(child)
		child.free()
	if instance.is_empty():
		return
	var roles := _collect_speech_debug_roles()
	var row_stride := 34.0
	var y := 0.0
	for role: String in roles:
		var resolved_role := _resolve_adapter(role)
		var display := "%s…" % resolved_role.substr(0, 22) if resolved_role.length() > 24 else resolved_role
		var button := _make_debug_speech_test_button(display, Callable(self, "_show_debug_speech_adapter").bind(role))
		button.name = "SpeechDebug_%s" % role
		button.position.y = y
		y += row_stride
		speech_debug_button_area.add_child(button)
	y += 4.0
	var clear_button := _make_debug_speech_test_button(_resolve_adapter("清除全部气泡"), Callable(self, "dismiss_all_speech"))
	clear_button.name = "SpeechDebug_Clear"
	clear_button.position.y = y
	speech_debug_button_area.add_child(clear_button)


func _layout_speech_debug_panel(screen_width: float, screen_height: float) -> void:
	var _unused_screen_width := screen_width
	speech_debug_layer.visible = geom_debug_visible
	if not geom_debug_visible:
		return
	var padding := 8.0
	var panel_x := 12.0
	var panel_y := 52.0
	var panel_width := 184.0
	var title_height := 22.0
	var content_bottom := 0.0
	for child: Node in speech_debug_button_area.get_children():
		if child is Control:
			content_bottom = maxf(content_bottom, child.position.y + 30.0)
	var inner_height := title_height + 6.0 + content_bottom
	var panel_height := minf(maxf(padding * 2.0 + inner_height, 72.0), floorf(screen_height * 0.72))
	speech_debug_layer.position = Vector2(panel_x, panel_y)
	speech_debug_layer.size = Vector2(panel_width, panel_height)
	speech_debug_bg.size = speech_debug_layer.size
	_set_graphics_data_adapter(speech_debug_bg, {"rect": Rect2(Vector2.ZERO, speech_debug_layer.size)})
	speech_debug_title.position = Vector2(padding, padding)
	speech_debug_title.size = Vector2(panel_width - padding * 2.0, title_height)
	speech_debug_button_area.position = Vector2(padding, padding + title_height + 4.0)
	speech_debug_button_area.size = Vector2(164.0, maxf(0.0, panel_height - speech_debug_button_area.position.y))


func _paint_button(background: GraphicsLayer, width: float, height: float, hover: bool) -> void:
	background.size = Vector2(width, height)
	_set_graphics_data_adapter(background, {
		"rect": Rect2(0.0, 0.0, width, height),
		"hover": hover,
	})


func _layout() -> void:
	if instance.is_empty():
		return
	var screen_width := renderer.screen_width
	var screen_height := renderer.screen_height
	root.position = Vector2.ZERO
	root.size = Vector2(screen_width, screen_height)
	ui_layer.position = Vector2.ZERO
	ui_layer.size = root.size
	speech_layer.position = Vector2.ZERO
	speech_layer.size = root.size

	bg.position = Vector2.ZERO
	bg.size = root.size
	_set_graphics_data_adapter(bg, {"rect": Rect2(Vector2.ZERO, root.size)})

	if background_sprite != null and is_instance_valid(background_sprite) and background_sprite.texture != null:
		var texture_width := float(background_sprite.texture.get_width())
		var texture_height := float(background_sprite.texture.get_height())
		var fit := "contain" if instance.get("backgroundFit") == "contain" else "cover"
		var scale_value := minf(screen_width / maxf(1.0, texture_width), screen_height / maxf(1.0, texture_height)) if fit == "contain" else maxf(screen_width / maxf(1.0, texture_width), screen_height / maxf(1.0, texture_height))
		background_sprite.scale = Vector2.ONE * scale_value
		background_sprite.position = Vector2((screen_width - texture_width * scale_value) / 2.0, (screen_height - texture_height * scale_value) / 2.0)
	if foreground_sprite != null and is_instance_valid(foreground_sprite) and foreground_sprite.texture != null:
		var texture_width := float(foreground_sprite.texture.get_width())
		var texture_height := float(foreground_sprite.texture.get_height())
		var fit := "contain" if instance.get("foregroundFit") == "contain" else "cover"
		var scale_value := minf(screen_width / maxf(1.0, texture_width), screen_height / maxf(1.0, texture_height)) if fit == "contain" else maxf(screen_width / maxf(1.0, texture_width), screen_height / maxf(1.0, texture_height))
		foreground_sprite.scale = Vector2.ONE * scale_value
		foreground_sprite.position = Vector2((screen_width - texture_width * scale_value) / 2.0, (screen_height - texture_height * scale_value) / 2.0)

	var top_reserve := 96.0
	var bottom_reserve := 126.0
	var usable_height := maxf(260.0, screen_height - top_reserve - bottom_reserve)
	var percent := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelMaxSizePercent"), 0.72)
	var maximum_pixels := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelMaxSizePx"), 660.0)
	var base_size := maxf(220.0, minf(minf(screen_width * RuntimeSugarWheelSpinPhysics.clamp(percent, 0.2, 1.0), usable_height), maximum_pixels))
	var size_value := base_size * RuntimeSugarWheelSpinPhysics.clamp(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelScale"), 1.0), 0.1, 3.0)
	var center_x := screen_width / 2.0
	var center_y := top_reserve + usable_height / 2.0
	var wheel_x := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelCenterOffsetXPx"), 0.0)
	var wheel_y := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelCenterOffsetYPx"), 0.0)

	wheel_layer.position = Vector2(center_x + wheel_x, center_y + wheel_y)
	var pointer_x := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerOffsetXPx"), 0.0)
	var pointer_y := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerOffsetYPx"), 0.0)
	wheel_layer.set_meta("hitRadius", maxf(size_value / 2.0, size_value / 2.0 + Vector2(pointer_x, pointer_y).length()))
	wheel_geom_radius_px = size_value / 2.0
	if wheel_sprite != null and is_instance_valid(wheel_sprite) and wheel_sprite.texture != null:
		var wheel_scale := size_value / maxf(float(wheel_sprite.texture.get_width()), float(wheel_sprite.texture.get_height()))
		wheel_sprite.scale = Vector2.ONE * wheel_scale
		wheel_sprite.position = Vector2.ZERO
	if pointer_sprite != null and is_instance_valid(pointer_sprite) and pointer_sprite.texture != null and wheel_sprite != null and is_instance_valid(wheel_sprite) and wheel_sprite.texture != null:
		var wheel_scale := size_value / maxf(float(wheel_sprite.texture.get_width()), float(wheel_sprite.texture.get_height()))
		pointer_sprite.scale = Vector2.ONE * wheel_scale * RuntimeSugarWheelSpinPhysics.clamp(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerScale"), 1.0), 0.1, 3.0)
		pointer_sprite.position = Vector2(pointer_x, pointer_y)

	_paint_arc_charge_ring()
	_layout_result_banner(screen_width, screen_height, center_x + wheel_x, center_y + wheel_y)

	var margin := 14.0
	close_icon_button.position = Vector2(screen_width - margin - 32.0, margin)

	var radius := wheel_geom_radius_px
	var offset_x := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("chargeButtonWheelOffsetXPx"), radius * 0.72)
	var offset_y := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("chargeButtonWheelOffsetYPx"), radius * 0.72)
	var charge_diameter := _charge_button_diameter()
	_paint_charge_button_disk()
	charge_button.position = Vector2(center_x + wheel_x + offset_x - charge_diameter / 2.0, center_y + wheel_y + offset_y - charge_diameter / 2.0)

	hint_text.position = Vector2(18.0, screen_height - hint_text.get_combined_minimum_size().y - 14.0)
	hint_text.size = Vector2(maxf(1.0, screen_width - 36.0), hint_text.get_combined_minimum_size().y)

	_layout_speech_debug_panel(screen_width, screen_height)
	_layout_confirm(screen_width, screen_height)
	_refresh_geom_debug_layer()


func _paint_arc_charge_ring() -> void:
	_graphics_clear_adapter(arc_power_ring)
	if phase != "charging" or wheel_geom_radius_px <= 0.0:
		return
	var power := _current_power()
	if power <= 1e-4:
		return
	_set_graphics_data_adapter(arc_power_ring, {
		"radius": wheel_geom_radius_px * 1.12,
		"start": -PI / 2.0,
		"end": -PI / 2.0 + power * RuntimeSugarWheelSpinPhysics.TAU,
	})


func _layout_result_banner(screen_width: float, screen_height: float, wheel_center_x: float, wheel_center_y: float) -> void:
	var _unused_wheel_center := Vector2(wheel_center_x, wheel_center_y)
	result_banner.position = Vector2(screen_width / 2.0, screen_height / 2.0)
	if not result_banner.visible or result_banner_text.text.is_empty():
		return
	var padding_x := 28.0
	var padding_y := 18.0
	var banner_width := minf(screen_width * 0.55, 400.0)
	result_banner_text.size.x = banner_width - padding_x * 2.0
	var text_size := result_banner_text.get_combined_minimum_size()
	var text_height := maxf(text_size.y, 26.0)
	var banner_height := maxf(70.0, text_height + padding_y * 2.0)
	var text_width := minf(banner_width - padding_x * 2.0, maxf(text_size.x, 1.0))
	var real_width := minf(banner_width, text_width + padding_x * 2.0)
	result_banner_bg.position = Vector2.ZERO
	result_banner_bg.size = Vector2(real_width, banner_height)
	result_banner_text.position = Vector2(-real_width / 2.0 + padding_x, -banner_height / 2.0 + padding_y)
	result_banner_text.size = Vector2(real_width - padding_x * 2.0, banner_height - padding_y * 2.0)
	_set_graphics_data_adapter(result_banner_bg, {"rect": Rect2(-real_width / 2.0, -banner_height / 2.0, real_width, banner_height)})


func _clear_result_banner_immediate() -> void:
	result_banner_anim = null
	result_banner.visible = false
	result_banner_text.text = ""


func _start_result_banner_anim(label: String) -> void:
	result_banner_text.text = RuntimeFillTemplateScript.fill_token(
		_resolve_adapter("[tag:string:sugarWheel:resultBanner]"),
		"{label}",
		_resolve_adapter(label),
	)
	result_banner.visible = true
	result_banner_anim = {"phase": "pop", "t0": _now_ms_adapter()}
	var screen_width := renderer.screen_width
	var screen_height := renderer.screen_height
	var wheel_x := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelCenterOffsetXPx"), 0.0)
	var wheel_y := RuntimeSugarWheelSpinPhysics.finite_or(instance.get("wheelCenterOffsetYPx"), 0.0)
	_layout_result_banner(screen_width, screen_height, screen_width / 2.0 + wheel_x, screen_height / 2.0 + wheel_y)
	result_banner.modulate.a = 0.0
	result_banner.scale = Vector2(0.7, 0.7)


func _advance_result_banner() -> void:
	if not result_banner_anim is Dictionary or not result_banner.visible:
		return
	var now := _now_ms_adapter()
	var elapsed := now - float(result_banner_anim.t0)
	if result_banner_anim.phase == "pop":
		if elapsed < 200.0:
			var amount := elapsed / 200.0
			var ease := 1.0 - (1.0 - amount) * (1.0 - amount)
			result_banner.modulate.a = ease
			var scale_value := 0.7 + 0.3 * ease
			result_banner.scale = Vector2(scale_value, scale_value)
		else:
			result_banner.modulate.a = 1.0
			result_banner.scale = Vector2.ONE
			result_banner_anim.phase = "hold"
			result_banner_anim.t0 = now
	elif result_banner_anim.phase == "hold":
		if elapsed >= 3000.0:
			result_banner_anim.phase = "fade"
			result_banner_anim.t0 = now
	else:
		if elapsed < 800.0:
			result_banner.modulate.a = 1.0 - elapsed / 800.0
		else:
			_clear_result_banner_immediate()


func _layout_confirm(screen_width: float, screen_height: float) -> void:
	confirm_layer.position = Vector2.ZERO
	confirm_layer.size = Vector2(screen_width, screen_height)
	confirm_shade.position = Vector2.ZERO
	confirm_shade.size = confirm_layer.size
	_set_graphics_data_adapter(confirm_shade, {"rect": Rect2(Vector2.ZERO, confirm_layer.size)})

	var dialog_width := 360.0
	var dialog_height := 180.0
	var dialog_x := (screen_width - dialog_width) / 2.0
	var dialog_y := (screen_height - dialog_height) / 2.0
	confirm_panel.position = Vector2.ZERO
	confirm_panel.size = confirm_layer.size
	_set_graphics_data_adapter(confirm_panel, {"rect": Rect2(dialog_x, dialog_y, dialog_width, dialog_height)})

	confirm_text.position = Vector2(dialog_x, dialog_y + 34.0)
	confirm_text.size = Vector2(dialog_width, 52.0)

	var button_width := 132.0
	var button_height := 40.0
	var gap := 24.0
	var total_width := button_width * 2.0 + gap
	var button_y := dialog_y + dialog_height - button_height - 22.0
	var left_x := dialog_x + (dialog_width - total_width) / 2.0
	confirm_no_button.position = Vector2(left_x, button_y)
	confirm_yes_button.position = Vector2(left_x + button_width + gap, button_y)


func _before_charge_passed() -> bool:
	var expression: Variant = instance.get("beforeChargeCondition")
	if expression == null:
		return true
	if not evaluate_before_charge_condition.is_valid():
		return true
	var evaluated: Variant = evaluate_before_charge_condition.call(expression)
	if evaluated == null:
		_sugar_dbg("beforeChargeCondition 求值异常: null")
		return false
	return bool(evaluated)


func _process_charge_input() -> void:
	if not charge_press_requested:
		return
	if is_actions_playback_locked():
		return
	charge_press_requested = false
	if not instance.get("sectors") is Array or instance.sectors.is_empty() or pointer_sprite == null or not is_instance_valid(pointer_sprite):
		return
	if phase != "idle" and phase != "result":
		return

	if _before_charge_passed():
		pending_charge_pass_actions = _sector_action_list(instance.get("beforeChargePassActions"))
		_enter_charge_phase()
		return

	pending_charge_pass_actions = null
	charge_release_requested = false
	var fail_actions: Variant = instance.get("beforeChargeFailActions")
	if fail_actions is Array and not fail_actions.is_empty():
		_run_before_charge_fail_actions_adapter(fail_actions)


func _process_charge_release() -> void:
	if phase != "charging":
		return
	if not charge_release_requested and charge_pointer_held:
		return
	if is_actions_playback_locked():
		return
	charge_release_requested = false
	_release_charge()


func _release_charge() -> void:
	if is_actions_playback_locked():
		return
	if phase != "charging":
		return
	var power := _current_power()
	phase = "launching"
	charge_elapsed = 0.0
	_layout()
	_launch_after_charge_pass_actions(power)


func _launch_after_charge_pass_actions(power: float) -> void:
	if launch_in_progress:
		return
	launch_in_progress = true
	var actions: Array = pending_charge_pass_actions if pending_charge_pass_actions is Array else []
	pending_charge_pass_actions = null
	if not actions.is_empty():
		await _run_sugar_wheel_action_batch(actions)
	if pointer_sprite != null and is_instance_valid(pointer_sprite) and instance.get("sectors") is Array and not instance.sectors.is_empty() and phase == "launching":
		_begin_physics_spin(power)
	launch_in_progress = false
	if phase == "launching":
		phase = "idle"
		charge_elapsed = 0.0
		pending_charge_pass_actions = null
		_layout()


func _enter_charge_phase() -> void:
	if not instance.get("sectors") is Array or instance.sectors.is_empty() or pointer_sprite == null or not is_instance_valid(pointer_sprite):
		return
	if phase != "idle" and phase != "result":
		return
	_end_pointer_drag(null, false)
	phase = "charging"
	charge_elapsed = 0.0
	_clear_result_banner_immediate()
	_sugar_sfx("sugar_wheel_charge_start")


func _pointer_art_offset_rad() -> float:
	return RuntimeSugarWheelSpinPhysics.deg_to_rad(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("pointerArtOffsetDeg"), 0.0))


func _sector_layout() -> Dictionary:
	return RuntimeSugarWheelSpinPhysics.sector_layout_from_instance(instance)


func _sector_index_from_wheel_geom_angle(geom_mod: float) -> int:
	return RuntimeSugarWheelSpinPhysics.sector_index_from_wheel_geom_angle(geom_mod, _sector_layout())


func _wheel_geom_angle_mod() -> float:
	if pointer_sprite == null or not is_instance_valid(pointer_sprite):
		return 0.0
	return RuntimeSugarWheelSpinPhysics.normalize_angle(pointer_sprite.rotation - _pointer_art_offset_rad())


func _begin_physics_spin(power_raw: float) -> void:
	if not instance.get("sectors") is Array or instance.sectors.is_empty() or pointer_sprite == null or not is_instance_valid(pointer_sprite) or phase != "launching":
		return
	var power := RuntimeSugarWheelSpinPhysics.clamp(power_raw, 0.0, 1.0)
	var direction_sign := -1.0 if instance.get("sectorDirection") == "counterclockwise" else 1.0
	var initial_velocity := RuntimeSugarWheelSpinPhysics.lerp(
		RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinChargeMinVelocityRadPerSec"), 0.0),
		RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinChargeMaxVelocityRadPerSec"), 11.0),
		power,
	)
	var initial_acceleration := RuntimeSugarWheelSpinPhysics.lerp(
		RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinChargeMinAccelRadPerSec2"), 0.0),
		RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinChargeMaxAccelRadPerSec2"), 9.0),
		power,
	)
	spin_omega = direction_sign * initial_velocity
	spin_alpha = direction_sign * initial_acceleration
	spin_settle_accum = 0.0
	last_spin_tick_sector_index = _sector_index_from_wheel_geom_angle(_wheel_geom_angle_mod())
	last_spin_tick_at_ms = _now_ms_adapter()
	phase = "spinning"
	last_result = null
	_clear_result_banner_immediate()
	_sugar_sfx("sugar_wheel_launch")
	atmosphere_scheduler.notify_phase("start")
	last_atmosphere_phase = "start"


func _finish_spin() -> void:
	if pointer_sprite == null or not is_instance_valid(pointer_sprite) or phase != "spinning":
		return
	var sectors: Array = instance.sectors
	var geometry_angle := _wheel_geom_angle_mod()
	var index := _sector_index_from_wheel_geom_angle(geometry_angle)
	var sector: Dictionary = sectors[index]
	var result := {
		"instanceId": instance.get("id"),
		"instanceLabel": instance.get("label"),
		"sectorId": sector.get("id"),
		"sectorLabel": sector.get("label"),
		"sectorIndex": index,
		"sectorPayload": sector.get("payload"),
	}
	phase = "landing"
	spin_omega = 0.0
	spin_alpha = 0.0
	_sugar_sfx("sugar_wheel_prize_chime" if sector.get("payload") is Dictionary and sector.payload.get("tier") == "jackpot" else "sugar_wheel_stop")
	var landing_raw := _sector_action_list(sector.get("actionsOnSpinLanding"))
	var landing := _with_sugar_wheel_debug_probe(landing_raw, "actionsOnSpinLanding", index, sector, geometry_angle)
	_finish_spin_after_landing_actions_adapter(landing, result, sector)


func abort() -> void:
	if is_actions_playback_locked():
		return
	if confirm_visible:
		_dismiss_close()
		return
	_request_close()


func _request_close() -> void:
	if is_actions_playback_locked():
		return
	if confirm_visible:
		return
	if phase == "charging":
		_cancel_charge()
	confirm_visible = true
	confirm_layer.visible = true


func _cancel_charge() -> void:
	if phase != "charging":
		return
	phase = "idle"
	charge_elapsed = 0.0
	pending_charge_pass_actions = null
	charge_press_requested = false
	charge_release_requested = false
	_layout()


func _accept_close() -> void:
	if not confirm_visible:
		return
	confirm_visible = false
	confirm_layer.visible = false
	if on_close.is_valid():
		on_close.call()


func _dismiss_close() -> void:
	if not confirm_visible:
		return
	confirm_visible = false
	confirm_layer.visible = false


func update(dt: float) -> void:
	_advance_result_banner()
	_update_speech_bubbles()
	_process_charge_input()

	if phase == "charging":
		charge_elapsed += dt
		_process_charge_release()
		_paint_arc_charge_ring()
		return

	var step := minf(maxf(dt, 0.0), 0.05)
	if phase != "spinning" or pointer_sprite == null or not is_instance_valid(pointer_sprite):
		atmosphere_scheduler.tick(step)
		if geom_debug_visible:
			_refresh_geom_debug_layer()
		return

	var art := _pointer_art_offset_rad()
	var geometry_angle := RuntimeSugarWheelSpinPhysics.normalize_angle(pointer_sprite.rotation - art)
	var output := RuntimeSugarWheelSpinPhysics.advance_sugar_wheel_spin_step({
		"instance": instance,
		"omega": spin_omega,
		"alpha": spin_alpha,
		"phiGeom": geometry_angle,
		"dt": step,
	})
	spin_omega = output.omega
	spin_alpha = output.alpha
	pointer_sprite.rotation = output.phiGeom + art
	_maybe_play_spin_tick()

	var stop_epsilon := maxf(1e-3, RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinStopSpeedRadPerSec"), 0.06))
	var settle_need := maxf(0.0, RuntimeSugarWheelSpinPhysics.finite_or(instance.get("spinStopSettleSec"), 0.085))
	if absf(spin_omega) < stop_epsilon:
		spin_settle_accum += step
		if spin_settle_accum >= settle_need:
			pointer_sprite.rotation = _normalize_pointer_rotation_snapped()
			_finish_spin()
	else:
		spin_settle_accum = 0.0

	var atmosphere_phase: Variant = RuntimeSugarWheelAtmosphereScheduler.resolve_atmosphere_phase(phase, absf(spin_omega))
	if atmosphere_phase != null and atmosphere_phase != last_atmosphere_phase:
		atmosphere_scheduler.notify_phase(str(atmosphere_phase))
		last_atmosphere_phase = atmosphere_phase
	atmosphere_scheduler.tick(step)

	if geom_debug_visible:
		_refresh_geom_debug_layer()


func _normalize_pointer_rotation_snapped() -> float:
	if pointer_sprite == null or not is_instance_valid(pointer_sprite):
		return 0.0
	return pointer_sprite.rotation


func _maybe_play_spin_tick() -> void:
	if pointer_sprite == null or not is_instance_valid(pointer_sprite) or not instance.get("sectors") is Array or instance.sectors.is_empty():
		return
	var index := _sector_index_from_wheel_geom_angle(_wheel_geom_angle_mod())
	if index == last_spin_tick_sector_index:
		return
	var now := _now_ms_adapter()
	var speed := absf(spin_omega)
	var minimum_gap_ms := 64.0 if speed > 5.0 else (86.0 if speed > 2.0 else 122.0)
	if now - last_spin_tick_at_ms < minimum_gap_ms:
		return
	last_spin_tick_sector_index = index
	last_spin_tick_at_ms = now
	_sugar_sfx("sugar_wheel_tick_fast" if speed > 2.6 else "sugar_wheel_tick_slow")


func reset_pointer_geom_angle_deg(angle_deg: float) -> void:
	if pointer_sprite == null or not is_instance_valid(pointer_sprite) or not is_finite(angle_deg):
		return
	if phase != "idle" and phase != "result":
		return
	var geometry_angle := RuntimeSugarWheelSpinPhysics.normalize_angle(RuntimeSugarWheelSpinPhysics.deg_to_rad(angle_deg))
	pointer_sprite.rotation = geometry_angle + _pointer_art_offset_rad()
	if geom_debug_visible:
		_refresh_geom_debug_layer()


func show_speech(role: String, text: String, duration_ms: Variant = null) -> void:
	if instance.is_empty():
		return
	var resolved := _resolve_adapter(text)
	if resolved.strip_edges().is_empty():
		_sugar_dbg("showSpeech: 解析后文案为空（role=%s），已跳过；请检查占位 tag 或未配置文案。" % role)
		return
	dismiss_speech(role)
	var hold := maxf(500.0, float(duration_ms) if duration_ms != null else RuntimeSugarWheelSpinPhysics.finite_or(instance.get("speechDurationMs"), 3000.0))
	var anchor := _resolve_speech_anchor(role)
	var bubble := _build_speech_bubble_node(role, resolved, anchor)
	var screen_width := renderer.screen_width
	var screen_height := renderer.screen_height
	var x_ratio := RuntimeSugarWheelSpinPhysics.finite_or(anchor.get("xRatio"), 0.5)
	var y_ratio := RuntimeSugarWheelSpinPhysics.finite_or(anchor.get("yRatio"), 0.85)
	var pivot: Vector2 = bubble.get_meta("sourcePivot", Vector2.ZERO)
	bubble.position = Vector2(screen_width * x_ratio, screen_height * y_ratio) - pivot
	speech_layer.add_child(bubble)
	speech_entries.push_back({
		"role": role,
		"container": bubble,
		"parent": speech_layer,
		"t0": _now_ms_adapter(),
		"holdMs": hold,
	})
	bubble.modulate.a = 0.0
	bubble.scale = Vector2(0.9, 0.9)
	bubble.pivot_offset = pivot


func dismiss_speech(role: String) -> void:
	for index: int in range(speech_entries.size() - 1, -1, -1):
		if str(speech_entries[index].role) == role:
			_remove_speech_entry_at(index)


func dismiss_all_speech() -> void:
	while not speech_entries.is_empty():
		_remove_speech_entry_at(0)


func _remove_speech_entry_at(index: int) -> void:
	if index < 0 or index >= speech_entries.size():
		return
	var entry: Dictionary = speech_entries[index]
	var container: Variant = entry.get("container")
	if container is Node and is_instance_valid(container):
		if container.get_parent() != null:
			container.get_parent().remove_child(container)
		container.free()
	speech_entries.remove_at(index)


func _update_speech_bubbles() -> void:
	var now := _now_ms_adapter()
	var fade_in := 150.0
	var fade_out := 800.0
	for index: int in range(speech_entries.size() - 1, -1, -1):
		var entry: Dictionary = speech_entries[index]
		var elapsed := now - float(entry.t0)
		var container: Control = entry.container
		if elapsed < fade_in:
			var amount := elapsed / fade_in
			container.modulate.a = amount
			var scale_value := 0.9 + 0.1 * amount
			container.scale = Vector2(scale_value, scale_value)
		elif elapsed < fade_in + float(entry.holdMs):
			container.modulate.a = 1.0
			container.scale = Vector2.ONE
		elif elapsed < fade_in + float(entry.holdMs) + fade_out:
			var amount := (elapsed - fade_in - float(entry.holdMs)) / fade_out
			container.modulate.a = 1.0 - amount
			container.scale = Vector2.ONE
		else:
			_remove_speech_entry_at(index)


func _resolve_speech_anchor(role: String) -> Dictionary:
	var defaults := {
		"child_a": {"role": "child_a", "label": "小孩", "xRatio": 0.08, "yRatio": 0.72, "tailDirection": "down"},
		"child_b": {"role": "child_b", "label": "小孩", "xRatio": 0.25, "yRatio": 0.7, "tailDirection": "down"},
		"child_c": {"role": "child_c", "label": "小孩", "xRatio": 0.62, "yRatio": 0.72, "tailDirection": "down"},
		"child_d": {"role": "child_d", "label": "小孩", "xRatio": 0.82, "yRatio": 0.7, "tailDirection": "down"},
		"protagonist": {"role": "protagonist", "xRatio": 0.5, "yRatio": 0.92, "tailDirection": "none"},
		"stall_owner": {"role": "stall_owner", "label": "摊主", "xRatio": 0.22, "yRatio": 0.12, "tailDirection": "up"},
	}
	var base: Dictionary = defaults.get(role, {"role": role, "label": role, "xRatio": 0.5, "yRatio": 0.5, "tailDirection": "none"}).duplicate(true)
	var from_data: Variant = null
	for anchor: Variant in instance.get("speechAnchors", []):
		if anchor is Dictionary and anchor.get("role") == role:
			from_data = anchor
			break
	if from_data is Dictionary:
		base.merge(from_data, true)
	base.role = role
	return base


func _build_speech_bubble_node(role: String, text: String, anchor: Dictionary) -> Control:
	var wrap := 240.0 if role == "protagonist" else 160.0
	var is_protagonist := role == "protagonist"
	var body_font_size := 15 if is_protagonist else 13
	var name_font_size := 11
	var tail := str(anchor.get("tailDirection", "none"))
	var show_name := not str(anchor.get("label", "")).is_empty() and not is_protagonist

	var name_node: Label = null
	if show_name:
		name_node = _make_label_adapter(_resolve_adapter(str(anchor.get("label", ""))), name_font_size, Color("ead9cb"), true)
	var body_node := _make_label_adapter(text, body_font_size, Color("ccccdd"))
	body_node.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	body_node.size = Vector2(wrap, 1.0)
	body_node.custom_minimum_size.x = wrap

	var padding_x := 10.0
	var padding_y := 8.0
	var tail_height := 0.0 if tail == "none" else 10.0
	var name_height := name_node.get_combined_minimum_size().y + 4.0 if name_node != null else 0.0
	var body_size := body_node.get_combined_minimum_size()
	var bubble_width := maxf(maxf(name_node.get_combined_minimum_size().x + padding_x * 2.0 if name_node != null else 0.0, body_size.x + padding_x * 2.0), 80.0 if is_protagonist else 72.0)
	var body_box_height := name_height + maxf(body_size.y, float(body_font_size + 5)) + padding_y * 2.0
	var container := Control.new()
	container.name = "Speech_%s" % role
	container.size = Vector2(bubble_width, body_box_height + tail_height)
	container.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var graphics := GraphicsLayer.new(self, "speech_bubble")
	graphics.name = "Background"
	graphics.size = container.size
	_set_graphics_data_adapter(graphics, {
		"width": bubble_width,
		"bodyHeight": body_box_height,
		"tailHeight": tail_height,
		"tail": tail,
		"protagonist": is_protagonist,
	})
	container.add_child(graphics)
	var text_y := tail_height + padding_y if tail == "up" else padding_y
	if name_node != null:
		name_node.position = Vector2(padding_x, text_y)
		name_node.size = Vector2(bubble_width - padding_x * 2.0, name_node.get_combined_minimum_size().y)
		container.add_child(name_node)
		text_y += name_node.get_combined_minimum_size().y + 4.0
	body_node.position = Vector2(padding_x, text_y)
	body_node.size = Vector2(bubble_width - padding_x * 2.0, maxf(body_size.y, float(body_font_size + 5)))
	container.add_child(body_node)
	var pivot_x := bubble_width / 2.0
	var pivot_y := 0.0 if tail == "up" else (body_box_height + tail_height if tail == "down" else body_box_height)
	container.set_meta("sourcePivot", Vector2(pivot_x, pivot_y))
	return container


func destroy() -> void:
	charge_press_requested = false
	charge_pointer_held = false
	charge_release_requested = false
	launch_in_progress = false
	pending_charge_pass_actions = null
	dismiss_all_speech()
	_clear_result_banner_immediate()
	if unsub_resize is Callable and unsub_resize.is_valid():
		unsub_resize.call()
	unsub_resize = null
	if is_instance_valid(root):
		root.queue_free()
	_release_scene_cycles_adapter()


func _begin_pointer_drag(event: Dictionary) -> void:
	if is_actions_playback_locked():
		return
	if pointer_sprite == null or not is_instance_valid(pointer_sprite) or (phase != "idle" and phase != "result"):
		return
	_stop_event_adapter(event)
	dragging_pointer = true
	root.mouse_default_cursor_shape = Control.CURSOR_DRAG
	_clear_result_banner_immediate()
	_sugar_sfx("sugar_wheel_pointer_pickup")
	_rotate_pointer_toward_event(event)


func _update_pointer_drag(event: Dictionary) -> void:
	if is_actions_playback_locked():
		return
	if not dragging_pointer or pointer_sprite == null or not is_instance_valid(pointer_sprite):
		return
	_stop_event_adapter(event)
	_rotate_pointer_toward_event(event)


func _end_pointer_drag(event: Variant = null, run_drag_sector_actions: Variant = null) -> void:
	if not dragging_pointer:
		return
	if event is Dictionary:
		_stop_event_adapter(event)
	dragging_pointer = false
	root.mouse_default_cursor_shape = Control.CURSOR_MOVE
	_sugar_sfx("sugar_wheel_pointer_set")
	var fire: bool = not (run_drag_sector_actions is bool and run_drag_sector_actions == false)
	if fire:
		_after_pointer_drag_release_actions()


func _after_pointer_drag_release_actions() -> void:
	if is_actions_playback_locked():
		return
	if pointer_sprite == null or not is_instance_valid(pointer_sprite) or not instance.get("sectors") is Array or instance.sectors.is_empty():
		return
	if phase != "idle" and phase != "result":
		return
	var geometry_angle := _wheel_geom_angle_mod()
	var index := _sector_index_from_wheel_geom_angle(geometry_angle)
	var sector: Variant = instance.sectors[index]
	if not sector is Dictionary:
		return
	var actions_raw := _sector_action_list(sector.get("actionsOnPointerDrag"))
	var actions := _with_sugar_wheel_debug_probe(actions_raw, "actionsOnPointerDrag", index, sector, geometry_angle)
	if actions.is_empty():
		return
	await _run_sugar_wheel_action_batch(actions)


func _sector_action_list(raw: Variant) -> Array:
	if not raw is Array:
		return []
	var output: Array = []
	for item: Variant in raw:
		if not item is Dictionary:
			continue
		var action_type: Variant = item.get("type")
		if not action_type is String or action_type.strip_edges().is_empty():
			continue
		var params: Variant = item.get("params")
		output.push_back({
			"type": action_type.strip_edges(),
			"params": params if params is Dictionary else {},
		})
	return output


func _with_sugar_wheel_debug_probe(actions: Array, callback_kind: String, sector_index: int, sector: Dictionary, geometry_angle: float) -> Array:
	var instance_label: Variant = instance.get("label")
	var sector_label: Variant = sector.get("label")
	var probe := {
		"sugarWheelCallback": callback_kind,
		"sugarWheelInstanceId": instance.get("id"),
		"sugarWheelInstanceLabel": instance_label if instance_label != null else "",
		"sugarWheelSectorIndex": sector_index,
		"sugarWheelSectorId": sector.get("id"),
		"sugarWheelSectorLabel": sector_label if sector_label != null else "",
		"sugarWheelPhiGeomRad": geometry_angle,
	}
	var output: Array = []
	for action: Variant in actions:
		if action is Dictionary and action.get("type") == DEBUG_ALERT_ACTION_PARAMS:
			var copied_action: Dictionary = action.duplicate(false)
			var copied_params: Dictionary = action.get("params", {}).duplicate(false) if action.get("params") is Dictionary else {}
			copied_params.merge(probe, true)
			copied_action.params = copied_params
			output.push_back(copied_action)
		else:
			output.push_back(action)
	return output


func _rotate_pointer_toward_event(event: Dictionary) -> void:
	if pointer_sprite == null or not is_instance_valid(pointer_sprite):
		return
	var global_position: Vector2 = event.get("global", Vector2.ZERO)
	var local_position := wheel_layer.to_local(global_position)
	pointer_sprite.rotation = atan2(local_position.x, -local_position.y) + _pointer_art_offset_rad()
	if geom_debug_visible:
		_refresh_geom_debug_layer()


func _geom_point_on_wheel(radius: float, geometry_angle_rad: float) -> Vector2:
	return Vector2(radius * sin(geometry_angle_rad), -radius * cos(geometry_angle_rad))


func toggle_geom_debug_overlay() -> void:
	if is_actions_playback_locked():
		return
	geom_debug_visible = not geom_debug_visible
	speech_debug_layer.visible = geom_debug_visible
	_refresh_geom_debug_layer()
	_layout()


func _refresh_geom_debug_layer() -> void:
	_graphics_clear_adapter(geom_debug_gfx)
	if not geom_debug_visible or not instance.get("sectors") is Array or instance.sectors.is_empty() or wheel_geom_radius_px <= 0.0:
		geom_debug_hud.visible = false
		geom_debug_rim_container.visible = false
		return

	geom_debug_hud.visible = true
	geom_debug_rim_container.visible = true
	var radius := wheel_geom_radius_px * 1.08
	var layout_data := _sector_layout()
	var count: int = layout_data.n
	var step: float = layout_data.step
	var left_zero: float = layout_data.left0
	if count <= 0:
		geom_debug_hud.visible = false
		geom_debug_rim_container.visible = false
		return

	var arc_segments := maxi(6, mini(40, ceili(36.0 / maxf(1.0, float(count)))))
	var polygons: Array = []
	for index: int in count:
		var angle_zero := left_zero + index * step
		var angle_one := left_zero + (index + 1) * step
		var points := PackedVector2Array([Vector2.ZERO, _geom_point_on_wheel(radius, angle_zero)])
		for segment: int in range(1, arc_segments + 1):
			var amount := float(segment) / float(arc_segments)
			points.push_back(_geom_point_on_wheel(radius, angle_zero + amount * (angle_one - angle_zero)))
		points.push_back(Vector2.ZERO)
		polygons.push_back({"points": points, "color": Color("3366cc", 0.17) if index % 2 == 0 else Color("cc8833", 0.17)})

	var lines: Array = []
	var tick_outer := radius * 0.99
	var tick_inner_major := radius * 0.82
	var tick_inner_minor := radius * 0.91
	for degrees: int in range(0, 360, 10):
		var angle := float(degrees) / 360.0 * RuntimeSugarWheelSpinPhysics.TAU
		var major := degrees % 30 == 0
		lines.push_back({
			"from": _geom_point_on_wheel(tick_outer, angle),
			"to": _geom_point_on_wheel(tick_inner_major if major else tick_inner_minor, angle),
			"color": Color("d0d0d0", 0.9) if major else Color("707070", 0.55),
			"width": 2.0 if major else 1.0,
		})

	var samples := mini(576, maxi(96, ceili(radius * 0.95)))
	var potentials: Array[float] = []
	potentials.resize(samples)
	var minimum_potential := INF
	var maximum_potential := -INF
	for sample: int in samples:
		var sample_angle := float(sample) / float(samples) * RuntimeSugarWheelSpinPhysics.TAU
		var potential := RuntimeSugarWheelSpinPhysics.weight_terrain_potential(sample_angle, instance)
		potentials[sample] = potential
		minimum_potential = minf(minimum_potential, potential)
		maximum_potential = maxf(maximum_potential, potential)
	var span := maximum_potential - minimum_potential
	var denominator := span if span > 1e-14 else 1.0
	var potential_base_radius := radius * 1.1
	var valley_depth := radius * 0.11
	var potential_line := PackedVector2Array()
	for sample: int in samples:
		var sample_angle := float(sample) / float(samples) * RuntimeSugarWheelSpinPhysics.TAU
		var sample_radius := maxf(radius * 0.72, potential_base_radius - valley_depth * (maximum_potential - potentials[sample]) / denominator)
		potential_line.push_back(_geom_point_on_wheel(sample_radius, sample_angle))
	var close_radius := maxf(radius * 0.72, potential_base_radius - valley_depth * (maximum_potential - potentials[0]) / denominator)
	potential_line.push_back(_geom_point_on_wheel(close_radius, 0.0))

	var current_index := _sector_index_from_wheel_geom_angle(_wheel_geom_angle_mod()) if pointer_sprite != null and is_instance_valid(pointer_sprite) else -1
	for index: int in range(0, count + 1):
		var angle := left_zero + index * step
		var highlight := current_index >= 0 and (index == current_index or index == current_index + 1)
		lines.push_back({
			"from": Vector2.ZERO,
			"to": _geom_point_on_wheel(radius, angle),
			"color": Color("ffff66", 0.9) if highlight else Color(1.0, 1.0, 1.0, 0.38),
			"width": 2.5 if highlight else 1.0,
		})
	if pointer_sprite != null and is_instance_valid(pointer_sprite):
		lines.push_back({"from": Vector2.ZERO, "to": _geom_point_on_wheel(radius * 1.12, _wheel_geom_angle_mod()), "color": Color("00ff99", 0.95), "width": 3.0})

	_set_graphics_data_adapter(geom_debug_gfx, {"polygons": polygons, "lines": lines, "potential": potential_line})

	var label_radius := radius * 1.2
	for index: int in 12:
		var label: Label = geom_debug_rim_container.get_child(index)
		var degrees := index * 30
		var angle := float(degrees) / 360.0 * RuntimeSugarWheelSpinPhysics.TAU
		var point := _geom_point_on_wheel(label_radius, angle)
		label.text = _resolve_adapter("%d°" % degrees)
		label.position = point - label.size / 2.0

	var step_degrees := step * 180.0 / PI
	var left_zero_degrees := RuntimeSugarWheelSpinPhysics.normalize_angle(left_zero) * 180.0 / PI
	if pointer_sprite != null and is_instance_valid(pointer_sprite):
		var geometry_angle := _wheel_geom_angle_mod()
		var geometry_degrees := geometry_angle * 180.0 / PI
		var rotation := pointer_sprite.rotation
		var rotation_degrees := rotation * 180.0 / PI
		var art := _pointer_art_offset_rad()
		var art_degrees := art * 180.0 / PI
		var sector: Variant = instance.sectors[current_index] if current_index >= 0 else null
		var sector_line := "#%d %s · %s" % [current_index, sector.get("id", ""), sector.get("label", "")] if sector is Dictionary else "(无指针)"
		var current_potential := RuntimeSugarWheelSpinPhysics.weight_terrain_potential(geometry_angle, instance)
		var bias_torque := RuntimeSugarWheelSpinPhysics.weight_derived_bias_accel(geometry_angle, instance)
		var potential_derivative := -bias_torque
		geom_debug_hud.text = _resolve_adapter(
			"判格几何角 φ (mod 2π): %.2f°  ·  %.4f rad\n" % [geometry_degrees, geometry_angle]
			+ "sprite.rotation: %.2f°  ·  %.4f rad\n" % [rotation_degrees, rotation]
			+ "贴图校准 art: %.2f°  (φ = θ − art)\n" % art_degrees
			+ "分格 left0: %.2f°  ·  step: %.2f°\n" % [left_zero_degrees, step_degrees]
			+ "跑道势能 U(φ)=Σ(−ln w)·cos×scale · 青线向内=谷底 | U=%.4f  dU/dφ=%.4f ( −τ_bias )\n" % [current_potential, potential_derivative]
			+ "扇区: %s" % sector_line
		)
	else:
		var potential_at_zero := RuntimeSugarWheelSpinPhysics.weight_terrain_potential(0.0, instance)
		geom_debug_hud.text = _resolve_adapter(
			"分格 left0: %.2f°  ·  step: %.2f°\n" % [left_zero_degrees, step_degrees]
			+ "(无指针)；势能样例 φ=0° 处 U=%.4f\n" % potential_at_zero
			+ "青线周线：向内=势能更低（易滑向谷底）"
		)
	geom_debug_hud.position = Vector2(-360.0, -radius * 0.62)


func _current_power() -> float:
	if phase != "charging":
		return 0.0
	var charge_ms := maxf(250.0, RuntimeSugarWheelSpinPhysics.finite_or(instance.get("powerChargeMs"), 1200.0))
	var amount := RuntimeSugarWheelSpinPhysics.clamp(charge_elapsed * 1000.0 / charge_ms, 0.0, 1.0)
	var curve := RuntimeSugarWheelSpinPhysics.clamp(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("powerChargeCurve"), 1.0), 1.0, 3.0)
	var shaped := amount if curve == 1.0 else pow(amount, curve)
	var floor_value := RuntimeSugarWheelSpinPhysics.clamp(RuntimeSugarWheelSpinPhysics.finite_or(instance.get("minLaunchPower"), 0.0), 0.0, 1.0)
	return RuntimeSugarWheelSpinPhysics.clamp(floor_value + (1.0 - floor_value) * shaped, 0.0, 1.0)


# Godot input, drawing, lifetime, and theme adapters. The direct translation above
# owns domain state and ordering; these methods only bridge Pixi/browser primitives.
func _on_root_gui_input_adapter(event: InputEvent) -> void:
	if is_actions_playback_locked() or pointer_sprite == null or not is_instance_valid(pointer_sprite):
		return
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		var record := {"global": event.position}
		if event.pressed and (phase == "idle" or phase == "result") and event.position.distance_to(wheel_layer.position) <= float(wheel_layer.get_meta("hitRadius", wheel_geom_radius_px)):
			_begin_pointer_drag(record)
			root.accept_event()
		elif not event.pressed and dragging_pointer:
			_end_pointer_drag(record, true)
			root.accept_event()
	elif event is InputEventMouseMotion and dragging_pointer:
		_update_pointer_drag({"global": event.position})
		root.accept_event()


func _on_charge_button_gui_input_adapter(event: InputEvent) -> void:
	if is_actions_playback_locked():
		return
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed:
			_mark_charge_pointer_down()
		else:
			_mark_charge_pointer_released()


func _on_charge_button_hover_adapter(hover: bool) -> void:
	charge_button_hover = hover
	_paint_charge_button_disk()


func _on_action_input_shield_gui_input_adapter(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and not event.pressed:
		_mark_charge_pointer_released()
	elif event is InputEventScreenTouch and not event.pressed:
		_mark_charge_pointer_canceled()
	action_input_shield.accept_event()


func _run_before_charge_fail_actions_adapter(actions: Array) -> void:
	await _run_sugar_wheel_action_batch(actions)


func _finish_spin_after_landing_actions_adapter(landing: Array, result: Dictionary, sector: Dictionary) -> void:
	if not landing.is_empty():
		await _run_sugar_wheel_action_batch(landing)
	if pointer_sprite == null or not is_instance_valid(pointer_sprite) or instance.is_empty():
		return
	atmosphere_scheduler.notify_phase("stop")
	last_atmosphere_phase = "stop"
	phase = "result"
	last_result = result
	_start_result_banner_anim(str(sector.get("label", "")))
	_layout()
	if on_result.is_valid():
		on_result.call(result)


func _show_debug_speech_adapter(role: String) -> void:
	show_speech(role, "[调试] %s" % role)


func _invoke_callable_adapter(callback: Callable) -> void:
	if callback.is_valid():
		callback.call()


func _stop_event_adapter(event: Dictionary) -> void:
	var stop: Variant = event.get("stopPropagation")
	if stop is Callable and stop.is_valid():
		stop.call()


func _make_transparent_button_adapter(parent: Control) -> Button:
	var input := Button.new()
	input.name = "Input"
	input.text = ""
	input.flat = true
	input.focus_mode = Control.FOCUS_NONE
	input.mouse_filter = Control.MOUSE_FILTER_STOP
	input.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	parent.add_child(input)
	return input


func _set_control_tree_enabled_adapter(node: Node, enabled: bool) -> void:
	if node is Button:
		node.disabled = not enabled
	for child: Node in node.get_children():
		_set_control_tree_enabled_adapter(child, enabled)


func _append_child_adapter(parent: Node, child: Node) -> void:
	if child.get_parent() == parent:
		parent.move_child(child, parent.get_child_count() - 1)
	elif child.get_parent() == null:
		parent.add_child(child)


func _destroy_node_adapter(node: Variant) -> void:
	if node is Node and is_instance_valid(node):
		if node.get_parent() != null:
			node.get_parent().remove_child(node)
		node.free()


func _release_scene_cycles_adapter() -> void:
	# JavaScript's tracing GC collects the scene ↔ scheduler/gate/callback graph
	# after Manager drops `scene`. RefCounted is reference-counted, so release the
	# two self-capturing platform graphs explicitly at the same destroy boundary.
	if atmosphere_scheduler != null:
		atmosphere_scheduler.cancel()
		atmosphere_scheduler.host = {}
		atmosphere_scheduler = null
	if action_gate != null:
		action_gate.hooks = null
		action_gate.execute_batch = Callable()
		action_gate = null


func _now_ms_adapter() -> float:
	return Time.get_ticks_usec() / 1000.0


func _resolve_adapter(raw: String) -> String:
	return str(resolve_text.call(raw)) if resolve_text.is_valid() else raw


func _make_label_adapter(text: String, font_size: int, color: Color, bold := false) -> Label:
	var label := Label.new()
	label.text = text
	label.add_theme_font_override("font", _system_ui_font_adapter(700 if bold else 400))
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return label


func _system_ui_font_adapter(weight: int) -> SystemFont:
	var font := SystemFont.new()
	font.font_names = PackedStringArray(["Arial", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC"])
	font.font_weight = weight
	return font


func _paint_close_button_adapter(background: GraphicsLayer, hover: bool) -> void:
	_set_graphics_data_adapter(background, {"diameter": 32.0, "hover": hover})


func _graphics_clear_adapter(graphics: GraphicsLayer) -> void:
	graphics.set_meta("drawData", {})
	graphics.queue_redraw()


func _set_graphics_data_adapter(graphics: GraphicsLayer, data: Dictionary) -> void:
	graphics.set_meta("drawData", data)
	graphics.queue_redraw()


func _draw_graphics_adapter(kind: String, canvas: Control) -> void:
	var data: Dictionary = canvas.get_meta("drawData", {})
	if data.is_empty():
		return
	match kind:
		"background":
			canvas.draw_rect(data.rect, Color("050509"), true)
		"arc_power_ring":
			canvas.draw_arc(Vector2.ZERO, float(data.radius), float(data.start), float(data.end), 96, Color("e2b96f", 0.88), 6.0, true)
		"button":
			_draw_round_rect_adapter(canvas, data.rect, Color("6b5636", 0.92) if data.hover else Color("3a2e1e", 0.92), Color("4a3a24"), 6.0, 1.0)
		"charge_button":
			var diameter := float(data.diameter)
			canvas.draw_circle(Vector2(diameter / 2.0, diameter / 2.0), diameter / 2.0 - 1.0, Color("6b5636", 0.88) if data.hover else Color("3a2e1e", 0.88), true)
			canvas.draw_arc(Vector2(diameter / 2.0, diameter / 2.0), diameter / 2.0 - 1.0, 0.0, RuntimeSugarWheelSpinPhysics.TAU, 64, Color("4a3a24"), 1.0, true)
		"close_button":
			var diameter := float(data.diameter)
			canvas.draw_circle(Vector2(diameter / 2.0, diameter / 2.0), diameter / 2.0 - 1.0, Color("553333", 0.72) if data.hover else Color("222233", 0.72), true)
			canvas.draw_arc(Vector2(diameter / 2.0, diameter / 2.0), diameter / 2.0 - 1.0, 0.0, RuntimeSugarWheelSpinPhysics.TAU, 64, Color("4a3a24"), 1.0, true)
		"result_banner":
			_draw_round_rect_adapter(canvas, data.rect, Color("171522", 0.96), Color("e2b96f"), 10.0, 1.0)
		"confirm_shade":
			canvas.draw_rect(data.rect, Color(0.0, 0.0, 0.0, 0.72), true)
		"confirm_panel", "speech_debug_panel":
			_draw_round_rect_adapter(canvas, data.rect, Color("171522", 0.96), Color("4a3a24"), 10.0, 1.0)
		"action_input_shield":
			canvas.draw_rect(data.rect, Color(0.0, 0.0, 0.0, 0.008), true)
		"speech_bubble":
			_draw_speech_bubble_adapter(canvas, data)
		"geometry_debug":
			for polygon: Dictionary in data.get("polygons", []):
				canvas.draw_colored_polygon(polygon.points, polygon.color)
			for line: Dictionary in data.get("lines", []):
				canvas.draw_line(line.from, line.to, line.color, line.width, true)
			var potential: PackedVector2Array = data.get("potential", PackedVector2Array())
			if potential.size() >= 2:
				canvas.draw_polyline(potential, Color("66ffdd", 0.88), 2.75, true)


func _draw_round_rect_adapter(canvas: Control, rect: Rect2, fill: Color, border: Color, radius: float, border_width: float) -> void:
	var style := StyleBoxFlat.new()
	style.bg_color = fill
	style.border_color = border
	style.set_border_width_all(roundi(border_width))
	style.set_corner_radius_all(roundi(radius))
	style.anti_aliasing = true
	canvas.draw_style_box(style, rect)


func _draw_speech_bubble_adapter(canvas: Control, data: Dictionary) -> void:
	var width := float(data.width)
	var body_height := float(data.bodyHeight)
	var tail_height := float(data.tailHeight)
	var tail := str(data.tail)
	var protagonist: bool = data.protagonist
	var fill := Color("1a1408", 0.85) if protagonist else Color("111122", 0.82)
	var border_width := 2.0 if protagonist else 1.0
	var body_rect := Rect2(0.0, tail_height if tail == "up" else 0.0, width, body_height)
	_draw_round_rect_adapter(canvas, body_rect, fill, Color("e2b96f"), 8.0, border_width)
	if tail == "up":
		canvas.draw_colored_polygon(PackedVector2Array([Vector2(width / 2.0 - 6.0, tail_height), Vector2(width / 2.0, 0.0), Vector2(width / 2.0 + 6.0, tail_height)]), fill)
	elif tail == "down":
		canvas.draw_colored_polygon(PackedVector2Array([Vector2(width / 2.0 - 6.0, body_height), Vector2(width / 2.0, body_height + tail_height), Vector2(width / 2.0 + 6.0, body_height)]), fill)
