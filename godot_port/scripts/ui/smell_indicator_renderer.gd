class_name RuntimeSmellIndicatorRenderer
extends RefCounted

const TEXTURE_SIZE := 64.0
const BASE_COUNT := 3
const WISP_COUNT := 30
const REACH_COUNT := 6
const DEFAULT_FORM := {
	"riseH": 72.0,
	"stemDia": 5.0,
	"plumeGrow": 30.0,
	"plumeExp": 1.6,
	"topFade": 0.88,
	"alphaBase": 0.95,
	"curveAmp": 3.2,
	"swayGain": 0.6,
	"baseW": 50.0,
}

static var _puff_texture: Texture2D

var root := Node2D.new()
var bloom: Sprite2D
var baseline: Array[Sprite2D] = []
var wisps: Array[Sprite2D] = []
var reaches: Array[Sprite2D] = []
var label := Label.new()
var profiles: Dictionary = {}
var form: Dictionary = DEFAULT_FORM.duplicate(true)
var baseline_color := Color("969aa2")
var baseline_breathe := 0.9
var fade_seconds := 0.8
var target := {"scent": "", "intensity": 0.0, "dir": 0.0, "flicker": false}
var render_scent := ""
var pending_scent: Variant = null
var display_intensity := 0.0
var display_direction := 0.0
var fade := 0.0
var envelope_start_time := -1.0
var time := 0.0
var label_scent := ""
var normal_material := CanvasItemMaterial.new()
var additive_material := CanvasItemMaterial.new()


func _init(parent: Node, data: Dictionary, position := Vector2.ZERO) -> void:
	root.name = "SmellIndicatorRenderer"
	root.position = position
	parent.add_child(root)
	profiles = data.get("profiles", {}).duplicate(true)
	baseline_color = Color.from_string(str(data.get("baseline", {}).get("color", "#969aa2")), Color("969aa2"))
	baseline_breathe = float(data.get("baseline", {}).get("breatheFreq", 0.9))
	fade_seconds = maxf(0.05, float(data.get("transition", {}).get("fadeMs", 800.0)) / 1000.0)
	for key: Variant in data.get("form", {}):
		form[str(key)] = data.form[key]

	additive_material.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	var texture := _get_puff_texture()
	bloom = _make_sprite(texture)
	for _index in BASE_COUNT:
		baseline.push_back(_make_sprite(texture))
	for _index in WISP_COUNT:
		wisps.push_back(_make_sprite(texture))
	for _index in REACH_COUNT:
		reaches.push_back(_make_sprite(texture))

	label.position = Vector2(-45.0, 20.0)
	label.size = Vector2(90.0, 18.0)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.add_theme_font_size_override("font_size", 11)
	label.visible = false
	root.add_child(label)
	_draw_indicator()


func set_state(value: Dictionary) -> void:
	if value.has("scent"):
		target.scent = str(value.get("scent", ""))
	if value.has("intensity"):
		target.intensity = clampf(float(value.get("intensity", 0.0)) / 100.0, 0.0, 1.0)
	if value.has("dir"):
		target.dir = clampf(float(value.get("dir", 0.0)), -1.0, 1.0)
	if value.has("flicker"):
		target.flicker = value.get("flicker", false) == true
	if str(target.scent) != render_scent:
		pending_scent = str(target.scent)
	else:
		pending_scent = null


func pulse_boost() -> void:
	display_intensity = minf(1.0, display_intensity + 0.35)


func set_form_param(key: String, value: float) -> void:
	if form.has(key) and is_finite(value):
		form[key] = value


func get_form() -> Dictionary:
	return form.duplicate(true)


func reset_animation_clock() -> void:
	time = 0.0
	envelope_start_time = 0.0 if render_scent and _profile_has_envelope(_profile(render_scent)) else -1.0
	_draw_indicator()


