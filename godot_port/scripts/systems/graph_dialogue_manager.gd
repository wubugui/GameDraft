class_name RuntimeGraphDialogueManager
extends RuntimeSystem

const MAX_DRAIN_STEPS_PER_RUN := 1000

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var asset_manager: RuntimeAssetManager
var scene_manager: RuntimeSceneManager
var rules_manager: RuntimeRulesManager
var quest_manager: RuntimeQuestManager
var inventory_manager: RuntimeInventoryManager
var scenario_state: RuntimeScenarioStateManager
var strings: Variant = null
var resolve_display := Callable()
var condition_ctx_factory := Callable()

var graph: Variant = null
var graph_source_id := ""
var current_node_id := ""
var active := false
var npc_name := ""
var npc_id := ""
var dim_background := false
var owner_type := ""
var owner_id := ""
var op_chain: RuntimeAsyncTail = RuntimeAsyncTail.new()

var choice_phase: Variant = null
var awaiting_line_dismiss := false
var line_beat_index := 0
var drain_depth := 0
var op_drain_generation := 0
var deferred_graph_queue: Array = []
var chain_runner_active := false
var chain_continuation_pending := false
var last_graph_end_was_continuing := false

var last_precondition_debug: Variant = null
var last_switch_debug: Variant = null
var narrative_route_node_ids: Array[String] = []

var player_portrait_slug_provider := Callable()


func _init(
	next_event_bus: RuntimeEventBus,
	next_flag_store: RuntimeFlagStore,
	next_action_executor: RuntimeActionExecutor,
	next_asset_manager: RuntimeAssetManager,
	next_scene_manager: RuntimeSceneManager,
	next_rules_manager: RuntimeRulesManager,
	next_quest_manager: RuntimeQuestManager,
	next_inventory_manager: RuntimeInventoryManager,
	next_scenario_state: RuntimeScenarioStateManager,
) -> void:
	event_bus = next_event_bus
	flag_store = next_flag_store
	action_executor = next_action_executor
	asset_manager = next_asset_manager
	scene_manager = next_scene_manager
	rules_manager = next_rules_manager
	quest_manager = next_quest_manager
	inventory_manager = next_inventory_manager
	scenario_state = next_scenario_state


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void:
	condition_ctx_factory = factory


func get_narrative_eval_debug() -> Dictionary:
	var parts: Array[String] = []
	if not narrative_route_node_ids.is_empty():
		parts.push_back("【节点路由】%s" % " -> ".join(narrative_route_node_ids))
	else:
		parts.push_back("【节点路由】（尚无记录，或未在对话中）")
	parts.push_back("对话进行中: %s" % ("是" if active else "否"))
	parts.push_back("图(graphSourceId): %s" % (graph_source_id if not graph_source_id.is_empty() else "—"))
	parts.push_back("当前节点: %s" % (current_node_id if not current_node_id.is_empty() else "—"))
	parts.push_back("")
	if last_precondition_debug is Dictionary:
		parts.push_back("【最近·图 preconditions】")
		parts.push_back("图: %s" % last_precondition_debug.graphId)
		parts.push_back("满足: %s" % last_precondition_debug.satisfied)
		parts.push_back(str(last_precondition_debug.traceText))
		parts.push_back("")
	else:
		parts.push_back("【最近·图 preconditions】（尚无记录）")
		parts.push_back("")
	if last_switch_debug is Dictionary:
		parts.push_back("【最近·switch】")
		parts.push_back("节点: %s" % last_switch_debug.nodeId)
		parts.push_back("选中 next: %s（defaultNext=%s）" % [last_switch_debug.chosenNext, last_switch_debug.defaultNext])
		for case: Dictionary in last_switch_debug.casesTried:
			parts.push_back("— case[%s] -> %s命中=%s" % [case.index, case.next, case.matched])
			var indented: Array[String] = []
			for line: String in str(case.traceText).split("\n"):
				indented.push_back("    %s" % line)
			parts.push_back("\n".join(indented))
	else:
		parts.push_back("【最近·switch】（尚无记录）")
	return {
		"active": active,
		"graphSourceId": graph_source_id,
		"currentNodeId": current_node_id,
		"lastPrecondition": last_precondition_debug,
		"lastSwitch": last_switch_debug,
		"summaryText": "\n".join(parts),
	}


func _condition_ctx() -> Dictionary:
	var injected: Variant = condition_ctx_factory.call() if condition_ctx_factory.is_valid() else null
	var current_owner: Variant = null
	var trimmed_owner_type := owner_type.strip_edges()
	var trimmed_owner_id := owner_id.strip_edges()
	if not trimmed_owner_type.is_empty() and not trimmed_owner_id.is_empty():
		current_owner = {"ownerType": trimmed_owner_type, "ownerId": trimmed_owner_id}
	if injected is Dictionary:
		if current_owner == null:
			return injected
		var with_owner: Dictionary = injected.duplicate(false)
		with_owner.currentOwner = current_owner
		return with_owner
	return {
		"flagStore": flag_store,
		"questManager": quest_manager,
		"scenarioState": scenario_state,
		"resolveConditionLiteral": func(raw: Variant) -> String: return _r(str(raw)),
		"currentOwner": current_owner,
	}


