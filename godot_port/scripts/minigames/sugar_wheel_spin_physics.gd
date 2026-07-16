class_name RuntimeSugarWheelSpinPhysics
extends RefCounted

const TAU := PI * 2.0
const DEFAULT_SPIN_WEIGHT_BIAS_STRENGTH_RAD_PER_S2 := 4.2
const MIN_SPIN_TERRAIN_WEIGHT := 0.05
const DEFAULT_SPIN_DRY_FRICTION_ACCEL_RAD_PER_SEC2 := 0.34
const DEFAULT_SPIN_BIAS_CREEP_REF_RAD_PER_SEC := 1.2


static func finite_or(value: Variant, fallback: float) -> float:
	return float(value) if (value is int or value is float) and is_finite(float(value)) else fallback


static func clamp(value: float, minimum: float, maximum: float) -> float:
	return maxf(minimum, minf(maximum, value))


static func lerp(a: float, b: float, t: float) -> float:
	return a + (b - a) * t


static func normalize_angle(value: float) -> float:
	return fposmod(value, TAU)


static func deg_to_rad(value: float) -> float:
	return (value / 180.0) * PI


static func sector_layout_from_instance(instance: Dictionary) -> Dictionary:
	var sectors: Array = instance.sectors
	var count := sectors.size()
	if count <= 0:
		return {"n": 0, "step": TAU, "left0": 0.0}
	var step := TAU / count
	var offset := deg_to_rad(finite_or(instance.get("sectorAngleOffsetDeg"), 0.0))
	var raw_phase: Variant = instance.get("sectorCenterPhase")
	var phase := float(raw_phase) if (raw_phase is int or raw_phase is float) and is_finite(float(raw_phase)) else 0.0
	var left0 := offset + phase * step
	return {"n": count, "step": step, "left0": left0}


static func sector_index_from_wheel_geom_angle(geom_mod: float, layout: Dictionary) -> int:
	var count: int = layout.n
	var step: float = layout.step
	var left0: float = layout.left0
	if count <= 0:
		return 0
	var relative := normalize_angle(geom_mod - left0)
	var index := int(floor(relative / step + 1e-9))
	index = posmod(posmod(index, count) + count, count)
	return index


static func _sector_weight_or_default(sector: Variant) -> float:
	var weight: Variant = sector.get("weight") if sector is Dictionary else null
	if (weight is int or weight is float) and is_finite(float(weight)) and float(weight) >= 0.0:
		return float(weight)
	return 1.0


static func spin_weight_bias_scale(instance: Dictionary) -> float:
	var configured: Variant = instance.get("spinWeightBiasStrengthRadPerSec2")
	return float(configured) if (configured is int or configured is float) and is_finite(float(configured)) and float(configured) > 0.0 else DEFAULT_SPIN_WEIGHT_BIAS_STRENGTH_RAD_PER_S2


static func _weight_terrain_harmonic_components(phi: float, instance: Dictionary) -> Dictionary:
	var sectors: Array = instance.sectors
	var layout := sector_layout_from_instance(instance)
	var count: int = layout.n
	var step: float = layout.step
	var left0: float = layout.left0
	if count <= 0:
		return {"sinSum": 0.0, "cosSum": 0.0}

	var sin_sum := 0.0
	var cos_sum := 0.0
	for index: int in count:
		var raw_weight := _sector_weight_or_default(sectors[index] if index < sectors.size() else null)
		var terrain_weight := maxf(MIN_SPIN_TERRAIN_WEIGHT, raw_weight)
		var height := -log(terrain_weight)
		var center := left0 + (index + 0.5) * step
		var difference := phi - center
		sin_sum += height * sin(difference)
		cos_sum += height * cos(difference)
	return {"sinSum": sin_sum, "cosSum": cos_sum}


static func weight_terrain_potential(phi: float, instance: Dictionary) -> float:
	var scale := spin_weight_bias_scale(instance)
	return scale * float(_weight_terrain_harmonic_components(phi, instance).cosSum)


static func weight_derived_bias_accel(phi: float, instance: Dictionary) -> float:
	var scale := spin_weight_bias_scale(instance)
	return scale * float(_weight_terrain_harmonic_components(phi, instance).sinSum)


