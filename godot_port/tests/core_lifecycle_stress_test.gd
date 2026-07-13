extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _ready() -> void:
	await _run()


func _run() -> void:
	for iteration in 20:
		var bootstrap: Node = BootstrapScript.new()
		bootstrap.set_meta("suppressSceneOnEnter", true)
		add_child(bootstrap)
		await get_tree().process_frame
		assert(bootstrap.runtime_root != null and bootstrap.runtime_root.is_initialized())
		bootstrap.runtime_root.event_bus.on("stress", Callable(bootstrap, "resolve_display_text"))
		# Core systems + Dialogue/Encounter/Cutscene/Menu UI bridges + dialogue speaking-bubble bridge + coordinator + test listener.
		var listener_count: int = bootstrap.runtime_root.event_bus.listener_count()
		assert(listener_count == 102, "unexpected initialized listener count: %s" % listener_count)
		assert(bootstrap.asset_manager.get_stats().json.entries == 33)
		assert(bootstrap.scene_manager.get_current_scene_id() == "teahouse" and bootstrap.scene_manager.get_current_npcs().size() == 4 and bootstrap.scene_manager.get_current_hotspots().size() == 7)
		var snapshot: Dictionary = bootstrap.build_runtime_debug_snapshot("stress:%s" % iteration)
		assert(snapshot.gameState == "Exploring" and snapshot.flags is Dictionary and not str(snapshot.bootId).is_empty())
		bootstrap.state_controller.destroy()
		bootstrap.runtime_root.destroy_runtime()
		bootstrap.action_executor.destroy()
		bootstrap.save_manager.destroy()
		bootstrap.flag_store.destroy()
		bootstrap.input_manager.destroy()
		bootstrap.asset_manager.dispose()
		assert(bootstrap.runtime_root.event_bus.listener_count() == 0)
		assert(bootstrap.input_manager.subscriber_count() == 0)
		for type: String in RuntimeAssetManager.ASSET_TYPES:
			assert(bootstrap.asset_manager.get_stats()[type].entries == 0)
		remove_child(bootstrap)
		bootstrap.free()
		await get_tree().process_frame
	assert(get_child_count() == 0)
	await get_tree().create_timer(0.15).timeout
	print("Core lifecycle stress test: PASS (20 init/destroy cycles)")
	get_tree().quit(0)
