extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")

var lines: Array = []


func _ready() -> void:
	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	bootstrap.flag_store.set_value("player_display_name", "关二狗"); bootstrap.runtime_root.event_bus.on("dialogue:line", func(payload: Variant) -> void: lines.push_back(payload.duplicate(true)))
	var action := {"type": "playScriptedDialogue", "params": {"scriptedNpcId": "storyteller_zhang", "dimBackground": true, "lines": [{"speaker": "", "text": "掌柜：先坐下。"}, {"speaker": "{{player}}", "text": "我晓得了。", "portrait": {"emotion": "calm"}}, {"speaker": "{{npc}}", "text": "接着听书。", "portrait": {"emotion": "smirk"}}]}}
	bootstrap.action_executor.execute_await(action); await get_tree().process_frame
	assert(bootstrap.action_executor.has_handler("playScriptedDialogue") and bootstrap.dialogue_manager.is_active() and bootstrap.dialogue_ui.is_open() and bootstrap.state_controller.current_state == RuntimeGameStateController.DIALOGUE)
	var guard := 0
	while bootstrap.dialogue_manager.is_active() and guard < 12:
		guard += 1; bootstrap.dialogue_ui.update(100.0); bootstrap.dialogue_ui.debug_advance(); await get_tree().process_frame
	assert(guard < 12 and lines.size() == 3 and lines[0].speaker == "掌柜" and lines[0].text == "先坐下。")
	assert(lines[1].speaker == "关二狗" and lines[1].speakerEntity == {"kind": "player"} and lines[1].portrait.slug == "player_carry_corpse_anim" and lines[1].dim == true)
	assert(lines[2].speaker == "说书人张叨叨" and lines[2].speakerEntity == {"kind": "npc", "npcId": "storyteller_zhang"} and lines[2].portrait.slug == "npc_storyteller_anim")
	assert(not bootstrap.dialogue_manager.is_active() and not bootstrap.dialogue_ui.is_open() and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING)
	var graph: RuntimeGraphDialogueManager = bootstrap.graph_dialogue_manager; graph.graph = {"entry": "script", "nodes": {"script": {"type": "runActions", "actions": [{"type": "playScriptedDialogue", "params": {"lines": [{"speaker": "{{npc}}", "text": "嵌套脚本。"}]}}], "next": "outer"}, "outer": {"type": "line", "speaker": {"kind": "npc"}, "text": "外层继续。", "next": "end"}, "end": {"type": "end"}}}; graph.graph_source_id = "nested_script"; graph.current_node_id = "script"; graph.npc_name = "说书人张叨叨"; graph.npc_id = "storyteller_zhang"; graph.owner_type = "npc"; graph.owner_id = "storyteller_zhang"; graph.active = true; bootstrap.state_controller.set_state(RuntimeGameStateController.DIALOGUE); graph._drain_until_blocking(); await get_tree().process_frame
	assert(graph.is_active() and bootstrap.dialogue_manager.is_active() and bootstrap.state_controller.current_state == RuntimeGameStateController.DIALOGUE); bootstrap.dialogue_ui.update(100.0); bootstrap.dialogue_ui.debug_advance(); await get_tree().process_frame; assert(not bootstrap.dialogue_manager.is_active() and graph.is_active() and lines[-1].text == "外层继续。" and bootstrap.state_controller.current_state == RuntimeGameStateController.DIALOGUE); bootstrap.dialogue_ui.update(100.0); bootstrap.dialogue_ui.debug_advance(); await get_tree().process_frame; assert(not graph.is_active() and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING)
	bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame; remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout; print("playScriptedDialogue Action/UI/context integration test: PASS"); get_tree().quit(0)
