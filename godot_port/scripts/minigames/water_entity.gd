class_name RuntimeWaterEntity
extends RefCounted

const DEFAULT_DISPLAY_SIZE := {"grass": 70.0, "sunken": 62.0, "floating": 46.0, "swimming": 52.0}
const DEFAULT_HIT_RADIUS := {"grass": 42.0, "swimming": 34.0, "sunken": 38.0, "floating": 30.0}
const PARAM_SHADER := preload("res://scripts/minigames/water_param_encode.gdshader")

var def: Dictionary
var category := ""
var container := Node2D.new()
var sprite := Sprite2D.new()
var params_container: Node2D
var params_sprite: Sprite2D
var param_material: ShaderMaterial
var motion_time := 0.0
var depth_phase := 0.0
var rng := Callable()
var patrol_direction := 1.0
var start_position := Vector2.ZERO
var flee_bursts := 0.0
var escaped := false
var flee_deadline_ms: Variant = null


func _init(definition: Dictionary, texture: Texture2D, encode_params: bool = false, random_provider: Callable = Callable()) -> void:
	rng = random_provider if random_provider.is_valid() else func() -> float: return randf()
	depth_phase = float(rng.call()) * PI * 2.0
	def = definition.duplicate(true); category = str(def.get("category", "")); start_position = Vector2(float(def.pos.x), float(def.pos.y)); container.position = start_position; container.name = str(def.get("id", "WaterEntity"))
	sprite.texture = texture; sprite.centered = true; sprite.name = "ColorSprite"; var longest := maxf(texture.get_width(), texture.get_height()); var target := float(def.get("displaySize", DEFAULT_DISPLAY_SIZE.get(category, 52.0))); sprite.scale = Vector2.ONE * (target / longest if longest > 0 else 1.0); container.add_child(sprite)
	if encode_params:
		params_container = Node2D.new(); params_container.position = start_position; params_container.name = "%s_Params" % def.get("id", "WaterEntity")
		params_sprite = Sprite2D.new(); params_sprite.texture = texture; params_sprite.centered = true; params_sprite.scale = sprite.scale; param_material = ShaderMaterial.new(); param_material.shader = PARAM_SHADER; params_sprite.material = param_material; params_container.add_child(params_sprite)
	_apply_tint({})


func hit_radius() -> float:
	var value: Variant = def.get("hitRadius")
	return float(value) if (value is int or value is float) and is_finite(float(value)) and float(value) > 0 else float(DEFAULT_HIT_RADIUS.get(category, 30.0))


func set_flee_deadline(total_search_sec: float) -> void:
	if def.get("motion") is Dictionary and def.motion.get("path") == "flee" and category == "swimming": flee_deadline_ms = maxf(0.25, total_search_sec - 1.0) * 1000.0


func is_escaped() -> bool: return escaped
func is_visible() -> bool: return container.visible
func set_visible(value: bool) -> void:
	container.visible = value
	if params_container != null: params_container.visible = value


func effective_depth() -> float:
	var base := maxf(0.0, float(def.get("depth", 0.0))); var oscillation: Variant = def.get("depthOsc")
	if not oscillation is Dictionary or oscillation.get("curve") == "none" or float(oscillation.get("amplitude", 0)) == 0: return base
	var period := maxf(0.15, float(oscillation.get("period", 1.0))); var amplitude := float(oscillation.get("amplitude", 0)); var addition := 0.0
	match str(oscillation.get("curve", "none")):
		"sine": addition = sin(depth_phase + motion_time / period * PI * 2.0) * amplitude
		"approach_surface": addition = -(sin(motion_time / period) * 0.5 + 0.5) * amplitude
		"random_walk": addition = sin(motion_time * 3.1 + depth_phase) * 0.5 * amplitude
	return maxf(0.0, base + addition)


func depth_offset_y() -> float: return minf(effective_depth(), 1.35) * 18.0


func react_grass() -> void: sprite.rotation = sin(motion_time * 6.0) * 0.06


