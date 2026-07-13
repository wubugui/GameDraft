extends Node

const RuntimeRootScript := preload("res://scripts/runtime/runtime_root.gd")
const RuntimeSnapshotScript := preload("res://scripts/core/runtime_snapshot.gd")
const RuntimeCommandBridgeScript := preload("res://scripts/core/runtime_command_bridge.gd")

var runtime_root: RuntimeRoot
var runtime_boot_id := ""
var runtime_command_bridge: RuntimeCommandBridge
var state_controller: RuntimeGameStateController
var input_manager: RuntimeInputManager
var resource_locator: RuntimeResourceLocator
var asset_manager: RuntimeAssetManager
var strings_provider: RuntimeStringsProvider
var flag_store: RuntimeFlagStore
var text_resolver: RuntimeTextResolver
var action_executor: RuntimeActionExecutor
var save_manager: RuntimeSaveManager
var quest_manager: RuntimeQuestManager
var scenario_state_manager: RuntimeScenarioStateManager
var narrative_state_manager: RuntimeNarrativeStateManager
var plane_reconciler: RuntimePlaneReconciler
var day_manager: RuntimeDayManager
var health_system: RuntimeHealthSystem
var smell_system: RuntimeSmellSystem
var archive_manager: RuntimeArchiveManager
var document_reveal_manager: RuntimeDocumentRevealManager
var scene_manager: RuntimeSceneManager
var interaction_system: RuntimeInteractionSystem
var zone_system: RuntimeZoneSystem
var graph_dialogue_manager: RuntimeGraphDialogueManager
var dialogue_manager: RuntimeDialogueManager
var encounter_manager: RuntimeEncounterManager
var audio_manager: RuntimeAudioManager
var signal_cue_manager: RuntimeSignalCueManager
var emote_bubble_manager: RuntimeEmoteBubbleManager
var cutscene_renderer: RuntimeCutsceneRenderer
var cutscene_manager: RuntimeCutsceneManager
var pressure_hold_manager: RuntimePressureHoldManager
var paper_craft_minigame_manager: RuntimePaperCraftMinigameManager
var sugar_wheel_minigame_manager: RuntimeSugarWheelMinigameManager
var water_minigame_manager: RuntimeWaterMinigameManager
var scene_depth_system: RuntimeSceneDepthSystem
var inspect_box: RuntimeInspectBox
var dialogue_ui: RuntimeDialogueUI
var encounter_ui: RuntimeEncounterUI
var pressure_hold_ui: RuntimePressureHoldUI
var shop_ui: RuntimeShopUI
var notification_ui: RuntimeNotificationUI
var pickup_notification: RuntimePickupNotification
var inventory_ui: RuntimeInventoryUI
var quest_panel_ui: RuntimeQuestPanelUI
var rules_panel_ui: RuntimeRulesPanelUI
var action_choice_ui: RuntimeActionChoiceUI
var dialogue_log_ui: RuntimeDialogueLogUI
var rule_use_ui: RuntimeRuleUseUI
var character_book_ui: RuntimeCharacterBookUI
var lore_book_ui: RuntimeLoreBookUI
var document_box_ui: RuntimeDocumentBoxUI
var book_reader_ui: RuntimeBookReaderUI
var bookshelf_ui: RuntimeBookshelfUI
var hud: RuntimeHUD
var map_ui: RuntimeMapUI
var menu_ui: RuntimeMenuUI
var debug_panel_ui: RuntimeDebugPanelUI
var dev_mode_ui: RuntimeDevModeUI
var touch_mobile_controls: RuntimeTouchMobileControls
var dialogue_event_bridge: RuntimeDialogueEventBridge
var interaction_coordinator: RuntimeInteractionCoordinator
var condition_evaluator := RuntimeConditionEvaluator.new()
var rule_offer_registry := RuntimeRuleOfferRegistry.new()
var renderer: RuntimeRenderer
var camera: RuntimeCamera
var unsubscribe_renderer_resize := Callable()
var player: RuntimePlayer
var player_portrait_slug := ""
var ambient_narrative_owner: Variant = null
var default_player_avatar: Dictionary = {}
var play_time_ms := 0.0
var has_started_session := false
var runtime_random_state := 1
var fixed_tick_mode := false


