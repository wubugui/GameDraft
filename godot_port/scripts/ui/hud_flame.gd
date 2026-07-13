class_name RuntimeHudFlame
extends Node2D

const CURVE_SEGMENTS := 14
const ELLIPSE_SEGMENTS := 24

var intensity := 1.0
var phase := 0.7
var health_ratio := 1.0
var animation_time := 0.0


func _init(next_phase := 0.7) -> void:
	phase = next_phase


func set_flame_state(next_intensity: float, next_phase: float, next_ratio: float, next_time: float) -> void:
	intensity = clampf(next_intensity, 0.0, 1.0)
	phase = next_phase
	health_ratio = clampf(next_ratio, 0.0, 1.0)
	animation_time = next_time
	queue_redraw()


func get_debug_state() -> Dictionary:
	if intensity <= 0.015:
		return {"active": false, "intensity": intensity, "phase": phase}
	var dying := 1.0 - intensity
	var unrest := maxf(dying, (1.0 - health_ratio) * 0.78)
	var flick_frequency := 9.0
	var flick_amplitude := 0.04 + unrest * 0.46
	var flick := 0.96 \
		+ sin(animation_time * flick_frequency + phase) * flick_amplitude \
		+ sin(animation_time * flick_frequency * 1.7 + phase * 1.3) * flick_amplitude * 0.28
	var wink := 0.28 + 0.72 * absf(sin(animation_time * 7.0 + phase * 2.0)) if intensity < 0.32 else 1.0
	var tip_sway := sin(animation_time * 2.2 + phase) * (0.12 + unrest * 4.9)
	var height := maxf(2.2, 20.0 * maxf(intensity, 0.13) * flick)
	var width := 2.3 + 3.8 * intensity
	var alpha := (0.5 + 0.34 * intensity) * wink
	var edge_noise := sin(animation_time * 5.1 + phase * 1.7) * (0.04 + unrest * 0.92)
	return {
		"active": true,
		"intensity": intensity,
		"phase": phase,
		"unrest": unrest,
		"flick": flick,
		"wink": wink,
		"tipSway": tip_sway,
		"height": height,
		"width": width,
		"alpha": alpha,
		"edgeNoise": edge_noise,
		"tipX": tip_sway + edge_noise,
		"tipY": -height,
		"colors": {
			"halo": _lerp_rgb_int(0x233235, 0x6a4526, intensity),
			"outer": _lerp_rgb_int(0x5f746b, 0xb97836, intensity),
			"core": _lerp_rgb_int(0x9fb7aa, 0xe7c78d, intensity),
			"ember": _lerp_rgb_int(0x35504b, 0x7d4a22, intensity),
		},
	}


