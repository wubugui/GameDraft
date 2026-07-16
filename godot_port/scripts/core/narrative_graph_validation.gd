class_name RuntimeNarrativeGraphValidation
extends RefCounted

const RuntimeActionParamManifestScript := preload("res://scripts/runtime/action_param_manifest.gd")

const DEFAULT_NARRATIVE_DRAFT_SIGNAL := "__draft__"
const DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX := "state:"
const VALID_WRAPPER_OWNER_TYPES := {
	"npc": true,
	"hotspot": true,
	"zone": true,
	"quest": true,
	"dialogue": true,
	"minigame": true,
	"cutscene": true,
	"scenario": true,
	"scene": true,
	"system": true,
}
const ELEMENT_KINDS := {
	"wrapperGraph": true,
	"scenarioSubgraph": true,
	"dialogueBlackbox": true,
	"zoneBlackbox": true,
	"minigameBlackbox": true,
	"cutsceneBlackbox": true,
}


static func narrative_state_entered_signal_key(graph_id: Variant, state_id: Variant) -> String:
	var graph_key := str(graph_id).strip_edges() if graph_id != null else ""
	var state_key := str(state_id).strip_edges() if state_id != null else ""
	return "%s%s:%s" % [DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX, graph_key, state_key]


static func parse_narrative_derived_state_signal(id: Variant) -> Variant:
	var raw := str(id).strip_edges() if id != null else ""
	if not raw.begins_with(DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX):
		return null
	var rest := raw.substr(DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX.length())
	var separator := rest.find(":")
	if separator <= 0:
		return null
	var graph_id := rest.substr(0, separator).strip_edges()
	var state_id := rest.substr(separator + 1).strip_edges()
	return {"graphId": graph_id, "stateId": state_id} if not graph_id.is_empty() and not state_id.is_empty() else null


static func is_narrative_derived_state_signal(id: Variant) -> bool:
	return (str(id).strip_edges() if id != null else "").begins_with(DERIVED_NARRATIVE_STATE_SIGNAL_PREFIX)


static func is_reserved_narrative_author_signal_id(id: Variant) -> bool:
	var raw := str(id).strip_edges() if id != null else ""
	return raw.is_empty() or raw == DEFAULT_NARRATIVE_DRAFT_SIGNAL or is_narrative_derived_state_signal(raw)


static func narrative_state_broadcast_on_enter(state: Variant) -> bool:
	return state is Dictionary and state.get("broadcastOnEnter") == true


static func validate_narrative_graph_data(data_raw: Variant, opts: Dictionary = {}) -> Array[Dictionary]:
	var data := _normalize_validation_file(data_raw)
	var issues: Array[Dictionary] = []
	var composition_ids: Dictionary = {}
	var graph_ids: Dictionary = {}
	var graph_index := _build_graph_index(data)
	var known_signals := _collect_known_signals(data)
	var compositions: Array = data.get("compositions", [])
	for composition_index in compositions.size():
		var raw_composition: Variant = compositions[composition_index]
		var composition: Dictionary = raw_composition if raw_composition is Dictionary else {}
		var composition_path := "compositions[%s]" % composition_index
		var composition_id := _clean(composition.get("id"))
		var composition_target_value: Variant = _composition_target(composition_id, "id") if not composition_id.is_empty() else null
		_add_duplicate_issue(issues, composition_ids, composition.get("id"), "%s.id" % composition_path, "composition id", composition_id, composition_target_value)
		var main_graph: Dictionary = composition.get("mainGraph", {}) if composition.get("mainGraph") is Dictionary else {}
		_validate_graph(
			main_graph,
			"%s.mainGraph" % composition_path,
			issues,
			graph_ids,
			graph_index,
			known_signals,
			{"compositionId": composition_id, "graphId": _clean(main_graph.get("id"))},
			"",
			opts
		)
		var elements: Array = composition.get("elements", []) if composition.get("elements") is Array else []
		for element_index in elements.size():
			var raw_element: Variant = elements[element_index]
			var element: Dictionary = raw_element if raw_element is Dictionary else {}
			var path := "%s.elements[%s]" % [composition_path, element_index]
			var element_id := _clean(element.get("id"))
			var element_target_value: Variant = _element_target(composition_id, element_id) if not element_id.is_empty() else null
			if element_id.is_empty():
				_add_issue(issues, "error", "element.id.empty", "%s: element id is required" % path, path, "", element_target_value)
			_validate_id_delimiter(element.get("id"), "%s.id" % path, "element.id.delimiter", issues, str(element.get("id", "")), _with_field(element_target_value, "id"))
			var kind := _clean(element.get("kind"))
			if kind == "wrapperGraph":
				if _clean(element.get("ownerId")).is_empty():
					_add_issue(issues, "error", "wrapper.unbound", "%s: wrapper has no ownerId binding" % element_id, path, element_id, element_target_value)
				var owner_type := _clean(element.get("ownerType"))
				if not owner_type.is_empty() and not VALID_WRAPPER_OWNER_TYPES.has(owner_type):
					_add_issue(issues, "warning", "wrapper.ownerType.unsupported", "%s: wrapper ownerType is not runtime-backed: %s" % [element_id, owner_type], "%s.ownerType" % path, element_id, _with_field(element_target_value, "ownerType"))
				if not element.get("graph") is Dictionary:
					_add_issue(issues, "error", "wrapper.graph.missing", "%s: wrapperGraph requires an inner graph" % element_id, path, element_id, element_target_value)
			if kind == "scenarioSubgraph" and _clean(element.get("refId", element.get("ownerId"))).is_empty():
				_add_issue(issues, "warning", "scenario.id.empty", "%s: scenarioId is empty" % element_id, path, element_id, element_target_value)
			if kind != "wrapperGraph" and kind != "scenarioSubgraph" and _clean(element.get("refId")).is_empty():
				_add_issue(issues, "warning", "blackbox.ref.empty", "%s: blackbox refId is empty" % element_id, path, element_id, _with_field(element_target_value, "refId"))
			if (kind == "wrapperGraph" or kind == "scenarioSubgraph") and element.get("graph") is Dictionary:
				var graph: Dictionary = element.graph
				_validate_graph(
					graph,
					"%s.graph" % path,
					issues,
					graph_ids,
					graph_index,
					known_signals,
					{"compositionId": composition_id, "graphId": _clean(graph.get("id")), "elementId": element_id},
					kind,
					opts
				)
			var meta: Dictionary = element.get("meta", {}) if element.get("meta") is Dictionary else {}
			for key in ["emits", "reads", "commands"]:
				if meta.has(key) and not meta[key] is Array:
					_add_issue(issues, "warning", "element.meta.%s.shape" % key, "%s: meta.%s should be a string array" % [element_id, key], "%s.meta.%s" % [path, key], element_id, _with_field(element_target_value, "meta.%s" % key))
			for graph_id in _string_list(meta.get("reads")):
				if not graph_index.graphs.has(graph_id):
					_add_issue(issues, "warning", "projection.read.dangling", "%s: reads unknown narrative graph %s" % [element_id, graph_id], "%s.meta.reads" % path, element_id, _with_field(element_target_value, "meta.reads"))
			for command in _string_list(meta.get("commands")):
				var command_ref := _parse_state_command_ref(command)
				var target_graph: Variant = graph_index.graphs.get(command_ref.graphId)
				if not target_graph is Dictionary or (not command_ref.stateId.is_empty() and not _states(target_graph).has(command_ref.stateId)):
					_add_issue(issues, "warning", "projection.command.dangling", "%s: commands unknown narrative state %s" % [element_id, command], "%s.meta.commands" % path, element_id, _with_field(element_target_value, "meta.commands"))
	_validate_author_signals(data, issues)
	_validate_owner_bindings(data, issues)
	_validate_state_command_targets(data, graph_index, issues)
	_validate_broadcast_state_signals(data, issues)
	_validate_active_planes(data, issues)
	_validate_save_migrations(data, graph_index, issues)
	return issues


