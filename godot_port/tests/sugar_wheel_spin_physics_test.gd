extends Node

const UINT32_MASK := 0xffffffff

var rng_values: Array[float] = []
var rng_calls := 0
var mulberry_seed := 0


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var zodiac: Variant = assets.load_json("/assets/data/sugar_wheel/sugar_zodiac.json")
	var folk: Variant = assets.load_json("/assets/data/sugar_wheel/sugar_chongqing_folk.json")
	assert(zodiac is Dictionary and folk is Dictionary and zodiac.sectors.size() == 12 and folk.sectors.size() == 12)

	# Direct utility boundaries retain the source module's named API and JS-number
	# semantics rather than delegating domain behavior to engine helpers/callers.
	assert(RuntimeSugarWheelSpinPhysics.finite_or(3.5, 9.0) == 3.5)
	assert(RuntimeSugarWheelSpinPhysics.finite_or(true, 9.0) == 9.0)
	assert(RuntimeSugarWheelSpinPhysics.finite_or(INF, 9.0) == 9.0)
	assert(RuntimeSugarWheelSpinPhysics.clamp(4.0, -1.0, 2.0) == 2.0)
	assert(RuntimeSugarWheelSpinPhysics.lerp(2.0, 6.0, 0.25) == 3.0)
	assert(is_equal_approx(RuntimeSugarWheelSpinPhysics.normalize_angle(-0.25), RuntimeSugarWheelSpinPhysics.TAU - 0.25))
	assert(is_equal_approx(RuntimeSugarWheelSpinPhysics.deg_to_rad(180.0), PI))

	var empty_layout := RuntimeSugarWheelSpinPhysics.sector_layout_from_instance({"sectors": []})
	assert(empty_layout == {"n": 0, "step": RuntimeSugarWheelSpinPhysics.TAU, "left0": 0.0})
	var layout := RuntimeSugarWheelSpinPhysics.sector_layout_from_instance(zodiac)
	assert(layout.n == 12 and is_equal_approx(layout.step, PI / 6.0) and layout.left0 == 0.0)
	assert(RuntimeSugarWheelSpinPhysics.sector_index_from_wheel_geom_angle(0.0, layout) == 0)
	assert(RuntimeSugarWheelSpinPhysics.sector_index_from_wheel_geom_angle(PI / 6.0 - 1e-6, layout) == 0)
	assert(RuntimeSugarWheelSpinPhysics.sector_index_from_wheel_geom_angle(PI / 6.0 + 1e-6, layout) == 1)
	assert(RuntimeSugarWheelSpinPhysics.sector_index_from_wheel_geom_angle(-1e-6, layout) == 11)
	var phased := {"sectors": [{}, {}, {}, {}], "sectorAngleOffsetDeg": 90.0, "sectorCenterPhase": 0.5}
	var phased_layout := RuntimeSugarWheelSpinPhysics.sector_layout_from_instance(phased)
	assert(is_equal_approx(phased_layout.left0, PI * 0.75))

	# Equal terrain cancels exactly around an evenly divided wheel. Invalid and
	# omitted weights both translate to the same source default of 1.
	var equal_instance: Dictionary = zodiac.duplicate(true)
	for sector: Variant in equal_instance.sectors:
		if sector is Dictionary:
			sector.erase("weight")
	for phi: float in [0.0, 0.1, 1.2, 3.7, 5.9, RuntimeSugarWheelSpinPhysics.TAU - 0.01]:
		assert(absf(RuntimeSugarWheelSpinPhysics.weight_derived_bias_accel(phi, equal_instance)) < 1e-8)
	var invalid_weights := equal_instance.duplicate(true)
	invalid_weights.sectors[0].weight = -1.0
	invalid_weights.sectors[1].weight = NAN
	assert(absf(RuntimeSugarWheelSpinPhysics.weight_derived_bias_accel(0.7, invalid_weights)) < 1e-8)
	var target_center := (3.0 + 0.5) * RuntimeSugarWheelSpinPhysics.TAU / 12.0
	var after_center := RuntimeSugarWheelSpinPhysics.normalize_angle(target_center + 0.05)
	var low := equal_instance.duplicate(true); low.sectors[3].weight = 0.25
	var high := equal_instance.duplicate(true); high.sectors[3].weight = 2.5
	assert(RuntimeSugarWheelSpinPhysics.weight_derived_bias_accel(after_center, high) < 0.0)
	assert(RuntimeSugarWheelSpinPhysics.weight_derived_bias_accel(after_center, low) > 0.0)
	assert(is_equal_approx(RuntimeSugarWheelSpinPhysics.spin_drag_effective_k(0.8, folk), 1.6065725763888454))
	assert(is_equal_approx(RuntimeSugarWheelSpinPhysics.weight_derived_bias_accel(1.234, folk), 0.376337500756391))
	assert(is_equal_approx(RuntimeSugarWheelSpinPhysics.weight_terrain_potential(1.234, folk), 0.9121688244632259))

	# advanceSugarWheelSpinStep consumes the source SpinStepInput object. Golden
	# values catch operation-order drift across alpha decay, k(omega), bias, dry
	# friction and final Euler angle integration.
	var output := RuntimeSugarWheelSpinPhysics.advance_sugar_wheel_spin_step({"instance": folk, "omega": 5.0, "alpha": 3.0, "phiGeom": 1.234, "dt": 0.05})
	assert(is_equal_approx(output.omega, 5.108936170638559))
	assert(is_equal_approx(output.alpha, 2.7623859120147958))
	assert(is_equal_approx(output.phiGeom, 1.4894468085319277))
	var clamped_dt := RuntimeSugarWheelSpinPhysics.advance_sugar_wheel_spin_step({"instance": folk, "omega": 5.0, "alpha": 3.0, "phiGeom": 1.234, "dt": 5.0})
	assert(clamped_dt == output)
	var zero_dt := RuntimeSugarWheelSpinPhysics.advance_sugar_wheel_spin_step({"instance": folk, "omega": 5.0, "alpha": 3.0, "phiGeom": 1.234, "dt": -1.0})
	assert(zero_dt == {"omega": 5.0, "alpha": 3.0, "phiGeom": 1.234})
	var no_half_life := equal_instance.duplicate(true)
	no_half_life.spinAccelHalfLifeSec = 0.0
	no_half_life.spinLinearDragPerSec = 0.0
	no_half_life.spinDragLowSpeedThresholdRadPerSec = 0.0
	no_half_life.spinDragLowSpeedBoostPerSec = 0.0
	no_half_life.spinDryFrictionAccelRadPerSec2 = 0.0
	no_half_life.spinWeightBiasCreepRefRadPerSec = 0.0
	var no_alpha := RuntimeSugarWheelSpinPhysics.advance_sugar_wheel_spin_step({"instance": no_half_life, "omega": 1.0, "alpha": 8.0, "phiGeom": 0.0, "dt": 0.05})
	assert(no_alpha.alpha == 0.0 and is_equal_approx(no_alpha.omega, 0.99825))
	var dry_stop := equal_instance.duplicate(true)
	dry_stop.spinAccelHalfLifeSec = 0.0
	dry_stop.spinLinearDragPerSec = 0.0
	dry_stop.spinDragLowSpeedThresholdRadPerSec = 0.0
	dry_stop.spinDragLowSpeedBoostPerSec = 0.0
	dry_stop.spinWeightBiasCreepRefRadPerSec = 0.0
	dry_stop.spinDryFrictionAccelRadPerSec2 = 1.0
	var stopped := RuntimeSugarWheelSpinPhysics.advance_sugar_wheel_spin_step({"instance": dry_stop, "omega": 0.02, "alpha": 0.0, "phiGeom": 0.3, "dt": 0.05})
	assert(stopped.omega == 0.0 and stopped.phiGeom == 0.3)

	# The simulation consumes RNG in source order: initial phi first, power second;
	# explicitly supplied values consume none, and an empty wheel returns before RNG.
	rng_values = [0.2, 0.7]; rng_calls = 0
	var zero_step_index := RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(zodiac, Callable(self, "_sequence_rng"), {"maxSteps": 0})
	assert(rng_calls == 2 and zero_step_index == 2)
	rng_values = [0.7]; rng_calls = 0
	RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(zodiac, Callable(self, "_sequence_rng"), {"initialPhiRad": 0.1, "maxSteps": 0})
	assert(rng_calls == 1)
	rng_values = [0.2]; rng_calls = 0
	RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(zodiac, Callable(self, "_sequence_rng"), {"power": 0.7, "maxSteps": 0})
	assert(rng_calls == 1)
	rng_calls = 0
	RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(zodiac, Callable(self, "_sequence_rng"), {"initialPhiRad": 0.1, "power": 0.2, "maxSteps": 0})
	assert(rng_calls == 0)
	rng_calls = 0
	assert(RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing({"sectors": []}, Callable(self, "_sequence_rng")) == 0 and rng_calls == 0)

	# Real-data deterministic landings match the TypeScript integrator.
	var no_rng := Callable(self, "_rng_must_not_run")
	assert(RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(zodiac, no_rng, {"power": 0.2, "initialPhiRad": 0.1}) == 11)
	assert(RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(folk, no_rng, {"power": 0.2, "initialPhiRad": 0.1}) == 0)
	assert(RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(zodiac, no_rng, {"power": 0.5, "initialPhiRad": 1.5}) == 0)
	assert(RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(folk, no_rng, {"power": 0.5, "initialPhiRad": 1.5}) == 0)
	assert(RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(zodiac, no_rng, {"power": 1.0, "initialPhiRad": 4.2}) == 9)
	assert(RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(folk, no_rng, {"power": 1.0, "initialPhiRad": 4.2}) == 1)

	# Port the source PRNG-driven legal-index sweep and a bounded paired Monte Carlo
	# ordering check; the TypeScript suite retains the full 20,000-pair threshold.
	var monte_carlo_low := _make_twelve_wheel(0.25)
	var monte_carlo_high := _make_twelve_wheel(2.5)
	mulberry_seed = 42
	assert(is_equal_approx(_mulberry32(), 0.6011037519201636))
	assert(is_equal_approx(_mulberry32(), 0.44829055899754167))
	mulberry_seed = 42
	var legal_index_wheel := _make_twelve_wheel(0.2)
	for _trial: int in 500:
		var landed := RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(legal_index_wheel, Callable(self, "_mulberry32"))
		assert(landed >= 0 and landed < 12)
	var low_hits := 0
	var high_hits := 0
	mulberry_seed = 0xbeefcafe
	for _trial: int in 1000:
		var phi := RuntimeSugarWheelSpinPhysics.normalize_angle(_mulberry32() * RuntimeSugarWheelSpinPhysics.TAU)
		var power := RuntimeSugarWheelSpinPhysics.clamp(_mulberry32(), 0.0, 1.0)
		var options := {"initialPhiRad": phi, "power": power}
		if RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(monte_carlo_low, no_rng, options) == 3:
			low_hits += 1
		if RuntimeSugarWheelSpinPhysics.simulate_sugar_wheel_landing(monte_carlo_high, no_rng, options) == 3:
			high_hits += 1
	assert(high_hits > low_hits + 12, "low=%s high=%s" % [low_hits, high_hits])

	assets.dispose()
	print("SugarWheel spin physics direct API/input/RNG/integration/landing contract test: PASS")
	get_tree().quit(0)


