class_name RuntimeGraphDialogueManager
extends RuntimeSystem

const MAX_DRAIN_STEPS := 1000

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var asset_manager: RuntimeAssetManager
var scene_manager: RuntimeSceneManager
var rules_manager: RuntimeRulesManager
var quest_manager: RuntimeQuestManager
var inventory_manager: RuntimeInventoryManager
var scenario_state: RuntimeScenarioStateManager
var strings: RuntimeStringsProvider
var graph: Dictionary = {}
var graph_source_id := ""
var current_node_id := ""
var active := false
var npc_name := ""
var npc_id := ""
var owner_type := ""
var owner_id := ""
var dim_background := false
var awaiting_line_dismiss := false
var line_beat_index := 0
var choice_phase: Variant = null
var deferred_graph_queue: Array = []
var chain_continuation_pending := false
var chain_runner_active := false
var last_graph_end_was_continuing := false
var _chain_generation := 0
var _condition_context_factory := Callable()
var _resolve_display := Callable()
var _player_portrait_slug := Callable()
var _drain_depth := 0
var _destroyed := false
var last_precondition_debug: Variant = null
var last_switch_debug: Variant = null
var narrative_route_node_ids: Array[String] = []


func _init(events: RuntimeEventBus, flags: RuntimeFlagStore, actions: RuntimeActionExecutor, assets: RuntimeAssetManager, scenes: RuntimeSceneManager, rules: RuntimeRulesManager, quests: RuntimeQuestManager, inventory: RuntimeInventoryManager, scenarios: RuntimeScenarioStateManager) -> void:
	event_bus = events; flag_store = flags; action_executor = actions; asset_manager = assets; scene_manager = scenes; rules_manager = rules; quest_manager = quests; inventory_manager = inventory; scenario_state = scenarios


func init(ctx: Dictionary) -> void: strings = ctx.strings
func set_condition_eval_context_factory(factory: Callable = Callable()) -> void: _condition_context_factory = factory
func set_resolve_display(callback: Callable = Callable()) -> void: _resolve_display = callback
func set_player_portrait_slug_provider(callback: Callable = Callable()) -> void: _player_portrait_slug = callback
func is_active() -> bool: return active
func has_pending_chain_continuation() -> bool: return chain_continuation_pending
func get_context_npc_id() -> String: return npc_id
func get_debug_interaction_state() -> Dictionary: return {"active": active, "graphSourceId": graph_source_id, "currentNodeId": current_node_id, "choiceStage": choice_phase.stage if choice_phase is Dictionary else "none", "awaitingLineDismiss": awaiting_line_dismiss}


func start_dialogue_graph(request: Dictionary) -> bool:
	var id := str(request.get("graphId", "")).strip_edges()
	if id.is_empty() or _destroyed: return false
	if active and _drain_depth > 0:
		deferred_graph_queue.push_back(request.duplicate(true)); return true
	if active: return false
	var raw: Variant = asset_manager.load_json(asset_manager.locator.dialogue_graph_json_url(id))
	if not raw is Dictionary or not raw.get("nodes") is Dictionary or not raw.get("entry") is String or not raw.nodes.get(raw.entry) is Dictionary: return false
	var context := _condition_context(str(request.get("ownerType", "")), str(request.get("ownerId", request.get("npcId", ""))))
	var evaluator := RuntimeConditionEvaluator.new(); var precondition_result := evaluator.evaluate_preconditions_with_trace(raw.get("preconditions", []), context)
	last_precondition_debug = {"graphId": id, "satisfied": precondition_result.result, "traceText": evaluator.format_trace(precondition_result.trace)}; last_switch_debug = null
	if precondition_result.result != true: return false
	graph = raw.duplicate(true); graph_source_id = id; npc_name = str(request.get("npcName", "")); npc_id = str(request.get("npcId", "")).strip_edges(); owner_type = str(request.get("ownerType", "")).strip_edges(); owner_id = str(request.get("ownerId", "")).strip_edges(); dim_background = request.get("dimBackground") == true
	if owner_type.is_empty() and not npc_id.is_empty(): owner_type = "npc"
	if owner_id.is_empty(): owner_id = npc_id
	if request.get("preferGraphMetaTitle") == true and graph.get("meta") is Dictionary and not str(graph.meta.get("title", "")).strip_edges().is_empty(): npc_name = str(graph.meta.title).strip_edges()
	var requested_entry := str(request.get("entry", "")).strip_edges(); current_node_id = requested_entry if not requested_entry.is_empty() and graph.nodes.has(requested_entry) else str(graph.entry)
	active = true; awaiting_line_dismiss = false; line_beat_index = 0; choice_phase = null; narrative_route_node_ids = [current_node_id]; event_bus.emit("dialogue:start", {"npcName": npc_name, "graphId": id, "source": "graph"}); await _drain_until_blocking(); return active or chain_continuation_pending


