extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")


class AssetManagerStub extends RuntimeAssetManager:
	var responses: Array = []
	var load_count := 0

	func load_json(_path: String) -> Variant:
		var response: Variant = responses[load_count] if load_count < responses.size() else {"__error": "missing"}
		load_count += 1
		if response is Dictionary and response.has("__error"):
			_last_error = str(response.__error)
			return null
		_last_error = ""
		return response


var calls: Array[String] = []
var movement_fn: Variant = null
var policy_fn: Variant = null
var lighting: Variant = null
var game_state := RuntimeDataTypes.EXPLORING
var damage_reject := false


func _ready() -> void:
	await _run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var bus := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(bus)
	var executor := RuntimeActionExecutor.new(bus, flags)
	var narrative := RuntimeNarrativeStateManager.new(bus, flags, executor)
	narrative.init({"eventBus": bus, "flagStore": flags, "strings": null, "assetManager": assets})

	# loadDefs mirrors the source Promise boundary: no init warns; successful
	# arrays replace the registry with shallow-flat definitions, rejection retains
	# it, and a fulfilled non-array clears it through registerDefs([]).
	var uninitialized_bus := RuntimeEventBus.new()
	var uninitialized := RuntimePlaneReconciler.new(uninitialized_bus)
	await uninitialized.load_defs()
	uninitialized.destroy()
	uninitialized.free()
	uninitialized_bus.clear()
	var nested_movement := {"driftX": 7}
	var first_definition := {"id": " first ", "movement": nested_movement}
	var stub_assets := AssetManagerStub.new()
	stub_assets.responses = [[first_definition], {"__error": "missing"}, {"not": "an array"}]
	var load_probe := RuntimePlaneReconciler.new(bus)
	load_probe.init({"eventBus": bus, "flagStore": flags, "strings": null, "assetManager": stub_assets})
	await load_probe.load_defs()
	assert(load_probe.defs.has(" first "))
	assert(not is_same(load_probe.defs[" first "], first_definition), "object spread creates a new flat definition")
	assert(is_same(load_probe.defs[" first "].movement, nested_movement), "object spread preserves nested slot identity")
	first_definition.note = "source-object"
	await load_probe.load_defs()
	assert(load_probe.defs.has(" first ") and not load_probe.defs[" first "].has("note"), "rejected load retains the prior flat map")
	await load_probe.load_defs()
	assert(load_probe.defs.is_empty(), "fulfilled non-array is registerDefs([]), not a rejected load")
	load_probe.destroy()
	load_probe.free()
	stub_assets.dispose()

	var plane := RuntimePlaneReconciler.new(bus)
	plane.init({"eventBus": bus, "flagStore": flags, "strings": null, "assetManager": assets})
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
	await plane.load_defs()
	assert(plane.defs.size() == 2)
	assert(plane.get_active_plane_id() == "normal" and plane.get_active_plane_membership() == "shared")
	assert(plane.is_map_travel_allowed())

	var parent_movement := {"driftX": -28, "speedScale": 0.62, "allowRun": false}
	var parent_interaction := {"canPickup": false}
	var parent_camera := {"zoom": 1.25}
	var child_movement := {"driftX": 10}
	var parent_definition := {
		"id": "背尸",
		"movement": parent_movement,
		"interaction": parent_interaction,
		"camera": parent_camera,
		"travel": {"allowMapTravel": false},
		"healthDrainPerSec": 0.35,
	}
	var child_definition := {"id": "背尸喊名", "extends": "背尸", "movement": child_movement}
	plane.register_defs([
		{"id": "normal", "label": "常态"},
		parent_definition,
		{"id": "喊名", "membership": "exclusive", "movement": {"driftX": 10}},
		child_definition,
		{"id": "orphan", "extends": "missing", "camera": {"zoom": 2}},
		{"id": "loop_a", "extends": "loop_b", "camera": {"zoom": 3}},
		{"id": "loop_b", "extends": "loop_a"},
		{"id": "bad", "camera": {"zoom": -1}},
	])
	assert(plane.defs.size() == 7)
	assert(not is_same(plane.defs["背尸"], parent_definition) and not is_same(plane.defs["背尸喊名"], child_definition))
	assert(is_same(plane.defs["背尸"].movement, parent_movement) and is_same(plane.defs["背尸"].interaction, parent_interaction))
	assert(is_same(plane.defs["背尸喊名"].movement, child_movement), "child-owned slot must replace the whole parent slot")
	assert(is_same(plane.defs["背尸喊名"].interaction, parent_interaction) and is_same(plane.defs["背尸喊名"].camera, parent_camera), "absent slots inherit by reference")

	var graph := {
		"id": "carry",
		"ownerType": "flow",
		"initialState": "idle",
		"states": {
			"idle": {"id": "idle"},
			"carrying": {"id": "carrying", "activePlane": "背尸"},
			"calling": {"id": "calling", "activePlane": "背尸喊名"},
			"done": {"id": "done"},
		},
		"transitions": [
			{"id": "pick", "from": "idle", "to": "carrying", "signal": "pick"},
			{"id": "call", "from": "carrying", "to": "calling", "signal": "call"},
			{"id": "back", "from": "calling", "to": "carrying", "signal": "back"},
			{"id": "drop", "from": "carrying", "to": "done", "signal": "drop"},
		],
	}
	narrative.register_graphs([graph])
	assert(EventBusProbe.listener_count(bus) == 7, "repeated init must keep exactly six PlaneReconciler listeners")
	await narrative.emit_narrative_signal({"signal": "pick"})
	assert(plane.get_active_plane_id() == "背尸")
	assert(movement_fn.call() == {"driftX": -28.0, "driftY": 0.0, "speedScale": 0.62, "allowRun": false})
	assert(policy_fn.call() == {"canPickup": false, "canInteractHotspots": true, "canTalkNpcs": true})
	assert(plane.get_active_camera_zoom() == 1.25 and not plane.is_map_travel_allowed())
	assert(calls.has("refresh:entities") and calls.has("refresh:zones") and calls.has("zoom:1.25"))
	var entity_refresh_count := calls.count("refresh:entities")
	var zone_refresh_count := calls.count("refresh:zones")
	bus.emit("scene:entitiesRebuilt", {})
	assert(calls.count("refresh:entities") == entity_refresh_count + 1 and calls.count("refresh:zones") == zone_refresh_count)

	await narrative.emit_narrative_signal({"signal": "call"})
	assert(plane.get_active_plane_id() == "背尸喊名")
	assert(movement_fn.call().driftX == 10.0 and movement_fn.call().speedScale == 1.0 and movement_fn.call().allowRun)
	assert(policy_fn.call().canPickup == false and plane.get_active_camera_zoom() == 1.25)
	await narrative.emit_narrative_signal({"signal": "back"})
	assert(plane.get_active_plane_id() == "背尸")

	assert(plane.activate_plane_manually("喊名"))
	assert(plane.get_active_plane_id() == "喊名" and plane.get_active_plane_membership() == "exclusive")
	assert(plane.get_debug_state().source == "manual")
	assert(not plane.activate_plane_manually(""))
	assert(not plane.activate_plane_manually("missing"))
	plane.deactivate_manual_plane()
	assert(plane.get_active_plane_id() == "背尸")
	bus.emit("cutscene:start", {})
	assert(plane.activate_plane_manually("喊名"))
	bus.emit("cutscene:end", {})
	assert(plane.get_active_plane_id() == "背尸")
	assert(plane.activate_plane_manually("喊名"))
	bus.emit("cutscene:start", {})
	bus.emit("cutscene:end", {})
	assert(plane.get_active_plane_id() == "喊名", "session override survives later cutscenes")
	plane.deactivate_manual_plane()

	plane.update(2.0)
	assert(not calls.any(func(value: String) -> bool: return value.begins_with("damage:")))
	plane.update(1.0)
	await get_tree().process_frame
	assert(calls.has("damage:1"))
	var damage_count := calls.filter(func(value: String) -> bool: return value.begins_with("damage:")).size()
	game_state = RuntimeDataTypes.DIALOGUE
	plane.update(10.0)
	assert(calls.filter(func(value: String) -> bool: return value.begins_with("damage:")).size() == damage_count)
	game_state = RuntimeDataTypes.EXPLORING
	plane.update(0.0)
	damage_reject = true
	plane.drain_accum = 0.0
	plane.update(3.0)
	await get_tree().process_frame
	await get_tree().process_frame
	damage_reject = false

	assert(plane.serialize().is_empty())
	assert(plane.activate_plane_manually("喊名"))
	bus.emit("save:restoring", {})
	assert(plane.manual_override_plane_id == null and plane.get_active_plane_id() == "喊名", "save:restoring clears the override field without eager reconcile")
	plane.deserialize({})
	assert(plane.get_active_plane_id() == "背尸")

	# Zones wait outside Exploring, then refresh on the return edge.
	plane.update(0.0)
	game_state = RuntimeDataTypes.DIALOGUE
	var zone_count := calls.count("refresh:zones")
	await narrative.emit_narrative_signal({"signal": "drop"})
	assert(plane.get_active_plane_id() == "normal" and calls.count("refresh:zones") == zone_count)
	plane.update(0.0)
	game_state = RuntimeDataTypes.EXPLORING
	plane.update(0.0)
	assert(calls.count("refresh:zones") == zone_count + 1)
	assert(movement_fn == null and policy_fn == null and lighting == null)
	var ready_refresh_count := calls.count("refresh:entities")
	bus.emit("scene:ready", {})
	assert(plane.get_active_plane_id() == "normal" and calls.count("refresh:entities") == ready_refresh_count + 1, "scene:ready reconciles even without an id change")

	assert(plane.activate_plane_manually("orphan") and plane.get_active_camera_zoom() == 2.0)
	assert(plane.activate_plane_manually("loop_a") and plane.get_active_camera_zoom() == 3.0)

	# Full recomputation permits several graphs naming the same plane, diagnoses
	# only distinct simultaneous planes, and warns once per unknown active id.
	var same_a := {"id": "same_a", "ownerType": "flow", "initialState": "on", "states": {"on": {"id": "on", "activePlane": "背尸"}}, "transitions": []}
	var same_b := {"id": "same_b", "ownerType": "flow", "initialState": "on", "states": {"on": {"id": "on", "activePlane": "背尸"}}, "transitions": []}
	narrative.register_graphs([same_a, same_b])
	bus.emit("scene:ready", {})
	assert(plane.get_active_plane_id() == "loop_a", "session manual override remains above narrative recomputation")
	plane.deactivate_manual_plane()
	assert(plane.get_active_plane_id() == "背尸" and plane.get_debug_state().namedBy.size() == 2)
	var different := {"id": "different", "ownerType": "flow", "initialState": "on", "states": {"on": {"id": "on", "activePlane": "喊名"}}, "transitions": []}
	narrative.register_graphs([same_a, different])
	bus.emit("scene:ready", {})
	assert(plane.get_active_plane_id() == "喊名")
	var unknown := {"id": "unknown", "ownerType": "flow", "initialState": "on", "states": {"on": {"id": "on", "activePlane": "ghost"}}, "transitions": []}
	narrative.register_graphs([unknown])
	bus.emit("scene:ready", {})
	bus.emit("scene:ready", {})
	assert(plane.get_active_plane_id() == "ghost" and plane.warned_unknown_plane_ids.size() == 1)
	assert(RuntimeDataTypes.CUTSCENE_ACTION_WHITELIST.has("activatePlane") and RuntimeDataTypes.CUTSCENE_ACTION_WHITELIST.has("deactivatePlane"))

	assert(plane.activate_plane_manually("背尸"))
	var restore_count := calls.count("zoom:restore")
	assert(EventBusProbe.listener_count(bus) == 7)
	plane.destroy()
	assert(EventBusProbe.listener_count(bus) == 1 and plane.get_active_plane_id() == "normal")
	assert(plane.binding == null and plane.defs.is_empty() and plane.last_naming.is_empty() and plane.warned_unknown_plane_ids.is_empty())
	assert(movement_fn == null and policy_fn == null and lighting == null and calls.count("zoom:restore") == restore_count + 1)
	calls.clear()
	bus.emit("scene:ready", {})
	bus.emit("cutscene:start", {})
	bus.emit("cutscene:end", {})
	assert(calls.is_empty() and plane.get_active_plane_id() == "normal")
	plane.free()
	narrative.destroy()
	narrative.free()
	executor.destroy()
	flags.destroy()
	bus.clear()
	assets.dispose()
	print("PlaneReconciler contract test: PASS")
	get_tree().quit(0)


func _set_movement(value: Variant) -> void:
	movement_fn = value
	calls.push_back("movement:%s" % ("set" if value != null else "clear"))


func _set_policy(value: Variant) -> void:
	policy_fn = value
	calls.push_back("policy:%s" % ("set" if value != null else "clear"))


func _refresh_entities() -> void:
	calls.push_back("refresh:entities")


func _refresh_zones() -> void:
	calls.push_back("refresh:zones")


func _set_zoom(value: Variant) -> void:
	calls.push_back("zoom:%s" % value)


func _restore_zoom() -> void:
	calls.push_back("zoom:restore")


func _set_lighting(value: Variant) -> void:
	lighting = value
	calls.push_back("lighting:%s" % ("set" if value != null else "clear"))


func _damage(amount: int) -> Variant:
	calls.push_back("damage:%s" % amount)
	await get_tree().process_frame
	return false if damage_reject else null


func _get_game_state() -> String:
	return game_state
