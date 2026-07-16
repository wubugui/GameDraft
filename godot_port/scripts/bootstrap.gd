extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")
const RuntimeHotspotCollisionScript := preload("res://scripts/utils/hotspot_collision.gd")

const RuntimeRootScript := preload("res://scripts/runtime/runtime_root.gd")
const RuntimeSnapshotScript := preload("res://scripts/core/runtime_snapshot.gd")
const RuntimeCommandBridgeScript := preload("res://scripts/core/runtime_command_bridge.gd")
const RuntimeDevRuntimeCommandsScript := preload("res://scripts/core/dev_runtime_commands.gd")
const RuntimeActionRegistryScript := preload("res://scripts/runtime/action_registry.gd")
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")
const RuntimeDeterministicRandomScript := preload("res://scripts/utils/deterministic_random.gd")
const RuntimeClickContinuePromptScript := preload("res://scripts/ui/click_continue_prompt.gd")
const RuntimeScriptedDialogueSpeakerScript := preload("res://scripts/utils/scripted_dialogue_speaker.gd")
const RuntimeAnimationSetResolverScript := preload("res://scripts/utils/animation_set_resolver.gd")
const RuntimePlaceholderFactoryScript := preload("res://scripts/rendering/placeholder_factory.gd")
const RuntimeEntityShadowSourceScript := preload("res://scripts/rendering/entity_shadow_source.gd")
const RuntimeCharacterRegistryScript := preload("res://scripts/data/character_registry.gd")

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var strings_provider: RuntimeStringsProvider
var input_manager: RuntimeInputManager
var asset_manager: RuntimeAssetManager
var action_executor: RuntimeActionExecutor
var renderer: RuntimeRenderer
var camera: RuntimeCamera
var player: RuntimePlayer
var interaction_system: RuntimeInteractionSystem
var scene_manager: RuntimeSceneManager
var dialogue_manager: RuntimeDialogueManager
var graph_dialogue_manager: RuntimeGraphDialogueManager
var scenario_state_manager: RuntimeScenarioStateManager
var narrative_state_manager: RuntimeNarrativeStateManager
var document_reveal_manager: RuntimeDocumentRevealManager
var quest_manager: RuntimeQuestManager
var rules_manager: RuntimeRulesManager
var inventory_manager: RuntimeInventoryManager
var encounter_manager: RuntimeEncounterManager
var audio_manager: RuntimeAudioManager
var day_manager: RuntimeDayManager
var cutscene_manager: RuntimeCutsceneManager
var cutscene_renderer: RuntimeCutsceneRenderer
var resolve_actor_fn := Callable()
var scene_display_name_by_id: Dictionary = {}
var npc_display_name_by_id: Dictionary = {}
var archive_manager: RuntimeArchiveManager
var emote_bubble_manager: RuntimeEmoteBubbleManager
var rule_offer_registry: RuntimeRuleOfferRegistry
var zone_system: RuntimeZoneSystem
var save_manager: RuntimeSaveManager
var inspect_box: RuntimeInspectBox
var pickup_notification: RuntimePickupNotification
var dialogue_ui: RuntimeDialogueUI
var encounter_ui: RuntimeEncounterUI
var action_choice_ui: RuntimeActionChoiceUI
var hud: RuntimeHUD
var notification_ui: RuntimeNotificationUI
var quest_panel_ui: RuntimeQuestPanelUI
var inventory_ui: RuntimeInventoryUI
var rules_panel_ui: RuntimeRulesPanelUI
var dialogue_log_ui: RuntimeDialogueLogUI
var bookshelf_ui: RuntimeBookshelfUI
var book_reader_ui: RuntimeBookReaderUI
var shop_ui: RuntimeShopUI
var map_ui: RuntimeMapUI
var menu_ui: RuntimeMenuUI
var rule_use_ui: RuntimeRuleUseUI
var debug_panel_ui: RuntimeDebugPanelUI
var cutscene_step_hud_el: Control
var state_controller: RuntimeGameStateController
var last_time := 0.0
var last_fps := 0.0
var play_time_ms := 0.0
var runtime_random: RuntimeDeterministicRandom
var player_anim_def: Variant = null
var interaction_coordinator: RuntimeInteractionCoordinator
var event_bridge: RuntimeEventBridge
var debug_tools: RuntimeDebugTools
var scene_depth_system: RuntimeSceneDepthSystem
var water_minigame_manager: RuntimeWaterMinigameManager
var sugar_wheel_minigame_manager: RuntimeSugarWheelMinigameManager
var paper_craft_minigame_manager: RuntimePaperCraftMinigameManager
var pressure_hold_manager: RuntimePressureHoldManager
var signal_cue_manager: RuntimeSignalCueManager
var health_system: RuntimeHealthSystem
var smell_system: RuntimeSmellSystem
var plane_reconciler: RuntimePlaneReconciler
var smell_profiles_data: Variant = null
var pressure_hold_ui: RuntimePressureHoldUI
var depth_debug_visualizer: RuntimeDepthDebugVisualizer
var player_depth_filter: Variant = null
var current_probe: Texture2D
var current_light_env: Variant = null
var current_light_curve: Variant = null
var plane_light_env_override: Variant = null
var current_shadow_field: Variant = null
var entity_shadows: Dictionary = {}
var ambient_narrative_owner: Variant = null
var entity_pixel_density_match_debug_override: Variant = null
var entity_pixel_density_match_blur_scale_debug: Variant = null
var patrol_generation := 0
var npc_patrol_epoch: Dictionary = {}
var main_tick := Callable()
var gl_post_render_drain := Callable()
var webgl_context_lost_handler := Callable()
var webgl_context_restored_handler := Callable()
var runtime_debug_log_cleanup := Callable()
var runtime_debug_snapshot_timer: Variant = null
var runtime_command_poll_timer: Variant = null
var runtime_command_poll_in_flight := false
var runtime_boot_id := ""
var runtime_debug_snapshot_error_logged := false
var fixed_tick_mode := false
var runtime_ready := false
var runtime_command_poll_error_logged := false
var last_runtime_command_results: Array = []
var registered_systems: Array[Dictionary] = []
var bound_callbacks: Array[Dictionary] = []
var bound_window_listeners: Array[Dictionary] = []
var unsub_renderer_resize := Callable()
var tear_down_complete := false
var is_dev_mode := false
var smell_debug_global_keys: Array[String] = []
var dev_mode_ui: RuntimeDevModeUI
var touch_mobile_controls: RuntimeTouchMobileControls
var overlay_image_registry: Dictionary = {}
var game_config: Dictionary = {
	"initialScene": "",
	"initialQuest": "",
	"fallbackScene": "",
	"playerAvatar": {
		"animManifest": "/resources/runtime/animation/player_anim/anim.json",
		"stateMap": {},
	},
	"entityPixelDensityMatch": true,
	"entityPixelDensityMatchBlurScale": 0.25,
}
var current_player_portrait_slug: Variant = null
var narrative_warps: Array = []
var dev_startup_route := Callable()
var player_nav_target: Variant = null
var player_nav_frames := 0
var player_nav_prev: Variant = null
var player_nav_stuck := 0

# Godot-only engine/platform adapters. These may not own Game domain state.
var runtime_root: RuntimeRoot
var runtime_command_bridge: RuntimeCommandBridge


func _init() -> void:
	# Class-field initializers in Game.ts run before the constructor body.
	runtime_boot_id = "godot-%s-%s" % [Time.get_unix_time_from_system(), get_instance_id()]
	runtime_random = RuntimeDeterministicRandomScript.new("gamedraft-runtime-v1")

	# Direct translation of Game.constructor(), in source statement order.
	event_bus = RuntimeEventBus.new()
	if OS.is_debug_build(): event_bus.enable_debug_trace()
	flag_store = RuntimeFlagStore.new(event_bus)
	strings_provider = RuntimeStringsProvider.new()
	input_manager = RuntimeInputManager.new()
	asset_manager = RuntimeAssetManager.new()
	RuntimeEntityRuntimeFieldSchema.configure(asset_manager)
	state_controller = RuntimeGameStateController.new(input_manager, event_bus)
	action_executor = RuntimeActionExecutor.new(event_bus, flag_store, state_controller)
	rule_offer_registry = RuntimeRuleOfferRegistry.new()
	renderer = RuntimeRenderer.new()
	renderer.set_asset_manager(asset_manager)
	camera = RuntimeCamera.new(renderer.world_container)
	player = RuntimePlayer.new(input_manager)
	interaction_system = RuntimeInteractionSystem.new(event_bus, flag_store, input_manager)
	scene_manager = RuntimeSceneManager.new(asset_manager, event_bus, renderer)
	inventory_manager = RuntimeInventoryManager.new(event_bus, flag_store)
	rules_manager = RuntimeRulesManager.new(event_bus, flag_store)
	dialogue_manager = RuntimeDialogueManager.new(event_bus)
	quest_manager = RuntimeQuestManager.new(event_bus, flag_store, action_executor)
	scenario_state_manager = RuntimeScenarioStateManager.new()
	narrative_state_manager = RuntimeNarrativeStateManager.new(event_bus, flag_store, action_executor)
	graph_dialogue_manager = RuntimeGraphDialogueManager.new(event_bus, flag_store, action_executor, asset_manager, scene_manager, rules_manager, quest_manager, inventory_manager, scenario_state_manager)
	graph_dialogue_manager.set_player_portrait_slug_provider(func() -> Variant: return current_player_portrait_slug)
	document_reveal_manager = RuntimeDocumentRevealManager.new(asset_manager, event_bus, flag_store, quest_manager, scenario_state_manager)
	encounter_manager = RuntimeEncounterManager.new(event_bus, flag_store, action_executor)
	audio_manager = RuntimeAudioManager.new(event_bus)
	day_manager = RuntimeDayManager.new(event_bus, flag_store, action_executor)
	water_minigame_manager = RuntimeWaterMinigameManager.new()
	sugar_wheel_minigame_manager = RuntimeSugarWheelMinigameManager.new()
	paper_craft_minigame_manager = RuntimePaperCraftMinigameManager.new()
	pressure_hold_manager = RuntimePressureHoldManager.new(action_executor)
	signal_cue_manager = RuntimeSignalCueManager.new(action_executor)
	health_system = RuntimeHealthSystem.new(event_bus, flag_store, action_executor)
	smell_system = RuntimeSmellSystem.new(event_bus, flag_store)
	plane_reconciler = RuntimePlaneReconciler.new(event_bus)
	archive_manager = RuntimeArchiveManager.new(event_bus, flag_store)
	emote_bubble_manager = RuntimeEmoteBubbleManager.new()
	zone_system = RuntimeZoneSystem.new(event_bus, flag_store, action_executor, rule_offer_registry)
	scene_depth_system = RuntimeSceneDepthSystem.new()

	registered_systems = [
		{"name": "sceneManager", "system": scene_manager},
		{"name": "interactionSystem", "system": interaction_system},
		{"name": "dialogueManager", "system": dialogue_manager},
		{"name": "graphDialogueManager", "system": graph_dialogue_manager},
		{"name": "inventoryManager", "system": inventory_manager},
		{"name": "rulesManager", "system": rules_manager},
		{"name": "questManager", "system": quest_manager},
		{"name": "scenarioStateManager", "system": scenario_state_manager},
		{"name": "narrativeStateManager", "system": narrative_state_manager},
		{"name": "planeReconciler", "system": plane_reconciler},
		{"name": "documentRevealManager", "system": document_reveal_manager},
		{"name": "encounterManager", "system": encounter_manager},
		{"name": "audioManager", "system": audio_manager},
		{"name": "dayManager", "system": day_manager},
		{"name": "waterMinigameManager", "system": water_minigame_manager},
		{"name": "sugarWheelMinigameManager", "system": sugar_wheel_minigame_manager},
		{"name": "paperCraftMinigameManager", "system": paper_craft_minigame_manager},
		{"name": "pressureHoldManager", "system": pressure_hold_manager},
		{"name": "signalCueManager", "system": signal_cue_manager},
		{"name": "healthSystem", "system": health_system},
		{"name": "smellSystem", "system": smell_system},
		{"name": "cutsceneManager", "system": null},
		{"name": "archiveManager", "system": archive_manager},
		{"name": "zoneSystem", "system": zone_system},
		{"name": "emoteBubbleManager", "system": emote_bubble_manager},
		{"name": "sceneDepthSystem", "system": scene_depth_system},
	]

	# RuntimeRoot is only the Godot Node-parenting adapter. Game remains the owner
	# of registration order and every lifecycle call.
	runtime_root = RuntimeRootScript.new(event_bus)
	runtime_root.set_automatic_updates_enabled(false)
	if not runtime_root.attach_system_slots(registered_systems):
		push_error("Godot runtime bootstrap failed")
		return
	var game_context := {"eventBus": event_bus, "flagStore": flag_store, "strings": strings_provider, "assetManager": asset_manager}
	for entry: Dictionary in registered_systems:
		if entry.system != null: entry.system.init(game_context)


func _ready() -> void:
	# Game.ts only installs mainTick at the end of start().  Godot starts calling
	# _process as soon as this node enters the tree, so keep the engine adapter
	# disabled until the translated start sequence has fully committed.
	set_process(false)
	await start(RuntimeGameStartupAdapter.from_engine(self, OS.get_cmdline_user_args()))


func build_resolve_context() -> Dictionary:
	var strings := strings_provider
	return {
		"stringsRaw": Callable(strings, "get_raw"),
		"flagStore": flag_store,
		"itemNames": archive_manager.get_item_display_names(),
		"npcName": func(id: String) -> Variant:
			var normalized := id.strip_edges()
			if normalized.is_empty():
				return null
			var live: Variant = scene_manager.get_npc_by_id(normalized)
			return live.def.get("name") if live != null else npc_display_name_by_id.get(normalized),
		"contextNpcId": graph_dialogue_manager.get_context_npc_id(),
		"playerDisplayName": func() -> String:
			var value: Variant = flag_store.get_value("player_display_name")
			if value is String and not value.strip_edges().is_empty():
				return value.strip_edges()
			var fallback := strings.get_raw("dialogue", "defaultProtagonistName")
			return fallback if not fallback.is_empty() and fallback != "defaultProtagonistName" else "你",
		"questTitle": func(id: String) -> Variant: return quest_manager.get_quest_title(id),
		"ruleName": func(id: String) -> Variant:
			var definition: Variant = rules_manager.get_rule_def(id)
			return definition.get("name") if definition is Dictionary else null,
		"sceneDisplayName": func(scene_id: String) -> String:
			var normalized := scene_id.strip_edges()
			return str(scene_display_name_by_id.get(normalized, normalized)),
	}


func resolve_display_text(raw: Variant) -> String:
	return RuntimeTextResolver.resolve_text(raw, build_resolve_context())


func resolve_display_text_for_play_scripted(raw: Variant, scripted_npc_id: String = "") -> String:
	var context := build_resolve_context()
	var graph_npc := str(context.get("contextNpcId", "")).strip_edges()
	var scripted := scripted_npc_id.strip_edges()
	context.contextNpcId = graph_npc if not graph_npc.is_empty() else scripted
	return RuntimeTextResolver.resolve_text("" if raw == null else raw, context)


func _resolve_scripted_line_extras(raw_speaker: String, portrait_ref: Variant, scripted_npc_id: String = "") -> Dictionary:
	var entity: Variant = RuntimeScriptedDialogueSpeakerScript.resolve_scripted_speaker_entity(raw_speaker, {
		"graphDialogueNpcId": graph_dialogue_manager.get_context_npc_id(),
		"fallbackNpcId": scripted_npc_id,
	})
	var result := {}
	if entity is Dictionary: result.speakerEntity = entity
	var portrait: Variant = _resolve_scripted_portrait(portrait_ref, entity)
	if portrait is Dictionary: result.portrait = portrait
	return result


func _resolve_scripted_portrait(raw: Variant, entity: Variant) -> Variant:
	if not raw is Dictionary: return null
	var emotion := str(raw.get("emotion", "")).strip_edges()
	if emotion.is_empty(): return null
	var raw_slug: Variant = raw.get("slug")
	var slug: String = raw_slug.strip_edges() if raw_slug is String else ""
	if slug.is_empty() and entity is Dictionary:
		if entity.get("kind") == "player":
			slug = current_player_portrait_slug.strip_edges() if current_player_portrait_slug is String else ""
		elif entity.get("kind") == "npc":
			var npc: Variant = scene_manager.get_npc_by_id(str(entity.get("npcId", "")))
			if npc != null: slug = npc.get_current_portrait_slug()
	return {"slug": slug, "emotion": emotion} if not slug.is_empty() else null


func _resolve_emote_target(id: String) -> Variant:
	var actor: Variant = _resolve_action_actor(id)
	if actor != null or scene_manager == null: return actor
	var key := id.strip_edges()
	var hotspots := scene_manager.get_current_hotspots()
	var index := hotspots.find_custom(func(hotspot: RuntimeHotspot) -> bool: return hotspot.get_id() == key)
	return hotspots[index] if index >= 0 else null


func _refresh_text_resolve_lookups() -> void:
	scene_display_name_by_id.clear()
	var map_config: Variant = asset_manager.load_json("/assets/data/map_config.json")
	var nodes: Array = map_config if map_config is Array else map_config.get("nodes", []) if map_config is Dictionary and map_config.get("nodes") is Array else []
	for node: Variant in nodes:
		if node is Dictionary and not str(node.get("sceneId", "")).is_empty():
			scene_display_name_by_id[str(node.sceneId)] = str(node.get("name", node.sceneId))
	npc_display_name_by_id.clear()
	var scene_ids: Dictionary = {}
	for scene_id: String in scene_display_name_by_id: scene_ids[scene_id] = true
	for key: String in ["initialScene", "fallbackScene"]:
		var scene_id := str(game_config.get(key, "")).strip_edges()
		if not scene_id.is_empty(): scene_ids[scene_id] = true
	for scene_id: String in scene_ids:
		var scene: Variant = asset_manager.load_json(RuntimeResourceLocator.get_default().scene_json_url(scene_id))
		if not scene is Dictionary: continue
		for npc: Variant in scene.get("npcs", []):
			if npc is Dictionary and not str(npc.get("id", "")).is_empty():
				npc_display_name_by_id[str(npc.id)] = str(npc.get("name", npc.id))


func wire_text_resolve() -> void:
	var resolve := func(value: String) -> String: return resolve_display_text(value)
	strings_provider.set_resolve_display(resolve)
	action_executor.set_resolve_notification_text(resolve)
	graph_dialogue_manager.set_resolve_display(resolve)
	document_reveal_manager.set_resolve_condition_literal(resolve)
	encounter_manager.set_resolve_display(resolve)
	archive_manager.set_resolve_for_display(func(raw: Variant) -> String: return resolve_display_text(raw))
	inspect_box.set_resolve_display(resolve)
	shop_ui.set_resolve_display(resolve)
	map_ui.set_resolve_display(resolve)
	quest_panel_ui.set_resolve_display(resolve)
	rules_panel_ui.set_resolve_display(resolve)
	inventory_ui.set_resolve_display(resolve)
	cutscene_renderer.set_resolve_display(resolve)
	var narrator_key := strings_provider.get_text("dialogue", "narratorLabel")
	var narrator_fallback := narrator_key if not narrator_key.is_empty() and narrator_key != "narratorLabel" else "旁白"
	cutscene_manager.set_colon_speaker_narrator_baseline_resolved(resolve_display_text(narrator_fallback))
	cutscene_manager.set_display_text_resolver(resolve)
	hud.set_resolve_display(resolve)
	rule_use_ui.set_resolve_display(resolve)


