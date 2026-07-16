extends SceneTree

const REAL_CODE_COUNTS := {
	"transition.signal.draft": 6,
	"wrapper.ownerType.unsupported": 20,
	"state.broadcast.unused": 34,
}

const MIGRATION_CODES := [
	"migrations.graph.target.missing",
	"migrations.graph.source.stillExists",
	"migrations.state.target.missing",
	"migrations.state.source.stillExists",
	"migrations.states.graph.missing",
]

const COMPLEX_CODES := [
	"state.id.key.mismatch",
	"initialState.onEnterActions.unsupported",
	"state.activePlane.invalid",
	"action.param.missing",
	"action.param.missing",
	"transition.to.missing",
	"transition.trigger.invalid",
	"condition.narrative.graphMissing",
	"transition id.duplicate",
	"transition.crossGraphEndpoint.unsupported",
	"signal.id.empty",
	"signal.id.reserved",
	"signal.id.duplicate",
	"state.broadcast.sourceMissing",
	"state.broadcast.unused",
]


func _init() -> void:
	assert(RuntimeNarrativeGraphValidation.narrative_state_entered_signal_key(" g ", " s ") == "state:g:s")
	assert(RuntimeNarrativeGraphValidation.parse_narrative_derived_state_signal(" state:g:s ") == {"graphId": "g", "stateId": "s"})
	assert(RuntimeNarrativeGraphValidation.parse_narrative_derived_state_signal("state:g") == null)
	assert(RuntimeNarrativeGraphValidation.is_narrative_derived_state_signal(" state:g:s"))
	assert(RuntimeNarrativeGraphValidation.is_reserved_narrative_author_signal_id("__draft__"))
	assert(RuntimeNarrativeGraphValidation.narrative_state_broadcast_on_enter({"broadcastOnEnter": true}))
	assert(RuntimeNarrativeGraphValidation.resolve_narrative_endpoint(" a ", "g") == {"graphId": "g", "stateId": "a"})
	assert(RuntimeNarrativeGraphValidation.narrative_endpoint_label(" a ", "g") == "g.a")

	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var real: Variant = assets.load_json("/assets/data/narrative_graphs.json")
	var real_issues := RuntimeNarrativeGraphValidation.validate_narrative_graph_data(real)
	assert(_code_counts(real_issues) == REAL_CODE_COUNTS, "real codes changed: %s" % [_codes(real_issues)])
	assert(RuntimeNarrativeGraphValidation.blocking_narrative_validation_errors(real_issues).is_empty())

	var migration := {
		"signals": [],
		"compositions": [{"id": "c", "mainGraph": {"id": "g", "ownerType": "flow", "initialState": "a", "states": {"a": {"id": "a"}}, "transitions": []}}],
		"migrations": {"graphs": {"old": "nope", "g": "g"}, "states": {"g": {"gone": "nope2", "a": "a"}, "ghost": {"x": "y"}}},
	}
	var migration_issues := RuntimeNarrativeGraphValidation.validate_narrative_graph_data(migration)
	assert(_codes(migration_issues) == MIGRATION_CODES)
	assert(migration_issues.all(func(issue: Dictionary) -> bool: return issue.severity == "warning"))

	var complex := {
		"signals": [{"id": ""}, {"id": "__draft__"}, {"id": "go"}, {"id": "go"}],
		"compositions": [{"id": "c", "mainGraph": {
			"id": "g", "ownerType": "flow", "initialState": "a",
			"states": {
				"a": {"id": "wrong", "onEnterActions": [{"type": "setFlag", "params": {"key": ""}}], "activePlane": ""},
				"b": {"id": "b", "broadcastOnEnter": true},
			},
			"transitions": [
				{"id": "t", "from": "a", "to": "missing", "signal": "go", "trigger": "bad", "conditions": [{"narrative": "missing", "state": "x"}]},
				{"id": "t", "from": {"graphId": "x"}, "to": "b", "signal": "state:missing:nope"},
			],
		}}],
	}
	var complex_issues := RuntimeNarrativeGraphValidation.validate_narrative_graph_data(complex)
	assert(_codes(complex_issues) == COMPLEX_CODES)
	assert(RuntimeNarrativeGraphValidation.blocking_narrative_validation_errors(complex_issues).size() == 13)

	assets.dispose()
	print("Narrative graph validation direct-translation test: PASS")
	quit(0)


func _codes(issues: Array) -> Array:
	return issues.map(func(issue: Dictionary) -> String: return issue.code)


func _code_counts(issues: Array) -> Dictionary:
	var counts: Dictionary = {}
	for issue: Dictionary in issues:
		counts[issue.code] = int(counts.get(issue.code, 0)) + 1
	return counts