static func blocking_narrative_validation_errors(issues: Array) -> Array[Dictionary]:
	var errors: Array[Dictionary] = []
	for raw_issue: Variant in issues:
		if raw_issue is Dictionary and raw_issue.get("severity") == "error":
			errors.push_back(raw_issue)
	return errors


static func resolve_narrative_endpoint(endpoint: Variant, owner_graph_id: String) -> Dictionary:
	return {"graphId": owner_graph_id, "stateId": endpoint.strip_edges()} if endpoint is String else {"graphId": owner_graph_id, "stateId": ""}


static func narrative_endpoint_label(endpoint: Variant, owner_graph_id: String) -> String:
	var resolved := resolve_narrative_endpoint(endpoint, owner_graph_id)
	return "%s.%s" % [resolved.graphId, resolved.stateId]


static func _normalize_validation_file(data_raw: Variant) -> Dictionary:
	if not data_raw is Dictionary:
		return {"signals": [], "compositions": [], "migrations": null}
	return {
		"signals": data_raw.get("signals", []) if data_raw.get("signals") is Array else [],
		"compositions": data_raw.get("compositions", []) if data_raw.get("compositions") is Array else [],
		"migrations": data_raw.get("migrations"),
	}


static func _compile_graphs(data: Dictionary) -> Array[Dictionary]:
	var out: Array[Dictionary] = []
	for raw_composition: Variant in data.get("compositions", []):
		if not raw_composition is Dictionary:
			continue
		var composition: Dictionary = raw_composition
		if _is_graph(composition.get("mainGraph")):
			out.push_back({"graph": composition.mainGraph, "compositionId": str(composition.get("id", ""))})
		var elements: Array = composition.get("elements", []) if composition.get("elements") is Array else []
		for raw_element: Variant in elements:
			if not raw_element is Dictionary:
				continue
			var element: Dictionary = raw_element
			if (element.get("kind") == "wrapperGraph" or element.get("kind") == "scenarioSubgraph") and _is_graph(element.get("graph")):
				out.push_back({
					"graph": element.graph,
					"compositionId": str(composition.get("id", "")),
					"elementId": element.get("id"),
					"elementKind": element.get("kind"),
				})
	return out


static func _is_graph(graph: Variant) -> bool:
	return graph is Dictionary


static func _build_graph_index(data: Dictionary) -> Dictionary:
	var graphs: Dictionary = {}
	var element_kind_by_graph: Dictionary = {}
	var owners_by_graph_id: Dictionary = {}
	for raw_composition: Variant in data.get("compositions", []):
		if not raw_composition is Dictionary:
			continue
		var composition: Dictionary = raw_composition
		var composition_id := _clean(composition.get("id"))
		var main_graph: Variant = composition.get("mainGraph")
		if main_graph is Dictionary and not _clean(main_graph.get("id")).is_empty():
			var main_id := str(main_graph.id)
			graphs[main_id] = main_graph
			owners_by_graph_id[main_id] = {"compositionId": composition_id, "graphId": main_id}
		var elements: Array = composition.get("elements", []) if composition.get("elements") is Array else []
		for raw_element: Variant in elements:
			if not raw_element is Dictionary:
				continue
			var element: Dictionary = raw_element
			var graph: Variant = element.get("graph")
			if graph is Dictionary and not _clean(graph.get("id")).is_empty():
				var graph_id := str(graph.id)
				graphs[graph_id] = graph
				owners_by_graph_id[graph_id] = {"compositionId": composition_id, "elementId": _clean(element.get("id")), "graphId": graph_id}
				if _is_element_kind(element.get("kind")):
					element_kind_by_graph[graph_id] = element.kind
	return {"graphs": graphs, "elementKindByGraph": element_kind_by_graph, "ownersByGraphId": owners_by_graph_id}


static func _is_element_kind(value: Variant) -> bool:
	return value is String and ELEMENT_KINDS.has(value)


