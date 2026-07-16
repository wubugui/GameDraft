extends SceneTree

const RuntimeLightEnvResolverScript := preload("res://scripts/rendering/light_env_resolver.gd")


func _init() -> void:
	var baseline := RuntimeLightEnvResolverScript.resolve(null, null)
	assert(baseline.key.azimuthDeg == 125.0 and baseline.key.elevationDeg == 55.0)
	assert(baseline.shadow.mode == "real" and baseline.shadow.enabled == true)
	assert(baseline.shadow.length >= 0.3 and baseline.shadow.length <= 1.6)
	assert(baseline.toneStrength == 0.45 and baseline.toneEnabled == true)

	var resolved := RuntimeLightEnvResolverScript.resolve({
		"key": {"azimuthDeg": NAN, "elevationDeg": 30.0, "color": ["2.5", -1.0, 9.0], "intensity": INF},
		"ambient": {"color": [null, true, "bad"], "intensity": 0.25},
		"shadow": {
			"mode": "off", "enabled": false, "darkness": 3.0, "softness": -2.0,
			"contact": -1.0, "contactSize": 0.0, "softSamples": 20.0,
			"softRadius": -1.0, "billboard": "camera",
		},
		"toneStrength": 2.0,
		"toneEnabled": false,
		"ao": {"contact": 2.0, "form": -1.0},
	}, {
		"shadowMode": "planar",
		"toneEnabled": true,
		"defaultLightEnv": {
			"key": {"azimuthDeg": 40.0, "intensity": 0.75},
			"shadow": {"length": 1.25, "softSamples": 3.0},
		},
	})
	assert(resolved.key.azimuthDeg == 40.0 and resolved.key.elevationDeg == 30.0 and resolved.key.intensity == 0.75)
	assert(resolved.key.color == [2.5, 0.0, 4.0])
	assert(resolved.ambient.color == [0.0, 1.0, 0.72] and resolved.ambient.intensity == 0.25)
	assert(resolved.shadow.mode == "off" and resolved.shadow.enabled == false and resolved.shadow.length == 1.25)
	assert(resolved.shadow.darkness == 1.0 and resolved.shadow.softness == 0.0)
	assert(resolved.shadow.contact == 0.0 and resolved.shadow.contactSize == 0.1)
	assert(resolved.shadow.softSamples == 16 and resolved.shadow.softRadius == 0.0 and resolved.shadow.billboard == "camera")
	assert(resolved.toneStrength == 1.0 and resolved.toneEnabled == false)
	assert(resolved.ao.contact == 1.0 and resolved.ao.form == 0.0)

	var scene_length := RuntimeLightEnvResolverScript.resolve({"shadow": {"length": 0.7}}, {"defaultLightEnv": {"shadow": {"length": 1.2}}})
	assert(scene_length.shadow.length == 0.7)
	var invalid_scene_length := RuntimeLightEnvResolverScript.resolve({"shadow": {"length": NAN}}, {"defaultLightEnv": {"shadow": {"length": 1.2}}})
	assert(invalid_scene_length.shadow.length == 1.2)
	baseline.key.intensity = 99.0
	assert(RuntimeLightEnvResolverScript.resolve(null, null).key.intensity == 1.0)

	print("LightEnv baseline/merge/clamp/precedence/length direct-translation test: PASS")
	quit(0)
