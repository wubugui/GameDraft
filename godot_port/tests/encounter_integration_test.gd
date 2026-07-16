extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")
const SceneQueries := preload("res://tests/support/scene_queries.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	assert(await bootstrap.scene_manager.switch_scene("test_room_b")); bootstrap.flag_store.set_value("encounter_ghost_done", true); var hotspot: RuntimeHotspot = SceneQueries.hotspot(bootstrap.scene_manager, "old_box"); assert(hotspot != null and not hotspot.get_picked_up())
	assert(await bootstrap.interaction_coordinator.debug_trigger_hotspot_by_id("old_box")); assert(bootstrap.encounter_manager.is_active() and bootstrap.encounter_ui.is_open() and bootstrap.encounter_ui.get_phase() == RuntimeEncounterUI.NARRATIVE and bootstrap.state_controller.current_state == RuntimeDataTypes.ENCOUNTER and hotspot.get_picked_up())
	bootstrap.encounter_ui.debug_advance(); bootstrap.encounter_ui.debug_advance(); await get_tree().process_frame; assert(bootstrap.encounter_ui.get_phase() == RuntimeEncounterUI.OPTIONS and bootstrap.encounter_ui.get_option_count() == 2)
	bootstrap.encounter_ui.debug_select_option(0); await get_tree().process_frame; assert(bootstrap.flag_store.get_value("read_box_note") == true and bootstrap.encounter_ui.get_phase() == RuntimeEncounterUI.RESULT)
	bootstrap.encounter_ui.debug_advance(); bootstrap.encounter_ui.debug_advance(); await get_tree().process_frame; assert(not bootstrap.encounter_manager.is_active() and not bootstrap.encounter_ui.is_open() and bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)
	# QuestManager mirrors the source Promise tail: encounter flags may enqueue a
	# quest action microtask that outlives the encounter. Drain it before freeing
	# the test-owned Game object, just as the browser drains microtasks at the task boundary.
	await RuntimeMicrotaskQueue.yield_turn(); await bootstrap.quest_manager.quest_action_tail.wait_until_idle()
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout
	print("Hotspot real encounter/UI/reward/state integration test: PASS"); get_tree().quit(0)
