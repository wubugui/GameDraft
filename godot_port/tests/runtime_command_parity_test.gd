extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	var boot_guard := 0
	while bootstrap.runtime_command_bridge == null and boot_guard < 30:
		boot_guard += 1
		await get_tree().process_frame
	assert(boot_guard < 30, "bootstrap must finish its awaited Game.init-equivalent chain")
	assert(bootstrap.runtime_command_bridge != null, "runtime command transport must bind after the file-level protocol module")
	var registered: Array = bootstrap.action_executor.get_registered_action_types()
	var architecture_contract: Variant = JSON.parse_string(FileAccess.get_file_as_string("res://compatibility/architecture-contract.json"))
	assert(architecture_contract is Dictionary and architecture_contract.get("registeredActions") is Array)
	assert(registered.slice(4) == architecture_contract.registeredActions, "production ActionRegistry order must match ActionRegistry.ts exactly")
	var live_npcs: Array[RuntimeNpc] = bootstrap.scene_manager.get_current_npcs()
	assert(not live_npcs.is_empty())
	var live_npc: RuntimeNpc = live_npcs[0]; var moved_x := live_npc.get_x() + 1.25; var moved_y := live_npc.get_y()
	await bootstrap.action_executor.execute_await({"type": "setSceneEntityPosition", "params": {"sceneId": bootstrap.scene_manager.get_current_scene_id(), "entityKind": "npc", "entityId": live_npc.get_id(), "x": moved_x, "y": moved_y}})
	assert(is_equal_approx(live_npc.get_x(), snappedf(moved_x, 0.01)), "Game-owned runtime-field adapter must apply the stored write immediately")

	var fixed: Dictionary = await bootstrap.apply_runtime_command({"id": "fixed", "type": "debugSetFixedTickMode", "enabled": true})
	assert(fixed.ok == true and bootstrap.fixed_tick_mode, "fixed-tick command must route through the shared handler")
	var positioned: Dictionary = await bootstrap.apply_runtime_command({"type": "debugSetPlayerPosition", "x": 100, "y": 100, "snapCamera": true})
	assert(positioned.ok == true and is_equal_approx(bootstrap.player.get_x(), 100.0))
	var noclip: Dictionary = await bootstrap.apply_runtime_command({"type": "setPlayerCollisions", "enabled": false})
	assert(noclip.ok == true and not bootstrap.player.get_collisions_enabled_state())

	bootstrap.state_controller.set_state(RuntimeDataTypes.EXPLORING)
	var nav: Dictionary = await bootstrap.apply_runtime_command({"type": "playerMoveTo", "x": 200, "y": 100})
	assert(nav.ok == true and bootstrap.player_nav_target is Dictionary)
	assert(bootstrap.build_runtime_debug_snapshot("nav-start").playerView.navTargetActive == true, "snapshot must observe Game-owned nav state")
	var stepped: Dictionary = await bootstrap.apply_runtime_command({"type": "debugStepTicks", "ticks": 10, "dtMs": 1000.0 / 60.0})
	assert(stepped.ok == true and bootstrap.player.get_x() > 100.0, "playerMoveTo must use the real movement/tick path")
	await bootstrap.apply_runtime_command({"type": "debugStepTicks", "ticks": 100, "dtMs": 1000.0 / 60.0})
	assert(bootstrap.player_nav_target == null and bootstrap.build_runtime_debug_snapshot("nav-end").playerView.navTargetActive == false)

	var bool_flag: Dictionary = await bootstrap.apply_runtime_command({"type": "setFlag", "key": "heard_teahouse_story", "value": "yes"})
	assert(bool_flag.ok == true and bootstrap.flag_store.get_value("heard_teahouse_story") == true, "flag coercion must match devRuntimeCommands.ts")
	var invalid_flag: Dictionary = await bootstrap.apply_runtime_command({"type": "setFlag", "key": "__not_registered__", "value": true})
	assert(invalid_flag.ok == false and invalid_flag.message.contains("not registered"))
	var quest: Dictionary = await bootstrap.apply_runtime_command({"type": "debugSetQuestStatus", "questId": "opening_01", "status": "completed"})
	assert(quest.ok == true and bootstrap.quest_manager.get_status("opening_01") == 2)
	var scenario: Dictionary = await bootstrap.apply_runtime_command({"type": "debugSetScenarioPhase", "scenarioId": "runtime_protocol_probe", "phase": "p1", "status": "completed", "outcome": true})
	assert(scenario.ok == true and bootstrap.scenario_state_manager.serialize().scenarios.runtime_protocol_probe.p1.outcome == true)
	var unknown: Dictionary = await bootstrap.apply_runtime_command({"id": "unknown", "type": "notACommand"})
	assert(unknown == {"id": "unknown", "type": "notACommand", "ok": false, "message": "unsupported runtime command: notACommand"})

	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	await get_tree().process_frame
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("Runtime command 35-type/nav/tick/snapshot architecture parity test: PASS")
	get_tree().quit(0)
