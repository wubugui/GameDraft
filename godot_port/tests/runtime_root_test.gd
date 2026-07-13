extends SceneTree

class ProbeSystem:
	extends Node
	var label: String
	var calls: Array
	var value := 0

	func _init(next_label: String, call_log: Array) -> void:
		label = next_label
		calls = call_log

	func init(ctx: Dictionary) -> void:
		assert(ctx.eventBus is RuntimeEventBus)
		assert(ctx.flagStore != null and ctx.strings != null and ctx.assetManager != null)
		calls.push_back("init:" + label)

	func update(dt: float) -> void:
		calls.push_back("update:%s:%s" % [label, dt])

	func serialize() -> Dictionary:
		return {"value": value}

	func deserialize(data: Dictionary) -> void:
		value = int(data.get("value", 0))
		calls.push_back("deserialize:" + label)

	func destroy() -> void:
		calls.push_back("destroy:" + label)


func _init() -> void:
	var calls: Array = []
	var runtime := RuntimeRoot.new()
	root.add_child(runtime)
	assert(runtime.register_system("first", func() -> Node: return ProbeSystem.new("first", calls)))
	assert(runtime.register_system("second", func() -> Node: return ProbeSystem.new("second", calls)))
	var context := {"flagStore": RefCounted.new(), "strings": RefCounted.new(), "assetManager": RefCounted.new()}
	assert(runtime.init_runtime(context))
	assert(calls == ["init:first", "init:second"])
	assert(runtime.get_system("first") != null and runtime.get_system("second") != null)
	runtime.set_automatic_updates_enabled(false)
	assert(not runtime.automatic_updates_enabled() and not runtime.is_processing())
	runtime.update_runtime(0.25)
	assert(calls.slice(2) == ["update:first:0.25", "update:second:0.25"])
	var restore_events := [0]
	runtime.event_bus.on("save:restoring", func(_payload: Variant) -> void: restore_events[0] += 1)
	runtime.deserialize_systems({"first": {"value": 7}, "second": {"value": 9}})
	assert(restore_events[0] == 0)
	assert(runtime.serialize_systems() == {"first": {"value": 7}, "second": {"value": 9}})
	var marker := func(_payload: Variant) -> void: pass
	runtime.event_bus.on("leak-check", marker)
	runtime.destroy_runtime()
	assert(calls.slice(-2) == ["destroy:first", "destroy:second"])
	assert(runtime.event_bus.listener_count() == 0)
	assert(runtime.get_child_count() == 0)
	assert(runtime.init_runtime(context))
	assert(calls.slice(-2) == ["init:first", "init:second"])
	runtime.destroy_runtime()
	assert(calls.slice(-2) == ["destroy:first", "destroy:second"])
	runtime.queue_free()
	print("RuntimeRoot lifecycle test: PASS")
	quit(0)