func _push_narrative_route_step(node_id: String) -> void:
	if not node_id.is_empty():
		narrative_route_node_ids.push_back(node_id)


func _run_exclusive(callback: Callable) -> void:
	var tail := op_chain
	var generation_at_schedule := op_drain_generation
	await tail.then(func() -> void:
		if generation_at_schedule != op_drain_generation:
			return
		await callback.call()
	, "GraphDialogueManager: op failed")


func _run_user_op(callback: Callable) -> void:
	if drain_depth > 0:
		await RuntimeMicrotaskQueue.yield_turn()
		var result: Variant = await callback.call()
		if result is bool and result == false:
			push_warning("GraphDialogueManager: op failed")
		return
	await _run_exclusive(callback)


func init(ctx: Dictionary) -> void:
	strings = ctx.strings


func set_resolve_display(callback: Callable = Callable()) -> void:
	resolve_display = callback


func _r(text: String) -> String:
	return str(resolve_display.call(text)) if resolve_display.is_valid() else text


func update(_dt: float) -> void:
	return


func serialize() -> Dictionary:
	return {"active": false}


func deserialize(_data: Dictionary) -> void:
	deferred_graph_queue.clear()
	chain_continuation_pending = false
	last_graph_end_was_continuing = false
	_reset_session_fields()


func is_active() -> bool:
	return active


func has_pending_chain_continuation() -> bool:
	return chain_continuation_pending


func get_debug_interaction_state() -> Dictionary:
	return {
		"active": active,
		"graphSourceId": graph_source_id,
		"currentNodeId": current_node_id,
		"choiceStage": choice_phase.stage if choice_phase is Dictionary else "none",
		"awaitingLineDismiss": awaiting_line_dismiss,
	}


func get_player_dialogue() -> Dictionary:
	if not active or not graph is Dictionary:
		return {"active": false, "speaker": "", "text": "", "awaitingAdvance": false, "choices": []}
	var choices: Array = []
	if choice_phase is Dictionary and choice_phase.stage == "options":
		var choice_node: Variant = graph.nodes.get(choice_phase.nodeId)
		if choice_node is Dictionary and choice_node.get("type") == "choice":
			for choice: Dictionary in _build_choices_for_node(choice_node):
				choices.push_back({"index": choice.index, "text": choice.text, "selectable": choice.enabled})
	var text := ""
	var current: Variant = graph.nodes.get(current_node_id)
	if current is Dictionary and current.get("type") == "line":
		var beats := _line_beats_for(current)
		var beat: Variant = beats[mini(line_beat_index, beats.size() - 1)] if not beats.is_empty() else null
		if beat is Dictionary:
			text = str(_line_payload_to_dialogue_line(beat).get("text", ""))
	return {
		"active": true,
		"speaker": npc_name,
		"text": text,
		"awaitingAdvance": awaiting_line_dismiss,
		"choices": choices,
	}


func get_dialogue_view_debug() -> Dictionary:
	if not active or not graph is Dictionary:
		return {
			"active": false, "graphId": "", "npcName": "", "nodeId": "",
			"nodeType": null, "choiceStage": "none", "choices": [],
		}
	var choices: Array = []
	if choice_phase is Dictionary and choice_phase.stage == "options":
		var choice_node: Variant = graph.nodes.get(choice_phase.nodeId)
		if choice_node is Dictionary and choice_node.get("type") == "choice":
			for choice: Dictionary in _build_choices_for_node(choice_node):
				choices.push_back({"index": choice.index, "text": choice.text, "enabled": choice.enabled})
	var node: Variant = graph.nodes.get(current_node_id)
	return {
		"active": true,
		"graphId": graph_source_id if not graph_source_id.is_empty() else str(graph.get("id", "")),
		"npcName": npc_name,
		"nodeId": current_node_id,
		"nodeType": node.get("type") if node is Dictionary else null,
		"choiceStage": choice_phase.stage if choice_phase is Dictionary else "none",
		"choices": choices,
	}


func get_context_npc_id() -> String:
	return npc_id.strip_edges()


func destroy() -> void:
	deferred_graph_queue.clear()
	chain_continuation_pending = false
	last_graph_end_was_continuing = false
	if active:
		end_dialogue()
	else:
		op_drain_generation += 1
		op_chain = RuntimeAsyncTail.new()
	strings = null


