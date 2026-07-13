class_name RuntimeScenarioStateManager
extends RuntimeSystem

const SCENARIOS_URL := "/assets/data/scenarios.json"
const LINE_STATES := ["inactive", "active", "completed"]

var _by_scenario: Dictionary = {}
var _line_lifecycle: Dictionary = {}
var _manual_ids: Dictionary = {}
var _catalog: Array = []
var _catalog_by_id: Dictionary = {}
var _flag_store: RuntimeFlagStore
var _event_bus: RuntimeEventBus
var _asset_manager: RuntimeAssetManager
var _last_error := ""


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore) -> void:
	_event_bus = event_bus
	_flag_store = flag_store


func init(ctx: Dictionary) -> void:
	_asset_manager = ctx.assetManager


func update(_dt: float) -> void:
	return


func load_catalog() -> bool:
	var data: Variant = _asset_manager.load_json(SCENARIOS_URL)
	if not data is Dictionary:
		return false
	configure_runtime(_flag_store, data, _event_bus)
	return true


func configure_runtime(flag_store: RuntimeFlagStore, catalog_file: Variant, event_bus: RuntimeEventBus = null) -> void:
	_flag_store = flag_store
	_event_bus = event_bus
	_catalog.clear()
	_catalog_by_id.clear()
	_manual_ids.clear()
	var entries: Variant = catalog_file.get("scenarios", []) if catalog_file is Dictionary else []
	if not entries is Array:
		return
	for raw: Variant in entries:
		if not raw is Dictionary:
			continue
		var id := str(raw.get("id", "")).strip_edges()
		if id.is_empty():
			continue
		var entry: Dictionary = raw.duplicate(true)
		_catalog.push_back(entry)
		_catalog_by_id[id] = entry
		if entry.get("manualLineLifecycle", false) == true:
			_manual_ids[id] = true


func get_catalog_scenario_ids() -> Array[String]:
	var result: Array[String] = []
	for entry: Dictionary in _catalog:
		var id := str(entry.get("id", "")).strip_edges()
		if not id.is_empty():
			result.push_back(id)
	return result


func has_manual_line_lifecycle(scenario_id: String) -> bool:
	return _manual_ids.has(scenario_id.strip_edges())


func assert_scenario_line_entry_for_action(scenario_id: String) -> bool:
	return _assert_line_entry(scenario_id.strip_edges())


func reset_scenario_progress_for_debug(scenario_id: String) -> void:
	var id := scenario_id.strip_edges()
	if id.is_empty():
		return
	_line_lifecycle.erase(id)
	_by_scenario.erase(id)


func debug_set_scenario_line_lifecycle(scenario_id: String, state: String) -> void:
	var id := scenario_id.strip_edges()
	if id.is_empty() or not LINE_STATES.has(state):
		return
	if state == "inactive":
		_line_lifecycle.erase(id)
	else:
		_line_lifecycle[id] = state


func debug_set_scenario_phase(scenario_id: String, phase: String, payload: Dictionary) -> void:
	var id := scenario_id.strip_edges()
	var phase_id := phase.strip_edges()
	var status := str(payload.get("status", "")).strip_edges()
	if id.is_empty() or phase_id.is_empty() or status.is_empty():
		return
	var phases: Dictionary = _by_scenario.get(id, {})
	var current: Dictionary = phases.get(phase_id, {"status": "pending"})
	var value := {"status": status}
	if payload.has("outcome"):
		value["outcome"] = payload.outcome
	elif current.has("outcome"):
		value["outcome"] = current.outcome
	phases[phase_id] = value
	_by_scenario[id] = phases


func get_line_lifecycle_state(scenario_id: String) -> String:
	return str(_line_lifecycle.get(scenario_id.strip_edges(), "inactive"))


func activate_scenario_line(scenario_id: String) -> bool:
	var id := scenario_id.strip_edges()
	if id.is_empty() or not has_manual_line_lifecycle(id):
		return true
	var current := get_line_lifecycle_state(id)
	if current == "active":
		return true
	if current == "completed":
		return _lifecycle_error(id, "该 narrative 线已标记完成，不能再次 activateScenario")
	if not _assert_line_entry(id):
		return false
	_line_lifecycle[id] = "active"
	return true


func complete_scenario_line(scenario_id: String) -> bool:
	var id := scenario_id.strip_edges()
	if id.is_empty() or not has_manual_line_lifecycle(id):
		return true
	var current := get_line_lifecycle_state(id)
	if current != "active":
		return _lifecycle_error(id, "该线已为完成状态，不能重复 completeScenario" if current == "completed" else "须先 activateScenario（线处于进行中）后才能 completeScenario")
	_line_lifecycle[id] = "completed"
	return true


