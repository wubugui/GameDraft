extends RefCounted


static func bind(manager: RuntimeSceneManager, player: RuntimePlayer, camera: RuntimeCamera) -> void:
	RuntimeEntityRuntimeFieldSchema.configure(manager.asset_manager)
	manager.set_player_position_setter(func(x: float, y: float) -> void:
		player.set_x(x)
		player.set_y(y)
	)
	manager.set_camera_setter(func(bounds_width: float, bounds_height: float, snap_x: float, snap_y: float, camera_config: Variant, world_scale: float) -> void:
		camera.set_bounds(bounds_width, bounds_height)
		camera.set_pixels_per_unit(float(camera_config.get("pixelsPerUnit", 1.0)) if camera_config is Dictionary else 1.0)
		camera.set_zoom(float(camera_config.get("zoom", 1.0)) if camera_config is Dictionary else 1.0)
		camera.set_world_scale(world_scale)
		camera.snap_to(snap_x, snap_y)
	)
	manager.set_bounds_only_setter(func(width: float, height: float) -> void: camera.set_bounds(width, height))