func start_dialogue_graph(params: Dictionary) -> void:
	var graph_id := str(params.get("graphId", "") if params.get("graphId") != null else "").strip_edges()
	if graph_id.is_empty():
		return

	if drain_depth > 0 and active:
		var nested_npc_id := str(params.get("npcId", "") if params.get("npcId") != null else "").strip_edges()
		var nested_owner_id := str(params.get("ownerId", "") if params.get("ownerId") != null else "").strip_edges()
		var nested_entry := str(params.get("entry", "") if params.get("entry") != null else "").strip_edges()
		var nested_owner_type := str(params.get("ownerType", "") if params.get("ownerType") != null else "").strip_edges()
		deferred_graph_queue.push_back({
			"graphId": graph_id,
			"entry": nested_entry if not nested_entry.is_empty() else null,
			"npcName": str(params.get("npcName", "") if params.get("npcName") != null else ""),
			"npcId": nested_npc_id if not nested_npc_id.is_empty() else null,
			"ownerType": nested_owner_type if not nested_owner_type.is_empty() else null,
			"ownerId": nested_owner_id if not nested_owner_id.is_empty() else (nested_npc_id if not nested_npc_id.is_empty() else null),
			"preferGraphMetaTitle": params.get("preferGraphMetaTitle") == true,
			"dimBackground": params.get("dimBackground") == true,
		})
		return

	await _run_exclusive(func() -> void:
		if active:
			push_warning("GraphDialogueManager: 已有对话进行中，忽略重复 start")
			return

		var generation_at_start := op_drain_generation
		var path := RuntimeResourceLocator.get_default().dialogue_graph_json_url(graph_id)
		var raw: Variant = asset_manager.load_json(path)
		await RuntimeMicrotaskQueue.yield_turn()
		if not raw is Dictionary:
			push_warning("GraphDialogueManager: 无法加载 %s: %s" % [path, asset_manager.get_last_error()])
			return

		if generation_at_start != op_drain_generation:
			return

		if not raw.get("nodes") is Dictionary or not raw.get("entry") is String or not raw.nodes.get(raw.entry) is Dictionary:
			push_warning("GraphDialogueManager: 图 %s 缺少 entry 或 nodes" % graph_id)
			RuntimeDevErrorOverlay.report_dev_error("对话图 \"%s\" 缺少 entry 或 nodes，对话未开启" % graph_id, "[dialogue]")
			return

		var raw_id := str(raw.get("id", "") if raw.get("id") is String else "").strip_edges()
		if not raw_id.is_empty() and raw_id != graph_id:
			push_warning("GraphDialogueManager: 图 JSON id \"%s\" 与路径 graphId \"%s\" 不一致，以路径为准继续" % [raw_id, graph_id])

		last_switch_debug = null
		var precondition_context := _condition_ctx()
		var precondition_trace := RuntimeConditionEvaluator.evaluate_preconditions_with_trace(raw.get("preconditions"), precondition_context)
		last_precondition_debug = {
			"graphId": graph_id,
			"satisfied": precondition_trace.result,
			"traceText": RuntimeConditionEvaluator.format_trace(precondition_trace.trace),
		}
		if precondition_trace.result != true:
			push_warning("GraphDialogueManager: 图 %s preconditions 不满足" % graph_id)
			return

		graph = raw
		graph_source_id = graph_id
		var meta_title := ""
		if raw.get("meta") is Dictionary and raw.meta.get("title") is String:
			meta_title = raw.meta.title.strip_edges()
		var use_meta: bool = params.get("preferGraphMetaTitle") == true and not meta_title.is_empty()
		npc_name = meta_title if use_meta else str(params.get("npcName", "") if params.get("npcName") != null else "")
		npc_id = str(params.get("npcId", "") if params.get("npcId") != null else "").strip_edges()
		owner_type = str(params.get("ownerType", "") if params.get("ownerType") != null else "").strip_edges()
		if owner_type.is_empty() and not npc_id.is_empty():
			owner_type = "npc"
		owner_id = str(params.get("ownerId", "") if params.get("ownerId") != null else "").strip_edges()
		if owner_id.is_empty():
			owner_id = npc_id
		dim_background = params.get("dimBackground") == true
		var requested_entry := str(params.get("entry", "") if params.get("entry") != null else "").strip_edges()
		current_node_id = requested_entry if not requested_entry.is_empty() and raw.nodes.has(requested_entry) else str(raw.entry)
		narrative_route_node_ids.assign([current_node_id] if not current_node_id.is_empty() else [])
		active = true
		choice_phase = null
		awaiting_line_dismiss = false
		line_beat_index = 0

		event_bus.emit("dialogue:start", {"npcName": npc_name, "graphId": graph_id, "source": "graph"})
		await _drain_until_blocking()
	)


func advance() -> void:
	await _run_user_op(func() -> void:
		if not active or not graph is Dictionary:
			return
		if not awaiting_line_dismiss and not (choice_phase is Dictionary and choice_phase.stage == "prompt"):
			return
		await _advance_core()
	)


