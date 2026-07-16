class_name RuntimeNarrativeStateManager
extends RuntimeSystem

const RuntimeConditionEvalBridgeScript := preload("res://scripts/runtime/condition_eval_bridge.gd")
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")
const RuntimeNarrativeGraphValidationScript := preload("res://scripts/core/narrative_graph_validation.gd")

const NARRATIVE_GRAPHS_URL := "/assets/data/narrative_graphs.json"
const DEFAULT_DRAFT_SIGNAL := "__draft__"
const MAX_DRAIN_STEPS := 128
const MAX_TRACE_EVENTS := 160

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _action_executor: RuntimeActionExecutor
var _condition_context_factory := Callable()
var _graphs: Dictionary = {}
var _active_states: Dictionary = {}
var _owner_index: Dictionary = {}
var _queue: Array[Dictionary] = []
var _completed_queue_items: Array[Dictionary] = []
var _draining := false
var _drain_promise: RuntimeAsyncLatch = null
var _nested_drain_promises: Dictionary = {}
var _running_actions_depth := 0
var _drain_step_count := 0
var _destroyed := false
var _reactive_eval_scheduled := false
var _on_flag_changed_listener := Callable()
var _recent_transitions: Array[Dictionary] = []
var _reached_states: Dictionary = {}
var _recent_issues: Array[Dictionary] = []
var _save_migrations: Variant = null
var _listened_signal_keys_cache: Variant = null
var _reported_unlistened_signal_keys: Dictionary = {}
var _recent_trace: Array[Dictionary] = []
var _trace_seq := 0
var _primary_owner_warning_keys: Dictionary = {}
var _validation_mode := "off"


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore, action_executor: RuntimeActionExecutor) -> void:
	_event_bus = event_bus
	_flag_store = flag_store
	_action_executor = action_executor
	_validation_mode = _default_runtime_validation_mode()
	_on_flag_changed_listener = Callable(self, "_handle_flag_changed")
	_event_bus.on("flag:changed", _on_flag_changed_listener)


static func state_entered_signal_key(graph_id: Variant, state_id: Variant) -> String:
	var graph_key := str(graph_id).strip_edges() if graph_id != null else ""
	var state_key := str(state_id).strip_edges() if state_id != null else ""
	return "state:%s:%s" % [graph_key, state_key]


static func graph_state_entered_key(graph_id: Variant, state_id: Variant) -> String:
	return state_entered_signal_key(graph_id, state_id)


static func normalize_trigger_key(key: Variant) -> String:
	return str(key).strip_edges() if key != null else ""


static func trigger_keys_equal(left: Variant, right: Variant) -> bool:
	return normalize_trigger_key(left) == normalize_trigger_key(right)


func init(_ctx: Dictionary) -> void:
	return


func update(_dt: float) -> void:
	return


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void:
	_condition_context_factory = factory
	if factory.is_valid() and not _graphs.is_empty():
		_kick_reactive_evaluation()


func set_runtime_validation_mode(mode: String) -> void:
	_validation_mode = mode


func load_from_asset(asset_manager: RuntimeAssetManager, path: String = NARRATIVE_GRAPHS_URL) -> bool:
	var data: Variant = asset_manager.load_json(path)
	if data is Dictionary and _validate_loaded_data(data, path):
		set_save_migrations(data.get("migrations"))
		register_graphs(compile_narrative_graphs(data))
		return true
	var message := "NarrativeStateManager: narrative_graphs.json not found or invalid"
	_record_issue({"severity": "error", "code": "narrative.load.failed", "message": message})
	if _is_dev_runtime():
		return false
	push_warning("NarrativeStateManager: narrative_graphs.json not found or invalid, running empty")
	set_save_migrations(null)
	register_graphs([])
	return false


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
		var graph: Dictionary = raw_graph if raw_graph is Dictionary else {}
		var graph_id := str(graph.get("id", ""))
		var initial_state := str(graph.get("initialState", ""))
		var states: Variant = graph.get("states")
		if graph_id.is_empty() or initial_state.is_empty() or not states is Dictionary or not states.get(initial_state) is Dictionary:
			_record_issue({"severity": "warning", "code": "graph.invalid", "message": "NarrativeStateManager: skipped invalid graph", "graphId": graph_id})
			push_warning("NarrativeStateManager: skipped invalid graph")
			continue
		if _graphs.has(graph_id):
			var duplicate_message := "NarrativeStateManager: duplicate graph id %s (skipped duplicate, kept first)" % JSON.stringify(graph_id)
			_record_issue({"severity": "error", "code": "graph.id.duplicate", "message": duplicate_message, "graphId": graph_id})
			push_warning(duplicate_message)
			continue
		_graphs[graph_id] = graph
		_active_states[graph_id] = initial_state
		_mark_state_reached(graph_id, initial_state)
		_index_graph_owner(graph)
		if graph.get("projectFlags") == true:
			var deprecated_message := "NarrativeStateManager: graph.projectFlags is deprecated and ignored on %s" % graph_id
			_record_issue({"severity": "warning", "code": "projectFlags.deprecated", "message": deprecated_message, "graphId": graph_id})
			push_warning(deprecated_message)
	_record_duplicate_owner_bindings()
	_kick_reactive_evaluation()