static func _validate_graph(
	graph: Dictionary,
	path: String,
	issues: Array[Dictionary],
	graph_ids: Dictionary,
	graph_index: Dictionary,
	known_signals: Dictionary,
	context: Dictionary,
	element_kind: String = "",
	opts: Dictionary = {}
) -> void:
	var graph_target := _graph_target_from_context(context)
	_add_duplicate_issue(issues, graph_ids, graph.get("id"), "%s.id" % path, "graph id", str(graph.get("id", "")), _with_field(graph_target, "id"))
	_validate_id_delimiter(graph.get("id"), "%s.id" % path, "graph.id.delimiter", issues, str(graph.get("id", "")), _with_field(graph_target, "id"))
	var graph_id := str(graph.get("id", ""))
	var states := _states(graph)
	var initial_state := str(graph.get("initialState", ""))
	if initial_state.is_empty() or not states.has(initial_state):
		_add_issue(issues, "error", "graph.initialState.invalid", "%s: initialState does not exist" % graph_id, "%s.initialState" % path, graph_id, _with_field(graph_target, "initialState"))
	if graph.get("projectFlags") == true:
		_add_issue(issues, "error", "projectFlags.deprecated", "%s: projectFlags is deprecated; use narrative state reads instead of projected flags" % graph_id, "%s.projectFlags" % path, graph_id, _with_field(graph_target, "projectFlags"))
	if element_kind == "scenarioSubgraph" or graph.get("ownerType") == "scenario":
		var entry_state := str(graph.get("entryState", ""))
		if entry_state.is_empty() or not states.has(entry_state):
			_add_issue(issues, "error", "scenario.entryState.invalid", "%s: scenario entryState must point to an existing state" % graph_id, "%s.entryState" % path, graph_id, _with_field(graph_target, "entryState"))
		var exits := _string_list(graph.get("exitStates"))
		if exits.is_empty():
			_add_issue(issues, "error", "scenario.exitStates.empty", "%s: scenario requires at least one exitState" % graph_id, "%s.exitStates" % path, graph_id, _with_field(graph_target, "exitStates"))
		for exit_index in exits.size():
			var state_id: String = exits[exit_index]
			if not states.has(state_id):
				_add_issue(issues, "error", "scenario.exitState.invalid", "%s: scenario exitState does not exist: %s" % [graph_id, state_id], "%s.exitStates[%s]" % [path, exit_index], graph_id, _with_field(graph_target, "exitStates"))
	for state_key: Variant in states:
		var state_id := str(state_key)
		var state: Dictionary = states[state_key] if states[state_key] is Dictionary else {}
		var state_target := _state_target_from_context(context, state_id)
		if _clean(state.get("id")).is_empty():
			_add_issue(issues, "error", "state.id.empty", "%s.%s: state id is empty" % [graph_id, state_id], "%s.states.%s" % [path, state_id], state_id, _with_field(state_target, "id"))
		_validate_id_delimiter(state_id, "%s.states.%s" % [path, state_id], "state.id.delimiter", issues, state_id, _with_field(state_target, "id"))
		if state.has("id") and not _clean(state.id).is_empty() and str(state.id) != state_id:
			_add_issue(issues, "warning", "state.id.key.mismatch", "%s.%s: state.id differs from record key" % [graph_id, state_id], "%s.states.%s.id" % [path, state_id], state_id, _with_field(state_target, "id"))
		var enter_actions: Variant = state.get("onEnterActions")
		if state_id == initial_state and enter_actions is Array and not enter_actions.is_empty():
			_add_issue(issues, "error", "initialState.onEnterActions.unsupported", "%s.%s: initialState onEnterActions will not run at registration/load time" % [graph_id, state_id], "%s.states.%s.onEnterActions" % [path, state_id], state_id, _with_field(state_target, "onEnterActions"))
		if state.has("activePlane"):
			var active_plane: Variant = state.activePlane
			if not active_plane is String or active_plane.strip_edges().is_empty():
				_add_issue(issues, "error", "state.activePlane.invalid", "%s.%s: activePlane must be a non-empty string" % [graph_id, state_id], "%s.states.%s.activePlane" % [path, state_id], state_id, _with_field(state_target, "activePlane"))
			elif opts.has("planeIds") and not _set_has(opts.planeIds, active_plane.strip_edges()):
				_add_issue(issues, "error", "state.activePlane.unknown", "%s.%s: activePlane references unknown plane: %s" % [graph_id, state_id, active_plane.strip_edges()], "%s.states.%s.activePlane" % [path, state_id], state_id, _with_field(state_target, "activePlane"))
		_validate_actions(state.get("onEnterActions"), "%s.states.%s.onEnterActions" % [path, state_id], issues, "%s.%s" % [graph_id, state_id], _with_field(state_target, "onEnterActions"), state.has("onEnterActions"))
		_validate_actions(state.get("onExitActions"), "%s.states.%s.onExitActions" % [path, state_id], issues, "%s.%s" % [graph_id, state_id], _with_field(state_target, "onExitActions"), state.has("onExitActions"))
	var transition_ids: Dictionary = {}
	var transitions: Array = graph.get("transitions", []) if graph.get("transitions") is Array else []
	for transition_index in transitions.size():
		var raw_transition: Variant = transitions[transition_index]
		var transition: Dictionary = raw_transition if raw_transition is Dictionary else {}
		var transition_path := "%s.transitions[%s]" % [path, transition_index]
		var transition_target := _transition_target_from_context(context, _clean(transition.get("id")))
		_add_duplicate_issue(issues, transition_ids, transition.get("id"), "%s.id" % transition_path, "transition id", graph_id, _with_field(transition_target, "id"))
		_validate_id_delimiter(transition.get("id"), "%s.id" % transition_path, "transition.id.delimiter", issues, str(transition.get("id", "")), _with_field(transition_target, "id"))
		if not transition.get("from") is String or not transition.get("to") is String:
			_add_issue(issues, "error", "transition.crossGraphEndpoint.unsupported", "%s.%s: transition endpoints must be graph-local state ids; use signals, broadcasts, or projection metadata for cross-graph relationships" % [graph_id, transition.get("id", "")], transition_path, str(transition.get("id", "")), transition_target)
			continue
		var from_endpoint := resolve_narrative_endpoint(transition.from, graph_id)
		var to_endpoint := resolve_narrative_endpoint(transition.to, graph_id)
		if not states.has(from_endpoint.stateId):
			_add_issue(issues, "error", "transition.from.missing", "%s.%s: from state is missing" % [graph_id, transition.get("id", "")], "%s.from" % transition_path, str(transition.get("id", "")), _with_field(transition_target, "from"))
		if not states.has(to_endpoint.stateId):
			_add_issue(issues, "error", "transition.to.missing", "%s.%s: to state is missing" % [graph_id, transition.get("id", "")], "%s.to" % transition_path, str(transition.get("id", "")), _with_field(transition_target, "to"))
		_validate_transition_signal(graph_id, transition, transition_path, issues, known_signals, _with_field(transition_target, "signal"))
		_validate_reactive_trigger(transition, "%s.trigger" % transition_path, issues, _with_field(transition_target, "trigger"))
		_validate_conditions(transition.get("conditions"), "%s.conditions" % transition_path, issues, "%s.%s" % [graph_id, transition.get("id", "")], graph_index, _with_field(transition_target, "conditions"), transition.has("conditions"))


