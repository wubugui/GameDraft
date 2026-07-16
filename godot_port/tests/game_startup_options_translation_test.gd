extends Node

const GameHarnessScript := preload("res://tests/support/startup_options_game_harness.gd")
const StartupAdapterPath := "res://scripts/runtime/game_startup_adapter.gd"

var _start_finished := false


func _ready() -> void:
	await _run_contract()
	# Stopped AudioStreamPlayers are released on the audio mixer tick rather
	# than the scene-tree frame used to free each Game harness.
	await get_tree().create_timer(0.5).timeout
	print("Game start options/dev route/ready-guard direct-translation test: PASS")
	get_tree().quit(0)


func _run_contract() -> void:
	_test_engine_startup_adapter()
	await _test_normal_start_branch()
	await _test_parity_initial_scene_compatibility()
	await _test_dev_start_and_staged_route()
	await _test_ready_guard("teardown")
	await _test_ready_guard("renderer")


func _test_engine_startup_adapter() -> void:
	var adapter: Variant = load(StartupAdapterPath)
	assert(adapter != null, "RuntimeGameStartupAdapter script is missing")
	var host := Node.new()
	host.set_meta("startOptions", {
		"devMode": false,
		"playCutscene": "meta-cutscene",
		"devScene": "meta-scene",
		"narrativeWarp": "meta-warp",
		"waterPreview": "meta-water",
		"sugarWheelPreview": "meta-sugar",
		"paperCraftPreview": "meta-paper",
		"visualCapture": true,
		"notAStartOption": "must-not-cross-boundary",
	})
	var meta_only: Dictionary = adapter.call("from_engine", host, PackedStringArray())
	assert(_start_option_slice(meta_only) == {
		"devMode": false,
		"playCutscene": "meta-cutscene",
		"devScene": "meta-scene",
		"narrativeWarp": "meta-warp",
		"waterPreview": "meta-water",
		"sugarWheelPreview": "meta-sugar",
		"paperCraftPreview": "meta-paper",
		"visualCapture": true,
	})
	assert(not meta_only.has("notAStartOption"))

	var empty_host := Node.new()
	var cli: Dictionary = adapter.call("from_engine", empty_host, PackedStringArray([
		"--mode=dev",
		"--play_cutscene=alias-cutscene",
		"--play-cutscene=canonical-cutscene",
		"--dev_scene=alias-scene",
		"--devScene=last-scene",
		"--narrative_warp=cli-warp",
		"--waterPreview=cli-water",
		"--sugarWheelPreview=cli-sugar",
		"--paperCraftPreview=cli-paper",
		"--visualCapture",
		"--visual-capture=off",
	]))
	assert(_start_option_slice(cli) == {
		"devMode": true,
		"playCutscene": "canonical-cutscene",
		"devScene": "last-scene",
		"narrativeWarp": "cli-warp",
		"waterPreview": "cli-water",
		"sugarWheelPreview": "cli-sugar",
		"paperCraftPreview": "cli-paper",
		"visualCapture": false,
	})
	var metadata_wins: Dictionary = adapter.call("from_engine", host, PackedStringArray([
		"--dev-mode",
		"--play-cutscene=cli-must-lose",
		"--visual-capture=off",
	]))
	assert(metadata_wins.get("devMode") == false)
	assert(metadata_wins.get("playCutscene") == "meta-cutscene")
	assert(metadata_wins.get("visualCapture") == true)

	var parity: Dictionary = adapter.call("from_engine", empty_host, PackedStringArray([
		"--parity-start-scene=legacy-room",
		"--parity-request=ignored-request.json",
		"--parity-response=ignored-response.json",
		"--parity-quit",
	]))
	assert(parity.get("devMode") == false)
	assert(parity.get("_godotInitialScene") == "legacy-room")
	assert(not parity.has("devScene") or str(parity.get("devScene", "")).is_empty())
	assert(not parity.has("parity-start-scene") and not parity.has("parity-request"))
	var explicit_scene: Dictionary = adapter.call("from_engine", empty_host, PackedStringArray([
		"--parity-start-scene=legacy-room",
		"--dev-scene=explicit-room",
		"--dev-mode=0",
	]))
	assert(explicit_scene.get("devScene") == "explicit-room")
	assert(explicit_scene.get("devMode") == false)
	host.free()
	empty_host.free()