func _ready() -> void:
	runtime_boot_id = "godot-%s-%s" % [Time.get_unix_time_from_system(), get_instance_id()]
	_seed_runtime_random("gamedraft-runtime-v1")
	resource_locator = RuntimeResourceLocator.new()
	asset_manager = RuntimeAssetManager.new(resource_locator)
	renderer = RuntimeRenderer.new(); renderer.name = "Renderer"; add_child(renderer); renderer.set_asset_manager(asset_manager); renderer.init_renderer()
	camera = RuntimeCamera.new(renderer.world_container); camera.set_screen_size(renderer.get_screen_width(), renderer.get_screen_height()); unsubscribe_renderer_resize = renderer.subscribe_after_resize(Callable(self, "_on_renderer_resize"))
	strings_provider = RuntimeStringsProvider.new()
	if not strings_provider.load(asset_manager):
		push_warning("StringsProvider: strings.json not found, using key fallbacks")
	runtime_root = RuntimeRootScript.new()
	runtime_root.name = "RuntimeRoot"
	add_child(runtime_root)
	# Bootstrap mirrors Game.tick and is the sole clock owner. RuntimeRoot's standalone
	# auto-loop would otherwise advance every registered system a second time.
	runtime_root.set_automatic_updates_enabled(false)
	runtime_root.event_bus.enable_debug_trace()
	flag_store = RuntimeFlagStore.new(runtime_root.event_bus)
	var registry: Variant = asset_manager.load_json("/assets/data/flag_registry.json")
	flag_store.configure_registry(registry)
	text_resolver = RuntimeTextResolver.new()
	var game_config: Variant = asset_manager.load_json("/assets/data/game_config.json")
	if game_config is Dictionary and game_config.get("startupFlags") is Dictionary:
		for key: String in game_config.startupFlags: flag_store.set_value(key, game_config.startupFlags[key])
	if game_config is Dictionary and game_config.get("windowSize") is Dictionary: renderer.set_window_size(int(game_config.windowSize.get("width", 0)), int(game_config.windowSize.get("height", 0)))
	if game_config is Dictionary and game_config.get("viewport") is Dictionary: renderer.set_viewport_size(int(game_config.viewport.get("width", 0)), int(game_config.viewport.get("height", 0)))
	strings_provider.set_resolve_display(Callable(self, "resolve_display_text"))
	input_manager = RuntimeInputManager.new()
	input_manager.name = "InputManager"
	add_child(input_manager)
	# Edge-triggered input is cleared by _advance_runtime_tick, including explicit fixed ticks.
	# A separate natural-frame reset would drop replayed input before the deterministic tick.
	input_manager.set_process(false)
	inspect_box = RuntimeInspectBox.new(renderer, strings_provider, input_manager); inspect_box.set_resolve_display(Callable(self, "resolve_display_text"))
	state_controller = RuntimeGameStateController.new(input_manager, runtime_root.event_bus)
	action_executor = RuntimeActionExecutor.new(runtime_root.event_bus, flag_store, state_controller)
	action_executor.set_resolve_notification_text(Callable(self, "resolve_display_text"))
	action_executor.set_random_value_provider(Callable(self, "_next_runtime_random"))
	player = RuntimePlayer.new(input_manager); player.sprite.name = "Player"; renderer.entity_layer.add_child(player.sprite)
	cutscene_renderer = RuntimeCutsceneRenderer.new(renderer, camera, asset_manager)
	if not cutscene_renderer.load_overlay_defs(): push_warning("CutsceneRenderer: overlay_images.json not found")
	if game_config is Dictionary and game_config.get("playerAvatar") is Dictionary:
		var avatar: Dictionary = game_config.playerAvatar
		default_player_avatar = avatar.duplicate(true)
		player_portrait_slug = str(avatar.get("portraitSlug", "")).strip_edges()
		if player.sprite.load_from_paths(str(avatar.get("animManifest", "")), asset_manager):
			player.sprite.set_logical_state_map(avatar.get("stateMap")); player.sprite.play_animation("idle")
	runtime_root.register_system("inventoryManager", func() -> Node: return RuntimeInventoryManager.new(runtime_root.event_bus, flag_store))
	runtime_root.register_system("rulesManager", func() -> Node: return RuntimeRulesManager.new(runtime_root.event_bus, flag_store))
	runtime_root.register_system("questManager", func() -> Node: return RuntimeQuestManager.new(runtime_root.event_bus, flag_store, action_executor))
	runtime_root.register_system("scenarioStateManager", func() -> Node: return RuntimeScenarioStateManager.new(runtime_root.event_bus, flag_store))
	runtime_root.register_system("narrativeStateManager", func() -> Node: return RuntimeNarrativeStateManager.new(runtime_root.event_bus, flag_store, action_executor))
	runtime_root.register_system("planeReconciler", func() -> Node: return RuntimePlaneReconciler.new(runtime_root.event_bus))
	runtime_root.register_system("dayManager", func() -> Node: return RuntimeDayManager.new(runtime_root.event_bus, flag_store, action_executor))
	runtime_root.register_system("healthSystem", func() -> Node:
		var system := RuntimeHealthSystem.new(runtime_root.event_bus, flag_store, action_executor)
		if game_config is Dictionary: system.configure(game_config.get("health"))
		return system
	)
	runtime_root.register_system("smellSystem", func() -> Node: return RuntimeSmellSystem.new(runtime_root.event_bus, flag_store))
	runtime_root.register_system("archiveManager", func() -> Node: return RuntimeArchiveManager.new(runtime_root.event_bus, flag_store))
	runtime_root.register_system("documentRevealManager", func() -> Node: return RuntimeDocumentRevealManager.new(asset_manager, runtime_root.event_bus, flag_store, runtime_root.get_system("questManager"), runtime_root.get_system("scenarioStateManager")))
	runtime_root.register_system("dialogueManager", func() -> Node: return RuntimeDialogueManager.new(runtime_root.event_bus))
	runtime_root.register_system("audioManager", func() -> Node: return RuntimeAudioManager.new(runtime_root.event_bus))
	runtime_root.register_system("emoteBubbleManager", func() -> Node: return RuntimeEmoteBubbleManager.new())
	runtime_root.register_system("sceneManager", func() -> Node: return RuntimeSceneManager.new(asset_manager, runtime_root.event_bus, renderer, player, camera))
	runtime_root.register_system("sceneDepthSystem", func() -> Node: return RuntimeSceneDepthSystem.new())
	runtime_root.register_system("interactionSystem", func() -> Node: return RuntimeInteractionSystem.new(runtime_root.event_bus, flag_store, input_manager, condition_evaluator))
	runtime_root.register_system("zoneSystem", func() -> Node: return RuntimeZoneSystem.new(runtime_root.event_bus, flag_store, action_executor, rule_offer_registry))
	runtime_root.register_system("graphDialogueManager", func() -> Node: return RuntimeGraphDialogueManager.new(runtime_root.event_bus, flag_store, action_executor, asset_manager, runtime_root.get_system("sceneManager"), runtime_root.get_system("rulesManager"), runtime_root.get_system("questManager"), runtime_root.get_system("inventoryManager"), runtime_root.get_system("scenarioStateManager")))
	runtime_root.register_system("encounterManager", func() -> Node: return RuntimeEncounterManager.new(runtime_root.event_bus, flag_store, action_executor))
	runtime_root.register_system("signalCueManager", func() -> Node: return RuntimeSignalCueManager.new(action_executor))
	runtime_root.register_system("pressureHoldManager", func() -> Node: return RuntimePressureHoldManager.new(action_executor))
	runtime_root.register_system("paperCraftMinigameManager", func() -> Node: return RuntimePaperCraftMinigameManager.new())
	runtime_root.register_system("sugarWheelMinigameManager", func() -> Node: return RuntimeSugarWheelMinigameManager.new())
	runtime_root.register_system("waterMinigameManager", func() -> Node: return RuntimeWaterMinigameManager.new())
	runtime_root.register_system("cutsceneManager", func() -> Node: return RuntimeCutsceneManager.new(runtime_root.event_bus, flag_store, action_executor, cutscene_renderer, input_manager, asset_manager, camera, player, runtime_root.get_system("sceneManager")))
	if not runtime_root.init_runtime({"flagStore": flag_store, "strings": strings_provider, "assetManager": asset_manager}):
		push_error("Godot runtime bootstrap failed")
		return
	var inventory: RuntimeInventoryManager = runtime_root.get_system("inventoryManager")
	if not inventory.load_defs():
		push_warning("InventoryManager: items.json not found")
	var rules: RuntimeRulesManager = runtime_root.get_system("rulesManager")
	if not rules.load_defs(): push_warning("RulesManager: rules.json not found")
	quest_manager = runtime_root.get_system("questManager")
	if not quest_manager.load_defs(): push_warning("QuestManager: quests.json not found")
	action_executor.register_inventory_rule_quest_handlers(inventory, rules, quest_manager, rule_offer_registry, strings_provider)
	scenario_state_manager = runtime_root.get_system("scenarioStateManager")
	if not scenario_state_manager.load_catalog(): push_warning("ScenarioStateManager: scenarios.json not found")
	narrative_state_manager = runtime_root.get_system("narrativeStateManager")
	if not narrative_state_manager.load_from_asset(): push_warning("NarrativeStateManager: narrative_graphs.json not found")
	action_executor.register_scenario_narrative_handlers(scenario_state_manager, narrative_state_manager)
	plane_reconciler = runtime_root.get_system("planeReconciler")
	if not plane_reconciler.load_defs(): push_warning("PlaneReconciler: planes.json not found")
	action_executor.register_plane_handlers(plane_reconciler)
	health_system = runtime_root.get_system("healthSystem")
	smell_system = runtime_root.get_system("smellSystem")
	archive_manager = runtime_root.get_system("archiveManager")
	document_reveal_manager = runtime_root.get_system("documentRevealManager")
	scene_manager = runtime_root.get_system("sceneManager")
	scene_depth_system = runtime_root.get_system("sceneDepthSystem")
	interaction_system = runtime_root.get_system("interactionSystem")
	zone_system = runtime_root.get_system("zoneSystem")
	graph_dialogue_manager = runtime_root.get_system("graphDialogueManager")
	dialogue_manager = runtime_root.get_system("dialogueManager")
	encounter_manager = runtime_root.get_system("encounterManager")
	audio_manager = runtime_root.get_system("audioManager")
	emote_bubble_manager = runtime_root.get_system("emoteBubbleManager")
	signal_cue_manager = runtime_root.get_system("signalCueManager")
	pressure_hold_manager = runtime_root.get_system("pressureHoldManager")
	paper_craft_minigame_manager = runtime_root.get_system("paperCraftMinigameManager")
	sugar_wheel_minigame_manager = runtime_root.get_system("sugarWheelMinigameManager")
	water_minigame_manager = runtime_root.get_system("waterMinigameManager")
	cutscene_manager = runtime_root.get_system("cutsceneManager")
	if not encounter_manager.load_defs(): push_warning("EncounterManager: encounters.json not found")
	if not audio_manager.load_config(): push_warning("AudioManager: audio_config.json not found")
	if not signal_cue_manager.load_defs(): push_warning("SignalCueManager: signal_cues.json not found")
	if not pressure_hold_manager.load_defs(): push_warning("PressureHoldManager: pressure_holds.json not found")
	if not paper_craft_minigame_manager.load_index(): push_warning("PaperCraftMinigameManager: index.json not found")
	if not sugar_wheel_minigame_manager.load_index(): push_warning("SugarWheelMinigameManager: index.json not found")
	if not water_minigame_manager.load_index(): push_warning("WaterMinigameManager: index.json not found")
	if not cutscene_manager.load_defs(): push_warning("CutsceneManager: cutscenes/index.json not found")
	emote_bubble_manager.set_entity_attach_layer(renderer.entity_layer)
	cutscene_manager.set_runtime_support(audio_manager, emote_bubble_manager)
	cutscene_manager.set_resolve_display(Callable(self, "resolve_display_text"))
	cutscene_manager.set_scripted_speaker_resolver(Callable(self, "_resolve_scripted_speaker"))
	var narrator_label := strings_provider.get_text("dialogue", "narratorLabel")
	cutscene_manager.set_narrator_baseline("旁白" if narrator_label == "narratorLabel" or narrator_label.is_empty() else narrator_label)
	plane_reconciler.bind_runtime({
		"narrative": narrative_state_manager,
		"setPlayerMovementModifier": func(value: Variant) -> void: player.set_movement_modifier(value),
		"setPlaneInteractionPolicy": func(value: Variant) -> void: interaction_system.set_plane_interaction_policy(value),
		"refreshEntitiesForPlaneChange": func() -> void: scene_manager.refresh_entities_for_plane_change(scene_manager.get_current_scene_id()),
		"refreshZonesForPlaneChange": func() -> void: scene_manager.refresh_zones_for_plane_change(scene_manager.get_current_scene_id()),
		"setCameraZoom": func(zoom: Variant) -> void:
			if zoom is int or zoom is float: camera.set_zoom(float(zoom)),
		"restoreSceneCameraZoom": func() -> void: camera.set_zoom(_get_camera_baseline_zoom()),
		"applyPlaneLightEnvOverride": func(value: Variant) -> void: scene_depth_system.apply_light_env_override(value),
		"damagePlayer": func(amount: int) -> void: health_system.damage(float(amount)),
		"getGameState": func() -> String: return state_controller.current_state,
	})
	scene_manager.set_active_plane_getter(func() -> Dictionary: return {"id": plane_reconciler.get_active_plane_id(), "membership": plane_reconciler.get_active_plane_membership()})
	day_manager = runtime_root.get_system("dayManager")
	var condition_factory := func() -> Dictionary: return build_condition_eval_context()
	flag_store.set_condition_eval_context_factory(condition_factory)
	inventory.set_condition_eval_context_factory(condition_factory)
	quest_manager.set_condition_eval_context_factory(condition_factory)
	narrative_state_manager.set_condition_eval_context_factory(condition_factory)
	archive_manager.set_condition_eval_context_factory(condition_factory)
	archive_manager.set_resolve_for_display(Callable(self, "resolve_display_text"))
	if not archive_manager.load_defs(): push_warning("ArchiveManager: archive data not found")
	action_executor.add_post_action_hook(Callable(archive_manager, "flush_scheduled_unlock_evaluation"))
	document_reveal_manager.set_condition_eval_context_factory(condition_factory)
	document_reveal_manager.set_resolve_condition_literal(Callable(self, "resolve_display_text"))
	if not document_reveal_manager.load_definitions(): push_warning("DocumentRevealManager: definitions not found")
	action_executor.register_wellbeing_handlers(day_manager, archive_manager, health_system, smell_system, document_reveal_manager)
	graph_dialogue_manager.set_condition_eval_context_factory(condition_factory); graph_dialogue_manager.set_resolve_display(Callable(self, "resolve_display_text")); graph_dialogue_manager.set_player_portrait_slug_provider(func() -> String: return player_portrait_slug)
	encounter_manager.set_condition_eval_context_factory(condition_factory); encounter_manager.set_resolve_display(Callable(self, "resolve_display_text")); encounter_manager.set_rule_name_resolver(func(id: String) -> Variant: return rules.get_rule_def(id))
	interaction_system.set_condition_eval_context_factory(condition_factory); interaction_system.set_player_position_getter(func() -> Dictionary: return {"x": player.get_x(), "y": player.get_y()}); interaction_system.set_update_enabled_getter(func() -> bool: return state_controller.current_state == RuntimeGameStateController.EXPLORING); interaction_system.set_entity_base_visibility_readers(Callable(scene_manager, "get_hotspot_base_enabled_for_interaction"), Callable(scene_manager, "get_npc_base_visible_for_interaction")); scene_manager.set_interaction_setter(Callable(interaction_system, "set_entities"))
	zone_system.set_condition_eval_context_factory(condition_factory); zone_system.set_player_position_getter(func() -> Dictionary: return {"x": player.get_x(), "y": player.get_y()}); zone_system.set_update_enabled_getter(func() -> bool: return state_controller.current_state == RuntimeGameStateController.EXPLORING); scene_manager.set_zone_setter(Callable(zone_system, "set_zones")); scene_manager.set_zone_actions_waiter(Callable(zone_system, "wait_for_actions_idle"))
	runtime_root.event_bus.on("scene:ready", Callable(self, "_on_scene_ready_runtime_sync"))
	scene_manager.set_audio_applier(Callable(audio_manager, "apply_scene_audio"))
	scene_manager.set_scene_depth_system(scene_depth_system)
	scene_depth_system.bind_runtime(scene_manager, player, Callable(self, "evaluate_runtime_conditions"))
	action_executor.register_entity_handlers(scene_manager, player)
	action_executor.register_scene_camera_handlers(scene_manager, camera, Callable(self, "_get_camera_baseline_zoom"))
	action_executor.register_graph_dialogue_handler(graph_dialogue_manager, scene_manager, Callable(self, "get_ambient_narrative_owner"))
	action_executor.register_scripted_dialogue_handler(Callable(self, "play_scripted_dialogue_from_action"))
	action_executor.register_encounter_handler(encounter_manager)
	action_executor.register_audio_handlers(audio_manager, signal_cue_manager)
	action_executor.register_cutscene_handler(cutscene_manager)
	action_executor.register_pressure_hold_handler(pressure_hold_manager)
	action_executor.register_paper_craft_handler(paper_craft_minigame_manager)
	action_executor.register_sugar_wheel_handlers(sugar_wheel_minigame_manager)
	action_executor.register_water_minigame_handler(water_minigame_manager)
	action_executor.register_debug_alert_handler(Callable(self, "_show_debug_action_params"))
	action_executor.register_cutscene_actor_handlers(cutscene_manager, emote_bubble_manager, scene_manager, player, Callable(self, "_get_camera_baseline_zoom"))
	action_executor.register_wait_click_handler(input_manager, renderer)
	action_executor.register_player_avatar_handlers(Callable(self, "apply_player_avatar"), Callable(self, "reset_player_avatar"))
	dialogue_ui = RuntimeDialogueUI.new(renderer, runtime_root.event_bus, strings_provider, asset_manager, input_manager)
	runtime_root.event_bus.on("dialogue:line", Callable(self, "_on_dialogue_line_speaking_bubble"))
	runtime_root.event_bus.on("dialogue:end", Callable(self, "_clear_dialogue_speaking_bubble"))
	runtime_root.event_bus.on("dialogue:hidePanel", Callable(self, "_clear_dialogue_speaking_bubble"))
	encounter_ui = RuntimeEncounterUI.new(renderer, runtime_root.event_bus, strings_provider, input_manager)
	pressure_hold_ui = RuntimePressureHoldUI.new(renderer, strings_provider, input_manager)
	shop_ui = RuntimeShopUI.new(renderer, runtime_root.event_bus, inventory, strings_provider, asset_manager)
	shop_ui.set_resolve_display(Callable(self, "resolve_display_text"))
	if not shop_ui.load_defs(): push_warning("ShopUI: shops.json not found")
	runtime_root.event_bus.on("shop:purchase", Callable(self, "_on_shop_purchase"))
	runtime_root.event_bus.on("shop:closed", Callable(self, "_on_shop_closed"))
	action_executor.register_shop_depth_handlers(shop_ui, scene_depth_system)
	notification_ui = RuntimeNotificationUI.new(renderer, runtime_root.event_bus)
	pickup_notification = RuntimePickupNotification.new(renderer, strings_provider)
	action_executor.set_pickup_notification(Callable(pickup_notification, "show"))
	inventory_ui = RuntimeInventoryUI.new(renderer, runtime_root.event_bus, inventory, strings_provider); inventory_ui.set_resolve_display(Callable(self, "resolve_display_text"))
	quest_panel_ui = RuntimeQuestPanelUI.new(renderer, quest_manager, strings_provider); quest_panel_ui.set_resolve_display(Callable(self, "resolve_display_text"))
	rules_panel_ui = RuntimeRulesPanelUI.new(renderer, rules, strings_provider); rules_panel_ui.set_resolve_display(Callable(self, "resolve_display_text"))
	state_controller.register_panel("quest", quest_panel_ui, "Tab")
	state_controller.register_panel("inventory", inventory_ui, "KeyI")
	state_controller.register_panel("rules", rules_panel_ui, "KeyR")
	runtime_root.event_bus.on("inventory:discard", Callable(self, "_on_inventory_discard"))
	action_choice_ui = RuntimeActionChoiceUI.new(renderer, strings_provider, input_manager); action_executor.set_choose_action(Callable(action_choice_ui, "choose"))
	dialogue_log_ui = RuntimeDialogueLogUI.new(renderer, runtime_root.event_bus, strings_provider); dialogue_log_ui.set_resolve_display(Callable(self, "resolve_display_text")); state_controller.register_panel("dialogueLog", dialogue_log_ui, "KeyL")
	rule_use_ui = RuntimeRuleUseUI.new(renderer, runtime_root.event_bus, zone_system, rules, strings_provider); rule_use_ui.set_resolve_display(Callable(self, "resolve_display_text")); state_controller.register_panel("ruleUse", rule_use_ui, "KeyF")
	runtime_root.event_bus.on("ruleUse:apply", Callable(self, "_on_rule_use_apply"))
	character_book_ui = RuntimeCharacterBookUI.new(renderer, archive_manager, strings_provider); character_book_ui.set_resolve_display(Callable(self, "resolve_display_text"))
	lore_book_ui = RuntimeLoreBookUI.new(renderer, archive_manager, strings_provider); lore_book_ui.set_resolve_display(Callable(self, "resolve_display_text"))
	document_box_ui = RuntimeDocumentBoxUI.new(renderer, archive_manager, strings_provider); document_box_ui.set_resolve_display(Callable(self, "resolve_display_text"))
	book_reader_ui = RuntimeBookReaderUI.new(renderer, archive_manager, strings_provider); book_reader_ui.set_resolve_display(Callable(self, "resolve_display_text"))
	bookshelf_ui = RuntimeBookshelfUI.new(renderer, archive_manager, strings_provider, character_book_ui, lore_book_ui, document_box_ui, book_reader_ui, func() -> void: state_controller.toggle_panel("rules")); bookshelf_ui.set_resolve_display(Callable(self, "resolve_display_text")); state_controller.register_panel("bookshelf", bookshelf_ui, "KeyB")
	runtime_root.event_bus.on("archive:firstView", Callable(self, "_on_archive_first_view"))
	var smell_profiles: Variant = asset_manager.load_json("/assets/data/smell_profiles.json")
	hud = RuntimeHUD.new(renderer, runtime_root.event_bus, strings_provider, smell_profiles if smell_profiles is Dictionary else {})
	hud.set_resolve_display(Callable(self, "resolve_display_text"))
	hud.set_active_quests(quest_manager.get_active_quests())
	map_ui = RuntimeMapUI.new(renderer, runtime_root.event_bus, asset_manager, strings_provider)
	map_ui.set_resolve_display(Callable(self, "resolve_display_text"))
	map_ui.set_condition_evaluator(Callable(self, "evaluate_runtime_conditions"))
	if not map_ui.load_config():
		push_warning("MapUI: map_config.json not found")
	state_controller.register_panel("map", map_ui, "KeyM", {"openGuard": Callable(self, "_guard_map_travel")})
	runtime_root.event_bus.on("map:travel", Callable(self, "_on_map_travel")); runtime_root.event_bus.on("scene:enter", Callable(self, "_on_map_scene_enter"))
	pressure_hold_manager.bind_runtime({
		"resolveDisplayText": Callable(self, "resolve_display_text"),
		"runSegment": Callable(self, "_run_pressure_hold_segment"),
		"cancelSegment": Callable(pressure_hold_ui, "cancel"),
	})
	paper_craft_minigame_manager.bind_runtime({"renderer": renderer, "inputManager": input_manager, "stateController": state_controller, "actionExecutor": action_executor, "resolveDisplayText": Callable(self, "resolve_display_text")})
	sugar_wheel_minigame_manager.bind_runtime({"renderer": renderer, "inputManager": input_manager, "stateController": state_controller, "actionExecutor": action_executor, "resolveDisplayText": Callable(self, "resolve_display_text"), "playSfx": Callable(audio_manager, "play_sfx"), "evaluateBeforeChargeCondition": Callable(self, "_evaluate_sugar_wheel_condition")})
	water_minigame_manager.bind_runtime({"renderer": renderer, "inputManager": input_manager, "stateController": state_controller, "actionExecutor": action_executor, "dayManager": day_manager, "resolveDisplayText": Callable(self, "resolve_display_text")})
	dialogue_event_bridge = RuntimeDialogueEventBridge.new(runtime_root.event_bus, graph_dialogue_manager, dialogue_manager, encounter_manager, state_controller)
	interaction_coordinator = RuntimeInteractionCoordinator.new(runtime_root.event_bus, state_controller, scene_manager, action_executor, inspect_box, player, camera); interaction_coordinator.init()
	interaction_coordinator.set_graph_dialogue_starter(Callable(graph_dialogue_manager, "start_dialogue_graph"))
	if get_meta("suppressSceneOnEnter", false) != true: scene_manager.set_scene_enter_runner(Callable(self, "run_scene_enter_actions"))
	var initial_scene := str(game_config.get("initialScene", "dev_room")) if game_config is Dictionary else "dev_room"
	var parity_scene := _command_line_option("parity-start-scene")
	if not parity_scene.is_empty(): initial_scene = parity_scene
	elif game_config is Dictionary:
		var initial_quest := str(game_config.get("initialQuest", "")).strip_edges()
		if not initial_quest.is_empty(): quest_manager.accept_quest(initial_quest)
	if not scene_manager.load_scene(initial_scene): push_error("SceneManager: initial scene failed: %s" % initial_scene)
	else: await scene_manager.wait_for_current_scene_entry()
	save_manager = RuntimeSaveManager.new(
		Callable(self, "collect_save_data"),
		Callable(self, "distribute_save_data"),
		Callable(self, "reload_saved_scene"),
		strings_provider,
		initial_scene,
	)
	save_manager.set_can_save_predicate(func() -> bool:
		return state_controller.current_state in [RuntimeGameStateController.EXPLORING, RuntimeGameStateController.UI_OVERLAY]
	)
	menu_ui = RuntimeMenuUI.new(renderer, runtime_root.event_bus, save_manager, audio_manager, strings_provider); state_controller.register_panel("menu", menu_ui); state_controller.set_escape_fallback(func() -> void: state_controller.toggle_panel("menu"))
	runtime_root.event_bus.on("menu:newGame", Callable(self, "_on_menu_new_game")); runtime_root.event_bus.on("menu:returnToMain", Callable(self, "_on_menu_return_to_main")); runtime_root.event_bus.on("menu:resume", Callable(self, "_on_menu_resume"))
	debug_panel_ui = RuntimeDebugPanelUI.new(renderer, strings_provider, Callable(self, "_build_debug_system_info"))
	debug_panel_ui.add_section("叙事调试", func() -> String: return JSON.stringify(narrative_state_manager.serialize(), "  "))
	debug_panel_ui.add_section("场景", func() -> String: return JSON.stringify(scene_manager.serialize(), "  "))
	state_controller.register_panel("debug", debug_panel_ui, "F2", {"alwaysOpenable": true, "overlaysGameState": false})
	dev_mode_ui = RuntimeDevModeUI.new(renderer, strings_provider, {
		"getCutsceneIds": func() -> Array: return cutscene_manager.get_cutscene_ids(),
		"playCutscene": Callable(self, "_dev_play_cutscene"),
		"getScenes": Callable(self, "_get_dev_scene_entries"),
		"loadScene": Callable(self, "_dev_load_scene"),
		"reload": Callable(self, "_dev_reload"),
		"getMinigameEntries": Callable(self, "_get_dev_minigame_entries"),
		"launchMinigame": Callable(self, "_dev_launch_minigame"),
		"getNarrativeWarps": Callable(self, "_get_narrative_warp_entries"),
		"enterNarrativeWarp": Callable(self, "_enter_narrative_warp"),
	})
	state_controller.register_panel("devMode", dev_mode_ui, "F3", {"alwaysOpenable": true})
	touch_mobile_controls = RuntimeTouchMobileControls.new(renderer, input_manager, state_controller, strings_provider)
	runtime_command_bridge = RuntimeCommandBridgeScript.new()
	runtime_command_bridge.bind(Callable(self, "build_runtime_debug_snapshot"), runtime_boot_id, Callable(self, "apply_parity_runtime_command"))
	add_child(runtime_command_bridge)
	await _try_start_initial_prologue(game_config if game_config is Dictionary else {})


