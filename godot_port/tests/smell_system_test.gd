extends SceneTree

var changed: Array[Dictionary] = []
var sniffed: Array = []


func _init() -> void:
	var bus := RuntimeEventBus.new()
	bus.on("player:smellChanged", Callable(self, "_changed")); bus.on("player:smellSniff", Callable(self, "_sniffed"))
	var flags := RuntimeFlagStore.new(bus)
	var smell := RuntimeSmellSystem.new(bus, flags); smell.init({})
	assert(smell.get_scent() == "" and smell.get_source() == "none")
	assert(flags.get_value("current_smell") == "" and flags.get_value("smell_intensity") == 0.0)
	bus.emit("zone:enter", {"zone": {"id": "z1", "smell": {"scent": "corpse"}}})
	assert(smell.get_scent() == "corpse" and smell.get_intensity() == 60.0 and smell.get_source() == "zone")
	bus.emit("zone:enter", {"zone": {"id": "z2", "smell": {"scent": "incense", "intensity": 120, "dir": -2, "flicker": true}}})
	assert(smell.get_debug_state().effective == {"scent": "incense", "intensity": 100.0, "dir": -1.0, "flicker": true})
	smell.set_smell("powder", -5, 0.5, true)
	assert(smell.get_scent() == "powder" and smell.get_intensity() == 0.0 and smell.get_source() == "action")
	smell.sniff(); assert(sniffed == ["powder"])
	smell.clear_smell(); assert(smell.get_scent() == "incense" and smell.get_source() == "zone")
	bus.emit("zone:exit", {"zoneId": "z2"}); assert(smell.get_scent() == "corpse")
	smell.set_zone_smell("mold", "75", 2, false)
	assert(smell.get_scent() == "mold" and smell.get_intensity() == 75.0 and smell.get_debug_state().effective.dir == 1.0)
	smell.clear_zone_smell(); assert(smell.get_scent() == "corpse")
	bus.emit("zone:exit", {"zone": {"id": "z1"}}); assert(smell.get_scent() == "" and smell.get_source() == "none")
	smell.sniff(); assert(sniffed.size() == 1)
	smell.set_smell("blood", 80, -0.25, false)
	var snapshot := smell.serialize()
	var restored := RuntimeSmellSystem.new(bus, flags); restored.init({}); restored.deserialize(snapshot)
	assert(restored.serialize() == snapshot and restored.get_scent() == "blood")
	restored.deserialize({"scent": "yin", "intensity": 33, "dir": 0.2, "flicker": true})
	assert(restored.get_debug_state().action == {"scent": "yin", "intensity": 33.0, "dir": 0.2, "flicker": true})
	assert(bus.listener_count("zone:enter") == 2 and bus.listener_count("zone:exit") == 2)
	restored.destroy(); restored.free(); smell.destroy(); smell.free()
	assert(bus.listener_count("zone:enter") == 0 and bus.listener_count("zone:exit") == 0)
	flags.destroy(); bus.clear()
	print("SmellSystem contract test: PASS"); quit(0)


func _changed(payload: Dictionary) -> void: changed.push_back(payload.duplicate(true))
func _sniffed(payload: Dictionary) -> void: sniffed.push_back(payload.scent)
