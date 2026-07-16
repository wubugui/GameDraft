class_name RuntimeHoldProgress
extends RefCounted

var ratio: float
var cfg: Dictionary

var current: float:
	get:
		return ratio

var reached_stop: bool:
	get:
		return ratio >= float(cfg.stopRatio)


func _init(next_cfg: Dictionary) -> void:
	assert(float(next_cfg.get("fillSeconds", 0.0)) > 0.0, "HoldProgress: fillSeconds 必须为正数")
	assert(float(next_cfg.get("stopRatio", 0.0)) > float(next_cfg.get("startRatio", 0.0)), "HoldProgress: stopRatio 必须大于 startRatio")
	cfg = next_cfg
	ratio = clamp01(float(next_cfg.startRatio))


func tick(dt_seconds: float, holding: bool) -> float:
	if dt_seconds < 0.0 or not is_finite(dt_seconds):
		return ratio
	if reached_stop:
		return ratio
	if holding:
		ratio = minf(float(cfg.stopRatio), ratio + dt_seconds / float(cfg.fillSeconds))
	else:
		ratio = maxf(0.0, ratio - dt_seconds * float(cfg.decayPerSecond))
	return ratio


static func clamp01(value: float) -> float:
	if not is_finite(value):
		return 0.0
	return minf(1.0, maxf(0.0, value))


static func validate_interrupt_ratios(ratios: Array) -> Variant:
	var sorted := ratios.duplicate()
	sorted.sort_custom(func(a: Variant, b: Variant) -> bool: return float(a) < float(b))
	for raw_ratio: Variant in sorted:
		if not _is_finite_number(raw_ratio):
			return null
		var interrupt_ratio := float(raw_ratio)
		if not (interrupt_ratio > 0.0 and interrupt_ratio < 1.0):
			return null
	for index: int in range(1, sorted.size()):
		if float(sorted[index]) == float(sorted[index - 1]):
			return null
	return sorted


static func validate_interrupt_chain(interrupts: Array) -> bool:
	var sorted := interrupts.duplicate(true)
	sorted.sort_custom(func(a: Variant, b: Variant) -> bool: return float(a.get("atRatio", 0.0)) < float(b.get("atRatio", 0.0)))
	var ratios: Array = []
	for interrupt: Variant in sorted:
		if not interrupt is Dictionary:
			return false
		ratios.push_back(interrupt.get("atRatio"))
	if validate_interrupt_ratios(ratios) == null:
		return false
	for index: int in sorted.size():
		var current_interrupt: Dictionary = sorted[index]
		if current_interrupt.get("abort") == true:
			continue
		var reset := clamp01(float(current_interrupt.get("resetToRatio", 0.0)))
		var next_stop := float(sorted[index + 1].atRatio) if index + 1 < sorted.size() else 1.0
		if not reset < next_stop:
			return false
	return true


static func _is_finite_number(value: Variant) -> bool:
	return (value is int or value is float) and is_finite(float(value))