func _test_normal_start_branch() -> void:
	var game: Node = GameHarnessScript.new()
	game.install_trace_listeners()
	add_child(game)
	await game.start({})

	var ordered := _indices(game.trace, [
		"setup_player:false",
		"quest:opening_01",
		"scene:test_room_b",
		"initial_prologue",
		"command_polling:process=true:ready=true",
		"snapshot:runtime-ready",
	])
	assert(_strictly_increasing(ordered), "normal startup order drifted: %s" % [game.trace])
	assert(game.is_dev_mode == false)
	assert(game.dev_mode_ui == null, "DevModeUI must only be constructed by startDevMode")
	assert(game.runtime_ready and game.is_processing())
	assert(game.runtime_command_bridge != null)
	await _dispose_game(game)


func _test_parity_initial_scene_compatibility() -> void:
	var game: Node = GameHarnessScript.new()
	game.install_trace_listeners()
	add_child(game)
	await game.start({"_godotInitialScene": "test_room_a"})
	assert(game.is_dev_mode == false)
	assert(game.scene_manager.get_current_scene_id() == "test_room_a")
	assert(game.trace.has("setup_player:false"))
	assert(game.trace.has("scene:test_room_a"))
	assert(not game.trace.has("quest:opening_01"), "parity scene compatibility must skip initialQuest")
	assert(game.trace.find("scene:test_room_a") < game.trace.find("initial_prologue"))
	assert(game.dev_mode_ui == null)
	assert(game.runtime_ready and game.runtime_command_bridge != null)
	await _dispose_game(game)


func _test_dev_start_and_staged_route() -> void:
	var game: Node = GameHarnessScript.new()
	game.install_trace_listeners()
	game.block_play_cutscene = true
	add_child(game)
	_start_finished = false
	_begin_start(game, {
		"devMode": true,
		"playCutscene": "opening-cutscene",
		"devScene": "lower-priority-scene",
		"narrativeWarp": "warp-a",
		"waterPreview": "lower-water",
		"sugarWheelPreview": "lower-sugar",
		"paperCraftPreview": "lower-paper",
		"visualCapture": true,
	})
	await _wait_until(func() -> bool: return game.route_started, "dev startup route did not begin")

	assert(game.is_processing(), "main tick must be enabled before the staged dev route")
	assert(game.runtime_ready == false, "runtimeReady must stay false while the route is pending")
	assert(game.runtime_command_bridge == null)
	assert(not game.trace.any(func(value: String) -> bool:
		return value.begins_with("command_polling") or value.begins_with("snapshot:")
	))
	assert(game.dev_mode_ui != null, "dev startup must construct DevModeUI")
	assert(not game.dev_mode_ui.is_open(), "visualCapture must not open DevModeUI")
	game.release_blocked_route = true
	await _wait_until(func() -> bool: return _start_finished, "dev start did not finish after releasing route")

	assert(game.route_action_trace == ["cutscene:opening-cutscene", "narrative:warp-a"])
	var ordered := _indices(game.trace, [
		"setup_player:true",
		"scene:dev_room",
		"load_warps",
		"route_cutscene:process=true:ready=false",
		"command_polling:process=true:ready=true",
		"snapshot:runtime-ready",
	])
	assert(_strictly_increasing(ordered), "dev startup order drifted: %s" % [game.trace])
	assert(game.runtime_ready and game.runtime_command_bridge != null)
	game.audio_manager.stop_all_playback()
	game.scene_manager.set_audio_applier()
	await get_tree().process_frame

	# The route after playCutscene is exclusive and uses the exact source
	# priority: narrativeWarp > devScene > water > sugarWheel > paperCraft.
	assert(await _stage_route(game, {
		"playCutscene": "additive",
		"narrativeWarp": "warp-a",
		"devScene": "scene-a",
		"waterPreview": "water-a",
		"sugarWheelPreview": "sugar-a",
		"paperCraftPreview": "paper-a",
	}) == ["cutscene:additive", "narrative:warp-a"])
	assert(await _stage_route(game, {
		"devScene": "scene-a",
		"waterPreview": "water-a",
		"sugarWheelPreview": "sugar-a",
		"paperCraftPreview": "paper-a",
	}) == ["scene:scene-a"])
	assert(await _stage_route(game, {
		"waterPreview": "water-a",
		"sugarWheelPreview": "sugar-a",
		"paperCraftPreview": "paper-a",
	}) == ["water:water-a"])
	assert(await _stage_route(game, {
		"sugarWheelPreview": "sugar-a",
		"paperCraftPreview": "paper-a",
	}) == ["sugar:sugar-a"])
	assert(await _stage_route(game, {"paperCraftPreview": "paper-a"}) == ["paper:paper-a"])
	await _dispose_game(game)


