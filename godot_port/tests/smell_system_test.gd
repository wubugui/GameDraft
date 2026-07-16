extends SceneTree

var changed: Array[Dictionary] = []
var sniffed: Array = []


func _init() -> void:
	var bus := RuntimeEventBus.new()
	bus.on("player:smellChanged", Callable(self, "_changed"))
	bus.on("player:smellSniff", Callable(self, "_sniffed"))
	var flags := RuntimeFlagStore.new(bus)
	var smell := RuntimeSmellSystem.new(bus, flags)
	var enter_callback: Callable = smell.on_zone_enter
	var exit_callback: Callable = smell.on_zone_exit
	assert(enter_callback.is_valid() and exit_callback.is_valid())

	# init uses the constructor-bound callbacks, emits the empty effective state,
	# and is idempotent rather than stacking subscriptions.
	smell.init({})
	assert(smell.get_scent() == "" and smell.get_source() == "none")
	assert(flags.get_value("current_smell") == "" and flags.get_value("smell_intensity") == 0.0)
	assert(changed.back() == {"scent": "", "intensity": 0.0, "dir": 0.0, "flicker": false, "source": "none"})
	assert(EventBusProbe.listener_count(bus, "zone:enter") == 1)
	assert(EventBusProbe.listener_count(bus, "zone:exit") == 1)
	smell.set_smell("temporary", 99)
	smell.init({})
	assert(smell.on_zone_enter == enter_callback and smell.on_zone_exit == exit_callback)
	assert(EventBusProbe.listener_count(bus, "zone:enter") == 1)
	assert(EventBusProbe.listener_count(bus, "zone:exit") == 1)
	assert(smell.get_scent() == "" and smell.active_zone_smells.is_empty())

	# Missing (undefined) intensity defaults to 60, while explicit null follows
	# Number(null) and becomes 0.  String/array/prefixed-number coercions mirror JS.
	bus.emit("zone:enter", {"zone": {"id": "z1", "smell": {"scent": "corpse"}}})
	assert(smell.get_scent() == "corpse" and smell.get_intensity() == 60.0 and smell.get_source() == "zone")
	bus.emit("zone:enter", {"zone": {"id": "z2", "smell": {"scent": "incense", "intensity": 120, "dir": -2, "flicker": true}}})
	assert(smell.get_debug_state().effective == {"scent": "incense", "intensity": 100.0, "dir": -1.0, "flicker": true})
	bus.emit("zone:enter", {"zone": {"id": "z3", "smell": {"scent": "rain", "intensity": null, "dir": null}}})
	assert(smell.get_scent() == "rain" and smell.get_intensity() == 0.0 and smell.get_debug_state().effective.dir == 0.0)
	bus.emit("zone:exit", {"zoneId": "z3"})
	smell.set_smell("default-action")
	assert(smell.get_intensity() == 60.0 and smell.get_debug_state().effective.dir == 0.0)
	smell.set_smell("numeric", ["0x20"], ["0b1"], "false")
	assert(smell.get_intensity() == 32.0 and smell.get_debug_state().effective.dir == 1.0)
	assert(smell.get_debug_state().effective.flicker == true)

	# Re-setting an existing Map key does not move it to the tail: z2 remains
	# dominant even though z1's stored layer changes.
	smell.clear_smell()
	bus.emit("zone:enter", {"zone": {"id": "z1", "smell": {"scent": "ash", "intensity": 20}}})
	assert(smell.get_scent() == "incense")
	# Nullish coalescing is not truthy coalescing: an explicit empty zoneId does
	# not fall back to zone.id and therefore must leave z2 active.
	bus.emit("zone:exit", {"zoneId": "", "zone": {"id": "z2"}})
	assert(smell.get_scent() == "incense")
	bus.emit("zone:exit", {"zoneId": null, "zone": {"id": "z2"}})
	assert(smell.get_scent() == "ash")

	# Action always overrides zone; clearing it resurfaces the active zone.
	smell.set_smell("powder", -5, 0.5, true)
	assert(smell.get_scent() == "powder" and smell.get_intensity() == 0.0 and smell.get_source() == "action")
	smell.sniff()
	assert(sniffed == ["powder"])
	smell.clear_smell()
	assert(smell.get_scent() == "ash" and smell.get_source() == "zone")
	smell.set_zone_smell("mold", "75", 2, false)
	assert(smell.get_scent() == "mold" and smell.get_intensity() == 75.0 and smell.get_debug_state().effective.dir == 1.0)
	smell.clear_zone_smell()
	assert(smell.get_scent() == "ash")
	bus.emit("zone:exit", {"zone": {"id": "z1"}})
	assert(smell.get_scent() == "" and smell.get_source() == "none")
	smell.sniff()
	assert(sniffed.size() == 1)

	# Debug state and serialization use new shallow objects.  Only the action
	# layer is persisted; the position-derived zone layer is intentionally absent.
	smell.set_smell("blood", 80, -0.25, false)
	var debug_state := smell.get_debug_state()
	debug_state.action.scent = "mutated"
	debug_state.effective.intensity = -1
	assert(smell.get_scent() == "blood" and smell.get_intensity() == 80.0)
	var snapshot := smell.serialize()
	assert(snapshot.keys() == ["action"] and not snapshot.has("zone"))
	snapshot.action.scent = "snapshot-mutated"
	assert(smell.get_scent() == "blood")
	var clean_snapshot := smell.serialize()

	var restored := RuntimeSmellSystem.new(bus, flags)
	restored.init({})
	restored.deserialize(clean_snapshot)
	assert(restored.serialize() == clean_snapshot and restored.get_scent() == "blood")
	restored.deserialize({"scent": "yin", "intensity": 33, "dir": 0.2, "flicker": true})
	_assert_layer(restored.get_debug_state().action, "yin", 33.0, 0.2, true)
	# A non-null action wins over the legacy flat fields.  Truthy malformed
	# values produce an empty Partial<SmellLayer>; falsy ones leave state intact.
	restored.deserialize({"action": "malformed", "scent": "must-not-win"})
	_assert_layer(restored.get_debug_state().action, "", 0.0, 0.0, false)
	restored.set_smell("preserved", 41, -0.4, true)
	restored.deserialize({"action": false, "scent": "must-not-win"})
	_assert_layer(restored.get_debug_state().action, "preserved", 41.0, -0.4, true)
	restored.deserialize({})
	_assert_layer(restored.get_debug_state().action, "preserved", 41.0, -0.4, true)
	restored.deserialize({"action": null, "scent": "legacy-null", "intensity": 7})
	_assert_layer(restored.get_debug_state().action, "legacy-null", 7.0, 0.0, false)
	assert(EventBusProbe.listener_count(bus, "zone:enter") == 2 and EventBusProbe.listener_count(bus, "zone:exit") == 2)

	# destroy removes only subscriptions and the active Map.  Like the source it
	# does not refresh the cached layers; re-init returns it to first-init state.
	restored.clear_smell()
	bus.emit("zone:enter", {"zone": {"id": "last", "smell": {"scent": "stale-zone"}}})
	assert(restored.get_scent() == "stale-zone")
	restored.destroy()
	assert(restored.active_zone_smells.is_empty() and restored.get_scent() == "stale-zone")
	bus.emit("zone:enter", {"zone": {"id": "ignored", "smell": {"scent": "ignored"}}})
	assert(restored.get_scent() == "stale-zone")
	var restored_enter_callback: Callable = restored.on_zone_enter
	var restored_exit_callback: Callable = restored.on_zone_exit
	restored.init({})
	assert(restored.on_zone_enter == restored_enter_callback and restored.on_zone_exit == restored_exit_callback)
	assert(restored.get_scent() == "")
	assert(EventBusProbe.listener_count(bus, "zone:enter") == 2)
	restored.destroy()
	restored.free()
	smell.destroy()
	smell.free()
	assert(EventBusProbe.listener_count(bus, "zone:enter") == 0 and EventBusProbe.listener_count(bus, "zone:exit") == 0)
	flags.destroy()
	bus.clear()
	print("SmellSystem contract test: PASS")
	quit(0)


func _assert_layer(layer: Dictionary, scent: String, intensity: float, dir: float, flicker: bool) -> void:
	assert(layer.scent == scent)
	assert(is_equal_approx(float(layer.intensity), intensity))
	assert(is_equal_approx(float(layer.dir), dir))
	assert(layer.flicker == flicker)


func _changed(payload: Dictionary) -> void:
	changed.push_back(payload.duplicate(true))


func _sniffed(payload: Dictionary) -> void:
	sniffed.push_back(payload.scent)
