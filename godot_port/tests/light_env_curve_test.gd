extends SceneTree


func _init() -> void:
	assert(RuntimeLightEnvCurve.prepare(null) == null)
	assert(RuntimeLightEnvCurve.prepare({"points": [{"x": 1, "y": 1}, {"x": 1, "y": 1}]}) == null)
	var curve: Dictionary = RuntimeLightEnvCurve.prepare({"points": [
		{"x": 0, "y": 0, "env": {"key": {"azimuthDeg": 350.0, "intensity": 0.0, "color": [0.0, 0.2, 0.4]}, "shadow": {"mode": "planar", "enabled": true}, "toneEnabled": true}},
		{"x": 10, "y": 0, "env": {"key": {"azimuthDeg": 10.0, "intensity": 1.0, "color": [1.0, 0.6, 0.8]}, "shadow": {"mode": "real", "enabled": false}, "toneEnabled": false}},
		{"x": 10, "y": 10, "env": {"ambient": {"intensity": 0.25}}},
	]})
	assert(curve.total == 20.0 and curve.cum == [0.0, 10.0, 20.0])
	assert(is_equal_approx(RuntimeLightEnvCurve.project_to_t(curve, 5, 3), 0.25))
	assert(is_equal_approx(RuntimeLightEnvCurve.project_to_t(curve, 13, 5), 0.75))
	var quarter := RuntimeLightEnvCurve.interpolate(curve, 0.25)
	assert(is_equal_approx(float(quarter.key.azimuthDeg), 0.0))
	assert(is_equal_approx(float(quarter.key.intensity), 0.5))
	assert(is_equal_approx(float(quarter.key.color[0]), 0.5) and is_equal_approx(float(quarter.key.color[1]), 0.4) and is_equal_approx(float(quarter.key.color[2]), 0.6))
	assert(quarter.shadow.mode == "real" and quarter.shadow.enabled == false and quarter.toneEnabled == false)
	var latter := RuntimeLightEnvCurve.interpolate(curve, 0.75)
	assert(latter.key.azimuthDeg == 10.0 and latter.ambient.intensity == 0.25)
	var non_linear: Dictionary = RuntimeLightEnvCurve.prepare({"points": [
		{"x": 0, "y": 0, "env": {"key": {"intensity": 0.0}}},
		{"x": 10, "y": 0, "env": {"key": {"intensity": 1.0}}},
	]})
	var smooth := RuntimeLightEnvCurve.interpolate(non_linear, 0.25)
	assert(is_equal_approx(float(smooth.key.intensity), 0.15625))
	var destination := {
		"key": {"azimuthDeg": 0.0, "elevationDeg": 0.0, "color": [0.0, 0.0, 0.0], "intensity": 9.0},
		"ambient": {"color": [0.0, 0.0, 0.0], "intensity": 0.0},
		"shadow": {"mode": "off", "enabled": false, "darkness": 0.0, "softness": 0.0, "length": 0.0, "contact": 0.0, "contactSize": 0.0, "softSamples": 0, "softRadius": 0.0, "billboard": "camera"},
		"ao": {"contact": 0.0, "form": 0.0},
		"toneStrength": 0.0,
		"toneEnabled": true,
	}
	var identity := destination
	var key_identity: Dictionary = destination.key
	var shadow_identity: Dictionary = destination.shadow
	var source := {
		"key": {"azimuthDeg": 125.0, "elevationDeg": 55.0, "color": [1.0, 0.97, 0.92], "intensity": 0.4},
		"ambient": {"color": [0.55, 0.6, 0.72], "intensity": 0.5},
		"shadow": {"mode": "real", "enabled": true, "darkness": 0.4, "softness": 1.0, "length": 0.7, "contact": 0.5, "contactSize": 1.0, "softSamples": 1, "softRadius": 0.05, "billboard": "light"},
		"ao": {"contact": 0.45, "form": 0.2},
		"toneStrength": 0.3,
		"toneEnabled": false,
	}
	RuntimeLightEnvCurve.copy_resolved_into(destination, source)
	assert(identity == destination and is_same(destination.key, key_identity) and is_same(destination.shadow, shadow_identity))
	assert(destination == source and destination.key.intensity == 0.4 and destination.shadow.mode == "real" and destination.toneEnabled == false)
	print("LightEnvCurve projection/interpolation/copy parity test: PASS")
	quit(0)