func _test_ready_guard(kind: String) -> void:
	var game: Node = GameHarnessScript.new()
	game.install_trace_listeners()
	game.guard_on_play_cutscene = kind
	add_child(game)
	await game.start({
		"devMode": true,
		"playCutscene": "guard-%s" % kind,
		"visualCapture": true,
	})
	assert(game.route_started)
	assert(not game.runtime_ready)
	assert(game.runtime_command_bridge == null)
	assert(not game.trace.any(func(value: String) -> bool:
		return value.begins_with("command_polling") or value.begins_with("snapshot:")
	))
	if kind == "teardown":
		assert(game.tear_down_complete and not game.is_processing())
	else:
		assert(not game.renderer.is_initialized())
	await _dispose_game(game)


func _begin_start(game: Node, options: Dictionary) -> void:
	await game.start(options)
	_start_finished = true


func _stage_route(game: Node, options: Dictionary) -> Array:
	game.reset_route_probe()
	await game.start_dev_mode(
		str(options.get("playCutscene", "")),
		str(options.get("waterPreview", "")),
		str(options.get("sugarWheelPreview", "")),
		str(options.get("paperCraftPreview", "")),
		str(options.get("devScene", "")),
		str(options.get("narrativeWarp", "")),
		true,
	)
	assert(game.scene_manager.get_current_scene_id() == "dev_room")
	assert(game.dev_mode_ui != null and not game.dev_mode_ui.is_open())
	var route: Callable = game.dev_startup_route
	assert(not route.is_null() and route.is_valid())
	game.dev_startup_route = Callable()
	await route.call()
	return game.route_action_trace.duplicate()


func _dispose_game(game: Node) -> void:
	if game.audio_manager != null:
		game.audio_manager.stop_all_playback()
	if game.asset_manager != null:
		game.asset_manager.clear_cache()
	await get_tree().process_frame
	game.destroy()
	if game.get_parent() == self:
		remove_child(game)
	game.free()
	await get_tree().process_frame


func _wait_until(predicate: Callable, failure: String) -> void:
	for _frame in 900:
		if predicate.call():
			return
		await get_tree().process_frame
	assert(false, failure)


func _indices(trace: Array, expected: Array[String]) -> Array[int]:
	var result: Array[int] = []
	for value: String in expected:
		result.push_back(trace.find(value))
	return result


func _strictly_increasing(values: Array[int]) -> bool:
	for index in values.size():
		if values[index] < 0 or (index > 0 and values[index] <= values[index - 1]):
			return false
	return true


func _start_option_slice(options: Dictionary) -> Dictionary:
	return {
		"devMode": options.get("devMode"),
		"playCutscene": options.get("playCutscene"),
		"devScene": options.get("devScene"),
		"narrativeWarp": options.get("narrativeWarp"),
		"waterPreview": options.get("waterPreview"),
		"sugarWheelPreview": options.get("sugarWheelPreview"),
		"paperCraftPreview": options.get("paperCraftPreview"),
		"visualCapture": options.get("visualCapture"),
	}
