extends Node

class FakeNarrative:
	extends RefCounted
	var ambiguous := false
	func get_active_state(graph_id: String) -> Variant:
		if graph_id == "owner_graph": return "ready"
		if graph_id == "context_graph": return "context_ready"
		return null
	func get_graph(graph_id: String) -> Variant: return {"id": graph_id} if graph_id in ["owner_graph", "context_graph"] else null
	func get_graph_ids_by_owner(_owner_type: String, _owner_id: String) -> Array[String]: return ["owner_graph", "second_graph"] if ambiguous else ["owner_graph"]
	func get_primary_graph_by_owner(owner_type: String, _owner_id: String) -> Dictionary: return {"id": "context_graph" if owner_type == "scene" else "owner_graph"}

var lines: Array = []
var choices_events: Array = []
var end_events: Array = []
var hold_count := 0


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var events := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(events)
	flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	var strings := RuntimeStringsProvider.new(); assert(strings.load(assets))
	var input := RuntimeInputManager.new()
	var state := RuntimeGameStateController.new(input, events)
	var actions := RuntimeActionExecutor.new(events, flags, state)
	actions.register("holdRecord", Callable(self, "_hold_record"), [])
	var inventory := RuntimeInventoryManager.new(events, flags)
	inventory.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets})
	assert(inventory.load_defs()); assert(inventory.add_coins(10))
	var rules := RuntimeRulesManager.new(events, flags)
	var quests := RuntimeQuestManager.new(events, flags, actions)
	var scenarios := RuntimeScenarioStateManager.new(events, flags)
	var manager := RuntimeGraphDialogueManager.new(events, flags, actions, assets, null, rules, quests, inventory, scenarios)
	manager.init({"strings": strings})
	actions.register_graph_dialogue_handler(manager, null)
	var narrative := FakeNarrative.new()
	manager.set_condition_eval_context_factory(func() -> Dictionary: return {"flagStore": flags, "questManager": quests, "scenarioState": scenarios, "narrativeState": narrative, "currentSceneId": "test"})
	manager.set_resolve_display(func(text: String) -> String: return text.replace("{{name}}", "阿明"))
	events.on("dialogue:line", func(payload: Variant) -> void: lines.push_back(payload.duplicate(true)))
	events.on("dialogue:choices", func(payload: Variant) -> void: choices_events.push_back(payload.duplicate(true)))
	events.on("dialogue:end", func(payload: Variant) -> void: end_events.push_back(payload.duplicate(true)))

	# One deterministic path covers switch -> ownerState -> contextState ->
	# runActions -> multi-beat line -> prompted choice -> end.
	flags.set_value("dialogue_test_route", true)
	manager.graph = {
		"entry": "switch", "nodes": {
			"switch": {"type": "switch", "cases": [{"condition": {"flag": "dialogue_test_route", "op": "==", "value": true}, "next": "owner"}], "defaultNext": "end"},
			"owner": {"type": "ownerState", "wrapperGraphId": "owner_graph", "cases": [{"state": "ready", "next": "context"}], "defaultNext": "end", "missingWrapperNext": "end"},
			"context": {"type": "contextState", "graphId": "context_graph", "cases": [{"state": "context_ready", "next": "actions"}], "defaultNext": "end"},
			"actions": {"type": "runActions", "actions": [{"type": "setFlag", "params": {"key": "dialogue_test_action", "value": "ran"}}], "next": "line"},
			"line": {"type": "line", "speaker": {"kind": "npc"}, "portrait": {"slug": "fallback", "emotion": "happy"}, "lines": [{"speaker": {"kind": "npc"}, "text": "第一句 {{name}}"}, {"speaker": {"kind": "player"}, "text": "第二句"}], "next": "choice"},
			"choice": {"type": "choice", "promptLine": {"speaker": {"kind": "literal", "name": "旁白"}, "text": "选吧"}, "options": [
				{"text": "付钱", "costCoins": 3, "next": "end"},
				{"text": "锁定", "requireFlag": "never_unlocked", "disabledClickHint": "还不行", "next": "end"}
			]},
			"end": {"type": "end"}
		}
	}
	manager.graph_source_id = "synthetic_all_nodes"; manager.current_node_id = "switch"; manager.active = true; manager.npc_name = "测试人物"; manager.npc_id = "test_npc"; manager.owner_type = "npc"; manager.owner_id = "test_npc"
	await manager._drain_until_blocking()
	assert(flags.get_value("dialogue_test_action") == "ran")
	assert(manager.get_narrative_eval_debug().lastSwitch.chosenNext == "owner" and manager.get_narrative_eval_debug().lastSwitch.casesTried[0].matched == true)
	assert(lines.size() == 1 and lines[0].speaker == "测试人物" and lines[0].text == "第一句 阿明" and lines[0].portrait == {"slug": "fallback", "emotion": "happy"})
	manager.advance(); await get_tree().process_frame
	assert(lines.size() == 2 and lines[1].speaker != "" and lines[1].text == "第二句")
	manager.advance(); await get_tree().process_frame
	assert(lines.size() == 3 and lines[2].speaker == "旁白" and lines[2].text == "选吧")
	manager.advance(); assert(choices_events.size() == 1)
	var visible_choices: Array = choices_events[0]
	assert(visible_choices.size() == 2 and visible_choices[0].enabled == true and visible_choices[1].enabled == false and visible_choices[1].disableHint == "还不行")
	var priority_choices := manager._build_choices({"options": [{"text": "条件先失败", "requireCondition": {"flag": "never_unlocked", "op": "==", "value": true}, "costCoins": 999}, {"text": "规矩先失败", "requireFlag": "never_unlocked", "ruleHintId": "rule_no_go_night", "costCoins": 999}]}); assert(priority_choices[0].disableHint == strings.get_text("dialogue", "choiceFlagLocked") and priority_choices[1].disableHint == strings.get_text("dialogue", "choiceNeedRule", {"name": "rule_no_go_night"}))
	assert(not await manager.choose_option(1)); assert(await manager.choose_option(0)); assert(inventory.get_coins() == 7.0 and not manager.is_active())
	assert(end_events.size() == 1 and end_events[0].willContinue == false)
	var before_relative := lines.size(); manager.graph = {"entry": "owner", "nodes": {"owner": {"type": "ownerState", "wrapperGraphId": "@owner", "cases": [{"state": "ready", "next": "context"}], "defaultNext": "fallback"}, "context": {"type": "contextState", "graphId": "@scene", "cases": [{"state": "context_ready", "next": "relative_line"}], "defaultNext": "fallback"}, "relative_line": {"type": "line", "speaker": {"kind": "literal", "name": "相对"}, "text": "token route", "next": "end"}, "fallback": {"type": "line", "speaker": {"kind": "literal", "name": "错误"}, "text": "fallback", "next": "end"}, "end": {"type": "end"}}}; manager.graph_source_id = "relative_tokens"; manager.current_node_id = "owner"; manager.owner_type = "npc"; manager.owner_id = "test_npc"; manager.active = true; await manager._drain_until_blocking(); assert(lines.size() == before_relative + 1 and lines[-1].text == "token route"); manager.end_dialogue()
	narrative.ambiguous = true; manager.graph = {"entry": "owner", "nodes": {"owner": {"type": "ownerState", "cases": [{"state": "ready", "next": "wrong"}], "defaultNext": "wrong", "missingWrapperNext": "fallback"}, "wrong": {"type": "line", "speaker": {"kind": "literal", "name": "错误"}, "text": "wrong", "next": "end"}, "fallback": {"type": "line", "speaker": {"kind": "literal", "name": "回退"}, "text": "ambiguous fallback", "next": "end"}, "end": {"type": "end"}}}; manager.graph_source_id = "ambiguous_owner"; manager.current_node_id = "owner"; manager.owner_type = "npc"; manager.owner_id = "test_npc"; manager.active = true; await manager._drain_until_blocking(); assert(lines[-1].text == "ambiguous fallback"); manager.end_dialogue(); narrative.ambiguous = false
	var before_mutex := lines.size(); manager.graph = {"entry": "first", "nodes": {"first": {"type": "line", "speaker": {"kind": "literal", "name": "互斥"}, "text": "first", "next": "hold"}, "hold": {"type": "runActions", "actions": [{"type": "holdRecord", "params": {}}], "next": "second"}, "second": {"type": "line", "speaker": {"kind": "literal", "name": "互斥"}, "text": "second", "next": "end"}, "end": {"type": "end"}}}; manager.graph_source_id = "input_mutex"; manager.current_node_id = "first"; manager.active = true; await manager._drain_until_blocking(); manager.advance(); manager.advance(); await get_tree().create_timer(0.04).timeout; assert(hold_count == 1 and lines.size() == before_mutex + 2 and lines[-1].text == "second"); manager.end_dialogue()

	# A real shipped graph must load through the unmodified locator/JSON path.
	await actions.execute_await({"type": "startDialogueGraph", "params": {"graphId": "码头_", "ownerType": "npc", "ownerId": "dock", "dimBackground": true}})
	assert(manager.get_dialogue_view_debug().graphId == "码头_" and manager.get_dialogue_view_debug().nodeType == "line" and state.current_state == RuntimeGameStateController.DIALOGUE)
	assert(actions.has_handler("startDialogueGraph") and actions.get_param_names("startDialogueGraph") == ["graphId", "entry", "npcId", "ownerType", "ownerId", "dimBackground"])
	manager.end_dialogue()
	end_events.clear(); manager.graph = {"entry": "nested", "nodes": {"nested": {"type": "runActions", "actions": [{"type": "startDialogueGraph", "params": {"graphId": "码头_", "ownerType": "npc", "ownerId": "dock"}}], "next": "outer_end"}, "outer_end": {"type": "end"}}}; manager.graph_source_id = "outer"; manager.current_node_id = "nested"; manager.active = true
	await manager._drain_until_blocking(); await get_tree().process_frame
	assert(manager.is_active() and manager.get_dialogue_view_debug().graphId == "码头_" and end_events.size() == 1 and end_events[0].willContinue == true)
	manager.end_dialogue(); assert(end_events.size() == 2 and end_events[1].willContinue == false)
	end_events.clear(); manager.graph = {"entry": "end", "nodes": {"end": {"type": "end"}}}; manager.graph_source_id = "failed_chain_outer"; manager.current_node_id = "end"; manager.active = true; manager.deferred_graph_queue = [{"graphId": "definitely_missing"}]; manager.end_dialogue(); await get_tree().process_frame; await get_tree().process_frame; assert(end_events.size() == 2 and end_events[0].willContinue == true and end_events[1].willContinue == false and not manager.has_pending_chain_continuation())

	# Every shipped graph has a valid entry and only the seven supported node kinds.
	var graphs_dir := DirAccess.open(repository.path_join("public/assets/dialogues/graphs")); assert(graphs_dir != null)
	var files: Array[String] = []
	for path: String in graphs_dir.get_files():
		if path.ends_with(".json"): files.push_back(path)
	assert(files.size() == 63)
	var seen_types: Dictionary = {}
	for file: String in files:
		var graph_id := file.trim_suffix(".json"); var raw: Variant = assets.load_json(assets.locator.dialogue_graph_json_url(graph_id)); assert(raw is Dictionary and raw.get("nodes") is Dictionary and raw.get("entry") is String and raw.nodes.get(raw.entry) is Dictionary)
		for node: Variant in raw.nodes.values(): assert(node is Dictionary and str(node.get("type", "")) in ["choice", "contextState", "end", "line", "ownerState", "runActions", "switch"]); seen_types[str(node.type)] = true
	assert(seen_types.size() == 7)

	manager.destroy(); manager.free(); scenarios.destroy(); scenarios.free(); quests.destroy(); quests.free(); rules.destroy(); rules.free(); inventory.destroy(); inventory.free(); actions.destroy(); state.destroy(); input.destroy(); input.free(); flags.destroy(); events.clear(); assets.dispose()
	print("GraphDialogueManager seven-node/63-graph contract test: PASS"); get_tree().quit(0)


func _hold_record(_params: Dictionary, _zone: Variant) -> void:
	hold_count += 1; await get_tree().create_timer(0.02).timeout