func start(options: Dictionary = {}) -> void:
	is_dev_mode = bool(options.get("devMode", false))
	renderer.name = "Renderer"
	add_child(renderer)
	renderer.init({"resolution": 1} if options.get("visualCapture") == true else {})
	await RuntimeMicrotaskQueueScript.yield_turn()
	if tear_down_complete: return
	emote_bubble_manager.set_entity_attach_layer(renderer.entity_layer)
	strings_provider.load(asset_manager)
	await RuntimeMicrotaskQueueScript.yield_turn()
	await _load_game_config()
	if tear_down_complete: return
	runtime_root.name = "RuntimeRoot"
	add_child(runtime_root)
	if game_config.get("windowSize") is Dictionary: renderer.set_window_size(int(game_config.windowSize.get("width", 0)), int(game_config.windowSize.get("height", 0)))
	if game_config.get("viewport") is Dictionary: renderer.set_viewport_size(int(game_config.viewport.get("width", 0)), int(game_config.viewport.get("height", 0)))
	input_manager.name = "InputManager"
	add_child(input_manager)
	# Edge-triggered input is cleared by tick, including explicit fixed ticks.
	# A separate natural-frame reset would drop replayed input before the deterministic tick.
	input_manager.set_process(false)
	var game_context := {"eventBus": event_bus, "flagStore": flag_store, "strings": strings_provider, "assetManager": asset_manager}
	if game_config.get("health") is Dictionary:
		health_system.configure(game_config.health)
		health_system.init(game_context)

	# Direct translation of the source UI construction order.
	inspect_box = RuntimeInspectBox.new(renderer, strings_provider, input_manager)
	pickup_notification = RuntimePickupNotification.new(renderer, strings_provider)
	dialogue_ui = RuntimeDialogueUI.new(renderer, event_bus, strings_provider, asset_manager, input_manager)
	event_bus.on("dialogue:line", Callable(self, "_on_dialogue_line_speaking_bubble"))
	event_bus.on("dialogue:end", Callable(self, "_clear_dialogue_speaking_bubble"))
	event_bus.on("dialogue:hidePanel", Callable(self, "_clear_dialogue_speaking_bubble"))
	encounter_ui = RuntimeEncounterUI.new(renderer, event_bus, strings_provider, input_manager)
	action_choice_ui = RuntimeActionChoiceUI.new(renderer, strings_provider, input_manager)
	pressure_hold_ui = RuntimePressureHoldUI.new(renderer, strings_provider, input_manager)
	hud = RuntimeHUD.new(renderer, event_bus, strings_provider)
	notification_ui = RuntimeNotificationUI.new(renderer, event_bus)
	quest_panel_ui = RuntimeQuestPanelUI.new(renderer, quest_manager, strings_provider)
	inventory_ui = RuntimeInventoryUI.new(renderer, event_bus, inventory_manager, strings_provider)
	rules_panel_ui = RuntimeRulesPanelUI.new(renderer, rules_manager, strings_provider)
	dialogue_log_ui = RuntimeDialogueLogUI.new(renderer, event_bus, strings_provider)
	book_reader_ui = RuntimeBookReaderUI.new(renderer, archive_manager, strings_provider, asset_manager)
	var on_open_rules := func() -> void:
		state_controller.restore_previous_state()
		state_controller.toggle_panel("rules")
	var on_open_book := func(book: Dictionary, on_close: Callable) -> RuntimeBookReaderUI:
		book_reader_ui.open_book(book, on_close)
		return book_reader_ui
	var on_open_characters := func(on_close: Callable) -> RuntimeCharacterBookUI:
		var shelf := RuntimeCharacterBookUI.new(renderer, archive_manager, on_close, strings_provider, asset_manager)
		shelf.open()
		return shelf
	var on_open_lore := func(on_close: Callable) -> RuntimeLoreBookUI:
		var shelf := RuntimeLoreBookUI.new(renderer, archive_manager, on_close, strings_provider, asset_manager)
		shelf.open()
		return shelf
	var on_open_documents := func(on_close: Callable) -> RuntimeDocumentBoxUI:
		var shelf := RuntimeDocumentBoxUI.new(renderer, archive_manager, on_close, strings_provider, asset_manager)
		shelf.open()
		return shelf
	bookshelf_ui = RuntimeBookshelfUI.new(
		renderer,
		archive_manager,
		on_open_rules,
		on_open_book,
		on_open_characters,
		on_open_lore,
		on_open_documents,
		strings_provider,
	)
	shop_ui = RuntimeShopUI.new(renderer, event_bus, inventory_manager, strings_provider, asset_manager)
	map_ui = RuntimeMapUI.new(renderer, event_bus, flag_store, strings_provider, asset_manager)

	cutscene_renderer = RuntimeCutsceneRenderer.new(renderer, camera, asset_manager)
	if not cutscene_renderer.load_overlay_defs(): push_warning("CutsceneRenderer: overlay_images.json not found")
	cutscene_manager = RuntimeCutsceneManager.new(event_bus, flag_store, action_executor, cutscene_renderer)
	cutscene_manager.init(game_context)
	var cutscene_system_index := registered_systems.find_custom(func(entry: Dictionary) -> bool: return entry.name == "cutsceneManager")
	if cutscene_system_index >= 0:
		registered_systems[cutscene_system_index].system = cutscene_manager
	if not runtime_root.replace_registered_system("cutsceneManager", cutscene_manager):
		push_error("Godot runtime bootstrap failed to attach CutsceneManager")
		return
	resolve_actor_fn = Callable(self, "_resolve_action_actor")
	cutscene_manager.set_input_manager(input_manager)
	cutscene_manager.set_audio_manager(audio_manager)
	cutscene_manager.set_entity_resolver(resolve_actor_fn)
	cutscene_manager.set_emote_bubble_provider(emote_bubble_manager)
	cutscene_manager.set_emote_target_resolver(Callable(self, "_resolve_emote_target"))
	cutscene_manager.set_scene_switcher(Callable(self, "_switch_scene_for_cutscene"))
	cutscene_manager.set_scene_id_getter(func() -> String: return scene_manager.get_current_scene_id())
	cutscene_manager.set_player_position_getter(func() -> Dictionary: return {"x": player.get_x(), "y": player.get_y()})
	cutscene_manager.set_player_position_setter(func(x: float, y: float) -> void: player.set_x(x); player.set_y(y))
	cutscene_manager.set_camera_accessor(camera)
	cutscene_manager.set_scene_manager(scene_manager)
	cutscene_manager.set_spawn_point_resolver(Callable(self, "_resolve_cutscene_spawn_point"))
	cutscene_manager.set_scripted_speaker_resolver(func(raw: String, scripted_npc_id: String = "") -> String:
		return RuntimeScriptedDialogueSpeakerScript.resolve_scripted_speaker_display(raw, {
			"strings": strings_provider,
			"flagStore": flag_store,
			"sceneManager": scene_manager,
			"graphDialogueNpcId": graph_dialogue_manager.get_context_npc_id(),
			"fallbackNpcId": scripted_npc_id,
		})
	)
	save_manager = RuntimeSaveManager.new(
		Callable(self, "collect_save_data"),
		Callable(self, "distribute_save_data"),
		Callable(self, "reload_saved_scene"),
		strings_provider,
		str(game_config.get("fallbackScene", "")),
	)
	save_manager.set_can_save_predicate(func() -> bool:
		return state_controller.current_state in [RuntimeDataTypes.EXPLORING, RuntimeDataTypes.UI_OVERLAY]
	)
	menu_ui = RuntimeMenuUI.new(renderer, event_bus, save_manager, audio_manager, strings_provider)
	rule_use_ui = RuntimeRuleUseUI.new(renderer, event_bus, zone_system, rules_manager, strings_provider)
	debug_panel_ui = RuntimeDebugPanelUI.new(renderer, strings_provider, Callable(self, "_build_debug_system_info"))
	emote_bubble_manager.set_debug_panel_log(func(message: String) -> void:
		if debug_panel_ui != null:
			debug_panel_ui.log(message)
	)

	camera.set_screen_size(renderer.screen_width, renderer.screen_height)
	unsub_renderer_resize = renderer.subscribe_after_resize(Callable(self, "_on_renderer_resize"))
	add_window_listener("resize", Callable(self, "_on_renderer_resize"))
	setup_scene_manager()
	_register_ui_panels()
	encounter_manager.set_rule_name_resolver(func(id: String) -> Variant: return rules_manager.get_rule_def(id))

	var condition_factory := func() -> Dictionary: return build_condition_eval_context()
	flag_store.set_condition_eval_context_factory(condition_factory)
	quest_manager.set_condition_eval_context_factory(condition_factory)
	zone_system.set_condition_eval_context_factory(condition_factory)
	interaction_system.set_condition_eval_context_factory(condition_factory)
	interaction_system.set_entity_base_visibility_readers(Callable(scene_manager, "get_hotspot_base_enabled_for_interaction"), Callable(scene_manager, "get_npc_base_visible_for_interaction"))
	encounter_manager.set_condition_eval_context_factory(condition_factory)
	map_ui.set_condition_eval_context_factory(condition_factory)
	archive_manager.set_condition_eval_context_factory(condition_factory)
	inventory_manager.set_condition_eval_context_factory(condition_factory)
	graph_dialogue_manager.set_condition_eval_context_factory(condition_factory)
	document_reveal_manager.set_condition_eval_context_factory(condition_factory)
	narrative_state_manager.set_condition_eval_context_factory(condition_factory)
	plane_reconciler.bind_runtime({
		"narrative": narrative_state_manager,
		"setPlayerMovementModifier": func(value: Variant) -> void: player.set_movement_modifier(value),
		"setPlaneInteractionPolicy": func(value: Variant) -> void: interaction_system.set_plane_interaction_policy(value),
		"refreshEntitiesForPlaneChange": func() -> void: scene_manager.refresh_entities_for_plane_change(scene_manager.get_current_scene_id()),
		"refreshZonesForPlaneChange": func() -> void: scene_manager.refresh_zones_for_plane_change(scene_manager.get_current_scene_id()),
		"setCameraZoom": func(zoom: Variant) -> void:
			if zoom is int or zoom is float: camera.set_zoom(float(zoom)),
		"restoreSceneCameraZoom": func() -> void: camera.set_zoom(_get_camera_baseline_zoom()),
		"applyPlaneLightEnvOverride": Callable(self, "apply_plane_light_env_override"),
		"damagePlayer": func(amount: int) -> void: await health_system.damage(float(amount)),
		"getGameState": func() -> String: return state_controller.current_state,
	})
	scene_manager.set_active_plane_getter(func() -> Dictionary: return {"id": plane_reconciler.get_active_plane_id(), "membership": plane_reconciler.get_active_plane_membership()})
	document_reveal_manager.set_blend_executor(Callable(cutscene_manager, "blend_overlay_image"))
	await document_reveal_manager.load_definitions()
	var scenario_catalog: Variant = asset_manager.load_json("/assets/data/scenarios.json")
	await RuntimeMicrotaskQueueScript.yield_turn()
	scenario_state_manager.configure_runtime(flag_store, scenario_catalog if scenario_catalog is Dictionary else null, event_bus)
	if not narrative_state_manager.load_from_asset(asset_manager): push_warning("NarrativeStateManager: narrative_graphs.json not found")
	await RuntimeMicrotaskQueueScript.yield_turn()
	if tear_down_complete: return
	RuntimeActionRegistryScript.register_action_handlers(action_executor, {
		"randomValue": Callable(runtime_random, "next"),
		"resolveScriptedSpeaker": func(raw: String, scripted_npc_id: String = "") -> String:
			return RuntimeScriptedDialogueSpeakerScript.resolve_scripted_speaker_display(raw, {
				"strings": strings_provider,
				"flagStore": flag_store,
				"sceneManager": scene_manager,
				"graphDialogueNpcId": graph_dialogue_manager.get_context_npc_id(),
				"fallbackNpcId": scripted_npc_id,
			}),
		"resolveScriptedLineExtras": Callable(self, "_resolve_scripted_line_extras"),
		"ruleOfferRegistry": rule_offer_registry,
		"inventoryManager": inventory_manager,
		"rulesManager": rules_manager,
		"questManager": quest_manager,
		"encounterManager": encounter_manager,
		"audioManager": audio_manager,
		"dayManager": day_manager,
		"archiveManager": archive_manager,
		"cutsceneManager": cutscene_manager,
		"sceneManager": scene_manager,
		"emoteBubbleManager": emote_bubble_manager,
		"stateController": state_controller,
		"stringsProvider": strings_provider,
		"eventBus": event_bus,
		"resolveActor": resolve_actor_fn,
		"resolveEmoteTarget": Callable(self, "_resolve_emote_target"),
		"pickupNotification": pickup_notification,
		"inspectBox": inspect_box,
		"shopUI": shop_ui,
		"applyPlayerAvatar": Callable(self, "apply_player_avatar_from_action"),
		"resetPlayerAvatar": Callable(self, "reset_player_avatar_from_action"),
		"setSceneDepthFloorOffset": func(value: float) -> void: scene_depth_system.floor_offset = value,
		"resetSceneDepthFloorOffset": func() -> void:
			var depth_config: Variant = scene_depth_system.current_config
			scene_depth_system.floor_offset = float(depth_config.get("floor_offset", 0.0)) if depth_config is Dictionary else 0.0,
		"setCameraZoom": Callable(camera, "set_zoom"),
		"restoreSceneCameraZoom": func() -> void: camera.set_zoom(_get_camera_baseline_zoom()),
		"fadingRestoreSceneCameraZoom": func(duration_ms: float) -> void: await cutscene_manager.fading_camera_zoom(_get_camera_baseline_zoom(), duration_ms),
		"stopNpcPatrol": Callable(self, "stop_npc_patrol"),
		"startNpcPatrol": Callable(self, "_start_npc_patrol_for_npc"),
		"showOverlayImage": Callable(cutscene_manager, "show_overlay_image"),
		"resolveOverlayImagePath": Callable(self, "_resolve_overlay_image_id_to_path"),
		"hideOverlayImage": Callable(cutscene_manager, "hide_overlay_image"),
		"blendOverlayImage": Callable(cutscene_manager, "blend_overlay_image"),
		"startDialogueGraph": Callable(self, "_start_dialogue_graph_from_action"),
		"playScriptedDialogue": Callable(self, "play_scripted_dialogue_from_action"),
		"waitClickContinue": func(hint_override: String = "") -> void:
			var label := hint_override.strip_edges()
			if label.is_empty():
				label = strings_provider.get_text("actions", "clickToContinue")
			await RuntimeClickContinuePromptScript.wait_click_continue_with_hint(renderer, input_manager, label),
		"resolveDisplayText": Callable(self, "resolve_display_text"),
		"chooseAction": Callable(action_choice_ui, "choose"),
		"resolveDisplayTextForPlayScripted": Callable(self, "resolve_display_text_for_play_scripted"),
		"scenarioStateManager": scenario_state_manager,
		"narrativeStateManager": narrative_state_manager,
		"documentRevealManager": document_reveal_manager,
		"spawnCutsceneActor": Callable(cutscene_manager, "spawn_temp_actor"),
		"removeCutsceneActor": Callable(cutscene_manager, "remove_temp_actor"),
		"setSceneEntityField": Callable(self, "_set_scene_entity_field_from_action"),
		"setHotspotDisplayImage": Callable(self, "_set_hotspot_display_image_from_action"),
		"tempSetHotspotDisplayFacing": Callable(self, "_temp_set_hotspot_display_facing_from_action"),
		"debugPanelLog": func(message: String) -> void: if debug_panel_ui != null: debug_panel_ui.log(message),
		"waterMinigameManager": water_minigame_manager,
		"sugarWheelMinigameManager": sugar_wheel_minigame_manager,
		"paperCraftMinigameManager": paper_craft_minigame_manager,
		"pressureHoldManager": pressure_hold_manager,
		"signalCueManager": signal_cue_manager,
		"healthSystem": health_system,
		"smellSystem": smell_system,
		"planeReconciler": plane_reconciler,
	})
	if OS.is_debug_build():
		for message: String in RuntimeActionRegistryScript.audit_action_registrations_against_manifest(action_executor):
			push_warning("[actionParamManifest 漂移] %s" % message)
	pressure_hold_manager.bind_runtime({
		"resolveDisplayText": Callable(self, "resolve_display_text"),
		"runSegment": Callable(self, "_run_pressure_hold_segment"),
	})
	water_minigame_manager.bind_runtime({"renderer": renderer, "inputManager": input_manager, "stateController": state_controller, "actionExecutor": action_executor, "dayManager": day_manager, "resolveDisplayText": Callable(self, "resolve_display_text")})
	await water_minigame_manager.load_index()
	await RuntimeMicrotaskQueueScript.yield_turn()
	sugar_wheel_minigame_manager.bind_runtime({"renderer": renderer, "inputManager": input_manager, "stateController": state_controller, "actionExecutor": action_executor, "playSfx": Callable(audio_manager, "play_sfx"), "resolveDisplayText": Callable(self, "resolve_display_text"), "debugPanelLog": func(message: String) -> void: if debug_panel_ui != null: debug_panel_ui.log(message), "evaluateBeforeChargeCondition": Callable(self, "_evaluate_sugar_wheel_condition")})
	await sugar_wheel_minigame_manager.load_index()
	await RuntimeMicrotaskQueueScript.yield_turn()
	paper_craft_minigame_manager.bind_runtime({"renderer": renderer, "inputManager": input_manager, "stateController": state_controller, "actionExecutor": action_executor, "resolveDisplayText": Callable(self, "resolve_display_text")})
	await paper_craft_minigame_manager.load_index()
	await RuntimeMicrotaskQueueScript.yield_turn()
	if tear_down_complete: return
	interaction_coordinator = RuntimeInteractionCoordinator.new(event_bus, {
		"stateController": state_controller,
		"sceneManager": scene_manager,
		"dialogueManager": dialogue_manager,
		"graphDialogueManager": graph_dialogue_manager,
		"actionExecutor": action_executor,
		"inspectBox": inspect_box,
		"eventBus": event_bus,
		"getPlayerWorldPos": func() -> Dictionary: return {"x": player.get_x(), "y": player.get_y()},
		"getCameraZoom": Callable(camera, "get_zoom"),
		"preparePlayerForNpcDialogue": func(npc: RuntimeNpc) -> void:
			player.set_facing(npc.get_x() - player.get_x(), npc.get_y() - player.get_y())
			player.play_animation("idle"),
		"fadingDialogueCameraZoom": Callable(cutscene_manager, "fading_camera_zoom"),
		"fadingRestoreSceneCameraZoom": func(duration_ms: float) -> void:
			cutscene_manager.fading_camera_zoom(_get_camera_baseline_zoom(), duration_ms),
	})
	interaction_coordinator.init()
	listen_event("archive:firstView", Callable(self, "_on_archive_first_view"))
	event_bridge = RuntimeEventBridge.new(event_bus, {
		"dialogueManager": dialogue_manager,
		"graphDialogueManager": graph_dialogue_manager,
		"encounterManager": encounter_manager,
		"stateController": state_controller,
		"actionExecutor": action_executor,
		"mapUI": map_ui,
		"menuUI": menu_ui,
		"inspectBox": inspect_box,
		"guardMapTravel": Callable(self, "_guard_map_travel"),
	})
	event_bridge.init()
	setup_scene_ready_handler()
	depth_debug_visualizer = RuntimeDepthDebugVisualizer.new(scene_depth_system, camera, renderer, asset_manager, func(message: String) -> void: debug_panel_ui.log(message))
	if OS.is_debug_build():
		debug_tools = RuntimeDebugTools.new({
			"renderer": renderer,
			"camera": camera,
			"eventBus": event_bus,
			"player": player,
			"inventoryManager": inventory_manager,
			"debugPanelUI": debug_panel_ui,
			"depthDebugVisualizer": depth_debug_visualizer,
			"getCurrentSceneId": func() -> Variant: return scene_manager.get_current_scene_id() if scene_manager != null else null,
			"fallbackScene": str(game_config.get("fallbackScene", "teahouse")),
			"reloadScene": Callable(self, "_reload_scene"),
			"isExploring": func() -> bool: return state_controller.current_state == RuntimeDataTypes.EXPLORING,
			"getDebugSceneWorldSize": Callable(self, "_get_debug_scene_world_size"),
			"applyDebugSceneWorldSize": Callable(self, "_apply_debug_scene_world_size"),
			"isDevMode": func() -> bool: return is_dev_mode,
			"goToDevScene": func() -> void: dev_load_scene("dev_room"),
			"getEntityPixelDensityMatchConfig": func() -> bool: return game_config.get("entityPixelDensityMatch") == true,
			"getEntityPixelDensityMatchEffective": Callable(self, "_get_entity_pixel_density_match_effective"),
			"getEntityPixelDensityMatchDebugOverride": func() -> Variant: return entity_pixel_density_match_debug_override,
			"cycleEntityPixelDensityMatchDebugOverride": Callable(self, "_cycle_entity_pixel_density_match_debug_override"),
			"getEntityPixelDensityMatchBlurScaleFromConfig": Callable(self, "_get_entity_pixel_density_match_blur_scale_from_config"),
			"getEntityPixelDensityMatchBlurScaleEffective": Callable(self, "_get_entity_pixel_density_match_blur_scale"),
			"getEntityPixelDensityMatchBlurScaleDebug": func() -> Variant: return entity_pixel_density_match_blur_scale_debug,
			"nudgeEntityPixelDensityMatchBlurScaleDebug": Callable(self, "_nudge_entity_pixel_density_match_blur_scale_debug"),
			"clearEntityPixelDensityMatchBlurScaleDebug": Callable(self, "_clear_entity_pixel_density_match_blur_scale_debug"),
			"getNarrativeDebugSnapshot": func() -> Dictionary: return build_runtime_debug_snapshot("debug-panel"),
			"getScenarioDebugPanelRows": Callable(self, "_list_scenario_debug_panel_rows"),
			"scenarioDebugActivate": Callable(self, "_scenario_debug_activate"),
			"scenarioDebugComplete": Callable(self, "_scenario_debug_complete"),
			"scenarioDebugResetIncomplete": Callable(self, "_scenario_debug_reset_incomplete"),
			"getDepthOcclusionBlendFactor": func() -> float: return scene_depth_system.occlusion_blend_factor,
			"setDepthOcclusionBlendFactor": func(value: float) -> void: scene_depth_system.occlusion_blend_factor = value,
			"depthOcclusionActive": func() -> bool: return scene_depth_system.is_enabled,
			"entityShadowActive": Callable(self, "_entity_shadow_debug_active"),
			"getEntityShadowDebug": Callable(self, "_get_entity_shadow_debug"),
			"cycleShadowMode": Callable(self, "_cycle_shadow_mode_debug"),
			"toggleEntityTone": Callable(self, "_toggle_entity_tone_debug"),
			"toggleEntityShadowBillboard": Callable(self, "_toggle_entity_shadow_billboard_debug"),
			"setEntityShadowAzimuth": Callable(self, "_set_entity_shadow_azimuth_debug"),
			"nudgeEntityShadowElevation": Callable(self, "_nudge_entity_shadow_elevation_debug"),
			"nudgeEntityShadowLength": Callable(self, "_nudge_entity_shadow_length_debug"),
			"nudgeEntityShadowDarkness": Callable(self, "_nudge_entity_shadow_darkness_debug"),
			"nudgeEntityShadowContact": Callable(self, "_nudge_entity_shadow_contact_debug"),
			"nudgeEntityShadowContactSize": Callable(self, "_nudge_entity_shadow_contact_size_debug"),
			"nudgeEntityShadowSoftSamples": Callable(self, "_nudge_entity_shadow_soft_samples_debug"),
			"toggleEntityShadowEnabled": Callable(self, "_toggle_entity_shadow_enabled_debug"),
			"smellDebug": {
				"listProfiles": Callable(self, "_list_smell_debug_profiles"),
				"set": Callable(smell_system, "set_smell"),
				"clear": Callable(smell_system, "clear_smell"),
				"setZone": Callable(smell_system, "set_zone_smell"),
				"clearZone": Callable(smell_system, "clear_zone_smell"),
				"sniff": Callable(smell_system, "sniff"),
				"getForm": Callable(hud, "get_smell_form"),
				"setFormParam": Callable(hud, "set_smell_form_param"),
			},
		})
		debug_tools.name = "DebugTools"
		add_child(debug_tools)
		debug_tools.init()
	load_flag_registry()
	load_character_registry()
	load_smell_profiles()
	await inventory_manager.load_defs()
	await rules_manager.load_defs()
	await quest_manager.load_defs()
	await encounter_manager.load_defs()
	await pressure_hold_manager.load_defs()
	await plane_reconciler.load_defs()
	signal_cue_manager.load_defs()
	await audio_manager.load_config()
	cutscene_manager.load_defs()
	if cutscene_manager.get_cutscene_ids().is_empty(): push_warning("CutsceneManager: cutscenes/index.json not found")
	archive_manager.load_defs()
	if not shop_ui.load_defs(): push_warning("ShopUI: shops.json not found")
	if not map_ui.load_config(): push_warning("MapUI: map_config.json not found")
	await RuntimeMicrotaskQueueScript.yield_turn()
	if tear_down_complete: return
	_refresh_text_resolve_lookups()
	await RuntimeMicrotaskQueueScript.yield_turn()
	if tear_down_complete: return
	wire_text_resolve()
	debug_panel_ui.attach_flag_debug(flag_store, event_bus)
	setup_cutscene_step_hud()
	setup_plane_debug_section()
	var fallback_scene := str(game_config.get("fallbackScene", "")).strip_edges()
	save_manager.set_fallback_scene(fallback_scene if not fallback_scene.is_empty() else str(game_config.get("initialScene", "")))
	await setup_player({"deferAvatar": is_dev_mode})
	if tear_down_complete: return
	setup_runtime_debug_snapshot_publishing()
	if is_dev_mode:
		await start_dev_mode(
			str(options.get("playCutscene", "")),
			str(options.get("waterPreview", "")),
			str(options.get("sugarWheelPreview", "")),
			str(options.get("paperCraftPreview", "")),
			str(options.get("devScene", "")),
			str(options.get("narrativeWarp", "")),
			options.get("visualCapture") == true,
		)
	else:
		var godot_initial_scene := str(options.get("_godotInitialScene", "")).strip_edges()
		var initial_quest := str(game_config.get("initialQuest", "")).strip_edges() if game_config is Dictionary else ""
		# parity-start-scene is an engine-shell test adapter.  Preserve its prior
		# compatibility contract: a scene override does not accept initialQuest.
		if godot_initial_scene.is_empty() and not initial_quest.is_empty():
			quest_manager.accept_quest(initial_quest)
		var initial_scene := godot_initial_scene if not godot_initial_scene.is_empty() else str(game_config.get("initialScene", ""))
		if not await scene_manager.load_initial_scene(initial_scene):
			push_error("SceneManager: initial scene failed: %s" % initial_scene)
		await _try_start_initial_prologue(game_config if game_config is Dictionary else {})

	if tear_down_complete or not renderer.is_initialized():
		return
	# Godot's Node process callback is the platform adapter for Pixi's ticker.
	last_time = float(Time.get_ticks_msec())
	main_tick = func(delta: float) -> void:
		if not fixed_tick_mode: tick(clampf(delta, 0.0, 0.1))
	set_process(true)
	setup_web_gl_panel_diagnostics()

	# Staged dev routes need the main tick for cutscene movement and minigames.
	if dev_startup_route.is_valid():
		var route := dev_startup_route
		dev_startup_route = Callable()
		await route.call()
	if tear_down_complete or not renderer.is_initialized():
		return
	runtime_ready = true
	setup_runtime_command_polling()
	await publish_runtime_debug_snapshot("runtime-ready")