func update(dt: float) -> void:
	time += dt
	var interpolation := 1.0 - exp(-dt * 6.0)
	display_intensity += (float(target.intensity) - display_intensity) * interpolation
	display_direction += (float(target.dir) - display_direction) * interpolation

	if pending_scent != null and str(pending_scent) != render_scent:
		fade -= dt / (fade_seconds * 0.6)
		if fade <= 0.0:
			fade = 0.0
			render_scent = str(pending_scent)
			pending_scent = null
			if render_scent and _profile_has_envelope(_profile(render_scent)):
				envelope_start_time = time
	else:
		var fade_target := 1.0 if render_scent else 0.0
		fade += (fade_target - fade) * (1.0 - exp(-dt / fade_seconds))
		if absf(fade_target - fade) < 0.002:
			fade = fade_target

	_draw_indicator()


func get_state() -> Dictionary:
	return {
		"scent": str(target.scent),
		"intensity": float(target.intensity) * 100.0,
		"dir": float(target.dir),
		"flicker": target.flicker == true,
	}


func get_debug_state() -> Dictionary:
	return {
		"time": time,
		"target": target.duplicate(true),
		"renderScent": render_scent,
		"pendingScent": pending_scent,
		"displayIntensity": display_intensity,
		"displayDirection": display_direction,
		"fade": fade,
		"envelopeStartTime": envelope_start_time,
		"root": {"x": root.position.x, "y": root.position.y},
		"bloom": _sprite_debug_state(bloom),
		"baseline": _sprites_debug_state(baseline),
		"wisps": _sprites_debug_state(wisps),
		"reaches": _sprites_debug_state(reaches),
		"label": {
			"visible": label.visible,
			"text": label.text,
			"x": label.position.x + 45.0,
			"y": label.position.y,
			"alpha": label.modulate.a,
			"color": label.modulate.to_html(false).left(6),
		},
	}


func destroy() -> void:
	if is_instance_valid(root):
		root.free()
	baseline.clear()
	wisps.clear()
	reaches.clear()


func _draw_indicator() -> void:
	var profile := _profile(render_scent)
	var has_profile := not profile.is_empty()
	var special: Dictionary = profile.get("special", {}) if has_profile else {}
	var glow: bool = special.get("glow", false) == true
	var envelope := _envelope(profile) if has_profile and special.has("envelope") else 1.0
	var flicker := 1.0
	if target.flicker == true and has_profile:
		flicker = 0.45 + 0.55 * absf(sin(time * 3.2 + 0.5))
	var strength := clampf(fade * (0.25 + 0.75 * display_intensity) * envelope * flicker, 0.0, 1.2)

	_draw_baseline(profile, strength, glow)
	if glow and strength > 0.05:
		_draw_bloom(profile, strength)
	else:
		bloom.visible = false
	if has_profile and strength > 0.005:
		_draw_wisps(profile, strength, glow)
	else:
		_hide(wisps)
	if special.get("reach", false) == true and strength > 0.03:
		_draw_reaches(profile, strength)
	else:
		_hide(reaches)
	_draw_label(profile, strength)


func _draw_label(profile: Dictionary, strength: float) -> void:
	if profile.is_empty() or str(profile.get("name", "")).is_empty() or strength <= 0.02:
		label.visible = false
		return
	if label_scent != render_scent:
		label.text = str(profile.get("name", ""))
		label_scent = render_scent
	label.visible = true
	label.position.x = -45.0 + display_direction * 4.0
	label.modulate = _with_alpha(_profile_color(profile), minf(1.0, strength * 1.6))