func _sequence_rng() -> float:
	var value := rng_values[rng_calls] if rng_calls < rng_values.size() else 0.0
	rng_calls += 1
	return value


func _rng_must_not_run() -> float:
	rng_calls += 1
	return 0.0


func _make_twelve_wheel(dragon_weight: float) -> Dictionary:
	var sectors: Array = []
	for index: int in 12:
		var sector := {"id": "dragon" if index == 3 else "s%s" % index, "label": str(index)}
		if index == 3:
			sector.weight = dragon_weight
		sectors.push_back(sector)
	return {
		"id": "testwheel",
		"label": "test",
		"wheelImage": "/assets/x.png",
		"pointerImage": "/assets/y.png",
		"sectorDirection": "clockwise",
		"sectorAngleOffsetDeg": 0,
		"sectorCenterPhase": 0,
		"pointerArtOffsetDeg": 0,
		"spinLinearDragPerSec": 0.12,
		"spinDragLowSpeedThresholdRadPerSec": 2.2,
		"spinDragLowSpeedBoostPerSec": 2.0,
		"spinChargeMinVelocityRadPerSec": 0,
		"spinChargeMaxVelocityRadPerSec": 10.5,
		"spinChargeMinAccelRadPerSec2": 0,
		"spinChargeMaxAccelRadPerSec2": 8.5,
		"spinAccelHalfLifeSec": 0.42,
		"spinStopSpeedRadPerSec": 0.06,
		"spinStopSettleSec": 0.12,
		"spinDryFrictionAccelRadPerSec2": 0,
		"spinWeightBiasCreepRefRadPerSec": 0,
		"sectors": sectors,
	}


func _imul32(a: int, b: int) -> int:
	return (a * b) & UINT32_MASK


func _mulberry32() -> float:
	mulberry_seed = (mulberry_seed + 0x6d2b79f5) & UINT32_MASK
	var value := mulberry_seed
	value = _imul32(value ^ (value >> 15), value | 1)
	value ^= (value + _imul32(value ^ (value >> 7), value | 61)) & UINT32_MASK
	value &= UINT32_MASK
	return float((value ^ (value >> 14)) & UINT32_MASK) / 4294967296.0