func _advance_core() -> void:
	if not active or not graph is Dictionary:
		return

	if choice_phase is Dictionary and choice_phase.stage == "prompt":
		_show_choice_options_from_prompt()
		return

	if awaiting_line_dismiss:
		awaiting_line_dismiss = false
		var current: Variant = graph.nodes.get(current_node_id)
		if current is Dictionary and current.get("type") == "line":
			var beats := _line_beats_for(current)
			if line_beat_index + 1 < beats.size():
				line_beat_index += 1
				var line := _line_payload_to_dialogue_line(beats[line_beat_index])
				event_bus.emit("dialogue:line", line)
				awaiting_line_dismiss = true
				var next_after_beat: Variant = graph.nodes.get(current.get("next"))
				if line_beat_index == beats.size() - 1 and next_after_beat is Dictionary and next_after_beat.get("type") == "end":
					event_bus.emit("dialogue:willEnd", {})
				return
			line_beat_index = 0
			var next_after_line: Variant = graph.nodes.get(current.get("next"))
			if not (next_after_line is Dictionary and next_after_line.get("type") == "runActions"):
				event_bus.emit("dialogue:prepareBeat", {})
			current_node_id = str(current.get("next", ""))
			_push_narrative_route_step(current_node_id)
			await _drain_until_blocking()
		elif current is Dictionary and current.get("type") == "end":
			end_dialogue()
		return

	var head: Variant = graph.nodes.get(current_node_id)
	if not (head is Dictionary and head.get("type") == "runActions"):
		event_bus.emit("dialogue:prepareBeat", {})
	await _drain_until_blocking()


func choose_option(index: int) -> void:
	await _run_user_op(func() -> void:
		if not active or not graph is Dictionary or not choice_phase is Dictionary or choice_phase.stage != "options":
			return
		var node: Variant = graph.nodes.get(choice_phase.nodeId)
		if not node is Dictionary or node.get("type") != "choice":
			return
		var options: Variant = node.get("options")
		if not options is Array or index < 0 or index >= options.size():
			return
		var option: Variant = options[index]
		if not option is Dictionary:
			return
		var built := _build_choices_for_node(node)
		var built_choice: Variant = built[index] if index < built.size() else null
		if not built_choice is Dictionary or built_choice.get("enabled") != true:
			return
		var cost: Variant = option.get("costCoins")
		if (cost is int or cost is float) and float(cost) > 0.0:
			inventory_manager.remove_coins(float(cost))
		event_bus.emit("dialogue:choiceSelected:log", {"index": index, "text": built_choice.text})
		choice_phase = null
		current_node_id = str(option.get("next", ""))
		_push_narrative_route_step(current_node_id)
		await _advance_core()
	)


func debug_advance_until_blocking(max_steps: int = 24) -> Dictionary:
	var limit := clampi(max_steps if max_steps != 0 else 24, 1, 200)
	var steps := 0
	for _index: int in limit:
		var before := get_debug_interaction_state()
		if before.active != true or before.choiceStage == "options":
			break
		await advance()
		steps += 1
		var after := get_debug_interaction_state()
		if after.active != true or after.choiceStage == "options":
			break
		if after.currentNodeId == before.currentNodeId and after.choiceStage == before.choiceStage and after.awaitingLineDismiss == before.awaitingLineDismiss:
			break
	var final_state := get_debug_interaction_state()
	return {
		"steps": steps,
		"active": final_state.active,
		"currentNodeId": final_state.currentNodeId,
		"choiceStage": final_state.choiceStage,
	}


func debug_choose_option(params: Dictionary) -> bool:
	if not active or not graph is Dictionary:
		return false
	if choice_phase is Dictionary and choice_phase.stage == "prompt":
		await advance()
	if not active or not graph is Dictionary or not choice_phase is Dictionary or choice_phase.stage != "options":
		return false
	var node: Variant = graph.nodes.get(choice_phase.nodeId)
	if not node is Dictionary or node.get("type") != "choice":
		return false
	var choices := _build_choices_for_node(node)
	var raw_index: Variant = params.get("index")
	var index := int(raw_index) if (raw_index is int or raw_index is float) and is_finite(float(raw_index)) else -1
	var raw_text: Variant = params.get("text")
	if index < 0 and raw_text is String and not raw_text.strip_edges().is_empty():
		var needle := _normalize_choice_text(raw_text)
		var exact: Variant = null
		for choice: Dictionary in choices:
			if _normalize_choice_text(str(choice.text)) == needle and choice.enabled == true:
				exact = choice
				break
		var partial: Variant = exact
		if partial == null:
			for choice: Dictionary in choices:
				if _normalize_choice_text(str(choice.text)).contains(needle) and choice.enabled == true:
					partial = choice
					break
		index = int(partial.index) if partial is Dictionary else -1
	if index < 0 or index >= choices.size() or choices[index].enabled != true:
		return false
	await choose_option(index)
	return true