func build_runtime_debug_snapshot(reason: String, last_results: Array = []) -> Dictionary:
	return RuntimeSnapshotScript.capture(runtime_root, reason, runtime_boot_id, last_results, {
		"currentSceneId": scene_manager.get_current_scene_id() if scene_manager != null else null,
		"gameState": state_controller.current_state,
		"previousGameState": state_controller.previous_state,
		"flags": flag_store.serialize(),
		"questState": quest_manager.serialize() if quest_manager != null else {},
		"scenarioState": scenario_state_manager.serialize() if scenario_state_manager != null else {},
		"narrativeEval": graph_dialogue_manager.get_narrative_eval_debug() if graph_dialogue_manager != null else {},
		"narrativeState": narrative_state_manager.debug_snapshot() if narrative_state_manager != null else {},
		"documentReveals": document_reveal_manager.debug_snapshot() if document_reveal_manager != null else {},
		"eventTrace": runtime_root.event_bus.get_debug_trace(),
		"saveData": collect_save_data(),
		"runtimeRandomState": runtime_random_state,
		"activeZones": _sorted_strings(zone_system.get_active_zone_ids()) if zone_system != null else [],
		"uiState": state_controller.debug_snapshot() if state_controller != null else {"overlayReturnStack": [], "openPanels": []},
		"hudVisualState": hud.get_debug_visual_state() if fixed_tick_mode and hud != null else null,
		"renderState": _build_render_state(),
		"entityVisualState": {
			"player": {
				"x": player.get_x(),
				"y": player.get_y(),
				"visible": player.sprite.visible,
				"animation": player.sprite.get_debug_visual_state(),
			} if player != null else null,
			"npcs": scene_manager.get_debug_entity_visual_state() if scene_manager != null else [],
		} if fixed_tick_mode else null,
		"audioState": {
			"currentBgmId": audio_manager.get_requested_bgm_id() if audio_manager != null else null,
			"ambientIds": _sorted_strings(audio_manager.get_requested_ambient_ids()) if audio_manager != null else [],
			"volumes": audio_manager.serialize() if audio_manager != null else {},
		},
		"inFlight": {
			"runtimeReady": true,
			"fixedTickMode": fixed_tick_mode,
			"sceneSwitching": scene_manager.is_switching() if scene_manager != null else false,
			"actionPolicyDepth": action_executor.policy_depth() if action_executor != null else 0,
			"cutscene": cutscene_manager.is_playing() if cutscene_manager != null else false,
			"graphDialogue": graph_dialogue_manager.is_active() if graph_dialogue_manager != null else false,
			"scriptedDialogue": dialogue_manager.is_active() if dialogue_manager != null else false,
			"encounter": encounter_manager.is_active() if encounter_manager != null else false,
			"waterMinigame": water_minigame_manager.is_active() if water_minigame_manager != null else false,
			"sugarWheelMinigame": sugar_wheel_minigame_manager.is_active() if sugar_wheel_minigame_manager != null else false,
			"paperCraftMinigame": paper_craft_minigame_manager.is_active() if paper_craft_minigame_manager != null else false,
			"pressureHold": pressure_hold_ui.is_active() if pressure_hold_ui != null else false,
		},
		"dialogue": graph_dialogue_manager.get_debug_interaction_state() if graph_dialogue_manager != null else {},
		"dialogueView": graph_dialogue_manager.get_dialogue_view_debug() if graph_dialogue_manager != null else {},
		"minigameDebug": {
			"water": water_minigame_manager.get_debug_visual_state() if water_minigame_manager != null else null,
			"sugarWheel": sugar_wheel_minigame_manager.get_debug_visual_state() if sugar_wheel_minigame_manager != null else null,
			"paperCraft": paper_craft_minigame_manager.get_debug_visual_state() if paper_craft_minigame_manager != null else null,
			"pressureHold": pressure_hold_ui.get_debug_visual_state() if pressure_hold_ui != null else null,
		},
		"player": {"x": player.get_x(), "y": player.get_y(), "facing": player.get_facing_direction()} if player != null else {"x": 0.0, "y": 0.0, "facing": "right"},
		"planes": plane_reconciler.get_debug_state() if plane_reconciler != null else {},
		"inventory": runtime_root.get_system("inventoryManager").serialize() if runtime_root.get_system("inventoryManager") != null else {},
		"interactables": interaction_system.debug_list_interactables(player.get_x(), player.get_y()) if interaction_system != null and player != null else [],
		"playerView": _build_player_view(),
	})