static func _collect_known_signals(data: Dictionary) -> Dictionary:
	var known: Dictionary = {}
	for raw_signal: Variant in data.get("signals", []):
		if raw_signal is Dictionary:
			var signal_id := _clean(raw_signal.get("id"))
			if not signal_id.is_empty():
				known[signal_id] = true
	for graph_ref: Dictionary in _compile_graphs(data):
		var graph: Dictionary = graph_ref.graph
		for state_key: Variant in _states(graph):
			if narrative_state_broadcast_on_enter(_states(graph)[state_key]):
				known[narrative_state_entered_signal_key(graph.get("id"), state_key)] = true
	return known


static func _validate_transition_signal(owner_graph_id: String, transition: Dictionary, path: String, issues: Array[Dictionary], known_signals: Dictionary, target: Dictionary) -> void:
	var signal_id := _clean(transition.get("signal"))
	if signal_id.is_empty():
		signal_id = DEFAULT_NARRATIVE_DRAFT_SIGNAL
	if signal_id.begins_with("external:") or signal_id.begins_with("stateEntered:"):
		_add_issue(issues, "error", "transition.signal.legacyFormat", "%s.%s: legacy signal format; re-save or migrate to semantic event id" % [owner_graph_id, transition.get("id", "")], "%s.signal" % path, str(transition.get("id", "")), target)
		return
	if signal_id == DEFAULT_NARRATIVE_DRAFT_SIGNAL:
		var trigger := _clean(transition.get("trigger", "signal"))
		if trigger == "reactive" or trigger == "reactiveAll" or trigger == "reactiveAny":
			return
		_add_issue(issues, "warning", "transition.signal.draft", "%s.%s: transition still uses draft signal %s" % [owner_graph_id, transition.get("id", ""), DEFAULT_NARRATIVE_DRAFT_SIGNAL], "%s.signal" % path, "%s.%s" % [owner_graph_id, transition.get("id", "")], target)
		return
	if not known_signals.has(signal_id):
		_add_issue(issues, "warning", "transition.signal.unknown", "%s.%s: signal is not in author catalog or derived state list: %s" % [owner_graph_id, transition.get("id", ""), signal_id], "%s.signal" % path, str(transition.get("id", "")), target)


static func _validate_reactive_trigger(transition: Dictionary, path: String, issues: Array[Dictionary], target: Dictionary) -> void:
	var trigger := _clean(transition.get("trigger", "signal"))
	if not ["signal", "reactive", "reactiveAll", "reactiveAny"].has(trigger):
		_add_issue(issues, "error", "transition.trigger.invalid", "%s: trigger must be 'signal', 'reactive', 'reactiveAll', or 'reactiveAny', got '%s'" % [transition.get("id", ""), trigger], "%s.trigger" % path, str(transition.get("id", "")), target)
		return
	if trigger == "reactive" or trigger == "reactiveAll" or trigger == "reactiveAny":
		var conditions: Variant = transition.get("conditions")
		if not conditions is Array or conditions.is_empty():
			_add_issue(issues, "error", "transition.reactive.noConditions", "%s: reactive transition (trigger=%s) requires at least one condition" % [transition.get("id", ""), trigger], "%s.conditions" % path, str(transition.get("id", "")), target)
		var signal_id := _clean(transition.get("signal"))
		if not signal_id.is_empty() and signal_id != DEFAULT_NARRATIVE_DRAFT_SIGNAL:
			_add_issue(issues, "warning", "transition.reactive.signalIgnored", "%s: reactive transition ignores signal field; signal '%s' will never be used" % [transition.get("id", ""), signal_id], "%s.signal" % path, str(transition.get("id", "")), target)


static func _validate_state_command_targets(data: Dictionary, graph_index: Dictionary, issues: Array[Dictionary]) -> void:
	for graph_ref: Dictionary in _compile_graphs(data):
		var graph: Dictionary = graph_ref.graph
		var graph_id := str(graph.get("id", ""))
		for state_key: Variant in _states(graph):
			var state_id := str(state_key)
			var state: Dictionary = _states(graph)[state_key] if _states(graph)[state_key] is Dictionary else {}
			var state_target := _state_target_from_context({
				"compositionId": graph_ref.get("compositionId", ""),
				"graphId": graph_id,
				"elementId": graph_ref.get("elementId", ""),
			}, state_id)
			for list_name in ["onEnterActions", "onExitActions"]:
				var actions: Array = state.get(list_name, []) if state.get(list_name) is Array else []
				for action_index in actions.size():
					var raw_action: Variant = actions[action_index]
					if not raw_action is Dictionary or raw_action.get("type") != "setNarrativeState":
						continue
					_add_issue(
						issues,
						"error",
						"stateCommand.unsafeInContent",
						"%s.%s: setNarrativeState bypasses transition conditions and should only be used for debug/repair" % [graph_id, state_id],
						"%s.%s.%s[%s]" % [graph_id, state_id, list_name, action_index],
						"%s.%s" % [graph_id, state_id],
						_with_field(state_target, list_name)
					)
					var params: Dictionary = raw_action.get("params", {}) if raw_action.get("params") is Dictionary else {}
					var target_graph_id := _clean(params.get("graphId"))
					var target_state_id := _clean(params.get("stateId"))
					var target_graph: Variant = graph_index.graphs.get(target_graph_id)
					if not target_graph is Dictionary or not _states(target_graph).has(target_state_id):
						_add_issue(issues, "error", "stateCommand.target.missing", "%s.%s: setNarrativeState target does not exist: %s.%s" % [graph_id, state_id, target_graph_id, target_state_id], "%s.%s.%s[%s]" % [graph_id, state_id, list_name, action_index], "%s.%s" % [graph_id, state_id], _with_field(state_target, list_name))
						continue
					var target_kind: Variant = graph_index.elementKindByGraph.get(target_graph_id)
					var exits := _string_list(target_graph.get("exitStates"))
					if (target_kind == "scenarioSubgraph" or target_graph.get("ownerType") == "scenario") and target_state_id != str(target_graph.get("entryState", "")) and not exits.has(target_state_id):
						_add_issue(issues, "error", "stateCommand.scenario.internal", "%s.%s: setNarrativeState targets an internal scenario state: %s.%s" % [graph_id, state_id, target_graph_id, target_state_id], "%s.%s.%s[%s]" % [graph_id, state_id, list_name, action_index], "%s.%s" % [graph_id, state_id], _with_field(state_target, list_name))