func _on_dialogue_line_speaking_bubble(line: Variant) -> void:
	_clear_dialogue_speaking_bubble()
	if not line is Dictionary or not line.get("speakerEntity") is Dictionary: return
	var speaker_entity: Dictionary = line.speakerEntity; var anchor: Variant = null
	if speaker_entity.get("kind") == "player": anchor = player
	elif speaker_entity.get("kind") == "npc": anchor = scene_manager.get_npc_by_id(str(speaker_entity.get("npcId", "")))
	if anchor != null: emote_bubble_manager.show_sticky(anchor, "……", {}, "dialogue-speaking")


func _clear_dialogue_speaking_bubble(_payload: Variant = null) -> void:
	if emote_bubble_manager != null: emote_bubble_manager.cleanup_by_owner("dialogue-speaking")


func get_ambient_narrative_owner() -> Variant:
	return ambient_narrative_owner


func _resolve_action_actor(id: String) -> Variant:
	var key := id.strip_edges()
	var actor: Variant = cutscene_manager.get_temp_actors().get(key) if cutscene_manager != null else null
	if actor != null: return actor
	actor = scene_manager.get_npc_by_id(key) if scene_manager != null else null
	if actor != null: return actor
	return player if key == "player" else null


func _switch_scene_for_cutscene(params: Dictionary) -> void:
	if pickup_notification != null: pickup_notification.force_cleanup()
	if inspect_box != null and inspect_box.is_open(): inspect_box.close()
	var camera_position: Variant = null
	if (params.get("cameraX") is int or params.get("cameraX") is float) and (params.get("cameraY") is int or params.get("cameraY") is float):
		camera_position = {"x": float(params.cameraX), "y": float(params.cameraY)}
	await scene_manager.switch_scene(str(params.get("targetScene", "")), str(params.get("targetSpawnPoint", "")), camera_position)


func _resolve_cutscene_spawn_point(spawn_key: String) -> Variant:
	var scene := scene_manager.get_current_scene_data() if scene_manager != null else {}
	if scene.is_empty(): return null
	var key := spawn_key.strip_edges()
	if key.is_empty(): return scene.get("spawnPoint")
	var spawn_points: Variant = scene.get("spawnPoints")
	return spawn_points.get(key) if spawn_points is Dictionary else null


func run_scene_enter_actions(actions: Array) -> void:
	var scene_id := scene_manager.get_current_scene_id()
	ambient_narrative_owner = {"ownerType": "scene", "ownerId": scene_id} if not scene_id.is_empty() else null
	await action_executor.execute_batch_await(actions)
	ambient_narrative_owner = null


func play_scripted_dialogue_from_action(lines: Array) -> void:
	if lines.is_empty():
		push_warning("Game: playScriptedDialogue 收到空 lines，跳过")
		return
	var nested_in_graph := graph_dialogue_manager.is_active()
	state_controller.set_state(RuntimeDataTypes.DIALOGUE)
	var completion := RuntimeAsyncLatch.new()
	var on_end: Callable
	on_end = func(payload: Variant = null) -> void:
		if not payload is Dictionary or payload.get("source") != "scripted":
			return
		event_bus.off("dialogue:end", on_end)
		completion.resolve()
	event_bus.on("dialogue:end", on_end)
	dialogue_manager.start_scripted_dialogue(lines, nested_in_graph)
	await completion.wait()


func _start_dialogue_graph_from_action(graph_id: String, entry: String = "", npc_id: String = "", owner_type: String = "", owner_id: String = "", dim_background: bool = false) -> void:
	var id := graph_id.strip_edges()
	if id.is_empty(): return
	state_controller.set_state(RuntimeDataTypes.DIALOGUE)
	var npc_key := npc_id.strip_edges(); var npc_name := ""
	if not npc_key.is_empty():
		var npc: Variant = scene_manager.get_npc_by_id(npc_key)
		if npc != null: npc_name = str(npc.def.get("name", ""))
	var resolved_owner_type := owner_type.strip_edges(); var resolved_owner_id := owner_id.strip_edges()
	if resolved_owner_type.is_empty() and not npc_key.is_empty(): resolved_owner_type = "npc"
	if resolved_owner_id.is_empty(): resolved_owner_id = npc_key
	if resolved_owner_type.is_empty() and resolved_owner_id.is_empty() and ambient_narrative_owner is Dictionary:
		resolved_owner_type = str(ambient_narrative_owner.get("ownerType", "")); resolved_owner_id = str(ambient_narrative_owner.get("ownerId", ""))
	await graph_dialogue_manager.start_dialogue_graph({"graphId": id, "entry": entry.strip_edges(), "npcName": npc_name, "npcId": npc_key, "ownerType": resolved_owner_type, "ownerId": resolved_owner_id, "dimBackground": dim_background})
	if not graph_dialogue_manager.is_active() and not graph_dialogue_manager.has_pending_chain_continuation(): state_controller.set_state(RuntimeDataTypes.EXPLORING)


func evaluate_runtime_conditions(conditions: Array) -> bool:
	return RuntimeConditionEvalBridge.evaluate_condition_expr_list(conditions, build_condition_eval_context())


func _evaluate_sugar_wheel_condition(expression: Variant) -> bool:
	return true if expression == null else RuntimeConditionEvaluator.evaluate(expression, build_condition_eval_context())


func reload_saved_scene(scene_id: String) -> bool:
	if zone_system != null: zone_system.clear_active_zones_for_restore()
	return await _reload_scene(scene_id) if scene_manager != null else false


func _run_pressure_hold_segment(request: Dictionary) -> String:
	var previous := state_controller.current_state
	state_controller.set_state(RuntimeDataTypes.UI_OVERLAY)
	var outcome := await pressure_hold_ui.run_segment(request)
	if state_controller.current_state == RuntimeDataTypes.UI_OVERLAY:
		state_controller.set_state(previous)
	return outcome


func _show_debug_action_params(params: Dictionary) -> void:
	if DisplayServer.get_name() == "headless": return
	var title := str(params.get("title", "")).strip_edges()
	var body := (title + "\n\n" if not title.is_empty() else "") + JSON.stringify(params, "  ")
	OS.alert(body, "Action Params")


func _on_archive_first_view(payload: Variant) -> void:
	if payload is Dictionary and payload.get("actions") is Array:
		await action_executor.execute_batch_await(payload.actions)


func _on_renderer_resize() -> void:
	if camera != null and renderer != null: camera.set_screen_size(renderer.screen_width, renderer.screen_height)


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


func setup_web_gl_panel_diagnostics() -> void:
	# WebGL context/error hooks have no Godot rendering-server equivalent.
	return


func cutscene_step_hud_wanted() -> bool:
	# The browser's `?cutsceneDebug` switch is platform-only; devMode is the
	# shared source branch and remains the native-shell gate.
	return is_dev_mode


func setup_cutscene_step_hud() -> void:
	debug_panel_ui.add_section("cutscene-step", func() -> String:
		var snapshot := cutscene_manager.get_playback_hud_snapshot()
		if str(snapshot.get("cutsceneId", "")).is_empty():
			return "过场步骤：未在播放"
		return "过场步骤\ncutsceneId: %s\npath: %s\n%s" % [
			str(snapshot.cutsceneId),
			str(snapshot.get("path", "—")) if snapshot.get("path") != null else "—",
			str(snapshot.get("label", "")),
		]
	)
	if not cutscene_step_hud_wanted():
		return
	var panel := PanelContainer.new()
	panel.name = "CutsceneStepHud"
	panel.position = Vector2(8, 8)
	panel.custom_minimum_size = Vector2(minf(560.0, renderer.screen_width * 0.92), 0)
	panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.visible = false
	panel.z_index = 4095
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.059, 0.071, 0.094, 0.88)
	style.border_color = Color(0.47, 0.78, 0.55, 0.35)
	style.set_border_width_all(1)
	style.set_corner_radius_all(6)
	style.set_content_margin_all(8)
	panel.add_theme_stylebox_override("panel", style)
	var label := Label.new()
	label.name = "Text"
	label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	label.add_theme_font_size_override("font_size", 12)
	label.add_theme_color_override("font_color", Color("b8f6c6"))
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	panel.add_child(label)
	renderer.ui_layer.add_child(panel)
	cutscene_step_hud_el = panel
	listen_event("cutscene:step", func(payload: Variant = null) -> void:
		if cutscene_step_hud_el == null or not is_instance_valid(cutscene_step_hud_el):
			return
		if not payload is Dictionary or (payload.get("path") == null and payload.get("label") == null):
			cutscene_step_hud_el.visible = false
			return
		var text_label := cutscene_step_hud_el.get_node("Text") as Label
		text_label.text = "[过场 step] %s\npath: %s\n%s" % [
			str(payload.get("cutsceneId", "")),
			str(payload.get("path", "")),
			str(payload.get("label", "")),
		]
		cutscene_step_hud_el.visible = true
	)


