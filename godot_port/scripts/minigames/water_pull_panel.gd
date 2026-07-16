class_name RuntimeWaterPullPanel
extends Control


class GraphicsLayer:
	extends Control
	var draw_callback: Callable
	func _init(callback: Callable) -> void:
		draw_callback = callback
		mouse_filter = Control.MOUSE_FILTER_IGNORE
	func _draw() -> void:
		if draw_callback.is_valid():
			draw_callback.call(self)


var progress := 0.0
var marker := 0.45
var marker_vel := 0.0
var green_center := 0.5
var lift_held_binding := false
var elapsed := 0.0
var limit: float
var done := false
var burst_telegraph := 0.0
var spasm_next_at := 0.0
var spasm_kick := 0.0
var wobble_seed := 0.0
var random: Callable

var bar_w := 28.0
var bar_h := 260.0
var bar_g: GraphicsLayer
var warning_g: GraphicsLayer
var marker_g: GraphicsLayer
var green_g: GraphicsLayer
var prog_g: GraphicsLayer
var hint: Label
var params: Dictionary


func _init(initial_params: Dictionary) -> void:
	params = initial_params
	var provided_random: Variant = params.get("random")
	random = provided_random if provided_random is Callable and provided_random.is_valid() else func() -> float: return randf()
	wobble_seed = float(random.call()) * PI * 2.0
	limit = maxf(2.0, float(params.timeLimitSec))
	_reset_marker_for_rhythm()

	bar_g = GraphicsLayer.new(Callable(self, "_draw_bar"))
	warning_g = GraphicsLayer.new(Callable(self, "_draw_warning"))
	green_g = GraphicsLayer.new(Callable(self, "_draw_green"))
	marker_g = GraphicsLayer.new(Callable(self, "_draw_marker"))
	prog_g = GraphicsLayer.new(Callable(self, "_draw_progress"))

	hint = Label.new()
	hint.text = ""
	hint.add_theme_font_size_override("font_size", 14)
	hint.add_theme_color_override("font_color", Color("e0e8f0"))
	hint.position.y = bar_h + 12.0
	hint.size = Vector2(320.0, 42.0)
	hint.mouse_filter = Control.MOUSE_FILTER_IGNORE

	custom_minimum_size = Vector2(110.0, 310.0)
	size = custom_minimum_size
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	for child: Control in [bar_g, warning_g, green_g, marker_g, prog_g, hint]:
		child.size = Vector2(120.0, 310.0) if child != hint else child.size
		add_child(child)

	_refresh_geometry()


func set_lift_held(down: bool) -> void:
	lift_held_binding = down


func _lift_held() -> bool:
	return lift_held_binding


func _reset_marker_for_rhythm() -> void:
	if params.rhythm == "heavy_sink":
		green_center = 0.72
		marker = 0.7
	elif params.rhythm == "burst":
		green_center = 0.35
		marker = 0.38
	else:
		green_center = 0.5
		marker = 0.5
	marker_vel = 0.0
	spasm_next_at = 0.65 + float(random.call()) * 0.85


func _refresh_geometry() -> void:
	bar_g.queue_redraw()
	warning_g.queue_redraw()
	green_g.queue_redraw()
	marker_g.queue_redraw()
	prog_g.queue_redraw()


func _marker_wobble() -> float:
	if params.rhythm == "heavy_sink":
		return 0.0
	if params.rhythm == "spasm":
		return sin(elapsed * 19.0 + wobble_seed) * (1.2 + spasm_kick * 9.0)
	if params.rhythm == "burst":
		return sin(elapsed * 10.0 + wobble_seed) * (0.6 + burst_telegraph * 3.4)
	return sin(elapsed * 3.2 + wobble_seed) * 0.8


func _smooth01(t: float) -> float:
	var x := maxf(0.0, minf(1.0, t))
	return x * x * (3.0 - x * 2.0)