func _kick_reactive_evaluation() -> void:
	if _destroyed:
		return
	_evaluate_reactive_triggers()
	if _queue.is_empty():
		return
	if not _draining:
		_start_detached_drain()
	elif _running_actions_depth > 0:
		_drain_nested_queue()


func _handle_flag_changed(_payload: Variant = null) -> void:
	if _destroyed or _graphs.is_empty():
		return
	if not _condition_context_factory.is_valid():
		return
	if _reactive_eval_scheduled:
		return
	_reactive_eval_scheduled = true
	RuntimeMicrotaskQueueScript.queue_microtask(func() -> void:
		_reactive_eval_scheduled = false
		if _destroyed or _graphs.is_empty():
			return
		_kick_reactive_evaluation()
	)


func _start_detached_drain() -> void:
	if _draining or _queue.is_empty():
		return
	var drain := RuntimeAsyncLatch.new()
	_drain_promise = drain
	_drain_queue(drain, true)


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


func _mark_state_reached(graph_id: String, state_id: String) -> void:
	var reached: Dictionary = _reached_states.get(graph_id, {})
	reached[state_id] = true
	_reached_states[graph_id] = reached


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
	var key := _owner_key(owner_type, owner_id)
	var result: Array[String] = []
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
	var result: Dictionary = {}
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


func emit_narrative_signal(event_signal: Dictionary) -> bool:
	var clean := _normalize_signal(event_signal)
	if clean.is_empty():
		_record_trace("signal.ignored", {"message": "invalid signal", "payload": {"raw": event_signal}})
		return true
	if clean.key == DEFAULT_DRAFT_SIGNAL:
		push_warning("NarrativeStateManager: refusing to emit draft signal")
		_record_trace("signal.ignored", {"triggerKey": clean.key, "message": "refusing to emit draft signal", "payload": {"source": clean.source}})
		return true
	_record_trace("signal.received", {"triggerKey": clean.key, "payload": {"source": clean.source}})
	return await _enqueue({"kind": "external", "key": clean.key, "source": clean.source})


func enqueue_trigger_key(key: Variant) -> bool:
	var normalized := str(key).strip_edges() if key != null else ""
	if normalized.is_empty():
		return true
	return await _enqueue({"kind": "external", "key": normalized})


func debug_set_narrative_state(graph_id: String, state_id: String) -> bool:
	var graph_key := graph_id.strip_edges()
	var state_key := state_id.strip_edges()
	if graph_key.is_empty() or state_key.is_empty():
		return true
	var message := "NarrativeStateManager: debugSetNarrativeState bypasses transitions and should only be used for debug/repair: %s.%s" % [graph_key, state_key]
	_record_issue({"severity": "warning", "code": "stateCommand.debugOnly", "message": message, "graphId": graph_key, "stateId": state_key})
	_record_trace("state.command", {"graphId": graph_key, "stateId": state_key, "message": "debugSetNarrativeState requested"})
	push_warning(message)
	return await _enqueue({"kind": "setState", "graphId": graph_key, "stateId": state_key})


func set_narrative_state(graph_id: String, state_id: String) -> bool:
	return await debug_set_narrative_state(graph_id, state_id)


func serialize() -> Dictionary:
	var reached_states: Dictionary = {}
	for graph_id: Variant in _reached_states:
		reached_states[graph_id] = _reached_states[graph_id].keys()
	return {"activeStates": _active_states.duplicate(true), "reachedStates": reached_states}


func deserialize(data: Dictionary) -> void:
	_reset_states_to_registered_baseline()
	restore_active_states(data.get("activeStates", {}))
	_restore_reached_states(data.get("reachedStates"))
	_kick_reactive_evaluation()


func _reset_states_to_registered_baseline() -> void:
	_active_states.clear()
	_reached_states.clear()
	for raw_graph: Variant in _graphs.values():
		var graph: Dictionary = raw_graph
		_active_states[graph.id] = graph.initialState
		_mark_state_reached(graph.id, graph.initialState)


