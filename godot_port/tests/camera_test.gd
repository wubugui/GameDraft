extends SceneTree


func _init() -> void:
	var world := Node2D.new(); var camera := RuntimeCamera.new(world)
	camera.set_screen_size(800, 600); camera.set_bounds(2000, 1000); camera.set_pixels_per_unit(2)
	assert(camera.get_projection_scale() == 2 and camera.get_view_width() == 400 and camera.get_view_height() == 300)
	camera.snap_to(0, 0)
	assert(camera.get_x() == 200 and camera.get_y() == 150 and world.position == RuntimeCamera.RASTER_PHASE and world.scale == Vector2(2, 2))
	camera.snap_to(1000, 500)
	assert(world.position == Vector2(-1600, -700) + RuntimeCamera.RASTER_PHASE)
	assert(camera.screen_to_world(400, 300) == Vector2(1000, 500))
	camera.follow(2000, 1000); camera.update(1.0 / 60.0)
	assert(is_equal_approx(camera.get_x(), 1080.0) and is_equal_approx(camera.get_y(), 535.0))
	camera.set_zoom(2); assert(camera.get_projection_scale() == 4 and camera.get_view_width() == 200 and camera.get_zoom() == 2)
	camera.set_world_scale(0.5); assert(camera.get_projection_scale() == 2 and camera.get_world_scale() == 0.5)
	camera.set_bounds(100, 80); camera.snap_to(0, 0); assert(camera.get_x() == 50 and camera.get_y() == 40)

	camera.set_bounds(0, 0); camera.set_screen_size(801, 601); camera.set_pixels_per_unit(1); camera.set_zoom(1); camera.set_world_scale(1); camera.snap_to(100.25, 50.25)
	camera.set_pixel_snap_translation(true)
	var unsnapped := world.position; camera.update(0.0)
	assert(unsnapped - RuntimeCamera.RASTER_PHASE != (unsnapped - RuntimeCamera.RASTER_PHASE).round() and world.position - RuntimeCamera.RASTER_PHASE == (world.position - RuntimeCamera.RASTER_PHASE).round())
	camera.set_zoom(1.01); assert(world.position - RuntimeCamera.RASTER_PHASE != (world.position - RuntimeCamera.RASTER_PHASE).round())
	camera.set_zoom(1.0); camera.snap_to(420.0, 320.0); camera.update(0.0)
	assert(world.position.y - RuntimeCamera.RASTER_PHASE.y == -19.0)
	world.free(); print("Camera projection/follow/bounds test: PASS"); quit(0)
