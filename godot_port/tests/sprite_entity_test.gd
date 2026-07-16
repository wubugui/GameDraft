extends Node

var completed := 0


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var manifests: Array[String] = []; _collect_manifests("%s/public/resources/runtime/animation" % repository, manifests); manifests.sort()
	assert(manifests.size() == 46)
	var state_count := 0; var frame_count := 0
	for path: String in manifests:
		var data: Variant = JSON.parse_string(FileAccess.get_file_as_string(path)); assert(data is Dictionary)
		assert(data.get("spritesheet") is String and FileAccess.file_exists("%s/%s" % [path.get_base_dir(), data.spritesheet]))
		assert(int(data.get("cols", 0)) > 0 and int(data.get("rows", 0)) > 0 and float(data.get("worldHeight", 0)) > 0 and data.get("states") is Dictionary)
		for state: Dictionary in data.states.values():
			state_count += 1; frame_count += state.get("frames", []).size(); assert(not state.get("frames", []).is_empty() and state.get("loop") is bool)
			for index: Variant in state.frames: assert(int(index) >= 0 and int(index) < int(data.cols) * int(data.rows))
	assert(state_count == 327 and frame_count == 5050)

	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var entity := RuntimeSpriteEntity.new(); add_child(entity)
	assert(entity is Node2D and entity.container == entity and entity.sprite.get_parent() == entity)
	var manifest_path := "/resources/runtime/animation/fx_patron_drinker/anim.json"
	var animation_definition: Variant = assets.load_json(manifest_path)
	var atlas: Variant = assets.load_texture("%s/%s" % [manifest_path.get_base_dir(), animation_definition.spritesheet])
	assert(animation_definition is Dictionary and atlas is Texture2D)
	entity.load_from_def(atlas, animation_definition)
	assert(is_same(entity._anim_def, animation_definition), "loadFromDef must retain the caller animation definition")
	entity.play_animation("idle"); assert(entity.get_frame_count() == 14 and entity.get_world_size() == {"width": 31.0, "height": 43.408203125})
	entity.x = 12; entity.y = 34; entity.update(1.0 / 7.0); assert(entity.get_frame_index() == 1 and entity.position == Vector2(12, 34))
	entity.set_direction(-1, 0); assert(entity.get_facing_direction() == "left" and entity.sprite.scale.x < 0)
	entity.set_frame_index(-1); assert(entity.get_frame_index() == 13)
	entity.set_logical_state_map({"stand": "idle"}); entity.set_playing(false); entity.play_animation("stand"); assert(entity.get_current_state() == "idle")
	entity.set_pixel_density_match_active(true)
	assert(entity.get_pixel_density_match_active() and entity.sprite.get_meta("roundPixels") == true)
	entity.apply_pixel_density_match(Vector2(0.1, 0.1), 1.0)
	assert(entity._pixel_density_blur != null and entity._pixel_density_blur_mounted)
	assert(entity.sprite.material == entity._pixel_density_blur.material)
	var retained_blur: RefCounted = entity._pixel_density_blur
	var entity_filter := RuntimeEntityLightingFilter.create_for_entity({})
	RuntimeSceneEntityFilterBinding.attach(entity.container, entity_filter, entity.sprite)
	RuntimeSceneEntityFilterBinding.sync_sprite_entity_pixel_density_match(entity.container, entity, entity_filter, Vector2(0.1, 0.1), true, 1.0, 1.0)
	assert(RuntimeSceneEntityFilterBinding.get_filter(entity.container) == entity_filter and entity.sprite.material == entity_filter.material)
	assert(not entity._pixel_density_blur_mounted and entity._pixel_density_blur == retained_blur and float(entity_filter.material.get_shader_parameter("pixel_blur_strength")) > 0.0, "engine adapter must retain source BlurFilter state while folding the pass into the entity shader")
	entity.apply_pixel_density_match(Vector2(1000, 1000), 1.0)
	assert(not entity._pixel_density_blur_mounted and entity._pixel_density_blur == retained_blur and entity.sprite.material == entity_filter.material)
	RuntimeSceneEntityFilterBinding.sync_sprite_entity_pixel_density_match(entity.container, entity, entity_filter, Vector2(1000, 1000), true, 1.0, 1.0)
	assert(entity.sprite.material == entity_filter.material and is_zero_approx(float(entity_filter.material.get_shader_parameter("pixel_blur_strength"))))
	entity.set_pixel_density_match_active(false)
	assert(entity.sprite.get_meta("roundPixels") == false and entity._pixel_density_blur == null and retained_blur.destroyed)
	assert(entity.sprite.material == entity_filter.material, "disabling translated BlurFilter state must not detach the entity filter")

	var image := Image.create(20, 10, false, Image.FORMAT_RGBA8); image.fill(Color.WHITE); var texture := ImageTexture.create_from_image(image)
	entity.load_from_def(texture, {"spritesheet": "x", "cols": 2, "rows": 1, "worldWidth": 40, "worldHeight": 20, "states": {"once": {"frames": [0, 1], "frameRate": 10, "loop": false}}})
	entity.play_animation("once", Callable(self, "_complete")); entity.update(0.3); assert(entity.get_frame_index() == 1 and completed == 1)
	entity.update(1.0); assert(completed == 1, "non-loop completion callback must fire once")
	entity.set_playing(true); assert(entity.get_frame_index() == 0)

	if DisplayServer.get_name() != "headless":
		await _assert_nested_filter_pixels()

	var retained_definition := entity._anim_def
	var retained_snapshot: Dictionary = retained_definition.duplicate(true)
	entity.destroy(); remove_child(entity); entity.free(); assets.dispose()
	assert(retained_definition == retained_snapshot, "destroy must not mutate the caller animation definition")
	print("SpriteEntity 46-manifest atlas contract test: PASS"); get_tree().quit(0)


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