func restore_active_states(states: Dictionary) -> void:
	for raw_graph_key: Variant in states:
		var raw_graph_id := str(raw_graph_key)
		var graph_id := _migrate_save_graph_id(raw_graph_id)
		var raw_state_id := str(states[raw_graph_key]).strip_edges() if states[raw_graph_key] != null else ""
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
			var list_raw: Variant = states[raw_graph_key]
			if not list_raw is Array:
				continue
			var raw_graph_id := str(raw_graph_key)
			var graph_id := _migrate_save_graph_id(raw_graph_id)
			var graph: Variant = _graphs.get(graph_id)
			if not graph is Dictionary:
				var dropped: Array[String] = []
				for raw_state: Variant in list_raw:
					var dropped_state := str(raw_state).strip_edges() if raw_state != null else ""
					if not dropped_state.is_empty():
						dropped.push_back(dropped_state)
				_warn_dropped_save_entry(
					"save.reached.graphMissing",
					"NarrativeStateManager: save references unknown narrative graph %s%s; dropped reached states [%s] (reached-gates re-lock). If the graph was renamed, declare it in narrative_graphs.json migrations.graphs." % [JSON.stringify(raw_graph_id), _migration_suffix(raw_graph_id, graph_id), ", ".join(dropped)],
					graph_id
				)
				continue
			for raw_state: Variant in list_raw:
				var raw_state_id := str(raw_state).strip_edges() if raw_state != null else ""
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
	for graph_id: Variant in _active_states:
		var state_id := str(_active_states[graph_id])
		_mark_state_reached(graph_id, state_id)
		var graph: Variant = _graphs.get(graph_id)
		if graph is Dictionary:
			_mark_state_reached(graph_id, graph.initialState)


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
	var issue := {"severity": "warning", "code": code, "message": message, "graphId": graph_id}
	if not state_id.is_empty():
		issue["stateId"] = state_id
	_record_issue(issue)
	push_warning(message)


func destroy() -> void:
	_destroyed = true
	_reactive_eval_scheduled = false
	_event_bus.off("flag:changed", _on_flag_changed_listener)
	_reject_queued_items("NarrativeStateManager destroyed")
	_resolve_completed_queue_items()
	_graphs.clear()
	_active_states.clear()
	_reached_states.clear()
	_owner_index.clear()
	_nested_drain_promises.clear()
	_save_migrations = null
	_queue.clear()


func debug_snapshot() -> Dictionary:
	var owner_index := _owner_index.duplicate(true)
	var multi_wrapper_owners: Array[Dictionary] = []
	for owner_key: Variant in owner_index:
		var graph_ids: Variant = owner_index[owner_key]
		if graph_ids is Array and graph_ids.size() > 1:
			multi_wrapper_owners.push_back({"ownerKey": owner_key, "graphIds": graph_ids})
	return {
		"activeStates": _active_states.duplicate(true),
		"graphIds": _graphs.keys(),
		"ownerIndex": owner_index,
		"multiWrapperOwners": multi_wrapper_owners,
		"graphs": _graphs.keys(),
		"owners": owner_index,
		"recentTransitions": _recent_transitions.slice(maxi(0, _recent_transitions.size() - 20)),
		"recentIssues": _recent_issues.slice(maxi(0, _recent_issues.size() - 20)),
		"recentTrace": _recent_trace.slice(maxi(0, _recent_trace.size() - 80)),
		"traceLength": _recent_trace.size(),
		"queued": _queue.size(),
	}


func clear_debug_trace() -> void:
	_recent_trace = []


func _owner_key(owner_type: String, owner_id: Variant) -> String:
	var type := owner_type.strip_edges()
	var id := str(owner_id).strip_edges() if owner_id != null else ""
	return "%s:%s" % [type, id] if not type.is_empty() and not id.is_empty() else ""


func _index_graph_owner(graph: Dictionary) -> void:
	var key := _owner_key(str(graph.get("ownerType", "")), graph.get("ownerId"))
	if key.is_empty():
		return
	var ids: Array = _owner_index.get(key, [])
	if not ids.has(graph.id):
		ids.push_back(graph.id)
	_owner_index[key] = ids


func _record_duplicate_owner_bindings() -> void:
	for key: Variant in _owner_index:
		var graph_ids: Array = _owner_index[key]
		if graph_ids.size() <= 1:
			continue
		var message := "NarrativeStateManager: owner has multiple wrapper graphs %s -> %s" % [key, ", ".join(graph_ids)]
		_record_issue({"severity": "warning", "code": "owner.wrapper.multi", "message": message})
		push_warning(message)


func _record_primary_owner_ambiguous(owner_type: String, owner_id: String, graph_ids: Array[String]) -> void:
	var key := "%s:%s" % [owner_type, owner_id]
	if _primary_owner_warning_keys.has(key):
		return
	_primary_owner_warning_keys[key] = true
	var message := "NarrativeStateManager: primary owner lookup is ambiguous for %s; bound wrapper graphs: %s" % [key, ", ".join(graph_ids)]
	_record_issue({"severity": "warning", "code": "owner.primary.ambiguous", "message": message})
	push_warning(message)