func _draw_baseline(profile: Dictionary, strength: float, glow: bool) -> void:
	var breathe := 0.6 + 0.4 * sin(time * baseline_breathe)
	var color := _lerp_color(baseline_color, _profile_color(profile), minf(1.0, strength * 1.2)) if not profile.is_empty() else baseline_color
	var jitter_x := 0.0
	var dim := 1.0
	var special: Dictionary = profile.get("special", {}) if not profile.is_empty() else {}
	if special.get("baselineShudder", false) == true and strength > 0.05:
		var shudder := pow(maxf(0.0, sin(time * 2.1)), 6.0)
		jitter_x = sin(time * 15.0) * 1.4 * shudder
		dim = 1.0 - 0.5 * shudder
	for index in baseline.size():
		var sprite := baseline[index]
		var width := float(form.get("baseW", 50.0)) - index * 9.0
		var alpha := (0.52 * breathe * (1.0 - 0.4 * minf(1.0, strength)) + 0.68 * minf(1.0, strength)) * dim
		_configure_sprite(sprite, color, alpha, Vector2(jitter_x, 9.0), Vector2(width / TEXTURE_SIZE, (15.0 - index * 3.0) / TEXTURE_SIZE), glow and strength > 0.12)


func _draw_bloom(profile: Dictionary, strength: float) -> void:
	_configure_sprite(
		bloom,
		_lerp_color(_profile_color(profile), Color.WHITE, 0.3),
		0.16 * strength,
		Vector2(display_direction * 6.0, -float(form.get("riseH", 72.0)) * 0.42),
		Vector2(110.0 / TEXTURE_SIZE, 110.0 / TEXTURE_SIZE * 1.05),
		true
	)


func _draw_wisps(profile: Dictionary, strength: float, glow: bool) -> void:
	var heavy_scale := 0.5 if profile.get("heavy", false) == true else 1.0
	var height := float(form.get("riseH", 72.0)) * heavy_scale * (0.55 + 0.45 * minf(1.0, display_intensity))
	var scroll := time * (0.6 + float(profile.get("rise", 0.0)) * 1.3)
	var special: Dictionary = profile.get("special", {})
	var coil: bool = profile.get("wrong", false) == true or special.get("coil", false) == true
	var base_color := _lerp_color(_profile_color(profile), Color.WHITE, 0.32) if glow else _profile_color(profile)
	for index in wisps.size():
		var progress := float(index) / float(wisps.size() - 1)
		var curve_amplitude := float(form.get("curveAmp", 3.2)) + float(profile.get("sway", 0.0)) * float(form.get("swayGain", 0.6))
		var wobble := sin(progress * 6.3 - scroll) * curve_amplitude * (0.25 + progress * 0.95)
		if float(profile.get("jitter", 0.0)) != 0.0:
			wobble += sin(time * 4.0 + index * 1.5) * float(profile.get("jitter", 0.0)) * 2.5 * progress
		if coil:
			wobble += sin(progress * 9.0 - time) * 3.0 * (0.4 + progress)
		var diameter := float(form.get("stemDia", 5.0)) + pow(progress, float(form.get("plumeExp", 1.6))) * (float(form.get("plumeGrow", 30.0)) * (0.7 if profile.get("heavy", false) == true else 1.0))
		var alpha := minf(progress * 6.0, 1.0) * (1.0 - progress * float(form.get("topFade", 0.88))) * (float(form.get("alphaBase", 0.95)) * (0.44 if glow else 1.0)) * strength * (1.5 if glow else 1.0)
		_configure_sprite(
			wisps[index],
			base_color,
			alpha,
			Vector2(wobble + display_direction * progress * progress * 9.0, -progress * height),
			Vector2.ONE * (diameter / TEXTURE_SIZE),
			glow,
			alpha > 0.004
		)


func _draw_reaches(profile: Dictionary, strength: float) -> void:
	for index in reaches.size():
		var phase := fmod(time * 0.35 + float(index) / float(reaches.size()), 1.0)
		var diameter := (3.0 + phase * 3.0) * 2.1
		_configure_sprite(
			reaches[index],
			_lerp_color(_profile_color(profile), Color("eae0f4"), 0.5),
			(1.0 - phase) * 0.18 * strength,
			Vector2(sin(time * 1.05 + index * 1.3) * 8.0 * (0.5 + phase) + display_direction * 4.0, -4.0 + phase * 22.0),
			Vector2.ONE * (diameter / TEXTURE_SIZE),
			true
		)


