class_name RuntimeHealthSystem
extends RuntimeSystem

const DEFAULT_HEALTH_CONFIG := {
	"maxHealth": 100.0,
	"deathThreshold": 0.0,
	"restoreFloor": 60.0,
	"tetherCueId": "signal_death_tether",
	"tetherSuppressFlagKey": "forest.tether_suppressed",
}

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var config: Dictionary = DEFAULT_HEALTH_CONFIG.duplicate(true)
var current_health := DEFAULT_HEALTH_CONFIG.maxHealth
var max_health := DEFAULT_HEALTH_CONFIG.maxHealth
var tethering := false


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore, action_executor: RuntimeActionExecutor) -> void:
	self.event_bus = event_bus
	self.flag_store = flag_store
	self.action_executor = action_executor


func configure(partial: Variant) -> void:
	if partial == null:
		return
	if partial is Dictionary:
		config.merge(partial, true)


func init(_ctx: Dictionary) -> void:
	max_health = float(config.maxHealth)
	current_health = max_health
	_sync_flags()
	_emit_changed()


func update(_dt: float) -> void:
	return


func get_health() -> float:
	return current_health


func get_max_health() -> float:
	return max_health


func damage(amount: float) -> void:
	var amt := maxf(0.0, amount)
	if amt == 0.0:
		return
	var next := current_health - amt
	if next <= float(config.deathThreshold):
		await _trigger_death_tether()
		return
	current_health = next
	_sync_flags()
	_emit_changed()


func heal(amount: float) -> void:
	var amt := maxf(0.0, amount)
	if amt == 0.0:
		return
	current_health = minf(max_health, current_health + amt)
	_sync_flags()
	_emit_changed()


func set_health(value: float) -> void:
	var next := value if is_finite(value) else current_health
	current_health = maxf(0.0, minf(max_health, next))
	_sync_flags()
	_emit_changed()


func tether() -> void:
	await _trigger_death_tether()


func _trigger_death_tether() -> void:
	if tethering:
		return
	tethering = true
	current_health = 0.0
	_sync_flags()
	_emit_changed()
	if flag_store.get_value(str(config.tetherSuppressFlagKey)) == true:
		tethering = false
		return
	if not await action_executor.execute_batch_await([
		{"type": "playSignalCue", "params": {"id": str(config.tetherCueId)}},
		{"type": "emitNarrativeSignal", "params": {"sourceType": "system", "sourceId": "health", "signal": "death_tether"}},
	]):
		push_warning("HealthSystem: death-tether actions failed")
	current_health = maxf(1.0, minf(max_health, float(config.restoreFloor)))
	_sync_flags()
	_emit_changed()
	tethering = false


func _sync_flags() -> void:
	flag_store.set_value("player_health", current_health)
	flag_store.set_value("player_max_health", max_health)


func _emit_changed() -> void:
	event_bus.emit("player:healthChanged", {"current": current_health, "max": max_health})


func serialize() -> Dictionary:
	return {"currentHealth": current_health, "maxHealth": max_health}


func deserialize(data: Dictionary) -> void:
	if data.get("maxHealth") is int or data.get("maxHealth") is float:
		max_health = float(data.maxHealth)
	if data.get("currentHealth") is int or data.get("currentHealth") is float:
		current_health = float(data.currentHealth)
	_sync_flags()
	_emit_changed()


func destroy() -> void:
	return