func advance() -> void:
	if not active or graph.is_empty(): return
	if choice_phase is Dictionary and choice_phase.stage == "prompt": _show_choice_options(); return
	if not awaiting_line_dismiss: return
	awaiting_line_dismiss = false; var node: Variant = graph.nodes.get(current_node_id)
	if not node is Dictionary or node.get("type") != "line": return
	var beats := _line_beats(node)
	if line_beat_index + 1 < beats.size():
		line_beat_index += 1; event_bus.emit("dialogue:line", _line_payload(beats[line_beat_index])); awaiting_line_dismiss = true
		if line_beat_index == beats.size() - 1 and graph.nodes.get(node.get("next"), {}).get("type") == "end": event_bus.emit("dialogue:willEnd", {})
		return
	line_beat_index = 0
	if graph.nodes.get(node.get("next"), {}).get("type") != "runActions": event_bus.emit("dialogue:prepareBeat", {})
	current_node_id = str(node.get("next", "")); _push_route(current_node_id); await _drain_until_blocking()


func choose_option(index: int) -> bool:
	if not active or not choice_phase is Dictionary or choice_phase.stage != "options": return false
	var node: Variant = graph.nodes.get(choice_phase.nodeId); if not node is Dictionary or node.get("type") != "choice": return false
	var choices := _build_choices(node); if index < 0 or index >= choices.size() or choices[index].enabled != true: return false
	var option: Dictionary = node.options[index]; var cost: Variant = option.get("costCoins")
	if (cost is int or cost is float) and float(cost) > 0: inventory_manager.remove_coins(cost)
	event_bus.emit("dialogue:choiceSelected:log", {"index": index, "text": choices[index].text}); choice_phase = null; current_node_id = str(option.get("next", "")); _push_route(current_node_id)
	if graph.nodes.get(current_node_id, {}).get("type") != "runActions": event_bus.emit("dialogue:prepareBeat", {})
	await _drain_until_blocking(); return true


func debug_advance_until_blocking(max_steps: int = 24) -> Dictionary:
	var limit := clampi(max_steps if max_steps > 0 else 24, 1, 200)
	var steps := 0
	for _index: int in range(limit):
		var before := get_debug_interaction_state()
		if before.get("active") != true or before.get("choiceStage") == "options": break
		advance(); await get_tree().process_frame
		steps += 1
		var after := get_debug_interaction_state()
		if after.get("active") != true or after.get("choiceStage") == "options": break
		if after.get("currentNodeId") == before.get("currentNodeId") and after.get("choiceStage") == before.get("choiceStage") and after.get("awaitingLineDismiss") == before.get("awaitingLineDismiss"): break
	var final := get_debug_interaction_state()
	return {"steps": steps, "active": final.get("active", false), "currentNodeId": final.get("currentNodeId", ""), "choiceStage": final.get("choiceStage", "none")}


func debug_choose_option(params: Dictionary) -> bool:
	if not active or graph.is_empty(): return false
	if choice_phase is Dictionary and choice_phase.get("stage") == "prompt":
		advance(); await get_tree().process_frame
	if not active or graph.is_empty() or not choice_phase is Dictionary or choice_phase.get("stage") != "options": return false
	var node: Variant = graph.nodes.get(choice_phase.nodeId)
	if not node is Dictionary or node.get("type") != "choice": return false
	var choices := _build_choices(node)
	var index := int(params.get("index", -1)) if params.has("index") else -1
	var needle := str(params.get("text", "")).strip_edges()
	if index < 0 and not needle.is_empty():
		for choice: Dictionary in choices:
			if choice.get("enabled") == true and str(choice.get("text", "")).strip_edges() == needle: index = int(choice.get("index", -1)); break
		if index < 0:
			for choice: Dictionary in choices:
				if choice.get("enabled") == true and str(choice.get("text", "")).contains(needle): index = int(choice.get("index", -1)); break
	if index < 0 or index >= choices.size() or choices[index].get("enabled") != true: return false
	return await choose_option(index)


