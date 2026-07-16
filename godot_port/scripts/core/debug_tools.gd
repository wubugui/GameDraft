class_name RuntimeDebugTools
extends Node

const DEBUG_CAMERA_ZOOM_MIN := 0.05
const DEBUG_CAMERA_ZOOM_MAX := 4.0
const NARRATIVE_DEBUG_SECTION_ID := "叙事调试"

var _deps: Dictionary
var _position_debug_mode := false
var _position_debug_key_handler := Callable()
var _position_debug_pointer_handler := Callable()
var _debug_marker: Node2D
var _scene_unload_cb := Callable()

var _debug_middle_button_camera_zoom_enabled := false
var _middle_zoom_drag_active := false
var _middle_zoom_last_y := 0.0
var _middle_zoom_pointer_id: Variant = null
var _camera_zoom_wheel_handler := Callable()
var _middle_zoom_pointer_down_handler := Callable()
var _middle_zoom_pointer_move_handler := Callable()
var _middle_zoom_pointer_up_handler := Callable()
var _hud_health_debug_override_enabled := false
var _hud_health_debug_override_ratio := 1.0

var _smell_debug_scent := ""
var _smell_debug_intensity := 90.0
var _smell_debug_dir := 0.0
var _smell_debug_flicker := false
var _smell_debug_layer := "action"


func _init(deps: Dictionary) -> void:
	_deps = deps


func init() -> void:
	_setup_position_debug_tool()
	_setup_middle_button_camera_zoom()
	_setup_debug_panel_sections()
	_scene_unload_cb = func(_payload: Variant = null) -> void: _clear_debug_marker()
	var event_bus: RuntimeEventBus = _deps.eventBus
	event_bus.on("scene:beforeUnload", _scene_unload_cb)


func _clear_debug_marker() -> void:
	if _debug_marker == null:
		return
	if is_instance_valid(_debug_marker):
		if _debug_marker.get_parent() != null:
			_debug_marker.get_parent().remove_child(_debug_marker)
		_debug_marker.free()
	_debug_marker = null


func _clamp_debug_camera_zoom(value: float) -> float:
	return clampf(value, DEBUG_CAMERA_ZOOM_MIN, DEBUG_CAMERA_ZOOM_MAX)


func _normalize_wheel_delta_y(event: InputEventMouseButton) -> float:
	var factor := event.factor if event.factor > 0.0 else 1.0
	if event.button_index == MOUSE_BUTTON_WHEEL_UP:
		return -120.0 * factor
	if event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
		return 120.0 * factor
	return 0.0


func _is_event_on_canvas(position: Vector2) -> bool:
	var renderer: RuntimeRenderer = _deps.renderer
	return Rect2(Vector2.ZERO, Vector2(renderer.screen_width, renderer.screen_height)).has_point(position)


func _setup_middle_button_camera_zoom() -> void:
	set_process_input(true)


func update(_dt: float) -> void:
	return


func _setup_position_debug_tool() -> void:
	set_process_input(true)


func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_F10:
		_position_debug_mode = not _position_debug_mode
		var message := "Position debug: ON (click to log world x,y)" if _position_debug_mode else "Position debug: OFF"
		print(message)
		var event_bus: RuntimeEventBus = _deps.eventBus
		event_bus.emit("notification:show", {"text": message, "type": "info"})
		get_viewport().set_input_as_handled()
		return

	if event is InputEventMouseButton:
		var mouse_button: InputEventMouseButton = event
		if mouse_button.pressed \
			and mouse_button.button_index not in [MOUSE_BUTTON_WHEEL_UP, MOUSE_BUTTON_WHEEL_DOWN] \
			and _position_debug_mode \
			and _is_event_on_canvas(mouse_button.position):
			_log_debug_position(mouse_button.position)
		if mouse_button.button_index in [MOUSE_BUTTON_WHEEL_UP, MOUSE_BUTTON_WHEEL_DOWN] and mouse_button.pressed:
			if _debug_middle_button_camera_zoom_enabled and _is_exploring() and _is_event_on_canvas(mouse_button.position):
				var camera: RuntimeCamera = _deps.camera
				var delta_y := _normalize_wheel_delta_y(mouse_button)
				camera.set_zoom(_clamp_debug_camera_zoom(camera.get_zoom() * exp(-delta_y * 0.002)))
				_refresh_panel()
				get_viewport().set_input_as_handled()
			return
		if mouse_button.button_index == MOUSE_BUTTON_MIDDLE:
			if mouse_button.pressed:
				if _debug_middle_button_camera_zoom_enabled and _is_exploring() and _is_event_on_canvas(mouse_button.position):
					_middle_zoom_drag_active = true
					_middle_zoom_last_y = mouse_button.position.y
					_middle_zoom_pointer_id = mouse_button.device
					get_viewport().set_input_as_handled()
			else:
				_middle_zoom_drag_active = false
				_middle_zoom_pointer_id = null
			return

	if event is InputEventMouseMotion and _middle_zoom_drag_active:
		var motion: InputEventMouseMotion = event
		if _middle_zoom_pointer_id != null and motion.device != int(_middle_zoom_pointer_id):
			return
		var delta_y := motion.position.y - _middle_zoom_last_y
		_middle_zoom_last_y = motion.position.y
		var camera: RuntimeCamera = _deps.camera
		camera.set_zoom(_clamp_debug_camera_zoom(camera.get_zoom() * exp(delta_y * 0.008)))
		_refresh_panel()
		get_viewport().set_input_as_handled()


