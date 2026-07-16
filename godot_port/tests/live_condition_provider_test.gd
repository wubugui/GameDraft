extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	await _run()


func _run() -> void:
	var bootstrap: Node = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	await get_tree().process_frame
	assert(bootstrap.runtime_root.is_initialized())
	bootstrap.flag_store.set_value("box_opened", true)
	bootstrap.quest_manager.debug_set_quest_status("opening_01", "active")
	bootstrap.scenario_state_manager.debug_set_scenario_phase("integration", "phase", {"status": "done", "outcome": "ok"})
	bootstrap.scenario_state_manager.debug_set_scenario_line_lifecycle("码头水鬼", "active")
	assert(bootstrap.plane_reconciler.activate_plane_manually("背尸"))
	var graph: Dictionary = bootstrap.narrative_state_manager.get_graph("flow_dock_water_monkey")
	var initial := str(graph.initialState)
	var context: Dictionary = bootstrap.build_condition_eval_context()
	assert(RuntimeConditionEvaluator.evaluate({"flag": "box_opened"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"quest": "opening_01", "questStatus": "Active"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"scenario": "integration", "phase": "phase", "status": "done", "outcome": "ok"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"scenarioLine": "码头水鬼", "lineStatus": "active"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"narrative": "flow_dock_water_monkey", "state": initial}, context))
	assert(RuntimeConditionEvaluator.evaluate({"narrative": "flow_dock_water_monkey", "state": initial, "reached": true}, context))
	assert(RuntimeConditionEvaluator.evaluate({"plane": "背尸"}, context))
	assert(RuntimeConditionEvaluator.evaluate({"all": [{"flag": "box_opened"}, {"quest": "opening_01", "questStatus": "Active"}]}, context))
	assert(RuntimeConditionEvaluator.evaluate({"any": [{"flag": "got_iron_box"}, {"plane": "背尸"}]}, context))
	assert(RuntimeConditionEvaluator.evaluate({"not": {"flag": "got_iron_box"}}, context))
	assert(not RuntimeConditionEvaluator.evaluate({"unknown": true}, context))

	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache("audio")
	await get_tree().process_frame
	bootstrap.state_controller.destroy()
	bootstrap.runtime_root.destroy_runtime()
	bootstrap.action_executor.destroy()
	bootstrap.flag_store.destroy()
	bootstrap.input_manager.destroy()
	bootstrap.asset_manager.dispose()
	remove_child(bootstrap)
	bootstrap.free()
	# AudioServer releases playback resources asynchronously after players stop/free.
	await get_tree().create_timer(0.5).timeout
	print("Live 9-node condition provider direct-translation test: PASS")
	get_tree().quit(0)
