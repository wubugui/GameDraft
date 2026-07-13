extends Node

var graph_calls: Array = []
var encounter_calls: Array = []
var events_ref: RuntimeEventBus


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository)); var events := RuntimeEventBus.new(); events_ref = events; var flags := RuntimeFlagStore.new(events); flags.configure_registry(assets.load_json("/assets/data/flag_registry.json")); var strings := RuntimeStringsProvider.new(); strings.load(assets); var input := RuntimeInputManager.new(); add_child(input); var state := RuntimeGameStateController.new(input, events); var executor := RuntimeActionExecutor.new(events, flags, state); var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.init_renderer(); renderer.set_viewport_size(800, 600); var camera := RuntimeCamera.new(renderer.world_container); camera.set_screen_size(800, 600); var player := RuntimePlayer.new(input); renderer.entity_layer.add_child(player.sprite); var scenes := RuntimeSceneManager.new(assets, events, renderer, player, camera); add_child(scenes); scenes.init({}); var inventory := RuntimeInventoryManager.new(events, flags); inventory.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); inventory.load_defs(); var rules := RuntimeRulesManager.new(events, flags); rules.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); rules.load_defs(); var quests := RuntimeQuestManager.new(events, flags, executor); quests.init({"eventBus": events, "flagStore": flags, "strings": strings, "assetManager": assets}); quests.load_defs(); var offers := RuntimeRuleOfferRegistry.new(); executor.register_inventory_rule_quest_handlers(inventory, rules, quests, offers, strings); executor.register_scene_camera_handlers(scenes, camera)
	var box := RuntimeInspectBox.new(renderer, strings, input); var coordinator := RuntimeInteractionCoordinator.new(events, state, scenes, executor, box, player, camera); coordinator.init(); coordinator.set_graph_dialogue_starter(Callable(self, "_graph")); coordinator.set_encounter_starter(Callable(self, "_encounter"))
	assert(scenes.load_scene("test_room_b")); flags.set_value("encounter_ghost_done", true); _close_box_later(box); assert(await coordinator.debug_trigger_hotspot_by_id("strange_mark")); assert(scenes.serialize().memory.test_room_b.inspected == ["strange_mark"] and state.current_state == RuntimeGameStateController.EXPLORING)
	assert(await coordinator.debug_trigger_hotspot_by_id("herb_bundle")); assert(inventory.get_item_count("mugwort") == 2 and flags.get_value("picked_up_herb_bundle") == true and scenes.get_hotspot_by_id("herb_bundle").get_picked_up())
	assert(await coordinator.debug_trigger_hotspot_by_id("old_box")); assert(encounter_calls == ["old_box_encounter"] and scenes.get_hotspot_by_id("old_box").get_picked_up())
	assert(await coordinator.debug_trigger_hotspot_by_id("exit_to_a")); assert(scenes.get_current_scene_id() == "test_room_a")
	assert(scenes.load_scene("teahouse")); assert(await coordinator.debug_interact_npc_by_id("storyteller_zhang")); assert(graph_calls[-1].graphId == "寻狗_说书人" and state.current_state == RuntimeGameStateController.EXPLORING and not scenes.get_npc_by_id("storyteller_zhang").is_patrol_paused_for_dialogue())
	coordinator.destroy(); box.destroy(); quests.destroy(); quests.free(); rules.destroy(); rules.free(); inventory.destroy(); inventory.free(); offers.destroy(); scenes.destroy(); remove_child(scenes); scenes.free(); player.destroy_player(); state.destroy(); input.destroy(); remove_child(input); input.free(); assets.dispose(); renderer.destroy_renderer(); remove_child(renderer); renderer.free(); executor.destroy(); flags.destroy(); events.clear()
	print("InteractionCoordinator inspect/pickup/transition/npc/encounter routing test: PASS"); get_tree().quit(0)


func _close_box_later(box: RuntimeInspectBox) -> void: await get_tree().create_timer(0.12).timeout; box.close()
func _graph(request: Dictionary) -> bool: graph_calls.push_back(request.duplicate(true)); await get_tree().process_frame; return false
func _encounter(id: String) -> bool: encounter_calls.push_back(id); events_ref.emit("encounter:start", {"id": id}); await get_tree().process_frame; return true
