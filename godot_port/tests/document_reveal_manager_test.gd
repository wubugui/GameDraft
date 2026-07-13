extends Node

var manager: RuntimeDocumentRevealManager
var blend_calls: Array[Array] = []
var revealed_events: Array[String] = []


func _ready() -> void: await _run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var bus := RuntimeEventBus.new(); bus.on("document:revealed", Callable(self, "_revealed_event"))
	var flags := RuntimeFlagStore.new(bus)
	var state := RuntimeGameStateController.new(); var executor := RuntimeActionExecutor.new(bus, flags, state)
	var quests := RuntimeQuestManager.new(bus, flags, executor)
	var strings := RuntimeStringsProvider.new(); assert(strings.load(assets))
	quests.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets}); assert(quests.load_defs())
	var scenarios := RuntimeScenarioStateManager.new(bus, flags); scenarios.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets}); assert(scenarios.load_catalog())
	manager = RuntimeDocumentRevealManager.new(assets, bus, flags, quests, scenarios)
	manager.init({}); assert(manager.load_definitions() and manager.definition_count() == 2)
	manager.set_condition_eval_context_factory(func() -> Dictionary: return {"flagStore": flags, "questManager": quests, "scenarioState": scenarios})
	assert(manager.get_document_phase("unknown") == "hidden")
	assert(manager.get_document_phase("告示-水猴子") == "blurred")
	assert(str(manager.get_display_image("告示-水猴子")).ends_with("告示-抓水猴子X.png"))
	await manager.check_and_reveal("告示-水猴子-官差线")
	assert(not manager.is_revealed("告示-水猴子-官差线"))
	manager.set_blend_executor(Callable(self, "_blend"))
	await manager.check_and_reveal("告示-水猴子-官差线")
	assert(manager.is_revealed("告示-水猴子-官差线") and revealed_events == ["告示-水猴子-官差线"])
	assert(blend_calls[0][0] == "blend" and blend_calls[0][6] == 2000.0 and blend_calls[0][7] == 1000.0)
	await manager.check_and_reveal("告示-水猴子")
	assert(not manager.is_revealed("告示-水猴子"))
	scenarios.debug_set_scenario_phase("码头水鬼", "真相揭示", {"status": "done"})
	await manager.check_and_reveal("告示-水猴子")
	assert(manager.is_revealed("告示-水猴子") and flags.get_value("document_revealed_告示-水猴子") == true)
	assert(manager.get_document_phase("告示-水猴子") == "revealed" and str(manager.get_display_image("告示-水猴子")).ends_with("告示-抓水猴子.png"))

	manager.load_definitions_from_data([{"id": "中文 id", "blurredImagePath": "a", "clearImagePath": "b", "revealCondition": {"all": []}, "animation": {}}])
	await manager.check_and_reveal("中文 id")
	assert(blend_calls[-1][0] == "docReveal____id")
	var snapshot := manager.serialize(); var restored := RuntimeDocumentRevealManager.new(assets, bus, flags, quests, scenarios); restored.deserialize(snapshot)
	assert(restored.serialize() == snapshot)
	restored.destroy(); restored.free(); manager.destroy(); manager.free(); scenarios.destroy(); scenarios.free(); quests.destroy(); quests.free(); executor.destroy(); state.destroy(); flags.destroy(); bus.clear(); assets.dispose()
	print("DocumentRevealManager contract test: PASS"); get_tree().quit(0)


func _blend(id: String, from: String, to: String, x: float, y: float, width: float, duration: float, delay: float) -> void:
	blend_calls.push_back([id, from, to, x, y, width, duration, delay]); assert(manager.get_document_phase(manager.debug_snapshot().revealingTransient[0]) == "revealing"); await get_tree().process_frame
func _revealed_event(payload: Dictionary) -> void: revealed_events.push_back(payload.documentId)
