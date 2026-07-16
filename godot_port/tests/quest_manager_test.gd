extends Node


class AssetManagerStub extends RuntimeAssetManager:
	var responses: Array = []
	var load_count := 0

	func load_json(_path: String) -> Variant:
		var response: Variant = responses[load_count] if load_count < responses.size() else null
		load_count += 1
		return response


var events: Array = []
var narrative_reached: Dictionary = {}
var flags: RuntimeFlagStore
var block_latch := RuntimeAsyncLatch.new()
var block_entered := false


func _ready() -> void:
	await _run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var strings := RuntimeStringsProvider.new(); strings.load(assets)
	var bus := RuntimeEventBus.new()
	for event in ["quest:accepted", "quest:completed", "notification:show"]:
		bus.on(event, Callable(self, "_record_event").bind(event))
	flags = RuntimeFlagStore.new(bus)
	flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	var input := RuntimeInputManager.new()
	var state := RuntimeGameStateController.new(input)
	var executor := RuntimeActionExecutor.new(bus, flags, state)
	executor.register("rejectQuest", func(_params: Dictionary, _zone: Variant) -> bool: return false, [])
	executor.register("blockQuest", Callable(self, "_block_quest"), [])

	# loadDefs retains the Map and exact definition objects across subsequent
	# loads; a failed load leaves both definitions and seeded statuses untouched.
	var first_definition := {"id": " first "}
	var second_definition := {"id": "second"}
	var stub_assets := AssetManagerStub.new()
	stub_assets.responses = [[first_definition], [second_definition], null]
	var load_probe := RuntimeQuestManager.new(bus, flags, executor)
	load_probe.init({"strings": strings, "assetManager": stub_assets})
	await load_probe.load_defs()
	assert(load_probe.quest_defs.has(" first ") and is_same(load_probe.quest_defs[" first "], first_definition))
	first_definition.note = "same-object"
	await load_probe.load_defs()
	assert(load_probe.quest_defs[" first "].note == "same-object" and load_probe.quest_defs.has("second"))
	await load_probe.load_defs()
	assert(load_probe.quest_defs.has(" first ") and load_probe.quest_status.has("second"))
	load_probe.destroy(); load_probe.free()

	var quests := RuntimeQuestManager.new(bus, flags, executor)
	quests.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	quests.set_condition_eval_context_factory(func() -> Dictionary:
		return {"flagStore": flags, "questManager": quests, "narrativeState": self}
	)
	await quests.load_defs()
	assert(quests.quest_defs.size() == 24 and quests.serialize().size() == 24)
	var loaded_definitions: Array = assets.get_json("/assets/data/quests.json")
	assert(is_same(quests.quest_defs.opening_01, loaded_definitions[0]))

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
	await _wait_for_tail(quests)
	assert(flags.get_value("Q抓水猴子_禁止离开码头") == true)
	assert(quests.get_status(side) == RuntimeQuestManager.ACTIVE)
	quests._complete_quest(side)
	await _wait_for_tail(quests)
	assert(flags.get_value("Q抓水猴子_禁止离开码头") == false)
	assert(quests.get_status("支线-抓水猴子-找回漂浮的箱子") == RuntimeQuestManager.ACTIVE)

	# Rejected action Promises are caught at the same inner/outer boundaries;
	# events/chaining still run and the single tail remains usable.
	quests.quest_defs.reject_accept = {"id": "reject_accept", "title": "拒绝接取", "acceptActions": [{"type": "rejectQuest", "params": {}}], "preconditions": [], "completionConditions": [], "rewards": []}
	quests.accept_quest("reject_accept")
	await _wait_for_tail(quests)
	assert(events.any(func(entry: Dictionary) -> bool: return entry.event == "quest:accepted" and entry.payload.questId == "reject_accept"))
	quests.quest_defs.reject_reward = {"id": "reject_reward", "title": "拒绝奖励", "acceptActions": [], "preconditions": [], "completionConditions": [], "rewards": [{"type": "rejectQuest", "params": {}}]}
	quests._complete_quest("reject_reward")
	await _wait_for_tail(quests)
	assert(events.any(func(entry: Dictionary) -> bool: return entry.event == "quest:completed" and entry.payload.questId == "reject_reward"))
	quests._enqueue_quest_actions(func() -> bool: return false)
	await _wait_for_tail(quests)

	# Restore preserves data insertion order; it does not reorder by quest defs or
	# sort unknown ids. Only numeric Active entries rebuild HUD tracking.
	events.clear()
	quests.set_restoring(true)
	quests.deserialize({"z_extra": RuntimeQuestManager.ACTIVE, "opening_04": RuntimeQuestManager.COMPLETED, "a_extra": RuntimeQuestManager.ACTIVE, "raw_active": "active"})
	quests.set_restoring(false)
	assert(quests.serialize().keys() == ["z_extra", "opening_04", "a_extra", "raw_active"])
	assert(events.size() == 2 and events[0].payload.questId == "z_extra" and events[1].payload.questId == "a_extra")
	assert(events.all(func(entry: Dictionary) -> bool: return entry.event == "quest:accepted" and entry.payload.restored == true))
	assert(quests.get_status("raw_active") == "active")
	assert(flags.get_value("quest_opening_04_status") == RuntimeQuestManager.COMPLETED)

	quests.debug_set_quest_status("manual", "accepted")
	assert(quests.get_status("manual") == RuntimeQuestManager.ACTIVE)
	quests.debug_set_quest_status("manual", "completed")
	assert(quests.get_status("manual") == RuntimeQuestManager.COMPLETED)
	quests.debug_set_quest_status("manual", " completed ")
	assert(quests.get_status("manual") == RuntimeQuestManager.INACTIVE)
	quests.debug_set_quest_status("manual", " active ")
	assert(quests.get_status("manual") == RuntimeQuestManager.ACTIVE)

	# destroy replaces only the source Promise tail. A task already captured by
	# the old tail is not cancelled and still performs its captured post-action emit.
	var survivor := RuntimeQuestManager.new(bus, flags, executor)
	survivor.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	survivor.set_condition_eval_context_factory(func() -> Dictionary: return {"flagStore": flags})
	survivor.quest_defs.survivor = {"id": "survivor", "title": "幸存", "acceptActions": [{"type": "blockQuest", "params": {}}], "preconditions": [], "completionConditions": [], "rewards": []}
	block_latch = RuntimeAsyncLatch.new(); block_entered = false; events.clear()
	survivor.accept_quest("survivor")
	await RuntimeMicrotaskQueue.yield_turn()
	assert(block_entered)
	var old_tail := survivor.quest_action_tail
	var old_factory: Variant = survivor.condition_ctx_factory
	survivor.destroy()
	assert(not is_same(survivor.quest_action_tail, old_tail) and survivor.condition_ctx_factory == old_factory)
	block_latch.resolve()
	await old_tail.wait_until_idle()
	assert(events.any(func(entry: Dictionary) -> bool: return entry.event == "quest:accepted" and entry.payload.questId == "survivor"))
	survivor.free()

	quests.destroy(); quests.free()
	executor.destroy(); state.destroy(); input.destroy(); input.free()
	flags.destroy(); bus.clear(); assets.dispose(); stub_assets.dispose()
	print("QuestManager field/load/evaluate/tail/save/destroy direct-translation test: PASS")
	get_tree().quit(0)


func _wait_for_tail(quests: RuntimeQuestManager) -> void:
	await RuntimeMicrotaskQueue.yield_turn()
	await quests.quest_action_tail.wait_until_idle()


func _block_quest(_params: Dictionary, _zone: Variant) -> void:
	block_entered = true
	await block_latch.wait()


func has_reached_state(graph_id: String, state_id: String) -> bool:
	return narrative_reached.get("%s:%s" % [graph_id, state_id], false) == true


func is_state_active(graph_id: String, state_id: String) -> bool:
	return has_reached_state(graph_id, state_id)


func _record_event(payload: Variant, event: String) -> void:
	events.push_back({"event": event, "payload": payload})
