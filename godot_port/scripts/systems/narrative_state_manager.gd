class_name RuntimeNarrativeStateManager
extends RuntimeSystem

signal nested_drain_completed(depth: int)

const NARRATIVE_GRAPHS_URL := "/assets/data/narrative_graphs.json"
const DEFAULT_DRAFT_SIGNAL := "__draft__"
const MAX_DRAIN_STEPS := 128
const MAX_TRACE_EVENTS := 160

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _action_executor: RuntimeActionExecutor
var _asset_manager: RuntimeAssetManager
var _condition_context_factory := Callable()
var _graphs: Dictionary = {}
var _active_states: Dictionary = {}
var _reached_states: Dictionary = {}
var _owner_index: Dictionary = {}
var _queue: Array[Dictionary] = []
var _draining := false
var _running_actions_depth := 0
var _drain_step_count := 0
var _destroyed := false
var _reactive_eval_scheduled := false
var _recent_transitions: Array[Dictionary] = []
var _recent_issues: Array[Dictionary] = []
var _save_migrations: Variant = null
var _listened_signal_keys_cache: Variant = null
var _reported_unlistened_signal_keys: Dictionary = {}
var _recent_trace: Array[Dictionary] = []
var _trace_seq := 0
var _primary_owner_warning_keys: Dictionary = {}
var _nested_drain_active: Dictionary = {}


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore, action_executor: RuntimeActionExecutor) -> void:
	_event_bus = event_bus
	_flag_store = flag_store
	_action_executor = action_executor
	_event_bus.on("flag:changed", Callable(self, "_handle_flag_changed"))


func init(ctx: Dictionary) -> void:
	_asset_manager = ctx.assetManager


func update(_dt: float) -> void:
	return


func load_from_asset(path: String = NARRATIVE_GRAPHS_URL) -> bool:
	var data: Variant = _asset_manager.load_json(path)
	if not data is Dictionary:
		_record_issue("error", "narrative.load.failed", "NarrativeStateManager: narrative_graphs.json not found or invalid")
		set_save_migrations(null)
		register_graphs([])
		return false
	set_save_migrations(data.get("migrations"))
	register_graphs(RuntimeNarrativeGraphCompiler.compile(data))
	return true


func set_save_migrations(migrations: Variant) -> void:
	_save_migrations = migrations if migrations is Dictionary else null


func register_graphs(graphs: Array) -> void:
	_graphs.clear()
	_active_states.clear()
	_reached_states.clear()
	_owner_index.clear()
	_queue.clear()
	_primary_owner_warning_keys.clear()
	_listened_signal_keys_cache = null
	_reported_unlistened_signal_keys.clear()
	var retained_issues: Array[Dictionary] = []
	for issue: Dictionary in _recent_issues:
		if issue.get("code") == "narrative.load.failed":
			retained_issues.push_back(issue)
	_recent_issues = retained_issues
	for raw_graph: Variant in graphs:
		if not raw_graph is Dictionary:
			continue
		var graph: Dictionary = raw_graph
		var graph_id := str(graph.get("id", ""))
		var initial := str(graph.get("initialState", ""))
		if graph_id.is_empty() or initial.is_empty() or not graph.get("states") is Dictionary or not graph.states.get(initial) is Dictionary:
			_record_issue("warning", "graph.invalid", "NarrativeStateManager: skipped invalid graph", graph_id)
			continue
		if _graphs.has(graph_id):
			_record_issue("error", "graph.id.duplicate", "NarrativeStateManager: duplicate graph id %s" % JSON.stringify(graph_id), graph_id)
			continue
		_graphs[graph_id] = graph
		_active_states[graph_id] = initial
		_mark_state_reached(graph_id, initial)
		_index_graph_owner(graph)
		if graph.get("projectFlags", false) == true:
			_record_issue("warning", "projectFlags.deprecated", "NarrativeStateManager: graph.projectFlags is deprecated and ignored on %s" % graph_id, graph_id)
	_record_duplicate_owner_bindings()
	_kick_reactive_evaluation()


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void:
	_condition_context_factory = factory
	if not factory.is_null() and factory.is_valid() and not _graphs.is_empty():
		_kick_reactive_evaluation()