func end_dialogue() -> void:
	if not active:
		return
	_reset_session_fields()
	var will_continue := not deferred_graph_queue.is_empty()
	last_graph_end_was_continuing = will_continue
	event_bus.emit("dialogue:end", {"source": "graph", "willContinue": will_continue})
	if not will_continue:
		return
	if chain_runner_active:
		return
	chain_continuation_pending = true
	_run_deferred_chain_continuation()


func _reset_session_fields() -> void:
	active = false
	graph = null
	graph_source_id = ""
	current_node_id = ""
	npc_name = ""
	npc_id = ""
	owner_type = ""
	owner_id = ""
	dim_background = false
	choice_phase = null
	last_precondition_debug = null
	last_switch_debug = null
	narrative_route_node_ids.clear()
	awaiting_line_dismiss = false
	line_beat_index = 0
	op_drain_generation += 1
	op_chain = RuntimeAsyncTail.new()


func _run_deferred_chain_continuation() -> void:
	chain_runner_active = true
	while not active and not deferred_graph_queue.is_empty():
		var item: Variant = deferred_graph_queue.pop_front()
		if item is Dictionary:
			await start_dialogue_graph(item)
	chain_runner_active = false
	chain_continuation_pending = false
	if not active and last_graph_end_was_continuing:
		last_graph_end_was_continuing = false
		event_bus.emit("dialogue:end", {"source": "graph", "willContinue": false})


func _drain_until_blocking() -> void:
	if not active or not graph is Dictionary:
		return
	drain_depth += 1
	var steps := 0
	while active and graph is Dictionary:
		steps += 1
		if steps > MAX_DRAIN_STEPS_PER_RUN:
			var recent_route: Array[String] = narrative_route_node_ids.slice(maxi(0, narrative_route_node_ids.size() - 8))
			push_error("GraphDialogueManager: 图 %s 单次推进超过 %s 步，疑似路由成环（当前节点 %s，近路由 %s），强制结束对话" % [graph_source_id, MAX_DRAIN_STEPS_PER_RUN, current_node_id, " -> ".join(recent_route)])
			end_dialogue()
			break
		var node: Variant = graph.nodes.get(current_node_id)
		if not node is Dictionary:
			push_warning("GraphDialogueManager: 缺失节点 %s" % current_node_id)
			end_dialogue()
			break

		if node.get("type") == "switch":
			current_node_id = _eval_switch(node)
			_push_narrative_route_step(current_node_id)
			continue

		if node.get("type") == "ownerState":
			current_node_id = _eval_owner_state(node)
			_push_narrative_route_step(current_node_id)
			continue

		if node.get("type") == "contextState":
			current_node_id = _eval_context_state(node)
			_push_narrative_route_step(current_node_id)
			continue

		if node.get("type") == "runActions":
			event_bus.emit("dialogue:hidePanel", {})
			var actions_ok := true
			for action: Variant in node.get("actions", []):
				if action is Dictionary and not await action_executor.execute_await(action):
					actions_ok = false
					break
			if not actions_ok:
				push_warning("GraphDialogueManager: runActions 执行失败，结束对话")
				end_dialogue()
				break
			current_node_id = str(node.get("next", ""))
			_push_narrative_route_step(current_node_id)
			continue

		if node.get("type") == "line":
			line_beat_index = 0
			var beats := _line_beats_for(node)
			if beats.is_empty() or beats[0] == null:
				push_warning("GraphDialogueManager: line 节点无可用台词 %s" % current_node_id)
				end_dialogue()
				break
			var first: Variant = beats[0]
			if not first is Dictionary:
				push_warning("GraphDialogueManager: line 节点无可用台词 %s" % current_node_id)
				end_dialogue()
				break
			var line := _line_payload_to_dialogue_line(first)
			event_bus.emit("dialogue:line", line)
			awaiting_line_dismiss = true
			var next: Variant = graph.nodes.get(node.get("next"))
			if beats.size() == 1 and next is Dictionary and next.get("type") == "end":
				event_bus.emit("dialogue:willEnd", {})
			break

		if node.get("type") == "choice":
			if node.get("promptLine") is Dictionary:
				choice_phase = {"nodeId": current_node_id, "stage": "prompt"}
				var line := _line_payload_to_dialogue_line(node.promptLine)
				event_bus.emit("dialogue:line", line)
				awaiting_line_dismiss = true
				break
			event_bus.emit("dialogue:prepareBeat", {})
			choice_phase = {"nodeId": current_node_id, "stage": "options"}
			_emit_choices_for_node(node)
			break

		if node.get("type") == "end":
			end_dialogue()
			break

		push_warning("GraphDialogueManager: 未知节点类型，结束对话 %s %s" % [current_node_id, node])
		end_dialogue()
		break
	drain_depth -= 1