func _log_debug_position(screen_position: Vector2) -> void:
	var renderer: RuntimeRenderer = _deps.renderer
	var camera: RuntimeCamera = _deps.camera
	var player: RuntimePlayer = _deps.player
	var world := camera.screen_to_world(screen_position.x, screen_position.y)
	print("[F10 debug] screen: %.1f %.1f | wc.pos: %.1f %.1f | wc.scale: %.4f | world: %.1f %.1f | player: %.1f %.1f" % [
		screen_position.x, screen_position.y,
		renderer.world_container.position.x, renderer.world_container.position.y,
		renderer.world_container.scale.x,
		world.x, world.y, player.get_x(), player.get_y(),
	])
	_clear_debug_marker()
	var marker := Node2D.new()
	marker.name = "DebugPositionMarker"
	marker.position = world
	var horizontal := Line2D.new(); horizontal.points = PackedVector2Array([Vector2(-12, 0), Vector2(12, 0)]); horizontal.width = 2; horizontal.default_color = Color.RED
	var vertical := Line2D.new(); vertical.points = PackedVector2Array([Vector2(0, -12), Vector2(0, 12)]); vertical.width = 2; vertical.default_color = Color.RED
	var center := Polygon2D.new(); center.polygon = PackedVector2Array([Vector2(-4, 0), Vector2(0, -4), Vector2(4, 0), Vector2(0, 4)]); center.color = Color(1, 0, 0, 0.7)
	marker.add_child(horizontal); marker.add_child(vertical); marker.add_child(center)
	renderer.entity_layer.add_child(marker)
	_debug_marker = marker
	var event_bus: RuntimeEventBus = _deps.eventBus
	event_bus.emit("notification:show", {"text": "x: %.1f, y: %.1f" % [world.x, world.y], "type": "info"})


func _build_scenario_debug_list_extra(rows: Array) -> Control:
	var outer := VBoxContainer.new()
	outer.name = "ScenarioDebugListExtra"
	outer.add_child(_label("操作后会刷新本列表。「未完成」会清空该线的 phase 存档与 manual 生命周期（不自动回滚 exposes 写入的 flag）。", true))
	if rows.is_empty():
		outer.add_child(_label("（无条目）"))
		return outer
	for raw_row: Variant in rows:
		if not raw_row is Dictionary:
			continue
		var row: Dictionary = raw_row
		var card := HBoxContainer.new()
		var meta := VBoxContainer.new(); meta.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		meta.add_child(_label(str(row.get("id", ""))))
		meta.add_child(_label("线状态: %s%s" % [row.get("lifecycle", "inactive"), " · manualLineLifecycle" if row.get("manual") == true else " · 非 manual（无 activate/complete 入口）"], true))
		meta.add_child(_label("phase: %s" % row.get("phaseBrief", ""), true))
		card.add_child(meta)
		var buttons := VBoxContainer.new()
		var scenario_id := str(row.get("id", ""))
		var lifecycle := str(row.get("lifecycle", "inactive"))
		var manual: bool = row.get("manual") == true
		buttons.add_child(_button("激活", (func(bound_scenario_id: String) -> void:
			_call_dep("scenarioDebugActivate", [bound_scenario_id]); _refresh_panel()).bind(scenario_id), manual and lifecycle != "completed"))
		buttons.add_child(_button("完成", (func(bound_scenario_id: String) -> void:
			_call_dep("scenarioDebugComplete", [bound_scenario_id]); _refresh_panel()).bind(scenario_id), manual and lifecycle == "active"))
		buttons.add_child(_button("未完成", (func(bound_scenario_id: String) -> void:
			_call_dep("scenarioDebugResetIncomplete", [bound_scenario_id]); _refresh_panel()).bind(scenario_id)))
		card.add_child(buttons)
		outer.add_child(card)
	return outer