func update(dt: float, ambient: Dictionary, cursor_world: Vector2) -> void:
	if escaped: return
	motion_time += maxf(0.0, dt)
	if flee_deadline_ms != null and def.get("motion") is Dictionary and def.motion.get("path") == "flee" and motion_time * 1000.0 >= float(flee_deadline_ms): escaped = true; set_visible(false); return
	var motion: Variant = def.get("motion"); var speed := float(motion.get("speed", 0)) if motion is Dictionary else 0.0; var jitter := float(motion.get("jitter", 0)) if motion is Dictionary else 0.0
	if category == "swimming" and motion is Dictionary:
		match str(motion.get("path", "stationary")):
			"drift": container.position += Vector2(sin(motion_time * 0.7 + depth_phase) * speed * dt * 12.0, cos(motion_time * 0.55) * speed * dt * 8.0)
			"patrol":
				container.position.x += patrol_direction * speed * dt * 35.0
				if container.position.x > start_position.x + 90: patrol_direction = -1
				if container.position.x < start_position.x - 90: patrol_direction = 1
			"approach":
				var delta := cursor_world - container.position; var length := delta.length() + 1e-4; container.position += delta / length * speed * dt * 40.0
			"flee":
				flee_bursts += dt; var delta := container.position - cursor_world; var length := delta.length() + 1e-4; container.position += delta / length * speed * dt * (18.0 + flee_bursts * 4.0)
		if jitter > 0: container.position += Vector2(float(rng.call()) - 0.5, float(rng.call()) - 0.5) * jitter * dt * 30.0
	elif category == "floating": container.position += Vector2(sin(motion_time * 0.4) * dt * 6.0, cos(motion_time * 0.35) * dt * 4.0)
	sprite.position.y = depth_offset_y()
	if params_container != null:
		params_container.position = container.position; params_sprite.position = sprite.position; params_sprite.rotation = sprite.rotation; params_sprite.scale = sprite.scale; param_material.set_shader_parameter("depth_value", effective_depth()); param_material.set_shader_parameter("glow_value", _glow_strength())
	_apply_tint(ambient)


func hit_center() -> Vector2: return container.position + sprite.position


func _glow_strength() -> float:
	var glow: Variant = def.get("glow")
	if not glow is Dictionary or glow.get("enabled") != true: return 0.0
	return clampf(float(glow.get("daylightHint", 0.45)), 0.0, 1.0)


func _apply_tint(ambient: Dictionary) -> void:
	var depth_visual := minf(effective_depth(), 1.0); var murk := 0.35; var weather := str(ambient.get("weather", "")); var time_of_day := str(ambient.get("time", ""))
	if weather == "rain": murk = 0.55
	elif weather == "fog": murk = 0.8
	var luminance := 1.1 - depth_visual * 0.55 - murk * 0.35; var color := Color(luminance, luminance * 0.98, luminance * 1.02, 1.0); var glow: Variant = def.get("glow")
	if glow is Dictionary and glow.get("enabled") == true and not str(glow.get("color", "")).is_empty(): color = color.lerp(Color.from_string(str(glow.color), Color.WHITE), clampf(float(glow.get("daylightHint", 0.4)), 0.0, 1.0))
	if time_of_day == "night": color *= Color(0.55, 0.6, 0.75, 1)
	elif time_of_day == "morning": color *= Color(1.05, 0.97, 0.9, 1)
	# Pixi packs the computed float channels through `(round(v * 255) & 255)`.
	# Values slightly above 1 therefore wrap instead of clamp (notably the morning
	# floating leaf); reproduce that observable result so identical JSON stays exact.
	sprite.modulate = Color(_packed_channel(color.r), _packed_channel(color.g), _packed_channel(color.b), 1.0)


func _packed_channel(value: float) -> float:
	return float(int(round(value * 255.0)) & 255) / 255.0


func destroy() -> void:
	sprite.material = null
	if params_sprite != null: params_sprite.material = null
	param_material = null