func _sorted_strings(values: Array) -> Array[String]:
	var result: Array[String] = []
	for value: Variant in values: result.push_back(str(value))
	result.sort()
	return result


func _build_render_state() -> Dictionary:
	var result := renderer.get_debug_render_state() if renderer != null else {}
	if scene_manager != null: result.merge(scene_manager.get_debug_render_state(), true)
	return result


func _on_dialogue_line_speaking_bubble(line: Variant) -> void:
	_clear_dialogue_speaking_bubble()
	if not line is Dictionary or not line.get("speakerEntity") is Dictionary: return
	var speaker_entity: Dictionary = line.speakerEntity; var anchor: Variant = null
	if speaker_entity.get("kind") == "player": anchor = player
	elif speaker_entity.get("kind") == "npc": anchor = scene_manager.get_npc_by_id(str(speaker_entity.get("npcId", "")))
	if anchor != null: emote_bubble_manager.show_sticky(anchor, "……", {}, "dialogue-speaking")


func _clear_dialogue_speaking_bubble(_payload: Variant = null) -> void:
	if emote_bubble_manager != null: emote_bubble_manager.cleanup_by_owner("dialogue-speaking")


func apply_parity_runtime_command(command: Dictionary) -> Dictionary:
	var id := str(command.get("id", "runtime-command")); var type := str(command.get("type", "")); var ok := true; var message := "ok"
	match type:
		"debugClearEventTrace":
			runtime_root.event_bus.clear_debug_trace(); message = "event trace cleared"
		"debugExecuteAction":
			var raw_action: Variant = command.get("action")
			ok = raw_action is Dictionary and not str(raw_action.get("type", "")).strip_edges().is_empty()
			if ok: ok = await action_executor.execute_await(raw_action)
			message = "action executed: %s" % raw_action.get("type", "") if ok else "action rejected"
		"debugSetFixedTickMode":
			fixed_tick_mode = command.get("enabled", true) != false
			set_process(not fixed_tick_mode)
			if fixed_tick_mode:
				if hud != null: hud.reset_animation_clock()
				if player != null: player.sprite.reset_animation_clock()
				if scene_manager != null: scene_manager.reset_entity_animation_clocks()
			message = "fixed tick mode %s" % ("enabled" if fixed_tick_mode else "disabled")
		"debugStepTicks":
			var tick_count := clampi(int(command.get("ticks", 1)), 1, 200)
			var tick_dt := clampf(float(command.get("dtMs", 1000.0 / 60.0)) / 1000.0, 0.001, 0.1)
			for _tick_index: int in range(tick_count): _advance_runtime_tick(tick_dt)
			RenderingServer.force_draw()
			message = "stepped %s fixed tick(s)" % tick_count
		"setFlag":
			var key := str(command.get("key", "")).strip_edges(); ok = not key.is_empty() and flag_store.is_key_allowed_by_registry(key) and flag_store.set_value(key, command.get("value")); message = "flag set" if ok else "flag rejected"
		"emitNarrativeSignal":
			var signal_name := str(command.get("signal", "")).strip_edges(); ok = not signal_name.is_empty(); if ok: await narrative_state_manager.emit_narrative_signal({"signal": signal_name, "sourceType": str(command.get("sourceType", "parity")), "sourceId": str(command.get("sourceId", "runner"))}); message = "signal emitted" if ok else "signal rejected"
		"debugSetPlayerPosition":
			var x: Variant = command.get("x"); var y: Variant = command.get("y")
			ok = (x is int or x is float) and (y is int or y is float) and is_finite(float(x)) and is_finite(float(y))
			if ok:
				player.set_x(float(x)); player.set_y(float(y))
				if command.get("snapCamera", true) != false: camera.snap_to(float(x), float(y))
				interaction_system.update(0.0); zone_system.update(0.0)
				ok = await zone_system.wait_for_actions_idle()
			message = "player position set" if ok else "position rejected"
		"debugWait":
			var wait_ms := clampi(int(command.get("durationMs", 500)), 1, 60000); await get_tree().create_timer(float(wait_ms) / 1000.0).timeout; message = "waited for debug"
		"debugStartDialogueGraph":
			var graph_id := str(command.get("graphId", "")).strip_edges(); ok = not graph_id.is_empty(); if ok: await graph_dialogue_manager.start_dialogue_graph({"graphId": graph_id, "entry": str(command.get("entry", "")), "npcName": str(command.get("npcName", graph_id)), "npcId": str(command.get("npcId", "")), "ownerType": str(command.get("ownerType", "")), "ownerId": str(command.get("ownerId", ""))}); message = "dialogue graph started for debug" if ok else "dialogue graph rejected"
		"debugAdvanceDialogue":
			await graph_dialogue_manager.debug_advance_until_blocking(clampi(int(command.get("maxSteps", 24)), 1, 200)); message = "dialogue advanced for debug"
		"debugChooseDialogueOption":
			var choice_params := {}
			if command.has("index"): choice_params["index"] = int(command.index)
			if command.has("text"): choice_params["text"] = str(command.text)
			ok = await graph_dialogue_manager.debug_choose_option(choice_params)
			message = "dialogue option chosen for debug" if ok else "dialogue option rejected"
		"debugSwitchScene":
			var target_scene := str(command.get("sceneId", "")).strip_edges(); ok = not target_scene.is_empty() and await action_executor.execute_await({"type": "switchScene", "params": {"targetScene": target_scene, "targetSpawnPoint": str(command.get("spawnPoint", ""))}}) and scene_manager.get_current_scene_id() == target_scene; if ok: interaction_system.update(0.0); zone_system.update(0.0); ok = await zone_system.wait_for_actions_idle() and ok; message = "scene switched" if ok else "scene switch failed"
		"activatePlane":
			ok = plane_reconciler.activate_plane_manually(str(command.get("planeId", ""))); message = "plane activated" if ok else "plane rejected"
		"deactivatePlane":
			plane_reconciler.deactivate_manual_plane(); message = "plane deactivated"
		"debugSaveGame":
			ok = save_manager.save(int(command.get("slot", 2))); message = "game saved" if ok else "save failed"
		"debugLoadGame":
			ok = await save_manager.load(int(command.get("slot", 2))); if ok: interaction_system.update(0.0); zone_system.update(0.0); ok = await zone_system.wait_for_actions_idle() and ok; message = "game loaded" if ok else "load failed"
		_:
			ok = false; message = "unsupported runtime command: %s" % type
	return {"id": id, "type": type, "ok": ok, "message": message}