static func state_entered_signal_key(graph_id: Variant, state_id: Variant) -> String:
	return "state:%s:%s" % [str(graph_id).strip_edges(), str(state_id).strip_edges()]


static func graph_state_entered_key(graph_id: Variant, state_id: Variant) -> String:
	return state_entered_signal_key(graph_id, state_id)


static func normalize_trigger_key(key: Variant) -> String:
	return str(key).strip_edges() if key != null else ""


static func trigger_keys_equal(left: Variant, right: Variant) -> bool:
	return normalize_trigger_key(left) == normalize_trigger_key(right)


func get_active_state(graph_id: String) -> Variant:
	return _active_states.get(graph_id)


func is_state_active(graph_id: String, state_id: String) -> bool:
	return _active_states.get(graph_id) == state_id


func has_reached_state(graph_id: String, state_id: String) -> bool:
	var graph_key := graph_id.strip_edges()
	var state_key := state_id.strip_edges()
	if graph_key.is_empty() or state_key.is_empty():
		return false
	if _active_states.get(graph_key) == state_key:
		return true
	return _reached_states.get(graph_key, {}).has(state_key)


func get_graph(graph_id: String) -> Variant:
	return _graphs.get(graph_id)


func classify_state_ref(graph_id: String, state_id: String) -> String:
	if _graphs.is_empty():
		return "unavailable"
	var graph: Variant = _graphs.get(graph_id.strip_edges())
	if not graph is Dictionary:
		return "missingGraph"
	return "ok" if graph.states.get(state_id.strip_edges()) is Dictionary else "missingState"


func get_graphs() -> Array:
	return _graphs.values()


func get_graph_ids_by_owner(owner_type: String, owner_id: String) -> Array[String]:
	var result: Array[String] = []
	var key := _owner_key(owner_type, owner_id)
	if not key.is_empty():
		result.assign(_owner_index.get(key, []))
	return result


func get_graphs_by_owner(owner_type: String, owner_id: String) -> Array:
	var result: Array = []
	for graph_id: String in get_graph_ids_by_owner(owner_type, owner_id):
		if _graphs.has(graph_id):
			result.push_back(_graphs[graph_id])
	return result


func get_active_states_by_owner(owner_type: String, owner_id: String) -> Dictionary:
	var result := {}
	for graph_id: String in get_graph_ids_by_owner(owner_type, owner_id):
		if _active_states.get(graph_id) is String:
			result[graph_id] = _active_states[graph_id]
	return result


func get_primary_graph_by_owner(owner_type: String, owner_id: String) -> Variant:
	var graph_ids := get_graph_ids_by_owner(owner_type, owner_id)
	if graph_ids.is_empty():
		return null
	if graph_ids.size() > 1:
		_record_primary_owner_ambiguous(owner_type, owner_id, graph_ids)
		return null
	return _graphs.get(graph_ids[0])


func get_primary_active_state_by_owner(owner_type: String, owner_id: String) -> Variant:
	var graph: Variant = get_primary_graph_by_owner(owner_type, owner_id)
	return _active_states.get(graph.id) if graph is Dictionary else null


func is_owner_state_active(owner_type: String, owner_id: String, state_id: String) -> bool:
	return get_primary_active_state_by_owner(owner_type, owner_id) == state_id


func emit_narrative_signal(event_signal: Dictionary) -> void:
	var normalized := _normalize_signal(event_signal)
	if normalized.is_empty():
		_record_trace("signal.ignored", {"message": "invalid signal"})
		return
	if normalized.key == DEFAULT_DRAFT_SIGNAL:
		_record_trace("signal.ignored", {"triggerKey": normalized.key, "message": "refusing to emit draft signal"})
		return
	_record_trace("signal.received", {"triggerKey": normalized.key, "payload": {"source": normalized.source}})
	await _enqueue({"kind": "external", "key": normalized.key, "source": normalized.source})


func enqueue_trigger_key(key: Variant) -> void:
	var normalized := normalize_trigger_key(key)
	if normalized.is_empty():
		return
	await _enqueue({"kind": "external", "key": normalized})