func set_scenario_phase(scenario_id: String, phase: String, payload: Dictionary) -> bool:
	var id := scenario_id.strip_edges()
	var phase_id := phase.strip_edges()
	if id.is_empty() or phase_id.is_empty():
		return false
	var status := str(payload.get("status", "")).strip_edges()
	var entry: Variant = _catalog_by_id.get(id)
	if has_manual_line_lifecycle(id):
		var lifecycle := get_line_lifecycle_state(id)
		if lifecycle != "active":
			return _lifecycle_error(id, "该线已完成，禁止再修改 phase（须检查 completeScenario 时机）" if lifecycle == "completed" else "须先 activateScenario 激活该线后才能 setScenarioPhase")
	elif not _assert_line_entry(id):
		return false
	var raw_requires: Variant = null
	if entry is Dictionary and entry.get("phases") is Dictionary and entry.phases.get(phase_id) is Dictionary:
		raw_requires = entry.phases[phase_id].get("requires")
	if status in ["done", "active"] and not _eval_catalog_requires(id, raw_requires):
		_last_error = "叙事阶段「%s」违反 requires 前置（详情见控制台日志）" % phase_id
		_event_bus.emit("notification:show", {"text": _last_error, "type": "error"})
		return false
	var phases: Dictionary = _by_scenario.get(id, {})
	var current: Dictionary = phases.get(phase_id, {"status": "pending"})
	var value := {"status": status}
	if payload.has("outcome") and payload.outcome != null:
		value["outcome"] = payload.outcome
	elif current.has("outcome"):
		value["outcome"] = current.outcome
	phases[phase_id] = value
	_by_scenario[id] = phases
	_try_apply_exposes(id, phase_id, status)
	return true


func get_scenario_phase(scenario_id: String, phase: String) -> Variant:
	var id := scenario_id.strip_edges()
	var phase_id := phase.strip_edges()
	if id.is_empty() or phase_id.is_empty():
		return null
	var phases: Variant = _by_scenario.get(id)
	return phases.get(phase_id) if phases is Dictionary else null


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
	var result := {"scenarios": scenarios}
	var line_lifecycle := {}
	for id: String in _line_lifecycle:
		if _line_lifecycle[id] != "inactive":
			line_lifecycle[id] = _line_lifecycle[id]
	if not line_lifecycle.is_empty():
		result["lineLifecycle"] = line_lifecycle
	return result


func deserialize(data: Dictionary) -> void:
	_by_scenario.clear()
	_line_lifecycle.clear()
	var scenarios: Variant = data.get("scenarios")
	if scenarios is Dictionary:
		for raw_id: Variant in scenarios:
			var raw_phases: Variant = scenarios[raw_id]
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
				_by_scenario[str(raw_id)] = phases
	var lifecycle: Variant = data.get("lineLifecycle")
	if lifecycle is Dictionary:
		for raw_id: Variant in lifecycle:
			var id := str(raw_id).strip_edges()
			var state := str(lifecycle[raw_id])
			if not id.is_empty() and state in ["active", "completed"]:
				_line_lifecycle[id] = state


func destroy() -> void:
	_by_scenario.clear()
	_line_lifecycle.clear()
	_manual_ids.clear()
	_catalog.clear()
	_catalog_by_id.clear()
	_last_error = ""


func catalog_count() -> int:
	return _catalog.size()


func last_error() -> String:
	return _last_error


func debug_snapshot_fragment() -> Dictionary:
	return {"scenario": serialize()}


func _assert_line_entry(scenario_id: String) -> bool:
	var phases: Variant = _by_scenario.get(scenario_id)
	if phases is Dictionary and not phases.is_empty():
		return true
	var entry: Variant = _catalog_by_id.get(scenario_id)
	var requires: Variant = entry.get("requires") if entry is Dictionary else null
	if requires == null or _eval_catalog_requires(scenario_id, requires):
		return true
	_last_error = "Scenario 进线 requires 未满足: scenarioId=%s requires=%s" % [JSON.stringify(scenario_id), JSON.stringify(requires)]
	_event_bus.emit("notification:show", {"text": _last_error, "type": "error"})
	return false


func _eval_catalog_requires(scenario_id: String, raw: Variant) -> bool:
	if raw == null:
		return true
	if raw is Array:
		for child: Variant in raw:
			if not _eval_catalog_requires(scenario_id, child):
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
				if not _eval_catalog_requires(scenario_id, child):
					return false
			return true
		if raw.get("any") is Array:
			if raw.any.is_empty():
				return false
			for child: Variant in raw.any:
				if _eval_catalog_requires(scenario_id, child):
					return true
			return false
		if raw.has("not"):
			return not _eval_catalog_requires(scenario_id, raw.not)
	return false


func _try_apply_exposes(scenario_id: String, phase: String, status: String) -> void:
	if status != "done":
		return
	var entry: Variant = _catalog_by_id.get(scenario_id)
	if not entry is Dictionary or not entry.get("exposes") is Dictionary:
		return
	if str(entry.get("exposeAfterPhase", "")).strip_edges() != phase:
		return
	for raw_key: Variant in entry.exposes:
		var key := str(raw_key).strip_edges()
		if key.is_empty() or not _flag_store.is_key_allowed_by_registry(key):
			continue
		var value: Variant = _coerce_expose_value(key, entry.exposes[raw_key])
		if value != null:
			_flag_store.set_value(key, value)


func _coerce_expose_value(key: String, raw: Variant) -> Variant:
	if raw == null:
		return null
	var value_type := _flag_store.get_registry_value_type(key)
	if value_type.is_empty():
		value_type = "bool"
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
	if raw is bool:
		return "true" if raw else "false"
	if raw is int or raw is float:
		return str(int(raw)) if float(raw) == floor(float(raw)) else str(raw)
	return null


func _lifecycle_error(_scenario_id: String, detail: String) -> bool:
	_last_error = detail
	_event_bus.emit("notification:show", {"text": detail, "type": "error"})
	return false
