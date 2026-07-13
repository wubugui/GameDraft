extends Node


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var zodiac: Variant = assets.load_json("/assets/data/sugar_wheel/sugar_zodiac.json"); var folk: Variant = assets.load_json("/assets/data/sugar_wheel/sugar_chongqing_folk.json")
	assert(zodiac is Dictionary and folk is Dictionary and zodiac.sectors.size() == 12 and folk.sectors.size() == 12)
	var layout := RuntimeSugarWheelSpinPhysics.sector_layout(zodiac); assert(layout.n == 12 and is_equal_approx(layout.step, PI / 6.0) and layout.left0 == 0.0)
	assert(RuntimeSugarWheelSpinPhysics.sector_index(0.0, layout) == 0 and RuntimeSugarWheelSpinPhysics.sector_index(PI / 6.0 - 1e-6, layout) == 0 and RuntimeSugarWheelSpinPhysics.sector_index(PI / 6.0 + 1e-6, layout) == 1)
	var equal_instance: Dictionary = zodiac.duplicate(true)
	for value: Variant in equal_instance.sectors: if value is Dictionary: value.erase("weight")
	for phi: float in [0.0, 0.1, 1.2, 3.7, 5.9]: assert(absf(RuntimeSugarWheelSpinPhysics.weight_derived_bias_accel(phi, equal_instance)) < 1e-8)
	var target_center := (3.0 + 0.5) * RuntimeSugarWheelSpinPhysics.TAU / 12.0; var after_center := RuntimeSugarWheelSpinPhysics.normalize_angle(target_center + 0.05); var low := equal_instance.duplicate(true); low.sectors[3].weight = 0.25; var high := equal_instance.duplicate(true); high.sectors[3].weight = 2.5
	assert(RuntimeSugarWheelSpinPhysics.weight_derived_bias_accel(after_center, high) < 0 and RuntimeSugarWheelSpinPhysics.weight_derived_bias_accel(after_center, low) > 0)
	assert(is_equal_approx(RuntimeSugarWheelSpinPhysics.spin_drag_effective_k(0.8, folk), 1.6065725763888454))
	assert(is_equal_approx(RuntimeSugarWheelSpinPhysics.weight_derived_bias_accel(1.234, folk), 0.376337500756391))
	assert(is_equal_approx(RuntimeSugarWheelSpinPhysics.weight_terrain_potential(1.234, folk), 0.9121688244632259))
	var output := RuntimeSugarWheelSpinPhysics.advance_step(folk, 5.0, 3.0, 1.234, 0.05)
	assert(is_equal_approx(output.omega, 5.108936170638559) and is_equal_approx(output.alpha, 2.7623859120147958) and is_equal_approx(output.phiGeom, 1.4894468085319277))
	assert(RuntimeSugarWheelSpinPhysics.simulate_landing(zodiac, 0.2, 0.1) == 11 and RuntimeSugarWheelSpinPhysics.simulate_landing(folk, 0.2, 0.1) == 0)
	assert(RuntimeSugarWheelSpinPhysics.simulate_landing(zodiac, 0.5, 1.5) == 0 and RuntimeSugarWheelSpinPhysics.simulate_landing(folk, 0.5, 1.5) == 0)
	assert(RuntimeSugarWheelSpinPhysics.simulate_landing(zodiac, 1.0, 4.2) == 9 and RuntimeSugarWheelSpinPhysics.simulate_landing(folk, 1.0, 4.2) == 1)
	assets.dispose(); print("SugarWheel physics/layout/weight/golden landing parity test: PASS"); get_tree().quit(0)
