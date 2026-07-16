extends SceneTree


func _init() -> void:
	var env := {
		"key": {"azimuthDeg": 90.0},
		"shadow": {"length": 0.75},
	}
	var field := RuntimeUniformShadowField.new(env)
	var projection := field.sample(10.0, 20.0)
	assert(is_equal_approx(projection.angleRad, PI * 1.5) and projection.length == 0.75)
	env.key.azimuthDeg = 0.0
	env.shadow.length = 1.25
	var updated := field.sample(-100.0, 999.0)
	assert(is_equal_approx(updated.angleRad, PI) and updated.length == 1.25)

	print("UniformShadowField reference/direction/length direct-translation test: PASS")
	quit(0)
