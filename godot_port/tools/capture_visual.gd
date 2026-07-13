extends SceneTree

const BootstrapScript := preload("res://scripts/bootstrap.gd")


func _initialize() -> void:
	call_deferred("_capture")


func _capture() -> void:
	var options := _options()
	var output := str(options.get("output", "")).strip_edges()
	var scene_id := str(options.get("scene", "test_room_a")).strip_edges()
	if output.is_empty() or scene_id.is_empty():
		push_error("capture_visual requires --output=<png> and a non-empty --scene=<id>")
		quit(2)
		return
	var bootstrap: Node = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	root.add_child(bootstrap)
	await process_frame
	var commands: Array[Dictionary] = [
		{"type": "debugSetFixedTickMode", "enabled": true},
		{"type": "debugSwitchScene", "sceneId": scene_id},
		{
			"type": "debugSetPlayerPosition",
			"x": float(options.get("x", 2110.0)),
			"y": float(options.get("y", 1320.0)),
			"snapCamera": true,
		},
	]
	var health_damage := maxf(0.0, float(options.get("health-damage", 0.0)))
	if health_damage > 0.0:
		commands.push_back({"type": "debugExecuteAction", "action": {"type": "damagePlayer", "params": {"amount": health_damage}}})
	var scent := str(options.get("smell", "")).strip_edges()
	if not scent.is_empty():
		commands.push_back({
			"type": "debugExecuteAction",
			"action": {
				"type": "setSmell",
				"params": {
					"scent": scent,
					"intensity": float(options.get("smell-intensity", 100.0)),
					"dir": float(options.get("smell-dir", 0.0)),
					"flicker": str(options.get("smell-flicker", "false")).to_lower() in ["true", "1", "yes"],
				},
			},
		})
	commands.push_back({
		"type": "debugStepTicks",
		"ticks": maxi(1, int(options.get("ticks", 1))),
		"dtMs": float(options.get("dt-ms", 1000.0 / 60.0)),
	})
	var dialogue_graph := str(options.get("dialogue-graph", "")).strip_edges()
	if not dialogue_graph.is_empty():
		commands.push_back({"type": "debugStartDialogueGraph", "graphId": dialogue_graph})
		var dialogue_advance_steps := maxi(0, int(options.get("dialogue-advance-steps", 0)))
		if dialogue_advance_steps > 0: commands.push_back({"type": "debugAdvanceDialogue", "maxSteps": dialogue_advance_steps})
		commands.push_back({"type": "debugStepTicks", "ticks": 120, "dtMs": float(options.get("dt-ms", 1000.0 / 60.0))})
	for command: Dictionary in commands:
		var result: Dictionary = await bootstrap.apply_parity_runtime_command(command)
		if result.get("ok") != true:
			push_error("capture_visual command failed: %s" % result)
			_teardown(bootstrap)
			quit(3)
			return
	var minigame := str(options.get("minigame", "")).strip_edges()
	if not minigame.is_empty():
		if not await _start_minigame(bootstrap, minigame):
			push_error("capture_visual minigame failed to start: %s" % minigame)
			_teardown(bootstrap); quit(7); return
		var minigame_tick: Dictionary = await bootstrap.apply_parity_runtime_command({"type": "debugStepTicks", "ticks": 60, "dtMs": float(options.get("dt-ms", 1000.0 / 60.0))})
		if minigame_tick.get("ok") != true:
			push_error("capture_visual minigame fixed ticks failed: %s" % minigame_tick)
			_teardown(bootstrap); quit(8); return
	if not dialogue_graph.is_empty() and bootstrap.dialogue_ui != null:
		bootstrap.dialogue_ui.debug_complete_text()
	if bootstrap.renderer != null and bootstrap.renderer.world_container != null:
		bootstrap.renderer.world_container.position += Vector2(
			float(options.get("world-offset-x", 0.0)),
			float(options.get("world-offset-y", 0.0)),
		)
	if str(options.get("depth-debug", "false")).to_lower() in ["true", "1", "yes"] and bootstrap.scene_depth_system != null:
		bootstrap.scene_depth_system.set_debug_mode(true)
	if str(options.get("world-filter", "on")).to_lower() == "off" and bootstrap.renderer != null:
		bootstrap.renderer.clear_world_filter()
	if options.has("world-fade-alpha") and bootstrap.cutscene_renderer != null:
		bootstrap.cutscene_renderer.set_debug_world_fade_alpha(float(options.get("world-fade-alpha", 0.0)))
	var audio_probe: Variant = null
	var audio_probe_id := str(options.get("audio-probe", "")).strip_edges()
	if not audio_probe_id.is_empty() and bootstrap.audio_manager != null:
		if not bootstrap.audio_manager.play_bgm(audio_probe_id, 1000.0):
			push_error("capture_visual audio probe failed to start: %s" % audio_probe_id)
			_teardown(bootstrap); quit(6); return
		var audio_started_us := Time.get_ticks_usec()
		var audio_start: Dictionary = bootstrap.audio_manager.get_debug_output_state()
		OS.delay_msec(250)
		var audio_end: Dictionary = bootstrap.audio_manager.get_debug_output_state()
		audio_probe = {"id": audio_probe_id, "start": audio_start, "at250ms": audio_end, "elapsedMs": (Time.get_ticks_usec() - audio_started_us) / 1000.0}
	var background_filter := str(options.get("background-filter", "")).strip_edges().to_lower()
	if background_filter in ["nearest", "linear"] and bootstrap.scene_manager.scene_background != null:
		var texture_filter := CanvasItem.TEXTURE_FILTER_NEAREST if background_filter == "nearest" else CanvasItem.TEXTURE_FILTER_LINEAR
		for child: Node in bootstrap.scene_manager.scene_background.get_children():
			if child is CanvasItem: child.texture_filter = texture_filter
	RenderingServer.force_draw(true)
	await process_frame
	RenderingServer.force_draw(true)
	var state_output := str(options.get("state-output", "")).strip_edges()
	if not state_output.is_empty():
		var state_file := FileAccess.open(state_output, FileAccess.WRITE)
		if state_file == null:
			push_error("capture_visual failed to open state output: %s" % state_output)
			_teardown(bootstrap)
			quit(5)
			return
		var state: Dictionary = bootstrap.build_runtime_debug_snapshot("visual-capture")
		if audio_probe != null: state["_audioProbe"] = audio_probe
		state_file.store_string(JSON.stringify(state, "  ") + "\n")
		state_file.close()
	var image := root.get_texture().get_image()
	var error := image.save_png(output)
	_teardown(bootstrap)
	await process_frame
	if error != OK:
		push_error("capture_visual failed to save %s: %s" % [output, error])
		quit(4)
		return
	print("Godot visual capture: PASS %s" % output)
	quit(0)