func _normalize_signal(event_signal: Dictionary) -> Dictionary:
	var signal_id := str(event_signal.get("signal", "")).strip_edges()
	if signal_id.is_empty():
		push_warning("NarrativeStateManager: invalid signal (missing event id)")
		return {}
	var source_type := str(event_signal.get("sourceType", "")).strip_edges()
	var source_id := str(event_signal.get("sourceId", "")).strip_edges()
	var source := {"signal": signal_id}
	if not source_type.is_empty() and not source_id.is_empty():
		source["sourceType"] = source_type
		source["sourceId"] = source_id
	return {"key": signal_id, "source": source}


func _enqueue(trigger: Dictionary) -> bool:
	if _destroyed:
		return true
	var queued := RuntimeAsyncLatch.new()
	_queue.push_back({"trigger": trigger, "completion": queued})
	_record_trace("trigger.enqueued", _trace_patch_for_trigger(trigger))
	if not _draining:
		_consume_discarded_rejection(queued)
		var drain := RuntimeAsyncLatch.new()
		_drain_promise = drain
		_drain_queue(drain)
		return await drain.wait()
	if _running_actions_depth > 0:
		_drain_nested_queue()
		return await queued.wait()
	var shared := _drain_promise
	if shared != null:
		_consume_discarded_rejection(queued)
		return await shared.wait()
	return await queued.wait()


func _consume_discarded_rejection(promise: RuntimeAsyncLatch) -> void:
	var success := await promise.wait()
	if not success:
		_record_trace("issue", {"message": "discarded queued trigger rejected: %s" % str(promise.get_reason())})


func _drain_queue(completion: RuntimeAsyncLatch, detached: bool = false) -> void:
	if _draining:
		completion.resolve()
		return
	_draining = true
	_drain_step_count = 0
	var success := await _drain_available_queue()
	_resolve_completed_queue_items()
	_resolve_completed_queue_items()
	_draining = false
	if _drain_promise == completion:
		_drain_promise = null
	if not _destroyed and not _queue.is_empty():
		_start_detached_drain()
	if success:
		completion.resolve()
	else:
		var reason := "NarrativeStateManager drain failed"
		completion.reject(reason)
		if detached:
			_record_issue({"severity": "error", "code": "drain.detached.failed", "message": "NarrativeStateManager: detached drain failed: %s" % reason})


func _drain_nested_queue() -> bool:
	var depth := _running_actions_depth
	while _nested_drain_promises.has(depth):
		var inflight: RuntimeAsyncLatch = _nested_drain_promises[depth]
		await inflight.wait()
	if _destroyed or _queue.is_empty():
		return true
	var loop := RuntimeAsyncLatch.new()
	_nested_drain_promises[depth] = loop
	_run_nested_drain_loop(depth, loop)
	return await loop.wait()


func _run_nested_drain_loop(depth: int, completion: RuntimeAsyncLatch) -> void:
	await _drain_available_queue(true)
	if _nested_drain_promises.get(depth) == completion:
		_nested_drain_promises.erase(depth)
	completion.resolve()


func _drain_available_queue(nested: bool = false) -> bool:
	while not _queue.is_empty():
		_drain_step_count += 1
		if _drain_step_count > MAX_DRAIN_STEPS:
			var message := "NarrativeStateManager: drain loop guard tripped (exceeded %s steps; likely oscillating reactive transitions)" % MAX_DRAIN_STEPS
			_record_issue({"severity": "error", "code": "drain.loop.guard", "message": message})
			push_warning(message)
			_reject_queued_items(message)
			_resolve_completed_queue_items()
			break
		var item: Dictionary = _queue.pop_front()
		if not await _process_queue_item(item):
			_reject_queued_items("NarrativeStateManager trigger failed")
			return false
		if _queue.is_empty():
			_resolve_completed_queue_items()
			if nested:
				break
			if not _destroyed:
				_evaluate_reactive_triggers()
	return true


func _resolve_completed_queue_items() -> void:
	var items := _completed_queue_items.duplicate()
	_completed_queue_items.clear()
	for item: Dictionary in items:
		var completion: Variant = item.get("completion")
		if completion is RuntimeAsyncLatch:
			completion.resolve()


func _reject_queued_items(error: Variant) -> void:
	var items := _queue.duplicate()
	_queue.clear()
	for item: Dictionary in items:
		var completion: Variant = item.get("completion")
		if completion is RuntimeAsyncLatch:
			completion.reject(error)


