extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	var args := _parse_args(); var phase := str(args.get("phase", "produce")); var output := str(args.get("output", "")); var storage := str(args.get("storage", ""))
	if output.is_empty() or storage.is_empty(): push_error("save interop probe requires output/storage"); get_tree().quit(2); return
	var bootstrap: Node = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame; await get_tree().process_frame
	var manager := RuntimeSaveManager.new(Callable(bootstrap, "collect_save_data"), Callable(bootstrap, "distribute_save_data"), Callable(bootstrap, "reload_saved_scene"), bootstrap.strings_provider, "teahouse", storage)
	manager.set_can_save_predicate(func() -> bool: return true)
	if phase == "produce":
		bootstrap.runtime_root.event_bus.emit("dialogue:line", {"speaker": "存档探针", "text": "跨壳日志"})
		var restore_events := [0]
		bootstrap.runtime_root.event_bus.on("save:restoring", func(_payload: Variant) -> void: restore_events[0] += 1)
		var local_snapshot: Dictionary = bootstrap.collect_save_data()
		assert(local_snapshot.get("dialogueLog") is Dictionary and local_snapshot.dialogueLog.entries.size() == 1 and float(local_snapshot.game.playTimeMs) > 0.0 and int(local_snapshot.game.randomState) == bootstrap.runtime_random_state)
		var expected_next_random: float = bootstrap._next_runtime_random()
		assert(bootstrap.distribute_save_data(local_snapshot) and restore_events[0] == 1 and bootstrap.dialogue_log_ui.entries.size() == 1)
		assert(bootstrap._next_runtime_random() == expected_next_random)
		var px: float = bootstrap.player.get_x(); var py: float = bootstrap.player.get_y()
		bootstrap.zone_system.set_zones([{"id": "restore_probe", "polygon": [{"x": px - 10, "y": py - 10}, {"x": px + 10, "y": py - 10}, {"x": px + 10, "y": py + 10}, {"x": px - 10, "y": py + 10}], "onExit": [{"type": "setFlag", "params": {"key": "restore_zone_exit_pollution", "value": true}}]}])
		bootstrap.zone_system.update(0.0)
		assert(bootstrap.zone_system.get_active_zone_ids().has("restore_probe"))
		assert(bootstrap.reload_saved_scene("teahouse"))
		await get_tree().process_frame
		assert(bootstrap.flag_store.get_value("restore_zone_exit_pollution") != true)
		bootstrap.flag_store.set_value("archive_book_book_erta_guide", true)
		assert(manager.save(0) and manager.export_slot_payload(0, output))
		print("Godot save interop producer: PASS")
	else:
		var input := str(args.get("input", "")); assert(not input.is_empty())
		assert(manager.import_slot_payload(0, input) and await manager.load(0))
		assert(bootstrap.flag_store.get_value("archive_book_book_erta_guide") == false)
		assert(bootstrap.dialogue_log_ui.entries.size() == 1 and bootstrap.dialogue_log_ui.entries[0].text == "跨壳日志" and bootstrap.play_time_ms > 0.0)
		assert(manager.save(1) and manager.export_slot_payload(1, output))
		print("Godot save interop consumer: PASS")
	manager.destroy(); bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.1).timeout; get_tree().quit(0)


func _parse_args() -> Dictionary:
	var result := {}
	for raw: String in OS.get_cmdline_user_args():
		if raw.begins_with("--") and raw.contains("="):
			var at := raw.find("="); result[raw.substr(2, at - 2)] = raw.substr(at + 1)
	return result
