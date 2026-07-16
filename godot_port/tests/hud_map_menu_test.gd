extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")
const BootstrapScript := preload("res://scripts/bootstrap.gd")
func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	assert(bootstrap.map_ui.current_scene_id == bootstrap.scene_manager.get_current_scene_id(), "initial scene:enter must flow through the already-initialized EventBridge")
	assert(bootstrap.quest_manager.get_status("xg01_tingshu") == RuntimeQuestManager.ACTIVE and bootstrap.hud.quest.text == "当前：听先生说书")
	var inventory: RuntimeInventoryManager = bootstrap.inventory_manager; inventory.add_coins(12); await bootstrap.action_executor.execute_await({"type": "updateQuest", "params": {"id": "opening_01"}}); bootstrap.runtime_root.event_bus.emit("player:healthChanged", {"current": 25, "max": 100}); bootstrap.runtime_root.event_bus.emit("player:smellChanged", {"scent": "corpse", "intensity": 80, "dir": -0.5, "flicker": true}); bootstrap.runtime_root.event_bus.emit("zone:ruleAvailable", {}); bootstrap.hud.update(0.2)
	assert(bootstrap.hud.coin.text.contains("12") and bootstrap.hud.quest.text.begins_with("当前：") and bootstrap.hud.quest_bg.visible and bootstrap.hud.quest.position.x > bootstrap.renderer.screen_width / 2.0 and is_equal_approx(bootstrap.hud.health_ratio, 0.25) and bootstrap.hud.rule_hint.visible and bootstrap.hud.rule_hint_bg.visible and bootstrap.hud.smell.get_state().scent == "corpse")
	assert(bootstrap.hud.flames.size() == 3 and bootstrap.hud.flames[0].get_script().resource_path == "res://scripts/ui/hud_flame.gd" and bootstrap.hud.flames[0].position == Vector2(16, 70))
	assert(bootstrap.hud.smell.root.position == Vector2(34, 160) and bootstrap.hud.smell.baseline.size() == 3 and bootstrap.hud.smell.wisps.size() == 30 and bootstrap.hud.smell.reaches.size() == 6)
	assert(bootstrap.plane_reconciler.activate_plane_manually("背尸")); InputManagerProbe.key_down(bootstrap.input_manager, "KeyM"); InputManagerProbe.key_up(bootstrap.input_manager, "KeyM"); assert(not bootstrap.map_ui.is_open()); bootstrap.plane_reconciler.deactivate_manual_plane()
	InputManagerProbe.key_down(bootstrap.input_manager, "KeyM"); InputManagerProbe.key_up(bootstrap.input_manager, "KeyM")
	assert(bootstrap.map_ui.is_open())
	assert(bootstrap.map_ui.get_configured_scene_ids().size() == 18)
	assert(bootstrap.map_ui.content.text.contains("茶馆"))
	for button: Button in bootstrap.map_ui.action_buttons:
		if button.get_meta("action_id", "") == "雾津街头": button.pressed.emit(); break
	for _index in 60:
		await get_tree().process_frame
		if bootstrap.scene_manager.get_current_scene_id() == "雾津街头" and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING: break
	assert(bootstrap.scene_manager.get_current_scene_id() == "雾津街头" and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)
	InputManagerProbe.key_down(bootstrap.input_manager, "Escape"); InputManagerProbe.key_up(bootstrap.input_manager, "Escape"); assert(bootstrap.menu_ui.is_open() and bootstrap.state_controller.current_state == RuntimeDataTypes.UI_OVERLAY); bootstrap.menu_ui.debug_mode("settings"); var before: float = bootstrap.audio_manager.get_volume("bgm"); bootstrap.menu_ui.debug_set_volume("bgm", 0.42); assert(is_equal_approx(bootstrap.audio_manager.get_volume("bgm"), 0.42) and bootstrap.menu_ui.content.text.contains("42%")); bootstrap.audio_manager.set_volume("bgm", before); bootstrap.menu_ui.debug_mode("pause"); bootstrap.menu_ui.action_buttons[0].pressed.emit(); await get_tree().process_frame; assert(not bootstrap.menu_ui.is_open() and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)
	InputManagerProbe.key_down(bootstrap.input_manager, "Escape"); InputManagerProbe.key_up(bootstrap.input_manager, "Escape"); assert(bootstrap.menu_ui.is_open()); bootstrap.menu_ui.action_buttons[-1].pressed.emit(); await get_tree().process_frame; assert(bootstrap.state_controller.current_state == RuntimeDataTypes.MAIN_MENU and bootstrap.menu_ui.is_open() and bootstrap.menu_ui.mode == "main" and EventBridgeProbe.has_started_session(bootstrap.event_bridge))
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout; print("HUD/Smell/Map/Menu shared-data/events/travel/settings lifecycle test: PASS"); get_tree().quit(0)
