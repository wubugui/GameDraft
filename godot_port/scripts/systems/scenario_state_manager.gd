class_name RuntimeScenarioStateManager
extends RuntimeSystem

const SCENARIO_STATUS_SUGGESTED := ["pending", "active", "done", "locked"]

var _by_scenario: Dictionary = {}
var _line_lifecycle_by_scenario: Dictionary = {}
var _manual_lifecycle_scenario_ids: Dictionary = {}
var _flag_store: RuntimeFlagStore
var _catalog: Array = []
var _event_bus: RuntimeEventBus


func configure_runtime(
	flag_store: RuntimeFlagStore,
	catalog_file: Variant,
	event_bus: RuntimeEventBus = null,
) -> void:
	_flag_store = flag_store
	_catalog = catalog_file.scenarios.duplicate(true) if (
		catalog_file is Dictionary and catalog_file.get("scenarios") is Array
	) else []
	_event_bus = event_bus
	var manual_ids := {}
	for entry: Variant in _catalog:
		if not entry is Dictionary:
			continue
		var id := str(entry.get("id", "")).strip_edges()
		if not id.is_empty() and entry.get("manualLineLifecycle") == true:
			manual_ids[id] = true
	_manual_lifecycle_scenario_ids = manual_ids


func get_catalog_scenario_ids() -> Array[String]:
	var result: Array[String] = []
	for entry: Variant in _catalog:
		if not entry is Dictionary:
			continue
		var id := str(entry.get("id", "")).strip_edges()
		if not id.is_empty():
			result.push_back(id)
	return result


func has_manual_line_lifecycle(scenario_id: String) -> bool:
	return _uses_manual_line_lifecycle(scenario_id.strip_edges())


func init(_ctx: Dictionary) -> void:
	return


func assert_scenario_line_entry_for_action(scenario_id: String) -> bool:
	return _assert_scenario_line_entry_met_or_throw(scenario_id.strip_edges())


func update(_dt: float) -> void:
	return


func destroy() -> void:
	_by_scenario.clear()
	_line_lifecycle_by_scenario.clear()
	_catalog.clear()
	_manual_lifecycle_scenario_ids.clear()
	_flag_store = null
	_event_bus = null


func reset_scenario_progress_for_debug(scenario_id: String) -> void:
	var sid := scenario_id.strip_edges()
	if sid.is_empty():
		return
	_line_lifecycle_by_scenario.erase(sid)
	_by_scenario.erase(sid)


func debug_set_scenario_line_lifecycle(scenario_id: String, state: String) -> void:
	var sid := scenario_id.strip_edges()
	if sid.is_empty():
		return
	if state == "inactive":
		_line_lifecycle_by_scenario.erase(sid)
		return
	_line_lifecycle_by_scenario[sid] = state


func debug_set_scenario_phase(scenario_id: String, phase: String, payload: Dictionary) -> void:
	var sid := scenario_id.strip_edges()
	var ph := phase.strip_edges()
	var status := str(payload.get("status", "")).strip_edges()
	if sid.is_empty() or ph.is_empty() or status.is_empty():
		return
	var phases: Dictionary = _by_scenario.get(sid, {})
	var current: Dictionary = phases.get(ph, {"status": "pending"})
	var value := {"status": status}
	if payload.has("outcome"):
		value["outcome"] = payload.outcome
	elif current.has("outcome"):
		value["outcome"] = current.outcome
	phases[ph] = value
	_by_scenario[sid] = phases


func _is_first_write_to_scenario(scenario_id: String) -> bool:
	var phases: Variant = _by_scenario.get(scenario_id)
	return not phases is Dictionary or phases.is_empty()


func _assert_scenario_line_entry_met_or_throw(scenario_id: String) -> bool:
	if not _is_first_write_to_scenario(scenario_id):
		return true
	var entry: Variant = null
	for candidate: Variant in _catalog:
		if candidate is Dictionary and str(candidate.get("id", "")) == scenario_id:
			entry = candidate
			break
	var requires: Variant = entry.get("requires") if entry is Dictionary else null
	if requires == null or _eval_catalog_requires_met(scenario_id, requires):
		return true
	if _event_bus != null:
		_event_bus.emit("notification:show", {
			"text": "Scenario 进线 requires 未满足: scenarioId=%s requires=%s" % [JSON.stringify(scenario_id), JSON.stringify(requires)],
			"type": "error",
		})
	return false


func _uses_manual_line_lifecycle(scenario_id: String) -> bool:
	return _manual_lifecycle_scenario_ids.has(scenario_id.strip_edges())


func get_line_lifecycle_state(scenario_id: String) -> String:
	return str(_line_lifecycle_by_scenario.get(scenario_id.strip_edges(), "inactive"))