func _start_minigame(bootstrap: Node, spec: String) -> bool:
	var separator := spec.find(":")
	if separator <= 0 or separator >= spec.length() - 1: return false
	var kind := spec.left(separator); var id := spec.substr(separator + 1); var manager: Variant = null
	if kind == "pressureHold":
		var request: Variant = bootstrap.pressure_hold_manager.get_debug_preview_request(id)
		return request is Dictionary and bootstrap.pressure_hold_ui.show_debug_preview(request, 0.42)
	match kind:
		"water": manager = bootstrap.water_minigame_manager
		"sugarWheel": manager = bootstrap.sugar_wheel_minigame_manager
		"paperCraft": manager = bootstrap.paper_craft_minigame_manager
		_: return false
	manager.start(id)
	for _index: int in 240:
		await process_frame
		if manager.active and manager.scene != null:
			var scene_root: Variant = manager.scene.get_root()
			if scene_root != null and scene_root.get_parent() == bootstrap.renderer.cutscene_overlay: return true
	return false


func _teardown(bootstrap: Node) -> void:
	if bootstrap == null or not is_instance_valid(bootstrap): return
	if bootstrap.audio_manager != null: bootstrap.audio_manager.stop_all_playback()
	if bootstrap.asset_manager != null: bootstrap.asset_manager.clear_cache()
	if bootstrap.get_parent() != null: bootstrap.get_parent().remove_child(bootstrap)
	bootstrap.free()


func _options() -> Dictionary:
	var result := {}
	for raw: String in OS.get_cmdline_user_args():
		if not raw.begins_with("--"): continue
		var pair := raw.trim_prefix("--").split("=", true, 1)
		result[pair[0]] = pair[1] if pair.size() == 2 else true
	return result
