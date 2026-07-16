extends Node

const GameHarnessScript := preload("res://tests/support/hotspot_display_game_harness.gd")
const AssetProbeScript := preload("res://tests/support/hotspot_display_asset_manager_probe.gd")

const SCENE_ID := "live_room"
const HOTSPOT_ID := "display_probe"
const OLD_IMAGE := "/virtual/old.png"
const NEW_IMAGE := "/virtual/new.png"
const MISSING_IMAGE := "/virtual/missing.png"


func _ready() -> void:
	await _run_contract()
	print("Game hotspot display-image transaction/filter-ownership direct-translation test: PASS")
	get_tree().quit(0)


func _run_contract() -> void:
	var assets: Variant = AssetProbeScript.new()
	assets.textures[OLD_IMAGE] = _texture(40, 20, Color("9a7654"))
	assets.textures[NEW_IMAGE] = _texture(20, 40, Color("476e91"))
	var game: Node = GameHarnessScript.new()
	game.asset_manager = assets
	game.renderer.set_asset_manager(assets)
	add_child(game)
	game.runtime_root.name = "RuntimeRoot"
	game.add_child(game.runtime_root)
	game.renderer.name = "Renderer"
	game.add_child(game.renderer)
	game.renderer.init()
	game.renderer.entity_layer.add_child(game.player.sprite)
	game.input_manager.name = "InputManager"
	game.add_child(game.input_manager)
	game.input_manager.set_process(false)

	var old_display := {
		"image": OLD_IMAGE,
		"worldWidth": 80.0,
		"worldHeight": 40.0,
		"facing": "left",
		"spriteSort": "front",
	}
	var definition := {"id": HOTSPOT_ID, "type": "inspect", "x": 120.0, "y": 240.0, "displayImage": old_display.duplicate(true)}
	var hotspot := RuntimeHotspot.new(definition)
	game.renderer.entity_layer.add_child(hotspot.container)
	hotspot.set_display_texture(assets.textures[OLD_IMAGE], 80.0, 40.0)
	game.scene_manager.current_scene = {"id": SCENE_ID, "hotspots": [definition.duplicate(true)]}
	var live_hotspots: Array[RuntimeHotspot] = [hotspot]
	game.scene_manager.current_hotspots = live_hotspots
	_prepare_depth_system(game.scene_depth_system, assets.textures[OLD_IMAGE])
	var old_filter: RuntimeEntityLightingFilter = game.scene_depth_system.create_filter_for_entity()
	hotspot.attach_depth_occlusion_filter(old_filter)
	assert(RuntimeSceneEntityFilterBinding.get_filter(hotspot.display_sprite) == old_filter)
	assert(hotspot.display_sprite.material == old_filter.material)
	assert(game.scene_depth_system.filters.has(old_filter))
	hotspot.apply_entity_pixel_density_match(true, {"x": 1.0, "y": 1.0})
	assert(hotspot.get_pixel_density_match_active())

	var old_sprite := hotspot.display_sprite
	await game._apply_hotspot_display_image_now(hotspot, {"image": MISSING_IMAGE, "worldWidth": 30.0, "worldHeight": 60.0})
	assert(hotspot.def.displayImage == old_display)
	assert(hotspot.display_sprite == old_sprite)
	assert(hotspot.get_depth_occlusion_filter() == old_filter)
	assert(RuntimeSceneEntityFilterBinding.get_filter(hotspot.display_sprite) == old_filter)
	assert(game.scene_depth_system.filters.has(old_filter))
	assert(not old_filter.destroyed)

	var replacement := {"image": NEW_IMAGE, "worldWidth": 30.0, "worldHeight": 60.0, "facing": "right", "spriteSort": "back"}
	await game._apply_hotspot_runtime_field_now(HOTSPOT_ID, "displayImage", replacement)
	var replacement_filter: RuntimeEntityLightingFilter = hotspot.get_depth_occlusion_filter()
	assert(replacement_filter != null and replacement_filter != old_filter)
	assert(old_filter.destroyed and old_filter.material == null)
	assert(not game.scene_depth_system.filters.has(old_filter) and game.scene_depth_system.filters.has(replacement_filter))
	assert(hotspot.def.displayImage == replacement)
	assert(hotspot.get_display_texture() == assets.textures[NEW_IMAGE])
	assert(hotspot.get_world_size() == {"width": 30.0, "height": 60.0})
	assert(hotspot.get_facing() == 1 and hotspot.container.get_meta("entitySortBand") == "back")
	assert(RuntimeSceneEntityFilterBinding.get_filter(hotspot.display_sprite) == replacement_filter)
	assert(hotspot.display_sprite.material == replacement_filter.material)
	assert(not hotspot.get_pixel_density_match_active())
	assert(game.pixel_density_sync_calls == 1)

	await game._apply_hotspot_runtime_field_now(HOTSPOT_ID, "displayImage", null)
	assert(replacement_filter.destroyed and replacement_filter.material == null)
	assert(not game.scene_depth_system.filters.has(replacement_filter))
	assert(hotspot.get_depth_occlusion_filter() == null and hotspot.display_sprite == null)
	assert(not hotspot.def.has("displayImage") and hotspot.marker.visible)
	assert(game.pixel_density_sync_calls == 2)

	# Restore one live image/filter, then drive the complete Action -> store -> live-apply chain.
	hotspot.def.displayImage = old_display.duplicate(true)
	hotspot.set_display_texture(assets.textures[OLD_IMAGE], 80.0, 40.0)
	var action_old_filter: RuntimeEntityLightingFilter = game.scene_depth_system.create_filter_for_entity()
	hotspot.attach_depth_occlusion_filter(action_old_filter)
	var resolved_new := "/virtual/scenes/%s/replacement.png" % SCENE_ID
	assets.textures[resolved_new] = _texture(50, 100, Color("71568e"))
	await game._set_hotspot_display_image_from_action(SCENE_ID, HOTSPOT_ID, " replacement.png ", 25.0, null, null)
	var action_display: Dictionary = hotspot.def.displayImage
	assert(action_display == {"image": resolved_new, "worldWidth": 25.0, "worldHeight": 50.0, "facing": "left", "spriteSort": "front"})
	assert(game.scene_manager.get_entity_runtime_override(SCENE_ID, "hotspot", HOTSPOT_ID).displayImage == action_display)
	assert(assets.resolve_calls.back() == {"sceneId": SCENE_ID, "imagePath": "replacement.png"})
	assert(assets.texture_calls.count(resolved_new) == 2)
	assert(action_old_filter.destroyed and not game.scene_depth_system.filters.has(action_old_filter))
	var action_new_filter: RuntimeEntityLightingFilter = hotspot.get_depth_occlusion_filter()
	assert(action_new_filter != null and RuntimeSceneEntityFilterBinding.get_filter(hotspot.display_sprite) == action_new_filter)
	assert(game.pixel_density_sync_calls == 3)

	var stored_before_failure: Dictionary = game.scene_manager.get_entity_runtime_override(SCENE_ID, "hotspot", HOTSPOT_ID).duplicate(true)
	var sprite_before_failure := hotspot.display_sprite
	await game._set_hotspot_display_image_from_action(SCENE_ID, HOTSPOT_ID, MISSING_IMAGE, null, null, null)
	assert(game.scene_manager.get_entity_runtime_override(SCENE_ID, "hotspot", HOTSPOT_ID) == stored_before_failure)
	assert(hotspot.display_sprite == sprite_before_failure)
	assert(hotspot.get_depth_occlusion_filter() == action_new_filter)
	assert(not action_new_filter.destroyed and game.scene_depth_system.filters.has(action_new_filter))
	assert(game.pixel_density_sync_calls == 3)

	await _assert_dimension_fallbacks(game, assets)

	# Hotspot owns the sprite/filter binding: detach clears material/meta before returning ownership.
	var detached: RuntimeEntityLightingFilter = hotspot.detach_depth_occlusion_filter()
	assert(detached == action_new_filter)
	assert(RuntimeSceneEntityFilterBinding.get_filter(hotspot.display_sprite) == null and hotspot.display_sprite.material == null)
	game.scene_depth_system.remove_filter(detached)
	detached.destroy()
	hotspot.destroy_hotspot()
	game.scene_manager.current_hotspots.clear()
	game.destroy()
	remove_child(game)
	game.free()


