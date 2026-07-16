extends SceneTree


func _init() -> void:
	var progress := RuntimeHoldProgress.new({"startRatio": 0.0, "stopRatio": 0.6, "fillSeconds": 2.0, "decayPerSecond": 0.5})
	progress.tick(1.0, true)
	assert(is_equal_approx(progress.current, 0.5))
	assert(not progress.reached_stop)
	progress.tick(1.0, true)
	assert(is_equal_approx(progress.current, 0.6))
	assert(progress.reached_stop)
	progress.tick(1.0, false)
	assert(is_equal_approx(progress.current, 0.6))

	var decay := RuntimeHoldProgress.new({"startRatio": 0.0, "stopRatio": 1.0, "fillSeconds": 2.0, "decayPerSecond": 0.4})
	decay.tick(1.0, true)
	decay.tick(0.5, false)
	assert(is_equal_approx(decay.current, 0.3))
	decay.tick(10.0, false)
	assert(decay.current == 0.0)
	decay.tick(NAN, true)
	decay.tick(-1.0, true)
	assert(decay.current == 0.0)

	assert(RuntimeHoldProgress.validate_interrupt_ratios([0.9, 0.6]) == [0.6, 0.9])
	assert(RuntimeHoldProgress.validate_interrupt_ratios([0.0]) == null)
	assert(RuntimeHoldProgress.validate_interrupt_ratios([1.0]) == null)
	assert(RuntimeHoldProgress.validate_interrupt_ratios([0.5, 0.5]) == null)
	assert(RuntimeHoldProgress.clamp01(-1.0) == 0.0)
	assert(RuntimeHoldProgress.clamp01(2.0) == 1.0)
	assert(RuntimeHoldProgress.clamp01(NAN) == 0.0)
	assert(is_equal_approx(RuntimeHoldProgress.clamp01(0.4), 0.4))
	assert(RuntimeHoldProgress.validate_interrupt_chain([
		{"atRatio": 0.6, "resetToRatio": 0.2},
		{"atRatio": 0.9, "resetToRatio": 0.4},
	]))
	assert(not RuntimeHoldProgress.validate_interrupt_chain([{"atRatio": 0.6, "resetToRatio": 1.0}]))
	assert(RuntimeHoldProgress.validate_interrupt_chain([{"atRatio": 0.6, "resetToRatio": 1.0, "abort": true}]))

	print("HoldProgress fill/decay/stop/validation direct-translation test: PASS")
	quit(0)
