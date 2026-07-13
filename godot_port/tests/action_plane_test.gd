extends Node


func _ready() -> void:
	var events := RuntimeEventBus.new(); var flags := RuntimeFlagStore.new(events); var executor := RuntimeActionExecutor.new(events, flags); var planes := RuntimePlaneReconciler.new(events); planes.register_defs([{"id": "normal", "membership": "shared"}, {"id": "dream", "membership": "exclusive"}]); executor.register_plane_handlers(planes)
	assert(planes.get_active_plane_id() == "normal"); await executor.execute_await({"type": "activatePlane", "params": {"id": "dream"}}); assert(planes.get_active_plane_id() == "dream" and planes.get_active_plane_membership() == "exclusive")
	await executor.execute_await({"type": "activatePlane", "params": {"id": "missing"}}); assert(planes.get_active_plane_id() == "dream"); await executor.execute_await({"type": "deactivatePlane", "params": {}}); assert(planes.get_active_plane_id() == "normal")
	assert(executor.has_handler("activatePlane") and executor.has_handler("deactivatePlane")); planes.destroy(); planes.free(); executor.destroy(); flags.destroy(); events.clear()
	print("Plane Action contract test: PASS"); get_tree().quit(0)
