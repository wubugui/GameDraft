class_name RuntimeSugarWheelAtmosphereScheduler
extends RefCounted

const SLOWING_OMEGA_THRESHOLD := 2.5

var group: Variant = null
var runner: RuntimeMinigameScriptRunner = null
var ctx: Variant = null
var current_phase: Variant = null
var pending_phase: Variant = null
var host: Dictionary
var rng: Callable = RuntimeDeterministicRandom.create_deterministic_random("")


static func _sugar_wheel_opcodes(opcode_host: Dictionary) -> Dictionary:
	return {
		"say": func(step: Dictionary, opcode_ctx: Dictionary, _run_children: Callable) -> void:
			var raw_role: Variant = step.get("role")
			var role := str(raw_role) if raw_role != null else "child_a"
			var raw_text: Variant = step.get("text")
			var text := str(raw_text) if raw_text != null else ""
			var raw_pool: Variant = step.get("pool")
			if text.is_empty() and raw_pool != null and not str(raw_pool).is_empty():
				var values: Variant = opcode_ctx.vars.get(str(raw_pool))
				if values is Array and not values.is_empty():
					var random: Callable = opcode_ctx.rng
					text = str(values[int(floor(float(random.call()) * values.size()))])
			if text.is_empty():
				var raw_slot: Variant = step.get("slot")
				var slot := str(raw_slot) if raw_slot != null else "_line"
				var slot_text: Variant = opcode_ctx.slots.get(slot)
				text = str(slot_text) if slot_text != null else ""
			if not text.is_empty():
				var show_speech: Callable = opcode_host.showSpeech
				show_speech.call(role, text, step.get("durationMs")),

		"when_near_sector": func(step: Dictionary, _opcode_ctx: Dictionary, run_children: Callable) -> Variant:
			var raw_sector_id: Variant = step.get("sectorId")
			var sector_id := str(raw_sector_id) if raw_sector_id != null else ""
			var raw_buffer: Variant = step.get("degBuffer")
			var buffer_degrees := maxf(0.0, float(raw_buffer) if raw_buffer != null else 15.0)
			var get_instance: Callable = opcode_host.getInstance
			var instance: Dictionary = get_instance.call()
			var layout := RuntimeSugarWheelSpinPhysics.sector_layout_from_instance(instance)
			var sector_index := -1
			for index: int in instance.sectors.size():
				if instance.sectors[index].id == sector_id:
					sector_index = index
					break
			if sector_index < 0:
				return null

			var center := float(layout.left0) + (sector_index + 0.5) * float(layout.step)
			var get_angle: Callable = opcode_host.getWheelGeomAngleMod
			var phi: float = get_angle.call()
			var difference := phi - center
			# JavaScript Math.round(x) is floor(x + 0.5), including negative halves.
			difference = difference - floor(difference / RuntimeSugarWheelSpinPhysics.TAU + 0.5) * RuntimeSugarWheelSpinPhysics.TAU
			var in_range := absf(difference) * (180.0 / PI) <= buffer_degrees

			var then_steps: Variant = step.get("then")
			if in_range and then_steps is Array and not then_steps.is_empty():
				return run_children.call(then_steps)
			var else_steps: Variant = step.get("else")
			if not in_range and else_steps is Array and not else_steps.is_empty():
				return run_children.call(else_steps)
			return null,
	}


func _init(initial_host: Dictionary) -> void:
	host = initial_host


func select_group(instance: Dictionary) -> void:
	cancel()
	var groups: Variant = instance.get("atmosphereGroups")
	if not groups is Array or groups.is_empty():
		group = null
		return
	rng = RuntimeDeterministicRandom.create_deterministic_random(str(instance.id))
	group = _weighted_pick(groups, func(value: Variant) -> float:
		var raw_weight: Variant = value.get("weight")
		return maxf(0.0, float(raw_weight) if raw_weight != null else 1.0)
	, rng)
	var raw_vars: Variant = group.get("vars") if group is Dictionary else null
	ctx = {
		"rng": rng,
		"vars": raw_vars.duplicate(false) if raw_vars is Dictionary else {},
		"slots": {},
	}
	var registry := RuntimeMinigameScriptRunner.core_opcodes()
	registry.merge(_sugar_wheel_opcodes(host), true)
	runner = RuntimeMinigameScriptRunner.new(registry, ctx)
	current_phase = null


func notify_phase(phase: String) -> void:
	if phase == current_phase:
		return
	if phase == "spinning" and current_phase == "start" and runner != null and runner.is_running():
		pending_phase = "spinning"
		return
	pending_phase = null
	_start_phase(phase)


func tick(dt: float) -> void:
	if runner != null:
		runner.tick(dt)
	if pending_phase != null and runner != null and not runner.is_running():
		var next: String = pending_phase
		pending_phase = null
		_start_phase(next)


func cancel() -> void:
	if runner != null:
		runner.cancel()
	current_phase = null
	pending_phase = null


func _start_phase(phase: String) -> void:
	current_phase = phase
	if not group is Dictionary or runner == null:
		return
	var steps: Variant = group.get(phase)
	if steps is Array and not steps.is_empty():
		runner.run_phase(steps)


static func resolve_atmosphere_phase(scene_phase: String, absolute_omega: float) -> Variant:
	if scene_phase != "spinning":
		return null
	if absolute_omega > SLOWING_OMEGA_THRESHOLD:
		return "spinning"
	return "slowing"


static func _weighted_pick(items: Array, weight_fn: Callable, random: Callable) -> Variant:
	var total := 0.0
	for item: Variant in items:
		total += float(weight_fn.call(item))
	if total <= 0.0:
		return items[0]
	var remaining := float(random.call()) * total
	for item: Variant in items:
		remaining -= float(weight_fn.call(item))
		if remaining <= 0.0:
			return item
	return items[-1]