func _build_player_view() -> Dictionary:
	var state := str(state_controller.current_state) if state_controller != null else RuntimeGameStateController.MAIN_MENU
	var mode := str({
		RuntimeGameStateController.MAIN_MENU: "menu",
		RuntimeGameStateController.EXPLORING: "exploring",
		RuntimeGameStateController.ACTION_SEQUENCE: "busy",
		RuntimeGameStateController.DIALOGUE: "dialogue",
		RuntimeGameStateController.ENCOUNTER: "encounter",
		RuntimeGameStateController.CUTSCENE: "cutscene",
		RuntimeGameStateController.UI_OVERLAY: "menu",
		RuntimeGameStateController.MINIGAME: "minigame",
	}.get(state, state))
	var scene: Variant = scene_manager.get_current_scene_data() if scene_manager != null else null
	var player_state := {"x": player.get_x(), "y": player.get_y(), "facing": player.get_facing_direction()} if player != null else {"x": 0.0, "y": 0.0, "facing": "right"}
	var inventory: RuntimeInventoryManager = runtime_root.get_system("inventoryManager") if runtime_root != null else null
	return {
		"mode": mode,
		"scene": str(scene.get("name", scene.get("id", ""))) if scene is Dictionary else null,
		"player": player_state,
		"entities": interaction_system.get_player_visible_entities() if interaction_system != null else [],
		"interactionPrompt": interaction_system.get_nearest_prompt() if interaction_system != null else null,
		"dialogue": graph_dialogue_manager.get_player_dialogue() if graph_dialogue_manager != null else null,
		"hud": {"coins": inventory.get_coins() if inventory != null else 0.0, "questTracker": hud.quest.text if hud != null and hud.quest != null else ""},
		"navTargetActive": false,
	}


