extends Node


func _ready() -> void:
	var input := RuntimeInputManager.new(); add_child(input)
	var player := RuntimePlayer.new(input); add_child(player.sprite)
	var image := Image.create(30, 10, false, Image.FORMAT_RGBA8); image.fill(Color.WHITE); var texture := ImageTexture.create_from_image(image)
	player.sprite.load_from_def(texture, {"spritesheet": "x", "cols": 3, "rows": 1, "worldWidth": 30, "worldHeight": 20, "states": {"idle": {"frames": [0], "frameRate": 8, "loop": true}, "walk": {"frames": [1], "frameRate": 8, "loop": true}, "run": {"frames": [2], "frameRate": 8, "loop": true}}})
	player.sync_movement_from_scene({"playerWalkSpeed": 100, "playerRunSpeed": 180, "worldWidth": 200, "worldHeight": 150})
	player.set_x(0); player.set_y(50); input.debug_key_down("KeyD"); player.update(0.5)
	assert(player.get_x() == 50 and player.sprite.get_current_state() == "walk" and player.get_facing_direction() == "right")
	input.debug_key_down("ShiftLeft"); player.update(0.5); assert(player.get_x() == 140 and player.sprite.get_current_state() == "run")
	player.set_movement_modifier(func() -> Dictionary: return {"driftX": -10, "driftY": 0, "speedScale": 0.5, "allowRun": false})
	player.update(1.0); assert(player.get_x() == 180 and player.sprite.get_current_state() == "walk")
	input.debug_key_up("KeyD"); input.debug_key_up("ShiftLeft"); player.update(1.0); assert(player.get_x() == 170 and player.sprite.get_current_state() == "idle")
	player.set_depth_collision(func(x: float, _y: float) -> bool: return x > 175); input.debug_key_down("KeyD"); player.update(1.0); assert(player.get_x() == 170)
	player.set_collisions_enabled(false); player.update(0.75); assert(player.get_x() == 200)
	player.update(1.0); assert(player.get_x() == 200)
	assert(not player.get_collisions_enabled_state() and player.get_emote_bubble_anchor_local_y() == -28)
	player.set_visible(false); assert(not player.sprite.visible); player.set_visible(true)

	input.debug_key_up("KeyD"); player.set_movement_modifier(); player.set_x(0); player.set_y(0)
	player.move_to(30, 40, 25, "walk", true); assert(player.is_moving_to_target())
	player.cutscene_update(1.0); assert(player.get_x() == 15 and player.get_y() == 20 and player.is_moving_to_target())
	player.cutscene_update(1.0); await get_tree().process_frame; assert(player.get_x() == 30 and player.get_y() == 40 and not player.is_moving_to_target() and player.sprite.get_current_state() == "idle")
	await get_tree().process_frame
	player.destroy_player(); remove_child(player.sprite); player.sprite.free(); input.destroy(); remove_child(input); input.free()
	print("Player movement/cutscene/modifier contract test: PASS"); get_tree().quit(0)