func debug_set_narrative_state(graph_id: String, state_id: String) -> void:
	var graph_key := graph_id.strip_edges()
	var state_key := state_id.strip_edges()
	if graph_key.is_empty() or state_key.is_empty():
		return
	_record_issue("warning", "stateCommand.debugOnly", "NarrativeStateManager: debugSetNarrativeState bypasses transitions", graph_key, state_key)
	await _enqueue({"kind": "setState", "graphId": graph_key, "stateId": state_key})


func set_narrative_state(graph_id: String, state_id: String) -> void:
	await debug_set_narrative_state(graph_id, state_id)


func serialize() -> Dictionary:
	var reached := {}
	for graph_id: String in _reached_states:
		reached[graph_id] = _reached_states[graph_id].keys()
	return {"activeStates": _active_states.duplicate(true), "reachedStates": reached}


func deserialize(data: Dictionary) -> void:
	_reset_states_to_registered_baseline()
	_restore_active_states(data.get("activeStates", {}))
	_restore_reached_states(data.get("reachedStates"))
	_kick_reactive_evaluation()


func destroy() -> void:
	if _destroyed:
		return
	_destroyed = true
	_reactive_eval_scheduled = false
	_event_bus.off("flag:changed", Callable(self, "_handle_flag_changed"))
	_graphs.clear()
	_active_states.clear()
	_reached_states.clear()
	_owner_index.clear()
	_save_migrations = null
	_listened_signal_keys_cache = null
	_reported_unlistened_signal_keys.clear()
	_queue.clear()
	_condition_context_factory = Callable()


func debug_snapshot() -> Dictionary:
	var multi: Array = []
	for owner_key: String in _owner_index:
		if _owner_index[owner_key].size() > 1:
			multi.push_back({"ownerKey": owner_key, "graphIds": _owner_index[owner_key].duplicate()})
	return {
		"activeStates": _active_states.duplicate(true),
		"graphIds": _graphs.keys(),
		"ownerIndex": _owner_index.duplicate(true),
		"multiWrapperOwners": multi,
		"graphs": _graphs.keys(),
		"owners": _owner_index.duplicate(true),
		"recentTransitions": _recent_transitions.slice(maxi(0, _recent_transitions.size() - 20)),
		"recentIssues": _recent_issues.slice(maxi(0, _recent_issues.size() - 20)),
		"recentTrace": _recent_trace.slice(maxi(0, _recent_trace.size() - 80)),
		"traceLength": _recent_trace.size(),
		"queued": _queue.size(),
	}


func clear_debug_trace() -> void:
	_recent_trace.clear()


func debug_snapshot_fragment() -> Dictionary:
	return {"narrative": serialize()}


func graph_count() -> int:
	return _graphs.size()


func _normalize_signal(event_signal: Dictionary) -> Dictionary:
	var event_id := str(event_signal.get("signal", "")).strip_edges()
	if event_id.is_empty():
		return {}
	var source_type := str(event_signal.get("sourceType", "")).strip_edges()
	var source_id := str(event_signal.get("sourceId", "")).strip_edges()
	var source := {"signal": event_id}
	if not source_type.is_empty() and not source_id.is_empty():
		source["sourceType"] = source_type
		source["sourceId"] = source_id
	return {"key": event_id, "source": source}


func _enqueue(trigger: Dictionary) -> void:
	if _destroyed:
		return
	_queue.push_back(trigger)
	_record_trace("trigger.enqueued", _trace_patch_for_trigger(trigger))
	if not _draining:
		_draining = true
		_drain_step_count = 0
		await _drain_available(false)
		_draining = false
	elif _running_actions_depth > 0:
		await _drain_nested_queue()


func _drain_nested_queue() -> void:
	var depth := _running_actions_depth
	while _nested_drain_active.has(depth):
		await nested_drain_completed
	if _destroyed or _queue.is_empty(): return
	_nested_drain_active[depth] = true
	await _drain_available(true)
	_nested_drain_active.erase(depth)
	nested_drain_completed.emit(depth)


func _drain_available(nested: bool) -> void:
	while not _queue.is_empty() and not _destroyed:
		_drain_step_count += 1
		if _drain_step_count > MAX_DRAIN_STEPS:
			_record_issue("error", "drain.loop.guard", "NarrativeStateManager: drain loop guard tripped")
			_queue.clear()
			break
		var trigger: Dictionary = _queue.pop_front()
		await _process_queue_item(trigger)
		if nested and _queue.is_empty():
			break
		if not nested and _queue.is_empty() and not _destroyed:
			_evaluate_reactive_triggers()