func end_dialogue() -> void:
	if not active: return
	var continues := not deferred_graph_queue.is_empty(); last_graph_end_was_continuing = continues; _reset_session_fields(); event_bus.emit("dialogue:end", {"source": "graph", "willContinue": continues})
	if continues:
		chain_continuation_pending = true
		if not chain_runner_active: call_deferred("_continue_deferred_chain")


func get_player_dialogue() -> Dictionary:
	if not active: return {"active": false, "speaker": "", "text": "", "awaitingAdvance": false, "choices": []}
	var choices: Array = []; if choice_phase is Dictionary and choice_phase.stage == "options": choices = _build_choices(graph.nodes[choice_phase.nodeId]).map(func(value: Dictionary) -> Dictionary: return {"index": value.index, "text": value.text, "selectable": value.enabled})
	var text := ""; var node: Variant = graph.nodes.get(current_node_id)
	if node is Dictionary and node.get("type") == "line": var beats := _line_beats(node); if not beats.is_empty(): text = str(_line_payload(beats[mini(line_beat_index, beats.size() - 1)]).text)
	return {"active": true, "speaker": npc_name, "text": text, "awaitingAdvance": awaiting_line_dismiss, "choices": choices}


func get_dialogue_view_debug() -> Dictionary:
	var node: Variant = graph.nodes.get(current_node_id) if active else null; var choices: Array = []
	if choice_phase is Dictionary and choice_phase.stage == "options": choices = _build_choices(graph.nodes[choice_phase.nodeId]).map(func(value: Dictionary) -> Dictionary: return {"index": value.index, "text": value.text, "enabled": value.enabled})
	return {"active": active, "graphId": graph_source_id, "npcName": npc_name, "nodeId": current_node_id, "nodeType": node.get("type") if node is Dictionary else null, "choiceStage": choice_phase.stage if choice_phase is Dictionary else "none", "choices": choices}


func get_narrative_eval_debug() -> Dictionary:
	var parts: Array[String] = ["【节点路由】%s" % (" -> ".join(narrative_route_node_ids) if not narrative_route_node_ids.is_empty() else "（尚无记录，或未在对话中）"), "对话进行中: %s" % ("是" if active else "否"), "图(graphSourceId): %s" % (graph_source_id if not graph_source_id.is_empty() else "—"), "当前节点: %s" % (current_node_id if not current_node_id.is_empty() else "—"), ""]
	if last_precondition_debug is Dictionary:
		parts.append_array(["【最近·图 preconditions】", "图: %s" % last_precondition_debug.get("graphId", ""), "满足: %s" % last_precondition_debug.get("satisfied", false), str(last_precondition_debug.get("traceText", "")), ""])
	else:
		parts.append_array(["【最近·图 preconditions】（尚无记录）", ""])
	if last_switch_debug is Dictionary:
		parts.append_array(["【最近·switch】", "节点: %s" % last_switch_debug.get("nodeId", ""), "选中 next: %s（defaultNext=%s）" % [last_switch_debug.get("chosenNext", ""), last_switch_debug.get("defaultNext", "")]])
		for value: Variant in last_switch_debug.get("casesTried", []):
			if not value is Dictionary: continue
			parts.push_back("— case[%s] -> %s命中=%s" % [value.get("index", 0), value.get("next", ""), value.get("matched", false)])
			var indented: Array[String] = []
			for line: String in str(value.get("traceText", "")).split("\n"): indented.push_back("    %s" % line)
			parts.push_back("\n".join(indented))
	else:
		parts.push_back("【最近·switch】（尚无记录）")
	return {"active": active, "graphSourceId": graph_source_id, "currentNodeId": current_node_id, "lastPrecondition": last_precondition_debug, "lastSwitch": last_switch_debug, "summaryText": "\n".join(parts)}