func _lerp(a: float, b: float, t: float) -> float:
	return a + (b - a) * _smooth01(t)


func _drive_green(dt: float) -> void:
	var t := elapsed
	var rhythm: String = params.rhythm
	var half_zone := maxf(0.04, minf(0.45, float(params.zoneSize)))
	burst_telegraph = 0.0
	spasm_kick = maxf(0.0, spasm_kick - dt * 2.8)

	if rhythm == "stable":
		green_center = 0.5 + sin(t * 2.2) * (0.42 - half_zone)
	elif rhythm == "burst":
		var cycle := fposmod(t, 4.2)
		if cycle < 2.45:
			green_center = 0.35 + sin(t * 3.2) * 0.035
		elif cycle < 3.15:
			burst_telegraph = (cycle - 2.45) / 0.7
			green_center = _lerp(0.35, 0.56, burst_telegraph)
		elif cycle < 3.55:
			burst_telegraph = 1.0
			green_center = 0.78 + sin(t * 8.0) * 0.025
		else:
			green_center = _lerp(0.78, 0.35, (cycle - 3.55) / 0.65)
	elif rhythm == "spasm":
		if t >= spasm_next_at:
			green_center = 0.18 + float(random.call()) * 0.64
			marker_vel -= (0.16 + float(random.call()) * 0.22) * maxf(0.2, float(params.sliderSpeed))
			spasm_kick = 1.0
			spasm_next_at = t + 0.45 + float(random.call()) * 1.35
		green_center += sin(t * 11.0 + marker * 7.0) * dt * 0.28
	else:
		green_center = 0.72 + sin(t * 0.45) * 0.025
	green_center = maxf(half_zone + 0.02, minf(1.0 - half_zone - 0.02, green_center))


func _drive_marker(dt: float) -> void:
	var base := maxf(0.2, float(params.sliderSpeed))
	var held := _lift_held()

	var acceleration := (1.12 if held else -0.62) * base
	if params.rhythm == "heavy_sink":
		acceleration = (1.38 if held else -0.9) * base
	elif params.rhythm == "burst":
		acceleration *= 1.25 if burst_telegraph > 0.8 else 1.0
	elif params.rhythm == "spasm":
		acceleration *= 1.0 + spasm_kick * 0.25

	marker_vel += acceleration * dt * 2.4
	marker_vel *= exp(-dt * (2.1 if held else 2.8))

	var max_velocity := (0.78 if params.rhythm == "heavy_sink" else 0.95) * base
	marker_vel = maxf(-max_velocity, minf(max_velocity, marker_vel))
	marker += marker_vel * dt * 1.1
	if marker < 0.02:
		marker = 0.02
		marker_vel = maxf(0.0, marker_vel * -0.15)
	if marker > 0.98:
		marker = 0.98
		marker_vel = minf(0.0, marker_vel * -0.15)


func _in_zone() -> bool:
	var half_zone := maxf(0.04, minf(0.45, float(params.zoneSize)))
	return absf(marker - green_center) <= half_zone


