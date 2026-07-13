extends SceneTree

var events: Array = []


func _init() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var strings := RuntimeStringsProvider.new()
	assert(strings.load(assets))
	var bus := RuntimeEventBus.new()
	for event in ["inventory:full", "notification:show", "item:acquired", "item:consumed", "currency:changed"]:
		bus.on(event, Callable(self, "_record_event").bind(event))
	var flags := RuntimeFlagStore.new(bus)
	flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	var inventory := RuntimeInventoryManager.new(bus, flags)
	inventory.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	assert(inventory.load_defs() and inventory.definition_count() == 17)
	assert(inventory.get_item_def("iron_box").name == "铁盒子")

	assert(inventory.add_item("taomu", 20))
	assert(inventory.get_item_count("taomu") == 10)
	assert(flags.get_value("has_item_taomu") == true and flags.get_value("item_count_taomu") == 10.0)
	assert(inventory.remove_item("taomu", 3) and inventory.get_item_count("taomu") == 7)
	assert(not inventory.remove_item("taomu", 8))

	# Fill 12 distinct slots, reject the 13th ordinary item, then allow a critical bypass.
	for index in 11:
		assert(inventory.add_item("filler_%s" % index, 1))
	assert(inventory.get_all_items().size() == 12)
	assert(not inventory.add_item("ordinary_overflow", 1))
	assert(not inventory.has_item("ordinary_overflow"))
	assert(events.any(func(entry: Dictionary) -> bool: return entry.event == "inventory:full" and entry.payload.itemId == "ordinary_overflow"))
	assert(inventory.add_item("critical_story_item", 1, {"bypassSlotLimit": true}))
	assert(inventory.get_all_items().size() == 13)

	assert(inventory.add_coins(10.0) and inventory.get_coins() == 10.0)
	assert(not inventory.remove_coins(11.0) and inventory.remove_coins(4.0) and inventory.get_coins() == 6.0)
	assert(not inventory.add_coins(NAN) and not inventory.remove_coins(INF))
	assert(flags.get_value("coins") == 6.0)

	assert(inventory.get_item_description("iron_box").contains("千万别打开"))
	flags.set_value("box_opened", true)
	assert(inventory.get_item_description("iron_box").contains("小铜镜"))
	assert(inventory.can_discard("taomu") and not inventory.can_discard("iron_box"))
	inventory.discard_item("iron_box")
	assert(inventory.has_item("critical_story_item"))
	inventory.discard_item("taomu")
	assert(not inventory.has_item("taomu") and flags.get_value("has_item_taomu") == false)

	events.clear()
	inventory.deserialize({"items": {"iron_box": 1.0}, "coins": 9.0})
	assert(inventory.serialize() == {"items": {"iron_box": 1}, "coins": 9.0})
	assert(events.any(func(entry: Dictionary) -> bool: return entry.event == "currency:changed" and entry.payload.restored == true and entry.payload.amount == 0))
	inventory.destroy()
	assert(inventory.serialize() == {"items": {}, "coins": 0.0})
	inventory.free()
	flags.destroy()
	bus.clear()
	assets.dispose()
	print("InventoryManager contract test: PASS")
	quit(0)


func _record_event(payload: Variant, event: String) -> void:
	events.push_back({"event": event, "payload": payload})
