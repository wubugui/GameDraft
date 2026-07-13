extends Node


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var locator := RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository); var assets := RuntimeAssetManager.new(locator); var events := RuntimeEventBus.new()
	var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.set_asset_manager(assets); renderer.init_renderer(); var camera := RuntimeCamera.new(renderer.world_container); camera.set_screen_size(800, 600); var input := RuntimeInputManager.new(); add_child(input); var player := RuntimePlayer.new(input); renderer.entity_layer.add_child(player.sprite)
	var manager := RuntimeSceneManager.new(assets, events, renderer, player, camera); add_child(manager); manager.init({})
	var files: Array[String] = []; _collect_json("%s/public/assets/scenes" % repository, files); assert(files.size() == 27 and manager.character_registry.size() == 4)
	var raw_npcs := 0; var raw_hotspots := 0; var raw_zones := 0; var instantiated_npcs := 0; var instantiated_hotspots := 0; var backgrounds := 0; var placeholder_scenes := 0
	for path: String in files:
		var raw: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path)); var id := str(raw.id); raw_npcs += raw.get("npcs", []).size(); raw_hotspots += raw.get("hotspots", []).size(); raw_zones += raw.get("zones", []).size(); backgrounds += raw.get("backgrounds", []).size(); placeholder_scenes += int(raw.get("backgrounds", []).is_empty())
		assert(manager.load_scene(id)); var scene := manager.get_current_scene_data(); assert(scene.id == id and float(scene.worldWidth) > 0 and float(scene.worldHeight) > 0 and manager.scene_background != null)
		var expected_npcs := 0; for definition: Dictionary in raw.get("npcs", []): expected_npcs += int(not _cutscene_only(definition))
		var expected_hotspots := 0; for definition: Dictionary in raw.get("hotspots", []): expected_hotspots += int(not _cutscene_only(definition))
		assert(manager.get_current_npcs().size() == expected_npcs and manager.get_current_hotspots().size() == expected_hotspots)
		var diag := manager.get_diagnostics()
		if diag != {"backgroundFailures": [], "npcSpriteFailures": [], "hotspotImageFailures": []}:
			print("Scene diagnostics: ", id, " ", diag)
			if not diag.npcSpriteFailures.is_empty():
				var failed_id := str(diag.npcSpriteFailures[0].id); var failed_def: Dictionary = raw.npcs.filter(func(v: Dictionary) -> bool: return v.id == failed_id)[0]; var failed_manifest: Variant = assets.load_json(str(failed_def.animFile)); var failed_texture: Variant = assets.load_texture("%s/%s" % [str(failed_def.animFile).get_base_dir(), str(failed_manifest.get("spritesheet", ""))])
				print("Failed cache probe: manifest=", failed_manifest is Dictionary, " textureType=", typeof(failed_texture), " textureClass=", failed_texture.get_class() if failed_texture is Object else "not-object", " valid=", is_instance_valid(failed_texture) if failed_texture is Object else false)
		assert(diag == {"backgroundFailures": [], "npcSpriteFailures": [], "hotspotImageFailures": []})
		instantiated_npcs += expected_npcs; instantiated_hotspots += expected_hotspots
	assert(raw_npcs == 63 and raw_hotspots == 115 and raw_zones == 36 and backgrounds == 26 and placeholder_scenes == 1)
	assert(instantiated_npcs > 0 and instantiated_hotspots > 0)
	assert(manager.load_scene("teahouse", "from_street")); assert(player.get_x() == 151.9 and player.get_y() == 171.4 and camera.get_zoom() == 1.5 and camera.get_pixels_per_unit() == 1.0 and manager.get_npc_by_id("storyteller_zhang") != null and manager.get_hotspot_by_id("exit_to_street") != null)
	var teahouse_background: Sprite2D = manager.scene_background.get_child(0); assert(teahouse_background.texture_filter == CanvasItem.TEXTURE_FILTER_LINEAR and teahouse_background.material is ShaderMaterial)
	var teahouse_radius: Vector2 = teahouse_background.material.get_shader_parameter("radius_texels"); assert(teahouse_radius.x > 0.9 and is_equal_approx(teahouse_radius.x, teahouse_radius.y))
	assert(int(manager.get_current_scene_data().worldHeight) == 525 and manager.resolve_scene_display_name("teahouse") == "茶馆")
	assert(manager.load_scene("test_room_a")); var upscaled_background: Sprite2D = manager.scene_background.get_child(0); assert(upscaled_background.texture_filter == CanvasItem.TEXTURE_FILTER_LINEAR and upscaled_background.material == null)
	var patrol_npc: RuntimeNpc = manager.get_npc_by_id("new_npc_2"); assert(patrol_npc != null); var patrol_start := Vector2(patrol_npc.get_x(), patrol_npc.get_y()); manager.update(0.02); var patrol_delta := Vector2(patrol_npc.get_x(), patrol_npc.get_y()).distance_to(patrol_start); assert(absf(patrol_delta - 1.2) < 0.001)
	manager.destroy(); remove_child(manager); manager.free(); player.destroy_player(); input.destroy(); remove_child(input); input.free(); assets.dispose(); renderer.destroy_renderer(); remove_child(renderer); renderer.free(); events.clear()
	print("SceneManager 27-scene JSON/asset/instantiate contract test: PASS"); get_tree().quit(0)


func _cutscene_only(definition: Dictionary) -> bool: return definition.get("cutsceneIds") is Array and not definition.cutsceneIds.is_empty() and definition.get("cutsceneOnly") != false
func _collect_json(path: String, output: Array[String]) -> void:
	var dir := DirAccess.open(path); assert(dir != null); dir.list_dir_begin(); var name := dir.get_next()
	while not name.is_empty():
		if name.ends_with(".json") and not dir.current_is_dir(): output.push_back("%s/%s" % [path, name])
		name = dir.get_next()
	dir.list_dir_end(); output.sort()
