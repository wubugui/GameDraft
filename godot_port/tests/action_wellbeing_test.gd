extends Node

var order: Array = []
var sniff_events := 0
var blend_calls: Array = []


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository)); var events := RuntimeEventBus.new(); events.on("player:smellSniff", func(_payload: Variant) -> void: sniff_events += 1); var flags := RuntimeFlagStore.new(events); flags.configure_registry(assets.load_json("/assets/data/flag_registry.json")); var executor := RuntimeActionExecutor.new(events, flags); executor.register("record", func(params: Dictionary, _zone: Variant) -> void: order.push_back(params.id), ["id"])
	var day := RuntimeDayManager.new(events, flags, executor); day.init({}); var archive := RuntimeArchiveManager.new(events, flags); archive.init({"eventBus": events, "flagStore": flags, "strings": RuntimeStringsProvider.new(), "assetManager": assets}); var health := RuntimeHealthSystem.new(events, flags, executor); health.init({}); var smell := RuntimeSmellSystem.new(events, flags); smell.init({}); var documents := RuntimeDocumentRevealManager.new(assets, events, flags, null, null); documents.defs["doc"] = {"id": "doc", "blurredImagePath": "blur", "clearImagePath": "clear", "revealCondition": {"flag": "doc_ready", "value": true}, "animation": {"durationMs": 1, "delayMs": 0}, "revealedFlag": "doc_revealed"}; documents.set_blend_executor(Callable(self, "_blend"))
	var condition_factory := func() -> Dictionary:
		return {"flagStore": flags, "questManager": null, "scenarioState": null, "narrativeState": null, "getActivePlaneId": func() -> String: return "normal", "resolveConditionLiteral": func(value: String) -> String: return value, "currentOwner": null, "currentSceneId": ""}
	flags.set_condition_eval_context_factory(condition_factory)
	archive.set_condition_eval_context_factory(condition_factory)
	documents.set_condition_eval_context_factory(condition_factory)
	archive.load_defs()
	preload("res://tests/support/action_registry_fixture.gd").register(executor, {
		"dayManager": day,
		"archiveManager": archive,
		"healthSystem": health,
		"smellSystem": smell,
		"documentRevealManager": documents,
	})
	await executor.execute_await({"type": "addDelayedEvent", "params": {"targetDay": 2, "actions": [{"type": "record", "params": {"id": "delayed"}}, {"bad": true}]}}); await executor.execute_await({"type": "endDay", "params": {}}); assert(day.get_current_day() == 2 and order == ["delayed"])
	await executor.execute_await({"type": "addArchiveEntry", "params": {"bookType": "character", "entryId": "storyteller_zhang"}}); assert(archive.get_unlocked_characters().any(func(v: Dictionary) -> bool: return v.id == "storyteller_zhang"))
	await executor.execute_await({"type": "damagePlayer", "params": {"amount": 10}}); assert(health.get_health() == 90); await executor.execute_await({"type": "healPlayer", "params": {"amount": 5}}); assert(health.get_health() == 95); await executor.execute_await({"type": "setHealth", "params": {"amount": 40}}); await executor.execute_await({"type": "incHealth", "params": {"amount": 20}}); await executor.execute_await({"type": "decHealth", "params": {"amount": 5}}); assert(health.get_health() == 55); await executor.execute_await({"type": "resetHealth", "params": {}}); assert(health.get_health() == 100)
	health.set_health(1); await executor.execute_await({"type": "triggerDeathTether", "params": {}}); assert(health.get_health() == 60)
	await executor.execute_await({"type": "setSmell", "params": {"scent": "incense", "intensity": 77, "dir": -0.5, "flicker": true}}); assert(smell.get_scent() == "incense" and smell.get_intensity() == 77); await executor.execute_await({"type": "sniff", "params": {}}); assert(sniff_events == 1); await executor.execute_await({"type": "clearSmell", "params": {}}); assert(smell.get_scent().is_empty())
	await executor.execute_await({"type": "revealDocument", "params": {"documentId": "doc"}}); assert(not documents.is_revealed("doc") and blend_calls.is_empty()); flags.set_value("doc_ready", true); await executor.execute_await({"type": "revealDocument", "params": {"documentId": "doc"}}); assert(documents.is_revealed("doc") and flags.get_value("doc_revealed") == true and blend_calls.size() == 1)
	for type: String in ["endDay", "addDelayedEvent", "addArchiveEntry", "damagePlayer", "healPlayer", "resetHealth", "setHealth", "incHealth", "decHealth", "triggerDeathTether", "setSmell", "clearSmell", "sniff", "revealDocument"]: assert(executor.has_handler(type))
	documents.destroy(); documents.free(); smell.destroy(); smell.free(); health.destroy(); health.free(); archive.destroy(); archive.free(); day.destroy(); day.free(); executor.destroy(); flags.destroy(); events.clear(); assets.dispose()
	print("Day/archive/health/smell/document Action contract test: PASS"); get_tree().quit(0)


func _blend(overlay_id: String, from_image: String, to_image: String, x: float, y: float, width: float, duration: float, delay: float) -> void:
	blend_calls.push_back({"id": overlay_id, "from": from_image, "to": to_image, "x": x, "y": y, "width": width, "duration": duration, "delay": delay}); await get_tree().process_frame