func _process_queue_item(item: Dictionary) -> bool:
	var trigger: Dictionary = item.trigger
	_record_trace("trigger.start", _trace_patch_for_trigger(trigger))
	match str(trigger.get("kind", "")):
		"setState":
			await _apply_state_command(str(trigger.get("graphId", "")), str(trigger.get("stateId", "")))
		"reactive":
			await _process_reactive_trigger(str(trigger.get("graphId", "")), str(trigger.get("transitionId", "")))
		_:
			await _process_trigger(normalize_trigger_key(trigger.get("key")))
	_record_trace("trigger.end", _trace_patch_for_trigger(trigger))
	_completed_queue_items.push_back(item)
	return true


func _process_trigger(trigger_key: String) -> void:
	var migrated_graphs: Dictionary = {}
	var graph_entries: Array[Array] = []
	for graph_id: Variant in _graphs:
		graph_entries.push_back([graph_id, _graphs[graph_id]])
	var matched_graph_ids: Array[String] = []
	for entry: Array in graph_entries:
		var graph_id := str(entry[0])
		var graph: Dictionary = entry[1]
		if migrated_graphs.has(graph_id):
			continue
		var active := str(_active_states.get(graph_id, graph.initialState))
		var selected: Variant = null
		var selected_priority := 0.0
		var transitions: Array = graph.get("transitions", []) if graph.get("transitions") is Array else []
		for raw_transition: Variant in transitions:
			if not raw_transition is Dictionary:
				continue
			var transition: Dictionary = raw_transition
			if not trigger_keys_equal(transition.get("signal"), trigger_key):
				continue
			if not _is_local_endpoint(transition.get("from")) or not _is_local_endpoint(transition.get("to")):
				_record_unsupported_endpoint(graph_id, str(transition.get("id", "")))
				continue
			if transition.from != active or not _conditions_met(transition.get("conditions")):
				continue
			var priority := float(transition.get("priority", 0.0))
			if selected == null or priority > selected_priority:
				selected = transition
				selected_priority = priority
		if not selected is Dictionary:
			continue
		await _apply_transition(graph, selected, trigger_key)
		migrated_graphs[graph_id] = true
		matched_graph_ids.push_back(graph_id)
	if matched_graph_ids.is_empty():
		_report_unlistened_signal(trigger_key)
	_record_trace("signal.processed", {
		"triggerKey": trigger_key,
		"payload": {"matchedGraphIds": matched_graph_ids},
		"message": "matched %s graph(s)" % matched_graph_ids.size() if not matched_graph_ids.is_empty() else "no matching transition",
	})


func _get_listened_signal_keys() -> Dictionary:
	if _listened_signal_keys_cache == null:
		var keys: Dictionary = {}
		for raw_graph: Variant in _graphs.values():
			var graph: Dictionary = raw_graph
			var transitions: Array = graph.get("transitions", []) if graph.get("transitions") is Array else []
			for raw_transition: Variant in transitions:
				if not raw_transition is Dictionary:
					continue
				var trigger: Variant = raw_transition.get("trigger")
				if trigger != null and str(trigger) != "signal":
					continue
				var key := normalize_trigger_key(raw_transition.get("signal"))
				if not key.is_empty():
					keys[key] = true
		_listened_signal_keys_cache = keys
	return _listened_signal_keys_cache


func _report_unlistened_signal(trigger_key: String) -> void:
	var key := normalize_trigger_key(trigger_key)
	if key.is_empty() or key == DEFAULT_DRAFT_SIGNAL:
		return
	if _graphs.is_empty() or _reported_unlistened_signal_keys.has(key) or _get_listened_signal_keys().has(key):
		return
	_reported_unlistened_signal_keys[key] = true
	var message := "NarrativeStateManager: signal %s has no listening transition in any registered graph (emit is a no-op); likely dangling after rename/delete" % JSON.stringify(key)
	_record_issue({"severity": "warning", "code": "signal.unlistened", "message": message})
	RuntimeDevErrorOverlay.report_dev_error(
		"叙事信号 %s 没有任何已注册叙事图的 transition 监听，发射不推动任何状态——疑似信号改名/删除后的悬垂发射端" % JSON.stringify(key),
		"[narrative]"
	)


func _conditions_met(conditions: Variant) -> bool:
	if not conditions is Array or conditions.is_empty():
		return true
	if not _condition_context_factory.is_valid():
		push_warning("NarrativeStateManager: missing condition context; rejecting guarded transition")
		return false
	var context: Variant = _condition_context_factory.call()
	return context is Dictionary and RuntimeConditionEvalBridgeScript.evaluate_condition_expr_list(conditions, context)


