extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	var npc: RuntimeNpc = bootstrap.scene_manager.get_npc_by_id("storyteller_zhang"); assert(npc != null and npc.is_moving_to_target(), "scene:ready must start the Game-owned patrol coroutine"); var original_zoom: float = bootstrap.camera.get_zoom()
	var routed: bool = await bootstrap.interaction_coordinator.debug_interact_npc_by_id("storyteller_zhang"); assert(routed); assert(bootstrap.graph_dialogue_manager.is_active() and bootstrap.dialogue_ui.is_open() and bootstrap.state_controller.current_state == RuntimeDataTypes.DIALOGUE and npc.is_patrol_paused_for_dialogue())
	assert(bootstrap.emote_bubble_manager.active_bubbles.size() == 1 and bootstrap.emote_bubble_manager.active_bubbles[0].owner == "dialogue-speaking")
	var steps := 0
	while bootstrap.graph_dialogue_manager.is_active() and steps < 80:
		steps += 1; var view: Dictionary = bootstrap.graph_dialogue_manager.get_dialogue_view_debug()
		if view.choiceStage == "options":
			var picked := -1
			for choice: Dictionary in view.choices:
				if choice.enabled == true: picked = int(choice.index); break
			assert(picked >= 0); bootstrap.dialogue_ui.debug_select_choice(picked)
		else:
			bootstrap.dialogue_ui.update(100.0); bootstrap.dialogue_ui.debug_advance()
		await get_tree().process_frame
	assert(steps < 80 and not bootstrap.graph_dialogue_manager.is_active() and not bootstrap.dialogue_ui.is_open())
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING and not npc.is_patrol_paused_for_dialogue() and bootstrap.camera.get_zoom() == original_zoom and bootstrap.emote_bubble_manager.active_bubbles.is_empty())
	await get_tree().create_timer(0.06).timeout; assert(npc.is_moving_to_target(), "dialogue end must resume the same epoch-guarded patrol coroutine")
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout
	print("NPC real-JSON dialogue/UI/state/camera integration test: PASS"); get_tree().quit(0)
