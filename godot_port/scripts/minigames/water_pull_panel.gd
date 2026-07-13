class_name RuntimeWaterPullPanel
extends Control

var params: Dictionary
var progress := 0.0
var marker := 0.45
var marker_velocity := 0.0
var green_center := 0.5
var lift_held := false
var elapsed := 0.0
var time_limit := 12.0
var done := false
var burst_telegraph := 0.0
var spasm_next_at := 0.0
var spasm_kick := 0.0
var wobble_seed := 0.0
var hint := Label.new()
var rng := Callable()

const BAR_WIDTH := 28.0
const BAR_HEIGHT := 260.0


func _init(next_params: Dictionary, random_provider: Callable = Callable()) -> void:
	params = next_params
	if random_provider.is_valid(): rng = random_provider
	else: rng = func() -> float: return randf()
	wobble_seed = float(rng.call()) * PI * 2.0
	time_limit = maxf(2.0, float(params.get("timeLimitSec", 12.0)))
	custom_minimum_size = Vector2(110, 310); size = custom_minimum_size; mouse_filter = Control.MOUSE_FILTER_IGNORE; _reset_marker()
	hint.position = Vector2(0, BAR_HEIGHT + 12); hint.size = Vector2(300, 42); hint.add_theme_font_size_override("font_size", 14); hint.add_theme_color_override("font_color", Color("e0e8f0")); hint.mouse_filter = Control.MOUSE_FILTER_IGNORE; add_child(hint)


func set_lift_held(value: bool) -> void: lift_held = value
func is_done() -> bool: return done
func get_progress() -> float: return progress
func get_marker() -> float: return marker
func get_green_center() -> float: return green_center


func update(dt: float) -> void:
	if done: return
	var step := clampf(dt, 0.0, 0.084); elapsed += step; _drive_green(step); _drive_marker(step); var overlap := _in_zone(); var rhythm := str(params.get("rhythm", "stable"))
	if overlap:
		var rate := 0.22 if rhythm == "heavy_sink" else (0.36 if rhythm == "burst" else (0.28 if rhythm == "spasm" else 0.34)); progress = minf(1.0, progress + rate * step)
	else:
		var drain := 0.07
		if rhythm == "heavy_sink": drain = 0.18 if lift_held else 0.13
		elif rhythm == "spasm": drain = 0.11 + spasm_kick * 0.08
		elif rhythm == "burst": drain = 0.09 + burst_telegraph * 0.06
		progress = maxf(0.0, progress - drain * step)
	var remaining := maxf(0.0, time_limit - elapsed); var state_key := "pullStateForeshadow" if rhythm == "burst" and burst_telegraph > 0.01 else ("pullStateYank" if rhythm == "spasm" and spasm_kick > 0.01 else ("pullStateInZone" if overlap else ("pullStateHold" if marker < green_center else "pullStateRelease"))); hint.text = _text("[tag:string:waterMinigame:pullStatus]").replace("{sec}", "%.1f" % remaining).replace("{state}", _text("[tag:string:waterMinigame:%s]" % state_key)); queue_redraw()
	if progress >= 0.995: _finish("success")
	elif elapsed >= time_limit: _finish("fail_escape" if params.get("failurePolicy") == "escape" else ("fail_snap" if params.get("failurePolicy") == "snap" else "fail_bite"))


func abort() -> void: _finish("abort")
func debug_finish(result: String) -> void: _finish(result)
func debug_set_state(next_marker: float, next_green: float, next_progress: float = 0.0) -> void: marker = next_marker; green_center = next_green; progress = next_progress; marker_velocity = 0.0; queue_redraw()


func _draw() -> void:
	draw_rect(Rect2(0, 0, BAR_WIDTH, BAR_HEIGHT), Color(0.06, 0.09, 0.14, 0.95), true); draw_rect(Rect2(0, 0, BAR_WIDTH, BAR_HEIGHT), Color("765b38"), false, 2.0); var half_zone := clampf(float(params.get("zoneSize", 0.18)), 0.04, 0.45); var green_rect := Rect2(-2, (green_center - half_zone) * BAR_HEIGHT - 2, BAR_WIDTH + 4, half_zone * 2 * BAR_HEIGHT + 4); draw_rect(green_rect, Color(0.12, 0.42, 0.23, 0.35), true); draw_rect(green_rect, Color("4ade80"), false, 2.0); var marker_y := marker * BAR_HEIGHT; draw_rect(Rect2(-4, marker_y - 6, BAR_WIDTH + 8, 12), Color("fff1a8"), true); draw_rect(Rect2(-4, marker_y - 6, BAR_WIDTH + 8, 12), Color("fbbf24"), false, 2.0); draw_rect(Rect2(0, -22, BAR_WIDTH + 58, 12), Color("0f172a"), true); draw_rect(Rect2(0, -22, (BAR_WIDTH + 58) * progress, 12), Color("38bdf8"), true)