func _emit_hud_health_debug_override() -> void:
	var event_bus: RuntimeEventBus = _deps.eventBus
	event_bus.emit("debug:hudHealthOverrideChanged", {
		"enabled": _hud_health_debug_override_enabled,
		"value": _hud_health_debug_override_ratio,
	})


func _clamp_unit_value(value: float) -> float:
	return clampf(value, 0.0, 1.0)


func _apply_smell_debug() -> void:
	var smell_debug: Dictionary = _deps.smellDebug
	var zone := _smell_debug_layer == "zone"
	if not _smell_debug_scent.is_empty():
		var callback: Callable = smell_debug.get("setZone" if zone else "set", Callable())
		if callback.is_valid():
			callback.call(_smell_debug_scent, _smell_debug_intensity, _smell_debug_dir, _smell_debug_flicker)
	else:
		var callback: Callable = smell_debug.get("clearZone" if zone else "clear", Callable())
		if callback.is_valid():
			callback.call()


func _build_smell_debug_section() -> Dictionary:
	var smell_debug: Dictionary = _deps.smellDebug
	var get_form: Callable = smell_debug.get("getForm", Callable())
	var form: Variant = get_form.call() if get_form.is_valid() else null
	if not form is Dictionary:
		return {"text": "气味渲染器未就绪（等 smell_profiles.json 加载完、进入有 HUD 的场景后再开 F2）。"}

	var wrap := VBoxContainer.new()
	wrap.name = "SmellDebugExtra"
	wrap.add_child(_label("驱动层（action 优先级高于 zone）：下面的味种/浓度写入所选层。", true))
	var layer_row := HBoxContainer.new()
	layer_row.add_child(_button("action 层", func() -> void: _smell_debug_layer = "action"))
	layer_row.add_child(_button("zone 层（模拟在区内）", func() -> void: _smell_debug_layer = "zone"))
	wrap.add_child(layer_row)

	wrap.add_child(_label("驱动味种（只影响 HUD 显示，不写 flag、不动存档）：", true))
	var scent_row := HBoxContainer.new()
	scent_row.add_child(_button("无味", func() -> void:
		_smell_debug_scent = ""; _apply_smell_debug()))
	var list_profiles: Callable = smell_debug.get("listProfiles", Callable())
	var profiles: Variant = list_profiles.call() if list_profiles.is_valid() else []
	if profiles is Array:
		for raw_profile: Variant in profiles:
			if not raw_profile is Dictionary:
				continue
			var scent_id := str(raw_profile.get("id", ""))
			scent_row.add_child(_button(str(raw_profile.get("name", scent_id)), (func(bound_scent_id: String) -> void:
				_smell_debug_scent = bound_scent_id; _apply_smell_debug()).bind(scent_id)))
	wrap.add_child(scent_row)

	wrap.add_child(_slider("浓度", 0, 100, 1, _smell_debug_intensity, func(value: float) -> void:
		_smell_debug_intensity = value; _apply_smell_debug()))
	wrap.add_child(_slider("方位偏向", -1, 1, 0.05, _smell_debug_dir, func(value: float) -> void:
		_smell_debug_dir = value; _apply_smell_debug()))
	var flicker := CheckBox.new(); flicker.text = "波动（flicker，不对劲味的忽强忽弱）"; flicker.button_pressed = _smell_debug_flicker
	flicker.toggled.connect(func(enabled: bool) -> void:
		_smell_debug_flicker = enabled; _apply_smell_debug())
	wrap.add_child(flicker)

	wrap.add_child(_label("烟形（所有味共用骨架，实时；满意后把读数抄进 smell_profiles.json）：", true))
	var readout := Label.new()
	readout.name = "SmellFormReadout"
	readout.text = JSON.stringify(form, "  ")
	readout.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	var form_sliders := [
		["riseH", "高度", 40.0, 140.0, 1.0],
		["stemDia", "茎粗", 2.0, 14.0, 0.5],
		["plumeGrow", "顶宽", 8.0, 55.0, 1.0],
		["plumeExp", "顶散指数", 0.8, 3.0, 0.05],
		["topFade", "顶部消散", 0.4, 1.0, 0.01],
		["curveAmp", "弯度", 0.0, 12.0, 0.2],
		["swayGain", "飘法增益", 0.0, 1.5, 0.05],
		["baseW", "底盘宽", 20.0, 70.0, 1.0],
		["alphaBase", "不透明", 0.3, 1.4, 0.02],
	]
	for spec: Array in form_sliders:
		var key := str(spec[0])
		wrap.add_child(_slider(str(spec[1]), float(spec[2]), float(spec[3]), float(spec[4]), float(form.get(key, 0.0)), (func(value: float, bound_key: String) -> void:
			var setter: Callable = smell_debug.get("setFormParam", Callable())
			if setter.is_valid(): setter.call(bound_key, value)
			var current_form: Variant = get_form.call() if get_form.is_valid() else null
			if current_form is Dictionary: readout.text = JSON.stringify(current_form, "  ")).bind(key)))
	wrap.add_child(readout)

	return {
		"text": "",
		"extra": wrap,
		"actions": [
			{"label": "嗅一下（拔高）", "noRefresh": true, "fn": func() -> void:
				var sniff: Callable = smell_debug.get("sniff", Callable()); if sniff.is_valid(): sniff.call()},
			{"label": "清除（无味）", "noRefresh": true, "fn": func() -> void:
				_smell_debug_scent = ""; _apply_smell_debug()},
		],
	}


