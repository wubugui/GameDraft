extends SceneTree


class AssetManagerStub extends RuntimeAssetManager:
	var responses: Array = []
	var load_count := 0

	func load_json(_path: String) -> Variant:
		var response: Variant = responses[load_count] if load_count < responses.size() else null
		load_count += 1
		return response


var events: Array = []


func _init() -> void:
	_run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var strings := RuntimeStringsProvider.new()
	strings.load(assets)
	var bus := RuntimeEventBus.new()
	for event in ["inventory:full", "notification:show", "item:acquired", "item:consumed", "currency:changed"]:
		bus.on(event, Callable(self, "_record_event").bind(event))
	var flags := RuntimeFlagStore.new(bus)
	flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	var inventory := RuntimeInventoryManager.new(bus, flags)
	inventory.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})

	await inventory.load_defs()
	var loaded_array: Array = assets.get_json("/assets/data/items.json")
	assert(inventory.loaded and inventory.item_defs.size() == loaded_array.size())
	assert(inventory.get_item_def("iron_box").name == "铁盒子")
	var source_iron_box: Variant = loaded_array.filter(func(definition: Dictionary) -> bool: return definition.id == "iron_box")[0]
	assert(is_same(inventory.get_item_def("iron_box"), source_iron_box))

	# The source Map is not cleared between loadDefs calls. A malformed entry
	# takes the outer catch path after retaining definitions inserted before it.
	var first_definition := {"id": " first ", "name": "first"}
	var before_failure := {"id": "before_failure", "name": "before"}
	var after_failure := {"id": "after_failure", "name": "after"}
	var stub_assets := AssetManagerStub.new()
	stub_assets.responses = [[first_definition], [before_failure, null, after_failure], null]
	inventory.init({"strings": strings, "assetManager": stub_assets})
	await inventory.load_defs()
	assert(inventory.item_defs.has(" first ") and is_same(inventory.item_defs[" first "], first_definition))
	first_definition.note = "same-object"
	assert(inventory.item_defs[" first "].note == "same-object" and inventory.item_defs.has("iron_box"))
	inventory.loaded = false
	await inventory.load_defs()
	assert(inventory.loaded and inventory.item_defs.has("before_failure") and not inventory.item_defs.has("after_failure"))
	inventory.loaded = false
	await inventory.load_defs()
	assert(inventory.loaded and inventory.item_defs.has("before_failure"))

	assert(inventory.add_item("taomu", 20.0))
	assert(inventory.get_item_count("taomu") == 10.0)
	assert(flags.get_value("has_item_taomu") == true and flags.get_value("item_count_taomu") == 10.0)
	assert(inventory.remove_item("taomu", 3.0) and inventory.get_item_count("taomu") == 7.0)
	assert(not inventory.remove_item("taomu", 8.0))
	assert(inventory.add_item("fractional", 1.5) and inventory.get_item_count("fractional") == 1.5)
	assert(inventory.remove_item("fractional", 0.25) and inventory.get_item_count("fractional") == 1.25)
	assert(inventory.remove_item("fractional", 1.25) and not inventory.has_item("fractional"))

	# Fill 12 distinct slots, reject the 13th ordinary item, then allow a critical bypass.
	for index in 11:
		assert(inventory.add_item("filler_%s" % index, 1.0))
	assert(inventory.get_all_items().size() == 12)
	var filler_entry: Dictionary = inventory.get_all_items().filter(func(entry: Dictionary) -> bool: return entry.id == "filler_0")[0]
	assert(filler_entry.has("def") and filler_entry.def == null)
	assert(not inventory.add_item("ordinary_overflow", 1.0))
	assert(not inventory.has_item("ordinary_overflow"))
	assert(events.any(func(entry: Dictionary) -> bool: return entry.event == "inventory:full" and entry.payload.itemId == "ordinary_overflow"))
	assert(inventory.add_item("critical_story_item", 1.0, {"bypassSlotLimit": true}))
	assert(inventory.get_all_items().size() == 13)

	inventory.add_coins(10.0)
	assert(inventory.get_coins() == 10.0)
	assert(not inventory.remove_coins(11.0) and inventory.remove_coins(4.0) and inventory.get_coins() == 6.0)
	inventory.add_coins(NAN)
	assert(not inventory.remove_coins(INF) and inventory.get_coins() == 6.0)
	assert(flags.get_value("coins") == 6.0)

	var condition_factory := func() -> Dictionary:
		return {"flagStore": flags, "questManager": null, "scenarioState": null, "narrativeState": null, "getActivePlaneId": func() -> String: return "normal", "resolveConditionLiteral": func(value: String) -> String: return value, "currentOwner": null, "currentSceneId": ""}
	inventory.set_condition_eval_context_factory(condition_factory)
	assert(inventory.get_item_description("iron_box").contains("千万别打开"))
	flags.set_value("box_opened", true)
	assert(inventory.get_item_description("iron_box").contains("小铜镜"))
	assert(inventory.can_discard("taomu") and not inventory.can_discard("iron_box"))
	inventory.discard_item("iron_box")
	assert(inventory.has_item("critical_story_item"))
	inventory.discard_item("taomu")
	assert(not inventory.has_item("taomu") and flags.get_value("has_item_taomu") == false)

	events.clear()
	inventory.deserialize({"items": {"iron_box": 1.25}, "coins": 9.0})
	assert(inventory.serialize() == {"items": {"iron_box": 1.25}, "coins": 9.0})
	assert(inventory.get_item_count("iron_box") == 1.25)
	# deserialize mirrors the source exactly: flags for removed pre-load slots are
	# not proactively cleared; only restored entries are synchronized.
	assert(flags.get_value("has_item_critical_story_item") == true)
	assert(events.any(func(entry: Dictionary) -> bool: return entry.event == "currency:changed" and entry.payload.restored == true and entry.payload.amount == 0))
	var snapshot: Dictionary = inventory.serialize()
	snapshot.items.iron_box = 99.0
	assert(inventory.get_item_count("iron_box") == 1.25)

	var owned_asset_manager := inventory.asset_manager
	inventory.destroy()
	assert(inventory.serialize() == {"items": {}, "coins": 0.0})
	assert(inventory.loaded and inventory.asset_manager == owned_asset_manager and inventory.condition_ctx_factory == condition_factory)
	inventory.free()
	flags.destroy(); bus.clear(); assets.dispose(); stub_assets.dispose()
	print("InventoryManager field/load/number/events/save direct-translation test: PASS")
	quit(0)


func _record_event(payload: Variant, event: String) -> void:
	events.push_back({"event": event, "payload": payload})