func serialize() -> Dictionary: return {"active": false}
func deserialize(_data: Dictionary) -> void: _chain_generation += 1; deferred_graph_queue.clear(); chain_continuation_pending = false; chain_runner_active = false; last_graph_end_was_continuing = false; _reset_session_fields()
func destroy() -> void: _destroyed = true; _chain_generation += 1; deferred_graph_queue.clear(); chain_continuation_pending = false; chain_runner_active = false; last_graph_end_was_continuing = false; if active: end_dialogue(); _condition_context_factory = Callable(); _resolve_display = Callable(); _player_portrait_slug = Callable()


func _drain_until_blocking() -> void:
	_drain_depth += 1; var steps := 0
	while active and not graph.is_empty():
		steps += 1
		if steps > MAX_DRAIN_STEPS: end_dialogue(); break
		var node: Variant = graph.nodes.get(current_node_id)
		if not node is Dictionary: end_dialogue(); break
		match str(node.get("type", "")):
			"switch": current_node_id = _eval_switch(node); _push_route(current_node_id)
			"ownerState": current_node_id = _eval_owner_state(node); _push_route(current_node_id)
			"contextState": current_node_id = _eval_context_state(node); _push_route(current_node_id)
			"runActions":
				event_bus.emit("dialogue:hidePanel", {}); await action_executor.execute_batch_await(node.get("actions", [])); current_node_id = str(node.get("next", "")); _push_route(current_node_id)
			"line":
				line_beat_index = 0; var beats := _line_beats(node)
				if beats.is_empty(): end_dialogue(); break
				event_bus.emit("dialogue:line", _line_payload(beats[0])); awaiting_line_dismiss = true
				if beats.size() == 1 and graph.nodes.get(node.get("next"), {}).get("type") == "end": event_bus.emit("dialogue:willEnd", {})
				break
			"choice":
				if node.get("promptLine") is Dictionary: choice_phase = {"nodeId": current_node_id, "stage": "prompt"}; event_bus.emit("dialogue:line", _line_payload(node.promptLine)); awaiting_line_dismiss = true
				else: event_bus.emit("dialogue:prepareBeat", {}); choice_phase = {"nodeId": current_node_id, "stage": "options"}; _emit_choices(node)
				break
			"end": end_dialogue(); break
			_: end_dialogue(); break
	_drain_depth -= 1


func _show_choice_options() -> void:
	if not choice_phase is Dictionary: return
	var node: Variant = graph.nodes.get(choice_phase.nodeId); if not node is Dictionary: return
	awaiting_line_dismiss = false; choice_phase.stage = "options"; _emit_choices(node)
func _emit_choices(node: Dictionary) -> void:
	var choices := _build_choices(node)
	if choices.is_empty() or choices.all(func(value: Dictionary) -> bool: return value.enabled != true): end_dialogue(); return
	event_bus.emit("dialogue:choices", choices)


func _build_choices(node: Dictionary) -> Array:
	var output: Array = []; var context := _condition_context(owner_type, owner_id)
	for index in node.get("options", []).size():
		var option: Dictionary = node.options[index]; var require_flag := str(option.get("requireFlag", "")).strip_edges(); var require_expr_ok := true
		if option.get("requireCondition") != null: require_expr_ok = RuntimeConditionEvaluator.new().evaluate(option.requireCondition, context)
		var require_flag_ok := require_flag.is_empty() or flag_store.eval_pure_flag_conjunction([{"flag": require_flag, "op": "!=", "value": false}]); var require_ok := require_expr_ok and require_flag_ok
		var cost: Variant = option.get("costCoins"); var cost_ok := not (cost is int or cost is float) or inventory_manager.get_coins() >= float(cost); var enabled := require_ok and cost_ok
		var hint: Variant = null
		if not enabled and not str(option.get("disabledClickHint", "")).strip_edges().is_empty(): hint = _r(str(option.disabledClickHint))
		elif not require_expr_ok: hint = strings.get_text("dialogue", "choiceFlagLocked")
		elif not require_ok and not require_flag.is_empty() and not str(option.get("ruleHintId", "")).strip_edges().is_empty():
			var rule_id := str(option.ruleHintId); var rule: Variant = rules_manager.get_rule_def(rule_id); var rule_name := str(rule.get("name", rule_id)) if rule is Dictionary else rule_id; hint = strings.get_text("dialogue", "choiceNeedRule", {"name": rule_name})
		elif not require_ok: hint = strings.get_text("dialogue", "choiceFlagLocked")
		elif not cost_ok: hint = strings.get_text("dialogue", "choiceNeedCoins", {"amount": cost})
		var choice := {"index": index, "text": _r(str(option.get("text", ""))), "tags": [], "enabled": enabled}
		if option.get("ruleHintId") != null: choice["ruleHintId"] = option.ruleHintId
		if hint != null: choice["disableHint"] = hint
		output.push_back(choice)
	return output