func _setup_debug_panel_sections() -> void:
	var debug_panel: RuntimeDebugPanelUI = _deps.debugPanelUI
	debug_panel.add_section(NARRATIVE_DEBUG_SECTION_ID, Callable(self, "_narrative_section"))
	debug_panel.add_section("Quick Actions", Callable(self, "_quick_actions_section"))
	debug_panel.add_section("三把火 HUD（调试）", Callable(self, "_hud_health_section"))
	debug_panel.add_section("气味指示器（调试）", Callable(self, "_build_smell_debug_section"))
	debug_panel.add_section("Collisions", Callable(self, "_collisions_section"))
	debug_panel.add_section("Background Debug", Callable(self, "_background_debug_section"))
	debug_panel.add_section("深度精灵遮挡（调试）", Callable(self, "_depth_occlusion_section"))
	debug_panel.add_section("投影阴影（调试）", Callable(self, "_entity_shadow_section"))
	debug_panel.add_section("Scene world 尺寸", Callable(self, "_scene_world_size_section"))
	debug_panel.add_section("实体像素密度匹配", Callable(self, "_pixel_density_section"))
	debug_panel.add_section("Camera", Callable(self, "_camera_section"))


func _narrative_section() -> Dictionary:
	var snapshot: Variant = _call_dep("getNarrativeDebugSnapshot", [], {})
	var narrative_block := ""
	if snapshot is Dictionary:
		var narrative_eval: Variant = snapshot.get("narrativeEval")
		if narrative_eval is Dictionary:
			narrative_block = str(narrative_eval.get("summaryText", "")).strip_edges()
		var narrative_state: Variant = snapshot.get("narrativeState")
		var trace: Variant = narrative_state.get("recentTrace") if narrative_state is Dictionary else []
		if trace is Array and not trace.is_empty():
			var trace_lines: Array[String] = []
			for raw_event: Variant in trace.slice(maxi(0, trace.size() - 10)):
				if not raw_event is Dictionary:
					trace_lines.push_back(str(raw_event)); continue
				var event: Dictionary = raw_event
				var seq := "" if not event.has("seq") else "#%s " % event.seq
				var graph := " %s" % event.graphId if event.get("graphId") else ""
				var transition := ".%s" % event.transitionId if event.get("transitionId") else ""
				var from_to := " %s -> %s" % [event.get("from", "?"), event.get("to", "?")] if event.get("from") or event.get("to") else ""
				var trigger := " [%s]" % event.triggerKey if event.get("triggerKey") else ""
				var message := " - %s" % event.message if event.get("message") else ""
				trace_lines.push_back("%s%s%s%s%s%s%s" % [seq, event.get("type", "trace"), graph, transition, from_to, trigger, message])
			narrative_block += "\n\n【Runtime Trace】\n%s" % "\n".join(trace_lines)
	if narrative_block.strip_edges().is_empty():
		narrative_block = "（暂无叙事解算摘要）"
	var rows: Variant = _call_dep("getScenarioDebugPanelRows", [], [])
	if not rows is Array:
		rows = []
	var count: int = rows.size()
	return {
		"text": "%s\n\n--- Scenario（catalog）---\n%s" % [
			narrative_block,
			"（暂无 catalog 条目）" if count == 0 else "共 %s 条线（顺序同 scenarios.json）。下方逐条可点「激活 / 完成」。\n仅 manualLineLifecycle=true 的线可点；「完成」需线状态为 active。" % count,
		],
		"actions": [{"label": "刷新", "fn": func() -> void: _panel_log("叙事调试：已刷新")}],
		"extra": _build_scenario_debug_list_extra(rows),
	}


