extends "res://scripts/bootstrap.gd"


class WaterPreviewProbe:
	extends RuntimeWaterMinigameManager

	var trace: Array

	func _init(next_trace: Array) -> void:
		trace = next_trace

	func start(id: String) -> void:
		trace.push_back("water:%s" % id)


class SugarWheelPreviewProbe:
	extends RuntimeSugarWheelMinigameManager

	var trace: Array

	func _init(next_trace: Array) -> void:
		trace = next_trace

	func start(id: String) -> void:
		trace.push_back("sugar:%s" % id)


class PaperCraftPreviewProbe:
	extends RuntimePaperCraftMinigameManager

	var trace: Array

	func _init(next_trace: Array) -> void:
		trace = next_trace

	func start(id: String) -> void:
		trace.push_back("paper:%s" % id)


const INITIAL_SCENE := "test_room_b"
const INITIAL_QUEST := "opening_01"

var trace: Array[String] = []
var route_action_trace: Array = []
var route_started := false
var release_blocked_route := false
var block_play_cutscene := false
var guard_on_play_cutscene := ""

var _trace_listeners_installed := false
var _real_water_manager: RuntimeWaterMinigameManager
var _real_sugar_manager: RuntimeSugarWheelMinigameManager
var _real_paper_manager: RuntimePaperCraftMinigameManager
var _water_probe: WaterPreviewProbe
var _sugar_probe: SugarWheelPreviewProbe
var _paper_probe: PaperCraftPreviewProbe


func _ready() -> void:
	# Tests call start(options) explicitly.  This also prevents the engine adapter
	# from consuming the test runner's own command-line arguments.
	set_meta("suppressSceneOnEnter", true)
	set_process(false)


func install_trace_listeners() -> void:
	if _trace_listeners_installed:
		return
	_trace_listeners_installed = true
	event_bus.on("quest:accepted", Callable(self, "_on_startup_quest_accepted"))
	event_bus.on("scene:enter", Callable(self, "_on_startup_scene_enter"))


func _load_game_config() -> void:
	await super()
	game_config.initialScene = INITIAL_SCENE
	game_config.initialQuest = INITIAL_QUEST
	game_config.erase("initialCutscene")
	game_config.erase("initialCutsceneDoneFlag")


func setup_player(options: Dictionary = {}) -> void:
	trace.push_back("setup_player:%s" % str(options.get("deferAvatar") == true).to_lower())
	await super(options)


func _try_start_initial_prologue(_config: Dictionary) -> void:
	trace.push_back("initial_prologue")


# These methods deliberately retain the source Game.ts names.  They are the
# behavior seams used by startDevMode's staged route, not test-only launch
# helpers.  The contract replaces expensive cutscenes/minigames with traces.
func load_narrative_warps() -> void:
	trace.push_back("load_warps")
	narrative_warps = [{"id": "warp-a", "label": "Warp A", "scene": "test_room_a"}]
	_install_minigame_probes()


func enter_narrative_warp(id: String) -> void:
	route_action_trace.push_back("narrative:%s" % id)


func dev_play_cutscene(id: String) -> void:
	route_action_trace.push_back("cutscene:%s" % id)
	trace.push_back("route_cutscene:process=%s:ready=%s" % [
		str(is_processing()).to_lower(),
		str(runtime_ready).to_lower(),
	])
	route_started = true
	match guard_on_play_cutscene:
		"teardown":
			destroy()
			return
		"renderer":
			# Simulate the source renderer-lost guard without prematurely freeing
			# the whole render tree; normal Game.destroy still owns final cleanup.
			renderer._initialized = false
			return
	while block_play_cutscene and not release_blocked_route:
		await get_tree().process_frame


func dev_load_scene(id: String) -> void:
	route_action_trace.push_back("scene:%s" % id)


func dev_reload() -> void:
	route_action_trace.push_back("reload")


func get_dev_scene_ids() -> Array[String]:
	return ["dev_room", "test_room_a"]


