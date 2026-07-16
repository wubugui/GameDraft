extends Node

var replaced_move_resolved := false


func _ready() -> void:
	var input := RuntimeInputManager.new(); add_child(input)
	var player := RuntimePlayer.new(input); add_child(player.sprite)
	var image := Image.create(30, 10, false, Image.FORMAT_RGBA8); image.fill(Color.WHITE); var texture := ImageTexture.create_from_image(image)
	player.sprite.load_from_def(texture, {"spritesheet": "x", "cols": 3, "rows": 1, "worldWidth": 30, "worldHeight": 20, "states": {"idle": {"frames": [0], "frameRate": 8, "loop": true}, "walk": {"frames": [1], "frameRate": 8, "loop": true}, "run": {"frames": [2], "frameRate": 8, "loop": true}}})
	player.sync_movement_from_scene({"playerWalkSpeed": 100, "playerRunSpeed": 180, "worldWidth": 200, "worldHeight": 150})
	player.set_x(0); player.set_y(50); InputManagerProbe.key_down(input, "KeyD"); player.update(0.5)
	assert(player.get_x() == 50 and player.sprite.get_current_state() == "walk" and player.get_facing_direction() == "right")
	InputManagerProbe.key_down(input, "ShiftLeft"); player.update(0.5); assert(player.get_x() == 140 and player.sprite.get_current_state() == "run")
	player.set_movement_modifier(func() -> Dictionary: return {"driftX": -10, "driftY": 0, "speedScale": 0.5, "allowRun": false})
	player.update(1.0); assert(player.get_x() == 180 and player.sprite.get_current_state() == "walk")
	InputManagerProbe.key_up(input, "KeyD"); InputManagerProbe.key_up(input, "ShiftLeft"); player.update(1.0); assert(player.get_x() == 170 and player.sprite.get_current_state() == "idle")
	player.set_depth_collision(func(x: float, _y: float) -> bool: return x > 175); InputManagerProbe.key_down(input, "KeyD"); player.update(1.0); assert(player.get_x() == 170)
	player.set_collisions_enabled(false); player.update(0.75); assert(player.get_x() == 200)
	player.update(1.0); assert(player.get_x() == 200)
	assert(not player.get_collisions_enabled_state() and player.get_emote_bubble_anchor_local_y() == -28)
	player.set_visible(false); assert(not player.sprite.visible); player.set_visible(true)

	InputManagerProbe.key_up(input, "KeyD"); player.set_movement_modifier(); player.set_x(0); player.set_y(0)
	player.move_to(30, 40, 25, "walk", true); assert(player.is_moving_to_target())
	player.cutscene_update(1.0); assert(player.get_x() == 15 and player.get_y() == 20 and player.is_moving_to_target())
	player.cutscene_update(1.0); await get_tree().process_frame; assert(player.get_x() == 30 and player.get_y() == 40 and not player.is_moving_to_target() and player.sprite.get_current_state() == "idle")
	_track_replaced_move(player, 80, 40)
	assert(not replaced_move_resolved)
	player.move_to(31, 40, 10, null, null); player.cutscene_update(0.1); await get_tree().process_frame; assert(player.get_x() == 31 and not player.is_moving_to_target())
	assert(replaced_move_resolved)
	await get_tree().process_frame
	player.destroy_player(); remove_child(player.sprite); player.sprite.free(); input.destroy(); remove_child(input); input.free()
	print("Player movement/cutscene/modifier contract test: PASS"); get_tree().quit(0)


func _track_replaced_move(player: RuntimePlayer, x: float, y: float) -> void:
	await player.move_to(x, y, 10)
	replaced_move_resolved = true
