extends Node

const SceneQueries := preload("res://tests/support/scene_queries.gd")
const AssetProbeScript := preload("res://tests/support/hotspot_display_asset_manager_probe.gd")
const RuntimeCharacterRegistryScript := preload("res://scripts/data/character_registry.gd")


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var locator := RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository); var assets := RuntimeAssetManager.new({}, locator); var events := RuntimeEventBus.new()
	var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.set_asset_manager(assets); renderer.init(); var camera := RuntimeCamera.new(renderer.world_container); camera.set_screen_size(800, 600); var input := RuntimeInputManager.new(); add_child(input); var player := RuntimePlayer.new(input); renderer.entity_layer.add_child(player.sprite)
	var manager := RuntimeSceneManager.new(assets, events, renderer); add_child(manager); manager.init({}); preload("res://tests/support/scene_manager_wiring.gd").bind(manager, player, camera)
	var registry_raw: Variant = assets.load_json("/assets/data/character_registry.json")
	manager.set_character_registry(RuntimeCharacterRegistryScript.build_character_registry(registry_raw.get("characters") if registry_raw is Dictionary else null))
	var files: Array[String] = []; _collect_json("%s/public/assets/scenes" % repository, files); assert(files.size() == 29 and manager.character_registry.size() == 4)
	var raw_npcs := 0; var raw_hotspots := 0; var raw_zones := 0; var instantiated_npcs := 0; var instantiated_hotspots := 0; var backgrounds := 0; var placeholder_scenes := 0
	for path: String in files:
		var raw: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path)); var id := str(raw.id); raw_npcs += raw.get("npcs", []).size(); raw_hotspots += raw.get("hotspots", []).size(); raw_zones += raw.get("zones", []).size(); backgrounds += raw.get("backgrounds", []).size(); placeholder_scenes += int(raw.get("backgrounds", []).is_empty())
		if not manager.get_current_scene_id().is_empty(): manager.unload_scene()
		assert(await manager.load_scene(id)); var scene := manager.get_current_scene_data(); assert(scene.id == id and float(scene.worldWidth) > 0 and float(scene.worldHeight) > 0 and manager.scene_background != null)
		var expected_npcs := 0; for definition: Dictionary in raw.get("npcs", []): expected_npcs += int(not _cutscene_only(definition))
		var expected_hotspots := 0; for definition: Dictionary in raw.get("hotspots", []): expected_hotspots += int(not _cutscene_only(definition))
		assert(manager.get_current_npcs().size() == expected_npcs and manager.get_current_hotspots().size() == expected_hotspots)
		instantiated_npcs += expected_npcs; instantiated_hotspots += expected_hotspots
	assert(raw_npcs == 72 and raw_hotspots == 119 and raw_zones == 43 and backgrounds == 28 and placeholder_scenes == 1)
	assert(instantiated_npcs > 0 and instantiated_hotspots > 0)
	manager.unload_scene(); assert(await manager.load_scene("teahouse", "from_street")); assert(player.get_x() == 151.9 and player.get_y() == 171.4 and camera.get_zoom() == 1.5 and camera.get_pixels_per_unit() == 1.0 and manager.get_npc_by_id("storyteller_zhang") != null and SceneQueries.hotspot(manager, "exit_to_street") != null)
	var teahouse_background: Sprite2D = manager.scene_background.get_child(0); assert(teahouse_background.texture_filter == CanvasItem.TEXTURE_FILTER_LINEAR and teahouse_background.material == null)
	assert(int(manager.get_current_scene_data().worldHeight) == 525)
	manager.unload_scene(); assert(await manager.load_scene("test_room_a")); var upscaled_background: Sprite2D = manager.scene_background.get_child(0); assert(upscaled_background.texture_filter == CanvasItem.TEXTURE_FILTER_LINEAR and upscaled_background.material == null)
	var patrol_npc: RuntimeNpc = manager.get_npc_by_id("new_npc_2"); assert(patrol_npc != null and patrol_npc.def.get("patrol") is Dictionary)
	var patrol_start := Vector2(patrol_npc.get_x(), patrol_npc.get_y()); manager.update(0.02)
	assert(Vector2(patrol_npc.get_x(), patrol_npc.get_y()).is_equal_approx(patrol_start), "SceneManager must not own Game-level patrol/tick advancement")
	await _test_primary_background_texture_lifecycle(renderer, events)
	manager.destroy(); remove_child(manager); manager.free(); player.destroy_player(); input.destroy(); remove_child(input); input.free(); assets.dispose(); renderer.destroy(); remove_child(renderer); renderer.free(); events.clear()
	print("SceneManager all-scene JSON/asset/instantiate contract test: PASS"); get_tree().quit(0)


func _test_primary_background_texture_lifecycle(renderer: RuntimeRenderer, events: RuntimeEventBus) -> void:
	var probe: RuntimeAssetManager = AssetProbeScript.new()
	var successful_image := Image.create(17, 9, false, Image.FORMAT_RGBA8)
	successful_image.fill(Color("9b6a42"))
	var successful_texture := ImageTexture.create_from_image(successful_image)
	var missing_path := "/virtual/scenes/primary_cache_probe/missing.png"
	var successful_path := "/virtual/scenes/primary_cache_probe/success.png"
	probe.scenes.primary_cache_probe = {
		"id": "primary_cache_probe",
		"name": "Primary cache probe",
		"worldWidth": 100.0,
		"worldHeight": 50.0,
		"backgrounds": [
			{"image": missing_path, "z": 0},
			{"image": successful_path, "z": 1},
		],
		"hotspots": [],
		"npcs": [],
		"zones": [],
	}
	probe.textures[successful_path] = successful_texture
	var probe_manager := RuntimeSceneManager.new(probe, events, renderer)
	add_child(probe_manager)
	probe_manager.init({})
	assert(probe_manager.get_primary_background_texture() == null)
	assert(await probe_manager.load_scene("primary_cache_probe"))
	assert(probe_manager.scene_background.get_child_count() == 1)
	assert(probe_manager.scene_background.get_child(0).texture == successful_texture)
	assert(probe_manager.get_primary_background_texture() == successful_texture, "primary texture must be the first background that actually mounted")
	probe_manager.unload_scene()
	assert(probe_manager.get_primary_background_texture() == null, "unload_scene must clear the primary texture cache")
	assert(await probe_manager.load_scene("primary_cache_probe"))
	assert(probe_manager.get_primary_background_texture() == successful_texture)
	probe_manager.destroy()
	assert(probe_manager.get_primary_background_texture() == null, "destroy must clear through unload_scene")
	remove_child(probe_manager)
	probe_manager.free()
	probe.dispose()


func _cutscene_only(definition: Dictionary) -> bool: return definition.get("cutsceneIds") is Array and not definition.cutsceneIds.is_empty() and definition.get("cutsceneOnly") != false
func _collect_json(path: String, output: Array[String]) -> void:
	var dir := DirAccess.open(path); assert(dir != null); dir.list_dir_begin(); var name := dir.get_next()
	while not name.is_empty():
		if name.ends_with(".json") and not dir.current_is_dir(): output.push_back("%s/%s" % [path, name])
		name = dir.get_next()
	dir.list_dir_end(); output.sort()
