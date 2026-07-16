extends Node


class AssetManagerStub extends RuntimeAssetManager:
	var responses: Array = []
	var errors: Array[String] = []
	var load_count := 0
	var current_error := ""

	func load_json(_path: String) -> Variant:
		current_error = errors[load_count] if load_count < errors.size() else ""
		var response: Variant = responses[load_count] if load_count < responses.size() else null
		load_count += 1
		return response

	func get_last_error() -> String:
		return current_error


class NarrativeConditionView:
	extends RefCounted
	var source: RuntimeNarrativeStateManager
	func _init(value: RuntimeNarrativeStateManager) -> void: source = value
	func get_active_state(graph_id: String) -> Variant: return source.get_active_state(graph_id)
	func is_state_active(graph_id: String, state_id: String) -> bool: return source.is_state_active(graph_id, state_id)
	func has_reached_state(graph_id: String, state_id: String) -> bool: return source.has_reached_state(graph_id, state_id)
	func get_primary_graph_by_owner(owner_type: String, owner_id: String) -> Variant: return source.get_primary_graph_by_owner(owner_type, owner_id)


var manager: RuntimeDocumentRevealManager
var blend_calls: Array[Array] = []
var revealed_events: Array[String] = []
var timeline: Array[String] = []
var reject_next_blend := false
var hold_next_blend := false
var blend_entered := RuntimeAsyncLatch.new()
var blend_release := RuntimeAsyncLatch.new()


