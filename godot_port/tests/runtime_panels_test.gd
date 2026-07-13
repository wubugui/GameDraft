extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	var inventory: RuntimeInventoryManager = bootstrap.runtime_root.get_system("inventoryManager")
	var queue_before: int = bootstrap.notification_ui.get_queue_count()
	bootstrap.runtime_root.event_bus.emit("notification:show", {"text": "一", "type": "info"}); bootstrap.runtime_root.event_bus.emit("notification:show", {"text": "二", "type": "warning"})
	assert(bootstrap.notification_ui.get_queue_count() == queue_before + 2); bootstrap.notification_ui.debug_flush_one(); assert(bootstrap.notification_ui.get_visible_count() == 1 and bootstrap.notification_ui.get_queue_count() == queue_before + 1)
	var toast: Control = bootstrap.notification_ui.entries[0].node; var toast_panel: Panel = toast.get_child(0); var toast_label: Label = toast.get_child(1); var toast_style: StyleBoxFlat = toast_panel.get_theme_stylebox("panel")
	assert(toast.size == Vector2(240, 30), "toast dimensions must match Pixi"); assert(toast.position == Vector2((bootstrap.renderer.get_screen_width() - 240) / 2.0, 50), "toast anchor must match Pixi")
	assert(toast_label.position == Vector2(10, 8) and toast_label.horizontal_alignment == HORIZONTAL_ALIGNMENT_LEFT, "toast text inset/alignment must match Pixi"); assert(bootstrap.notification_ui._color("archive").is_equal_approx(Color("aaaacc")), "unknown notification types must use Pixi's info fallback color")
	assert(toast_style.bg_color.is_equal_approx(Color("130f0a", 0.85)) and toast_style.border_color.is_equal_approx(Color("574733")), "toast panel skin must match Pixi")
	await bootstrap.action_executor.execute_await({"type": "pickup", "params": {"itemId": "taomu", "itemName": "桃木", "count": 2}})
	assert(inventory.get_item_count("taomu") == 2 and bootstrap.pickup_notification.get_visible_count() == 1)
	bootstrap.input_manager.debug_key_down("KeyI"); bootstrap.input_manager.debug_key_up("KeyI"); assert(bootstrap.inventory_ui.is_open() and bootstrap.state_controller.current_state == RuntimeGameStateController.UI_OVERLAY and bootstrap.inventory_ui.content.text.contains("桃木"))
	assert(bootstrap.inventory_ui.get_action_button_count() >= 1); bootstrap.inventory_ui.action_buttons[0].pressed.emit(); await get_tree().process_frame
	assert(bootstrap.inventory_ui.content.text.contains("×2"))
	bootstrap.inventory_ui.action_buttons[-1].pressed.emit(); await get_tree().process_frame
	await get_tree().process_frame
	assert(inventory.get_item_count("taomu") == 0)
	bootstrap.input_manager.debug_key_down("Escape"); bootstrap.input_manager.debug_key_up("Escape"); assert(not bootstrap.inventory_ui.is_open() and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING)
	await bootstrap.action_executor.execute_await({"type": "updateQuest", "params": {"id": "opening_01"}})
	bootstrap.input_manager.debug_key_down("Tab"); bootstrap.input_manager.debug_key_up("Tab"); assert(bootstrap.quest_panel_ui.is_open() and bootstrap.quest_panel_ui.content.text.length() > 10); bootstrap.input_manager.debug_key_down("Escape"); bootstrap.input_manager.debug_key_up("Escape")
	await bootstrap.action_executor.execute_await({"type": "giveRule", "params": {"id": "rule_no_go_night"}})
	bootstrap.input_manager.debug_key_down("KeyR"); bootstrap.input_manager.debug_key_up("KeyR"); assert(bootstrap.rules_panel_ui.is_open() and bootstrap.rules_panel_ui.content.text.length() > 10); bootstrap.input_manager.debug_key_down("Escape"); bootstrap.input_manager.debug_key_up("Escape")
	bootstrap.pickup_notification.force_cleanup(); bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout
	print("Notification/Pickup/Inventory/Quest/Rules UI data/input/action lifecycle test: PASS"); get_tree().quit(0)
