extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")

var last_health_override: Dictionary = {}


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	await get_tree().process_frame

	var tools: RuntimeDebugTools = bootstrap.debug_tools
	var panel: RuntimeDebugPanelUI = bootstrap.debug_panel_ui
	assert(tools != null and bootstrap.depth_debug_visualizer != null)
	assert(panel.sections.keys() == [
		"叙事调试", "Quick Actions", "三把火 HUD（调试）", "气味指示器（调试）", "Collisions",
		"Background Debug", "深度精灵遮挡（调试）", "投影阴影（调试）", "Scene world 尺寸", "实体像素密度匹配", "Camera",
		"Flag 调试", "cutscene-step", "位面",
	])

	var narrative: Dictionary = panel.sections["叙事调试"].call()
	assert(narrative.text.contains("Scenario（catalog）") and narrative.extra is Control)
	narrative.extra.free()
	var rows: Array = bootstrap._list_scenario_debug_panel_rows()
	assert(rows.is_empty())
	var scenario_extra := tools._build_scenario_debug_list_extra([{"id": "fixture", "lifecycle": "inactive", "manual": true, "phaseBrief": "(无 phase 存档桶)"}])
	assert(scenario_extra is Control and scenario_extra.get_child_count() == 2)
	scenario_extra.free()

	bootstrap.runtime_root.event_bus.on("debug:hudHealthOverrideChanged", Callable(self, "_capture_health_override"))
	_invoke_action(panel, "三把火 HUD（调试）", "1/3")
	assert(last_health_override.enabled == false and is_equal_approx(float(last_health_override.value), 1.0 / 3.0))

	var collision_before: bool = bootstrap.player.get_collisions_enabled_state()
	_invoke_first_action(panel, "Collisions")
	assert(bootstrap.player.get_collisions_enabled_state() != collision_before)
	bootstrap.player.set_collisions_enabled(collision_before)

	_invoke_action(panel, "Background Debug", "Depth")
	assert(bootstrap.depth_debug_visualizer.mode == "depth")
	var background_sprite: Sprite2D = bootstrap.scene_manager.scene_background.get_child(0)
	assert(not bootstrap.renderer.background_layer is CanvasGroup and background_sprite.material == bootstrap.depth_debug_visualizer._filter.material)
	_invoke_action(panel, "Background Debug", "Off")
	assert(bootstrap.depth_debug_visualizer.mode == "off" and background_sprite.material == null)

	_invoke_action(panel, "深度精灵遮挡（调试）", "设为 0.50")
	assert(is_equal_approx(bootstrap.scene_depth_system.occlusion_blend_factor, 0.5))

	var shadow_section: Dictionary = panel.sections["投影阴影（调试）"].call()
	if shadow_section.get("actions") is Array:
		assert(shadow_section.actions.size() == 16)
		var shadow_before: Variant = bootstrap._get_entity_shadow_debug()
		if shadow_before is Dictionary:
			_invoke_action(panel, "投影阴影（调试）", "仰角 +5")
			assert(float(bootstrap._get_entity_shadow_debug().elevationDeg) >= float(shadow_before.elevationDeg))
	_free_section_extra(shadow_section)

	var scene: Dictionary = bootstrap.scene_manager.get_current_scene_data()
	var old_width := float(scene.worldWidth); var old_height := float(scene.worldHeight)
	_invoke_action(panel, "Scene world 尺寸", "WH+100")
	assert(is_equal_approx(float(scene.worldWidth), old_width + 100.0) and is_equal_approx(float(scene.worldHeight), old_height + 100.0))
	bootstrap._apply_debug_scene_world_size(old_width, old_height)

	assert(bootstrap.entity_pixel_density_match_debug_override == null)
	_invoke_first_action(panel, "实体像素密度匹配")
	assert(bootstrap.entity_pixel_density_match_debug_override == true)
	bootstrap.entity_pixel_density_match_debug_override = null
	bootstrap._sync_entity_pixel_density_match()

	var smell_section: Dictionary = panel.sections["气味指示器（调试）"].call()
	assert(smell_section.extra is Control and smell_section.actions.size() == 2)
	var form_before: Dictionary = bootstrap.hud.get_smell_form().duplicate(true)
	var rise_slider := _find_named_slider(smell_section.extra, "高度")
	assert(rise_slider != null)
	var next_rise := float(form_before.riseH) + 1.0
	rise_slider.value = next_rise
	rise_slider.value_changed.emit(next_rise)
	assert(is_equal_approx(float(bootstrap.hud.get_smell_form().riseH), next_rise), "smell form after slider: %s expected riseH=%s" % [bootstrap.hud.get_smell_form(), next_rise])
	var readout: Label = smell_section.extra.find_child("SmellFormReadout", true, false)
	assert(readout != null and readout.text.contains(str(next_rise)))
	smell_section.extra.free()
	_invoke_action(panel, "气味指示器（调试）", "嗅一下（拔高）")

	var camera_zoom: float = bootstrap.camera.get_zoom()
	_invoke_first_action(panel, "Camera")
	var wheel := InputEventMouseButton.new(); wheel.position = Vector2(400, 300); wheel.button_index = MOUSE_BUTTON_WHEEL_UP; wheel.pressed = true; wheel.factor = 1.0
	tools._input(wheel)
	assert(bootstrap.camera.get_zoom() > camera_zoom)

	var key := InputEventKey.new(); key.keycode = KEY_F10; key.pressed = true
	tools._input(key)
	tools._input(wheel)
	assert(tools._debug_marker == null)
	var click := InputEventMouseButton.new(); click.position = Vector2(400, 300); click.button_index = MOUSE_BUTTON_LEFT; click.pressed = true
	tools._input(click)
	assert(tools._position_debug_mode and tools._debug_marker != null and tools._debug_marker.get_parent() == bootstrap.renderer.entity_layer)
	bootstrap.runtime_root.event_bus.emit("scene:beforeUnload")
	assert(tools._debug_marker == null)

	panel.open(); panel.select_tab("tools"); panel.refresh()
	var panel_snapshot := panel.debug_snapshot()
	assert(panel_snapshot.actions > 0 and panel_snapshot.extras > 0)
	var camera_button := _find_action_button(panel, "Camera:")
	assert(camera_button != null and tools._debug_middle_button_camera_zoom_enabled)
	camera_button.pressed.emit()
	await get_tree().process_frame
	assert(not tools._debug_middle_button_camera_zoom_enabled)
	panel.close()
	panel.open(); panel.select_tab("tools"); panel.refresh()
	assert(panel.extra_scroll != null and is_instance_valid(panel.extra_scroll) and panel.debug_snapshot().extras > 0)
	panel.close()

	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	await get_tree().process_frame
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("DebugTools 14-section/input/render-debug direct-translation test: PASS")
	get_tree().quit(0)


