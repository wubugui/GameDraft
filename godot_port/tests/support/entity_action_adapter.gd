extends RefCounted

const SceneQueries := preload("res://tests/support/scene_queries.gd")

var scenes: RuntimeSceneManager
var assets: RuntimeAssetManager


func _init(next_scenes: RuntimeSceneManager, next_assets: RuntimeAssetManager) -> void:
	scenes = next_scenes
	assets = next_assets


func set_scene_entity_field(scene_id: String, kind: String, entity_id: String, field_name: String, value: Variant) -> void:
	var stored: Dictionary = scenes.set_entity_runtime_field(scene_id, kind, entity_id, field_name, value)
	if stored.get("ok") != true or scenes.get_current_scene_id() != scene_id:
		return
	if kind == "npc":
		var npc: Variant = scenes.get_npc_by_id(entity_id)
		if npc == null: return
		match field_name:
			"x": npc.set_x(float(stored.value))
			"y": npc.set_y(float(stored.value))
			"enabled": npc.set_visible(stored.value == true)
			"animState": npc.play_animation(str(stored.value))
	else:
		var hotspot: Variant = SceneQueries.hotspot(scenes, entity_id)
		if hotspot == null: return
		match field_name:
			"x": hotspot.set_position(float(stored.value), hotspot.get_center_y())
			"y": hotspot.set_position(hotspot.get_center_x(), float(stored.value))
			"enabled": hotspot.set_enabled(stored.value == true)
			"displayImage":
				hotspot.def.displayImage = stored.value.duplicate(true)
				hotspot.load_display_image(assets)


func set_hotspot_display_image(scene_id: String, hotspot_id: String, image_path: String, world_width: Variant, world_height: Variant, facing: Variant) -> void:
	var texture: Variant = assets.load_texture(image_path)
	if not texture is Texture2D: return
	var width := float(world_width) if world_width != null else 0.0
	var height := float(world_height) if world_height != null else 0.0
	if width <= 0.0 and height <= 0.0: width = 100.0; height = width * float(texture.get_height()) / float(texture.get_width())
	elif width <= 0.0: width = height * float(texture.get_width()) / float(texture.get_height())
	elif height <= 0.0: height = width * float(texture.get_height()) / float(texture.get_width())
	var display := {"image": image_path, "worldWidth": width, "worldHeight": height}
	if facing in ["left", "right"]: display.facing = facing
	await set_scene_entity_field(scene_id, "hotspot", hotspot_id, "displayImage", display)


func temp_set_hotspot_display_facing(scene_id: String, hotspot_id: String, facing: String) -> void:
	if scenes.get_current_scene_id() != scene_id: return
	var hotspot: Variant = SceneQueries.hotspot(scenes, hotspot_id)
	if hotspot != null: hotspot.set_runtime_display_facing(null if facing == "restore" else facing)
