extends Node

var events: Array[Dictionary] = []
var actions: Array[String] = []


func _ready() -> void:
	await _run()


func _run() -> void:
	var bus := RuntimeEventBus.new()
	bus.on("player:healthChanged", Callable(self, "_record_health"))
	var flags := RuntimeFlagStore.new(bus)
	var executor := RuntimeActionExecutor.new(bus, flags)
	executor.register("playSignalCue", Callable(self, "_record_cue"), ["id"])
	executor.register("emitNarrativeSignal", Callable(self, "_record_signal"), ["sourceType", "sourceId", "signal"])
	var health := RuntimeHealthSystem.new(bus, flags, executor)
	health.init({})
	assert(health.get_health() == 100.0 and health.get_max_health() == 100.0)
	assert(flags.get_value("player_health") == 100.0 and events[-1] == {"current": 100.0, "max": 100.0})
	await health.damage(10.0)
	assert(health.get_health() == 90.0)
	health.heal(20.0)
	assert(health.get_health() == 100.0)
	health.set_health(-5.0)
	assert(health.get_health() == 0.0 and actions.is_empty())
	health.set_health(NAN)
	assert(health.get_health() == 0.0)
	health.set_health(5.0)
	await health.damage(10.0)
	assert(actions == ["cue:signal_death_tether", "signal:death_tether"])
	assert(health.get_health() == 60.0 and flags.get_value("player_health") == 60.0)

	# Suppression hands recovery to content: hit zero, no cue/signal, no auto-heal.
	actions.clear()
	flags.set_value("forest.tether_suppressed", true)
	health.set_health(2.0)
	await health.tether()
	assert(health.get_health() == 0.0 and actions.is_empty())
	flags.set_value("forest.tether_suppressed", false)

	var snapshot := health.serialize()
	var restored := RuntimeHealthSystem.new(bus, flags, executor)
	restored.configure({"maxHealth": 120.0, "deathThreshold": 10.0, "restoreFloor": 150.0, "tetherCueId": "custom"})
	restored.init({})
	assert(restored.get_health() == 120.0)
	restored.set_health(11.0)
	actions.clear()
	await restored.damage(1.0)
	assert(restored.get_health() == 120.0 and actions[0] == "cue:custom")
	restored.deserialize(snapshot)
	assert(restored.serialize() == snapshot)
	restored.destroy(); restored.free()
	health.destroy(); health.free()
	executor.destroy(); flags.destroy(); bus.clear()
	print("HealthSystem contract test: PASS")
	get_tree().quit(0)


func _record_health(payload: Dictionary) -> void:
	events.push_back(payload.duplicate(true))


func _record_cue(params: Dictionary, _zone: Variant) -> void:
	actions.push_back("cue:%s" % params.get("id", ""))
	await get_tree().process_frame


func _record_signal(params: Dictionary, _zone: Variant) -> void:
	actions.push_back("signal:%s" % params.get("signal", ""))