func setup_plane_debug_section() -> void:
	debug_panel_ui.add_section("位面", func() -> String:
		var snapshot := plane_reconciler.get_debug_state()
		var definition: Variant = snapshot.get("def")
		var active_id := str(snapshot.get("activePlaneId", "normal"))
		var label := str(definition.get("label", "")) if definition is Dictionary else ""
		var lines: Array[String] = ["激活位面: %s%s" % [active_id, "（%s）" % label if not label.is_empty() else ""]]
		var source := str(snapshot.get("source", "default"))
		lines.push_back("来源: %s" % ({"manual": "manual（activatePlane 覆盖）", "narrative": "narrative（叙事点名）", "default": "default（normal 兜底）"}.get(source, source)))
		var named: Array[String] = []
		for entry: Variant in snapshot.get("namedBy", []):
			if entry is Dictionary: named.push_back("%s→%s" % [entry.get("graphId", ""), entry.get("planeId", "")])
		if not named.is_empty(): lines.push_back("点名: %s" % ", ".join(named))
		if definition is Dictionary:
			if definition.get("movement") is Dictionary:
				var movement: Dictionary = definition.movement
				lines.push_back("移动: drift=(%s,%s) speed×%s 跑=%s" % [movement.get("driftX", 0), movement.get("driftY", 0), movement.get("speedScale", 1), "允许" if movement.get("allowRun", true) != false else "禁止"])
			if definition.get("interaction") is Dictionary:
				var interaction: Dictionary = definition.interaction
				lines.push_back("交互: 热点=%s 拾取=%s 对话=%s" % ["可" if interaction.get("canInteractHotspots", true) != false else "禁", "可" if interaction.get("canPickup", true) != false else "禁", "可" if interaction.get("canTalkNpcs", true) != false else "禁"])
			if definition.get("camera") is Dictionary and definition.camera.has("zoom"): lines.push_back("相机 zoom: %s" % definition.camera.zoom)
			if definition.get("lighting") is Dictionary: lines.push_back("光照: 位面档生效（lightEnvCurve 挂起）")
			if definition.get("membership") == "exclusive": lines.push_back("世界模型: exclusive（独立世界，缺省实体不存在）")
			if definition.get("travel") is Dictionary and definition.travel.get("allowMapTravel") == false: lines.push_back("旅行: 地图快速旅行禁用")
		elif active_id != "normal":
			lines.push_back("（该位面未在 planes.json 注册，各槽按无配置处理）")
		var drain_parts: Array[String] = []
		if definition is Dictionary and definition.has("healthDrainPerSec"): drain_parts.push_back("位面 %s/s（仅 Exploring 计费）" % definition.healthDrainPerSec)
		for zone: Variant in zone_system.get_active_zones():
			if not zone is Dictionary: continue
			for pair: Array in [["onEnter", "进入"], ["onStay", "停留"]]:
				for action: Variant in zone.get(pair[0], []):
					if action is Dictionary and action.get("type") == "damagePlayer":
						var params: Variant = action.get("params")
						drain_parts.push_back("zone %s %s -%s" % [zone.get("id", ""), pair[1], params.get("amount", "?") if params is Dictionary else "?"])
		if not drain_parts.is_empty(): lines.push_back("掉阳气: %s" % "；".join(drain_parts))
		return "位面\n%s" % "\n".join(lines)
	)


func load_flag_registry() -> void:
	var registry: Variant = asset_manager.load_json("/assets/data/flag_registry.json")
	flag_store.configure_registry(registry)


func load_character_registry() -> void:
	var raw: Variant = asset_manager.load_json("/assets/data/character_registry.json")
	scene_manager.set_character_registry(RuntimeCharacterRegistryScript.build_character_registry(raw.get("characters") if raw is Dictionary else null))


func load_smell_profiles() -> void:
	var data: Variant = asset_manager.load_json("/assets/data/smell_profiles.json")
	if data is Dictionary:
		smell_profiles_data = data
		if hud != null:
			hud.set_smell_profiles(data)


func _load_game_config() -> void:
	var cfg: Variant = asset_manager.load_json("/assets/data/game_config.json")
	await RuntimeMicrotaskQueueScript.yield_turn()
	if cfg is Dictionary:
		var initial_scene: Variant = cfg.get("initialScene")
		if initial_scene is String and not initial_scene.is_empty(): game_config.initialScene = initial_scene
		var initial_quest: Variant = cfg.get("initialQuest")
		if initial_quest is String and not initial_quest.is_empty(): game_config.initialQuest = initial_quest
		var fallback_scene: Variant = cfg.get("fallbackScene")
		if fallback_scene is String and not fallback_scene.is_empty(): game_config.fallbackScene = fallback_scene
		if cfg.has("initialCutscene"): game_config.initialCutscene = cfg.initialCutscene
		if cfg.has("initialCutsceneDoneFlag"): game_config.initialCutsceneDoneFlag = cfg.initialCutsceneDoneFlag
		if cfg.get("startupFlags") is Dictionary:
			for key: String in cfg.startupFlags: flag_store.set_value(key, cfg.startupFlags[key])
		if cfg.get("viewport") is Dictionary: game_config.viewport = cfg.viewport.duplicate(true)
		if cfg.get("windowSize") is Dictionary: game_config.windowSize = cfg.windowSize.duplicate(true)
		if cfg.has("playerAvatar"):
			var player_avatar: Variant = cfg.playerAvatar
			if player_avatar is Dictionary:
				var previous: Dictionary = game_config.playerAvatar if game_config.get("playerAvatar") is Dictionary else {}
				var manifest: Variant = player_avatar.get("animManifest")
				var state_map: Variant = player_avatar.get("stateMap")
				game_config.playerAvatar = {
					"animManifest": manifest if manifest != null else previous.get("animManifest"),
					"stateMap": state_map.duplicate(true) if state_map is Dictionary else previous.get("stateMap"),
				}
		var density_match: Variant = cfg.get("entityPixelDensityMatch")
		if density_match is bool: game_config.entityPixelDensityMatch = density_match
		var blur_scale: Variant = cfg.get("entityPixelDensityMatchBlurScale")
		if (blur_scale is int or blur_scale is float) and not is_nan(float(blur_scale)) and not is_inf(float(blur_scale)) and float(blur_scale) > 0.0:
			game_config.entityPixelDensityMatchBlurScale = float(blur_scale)
		if cfg.get("entityLighting") is Dictionary: game_config.entityLighting = cfg.entityLighting.duplicate(true)
		if cfg.get("health") is Dictionary: game_config.health = cfg.health.duplicate(true)
	var overlays: Variant = asset_manager.load_json("/assets/data/overlay_images.json")
	await RuntimeMicrotaskQueueScript.yield_turn()
	overlay_image_registry = overlays.duplicate(true) if overlays is Dictionary else {}


func _resolve_overlay_image_id_to_path(image: String) -> String:
	var raw := image.strip_edges()
	if raw.is_empty() or raw.begins_with("/"): return raw
	var path := str(overlay_image_registry.get(raw, ""))
	if not path.is_empty(): return path
	push_warning("Game: overlay image id '%s' is not registered; treating it as a path" % raw)
	return raw


func build_animation_manifest_refs(anim_path: String, label_prefix: String) -> Array:
	var refs: Array = [{"type": "json", "path": anim_path, "label": "%s清单" % label_prefix}]
	var anim_raw: Variant = asset_manager.load_json(anim_path)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if anim_raw is Dictionary and anim_raw.get("spritesheet"):
		refs.push_back({
			"type": "texture",
			"path": RuntimeResourceLocator.get_default().resolve_anim_relative(anim_path, str(anim_raw.spritesheet)),
			"label": "%s图集" % label_prefix,
		})
	return refs


func load_player_avatar_resources(player_anim_path: String) -> Variant:
	var anim_raw: Variant = asset_manager.load_json(player_anim_path)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if not anim_raw is Dictionary:
		return null
	if anim_raw.get("spritesheet"):
		var sheet_path := RuntimeResourceLocator.get_default().resolve_anim_relative(player_anim_path, str(anim_raw.spritesheet))
		var texture: Variant = asset_manager.load_texture(sheet_path)
		await RuntimeMicrotaskQueueScript.yield_turn()
		if not texture is Texture2D:
			return null
		var anim_def := RuntimeAnimationSetResolverScript.normalize_animation_set_def(anim_raw, texture.get_width(), texture.get_height())
		return {"texture": texture, "animDef": anim_def}
	var placeholder: Dictionary = RuntimePlaceholderFactoryScript.create_placeholder_player_textures(renderer)
	var texture: Texture2D = placeholder.texture
	var anim_def := RuntimeAnimationSetResolverScript.normalize_animation_set_def(anim_raw, texture.get_width(), texture.get_height())
	return {"texture": texture, "animDef": anim_def}


func placeholder_player_avatar() -> Dictionary:
	var placeholder: Dictionary = RuntimePlaceholderFactoryScript.create_placeholder_player_textures(renderer)
	return {
		"texture": placeholder.texture,
		"animDef": {
			"spritesheet": "",
			"cols": 6,
			"rows": 1,
			"worldWidth": placeholder.frameWidth,
			"worldHeight": placeholder.frameHeight,
			"states": {
				"idle": {"frames": [0, 1], "frameRate": 2, "loop": true},
				"walk": {"frames": [2, 3, 4, 5], "frameRate": 8, "loop": true},
				"run": {"frames": [2, 3, 4, 5], "frameRate": 12, "loop": true},
			},
		},
	}


static func portrait_slug_from_manifest(path: String) -> Variant:
	var regex := RegEx.new()
	regex.compile("/animation/([^/]+)/anim\\.json")
	var matched := regex.search(path)
	return matched.get_string(1) if matched != null else null


func mount_player_avatar(
	texture: Texture2D,
	anim_def: Dictionary,
	state_map: Variant,
	source_path_for_log: String,
	apply_state_map: bool,
	portrait_slug: Variant = null,
) -> void:
	var explicit_slug: String = portrait_slug.strip_edges() if portrait_slug is String else ""
	current_player_portrait_slug = explicit_slug if not explicit_slug.is_empty() else portrait_slug_from_manifest(source_path_for_log)
	player_anim_def = anim_def
	player.sprite.load_from_def(texture, anim_def)
	var logical_state_map: Variant = state_map if apply_state_map else null
	player.sprite.set_logical_state_map(logical_state_map)
	if logical_state_map is Dictionary and anim_def.get("states") is Dictionary:
		for logical: Variant in logical_state_map:
			var clip := str(logical_state_map[logical])
			if not clip.is_empty() and not anim_def.states.has(clip):
				push_warning("Game: playerAvatar.stateMap[%s] -> %s is not a state in %s" % [JSON.stringify(str(logical)), JSON.stringify(clip), source_path_for_log])
	player.sprite.play_animation("idle")


func apply_player_avatar_from_action(
	manifest_path: String,
	state_map: Variant = null,
	portrait_slug: Variant = null,
) -> void:
	var path := manifest_path.strip_edges()
	if path.is_empty():
		return
	var loaded: Variant = await load_player_avatar_resources(path)
	if not loaded is Dictionary:
		push_warning("applyPlayerAvatar: 无法加载 %s" % path)
		return
	var logical_state_map: Variant = state_map if state_map is Dictionary and not state_map.is_empty() else null
	mount_player_avatar(loaded.texture, loaded.animDef, logical_state_map, path, true, portrait_slug)


func reset_player_avatar_from_action() -> void:
	var avatar: Variant = game_config.get("playerAvatar")
	var configured_path: Variant = avatar.get("animManifest") if avatar is Dictionary else null
	var path: String = configured_path.strip_edges() if configured_path is String else ""
	if path.is_empty():
		path = "/resources/runtime/animation/player_anim/anim.json"
	await apply_player_avatar_from_action(
		path,
		avatar.get("stateMap") if avatar is Dictionary else null,
		avatar.get("portraitSlug") if avatar is Dictionary else null,
	)


func setup_player(options: Dictionary = {}) -> void:
	var avatar: Variant = game_config.get("playerAvatar")
	var configured_path: Variant = avatar.get("animManifest") if avatar is Dictionary else null
	var player_anim_path: String = configured_path.strip_edges() if configured_path is String else ""
	if player_anim_path.is_empty():
		player_anim_path = "/resources/runtime/animation/player_anim/anim.json"
	var configured_state_map: Variant = avatar.get("stateMap") if avatar is Dictionary else null
	var configured_portrait_slug: Variant = avatar.get("portraitSlug") if avatar is Dictionary else null

	if options.get("deferAvatar") == true:
		var placeholder := placeholder_player_avatar()
		mount_player_avatar(placeholder.texture, placeholder.animDef, null, player_anim_path, false, configured_portrait_slug)
		var load_deferred := func() -> void:
			var refs: Array = await build_animation_manifest_refs(player_anim_path, "玩家动画")
			asset_manager.preload_manifest({"scopeId": "startup:player", "refs": refs}, {"mode": "runtime", "tolerateErrors": true})
			await RuntimeMicrotaskQueueScript.yield_turn()
			var loaded: Variant = await load_player_avatar_resources(player_anim_path)
			if not loaded is Dictionary or tear_down_complete or not renderer.is_initialized():
				return
			mount_player_avatar(loaded.texture, loaded.animDef, configured_state_map, player_anim_path, true, configured_portrait_slug)
		load_deferred.call()
	else:
		var refs: Array = await build_animation_manifest_refs(player_anim_path, "玩家动画")
		asset_manager.preload_manifest({"scopeId": "startup:player", "refs": refs}, {"mode": "stage", "tolerateErrors": true})
		await RuntimeMicrotaskQueueScript.yield_turn()
		var loaded: Variant = await load_player_avatar_resources(player_anim_path)
		if loaded is Dictionary:
			mount_player_avatar(loaded.texture, loaded.animDef, configured_state_map, player_anim_path, true, configured_portrait_slug)
		else:
			var placeholder := placeholder_player_avatar()
			mount_player_avatar(placeholder.texture, placeholder.animDef, null, player_anim_path, false, configured_portrait_slug)
	if player.sprite.get_parent() == null:
		renderer.entity_layer.add_child(player.sprite)
	var player_position_getter := func() -> Dictionary: return {"x": player.get_x(), "y": player.get_y()}
	interaction_system.set_player_position_getter(player_position_getter)
	zone_system.set_player_position_getter(player_position_getter)


func stop_npc_patrol(npc_id: String) -> void:
	var id := npc_id.strip_edges()
	if id.is_empty():
		return
	var npc: Variant = scene_manager.get_npc_by_id(id) if scene_manager != null else null
	if npc != null:
		npc.cancel_active_move()
	npc_patrol_epoch[id] = int(npc_patrol_epoch.get(id, 0)) + 1


func _start_npc_patrol_for_npc(npc_id: String) -> void:
	var id := npc_id.strip_edges()
	var npc: Variant = scene_manager.get_npc_by_id(id) if scene_manager != null else null
	if id.is_empty() or npc == null or not npc.def.get("patrol") is Dictionary:
		return
	var patrol: Dictionary = npc.def.patrol
	if not patrol.get("route") is Array or patrol.route.is_empty():
		return
	stop_npc_patrol(id)
	_run_npc_patrol(npc, patrol.route, float(patrol.get("speed", 60.0)), str(patrol.get("moveAnimState", "")))


func _sleep_while_npc_patrol_paused(npc: RuntimeNpc, generation: int) -> void:
	while npc.is_patrol_paused_for_dialogue() and patrol_generation == generation \
		and scene_manager.get_current_npcs().has(npc):
		await get_tree().create_timer(0.04).timeout


func _run_npc_patrol(npc: RuntimeNpc, route: Array, speed: float, move_anim_state: String = "") -> void:
	var generation := patrol_generation
	var npc_id := npc.get_id()
	var token_at_start := int(npc_patrol_epoch.get(npc_id, 0))
	var points: Array = []
	for raw: Variant in route:
		if not raw is Dictionary:
			continue
		var point := Vector2(float(raw.get("x", 0.0)), float(raw.get("y", 0.0)))
		if points.is_empty() or Vector2(float(points[-1].x), float(points[-1].y)).distance_to(point) > 0.001:
			points.push_back({"x": point.x, "y": point.y})
	if points.size() <= 1:
		if points.size() == 1:
			var only: Dictionary = points[0]
			npc.move_to(float(only.x), float(only.y), speed, move_anim_state)
		return
	var index := 0
	var step := 1
	while patrol_generation == generation and scene_manager.get_current_npcs().has(npc):
		if int(npc_patrol_epoch.get(npc_id, 0)) != token_at_start:
			break
		await _sleep_while_npc_patrol_paused(npc, generation)
		if patrol_generation != generation or not scene_manager.get_current_npcs().has(npc):
			break
		if int(npc_patrol_epoch.get(npc_id, 0)) != token_at_start:
			break
		var target: Dictionary = points[index]
		await npc.move_to(float(target.x), float(target.y), speed, move_anim_state)
		if patrol_generation != generation or not scene_manager.get_current_npcs().has(npc):
			break
		if not npc.consume_patrol_skip_waypoint_advance():
			index += step
			if index >= points.size():
				index = points.size() - 2
				step = -1
			elif index < 0:
				index = 1
				step = 1


func setup_scene_manager() -> void:
	scene_manager.set_player_position_setter(func(x: float, y: float) -> void:
		player.set_x(x)
		player.set_y(y)
	)
	scene_manager.set_camera_setter(func(bounds_width: float, bounds_height: float, snap_x: float, snap_y: float, camera_config: Variant, world_scale: float) -> void:
		camera.set_bounds(bounds_width, bounds_height)
		if camera_config is Dictionary and camera_config.get("pixelsPerUnit"):
			camera.set_pixels_per_unit(float(camera_config.pixelsPerUnit))
		if camera_config is Dictionary and camera_config.get("zoom"):
			camera.set_zoom(float(camera_config.zoom))
		camera.set_world_scale(world_scale)
		camera.snap_to(snap_x, snap_y)
	)
	scene_manager.set_bounds_only_setter(func(width: float, height: float) -> void:
		camera.set_bounds(width, height)
	)
	scene_manager.set_audio_applier(Callable(audio_manager, "apply_scene_audio"))
	scene_manager.set_audio_manifest_resolver(Callable(audio_manager, "get_scene_audio_refs"))
	scene_manager.set_zone_setter(Callable(zone_system, "set_zones"))
	scene_manager.set_interaction_setter(func(hotspots: Array, npcs: Array) -> void:
		interaction_system.set_hotspots(hotspots)
		interaction_system.set_npcs(npcs)
	)
	scene_manager.set_entity_filter_releaser(func(filters: Array) -> void:
		for filter: Variant in filters:
			scene_depth_system.remove_filter(filter)
			filter.destroy()
	)
	scene_manager.set_depth_loader(Callable(self, "_load_scene_depth_runtime"))
	scene_manager.set_depth_unloader(Callable(self, "_unload_scene_depth_runtime"))
	if get_meta("suppressSceneOnEnter", false) != true:
		scene_manager.set_scene_enter_runner(Callable(self, "run_scene_enter_actions"))


func _load_scene_depth_runtime(scene_id: String, scene: Dictionary, world_to_pixel_x: float, world_to_pixel_y: float) -> void:
	var depth_config: Variant = scene.get("depthConfig")
	if depth_config is Dictionary:
		scene_depth_system.load(
			scene_id,
			depth_config,
			asset_manager,
			float(scene.get("worldWidth", 1.0)),
			float(scene.get("worldHeight", 1.0)),
			world_to_pixel_x,
			world_to_pixel_y,
		)
	else:
		scene_depth_system.load_default()
	setup_scene_lighting(scene, world_to_pixel_x, world_to_pixel_y)
	refresh_player_world_collision()
	var texture: Variant = scene_depth_system.current_depth_texture
	log_depth_diag("depthLoader %s: depth=%s" % [scene_id, "loaded" if texture is Texture2D else "disabled"])
	run_depth_and_shader_gl_diagnostics(scene_id, texture, scene_depth_system.is_enabled)