func _assert_nested_filter_pixels() -> void:
	var image := Image.create(8, 8, false, Image.FORMAT_RGBA8)
	image.fill(Color(0, 0, 0, 0))
	for y_index: int in 8:
		for x_index: int in 4:
			image.set_pixel(x_index, y_index, Color(1, 0, 0, 1))
	var visual := RuntimeSpriteEntity.new()
	add_child(visual)
	visual.load_from_def(ImageTexture.create_from_image(image), {
		"spritesheet": "probe.png",
		"cols": 1,
		"rows": 1,
		"worldWidth": 64.0,
		"worldHeight": 64.0,
		"states": {"idle": {"frames": [0], "frameRate": 8.0, "loop": true}},
	})
	visual.play_animation("idle")
	visual.x = 64.0
	visual.y = 96.0
	visual.update(0.0)
	var filter := RuntimeEntityLightingFilter.create_for_entity({})
	RuntimeSceneEntityFilterBinding.attach(visual.container, filter, visual.sprite)
	RuntimeSceneEntityFilterBinding.sync_sprite_entity_pixel_density_match(visual.container, visual, filter, Vector2(0.01, 0.01), true, 4.0, 1.0)
	RenderingServer.force_draw(true)
	await get_tree().process_frame
	RenderingServer.force_draw(true)
	await get_tree().process_frame
	var rendered := get_viewport().get_texture().get_image()
	var solid := rendered.get_pixel(48, 64)
	var blurred_edge := rendered.get_pixel(65, 64)
	var transparent_region := rendered.get_pixel(88, 64)
	assert(solid.r > 0.5 and solid.g < 0.2, "entity filter must preserve the opaque sprite body: %s" % solid)
	assert(blurred_edge.r > blurred_edge.g + 0.05, "folded density blur must remain visible through the entity filter: %s" % blurred_edge)
	assert(transparent_region.r < 0.6 and transparent_region.g < 0.6 and transparent_region.b < 0.6, "transparent sprite bounds must not become an opaque white rectangle: %s" % transparent_region)
	visual.destroy()
	remove_child(visual)
	visual.free()