func _command_line_option(name: String) -> String:
	var prefix := "--%s=" % name
	for argument: String in OS.get_cmdline_user_args():
		if argument.begins_with(prefix): return argument.trim_prefix(prefix).strip_edges()
	return ""


func resolve_display_text(raw: String) -> String:
	var inventory: RuntimeInventoryManager = runtime_root.get_system("inventoryManager")
	var rules: RuntimeRulesManager = runtime_root.get_system("rulesManager")
	return text_resolver.resolve_text(raw, {
		"stringsRaw": Callable(strings_provider, "get_raw"),
		"flagStore": flag_store,
		"itemNames": inventory.get_item_name_map() if inventory != null else {},
		"npcName": func(id: String) -> Variant:
			var npc: Variant = scene_manager.get_npc_by_id(id) if scene_manager != null else null
			return npc.def.get("name") if npc != null else null,
		"playerDisplayName": func() -> String:
			var value: Variant = flag_store.get_value("player_display_name")
			return value.strip_edges() if value is String and not value.strip_edges().is_empty() else strings_provider.get_raw("dialogue", "defaultProtagonistName"),
		"questTitle": func(id: String) -> Variant: return quest_manager.get_quest_title(id) if quest_manager != null else null,
		"ruleName": func(id: String) -> Variant:
			var definition: Variant = rules.get_rule_def(id) if rules != null else null
			return definition.get("name") if definition is Dictionary else null,
		"sceneDisplayName": func(id: String) -> Variant: return scene_manager.resolve_scene_display_name(id) if scene_manager != null else null,
		"contextNpcId": graph_dialogue_manager.get_context_npc_id() if graph_dialogue_manager != null else "",
	})


func get_ambient_narrative_owner() -> Variant:
	return ambient_narrative_owner


func run_scene_enter_actions(actions: Array, scene_id: String) -> void:
	var previous: Variant = ambient_narrative_owner
	ambient_narrative_owner = {"ownerType": "scene", "ownerId": scene_id}
	await action_executor.execute_batch_await(actions)
	ambient_narrative_owner = previous


func apply_player_avatar(anim_manifest: String, state_map: Variant = null, portrait_slug: String = "") -> bool:
	var path := anim_manifest.strip_edges()
	if path.is_empty() or not player.sprite.load_from_paths(path, asset_manager): return false
	player.sprite.set_logical_state_map(state_map if state_map is Dictionary else null); player.sprite.play_animation("idle")
	player_portrait_slug = portrait_slug if not portrait_slug.is_empty() else RuntimeNpc.portrait_slug_from_anim_file(path)
	return true


func reset_player_avatar() -> bool:
	if default_player_avatar.is_empty(): return false
	return apply_player_avatar(str(default_player_avatar.get("animManifest", "")), default_player_avatar.get("stateMap"), str(default_player_avatar.get("portraitSlug", "")))


func resolve_display_text_for_scripted(raw: String, scripted_npc_id: String) -> String:
	var graph_npc := graph_dialogue_manager.get_context_npc_id() if graph_dialogue_manager != null else ""
	var context_id := graph_npc if not graph_npc.is_empty() else scripted_npc_id.strip_edges()
	var inventory: RuntimeInventoryManager = runtime_root.get_system("inventoryManager")
	var rules: RuntimeRulesManager = runtime_root.get_system("rulesManager")
	return text_resolver.resolve_text(raw, {
		"stringsRaw": Callable(strings_provider, "get_raw"),
		"flagStore": flag_store,
		"itemNames": inventory.get_item_name_map(),
		"npcName": func(id: String) -> Variant:
			var npc: Variant = scene_manager.get_npc_by_id(id)
			return npc.def.get("name") if npc != null else null,
		"playerDisplayName": func() -> String:
			var value: Variant = flag_store.get_value("player_display_name")
			return value.strip_edges() if value is String and not value.strip_edges().is_empty() else strings_provider.get_raw("dialogue", "defaultProtagonistName"),
		"questTitle": func(id: String) -> Variant: return quest_manager.get_quest_title(id),
		"ruleName": func(id: String) -> Variant:
			var definition: Variant = rules.get_rule_def(id)
			return definition.get("name") if definition is Dictionary else null,
		"sceneDisplayName": func(id: String) -> Variant: return scene_manager.resolve_scene_display_name(id),
		"contextNpcId": context_id,
	})


func play_scripted_dialogue_from_action(params: Dictionary) -> bool:
	var raw: Variant = params.get("lines")
	if not raw is Array or raw.is_empty(): return false
	var scripted_npc_id := str(params.get("scriptedNpcId", "")).strip_edges()
	var narrator := strings_provider.get_text("dialogue", "narratorLabel")
	if narrator == "narratorLabel" or narrator.is_empty(): narrator = "旁白"
	var narrator_resolved := resolve_display_text_for_scripted(narrator, scripted_npc_id)
	var lines: Array = []
	for item: Variant in raw:
		if not item is Dictionary: continue
		var text := str(item.get("text", "")).strip_edges()
		if text.is_empty(): continue
		var speaker_raw := str(item.get("speaker", "")).strip_edges()
		var speaker_value := _resolve_scripted_speaker(speaker_raw, scripted_npc_id) if not speaker_raw.is_empty() else narrator
		var split := text_resolver.apply_dialogue_colon_speaker(resolve_display_text_for_scripted(speaker_value, scripted_npc_id), resolve_display_text_for_scripted(text, scripted_npc_id), narrator_resolved)
		var line := {"speaker": split.speaker, "text": split.text, "tags": []}
		var entity: Variant = _resolve_scripted_speaker_entity(speaker_raw, scripted_npc_id)
		if entity is Dictionary: line.speakerEntity = entity
		var portrait: Variant = _resolve_scripted_portrait(item.get("portrait"), entity)
		if portrait is Dictionary: line.portrait = portrait
		if params.get("dimBackground") == true: line.dim = true
		lines.push_back(line)
	if lines.is_empty(): return false
	state_controller.set_state(RuntimeGameStateController.DIALOGUE)
	return await dialogue_manager.play_and_wait(lines, graph_dialogue_manager.is_active())


func _resolve_scripted_speaker(raw: String, scripted_npc_id: String) -> String:
	var graph_npc := graph_dialogue_manager.get_context_npc_id() if graph_dialogue_manager != null else ""
	var output := ""
	var offset := 0
	while offset < raw.length():
		var start := raw.find("{{", offset)
		if start < 0:
			output += raw.substr(offset)
			break
		output += raw.substr(offset, start - offset)
		var end := raw.find("}}", start + 2)
		if end < 0:
			output += raw.substr(start)
			break
		var inner := raw.substr(start + 2, end - start - 2)
		var parts := inner.strip_edges().split(":")
		var kind := str(parts[0]).strip_edges().to_lower() if not parts.is_empty() else ""
		offset = end + 2
		if kind == "player":
			var value: Variant = flag_store.get_value("player_display_name")
			output += value.strip_edges() if value is String and not value.strip_edges().is_empty() else strings_provider.get_text("dialogue", "defaultProtagonistName")
		elif kind == "npc":
			var wanted := str(parts[1]).strip_edges() if parts.size() > 1 else ""
			var id := (graph_npc if not graph_npc.is_empty() else scripted_npc_id) if wanted.is_empty() or wanted == "@context" else wanted
			var npc: Variant = scene_manager.get_npc_by_id(id)
			output += str(npc.def.get("name", id)) if npc != null else (id if not id.is_empty() else "…")
		else: output += "{{%s}}" % inner
	return output


func _resolve_scripted_speaker_entity(raw: String, scripted_npc_id: String) -> Variant:
	var start := raw.find("{{")
	if start < 0: return null
	var end := raw.find("}}", start + 2)
	if end < 0: return null
	var parts := raw.substr(start + 2, end - start - 2).split(":")
	var kind := str(parts[0]).strip_edges().to_lower() if not parts.is_empty() else ""
	if kind == "player": return {"kind": "player"}
	if kind == "npc":
		var wanted := str(parts[1]).strip_edges() if parts.size() > 1 else ""
		var graph_npc := graph_dialogue_manager.get_context_npc_id() if graph_dialogue_manager != null else ""
		var id := (graph_npc if not graph_npc.is_empty() else scripted_npc_id) if wanted.is_empty() or wanted == "@context" else wanted
		if not id.is_empty(): return {"kind": "npc", "npcId": id}
	return null