func _process_queue_item(trigger: Dictionary) -> void:
	_record_trace("trigger.start", _trace_patch_for_trigger(trigger))
	match str(trigger.get("kind", "")):
		"setState":
			await _apply_state_command(str(trigger.get("graphId", "")), str(trigger.get("stateId", "")))
		"reactive":
			await _process_reactive_trigger(str(trigger.get("graphId", "")), str(trigger.get("transitionId", "")))
		"external":
			await _process_trigger(normalize_trigger_key(trigger.get("key")))
	_record_trace("trigger.end", _trace_patch_for_trigger(trigger))


func _process_trigger(trigger_key: String) -> void:
	var matched_graph_ids: Array[String] = []
	for graph_id: String in _graphs.keys():
		var graph: Dictionary = _graphs[graph_id]
		var active := str(_active_states.get(graph_id, graph.initialState))
		var selected: Variant = null
		var selected_priority := 0.0
		for raw_transition: Variant in graph.get("transitions", []):
			if not raw_transition is Dictionary:
				continue
			var transition: Dictionary = raw_transition
			if not trigger_keys_equal(transition.get("signal"), trigger_key):
				continue
			if not _is_local_endpoint(transition.get("from")) or not _is_local_endpoint(transition.get("to")):
				_record_unsupported_endpoint(graph_id, str(transition.get("id", "")))
				continue
			if transition.from != active or not _conditions_met(transition.get("conditions", [])):
				continue
			var priority := float(transition.get("priority", 0.0))
			if selected == null or priority > selected_priority:
				selected = transition
				selected_priority = priority
		if selected is Dictionary:
			await _apply_transition(graph, selected, trigger_key)
			matched_graph_ids.push_back(graph_id)
	if matched_graph_ids.is_empty():
		_report_unlistened_signal(trigger_key)
	_record_trace("signal.processed", {"triggerKey": trigger_key, "payload": {"matchedGraphIds": matched_graph_ids}, "message": "matched %s graph(s)" % matched_graph_ids.size() if not matched_graph_ids.is_empty() else "no matching transition"})


func _get_listened_signal_keys() -> Dictionary:
	if _listened_signal_keys_cache == null:
		var keys: Dictionary = {}
		for raw_graph: Variant in _graphs.values():
			if not raw_graph is Dictionary:
				continue
			for raw_transition: Variant in raw_graph.get("transitions", []):
				if not raw_transition is Dictionary:
					continue
				var trigger := str(raw_transition.get("trigger", ""))
				if not trigger.is_empty() and trigger != "signal":
					continue
				var key := normalize_trigger_key(raw_transition.get("signal"))
				if not key.is_empty():
					keys[key] = true
		_listened_signal_keys_cache = keys
	return _listened_signal_keys_cache


func _report_unlistened_signal(trigger_key: String) -> void:
	var key := normalize_trigger_key(trigger_key)
	if key.is_empty() or key == DEFAULT_DRAFT_SIGNAL or _graphs.is_empty():
		return
	if _reported_unlistened_signal_keys.has(key) or _get_listened_signal_keys().has(key):
		return
	_reported_unlistened_signal_keys[key] = true
	var message := "NarrativeStateManager: signal %s has no listening transition in any registered graph (emit is a no-op); likely dangling after rename/delete" % JSON.stringify(key)
	_record_issue("warning", "signal.unlistened", message)


func _conditions_met(conditions: Variant) -> bool:
	if not conditions is Array or conditions.is_empty():
		return true
	if _condition_context_factory.is_null() or not _condition_context_factory.is_valid():
		return false
	var context: Variant = _condition_context_factory.call()
	return context is Dictionary and context.get("evaluateList") is Callable and bool(context.evaluateList.call(conditions))


func _handle_flag_changed(_payload: Variant = null) -> void:
	if _destroyed or _graphs.is_empty() or _condition_context_factory.is_null() or not _condition_context_factory.is_valid():
		return
	if _reactive_eval_scheduled:
		return
	_reactive_eval_scheduled = true
	call_deferred("_flush_reactive_evaluation")


