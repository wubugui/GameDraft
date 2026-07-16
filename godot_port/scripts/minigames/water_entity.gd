class_name RuntimeWaterEntity
extends RefCounted

const PARAM_SHADER := preload("res://scripts/minigames/water_param_encode.gdshader")
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")
const DEFAULT_DISPLAY_SIZE := {"grass": 70.0, "sunken": 62.0, "floating": 46.0, "swimming": 52.0}
const DEFAULT_HIT_RADIUS := {"grass": 42.0, "swimming": 34.0, "sunken": 38.0, "floating": 30.0}

# Engine adapter for Pixi's process-wide Texture.WHITE singleton.
static var _texture_white: Texture2D


static func _parse_hex_color(value: String) -> Dictionary:
	var text := value.strip_edges()
	if not text.begins_with("#"):
		return {"r": 1.0, "g": 1.0, "b": 1.0}
	var hex := text.substr(1)
	var full := ""
	if hex.length() == 3:
		for character_index: int in hex.length():
			var character := hex.substr(character_index, 1)
			full += character + character
	else:
		full = hex
	full = full.strip_edges(true, false)
	var sign := 1
	var index := 0
	if full.begins_with("-"):
		sign = -1
		index = 1
	elif full.begins_with("+"):
		index = 1
	if full.substr(index, 2).to_lower() == "0x":
		index += 2
	var number := 0.0
	var parsed := false
	var digits := "0123456789abcdef"
	while index < full.length():
		var digit := digits.find(full.substr(index, 1).to_lower())
		if digit < 0:
			break
		number = number * 16.0 + float(digit)
		if not is_finite(number):
			return {"r": 1.0, "g": 1.0, "b": 1.0}
		parsed = true
		index += 1
	if not parsed:
		return {"r": 1.0, "g": 1.0, "b": 1.0}
	number *= float(sign)
	var uint32 := int(fposmod(number, 4294967296.0))
	return {
		"r": float((uint32 >> 16) & 255) / 255.0,
		"g": float((uint32 >> 8) & 255) / 255.0,
		"b": float(uint32 & 255) / 255.0,
	}


var def: Dictionary
var category := ""
var sprite: Sprite2D
var container: Node2D
var params_sprite: Sprite2D

var motion_t := 0.0
var depth_phase := 0.0
var random: Callable
var patrol_dir := 1.0
var start_x := 0.0
var start_y := 0.0
var flee_bursts := 0.0
var escaped := false
var flee_deadline_ms: Variant = null
var param_encode: ShaderMaterial

# Godot renders the color and parameter passes through separate SubViewports.
# Pixi can keep both sprites in one Container and toggle them per render pass;
# this host mirrors the source paramsSprite geometry without duplicating state.
var params_container: Node2D
var _pointer_tap_callbacks: Array[Callable] = []


func _init(
	definition: Dictionary,
	texture: Texture2D,
	_asset_manager: RuntimeAssetManager,
	options: Dictionary = {},
) -> void:
	def = definition
	category = str(def.category)
	var provided_random: Variant = options.get("random")
	random = provided_random if provided_random is Callable and provided_random.is_valid() else func() -> float: return randf()
	depth_phase = float(random.call()) * PI * 2.0
	start_x = float(def.pos.x)
	start_y = float(def.pos.y)

	container = Node2D.new()
	container.position = Vector2(start_x, start_y)
	container.name = str(def.get("id", "WaterEntity"))

	sprite = Sprite2D.new()
	sprite.texture = texture
	sprite.centered = true
	sprite.name = "ColorSprite"
	var base := maxf(texture.get_width(), texture.get_height())
	var display_size: Variant = def.get("displaySize")
	var target := float(display_size) if (display_size is int or display_size is float) and is_finite(float(display_size)) and float(display_size) > 0.0 else float(DEFAULT_DISPLAY_SIZE.get(category, 52.0))
	var scale_value := target / base if base > 0.0 else 1.0
	sprite.scale = Vector2(scale_value, scale_value)

	if options.get("paramsEncode") == true:
		param_encode = ShaderMaterial.new()
		param_encode.shader = PARAM_SHADER
		params_sprite = Sprite2D.new()
		params_sprite.texture = texture
		params_sprite.centered = true
		params_sprite.scale = Vector2(scale_value, scale_value)
		params_sprite.material = param_encode
		# The source toggles this sprite on only while rendering its params pass.
		# A dedicated Godot SubViewport is that pass, so its resident mirror stays on.
		params_sprite.visible = true
		container.add_child(sprite)
		params_container = Node2D.new()
		params_container.position = container.position
		params_container.name = "%s_Params" % def.get("id", "WaterEntity")
		params_container.add_child(params_sprite)
	else:
		container.add_child(sprite)

	_apply_tint()