func _unload_scene_depth_runtime() -> void:
	if scene_depth_system != null:
		scene_depth_system.unload()
		refresh_player_world_collision()
		if player != null and player.sprite != null:
			RuntimeSceneEntityFilterBinding.detach(player.sprite.container)
		player_depth_filter = null
		clear_entity_shadows()
	current_probe = null
	current_light_env = null
	current_light_curve = null
	current_shadow_field = null


func refresh_player_world_collision() -> void:
	player.set_depth_collision(Callable(self, "_is_player_world_collision"))


func setup_scene_lighting(scene: Dictionary, world_to_pixel_x: float, world_to_pixel_y: float) -> void:
	current_probe = null
	current_light_env = null
	current_light_curve = null
	current_shadow_field = null
	var lighting: Variant = game_config.get("entityLighting")
	if not lighting is Dictionary or lighting.get("enabled") != true:
		scene_depth_system.disable_lighting()
		return
	var env := RuntimeLightEnvResolver.resolve(scene.get("lightEnv"), lighting)
	current_light_env = env
	current_light_curve = RuntimeLightEnvCurve.prepare(scene.get("lightEnvCurve"))
	if current_light_curve != null and player != null:
		resolve_light_curve_into(player.get_x(), player.get_y(), env)
	current_shadow_field = RuntimeUniformShadowField.new(env)
	var primary_background: Variant = scene_manager.get_primary_background_texture()
	if primary_background is Texture2D:
		current_probe = RuntimeSceneDepthFilterAdapter.build_probe_texture(primary_background)
	scene_depth_system.enable_lighting(current_probe, env, float(scene.get("worldWidth", 1.0)), float(scene.get("worldHeight", 1.0)), world_to_pixel_x, world_to_pixel_y)


func _active_depth_floor_zones() -> Array:
	var result: Array = []
	if scene_manager == null: return result
	var raw: Variant = scene_manager.get_current_scene_data().get("zones")
	if not raw is Array: return result
	for zone: Variant in raw:
		if zone is Dictionary and scene_manager.is_entity_in_active_plane(zone): result.push_back(zone)
	return result


func _depth_floor_offset(zones: Array, x: float, y: float) -> float:
	return RuntimeDepthFloorZones.resolve(zones, x, y, flag_store, build_condition_eval_context())


func _update_scene_depth_runtime() -> void:
	if scene_depth_system == null or scene_manager == null or player == null or renderer == null or camera == null: return
	if not scene_depth_system.is_active: return
	var projection_scale := camera.get_projection_scale()
	scene_depth_system.update_per_frame(renderer.world_container.position.x, renderer.world_container.position.y, projection_scale)
	var zones := _active_depth_floor_zones()
	var pixel_match := _is_entity_pixel_density_match_rendering_on()
	var blur_scale := _get_entity_pixel_density_match_blur_scale()
	var world_to_pixel := Vector2(scene_depth_system.world_to_pixel_x, scene_depth_system.world_to_pixel_y)
	var player_x := player.get_x(); var player_y := player.get_y()
	if player_depth_filter != null and player.sprite != null:
		var player_size := player.sprite.get_world_size()
		RuntimeSceneEntityFilterBinding.configure_combined_pixel_blur(player_depth_filter, player.sprite.get_display_texture(), Vector2(float(player_size.width), float(player_size.height)), pixel_match, blur_scale, world_to_pixel, projection_scale)
		scene_depth_system.update_entity_depth_occlusion(player_depth_filter, player_x, player_y, _depth_floor_offset(zones, player_x, player_y))
	for npc: RuntimeNpc in scene_manager.get_current_npcs():
		if npc.sprite == null or npc.def.get("renderRaw") == true: continue
		var filter: Variant = RuntimeSceneEntityFilterBinding.get_filter(npc.container)
		if filter == null: continue
		var npc_size := npc.get_world_size()
		RuntimeSceneEntityFilterBinding.configure_combined_pixel_blur(filter, npc.get_display_texture(), Vector2(float(npc_size.width), float(npc_size.height)), pixel_match, blur_scale, world_to_pixel, projection_scale)
		scene_depth_system.update_entity_depth_occlusion(filter, npc.get_x(), npc.get_y(), _depth_floor_offset(zones, npc.get_x(), npc.get_y()))
	for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():
		var filter: Variant = hotspot.get_depth_occlusion_filter()
		if filter == null or hotspot.display_sprite == null: continue
		var size := hotspot.get_world_size(); var foot_y := hotspot.depth_occlusion_foot_world_y()
		RuntimeSceneEntityFilterBinding.configure_combined_pixel_blur(filter, hotspot.get_display_texture(), Vector2(float(size.width), float(size.height)), pixel_match, blur_scale, world_to_pixel, projection_scale)
		scene_depth_system.update_entity_depth_occlusion(filter, hotspot.get_center_x(), foot_y, _depth_floor_offset(zones, hotspot.get_center_x(), foot_y))


func rebuild_entity_shadows() -> void:
	clear_entity_shadows()
	var env: Variant = current_light_env
	if not env is Dictionary or env.get("shadow", {}).get("mode") == "off" or not scene_depth_system.is_lighting_enabled:
		return
	entity_shadows["player"] = {
		"shadow": create_shadow_impl(str(env.shadow.mode)),
		"src": make_player_shadow_source(),
		"owner": player,
	}
	for npc: RuntimeNpc in scene_manager.get_current_npcs():
		build_npc_shadow_entry(npc)
	for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():
		build_hotspot_shadow_entry(hotspot)


func rebuild_entity_shadows_for_ids(npc_ids: Array, hotspot_ids: Array) -> void:
	var env: Variant = current_light_env
	var shadows_on: bool = env is Dictionary and env.get("shadow", {}).get("mode") != "off" and scene_depth_system.is_lighting_enabled
	for raw_id: Variant in npc_ids:
		var id := str(raw_id)
		destroy_entity_shadow_entry(id)
		if not shadows_on:
			continue
		var npc: Variant = scene_manager.get_npc_by_id(id)
		if npc is RuntimeNpc:
			build_npc_shadow_entry(npc)
	for raw_id: Variant in hotspot_ids:
		var id := str(raw_id)
		destroy_entity_shadow_entry("hotspot:%s" % id)
		if not shadows_on:
			continue
		for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():
			if hotspot.get_id() == id:
				build_hotspot_shadow_entry(hotspot)
				break


func destroy_entity_shadow_entry(key: String) -> void:
	var entry: Variant = entity_shadows.get(key)
	if not entry is Dictionary:
		return
	scene_depth_system.unregister_shadow(entry.shadow)
	entry.shadow.destroy()
	entity_shadows.erase(key)


func build_npc_shadow_entry(npc: RuntimeNpc) -> void:
	var env: Variant = current_light_env
	if not env is Dictionary or npc.def.get("castShadow") == false:
		return
	entity_shadows[npc.get_id()] = {
		"shadow": create_shadow_impl(str(env.shadow.mode)),
		"src": make_npc_shadow_source(npc),
		"owner": npc,
	}


func build_hotspot_shadow_entry(hotspot: RuntimeHotspot) -> void:
	var env: Variant = current_light_env
	var display_image: Variant = hotspot.def.get("displayImage")
	if not env is Dictionary or hotspot.def.get("castShadow") == false \
		or not display_image is Dictionary or str(display_image.get("image", "")).is_empty():
		return
	entity_shadows["hotspot:%s" % hotspot.get_id()] = {
		"shadow": create_shadow_impl(str(env.shadow.mode)),
		"src": make_hotspot_shadow_source(hotspot),
		"owner": hotspot,
	}


func create_shadow_impl(mode: String) -> Variant:
	var context: Variant = scene_depth_system.get_shadow_scene_context()
	var shadow: Variant = RuntimeDeferredEntityShadow.new(renderer.shadow_layer, context) if mode == "real" and context is Dictionary else RuntimePlanarEntityShadow.new(renderer.shadow_layer, context)
	scene_depth_system.register_shadow(shadow)
	return shadow


func apply_shadow_and_ao() -> void:
	var env: Variant = current_light_env
	if not env is Dictionary: return
	var mode := str(env.get("shadow", {}).get("mode", "off"))
	scene_depth_system.apply_shadow_filter_tone_ao(float(env.get("toneStrength", 0.0)) if env.get("toneEnabled", true) == true else 0.0, float(env.get("ao", {}).get("contact", 0.0)) if mode == "off" else 0.0, float(env.get("ao", {}).get("form", 0.0)) if mode != "off" else 0.0)


func _apply_shadow_mode_change() -> void:
	rebuild_entity_shadows()
	apply_shadow_and_ao()


func resolve_light_curve_into(x: float, y: float, env: Dictionary) -> void:
	if current_light_curve == null: return
	var partial := RuntimeLightEnvCurve.interpolate(current_light_curve, RuntimeLightEnvCurve.project_to_t(current_light_curve, x, y))
	RuntimeLightEnvCurve.copy_resolved_into(env, RuntimeLightEnvResolver.resolve(partial, game_config.get("entityLighting", {})))


func _get_camera_baseline_zoom() -> float:
	var plane_zoom: Variant = plane_reconciler.get_active_camera_zoom() if plane_reconciler != null else null
	if plane_zoom is int or plane_zoom is float: return float(plane_zoom)
	var scene_data := scene_manager.get_current_scene_data() if scene_manager != null else {}
	var zoom: Variant = scene_data.get("camera", {}).get("zoom") if scene_data.get("camera") is Dictionary else null
	return float(zoom) if (zoom is int or zoom is float) and float(zoom) > 0.0 else 1.0


func apply_plane_light_env_override(partial: Variant) -> void:
	if partial == null and plane_light_env_override == null: return
	plane_light_env_override = partial
	if not current_light_env is Dictionary: return
	var previous_mode := str(current_light_env.get("shadow", {}).get("mode", "off"))
	var scene_light_env: Variant = scene_manager.get_current_scene_data().get("lightEnv") if scene_manager != null else null
	RuntimeLightEnvCurve.copy_resolved_into(current_light_env, RuntimeLightEnvResolver.resolve(partial if partial is Dictionary else scene_light_env, game_config.get("entityLighting", {})))
	scene_depth_system.apply_key_ambient(current_light_env.key.color, float(current_light_env.key.intensity), current_light_env.ambient.color, float(current_light_env.ambient.intensity))
	apply_shadow_and_ao()
	if str(current_light_env.shadow.mode) != previous_mode: rebuild_entity_shadows()


func update_light_env_from_curve() -> void:
	if current_light_curve == null or not current_light_env is Dictionary or plane_light_env_override is Dictionary: return
	if debug_panel_ui != null and debug_panel_ui.is_open(): return
	var previous_mode := str(current_light_env.get("shadow", {}).get("mode", "off"))
	resolve_light_curve_into(player.get_x(), player.get_y(), current_light_env)
	scene_depth_system.apply_key_ambient(current_light_env.key.color, float(current_light_env.key.intensity), current_light_env.ambient.color, float(current_light_env.ambient.intensity))
	apply_shadow_and_ao()
	if str(current_light_env.shadow.mode) != previous_mode: rebuild_entity_shadows()


func update_entity_shadows() -> void:
	if not current_light_env is Dictionary or entity_shadows.is_empty(): return
	var player_entry: Variant = entity_shadows.get("player")
	if player_entry is Dictionary:
		player_entry.shadow.update(player_entry.src, current_light_env, current_shadow_field)
	for npc: RuntimeNpc in scene_manager.get_current_npcs():
		var entry: Variant = entity_shadows.get(npc.get_id())
		if not entry is Dictionary: continue
		if not is_same(entry.owner, npc):
			entry.owner = npc
			entry.src = make_npc_shadow_source(npc)
		entry.shadow.update(entry.src, current_light_env, current_shadow_field)
	for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():
		var entry: Variant = entity_shadows.get("hotspot:%s" % hotspot.get_id())
		if not entry is Dictionary: continue
		if not is_same(entry.owner, hotspot):
			entry.owner = hotspot
			entry.src = make_hotspot_shadow_source(hotspot)
		entry.shadow.update(entry.src, current_light_env, current_shadow_field)


func make_player_shadow_source() -> RuntimeEntityShadowSource:
	return RuntimeEntityShadowSourceScript.for_player(player)


func make_npc_shadow_source(npc: RuntimeNpc) -> RuntimeEntityShadowSource:
	return RuntimeEntityShadowSourceScript.for_npc(npc)


func make_hotspot_shadow_source(hotspot: RuntimeHotspot) -> RuntimeEntityShadowSource:
	return RuntimeEntityShadowSourceScript.for_hotspot(hotspot)


func clear_entity_shadows() -> void:
	for entry: Variant in entity_shadows.values():
		if entry is Dictionary and entry.get("shadow") != null:
			scene_depth_system.unregister_shadow(entry.shadow)
			entry.shadow.destroy()
	entity_shadows.clear()


func _entity_shadow_debug_active() -> bool:
	return scene_depth_system.is_lighting_enabled and current_light_env is Dictionary


func _get_entity_shadow_debug() -> Variant:
	if not current_light_env is Dictionary:
		return null
	var env: Dictionary = current_light_env
	return {
		"mode": env.shadow.mode,
		"toneEnabled": env.toneEnabled,
		"billboard": env.shadow.billboard,
		"enabled": env.shadow.enabled,
		"azimuthDeg": env.key.azimuthDeg,
		"elevationDeg": env.key.elevationDeg,
		"lengthFactor": env.shadow.length,
		"darkness": env.shadow.darkness,
		"contact": env.shadow.contact,
		"contactSize": env.shadow.contactSize,
		"softSamples": env.shadow.softSamples,
	}


func _cycle_shadow_mode_debug() -> void:
	if not current_light_env is Dictionary: return
	var mode := str(current_light_env.shadow.mode)
	current_light_env.shadow.mode = "planar" if mode == "real" else ("off" if mode == "planar" else "real")
	_apply_shadow_mode_change()


func _toggle_entity_tone_debug() -> void:
	if not current_light_env is Dictionary: return
	current_light_env.toneEnabled = current_light_env.get("toneEnabled", true) != true
	apply_shadow_and_ao()


func _toggle_entity_shadow_billboard_debug() -> void:
	if not current_light_env is Dictionary: return
	current_light_env.shadow.billboard = "camera" if current_light_env.shadow.get("billboard", "light") == "light" else "light"


func _nudge_entity_shadow_elevation_debug(delta: float) -> void:
	if current_light_env is Dictionary: current_light_env.key.elevationDeg = clampf(float(current_light_env.key.elevationDeg) + delta, 5.0, 85.0)


func _nudge_entity_shadow_soft_samples_debug(delta: float) -> void:
	if current_light_env is Dictionary: current_light_env.shadow.softSamples = clampi(int(round(float(current_light_env.shadow.softSamples) + delta)), 1, 8)


func _set_entity_shadow_azimuth_debug(degrees: float) -> void:
	if current_light_env is Dictionary and is_finite(degrees): current_light_env.key.azimuthDeg = fposmod(degrees, 360.0)


func _nudge_entity_shadow_length_debug(delta: float) -> void:
	if current_light_env is Dictionary: current_light_env.shadow.length = clampf(float(current_light_env.shadow.length) + delta, 0.05, 3.0)


func _nudge_entity_shadow_darkness_debug(delta: float) -> void:
	if current_light_env is Dictionary: current_light_env.shadow.darkness = clampf(float(current_light_env.shadow.darkness) + delta, 0.0, 1.0)


func _nudge_entity_shadow_contact_debug(delta: float) -> void:
	if current_light_env is Dictionary: current_light_env.shadow.contact = clampf(float(current_light_env.shadow.contact) + delta, 0.0, 1.0)


func _nudge_entity_shadow_contact_size_debug(delta: float) -> void:
	if current_light_env is Dictionary: current_light_env.shadow.contactSize = clampf(float(current_light_env.shadow.contactSize) + delta, 0.1, 3.0)


func _toggle_entity_shadow_enabled_debug() -> void:
	if current_light_env is Dictionary: current_light_env.shadow.enabled = current_light_env.shadow.get("enabled", true) != true


func build_condition_eval_context() -> Dictionary:
	return {
		"flagStore": flag_store,
		"questManager": quest_manager,
		"scenarioState": scenario_state_manager,
		"narrativeState": narrative_state_manager,
		"getActivePlaneId": func() -> String: return plane_reconciler.get_active_plane_id() if plane_reconciler != null else "normal",
		"resolveConditionLiteral": func(value: String) -> String: return resolve_display_text(value),
		"currentOwner": ambient_narrative_owner,
		"currentSceneId": scene_manager.get_current_scene_id() if scene_manager != null else "",
	}


func _guard_map_travel() -> bool:
	if plane_reconciler == null or plane_reconciler.is_map_travel_allowed(): return true
	event_bus.emit("notification:show", {"text": strings_provider.get_text("notifications", "mapTravelBlocked"), "type": "warning"})
	return false


func _register_ui_panels() -> void:
	# Keep the insertion order identical to Game.registerUIPanels: shortcut
	# dispatch, Esc close priority and panel destruction all depend on it.
	state_controller.register_panel("quest", quest_panel_ui, "Tab")
	state_controller.register_panel("inventory", inventory_ui, "KeyI")
	state_controller.register_panel("rules", rules_panel_ui, "KeyR")
	state_controller.register_panel("dialogueLog", dialogue_log_ui, "KeyL")
	state_controller.register_panel("bookshelf", bookshelf_ui, "KeyB")
	state_controller.register_panel("map", map_ui, "KeyM", {"openGuard": Callable(self, "_guard_map_travel")})
	state_controller.register_panel("ruleUse", rule_use_ui, "KeyF")
	state_controller.register_panel("shop", shop_ui)
	state_controller.register_panel("menu", menu_ui)
	if OS.is_debug_build():
		state_controller.register_panel("debug", debug_panel_ui, "F2", {"alwaysOpenable": true, "overlaysGameState": false})
	state_controller.set_escape_fallback(func() -> void: state_controller.toggle_panel("menu"))
	touch_mobile_controls = RuntimeTouchMobileControls.new(renderer, input_manager, state_controller, strings_provider)


func log_depth_diag(message: String) -> void:
	if debug_panel_ui != null:
		debug_panel_ui.log("[深度诊断] %s" % message)


func run_depth_and_shader_gl_diagnostics(scene_id: String, depth_texture: Variant, depth_enabled: bool) -> void:
	# Source diagnostics probe Pixi/WebGL program objects. Godot's rendering
	# server owns native shader compilation, so retain Game's diagnostic boundary
	# and report the equivalent loaded/disabled state without moving ownership.
	if debug_panel_ui == null:
		return
	if depth_enabled and depth_texture is Texture2D:
		debug_panel_ui.log("[GL诊断] %s 深度贴图(RenderingServer) %sx%s" % [scene_id, depth_texture.get_width(), depth_texture.get_height()])
	elif not depth_enabled:
		debug_panel_ui.log("[GL诊断] %s: depthEnabled=false，跳过深度 GPU 探测" % scene_id)


