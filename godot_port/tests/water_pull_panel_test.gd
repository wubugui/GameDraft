extends Node

var results: Array[String] = []
var rng_values: Array[float] = []
var rng_calls := 0


func _ready() -> void:
	# Constructor consumes RNG in source order (wobble seed, rhythm reset), keeps
	# random inside params, creates five distinct Graphics owners and then Text.
	rng_values = [0.25, 0.5]; rng_calls = 0
	var panel := _make_panel("stable", "escape", 1.0)
	add_child(panel)
	assert(rng_calls == 2 and is_equal_approx(panel.wobble_seed, PI * 0.5))
	assert(panel.limit == 2.0 and panel.marker == 0.5 and panel.green_center == 0.5)
	assert(panel.spasm_next_at == 0.65 + 0.5 * 0.85)
	assert(panel.get_children() == [panel.bar_g, panel.warning_g, panel.green_g, panel.marker_g, panel.prog_g, panel.hint])
	assert(panel.bar_g != panel.warning_g and panel.warning_g != panel.green_g and panel.green_g != panel.marker_g and panel.marker_g != panel.prog_g)
	panel.set_lift_held(true); assert(panel._lift_held())
	panel.set_lift_held(false); assert(not panel._lift_held())
	panel.queue_free()

	# resetMarkerForRhythm exact initial states and second RNG draw.
	for rhythm_and_state: Array in [
		["heavy_sink", 0.72, 0.7],
		["burst", 0.35, 0.38],
		["spasm", 0.5, 0.5],
		["stable", 0.5, 0.5],
	]:
		rng_values = [0.0, 0.0]; rng_calls = 0
		var reset_panel := _make_panel(str(rhythm_and_state[0]), "bite", 8.0)
		assert(reset_panel.green_center == rhythm_and_state[1] and reset_panel.marker == rhythm_and_state[2])
		assert(reset_panel.marker_vel == 0.0 and reset_panel.spasm_next_at == 0.65 and rng_calls == 2)
		reset_panel.free()

	# Wobble and smoothing functions retain their source rhythm formulas.
	var stable_math := _make_panel("stable", "bite", 8.0)
	stable_math.elapsed = 0.7; stable_math.wobble_seed = 0.3
	assert(is_equal_approx(stable_math._marker_wobble(), sin(0.7 * 3.2 + 0.3) * 0.8))
	assert(stable_math._smooth01(-2.0) == 0.0 and stable_math._smooth01(2.0) == 1.0)
	assert(is_equal_approx(stable_math._smooth01(0.25), 0.15625))
	assert(is_equal_approx(stable_math._lerp(2.0, 6.0, 0.25), 2.625))
	stable_math.free()
	var heavy_math := _make_panel("heavy_sink", "bite", 8.0); assert(heavy_math._marker_wobble() == 0.0); heavy_math.free()
	var burst_math := _make_panel("burst", "bite", 8.0); burst_math.elapsed = 1.0; burst_math.wobble_seed = 0.2; burst_math.burst_telegraph = 0.75; assert(is_equal_approx(burst_math._marker_wobble(), sin(10.2) * (0.6 + 0.75 * 3.4))); burst_math.free()
	var spasm_math := _make_panel("spasm", "bite", 8.0); spasm_math.elapsed = 0.4; spasm_math.wobble_seed = 0.1; spasm_math.spasm_kick = 0.5; assert(is_equal_approx(spasm_math._marker_wobble(), sin(0.4 * 19.0 + 0.1) * (1.2 + 0.5 * 9.0))); spasm_math.free()

	# driveGreen covers stable, all burst subphases, heavy breathing, and spasm's
	# three deterministic RNG draws/order plus marker kick.
	var stable_green := _make_panel("stable", "bite", 8.0); stable_green.elapsed = 0.6; stable_green._drive_green(0.1); assert(is_equal_approx(stable_green.green_center, 0.5 + sin(0.6 * 2.2) * (0.42 - 0.18))); stable_green.free()
	var burst_green := _make_panel("burst", "bite", 8.0)
	burst_green.elapsed = 2.8; burst_green._drive_green(0.1); assert(is_equal_approx(burst_green.burst_telegraph, 0.5) and is_equal_approx(burst_green.green_center, burst_green._lerp(0.35, 0.56, 0.5)))
	burst_green.elapsed = 3.2; burst_green._drive_green(0.1); assert(burst_green.burst_telegraph == 1.0 and is_equal_approx(burst_green.green_center, 0.78 + sin(3.2 * 8.0) * 0.025))
	burst_green.elapsed = 3.8; burst_green._drive_green(0.1); assert(is_equal_approx(burst_green.green_center, burst_green._lerp(0.78, 0.35, (3.8 - 3.55) / 0.65))); burst_green.free()
	var heavy_green := _make_panel("heavy_sink", "bite", 8.0); heavy_green.elapsed = 2.0; heavy_green._drive_green(0.1); assert(is_equal_approx(heavy_green.green_center, 0.72 + sin(0.9) * 0.025)); heavy_green.free()
	rng_values = [0.0, 0.0, 0.1, 0.2, 0.3]; rng_calls = 0
	var spasm_green := _make_panel("spasm", "bite", 8.0)
	spasm_green.elapsed = spasm_green.spasm_next_at
	var spasm_time := spasm_green.elapsed
	spasm_green._drive_green(0.1)
	assert(rng_calls == 5 and spasm_green.spasm_kick == 1.0)
	assert(is_equal_approx(spasm_green.marker_vel, -(0.16 + 0.2 * 0.22) * 0.75))
	assert(is_equal_approx(spasm_green.spasm_next_at, spasm_time + 0.45 + 0.3 * 1.35))
	spasm_green.free()

	# Marker force direction, damping, velocity clamp and both boundary bounces.
	var marker_panel := _make_panel("stable", "bite", 8.0)
	marker_panel.marker = 0.5; marker_panel.marker_vel = 0.0; marker_panel.set_lift_held(true); marker_panel._drive_marker(0.05); assert(marker_panel.marker_vel > 0.0 and marker_panel.marker > 0.5)
	marker_panel.marker = 0.5; marker_panel.marker_vel = 0.0; marker_panel.set_lift_held(false); marker_panel._drive_marker(0.05); assert(marker_panel.marker_vel < 0.0 and marker_panel.marker < 0.5)
	marker_panel.marker = 0.0; marker_panel.marker_vel = -1.0; marker_panel._drive_marker(0.05); assert(marker_panel.marker == 0.02 and marker_panel.marker_vel >= 0.0)
	marker_panel.marker = 1.0; marker_panel.marker_vel = 1.0; marker_panel._drive_marker(0.05); assert(marker_panel.marker == 0.98 and marker_panel.marker_vel <= 0.0)
	marker_panel.marker = marker_panel.green_center; assert(marker_panel._in_zone())
	marker_panel.marker = 0.0; marker_panel.green_center = 1.0; assert(not marker_panel._in_zone())
	marker_panel.free()

	# update clamps dt, updates progress/hint before result, supports controlled
	# success, maps all three timeout policies, and completes exactly once.
	results.clear(); rng_values = [0.5, 0.5]; rng_calls = 0
	var stable := _make_panel("stable", "escape", 8.0); add_child(stable)
	var before_negative := stable.progress; stable.update(-1.0); assert(stable.progress == before_negative and stable.elapsed == 0.0)
	for _index: int in 600:
		stable.set_lift_held(stable.marker < stable.green_center)
		stable.update(0.02)
		if stable.done: break
	assert(results == ["success"] and stable.progress >= 0.995)
	var elapsed_at_done := stable.elapsed; stable.update(1.0); stable.abort(); assert(results == ["success"] and stable.elapsed == elapsed_at_done)
	stable.queue_free()

	for policy: String in ["escape", "snap", "bite"]:
		results.clear(); rng_values = [0.5, 0.5]; rng_calls = 0
		var failure := _make_panel("heavy_sink", policy, 2.0); add_child(failure)
		failure.marker = 0.02; failure.green_center = 0.9; failure.progress = 0.0; failure.marker_vel = 0.0
		for _index: int in 40:
			failure.set_lift_held(false); failure.update(0.084)
			if failure.done: break
		var expected := "fail_escape" if policy == "escape" else ("fail_snap" if policy == "snap" else "fail_bite")
		assert(results == [expected], "policy=%s result=%s elapsed=%s limit=%s" % [policy, results, failure.elapsed, failure.limit])
		assert(failure.hint.text.contains("pullStatus"))
		failure.queue_free()

	results.clear(); rng_values = [0.5, 0.5]; rng_calls = 0
	var abort_panel := _make_panel("spasm", "bite", 10.0); add_child(abort_panel)
	abort_panel.abort(); abort_panel.abort()
	assert(results == ["abort"] and abort_panel.done)
	abort_panel.queue_free()
	print("WaterPullPanel direct field/RNG/rhythm/physics/result/graphics-owner contract test: PASS")
	get_tree().quit(0)


func _make_panel(rhythm: String, policy: String, time_limit: float) -> RuntimeWaterPullPanel:
	return RuntimeWaterPullPanel.new({
		"zoneSize": 0.18,
		"sliderSpeed": 0.75,
		"rhythm": rhythm,
		"failurePolicy": policy,
		"timeLimitSec": time_limit,
		"resolveText": func(raw: String) -> String: return raw,
		"random": Callable(self, "_sequence_rng"),
		"onResult": Callable(self, "_capture"),
	})


func _sequence_rng() -> float:
	var value := rng_values[rng_calls] if rng_calls < rng_values.size() else 0.5
	rng_calls += 1
	return value


func _capture(value: String) -> void:
	results.push_back(value)