func hit_radius() -> float:
	var radius: Variant = def.get("hitRadius")
	if (radius is int or radius is float) and is_finite(float(radius)) and float(radius) > 0.0:
		return float(radius)
	return float(DEFAULT_HIT_RADIUS.get(category, 30.0))


func _glow_strength() -> float:
	var glow: Variant = def.get("glow")
	if not glow is Dictionary or glow.get("enabled") != true:
		return 0.0
	var hint: Variant = glow.get("daylightHint")
	return minf(1.0, maxf(0.0, float(hint) if hint is int or hint is float else 0.45))


func set_flee_deadline(total_search_sec: float) -> void:
	var motion: Variant = def.get("motion")
	if motion is Dictionary and motion.get("path") == "flee" and category == "swimming":
		var lead_sec := maxf(0.25, total_search_sec - 1.0)
		flee_deadline_ms = lead_sec * 1000.0


func is_escaped() -> bool:
	return escaped


func depth_offset_y() -> float:
	var depth := minf(effective_depth(), 1.35)
	return depth * 18.0


func effective_depth() -> float:
	var base := maxf(0.0, float(def.get("depth", 0.0)))
	var oscillation: Variant = def.get("depthOsc")
	if not oscillation is Dictionary or oscillation.get("curve") == "none" or float(oscillation.get("amplitude", 0.0)) == 0.0:
		return base
	var period := maxf(0.15, float(oscillation.get("period", 0.0)))
	var addition := 0.0
	if oscillation.get("curve") == "sine":
		addition = sin(depth_phase + motion_t / period * PI * 2.0) * float(oscillation.amplitude)
	elif oscillation.get("curve") == "approach_surface":
		var t := sin(motion_t / period) * 0.5 + 0.5
		addition = -t * float(oscillation.amplitude)
	else:
		addition = sin(motion_t * 3.1 + depth_phase) * 0.5 * float(oscillation.amplitude)
	return maxf(0.0, base + addition)


func react_grass(_strength: float, _dir_x: float, _dir_y: float) -> void:
	sprite.rotation = sin(motion_t * 6.0) * 0.06


func _apply_tint(ambient: Variant = null) -> void:
	var depth_visual := minf(effective_depth(), 1.0)
	var murk := 0.35
	if ambient is Dictionary:
		if ambient.get("weather") == "rain":
			murk = 0.55
		elif ambient.get("weather") == "fog":
			murk = 0.8
	var luminance := 1.1 - depth_visual * 0.55 - murk * 0.35
	var red := luminance
	var green := luminance * 0.98
	var blue := luminance * 1.02
	var glow: Variant = def.get("glow")
	var glow_color_value: Variant = glow.get("color") if glow is Dictionary else null
	if glow is Dictionary and glow.get("enabled") == true and glow_color_value is String and not glow_color_value.is_empty():
		var glow_color := _parse_hex_color(glow_color_value)
		var raw_hint: Variant = glow.get("daylightHint")
		var hint := float(raw_hint) if raw_hint != null else 0.4
		red = red * (1.0 - hint) + float(glow_color.r) * hint
		green = green * (1.0 - hint) + float(glow_color.g) * hint
		blue = blue * (1.0 - hint) + float(glow_color.b) * hint
	if ambient is Dictionary and ambient.get("time") == "night":
		red *= 0.55
		green *= 0.6
		blue *= 0.75
	elif ambient is Dictionary and ambient.get("time") == "morning":
		red *= 1.05
		green *= 0.97
		blue *= 0.9
	sprite.modulate = Color(
		float(int(floorf(red * 255.0 + 0.5)) & 255) / 255.0,
		float(int(floorf(green * 255.0 + 0.5)) & 255) / 255.0,
		float(int(floorf(blue * 255.0 + 0.5)) & 255) / 255.0,
		1.0,
	)