func _reset_marker() -> void:
	match str(params.get("rhythm", "stable")):
		"heavy_sink": green_center = 0.72; marker = 0.7
		"burst": green_center = 0.35; marker = 0.38
		_: green_center = 0.5; marker = 0.5
	marker_velocity = 0.0; spasm_next_at = 0.65 + float(rng.call()) * 0.85


func _drive_green(dt: float) -> void:
	var rhythm := str(params.get("rhythm", "stable")); var half_zone := clampf(float(params.get("zoneSize", 0.18)), 0.04, 0.45); burst_telegraph = 0.0; spasm_kick = maxf(0.0, spasm_kick - dt * 2.8)
	match rhythm:
		"stable": green_center = 0.5 + sin(elapsed * 2.2) * (0.42 - half_zone)
		"burst":
			var cycle := fposmod(elapsed, 4.2)
			if cycle < 2.45: green_center = 0.35 + sin(elapsed * 3.2) * 0.035
			elif cycle < 3.15: burst_telegraph = (cycle - 2.45) / 0.7; green_center = _smooth_lerp(0.35, 0.56, burst_telegraph)
			elif cycle < 3.55: burst_telegraph = 1.0; green_center = 0.78 + sin(elapsed * 8.0) * 0.025
			else: green_center = _smooth_lerp(0.78, 0.35, (cycle - 3.55) / 0.65)
		"spasm":
			if elapsed >= spasm_next_at: green_center = 0.18 + float(rng.call()) * 0.64; marker_velocity -= (0.16 + float(rng.call()) * 0.22) * maxf(0.2, float(params.get("sliderSpeed", 1.0))); spasm_kick = 1.0; spasm_next_at = elapsed + 0.45 + float(rng.call()) * 1.35
			green_center += sin(elapsed * 11.0 + marker * 7.0) * dt * 0.28
		"heavy_sink": green_center = 0.72 + sin(elapsed * 0.45) * 0.025
	green_center = clampf(green_center, half_zone + 0.02, 1.0 - half_zone - 0.02)


func _drive_marker(dt: float) -> void:
	var rhythm := str(params.get("rhythm", "stable")); var base := maxf(0.2, float(params.get("sliderSpeed", 1.0))); var acceleration := (1.12 if lift_held else -0.62) * base
	if rhythm == "heavy_sink": acceleration = (1.38 if lift_held else -0.9) * base
	elif rhythm == "burst": acceleration *= 1.25 if burst_telegraph > 0.8 else 1.0
	elif rhythm == "spasm": acceleration *= 1.0 + spasm_kick * 0.25
	marker_velocity += acceleration * dt * 2.4; marker_velocity *= exp(-dt * (2.1 if lift_held else 2.8)); var max_velocity := (0.78 if rhythm == "heavy_sink" else 0.95) * base; marker_velocity = clampf(marker_velocity, -max_velocity, max_velocity); marker += marker_velocity * dt * 1.1
	if marker < 0.02: marker = 0.02; marker_velocity = maxf(0.0, marker_velocity * -0.15)
	if marker > 0.98: marker = 0.98; marker_velocity = minf(0.0, marker_velocity * -0.15)


func _in_zone() -> bool: return absf(marker - green_center) <= clampf(float(params.get("zoneSize", 0.18)), 0.04, 0.45)
func _smooth_lerp(a: float, b: float, value: float) -> float: var x := clampf(value, 0.0, 1.0); var smooth := x * x * (3.0 - x * 2.0); return a + (b - a) * smooth
func _text(raw: String) -> String: var resolver: Variant = params.get("resolveText"); return str(resolver.call(raw)) if resolver is Callable and resolver.is_valid() else raw


func _finish(result: String) -> void:
	if done: return
	done = true; var callback: Variant = params.get("onResult")
	if callback is Callable and callback.is_valid(): callback.call(result)