func setup_scene_ready_handler() -> void:
	listen_event("scene:beforeUnload", Callable(self, "_on_scene_before_unload_runtime_sync"))
	listen_event("scene:ready", Callable(self, "_on_scene_ready_runtime_sync"))
	listen_event("scene:entitiesRebuilt", Callable(self, "_on_scene_entities_rebuilt_runtime_sync"))


func _on_scene_before_unload_runtime_sync(_payload: Variant = null) -> void:
	patrol_generation += 1
	npc_patrol_epoch.clear()
	for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():
		var filter: Variant = hotspot.detach_depth_occlusion_filter()
		if filter != null:
			scene_depth_system.remove_filter(filter)
			filter.destroy()


func _on_scene_ready_runtime_sync(_payload: Variant = null) -> void:
	player.sync_movement_from_scene(scene_manager.get_current_scene_data())
	interaction_system.update(0.0)

	var lighting_on := scene_depth_system.is_lighting_enabled
	var player_size := player.sprite.get_world_size()
	player_depth_filter = scene_depth_system.create_lighting_filter_for_entity(float(player_size.height) * 0.4) if lighting_on else scene_depth_system.create_filter_for_entity()
	if player_depth_filter != null:
		RuntimeSceneEntityFilterBinding.attach(player.sprite.container, player_depth_filter, player.sprite.sprite)
	else:
		RuntimeSceneEntityFilterBinding.detach(player.sprite.container)

	for npc: RuntimeNpc in scene_manager.get_current_npcs():
		attach_npc_scene_filters(npc)
		_start_npc_patrol_if_eligible(npc)
	for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():
		attach_hotspot_depth_filter(hotspot)

	rebuild_entity_shadows()
	apply_shadow_and_ao()
	_sync_entity_pixel_density_match()

	if depth_debug_visualizer != null and scene_depth_system.current_depth_texture != null and scene_depth_system.current_config is Dictionary:
		var scene := scene_manager.get_current_scene_data()
		var texture := scene_depth_system.current_depth_texture
		depth_debug_visualizer.on_scene_loaded(
			scene_depth_system.current_scene_id,
			texture,
			texture.get_width(),
			texture.get_height(),
			float(scene.get("worldWidth", 0.0)),
			float(scene.get("worldHeight", 0.0)),
			scene_depth_system.current_config,
		)
		log_depth_diag("scene:ready: 背景调试已绑定 %sx%s" % [texture.get_width(), texture.get_height()])


func _is_player_world_collision(world_x: float, world_y: float) -> bool:
	if scene_depth_system != null and scene_depth_system.is_collision(world_x, world_y): return true
	if scene_manager == null: return false
	for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():
		if not hotspot.get_active(): continue
		var polygon: Variant = RuntimeHotspotCollisionScript.hotspot_collision_polygon_to_world(hotspot.def)
		if RuntimeZoneGeometry.is_valid_zone_polygon(polygon) and RuntimeZoneGeometry.is_point_in_polygon(polygon, world_x, world_y): return true
	for npc: RuntimeNpc in scene_manager.get_current_npcs():
		if not npc.container.visible: continue
		var polygon: Variant = RuntimeHotspotCollisionScript.npc_collision_polygon_to_world(npc)
		if RuntimeZoneGeometry.is_valid_zone_polygon(polygon) and RuntimeZoneGeometry.is_point_in_polygon(polygon, world_x, world_y): return true
	return false


func _on_scene_entities_rebuilt_runtime_sync(payload: Variant) -> void:
	if not payload is Dictionary:
		return
	for raw_id: Variant in payload.get("npcIds", []):
		var id := str(raw_id)
		var npc: Variant = scene_manager.get_npc_by_id(id)
		if not npc is RuntimeNpc:
			continue
		stop_npc_patrol(id)
		attach_npc_scene_filters(npc)
		if payload.get("phase") == "exit":
			_start_npc_patrol_if_eligible(npc)
	for raw_id: Variant in payload.get("hotspotIds", []):
		var hotspot_id := str(raw_id)
		for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():
			if hotspot.get_id() == hotspot_id:
				attach_hotspot_depth_filter(hotspot)
				break
	rebuild_entity_shadows_for_ids(
		payload.get("npcIds", []) if payload.get("npcIds") is Array else [],
		payload.get("hotspotIds", []) if payload.get("hotspotIds") is Array else [],
	)
	apply_shadow_and_ao()
	_sync_entity_pixel_density_match()


func attach_npc_scene_filters(npc: RuntimeNpc) -> void:
	if npc.sprite == null or npc.def.get("renderRaw") == true:
		return
	var lighting_on := scene_depth_system.is_lighting_enabled
	var size := npc.get_world_size()
	var filter: Variant = scene_depth_system.create_lighting_filter_for_entity(float(size.height) * 0.4) if lighting_on else scene_depth_system.create_filter_for_entity()
	if filter != null:
		RuntimeSceneEntityFilterBinding.attach(npc.container, filter, npc.sprite.sprite)


func _start_npc_patrol_if_eligible(npc: RuntimeNpc) -> void:
	if npc.container.visible and npc.def.get("patrol") is Dictionary \
		and not scene_manager.is_npc_patrol_persistently_disabled(npc.get_id()):
		var patrol: Dictionary = npc.def.patrol
		if patrol.get("route") is Array and not patrol.route.is_empty():
			_run_npc_patrol(npc, patrol.route, float(patrol.get("speed", 60.0)), str(patrol.get("moveAnimState", "")))


func attach_hotspot_depth_filter(hotspot: RuntimeHotspot) -> void:
	if not hotspot.has_depth_display_image():
		return
	var filter: Variant = scene_depth_system.create_filter_for_entity()
	if filter != null:
		hotspot.attach_depth_occlusion_filter(filter)


func load_narrative_warps() -> void:
	var data: Variant = asset_manager.load_json("/assets/data/dev_narrative_warps.json")
	await RuntimeMicrotaskQueueScript.yield_turn()
	narrative_warps = data.get("warps", []).duplicate(true) if data is Dictionary and data.get("warps") is Array else []


func enter_narrative_warp(id: String) -> void:
	var warp: Variant = null
	for candidate: Variant in narrative_warps:
		if candidate is Dictionary and str(candidate.get("id", "")) == id:
			warp = candidate
			break
	if not warp is Dictionary:
		return
	var flow_graph := str(warp.get("flowGraph", "")).strip_edges()
	var flow_state := str(warp.get("flowState", "")).strip_edges()
	if not flow_graph.is_empty() and not flow_state.is_empty():
		var graph: Variant = narrative_state_manager.get_graph(flow_graph)
		if not graph is Dictionary:
			push_warning('enterNarrativeWarp: 找不到流程图 "%s"' % flow_graph)
		else:
			var adjacency := {}
			for transition: Variant in graph.get("transitions", []):
				if not transition is Dictionary: continue
				var from_state := str(transition.get("from", ""))
				if not adjacency.has(from_state): adjacency[from_state] = []
				adjacency[from_state].push_back(str(transition.get("to", "")))
			var start := str(graph.get("initialState", ""))
			var came_from := {}
			var seen := {start: true}
			var queue: Array[String] = [start]
			while not queue.is_empty():
				var current: String = queue.pop_front()
				if current == flow_state: break
				for next: Variant in adjacency.get(current, []):
					var next_state := str(next)
					if seen.has(next_state): continue
					seen[next_state] = true
					came_from[next_state] = current
					queue.push_back(next_state)
			if not seen.has(flow_state):
				push_warning('enterNarrativeWarp: 流程图 "%s" 从 "%s" 无迁移路径可达 "%s"，已跳过主线推进' % [flow_graph, start, flow_state])
			else:
				var path: Array[String] = []
				var cursor := flow_state
				while true:
					path.push_front(cursor)
					if cursor == start: break
					if not came_from.has(cursor): break
					cursor = str(came_from[cursor])
				for state_id: String in path:
					await narrative_state_manager.debug_set_narrative_state(flow_graph, state_id)
	for state: Variant in warp.get("set", []):
		if state is Dictionary:
			await narrative_state_manager.debug_set_narrative_state(str(state.get("graph", "")), str(state.get("state", "")))
	await dev_load_scene(str(warp.get("scene", "")))


func start_dev_mode(
	play_cutscene: String = "",
	water_preview: String = "",
	sugar_wheel_preview: String = "",
	paper_craft_preview: String = "",
	dev_scene: String = "",
	narrative_warp: String = "",
	visual_capture: bool = false,
) -> void:
	const DEV_SCENE := "dev_room"
	await scene_manager.load_scene(DEV_SCENE)
	await load_narrative_warps()
	dev_mode_ui = RuntimeDevModeUI.new(renderer, {
		"getCutsceneIds": func() -> Array: return cutscene_manager.get_cutscene_ids(),
		"playCutscene": Callable(self, "dev_play_cutscene"),
		"getScenes": Callable(self, "get_dev_scene_entries"),
		"loadScene": Callable(self, "dev_load_scene"),
		"reload": Callable(self, "dev_reload"),
		"getMinigameEntries": Callable(self, "_get_dev_minigame_entries"),
		"launchMinigame": Callable(self, "_dev_launch_minigame"),
		"getNarrativeWarps": Callable(self, "get_narrative_warp_entries"),
		"enterNarrativeWarp": Callable(self, "enter_narrative_warp"),
	})
	if not visual_capture: dev_mode_ui.open()

	var reopen_dev_hub := func() -> void:
		if not is_dev_mode: return
		if scene_manager.get_current_scene_id() == DEV_SCENE and dev_mode_ui != null: dev_mode_ui.open()
	water_minigame_manager.set_on_session_end(reopen_dev_hub)
	sugar_wheel_minigame_manager.set_on_session_end(reopen_dev_hub)
	paper_craft_minigame_manager.set_on_session_end(reopen_dev_hub)

	# The source stores this route until mainTick is attached.  playCutscene is
	# additive; the remaining direct-entry branches are mutually exclusive.
	dev_startup_route = func() -> void:
		var cutscene_id := play_cutscene.strip_edges()
		if not cutscene_id.is_empty(): await dev_play_cutscene(cutscene_id)
		var warp_id := narrative_warp.strip_edges()
		if not warp_id.is_empty():
			await enter_narrative_warp(warp_id)
			return
		var scene_id := dev_scene.strip_edges()
		if not scene_id.is_empty():
			if scene_id != DEV_SCENE: await dev_load_scene(scene_id)
			return
		var water_id := water_preview.strip_edges()
		if not water_id.is_empty():
			if dev_mode_ui != null: dev_mode_ui.close()
			await water_minigame_manager.start(water_id)
			return
		var sugar_id := sugar_wheel_preview.strip_edges()
		if not sugar_id.is_empty():
			if dev_mode_ui != null: dev_mode_ui.close()
			await sugar_wheel_minigame_manager.start(sugar_id)
			return
		var paper_id := paper_craft_preview.strip_edges()
		if not paper_id.is_empty():
			if dev_mode_ui != null: dev_mode_ui.close()
			await paper_craft_minigame_manager.start(paper_id)


func get_narrative_warp_entries() -> Array:
	var result: Array = []
	for warp: Variant in narrative_warps:
		if warp is Dictionary:
			result.push_back({"id": str(warp.get("id", "")), "label": str(warp.get("label", ""))})
	return result


func _get_dev_minigame_entries() -> Array:
	var result: Array = []
	for pair: Array in [[water_minigame_manager, "water"], [sugar_wheel_minigame_manager, "sugarWheel"], [paper_craft_minigame_manager, "paperCraft"]]:
		for raw: Dictionary in pair[0].get_instance_list():
			var entry := raw.duplicate(true); entry.kind = pair[1]; result.push_back(entry)
	return result


func _dev_launch_minigame(entry: Dictionary) -> void:
	if dev_mode_ui != null: dev_mode_ui.close()
	match str(entry.get("kind", "")):
		"sugarWheel": sugar_wheel_minigame_manager.start(str(entry.get("id", "")))
		"paperCraft": paper_craft_minigame_manager.start(str(entry.get("id", "")))
		_: water_minigame_manager.start(str(entry.get("id", "")))


func dev_play_cutscene(id: String) -> void:
	if cutscene_manager.is_playing(): return
	if dev_mode_ui != null: dev_mode_ui.close()
	state_controller.set_state(RuntimeDataTypes.CUTSCENE)
	await cutscene_manager.start_cutscene(id)
	state_controller.set_state(RuntimeDataTypes.EXPLORING)
	if is_dev_mode:
		if scene_manager.get_current_scene_id() != "dev_room":
			await scene_manager.switch_scene("dev_room")
		if dev_mode_ui != null: dev_mode_ui.open()


func dev_reload() -> void:
	get_tree().reload_current_scene()


func get_dev_scene_ids() -> Array[String]:
	var seen := {}
	for raw_id: Variant in map_ui.get_configured_scene_ids():
		var id := str(raw_id).strip_edges()
		if not id.is_empty(): seen[id] = true
	seen["dev_room"] = true
	for key: String in ["initialScene", "fallbackScene"]:
		var id := str(game_config.get(key, "")).strip_edges()
		if not id.is_empty(): seen[id] = true
	var ids: Array[String] = []
	for raw_id: Variant in seen.keys(): ids.push_back(str(raw_id))
	ids.sort()
	return ids


func get_dev_scene_entries() -> Array:
	var result: Array = []
	for id: String in get_dev_scene_ids():
		var definition := asset_manager.load_scene_data(id)
		var raw_name: Variant = definition.get("name") if definition is Dictionary else null
		var name: String = raw_name.strip_edges() if raw_name is String and not raw_name.strip_edges().is_empty() else id
		result.push_back({"id": id, "name": name})
	return result


func dev_load_scene(scene_id: String) -> void:
	if scene_id.is_empty() or scene_manager.is_switching(): return
	if dev_mode_ui != null: dev_mode_ui.close()
	await scene_manager.switch_scene(scene_id)
	map_ui.set_current_scene(scene_id)
	if is_dev_mode and scene_id == "dev_room" and dev_mode_ui != null: dev_mode_ui.open()


func _try_start_initial_prologue(game_config: Dictionary) -> void:
	var cutscene_id := str(game_config.get("initialCutscene", "")).strip_edges()
	if cutscene_id.is_empty(): return
	var done_flag := str(game_config.get("initialCutsceneDoneFlag", "")).strip_edges()
	if not done_flag.is_empty() and flag_store.get_value(done_flag) == true: return
	state_controller.set_state(RuntimeDataTypes.CUTSCENE)
	await cutscene_manager.start_cutscene(cutscene_id)
	if not done_flag.is_empty(): flag_store.set_value(done_flag, true)
	state_controller.set_state(RuntimeDataTypes.EXPLORING)


func collect_save_data() -> Dictionary:
	var systems := {}
	for entry: Dictionary in registered_systems:
		if entry.system == null:
			continue
		var value: Variant = entry.system.serialize()
		systems[entry.name] = value if value is Dictionary else {}
	systems["flagStore"] = flag_store.serialize()
	if dialogue_log_ui != null: systems["dialogueLog"] = dialogue_log_ui.serialize()
	systems["game"] = {"playTimeMs": play_time_ms, "randomState": runtime_random.get_state()}
	return systems


func distribute_save_data(data: Dictionary) -> bool:
	event_bus.emit("save:restoring", {})
	quest_manager.set_restoring(true)
	archive_manager.set_restoring(true)
	if data.get("flagStore") is Dictionary:
		flag_store.deserialize(data.flagStore)
	for entry: Dictionary in registered_systems:
		if entry.system != null and data.get(entry.name) is Dictionary:
			entry.system.deserialize(data[entry.name])
	if dialogue_log_ui != null and data.get("dialogueLog") is Dictionary:
		dialogue_log_ui.deserialize(data.dialogueLog)
	if data.get("game") is Dictionary:
		var restored_play_time: Variant = data.game.get("playTimeMs")
		play_time_ms = float(restored_play_time) if restored_play_time is int or restored_play_time is float else 0.0
		var restored_random: Variant = data.game.get("randomState")
		runtime_random.set_state(restored_random)
	quest_manager.set_restoring(false)
	archive_manager.set_restoring(false)
	return true


func _get_entity_pixel_density_match_effective() -> bool:
	return bool(entity_pixel_density_match_debug_override) if entity_pixel_density_match_debug_override != null else game_config.get("entityPixelDensityMatch") == true


func _cycle_entity_pixel_density_match_debug_override() -> void:
	entity_pixel_density_match_debug_override = true if entity_pixel_density_match_debug_override == null else (false if entity_pixel_density_match_debug_override == true else null)
	_sync_entity_pixel_density_match()


func _is_entity_pixel_density_match_rendering_on() -> bool:
	return scene_manager.get_background_texels_per_world() != null and _get_entity_pixel_density_match_effective()


func _get_entity_pixel_density_match_blur_scale_from_config() -> float:
	var value: Variant = game_config.get("entityPixelDensityMatchBlurScale")
	return float(value) if (value is int or value is float) and is_finite(float(value)) and float(value) > 0.0 else RuntimeEntityPixelDensityMatch.DEFAULT_ENTITY_PIXEL_DENSITY_BLUR_SCALE


func _get_entity_pixel_density_match_blur_scale() -> float:
	var value := float(entity_pixel_density_match_blur_scale_debug) if entity_pixel_density_match_blur_scale_debug != null else _get_entity_pixel_density_match_blur_scale_from_config()
	return clampf(value, 0.05, 5.0)


func _nudge_entity_pixel_density_match_blur_scale_debug(delta: float) -> void:
	var current := float(entity_pixel_density_match_blur_scale_debug) if entity_pixel_density_match_blur_scale_debug != null else _get_entity_pixel_density_match_blur_scale_from_config()
	entity_pixel_density_match_blur_scale_debug = clampf(current + delta, 0.05, 5.0)
	_sync_entity_pixel_density_match()


func _clear_entity_pixel_density_match_blur_scale_debug() -> void:
	entity_pixel_density_match_blur_scale_debug = null
	_sync_entity_pixel_density_match()


func _set_scene_entity_field_from_action(scene_id: String, kind: String, entity_id: String, field_name: String, value: Variant) -> void:
	var sid := scene_id.strip_edges()
	var id := entity_id.strip_edges()
	var field := field_name.strip_edges()
	var current_scene_id := scene_manager.get_current_scene_id()
	if scene_manager.is_cutscene_staging_active() and sid != current_scene_id:
		return
	var checked: Dictionary = RuntimeEntityRuntimeFieldSchema.coerce_value(kind, field, value)
	if checked.get("ok") != true:
		return
	var stored: Dictionary = scene_manager.set_entity_runtime_field(sid, kind, id, field, checked.value)
	if stored.get("ok") != true or current_scene_id != sid:
		return
	if kind == "npc":
		await _apply_npc_runtime_field_now(id, field, checked.value)
	else:
		await _apply_hotspot_runtime_field_now(id, field, checked.value)


