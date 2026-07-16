extends Node

var notifications: Array = []


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository)); var events := RuntimeEventBus.new(); events.on("notification:show", func(payload: Variant) -> void: notifications.push_back(payload)); var flags := RuntimeFlagStore.new(events); flags.configure_registry(assets.load_json("/assets/data/flag_registry.json")); var strings := RuntimeStringsProvider.new(); strings.load(assets); var executor := RuntimeActionExecutor.new(events, flags)
	var inventory := RuntimeInventoryManager.new(events, flags); inventory.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); await inventory.load_defs(); assert(inventory.loaded); var rules := RuntimeRulesManager.new(events, flags); rules.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); await rules.load_defs(); var quests := RuntimeQuestManager.new(events, flags, executor); quests.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); await quests.load_defs(); var offers := RuntimeRuleOfferRegistry.new()
	var condition_factory := func() -> Dictionary:
		return {"flagStore": flags, "questManager": quests, "scenarioState": null, "narrativeState": null, "getActivePlaneId": func() -> String: return "normal", "resolveConditionLiteral": func(value: String) -> String: return value, "currentOwner": null, "currentSceneId": ""}
	flags.set_condition_eval_context_factory(condition_factory)
	inventory.set_condition_eval_context_factory(condition_factory)
	quests.set_condition_eval_context_factory(condition_factory)
	preload("res://tests/support/action_registry_fixture.gd").register(executor, {
		"ruleOfferRegistry": offers,
		"inventoryManager": inventory,
		"rulesManager": rules,
		"questManager": quests,
		"stringsProvider": strings,
		"eventBus": events,
		"resolveDisplayText": func(text: String) -> String: return "7" if text == "{{amount}}" else text,
	})
	await executor.execute_await({"type": "giveItem", "params": {"id": "taomu", "count": 2}}); assert(inventory.get_item_count("taomu") == 2); await executor.execute_await({"type": "removeItem", "params": {"id": "taomu", "count": 1}}); assert(inventory.get_item_count("taomu") == 1)
	await executor.execute_await({"type": "giveCurrency", "params": {"amount": "{{amount}}"}}); assert(inventory.get_coins() == 7); await executor.execute_await({"type": "removeCurrency", "params": {"amount": 2.9}}); assert(inventory.get_coins() == 5); await executor.execute_await({"type": "giveCurrency", "params": {"amount": -2}}); assert(inventory.get_coins() == 5)
	await executor.execute_await({"type": "pickup", "params": {"itemId": "nuomi", "itemName": "糯米", "count": 2}}); await executor.execute_await({"type": "pickup", "params": {"itemId": "copper_coins", "itemName": "铜钱", "count": "3", "isCurrency": true}}); assert(inventory.get_item_count("nuomi") == 2 and inventory.get_coins() == 8)
	await executor.execute_await({"type": "giveRule", "params": {"id": "rule_no_go_night"}}); await executor.execute_await({"type": "grantRuleLayer", "params": {"ruleId": "rule_no_go_night", "layer": "xiang"}}); await executor.execute_await({"type": "giveFragment", "params": {"id": "frag_zombie_fire_01"}}); assert(rules.has_rule("rule_no_go_night") and rules.has_layer("rule_no_go_night", "xiang") and rules.has_fragment("frag_zombie_fire_01"))
	await executor.execute_await({"type": "updateQuest", "params": {"id": "opening_01"}}); assert(quests.get_status("opening_01") == RuntimeQuestManager.ACTIVE)
	await executor.execute_await({"type": "runActions", "params": {"actions": [{"type": "enableRuleOffers", "params": {"slots": [{"ruleId": "rule_no_go_night", "resultActions": []}]}}]}}, {"zoneId": "z"}); assert(offers.get_aggregated_slots().size() == 1); await executor.execute_await({"type": "disableRuleOffers", "params": {}}, {"zoneId": "z"}); assert(offers.get_aggregated_slots().is_empty())
	# Purchase success, insufficient funds, and full-bag refund.
	await executor.execute_await({"type": "shopPurchase", "params": {"itemId": "shaojiu", "price": 5}}); assert(inventory.get_item_count("shaojiu") == 1 and inventory.get_coins() == 3 and notifications[-1].text == "购买了 烧酒")
	await executor.execute_await({"type": "shopPurchase", "params": {"itemId": "taomu", "price": 99}}); assert(inventory.get_coins() == 3 and notifications[-1].text == "铜钱不足!")
	var full_items := {}
	for index in 12: full_items["full_%s" % index] = 1
	inventory.deserialize({"items": full_items, "coins": 10}); var notice_before := notifications.size(); await executor.execute_await({"type": "shopPurchase", "params": {"itemId": "taomu", "price": 3}}); assert(inventory.get_coins() == 10 and not inventory.has_item("taomu") and notifications.size() > notice_before)
	inventory.deserialize({"items": {"taomu": 1}, "coins": 0}); await executor.execute_await({"type": "inventoryDiscard", "params": {"itemId": "taomu"}}); assert(not inventory.has_item("taomu"))
	for type: String in ["enableRuleOffers", "disableRuleOffers", "giveItem", "removeItem", "giveCurrency", "removeCurrency", "giveRule", "grantRuleLayer", "giveFragment", "updateQuest", "pickup", "shopPurchase", "inventoryDiscard"]: assert(executor.has_handler(type))
	quests.destroy(); quests.free(); rules.destroy(); rules.free(); inventory.destroy(); inventory.free(); offers.clear(); executor.destroy(); flags.destroy(); events.clear(); assets.dispose()
	print("Inventory/rules/quest/shop Action contract test: PASS"); get_tree().quit(0)