func _ready() -> void:
	await _run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var bus := RuntimeEventBus.new()
	bus.on("document:revealed", Callable(self, "_revealed_event"))
	var flags := RuntimeFlagStore.new(bus)
	var input := RuntimeInputManager.new()
	var state := RuntimeGameStateController.new(input)
	var executor := RuntimeActionExecutor.new(bus, flags, state)
	var quests := RuntimeQuestManager.new(bus, flags, executor)
	var strings := RuntimeStringsProvider.new()
	strings.load(assets)
	quests.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	await quests.load_defs()
	var scenarios := RuntimeScenarioStateManager.new()
	scenarios.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	scenarios.configure_runtime(flags, assets.load_json("/assets/data/scenarios.json"), bus)
	var narrative := RuntimeNarrativeStateManager.new(bus, flags, executor)
	narrative.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	narrative.register_graphs([{"id": "scenario_码头真相", "ownerType": "scenario", "ownerId": "码头_真相揭示", "initialState": "hidden", "entryState": "hidden", "exitStates": ["revealed"], "states": {"hidden": {"id": "hidden"}, "revealed": {"id": "revealed"}}, "transitions": []}])
	var narrative_condition_view := NarrativeConditionView.new(narrative)
	var condition_factory := func() -> Dictionary:
		return {"flagStore": flags, "questManager": quests, "scenarioState": scenarios, "narrativeState": narrative_condition_view, "resolveConditionLiteral": func(value: String) -> String: return value, "currentSceneId": "", "currentOwner": null, "getActivePlaneId": func() -> String: return "normal"}
	flags.set_condition_eval_context_factory(condition_factory)
	quests.set_condition_eval_context_factory(condition_factory)
	narrative.set_condition_eval_context_factory(condition_factory)

	# loadDefinitions clears first, awaits the AssetManager Promise boundary, keeps
	# source definition identity, trims only the Map key, skips invalid entries and
	# leaves an already-existing key in its original insertion position.
	var first_definition := {"id": " first ", "blurredImagePath": "old-blur", "clearImagePath": "old-clear", "revealCondition": {"all": []}, "animation": {}}
	var replacement_definition := {"id": " first ", "blurredImagePath": "new-blur", "clearImagePath": "new-clear", "revealCondition": {"all": []}, "animation": {}}
	var second_definition := {"id": "second", "blurredImagePath": "second-blur", "clearImagePath": "second-clear", "revealCondition": {"all": []}, "animation": {}}
	var stub_assets := AssetManagerStub.new()
	stub_assets.responses = [[first_definition, null, {"id": 7}, {"id": "   "}, second_definition, replacement_definition], {"not": "an array"}, null]
	stub_assets.errors = ["", "", "broken-json"]
	manager = RuntimeDocumentRevealManager.new(stub_assets, bus, flags, quests, scenarios)
	manager.init({})
	await manager.load_definitions()
	assert(manager.defs.keys() == ["first", "second"])
	assert(is_same(manager.defs.first, replacement_definition))
	await manager.load_definitions()
	assert(manager.defs.is_empty())
	await manager.load_definitions()
	assert(manager.defs.is_empty())

	# The fallback condition context owns literal resolution until an injected
	# factory is supplied. Nullish numeric defaults preserve explicit zero values.
	flags.set_value("literal_ready", "resolved")
	var custom_definition := {
		"id": "中文 id",
		"overlayId": " layer-instance ",
		"blurredImagePath": "blur-ref",
		"clearImagePath": "clear-ref",
		"revealCondition": {"flag": "literal_ready", "value": "[tag:ready]"},
		"revealedFlag": " custom_revealed ",
		"xPercent": 0,
		"yPercent": 0,
		"widthPercent": 0,
		"animation": {"durationMs": 0, "delayMs": 0},
	}
	manager.defs["中文 id"] = custom_definition
	manager.set_resolve_condition_literal(func(raw: String) -> String: return "resolved" if raw == "[tag:ready]" else raw)
	assert(manager.get_document_phase("unknown") == "hidden")
	assert(manager.get_document_phase(" 中文 id ") == "blurred")
	assert(manager.get_display_image("中文 id") == "blur-ref")
	await manager.check_and_reveal(" missing ")
	await manager.check_and_reveal(" 中文 id ")
	assert(not manager.is_revealed("中文 id") and revealed_events.is_empty())
	manager.set_blend_executor(Callable(self, "_blend"))
	await manager.check_and_reveal(" 中文 id ")
	assert(manager.is_revealed("中文 id") and flags.get_value("custom_revealed") == true)
	assert(manager.get_document_phase("中文 id") == "revealed" and manager.get_display_image("中文 id") == "clear-ref")
	assert(blend_calls[0] == ["layer-instance", "blur-ref", "clear-ref", 0, 0, 0, 0, 0])
	assert(timeline.slice(0, 2) == ["event:中文 id", "blend:layer-instance"])
	await manager.check_and_reveal("中文 id")
	assert(blend_calls.size() == 1 and revealed_events == ["中文 id"])

	# A rejected blend is caught: the early event remains source-observable, but
	# revealed/flag state is not committed, the guard is released, and retry works.
	var retry_definition := {"id": "retry", "blurredImagePath": "retry-blur", "clearImagePath": "retry-clear", "revealCondition": {"all": []}, "revealedFlag": "retry_done"}
	manager.defs["retry"] = retry_definition
	reject_next_blend = true
	await manager.check_and_reveal("retry")
	assert(not manager.is_revealed("retry") and manager.get_document_phase("retry") == "blurred")
	assert(flags.get_value("retry_done") == null and revealed_events.count("retry") == 1)
	assert(blend_calls[-1] == ["docReveal_retry", "retry-blur", "retry-clear", 50, 50, 40, 2000, 0])
	await manager.check_and_reveal("retry")
	assert(manager.is_revealed("retry") and flags.get_value("retry_done") == true and revealed_events.count("retry") == 2)

	# revealing is a per-document re-entry guard. A different document remains
	# independent, while a duplicate request during the held Promise is ignored.
	manager.defs["slow"] = {"id": "slow", "blurredImagePath": "slow-blur", "clearImagePath": "slow-clear", "revealCondition": {"all": []}, "animation": {}}
	hold_next_blend = true
	blend_entered = RuntimeAsyncLatch.new()
	blend_release = RuntimeAsyncLatch.new()
	manager.check_and_reveal("slow")
	await blend_entered.wait()
	assert(manager.get_document_phase("slow") == "revealing")
	await manager.check_and_reveal(" slow ")
	assert(revealed_events.count("slow") == 1)
	blend_release.resolve()
	while manager.revealing.has("slow"):
		await get_tree().process_frame
	assert(manager.is_revealed("slow") and revealed_events.count("slow") == 1)

	# Debug state includes the transient phase, whereas save state contains only
	# the source Set insertion order. Deserialize silently clears transients,
	# trims strings, ignores non-strings/empties and de-duplicates in first order.
	manager.revealing["temporary"] = true
	var debug := manager.debug_snapshot()
	assert(debug.revealingTransient == ["temporary"], str(debug))
	assert(debug.phaseByDefId.slow == "revealed", str(debug))
	var snapshot := manager.serialize()
	assert(not snapshot.has("revealing"))
	manager.deserialize({"revealed": [" z ", "", 7, "z", "a"]})
	assert(manager.serialize() == {"revealed": ["z", "a"]})
	assert(manager.is_revealed(" z ") and manager.get_document_phase("z") == "hidden" and manager.revealing.is_empty())
	manager.deserialize({"revealed": "not-an-array"})
	assert(manager.serialize() == {"revealed": []})

	# Real exported data and the shared narrative condition context complete the
	# same runtime path used by Game.start.
	var shipped := RuntimeDocumentRevealManager.new(assets, bus, flags, quests, scenarios)
	shipped.set_condition_eval_context_factory(condition_factory)
	shipped.set_blend_executor(Callable(self, "_blend"))
	await shipped.load_definitions()
	assert(shipped.defs.size() == 2)
	await shipped.check_and_reveal("告示-水猴子")
	assert(not shipped.is_revealed("告示-水猴子"))
	await narrative.debug_set_narrative_state("scenario_码头真相", "revealed")
	await shipped.check_and_reveal("告示-水猴子")
	assert(shipped.is_revealed("告示-水猴子") and flags.get_value("document_revealed_告示-水猴子") == true)

	manager.destroy()
	assert(manager.defs.is_empty() and manager.revealed.is_empty() and manager.revealing.is_empty())
	assert(not manager.blend.is_valid() and not manager.resolve_condition_literal.is_valid() and not manager.condition_ctx_factory.is_valid())
	manager.free()
	shipped.destroy(); shipped.free()
	narrative.destroy(); narrative.free()
	scenarios.destroy(); scenarios.free()
	quests.destroy(); quests.free()
	executor.destroy(); state.destroy(); input.destroy(); input.free()
	flags.destroy(); bus.clear(); assets.dispose(); stub_assets.dispose()
	print("DocumentRevealManager direct field/load/condition/reentry/failure/save contract test: PASS")
	get_tree().quit(0)


func _blend(id: Variant, from: Variant, to: Variant, x: Variant, y: Variant, width: Variant, duration: Variant, delay: Variant) -> Variant:
	blend_calls.push_back([id, from, to, x, y, width, duration, delay])
	timeline.push_back("blend:%s" % str(id))
	if hold_next_blend:
		hold_next_blend = false
		blend_entered.resolve()
		await blend_release.wait()
	else:
		await get_tree().process_frame
	if reject_next_blend:
		reject_next_blend = false
		return false
	return null


func _revealed_event(payload: Dictionary) -> void:
	var id := str(payload.documentId)
	revealed_events.push_back(id)
	timeline.push_back("event:%s" % id)
