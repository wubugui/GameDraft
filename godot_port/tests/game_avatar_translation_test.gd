extends Node

const AvatarGameHarnessScript := preload("res://tests/support/avatar_game_harness.gd")
const AvatarAssetManagerProbeScript := preload("res://tests/support/avatar_asset_manager_probe.gd")

const MANIFEST := "/virtual/avatar/anim.json"
const SHEET := "/virtual/avatar/atlas.png"
const DEFAULT_MANIFEST := "/resources/runtime/animation/player_anim/anim.json"


func _ready() -> void:
	await _run_contract()
	await get_tree().process_frame
	print("Game avatar 8-method load/mount/setup/defer direct-translation test: PASS")
	get_tree().quit(0)


func _run_contract() -> void:
	var probe: AvatarAssetManagerProbe = AvatarAssetManagerProbeScript.new()
	var texture := _texture(300, 100, Color("c49564"))
	probe.json_by_path[MANIFEST] = _sheet_manifest()
	probe.texture_by_path[SHEET] = texture
	var game: Node = _new_game(probe)

	var refs: Array = await game.build_animation_manifest_refs(MANIFEST, "玩家动画")
	assert(refs == [
		{"type": "json", "path": MANIFEST, "label": "玩家动画清单"},
		{"type": "texture", "path": SHEET, "label": "玩家动画图集"},
	])
	var loaded: Dictionary = await game.load_player_avatar_resources(MANIFEST)
	assert(loaded.texture == texture)
	assert(loaded.animDef.worldWidth == 90 and loaded.animDef.worldHeight == 90.0)
	assert(loaded.animDef.cellWidth == 100.0 and loaded.animDef.cellHeight == 100.0)
	var missing_refs: Array = await game.build_animation_manifest_refs("/missing/anim.json", "玩家动画")
	assert(missing_refs == [{"type": "json", "path": "/missing/anim.json", "label": "玩家动画清单"}])
	var whitespace_path := "/virtual/whitespace/anim.json"
	probe.json_by_path[whitespace_path] = {"spritesheet": "  ", "cols": 1, "rows": 1, "states": _states()}
	var whitespace_refs: Array = await game.build_animation_manifest_refs(whitespace_path, "玩家动画")
	assert(whitespace_refs == [
		{"type": "json", "path": whitespace_path, "label": "玩家动画清单"},
		{"type": "texture", "path": "", "label": "玩家动画图集"},
	])
	assert(await game.load_player_avatar_resources(whitespace_path) == null)

	var no_sheet_path := "/virtual/no_sheet/anim.json"
	probe.json_by_path[no_sheet_path] = {
		"cols": 6,
		"rows": 1,
		"worldHeight": 48,
		"states": _states(),
	}
	var no_sheet: Dictionary = await game.load_player_avatar_resources(no_sheet_path)
	assert(no_sheet.texture.get_width() == 192 and no_sheet.texture.get_height() == 48)
	assert(no_sheet.animDef.worldWidth == 32.0 and no_sheet.animDef.worldHeight == 48)

	var placeholder: Dictionary = game.placeholder_player_avatar()
	assert(placeholder.texture.get_width() == 192 and placeholder.texture.get_height() == 48)
	assert(placeholder.animDef.worldWidth == 32 and placeholder.animDef.worldHeight == 48)
	assert(placeholder.animDef.states.idle == {"frames": [0, 1], "frameRate": 2, "loop": true})
	assert(placeholder.animDef.states.walk == {"frames": [2, 3, 4, 5], "frameRate": 8, "loop": true})
	assert(placeholder.animDef.states.run == {"frames": [2, 3, 4, 5], "frameRate": 12, "loop": true})
	assert(game.portrait_slug_from_manifest("/resources/runtime/animation/player_carry/anim.json") == "player_carry")
	assert(game.portrait_slug_from_manifest("/resources/runtime/animation/纸人/anim.json?rev=1") == "纸人")
	assert(game.portrait_slug_from_manifest("animation/player_carry/anim.json") == null)
	assert(game.portrait_slug_from_manifest("/resources/runtime/animation/player_carry/other.json") == null)

	game.mount_player_avatar(placeholder.texture, placeholder.animDef, {"idle": "run"}, MANIFEST, true, "  explicit_portrait  ")
	assert(game.current_player_portrait_slug == "explicit_portrait")
	assert(game.player_anim_def == placeholder.animDef)
	assert(game.player.sprite.get_current_state() == "run")
	game.mount_player_avatar(placeholder.texture, placeholder.animDef, {"idle": "missing"}, MANIFEST, true)
	assert(game.player.sprite.get_current_state().is_empty())
	game.mount_player_avatar(placeholder.texture, placeholder.animDef, {"idle": "missing"}, MANIFEST, false)
	assert(game.current_player_portrait_slug == null)
	assert(game.player.sprite.get_current_state() == "idle")

	var before_def: Dictionary = game.player_anim_def
	var before_texture: Variant = game.player.sprite.get_display_texture()
	var before_slug: Variant = game.current_player_portrait_slug
	await game.apply_player_avatar_from_action("/missing/anim.json", {"idle": "idle"})
	assert(game.player_anim_def == before_def)
	assert(game.player.sprite.get_display_texture() == before_texture)
	assert(game.current_player_portrait_slug == before_slug)

	probe.json_by_path[DEFAULT_MANIFEST] = _sheet_manifest()
	probe.texture_by_path["/resources/runtime/animation/player_anim/atlas.png"] = texture
	game.game_config.playerAvatar = {"animManifest": "  ", "stateMap": {"idle": "idle"}}
	await game.reset_player_avatar_from_action()
	assert(probe.json_calls.has(DEFAULT_MANIFEST))
	assert(game.current_player_portrait_slug == "player_anim")

	probe.preload_calls.clear()
	game.game_config.playerAvatar = {"animManifest": MANIFEST, "stateMap": {"idle": "idle"}}
	await game.setup_player()
	assert(probe.preload_calls.size() == 1)
	assert(probe.preload_calls[0].manifest.scopeId == "startup:player")
	assert(probe.preload_calls[0].options == {"mode": "stage", "tolerateErrors": true})
	assert(game.player.get_display_object().get_parent() == game.renderer.entity_layer)
	assert(game.interaction_system._player_position_getter == game.zone_system.player_pos_getter)

	var failed_probe: AvatarAssetManagerProbe = AvatarAssetManagerProbeScript.new()
	var failed_game: Node = _new_game(failed_probe)
	failed_game.game_config.playerAvatar = {"animManifest": "/missing/startup.json", "stateMap": {"idle": "configured_only"}}
	await failed_game.setup_player()
	assert(failed_game.player_anim_def.spritesheet == "")
	assert(failed_game.player.sprite.get_current_state() == "idle")
	assert(failed_game.player.get_display_object().get_parent() == failed_game.renderer.entity_layer)
	assert(failed_game.interaction_system._player_position_getter == failed_game.zone_system.player_pos_getter)

	var deferred_probe: AvatarAssetManagerProbe = AvatarAssetManagerProbeScript.new()
	deferred_probe.json_by_path[MANIFEST] = _sheet_manifest()
	deferred_probe.texture_by_path[SHEET] = texture
	var deferred_game: Node = _new_game(deferred_probe)
	deferred_game.game_config.playerAvatar = {"animManifest": MANIFEST, "stateMap": {"idle": "idle"}}
	await deferred_game.setup_player({"deferAvatar": true})
	assert(deferred_game.player_anim_def.spritesheet == "")
	assert(deferred_game.player.sprite.get_current_state() == "idle")
	for _index in 20:
		if deferred_game.player_anim_def.get("worldWidth") == 90:
			break
		await get_tree().process_frame
	assert(deferred_game.player_anim_def.worldWidth == 90)
	assert(deferred_probe.preload_calls[0].options == {"mode": "runtime", "tolerateErrors": true})

	var guarded_probe: AvatarAssetManagerProbe = AvatarAssetManagerProbeScript.new()
	guarded_probe.json_by_path[MANIFEST] = _sheet_manifest()
	guarded_probe.texture_by_path[SHEET] = texture
	var guarded_game: Node = _new_game(guarded_probe)
	guarded_game.game_config.playerAvatar = {"animManifest": MANIFEST, "stateMap": {"idle": "idle"}}
	await guarded_game.setup_player({"deferAvatar": true})
	guarded_game.tear_down_complete = true
	for _index in 5:
		await get_tree().process_frame
	assert(guarded_game.player_anim_def.spritesheet == "")
	guarded_game.tear_down_complete = false

	_cleanup_game(guarded_game)
	_cleanup_game(deferred_game)
	_cleanup_game(failed_game)
	_cleanup_game(game)


