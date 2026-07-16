extends Node

var narrative: RuntimeNarrativeStateManager
var order: Array[String] = []
var flags: RuntimeFlagStore


func _ready() -> void:
	await _run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var bus := RuntimeEventBus.new()
	bus.on("narrative:stateChanged", Callable(self, "_state_changed"))
	flags = RuntimeFlagStore.new(bus)
	flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	var executor := RuntimeActionExecutor.new(bus, flags)
	executor.register("record", Callable(self, "_record_action"), ["label"])
	executor.register("emitNested", Callable(self, "_emit_nested"), ["signal"])
	narrative = RuntimeNarrativeStateManager.new(bus, flags, executor)
	narrative.init({"eventBus": bus, "flagStore": flags, "strings": null, "assetManager": assets})
	narrative.set_condition_eval_context_factory(func() -> Dictionary:
		return {"flagStore": flags, "narrativeState": narrative}
	)
	var graphs: Array = [
		{"id": "g1", "ownerType": "flow", "initialState": "a", "states": {
			"a": {"id": "a", "onExitActions": [{"type": "record", "params": {"label": "exit"}}]},
			"b": {"id": "b", "broadcastOnEnter": true, "onEnterActions": [
				{"type": "record", "params": {"label": "enter"}},
				{"type": "emitNested", "params": {"signal": "nested"}},
			]},
			"c": {"id": "c"},
		}, "transitions": [
			{"id": "low", "from": "a", "to": "c", "signal": "go", "priority": 1},
			{"id": "high", "from": "a", "to": "b", "signal": " go ", "priority": 5},
		]},
		{"id": "g2", "ownerType": "npc", "ownerId": "n", "initialState": "x", "states": {
			"x": {"id": "x"}, "y": {"id": "y"}, "z": {"id": "z"},
		}, "transitions": [
			{"id": "nested", "from": "x", "to": "y", "signal": "nested"},
			{"id": "broadcast", "from": "y", "to": "z", "signal": "state:g1:b"},
		]},
		{"id": "guard", "ownerType": "flow", "initialState": "p", "states": {"p": {"id": "p"}, "q": {"id": "q"}}, "transitions": [
			{"id": "guarded", "from": "p", "to": "q", "signal": "go", "conditions": [{"flag": "heard_teahouse_story"}]},
		]},
		{"id": "scenario", "ownerType": "scenario", "ownerId": "s", "initialState": "waiting", "entryState": "entry", "exitStates": ["done"], "states": {
			"waiting": {"id": "waiting"}, "entry": {"id": "entry"}, "inside": {"id": "inside"}, "done": {"id": "done"},
		}, "transitions": []},
		{"id": "bad_endpoint", "ownerType": "flow", "initialState": "a", "states": {"a": {"id": "a"}}, "transitions": [
			{"id": "bad", "from": {"graphId": "other", "stateId": "a"}, "to": "a", "signal": "go"},
		]},
	]
	narrative.register_graphs(graphs)
	assert(narrative.get_graphs().size() == 5 and narrative.has_reached_state("g1", "a"))
	await narrative.emit_narrative_signal({"signal": " go ", "sourceType": "dialogue", "sourceId": "d"})
	assert(narrative.get_active_state("g1") == "b")
	assert(narrative.get_active_state("g2") == "z")
	assert(narrative.get_active_state("guard") == "p")
	assert(order == ["action:exit", "state:g1:a>b", "action:enter", "state:g2:x>y", "state:g2:y>z"])
	assert(narrative.has_reached_state("g1", "a") and narrative.has_reached_state("g1", "b"))
	assert(narrative.debug_snapshot().recentIssues.any(func(issue: Dictionary) -> bool: return issue.code == "transition.crossGraphEndpoint.unsupported"))

	flags.set_value("heard_teahouse_story", true)
	await narrative.enqueue_trigger_key("go")
	assert(narrative.get_active_state("guard") == "q")
	await narrative.emit_narrative_signal({"signal": RuntimeNarrativeStateManager.DEFAULT_DRAFT_SIGNAL})
	await narrative.emit_narrative_signal({"signal": "  "})
	assert(narrative.get_active_state("g1") == "b")

	await narrative.debug_set_narrative_state("scenario", "inside")
	assert(narrative.get_active_state("scenario") == "waiting")
	await narrative.debug_set_narrative_state("scenario", "entry")
	assert(narrative.get_active_state("scenario") == "entry")
	assert(narrative.get_graph_ids_by_owner("npc", "n") == ["g2"])
	assert(narrative.get_primary_graph_by_owner("npc", "n").id == "g2")

	var actual := RuntimeNarrativeStateManager.new(bus, flags, executor)
	actual.init({"eventBus": bus, "flagStore": flags, "strings": null, "assetManager": assets})
	assert(actual.load_from_asset(assets) and actual.get_graphs().size() == 51)
	assert(actual.get_graph("flow_xungou_main") is Dictionary)
	actual.destroy(); actual.free()
	narrative.destroy(); narrative.free()
	executor.destroy(); flags.destroy(); bus.clear(); assets.dispose()
	print("Narrative signal queue contract test: PASS")
	get_tree().quit(0)


func _record_action(params: Dictionary, _zone: Variant) -> void:
	order.push_back("action:%s" % params.get("label", ""))


func _emit_nested(params: Dictionary, _zone: Variant) -> void:
	await narrative.emit_narrative_signal({"signal": str(params.get("signal", "")), "sourceType": "action", "sourceId": "test"})


func _state_changed(payload: Dictionary) -> void:
	order.push_back("state:%s:%s>%s" % [payload.graphId, payload.from, payload.to])