func _flush_reactive_evaluation() -> void:
	await flush_scheduled_reactive_evaluation()


func flush_scheduled_reactive_evaluation() -> void:
	if not _reactive_eval_scheduled: return
	_reactive_eval_scheduled = false
	if not _destroyed: await _kick_reactive_evaluation()


func _kick_reactive_evaluation() -> void:
	if _destroyed:
		return
	_evaluate_reactive_triggers()
	if _queue.is_empty():
		return
	if not _draining:
		_draining = true
		_drain_step_count = 0
		await _drain_available(false)
		_draining = false
	elif _running_actions_depth > 0:
		await _drain_nested_queue()


func _evaluate_reactive_triggers() -> void:
	for graph_id: String in _graphs:
		var graph: Dictionary = _graphs[graph_id]
		var active := str(_active_states.get(graph_id, graph.initialState))
		var selected: Variant = null
		var selected_priority := 0.0
		for raw_transition: Variant in graph.get("transitions", []):
			if not raw_transition is Dictionary:
				continue
			var transition: Dictionary = raw_transition
			var trigger := str(transition.get("trigger", "signal"))
			if trigger == "signal" or trigger.is_empty() or transition.get("from") != active:
				continue
			if not _is_local_endpoint(transition.get("from")) or not _is_local_endpoint(transition.get("to")):
				_record_unsupported_endpoint(graph_id, str(transition.get("id", "")))
				continue
			if not _evaluate_reactive_conditions(transition):
				continue
			var priority := float(transition.get("priority", 0.0))
			if selected == null or priority > selected_priority:
				selected = transition
				selected_priority = priority
		if selected is Dictionary:
			var transition_id := str(selected.get("id", ""))
			var duplicate := _queue.any(func(item: Dictionary) -> bool:
				return item.get("kind") == "reactive" and item.get("graphId") == graph_id and item.get("transitionId") == transition_id
			)
			if not duplicate:
				_record_trace("reactive.queued", {"graphId": graph_id, "transitionId": transition_id, "triggerKey": "__reactive__"})
				_queue.push_back({"kind": "reactive", "graphId": graph_id, "transitionId": transition_id})


func _evaluate_reactive_conditions(transition: Dictionary) -> bool:
	var conditions: Variant = transition.get("conditions")
	if not conditions is Array or conditions.is_empty():
		return false
	match str(transition.get("trigger", "")):
		"reactive": return _conditions_met(conditions)
		"reactiveAll": return _conditions_met([{"all": conditions}])
		"reactiveAny": return _conditions_met([{"any": conditions}])
	return false


func _process_reactive_trigger(graph_id: String, transition_id: String) -> void:
	var graph: Variant = _graphs.get(graph_id)
	if not graph is Dictionary:
		return
	var transition: Variant = null
	for candidate: Variant in graph.get("transitions", []):
		if candidate is Dictionary and candidate.get("id") == transition_id:
			transition = candidate
			break
	if not transition is Dictionary or str(transition.get("trigger", "")).is_empty():
		return
	var active := str(_active_states.get(graph_id, graph.initialState))
	if transition.get("from") == active and _evaluate_reactive_conditions(transition):
		await _apply_transition(graph, transition, "__reactive__")


func _apply_state_command(graph_id: String, state_id: String) -> void:
	var graph: Variant = _graphs.get(graph_id)
	if not graph is Dictionary or not graph.states.get(state_id) is Dictionary:
		_record_issue("warning", "setState.target.missing", "NarrativeStateManager: setState target missing %s.%s" % [graph_id, state_id], graph_id, state_id)
		return
	if not _can_remote_enter_state(graph, state_id):
		_record_issue("error", "scenario.boundary.stateCommand", "NarrativeStateManager: setState target violates scenario boundary %s.%s" % [graph_id, state_id], graph_id, state_id)
		return
	var from := str(_active_states.get(graph_id, graph.initialState))
	await _enter_state(graph, from, state_id, "setState:%s:%s" % [graph_id, state_id])