func _eval_switch(node: Dictionary) -> String:
	var context := _condition_context(owner_type, owner_id); var evaluator := RuntimeConditionEvaluator.new(); var tried: Array = []; var chosen := str(node.get("defaultNext", "")); var index := 0
	for case: Variant in node.get("cases", []):
		if not case is Dictionary: continue
		var trace_result: Dictionary
		if case.get("condition") is Dictionary: trace_result = evaluator.evaluate_with_trace(case.condition, context)
		else:
			var conditions: Variant = case.get("conditions", []); var expr: Dictionary = {"all": conditions if conditions is Array else []}; trace_result = evaluator.evaluate_with_trace(expr, context)
		tried.push_back({"index": index, "next": str(case.get("next", "")), "matched": trace_result.result, "traceText": evaluator.format_trace(trace_result.trace)})
		if trace_result.result == true: chosen = str(case.get("next", "")); break
		index += 1
	last_switch_debug = {"graphSourceId": graph_source_id, "nodeId": current_node_id, "defaultNext": str(node.get("defaultNext", "")), "chosenNext": chosen, "casesTried": tried}
	return chosen


func _eval_owner_state(node: Dictionary) -> String:
	var fallback := str(node.get("missingWrapperNext", "")).strip_edges()
	if fallback.is_empty(): fallback = str(node.get("defaultNext", ""))
	var context := _condition_context(owner_type, owner_id); var narrative: Variant = context.get("narrativeState")
	if narrative == null or owner_type.is_empty() or owner_id.is_empty(): return fallback
	var wrapper := RuntimeConditionEvaluator.new().resolve_narrative_graph_ref(str(node.get("wrapperGraphId", "")), context); var active_state: Variant = null
	if not wrapper.is_empty():
		if narrative.has_method("get_graph") and narrative.get_graph(wrapper) == null: return fallback
		active_state = narrative.get_active_state(wrapper)
	else:
		var ids: Array = narrative.get_graph_ids_by_owner(owner_type, owner_id); if ids.size() != 1: return fallback; active_state = narrative.get_active_state(ids[0])
	if active_state == null or str(active_state).is_empty(): return fallback
	for case: Variant in node.get("cases", []): if case is Dictionary and case.get("state") == active_state: return str(case.get("next", ""))
	return str(node.get("defaultNext", ""))


func _eval_context_state(node: Dictionary) -> String:
	var context := _condition_context(owner_type, owner_id)
	var narrative: Variant = context.get("narrativeState")
	if narrative == null:
		return str(node.get("defaultNext", ""))
	var id := RuntimeConditionEvaluator.new().resolve_narrative_graph_ref(str(node.get("graphId", "")), context)
	var active_state: Variant = narrative.get_active_state(id) if not id.is_empty() else null
	for case: Variant in node.get("cases", []):
		if case is Dictionary and case.get("state") == active_state:
			return str(case.get("next", ""))
	return str(node.get("defaultNext", ""))


func _line_beats(node: Dictionary) -> Array:
	if node.get("lines") is Array and not node.lines.is_empty():
		var output: Array = []
		for raw: Variant in node.lines:
			if raw is Dictionary:
				var beat: Dictionary = raw.duplicate(true)
				if not beat.has("portrait") and node.has("portrait"):
					beat.portrait = node.portrait
				output.push_back(beat)
		return output
	return [{"speaker": node.get("speaker", {"kind": "literal", "name": ""}), "text": node.get("text"), "textKey": node.get("textKey"), "portrait": node.get("portrait")}]


