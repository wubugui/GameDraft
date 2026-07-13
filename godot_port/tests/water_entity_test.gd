extends Node


func _ready() -> void:
	var image := Image.create_empty(100, 50, false, Image.FORMAT_RGBA8); image.fill(Color.WHITE); var texture := ImageTexture.create_from_image(image)
	var definition := {"id": "fish", "category": "swimming", "sprite": "x", "pos": {"x": 100, "y": 120}, "depth": 0.5, "displaySize": 68, "hitRadius": 42, "motion": {"path": "patrol", "speed": 1.0}, "depthOsc": {"curve": "sine", "amplitude": 0.1, "period": 2.0}, "glow": {"enabled": true, "color": "#66ccff", "daylightHint": 0.25}}
	var entity := RuntimeWaterEntity.new(definition, texture, true); add_child(entity.container); add_child(entity.params_container); entity.depth_phase = 0.0
	assert(entity.category == "swimming" and entity.hit_radius() == 42 and entity.sprite.scale == Vector2(0.68, 0.68) and entity.params_sprite != null)
	entity.update(1.0, {"time": "morning", "weather": "clear"}, Vector2.ZERO)
	assert(entity.container.position.x == 135.0 and entity.params_container.position == entity.container.position and is_equal_approx(entity.sprite.position.y, entity.depth_offset_y()))
	assert(is_equal_approx(float(entity.param_material.get_shader_parameter("depth_value")), entity.effective_depth()) and is_equal_approx(float(entity.param_material.get_shader_parameter("glow_value")), 0.25))
	entity.react_grass(); assert(absf(entity.sprite.rotation) <= 0.06)
	var default_grass := RuntimeWaterEntity.new({"id": "g", "category": "grass", "sprite": "x", "pos": {"x": 0, "y": 0}, "depth": 0.1}, texture); assert(default_grass.hit_radius() == 42 and is_equal_approx(default_grass.sprite.scale.x, 0.7))
	var flee := RuntimeWaterEntity.new({"id": "f", "category": "swimming", "sprite": "x", "pos": {"x": 20, "y": 20}, "depth": 0.4, "motion": {"path": "flee", "speed": 0.5}}, texture); flee.set_flee_deadline(1.1); flee.update(0.3, {"time": "night", "weather": "fog"}, Vector2.ZERO); assert(flee.is_escaped() and not flee.is_visible())
	entity.destroy(); default_grass.destroy(); flee.destroy(); remove_child(entity.container); entity.container.free(); remove_child(entity.params_container); entity.params_container.free(); default_grass.container.free(); flee.container.free()
	print("WaterEntity size/hit/depth/motion/glow/flee/param-pass contract test: PASS"); get_tree().quit(0)