func _show_choice_options_from_prompt() -> void:
	if not graph is Dictionary or not choice_phase is Dictionary or choice_phase.stage != "prompt":
		return
	var node: Variant = graph.nodes.get(choice_phase.nodeId)
	if not node is Dictionary or node.get("type") != "choice":
		return
	awaiting_line_dismiss = false
	choice_phase = {"nodeId": choice_phase.nodeId, "stage": "options"}
	_emit_choices_for_node(node)


func _inventory_coins_for_choice() -> float:
	return inventory_manager.get_coins()


func _emit_choices_for_node(node: Dictionary) -> void:
	var choices := _build_choices_for_node(node)
	var has_enabled := false
	for choice: Dictionary in choices:
		if choice.enabled == true:
			has_enabled = true
			break
	if choices.is_empty() or not has_enabled:
		push_error("GraphDialogueManager: choice 节点 %s（图 %s）无可选选项，强制结束对话" % [current_node_id, graph_source_id])
		end_dialogue()
		return
	event_bus.emit("dialogue:choices", choices)


func _build_choices_for_node(node: Dictionary) -> Array:
	var output: Array = []
	var context := _condition_ctx()
	var options: Variant = node.get("options")
	if not options is Array:
		return output
	for index: int in options.size():
		var option: Variant = options[index]
		if not option is Dictionary:
			continue
		var require_key_text := str(option.get("requireFlag", "") if option.get("requireFlag") != null else "").strip_edges()
		var require_key: Variant = require_key_text if not require_key_text.is_empty() else null
		var require_expression_ok := true
		if option.has("requireCondition") and option.get("requireCondition") != null:
			require_expression_ok = RuntimeConditionEvaluator.evaluate(option.requireCondition, context)
		var require_ok := require_expression_ok and (require_key == null or flag_store.check_conditions([{"flag": require_key, "op": "!=", "value": false}]))
		var cost_amount: Variant = option.get("costCoins") if option.has("costCoins") else null
		var coins := _inventory_coins_for_choice()
		var cost_ok := cost_amount == null or coins >= float(cost_amount)
		var enabled := require_ok and cost_ok
		var custom_hint: Variant = null
		if not enabled and option.get("disabledClickHint") is String and not option.disabledClickHint.strip_edges().is_empty():
			custom_hint = option.disabledClickHint.strip_edges()
		var auto_hint: Variant = null
		if not enabled:
			auto_hint = _build_choice_disable_hint({
				"requireKey": require_key,
				"reqOk": require_ok,
				"reqExprOk": require_expression_ok,
				"costAmount": cost_amount,
				"costOk": cost_ok,
				"ruleHintId": option.get("ruleHintId") if option.has("ruleHintId") else null,
			}, strings)
		var disable_hint: Variant = custom_hint if custom_hint != null else auto_hint
		var choice := {
			"index": index,
			"text": _r(str(option.get("text", ""))),
			"tags": [],
			"enabled": enabled,
		}
		if option.has("ruleHintId") and option.get("ruleHintId") != null:
			choice.ruleHintId = option.ruleHintId
		if disable_hint != null:
			choice.disableHint = _r(str(disable_hint))
		output.push_back(choice)
	return output


func _build_choice_disable_hint(args: Dictionary, provider: Variant) -> Variant:
	if provider == null:
		return null
	if args.reqExprOk != true:
		return provider.get_text("dialogue", "choiceFlagLocked")
	if args.reqOk != true and args.requireKey != null:
		if args.ruleHintId != null:
			var definition: Variant = rules_manager.get_rule_def(str(args.ruleHintId))
			var name := str(definition.get("name", args.ruleHintId)) if definition is Dictionary else str(args.ruleHintId)
			return provider.get_text("dialogue", "choiceNeedRule", {"name": name})
		return provider.get_text("dialogue", "choiceFlagLocked")
	if args.costOk != true and args.costAmount != null:
		return provider.get_text("dialogue", "choiceNeedCoins", {"amount": args.costAmount})
	return null


func _normalize_choice_text(text: String) -> String:
	var whitespace := RegEx.create_from_string("\\s+")
	return whitespace.sub(_r(text), "", true).strip_edges().to_lower()


func _eval_switch(node: Dictionary) -> String:
	var context := _condition_ctx()
	var cases_tried: Array = []
	var chosen := str(node.get("defaultNext", ""))
	var cases: Variant = node.get("cases")
	if not cases is Array:
		cases = []
	for index: int in cases.size():
		var case: Variant = cases[index]
		if not case is Dictionary:
			continue
		var trace_result: Dictionary
		if case.has("condition") and case.get("condition") != null:
			trace_result = RuntimeConditionEvaluator.evaluate_with_trace(case.condition, context)
		else:
			var conditions: Variant = case.get("conditions")
			if not conditions is Array:
				conditions = []
			var expression: Variant = conditions[0] if conditions.size() == 1 else ({"all": []} if conditions.is_empty() else {"all": conditions})
			trace_result = RuntimeConditionEvaluator.evaluate_with_trace(expression, context)
		var matched: bool = trace_result.result == true
		cases_tried.push_back({
			"index": index,
			"next": str(case.get("next", "")),
			"matched": matched,
			"traceText": RuntimeConditionEvaluator.format_trace(trace_result.trace),
		})
		if matched:
			chosen = str(case.get("next", ""))
			break
	last_switch_debug = {
		"graphSourceId": graph_source_id,
		"nodeId": current_node_id,
		"defaultNext": str(node.get("defaultNext", "")),
		"chosenNext": chosen,
		"casesTried": cases_tried,
	}
	return chosen