static func advance_sugar_wheel_spin_step(input: Dictionary) -> Dictionary:
	var instance: Dictionary = input.instance
	var omega: float = input.omega
	var alpha: float = input.alpha
	var phi_geom: float = input.phiGeom
	var dt: float = input.dt
	dt = clamp(dt, 0.0, 0.05)

	var half_life := finite_or(instance.get("spinAccelHalfLifeSec"), 0.42)
	if half_life > 1e-5:
		alpha *= pow(0.5, dt / half_life)
	else:
		alpha = 0.0

	var k := spin_drag_effective_k(omega, instance)
	var bias_accel := weight_derived_bias_accel(phi_geom, instance)

	var creep_config: Variant = instance.get("spinWeightBiasCreepRefRadPerSec")
	var creep_ref: float
	if not instance.has("spinWeightBiasCreepRefRadPerSec") or creep_config == null:
		creep_ref = DEFAULT_SPIN_BIAS_CREEP_REF_RAD_PER_SEC
	elif (creep_config is int or creep_config is float) and is_finite(float(creep_config)) and float(creep_config) > 1e-6:
		creep_ref = float(creep_config)
	else:
		creep_ref = NAN
	if is_finite(creep_ref) and creep_ref > 1e-6:
		var absolute_omega := absf(omega)
		if absolute_omega < creep_ref:
			bias_accel *= clamp(absolute_omega / creep_ref, 0.0, 1.0)

	omega += (alpha - k * omega + bias_accel) * dt

	var dry_config: Variant = instance.get("spinDryFrictionAccelRadPerSec2")
	var dry := maxf(0.0, float(dry_config)) if (dry_config is int or dry_config is float) and is_finite(float(dry_config)) else DEFAULT_SPIN_DRY_FRICTION_ACCEL_RAD_PER_SEC2
	if instance.has("spinDryFrictionAccelRadPerSec2") and dry_config != null and (dry_config is int or dry_config is float) and float(dry_config) <= 0.0:
		dry = 0.0

	if dry > 1e-11 and absf(omega) > 1e-24:
		var sign_value := signf(omega)
		var decrement := dry * dt
		if absf(omega) <= decrement:
			omega = 0.0
		else:
			omega -= sign_value * decrement

	phi_geom = normalize_angle(phi_geom + omega * dt)
	return {"omega": omega, "alpha": alpha, "phiGeom": phi_geom}


static func spin_drag_effective_k(omega: float, instance: Dictionary) -> float:
	var base := maxf(0.0, finite_or(instance.get("spinLinearDragPerSec"), 0.58))
	var floor_value := 0.035
	var threshold := finite_or(instance.get("spinDragLowSpeedThresholdRadPerSec"), 0.0)
	var boost := maxf(0.0, finite_or(instance.get("spinDragLowSpeedBoostPerSec"), 0.0))
	if threshold <= 1e-6 or boost <= 1e-6:
		return maxf(floor_value, base)
	var absolute_omega := absf(omega)
	var raw_t: float = clamp(1.0 - absolute_omega / threshold, 0.0, 1.0)
	var blend: float = raw_t * raw_t * raw_t * (raw_t * (raw_t * 6.0 - 15.0) + 10.0)
	return maxf(floor_value, base + boost * blend)


static func simulate_sugar_wheel_landing(instance: Dictionary, rng: Callable, options: Dictionary = {}) -> int:
	var layout := sector_layout_from_instance(instance)
	if int(layout.n) <= 0:
		return 0

	var initial_phi: float = normalize_angle(float(options.get("initialPhiRad"))) if options.has("initialPhiRad") else normalize_angle(float(rng.call()) * TAU)
	var power: float = clamp(float(options.get("power")), 0.0, 1.0) if options.has("power") else clamp(float(rng.call()), 0.0, 1.0)

	var sign_value: float = -1.0 if instance.get("sectorDirection") == "counterclockwise" else 1.0
	var omega: float = sign_value * lerp(
		finite_or(instance.get("spinChargeMinVelocityRadPerSec"), 0.0),
		finite_or(instance.get("spinChargeMaxVelocityRadPerSec"), 11.0),
		power,
	)
	var alpha: float = sign_value * lerp(
		finite_or(instance.get("spinChargeMinAccelRadPerSec2"), 0.0),
		finite_or(instance.get("spinChargeMaxAccelRadPerSec2"), 9.0),
		power,
	)

	var phi: float = initial_phi
	var settle_accum := 0.0
	var dt := 0.05
	var max_steps: Variant = options.get("maxSteps")
	if max_steps == null:
		max_steps = 400000
	var stop_epsilon := maxf(1e-3, finite_or(instance.get("spinStopSpeedRadPerSec"), 0.06))
	var settle_need := maxf(0.0, finite_or(instance.get("spinStopSettleSec"), 0.085))

	var index := 0
	while index < float(max_steps):
		var output := advance_sugar_wheel_spin_step({
			"instance": instance,
			"omega": omega,
			"alpha": alpha,
			"phiGeom": phi,
			"dt": dt,
		})
		omega = output.omega
		alpha = output.alpha
		phi = output.phiGeom

		if absf(omega) < stop_epsilon:
			settle_accum += dt
			if settle_accum >= settle_need:
				return sector_index_from_wheel_geom_angle(phi, layout)
		else:
			settle_accum = 0.0
		index += 1

	return sector_index_from_wheel_geom_angle(phi, layout)
