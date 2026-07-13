extends Node

var events: Array = []
var narrative_reached: Dictionary = {}
var flags: RuntimeFlagStore


func _ready() -> void:
	await _run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var strings := RuntimeStringsProvider.new()
	assert(strings.load(assets))
	var bus := RuntimeEventBus.new()
	for event in ["quest:accepted", "quest:completed", "notification:show"]:
		bus.on(event, Callable(self, "_record_event").bind(event))
	flags = RuntimeFlagStore.new(bus)
	flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	var state := RuntimeGameStateController.new()
	var executor := RuntimeActionExecutor.new(bus, flags, state)
	var quests := RuntimeQuestManager.new(bus, flags, executor)
	quests.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	quests.set_condition_eval_context_factory(func() -> Dictionary:
		return {"evaluateList": Callable(self, "_evaluate_conditions")}
	)
	assert(quests.load_defs() and quests.definition_count() == 24)
	assert(quests.serialize().size() == 24)

	quests.accept_quest("opening_01")
	assert(quests.get_status("opening_01") == RuntimeQuestManager.ACTIVE)
	assert(quests.get_current_main_quest().id == "opening_01")
	flags.set_value("heard_teahouse_story", true)
	assert(quests.get_status("opening_01") == RuntimeQuestManager.COMPLETED)
	assert(quests.get_status("opening_02") == RuntimeQuestManager.ACTIVE)
	assert(flags.get_value("quest_opening_01_status") == RuntimeQuestManager.COMPLETED)
	assert(events.any(func(entry: Dictionary) -> bool: return entry.event == "quest:completed" and entry.payload.questId == "opening_01"))

	# An inactive quest whose completion state is already true catches up and chains.
	flags.set_value("box_hidden_in_temple", true)
	assert(quests.get_status("opening_03") == RuntimeQuestManager.COMPLETED)
	assert(quests.get_status("opening_04") == RuntimeQuestManager.ACTIVE)

	# Narrative source changes activate and then complete a preconditioned quest.
	narrative_reached["scenario_枯井:hired"] = true
	bus.emit("narrative:stateChanged", {})
	assert(quests.get_status("xg07_kujing") == RuntimeQuestManager.ACTIVE)
	narrative_reached["scenario_枯井:fled"] = true
	bus.emit("narrative:stateChanged", {})
	assert(quests.get_status("xg07_kujing") == RuntimeQuestManager.COMPLETED)

	# Existing side quest proves acceptActions and rewards execute before events/chaining.
	var side := "支线-抓水猴子-查看水边情况"
	quests.accept_quest(side)
	await get_tree().process_frame
	assert(flags.get_value("Q抓水猴子_禁止离开码头") == true)
	assert(quests.get_status(side) == RuntimeQuestManager.ACTIVE)
	quests._complete_quest(side)
	await get_tree().process_frame
	assert(flags.get_value("Q抓水猴子_禁止离开码头") == false)
	assert(quests.get_status("支线-抓水猴子-找回漂浮的箱子") == RuntimeQuestManager.ACTIVE)

	# Restore rebuilds status flags and HUD tracking without fake notifications.
	events.clear()
	quests.set_restoring(true)
	quests.deserialize({"opening_05": RuntimeQuestManager.ACTIVE, "opening_04": RuntimeQuestManager.COMPLETED})
	quests.set_restoring(false)
	assert(quests.serialize() == {"opening_05": 1, "opening_04": 2})
	assert(events.size() == 1 and events[0].event == "quest:accepted" and events[0].payload.restored == true)
	assert(flags.get_value("quest_opening_04_status") == RuntimeQuestManager.COMPLETED)

	quests.debug_set_quest_status("manual", "accepted")
	assert(quests.get_status("manual") == RuntimeQuestManager.ACTIVE)
	quests.debug_set_quest_status("manual", "completed")
	assert(quests.get_status("manual") == RuntimeQuestManager.COMPLETED)

	quests.destroy()
	quests.free()
	executor.destroy()
	state.destroy()
	flags.destroy()
	bus.clear()
	assets.dispose()
	print("QuestManager contract test: PASS")
	get_tree().quit(0)


func _evaluate_conditions(conditions: Array) -> bool:
	for raw: Variant in conditions:
		if not raw is Dictionary:
			return false
		var condition: Dictionary = raw
		if condition.get("flag") is String:
			if not flags.eval_pure_flag_conjunction([condition]):
				return false
		elif condition.get("narrative") is String:
			var key := "%s:%s" % [condition.narrative, condition.get("state", "")]
			if narrative_reached.get(key, false) != true:
				return false
		else:
			return false
	return true


func _record_event(payload: Variant, event: String) -> void:
	events.push_back({"event": event, "payload": payload})