func _evaluate_reactive_triggers() -> void:
	for graph_id: Variant in _graphs:
		var graph: Dictionary = _graphs[graph_id]
		var active := str(_active_states.get(graph_id, graph.initialState))
		var selected: Variant = null
		var selected_priority := 0.0
		var transitions: Array = graph.get("transitions", []) if graph.get("transitions") is Array else []
		for raw_transition: Variant in transitions:
			if not raw_transition is Dictionary:
				continue
			var transition: Dictionary = raw_transition
			var trigger: Variant = transition.get("trigger")
			if trigger == null or str(trigger) == "signal":
				continue
			if transition.get("from") != active:
				continue
			if not _is_local_endpoint(transition.get("from")) or not _is_local_endpoint(transition.get("to")):
				_record_unsupported_endpoint(str(graph_id), str(transition.get("id", "")))
				continue
			if not _evaluate_reactive_conditions(transition):
				continue
			var priority := float(transition.get("priority", 0.0))
			if selected == null or priority > selected_priority:
				selected = transition
				selected_priority = priority
		if not selected is Dictionary:
			continue
		_record_trace("reactive.queued", {"graphId": graph_id, "transitionId": selected.id, "triggerKey": "__reactive__"})
		_queue.push_back({
			"trigger": {"kind": "reactive", "graphId": graph_id, "transitionId": selected.id},
			"completion": RuntimeAsyncLatch.new(),
		})


func _evaluate_reactive_conditions(transition: Dictionary) -> bool:
	var conditions: Variant = transition.get("conditions")
	if not conditions is Array or conditions.is_empty():
		return false
	match str(transition.get("trigger", "")):
		"reactive":
			return _conditions_met(conditions)
		"reactiveAll":
			return _conditions_met([{"all": conditions}])
		"reactiveAny":
			return _conditions_met([{"any": conditions}])
	return false


func _process_reactive_trigger(graph_id: String, transition_id: String) -> void:
	var graph: Variant = _graphs.get(graph_id)
	if not graph is Dictionary:
		return
	var transition: Variant = null
	var transitions: Array = graph.get("transitions", []) if graph.get("transitions") is Array else []
	for raw_transition: Variant in transitions:
		if raw_transition is Dictionary and raw_transition.get("id") == transition_id:
			transition = raw_transition
			break
	if graph is Dictionary and transition is Dictionary and transition.get("trigger") != null:
		var active := str(_active_states.get(graph_id, graph.initialState))
		if transition.from != active:
			return
		if _evaluate_reactive_conditions(transition):
			await _apply_transition(graph, transition, "__reactive__")


func _apply_state_command(graph_id: String, state_id: String) -> void:
	var graph: Variant = _graphs.get(graph_id)
	if not graph is Dictionary or not graph.states.get(state_id) is Dictionary:
		var missing_message := "NarrativeStateManager: setState target missing %s.%s" % [graph_id, state_id]
		_record_issue({"severity": "warning", "code": "setState.target.missing", "message": missing_message, "graphId": graph_id, "stateId": state_id})
		_record_trace("state.command", {"graphId": graph_id, "stateId": state_id, "message": "target missing"})
		push_warning(missing_message)
		return
	if not _can_remote_enter_state(graph, state_id):
		var boundary_message := "NarrativeStateManager: setState target violates scenario boundary %s.%s" % [graph_id, state_id]
		_record_issue({"severity": "error", "code": "scenario.boundary.stateCommand", "message": boundary_message, "graphId": graph_id, "stateId": state_id})
		_record_trace("state.command", {"graphId": graph_id, "stateId": state_id, "message": "scenario boundary rejected"})
		push_warning(boundary_message)
		return
	var from := str(_active_states.get(graph_id, graph.initialState))
	_record_trace("state.command", {"graphId": graph_id, "stateId": state_id, "from": from, "to": state_id, "message": "applying debug state command"})
	await _enter_state(graph, from, state_id, "setState:%s:%s" % [graph_id, state_id])


func _apply_transition(graph: Dictionary, transition: Dictionary, trigger_key: String) -> void:
	if not _is_local_endpoint(transition.get("from")) or not _is_local_endpoint(transition.get("to")):
		_record_unsupported_endpoint(graph.id, str(transition.get("id", "")))
		return
	var active_now := str(_active_states.get(graph.id, graph.initialState))
	if transition.from != active_now:
		_record_trace("signal.ignored", {
			"graphId": graph.id,
			"transitionId": transition.get("id", ""),
			"triggerKey": trigger_key,
			"message": "stale transition: from=%s but active=%s" % [transition.from, active_now],
		})
		return
	var from_state_id := str(transition.from)
	var to_state_id := str(transition.to)
	if not graph.states.get(from_state_id) is Dictionary:
		var source_message := "NarrativeStateManager: transition source missing %s.%s" % [graph.id, from_state_id]
		_record_issue({"severity": "warning", "code": "transition.from.missing", "message": source_message, "graphId": graph.id, "stateId": from_state_id, "transitionId": transition.get("id", "")})
		push_warning(source_message)
		return
	if not graph.states.get(to_state_id) is Dictionary:
		var target_message := "NarrativeStateManager: transition target missing %s.%s" % [graph.id, to_state_id]
		_record_issue({"severity": "warning", "code": "transition.target.missing", "message": target_message, "graphId": graph.id, "stateId": to_state_id, "transitionId": transition.get("id", "")})
		push_warning(target_message)
		return
	await _enter_state(graph, from_state_id, to_state_id, trigger_key, str(transition.get("id", "")))


