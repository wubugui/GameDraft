class_name RuntimeSugarWheelAtmosphereScheduler
extends RefCounted

const SLOWING_OMEGA_THRESHOLD := 2.5

var host: Dictionary
var group: Variant = null
var runner: RuntimeMinigameScriptRunner
var context: Dictionary = {}
var current_phase: Variant = null
var pending_phase: Variant = null
var _rng := Callable()
var _injected_rng := Callable()
var _random_state := 1


func _init(next_host: Dictionary, rng: Callable = Callable()) -> void:
	host = next_host; _injected_rng = rng if not rng.is_null() and rng.is_valid() else Callable()


func select_group(instance: Dictionary) -> void:
	cancel(); var groups: Variant = instance.get("atmosphereGroups")
	if not groups is Array or groups.is_empty(): group = null; return
	if not _injected_rng.is_null() and _injected_rng.is_valid(): _rng = _injected_rng
	else: _seed_random(str(instance.get("id", ""))); _rng = Callable(self, "_next_random")
	group = _weighted_pick(groups)
	context = {"rng": _rng, "vars": group.get("vars", {}).duplicate(true) if group.get("vars") is Dictionary else {}, "slots": {}}
	runner = RuntimeMinigameScriptRunner.new({"say": Callable(self, "_say"), "when_near_sector": Callable(self, "_when_near_sector")}, context)


func notify_phase(phase: String) -> void:
	if phase == current_phase: return
	if phase == "spinning" and current_phase == "start" and runner != null and runner.is_running(): pending_phase = "spinning"; return
	pending_phase = null; _start_phase(phase)


func tick(dt: float) -> void:
	if runner != null: runner.tick(dt)
	if pending_phase != null and runner != null and not runner.is_running():
		var next := str(pending_phase); pending_phase = null; _start_phase(next)


func cancel() -> void:
	if runner != null: runner.cancel()
	current_phase = null; pending_phase = null


func _start_phase(phase: String) -> void:
	current_phase = phase
	if not group is Dictionary or runner == null: return
	var steps: Variant = group.get(phase)
	if steps is Array and not steps.is_empty(): runner.run_phase(steps)


func _say(step: Dictionary, ctx: Dictionary, _children: Callable) -> Variant:
	var role := str(step.get("role", "child_a")); var text := str(step.get("text", ""))
	if text.is_empty() and not str(step.get("pool", "")).is_empty():
		var values: Variant = ctx.vars.get(str(step.pool)); text = _pick_text(values)
	if text.is_empty(): text = str(ctx.slots.get(str(step.get("slot", "_line")), ""))
	var show: Variant = host.get("showSpeech")
	if not text.is_empty() and show is Callable and show.is_valid(): show.call(role, text, step.get("durationMs"))
	return null


func _when_near_sector(step: Dictionary, _ctx: Dictionary, children: Callable) -> Variant:
	var get_instance: Variant = host.get("getInstance"); var get_angle: Variant = host.get("getWheelGeomAngleMod")
	if not get_instance is Callable or not get_instance.is_valid() or not get_angle is Callable or not get_angle.is_valid(): return null
	var instance: Variant = get_instance.call()
	if not instance is Dictionary or not instance.get("sectors") is Array: return null
	var sector_index := -1
	for index: int in instance.sectors.size():
		if instance.sectors[index] is Dictionary and str(instance.sectors[index].get("id", "")) == str(step.get("sectorId", "")): sector_index = index; break
	if sector_index < 0: return null
	var layout := RuntimeSugarWheelSpinPhysics.sector_layout(instance); var center := float(layout.left0) + (sector_index + 0.5) * float(layout.step); var difference := float(get_angle.call()) - center; difference -= round(difference / RuntimeSugarWheelSpinPhysics.TAU) * RuntimeSugarWheelSpinPhysics.TAU
	var in_range := absf(difference) * 180.0 / PI <= maxf(0.0, float(step.get("degBuffer", 15)))
	var branch: Variant = step.get("then") if in_range else step.get("else")
	return children.call(branch) if branch is Array and not branch.is_empty() else null


func _weighted_pick(groups: Array) -> Variant:
	var total := 0.0
	for value: Variant in groups: if value is Dictionary: total += maxf(0.0, float(value.get("weight", 1)))
	if total <= 0: return groups[0]
	var remaining := float(_rng.call()) * total
	for value: Variant in groups:
		if not value is Dictionary: continue
		remaining -= maxf(0.0, float(value.get("weight", 1)))
		if remaining <= 0: return value
	return groups[-1]


func _pick_text(values: Variant) -> String:
	if not values is Array or values.is_empty(): return ""
	return str(values[clampi(int(floor(float(_rng.call()) * values.size())), 0, values.size() - 1)])


func _seed_random(id: String) -> void:
	var hash := 0x811c9dc5
	for byte: int in id.to_utf8_buffer(): hash = ((hash ^ byte) * 0x01000193) & 0xffffffff
	_random_state = hash if hash != 0 else 1


func _next_random() -> float:
	var x: int = _random_state & 0xffffffff
	x = (x ^ ((x << 13) & 0xffffffff)) & 0xffffffff
	x = (x ^ (x >> 17)) & 0xffffffff
	x = (x ^ ((x << 5) & 0xffffffff)) & 0xffffffff
	_random_state = x
	return float(x) / 4294967296.0


static func resolve_atmosphere_phase(scene_phase: String, abs_omega: float) -> Variant:
	if scene_phase != "spinning": return null
	return "spinning" if abs_omega > SLOWING_OMEGA_THRESHOLD else "slowing"
