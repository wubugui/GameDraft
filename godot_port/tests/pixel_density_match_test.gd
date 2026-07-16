extends SceneTree


func _init() -> void:
	assert(RuntimeEntityPixelDensityMatch.DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE == 0.25)
	assert(RuntimeEntityPixelDensityMatch.compute_pixel_density_k(100, 200, 50, 100, Vector2(2, 2)) == 1.0)
	assert(RuntimeEntityPixelDensityMatch.compute_pixel_density_k(400, 200, 50, 100, Vector2(2, 2)) == 4.0)
	assert(RuntimeEntityPixelDensityMatch.compute_pixel_density_k(400, 200, 0, 100, Vector2(2, 2)) == 1.0)
	assert(RuntimeEntityPixelDensityMatch.blur_strength_from_pixel_density_k(1.0, 0.25) == 0.0)
	assert(is_equal_approx(RuntimeEntityPixelDensityMatch.blur_strength_from_pixel_density_k(5.0, 0.25), 0.09))
	assert(is_equal_approx(RuntimeEntityPixelDensityMatch.blur_strength_from_pixel_density_k(5.0, -2.0), 0.36))
	assert(RuntimeEntityPixelDensityMatch.blur_strength_from_pixel_density_k(1000000.0, 5.0) == 12.0)
	var filter := RuntimeEntityPixelDensityMatch.create_pixel_density_blur_filter(-3.0)
	assert(filter.strength == 0.0 and filter.quality == 3 and not filter.destroyed)
	filter.strength = 0.5
	filter.destroy()
	assert(filter.strength == 0.5 and filter.destroyed)
	print("Entity pixel-density K/blur/filter direct-translation test: PASS")
	quit(0)
