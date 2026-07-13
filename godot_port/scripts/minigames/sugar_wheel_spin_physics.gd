class_name RuntimeSugarWheelSpinPhysics
extends RefCounted

const TAU := PI * 2.0
const DEFAULT_SPIN_WEIGHT_BIAS_STRENGTH_RAD_PER_S2 := 4.2
const MIN_SPIN_TERRAIN_WEIGHT := 0.05
const DEFAULT_SPIN_DRY_FRICTION_ACCEL_RAD_PER_SEC2 := 0.34
const DEFAULT_SPIN_BIAS_CREEP_REF_RAD_PER_SEC := 1.2


static func finite_or(value: Variant, fallback: float) -> float:
	return float(value) if (value is int or value is float) and is_finite(float(value)) else fallback


static func normalize_angle(value: float) -> float:
	return fposmod(value, TAU)


static func deg_to_rad(value: float) -> float:
	return value / 180.0 * PI


static func sector_layout(instance: Dictionary) -> Dictionary:
	var sectors: Variant = instance.get("sectors")
	var count: int = sectors.size() if sectors is Array else 0
	if count <= 0: return {"n": 0, "step": TAU, "left0": 0.0}
	var step: float = TAU / count
	var offset := deg_to_rad(finite_or(instance.get("sectorAngleOffsetDeg"), 0.0))
	var phase := finite_or(instance.get("sectorCenterPhase"), 0.0)
	return {"n": count, "step": step, "left0": offset + phase * step}


static func sector_index(geom_mod: float, layout: Dictionary) -> int:
	var count := int(layout.get("n", 0))
	if count <= 0: return 0
	var rel := normalize_angle(geom_mod - float(layout.left0))
	return posmod(int(floor(rel / float(layout.step) + 1e-9)), count)


static func spin_weight_bias_scale(instance: Dictionary) -> float:
	var configured: Variant = instance.get("spinWeightBiasStrengthRadPerSec2")
	return float(configured) if (configured is int or configured is float) and is_finite(float(configured)) and float(configured) > 0 else DEFAULT_SPIN_WEIGHT_BIAS_STRENGTH_RAD_PER_S2


static func weight_terrain_components(phi: float, instance: Dictionary) -> Dictionary:
	var sectors: Variant = instance.get("sectors")
	var layout := sector_layout(instance); var count := int(layout.n)
	if count <= 0 or not sectors is Array: return {"sinSum": 0.0, "cosSum": 0.0}
	var sin_sum := 0.0; var cos_sum := 0.0
	for index: int in count:
		var sector: Variant = sectors[index] if index < sectors.size() else null
		var raw_weight: Variant = sector.get("weight") if sector is Dictionary else null
		var weight := float(raw_weight) if (raw_weight is int or raw_weight is float) and is_finite(float(raw_weight)) and float(raw_weight) >= 0 else 1.0
		var height := -log(maxf(MIN_SPIN_TERRAIN_WEIGHT, weight))
		var center := float(layout.left0) + (index + 0.5) * float(layout.step)
		var difference := phi - center
		sin_sum += height * sin(difference); cos_sum += height * cos(difference)
	return {"sinSum": sin_sum, "cosSum": cos_sum}


static func weight_terrain_potential(phi: float, instance: Dictionary) -> float:
	return spin_weight_bias_scale(instance) * float(weight_terrain_components(phi, instance).cosSum)


static func weight_derived_bias_accel(phi: float, instance: Dictionary) -> float:
	return spin_weight_bias_scale(instance) * float(weight_terrain_components(phi, instance).sinSum)