func _resolve_scripted_portrait(raw: Variant, entity: Variant) -> Variant:
	if not raw is Dictionary: return null
	var emotion := str(raw.get("emotion", "")).strip_edges()
	if emotion.is_empty(): return null
	var slug := str(raw.get("slug", "")).strip_edges()
	if slug.is_empty() and entity is Dictionary:
		if entity.get("kind") == "player": slug = player_portrait_slug
		elif entity.get("kind") == "npc":
			var npc: Variant = scene_manager.get_npc_by_id(str(entity.get("npcId", "")))
			if npc != null: slug = npc.get_current_portrait_slug()
	return {"slug": slug, "emotion": emotion} if not slug.is_empty() else null


func build_condition_eval_context() -> Dictionary:
	return {
		"flagStore": flag_store,
		"questManager": quest_manager,
		"scenarioState": scenario_state_manager,
		"narrativeState": narrative_state_manager,
		"getActivePlaneId": func() -> String: return plane_reconciler.get_active_plane_id() if plane_reconciler != null else "normal",
		"resolveConditionLiteral": func(value: String) -> String: return resolve_display_text(value),
		"evaluateList": Callable(self, "evaluate_runtime_conditions"),
		"currentOwner": null,
		"currentSceneId": scene_manager.get_current_scene_id() if scene_manager != null else "",
	}


func evaluate_runtime_conditions(conditions: Array) -> bool:
	return condition_evaluator.evaluate_list(conditions, build_condition_eval_context())


func _evaluate_sugar_wheel_condition(expression: Variant) -> bool:
	return true if expression == null else condition_evaluator.evaluate(expression, build_condition_eval_context())


func _get_camera_baseline_zoom() -> float:
	var plane_zoom: Variant = plane_reconciler.get_active_camera_zoom() if plane_reconciler != null else null
	if plane_zoom is int or plane_zoom is float: return float(plane_zoom)
	var scene_data := scene_manager.get_current_scene_data() if scene_manager != null else {}
	var zoom: Variant = scene_data.get("camera", {}).get("zoom") if scene_data.get("camera") is Dictionary else null
	return float(zoom) if (zoom is int or zoom is float) and float(zoom) > 0.0 else 1.0


func _try_start_initial_prologue(game_config: Dictionary) -> void:
	var cutscene_id := str(game_config.get("initialCutscene", "")).strip_edges()
	if cutscene_id.is_empty(): return
	var done_flag := str(game_config.get("initialCutsceneDoneFlag", "")).strip_edges()
	if not done_flag.is_empty() and flag_store.get_value(done_flag) == true: return
	state_controller.set_state(RuntimeGameStateController.CUTSCENE)
	var played := await cutscene_manager.start_cutscene(cutscene_id)
	if played and not done_flag.is_empty(): flag_store.set_value(done_flag, true)
	state_controller.set_state(RuntimeGameStateController.EXPLORING)


func collect_save_data() -> Dictionary:
	var systems := runtime_root.serialize_systems()
	systems["flagStore"] = flag_store.serialize()
	if dialogue_log_ui != null: systems["dialogueLog"] = dialogue_log_ui.serialize()
	systems["game"] = {"playTimeMs": play_time_ms, "randomState": runtime_random_state}
	return systems


func distribute_save_data(data: Dictionary) -> bool:
	runtime_root.event_bus.emit("save:restoring", {})
	quest_manager.set_restoring(true)
	archive_manager.set_restoring(true)
	if data.get("flagStore") is Dictionary:
		flag_store.deserialize(data.flagStore)
	runtime_root.deserialize_systems(data)
	if dialogue_log_ui != null and data.get("dialogueLog") is Dictionary:
		dialogue_log_ui.deserialize(data.dialogueLog)
	if data.get("game") is Dictionary:
		var restored_play_time: Variant = data.game.get("playTimeMs")
		play_time_ms = float(restored_play_time) if restored_play_time is int or restored_play_time is float else 0.0
		var restored_random: Variant = data.game.get("randomState")
		if restored_random is int or restored_random is float: runtime_random_state = int(restored_random) & 0xffffffff; if runtime_random_state == 0: runtime_random_state = 1
	quest_manager.set_restoring(false)
	archive_manager.set_restoring(false)
	return true


func _seed_runtime_random(id: String) -> void:
	var hash := 0x811c9dc5
	for byte: int in id.to_utf8_buffer(): hash = ((hash ^ byte) * 0x01000193) & 0xffffffff
	runtime_random_state = hash if hash != 0 else 1


func _next_runtime_random() -> float:
	var x: int = runtime_random_state & 0xffffffff
	x = (x ^ ((x << 13) & 0xffffffff)) & 0xffffffff
	x = (x ^ (x >> 17)) & 0xffffffff
	x = (x ^ ((x << 5) & 0xffffffff)) & 0xffffffff
	runtime_random_state = x
	return float(x) / 4294967296.0


func reload_saved_scene(scene_id: String) -> bool:
	if zone_system != null: zone_system.clear_active_zones_for_restore()
	return scene_manager.load_scene(scene_id) if scene_manager != null else false


func _process(delta: float) -> void:
	if not fixed_tick_mode: _advance_runtime_tick(clampf(delta, 0.0, 0.1))


func _advance_runtime_tick(dt: float) -> void:
	play_time_ms += dt * 1000.0
	if camera != null and scene_depth_system != null: camera.set_pixel_snap_translation(scene_depth_system.is_pixel_density_match_active())
	if plane_reconciler != null: plane_reconciler.update(dt)
	var state := state_controller.current_state if state_controller != null else RuntimeGameStateController.MAIN_MENU
	match state:
		RuntimeGameStateController.EXPLORING:
			if player != null: player.update(dt)
			if input_manager != null and input_manager.was_key_just_pressed("KeyQ") and smell_system != null: smell_system.sniff()
			if interaction_system != null: interaction_system.update(dt)
			if zone_system != null: zone_system.update(dt)
			if scene_manager != null: scene_manager.update(dt)
			if camera != null and player != null: camera.follow(player.get_x(), player.get_y())
		RuntimeGameStateController.CUTSCENE:
			if player != null: player.cutscene_update(dt)
			if scene_manager != null: scene_manager.update(dt)
			if cutscene_manager != null: cutscene_manager.update(dt)
		RuntimeGameStateController.DIALOGUE:
			if dialogue_ui != null: dialogue_ui.update(dt)
			if player != null: player.cutscene_update(dt)
			if scene_manager != null: scene_manager.update(dt)
		RuntimeGameStateController.ENCOUNTER:
			if encounter_ui != null: encounter_ui.update(dt)
			if player != null: player.cutscene_update(dt)
			if scene_manager != null: scene_manager.update(dt)
		RuntimeGameStateController.MINIGAME:
			if water_minigame_manager != null: water_minigame_manager.update(dt)
			if sugar_wheel_minigame_manager != null: sugar_wheel_minigame_manager.update(dt)
			if paper_craft_minigame_manager != null: paper_craft_minigame_manager.update(dt)
			if player != null: player.cutscene_update(dt)
			if scene_manager != null: scene_manager.update(dt)
		RuntimeGameStateController.UI_OVERLAY:
			if player != null: player.cutscene_update(dt)
			if scene_manager != null: scene_manager.update(dt)
		RuntimeGameStateController.ACTION_SEQUENCE:
			if player != null: player.cutscene_update(dt)
			if scene_manager != null: scene_manager.update(dt)
			if camera != null and player != null: camera.follow(player.get_x(), player.get_y())
	if emote_bubble_manager != null: emote_bubble_manager.update(dt)
	if notification_ui != null: notification_ui.update(dt)
	if hud != null: hud.update(dt)
	if camera != null: camera.update(dt)
	if scene_depth_system != null: scene_depth_system.update(dt)
	if renderer != null and player != null: renderer.sort_entity_layer(player.get_x(), player.get_y())
	if touch_mobile_controls != null: touch_mobile_controls.update()
	if input_manager != null: input_manager.end_frame()


func _run_pressure_hold_segment(request: Dictionary) -> String:
	var previous := state_controller.current_state
	state_controller.set_state(RuntimeGameStateController.UI_OVERLAY)
	var outcome := await pressure_hold_ui.run_segment(request)
	if state_controller.current_state == RuntimeGameStateController.UI_OVERLAY:
		state_controller.set_state(previous)
	return outcome


func _show_debug_action_params(params: Dictionary) -> void:
	if DisplayServer.get_name() == "headless": return
	var title := str(params.get("title", "")).strip_edges()
	var body := (title + "\n\n" if not title.is_empty() else "") + JSON.stringify(params, "  ")
	OS.alert(body, "Action Params")


func _on_shop_purchase(payload: Variant) -> void:
	if payload is Dictionary:
		await action_executor.execute_await({"type": "shopPurchase", "params": {"itemId": str(payload.get("itemId", "")), "price": payload.get("price", 0)}})


func _on_shop_closed(_payload: Variant = null) -> void:
	if state_controller != null and state_controller.current_state == RuntimeGameStateController.UI_OVERLAY:
		state_controller.set_state(RuntimeGameStateController.EXPLORING)