func _enter_state(graph: Dictionary, from_state_id: String, to_state_id: String, trigger_key: String, transition_id: String = "") -> void:
	var from_state: Variant = graph.states.get(from_state_id)
	var to_state: Variant = graph.states.get(to_state_id)
	await _run_actions(from_state.get("onExitActions") if from_state is Dictionary else null, "%s.%s.onExit" % [graph.id, from_state_id])
	_record_trace("transition.applied", {"graphId": graph.id, "transitionId": transition_id, "triggerKey": trigger_key, "from": from_state_id, "to": to_state_id})
	_active_states[graph.id] = to_state_id
	_mark_state_reached(graph.id, to_state_id)
	_recent_transitions.push_back({"graphId": graph.id, "transitionId": transition_id, "from": from_state_id, "to": to_state_id, "triggerKey": trigger_key})
	while _recent_transitions.size() > 50:
		_recent_transitions.pop_front()
	_record_trace("state.changed", {"graphId": graph.id, "transitionId": transition_id, "triggerKey": trigger_key, "from": from_state_id, "to": to_state_id})
	_event_bus.emit("narrative:stateChanged", {"graphId": graph.id, "from": from_state_id, "to": to_state_id, "triggerKey": trigger_key, "transitionId": transition_id})
	await _run_actions(to_state.get("onEnterActions") if to_state is Dictionary else null, "%s.%s.onEnter" % [graph.id, to_state_id])
	if to_state is Dictionary and to_state.get("broadcastOnEnter") == true:
		_enqueue_graph_state_entered(graph.id, to_state_id)


func _enqueue_graph_state_entered(graph_id: String, state_id: String) -> void:
	if _destroyed:
		return
	var key := state_entered_signal_key(graph_id, state_id)
	var source := {"signal": key, "sourceType": "state", "sourceId": graph_id}
	_record_trace("signal.broadcast", {"graphId": graph_id, "stateId": state_id, "triggerKey": key, "payload": {"source": source}})
	_queue.push_back({"trigger": {"kind": "external", "key": key, "source": source}, "completion": RuntimeAsyncLatch.new()})
	if _draining and _running_actions_depth > 0:
		_drain_nested_queue()


func _is_local_endpoint(endpoint: Variant) -> bool:
	return endpoint is String and not endpoint.strip_edges().is_empty()


func _record_unsupported_endpoint(graph_id: String, transition_id: String) -> void:
	var message := "NarrativeStateManager: transition %s.%s uses unsupported cross-graph endpoint data" % [graph_id, transition_id]
	_record_issue({"severity": "error", "code": "transition.crossGraphEndpoint.unsupported", "message": message, "graphId": graph_id, "transitionId": transition_id})
	push_warning(message)


func _run_actions(actions: Variant, label: String) -> void:
	if not actions is Array or actions.is_empty():
		return
	var action_types: Array = actions.map(func(action: Variant) -> Variant: return action.get("type") if action is Dictionary else null)
	_record_trace("actions.start", {"label": label, "payload": {"count": actions.size(), "types": action_types}})
	_running_actions_depth += 1
	var success := await _action_executor.execute_batch_await(actions)
	if success:
		_record_trace("actions.end", {"label": label, "payload": {"count": actions.size()}})
	else:
		push_warning("NarrativeStateManager: lifecycle actions failed at %s" % label)
		_record_trace("actions.failed", {"label": label, "message": "action batch rejected", "payload": {"count": actions.size()}})
	_running_actions_depth = maxi(0, _running_actions_depth - 1)


func _is_scenario_graph(graph: Dictionary) -> bool:
	return graph.get("ownerType") == "scenario" or not str(graph.get("entryState", "")).is_empty() or (graph.get("exitStates") is Array and not graph.exitStates.is_empty())


func _can_remote_enter_state(graph: Dictionary, state_id: String) -> bool:
	if not _is_scenario_graph(graph):
		return true
	return state_id == graph.get("entryState") or (graph.get("exitStates") is Array and graph.exitStates.has(state_id))


func _can_leave_graph_remotely(graph: Dictionary, state_id: String) -> bool:
	if not _is_scenario_graph(graph):
		return true
	return graph.get("exitStates") is Array and graph.exitStates.has(state_id)


