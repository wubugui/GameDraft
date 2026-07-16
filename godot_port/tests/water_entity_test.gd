extends Node


class AssetManagerStub extends RuntimeAssetManager:
	var paths: Array[String] = []
	var responses: Array[Variant] = []

	func load_texture(path: String) -> Variant:
		paths.push_back(path)
		return responses.pop_front() if not responses.is_empty() else null


var random_values: Array[float] = []
var random_calls := 0
var tap_count := 0
var tapped_entity: RuntimeWaterEntity
var tapped_event: Variant


func _ready() -> void:
	await _run()


func _run() -> void:
	var image := Image.create_empty(100, 50, false, Image.FORMAT_RGBA8)
	image.fill(Color.WHITE)
	var texture := ImageTexture.create_from_image(image)
	var assets := AssetManagerStub.new()
	var owned: Array[RuntimeWaterEntity] = []

	# parseHexColor keeps the source trim/#/3-digit/parseInt-prefix/bit-pack semantics.
	_assert_rgb(RuntimeWaterEntity._parse_hex_color(" #abc "), 0xaa, 0xbb, 0xcc)
	_assert_rgb(RuntimeWaterEntity._parse_hex_color("abc"), 0xff, 0xff, 0xff)
	_assert_rgb(RuntimeWaterEntity._parse_hex_color("#gg"), 0xff, 0xff, 0xff)
	_assert_rgb(RuntimeWaterEntity._parse_hex_color("#ff00zz"), 0x00, 0xff, 0x00)
	_assert_rgb(RuntimeWaterEntity._parse_hex_color("#0x12"), 0x00, 0x00, 0x12)
	_assert_rgb(RuntimeWaterEntity._parse_hex_color("#  ff"), 0x00, 0x00, 0xff)
	_assert_rgb(RuntimeWaterEntity._parse_hex_color("#-00ff"), 0xff, 0xff, 0x01)

	var definition := {
		"id": "fish",
		"category": "swimming",
		"sprite": "x",
		"pos": {"x": 100, "y": 120},
		"depth": 0.5,
		"displaySize": 68,
		"hitRadius": 42,
		"motion": {"path": "patrol", "speed": 1.0},
		"depthOsc": {"curve": "sine", "amplitude": 0.1, "period": 2.0},
		"glow": {"enabled": true, "color": "#66ccff", "daylightHint": 0.25},
	}
	random_values = [0.25, 0.75, 0.1]
	random_calls = 0
	var entity := RuntimeWaterEntity.new(definition, texture, assets, {"paramsEncode": true, "random": Callable(self, "_next_random")})
	owned.push_back(entity)
	assert(is_same(entity.def, definition))
	assert(entity.category == "swimming" and entity.container.position == Vector2(100, 120))
	assert(is_equal_approx(entity.depth_phase, PI * 0.5) and entity.start_x == 100.0 and entity.start_y == 120.0)
	assert(random_calls == 1 and entity.sprite.scale == Vector2(0.68, 0.68))
	assert(entity.sprite.get_parent() == entity.container and entity.params_sprite.get_parent() == entity.params_container)
	assert(entity.params_sprite.visible, "dedicated Godot params-pass viewport must keep its mirror resident")
	definition.hitRadius = 41
	assert(entity.hit_radius() == 41.0, "WaterEntity must retain the caller definition by identity")
	definition.hitRadius = 42

	entity.depth_phase = 0.0
	entity.update(1.0, {"time": "morning", "weather": "clear"}, Vector2.ZERO)
	assert(entity.motion_t == 1.0 and entity.container.position.x == 135.0)
	assert(entity.params_container.position == entity.container.position)
	assert(is_equal_approx(entity.sprite.position.y, entity.depth_offset_y()))
	assert(entity.params_sprite.position == entity.sprite.position and entity.params_sprite.rotation == entity.sprite.rotation and entity.params_sprite.scale == entity.sprite.scale)
	assert(is_equal_approx(float(entity.param_encode.get_shader_parameter("depth_value")), entity.effective_depth()))
	assert(is_equal_approx(float(entity.param_encode.get_shader_parameter("glow_value")), 0.25))
	entity.react_grass(3.0, 9.0, -4.0)
	assert(is_equal_approx(entity.sprite.rotation, sin(entity.motion_t * 6.0) * 0.06))

	entity.on_pointer_tap(Callable(self, "_record_tap"))
	var pointer_event := {"kind": "pointertap"}
	entity._emit_pointer_tap(pointer_event)
	assert(tap_count == 1 and tapped_entity == entity and is_same(tapped_event, pointer_event))
	entity.escaped = true
	entity._emit_pointer_tap(pointer_event)
	assert(tap_count == 1)
	entity.escaped = false

	# Display size and hit radius accept only finite positive numbers, then fall back by category.
	var default_grass := RuntimeWaterEntity.new(_definition("grass", "grass", {"displaySize": -2, "hitRadius": NAN}), texture, assets)
	owned.push_back(default_grass)
	assert(default_grass.hit_radius() == 42.0 and is_equal_approx(default_grass.sprite.scale.x, 0.7))
	var default_unknown := RuntimeWaterEntity.new(_definition("unknown", "other", {"displaySize": NAN, "hitRadius": 0}), texture, assets)
	owned.push_back(default_unknown)
	assert(default_unknown.hit_radius() == 30.0 and is_equal_approx(default_unknown.sprite.scale.x, 0.52))

	# glowStrength is independently clamped for the parameter pass.
	var glow_entity := RuntimeWaterEntity.new(_definition("glow", "sunken", {"glow": {"enabled": true, "color": "#fff"}}), texture, assets, {"paramsEncode": true})
	owned.push_back(glow_entity)
	assert(is_equal_approx(glow_entity._glow_strength(), 0.45))
	glow_entity.def.glow.daylightHint = 3.0
	assert(glow_entity._glow_strength() == 1.0)
	glow_entity.def.glow.daylightHint = -2.0
	assert(glow_entity._glow_strength() == 0.0)
	glow_entity.def.glow.enabled = false
	assert(glow_entity._glow_strength() == 0.0)

	# effectiveDepth covers the source's sine, approach_surface and generic else branch.
	entity.def.depth = 0.5
	entity.depth_phase = 0.0
	entity.motion_t = 0.5
	entity.def.depthOsc = {"curve": "sine", "amplitude": 0.1, "period": 2.0}
	assert(is_equal_approx(entity.effective_depth(), 0.6))
	entity.motion_t = 0.0
	entity.def.depthOsc = {"curve": "approach_surface", "amplitude": 0.1, "period": 2.0}
	assert(is_equal_approx(entity.effective_depth(), 0.45))
	entity.motion_t = 0.5
	entity.depth_phase = 0.2
	entity.def.depthOsc = {"curve": "future_curve", "amplitude": 0.2, "period": 1.0}
	assert(is_equal_approx(entity.effective_depth(), maxf(0.0, 0.5 + sin(0.5 * 3.1 + 0.2) * 0.1)))
	entity.def.depth = -3.0
	entity.def.depthOsc = {"curve": "none", "amplitude": 0.0, "period": 1.0}
	assert(entity.effective_depth() == 0.0)

	# update consumes raw dt, preserves each path formula, and consumes jitter RNG in x/y order.
	entity.def.depth = 0.5
	entity.def.depthOsc = {"curve": "none", "amplitude": 0.0, "period": 1.0}
	entity.def.motion = {"path": "patrol", "speed": 1.0}
	entity.motion_t = 0.0
	entity.container.position = Vector2(100, 120)
	entity.patrol_dir = 1.0
	entity.update(-0.5, {"time": "day", "weather": "clear"}, Vector2.ZERO)
	assert(entity.motion_t == -0.5 and entity.container.position.x == 82.5, "negative dt must not be silently clamped")

	var approach := RuntimeWaterEntity.new(_definition("approach", "swimming", {"motion": {"path": "approach", "speed": 1.0}}), texture, assets, {"random": func() -> float: return 0.0})
	owned.push_back(approach)
	approach.update(1.0, {"time": "day", "weather": "clear"}, Vector2(3, 4))
	assert(is_equal_approx(approach.container.position.x, 3.0 / 5.0001 * 40.0) and is_equal_approx(approach.container.position.y, 4.0 / 5.0001 * 40.0))

	var flee_motion := RuntimeWaterEntity.new(_definition("flee_motion", "swimming", {"pos": {"x": 3, "y": 4}, "motion": {"path": "flee", "speed": 0.5}}), texture, assets, {"random": func() -> float: return 0.0})
	owned.push_back(flee_motion)
	flee_motion.update(0.2, {"time": "day", "weather": "clear"}, Vector2.ZERO)
	var flee_factor := 0.5 * 0.2 * (18.0 + 0.2 * 4.0)
	assert(is_equal_approx(flee_motion.container.position.x, 3.0 + 3.0 / 5.0001 * flee_factor))
	assert(is_equal_approx(flee_motion.container.position.y, 4.0 + 4.0 / 5.0001 * flee_factor))

	random_values = [0.25, 0.75, 0.1]
	random_calls = 0
	var jitter := RuntimeWaterEntity.new(_definition("jitter", "swimming", {"motion": {"path": "stationary", "jitter": 0.5}}), texture, assets, {"random": Callable(self, "_next_random")})
	owned.push_back(jitter)
	jitter.update(2.0, {"time": "day", "weather": "clear"}, Vector2.ZERO)
	assert(random_calls == 3 and is_equal_approx(jitter.container.position.x, 7.5) and is_equal_approx(jitter.container.position.y, -12.0))

	var floating := RuntimeWaterEntity.new(_definition("floating", "floating"), texture, assets, {"random": func() -> float: return 0.0})
	owned.push_back(floating)
	floating.update(1.0, {"time": "day", "weather": "clear"}, Vector2.ZERO)
	assert(is_equal_approx(floating.container.position.x, sin(0.4) * 6.0) and is_equal_approx(floating.container.position.y, cos(0.35) * 4.0))

	# Pixi packs rounded tint channels with &255; values above one wrap instead of clamp.
	floating.motion_t = 0.0
	floating.container.position = Vector2.ZERO
	floating.update(0.0, {"time": "morning", "weather": "clear"}, Vector2.ZERO)
	var luminance := 1.1 - 0.35 * 0.35
	assert(is_equal_approx(floating.sprite.modulate.r, _packed_channel(luminance * 1.05)))
	assert(is_equal_approx(floating.sprite.modulate.g, _packed_channel(luminance * 0.98 * 0.97)))
	assert(is_equal_approx(floating.sprite.modulate.b, _packed_channel(luminance * 1.02 * 0.9)))

	var flee_deadline := RuntimeWaterEntity.new(_definition("deadline", "swimming", {"motion": {"path": "flee", "speed": 0.5}}), texture, assets, {"paramsEncode": true, "random": func() -> float: return 0.0})
	owned.push_back(flee_deadline)
	flee_deadline.set_flee_deadline(1.1)
	assert(flee_deadline.flee_deadline_ms == 250.0)
	flee_deadline.update(0.3, {"time": "night", "weather": "fog"}, Vector2.ZERO)
	assert(flee_deadline.is_escaped() and not flee_deadline.container.visible and not flee_deadline.params_container.visible)

	# loadEntityTexture strips one leading slash, yields the Promise boundary, and falls back to 1x1 white.
	assets.responses = [texture, null, null]
	var loaded := await RuntimeWaterEntity.load_entity_texture(assets, "/fish.png")
	var fallback := await RuntimeWaterEntity.load_entity_texture(assets, "missing.png")
	var fallback_again := await RuntimeWaterEntity.load_entity_texture(assets, "missing-again.png")
	assert(assets.paths.slice(-3) == ["fish.png", "missing.png", "missing-again.png"] and loaded == texture)
	assert(fallback.get_width() == 1 and fallback.get_height() == 1 and fallback.get_image().get_pixel(0, 0) == Color.WHITE)
	assert(fallback == fallback_again, "Texture.WHITE fallback must preserve singleton identity")

	for value: RuntimeWaterEntity in owned:
		_dispose(value)
	print("WaterEntity module/field/constructor/depth/motion/tint/input/resource direct-translation test: PASS")
	get_tree().quit(0)


func _definition(id: String, category: String, overrides: Dictionary = {}) -> Dictionary:
	var result := {"id": id, "category": category, "sprite": "x", "pos": {"x": 0, "y": 0}, "depth": 0.0}
	result.merge(overrides, true)
	return result


func _next_random() -> float:
	random_calls += 1
	return random_values.pop_front()


func _record_tap(entity: RuntimeWaterEntity, event: Variant) -> void:
	tap_count += 1
	tapped_entity = entity
	tapped_event = event


func _packed_channel(value: float) -> float:
	return float(int(floorf(value * 255.0 + 0.5)) & 255) / 255.0


func _assert_rgb(value: Dictionary, red: int, green: int, blue: int) -> void:
	assert(is_equal_approx(float(value.r), float(red) / 255.0))
	assert(is_equal_approx(float(value.g), float(green) / 255.0))
	assert(is_equal_approx(float(value.b), float(blue) / 255.0))


func _dispose(entity: RuntimeWaterEntity) -> void:
	entity.destroy()
	if entity.params_container != null and is_instance_valid(entity.params_container):
		entity.params_container.free()
	if is_instance_valid(entity.container):
		entity.container.free()
