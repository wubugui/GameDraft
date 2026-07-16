class_name RuntimePlaceholderFactory
extends RefCounted


static func create_placeholder_background(_renderer: Variant, width: float, height: float) -> Node2D:
	var container := Node2D.new()
	var background := Polygon2D.new()
	background.polygon = PackedVector2Array([
		Vector2.ZERO,
		Vector2(width, 0.0),
		Vector2(width, height),
		Vector2(0.0, height),
	])
	background.color = Color("2a2a3e")
	container.add_child(background)
	for x in range(0, ceili(width), 80):
		container.add_child(_grid_line(Vector2(float(x), 0.0), Vector2(float(x), height)))
	for y in range(0, ceili(height), 80):
		container.add_child(_grid_line(Vector2(0.0, float(y)), Vector2(width, float(y))))
	return container


static func create_placeholder_player_textures(_renderer: Variant = null) -> Dictionary:
	var frame_width := 32
	var frame_height := 48
	var frame_count := 6
	var image := Image.create(frame_width * frame_count, frame_height, false, Image.FORMAT_RGBA8)
	image.fill(Color(0.0, 0.0, 0.0, 0.0))
	for index in frame_count:
		var x := index * frame_width
		var brightness := Color8(0xd4, 0xa5, 0x74) if index < 2 else (Color8(0xc4, 0x95, 0x64) if index % 2 == 0 else Color8(0xb4, 0x85, 0x54))
		_fill_circle(image, Vector2i(x + 16, 12), 7, brightness)
		image.fill_rect(Rect2i(x + 10, 19, 12, 16), brightness)
		if index >= 2:
			var leg_offset := 0 if index % 2 == 0 else 4
			image.fill_rect(Rect2i(x + 10 + leg_offset, 35, 5, 12), brightness)
			image.fill_rect(Rect2i(x + 17 - leg_offset, 35, 5, 12), brightness)
		else:
			image.fill_rect(Rect2i(x + 11, 35, 4, 12), brightness)
			image.fill_rect(Rect2i(x + 17, 35, 4, 12), brightness)
	return {
		"texture": ImageTexture.create_from_image(image),
		"frameWidth": frame_width,
		"frameHeight": frame_height,
	}


static func _grid_line(from: Vector2, to: Vector2) -> Line2D:
	var line := Line2D.new()
	line.width = 1.0
	line.default_color = Color("3a3a4e")
	line.points = PackedVector2Array([from, to])
	return line


static func _fill_circle(image: Image, center: Vector2i, radius: int, color: Color) -> void:
	var radius_squared := radius * radius
	for y in range(center.y - radius, center.y + radius + 1):
		for x in range(center.x - radius, center.x + radius + 1):
			var dx := x - center.x
			var dy := y - center.y
			if dx * dx + dy * dy <= radius_squared:
				image.set_pixel(x, y, color)
