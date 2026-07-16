extends Node

const GameHarnessScript := preload("res://tests/support/scene_lifecycle_game_harness.gd")

const DEPTH_SCENE_ID := "test_room_a"
const NO_DEPTH_SCENE_ID := "义庄"

var game: Node
var trace: Array[String] = []
var enter_snapshot: Dictionary = {}
var ready_snapshot: Dictionary = {}
var reveal_snapshot: Dictionary = {}
var before_unload_snapshot: Dictionary = {}
var no_depth_ready_snapshot: Dictionary = {}
var tracked_hotspot: RuntimeHotspot
var tracked_hotspot_filter: Variant = null


func _ready() -> void:
	await _run_contract()
	print("Game scene enter/ready/reveal/density/unload direct-translation test: PASS")
	get_tree().quit(0)


func _run_contract() -> void:
	game = GameHarnessScript.new()
	game.set_meta("suppressSceneOnEnter", true)
	add_child(game)
	await _wait_until_runtime_ready()
	# Scene audio is outside this contract.  Stop the initial ambience and keep
	# subsequent loads from creating playback objects that would obscure Node /
	# RefCounted lifecycle leaks owned by the behavior under test.
	game.audio_manager.stop_all_playback()
	game.scene_manager.set_audio_applier()
	await get_tree().process_frame

	# Register after Game.setupSceneReadyHandler: EventBus preserves insertion
	# order, so these probes observe the completed Game handler at ready/unload.
	game.event_bus.on("scene:enter", Callable(self, "_capture_scene_enter"))
	game.event_bus.on("scene:ready", Callable(self, "_capture_scene_ready"))
	game.event_bus.on("scene:beforeUnload", Callable(self, "_capture_before_unload"))

	game.scene_manager.unload_scene()
	trace.clear()
	assert(await game.scene_manager.load_scene(
		DEPTH_SCENE_ID,
		"",
		null,
		null,
		Callable(),
		Callable(self, "_capture_reveal"),
	))

	# Keep the old filter alive as an ownership probe.  At beforeUnload, Game
	# must have detached/removed/destroyed it before SceneManager starts freeing
	# the hotspot instances.
	game.scene_manager.unload_scene()

	# Pixel-density matching is a background-density feature, not a depth or
	# entity-lighting feature.  Disable lighting and use a scene with no depth
	# map so an accidental `SceneDepthSystem.isActive` gate cannot make this pass.
	var lighting: Dictionary = game.game_config.get("entityLighting", {}).duplicate(true)
	lighting.enabled = false
	game.game_config.entityLighting = lighting
	assert(await game.scene_manager.load_scene(NO_DEPTH_SCENE_ID))

	var checks := {
		"event order": trace.slice(0, 3) == ["enter", "ready", "reveal"],
		"enter depth/light/world commit": enter_snapshot.get("depthCommitted") == true \
			and enter_snapshot.get("lightingCommitted") == true \
			and enter_snapshot.get("worldFilterCommitted") == true,
		"enter has no Game entity assembly": enter_snapshot.get("playerFilterAbsent") == true \
			and enter_snapshot.get("npcFiltersAbsent") == true \
			and enter_snapshot.get("hotspotFiltersAbsent") == true \
			and enter_snapshot.get("shadowOwnersAbsent") == true,
		"ready entity filters": ready_snapshot.get("playerFilterReady") == true \
			and ready_snapshot.get("npcFiltersReady") == true \
			and ready_snapshot.get("hotspotFiltersReady") == true,
		"ready shadows/AO": ready_snapshot.get("shadowOwnersReady") == true \
			and ready_snapshot.get("aoReady") == true,
		"ready density/patrol": ready_snapshot.get("densityReady") == true \
			and ready_snapshot.get("eligiblePatrolCount", 0) > 0 \
			and ready_snapshot.get("eligiblePatrolsRunning") == true,
		"ready completed before reveal": reveal_snapshot.get("readyWasLastEvent") == true \
			and reveal_snapshot.get("filtersReady") == true \
			and reveal_snapshot.get("shadowsReady") == true \
			and reveal_snapshot.get("densityReady") == true \
			and reveal_snapshot.get("patrolsRunning") == true,
		"beforeUnload owns hotspot filter cleanup": before_unload_snapshot.get("detached") == true \
			and before_unload_snapshot.get("removed") == true \
			and before_unload_snapshot.get("destroyed") == true,
		"no-depth density remains independent": no_depth_ready_snapshot.get("depthAndLightingInactive") == true \
			and no_depth_ready_snapshot.get("backgroundDensityAvailable") == true \
			and no_depth_ready_snapshot.get("playerDensityReady") == true \
			and no_depth_ready_snapshot.get("npcDensityReady") == true \
			and no_depth_ready_snapshot.get("hotspotDensityReady") == true,
	}

	await _cleanup()
	# AudioServer releases stopped WAV playback on its mixer tick rather than on
	# the scene-tree frame that frees AudioStreamPlayer.  Match the dedicated
	# AudioManager teardown test's drain window so strict leak detection is real.
	await get_tree().create_timer(0.5).timeout
	for label: String in checks:
		assert(checks[label], label)


