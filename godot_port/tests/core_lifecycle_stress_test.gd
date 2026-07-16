extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")
const EXPECTED_INITIAL_JSON_ENTRIES := 50


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
		# Core systems + full 17-event EventBridge + dialogue speaking-bubble bridge +
		# coordinator + DebugTools scene-unload marker listener + the source Game
		# runtime-snapshot publication listeners (9) + test listener.
		var listener_count: int = EventBusProbe.listener_count(bootstrap.runtime_root.event_bus)
		assert(listener_count == 113, "unexpected initialized listener count: %s" % listener_count)
		# Game.refreshTextResolveLookups() also caches every map-addressable scene so
		# [tag:npc:*] resolution has the same global name lookup as the source shell.
		assert(bootstrap.asset_manager.get_stats().json.entries == EXPECTED_INITIAL_JSON_ENTRIES, "unexpected JSON cache entries: %s" % bootstrap.asset_manager.get_stats().json.entries)
		assert(
			bootstrap.scene_manager.get_current_scene_id() == "teahouse"
			and bootstrap.scene_manager.get_current_npcs().size() == 4
			and bootstrap.scene_manager.get_current_hotspots().size() == 6,
			"unexpected scene graph: scene=%s npcs=%s hotspots=%s" % [
				bootstrap.scene_manager.get_current_scene_id(),
				bootstrap.scene_manager.get_current_npcs().size(),
				bootstrap.scene_manager.get_current_hotspots().size(),
			],
		)
		var snapshot: Dictionary = bootstrap.build_runtime_debug_snapshot("stress:%s" % iteration)
		assert(snapshot.gameState == "Exploring" and snapshot.flags is Dictionary and not str(snapshot.bootId).is_empty())
		bootstrap.state_controller.destroy()
		bootstrap.runtime_root.destroy_runtime()
		bootstrap.action_executor.destroy()
		bootstrap.flag_store.destroy()
		bootstrap.input_manager.destroy()
		bootstrap.asset_manager.dispose()
		assert(EventBusProbe.listener_count(bootstrap.runtime_root.event_bus) == 0)
		assert(InputManagerProbe.subscriber_count(bootstrap.input_manager) == 0)
		for type: String in RuntimeAssetManager.ASSET_TYPES:
			assert(bootstrap.asset_manager.get_stats()[type].entries == 0)
		remove_child(bootstrap)
		bootstrap.free()
		await get_tree().process_frame
	assert(get_child_count() == 0)
	# AudioStreamPlayer.stop/free 已同步完成；Godot 音频线程仍需一个真实
	# 混音释放窗口才能丢掉最后一轮 playback 引用（与 audio_manager_test 一致）。
	await get_tree().create_timer(0.5).timeout
	print("Core lifecycle stress test: PASS (20 init/destroy cycles)")
	get_tree().quit(0)