func _record_issue(issue: Dictionary) -> void:
	_recent_issues.push_back(issue)
	while _recent_issues.size() > 50:
		_recent_issues.pop_front()
	var patch := {"message": issue.get("message", ""), "payload": {"severity": issue.get("severity"), "code": issue.get("code")}}
	for key in ["graphId", "stateId", "transitionId"]:
		if issue.has(key) and issue[key] != null:
			patch[key] = issue[key]
	_record_trace("issue", patch)


func _record_trace(type: String, patch: Dictionary = {}) -> void:
	_trace_seq += 1
	var event := {"seq": _trace_seq, "at": int(Time.get_unix_time_from_system() * 1000.0), "type": type}
	event.merge(patch, true)
	_recent_trace.push_back(event)
	if _recent_trace.size() > MAX_TRACE_EVENTS:
		_recent_trace = _recent_trace.slice(maxi(0, _recent_trace.size() - MAX_TRACE_EVENTS))


func _trace_patch_for_trigger(trigger: Dictionary) -> Dictionary:
	if trigger.get("kind") == "external":
		return {"triggerKey": trigger.get("key", ""), "payload": {"kind": trigger.get("kind"), "source": trigger.get("source")}}
	if trigger.get("kind") == "setState":
		return {"graphId": trigger.get("graphId", ""), "stateId": trigger.get("stateId", ""), "triggerKey": "setState:%s:%s" % [trigger.get("graphId", ""), trigger.get("stateId", "")], "payload": {"kind": trigger.get("kind")}}
	return {"graphId": trigger.get("graphId", ""), "transitionId": trigger.get("transitionId", ""), "triggerKey": "__reactive__", "payload": {"kind": trigger.get("kind")}}


func _is_dev_runtime() -> bool:
	# Source accesses Vite's import.meta through a local `meta` alias. Vite does
	# not inject `env` on that indirect object, so the effective source value is
	# undefined/false; Godot's engine debug bit is not an equivalent substitute.
	var meta_env: Variant = null
	return meta_env is Dictionary and (bool(meta_env.get("DEV", false)) or meta_env.get("MODE") == "development")


func _default_runtime_validation_mode() -> String:
	var meta_env: Variant = null
	var raw := str(meta_env.get("VITE_NARRATIVE_VALIDATE_RUNTIME", "")).strip_edges().to_lower() if meta_env is Dictionary else ""
	if raw == "off" or raw == "0" or raw == "false":
		return "off"
	if raw == "throw" or raw == "error" or raw == "strict":
		return "throw"
	if raw == "warn" or raw == "1" or raw == "true":
		return "warn"
	return "warn" if _is_dev_runtime() else "off"


func _validate_loaded_data(data: Dictionary, path: String) -> bool:
	if _validation_mode == "off":
		return true
	var issues := RuntimeNarrativeGraphValidationScript.validate_narrative_graph_data(data)
	if issues.is_empty():
		return true
	for issue: Dictionary in issues:
		_record_validation_issue(issue)
	var errors := RuntimeNarrativeGraphValidationScript.blocking_narrative_validation_errors(issues)
	var summary := "NarrativeStateManager: %s validation found %s error(s), %s warning(s)" % [path, errors.size(), issues.size() - errors.size()]
	if not errors.is_empty() and _validation_mode == "throw":
		return false
	push_warning(summary)
	return true


func _record_validation_issue(issue: Dictionary) -> void:
	var message := str(issue.get("message", ""))
	if issue.has("path") and not str(issue.path).is_empty():
		message = "%s (%s)" % [message, issue.path]
	var runtime_issue := {"severity": issue.get("severity", "warning"), "code": issue.get("code", ""), "message": message}
	if issue.has("itemId"):
		runtime_issue["graphId"] = issue.itemId
	_record_issue(runtime_issue)


static func compile_narrative_graphs(data: Variant) -> Array:
	if not data is Dictionary:
		return []
	if data.get("compositions") is Array:
		var result: Array = []
		for raw_composition: Variant in data.compositions:
			if not raw_composition is Dictionary:
				continue
			if _is_narrative_graph(raw_composition.get("mainGraph")):
				result.push_back(raw_composition.mainGraph)
			var elements: Array = raw_composition.get("elements", []) if raw_composition.get("elements") is Array else []
			for raw_element: Variant in elements:
				if not raw_element is Dictionary:
					continue
				if (raw_element.get("kind") == "wrapperGraph" or raw_element.get("kind") == "scenarioSubgraph") and _is_narrative_graph(raw_element.get("graph")):
					result.push_back(raw_element.graph)
		return result
	var graphs: Variant = data.get("graphs")
	if not graphs is Array:
		return []
	return graphs.filter(func(graph: Variant) -> bool: return _is_narrative_graph(graph))


static func _is_narrative_graph(value: Variant) -> bool:
	return value is Dictionary \
		and value.get("id") is String \
		and value.get("initialState") is String \
		and value.get("states") is Dictionary \
		and value.get("transitions") is Array
