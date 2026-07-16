extends SceneTree

const PlaceholderFactory := preload("res://scripts/rendering/placeholder_factory.gd")


func _init() -> void:
	var placeholder: Dictionary = PlaceholderFactory.create_placeholder_player_textures()
	var texture: Texture2D = placeholder.texture
	assert(placeholder.frameWidth == 32 and placeholder.frameHeight == 48)
	assert(texture.get_width() == 192 and texture.get_height() == 48)
	var image := texture.get_image()
	assert(image.get_pixel(16, 12).is_equal_approx(Color8(0xd4, 0xa5, 0x74)))
	assert(image.get_pixel(80, 12).is_equal_approx(Color8(0xc4, 0x95, 0x64)))
	assert(image.get_pixel(112, 12).is_equal_approx(Color8(0xb4, 0x85, 0x54)))
	assert(image.get_pixel(0, 0).a == 0.0)
	var background: Node2D = PlaceholderFactory.create_placeholder_background(null, 160.0, 80.0)
	assert(background.get_child_count() == 4)
	background.free()
	print("PlaceholderFactory background/player atlas direct-translation test: PASS")
	quit(0)