func _assert_dimension_fallbacks(game: Node, assets: Variant) -> void:
	var cases: Array[Dictionary] = [
		{"id": "both", "previous": {}, "width": 11.0, "height": 12.0, "expected": Vector2(11, 12)},
		{"id": "width", "previous": {}, "width": 10.0, "height": null, "expected": Vector2(10, 5)},
		{"id": "height", "previous": {}, "width": null, "height": 10.0, "expected": Vector2(20, 10)},
		{"id": "previous_both", "previous": {"worldWidth": 31.0, "worldHeight": 17.0}, "width": null, "height": null, "expected": Vector2(31, 17)},
		{"id": "previous_width", "previous": {"worldWidth": 30.0}, "width": null, "height": null, "expected": Vector2(30, 15)},
		{"id": "previous_height", "previous": {"worldHeight": 15.0}, "width": null, "height": null, "expected": Vector2(30, 15)},
		{"id": "default", "previous": {}, "width": null, "height": null, "expected": Vector2(100, 50)},
	]
	for entry: Dictionary in cases:
		var scene_id := "offscreen_%s" % entry.id
		var image_path := "/virtual/scenes/%s/probe.png" % scene_id
		assets.textures[image_path] = _texture(40, 20, Color.WHITE)
		var previous: Dictionary = entry.previous.duplicate(true)
		previous.image = "/virtual/base.png"
		previous.facing = "left"
		previous.spriteSort = "front"
		assets.scenes[scene_id] = {"id": scene_id, "hotspots": [{"id": HOTSPOT_ID, "displayImage": previous}]}
		await game._set_hotspot_display_image_from_action(scene_id, HOTSPOT_ID, "probe.png", entry.width, entry.height, null)
		var display: Dictionary = game.scene_manager.get_entity_runtime_override(scene_id, "hotspot", HOTSPOT_ID).displayImage
		assert(Vector2(float(display.worldWidth), float(display.worldHeight)) == entry.expected)
		assert(display.image == image_path and display.facing == "left" and display.spriteSort == "front")
		assert(assets.scene_calls.back() == scene_id)


func _prepare_depth_system(depth: RuntimeSceneDepthSystem, texture: Texture2D) -> void:
	depth.enabled = true
	depth.depth_texture = texture
	depth.config = {}
	depth.scene_w = 800.0
	depth.scene_h = 600.0
	depth.world_to_pixel_x = 1.0
	depth.world_to_pixel_y = 1.0


func _texture(width: int, height: int, color: Color) -> Texture2D:
	var image := Image.create(width, height, false, Image.FORMAT_RGBA8)
	image.fill(color)
	return ImageTexture.create_from_image(image)