func update(dt: float) -> void:
	if done:
		return
	var step := minf(maxf(dt, 0.0), 0.084)
	elapsed += step
	_drive_green(step)
	_drive_marker(step)

	var overlap := _in_zone()
	if overlap:
		var rate := 0.34
		if params.rhythm == "heavy_sink":
			rate = 0.22
		if params.rhythm == "burst":
			rate = 0.36
		if params.rhythm == "spasm":
			rate = 0.28
		progress = minf(1.0, progress + rate * step)
	else:
		var drain := 0.07
		if params.rhythm == "heavy_sink":
			drain = 0.18 if _lift_held() else 0.13
		elif params.rhythm == "spasm":
			drain = 0.11 + spasm_kick * 0.08
		elif params.rhythm == "burst":
			drain = 0.09 + burst_telegraph * 0.06
		progress = maxf(0.0, progress - drain * step)

	var remaining := maxf(0.0, limit - elapsed)
	var resolve_text: Callable = params.resolveText
	var text := func(key: String) -> String: return str(resolve_text.call("[tag:string:waterMinigame:%s]" % key))
	var state_hint := ""
	if params.rhythm == "burst" and burst_telegraph > 0.01:
		state_hint = text.call("pullStateForeshadow")
	elif params.rhythm == "spasm" and spasm_kick > 0.01:
		state_hint = text.call("pullStateYank")
	elif overlap:
		state_hint = text.call("pullStateInZone")
	elif marker < green_center:
		state_hint = text.call("pullStateHold")
	else:
		state_hint = text.call("pullStateRelease")
	hint.text = text.call("pullStatus").replace("{sec}", "%.1f" % remaining).replace("{state}", state_hint)
	_refresh_geometry()

	if progress >= 0.995:
		_finish("success")
		return
	if elapsed >= limit:
		if params.failurePolicy == "escape":
			_finish("fail_escape")
		elif params.failurePolicy == "snap":
			_finish("fail_snap")
		else:
			_finish("fail_bite")


func abort() -> void:
	_finish("abort")


func _finish(result: String) -> void:
	if done:
		return
	done = true
	var on_result: Callable = params.onResult
	on_result.call(result)


# Pixi Graphics is an engine primitive. These layer-local draw adapters preserve
# the five source Graphics owners and their child order without moving game state.
func _draw_bar(layer: Control) -> void:
	layer.draw_rect(Rect2(0.0, 0.0, bar_w, bar_h), Color(0.06, 0.09, 0.14, 0.95), true)
	layer.draw_rect(Rect2(0.0, 0.0, bar_w, bar_h), Color("765b38"), false, 2.0)


func _draw_warning(layer: Control) -> void:
	if burst_telegraph <= 0.001:
		return
	var half_zone := maxf(0.04, minf(0.45, float(params.zoneSize)))
	var warning_y := (0.78 - half_zone) * bar_h
	var warning_height := half_zone * 2.0 * bar_h
	layer.draw_rect(Rect2(-5.0, warning_y - 4.0, bar_w + 10.0, warning_height + 8.0), Color(0.96, 0.62, 0.04, 0.18 + burst_telegraph * 0.22), true)
	layer.draw_rect(Rect2(-5.0, warning_y - 4.0, bar_w + 10.0, warning_height + 8.0), Color(0.98, 0.75, 0.14, 0.4 + burst_telegraph * 0.5), false, 2.0)


func _draw_green(layer: Control) -> void:
	var half_zone := maxf(0.04, minf(0.45, float(params.zoneSize)))
	var green_y := (green_center - half_zone) * bar_h
	var green_height := half_zone * 2.0 * bar_h
	var rect := Rect2(-2.0, green_y - 2.0, bar_w + 4.0, green_height + 4.0)
	layer.draw_rect(rect, Color(0.12, 0.42, 0.23, 0.35), true)
	layer.draw_rect(rect, Color("4ade80"), false, 2.0)


func _draw_marker(layer: Control) -> void:
	var marker_y := marker * bar_h
	var wobble := _marker_wobble()
	var rect := Rect2(-4.0 + wobble, marker_y - 6.0, bar_w + 8.0, 12.0)
	layer.draw_rect(rect, Color("fff1a8"), true)
	layer.draw_rect(rect, Color("fbbf24"), false, 2.0)


func _draw_progress(layer: Control) -> void:
	var frame_width := bar_w + 58.0
	layer.draw_rect(Rect2(0.0, -22.0, frame_width, 12.0), Color(0.06, 0.09, 0.16, 0.9), true)
	layer.draw_rect(Rect2(0.0, -22.0, progress * frame_width, 12.0), Color("38bdf8"), true)
	layer.draw_rect(Rect2(0.0, -22.0, frame_width, 12.0), Color(0.38, 0.65, 0.98, 0.65), false, 1.0)
