class_name RuntimeHealthSystem
extends RuntimeSystem

const DEFAULT_CONFIG := {
	"maxHealth": 100.0,
	"deathThreshold": 0.0,
	"restoreFloor": 60.0,
	"tetherCueId": "signal_death_tether",
	"tetherSuppressFlagKey": "forest.tether_suppressed",
}

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _action_executor: RuntimeActionExecutor
var _config: Dictionary = DEFAULT_CONFIG.duplicate(true)
var _current_health := 100.0
var _max_health := 100.0
var _tethering := false


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore, action_executor: RuntimeActionExecutor) -> void:
	_event_bus = event_bus
	_flag_store = flag_store
	_action_executor = action_executor


func configure(partial: Variant) -> void:
	if partial is Dictionary:
		_config.merge(partial, true)


func init(_ctx: Dictionary) -> void:
	_max_health = float(_config.get("maxHealth", 100.0))
	_current_health = _max_health
	_tethering = false
	_sync_flags()
	_emit_changed()


func update(_dt: float) -> void:
	return


func get_health() -> float:
	return _current_health


func get_max_health() -> float:
	return _max_health


func damage(amount: float) -> void:
	var value := maxf(0.0, amount)
	if value == 0.0:
		return
	var next := _current_health - value
	if next <= float(_config.get("deathThreshold", 0.0)):
		await _trigger_death_tether()
		return
	_current_health = next
	_sync_flags()
	_emit_changed()


func heal(amount: float) -> void:
	var value := maxf(0.0, amount)
	if value == 0.0:
		return
	_current_health = minf(_max_health, _current_health + value)
	_sync_flags()
	_emit_changed()


func set_health(value: float) -> void:
	var next := value if is_finite(value) else _current_health
	_current_health = clampf(next, 0.0, _max_health)
	_sync_flags()
	_emit_changed()


func tether() -> void:
	await _trigger_death_tether()


func serialize() -> Dictionary:
	return {"currentHealth": _current_health, "maxHealth": _max_health}


func deserialize(data: Dictionary) -> void:
	if data.get("maxHealth") is int or data.get("maxHealth") is float:
		_max_health = float(data.maxHealth)
	if data.get("currentHealth") is int or data.get("currentHealth") is float:
		_current_health = float(data.currentHealth)
	_sync_flags()
	_emit_changed()


func destroy() -> void:
	return


func debug_snapshot_fragment() -> Dictionary:
	return {"health": serialize()}


func _trigger_death_tether() -> void:
	if _tethering:
		return
	_tethering = true
	_current_health = 0.0
	_sync_flags()
	_emit_changed()
	if _flag_store.get_value(str(_config.get("tetherSuppressFlagKey", "forest.tether_suppressed"))) == true:
		_tethering = false
		return
	await _action_executor.execute_batch_await([
		{"type": "playSignalCue", "params": {"id": str(_config.get("tetherCueId", "signal_death_tether"))}},
		{"type": "emitNarrativeSignal", "params": {"sourceType": "system", "sourceId": "health", "signal": "death_tether"}},
	])
	_current_health = maxf(1.0, minf(_max_health, float(_config.get("restoreFloor", 60.0))))
	_sync_flags()
	_emit_changed()
	_tethering = false


func _sync_flags() -> void:
	_flag_store.set_value("player_health", _current_health)
	_flag_store.set_value("player_max_health", _max_health)


func _emit_changed() -> void:
	_event_bus.emit("player:healthChanged", {"current": _current_health, "max": _max_health})