func _new_game(probe: AvatarAssetManagerProbe) -> Node:
	var game: Node = AvatarGameHarnessScript.new()
	game.asset_manager = probe
	game.renderer.set_asset_manager(probe)
	add_child(game)
	game.runtime_root.name = "RuntimeRoot"
	game.add_child(game.runtime_root)
	game.renderer.name = "Renderer"
	game.add_child(game.renderer)
	game.renderer.init()
	game.input_manager.name = "InputManager"
	game.add_child(game.input_manager)
	game.input_manager.set_process(false)
	return game


func _cleanup_game(game: Node) -> void:
	game.destroy()
	remove_child(game)
	game.free()


func _sheet_manifest() -> Dictionary:
	return {
		"spritesheet": "./atlas.png",
		"cols": 3,
		"rows": 1,
		"worldWidth": 90,
		"states": _states(),
	}


func _states() -> Dictionary:
	return {
		"idle": {"frames": [0], "frameRate": 2, "loop": true},
		"walk": {"frames": [1], "frameRate": 8, "loop": true},
		"run": {"frames": [2], "frameRate": 12, "loop": true},
	}


func _texture(width: int, height: int, color: Color) -> Texture2D:
	var image := Image.create(width, height, false, Image.FORMAT_RGBA8)
	image.fill(color)
	return ImageTexture.create_from_image(image)
