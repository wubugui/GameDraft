extends Node

var calls: Array[String] = []
var movement_fn: Variant = null
var policy_fn: Variant = null
var lighting: Variant = null
var game_state := RuntimeGameStateController.EXPLORING


func _ready() -> void:
	await _run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var bus := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(bus)
	var executor := RuntimeActionExecutor.new(bus, flags)
	var narrative := RuntimeNarrativeStateManager.new(bus, flags, executor)
	narrative.init({"eventBus": bus, "flagStore": flags, "strings": null, "assetManager": assets})
	var plane := RuntimePlaneReconciler.new(bus)
	plane.init({"eventBus": bus, "flagStore": flags, "strings": null, "assetManager": assets})
	plane.bind_runtime({
		"narrative": narrative,
		"setPlayerMovementModifier": Callable(self, "_set_movement"),
		"setPlaneInteractionPolicy": Callable(self, "_set_policy"),
		"refreshEntitiesForPlaneChange": Callable(self, "_refresh_entities"),
		"refreshZonesForPlaneChange": Callable(self, "_refresh_zones"),
		"setCameraZoom": Callable(self, "_set_zoom"),
		"restoreSceneCameraZoom": Callable(self, "_restore_zoom"),
		"applyPlaneLightEnvOverride": Callable(self, "_set_lighting"),
		"damagePlayer": Callable(self, "_damage"),
		"getGameState": Callable(self, "_get_game_state"),
	})
	assert(plane.load_defs() and plane.definition_count() == 2)
	assert(plane.get_active_plane_id() == "normal" and plane.get_active_plane_membership() == "shared")
	assert(plane.is_map_travel_allowed())

	plane.register_defs([
		{"id": "normal", "label": "常态"},
		{"id": "背尸", "movement": {"driftX": -28, "speedScale": 0.62, "allowRun": false}, "interaction": {"canPickup": false}, "camera": {"zoom": 1.25}, "travel": {"allowMapTravel": false}, "healthDrainPerSec": 0.35},
		{"id": "喊名", "membership": "exclusive", "movement": {"driftX": 10}},
		{"id": "背尸喊名", "extends": "背尸", "movement": {"driftX": 10}},
		{"id": "orphan", "extends": "missing", "camera": {"zoom": 2}},
		{"id": "loop_a", "extends": "loop_b", "camera": {"zoom": 3}},
		{"id": "loop_b", "extends": "loop_a"},
		{"id": "bad", "camera": {"zoom": -1}},
	])
	assert(plane.definition_count() == 7)
	var graph := {"id": "carry", "ownerType": "flow", "initialState": "idle", "states": {
		"idle": {"id": "idle"},
		"carrying": {"id": "carrying", "activePlane": "背尸"},
		"calling": {"id": "calling", "activePlane": "背尸喊名"},
		"done": {"id": "done"},
	}, "transitions": [
		{"id": "pick", "from": "idle", "to": "carrying", "signal": "pick"},
		{"id": "call", "from": "carrying", "to": "calling", "signal": "call"},
		{"id": "back", "from": "calling", "to": "carrying", "signal": "back"},
		{"id": "drop", "from": "carrying", "to": "done", "signal": "drop"},
	]}
	narrative.register_graphs([graph])
	await narrative.emit_narrative_signal({"signal": "pick"})
	assert(plane.get_active_plane_id() == "背尸")
	assert(movement_fn.call() == {"driftX": -28.0, "driftY": 0.0, "speedScale": 0.62, "allowRun": false})
	assert(policy_fn.call() == {"canPickup": false, "canInteractHotspots": true, "canTalkNpcs": true})
	assert(plane.get_active_camera_zoom() == 1.25 and not plane.is_map_travel_allowed())
	assert(calls.has("refresh:entities") and calls.has("refresh:zones") and calls.has("zoom:1.25"))

	await narrative.emit_narrative_signal({"signal": "call"})
	assert(plane.get_active_plane_id() == "背尸喊名")
	assert(movement_fn.call().driftX == 10.0 and movement_fn.call().speedScale == 1.0)
	assert(policy_fn.call().canPickup == false and plane.get_active_camera_zoom() == 1.25)
	await narrative.emit_narrative_signal({"signal": "back"})
	assert(plane.get_active_plane_id() == "背尸")

	assert(plane.activate_plane_manually("喊名"))
	assert(plane.get_active_plane_id() == "喊名" and plane.get_active_plane_membership() == "exclusive")
	assert(plane.get_debug_state().source == "manual")
	assert(not plane.activate_plane_manually("missing"))
	plane.deactivate_manual_plane()
	assert(plane.get_active_plane_id() == "背尸")
	bus.emit("cutscene:start", {})
	assert(plane.activate_plane_manually("喊名"))
	bus.emit("cutscene:end", {})
	assert(plane.get_active_plane_id() == "背尸")

	plane.update(2.0)
	plane.update(1.0)
	assert(calls.has("damage:1"))
	assert(plane.serialize().is_empty())
	assert(plane.activate_plane_manually("喊名"))
	plane.deserialize({})
	assert(plane.get_active_plane_id() == "背尸")

	# Zones wait outside Exploring, then refresh on the return edge.
	plane.update(0.0)
	game_state = RuntimeGameStateController.DIALOGUE
	var zone_count := calls.count("refresh:zones")
	await narrative.emit_narrative_signal({"signal": "drop"})
	assert(plane.get_active_plane_id() == "normal" and calls.count("refresh:zones") == zone_count)
	plane.update(0.0)
	game_state = RuntimeGameStateController.EXPLORING
	plane.update(0.0)
	assert(calls.count("refresh:zones") == zone_count + 1)
	assert(movement_fn == null and policy_fn == null and lighting == null)
	bus.emit("scene:ready", {})
	assert(plane.get_active_plane_id() == "normal")

	assert(plane.activate_plane_manually("orphan") and plane.get_active_camera_zoom() == 2.0)
	assert(plane.activate_plane_manually("loop_a") and plane.get_active_camera_zoom() == 3.0)
	assert(bus.listener_count() == 7)
	plane.destroy()
	assert(bus.listener_count() == 1 and plane.get_active_plane_id() == "normal")
	plane.free()
	narrative.destroy(); narrative.free()
	executor.destroy(); flags.destroy(); bus.clear(); assets.dispose()
	print("PlaneReconciler contract test: PASS")
	get_tree().quit(0)


func _set_movement(value: Variant) -> void: movement_fn = value; calls.push_back("movement:%s" % ("set" if value != null else "clear"))
func _set_policy(value: Variant) -> void: policy_fn = value; calls.push_back("policy:%s" % ("set" if value != null else "clear"))
func _refresh_entities() -> void: calls.push_back("refresh:entities")
func _refresh_zones() -> void: calls.push_back("refresh:zones")
func _set_zoom(value: Variant) -> void: calls.push_back("zoom:%s" % value)
func _restore_zoom() -> void: calls.push_back("zoom:restore")
func _set_lighting(value: Variant) -> void: lighting = value; calls.push_back("lighting:%s" % ("set" if value != null else "clear"))
func _damage(amount: int) -> void: calls.push_back("damage:%s" % amount)
func _get_game_state() -> String: return game_state
