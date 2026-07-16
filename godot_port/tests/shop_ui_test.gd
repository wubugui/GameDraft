extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")

var opened: Array = []
var closed := 0


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	await get_tree().process_frame
	bootstrap.runtime_root.event_bus.on("shop:opened", func(payload: Variant) -> void: opened.push_back(payload))
	bootstrap.runtime_root.event_bus.on("shop:closed", func(_payload: Variant) -> void: closed += 1)
	var inventory: RuntimeInventoryManager = bootstrap.inventory_manager
	assert(bootstrap.shop_ui.get_shop_ids().size() == 2 and bootstrap.action_executor.has_handler("openShop"))
	inventory.add_coins(10); assert(inventory.get_coins() == 10.0)
	await bootstrap.action_executor.execute_await({"type": "openShop", "params": {"shopId": "teahouse_shop"}})
	assert(bootstrap.shop_ui.is_open() and bootstrap.shop_ui.get_item_count() == 5 and bootstrap.state_controller.current_state == RuntimeDataTypes.UI_OVERLAY)
	assert(opened.size() == 1 and opened[0].shopId == "teahouse_shop" and bootstrap.shop_ui.root.get_parent() == bootstrap.renderer.ui_layer)
	assert(bootstrap.shop_ui.get_row_state("taomu").enabled and bootstrap.shop_ui.get_row_state("talisman").enabled)
	bootstrap.shop_ui.debug_purchase("taomu")
	await get_tree().process_frame
	assert(inventory.get_item_count("taomu") == 1 and inventory.get_coins() == 7)
	assert(not bootstrap.shop_ui.get_row_state("talisman").enabled)
	bootstrap.shop_ui.debug_purchase("talisman")
	await get_tree().process_frame
	assert(not inventory.has_item("talisman") and inventory.get_coins() == 7)
	bootstrap.shop_ui.close()
	assert(not bootstrap.shop_ui.is_open() and closed == 1 and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)
	await bootstrap.action_executor.execute_await({"type": "openShop", "params": {"shopId": "peddler_shop"}})
	assert(bootstrap.shop_ui.is_open() and opened[-1].shopId == "peddler_shop" and not bootstrap.shop_ui.get_row_state("taomu").enabled and bootstrap.shop_ui.get_row_state("nuomi").enabled)
	InputManagerProbe.key_down(bootstrap.input_manager, "Escape")
	InputManagerProbe.key_up(bootstrap.input_manager, "Escape")
	# Shop is Action-opened rather than a shortcut panel; mirror the TS close button path.
	bootstrap.shop_ui.close()
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING and closed == 2)
	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	await get_tree().process_frame
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("ShopUI 2-def/open/purchase/insufficient/rebuild/close/state Action integration test: PASS")
	get_tree().quit(0)