func _apply_transition(graph: Dictionary, transition: Dictionary, trigger_key: String) -> void:
	if not _is_local_endpoint(transition.get("from")) or not _is_local_endpoint(transition.get("to")):
		_record_unsupported_endpoint(graph.id, str(transition.get("id", "")))
		return
	var active_now := str(_active_states.get(graph.id, graph.initialState))
	if transition.from != active_now:
		_record_trace("signal.ignored", {"graphId": graph.id, "transitionId": transition.get("id", ""), "triggerKey": trigger_key, "message": "stale transition"})
		return
	if not graph.states.get(transition.from) is Dictionary:
		_record_issue("warning", "transition.from.missing", "NarrativeStateManager: transition source missing", graph.id, transition.from, transition.get("id", ""))
		return
	if not graph.states.get(transition.to) is Dictionary:
		_record_issue("warning", "transition.target.missing", "NarrativeStateManager: transition target missing", graph.id, transition.to, transition.get("id", ""))
		return
	await _enter_state(graph, transition.from, transition.to, trigger_key, str(transition.get("id", "")))


func _enter_state(graph: Dictionary, from_state_id: String, to_state_id: String, trigger_key: String, transition_id: String = "") -> void:
	var from_state: Variant = graph.states.get(from_state_id)
	var to_state: Variant = graph.states.get(to_state_id)
	if from_state is Dictionary:
		await _run_actions(from_state.get("onExitActions", []), "%s.%s.onExit" % [graph.id, from_state_id])
	_record_trace("transition.applied", {"graphId": graph.id, "transitionId": transition_id, "from": from_state_id, "to": to_state_id, "triggerKey": trigger_key})
	_active_states[graph.id] = to_state_id
	_mark_state_reached(graph.id, to_state_id)
	var record := {"graphId": graph.id, "transitionId": transition_id, "from": from_state_id, "to": to_state_id, "triggerKey": trigger_key}
	_recent_transitions.push_back(record)
	if _recent_transitions.size() > 50:
		_recent_transitions.pop_front()
	_record_trace("state.changed", record)
	_event_bus.emit("narrative:stateChanged", record.duplicate(true))
	if to_state is Dictionary:
		await _run_actions(to_state.get("onEnterActions", []), "%s.%s.onEnter" % [graph.id, to_state_id])
		if to_state.get("broadcastOnEnter", false) == true:
			_enqueue_graph_state_entered(graph.id, to_state_id)


func _run_actions(actions: Variant, label: String) -> void:
	if not actions is Array or actions.is_empty():
		return
	_record_trace("actions.start", {"label": label, "payload": {"count": actions.size(), "types": actions.map(func(action: Variant) -> Variant: return action.get("type") if action is Dictionary else null)}})
	_running_actions_depth += 1
	await _action_executor.execute_batch_await(actions)
	_record_trace("actions.end", {"label": label, "payload": {"count": actions.size()}})
	_running_actions_depth = maxi(0, _running_actions_depth - 1)


func _enqueue_graph_state_entered(graph_id: String, state_id: String) -> void:
	if _destroyed:
		return
	var key := state_entered_signal_key(graph_id, state_id)
	var source := {"signal": key, "sourceType": "state", "sourceId": graph_id}
	_record_trace("signal.broadcast", {"graphId": graph_id, "stateId": state_id, "triggerKey": key, "payload": {"source": source}})
	_queue.push_back({"kind": "external", "key": key, "source": source})


func _is_local_endpoint(endpoint: Variant) -> bool:
	return endpoint is String and not endpoint.strip_edges().is_empty()


func _is_scenario_graph(graph: Dictionary) -> bool:
	return graph.get("ownerType") == "scenario" or graph.has("entryState") or (graph.get("exitStates") is Array and not graph.exitStates.is_empty())


func _can_remote_enter_state(graph: Dictionary, state_id: String) -> bool:
	return true if not _is_scenario_graph(graph) else state_id == graph.get("entryState") or (graph.get("exitStates") is Array and graph.exitStates.has(state_id))


func _mark_state_reached(graph_id: String, state_id: String) -> void:
	var states: Dictionary = _reached_states.get(graph_id, {})
	states[state_id] = true
	_reached_states[graph_id] = states


func _reset_states_to_registered_baseline() -> void:
	_active_states.clear()
	_reached_states.clear()
	for graph_id: String in _graphs:
		var initial := str(_graphs[graph_id].initialState)
		_active_states[graph_id] = initial
		_mark_state_reached(graph_id, initial)


