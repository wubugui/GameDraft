class_name RuntimeRoot
extends Node

const REQUIRED_METHODS := ["init", "update", "serialize", "deserialize", "destroy"]

var event_bus: RuntimeEventBus
var _registrations: Array[Dictionary] = []
var _systems: Array[Dictionary] = []
var _initialized := false
var _destroying := false
var _automatic_updates_enabled := true


func _init(source_event_bus: RuntimeEventBus = null) -> void:
	event_bus = source_event_bus if source_event_bus != null else RuntimeEventBus.new()


func register_system(name: String, system: Variant = null) -> bool:
	var normalized := name.strip_edges()
	if _initialized or _destroying:
		push_error("RuntimeRoot: cannot register systems while runtime is active")
		return false
	if normalized.is_empty() or _registrations.any(func(item: Dictionary) -> bool: return item.name == normalized):
		push_error("RuntimeRoot: system name must be non-empty and unique: %s" % normalized)
		return false
	if system != null and (not system is Node or not _implements_game_system(system)):
		push_error("RuntimeRoot: %s does not implement IGameSystem" % normalized)
		return false
	if system != null and system.get_parent() != null:
		push_error("RuntimeRoot: %s is already owned by another node" % normalized)
		return false
	# Match Game.ts: Game explicitly constructs concrete systems first, then puts
	# those same instances into one ordered registeredSystems list.  RuntimeRoot
	# is only the Godot lifecycle adapter for that list; it is not a factory or
	# service-locator framework.
	_registrations.push_back({"name": normalized, "system": system})
	return true


func replace_registered_system(name: String, system: Node) -> bool:
	if system == null or not _implements_game_system(system) or system.get_parent() != null:
		return false
	for index in _registrations.size():
		var registration: Dictionary = _registrations[index]
		if str(registration.name) != name:
			continue
		if registration.system != null:
			return registration.system == system
		registration.system = system
		_registrations[index] = registration
		if _initialized:
			system.name = name
			add_child(system)
			_systems[index].system = system
		return true
	return false


## Godot-only parenting adapter. Game/bootstrap retains the source-owned ordered
## registered_systems array and calls init/serialize/deserialize/destroy itself.
func attach_system_slots(source_slots: Array[Dictionary]) -> bool:
	if _initialized or _destroying or not _registrations.is_empty() or not _systems.is_empty():
		return false
	for source_entry: Dictionary in source_slots:
		if not register_system(str(source_entry.get("name", "")), source_entry.get("system")):
			return false
	for registration: Dictionary in _registrations:
		var node: Variant = registration.system
		_systems.push_back({"name": str(registration.name), "system": node})
		if node != null:
			node.name = str(registration.name)
			add_child(node)
	_initialized = true
	return true


func release_system_nodes() -> void:
	_destroy_constructed_systems(false)
	_registrations.clear()
	_initialized = false


func init_runtime(context_values: Dictionary = {}) -> bool:
	if _initialized:
		return true
	if _destroying:
		return false
	var context := {
		"eventBus": event_bus,
		"flagStore": context_values.get("flagStore"),
		"strings": context_values.get("strings"),
		"assetManager": context_values.get("assetManager"),
	}
	if not _registrations.is_empty():
		for required in ["flagStore", "strings", "assetManager"]:
			if context[required] == null:
				push_error("RuntimeRoot: GameContext missing %s" % required)
				return false
	for registration in _registrations:
		var node: Variant = registration.system
		var entry := {"name": str(registration.name), "system": node}
		_systems.push_back(entry)
		if node != null:
			node.name = str(registration.name)
			add_child(node)
			node.call("init", context)
	_initialized = true
	return true


func update_runtime(dt: float) -> void:
	if not _initialized or _destroying:
		return
	for entry in _systems:
		if entry.system != null: entry.system.call("update", dt)


func set_automatic_updates_enabled(enabled: bool) -> void:
	_automatic_updates_enabled = enabled
	set_process(enabled)


func automatic_updates_enabled() -> bool:
	return _automatic_updates_enabled


func serialize_systems() -> Dictionary:
	var result := {}
	if not _initialized:
		return result
	for entry in _systems:
		if entry.system != null:
			var value: Variant = entry.system.call("serialize")
			result[entry.name] = value if value is Dictionary else {}
	return result


func deserialize_systems(data: Dictionary) -> void:
	if not _initialized or _destroying:
		return
	for entry in _systems:
		if entry.system != null and data.get(entry.name) is Dictionary:
			entry.system.call("deserialize", data[entry.name])


func destroy_runtime() -> void:
	if _destroying:
		return
	_destroying = true
	# Match Game.ts: registered systems destroy in registration order.  EventBus
	# clears only after every owner has had the chance to off its listeners.
	for entry in _systems:
		if entry.system != null: entry.system.call("destroy")
	_destroy_constructed_systems(false)
	_registrations.clear()
	event_bus.clear()
	_initialized = false
	_destroying = false


func is_initialized() -> bool:
	return _initialized


func debug_snapshot_fragments() -> Dictionary:
	var result := {}
	for entry in _systems:
		if entry.system != null and entry.system.has_method("debug_snapshot_fragment"):
			var fragment: Variant = entry.system.call("debug_snapshot_fragment")
			if fragment is Dictionary:
				for key: Variant in fragment:
					if result.has(key):
						push_error("RuntimeRoot: duplicate debug snapshot field provider: %s" % key)
						continue
					result[key] = fragment[key]
	return result


func _process(delta: float) -> void:
	if _automatic_updates_enabled: update_runtime(clampf(delta, 0.0, 0.1))


func _exit_tree() -> void:
	destroy_runtime()


func _implements_game_system(system: Node) -> bool:
	return REQUIRED_METHODS.all(func(method: String) -> bool: return system.has_method(method))


func _destroy_constructed_systems(call_destroy: bool = true) -> void:
	if call_destroy:
		for entry in _systems:
			if entry.system != null: entry.system.call("destroy")
	for entry in _systems:
		var node: Variant = entry.system
		if node == null:
			continue
		if node.get_parent() == self:
			remove_child(node)
		node.free()
	_systems.clear()
