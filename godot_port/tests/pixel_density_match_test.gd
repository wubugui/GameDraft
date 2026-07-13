extends SceneTree


func _init() -> void:
	assert(RuntimeEntityPixelDensityMatch.compute_k(100, 200, 50, 100, Vector2(2, 2)) == 1.0)
	assert(RuntimeEntityPixelDensityMatch.compute_k(400, 200, 50, 100, Vector2(2, 2)) == 4.0)
	assert(RuntimeEntityPixelDensityMatch.compute_k(400, 200, 0, 100, Vector2(2, 2)) == 1.0)
	assert(RuntimeEntityPixelDensityMatch.blur_strength(1.0, 0.25) == 0.0)
	assert(is_equal_approx(RuntimeEntityPixelDensityMatch.blur_strength(5.0, 0.25), 0.09))
	assert(is_equal_approx(RuntimeEntityPixelDensityMatch.blur_strength(5.0, -2.0), 0.36))
	assert(RuntimeEntityPixelDensityMatch.blur_strength(1000000.0, 5.0) == 12.0)
	assert(is_equal_approx(RuntimeEntityPixelDensityMatch.blur_radius_texels(5.0, 0.25, Vector2(400, 200), Vector2(50, 100), 2.0), 0.36))
	var image := Image.create_empty(32, 24, false, Image.FORMAT_RGBA8)
	var atlas := AtlasTexture.new(); atlas.atlas = ImageTexture.create_from_image(image); atlas.region = Rect2(4, 3, 11, 9)
	assert(RuntimeEntityPixelDensityMatch.texture_frame_size(atlas) == Vector2(11, 9))
	print("Entity pixel-density K/blur/frame parity test: PASS")
	quit(0)
