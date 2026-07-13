extends Node

class ProbePanel extends RefCounted:
	var opened := false
	func is_open() -> bool: return opened
	func open() -> void: opened = true
	func close() -> void: opened = false

var calls: Array = []


func _ready() -> void:
	var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.init_renderer(); renderer.set_viewport_size(800, 600)
	var strings := RuntimeStringsProvider.new()
	var input := RuntimeInputManager.new(); add_child(input)
	var events := RuntimeEventBus.new(); var state := RuntimeGameStateController.new(input, events)
	var debug := RuntimeDebugPanelUI.new(renderer, strings, func() -> Dictionary: return {"sceneId": "probe", "state": state.current_state})
	debug.add_section("probe", func() -> String: return "section-value")
	for i in 55: debug.log("line-%s" % i)
	assert(debug.log_lines.size() == 50 and debug.log_lines[0] == "line-5")
	state.register_panel("debug", debug, "F2", {"alwaysOpenable": true, "overlaysGameState": false})
	state.set_state(RuntimeGameStateController.CUTSCENE); input.debug_key_down("F2"); await get_tree().process_frame
	assert(debug.is_open() and state.current_state == RuntimeGameStateController.CUTSCENE)
	assert(debug.select_tab("system") and debug.content.text.contains("probe")); input.debug_key_up("F2"); input.debug_key_down("F2"); await get_tree().process_frame
	assert(not debug.is_open() and debug.debug_snapshot().logs.size() == 50)

	var dev := RuntimeDevModeUI.new(renderer, strings, {
		"getCutsceneIds": func() -> Array: return ["c1", "c2"],
		"playCutscene": func(id: String) -> void: calls.push_back("cutscene:" + id),
		"getScenes": func() -> Array: return [{"id": "s1", "name": "Scene One"}],
		"loadScene": func(id: String) -> void: calls.push_back("scene:" + id),
		"reload": func() -> void: calls.push_back("reload"),
		"getMinigameEntries": func() -> Array: return [{"id": "m1", "label": "Water", "kind": "water"}],
		"launchMinigame": func(entry: Dictionary) -> void: calls.push_back("minigame:" + str(entry.id)),
		"getNarrativeWarps": func() -> Array: return [{"id": "n1", "label": "Warp"}],
		"enterNarrativeWarp": func(id: String) -> void: calls.push_back("warp:" + id),
	})
	dev.open(); assert(dev.entries == ["c1", "c2"] and dev.debug_select(1)); assert(calls.has("cutscene:c2"))
	assert(dev.select_section("scene") and dev.entries.size() == 1 and dev.debug_select(0)); assert(calls.has("scene:s1"))
	assert(dev.select_section("minigames") and dev.debug_select(0)); assert(calls.has("minigame:m1"))
	assert(dev.select_section("narrative") and dev.debug_select(0)); assert(calls.has("warp:n1")); dev.destroy()

	var inventory := ProbePanel.new(); state.register_panel("inventory", inventory)
	state.set_state(RuntimeGameStateController.EXPLORING)
	var touch := RuntimeTouchMobileControls.new(renderer, input, state, strings, true); touch.update(); assert(touch.root.visible and touch.explore_group.visible)
	touch.debug_direction("u", true); touch.debug_direction("r", true); assert(input.get_movement_direction().is_equal_approx(Vector2(1, -1).normalized()))
	touch.debug_direction("u", false); touch.debug_run(true); assert(input.is_running()); touch.debug_interact(); assert(input.was_key_just_pressed("KeyE"))
	touch.debug_toggle_panel("inventory"); touch.update(); assert(inventory.opened and state.current_state == RuntimeGameStateController.UI_OVERLAY and not touch.explore_group.visible and touch.overlay_group.visible and input.get_movement_direction() == Vector2.ZERO and not input.is_running())
	touch.debug_back(); assert(not inventory.opened and state.current_state == RuntimeGameStateController.EXPLORING)
	touch.destroy(); assert(input.get_movement_direction() == Vector2.ZERO)
	state.destroy(); input.destroy(); renderer.destroy_renderer()
	print("DebugPanel/DevMode/TouchMobileControls shared-state/input lifecycle test: PASS"); get_tree().quit(0)