func _quick_actions_section() -> Dictionary:
	var actions := [
		{"label": "Reload Scene", "fn": func() -> void:
			var scene_id: Variant = _call_dep("getCurrentSceneId", [], null)
			if scene_id == null or str(scene_id).is_empty(): scene_id = _deps.fallbackScene
			_call_dep("reloadScene", [str(scene_id)]); _panel_log("Reloaded scene: %s" % scene_id)},
		{"label": "+100 Coins", "fn": func() -> void:
			var inventory: RuntimeInventoryManager = _deps.inventoryManager; inventory.add_coins(100); _panel_log("Added 100 coins")},
		{"label": "Refresh", "fn": func() -> void: _refresh_panel()},
	]
	if bool(_call_dep("isDevMode", [], false)):
		actions.push_back({"label": "回到 Dev 场景", "fn": func() -> void:
			_call_dep("goToDevScene"); _panel_log("切换到 dev_room")})
	return {"text": "Debug shortcuts for development.", "actions": actions}


func _hud_health_section() -> Dictionary:
	var wrap := VBoxContainer.new(); wrap.name = "HudHealthDebugExtra"
	var checkbox := CheckBox.new(); checkbox.text = "接管系统值"; checkbox.button_pressed = _hud_health_debug_override_enabled
	var slider := _slider("Debug ratio", 0, 1000, 1, roundf(_hud_health_debug_override_ratio * 1000.0), func(value: float) -> void:
		_hud_health_debug_override_ratio = _clamp_unit_value(value / 1000.0)
		if _hud_health_debug_override_enabled: _emit_hud_health_debug_override())
	checkbox.toggled.connect(func(enabled: bool) -> void:
		_hud_health_debug_override_enabled = enabled; _emit_hud_health_debug_override(); _panel_log("三把火 HUD override: %s (%.3f)" % ["on" if enabled else "off", _hud_health_debug_override_ratio]))
	wrap.add_child(checkbox); wrap.add_child(slider)
	wrap.add_child(_label("勾选后 HUD 三把火不再读 player_health/current，直接用滑块 0~1 作为 current/max 比值；只影响显示。", true))
	var set_ratio := func(value: float) -> void:
		_hud_health_debug_override_ratio = value; _emit_hud_health_debug_override()
	return {
		"text": "Override: %s\nDebug ratio: %.3f" % ["ON" if _hud_health_debug_override_enabled else "OFF", _hud_health_debug_override_ratio],
		"actions": [
			{"label": "0", "noRefresh": true, "fn": set_ratio.bind(0.0)},
			{"label": "1/3", "noRefresh": true, "fn": set_ratio.bind(1.0 / 3.0)},
			{"label": "2/3", "noRefresh": true, "fn": set_ratio.bind(2.0 / 3.0)},
			{"label": "1", "noRefresh": true, "fn": set_ratio.bind(1.0)},
		],
		"extra": wrap,
	}