static func _validate_owner_bindings(data: Dictionary, issues: Array[Dictionary]) -> void:
	var by_owner: Dictionary = {}
	for graph_ref: Dictionary in _compile_graphs(data):
		if graph_ref.get("elementKind") != "wrapperGraph":
			continue
		var graph: Dictionary = graph_ref.graph
		var owner_type := _clean(graph.get("ownerType"))
		var owner_id := _clean(graph.get("ownerId"))
		var graph_id := _clean(graph.get("id"))
		if owner_type.is_empty() or owner_id.is_empty() or graph_id.is_empty():
			continue
		var key := "%s:%s" % [owner_type, owner_id]
		var entries: Array = by_owner.get(key, [])
		entries.push_back({"graphId": graph_id, "category": _clean(graph.get("category"))})
		by_owner[key] = entries
	for key: Variant in by_owner:
		var graphs: Array = by_owner[key]
		if graphs.size() <= 1:
			continue
		var graph_ids: Array[String] = []
		for entry: Dictionary in graphs:
			graph_ids.push_back(entry.graphId)
		_add_issue(issues, "warning", "owner.wrapper.multi", "%s: multiple wrapper graphs share the same owner binding (%s)" % [key, ", ".join(graph_ids)], "", str(key))
		var missing_category_ids: Array[String] = []
		var category_map: Dictionary = {}
		for entry: Dictionary in graphs:
			if str(entry.category).is_empty():
				missing_category_ids.push_back(entry.graphId)
			else:
				var ids: Array = category_map.get(entry.category, [])
				ids.push_back(entry.graphId)
				category_map[entry.category] = ids
		if not missing_category_ids.is_empty():
			_add_issue(issues, "warning", "owner.wrapper.category.missing", "%s: multiple wrappers should set category for clarity (missing on: %s)" % [key, ", ".join(missing_category_ids)], "", str(key))
		for category: Variant in category_map:
			var ids: Array = category_map[category]
			if ids.size() > 1:
				_add_issue(issues, "warning", "owner.wrapper.category.duplicate", "%s: wrapper category %s is used by multiple wrappers (%s)" % [key, JSON.stringify(str(category)), ", ".join(ids)], "", str(key))


static func _validate_broadcast_state_signals(data: Dictionary, issues: Array[Dictionary]) -> void:
	var listeners := _collect_listener_refs(data)
	var graph_by_id: Dictionary = {}
	var owner_by_graph_id: Dictionary = {}
	for graph_ref: Dictionary in _compile_graphs(data):
		var graph: Dictionary = graph_ref.graph
		var graph_id := str(graph.get("id", ""))
		if not graph_id.is_empty():
			graph_by_id[graph_id] = graph
			owner_by_graph_id[graph_id] = {
				"compositionId": graph_ref.get("compositionId", ""),
				"elementId": graph_ref.get("elementId", ""),
				"graphId": graph_id,
			}
	for signal_id: Variant in listeners:
		var parsed: Variant = parse_narrative_derived_state_signal(signal_id)
		if not parsed is Dictionary:
			continue
		var source_graph: Variant = graph_by_id.get(parsed.graphId)
		var state: Variant = _states(source_graph).get(parsed.stateId) if source_graph is Dictionary else null
		var state_path := "%s.%s" % [parsed.graphId, parsed.stateId]
		var references: Array = listeners[signal_id]
		if not state is Dictionary:
			for reference: Dictionary in references:
				var owner: Variant = owner_by_graph_id.get(reference.graphId)
				_add_issue(issues, "error", "state.broadcast.sourceMissing", "%s.%s: derived signal %s references missing state" % [reference.graphId, reference.transitionId, signal_id], "%s.transitions" % reference.graphId, reference.transitionId, _transition_target_from_context(owner, reference.transitionId) if owner is Dictionary else null)
			continue
		if not narrative_state_broadcast_on_enter(state):
			for reference: Dictionary in references:
				var owner: Variant = owner_by_graph_id.get(reference.graphId)
				_add_issue(issues, "error", "state.broadcast.missing", "%s.%s: %s requires %s to enable broadcastOnEnter" % [reference.graphId, reference.transitionId, signal_id, state_path], "%s.states.%s.broadcastOnEnter" % [parsed.graphId, parsed.stateId], reference.transitionId, _transition_target_from_context(owner, reference.transitionId) if owner is Dictionary else null)
	for graph_ref: Dictionary in _compile_graphs(data):
		var graph: Dictionary = graph_ref.graph
		var graph_id := str(graph.get("id", ""))
		for state_key: Variant in _states(graph):
			var state_id := str(state_key)
			if not narrative_state_broadcast_on_enter(_states(graph)[state_key]):
				continue
			var signal_id := narrative_state_entered_signal_key(graph_id, state_id)
			var references: Array = listeners.get(signal_id, [])
			if references.is_empty():
				_add_issue(issues, "warning", "state.broadcast.unused", "%s.%s: broadcastOnEnter is enabled but no transition listens to %s" % [graph_id, state_id, signal_id], "%s.states.%s.broadcastOnEnter" % [graph_id, state_id], state_id, _state_target_from_context({"compositionId": graph_ref.get("compositionId", ""), "elementId": graph_ref.get("elementId", ""), "graphId": graph_id}, state_id, "broadcastOnEnter"))