func _draw() -> void:
	if intensity <= 0.015:
		return

	var dying := 1.0 - intensity
	var unrest := maxf(dying, (1.0 - health_ratio) * 0.78)
	var flick_frequency := 9.0
	var flick_amplitude := 0.04 + unrest * 0.46
	var flick := 0.96 \
		+ sin(animation_time * flick_frequency + phase) * flick_amplitude \
		+ sin(animation_time * flick_frequency * 1.7 + phase * 1.3) * flick_amplitude * 0.28
	var wink := 0.28 + 0.72 * absf(sin(animation_time * 7.0 + phase * 2.0)) if intensity < 0.32 else 1.0
	var tip_sway := sin(animation_time * 2.2 + phase) * (0.12 + unrest * 4.9)
	var effective_intensity := maxf(intensity, 0.13)
	var height := maxf(2.2, 20.0 * effective_intensity * flick)
	var width := 2.3 + 3.8 * intensity
	var alpha := (0.5 + 0.34 * intensity) * wink
	var edge_noise := sin(animation_time * 5.1 + phase * 1.7) * (0.04 + unrest * 0.92)
	var tip := Vector2(tip_sway + edge_noise, -height)

	var halo_color := _lerp_color(0x233235, 0x6a4526, intensity)
	_draw_ellipse(
		Vector2(tip_sway * 0.16, -height * 0.34),
		Vector2(width * (1.15 + intensity * 0.35), height * 0.42),
		_with_alpha(halo_color, alpha * (0.13 + intensity * 0.05))
	)

	var outer := PackedVector2Array([tip])
	_append_cubic(
		outer,
		tip,
		Vector2(-width * 0.96 - edge_noise * 0.2, -height * 0.62),
		Vector2(-width * 0.72, -height * 0.18),
		Vector2(-width * 0.16, 0.0)
	)
	_append_cubic(
		outer,
		Vector2(-width * 0.16, 0.0),
		Vector2(width * 0.08, height * 0.05),
		Vector2(width * 0.78, -height * 0.08),
		Vector2(width * 0.58 + edge_noise * 0.25, -height * 0.38)
	)
	_append_cubic(
		outer,
		Vector2(width * 0.58 + edge_noise * 0.25, -height * 0.38),
		Vector2(width * 0.45, -height * 0.68),
		Vector2(tip.x + width * 0.24, -height * 0.84),
		tip
	)
	draw_colored_polygon(outer, _with_alpha(_lerp_color(0x5f746b, 0xb97836, intensity), alpha))

	var core_height := height * (0.48 + intensity * 0.1)
	var core_width := width * (0.28 + intensity * 0.08)
	var core_tip_x := tip_sway * 0.48
	var core_tip := Vector2(core_tip_x, -core_height)
	var core := PackedVector2Array([core_tip])
	_append_cubic(
		core,
		core_tip,
		Vector2(-core_width, -core_height * 0.45),
		Vector2(-core_width * 0.8, -height * 0.08),
		Vector2(-core_width * 0.18, -height * 0.01)
	)
	_append_cubic(
		core,
		Vector2(-core_width * 0.18, -height * 0.01),
		Vector2(core_width * 0.78, -height * 0.08),
		Vector2(core_width * 0.72, -core_height * 0.45),
		core_tip
	)
	draw_colored_polygon(
		core,
		_with_alpha(_lerp_color(0x9fb7aa, 0xe7c78d, intensity), alpha * (0.72 + intensity * 0.1))
	)

	draw_line(Vector2(0.0, -1.4), Vector2(0.0, 2.4), _with_alpha(Color8(0x21, 0x17, 0x11), 0.62 * alpha), 0.75, true)
	draw_circle(
		Vector2(0.0, 1.6),
		maxf(0.9, width * 0.16),
		_with_alpha(_lerp_color(0x35504b, 0x7d4a22, intensity), 0.44 * alpha)
	)


func _draw_ellipse(center: Vector2, radii: Vector2, color: Color) -> void:
	var polygon := PackedVector2Array()
	for index in ELLIPSE_SEGMENTS:
		var angle := TAU * float(index) / float(ELLIPSE_SEGMENTS)
		polygon.push_back(center + Vector2(cos(angle) * radii.x, sin(angle) * radii.y))
	draw_colored_polygon(polygon, color)


func _append_cubic(points: PackedVector2Array, p0: Vector2, p1: Vector2, p2: Vector2, p3: Vector2) -> void:
	for index in range(1, CURVE_SEGMENTS + 1):
		var t := float(index) / float(CURVE_SEGMENTS)
		var inverse := 1.0 - t
		points.push_back(
			p0 * inverse * inverse * inverse
			+ p1 * 3.0 * inverse * inverse * t
			+ p2 * 3.0 * inverse * t * t
			+ p3 * t * t * t
		)


func _lerp_color(from_rgb: int, to_rgb: int, amount: float) -> Color:
	var rgb := _lerp_rgb_int(from_rgb, to_rgb, amount)
	return Color8((rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff)


func _lerp_rgb_int(from_rgb: int, to_rgb: int, amount: float) -> int:
	var value := clampf(amount, 0.0, 1.0)
	var from_r := (from_rgb >> 16) & 0xff
	var from_g := (from_rgb >> 8) & 0xff
	var from_b := from_rgb & 0xff
	var to_r := (to_rgb >> 16) & 0xff
	var to_g := (to_rgb >> 8) & 0xff
	var to_b := to_rgb & 0xff
	return (
		roundi(from_r + (to_r - from_r) * value) << 16
		| roundi(from_g + (to_g - from_g) * value) << 8
		| roundi(from_b + (to_b - from_b) * value)
	)


func _with_alpha(color: Color, alpha: float) -> Color:
	color.a = clampf(alpha, 0.0, 1.0)
	return color