func _collisions_section() -> Dictionary:
	var player: RuntimePlayer = _deps.player
	var enabled := player.get_collisions_enabled_state()
	return {
		"text": "Enabled: %s\n(depth-based collision)" % enabled,
		"actions": [{"label": "Disable Collisions" if enabled else "Enable Collisions", "fn": func() -> void:
			player.set_collisions_enabled(not enabled); _panel_log("Collisions: %s" % ("disabled" if enabled else "enabled"))}],
	}


func _background_debug_section() -> Dictionary:
	var visualizer: RuntimeDepthDebugVisualizer = _deps.depthDebugVisualizer
	var labels := {"off": "Off", "depth": "Depth", "collision": "Collision", "uv": "UV"}
	var actions: Array = []
	for mode_id: String in ["off", "depth", "collision", "uv"]:
		actions.push_back({"label": labels[mode_id], "fn": (func(bound_mode_id: String) -> void:
			visualizer.set_mode(bound_mode_id); _panel_log("BG debug: %s" % bound_mode_id)).bind(mode_id)})
	return {"text": "Mode: %s" % visualizer.mode, "actions": actions}


func _depth_occlusion_section() -> Dictionary:
	var active := bool(_call_dep("depthOcclusionActive", [], false))
	var factor := float(_call_dep("getDepthOcclusionBlendFactor", [], 0.0))
	var extra: Variant = null
	if active:
		var wrap := VBoxContainer.new(); wrap.name = "DepthOcclusionDebugExtra"
		wrap.add_child(_label("被遮挡像素：对预乘后的精灵色整体 × 系数。0=硬裁切；1≈不因深度裁透明度。", true))
		wrap.add_child(_slider("混合系数", 0, 100, 1, roundf(clampf(factor, 0, 1) * 100), func(value: float) -> void:
			_call_dep("setDepthOcclusionBlendFactor", [value / 100.0])))
		extra = wrap
	var actions: Array = []
	if active:
		actions = [
			{"label": "系数归零（硬裁切）", "fn": func() -> void: _call_dep("setDepthOcclusionBlendFactor", [0.0]); _panel_log("深度遮挡混合系数 -> 0"); _refresh_panel()},
			{"label": "设为 0.50", "fn": func() -> void: _call_dep("setDepthOcclusionBlendFactor", [0.5]); _panel_log("深度遮挡混合系数 -> 0.50"); _refresh_panel()},
		]
	return {
		"text": ("遮挡混合系数（当前）: %.2f" % factor if active else "当前场景未加载 depthConfig 或深度纹理未就绪，无精灵深度遮挡。") + "\n不影响碰撞与存档。",
		"actions": actions,
		"extra": extra,
	}


func _entity_shadow_section() -> Dictionary:
	var active := bool(_call_dep("entityShadowActive", [], false))
	var shadow: Variant = _call_dep("getEntityShadowDebug", [], null)
	if not active or not shadow is Dictionary:
		return {"text": "当前场景未启用逐 entity 光照阴影（game_config.entityLighting.enabled 关或 lightEnv.shadow 关）。"}
	var wrap := VBoxContainer.new(); wrap.name = "EntityShadowDebugExtra"
	wrap.add_child(_label("模式 %s　色调 %s　billboard %s\n方位 %s°　仰角 %s°　长 %.2f　暗 %.2f\n接触 %.2f(大小 %.2f)　软采样 %s　%s" % [
		shadow.mode, "开" if shadow.toneEnabled else "关", shadow.billboard,
		roundf(float(shadow.azimuthDeg)), roundf(float(shadow.elevationDeg)), shadow.lengthFactor, shadow.darkness,
		shadow.contact, shadow.contactSize, shadow.softSamples, "阴影开" if shadow.enabled else "阴影关",
	], true))
	wrap.add_child(_slider("方位角", 0, 359, 1, roundf(float(shadow.azimuthDeg)), func(value: float) -> void:
		_call_dep("setEntityShadowAzimuth", [value])))
	var button_action := func(label: String, dep_name: String, args: Array = []) -> Dictionary:
		return {"label": label, "noRefresh": true, "fn": func() -> void: _call_dep(dep_name, args)}
	return {
		"text": "",
		"extra": wrap,
		"actions": [
			button_action.call("模式 real/planar/off ↻", "cycleShadowMode"),
			button_action.call("色调融入 开/关", "toggleEntityTone"),
			button_action.call("billboard 光/相机 ↻", "toggleEntityShadowBillboard"),
			button_action.call("阴影 开/关", "toggleEntityShadowEnabled"),
			button_action.call("仰角 −5", "nudgeEntityShadowElevation", [-5.0]),
			button_action.call("仰角 +5", "nudgeEntityShadowElevation", [5.0]),
			button_action.call("长度 −0.1", "nudgeEntityShadowLength", [-0.1]),
			button_action.call("长度 +0.1", "nudgeEntityShadowLength", [0.1]),
			button_action.call("暗度 −0.1", "nudgeEntityShadowDarkness", [-0.1]),
			button_action.call("暗度 +0.1", "nudgeEntityShadowDarkness", [0.1]),
			button_action.call("接触 −0.1", "nudgeEntityShadowContact", [-0.1]),
			button_action.call("接触 +0.1", "nudgeEntityShadowContact", [0.1]),
			button_action.call("接触大小 −0.1", "nudgeEntityShadowContactSize", [-0.1]),
			button_action.call("接触大小 +0.1", "nudgeEntityShadowContactSize", [0.1]),
			button_action.call("软采样 −1", "nudgeEntityShadowSoftSamples", [-1.0]),
			button_action.call("软采样 +1", "nudgeEntityShadowSoftSamples", [1.0]),
		],
	}