static func _validate_active_planes(data: Dictionary, issues: Array[Dictionary]) -> void:
	var declarations: Array[Dictionary] = []
	for graph_ref: Dictionary in _compile_graphs(data):
		var graph: Dictionary = graph_ref.graph
		var graph_id := _clean(graph.get("id"))
		if graph_id.is_empty():
			continue
		for state_key: Variant in _states(graph):
			var state: Variant = _states(graph)[state_key]
			var plane_id := _clean(state.get("activePlane")) if state is Dictionary and state.get("activePlane") is String else ""
			if not plane_id.is_empty():
				declarations.push_back({
					"ctx": {"compositionId": graph_ref.get("compositionId", ""), "elementId": graph_ref.get("elementId", ""), "graphId": graph_id},
					"stateId": str(state_key),
					"planeId": plane_id,
				})
	var graphs_by_plane: Dictionary = {}
	for declaration: Dictionary in declarations:
		var graph_set: Dictionary = graphs_by_plane.get(declaration.planeId, {})
		graph_set[declaration.ctx.graphId] = true
		graphs_by_plane[declaration.planeId] = graph_set
	if graphs_by_plane.size() <= 1:
		return
	var plane_ids := graphs_by_plane.keys()
	plane_ids.sort()
	var detail_parts: Array[String] = []
	for plane_key: Variant in plane_ids:
		var graph_ids: Array = graphs_by_plane[plane_key].keys()
		graph_ids.sort()
		detail_parts.push_back("%s ← %s" % [plane_key, ", ".join(graph_ids)])
	var detail := "；".join(detail_parts)
	for declaration: Dictionary in declarations:
		_add_issue(
			issues,
			"warning",
			"plane.activePlane.multiPlane",
			"%s.%s 点名位面「%s」，而全项目点名了多个不同位面（%s）；若这些图可能同时处于点名状态，运行时按后进者胜——请确认互斥。（同一位面被多张图点名完全合法，不在此列）" % [declaration.ctx.graphId, declaration.stateId, declaration.planeId, detail],
			"%s.states.%s.activePlane" % [declaration.ctx.graphId, declaration.stateId],
			declaration.stateId,
			_state_target_from_context(declaration.ctx, declaration.stateId, "activePlane")
		)


static func _validate_save_migrations(data: Dictionary, graph_index: Dictionary, issues: Array[Dictionary]) -> void:
	var raw: Variant = data.get("migrations")
	if raw == null:
		return
	if not _is_plain_record(raw):
		_add_issue(issues, "warning", "migrations.shape", "migrations must be an object: { graphs?: { oldGraphId: newGraphId }, states?: { graphId: { oldStateId: newStateId } } }", "migrations")
		return
	var graphs_map: Variant = raw.get("graphs")
	if raw.has("graphs") and not _is_plain_record(graphs_map):
		_add_issue(issues, "warning", "migrations.graphs.shape", "migrations.graphs must map old graph id -> new graph id", "migrations.graphs")
	elif graphs_map is Dictionary:
		for old_key: Variant in graphs_map:
			var old_id := str(old_key)
			var path := "migrations.graphs.%s" % old_id
			var new_id_raw: Variant = graphs_map[old_key]
			var new_id: String = new_id_raw.strip_edges() if new_id_raw is String else ""
			if new_id.is_empty():
				_add_issue(issues, "warning", "migrations.graphs.value.shape", "%s: mapping target must be a non-empty graph id string" % path, path)
				continue
			if not graph_index.graphs.has(new_id):
				_add_issue(issues, "warning", "migrations.graph.target.missing", "%s: maps to unknown narrative graph %s" % [path, JSON.stringify(new_id)], path)
			if graph_index.graphs.has(old_id):
				_add_issue(issues, "warning", "migrations.graph.source.stillExists", "%s: source graph %s still exists; saved entries for it will be redirected to %s" % [path, JSON.stringify(old_id), JSON.stringify(new_id)], path)
	var states_map: Variant = raw.get("states")
	if raw.has("states") and not _is_plain_record(states_map):
		_add_issue(issues, "warning", "migrations.states.shape", "migrations.states must map graphId -> { old state id: new state id }", "migrations.states")
	elif states_map is Dictionary:
		for graph_key: Variant in states_map:
			var graph_id := str(graph_key)
			var base_path := "migrations.states.%s" % graph_id
			var graph: Variant = graph_index.graphs.get(graph_id)
			if not graph is Dictionary:
				_add_issue(issues, "warning", "migrations.states.graph.missing", "%s: unknown narrative graph %s (state-rename keys must use the current, post-rename graph id)" % [base_path, JSON.stringify(graph_id)], base_path)
				continue
			var renames_raw: Variant = states_map[graph_key]
			if not _is_plain_record(renames_raw):
				_add_issue(issues, "warning", "migrations.states.value.shape", "%s: must map old state id -> new state id" % base_path, base_path)
				continue
			for old_state_key: Variant in renames_raw:
				var old_state := str(old_state_key)
				var path := "%s.%s" % [base_path, old_state]
				var new_state_raw: Variant = renames_raw[old_state_key]
				var new_state: String = new_state_raw.strip_edges() if new_state_raw is String else ""
				if new_state.is_empty():
					_add_issue(issues, "warning", "migrations.state.value.shape", "%s: mapping target must be a non-empty state id string" % path, path)
					continue
				if not _states(graph).has(new_state):
					_add_issue(issues, "warning", "migrations.state.target.missing", "%s: maps to unknown state %s in graph %s" % [path, JSON.stringify(new_state), JSON.stringify(graph_id)], path)
				if _states(graph).has(old_state):
					_add_issue(issues, "warning", "migrations.state.source.stillExists", "%s: source state %s still exists in graph %s; saved entries for it will be redirected to %s" % [path, JSON.stringify(old_state), JSON.stringify(graph_id), JSON.stringify(new_state)], path)


static func _is_plain_record(value: Variant) -> bool:
	return value is Dictionary


