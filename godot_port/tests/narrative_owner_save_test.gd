extends Node

var flags: RuntimeFlagStore


func _ready() -> void:
	await _run()


func _run() -> void:
	var bus := RuntimeEventBus.new()
	flags = RuntimeFlagStore.new(bus)
	var executor := RuntimeActionExecutor.new(bus, flags)
	var narrative := RuntimeNarrativeStateManager.new(bus, flags, executor)
	narrative.init({"eventBus": bus, "flagStore": flags, "strings": null, "assetManager": null})
	narrative.set_condition_eval_context_factory(func() -> Dictionary:
		return {"flagStore": flags, "narrativeState": narrative}
	)
	var flow := {"id": "flow", "ownerType": "flow", "initialState": "a", "states": {
		"a": {"id": "a"}, "b": {"id": "b"}, "c": {"id": "c"},
	}, "transitions": [
		{"id": "restore_reactive", "from": "b", "to": "c", "trigger": "reactive", "conditions": [{"flag": "restore_ready"}]},
	]}
	var owner_a := {"id": "owner_a", "ownerType": "npc", "ownerId": "same", "initialState": "idle", "states": {"idle": {"id": "idle"}}, "transitions": []}
	var owner_b := {"id": "owner_b", "ownerType": "npc", "ownerId": "same", "initialState": "idle", "states": {"idle": {"id": "idle"}}, "transitions": []}
	narrative.register_graphs([flow, owner_a, owner_b, owner_b.duplicate(true), {"id": "invalid", "initialState": "missing", "states": {}, "transitions": []}])
	assert(narrative.get_graphs().size() == 3)
	assert(narrative.classify_state_ref("flow", "a") == "ok")
	assert(narrative.classify_state_ref("missing", "a") == "missingGraph")
	assert(narrative.classify_state_ref("flow", "missing") == "missingState")
	assert(narrative.get_graph_ids_by_owner("npc", "same") == ["owner_a", "owner_b"])
	assert(narrative.get_graphs_by_owner("npc", "same").size() == 2)
	assert(narrative.get_active_states_by_owner("npc", "same") == {"owner_a": "idle", "owner_b": "idle"})
	assert(narrative.get_primary_graph_by_owner("npc", "same") == null)
	assert(narrative.get_primary_graph_by_owner("npc", "same") == null)
	var primary_issues: Array = narrative.debug_snapshot().recentIssues.filter(func(issue: Dictionary) -> bool: return issue.code == "owner.primary.ambiguous")
	assert(primary_issues.size() == 1)
	assert(narrative.debug_snapshot().recentIssues.any(func(issue: Dictionary) -> bool: return issue.code == "graph.id.duplicate"))

	await narrative.debug_set_narrative_state("flow", "b")
	await narrative.debug_set_narrative_state("flow", "c")
	assert(narrative.has_reached_state("flow", "a"))
	assert(narrative.has_reached_state("flow", "b"))
	assert(narrative.has_reached_state("flow", "c"))
	var full_save := narrative.serialize()
	assert(full_save.activeStates.flow == "c")
	assert(full_save.reachedStates.flow == ["a", "b", "c"])

	# Loading an earlier save resets reached history rather than leaking later progress.
	narrative.deserialize({"activeStates": {"flow": "b"}, "reachedStates": {"flow": ["a", "b"]}})
	assert(narrative.get_active_state("flow") == "b")
	assert(narrative.has_reached_state("flow", "a") and narrative.has_reached_state("flow", "b"))
	assert(not narrative.has_reached_state("flow", "c"))

	# Legacy saves backfill only initial + active; invalid entries fall back and leave named issues.
	narrative.deserialize({"activeStates": {"flow": "c", "missing": "x"}})
	assert(narrative.get_active_state("flow") == "c")
	assert(narrative.has_reached_state("flow", "a") and narrative.has_reached_state("flow", "c"))
	assert(not narrative.has_reached_state("flow", "b"))
	narrative.deserialize({"activeStates": {"flow": "missing", "gone": "x"}, "reachedStates": {"flow": ["missing"], "gone": ["x"]}})
	assert(narrative.get_active_state("flow") == "a" and narrative.serialize().reachedStates.flow == ["a"])
	var save_issue_codes: Array = narrative.debug_snapshot().recentIssues.map(func(issue: Dictionary) -> Variant: return issue.code)
	assert(save_issue_codes.has("save.active.graphMissing"))
	assert(save_issue_codes.has("save.active.stateMissing"))
	assert(save_issue_codes.has("save.reached.graphMissing"))
	assert(save_issue_codes.has("save.reached.stateMissing"))

	# Renamed graph/state ids remap in one hop, matching the TypeScript save contract.
	narrative.set_save_migrations({"graphs": {"old_flow": "flow"}, "states": {"flow": {"old_b": "b"}}})
	narrative.deserialize({"activeStates": {"old_flow": "old_b"}, "reachedStates": {"old_flow": ["a", "old_b"]}})
	assert(narrative.get_active_state("flow") == "b")
	assert(narrative.has_reached_state("flow", "a") and narrative.has_reached_state("flow", "b"))

	# A statically unlistened signal is reported once; a normal zero-match listened signal is trace-only.
	await narrative.emit_narrative_signal({"sourceType": "system", "sourceId": "test", "signal": "dangling"})
	await narrative.emit_narrative_signal({"sourceType": "system", "sourceId": "test", "signal": "dangling"})
	var dangling_issues: Array = narrative.debug_snapshot().recentIssues.filter(func(issue: Dictionary) -> bool: return issue.code == "signal.unlistened")
	assert(dangling_issues.size() == 1)

	# Restore can immediately unlock a reactive transition because FlagStore restore is silent.
	flags.set_value("restore_ready", true)
	await get_tree().process_frame
	narrative.deserialize({"activeStates": {"flow": "b"}, "reachedStates": {"flow": ["a", "b"]}})
	await get_tree().process_frame
	assert(narrative.get_active_state("flow") == "c")
	assert(narrative.has_reached_state("flow", "b") and narrative.has_reached_state("flow", "c"))

	assert(EventBusProbe.listener_count(bus, "flag:changed") == 1)
	narrative.destroy(); narrative.free()
	assert(EventBusProbe.listener_count(bus, "flag:changed") == 0)
	executor.destroy(); flags.destroy(); bus.clear()
	print("Narrative owner/reached/save contract test: PASS")
	get_tree().quit(0)
