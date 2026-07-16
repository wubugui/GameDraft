extends Node

const SceneQueries := preload("res://tests/support/scene_queries.gd")

var transition_events: Array = []
var lifecycle_events: Array[String] = []
var rebuilt_events: Array = []


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir(); var locator := RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository); var assets := RuntimeAssetManager.new({}, locator); var events := RuntimeEventBus.new()
	var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.set_asset_manager(assets); renderer.init(); var camera := RuntimeCamera.new(renderer.world_container); camera.set_screen_size(800, 600); var input := RuntimeInputManager.new(); add_child(input); var player := RuntimePlayer.new(input); renderer.entity_layer.add_child(player.sprite)
	var manager := RuntimeSceneManager.new(assets, events, renderer); add_child(manager); manager.init({}); preload("res://tests/support/scene_manager_wiring.gd").bind(manager, player, camera); events.on("scene:transition", Callable(self, "_capture_transition")); events.on("scene:beforeUnload", Callable(self, "_capture_before_unload")); events.on("scene:enter", Callable(self, "_capture_scene_enter")); events.on("scene:ready", Callable(self, "_capture_scene_ready")); events.on("scene:entitiesRebuilt", Callable(self, "_capture_entities_rebuilt"))
	assert(await manager.load_scene("teahouse")); var storyteller: RuntimeNpc = manager.get_npc_by_id("storyteller_zhang"); var original_position := Vector2(storyteller.get_x(), storyteller.get_y())
	assert(manager.set_entity_runtime_field("teahouse", "npc", "storyteller_zhang", "x", 321).ok); assert(manager.set_entity_runtime_field("teahouse", "npc", "storyteller_zhang", "y", 222).ok); assert(manager.set_entity_runtime_field("teahouse", "npc", "storyteller_zhang", "enabled", false).ok); assert(not manager.set_entity_runtime_field("teahouse", "npc", "storyteller_zhang", "bogus", 1).ok)
	# Like SceneManager.ts, the storage owner does not mutate live entities; Game applies
	# action writes immediately, while a later scene load merges the stored override.
	assert(Vector2(storyteller.get_x(), storyteller.get_y()) == original_position and storyteller.container.visible)
	assert(manager.set_entity_session_enabled("hotspot", "exit_to_street", false)); assert(not SceneQueries.hotspot(manager, "exit_to_street").container.visible)
	manager.merge_persistent_npc_state("blind_li", {"patrolDisabled": true, "animState": "boy_run_ring"}); assert(manager.is_npc_patrol_persistently_disabled("blind_li"))
	assert(await manager.switch_scene("test_room_b")); events.emit("hotspot:inspected", {"hotspotId": "strange_mark"}); events.emit("hotspot:pickup:done", {"hotspotId": "herb_bundle"}); assert(SceneQueries.hotspot(manager, "herb_bundle").get_picked_up())
	assert(await manager.switch_scene("teahouse", "from_street")); assert(player.get_x() == 151.9 and player.get_y() == 171.4); storyteller = manager.get_npc_by_id("storyteller_zhang"); assert(storyteller.get_x() == 321 and storyteller.get_y() == 222 and not manager.get_npc_base_visible_for_interaction(storyteller) and not SceneQueries.hotspot(manager, "exit_to_street").container.visible)
	assert(transition_events.size() == 2 and transition_events[0] == {"fromSceneId": "teahouse", "toSceneId": "test_room_b"} and transition_events[1] == {"fromSceneId": "test_room_b", "toSceneId": "teahouse"})
	var wire: Dictionary = JSON.parse_string(JSON.stringify(manager.serialize())); assert(wire.currentSceneId == "teahouse" and wire.memory.test_room_b.inspected == ["strange_mark"] and wire.memory.test_room_b.pickedUp == ["herb_bundle"] and wire.memory.teahouse.entityOverrides.npcs.storyteller_zhang.x == 321)

	# JSON wire reload clears session-only hiding while keeping committed overrides and pickup memory.
	manager.deserialize(wire); manager.unload_scene(); assert(await manager.load_scene("test_room_b")); assert(SceneQueries.hotspot(manager, "herb_bundle") == null and SceneQueries.hotspot(manager, "taomu_pickup") != null)
	manager.unload_scene(); assert(await manager.load_scene("teahouse")); assert(not manager.get_npc_base_visible_for_interaction(manager.get_npc_by_id("storyteller_zhang")) and SceneQueries.hotspot(manager, "exit_to_street").container.visible)
	# Legacy fields normalize into the current entityOverrides payload.
	manager.deserialize({"currentSceneId": "teahouse", "memory": {"teahouse": {"inspected": [], "pickedUp": [], "npcSnapshots": {"blind_li": {"x": 444, "patrolDisabled": true}}, "hotspotDisplayImageOverrides": {"teahouse_notice": {"image": "/resources/runtime/images/illustrations/糖画摊_45度_生肖转盘.png", "worldWidth": 10, "worldHeight": 20}}}}})
	manager.unload_scene(); assert(await manager.load_scene("teahouse")); assert(manager.get_npc_by_id("blind_li").get_x() == 444 and manager.is_npc_patrol_persistently_disabled("blind_li") and SceneQueries.hotspot(manager, "teahouse_notice").has_depth_display_image())
	manager.begin_cutscene_staging("probe", "teahouse"); assert(not manager.set_entity_runtime_field("test_room_b", "npc", "npc_ringboy", "x", 999).ok); manager.merge_persistent_zone_enabled("test_room_b", "zone", false); assert(not manager.serialize().memory.get("test_room_b", {}).get("entityOverrides", {}).get("npcs", {}).get("npc_ringboy", {}).has("x")); manager.end_cutscene_staging()

	# Same-scene cutscene staging must rebuild only bound entities. It must not reload the
	# scene or disturb player/camera/background/unbound instances.
	manager.unload_scene(); assert(await manager.load_scene("码头白天", "", {"x": 901.0, "y": 777.0})); lifecycle_events.clear(); rebuilt_events.clear()
	var background_before := manager.scene_background; var unbound_before: RuntimeHotspot = SceneQueries.hotspot(manager, "hotspot_码头告示板"); var outer_before: RuntimeHotspot = SceneQueries.hotspot(manager, "new_hotspot_人群")
	assert(manager.get_npc_by_id("new_npc_3") == null); assert(SceneQueries.hotspot(manager, "new_hotspot_6") == null)
	manager.begin_cutscene_staging("洋人第一次出场", "码头白天"); manager.enter_cutscene_instances_for_current("洋人第一次出场")
	assert(lifecycle_events.is_empty() and manager.scene_background == background_before and SceneQueries.hotspot(manager, "hotspot_码头告示板") == unbound_before)
	assert(SceneQueries.hotspot(manager, "new_hotspot_人群") != outer_before and manager.get_npc_by_id("new_npc_3") != null and SceneQueries.hotspot(manager, "new_hotspot_6") != null)
	assert(player.get_x() == 901.0 and player.get_y() == 777.0); assert(manager.set_entity_runtime_field("码头白天", "hotspot", "new_hotspot_人群", "x", 123.0).ok)
	manager.exit_cutscene_instances_for_current("洋人第一次出场"); manager.end_cutscene_staging()
	assert(lifecycle_events.is_empty() and manager.scene_background == background_before and SceneQueries.hotspot(manager, "hotspot_码头告示板") == unbound_before)
	assert(manager.get_npc_by_id("new_npc_3") == null and SceneQueries.hotspot(manager, "new_hotspot_6") == null and SceneQueries.hotspot(manager, "new_hotspot_人群").get_center_x() == 1725.6)
	assert(rebuilt_events.size() == 2 and rebuilt_events[0].phase == "enter" and rebuilt_events[1].phase == "exit")

	events.off("scene:transition", Callable(self, "_capture_transition")); events.off("scene:beforeUnload", Callable(self, "_capture_before_unload")); events.off("scene:enter", Callable(self, "_capture_scene_enter")); events.off("scene:ready", Callable(self, "_capture_scene_ready")); events.off("scene:entitiesRebuilt", Callable(self, "_capture_entities_rebuilt")); manager.destroy(); assert(EventBusProbe.listener_count(events) == 0); remove_child(manager); manager.free(); player.destroy_player(); input.destroy(); remove_child(input); input.free(); assets.dispose(); renderer.destroy(); remove_child(renderer); renderer.free(); events.clear()
	print("SceneManager spawn/transition/memory/override contract test: PASS"); get_tree().quit(0)


func _capture_transition(payload: Variant) -> void: transition_events.push_back(payload.duplicate(true))
func _capture_before_unload(_payload: Variant) -> void: lifecycle_events.push_back("beforeUnload")
func _capture_scene_enter(_payload: Variant) -> void: lifecycle_events.push_back("enter")
func _capture_scene_ready(_payload: Variant) -> void: lifecycle_events.push_back("ready")
func _capture_entities_rebuilt(payload: Variant) -> void: if payload is Dictionary: rebuilt_events.push_back(payload.duplicate(true))
