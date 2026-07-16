extends Node


func _ready() -> void:
	var input := RuntimeInputManager.new()
	add_child(input)
	var player := RuntimePlayer.new(input)
	player.set_x(100.0)
	player.set_y(200.0)
	player.sprite.update(0.0)

	var bubbles := RuntimeEmoteBubbleManager.new()
	add_child(bubbles)
	var debug_messages: Array[String] = []
	bubbles.set_debug_panel_log(func(message: String) -> void: debug_messages.push_back(message))
	bubbles.init({})
	assert(bubbles.serialize().is_empty())

	# Source fallback: without entityAttachLayer the bubble mounts in the anchor's
	# own display object instead of rejecting the request.
	var local_dismiss := bubbles.show_sticky(player, "本地")
	assert(local_dismiss.is_valid() and bubbles.active_bubbles.size() == 1)
	assert(bubbles.active_bubbles[0].parent == player.sprite)
	local_dismiss.call()
	assert(bubbles.active_bubbles.is_empty())

	var layer := Node2D.new()
	add_child(layer)
	layer.add_child(player.sprite)
	bubbles.set_entity_attach_layer(layer)
	bubbles.set_time_scale(0.0)

	# Direct entity child: bubble is a sibling on entityLayer and follows the
	# moving display object every update, preserving offsets and front band.
	var follow_dismiss := bubbles.show_sticky(
		player,
		"!",
		{"anchorOffsetX": 3.0, "anchorOffsetY": 4.0},
		"world",
	)
	assert(follow_dismiss.is_valid() and bubbles.active_bubbles.size() == 1)
	var follow_entry: Dictionary = bubbles.active_bubbles[0]
	assert(follow_entry.parent == layer and follow_entry.noAutoExpire == true)
	assert(follow_entry.follow is Dictionary and follow_entry.bubble.get_meta("entitySortBand") == "front")
	var before: Vector2 = follow_entry.bubble.position
	player.set_x(150.0)
	player.sprite.update(0.0)
	bubbles.update(0.016)
	assert(is_equal_approx(follow_entry.bubble.position.x, before.x + 50.0))
	assert(is_equal_approx(float(follow_entry.remainingMs), 0.0))

	# Hotspots use the authoritative world quad once and do not acquire follow.
	var hotspot := RuntimeHotspot.new({
		"id": "probe",
		"x": 300.0,
		"y": 400.0,
		"type": "inspect",
		"displayImage": {"image": "probe.png", "worldWidth": 100.0, "worldHeight": 80.0},
	})
	var image := Image.create_empty(10, 10, false, Image.FORMAT_RGBA8)
	image.fill(Color.WHITE)
	hotspot.set_display_texture(ImageTexture.create_from_image(image), 100.0, 80.0)
	layer.add_child(hotspot.container)
	var hotspot_dismiss := bubbles.show_sticky(hotspot, "?", {}, "cutscene")
	assert(hotspot_dismiss.is_valid() and bubbles.active_bubbles.size() == 2)
	var hotspot_entry: Dictionary = bubbles.active_bubbles[1]
	assert(hotspot_entry.parent == layer and hotspot_entry.follow == null)
	var quad := hotspot.get_emote_world_quad()
	var bubble_height := float((hotspot_entry.bubble.get_child(0) as Panel).size.y)
	assert(is_equal_approx(hotspot_entry.bubble.position.y, float(quad.top) - 8.0 - bubble_height))
	var fixed_hotspot_position: Vector2 = hotspot_entry.bubble.position
	hotspot.set_position(360.0, 460.0)
	bubbles.update(0.016)
	assert(hotspot_entry.bubble.position == fixed_hotspot_position)

	bubbles.cleanup_by_owner("cutscene")
	assert(bubbles.active_bubbles.size() == 1 and is_same(bubbles.active_bubbles[0], follow_entry))
	hotspot_dismiss.call() # already removed: returned dismiss is idempotent
	assert(bubbles.active_bubbles.size() == 1)

	# showAndWait owns an independent timer Promise while the normal update path
	# owns visual expiry, exactly as the TypeScript source does.
	var wait_state := {"done": false}
	var run_wait := func() -> void:
		await bubbles.show_and_wait(player, "...", 1000.0, {}, "action")
		wait_state.done = true
	run_wait.call()
	assert(bubbles.active_bubbles.size() == 2 and bubbles.pending_timers.size() == 1)
	bubbles.update(1.0)
	await get_tree().process_frame
	await get_tree().process_frame
	assert(wait_state.done == true and bubbles.pending_timers.is_empty())
	assert(bubbles.active_bubbles.size() == 1 and is_same(bubbles.active_bubbles[0], follow_entry))

	# Timed bubbles use raw dt and negative durations are not normalized.
	bubbles.set_time_scale(1.0)
	bubbles.show(player, "x", -5.0)
	assert(bubbles.active_bubbles.size() == 2)
	bubbles.update(0.0)
	assert(bubbles.active_bubbles.size() == 1)

	# A moving anchor removed from the tree invalidates its follow entry.
	player.destroy_player()
	layer.remove_child(player.sprite)
	bubbles.update(0.016)
	assert(bubbles.active_bubbles.is_empty())
	player.sprite.free()

	# deserialize/cleanup/destroy are symmetric and release injected references.
	bubbles.show_sticky(hotspot, "清")
	bubbles.deserialize({"ignored": true})
	assert(bubbles.active_bubbles.is_empty() and bubbles.pending_timers.is_empty())
	assert(debug_messages.any(func(message: String) -> bool: return message.begins_with("[EmoteBubble] mount 开始")))
	bubbles.destroy()
	assert(bubbles.entity_attach_layer == null and bubbles.debug_panel_log == null)

	hotspot.destroy_hotspot()
	remove_child(bubbles)
	bubbles.free()
	input.destroy()
	remove_child(input)
	input.free()
	remove_child(layer)
	layer.free()
	print("EmoteBubble module/field/mount/follow/hotspot/sticky/owner/wait/lifecycle direct-translation test: PASS")
	get_tree().quit(0)