func _restore_active_states(states: Variant) -> void:
	if not states is Dictionary:
		return
	for raw_graph_key: Variant in states:
		var raw_graph_id := str(raw_graph_key)
		var graph_id := _migrate_save_graph_id(raw_graph_id)
		var raw_state_id := str(states[raw_graph_key]).strip_edges()
		var state_id := _migrate_save_state_id(graph_id, raw_state_id) if not raw_state_id.is_empty() else ""
		var graph: Variant = _graphs.get(graph_id)
		if not graph is Dictionary:
			_warn_dropped_save_entry(
				"save.active.graphMissing",
				"NarrativeStateManager: save references unknown narrative graph %s%s; dropped active state %s. If the graph was renamed, declare it in narrative_graphs.json migrations.graphs." % [JSON.stringify(raw_graph_id), _migration_suffix(raw_graph_id, graph_id), JSON.stringify(raw_state_id)],
				graph_id,
				state_id
			)
			continue
		if state_id.is_empty() or not graph.states.get(state_id) is Dictionary:
			_warn_dropped_save_entry(
				"save.active.stateMissing",
				"NarrativeStateManager: save references unknown state %s%s in graph %s; graph falls back to initialState %s. If the state was renamed, declare it in narrative_graphs.json migrations.states." % [JSON.stringify(raw_state_id), _migration_suffix(raw_state_id, state_id), JSON.stringify(graph_id), JSON.stringify(str(graph.initialState))],
				graph_id,
				state_id if not state_id.is_empty() else raw_state_id
			)
			continue
		_active_states[graph_id] = state_id


func _restore_reached_states(states: Variant) -> void:
	if states is Dictionary:
		for raw_graph_key: Variant in states:
			if not states[raw_graph_key] is Array:
				continue
			var raw_graph_id := str(raw_graph_key)
			var graph_id := _migrate_save_graph_id(raw_graph_id)
			var graph: Variant = _graphs.get(graph_id)
			if not graph is Dictionary:
				var dropped := PackedStringArray()
				for raw_dropped_state: Variant in states[raw_graph_key]:
					var dropped_state := str(raw_dropped_state).strip_edges()
					if not dropped_state.is_empty():
						dropped.push_back(dropped_state)
				_warn_dropped_save_entry(
					"save.reached.graphMissing",
					"NarrativeStateManager: save references unknown narrative graph %s%s; dropped reached states [%s] (reached-gates re-lock). If the graph was renamed, declare it in narrative_graphs.json migrations.graphs." % [JSON.stringify(raw_graph_id), _migration_suffix(raw_graph_id, graph_id), ", ".join(dropped)],
					graph_id
				)
				continue
			for raw_state_value: Variant in states[raw_graph_key]:
				var raw_state_id := str(raw_state_value).strip_edges()
				if raw_state_id.is_empty():
					continue
				var state_id := _migrate_save_state_id(graph_id, raw_state_id)
				if not graph.states.get(state_id) is Dictionary:
					_warn_dropped_save_entry(
						"save.reached.stateMissing",
						"NarrativeStateManager: save references unknown state %s%s in graph %s; dropped from reached states (its reached-gate re-locks). If the state was renamed, declare it in narrative_graphs.json migrations.states." % [JSON.stringify(raw_state_id), _migration_suffix(raw_state_id, state_id), JSON.stringify(graph_id)],
						graph_id,
						state_id
					)
					continue
				_mark_state_reached(graph_id, state_id)
	for graph_id: String in _active_states:
		_mark_state_reached(graph_id, str(_active_states[graph_id]))
		_mark_state_reached(graph_id, str(_graphs[graph_id].initialState))


func _migrate_save_graph_id(graph_id: String) -> String:
	if _save_migrations is Dictionary and _save_migrations.get("graphs") is Dictionary:
		var mapped: Variant = _save_migrations.graphs.get(graph_id)
		if mapped is String and not mapped.strip_edges().is_empty():
			return mapped.strip_edges()
	return graph_id


