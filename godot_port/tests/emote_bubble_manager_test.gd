extends Node


func _ready() -> void:
	var layer := Node2D.new(); add_child(layer); var input := RuntimeInputManager.new(); add_child(input); var player := RuntimePlayer.new(input); layer.add_child(player.sprite); player.set_x(100); player.set_y(200); player.sprite.update(0)
	var bubbles := RuntimeEmoteBubbleManager.new(); add_child(bubbles); bubbles.set_entity_attach_layer(layer); bubbles.set_time_scale(0.0)
	var follow_id := bubbles.show_sticky(player, "!", {"anchorOffsetX": 3, "anchorOffsetY": 4}, "world"); assert(follow_id > 0 and bubbles.active_bubbles.size() == 1); var before: Vector2 = bubbles.active_bubbles[0].bubble.position; player.set_x(150); player.sprite.update(0); bubbles.update(0.016); assert(is_equal_approx(bubbles.active_bubbles[0].bubble.position.x, before.x + 50))
	var hotspot := RuntimeHotspot.new({"id": "probe", "x": 300, "y": 400, "type": "inspect", "displayImage": {"image": "probe.png", "worldWidth": 100, "worldHeight": 80}}); var image := Image.create_empty(10, 10, false, Image.FORMAT_RGBA8); image.fill(Color.WHITE); hotspot.set_display_texture(ImageTexture.create_from_image(image), 100, 80); layer.add_child(hotspot.container); var hotspot_id := bubbles.show_sticky(hotspot, "?", {}, "cutscene"); assert(hotspot_id > 0 and bubbles.active_bubbles.size() == 2); var hotspot_bubble: Node2D = bubbles.active_bubbles[1].bubble; assert(hotspot_bubble.position.y < 320)
	bubbles.cleanup_by_owner("cutscene"); assert(bubbles.active_bubbles.size() == 1 and int(bubbles.active_bubbles[0].id) == follow_id)
	await bubbles.show_and_wait(player, "...", 1000, {}, "action"); assert(bubbles.active_bubbles.size() == 1)
	bubbles.dismiss(follow_id); assert(bubbles.active_bubbles.is_empty()); bubbles.show(player, "x", 1000); player.destroy_player(); bubbles.update(0.016); assert(bubbles.active_bubbles.is_empty())
	hotspot.destroy_hotspot(); bubbles.destroy(); remove_child(bubbles); bubbles.free(); input.destroy(); remove_child(input); input.free(); remove_child(layer); layer.free(); print("EmoteBubble follow/hotspot/sticky/owner/wait lifecycle test: PASS"); get_tree().quit(0)