func _capture_health_override(payload: Variant) -> void:
	if payload is Dictionary:
		last_health_override = payload.duplicate(true)


func _invoke_first_action(panel: RuntimeDebugPanelUI, section_id: String) -> void:
	var section: Variant = panel.sections[section_id].call()
	assert(section is Dictionary and section.get("actions") is Array and not section.actions.is_empty())
	section.actions[0].fn.call()
	_free_section_extra(section)


func _invoke_action(panel: RuntimeDebugPanelUI, section_id: String, label: String) -> void:
	var section: Variant = panel.sections[section_id].call()
	assert(section is Dictionary and section.get("actions") is Array)
	for action: Variant in section.actions:
		if action is Dictionary and action.get("label") == label:
			action.fn.call()
			_free_section_extra(section)
			return
	_free_section_extra(section)
	assert(false, "missing DebugTools action: %s / %s" % [section_id, label])


func _free_section_extra(section: Variant) -> void:
	if section is Dictionary and section.get("extra") is Control and is_instance_valid(section.extra):
		section.extra.free()


func _find_named_slider(root: Node, label_text: String) -> HSlider:
	for child: Node in root.get_children():
		if child is Control and child.get_child_count() >= 2 and child.get_child(0) is Label \
			and str(child.get_child(0).text) == label_text and child.get_child(1) is HSlider:
			return child.get_child(1)
		var nested := _find_named_slider(child, label_text)
		if nested != null:
			return nested
	return null


func _find_action_button(panel: RuntimeDebugPanelUI, id_prefix: String) -> Button:
	for button: Button in panel.action_buttons:
		if str(button.get_meta("action_id", "")).begins_with(id_prefix):
			return button
	return null