func _eval_owner_state(node: Dictionary) -> String:
	var fallback := str(node.get("missingWrapperNext", "") if node.get("missingWrapperNext") != null else "").strip_edges()
	if fallback.is_empty():
		fallback = str(node.get("defaultNext", ""))
	var trimmed_owner_type := owner_type.strip_edges()
	var trimmed_owner_id := owner_id.strip_edges()
	var context := _condition_ctx()
	var wrapper_graph_id := RuntimeConditionEvaluator.resolve_narrative_graph_ref(str(node.get("wrapperGraphId", "") if node.get("wrapperGraphId") != null else "").strip_edges(), context)
	if trimmed_owner_type.is_empty() or trimmed_owner_id.is_empty():
		push_warning("GraphDialogueManager: ownerState %s has no dialogue owner context" % current_node_id)
		return fallback
	var narrative: Variant = context.get("narrativeState")
	var active_state: Variant = null
	if not wrapper_graph_id.is_empty():
		var wrapper_graph: Variant = narrative.get_graph(wrapper_graph_id) if narrative != null else null
		if wrapper_graph == null:
			push_warning("GraphDialogueManager: ownerState %s references missing wrapperGraphId %s" % [current_node_id, wrapper_graph_id])
			return fallback
		if wrapper_graph is Dictionary:
			var graph_owner_type := str(wrapper_graph.get("ownerType", "") if wrapper_graph.get("ownerType") != null else "").strip_edges()
			var graph_owner_id := str(wrapper_graph.get("ownerId", "") if wrapper_graph.get("ownerId") != null else "").strip_edges()
			if not graph_owner_type.is_empty() and not graph_owner_id.is_empty() and (graph_owner_type != trimmed_owner_type or graph_owner_id != trimmed_owner_id):
				push_warning("GraphDialogueManager: ownerState %s wrapperGraphId %s belongs to %s:%s, current dialogue owner is %s:%s" % [current_node_id, wrapper_graph_id, graph_owner_type, graph_owner_id, trimmed_owner_type, trimmed_owner_id])
		active_state = narrative.get_active_state(wrapper_graph_id) if narrative != null else null
		if active_state == null or str(active_state).is_empty():
			push_warning("GraphDialogueManager: ownerState %s cannot read active state for wrapperGraphId %s" % [current_node_id, wrapper_graph_id])
			return fallback
	else:
		var owner_graph_ids: Array = narrative.get_graph_ids_by_owner(trimmed_owner_type, trimmed_owner_id) if narrative != null else []
		if owner_graph_ids.size() > 1:
			push_warning("GraphDialogueManager: ownerState %s is ambiguous for %s:%s; set wrapperGraphId to one of [%s]" % [current_node_id, trimmed_owner_type, trimmed_owner_id, ", ".join(owner_graph_ids)])
			return fallback
		active_state = narrative.get_primary_active_state_by_owner(trimmed_owner_type, trimmed_owner_id) if narrative != null else null
	if active_state == null or str(active_state).is_empty():
		push_warning("GraphDialogueManager: ownerState %s cannot resolve wrapper for %s:%s" % [current_node_id, trimmed_owner_type, trimmed_owner_id])
		return fallback
	for case: Variant in node.get("cases", []):
		if case is Dictionary and case.get("state") == active_state:
			return str(case.get("next", ""))
	return str(node.get("defaultNext", ""))


func _eval_context_state(node: Dictionary) -> String:
	var context := _condition_ctx()
	var graph_id := RuntimeConditionEvaluator.resolve_narrative_graph_ref(str(node.get("graphId", "") if node.get("graphId") != null else "").strip_edges(), context)
	if graph_id.is_empty():
		push_warning("GraphDialogueManager: contextState %s missing graphId" % current_node_id)
		return str(node.get("defaultNext", ""))
	var narrative: Variant = context.get("narrativeState")
	var active_state: Variant = narrative.get_active_state(graph_id) if narrative != null else null
	if active_state == null or str(active_state).is_empty():
		push_warning("GraphDialogueManager: contextState %s cannot read active state for %s" % [current_node_id, graph_id])
		return str(node.get("defaultNext", ""))
	for case: Variant in node.get("cases", []):
		if case is Dictionary and case.get("state") == active_state:
			return str(case.get("next", ""))
	return str(node.get("defaultNext", ""))