func _notify_scenario_lifecycle_error(text: String) -> void:
	if _event_bus != null:
		_event_bus.emit("notification:show", {"text": text, "type": "error"})


func _throw_lifecycle(_scenario_id: String, detail: String) -> bool:
	_notify_scenario_lifecycle_error(detail)
	return false


func activate_scenario_line(scenario_id: String) -> bool:
	var sid := scenario_id.strip_edges()
	if sid.is_empty() or not _uses_manual_line_lifecycle(sid):
		return true
	var current := get_line_lifecycle_state(sid)
	if current == "active":
		return true
	if current == "completed":
		return _throw_lifecycle(sid, "该 narrative 线已标记完成，不能再次 activateScenario")
	if not _assert_scenario_line_entry_met_or_throw(sid):
		return false
	_line_lifecycle_by_scenario[sid] = "active"
	return true


func complete_scenario_line(scenario_id: String) -> bool:
	var sid := scenario_id.strip_edges()
	if sid.is_empty() or not _uses_manual_line_lifecycle(sid):
		return true
	var current := get_line_lifecycle_state(sid)
	if current != "active":
		return _throw_lifecycle(
			sid,
			"该线已为完成状态，不能重复 completeScenario" if current == "completed" else "须先 activateScenario（线处于进行中）后才能 completeScenario",
		)
	_line_lifecycle_by_scenario[sid] = "completed"
	return true


func _eval_catalog_requires_met(scenario_id: String, raw: Variant) -> bool:
	if raw == null:
		return true
	if raw is Array:
		for child: Variant in raw:
			if not _eval_catalog_requires_met(scenario_id, child):
				return false
		return true
	if raw is String:
		var phase: String = raw.strip_edges()
		return true if phase.is_empty() else phase_status_equals(scenario_id, phase, "done")
	if raw is Dictionary:
		for key: Variant in raw:
			if key not in ["all", "any", "not"]:
				return false
		var op_count := int(raw.has("all")) + int(raw.has("any")) + int(raw.has("not"))
		if op_count != 1:
			return false
		if raw.get("all") is Array:
			for child: Variant in raw.all:
				if not _eval_catalog_requires_met(scenario_id, child):
					return false
			return true
		if raw.get("any") is Array:
			if raw.any.is_empty():
				return false
			for child: Variant in raw.any:
				if _eval_catalog_requires_met(scenario_id, child):
					return true
			return false
		if raw.has("not"):
			return not _eval_catalog_requires_met(scenario_id, raw.not)
	return false


func set_scenario_phase(scenario_id: String, phase: String, payload: Dictionary) -> bool:
	var sid := scenario_id.strip_edges()
	var ph := phase.strip_edges()
	if sid.is_empty() or ph.is_empty():
		return false
	var status := str(payload.get("status", "")).strip_edges()
	var entry: Variant = null
	for candidate: Variant in _catalog:
		if candidate is Dictionary and str(candidate.get("id", "")) == sid:
			entry = candidate
			break
	if OS.is_debug_build():
		if entry is Dictionary and entry.get("phases") is Dictionary and not entry.phases.has(ph):
			push_warning("[ScenarioStateManager] setScenarioPhase: phase \"%s\" 未出现在 scenario \"%s\" 的 scenarios.json 清单中" % [ph, sid])
		if not status.is_empty() and status not in SCENARIO_STATUS_SUGGESTED:
			push_warning("[ScenarioStateManager] setScenarioPhase: 非建议 status \"%s\"（建议 pending|active|done|locked）" % status)
	if _uses_manual_line_lifecycle(sid):
		var lifecycle := get_line_lifecycle_state(sid)
		if lifecycle != "active":
			return _throw_lifecycle(
				sid,
				"该线已完成，禁止再修改 phase（须检查 completeScenario 时机）" if lifecycle == "completed" else "须先 activateScenario 激活该线后才能 setScenarioPhase",
			)
	elif not _assert_scenario_line_entry_met_or_throw(sid):
		return false
	var raw_requires: Variant = null
	if entry is Dictionary and entry.get("phases") is Dictionary and entry.phases.get(ph) is Dictionary:
		raw_requires = entry.phases[ph].get("requires")
	if status in ["done", "active"] and not _eval_catalog_requires_met(sid, raw_requires):
		if _event_bus != null:
			_event_bus.emit("notification:show", {
				"text": "叙事阶段「%s」违反 requires 前置（详情见控制台日志）" % ph,
				"type": "error",
			})
		return false
	var phases: Dictionary = _by_scenario.get(sid, {})
	var current: Dictionary = phases.get(ph, {"status": "pending"})
	var value := {"status": status}
	if payload.has("outcome"):
		value["outcome"] = payload.outcome
	elif current.has("outcome"):
		value["outcome"] = current.outcome
	phases[ph] = value
	_by_scenario[sid] = phases
	_try_apply_exposes(sid, ph, status)
	return true