func get_dev_scene_entries() -> Array:
	return [
		{"id": "dev_room", "name": "Dev Room"},
		{"id": "test_room_a", "name": "Test Room A"},
	]


func get_narrative_warp_entries() -> Array:
	return narrative_warps.map(func(warp: Dictionary) -> Dictionary:
		return {"id": str(warp.get("id", "")), "label": str(warp.get("label", ""))}
	)


func setup_runtime_command_polling() -> void:
	trace.push_back("command_polling:process=%s:ready=%s" % [
		str(is_processing()).to_lower(),
		str(runtime_ready).to_lower(),
	])
	# RuntimeCommandBridge is the Godot platform adapter for the source command
	# poller.  Construct it here so the test still asserts the real ownership
	# boundary while avoiding any external request/response files.
	if runtime_command_bridge == null:
		runtime_command_bridge = RuntimeCommandBridge.new()
		runtime_command_bridge.bind(
			Callable(self, "build_runtime_debug_snapshot"),
			runtime_boot_id,
			Callable(self, "apply_runtime_command"),
		)
		add_child(runtime_command_bridge)


func publish_runtime_debug_snapshot(reason: String) -> void:
	trace.push_back("snapshot:%s" % reason)


func reset_route_probe() -> void:
	route_action_trace.clear()
	route_started = false
	release_blocked_route = false
	block_play_cutscene = false
	guard_on_play_cutscene = ""
	dev_startup_route = Callable()
	if dev_mode_ui != null:
		dev_mode_ui.destroy()
		dev_mode_ui = null
	if scene_manager != null and not scene_manager.get_current_scene_id().is_empty():
		scene_manager.unload_scene()


func destroy() -> void:
	if _trace_listeners_installed and event_bus != null:
		event_bus.off("quest:accepted", Callable(self, "_on_startup_quest_accepted"))
		event_bus.off("scene:enter", Callable(self, "_on_startup_scene_enter"))
		_trace_listeners_installed = false
	_restore_real_minigame_managers()
	super()
	_free_minigame_probes()


func _on_startup_quest_accepted(payload: Variant) -> void:
	if payload is Dictionary and str(payload.get("questId", "")) == INITIAL_QUEST:
		trace.push_back("quest:%s" % INITIAL_QUEST)


func _on_startup_scene_enter(payload: Variant) -> void:
	if not payload is Dictionary:
		return
	var scene_id := str(payload.get("sceneId", ""))
	if scene_id in [INITIAL_SCENE, "test_room_a", "dev_room"]:
		trace.push_back("scene:%s" % scene_id)


func _install_minigame_probes() -> void:
	if _water_probe != null:
		return
	_real_water_manager = water_minigame_manager
	_real_sugar_manager = sugar_wheel_minigame_manager
	_real_paper_manager = paper_craft_minigame_manager
	_water_probe = WaterPreviewProbe.new(route_action_trace)
	_sugar_probe = SugarWheelPreviewProbe.new(route_action_trace)
	_paper_probe = PaperCraftPreviewProbe.new(route_action_trace)
	water_minigame_manager = _water_probe
	sugar_wheel_minigame_manager = _sugar_probe
	paper_craft_minigame_manager = _paper_probe


func _restore_real_minigame_managers() -> void:
	if _real_water_manager != null:
		water_minigame_manager = _real_water_manager
	if _real_sugar_manager != null:
		sugar_wheel_minigame_manager = _real_sugar_manager
	if _real_paper_manager != null:
		paper_craft_minigame_manager = _real_paper_manager


func _free_minigame_probes() -> void:
	for probe: Node in [_water_probe, _sugar_probe, _paper_probe]:
		if probe != null and is_instance_valid(probe):
			probe.free()
	_water_probe = null
	_sugar_probe = null
	_paper_probe = null
	_real_water_manager = null
	_real_sugar_manager = null
	_real_paper_manager = null