static func _collect_listener_refs(data: Dictionary) -> Dictionary:
	var map: Dictionary = {}
	for graph_ref: Dictionary in _compile_graphs(data):
		var graph: Dictionary = graph_ref.graph
		var transitions: Array = graph.get("transitions", []) if graph.get("transitions") is Array else []
		for raw_transition: Variant in transitions:
			if not raw_transition is Dictionary:
				continue
			var signal_id := _clean(raw_transition.get("signal"))
			if signal_id.is_empty():
				continue
			var list: Array = map.get(signal_id, [])
			list.push_back({"graphId": str(graph.get("id", "")), "transitionId": str(raw_transition.get("id", ""))})
			map[signal_id] = list
	return map


static func _validate_author_signals(data: Dictionary, issues: Array[Dictionary]) -> void:
	var seen: Dictionary = {}
	var signals: Array = data.get("signals", []) if data.get("signals") is Array else []
	for signal_index in signals.size():
		var raw_row: Variant = signals[signal_index]
		var row: Dictionary = raw_row if raw_row is Dictionary else {}
		var id := _clean(row.get("id"))
		var path := "signals[%s].id" % signal_index
		var target: Variant = _signal_target(id, "id") if not id.is_empty() else null
		if id.is_empty():
			_add_issue(issues, "error", "signal.id.empty", "author signal id is required", path)
			continue
		if seen.has(id):
			_add_issue(issues, "error", "signal.id.duplicate", "duplicate author signal id: %s" % id, path, id, target)
		seen[id] = true
		if is_reserved_narrative_author_signal_id(id):
			_add_issue(issues, "error", "signal.id.reserved", "author signal id is reserved: %s" % id, path, id, target)


static func _validate_actions(actions: Variant, path: String, issues: Array[Dictionary], owner: String, target: Variant = null, is_defined: bool = true) -> void:
	if not is_defined:
		return
	if not actions is Array:
		_add_issue(issues, "error", "actions.shape", "%s: actions must be an array" % owner, path, owner, target)
		return
	for action_index in actions.size():
		var action: Variant = actions[action_index]
		if not action is Dictionary or _clean(action.get("type")).is_empty():
			_add_issue(issues, "error", "action.shape", "%s: action %s is missing type" % [owner, action_index + 1], "%s[%s]" % [path, action_index], owner, target)
			continue
		_validate_action_def(action, "%s[%s]" % [path, action_index], issues, owner, target)


static func _validate_conditions(conditions: Variant, path: String, issues: Array[Dictionary], owner: String, graph_index: Dictionary, target: Variant = null, is_defined: bool = true) -> void:
	if not is_defined:
		return
	if not conditions is Array:
		_add_issue(issues, "error", "conditions.shape", "%s: conditions should be an array" % owner, path, owner, target)
		return
	for condition_index in conditions.size():
		_validate_condition_expr(conditions[condition_index], "%s[%s]" % [path, condition_index], issues, owner, graph_index, target)


static func _validate_condition_expr(expr: Variant, path: String, issues: Array[Dictionary], owner: String, graph_index: Dictionary, target: Variant = null) -> bool:
	if not expr is Dictionary:
		_add_issue(issues, "error", "condition.shape", "%s: condition has an unknown shape" % owner, path, owner, target)
		return false
	if expr.get("all") is Array:
		var all_valid := true
		for index in expr.all.size():
			if not _validate_condition_expr(expr.all[index], "%s.all[%s]" % [path, index], issues, owner, graph_index, target):
				all_valid = false
		return all_valid
	if expr.get("any") is Array:
		var any_valid := true
		for index in expr.any.size():
			if not _validate_condition_expr(expr.any[index], "%s.any[%s]" % [path, index], issues, owner, graph_index, target):
				any_valid = false
		return any_valid
	if expr.has("not"):
		return _validate_condition_expr(expr.not, "%s.not" % path, issues, owner, graph_index, target)
	if expr.get("narrative") is String:
		var graph_id: String = expr.narrative.strip_edges()
		var state_id: String = expr.state.strip_edges() if expr.get("state") is String else ""
		if state_id.is_empty():
			_add_issue(issues, "error", "condition.shape", "%s: narrative condition requires state" % owner, path, owner, target)
			return false
		if graph_id.begins_with("@"):
			return true
		var graph: Variant = graph_index.graphs.get(graph_id)
		if not graph is Dictionary:
			_add_issue(issues, "error", "condition.narrative.graphMissing", "%s: narrative graph does not exist: %s" % [owner, graph_id], "%s.narrative" % path, owner, target)
			return false
		if not _states(graph).has(state_id):
			_add_issue(issues, "error", "condition.narrative.stateMissing", "%s: narrative state does not exist: %s.%s" % [owner, graph_id, state_id], "%s.state" % path, owner, target)
			return false
		return true
	if expr.get("flag") is String:
		return true
	if expr.get("quest") is String:
		return expr.get("questStatus") is String or expr.get("status") is String
	if expr.get("scenario") is String:
		return expr.get("phase") is String and expr.get("status") is String
	if expr.get("scenarioLine") is String:
		return expr.get("lineStatus") is String
	if expr.get("plane") is String:
		if expr.plane.strip_edges().is_empty():
			_add_issue(issues, "error", "condition.shape", "%s: plane condition requires a non-empty id" % owner, path, owner, target)
			return false
		return true
	_add_issue(issues, "error", "condition.shape", "%s: condition has an unknown shape" % owner, path, owner, target)
	return false