func _coerce_expose_value(key: String, raw: Variant) -> Variant:
	var value_type: Variant = _flag_store.get_registry_value_type(key.strip_edges()) if _flag_store != null else null
	if value_type == null:
		value_type = "bool"
	if raw == null:
		return null
	if value_type == "bool":
		if raw is bool:
			return raw
		if raw is int or raw is float:
			return float(raw) != 0.0 if is_finite(float(raw)) else null
		if raw is String:
			var text: String = raw.strip_edges().to_lower()
			if text in ["true", "1"]: return true
			if text in ["false", "0", ""]: return false
		return null
	if value_type == "float":
		if raw is int or raw is float:
			return float(raw) if is_finite(float(raw)) else null
		if raw is String and not raw.strip_edges().is_empty() and raw.strip_edges().is_valid_float():
			return raw.strip_edges().to_float()
		return null
	if raw is String:
		return raw
	if raw is int or raw is float:
		return str(int(raw)) if float(raw) == floor(float(raw)) else str(raw)
	if raw is bool:
		return "true" if raw else "false"
	return null


func _try_apply_exposes(scenario_id: String, phase: String, status: String) -> void:
	if status != "done" or _flag_store == null:
		return
	var entry: Variant = null
	for candidate: Variant in _catalog:
		if candidate is Dictionary and str(candidate.get("id", "")) == scenario_id:
			entry = candidate
			break
	if not entry is Dictionary or not entry.get("exposes") is Dictionary:
		return
	var trigger := str(entry.get("exposeAfterPhase", "")).strip_edges()
	if trigger.is_empty() or trigger != phase:
		return
	for raw_key: Variant in entry.exposes:
		var key := str(raw_key).strip_edges()
		if key.is_empty() or not _flag_store.is_key_allowed_by_registry(key):
			continue
		var value: Variant = _coerce_expose_value(key, entry.exposes[raw_key])
		if value != null:
			_flag_store.set_value(key, value)


func get_scenario_phase(scenario_id: String, phase: String) -> Variant:
	var sid := scenario_id.strip_edges()
	var ph := phase.strip_edges()
	if sid.is_empty() or ph.is_empty():
		return null
	var phases: Variant = _by_scenario.get(sid)
	return phases.get(ph) if phases is Dictionary else null


func phase_status_equals(scenario_id: String, phase: String, wanted: String) -> bool:
	var value: Variant = get_scenario_phase(scenario_id, phase)
	return wanted == "pending" if not value is Dictionary else str(value.get("status", "")) == wanted


func check_prerequisites(scenario_id: String, required_phases: Array) -> bool:
	for phase: Variant in required_phases:
		if not phase_status_equals(scenario_id, str(phase).strip_edges(), "done"):
			return false
	return true


func serialize() -> Dictionary:
	var scenarios := _by_scenario.duplicate(true)
	var line_lifecycle := {}
	for sid: String in _line_lifecycle_by_scenario:
		if _line_lifecycle_by_scenario[sid] != "inactive":
			line_lifecycle[sid] = _line_lifecycle_by_scenario[sid]
	var result := {"scenarios": scenarios}
	if not line_lifecycle.is_empty():
		result["lineLifecycle"] = line_lifecycle
	return result


func deserialize(data: Dictionary) -> void:
	_by_scenario.clear()
	_line_lifecycle_by_scenario.clear()
	var scenarios: Variant = data.get("scenarios")
	if scenarios is Dictionary:
		for raw_sid: Variant in scenarios:
			var raw_phases: Variant = scenarios[raw_sid]
			if not raw_phases is Dictionary:
				continue
			var phases := {}
			for raw_phase: Variant in raw_phases:
				var raw_value: Variant = raw_phases[raw_phase]
				if raw_value is Dictionary and raw_value.get("status") is String:
					var value := {"status": raw_value.status}
					if raw_value.has("outcome"):
						value["outcome"] = raw_value.outcome
					phases[str(raw_phase)] = value
			if not phases.is_empty():
				_by_scenario[str(raw_sid)] = phases
	var line_lifecycle: Variant = data.get("lineLifecycle")
	if line_lifecycle is Dictionary:
		for raw_sid: Variant in line_lifecycle:
			var sid := str(raw_sid).strip_edges()
			var state := str(line_lifecycle[raw_sid])
			if not sid.is_empty() and state in ["active", "completed"]:
				_line_lifecycle_by_scenario[sid] = state
