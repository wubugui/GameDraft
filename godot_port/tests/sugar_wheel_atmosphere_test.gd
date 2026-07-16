extends Node

var speeches: Array[Dictionary] = []
var angle := 0.0
var current_instance: Dictionary = {}
var rng_values: Array[float] = []
var rng_calls := 0


func _ready() -> void:
	var sectors: Array = []
	for index: int in 12:
		sectors.push_back({"id": "dragon" if index == 3 else "s%d" % index, "label": str(index)})
	var group := {
		"id": "g",
		"weight": 1,
		"vars": {"start": ["开场"], "spin": ["旋转"]},
		"start": [
			{"op": "say", "role": "a", "pool": "start"},
			{"op": "wait", "sec": 0.4},
			{"op": "say", "role": "b", "text": "接句"},
		],
		"spinning": [
			{"op": "say", "role": "c", "pool": "spin"},
			{"op": "wait", "sec": 1.0},
			{"op": "say", "role": "late", "text": "不应播到"},
		],
		"slowing": [{
			"op": "when_near_sector",
			"sectorId": "dragon",
			"degBuffer": 20,
			"then": [{"op": "say", "role": "near", "text": "龙"}],
			"else": [{"op": "say", "role": "far", "text": "别处"}],
		}],
		"stop": [{"op": "say", "text": "停"}],
	}
	current_instance = {"id": "atmos", "sectors": sectors, "atmosphereGroups": [group]}
	var host := {
		"showSpeech": Callable(self, "_show_speech"),
		"getWheelGeomAngleMod": Callable(self, "_get_angle"),
		"getSpinOmega": func() -> float: return 0.0,
		"getInstance": Callable(self, "_get_instance"),
	}
	var scheduler := RuntimeSugarWheelAtmosphereScheduler.new(host)

	# selectGroup keeps the selected source group, shallow-spreads vars, composes
	# core/custom registries, and initializes the exact source phase state.
	scheduler.select_group(current_instance)
	assert(is_same(scheduler.group, group))
	assert(scheduler.ctx is Dictionary and not is_same(scheduler.ctx.vars, group.vars))
	assert(is_same(scheduler.ctx.vars.start, group.vars.start))
	assert(scheduler.runner != null and scheduler.current_phase == null and scheduler.pending_phase == null)

	# spinning cannot preempt a running start script. It is queued exactly once,
	# then starts immediately after start finishes; slowing still preempts spinning.
	scheduler.notify_phase("start")
	assert(speeches.map(func(value: Dictionary) -> String: return value.text) == ["开场"])
	scheduler.notify_phase("spinning")
	assert(scheduler.pending_phase == "spinning" and scheduler.current_phase == "start")
	scheduler.notify_phase("spinning")
	assert(scheduler.pending_phase == "spinning")
	scheduler.tick(0.2)
	assert(speeches.size() == 1 and scheduler.pending_phase == "spinning")
	scheduler.tick(0.2)
	assert(speeches.map(func(value: Dictionary) -> String: return value.text) == ["开场", "接句", "旋转"])
	assert(scheduler.current_phase == "spinning" and scheduler.pending_phase == null and scheduler.runner.is_running())
	scheduler.notify_phase("spinning")
	assert(speeches.size() == 3)
	angle = (3.0 + 0.5) * RuntimeSugarWheelSpinPhysics.TAU / 12.0
	scheduler.notify_phase("slowing")
	assert(speeches[-1] == {"role": "near", "text": "龙", "duration": null})
	scheduler.tick(2.0)
	assert(not speeches.any(func(value: Dictionary) -> bool: return value.text == "不应播到"))

	# Re-select cancels the old runner. Missing groups clear only group and retain
	# the cancelled runner/context objects, exactly as the source early return does.
	var old_runner := scheduler.runner
	var old_context: Variant = scheduler.ctx
	var no_groups := current_instance.duplicate(false)
	no_groups.erase("atmosphereGroups")
	scheduler.select_group(no_groups)
	assert(scheduler.group == null and is_same(scheduler.runner, old_runner) and is_same(scheduler.ctx, old_context))
	assert(not scheduler.runner.is_running() and scheduler.current_phase == null and scheduler.pending_phase == null)

	# Far/near branches, unknown sector and negative buffer all follow the custom
	# opcode's exact child-block and default semantics.
	speeches.clear()
	scheduler.select_group(current_instance)
	angle = 0.0
	scheduler.notify_phase("slowing")
	assert(speeches[-1].role == "far" and speeches[-1].text == "别处")
	var registry := RuntimeSugarWheelAtmosphereScheduler._sugar_wheel_opcodes(host)
	var children := func(steps: Array) -> Dictionary: return {"__children": steps.duplicate(false)}
	var near_handler: Callable = registry.when_near_sector
	assert(near_handler.call({"op": "when_near_sector", "sectorId": "missing", "then": [{"op": "say", "text": "X"}]}, scheduler.ctx, children) == null)
	angle = (3.0 + 0.5) * RuntimeSugarWheelSpinPhysics.TAU / 12.0
	var exact_branch: Variant = near_handler.call({"op": "when_near_sector", "sectorId": "dragon", "degBuffer": -5, "then": [{"op": "say", "text": "exact"}]}, scheduler.ctx, children)
	assert(exact_branch is Dictionary and exact_branch.__children[0].text == "exact")

	# say uses text > pool > slot fallback, preserves explicit role/duration, and
	# consumes RNG only for a non-empty selected pool.
	var say_handler: Callable = registry.say
	var opcode_context := {"rng": Callable(self, "_sequence_rng"), "vars": {"pool": ["池一", "池二"], "empty": []}, "slots": {"_line": "槽默认", "named": "槽命名"}}
	rng_values = [0.75]; rng_calls = 0
	speeches.clear()
	say_handler.call({"op": "say", "role": "r", "text": "直给", "pool": "pool", "durationMs": 123}, opcode_context, children)
	say_handler.call({"op": "say", "pool": "pool"}, opcode_context, children)
	say_handler.call({"op": "say", "pool": "empty", "slot": "named"}, opcode_context, children)
	say_handler.call({"op": "say"}, opcode_context, children)
	assert(speeches == [
		{"role": "r", "text": "直给", "duration": 123},
		{"role": "child_a", "text": "池二", "duration": null},
		{"role": "child_a", "text": "槽命名", "duration": null},
		{"role": "child_a", "text": "槽默认", "duration": null},
	])
	assert(rng_calls == 1)

	# weightedPick evaluates weights in source order, skips RNG for non-positive
	# totals, and otherwise subtracts until the first <= 0 boundary.
	var items := [{"id": "a", "weight": 0.0}, {"id": "b", "weight": 0.0}]
	rng_calls = 0
	var picked_zero: Variant = RuntimeSugarWheelAtmosphereScheduler._weighted_pick(items, func(value: Dictionary) -> float: return value.weight, Callable(self, "_sequence_rng"))
	assert(is_same(picked_zero, items[0]) and rng_calls == 0)
	items[0].weight = 1.0; items[1].weight = 3.0
	rng_values = [0.75]; rng_calls = 0
	var picked_weighted: Variant = RuntimeSugarWheelAtmosphereScheduler._weighted_pick(items, func(value: Dictionary) -> float: return value.weight, Callable(self, "_sequence_rng"))
	assert(is_same(picked_weighted, items[1]) and rng_calls == 1)

	# DeterministicRandom is the shared translated module, not scheduler-owned RNG
	# state. Re-selecting the same id reproduces group/pool selection exactly.
	var deterministic_instance := current_instance.duplicate(true)
	deterministic_instance.id = "转盘_生肖"
	deterministic_instance.atmosphereGroups[0].vars.start = ["甲", "乙", "丙"]
	current_instance = deterministic_instance
	speeches.clear()
	var deterministic := RuntimeSugarWheelAtmosphereScheduler.new(host)
	deterministic.select_group(deterministic_instance)
	deterministic.notify_phase("start")
	assert(speeches[0].text == "乙")
	speeches.clear()
	deterministic.select_group(deterministic_instance)
	deterministic.notify_phase("start")
	assert(speeches[0].text == "乙")

	assert(RuntimeSugarWheelAtmosphereScheduler.resolve_atmosphere_phase("idle", 9.0) == null)
	assert(RuntimeSugarWheelAtmosphereScheduler.resolve_atmosphere_phase("spinning", 2.500001) == "spinning")
	assert(RuntimeSugarWheelAtmosphereScheduler.resolve_atmosphere_phase("spinning", 2.5) == "slowing")
	scheduler.cancel(); deterministic.cancel()
	assert(scheduler.current_phase == null and scheduler.pending_phase == null and not scheduler.runner.is_running())
	print("SugarWheel atmosphere direct opcode/RNG/phase/pending/branch contract test: PASS")
	get_tree().quit(0)


func _show_speech(role: String, text: String, duration: Variant = null) -> void:
	speeches.push_back({"role": role, "text": text, "duration": duration})


func _get_angle() -> float:
	return angle


func _get_instance() -> Dictionary:
	return current_instance


func _sequence_rng() -> float:
	var value := rng_values[rng_calls] if rng_calls < rng_values.size() else 0.0
	rng_calls += 1
	return value