func _on_menu_new_game(_payload: Variant = null) -> void:
	if has_started_session:
		get_tree().reload_current_scene()
		return
	has_started_session = true
	if menu_ui != null: menu_ui.close()
	state_controller.set_state(RuntimeGameStateController.EXPLORING)


func _on_menu_return_to_main(_payload: Variant = null) -> void:
	has_started_session = true
	state_controller.set_state(RuntimeGameStateController.MAIN_MENU)
	if menu_ui != null: menu_ui.open_main_menu()


func _on_menu_resume(_payload: Variant = null) -> void:
	if state_controller.current_state == RuntimeGameStateController.UI_OVERLAY:
		state_controller.restore_previous_state()


func _on_inventory_discard(payload: Variant) -> void:
	if payload is Dictionary:
		await action_executor.execute_await({"type": "inventoryDiscard", "params": {"itemId": str(payload.get("itemId", ""))}})


func _on_rule_use_apply(payload: Variant) -> void:
	if not payload is Dictionary: return
	state_controller.close_panel("ruleUse")
	await action_executor.execute_batch_await(payload.get("actions", []))
	await action_executor.execute_await({"type": "setFlag", "params": {"key": "rule_used_%s" % str(payload.get("ruleId", "")), "value": true}})
	if payload.get("resultText") != null:
		state_controller.set_state(RuntimeGameStateController.UI_OVERLAY)
		await inspect_box.show(resolve_display_text(str(payload.resultText)))
		if state_controller.current_state == RuntimeGameStateController.UI_OVERLAY: state_controller.set_state(RuntimeGameStateController.EXPLORING)


func _on_archive_first_view(payload: Variant) -> void:
	if payload is Dictionary and payload.get("actions") is Array:
		await action_executor.execute_batch_await(payload.actions)


func _on_map_scene_enter(payload: Variant) -> void:
	if map_ui != null and payload is Dictionary: map_ui.set_current_scene(str(payload.get("sceneId", "")))


func _on_scene_ready_runtime_sync(_payload: Variant = null) -> void:
	if interaction_system != null: interaction_system.update(0.0)


func _on_map_travel(payload: Variant) -> void:
	if not payload is Dictionary: return
	if state_controller.current_state == RuntimeGameStateController.UI_OVERLAY: state_controller.restore_previous_state()
	if not _guard_map_travel(): return
	await action_executor.execute_await({"type": "switchScene", "params": {"targetScene": str(payload.get("sceneId", ""))}})


func _guard_map_travel() -> bool:
	if plane_reconciler == null or plane_reconciler.is_map_travel_allowed(): return true
	runtime_root.event_bus.emit("notification:show", {"text": strings_provider.get_text("notifications", "mapTravelBlocked"), "type": "warning"})
	return false


func _on_renderer_resize() -> void:
	if camera != null and renderer != null: camera.set_screen_size(renderer.get_screen_width(), renderer.get_screen_height())


func _build_debug_system_info() -> Dictionary:
	var scene_data := scene_manager.get_current_scene_data() if scene_manager != null else {}
	return {
		"fps": Engine.get_frames_per_second(),
		"sceneId": scene_manager.get_current_scene_id() if scene_manager != null else "",
		"state": state_controller.current_state if state_controller != null else "",
		"worldWidth": scene_data.get("worldWidth", 0),
		"worldHeight": scene_data.get("worldHeight", 0),
		"depthOcclusionEnabled": scene_depth_system != null and scene_depth_system.enabled,
		"smell": smell_system.serialize() if smell_system != null else {},
	}


func _get_dev_scene_entries() -> Array:
	var result: Array = []
	var directory := resource_locator.resolve_url("/assets/scenes", RuntimeResourceLocator.TEXT)
	for file: String in DirAccess.get_files_at(directory):
		if not file.ends_with(".json"): continue
		var id := file.trim_suffix(".json"); var definition := asset_manager.load_scene_data(id)
		if not definition.is_empty(): result.push_back({"id": id, "name": str(definition.get("name", id))})
	result.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return str(a.id) < str(b.id))
	return result


func _get_dev_minigame_entries() -> Array:
	var result: Array = []
	for pair: Array in [[water_minigame_manager, "water"], [sugar_wheel_minigame_manager, "sugarWheel"], [paper_craft_minigame_manager, "paperCraft"]]:
		for raw: Dictionary in pair[0].get_instance_list():
			var entry := raw.duplicate(true); entry.kind = pair[1]; result.push_back(entry)
	return result


func _get_narrative_warp_entries() -> Array:
	var raw: Variant = asset_manager.load_json("/assets/data/dev_narrative_warps.json")
	return raw.get("warps", []).duplicate(true) if raw is Dictionary and raw.get("warps") is Array else []


func _dev_play_cutscene(id: String) -> void:
	state_controller.close_panel("devMode")
	await action_executor.execute_await({"type": "playCutscene", "params": {"id": id}})


func _dev_load_scene(id: String) -> void:
	state_controller.close_panel("devMode")
	await scene_manager.switch_scene_and_wait(id)


func _dev_reload() -> void:
	var id := scene_manager.get_current_scene_id()
	if not id.is_empty(): scene_manager.load_scene(id)


func _dev_launch_minigame(entry: Dictionary) -> void:
	state_controller.close_panel("devMode")
	match str(entry.get("kind", "")):
		"sugarWheel": sugar_wheel_minigame_manager.start(str(entry.get("id", "")))
		"paperCraft": paper_craft_minigame_manager.start(str(entry.get("id", "")))
		_: water_minigame_manager.start(str(entry.get("id", "")))


func _enter_narrative_warp(id: String) -> void:
	var target: Variant = null
	for warp: Variant in _get_narrative_warp_entries():
		if warp is Dictionary and str(warp.get("id", "")) == id: target = warp; break
	if not target is Dictionary: return
	state_controller.close_panel("devMode")
	if not str(target.get("flowGraph", "")).is_empty() and not str(target.get("flowState", "")).is_empty():
		await _advance_narrative_debug_path(str(target.flowGraph), str(target.flowState))
	for state: Variant in target.get("set", []):
		if state is Dictionary: await narrative_state_manager.debug_set_narrative_state(str(state.get("graph", "")), str(state.get("state", "")))
	await scene_manager.switch_scene_and_wait(str(target.get("scene", "")))


func _advance_narrative_debug_path(graph_id: String, target_state: String) -> void:
	var graph: Variant = narrative_state_manager.get_graph(graph_id)
	if not graph is Dictionary: return
	var start := str(graph.get("initialState", "")); var queue: Array[String] = [start]; var seen := {start: true}; var came_from := {}
	while not queue.is_empty():
		var current: String = queue.pop_front()
		if current == target_state: break
		for transition: Variant in graph.get("transitions", []):
			if transition is Dictionary and str(transition.get("from", "")) == current:
				var next := str(transition.get("to", ""))
				if not seen.has(next): seen[next] = true; came_from[next] = current; queue.push_back(next)
	if not seen.has(target_state): return
	var path: Array[String] = []; var cursor := target_state
	while not cursor.is_empty():
		path.push_front(cursor)
		if cursor == start: break
		cursor = str(came_from.get(cursor, ""))
	for state_id: String in path: await narrative_state_manager.debug_set_narrative_state(graph_id, state_id)


func _exit_tree() -> void:
	if runtime_root != null and runtime_root.event_bus != null:
		runtime_root.event_bus.off("dialogue:line", Callable(self, "_on_dialogue_line_speaking_bubble"))
		runtime_root.event_bus.off("dialogue:end", Callable(self, "_clear_dialogue_speaking_bubble"))
		runtime_root.event_bus.off("dialogue:hidePanel", Callable(self, "_clear_dialogue_speaking_bubble"))
	if touch_mobile_controls != null:
		touch_mobile_controls.destroy()
	if dialogue_event_bridge != null:
		dialogue_event_bridge.destroy()
	if dialogue_ui != null:
		dialogue_ui.destroy()
	if encounter_ui != null:
		encounter_ui.destroy()
	if pressure_hold_ui != null:
		pressure_hold_ui.destroy()
	if shop_ui != null:
		shop_ui.destroy()
	if notification_ui != null:
		notification_ui.destroy()
	if pickup_notification != null:
		pickup_notification.destroy()
	if action_choice_ui != null:
		action_choice_ui.destroy()
	if hud != null:
		hud.destroy()
	if interaction_coordinator != null:
		interaction_coordinator.destroy()
	if inspect_box != null:
		inspect_box.destroy()
	if rule_offer_registry != null:
		rule_offer_registry.clear()
	if state_controller != null:
		state_controller.destroy()
	if runtime_root != null:
		runtime_root.destroy_runtime()
	if action_executor != null:
		action_executor.destroy()
	if save_manager != null:
		save_manager.destroy()
	if flag_store != null:
		flag_store.destroy()
	if input_manager != null:
		input_manager.destroy()
	if player != null:
		player.destroy_player()
	if asset_manager != null:
		asset_manager.dispose()
	if renderer != null:
		if not unsubscribe_renderer_resize.is_null() and unsubscribe_renderer_resize.is_valid(): unsubscribe_renderer_resize.call()
		renderer.destroy_renderer()
