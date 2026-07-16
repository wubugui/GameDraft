extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

class ProbePanel extends RefCounted:
	var opened := false
	func is_open() -> bool: return opened
	func open() -> void: opened = true
	func close() -> void: opened = false

var calls: Array = []


func _ready() -> void:
	var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.init(); renderer.set_viewport_size(800, 600)
	var strings := RuntimeStringsProvider.new()
	var input := RuntimeInputManager.new(); add_child(input)
	var events := RuntimeEventBus.new(); var state := RuntimeGameStateController.new(input, events)
	var debug := RuntimeDebugPanelUI.new(renderer, strings, func() -> Dictionary: return {"sceneId": "probe", "state": state.current_state})
	debug.add_section("probe", func() -> String: return "section-value")
	for i in 55: debug.log("line-%s" % i)
	assert(debug.log_lines.size() == 50 and debug.log_lines[0] == "line-5")
	state.register_panel("debug", debug, "F2", {"alwaysOpenable": true, "overlaysGameState": false})
	state.set_state(RuntimeDataTypes.CUTSCENE); InputManagerProbe.key_down(input, "F2"); await get_tree().process_frame
	assert(debug.is_open() and state.current_state == RuntimeDataTypes.CUTSCENE)
	assert(debug.select_tab("system") and debug.content.text.contains("probe")); InputManagerProbe.key_up(input, "F2"); InputManagerProbe.key_down(input, "F2"); await get_tree().process_frame
	assert(not debug.is_open() and debug.debug_snapshot().logs.size() == 50)

	var cutscene_ids: Array = ["c1", "c2"]
	for index in 24: cutscene_ids.push_back("c%s" % (index + 3))
	var dev := RuntimeDevModeUI.new(renderer, {
		"getCutsceneIds": func() -> Array: return cutscene_ids,
		"playCutscene": func(id: String) -> void: calls.push_back("cutscene:" + id),
		"getScenes": func() -> Array: return [{"id": "s1", "name": "Scene One"}],
		"loadScene": func(id: String) -> void: calls.push_back("scene:" + id),
		"reload": func() -> void: calls.push_back("reload"),
		"getMinigameEntries": func() -> Array: return [{"id": "m1", "label": "Water", "kind": "water"}],
		"launchMinigame": func(entry: Dictionary) -> void: calls.push_back("minigame:" + str(entry.id)),
		"getNarrativeWarps": func() -> Array: return [{"id": "n1", "label": "Warp"}],
		"enterNarrativeWarp": func(id: String) -> void: calls.push_back("warp:" + id),
	})
	var persistent_container := dev.container
	assert(persistent_container.get_parent() == renderer.ui_layer and not persistent_container.visible and persistent_container.get_child_count() == 0)
	dev.open(); assert(dev.is_open() and dev.container == persistent_container and dev.section == "cutscene" and dev.debug_select(1)); assert(calls.has("cutscene:c2"))
	assert(dev.max_scroll_y > 0.0 and dev.content_mask != null and dev.content_container != null)
	var row_label := dev.content_container.get_child(0).get_node("Label") as Label; var row_hit := dev.content_container.get_child(0).get_node("HitArea") as Button
	assert(row_label.text == "c1"); row_hit.pressed.emit(); assert(calls.has("cutscene:c1"))
	var wheel_down := InputEventMouseButton.new(); wheel_down.button_index = MOUSE_BUTTON_WHEEL_DOWN; wheel_down.pressed = true
	dev.on_wheel(wheel_down); assert(is_equal_approx(dev.scroll_y, 30.0) and is_equal_approx(dev.content_container.position.y, -30.0))
	for index in 100: dev.on_wheel(wheel_down)
	assert(is_equal_approx(dev.scroll_y, dev.max_scroll_y))
	assert(not dev.select_section("invalid") and dev.section == "cutscene")
	assert(dev.select_section("scene") and dev.debug_select(0)); assert(calls.has("scene:s1")); await get_tree().process_frame
	row_label = dev.content_container.get_child(0).get_node("Label") as Label; row_hit = dev.content_container.get_child(0).get_node("HitArea") as Button
	assert(row_label.text == "Scene One"); row_hit.pressed.emit()
	assert(dev.select_section("minigames") and dev.debug_select(0)); assert(calls.has("minigame:m1"))
	row_label = dev.content_container.get_child(0).get_node("Label") as Label; row_hit = dev.content_container.get_child(0).get_node("HitArea") as Button
	assert(row_label.text == "[水域] Water"); row_hit.pressed.emit()
	assert(dev.select_section("narrative") and dev.debug_select(0)); assert(calls.has("warp:n1"))
	row_label = dev.content_container.get_child(0).get_node("Label") as Label; row_hit = dev.content_container.get_child(0).get_node("HitArea") as Button
	assert(row_label.text == "Warp"); row_hit.pressed.emit()
	var reload_button := dev.container.get_node_or_null("ReloadButton") as Button; assert(reload_button != null); reload_button.pressed.emit(); assert(calls.has("reload"))
	assert(dev.select_section("scene")); dev.close(); await get_tree().process_frame
	assert(not dev.is_open() and not persistent_container.visible and persistent_container.get_parent() == renderer.ui_layer and persistent_container.get_child_count() == 0)
	assert(dev.content_mask == null and dev.content_container == null and not dev.bound_wheel.is_valid())
	dev.open(); assert(dev.container == persistent_container and dev.section == "cutscene" and dev.scroll_y == 0.0 and persistent_container.visible)
	dev.destroy(); assert(dev.container == null and not is_instance_valid(persistent_container))

	var inventory := ProbePanel.new(); state.register_panel("inventory", inventory)
	state.set_state(RuntimeDataTypes.EXPLORING)
	var touch := RuntimeTouchMobileControls.new(renderer, input, state, strings, true); touch.update(); assert(touch.root.visible and touch.explore_group.visible)
	touch.debug_direction("u", true); touch.debug_direction("r", true); assert(input.get_movement_direction().is_equal_approx(Vector2(1, -1).normalized()))
	touch.debug_direction("u", false); touch.debug_run(true); assert(input.is_running()); touch.debug_interact(); assert(input.was_key_just_pressed("KeyE"))
	touch.debug_toggle_panel("inventory"); touch.update(); assert(inventory.opened and state.current_state == RuntimeDataTypes.UI_OVERLAY and not touch.explore_group.visible and touch.overlay_group.visible and input.get_movement_direction() == Vector2.ZERO and not input.is_running())
	touch.debug_back(); assert(not inventory.opened and state.current_state == RuntimeDataTypes.EXPLORING)
	touch.destroy(); assert(input.get_movement_direction() == Vector2.ZERO)
	state.destroy(); input.destroy(); renderer.destroy()
	print("DebugPanel/DevMode/TouchMobileControls shared-state/input lifecycle test: PASS"); get_tree().quit(0)