func _scene_world_size_section() -> Dictionary:
	var size: Variant = _call_dep("getDebugSceneWorldSize", [], null)
	var current_width := "—" if not size is Dictionary else str(roundf(float(size.width)))
	var current_height := "—" if not size is Dictionary else str(roundf(float(size.height)))
	var apply_delta := func(width_op: String, amount: float) -> void:
		var current: Variant = _call_dep("getDebugSceneWorldSize", [], null)
		if not current is Dictionary:
			_panel_log("无当前场景，无法修改 world 尺寸"); return
		var width := float(current.width); var height := float(current.height)
		match width_op:
			"both_add": width += amount; height += amount
			"both_scale": width *= amount; height *= amount
			"width": width += amount
			"height": height += amount
		_call_dep("applyDebugSceneWorldSize", [width, height]); _refresh_panel()
	return {
		"text": "当前（内存）worldWidth × worldHeight：%s × %s\n「WH」按钮同时改宽高；「仅W」「仅H」只改一维。仅拉伸背景与相机/深度；热点与 NPC 坐标不变。\n系统页可实时看数值。「重载场景」从 JSON 恢复。" % [current_width, current_height],
		"actions": [
			{"label": "WH−1000", "fn": apply_delta.bind("both_add", -1000.0)},
			{"label": "WH−100", "fn": apply_delta.bind("both_add", -100.0)},
			{"label": "WH+100", "fn": apply_delta.bind("both_add", 100.0)},
			{"label": "WH+1000", "fn": apply_delta.bind("both_add", 1000.0)},
			{"label": "宽高×0.95", "fn": apply_delta.bind("both_scale", 0.95)},
			{"label": "宽高×1.05", "fn": apply_delta.bind("both_scale", 1.05)},
			{"label": "仅W−100", "fn": apply_delta.bind("width", -100.0)},
			{"label": "仅W+100", "fn": apply_delta.bind("width", 100.0)},
			{"label": "仅H−100", "fn": apply_delta.bind("height", -100.0)},
			{"label": "仅H+100", "fn": apply_delta.bind("height", 100.0)},
		],
	}


