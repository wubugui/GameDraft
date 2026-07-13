extends Node

var completed := 0


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var manifests: Array[String] = []; _collect_manifests("%s/public/resources/runtime/animation" % repository, manifests); manifests.sort()
	assert(manifests.size() == 36)
	var state_count := 0; var frame_count := 0
	for path: String in manifests:
		var data: Variant = JSON.parse_string(FileAccess.get_file_as_string(path)); assert(data is Dictionary)
		assert(data.get("spritesheet") is String and FileAccess.file_exists("%s/%s" % [path.get_base_dir(), data.spritesheet]))
		assert(int(data.get("cols", 0)) > 0 and int(data.get("rows", 0)) > 0 and float(data.get("worldHeight", 0)) > 0 and data.get("states") is Dictionary)
		for state: Dictionary in data.states.values():
			state_count += 1; frame_count += state.get("frames", []).size(); assert(not state.get("frames", []).is_empty() and state.get("loop") is bool)
			for index: Variant in state.frames: assert(int(index) >= 0 and int(index) < int(data.cols) * int(data.rows))
	assert(state_count == 284 and frame_count == 4438)

	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var entity := RuntimeSpriteEntity.new(); add_child(entity)
	assert(entity.load_from_paths("/resources/runtime/animation/fx_patron_drinker/anim.json", assets))
	entity.play_animation("idle"); assert(entity.get_frame_count() == 14 and entity.get_world_size() == {"width": 31.0, "height": 43.408203125})
	entity.x = 12; entity.y = 34; entity.update(1.0 / 7.0); assert(entity.get_frame_index() == 1 and entity.position == Vector2(12, 34))
	entity.set_direction(-1); assert(entity.get_facing_direction() == "left" and entity.sprite.scale.x < 0)
	entity.set_frame_index(-1); assert(entity.get_frame_index() == 13)
	entity.set_logical_state_map({"stand": "idle"}); entity.set_playing(false); entity.play_animation("stand"); assert(entity.get_current_state() == "idle")
	entity.set_pixel_density_match_active(true); assert(entity.get_pixel_density_match_active() and entity.sprite.texture_filter == CanvasItem.TEXTURE_FILTER_LINEAR)
	entity.set_pixel_density_match_active(false); assert(entity.sprite.texture_filter == CanvasItem.TEXTURE_FILTER_PARENT_NODE)

	var image := Image.create(20, 10, false, Image.FORMAT_RGBA8); image.fill(Color.WHITE); var texture := ImageTexture.create_from_image(image)
	entity.load_from_def(texture, {"spritesheet": "x", "cols": 2, "rows": 1, "worldWidth": 40, "worldHeight": 20, "states": {"once": {"frames": [0, 1], "frameRate": 10, "loop": false}}})
	entity.play_animation("once", Callable(self, "_complete")); entity.update(0.3); assert(entity.get_frame_index() == 1 and completed == 1)
	entity.set_playing(true); assert(entity.get_frame_index() == 0)
	entity.destroy_entity(); remove_child(entity); entity.free(); assets.dispose()
	print("SpriteEntity 36-manifest atlas contract test: PASS"); get_tree().quit(0)


func _collect_manifests(path: String, output: Array[String]) -> void:
	var dir := DirAccess.open(path); assert(dir != null); dir.list_dir_begin()
	var name := dir.get_next()
	while not name.is_empty():
		if name not in [".", ".."]:
			var child := "%s/%s" % [path, name]
			if dir.current_is_dir(): _collect_manifests(child, output)
			elif name == "anim.json": output.push_back(child)
		name = dir.get_next()
	dir.list_dir_end()


func _complete() -> void: completed += 1