static func _validate_action_def(action: Dictionary, path: String, issues: Array[Dictionary], owner: String, target: Variant = null) -> void:
	var type := _clean(action.get("type"))
	var params: Dictionary = action.get("params", {}) if action.get("params") is Dictionary else {}
	var manifest: Variant = RuntimeActionParamManifestScript.get_action_param_manifest(type)
	if not manifest is Dictionary:
		_add_issue(issues, "error", "action.type.unknown", "%s: unknown action type %s" % [owner, type], "%s.type" % path, owner, target)
		return
	for name: Variant in manifest.get("required", []):
		var value: Variant = params.get(name)
		if not params.has(name) or value == null:
			_add_issue(issues, "error", "action.param.missing", "%s: %s missing params.%s" % [owner, type, name], "%s.params.%s" % [path, name], owner, target)
			continue
		if manifest.get("nonEmpty", []) is Array and manifest.get("nonEmpty", []).has(name) and value is String and value.strip_edges().is_empty():
			_add_issue(issues, "error", "action.param.missing", "%s: %s params.%s is empty" % [owner, type, name], "%s.params.%s" % [path, name], owner, target)
	if type == "runActions" or type == "addDelayedEvent":
		_validate_actions(params.get("actions"), "%s.params.actions" % path, issues, owner, target, params.has("actions"))
	elif type == "enableRuleOffers":
		if params.has("slots") and not params.slots is Array:
			_add_issue(issues, "error", "action.container.shape", "%s: enableRuleOffers params.slots must be an array" % owner, "%s.params.slots" % path, owner, target)
		var slots: Array = params.get("slots", []) if params.get("slots") is Array else []
		for slot_index in slots.size():
			var slot: Variant = slots[slot_index]
			if slot is Dictionary:
				_validate_actions(slot.get("resultActions"), "%s.params.slots[%s].resultActions" % [path, slot_index], issues, owner, target, slot.has("resultActions"))
	elif type == "chooseAction":
		if params.has("options") and not params.options is Array:
			_add_issue(issues, "error", "action.container.shape", "%s: chooseAction params.options must be an array" % owner, "%s.params.options" % path, owner, target)
		var options: Array = params.get("options", []) if params.get("options") is Array else []
		for option_index in options.size():
			var option: Variant = options[option_index]
			if option is Dictionary:
				_validate_actions(option.get("actions"), "%s.params.options[%s].actions" % [path, option_index], issues, owner, target, option.has("actions"))
	elif type == "randomBranch":
		_validate_actions(params.get("aboveActions"), "%s.params.aboveActions" % path, issues, owner, target, params.has("aboveActions"))
		_validate_actions(params.get("belowActions"), "%s.params.belowActions" % path, issues, owner, target, params.has("belowActions"))


static func _add_duplicate_issue(issues: Array[Dictionary], seen: Dictionary, id: Variant, path: String, label: String, item_id: String = "", target: Variant = null) -> void:
	var clean := _clean(id)
	if clean.is_empty():
		_add_issue(issues, "error", "%s.empty" % label, "%s is required" % label, path, item_id, target)
		return
	if seen.has(clean):
		_add_issue(issues, "error", "%s.duplicate" % label, "duplicate %s: %s" % [label, clean], path, item_id if not item_id.is_empty() else clean, target)
	seen[clean] = true


static func _add_issue(issues: Array[Dictionary], severity: String, code: String, message: String, path: String = "", item_id: String = "", target: Variant = null) -> void:
	var issue := {"severity": severity, "code": code, "message": message}
	if not path.is_empty():
		issue["path"] = path
	if not item_id.is_empty():
		issue["itemId"] = item_id
	if target is Dictionary:
		issue["target"] = target
	issues.push_back(issue)


static func _validate_id_delimiter(value: Variant, path: String, code: String, issues: Array[Dictionary], item_id: String = "", target: Variant = null) -> void:
	var id := str(value) if value != null else ""
	if id.contains(":") or id.contains("|"):
		_add_issue(issues, "error", code, "%s: id cannot contain \":\" or \"|\"" % id, path, item_id, target)


static func _composition_target(composition_id: String, field: String = "") -> Dictionary:
	return _compact_target({"kind": "composition", "compositionId": composition_id, "field": field})


static func _graph_target_from_context(context: Dictionary, field: String = "") -> Dictionary:
	return _compact_target({
		"kind": "graph",
		"compositionId": context.get("compositionId"),
		"graphId": context.get("graphId"),
		"elementId": context.get("elementId"),
		"field": field,
	})


static func _element_target(composition_id: String, element_id: String, field: String = "") -> Dictionary:
	return _compact_target({"kind": "element", "compositionId": composition_id, "elementId": element_id, "field": field})


static func _state_target_from_context(context: Dictionary, state_id: String, field: String = "") -> Dictionary:
	return _compact_target({
		"kind": "state",
		"compositionId": context.get("compositionId"),
		"graphId": context.get("graphId"),
		"elementId": context.get("elementId"),
		"stateId": state_id,
		"field": field,
	})


static func _transition_target_from_context(context: Dictionary, transition_id: String, field: String = "") -> Dictionary:
	return _compact_target({
		"kind": "transition",
		"compositionId": context.get("compositionId"),
		"graphId": context.get("graphId"),
		"elementId": context.get("elementId"),
		"transitionId": transition_id,
		"field": field,
	})


static func _signal_target(signal_id: String, field: String = "") -> Dictionary:
	return _compact_target({"kind": "signal", "signalId": signal_id, "field": field})


static func _compact_target(target: Dictionary) -> Dictionary:
	var compact: Dictionary = {}
	for key: Variant in target:
		var value: Variant = target[key]
		if value != null and value != "":
			compact[key] = value
	return compact


static func _string_list(value: Variant) -> Array[String]:
	var result: Array[String] = []
	if not value is Array:
		return result
	for raw_item: Variant in value:
		var item := _clean(raw_item)
		if not item.is_empty():
			result.push_back(item)
	return result


static func _parse_state_command_ref(raw: String) -> Dictionary:
	var value := raw.strip_edges()
	var separator := value.find(".")
	if separator > 0 and separator < value.length() - 1:
		return {"graphId": value.substr(0, separator), "stateId": value.substr(separator + 1)}
	separator = value.find(":")
	if separator > 0 and separator < value.length() - 1:
		return {"graphId": value.substr(0, separator), "stateId": value.substr(separator + 1)}
	return {"graphId": value, "stateId": ""}


static func _with_field(target: Variant, field: String) -> Variant:
	if not target is Dictionary:
		return null
	var result: Dictionary = target.duplicate(true)
	result["field"] = field
	return _compact_target(result)


static func _clean(value: Variant) -> String:
	return str(value).strip_edges() if value != null else ""


static func _states(graph: Variant) -> Dictionary:
	return graph.get("states", {}) if graph is Dictionary and graph.get("states") is Dictionary else {}


static func _set_has(set_value: Variant, key: String) -> bool:
	if set_value is Dictionary:
		return set_value.has(key)
	if set_value is Array:
		return set_value.has(key)
	if set_value is PackedStringArray:
		return set_value.has(key)
	return false
