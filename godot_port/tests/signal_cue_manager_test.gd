extends Node


class AssetManagerStub extends RuntimeAssetManager:
	var responses: Array = []
	var load_count := 0

	func load_json(_path: String) -> Variant:
		var response: Variant = responses[load_count] if load_count < responses.size() else null
		load_count += 1
		return response


var manager: RuntimeSignalCueManager
var action_order: Array[String] = []


func _ready() -> void:
	await _run()


func _run() -> void:
	var bus := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(bus)
	var executor := RuntimeActionExecutor.new(bus, flags)
	executor.register("record", Callable(self, "_record"), ["id"])
	executor.register("reenter", Callable(self, "_reenter"), [])
	executor.register("reject", Callable(self, "_reject"), [])
	manager = RuntimeSignalCueManager.new(executor)

	var first_definition := {
		"id": " first ",
		"actions": [
			{"type": "record", "params": {"id": "a"}},
			{"type": "record", "params": {"id": "b"}},
		],
	}
	var assets := AssetManagerStub.new()
	assets.responses = [
		[first_definition, null, {"id": "", "actions": []}, {"id": "bad"}],
		[{"id": "second", "actions": [{"type": "record", "params": {"id": "c"}}]}],
		null,
	]
	manager.init({"assetManager": assets})
	manager.load_defs()
	assert(manager.defs.has("first") and manager.defs.size() == 1)
	# Map.set(id, def) keeps the source object and definitions absent from a later load.
	first_definition.description = "same-object"
	assert(manager.defs.first.description == "same-object")
	manager.load_defs()
	assert(manager.defs.has("first") and manager.defs.has("second"))
	manager.load_defs()

	await manager.play(" first ")
	assert(action_order == ["a", "b"])
	await manager.play(null)

	manager.defs.loop = {"id": "loop", "actions": [{"type": "reenter", "params": {}}]}
	await manager.play("loop")
	assert(action_order == ["a", "b", "reenter-complete"] and not manager.in_flight.has("loop"))

	# ActionExecutor false is the target rejected-Promise channel; inFlight must
	# still be released exactly like the source finally block.
	manager.defs.failure = {"id": "failure", "actions": [{"type": "reject", "params": {}}]}
	await manager.play("failure")
	assert(not manager.in_flight.has("failure"))

	manager.in_flight.sentinel = true
	manager.deserialize({"ignored": true})
	assert(manager.in_flight.has("sentinel"))
	manager.in_flight.erase("sentinel")
	var owned_assets := manager.asset_manager
	manager.destroy()
	assert(manager.defs.is_empty() and manager.in_flight.is_empty() and manager.asset_manager == owned_assets)

	manager.free()
	executor.destroy(); flags.destroy(); bus.clear()
	print("SignalCueManager field/method/load/play direct-translation test: PASS")
	get_tree().quit(0)


func _record(params: Dictionary, _zone: Variant) -> void:
	action_order.push_back(str(params.get("id", "")))
	await get_tree().process_frame


func _reenter(_params: Dictionary, _zone: Variant) -> void:
	await manager.play("loop")
	action_order.push_back("reenter-complete")


func _reject(_params: Dictionary, _zone: Variant) -> bool:
	return false
