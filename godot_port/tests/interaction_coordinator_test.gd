extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const SceneQueries := preload("res://tests/support/scene_queries.gd")

class FakeGraphDialogue:
	extends RefCounted
	var calls: Array
	func _init(next_calls: Array) -> void: calls = next_calls
	func is_active() -> bool: return false
	func has_pending_chain_continuation() -> bool: return false
	func start_dialogue_graph(request: Dictionary) -> bool:
		calls.push_back(request.duplicate(true))
		await Engine.get_main_loop().process_frame
		return false

var graph_calls: Array = []
var encounter_calls: Array = []
var events_ref: RuntimeEventBus


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository)); var events := RuntimeEventBus.new(); events_ref = events; var flags := RuntimeFlagStore.new(events); flags.configure_registry(assets.load_json("/assets/data/flag_registry.json")); var strings := RuntimeStringsProvider.new(); strings.load(assets); var input := RuntimeInputManager.new(); add_child(input); var state := RuntimeGameStateController.new(input, events); var executor := RuntimeActionExecutor.new(events, flags, state); var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.init(); renderer.set_viewport_size(800, 600); var camera := RuntimeCamera.new(renderer.world_container); camera.set_screen_size(800, 600); var player := RuntimePlayer.new(input); renderer.entity_layer.add_child(player.sprite); var scenes := RuntimeSceneManager.new(assets, events, renderer); add_child(scenes); scenes.init({}); preload("res://tests/support/scene_manager_wiring.gd").bind(scenes, player, camera); var inventory := RuntimeInventoryManager.new(events, flags); inventory.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); await inventory.load_defs(); var rules := RuntimeRulesManager.new(events, flags); rules.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); await rules.load_defs(); var quests := RuntimeQuestManager.new(events, flags, executor); quests.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); await quests.load_defs(); var graph := FakeGraphDialogue.new(graph_calls); var scripted := RuntimeDialogueManager.new(events); var offers := RuntimeRuleOfferRegistry.new()
	var scenario := RuntimeScenarioStateManager.new(); scenario.configure_runtime(flags, null, events)
	var condition_factory := func() -> Dictionary:
		return {"flagStore": flags, "questManager": quests, "scenarioState": scenario, "narrativeState": null, "resolveConditionLiteral": func(value: String) -> String: return value, "currentSceneId": scenes.get_current_scene_id(), "currentOwner": null, "getActivePlaneId": func() -> String: return "normal"}
	flags.set_condition_eval_context_factory(condition_factory); inventory.set_condition_eval_context_factory(condition_factory); quests.set_condition_eval_context_factory(condition_factory)
	preload("res://tests/support/action_registry_fixture.gd").register(executor, {"ruleOfferRegistry": offers, "inventoryManager": inventory, "rulesManager": rules, "questManager": quests, "stringsProvider": strings, "eventBus": events, "sceneManager": scenes, "stateController": state, "setCameraZoom": Callable(camera, "set_zoom"), "restoreSceneCameraZoom": func() -> void: camera.set_zoom(1.0)})
	executor.register("startEncounter", func(params: Dictionary, _zone: Variant) -> void: await _encounter(str(params.get("id", ""))), ["id"])
	var box := RuntimeInspectBox.new(renderer, strings, input); var coordinator := RuntimeInteractionCoordinator.new(events, {"stateController": state, "sceneManager": scenes, "dialogueManager": scripted, "graphDialogueManager": graph, "actionExecutor": executor, "inspectBox": box, "eventBus": events, "getPlayerWorldPos": func() -> Dictionary: return {"x": player.get_x(), "y": player.get_y()}, "getCameraZoom": Callable(camera, "get_zoom"), "preparePlayerForNpcDialogue": func(npc: RuntimeNpc) -> void: player.set_facing(npc.get_x() - player.get_x(), npc.get_y() - player.get_y()); player.play_animation("idle"), "fadingDialogueCameraZoom": func(zoom: float, _duration: float) -> void: camera.set_zoom(zoom), "fadingRestoreSceneCameraZoom": func(_duration: float) -> void: camera.set_zoom(1.0)}); coordinator.init()
	assert(await scenes.load_scene("test_room_b")); flags.set_value("encounter_ghost_done", true); _close_box_later(box); assert(await coordinator.debug_trigger_hotspot_by_id("strange_mark")); assert(scenes.serialize().memory.test_room_b.inspected == ["strange_mark"] and state.current_state == RuntimeDataTypes.EXPLORING)
	assert(await coordinator.debug_trigger_hotspot_by_id("herb_bundle")); assert(inventory.get_item_count("mugwort") == 2 and flags.get_value("picked_up_herb_bundle") == true and SceneQueries.hotspot(scenes, "herb_bundle").get_picked_up())
	assert(await coordinator.debug_trigger_hotspot_by_id("old_box")); assert(encounter_calls == ["old_box_encounter"] and SceneQueries.hotspot(scenes, "old_box").get_picked_up())
	assert(await coordinator.debug_trigger_hotspot_by_id("exit_to_a")); assert(scenes.get_current_scene_id() == "test_room_a")
	assert(await scenes.switch_scene("teahouse")); assert(await coordinator.debug_interact_npc_by_id("storyteller_zhang")); assert(graph_calls[-1].graphId == "寻狗_说书人" and state.current_state == RuntimeDataTypes.EXPLORING and not scenes.get_npc_by_id("storyteller_zhang").is_patrol_paused_for_dialogue())
	coordinator.destroy(); box.destroy(); scripted.destroy(); scripted.free(); scenario.destroy(); scenario.free(); quests.destroy(); quests.free(); rules.destroy(); rules.free(); inventory.destroy(); inventory.free(); offers.clear(); scenes.destroy(); remove_child(scenes); scenes.free(); player.destroy_player(); state.destroy(); input.destroy(); remove_child(input); input.free(); assets.dispose(); renderer.destroy(); remove_child(renderer); renderer.free(); executor.destroy(); flags.destroy(); events.clear()
	print("InteractionCoordinator inspect/pickup/transition/npc/encounter routing test: PASS"); get_tree().quit(0)


func _close_box_later(box: RuntimeInspectBox) -> void: await get_tree().create_timer(0.12).timeout; box.close()
func _encounter(id: String) -> bool: encounter_calls.push_back(id); events_ref.emit("encounter:start", {"id": id}); await get_tree().process_frame; return true