func _set_hotspot_display_image_from_action(scene_id: String, hotspot_id: String, image_path: String, world_width: Variant = null, world_height: Variant = null, facing: Variant = null) -> void:
	var sid := scene_id.strip_edges()
	var id := hotspot_id.strip_edges()
	var path := image_path.strip_edges()
	if sid.is_empty() or id.is_empty() or path.is_empty():
		push_warning("setHotspotDisplayImage: 需要 sceneId、hotspotId 与 image")
		return
	var current_scene_id := scene_manager.get_current_scene_id()
	if scene_manager.is_cutscene_staging_active() and sid != current_scene_id:
		push_warning("setHotspotDisplayImage: 过场中忽略跨场景写入 \"%s\"（当前场景 \"%s\"）" % [sid, current_scene_id if not current_scene_id.is_empty() else "(无)"])
		return
	var path_resolved := path if path.begins_with("/") or path.begins_with("http://") or path.begins_with("https://") or path.begins_with("assets/") else asset_manager.resolve_scene_asset_path(sid, path)
	var texture: Variant = asset_manager.load_texture(path_resolved)
	if not texture is Texture2D:
		push_warning("setHotspotDisplayImage: 贴图加载失败 %s: %s" % [path_resolved, asset_manager.get_last_error()])
		return
	var current: Variant = null
	if current_scene_id == sid:
		var hotspots := scene_manager.get_current_hotspots()
		var index := hotspots.find_custom(func(candidate: RuntimeHotspot) -> bool: return candidate.get_id() == id)
		current = hotspots[index] if index >= 0 else null
	var scene_data: Dictionary = scene_manager.get_current_scene_data() if current_scene_id == sid else asset_manager.load_scene_data(sid)
	var base: Variant = null
	for definition: Variant in scene_data.get("hotspots", []):
		if definition is Dictionary and str(definition.get("id", "")) == id:
			base = definition
			break
	var runtime_override: Variant = scene_manager.get_entity_runtime_override(sid, "hotspot", id)
	var previous: Variant = current.def.get("displayImage") if current is RuntimeHotspot else null
	if previous == null and runtime_override is Dictionary and runtime_override.has("displayImage"):
		previous = runtime_override.get("displayImage")
	if previous == null and base is Dictionary:
		previous = base.get("displayImage")
	var requested_width: Variant = float(world_width) if (world_width is int or world_width is float) and is_finite(float(world_width)) and float(world_width) > 0.0 else null
	var requested_height: Variant = float(world_height) if (world_height is int or world_height is float) and is_finite(float(world_height)) and float(world_height) > 0.0 else null
	var previous_width_value: Variant = previous.get("worldWidth") if previous is Dictionary else null
	var previous_height_value: Variant = previous.get("worldHeight") if previous is Dictionary else null
	var has_previous_width := (previous_width_value is int or previous_width_value is float) and is_finite(float(previous_width_value)) and float(previous_width_value) > 0.0
	var has_previous_height := (previous_height_value is int or previous_height_value is float) and is_finite(float(previous_height_value)) and float(previous_height_value) > 0.0
	var texture_width := maxf(1.0, float(texture.get_width()))
	var texture_height := maxf(1.0, float(texture.get_height()))
	var width := 0.0
	var height := 0.0
	if requested_width != null and requested_height != null:
		width = float(requested_width); height = float(requested_height)
	elif requested_width != null:
		width = float(requested_width); height = maxf(0.1, roundf(width * texture_height / texture_width * 10.0) / 10.0)
	elif requested_height != null:
		height = float(requested_height); width = maxf(0.1, roundf(height * texture_width / texture_height * 10.0) / 10.0)
	elif has_previous_width and has_previous_height:
		width = float(previous_width_value); height = float(previous_height_value)
	elif has_previous_width:
		width = float(previous_width_value); height = maxf(0.1, roundf(width * texture_height / texture_width * 10.0) / 10.0)
	elif has_previous_height:
		height = float(previous_height_value); width = maxf(0.1, roundf(height * texture_width / texture_height * 10.0) / 10.0)
	else:
		width = 100.0; height = maxf(0.1, roundf(width * texture_height / texture_width * 10.0) / 10.0)
	var display_image := {"image": path_resolved, "worldWidth": width, "worldHeight": height}
	if facing in ["left", "right"]:
		display_image.facing = facing
	elif previous is Dictionary and previous.has("facing"):
		display_image.facing = previous.facing
	if previous is Dictionary and previous.has("spriteSort"):
		display_image.spriteSort = previous.spriteSort
	await _set_scene_entity_field_from_action(sid, "hotspot", id, "displayImage", display_image)


func _temp_set_hotspot_display_facing_from_action(scene_id: String, hotspot_id: String, facing: String) -> void:
	var sid := scene_id.strip_edges()
	var id := hotspot_id.strip_edges()
	if sid.is_empty() or id.is_empty():
		push_warning("tempSetHotspotDisplayFacing: 需要 sceneId、hotspotId")
		return
	if scene_manager.get_current_scene_id() != sid:
		push_warning("tempSetHotspotDisplayFacing: 仅在目标场景已加载时生效（不写档，无法在离屏场景施加）。当前场景: %s 请求: %s" % [scene_manager.get_current_scene_id() if not scene_manager.get_current_scene_id().is_empty() else "(无)", sid])
		return
	var hotspots := scene_manager.get_current_hotspots()
	var index := hotspots.find_custom(func(candidate: RuntimeHotspot) -> bool: return candidate.get_id() == id)
	var hotspot: Variant = hotspots[index] if index >= 0 else null
	if not hotspot is RuntimeHotspot:
		push_warning("tempSetHotspotDisplayFacing: 当前场景找不到热点 %s" % id)
		return
	hotspot.set_runtime_display_facing(null if facing == "restore" else facing)


func _apply_npc_runtime_field_now(npc_id: String, field_name: String, value: Variant) -> void:
	var npc: Variant = scene_manager.get_npc_by_id(npc_id)
	if not npc is RuntimeNpc:
		return
	if value == null:
		npc.def.erase(field_name)
	else:
		npc.def[field_name] = value
	match field_name:
		"x":
			if value is int or value is float: npc.set_x(float(value))
		"y":
			if value is int or value is float: npc.set_y(float(value))
		"enabled":
			if value is bool: npc.set_visible(value)
		"animState":
			if value is String: npc.play_animation(value)
		"patrolDisabled":
			if value is bool:
				if value: stop_npc_patrol(npc_id)
				else: _start_npc_patrol_for_npc(npc_id)
		"animFile", "initialAnimState":
			await reload_npc_sprite_from_def(npc)
	_sync_entity_pixel_density_match()


func reload_npc_sprite_from_def(npc: RuntimeNpc) -> void:
	var anim_file := str(npc.def.get("animFile", "")).strip_edges()
	if anim_file.is_empty():
		return
	var anim_raw: Variant = asset_manager.load_json(anim_file)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if not anim_raw is Dictionary:
		push_warning("setEntityField: reload NPC animation failed %s %s: %s" % [npc.get_id(), anim_file, asset_manager.get_last_error()])
		return
	var sheet_path := RuntimeResourceLocator.get_default().resolve_anim_relative(anim_file, str(anim_raw.get("spritesheet", "")))
	var texture: Variant = asset_manager.load_texture(sheet_path)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if not texture is Texture2D:
		push_warning("setEntityField: reload NPC animation failed %s %s: %s" % [npc.get_id(), anim_file, asset_manager.get_last_error()])
		return
	var anim_def := RuntimeAnimationSetResolverScript.normalize_animation_set_def(anim_raw, texture.get_width(), texture.get_height())
	npc.load_sprite(texture, anim_def, str(npc.def.get("initialAnimState", "")))


func _apply_hotspot_runtime_field_now(hotspot_id: String, field_name: String, value: Variant) -> void:
	var hotspots := scene_manager.get_current_hotspots()
	var index := hotspots.find_custom(func(candidate: RuntimeHotspot) -> bool: return candidate.get_id() == hotspot_id)
	var hotspot: Variant = hotspots[index] if index >= 0 else null
	if not hotspot is RuntimeHotspot:
		if field_name == "displayImage":
			var ids: Array[String] = []
			for candidate: RuntimeHotspot in hotspots: ids.push_back(candidate.get_id())
			push_warning("setHotspotDisplayImage: 当前场景找不到同 id 热点，无法立刻换图（运行态已记录）。 请求的 hotspotId=%s； 当前场景内热点 id: [%s]。 请与场景 JSON 里 hotspots[].id 一字不差；下拉框只把不带括注的 id 写入参数。" % [JSON.stringify(hotspot_id), ", ".join(ids) if not ids.is_empty() else "无"])
		return
	match field_name:
		"x":
			if value is int or value is float: hotspot.set_position(float(value), float(hotspot.def.get("y", 0.0)))
		"y":
			if value is int or value is float: hotspot.set_position(float(hotspot.def.get("x", 0.0)), float(value))
		"enabled":
			if value is bool: hotspot.set_enabled(value)
		"displayImage":
			if value == null:
				hotspot.def.erase("displayImage")
				var old_filter: Variant = hotspot.detach_depth_occlusion_filter()
				if old_filter != null:
					scene_depth_system.remove_filter(old_filter)
					old_filter.destroy()
				hotspot.set_display_texture(null, 0.0, 0.0)
			elif RuntimeHotspot.is_valid_display_image(value):
				await _apply_hotspot_display_image_now(hotspot, value)
	_sync_entity_pixel_density_match()


func _apply_hotspot_display_image_now(hotspot: RuntimeHotspot, display_image: Dictionary) -> void:
	var texture: Variant = asset_manager.load_texture(str(display_image.image))
	if not texture is Texture2D:
		push_warning("setEntityField: hotspot displayImage 加载失败 %s: %s" % [str(display_image.image), asset_manager.get_last_error()])
		return
	var old_filter: Variant = hotspot.detach_depth_occlusion_filter()
	if old_filter != null:
		scene_depth_system.remove_filter(old_filter)
		old_filter.destroy()
	hotspot.def.displayImage = display_image
	hotspot.set_display_texture(texture, float(display_image.worldWidth), float(display_image.worldHeight))
	if hotspot.has_depth_display_image():
		var next_filter: Variant = scene_depth_system.create_filter_for_entity()
		if next_filter != null:
			RuntimeDepthLog.depth_log("Game", ["setEntityField: reattach depth to hotspot display:", hotspot.get_id()])
			hotspot.attach_depth_occlusion_filter(next_filter)


func _sync_entity_pixel_density_match() -> void:
	var background_density: Variant = scene_manager.get_background_texels_per_world()
	var enabled := background_density != null and _get_entity_pixel_density_match_effective()
	var strength_scale := _get_entity_pixel_density_match_blur_scale()
	var projection_scale := camera.get_projection_scale() if camera != null else 1.0
	RuntimeSceneEntityFilterBinding.sync_sprite_entity_pixel_density_match(player.sprite.container, player.sprite, player_depth_filter, background_density, enabled, strength_scale, projection_scale)
	for npc: RuntimeNpc in scene_manager.get_current_npcs():
		var npc_enabled := false if npc.def.get("renderRaw") == true else enabled
		var npc_filter: Variant = RuntimeSceneEntityFilterBinding.get_filter(npc.container)
		RuntimeSceneEntityFilterBinding.sync_sprite_entity_pixel_density_match(npc.container, npc.sprite, npc_filter, background_density, npc_enabled, strength_scale, projection_scale)
	for hotspot: RuntimeHotspot in scene_manager.get_current_hotspots():
		hotspot.apply_entity_pixel_density_match(enabled, background_density, strength_scale)


func _apply_debug_scene_world_size(width: float, height: float) -> void:
	var result := scene_manager.apply_debug_world_size(width, height)
	if result.get("ok") != true: return
	var scene := scene_manager.get_current_scene_data()
	player.sync_movement_from_scene(scene)
	scene_depth_system.apply_runtime_scene_size(float(scene.worldWidth), float(scene.worldHeight), float(result.worldToPixelX), float(result.worldToPixelY))
	if scene_depth_system.current_depth_texture != null and scene_depth_system.current_config is Dictionary:
		depth_debug_visualizer.update_scene_world_size(float(scene.worldWidth), float(scene.worldHeight))
	_sync_entity_pixel_density_match()


func _get_debug_scene_world_size() -> Variant:
	if scene_manager == null or scene_manager.get_current_scene_data().is_empty(): return null
	var scene := scene_manager.get_current_scene_data()
	return {"width": scene.get("worldWidth", 0.0), "height": scene.get("worldHeight", 0.0)}


func _list_scenario_debug_panel_rows() -> Array:
	var ids := scenario_state_manager.get_catalog_scenario_ids()
	var serialized := scenario_state_manager.serialize()
	var scenario_buckets: Dictionary = serialized.get("scenarios", {}) if serialized.get("scenarios") is Dictionary else {}
	var result: Array = []
	for scenario_id: String in ids:
		var phases: Variant = scenario_buckets.get(scenario_id)
		var phase_brief := "(无 phase 存档桶)"
		if phases is Dictionary and not phases.is_empty():
			var pieces: Array[String] = []
			var keys: Array = phases.keys()
			for index in mini(14, keys.size()):
				var key := str(keys[index]); var phase: Variant = phases[key]
				pieces.push_back("%s=%s" % [key, phase.get("status", "") if phase is Dictionary else ""])
			phase_brief = "; ".join(pieces)
			if keys.size() > 14: phase_brief += " …(+%s)" % (keys.size() - 14)
		result.push_back({
			"id": scenario_id,
			"lifecycle": scenario_state_manager.get_line_lifecycle_state(scenario_id),
			"manual": scenario_state_manager.has_manual_line_lifecycle(scenario_id),
			"phaseBrief": phase_brief,
		})
	return result


func _scenario_debug_activate(scenario_id: String) -> void:
	var id := scenario_id.strip_edges()
	if id.is_empty(): return
	scenario_state_manager.activate_scenario_line(id)
	debug_panel_ui.log("[scenario] activateScenarioLine(%s) 已调用" % JSON.stringify(id))


func _scenario_debug_complete(scenario_id: String) -> void:
	var id := scenario_id.strip_edges()
	if id.is_empty(): return
	scenario_state_manager.complete_scenario_line(id)
	debug_panel_ui.log("[scenario] completeScenarioLine(%s) 已调用" % JSON.stringify(id))


func _scenario_debug_reset_incomplete(scenario_id: String) -> void:
	var id := scenario_id.strip_edges()
	if id.is_empty(): return
	scenario_state_manager.reset_scenario_progress_for_debug(id)
	debug_panel_ui.log("[scenario] resetScenarioProgressForDebug(%s)：线已视为未完成（已清 phase 桶与 manual 生命周期；exposes 写入的 flag 未回滚）" % JSON.stringify(id))


func _list_smell_debug_profiles() -> Array:
	var result: Array = []
	var profiles: Variant = smell_profiles_data.get("profiles") if smell_profiles_data is Dictionary else null
	if not profiles is Dictionary: return result
	for id: Variant in profiles:
		var profile: Variant = profiles[id]
		var raw_name: Variant = profile.get("name") if profile is Dictionary else null
		var display_name := str(raw_name) if raw_name is String and not raw_name.is_empty() else str(id)
		result.push_back({"id": str(id), "name": display_name})
	return result


func _reload_scene(scene_id: String) -> bool:
	scene_manager.unload_scene()
	if not await scene_manager.load_scene(scene_id): return false
	if state_controller.current_state not in [
		RuntimeDataTypes.DIALOGUE,
		RuntimeDataTypes.CUTSCENE,
		RuntimeDataTypes.ENCOUNTER,
		RuntimeDataTypes.MINIGAME,
	]:
		state_controller.set_state(RuntimeDataTypes.EXPLORING)
	# Browser reloadScene resolves through the event loop after scene:enter/ready;
	# local Godot loading is synchronous. The signal fires before node _process;
	# three boundaries cover one Game tick plus the Promise-style zone action
	# microtask checkpoint scheduled at that tick's tail.
	await get_tree().process_frame
	await get_tree().process_frame
	await get_tree().process_frame
	return true


func set_player_nav_target(x: float, y: float) -> void:
	player_nav_target = {"x": x, "y": y}
	player_nav_frames = 0
	player_nav_prev = null
	player_nav_stuck = 0


func _update_player_nav() -> void:
	if not player_nav_target is Dictionary:
		return
	var dx := float(player_nav_target.x) - player.get_x()
	var dy := float(player_nav_target.y) - player.get_y()
	if Vector2(dx, dy).length() < 14.0 or player_nav_frames > 1200:
		player_nav_target = null
		player_nav_prev = null
		input_manager.set_touch_move_axes(0, 0)
		return
	if player_nav_prev is Dictionary:
		var moved := Vector2(player.get_x() - float(player_nav_prev.x), player.get_y() - float(player_nav_prev.y)).length()
		player_nav_stuck = player_nav_stuck + 1 if moved < 0.6 else 0
	player_nav_prev = {"x": player.get_x(), "y": player.get_y()}
	player_nav_frames += 1
	var axis_x := 1 if dx > 6.0 else (-1 if dx < -6.0 else 0)
	var axis_y := 1 if dy > 6.0 else (-1 if dy < -6.0 else 0)
	if player_nav_stuck > 6:
		var use_x := int(floor(float(player_nav_frames) / 26.0)) % 2 == 0
		if use_x and axis_x != 0: axis_y = 0
		elif not use_x and axis_y != 0: axis_x = 0
		elif axis_x == 0: axis_y = 1 if player_nav_frames % 52 < 26 else -1
		else: axis_x = 1 if player_nav_frames % 52 < 26 else -1
	input_manager.set_touch_move_axes(axis_x, axis_y)


func get_player_view() -> Dictionary:
	var state := str(state_controller.current_state) if state_controller != null else RuntimeDataTypes.MAIN_MENU
	var mode := str({
		RuntimeDataTypes.MAIN_MENU: "menu",
		RuntimeDataTypes.EXPLORING: "exploring",
		RuntimeDataTypes.ACTION_SEQUENCE: "busy",
		RuntimeDataTypes.DIALOGUE: "dialogue",
		RuntimeDataTypes.ENCOUNTER: "encounter",
		RuntimeDataTypes.CUTSCENE: "cutscene",
		RuntimeDataTypes.UI_OVERLAY: "menu",
		RuntimeDataTypes.MINIGAME: "minigame",
	}.get(state, state))
	var scene: Variant = scene_manager.get_current_scene_data() if scene_manager != null else null
	var player_state := {"x": player.get_x(), "y": player.get_y(), "facing": player.get_facing_direction()} if player != null else {"x": 0.0, "y": 0.0, "facing": "right"}
	return {
		"mode": mode,
		"scene": str(scene.get("name", scene.get("id", ""))) if scene is Dictionary else null,
		"player": player_state,
		"entities": interaction_system.get_player_visible_entities() if interaction_system != null else [],
		"interactionPrompt": interaction_system.get_nearest_prompt() if interaction_system != null else null,
		"dialogue": graph_dialogue_manager.get_player_dialogue() if graph_dialogue_manager != null else null,
		"hud": {"coins": inventory_manager.get_coins() if inventory_manager != null else 0.0, "questTracker": hud.quest.text if hud != null and hud.quest != null else ""},
		"navTargetActive": player_nav_target != null,
	}


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
		"eventTrace": event_bus.get_debug_trace(),
		"saveData": collect_save_data(),
		"runtimeRandomState": runtime_random.get_state(),
		"activeZones": _sorted_strings(zone_system.get_active_zone_ids().keys()) if zone_system != null else [],
		"uiState": state_controller.get_debug_state() if state_controller != null else {"overlayReturnStack": [], "openPanels": []},
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
			"runtimeReady": runtime_ready,
			"fixedTickMode": fixed_tick_mode,
			"sceneSwitching": scene_manager.is_switching() if scene_manager != null else false,
			"actionPolicyDepth": action_executor.get_policy_depth() if action_executor != null else 0,
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
		"inventory": inventory_manager.serialize() if inventory_manager != null else {},
		"interactables": interaction_system.debug_list_interactables(player.get_x(), player.get_y()) if interaction_system != null and player != null else [],
		"playerView": get_player_view(),
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