func _migrate_save_state_id(graph_id: String, state_id: String) -> String:
	if _save_migrations is Dictionary and _save_migrations.get("states") is Dictionary:
		var graph_states: Variant = _save_migrations.states.get(graph_id)
		if graph_states is Dictionary:
			var mapped: Variant = graph_states.get(state_id)
			if mapped is String and not mapped.strip_edges().is_empty():
				return mapped.strip_edges()
	return state_id


func _migration_suffix(raw_id: String, migrated_id: String) -> String:
	return " (migrated to %s)" % JSON.stringify(migrated_id) if not migrated_id.is_empty() and migrated_id != raw_id else ""


func _warn_dropped_save_entry(code: String, message: String, graph_id: String, state_id: String = "") -> void:
	_record_issue("warning", code, message, graph_id, state_id)


func _owner_key(owner_type: Variant, owner_id: Variant) -> String:
	var type := str(owner_type).strip_edges()
	var id := str(owner_id).strip_edges()
	return "%s:%s" % [type, id] if not type.is_empty() and not id.is_empty() else ""


func _index_graph_owner(graph: Dictionary) -> void:
	var key := _owner_key(graph.get("ownerType", ""), graph.get("ownerId", ""))
	if key.is_empty():
		return
	var ids: Array = _owner_index.get(key, [])
	if not ids.has(graph.id):
		ids.push_back(graph.id)
	_owner_index[key] = ids


func _record_duplicate_owner_bindings() -> void:
	for key: String in _owner_index:
		if _owner_index[key].size() > 1:
			_record_issue("warning", "owner.wrapper.multi", "NarrativeStateManager: owner has multiple wrapper graphs %s" % key)


func _record_primary_owner_ambiguous(owner_type: String, owner_id: String, _graph_ids: Array[String]) -> void:
	var key := "%s:%s" % [owner_type, owner_id]
	if _primary_owner_warning_keys.has(key):
		return
	_primary_owner_warning_keys[key] = true
	_record_issue("warning", "owner.primary.ambiguous", "NarrativeStateManager: primary owner lookup is ambiguous for %s" % key)


func _record_unsupported_endpoint(graph_id: String, transition_id: String) -> void:
	_record_issue("error", "transition.crossGraphEndpoint.unsupported", "NarrativeStateManager: transition uses unsupported cross-graph endpoint data", graph_id, "", transition_id)


func _record_issue(severity: String, code: String, message: String, graph_id: String = "", state_id: String = "", transition_id: String = "") -> void:
	var issue := {"severity": severity, "code": code, "message": message}
	if not graph_id.is_empty(): issue["graphId"] = graph_id
	if not state_id.is_empty(): issue["stateId"] = state_id
	if not transition_id.is_empty(): issue["transitionId"] = transition_id
	_recent_issues.push_back(issue)
	if _recent_issues.size() > 50: _recent_issues.pop_front()
	var trace_patch := {"message": message, "payload": {"severity": severity, "code": code}}
	if not graph_id.is_empty(): trace_patch["graphId"] = graph_id
	if not state_id.is_empty(): trace_patch["stateId"] = state_id
	if not transition_id.is_empty(): trace_patch["transitionId"] = transition_id
	_record_trace("issue", trace_patch)


func _record_trace(type: String, patch: Dictionary = {}) -> void:
	_trace_seq += 1
	var event := {"seq": _trace_seq, "at": Time.get_ticks_msec(), "type": type}
	event.merge(patch, true)
	_recent_trace.push_back(event)
	if _recent_trace.size() > MAX_TRACE_EVENTS: _recent_trace.pop_front()


func _trace_patch_for_trigger(trigger: Dictionary) -> Dictionary:
	if trigger.get("kind") == "external":
		return {"triggerKey": trigger.get("key", ""), "payload": {"kind": "external", "source": trigger.get("source")}}
	if trigger.get("kind") == "reactive":
		return {"graphId": trigger.get("graphId", ""), "transitionId": trigger.get("transitionId", ""), "triggerKey": "__reactive__", "payload": {"kind": "reactive"}}
	return {"graphId": trigger.get("graphId", ""), "stateId": trigger.get("stateId", ""), "triggerKey": "setState:%s:%s" % [trigger.get("graphId", ""), trigger.get("stateId", "")], "payload": {"kind": trigger.get("kind", "")}}