func _wait_until_runtime_ready() -> void:
	var frames := 0
	while not game.runtime_ready and frames < 600:
		frames += 1
		await get_tree().process_frame
	assert(game.runtime_ready, "bootstrap did not finish within 600 frames")


func _capture_scene_enter(payload: Variant) -> void:
	if not payload is Dictionary or str(payload.get("sceneId", "")) != DEPTH_SCENE_ID:
		return
	trace.push_back("enter")
	enter_snapshot = {
		"depthCommitted": game.scene_depth_system.current_scene_id == DEPTH_SCENE_ID \
			and game.scene_depth_system.current_depth_texture != null \
			and game.scene_depth_system.current_config is Dictionary,
		"lightingCommitted": game.scene_depth_system.is_lighting_enabled \
			and game.current_light_env is Dictionary,
		"worldFilterCommitted": game.renderer.world_filter_pipeline.get_filters().size() == 1,
		"playerFilterAbsent": game.player_depth_filter == null \
			and RuntimeSceneEntityFilterBinding.get_filter(game.player.sprite.container) == null,
		"npcFiltersAbsent": _all_npc_filters(false),
		"hotspotFiltersAbsent": _all_hotspot_filters(false),
		"shadowOwnersAbsent": game.entity_shadows.is_empty(),
	}


func _capture_scene_ready(_payload: Variant) -> void:
	var scene_id: String = game.scene_manager.get_current_scene_id()
	if scene_id == DEPTH_SCENE_ID:
		trace.push_back("ready")
		var player_filter: Variant = game.player_depth_filter
		var env: Dictionary = game.current_light_env
		var mode := str(env.get("shadow", {}).get("mode", "off"))
		var expected_contact := float(env.get("ao", {}).get("contact", 0.0)) if mode == "off" else 0.0
		var expected_form := float(env.get("ao", {}).get("form", 0.0)) if mode != "off" else 0.0
		var material: ShaderMaterial = player_filter.material if player_filter != null else null
		var eligible := _eligible_patrol_npcs()
		ready_snapshot = {
			"playerFilterReady": player_filter != null \
				and RuntimeSceneEntityFilterBinding.get_filter(game.player.sprite.container) == player_filter,
			"npcFiltersReady": _all_npc_filters(true),
			"hotspotFiltersReady": _all_hotspot_filters(true),
			"shadowOwnersReady": _all_expected_shadow_owners_present(),
			"aoReady": material != null \
				and is_equal_approx(float(material.get_shader_parameter("tone_strength")), float(env.get("toneStrength", 0.0))) \
				and is_equal_approx(float(material.get_shader_parameter("ao_contact")), expected_contact) \
				and is_equal_approx(float(material.get_shader_parameter("ao_form")), expected_form),
			"densityReady": _all_entity_density_ready(),
			"eligiblePatrolCount": eligible.size(),
			"eligiblePatrolsRunning": eligible.all(func(npc: RuntimeNpc) -> bool: return npc.is_moving_to_target()),
		}
		for hotspot: RuntimeHotspot in game.scene_manager.get_current_hotspots():
			if hotspot.has_depth_display_image():
				tracked_hotspot = hotspot
				tracked_hotspot_filter = hotspot.get_depth_occlusion_filter()
				break
	elif scene_id == NO_DEPTH_SCENE_ID:
		no_depth_ready_snapshot = {
			"depthAndLightingInactive": not game.scene_depth_system.is_active \
				and game.player_depth_filter == null \
				and game.entity_shadows.is_empty(),
			"backgroundDensityAvailable": game.scene_manager.get_background_texels_per_world() != null,
			"playerDensityReady": game.player.sprite.get_pixel_density_match_active(),
			"npcDensityReady": _all_npc_density_ready(),
			"hotspotDensityReady": _all_hotspot_density_ready(),
		}