func _envelope(profile: Dictionary) -> float:
	var envelope: Dictionary = profile.get("special", {}).get("envelope", {})
	if envelope.is_empty() or envelope_start_time < 0.0:
		return 1.0
	var milliseconds := (time - envelope_start_time) * 1000.0
	var attack := float(envelope.get("attackMs", 0.0))
	var hold := float(envelope.get("holdMs", 0.0))
	var decay := float(envelope.get("decayMs", 0.0))
	var peak := float(envelope.get("peak", 1.0))
	if milliseconds < attack:
		return milliseconds / maxf(1.0, attack) * peak
	if milliseconds < attack + hold:
		return peak
	var elapsed_decay := milliseconds - attack - hold
	if elapsed_decay < decay:
		return peak * pow(1.0 - elapsed_decay / decay, 1.9)
	return 0.0


func _profile(id: String) -> Dictionary:
	var value: Variant = profiles.get(id, {})
	return value if value is Dictionary else {}


func _profile_color(profile: Dictionary) -> Color:
	return Color.from_string(str(profile.get("color", "#969aa2")), Color("969aa2"))


func _profile_has_envelope(profile: Dictionary) -> bool:
	return not profile.is_empty() and profile.get("special", {}).has("envelope")


func _make_sprite(texture: Texture2D) -> Sprite2D:
	var sprite := Sprite2D.new()
	sprite.texture = texture
	sprite.centered = true
	sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	sprite.visible = false
	root.add_child(sprite)
	return sprite


func _configure_sprite(sprite: Sprite2D, color: Color, alpha: float, position: Vector2, scale: Vector2, additive: bool, visible := true) -> void:
	sprite.visible = visible
	sprite.position = position
	sprite.scale = scale
	sprite.modulate = _with_alpha(color, alpha)
	sprite.material = additive_material if additive else normal_material


func _sprite_debug_state(sprite: Sprite2D) -> Dictionary:
	return {
		"visible": sprite.visible,
		"x": sprite.position.x,
		"y": sprite.position.y,
		"scaleX": sprite.scale.x,
		"scaleY": sprite.scale.y,
		"alpha": sprite.modulate.a,
		"color": sprite.modulate.to_html(false).left(6),
		"additive": sprite.material == additive_material,
	}


func _sprites_debug_state(sprites: Array[Sprite2D]) -> Array:
	var result: Array = []
	for sprite: Sprite2D in sprites:
		result.push_back(_sprite_debug_state(sprite))
	return result


func _hide(sprites: Array[Sprite2D]) -> void:
	for sprite in sprites:
		sprite.visible = false


func _lerp_color(from_color: Color, to_color: Color, amount: float) -> Color:
	var value := clampf(amount, 0.0, 1.0)
	return Color8(
		roundi(from_color.r8 + (to_color.r8 - from_color.r8) * value),
		roundi(from_color.g8 + (to_color.g8 - from_color.g8) * value),
		roundi(from_color.b8 + (to_color.b8 - from_color.b8) * value)
	)


func _with_alpha(color: Color, alpha: float) -> Color:
	color.a = clampf(alpha, 0.0, 1.0)
	return color


static func _get_puff_texture() -> Texture2D:
	if _puff_texture != null:
		return _puff_texture
	var size := int(TEXTURE_SIZE)
	var image := Image.create(size, size, false, Image.FORMAT_RGBA8)
	var center := Vector2(TEXTURE_SIZE / 2.0, TEXTURE_SIZE / 2.0)
	for y in size:
		for x in size:
			var radial := Vector2(x + 0.5, y + 0.5).distance_to(center) / (TEXTURE_SIZE / 2.0)
			var alpha := 0.0
			if radial <= 0.45:
				alpha = lerpf(1.0, 0.5, radial / 0.45)
			elif radial < 1.0:
				alpha = lerpf(0.5, 0.0, (radial - 0.45) / 0.55)
			image.set_pixel(x, y, Color(1.0, 1.0, 1.0, alpha))
	_puff_texture = ImageTexture.create_from_image(image)
	return _puff_texture