func setup_runtime_debug_snapshot_publishing() -> void:
	if not OS.is_debug_build():
		return
	for event: String in [
		"narrative:stateChanged",
		"flag:changed",
		"quest:accepted",
		"quest:completed",
		"dialogue:start",
		"dialogue:line",
		"dialogue:choices",
		"dialogue:end",
		"scene:enter",
	]:
		listen_event(event, Callable(self, "_schedule_runtime_debug_snapshot_from_event").bind(event))


func _schedule_runtime_debug_snapshot_from_event(_payload: Variant, event: String) -> void:
	schedule_runtime_debug_snapshot_publish(event)


func schedule_runtime_debug_snapshot_publish(reason: String) -> void:
	if not OS.is_debug_build():
		return
	var token := RefCounted.new()
	runtime_debug_snapshot_timer = token
	await get_tree().create_timer(0.12).timeout
	if runtime_debug_snapshot_timer != token or tear_down_complete:
		return
	runtime_debug_snapshot_timer = null
	await publish_runtime_debug_snapshot(reason)


func publish_runtime_debug_snapshot(_reason: String) -> void:
	# `fetch()` is asynchronous in the source.  Keep the same task boundary even
	# though the native shell has no HTTP publication target.
	await RuntimeMicrotaskQueueScript.yield_turn()


func setup_runtime_command_polling() -> void:
	# RuntimeCommandBridge is the native-shell adapter for the browser command
	# poller.  Constructing it here preserves Game.start's ownership and order.
	if runtime_command_bridge != null:
		return
	runtime_command_bridge = RuntimeCommandBridgeScript.new()
	runtime_command_bridge.bind(Callable(self, "build_runtime_debug_snapshot"), runtime_boot_id, Callable(self, "apply_runtime_command"))
	add_child(runtime_command_bridge)
	poll_runtime_commands()


func poll_runtime_commands() -> void:
	if not OS.is_debug_build() or runtime_command_poll_in_flight or runtime_command_bridge == null:
		return
	runtime_command_poll_in_flight = true
	await runtime_command_bridge.poll_once()
	runtime_command_poll_in_flight = false


func apply_runtime_command(command: Dictionary) -> Dictionary:
	return await RuntimeDevRuntimeCommandsScript.apply_dev_runtime_command(command, _build_runtime_command_dependencies())


func _build_runtime_command_dependencies() -> Dictionary:
	return {
		"captureSnapshot": Callable(self, "_capture_runtime_command_snapshot"),
		"clearEventTrace": Callable(event_bus, "clear_debug_trace"),
		"debugExecuteAction": Callable(action_executor, "execute_await"),
		"debugSetFixedTickMode": Callable(self, "_debug_set_fixed_tick_mode"),
		"debugStepTicks": Callable(self, "_debug_step_ticks"),
		"clearNarrativeTrace": Callable(narrative_state_manager, "clear_debug_trace"),
		"emitNarrativeSignal": Callable(narrative_state_manager, "emit_narrative_signal"),
		"debugSetNarrativeState": Callable(narrative_state_manager, "debug_set_narrative_state"),
		"setFlag": Callable(flag_store, "set_value"),
		"isFlagAllowed": Callable(flag_store, "is_key_allowed_by_registry"),
		"getFlagValueKind": Callable(flag_store, "get_debug_value_kind"),
		"debugSetQuestStatus": Callable(quest_manager, "debug_set_quest_status"),
		"debugSetScenarioPhase": Callable(scenario_state_manager, "debug_set_scenario_phase"),
		"debugSetScenarioLineLifecycle": Callable(scenario_state_manager, "debug_set_scenario_line_lifecycle"),
		"debugResetScenarioProgress": Callable(scenario_state_manager, "reset_scenario_progress_for_debug"),
		"debugStartDialogueGraph": Callable(graph_dialogue_manager, "start_dialogue_graph"),
		"debugAdvanceDialogue": Callable(graph_dialogue_manager, "debug_advance_until_blocking"),
		"debugChooseDialogueOption": Callable(graph_dialogue_manager, "debug_choose_option"),
		"debugSwitchScene": Callable(self, "_debug_switch_scene"),
		"debugTriggerHotspot": Callable(interaction_coordinator, "debug_trigger_hotspot_by_id"),
		"debugInteractNpc": Callable(interaction_coordinator, "debug_interact_npc_by_id"),
		"debugWait": Callable(self, "_debug_wait"),
		"debugSetPlayerPosition": Callable(self, "_debug_set_player_position"),
		"debugMovePlayerTo": Callable(self, "_debug_move_player_to"),
		"debugClick": Callable(self, "_debug_click"),
		"debugDrag": Callable(self, "_debug_drag"),
		"debugSaveGame": Callable(save_manager, "save"),
		"debugLoadGame": Callable(save_manager, "load"),
		"debugReloadScene": Callable(self, "_debug_reload_scene"),
		"playerInteract": func() -> void: input_manager.inject_key_just_pressed("KeyE"),
		"playerAdvance": func() -> void: event_bus.emit("dialogue:advance", {}),
		"playerChoose": func(index: int) -> void: event_bus.emit("dialogue:choiceSelected", {"index": index}),
		"playerMoveTo": Callable(self, "set_player_nav_target"),
		"playerTap": Callable(input_manager, "inject_pointer_down"),
		"setPlayerCollisions": Callable(player, "set_collisions_enabled"),
		"activatePlane": Callable(plane_reconciler, "activate_plane_manually"),
		"deactivatePlane": Callable(plane_reconciler, "deactivate_manual_plane"),
	}


func _capture_runtime_command_snapshot(reason: String) -> Dictionary:
	return build_runtime_debug_snapshot(reason)


func _debug_set_fixed_tick_mode(enabled: bool) -> void:
	fixed_tick_mode = enabled
	set_process(not fixed_tick_mode)
	if hud != null: hud.set_fixed_tick_mode(enabled)
	if not fixed_tick_mode:
		return
	if player != null: player.sprite.reset_animation_clock()
	if scene_manager != null: scene_manager.reset_entity_animation_clocks()


func _debug_switch_scene(scene_id: String, spawn_point: String = "") -> void:
	await action_executor.execute_await({"type": "switchScene", "params": {"targetScene": scene_id, "targetSpawnPoint": spawn_point}})
	interaction_system.update(0.0)
	zone_system.update(0.0)
	await _debug_wait(1)


func _debug_reload_scene(scene_id: String = "") -> void:
	var target := scene_id.strip_edges()
	if target.is_empty(): target = scene_manager.get_current_scene_id()
	if target.is_empty(): target = str(game_config.get("fallbackScene", game_config.get("initialScene", "dev_room")))
	await _reload_scene(target)


func _debug_wait(duration_ms: int) -> void:
	var ms := clampi(duration_ms, 1, 60000)
	await get_tree().create_timer(float(ms) / 1000.0).timeout


func _debug_step_ticks(ticks: int, dt_ms: float) -> void:
	var count := clampi(ticks, 1, 200)
	var dt := clampf(dt_ms / 1000.0, 0.001, 0.1)
	for _tick_index: int in range(count):
		tick(dt)
		hud.step_fixed_tick(dt)
		await _debug_yield_event_loop_turn()
	RenderingServer.force_draw()


func _debug_yield_event_loop_turn() -> void:
	# MessageChannel in the browser yields one complete task without advancing
	# its wall clock. A process-frame suspension is the native shell boundary
	# with the same continuation ordering.
	await get_tree().process_frame


func _debug_set_player_position(x: float, y: float, snap_camera: bool) -> void:
	player.set_x(x)
	player.set_y(y)
	if snap_camera: camera.snap_to(x, y)
	else: camera.follow(x, y)
	interaction_system.update(0.0)
	zone_system.update(0.0)
	await _debug_wait(1)


func _debug_move_player_to(x: float, y: float, speed: float, snap_camera: bool) -> void:
	var safe_speed := clampf(speed, 1.0, 5000.0)
	var distance := Vector2(x - player.get_x(), y - player.get_y()).length()
	if distance < 0.5:
		await _debug_set_player_position(x, y, snap_camera)
		return
	var timeout_ms := mini(15000, maxi(500, int(ceil(distance / safe_speed * 1000.0)) + 1000))
	var started_ms := Time.get_ticks_msec()
	player.move_to(x, y, safe_speed, "walk", true)
	while player.is_moving_to_target() and Time.get_ticks_msec() - started_ms < timeout_ms:
		await get_tree().process_frame
	await _debug_set_player_position(x, y, snap_camera)


func _debug_click(x: float, y: float) -> void:
	_dispatch_pointer_like("pointerdown", x, y)
	_dispatch_pointer_like("pointerup", x, y)
	_dispatch_pointer_like("click", x, y)
	await _debug_wait(50)


func _debug_drag(from_x: float, from_y: float, to_x: float, to_y: float, duration_ms: int) -> void:
	var from := Vector2(from_x, from_y)
	var to := Vector2(to_x, to_y)
	_dispatch_pointer_like("pointerdown", from.x, from.y)
	var steps := clampi(int(ceil(float(duration_ms) / 50.0)), 2, 20)
	for index: int in range(1, steps + 1):
		var position := from.lerp(to, float(index) / float(steps))
		_dispatch_pointer_like("pointermove", position.x, position.y)
		await _debug_wait(maxi(1, int(float(duration_ms) / float(steps))))
	_dispatch_pointer_like("pointerup", to.x, to.y)


func _dispatch_pointer_like(type: String, x: float, y: float) -> void:
	var position := Vector2(x, y)
	if type == "pointermove":
		var motion := InputEventMouseMotion.new()
		motion.position = position
		motion.global_position = position
		motion.button_mask = MOUSE_BUTTON_MASK_LEFT
		Input.parse_input_event(motion)
		return
	# Godot synthesizes the Control click from the button-up event, whereas the
	# browser dispatches a separate DOM `click`. Keep the source call boundary
	# while avoiding a second native release.
	if type == "click":
		return
	var button := InputEventMouseButton.new()
	button.position = position
	button.global_position = position
	button.button_index = MOUSE_BUTTON_LEFT
	button.pressed = type != "pointerup"
	button.button_mask = MOUSE_BUTTON_MASK_LEFT if button.pressed else 0
	Input.parse_input_event(button)


func listen_event(event: String, fn: Callable) -> void:
	event_bus.on(event, fn)
	bound_callbacks.push_back({"event": event, "fn": fn})


func add_window_listener(event: String, fn: Callable) -> void:
	if event != "resize" or not fn.is_valid() or not is_inside_tree():
		return
	var resize_signal := get_viewport().size_changed
	if not resize_signal.is_connected(fn):
		resize_signal.connect(fn)
	bound_window_listeners.push_back({"event": event, "fn": fn})


func get_save_manager() -> RuntimeSaveManager:
	return save_manager


func get_audio_manager() -> RuntimeAudioManager:
	return audio_manager


func get_debug_panel() -> RuntimeDebugPanelUI:
	return debug_panel_ui


func destroy() -> void:
	if tear_down_complete:
		return
	tear_down_complete = true
	runtime_ready = false
	runtime_debug_snapshot_timer = null
	runtime_command_poll_timer = null
	runtime_command_poll_in_flight = false
	if runtime_command_bridge != null and is_instance_valid(runtime_command_bridge):
		runtime_command_bridge.unbind()
	set_process(false)
	main_tick = Callable()
	patrol_generation += 1
	npc_patrol_epoch.clear()
	player_nav_target = null
	player_nav_prev = null
	if input_manager != null:
		input_manager.set_touch_move_axes(0, 0)
	for binding: Dictionary in bound_callbacks:
		if event_bus != null: event_bus.off(str(binding.event), binding.fn)
	bound_callbacks.clear()
	if cutscene_step_hud_el != null and is_instance_valid(cutscene_step_hud_el):
		if cutscene_step_hud_el.get_parent() != null: cutscene_step_hud_el.get_parent().remove_child(cutscene_step_hud_el)
		cutscene_step_hud_el.free()
	cutscene_step_hud_el = null
	if is_inside_tree():
		var resize_signal := get_viewport().size_changed
		for binding: Dictionary in bound_window_listeners:
			if binding.event == "resize" and binding.fn is Callable and resize_signal.is_connected(binding.fn):
				resize_signal.disconnect(binding.fn)
	bound_window_listeners.clear()
	if not unsub_renderer_resize.is_null() and unsub_renderer_resize.is_valid():
		unsub_renderer_resize.call()
	unsub_renderer_resize = Callable()
	# Match Game.destroy ownership and ordering: unregistered UI first, then
	# coordinators/bridges, panel owner, touch input, ordered systems, render
	# adapter, core primitives, renderer, and assets last.
	if inspect_box != null:
		inspect_box.destroy()
	if pickup_notification != null:
		pickup_notification.destroy()
	if dialogue_ui != null:
		dialogue_ui.destroy()
	if encounter_ui != null:
		encounter_ui.destroy()
	if action_choice_ui != null:
		action_choice_ui.destroy()
	if pressure_hold_ui != null:
		pressure_hold_ui.destroy()
	if hud != null:
		hud.destroy()
	if notification_ui != null:
		notification_ui.destroy()
	if book_reader_ui != null:
		book_reader_ui.destroy()
	if not OS.is_debug_build() and debug_panel_ui != null:
		debug_panel_ui.destroy()
	if dev_mode_ui != null:
		dev_mode_ui.destroy()
	if interaction_coordinator != null:
		interaction_coordinator.destroy()
	if event_bridge != null:
		event_bridge.destroy()
	if debug_tools != null:
		debug_tools.destroy()
		debug_tools = null
	if depth_debug_visualizer != null:
		depth_debug_visualizer.destroy()
		depth_debug_visualizer = null
	if state_controller != null:
		state_controller.destroy()
	if touch_mobile_controls != null:
		touch_mobile_controls.destroy()
	for entry: Dictionary in registered_systems:
		if entry.system != null:
			entry.system.destroy()
	if event_bus != null:
		event_bus.clear()
	if runtime_root != null:
		runtime_root.release_system_nodes()
	if cutscene_renderer != null:
		cutscene_renderer.destroy()
	if action_executor != null:
		action_executor.destroy()
	if flag_store != null:
		flag_store.destroy()
	if input_manager != null:
		input_manager.destroy()
	if player != null:
		player.destroy_player()
	if renderer != null:
		renderer.destroy()
	if asset_manager != null:
		asset_manager.dispose()


func _exit_tree() -> void:
	destroy()


func tick(dt: float) -> void:
	last_fps = 1.0 / dt if dt > 0.0 else 0.0
	play_time_ms += dt * 1000.0
	if camera != null: camera.set_pixel_snap_translation(_is_entity_pixel_density_match_rendering_on())
	if plane_reconciler != null: plane_reconciler.update(dt)
	var state := state_controller.current_state if state_controller != null else RuntimeDataTypes.MAIN_MENU
	match state:
		RuntimeDataTypes.EXPLORING:
			_update_player_nav()
			if player != null: player.update(dt)
			if input_manager != null and input_manager.was_key_just_pressed("KeyQ") and smell_system != null: smell_system.sniff()
			if interaction_system != null: interaction_system.update(dt)
			if zone_system != null: zone_system.update(dt)
			_update_scene_npcs_and_patrol(dt)
			if camera != null and player != null: camera.follow(player.get_x(), player.get_y())
		RuntimeDataTypes.CUTSCENE:
			if player != null: player.cutscene_update(dt)
			_update_scene_npcs_and_patrol(dt)
			if cutscene_manager != null:
				for npc: RuntimeNpc in cutscene_manager.get_temp_actors().values(): npc.cutscene_update(dt)
			if cutscene_renderer != null: cutscene_renderer.update(dt)
		RuntimeDataTypes.DIALOGUE:
			if dialogue_ui != null: dialogue_ui.update(dt)
			if player != null: player.cutscene_update(dt)
			_update_scene_npcs_and_patrol(dt)
		RuntimeDataTypes.ENCOUNTER:
			if encounter_ui != null: encounter_ui.update(dt)
			if player != null: player.cutscene_update(dt)
			_update_scene_npcs_and_patrol(dt)
		RuntimeDataTypes.MINIGAME:
			if water_minigame_manager != null: water_minigame_manager.update(dt)
			if sugar_wheel_minigame_manager != null: sugar_wheel_minigame_manager.update(dt)
			if paper_craft_minigame_manager != null: paper_craft_minigame_manager.update(dt)
			if player != null: player.cutscene_update(dt)
			_update_scene_npcs_and_patrol(dt)
		RuntimeDataTypes.UI_OVERLAY:
			if player != null: player.cutscene_update(dt)
			_update_scene_npcs_and_patrol(dt)
		RuntimeDataTypes.ACTION_SEQUENCE:
			if player != null: player.cutscene_update(dt)
			_update_scene_npcs_and_patrol(dt)
			if camera != null and player != null: camera.follow(player.get_x(), player.get_y())
	if emote_bubble_manager != null: emote_bubble_manager.update(dt)
	if notification_ui != null: notification_ui.update(dt)
	if hud != null: hud.update(dt)
	if camera != null: camera.update(dt)
	if debug_tools != null: debug_tools.update(dt)
	if depth_debug_visualizer != null: depth_debug_visualizer.update()
	_sync_entity_pixel_density_match()
	if scene_depth_system.is_active:
		_update_scene_depth_runtime()
	update_light_env_from_curve()
	update_entity_shadows()
	if renderer != null and player != null: renderer.sort_entity_layer(player.get_x(), player.get_y())
	if touch_mobile_controls != null: touch_mobile_controls.update()
	if input_manager != null: input_manager.end_frame()
	# Pixi ticker callback 返回后，浏览器在下一个 task 前先启动微任务队首。
	# Godot 没有该语言级检查点，由 Game 组合层在完整 tick 尾部机械替换。
	RuntimeMicrotaskQueueScript.flush_one_at_tick_boundary()


func _process(delta: float) -> void:
	if main_tick.is_valid(): main_tick.call(delta)


func _update_scene_npcs_and_patrol(dt: float) -> void:
	if scene_manager == null:
		return
	for npc: RuntimeNpc in scene_manager.get_current_npcs():
		npc.cutscene_update(dt)
