extends Node

const RuntimeCharacterRegistryScript := preload("res://scripts/data/character_registry.gd")

var replaced_move_resolved := false


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var registry_raw: Variant = assets.load_json("/assets/data/character_registry.json")
	var registry := RuntimeCharacterRegistryScript.build_character_registry(registry_raw.get("characters")); assert(registry.size() == 4)
	var inherited := RuntimeCharacterRegistryScript.apply_character_defaults({"id": "clara_here", "characterId": "clara", "name": "", "x": 10, "y": 20, "interactionRange": 80}, registry)
	assert(inherited.name == "克拉拉" and inherited.animFile == "/resources/runtime/animation/克拉拉_anim/anim.json" and inherited.portraitSlug == "clara")
	var local_wins := RuntimeCharacterRegistryScript.apply_character_defaults({"id": "local", "characterId": "clara", "name": "本地名", "animFile": "/resources/runtime/animation/埃德加_anim/anim.json", "x": 1, "y": 2, "interactionRange": 3}, registry)
	assert(local_wins.name == "本地名" and local_wins.animFile.ends_with("埃德加_anim/anim.json"))
	var overridden := RuntimeNpc.apply_runtime_override(inherited, {"x": 30, "y": 40, "animFile": null, "initialAnimState": "walk", "enabled": false, "patrolDisabled": true, "animState": "idle"})
	assert(overridden.x == 30 and overridden.y == 40 and not overridden.has("animFile") and overridden.initialAnimState == "walk" and not overridden.has("enabled") and not overridden.has("patrolDisabled") and not overridden.has("animState"))
	assert(RuntimeCharacterRegistryScript.portrait_slug_from_anim_file("/resources/runtime/animation/克拉拉_anim/anim.json") == "克拉拉_anim")
	assert(RuntimeCharacterRegistryScript.portrait_slug_from_anim_file("/resources/runtime/animation/克拉拉_anim/other.json") == null)
	assert(RuntimeCharacterRegistryScript.portrait_slug_from_anim_file("") == null)
	assert(RuntimeCharacterRegistryScript.portrait_slug_from_anim_file(null) == null)
	assert(RuntimeCharacterRegistryScript.build_character_registry([{"id": "  spaced  ", "name": "kept"}]).has("spaced"))

	var npc := RuntimeNpc.new({"id": "npc_test", "name": "测试", "x": 10, "y": 20, "interactionRange": 75, "initialFacing": "left", "animFile": inherited.animFile, "portraitSlug": inherited.portraitSlug, "patrol": {"route": [{"x": 10, "y": 20}, {"x": 30, "y": 20}], "speed": 10, "moveAnimState": "walk"}})
	add_child(npc.container); assert(npc.get_x() == 10 and npc.get_y() == 20 and npc.container.position == Vector2(10, 20) and npc.get_facing() == -1 and npc.get_interaction_range() == 75 and npc.name_label.pivot_offset == Vector2(50, 0))
	var sprite_loaded := npc.load_sprite_from_path(inherited.animFile, assets, "idle")
	if not sprite_loaded: print("NPC sprite load diagnostic: ", inherited.animFile, " / ", assets.get_last_error(), " / ", assets.get_stats())
	assert(sprite_loaded); assert(npc.sprite != null and npc.get_rest_anim_state() == "idle" and npc.get_world_size().height > 0 and npc.get_current_portrait_slug() == "clara")
	npc.show_prompt(); assert(npc.prompt_icon != null and npc.prompt_icon.pivot_offset == Vector2(12, 12)); npc.set_facing(1, 0); assert(npc.get_facing() == 1 and npc.prompt_icon.scale.x == 1); npc.hide_prompt(); assert(npc.prompt_icon == null)
	npc.set_derived_base_visible(false); assert(not npc.container.visible); npc.set_visible(false); npc.set_derived_base_visible(true); assert(not npc.container.visible); npc.set_visible(true); assert(npc.container.visible); npc.set_condition_visible(false); assert(not npc.container.visible); npc.set_condition_visible(true); assert(npc.container.visible)

	npc.move_to(30, 20, 10, "walk", true); assert(npc.is_moving_to_target()); npc.cutscene_update(1.0); assert(npc.get_x() == 20 and npc.sprite.get_current_state() == "walk")
	npc.pause_patrol_and_face_for_dialogue(0, 20); await get_tree().process_frame; assert(npc.is_patrol_paused_for_dialogue() and not npc.is_moving_to_target() and npc.consume_patrol_skip_waypoint_advance() and not npc.consume_patrol_skip_waypoint_advance() and npc.get_facing() == -1)
	npc.on_dialogue_end(); assert(not npc.is_patrol_paused_for_dialogue() and npc.get_facing() == 1)
	npc.move_to(30, 20, 10, "walk", true); npc.cutscene_update(1.0); await get_tree().process_frame; assert(npc.get_x() == 30 and not npc.is_moving_to_target() and npc.sprite.get_current_state() == "idle")
	var before := npc.sprite.get_frame_index(); npc.move_to(30, 20, 10, "walk"); await get_tree().process_frame; assert(not npc.is_moving_to_target() and npc.sprite.get_frame_index() == before)
	_track_replaced_move(npc, 40, 20)
	assert(not replaced_move_resolved)
	npc.move_to(31, 20, 10, null, null); npc.cutscene_update(0.1); await get_tree().process_frame; assert(npc.get_x() == 31 and not npc.is_moving_to_target() and npc.sprite.get_current_state() == "idle")
	assert(replaced_move_resolved)
	npc.apply_entity_pixel_density_match(true); assert(npc.sprite.get_pixel_density_match_active())
	await get_tree().process_frame
	npc.destroy_npc(); assert(npc.is_destroyed()); assets.dispose()

	var scene_files: Array[String] = []; _collect_json("%s/public/assets/scenes" % repository, scene_files)
	var npc_count := 0; var character_refs := 0; var animated := 0; var patrols := 0
	for path: String in scene_files:
		var scene: Variant = JSON.parse_string(FileAccess.get_file_as_string(path)); assert(scene is Dictionary)
		for npc_def: Variant in scene.get("npcs", []):
			if not npc_def is Dictionary: continue
			npc_count += 1; character_refs += int(npc_def.has("characterId")); animated += int(npc_def.has("animFile")); patrols += int(npc_def.has("patrol"))
	assert(scene_files.size() == 29 and npc_count == 72 and character_refs == 9 and animated == 62 and patrols == 11)
	print("Npc registry/visibility/movement/patrol contract test: PASS"); get_tree().quit(0)


func _track_replaced_move(npc: RuntimeNpc, x: float, y: float) -> void:
	await npc.move_to(x, y, 10)
	replaced_move_resolved = true


func _collect_json(path: String, output: Array[String]) -> void:
	var dir := DirAccess.open(path); assert(dir != null); dir.list_dir_begin(); var name := dir.get_next()
	while not name.is_empty():
		if name.ends_with(".json") and not dir.current_is_dir(): output.push_back("%s/%s" % [path, name])
		name = dir.get_next()
	dir.list_dir_end(); output.sort()