static func spin_drag_effective_k(omega: float, instance: Dictionary) -> float:
	var base := maxf(0.0, finite_or(instance.get("spinLinearDragPerSec"), 0.58)); var threshold := finite_or(instance.get("spinDragLowSpeedThresholdRadPerSec"), 0.0); var boost := maxf(0.0, finite_or(instance.get("spinDragLowSpeedBoostPerSec"), 0.0))
	if threshold <= 1e-6 or boost <= 1e-6: return maxf(0.035, base)
	var raw_t := clampf(1.0 - absf(omega) / threshold, 0.0, 1.0)
	var blend := raw_t * raw_t * raw_t * (raw_t * (raw_t * 6.0 - 15.0) + 10.0)
	return maxf(0.035, base + boost * blend)


static func advance_step(instance: Dictionary, omega_value: float, alpha_value: float, phi_value: float, dt_value: float) -> Dictionary:
	var dt := clampf(dt_value, 0.0, 0.05); var omega := omega_value; var alpha := alpha_value; var phi := phi_value
	var half_life := finite_or(instance.get("spinAccelHalfLifeSec"), 0.42)
	alpha = alpha * pow(0.5, dt / half_life) if half_life > 1e-5 else 0.0
	var bias := weight_derived_bias_accel(phi, instance)
	var creep_cfg: Variant = instance.get("spinWeightBiasCreepRefRadPerSec")
	var creep_ref := DEFAULT_SPIN_BIAS_CREEP_REF_RAD_PER_SEC if creep_cfg == null else (float(creep_cfg) if (creep_cfg is int or creep_cfg is float) and is_finite(float(creep_cfg)) and float(creep_cfg) > 1e-6 else NAN)
	if is_finite(creep_ref) and absf(omega) < creep_ref: bias *= clampf(absf(omega) / creep_ref, 0.0, 1.0)
	omega += (alpha - spin_drag_effective_k(omega, instance) * omega + bias) * dt
	var dry_cfg: Variant = instance.get("spinDryFrictionAccelRadPerSec2")
	var dry := maxf(0.0, float(dry_cfg)) if (dry_cfg is int or dry_cfg is float) and is_finite(float(dry_cfg)) else DEFAULT_SPIN_DRY_FRICTION_ACCEL_RAD_PER_SEC2
	if dry_cfg != null and (dry_cfg is int or dry_cfg is float) and float(dry_cfg) <= 0: dry = 0.0
	if dry > 1e-11 and absf(omega) > 1e-24:
		var decrement := dry * dt
		omega = 0.0 if absf(omega) <= decrement else omega - signf(omega) * decrement
	phi = normalize_angle(phi + omega * dt)
	return {"omega": omega, "alpha": alpha, "phiGeom": phi}


static func simulate_landing(instance: Dictionary, power_value: float, initial_phi: float, max_steps: int = 400000) -> int:
	var layout := sector_layout(instance)
	if int(layout.n) <= 0: return 0
	var power := clampf(power_value, 0.0, 1.0); var sign_value := -1.0 if instance.get("sectorDirection") == "counterclockwise" else 1.0
	var omega := sign_value * lerpf(finite_or(instance.get("spinChargeMinVelocityRadPerSec"), 0.0), finite_or(instance.get("spinChargeMaxVelocityRadPerSec"), 11.0), power)
	var alpha := sign_value * lerpf(finite_or(instance.get("spinChargeMinAccelRadPerSec2"), 0.0), finite_or(instance.get("spinChargeMaxAccelRadPerSec2"), 9.0), power)
	var phi := normalize_angle(initial_phi); var settle := 0.0; var stop_epsilon := maxf(1e-3, finite_or(instance.get("spinStopSpeedRadPerSec"), 0.06)); var settle_need := maxf(0.0, finite_or(instance.get("spinStopSettleSec"), 0.085))
	for _index: int in max_steps:
		var output := advance_step(instance, omega, alpha, phi, 0.05); omega = output.omega; alpha = output.alpha; phi = output.phiGeom
		if absf(omega) < stop_epsilon:
			settle += 0.05
			if settle >= settle_need: return sector_index(phi, layout)
		else: settle = 0.0
	return sector_index(phi, layout)