func update(dt: float, ambient: Dictionary, cursor_world: Vector2) -> void:
	if escaped:
		return
	motion_t += dt

	var motion: Variant = def.get("motion")
	if flee_deadline_ms != null and motion is Dictionary and motion.get("path") == "flee" and motion_t * 1000.0 >= float(flee_deadline_ms):
		escaped = true
		container.visible = false
		if params_sprite != null:
			params_sprite.visible = false
		if params_container != null:
			params_container.visible = false
		return

	var speed := float(motion.get("speed", 0.0)) if motion is Dictionary else 0.0
	var jitter := float(motion.get("jitter", 0.0)) if motion is Dictionary else 0.0
	if category == "swimming" and motion is Dictionary:
		if motion.get("path") == "drift":
			container.position.x += sin(motion_t * 0.7 + depth_phase) * speed * dt * 12.0
			container.position.y += cos(motion_t * 0.55) * speed * dt * 8.0
		elif motion.get("path") == "patrol":
			container.position.x += patrol_dir * speed * dt * 35.0
			if container.position.x > start_x + 90.0:
				patrol_dir = -1.0
			if container.position.x < start_x - 90.0:
				patrol_dir = 1.0
		elif motion.get("path") == "approach":
			var dx := cursor_world.x - container.position.x
			var dy := cursor_world.y - container.position.y
			var length := sqrt(dx * dx + dy * dy) + 1e-4
			container.position.x += dx / length * speed * dt * 40.0
			container.position.y += dy / length * speed * dt * 40.0
		elif motion.get("path") == "flee":
			flee_bursts += dt
			var dx := container.position.x - cursor_world.x
			var dy := container.position.y - cursor_world.y
			var length := sqrt(dx * dx + dy * dy) + 1e-4
			container.position.x += dx / length * speed * dt * (18.0 + flee_bursts * 4.0)
			container.position.y += dy / length * speed * dt * (18.0 + flee_bursts * 4.0)
		if jitter > 0.0:
			container.position.x += (float(random.call()) - 0.5) * jitter * dt * 30.0
			container.position.y += (float(random.call()) - 0.5) * jitter * dt * 30.0
	elif category == "floating":
		container.position.x += sin(motion_t * 0.4) * dt * 6.0
		container.position.y += cos(motion_t * 0.35) * dt * 4.0

	sprite.position.y = depth_offset_y()
	if params_sprite != null and param_encode != null:
		params_container.position = container.position
		params_container.visible = container.visible
		params_sprite.position.y = sprite.position.y
		params_sprite.rotation = sprite.rotation
		params_sprite.scale = sprite.scale
		var depth := effective_depth()
		param_encode.set_shader_parameter("depth_value", maxf(0.0, depth) if is_finite(depth) else 0.0)
		param_encode.set_shader_parameter("glow_value", maxf(0.0, minf(1.0, _glow_strength())))
	_apply_tint(ambient)


func on_pointer_tap(callback: Callable) -> void:
	if callback.is_valid():
		_pointer_tap_callbacks.push_back(callback)


func _emit_pointer_tap(event: Variant = null) -> void:
	if escaped:
		return
	for callback: Callable in _pointer_tap_callbacks.duplicate():
		if callback.is_valid():
			callback.call(self, event)


func destroy() -> void:
	_pointer_tap_callbacks.clear()
	if params_sprite != null:
		params_sprite.material = null
	param_encode = null


static func load_entity_texture(asset_manager: RuntimeAssetManager, path: String) -> Texture2D:
	var normalized := path.substr(1) if path.begins_with("/") else path
	var texture: Variant = asset_manager.load_texture(normalized)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if texture is Texture2D:
		return texture
	if _texture_white == null:
		var image := Image.create_empty(1, 1, false, Image.FORMAT_RGBA8)
		image.fill(Color.WHITE)
		_texture_white = ImageTexture.create_from_image(image)
	return _texture_white