func _capture_reveal() -> void:
	trace.push_back("reveal")
	reveal_snapshot = {
		"readyWasLastEvent": trace.size() >= 2 and trace[-2] == "ready",
		"filtersReady": ready_snapshot.get("playerFilterReady") == true \
			and ready_snapshot.get("npcFiltersReady") == true \
			and ready_snapshot.get("hotspotFiltersReady") == true,
		"shadowsReady": ready_snapshot.get("shadowOwnersReady") == true \
			and ready_snapshot.get("aoReady") == true,
		"densityReady": ready_snapshot.get("densityReady") == true,
		"patrolsRunning": ready_snapshot.get("eligiblePatrolsRunning") == true,
	}


func _capture_before_unload(_payload: Variant) -> void:
	if game.scene_manager.get_current_scene_id() != DEPTH_SCENE_ID:
		return
	before_unload_snapshot = {
		"detached": tracked_hotspot != null and tracked_hotspot.get_depth_occlusion_filter() == null,
		"removed": tracked_hotspot_filter != null and not game.scene_depth_system.filters.has(tracked_hotspot_filter),
		"destroyed": tracked_hotspot_filter != null and tracked_hotspot_filter.destroyed,
	}


func _all_npc_filters(expected_attached: bool) -> bool:
	var considered := 0
	for npc: RuntimeNpc in game.scene_manager.get_current_npcs():
		if npc.sprite == null or npc.def.get("renderRaw") == true:
			continue
		considered += 1
		var attached := RuntimeSceneEntityFilterBinding.get_filter(npc.container) != null
		if attached != expected_attached:
			return false
	return considered > 0


func _all_hotspot_filters(expected_attached: bool) -> bool:
	var considered := 0
	for hotspot: RuntimeHotspot in game.scene_manager.get_current_hotspots():
		if not hotspot.has_depth_display_image():
			continue
		considered += 1
		if (hotspot.get_depth_occlusion_filter() != null) != expected_attached:
			return false
	return considered > 0


func _all_expected_shadow_owners_present() -> bool:
	if not game.entity_shadows.has("player"):
		return false
	for npc: RuntimeNpc in game.scene_manager.get_current_npcs():
		if npc.def.get("castShadow") != false and not game.entity_shadows.has(npc.get_id()):
			return false
	for hotspot: RuntimeHotspot in game.scene_manager.get_current_hotspots():
		if hotspot.has_depth_display_image() and hotspot.def.get("castShadow") != false \
			and not game.entity_shadows.has("hotspot:%s" % hotspot.get_id()):
			return false
	return true


func _eligible_patrol_npcs() -> Array[RuntimeNpc]:
	var result: Array[RuntimeNpc] = []
	for npc: RuntimeNpc in game.scene_manager.get_current_npcs():
		var patrol: Variant = npc.def.get("patrol")
		if npc.container.visible and patrol is Dictionary \
			and patrol.get("route") is Array and not patrol.route.is_empty() \
			and not game.scene_manager.is_npc_patrol_persistently_disabled(npc.get_id()):
			result.push_back(npc)
	return result


func _all_entity_density_ready() -> bool:
	return game.player.sprite.get_pixel_density_match_active() \
		and _all_npc_density_ready() \
		and _all_hotspot_density_ready()


func _all_npc_density_ready() -> bool:
	var considered := 0
	for npc: RuntimeNpc in game.scene_manager.get_current_npcs():
		if npc.def.get("renderRaw") == true:
			continue
		considered += 1
		if npc.sprite == null or not npc.sprite.get_pixel_density_match_active():
			return false
	return considered > 0


func _all_hotspot_density_ready() -> bool:
	var considered := 0
	for hotspot: RuntimeHotspot in game.scene_manager.get_current_hotspots():
		if not hotspot.has_depth_display_image():
			continue
		considered += 1
		if not hotspot.get_pixel_density_match_active():
			return false
	return considered > 0


func _cleanup() -> void:
	game.event_bus.off("scene:enter", Callable(self, "_capture_scene_enter"))
	game.event_bus.off("scene:ready", Callable(self, "_capture_scene_ready"))
	game.event_bus.off("scene:beforeUnload", Callable(self, "_capture_before_unload"))
	game.audio_manager.stop_all_playback()
	game.asset_manager.clear_cache()
	await get_tree().process_frame
	tracked_hotspot = null
	tracked_hotspot_filter = null
	remove_child(game)
	game.free()
	game = null
