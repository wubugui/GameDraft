class_name RuntimeRoot
extends Node

const REQUIRED_METHODS := ["init", "update", "serialize", "deserialize", "destroy"]

var event_bus := RuntimeEventBus.new()
var _registrations: Array[Dictionary] = []
var _systems: Array[Dictionary] = []
var _system_by_name: Dictionary = {}
var _initialized := false
var _destroying := false
var _automatic_updates_enabled := true


func register_system(name: String, factory: Callable) -> bool:
	var normalized := name.strip_edges()
	if _initialized or _destroying:
		push_error("RuntimeRoot: cannot register systems while runtime is active")
		return false
	if normalized.is_empty() or _registrations.any(func(item: Dictionary) -> bool: return item.name == normalized):
		push_error("RuntimeRoot: system name must be non-empty and unique: %s" % normalized)
		return false
	if not factory.is_valid():
		push_error("RuntimeRoot: invalid factory for %s" % normalized)
		return false
	_registrations.push_back({"name": normalized, "factory": factory})
	return true


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
		var system: Variant = registration.factory.call()
		if not system is Node or not _implements_game_system(system):
			push_error("RuntimeRoot: factory for %s did not return IGameSystem Node" % registration.name)
			_destroy_constructed_systems()
			return false
		var node: Node = system
		node.name = str(registration.name)
		add_child(node)
		var entry := {"name": str(registration.name), "system": node}
		_systems.push_back(entry)
		_system_by_name[entry.name] = node
		node.call("init", context)
	_initialized = true
	return true


func update_runtime(dt: float) -> void:
	if not _initialized or _destroying:
		return
	for entry in _systems:
		entry.system.call("update", dt)


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
		var value: Variant = entry.system.call("serialize")
		result[entry.name] = value if value is Dictionary else {}
	return result


func deserialize_systems(data: Dictionary) -> void:
	if not _initialized or _destroying:
		return
	for entry in _systems:
		if data.get(entry.name) is Dictionary:
			entry.system.call("deserialize", data[entry.name])


func destroy_runtime() -> void:
	if _destroying:
		return
	_destroying = true
	# Match Game.ts: registered systems destroy in registration order.  EventBus
	# clears only after every owner has had the chance to off its listeners.
	for entry in _systems:
		entry.system.call("destroy")
	_destroy_constructed_systems(false)
	event_bus.clear()
	_initialized = false
	_destroying = false


func get_system(name: String) -> Variant:
	return _system_by_name.get(name)


func is_initialized() -> bool:
	return _initialized


func debug_snapshot_fragments() -> Dictionary:
	var result := {}
	for entry in _systems:
		if entry.system.has_method("debug_snapshot_fragment"):
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
			entry.system.call("destroy")
	for entry in _systems:
		var node: Node = entry.system
		if node.get_parent() == self:
			remove_child(node)
		node.free()
	_systems.clear()
	_system_by_name.clear()
