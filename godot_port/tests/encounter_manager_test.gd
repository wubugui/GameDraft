extends Node


class AssetManagerStub extends RuntimeAssetManager:
	var responses: Array = []
	var load_count := 0

	func load_json(_path: String) -> Variant:
		var response: Variant = responses[load_count] if load_count < responses.size() else null
		load_count += 1
		return response


var log: Array = []


func _ready() -> void:
	await _run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var events := RuntimeEventBus.new()
	for name: String in ["encounter:start", "encounter:narrative", "encounter:options", "encounter:result", "encounter:end"]:
		events.on(name, Callable(self, "_record").bind(name))
	var flags := RuntimeFlagStore.new(events); flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	var strings := RuntimeStringsProvider.new(); strings.load(assets)
	var input := RuntimeInputManager.new(); var state := RuntimeGameStateController.new(input, events)
	var actions := RuntimeActionExecutor.new(events, flags, state)
	actions.register("rejectEncounter", func(_params: Dictionary, _zone: Variant) -> bool: return false, [])
	var inventory := RuntimeInventoryManager.new(events, flags)
	inventory.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); await inventory.load_defs()
	var rules := RuntimeRulesManager.new(events, flags)
	rules.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); await rules.load_defs()
	var quests := RuntimeQuestManager.new(events, flags, actions)
	quests.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); await quests.load_defs()
	var offers := RuntimeRuleOfferRegistry.new()
	var condition_factory := func() -> Dictionary:
		return {"flagStore": flags, "questManager": quests, "scenarioState": null, "narrativeState": null, "resolveConditionLiteral": func(value: String) -> String: return value, "currentSceneId": "", "currentOwner": null, "getActivePlaneId": func() -> String: return "normal"}
	flags.set_condition_eval_context_factory(condition_factory)
	inventory.set_condition_eval_context_factory(condition_factory)
	quests.set_condition_eval_context_factory(condition_factory)
	preload("res://tests/support/action_registry_fixture.gd").register(actions, {"ruleOfferRegistry": offers, "inventoryManager": inventory, "rulesManager": rules, "questManager": quests, "stringsProvider": strings, "eventBus": events})

	# loadDefs retains prior Map entries and exact definition objects. Failure does
	# not clear the successful loads that came before it.
	var first_definition := {"id": " first ", "narrative": "一", "options": []}
	var second_definition := {"id": "second", "narrative": "二", "options": []}
	var stub_assets := AssetManagerStub.new(); stub_assets.responses = [[first_definition], [second_definition], null]
	var load_probe := RuntimeEncounterManager.new(events, flags, actions)
	load_probe.init({"strings": strings, "assetManager": stub_assets})
	await load_probe.load_defs()
	assert(load_probe.has_encounter(" first ") and not load_probe.has_encounter("first"))
	assert(is_same(load_probe.encounter_defs[" first "], first_definition))
	first_definition.note = "same-object"
	await load_probe.load_defs()
	assert(load_probe.encounter_defs[" first "].note == "same-object" and load_probe.has_encounter("second"))
	await load_probe.load_defs(); assert(load_probe.has_encounter("second"))
	load_probe.destroy(); load_probe.free()

	var manager := RuntimeEncounterManager.new(events, flags, actions)
	manager.init({"strings": strings, "assetManager": assets})
	await manager.load_defs()
	assert(manager.encounter_defs.size() == 2 and manager.has_encounter("old_box_encounter") and manager.has_encounter("ghost_encounter"))
	manager.set_condition_eval_context_factory(condition_factory)
	manager.set_rule_name_resolver(func(id: String) -> Variant: return rules.get_rule_def(id))
	manager.set_resolve_display(func(text: String) -> String: return text.replace("{{name}}", "已解算"))

	manager.start_encounter("missing")
	assert(not manager.is_active())
	manager.start_encounter("old_box_encounter")
	assert(manager.is_active() and log[-1].event == "encounter:narrative")
	manager.generate_options()
	assert(manager.current_options.size() == 2 and manager.current_options[0].enabled)
	var first_options := manager.current_options
	var options_event: Dictionary = log.filter(func(entry: Dictionary) -> bool: return entry.event == "encounter:options")[-1]
	assert(is_same(options_event.payload.options, manager.current_options))
	var source_option: Dictionary = manager.current_encounter.options[0]
	assert(is_same(manager.current_options[0].consumeItems, source_option.get("consumeItems")))
	assert(is_same(manager.current_options[0].resultActions, source_option.resultActions))
	manager.generate_options()
	assert(not is_same(manager.current_options, first_options))
	await manager.choose_option(0)
	assert(flags.get_value("read_box_note") == true and log[-1].event == "encounter:result" and not manager.resolving)
	manager.end_encounter(); assert(not manager.is_active() and log[-1].event == "encounter:end")

	manager.start_encounter("ghost_encounter"); manager.generate_options()
	var options := manager.current_options
	assert(options.size() == 3 and options[1].type == "special" and options[1].enabled == false)
	flags.set_value("rule_rule_no_go_night_discovered", true)
	manager.generate_options(); options = manager.current_options
	assert(options.size() == 4 and options[1].type == "rule" and options[1].enabled == false)
	assert(inventory.add_item("taomu", 1.0)); manager.generate_options(); options = manager.current_options
	assert(options[2].type == "special" and options[2].enabled == true)
	manager.choose_option(2); await manager.choose_option(2); await get_tree().process_frame
	assert(inventory.get_item_count("taomu") == 0.0 and flags.get_value("ghost_used_taomu") == true and log[-1].event == "encounter:result")
	manager.end_encounter()

	# startEncounter replaces only currentEncounter/active. It does not clear the
	# previous options or reset an in-flight resolving guard.
	manager.start_encounter("old_box_encounter"); manager.generate_options()
	var retained_options := manager.current_options
	manager.resolving = true
	manager.start_encounter("ghost_encounter")
	assert(is_same(manager.current_options, retained_options) and manager.resolving and manager.current_encounter.id == "ghost_encounter")
	manager.resolving = false; manager.end_encounter()

	manager.encounter_defs.reject_result = {"id": "reject_result", "narrative": "拒绝", "options": [{"text": "选", "type": "general", "conditions": [], "resultActions": [{"type": "rejectEncounter", "params": {}}], "resultText": "仍显示"}]}
	manager.start_encounter("reject_result"); manager.generate_options(); await manager.choose_option(0)
	assert(log[-1].event == "encounter:result" and not manager.resolving)
	manager.end_encounter()

	# A rejected removeItem Promise propagates through the engine false channel,
	# emits no result, and still releases the source finally guard.
	actions.register("removeItem", func(_params: Dictionary, _zone: Variant) -> bool: return false, ["id", "count"])
	manager.encounter_defs.reject_consume = {"id": "reject_consume", "narrative": "拒绝消耗", "options": [{"text": "选", "type": "general", "conditions": [], "consumeItems": [{"id": "x", "count": 0}], "resultActions": [], "resultText": "不显示"}]}
	manager.start_encounter("reject_consume"); manager.generate_options()
	var log_size_before := log.size()
	assert(await manager.choose_option(0) == false and not manager.resolving and log.size() == log_size_before)
	manager.end_encounter()

	manager.encounter_defs.synthetic_empty = {"id": "synthetic_empty", "narrative": "空", "options": [{"text": "隐藏", "type": "general", "conditions": [{"flag": "never_visible", "op": "==", "value": true}], "resultActions": []}]}
	manager.start_encounter("synthetic_empty"); manager.generate_options()
	assert(not manager.is_active() and log[-1].event == "encounter:end")

	var owned_condition_factory: Variant = manager.condition_ctx_factory
	var owned_rule_resolver: Variant = manager.rule_name_resolver
	var owned_display_resolver: Variant = manager.resolve_display
	manager.resolving = true
	manager.destroy()
	assert(manager.encounter_defs.is_empty() and not manager.active and manager.resolving)
	assert(manager.condition_ctx_factory == owned_condition_factory and manager.rule_name_resolver == owned_rule_resolver and manager.resolve_display == owned_display_resolver)
	manager.free()
	quests.destroy(); quests.free(); rules.destroy(); rules.free(); inventory.destroy(); inventory.free(); offers.clear()
	actions.destroy(); state.destroy(); input.destroy(); input.free(); flags.destroy(); events.clear(); assets.dispose(); stub_assets.dispose()
	print("EncounterManager field/load/options/resolve/finally direct-translation test: PASS")
	get_tree().quit(0)


func _record(payload: Variant, event: String) -> void:
	log.push_back({"event": event, "payload": payload})