func _line_beats_for(node: Dictionary) -> Array:
	var lines: Variant = node.get("lines")
	if lines is Array and not lines.is_empty():
		if not node.has("portrait"):
			return lines
		var output: Array = []
		for payload: Variant in lines:
			if payload is Dictionary and not payload.has("portrait"):
				var with_portrait: Dictionary = payload.duplicate(false)
				with_portrait.portrait = node.portrait
				output.push_back(with_portrait)
			else:
				output.push_back(payload)
		return output
	return [{
		"speaker": node.get("speaker"),
		"text": node.get("text"),
		"textKey": node.get("textKey"),
		"portrait": node.get("portrait"),
	}]


func _line_payload_to_dialogue_line(payload: Dictionary) -> Dictionary:
	var speaker: Variant = payload.get("speaker")
	var resolved_speaker: String = _r(_resolve_speaker(speaker))
	var text := ""
	var text_key: Variant = payload.get("textKey")
	if text_key is String and not text_key.strip_edges().is_empty():
		var key: String = text_key.strip_edges()
		var resolved: Variant = strings.get_text("dialogue", key) if strings != null else null
		text = str(resolved) if resolved is String and not resolved.is_empty() and resolved != key else str(payload.get("text", key) if payload.get("text") != null else key)
	else:
		text = str(payload.get("text", "") if payload.get("text") != null else "")
	var line: Dictionary = {"speaker": resolved_speaker, "text": _r(text), "tags": []}
	var portrait: Variant = _resolve_portrait(payload)
	if portrait != null:
		line.portrait = portrait
	var speaker_entity: Variant = _speaker_entity_of(speaker)
	if speaker_entity != null:
		line.speakerEntity = speaker_entity
	if dim_background:
		line.dim = true
	return line


func _speaker_entity_of(speaker: Variant) -> Variant:
	if not speaker is Dictionary:
		return null
	if speaker.get("kind") == "player":
		return {"kind": "player"}
	var id := _speaker_npc_id(speaker)
	return {"kind": "npc", "npcId": id} if not id.is_empty() else null


func _resolve_portrait(payload: Dictionary) -> Variant:
	var reference: Variant = payload.get("portrait")
	if not reference is Dictionary or str(reference.get("emotion", "")).is_empty():
		return null
	if reference.get("slug") is String and not reference.slug.strip_edges().is_empty():
		return reference
	var speaker: Variant = payload.get("speaker")
	if speaker is Dictionary and speaker.get("kind") == "player":
		var provided: Variant = player_portrait_slug_provider.call() if player_portrait_slug_provider.is_valid() else null
		var player_slug: String = provided.strip_edges() if provided is String else ""
		return {"slug": player_slug, "emotion": reference.emotion} if not player_slug.is_empty() else null
	if not speaker is Dictionary:
		return null
	var id: String = _speaker_npc_id(speaker)
	if id.is_empty():
		return null
	var npc: Variant = scene_manager.get_npc_by_id(id) if scene_manager != null else null
	var npc_slug: String = str(npc.get_current_portrait_slug()) if npc != null else ""
	return {"slug": npc_slug, "emotion": reference.emotion} if not npc_slug.is_empty() else null


func set_player_portrait_slug_provider(callback: Callable) -> void:
	player_portrait_slug_provider = callback


func _speaker_npc_id(speaker: Dictionary) -> String:
	if speaker.get("kind") == "npc":
		return npc_id.strip_edges()
	if speaker.get("kind") == "sceneNpc":
		var raw := str(speaker.get("npcId", "") if speaker.get("npcId") != null else "").strip_edges()
		var id := npc_id.strip_edges() if raw == "@contextNpc" else raw
		return id if not id.is_empty() else ""
	return ""


func _resolve_speaker(speaker: Variant) -> String:
	if not speaker is Dictionary:
		return str(speaker)
	if speaker.get("kind") == "player":
		var player_name: Variant = flag_store.get_value("player_display_name")
		if player_name is String and not player_name.strip_edges().is_empty():
			return player_name.strip_edges()
		var fallback: Variant = strings.get_text("dialogue", "defaultProtagonistName") if strings != null else null
		return str(fallback) if fallback is String and not fallback.is_empty() and fallback != "defaultProtagonistName" else "你"
	if speaker.get("kind") == "npc":
		return npc_name
	if speaker.get("kind") == "literal":
		return str(speaker.get("name", ""))
	var raw := str(speaker.get("npcId", "") if speaker.get("npcId") != null else "").strip_edges()
	var id := npc_id.strip_edges() if raw == "@contextNpc" else raw
	if id.is_empty():
		return npc_name if not npc_name.is_empty() else (raw if not raw.is_empty() else "…")
	var npc: Variant = scene_manager.get_npc_by_id(id) if scene_manager != null else null
	return str(npc.def.get("name", id)) if npc != null else id
