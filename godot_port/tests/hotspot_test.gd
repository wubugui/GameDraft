extends Node

const RuntimeHotspotCollisionScript := preload("res://scripts/utils/hotspot_collision.gd")


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var image_def := {"image": "/resources/runtime/images/illustrations/糖画摊_45度_生肖转盘.png", "worldWidth": 205.9, "worldHeight": 205.9, "facing": "left", "spriteSort": "front"}
	var base := {"id": "stall", "type": "npc", "x": 935.0, "y": 1354.9, "interactionRange": 100, "data": {"npcId": "vendor"}, "displayImage": image_def, "collisionPolygon": [{"x": -10, "y": -20}, {"x": 10, "y": -20}, {"x": 0, "y": 0}], "collisionPolygonLocal": true}
	assert(RuntimeHotspot.is_valid_display_image(image_def)); assert(not RuntimeHotspot.is_valid_display_image({"image": "x", "worldWidth": 0, "worldHeight": 10}))
	var overridden := RuntimeHotspot.apply_runtime_override(base, {"x": 100, "y": 200, "displayImage": null, "enabled": false}); assert(overridden.x == 100 and overridden.y == 200 and not overridden.has("displayImage") and not overridden.has("enabled"))
	var polygon: Array = RuntimeHotspotCollisionScript.hotspot_collision_polygon_to_world(base); assert(polygon.size() == 3 and is_equal_approx(polygon[0].x, 925.0) and is_equal_approx(polygon[0].y, 1334.9) and is_equal_approx(polygon[2].x, 935.0) and is_equal_approx(polygon[2].y, 1354.9))
	var world_poly := base.duplicate(true); world_poly.collisionPolygonLocal = false; assert(RuntimeHotspotCollisionScript.hotspot_collision_polygon_to_world(world_poly)[0] == {"x": -10, "y": -20})

	var hotspot := RuntimeHotspot.new(base); add_child(hotspot.container); assert(hotspot.get_center_x() == 935 and is_equal_approx(hotspot.get_center_y(), 1354.9) and hotspot.get_active() and hotspot.container.has_meta("entityOcclusionPolygon"))
	assert(hotspot.load_display_image(assets)); assert(hotspot.has_depth_display_image() and is_equal_approx(hotspot.get_world_size().width, 205.9) and is_equal_approx(hotspot.get_world_size().height, 205.9) and hotspot.get_facing() == -1 and hotspot.container.get_meta("entitySortBand") == "front" and not hotspot.marker.visible)
	assert(hotspot.display_sprite.position.is_equal_approx(Vector2(0, -102.95)) and is_equal_approx(hotspot.get_emote_bubble_anchor_local_y(), -213.9) and is_equal_approx(hotspot.get_emote_world_quad().width, 205.9))
	hotspot.set_runtime_display_facing("right"); assert(hotspot.get_facing() == 1 and hotspot.display_sprite.scale.x > 0); hotspot.set_runtime_display_facing(null); assert(hotspot.get_facing() == -1)
	var filter_probe := RuntimeEntityLightingFilter.create_for_entity({"depthTexture": null, "cfg": null, "probeSource": null, "lightEnv": {"key": {"color": [1.0, 1.0, 1.0], "intensity": 1.0}, "ambient": {"color": [1.0, 1.0, 1.0], "intensity": 1.0}, "toneStrength": 0.0, "ao": {"contact": 0.0, "form": 0.0}}, "sampleLiftWorld": 0.0}); hotspot.attach_depth_occlusion_filter(filter_probe); assert(hotspot.get_depth_occlusion_filter() == filter_probe and RuntimeSceneEntityFilterBinding.get_filter(hotspot.display_sprite) == filter_probe and hotspot.detach_depth_occlusion_filter() == filter_probe and hotspot.get_depth_occlusion_filter() == null and RuntimeSceneEntityFilterBinding.get_filter(hotspot.display_sprite) == null); filter_probe.destroy()
	hotspot.apply_entity_pixel_density_match(true, {"x": 1, "y": 1}); assert(hotspot.get_pixel_density_match_active() and hotspot.display_sprite.texture_filter == CanvasItem.TEXTURE_FILTER_LINEAR); hotspot.apply_entity_pixel_density_match(false); assert(not hotspot.get_pixel_density_match_active() and hotspot.display_sprite.texture_filter == CanvasItem.TEXTURE_FILTER_PARENT_NODE)
	hotspot.show_prompt(); assert(hotspot.prompt_icon != null); hotspot.set_derived_base_enabled(false); assert(not hotspot.get_active() and not hotspot.container.visible and hotspot.prompt_icon == null); hotspot.set_enabled(false); hotspot.set_derived_base_enabled(true); assert(not hotspot.get_active()); hotspot.set_enabled(true); assert(hotspot.get_active()); hotspot.set_condition_enabled(false); assert(not hotspot.get_active()); hotspot.set_condition_enabled(true); assert(hotspot.get_active())
	hotspot.mark_picked_up(); assert(hotspot.get_picked_up() and not hotspot.get_active()); hotspot.set_enabled(true); hotspot.set_derived_base_enabled(true); hotspot.set_condition_enabled(true); assert(not hotspot.get_active())
	hotspot.set_position(50, 60); assert(hotspot.container.position == Vector2(50, 60) and RuntimeHotspotCollisionScript.hotspot_collision_polygon_to_world(hotspot.def)[0] == {"x": 40.0, "y": 40.0})
	hotspot.destroy_hotspot(); assert(hotspot.is_destroyed()); assets.dispose()

	var scene_files: Array[String] = []; _collect_json("%s/public/assets/scenes" % repository, scene_files); var total := 0; var types := {}; var display := 0; var polygons := 0; var conditions := 0; var auto := 0; var cutscene := 0
	for path: String in scene_files:
		var scene: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(path))
		for entry: Variant in scene.get("hotspots", []):
			if not entry is Dictionary: continue
			total += 1; var type := str(entry.get("type", "")); types[type] = int(types.get(type, 0)) + 1; display += int(entry.has("displayImage")); polygons += int(entry.has("collisionPolygon")); conditions += int(entry.has("conditions")); auto += int(entry.get("autoTrigger") == true); cutscene += int(entry.has("cutsceneIds"))
	assert(total == 119 and types == {"encounter": 2, "inspect": 75, "npc": 1, "pickup": 2, "transition": 39} and display == 22 and polygons == 12 and conditions == 49 and auto == 1 and cutscene == 8)
	print("Hotspot five-type/display/visibility/collision contract test: PASS"); get_tree().quit(0)


func _collect_json(path: String, output: Array[String]) -> void:
	var dir := DirAccess.open(path); assert(dir != null); dir.list_dir_begin(); var name := dir.get_next()
	while not name.is_empty():
		if name.ends_with(".json") and not dir.current_is_dir(): output.push_back("%s/%s" % [path, name])
		name = dir.get_next()
	dir.list_dir_end(); output.sort()