func _line_payload(payload: Dictionary) -> Dictionary:
	var speaker: Variant = payload.get("speaker", {"kind": "literal", "name": ""})
	var text := ""
	var text_key: Variant = payload.get("textKey")
	if text_key is String and not text_key.strip_edges().is_empty():
		text = strings.get_text("dialogue", text_key)
		if text == text_key:
			text = str(payload.get("text", text_key))
	else:
		text = str(payload.get("text", ""))
	var line := {"speaker": _r(_resolve_speaker(speaker)), "text": _r(text), "tags": []}
	if dim_background: line["dim"] = true
	if speaker is Dictionary and speaker.get("kind") == "player": line.speakerEntity = {"kind": "player"}
	elif speaker is Dictionary and speaker.get("kind") in ["npc", "sceneNpc"]:
		var id := _speaker_npc_id(speaker); if not id.is_empty(): line.speakerEntity = {"kind": "npc", "npcId": id}
	var portrait: Variant = payload.get("portrait")
	if portrait is Dictionary and not str(portrait.get("emotion", "")).is_empty():
		var slug := str(portrait.get("slug", "")).strip_edges()
		if slug.is_empty() and speaker is Dictionary and speaker.get("kind") == "player" and not _player_portrait_slug.is_null() and _player_portrait_slug.is_valid(): slug = str(_player_portrait_slug.call())
		elif slug.is_empty() and speaker is Dictionary: var id := _speaker_npc_id(speaker); var npc: Variant = scene_manager.get_npc_by_id(id); if npc != null: slug = npc.get_current_portrait_slug()
		if not slug.is_empty(): line.portrait = {"slug": slug, "emotion": portrait.emotion}
	return line


func _resolve_speaker(speaker: Variant) -> String:
	if not speaker is Dictionary: return str(speaker)
	match str(speaker.get("kind", "")):
		"player": var name: Variant = flag_store.get_value("player_display_name"); return name.strip_edges() if name is String and not name.strip_edges().is_empty() else strings.get_text("dialogue", "defaultProtagonistName")
		"npc": return npc_name
		"literal": return str(speaker.get("name", ""))
		"sceneNpc": var id := _speaker_npc_id(speaker); var npc: Variant = scene_manager.get_npc_by_id(id) if scene_manager != null else null; return str(npc.def.get("name")) if npc != null else (npc_name if id.is_empty() else id)
	return ""
func _speaker_npc_id(speaker: Dictionary) -> String:
	if speaker.get("kind") == "npc": return npc_id
	if speaker.get("kind") == "sceneNpc": var id := str(speaker.get("npcId", "")); return npc_id if id == "@contextNpc" else id
	return ""
func _condition_context(type: String, id: String) -> Dictionary:
	var context: Dictionary = _condition_context_factory.call() if not _condition_context_factory.is_null() and _condition_context_factory.is_valid() else {"flagStore": flag_store, "questManager": quest_manager, "scenarioState": scenario_state}
	if not type.strip_edges().is_empty() and not id.strip_edges().is_empty(): context.currentOwner = {"ownerType": type.strip_edges(), "ownerId": id.strip_edges()}
	return context
func _r(text: String) -> String: return str(_resolve_display.call(text)) if not _resolve_display.is_null() and _resolve_display.is_valid() else text
func _continue_deferred_chain() -> void:
	if chain_runner_active: return
	chain_runner_active = true; var generation := _chain_generation
	while generation == _chain_generation and not active and not deferred_graph_queue.is_empty(): var request: Dictionary = deferred_graph_queue.pop_front(); await start_dialogue_graph(request)
	if generation != _chain_generation: return
	chain_runner_active = false; chain_continuation_pending = false
	if not active and last_graph_end_was_continuing:
		last_graph_end_was_continuing = false
		event_bus.emit("dialogue:end", {"source": "graph", "willContinue": false})


func _reset_session_fields() -> void:
	active = false; graph.clear(); graph_source_id = ""; current_node_id = ""; npc_name = ""; npc_id = ""; owner_type = ""; owner_id = ""; dim_background = false; choice_phase = null; last_precondition_debug = null; last_switch_debug = null; narrative_route_node_ids.clear(); awaiting_line_dismiss = false; line_beat_index = 0


func _push_route(node_id: String) -> void:
	if not node_id.is_empty(): narrative_route_node_ids.push_back(node_id)