func _pixel_density_section() -> Dictionary:
	var config := bool(_call_dep("getEntityPixelDensityMatchConfig", [], false))
	var effective := bool(_call_dep("getEntityPixelDensityMatchEffective", [], false))
	var override: Variant = _call_dep("getEntityPixelDensityMatchDebugOverride", [], null)
	var override_label := "跟随配置" if override == null else ("强制开" if override == true else "强制关")
	var blur_config := float(_call_dep("getEntityPixelDensityMatchBlurScaleFromConfig", [], 0.25))
	var blur_effective := float(_call_dep("getEntityPixelDensityMatchBlurScaleEffective", [], blur_config))
	var blur_debug: Variant = _call_dep("getEntityPixelDensityMatchBlurScaleDebug", [], null)
	return {
		"text": "game_config.entityPixelDensityMatch：%s\n当前生效：%s\n调试覆盖：%s\n模糊倍率（配置）：%.2f\n模糊倍率（实际）：%.2f 调试内存值：%s\n纯渲染低通，不影响深度遮挡与碰撞。" % [config, effective, override_label, blur_config, blur_effective, "无（跟配置）" if blur_debug == null else "%.2f" % blur_debug],
		"actions": [
			{"label": "切换调试覆盖（开/关/跟随）", "fn": func() -> void: _call_dep("cycleEntityPixelDensityMatchDebugOverride"); _refresh_panel()},
			{"label": "模糊倍率 −0.25", "fn": func() -> void: _call_dep("nudgeEntityPixelDensityMatchBlurScaleDebug", [-0.25]); _refresh_panel()},
			{"label": "模糊倍率 +0.25", "fn": func() -> void: _call_dep("nudgeEntityPixelDensityMatchBlurScaleDebug", [0.25]); _refresh_panel()},
			{"label": "重置模糊倍率调试", "fn": func() -> void: _call_dep("clearEntityPixelDensityMatchBlurScaleDebug"); _refresh_panel()},
		],
	}


func _camera_section() -> Dictionary:
	var camera: RuntimeCamera = _deps.camera
	var zoom := camera.get_zoom()
	var hint := "中键摄像机缩放：开启\n仅在探索模式下生效。\n滚轮 / 中键拖动缩放；调试范围约 %.2f～%.0f。" % [DEBUG_CAMERA_ZOOM_MIN, DEBUG_CAMERA_ZOOM_MAX] if _debug_middle_button_camera_zoom_enabled else "中键摄像机缩放：关闭\n开启后可在探索模式下用滚轮或中键拖动缩放镜头。"
	return {
		"text": "当前 camera.zoom：%.4f（有效投影另含 pixelsPerUnit × worldScale）\n\n%s" % [zoom, hint],
		"actions": [{"label": "关闭中键缩放" if _debug_middle_button_camera_zoom_enabled else "开启中键缩放", "fn": func() -> void:
			_debug_middle_button_camera_zoom_enabled = not _debug_middle_button_camera_zoom_enabled; _panel_log("中键摄像机缩放: %s" % ("on" if _debug_middle_button_camera_zoom_enabled else "off"))}],
	}


func destroy() -> void:
	set_process_input(false)
	if _scene_unload_cb.is_valid():
		var event_bus: RuntimeEventBus = _deps.eventBus
		event_bus.off("scene:beforeUnload", _scene_unload_cb)
		_scene_unload_cb = Callable()
	_clear_debug_marker()
	_middle_zoom_drag_active = false
	_middle_zoom_pointer_id = null


func _call_dep(name: String, args: Array = [], fallback: Variant = null) -> Variant:
	var callback: Variant = _deps.get(name)
	return callback.callv(args) if callback is Callable and callback.is_valid() else fallback


func _is_exploring() -> bool:
	return bool(_call_dep("isExploring", [], false))


func _refresh_panel() -> void:
	var panel: RuntimeDebugPanelUI = _deps.debugPanelUI
	panel.refresh()


func _panel_log(message: String) -> void:
	var panel: RuntimeDebugPanelUI = _deps.debugPanelUI
	panel.log(message)


func _label(text: String, wrap := false) -> Label:
	var label := Label.new(); label.text = text
	if wrap: label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.custom_minimum_size = Vector2(260, 0)
	return label


func _button(text: String, callback: Callable, enabled := true) -> Button:
	var button := Button.new(); button.text = text; button.disabled = not enabled
	if callback.is_valid(): button.pressed.connect(callback)
	return button


func _slider(label_text: String, minimum: float, maximum: float, step: float, value: float, callback: Callable) -> Control:
	var row := HBoxContainer.new()
	var label := Label.new(); label.text = label_text; label.custom_minimum_size.x = 92
	var slider := HSlider.new(); slider.min_value = minimum; slider.max_value = maximum; slider.step = step; slider.value = value; slider.custom_minimum_size.x = 180; slider.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var readout := Label.new(); readout.text = "%.2f" % value if step < 1.0 else str(value)
	slider.value_changed.connect(func(next_value: float) -> void:
		readout.text = "%.2f" % next_value if step < 1.0 else str(next_value)
		if callback.is_valid(): callback.call(next_value))
	row.add_child(label); row.add_child(slider); row.add_child(readout)
	return row
