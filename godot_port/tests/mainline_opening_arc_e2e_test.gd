extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")
const EXPECTED_PLAYER_SCENES: Array[String] = [
	"bridge_underpass", "mountain_pass", "teahouse", "temple", "temple_exterior", "test_room_a", "test_room_b",
	"义庄", "城门口", "城隍庙夜", "婆子家院", "崖墓", "枯井土地庙", "梦_农家院", "梦_夜路", "梦_醒来土路",
	"梦_里屋", "梦_饭屋", "河边", "码头白天", "阎王岭山口", "雾津街头",
]

var bootstrap: Node
var visited_scenes: Array[String] = []


func _ready() -> void:
	bootstrap = BootstrapScript.new()
	add_child(bootstrap)
	await get_tree().process_frame
	await get_tree().process_frame
	bootstrap.runtime_root.event_bus.on("scene:enter", func(payload: Variant) -> void:
		if payload is Dictionary: visited_scenes.push_back(str(payload.get("sceneId", "")))
	)
	visited_scenes.push_back(bootstrap.scene_manager.get_current_scene_id())
	_send_key(KEY_ESCAPE)
	assert(await _wait_until(func() -> bool: return not bootstrap.cutscene_manager.is_playing() and not bootstrap.scene_manager.is_scene_enter_running(), 180))

	# Beat 0/1: shipped storyteller dialogue via real E/Enter/Digit input.
	assert(await _interact_npc("storyteller_zhang"))
	assert(await _drive_runtime_until_dialogue_closed(360))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s01_tingshu")
	assert(await _take_transition("exit_to_street", "雾津街头"))

	# The current content requires the ordinary roadside-corpse tutorial before
	# the contractor appears. Start from the street rest zone, visit 义庄 to
	# accept the job, return for the corpse, then carry/place/settle it.
	assert(await _enter_zone_by_id("z_找活_起意", "寻狗_找活"))
	assert(await _drive_runtime_until_dialogue_closed(420))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_背尸_零工活") == "looking")
	assert(await _take_transition("T_去义庄", "义庄"))
	assert(await _interact_npc("npc_义庄门口拦活"))
	assert(await _drive_runtime_until_dialogue_closed(420))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_背尸_零工活") == "accepted")
	assert(await _take_transition("T_出义庄", "雾津街头"))
	assert(await _interact_hotspot("hs_零工_路倒"))
	assert(await _drive_runtime_until_dialogue_closed(720))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_背尸_零工活") == "carrying")
	assert(await _take_transition("T_去义庄", "义庄"))
	assert(await _interact_hotspot("hs_背尸_空凳"))
	assert(await _drive_runtime_until_dialogue_closed(720))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_背尸_零工活") == "placed")
	assert(await _interact_npc("npc_管事"))
	assert(await _drive_runtime_until_dialogue_closed(480))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_背尸_零工活") == "delivered")
	assert(await _take_transition("T_出义庄", "雾津街头"))

	# Beat 1: accept the corpse-carry job. The shipped graph itself switches to
	# 崖墓; this test never calls SceneManager.load_scene or edits narrative state.
	assert(await _interact_npc("npc_庄家来人"))
	assert(await _drive_runtime_until_dialogue_closed(480))
	assert(bootstrap.scene_manager.get_current_scene_id() == "崖墓")
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_背尸") in ["hired", "at_yamu"])
	bootstrap.player.set_x(500.0); bootstrap.player.set_y(500.0)
	bootstrap.zone_system.update(0.0)
	await get_tree().process_frame
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_背尸") == "at_yamu")
	if bootstrap.cutscene_manager.is_playing(): _send_key(KEY_ESCAPE)
	assert(await _wait_until(func() -> bool: return not bootstrap.cutscene_manager.is_playing() and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING, 240))

	# Inspect the body and genuinely hold Space through both pressure interrupts.
	assert(await _interact_hotspot("hs_女尸"))
	assert(await _drive_runtime_until_dialogue_closed(900))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_背尸") == "scent")
	assert(bootstrap.flag_store.get_value("beishi_carrying") == true)

	# Walk into the ghost-wall zone three times. The first two shipped dialogue
	# runs switch back to the same scene/spawn; the third performs the death
	# tether and returns to the production street.
	for expected_loop in [1, 2]:
		assert(await _enter_zone_at(Vector2(500, 720), "寻狗_鬼打墙"))
		assert(await _drive_runtime_until_dialogue_closed(420))
		assert(bootstrap.scene_manager.get_current_scene_id() == "崖墓")
		assert(int(bootstrap.flag_store.get_value("guidaoqiang_loops")) == expected_loop)
	assert(await _enter_zone_at(Vector2(500, 720), "寻狗_鬼打墙"))
	assert(await _drive_runtime_until_dialogue_closed(720))
	assert(await _wait_until(func() -> bool: return bootstrap.scene_manager.get_current_scene_id() == "雾津街头", 240))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s02_beishi")
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_梦待死之礼") == "road")
	assert(bootstrap.flag_store.get_value("beishi_carrying") == false)

	# Enter the source-authored dream gate and traverse all five dream scenes.
	assert(await _enter_zone_and_wait_scene(Vector2(640, 500), "梦_夜路"))
	assert(await _wait_for_graph("梦_段A_夜路", 240))
	assert(await _drive_runtime_until_dialogue_closed(480))
	assert(await _enter_zone_and_wait_scene(Vector2(2280, 380), "梦_农家院"))
	assert(await _wait_for_graph("梦_段B_农家院", 240))
	assert(await _drive_runtime_until_dialogue_closed(480))
	assert(await _enter_zone_and_wait_scene(Vector2(820, 250), "梦_饭屋"))
	assert(await _enter_zone_at(Vector2(310, 280), "梦_段C_饭屋"))
	assert(await _drive_runtime_until_dialogue_closed(900))
	assert(await _wait_until(func() -> bool: return bootstrap.scene_manager.get_current_scene_id() == "梦_里屋", 300))
	assert(await _enter_zone_at(Vector2(500, 380), "梦_段D_里屋"))
	# 段D switches to 醒来土路 whose onEnter immediately nests 段E; one real
	# input loop therefore owns both graphs until E switches back to the street.
	assert(await _drive_runtime_until_dialogue_closed(2000))
	assert(await _wait_until(func() -> bool: return bootstrap.scene_manager.get_current_scene_id() == "雾津街头", 300))
	for dream_scene: String in ["梦_夜路", "梦_农家院", "梦_饭屋", "梦_里屋", "梦_醒来土路"]: assert(visited_scenes.has(dream_scene))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s02b_meng")
	assert(bootstrap.narrative_state_manager.has_reached_state("scenario_梦待死之礼", "woken"))
	assert(bootstrap.health_system.get_health() > 0.0)

	# Beats 2-4: return to the teahouse to spread the boast, accept the old
	# woman's job, read both people in her courtyard, perform/collect payment,
	# then follow the source-authored exit to the river and take the paper.
	assert(await _take_transition("T_进茶馆", "teahouse"))
	assert(await _interact_hotspot("hs_茶客吹牛"))
	assert(await _drive_runtime_until_dialogue_closed(720))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s03_chuiniu")
	assert(await _take_transition("exit_to_street", "雾津街头"))
	assert(await _interact_npc("npc_婆子"))
	assert(await _drive_runtime_until_dialogue_closed(720))
	assert(bootstrap.scene_manager.get_current_scene_id() == "婆子家院")
	if bootstrap.narrative_state_manager.get_active_state("scenario_婆子家") == "hired":
		bootstrap.player.set_x(300.0); bootstrap.player.set_y(620.0); bootstrap.zone_system.update(0.0)
		assert(await _wait_until(func() -> bool: return bootstrap.dialogue_manager.is_active(), 180))
	if bootstrap.dialogue_manager.is_active(): assert(await _drive_scripted_dialogue(120))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_婆子家") == "at_courtyard")
	var courtyard_exploring := await _wait_until(func() -> bool: return bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING, 180)
	if not courtyard_exploring: print("COURTYARD_STATE_STUCK ", {"state": bootstrap.state_controller.current_state, "graph": bootstrap.graph_dialogue_manager.is_active(), "scripted": bootstrap.dialogue_manager.is_active(), "sceneEnter": bootstrap.scene_manager.is_scene_enter_running(), "switching": bootstrap.scene_manager.is_switching()})
	assert(courtyard_exploring)
	assert(await _interact_npc("npc_院中婆子")); assert(await _drive_runtime_until_dialogue_closed(480))
	assert(await _interact_npc("npc_她儿子")); assert(await _drive_runtime_until_dialogue_closed(480))
	assert(await _wait_until(func() -> bool: return bootstrap.narrative_state_manager.get_active_state("scenario_婆子家") == "read_all", 180))
	assert(await _interact_hotspot("hs_院中宣布")); assert(await _drive_runtime_until_dialogue_closed(600))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s04_pozi")
	assert(await _take_transition("T_出院子", "河边"))
	assert(await _enter_zone_at(Vector2(700, 450), "寻狗_河边递纸"))
	assert(await _drive_runtime_until_dialogue_closed(720))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s05_hebian")

	# The source data keeps a six-scene compatibility branch reachable from the
	# river. Traverse only its authored transition hotspots and return, proving
	# these older resource/JSON scenes are not merely loadable by debug command.
	assert(await _take_transition("T到山路", "mountain_pass"))
	assert(await _take_transition("exit_to_temple", "temple_exterior"))
	assert(await _take_transition("T到庙宇室内", "temple"))
	assert(await _take_transition("T到室外", "temple_exterior"))
	assert(await _take_transition("exit_to_mountain_pass", "mountain_pass"))
	assert(await _take_transition("exit_to_street", "test_room_a"))
	assert(await _take_transition("exit_to_b", "test_room_b"))
	assert(await _take_transition("exit_to_a", "test_room_a"))
	assert(await _take_transition("exit_to_bridge", "bridge_underpass"))
	assert(await _take_transition("exit_to_street", "test_room_a"))
	assert(await _take_transition("exit_to_mountain_pass", "mountain_pass"))
	assert(await _take_transition("T到河边", "河边"))
	for compatibility_scene: String in ["mountain_pass", "temple_exterior", "temple", "test_room_a", "test_room_b", "bridge_underpass"]: assert(visited_scenes.has(compatibility_scene))

	# Beat 5: return through the real exits, enter the dock event zone, let its
	# movement/emote/scripted-dialogue chain run, skip only the skippable cutscene
	# with Escape, then answer the shipped dock choice graph.
	assert(await _take_transition("T回城", "雾津街头"))
	assert(await _take_transition("T_去码头", "码头白天"))
	bootstrap.player.set_x(500.0); bootstrap.player.set_y(1450.0); bootstrap.zone_system.update(0.0)
	assert(await _drive_world_until_graph("寻狗_码头选择", 3600))
	assert(await _drive_runtime_until_dialogue_closed(900))
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s06_laoxiang")
	assert(await _wait_until(func() -> bool: return bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING and not bootstrap.cutscene_manager.is_playing(), 300))
	var dock_zone_drained := await _wait_until(func() -> bool: return bootstrap.zone_system._action_running.is_empty(), 600)
	assert(dock_zone_drained)
	assert(await _take_transition("T码头到街巷", "雾津街头"))

	# Optional beat 7 is source-authored only while the main flow is at s06.
	# Take the commission, enter its well zone, inspect the real overlay sequence,
	# and let the graph return to town without changing the main milestone.
	var coins_before_well: int = bootstrap.runtime_root.get_system("inventoryManager").get_coins()
	assert(await _interact_npc("npc_枯井街坊")); assert(await _drive_runtime_until_dialogue_closed(720))
	assert(bootstrap.scene_manager.get_current_scene_id() == "枯井土地庙")
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_枯井") == "hired")
	assert(bootstrap.runtime_root.get_system("inventoryManager").get_coins() == coins_before_well + 15)
	bootstrap.player.set_x(800.0); bootstrap.player.set_y(500.0); bootstrap.zone_system.update(0.0)
	assert(await _drive_world_until_idle(600))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_枯井") == "at_well")
	assert(await _interact_hotspot("hs_枯井")); assert(await _drive_runtime_until_dialogue_closed(1800))
	assert(await _drive_world_until_idle(480))
	assert(bootstrap.scene_manager.get_current_scene_id() == "雾津街头")
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_枯井") == "fled")
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s06_laoxiang")

	# Beat 8: read the real teahouse notice, size up the competition, collect
	# all three outfit pieces from their authored street hotspots, and return to
	# the crowd to put the disguise on. No inventory or flag is injected here.
	assert(await _take_transition("T_进茶馆", "teahouse"))
	assert(await _interact_hotspot("hs_向导传闻")); assert(await _drive_runtime_until_dialogue_closed(480))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_向导") == "noticed")
	assert(await _take_transition("exit_to_street", "雾津街头"))
	assert(await _interact_hotspot("hs_围观人群")); assert(await _drive_runtime_until_dialogue_closed(480))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_向导") == "watched")
	for outfit_hotspot: String in ["hs_当铺道袍", "hs_庙会罗盘", "hs_城东桃木"]:
		assert(await _interact_hotspot(outfit_hotspot)); assert(await _drive_runtime_until_dialogue_closed(360))
	assert(bootstrap.flag_store.get_value("got_xingtou_daopao") == true)
	assert(bootstrap.flag_store.get_value("got_xingtou_luopan") == true)
	assert(bootstrap.flag_store.get_value("got_xingtou_taomu") == true)
	assert(bootstrap.runtime_root.get_system("inventoryManager").get_item_count("daopao") == 1)
	assert(bootstrap.runtime_root.get_system("inventoryManager").get_item_count("luopan") == 1)
	assert(bootstrap.runtime_root.get_system("inventoryManager").get_item_count("taomu_sword") == 1)
	assert(bootstrap.runtime_root.get_system("inventoryManager").get_item_count("talisman") == 2)
	assert(await _interact_hotspot("hs_围观人群")); assert(await _drive_runtime_until_dialogue_closed(480))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_向导") == "outfitted")
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s08_xiangdao")

	# Beat 9: the employer graph itself moves the player to 阎王岭. Traverse
	# the authored road/X zones, deliberately choose the first (wrong-name)
	# option at point two, skip point three by walking past it, deliver the real
	# inventory item, and survive the return pressure sequence and rescue chain.
	var coins_before_delivery: int = bootstrap.runtime_root.get_system("inventoryManager").get_coins()
	assert(await _interact_npc("npc_送货雇主")); assert(await _drive_runtime_until_dialogue_closed(600))
	assert(bootstrap.scene_manager.get_current_scene_id() == "阎王岭山口")
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_送货") == "bundle_taken")
	assert(bootstrap.runtime_root.get_system("inventoryManager").get_item_count("heavy_bundle") == 1)
	bootstrap.player.set_x(700.0); bootstrap.player.set_y(780.0); bootstrap.zone_system.update(0.0)
	assert(await _wait_until(func() -> bool: return bootstrap.narrative_state_manager.get_active_state("scenario_送货") == "on_road", 240))
	assert(await _drive_world_until_idle(900))
	bootstrap.player.set_x(700.0); bootstrap.player.set_y(600.0); bootstrap.zone_system.update(0.0)
	assert(await _wait_until(func() -> bool: return bootstrap.narrative_state_manager.get_active_state("scenario_送货") == "x1_called", 240))
	assert(await _drive_world_until_idle(480))
	assert(await _interact_hotspot("hs_X点二_林边")); assert(await _drive_runtime_until_dialogue_closed(720))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_送货") == "x2_resolved")
	assert(bootstrap.narrative_state_manager.get_active_state("wrap_喊名_点二") == "wrong")
	assert(await _drive_world_until_idle(480))
	bootstrap.player.set_x(700.0); bootstrap.player.set_y(320.0); bootstrap.zone_system.update(0.0)
	assert(await _drive_world_until_idle(480))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_送货") == "x3_resolved")
	assert(bootstrap.narrative_state_manager.get_active_state("wrap_喊名_点三") == "skipped")
	assert(await _interact_hotspot("hs_歇脚棚")); assert(await _drive_runtime_until_dialogue_closed(600))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_送货") == "delivered")
	assert(bootstrap.runtime_root.get_system("inventoryManager").get_item_count("heavy_bundle") == 0)
	assert(bootstrap.runtime_root.get_system("inventoryManager").get_coins() == coins_before_delivery + 40)
	assert(await _interact_hotspot("hs_进山的路")); assert(await _drive_runtime_until_dialogue_closed(2400))
	assert(await _drive_world_until_idle(1200))
	assert(bootstrap.scene_manager.get_current_scene_id() == "雾津街头")
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_送货") == "returned")
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s09_songhuo")
	assert(bootstrap.narrative_state_manager.has_reached_state("scenario_送货", "litiangou_rescue"))

	# Beats 11-12: accept Clara's real offer, verify the 100-coin advance,
	# travel through the authored city-gate transition, then finish the shipped
	# reunion graph and its terminal cutscene with actual dialogue/skip input.
	var coins_before_recruitment: int = bootstrap.runtime_root.get_system("inventoryManager").get_coins()
	assert(await _interact_npc("npc_克拉拉")); assert(await _drive_runtime_until_dialogue_closed(720))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_招募") == "recruited")
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s11_zhaomu")
	assert(bootstrap.runtime_root.get_system("inventoryManager").get_coins() == coins_before_recruitment + 100)

	# Optional beat 11 is unlocked by that completed recruitment quest. Enter
	# the night temple, finish its intro, oil and seated-vigil graphs, collect the
	# authored 20-coin reward, and return before the final city-gate departure.
	var coins_before_vigil: int = bootstrap.runtime_root.get_system("inventoryManager").get_coins()
	assert(await _take_transition("T_去城隍庙", "城隍庙夜"))
	bootstrap.player.set_x(700.0); bootstrap.player.set_y(580.0); bootstrap.zone_system.update(0.0)
	assert(await _drive_world_until_idle(600))
	assert(bootstrap.narrative_state_manager.get_active_state("wrap_守夜") == "intro_done")
	assert(await _interact_hotspot("hs_无名女尸")); assert(await _drive_runtime_until_dialogue_closed(480))
	assert(await _interact_hotspot("hs_长明灯")); assert(await _drive_runtime_until_dialogue_closed(480))
	assert(bootstrap.narrative_state_manager.get_active_state("wrap_守夜") == "oil_added")
	assert(await _interact_hotspot("hs_坐下想东西")); assert(await _drive_runtime_until_dialogue_closed(720))
	assert(await _drive_world_until_idle(480))
	assert(bootstrap.narrative_state_manager.get_active_state("wrap_守夜") == "done")
	assert(bootstrap.runtime_root.get_system("inventoryManager").get_coins() == coins_before_vigil + 20)
	assert(await _take_transition("T_出庙", "雾津街头"))
	assert(await _take_transition("T_去城门", "城门口"))
	assert(await _interact_npc("npc_埃德加")); assert(await _drive_runtime_until_dialogue_closed(720))
	assert(await _drive_world_until_idle(900))
	assert(bootstrap.narrative_state_manager.get_active_state("scenario_终幕") == "departed")
	assert(bootstrap.narrative_state_manager.get_active_state("flow_xungou_main") == "s12_chufa")
	assert(bootstrap.player.sprite.get_current_state() == "hero_stand")
	var unique_visited: Dictionary = {}
	for scene_id: String in visited_scenes: unique_visited[scene_id] = true
	for scene_id: String in EXPECTED_PLAYER_SCENES: assert(unique_visited.has(scene_id))
	assert(unique_visited.size() == EXPECTED_PLAYER_SCENES.size())
	await get_tree().create_timer(0.6).timeout
	assert(not bootstrap.graph_dialogue_manager.is_active() and not bootstrap.dialogue_manager.is_active() and not bootstrap.cutscene_manager.is_playing())

	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	remove_child(bootstrap)
	bootstrap.free()
	bootstrap = null
	visited_scenes.clear()
	await get_tree().create_timer(1.5).timeout
	print("No-debug 22-scene full mainline/side-path new-game-to-s12_chufa E2E: PASS")
	get_tree().quit(0)


func _interact_npc(id: String) -> bool:
	var npc: RuntimeNpc = bootstrap.scene_manager.get_npc_by_id(id)
	if npc == null: return false
	bootstrap.player.set_x(npc.get_x()); bootstrap.player.set_y(npc.get_y())
	await _press_interact()
	return await _wait_until(func() -> bool: return bootstrap.graph_dialogue_manager.is_active(), 120)


func _interact_hotspot(id: String) -> bool:
	var hotspot: RuntimeHotspot = bootstrap.scene_manager.get_hotspot_by_id(id)
	if hotspot == null: print("INTERACT_HOTSPOT_MISSING ", {"id": id, "scene": bootstrap.scene_manager.get_current_scene_id(), "state": bootstrap.state_controller.current_state}); return false
	bootstrap.player.set_x(hotspot.get_center_x()); bootstrap.player.set_y(hotspot.get_center_y())
	await _press_interact()
	var started := await _wait_until(func() -> bool: return bootstrap.graph_dialogue_manager.is_active(), 120)
	if not started: print("INTERACT_HOTSPOT_NO_GRAPH ", {"id": id, "scene": bootstrap.scene_manager.get_current_scene_id(), "state": bootstrap.state_controller.current_state, "active": hotspot.is_active()})
	return started


func _take_transition(id: String, expected_scene: String) -> bool:
	var hotspot: RuntimeHotspot = bootstrap.scene_manager.get_hotspot_by_id(id)
	if hotspot == null: return false
	bootstrap.player.set_x(hotspot.get_center_x()); bootstrap.player.set_y(hotspot.get_center_y())
	await _press_interact()
	var arrived := await _wait_until(func() -> bool: return bootstrap.scene_manager.get_current_scene_id() == expected_scene and not bootstrap.scene_manager.is_switching() and not bootstrap.scene_manager.is_scene_enter_running() and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING, 240)
	if not arrived: print("TRANSITION_NOT_SETTLED ", {"id": id, "expected": expected_scene, "scene": bootstrap.scene_manager.get_current_scene_id(), "state": bootstrap.state_controller.current_state, "entry": bootstrap.scene_manager.is_scene_enter_running()})
	return arrived


func _press_interact() -> void:
	bootstrap.interaction_system.update(0.0)
	_key_event(KEY_E, true)
	bootstrap.interaction_system.update(0.0)
	_key_event(KEY_E, false)
	bootstrap.input_manager.end_frame()
	await get_tree().process_frame


func _enter_zone_at(position: Vector2, expected_graph: String) -> bool:
	bootstrap.player.set_x(position.x); bootstrap.player.set_y(position.y)
	bootstrap.zone_system.update(0.0)
	return await _wait_for_graph(expected_graph, 180)


func _enter_zone_by_id(zone_id: String, expected_graph: String) -> bool:
	for zone: Variant in bootstrap.scene_manager.get_current_scene_data().get("zones", []):
		if not zone is Dictionary or str(zone.get("id", "")) != zone_id: continue
		var polygon: Variant = zone.get("polygon")
		if not polygon is Array or polygon.is_empty(): return false
		var center := Vector2.ZERO
		for point: Variant in polygon:
			if not point is Dictionary: return false
			center += Vector2(float(point.get("x", 0.0)), float(point.get("y", 0.0)))
		return await _enter_zone_at(center / polygon.size(), expected_graph)
	return false


func _enter_zone_and_wait_scene(position: Vector2, expected_scene: String) -> bool:
	bootstrap.player.set_x(position.x); bootstrap.player.set_y(position.y)
	bootstrap.zone_system.update(0.0)
	return await _wait_until(func() -> bool: return bootstrap.scene_manager.get_current_scene_id() == expected_scene and not bootstrap.scene_manager.is_switching(), 300)


func _wait_for_graph(graph_id: String, frames: int) -> bool:
	return await _wait_until(func() -> bool:
		return bootstrap.graph_dialogue_manager.is_active() and bootstrap.graph_dialogue_manager.get_dialogue_view_debug().get("graphId") == graph_id,
		frames,
	)


func _drive_runtime_until_dialogue_closed(limit: int) -> bool:
	var steps := 0
	while bootstrap.graph_dialogue_manager.is_active() and steps < limit:
		steps += 1
		# A pressure definition may run a scripted dialogue in onComplete while
		# its manager still owns the outer await; advance that real UI first.
		if bootstrap.dialogue_manager.is_active():
			_send_key(KEY_ENTER)
			await get_tree().process_frame
			continue
		if bootstrap.pressure_hold_manager.is_running():
			_key_event(KEY_SPACE, true)
			while bootstrap.pressure_hold_manager.is_running() and bootstrap.pressure_hold_ui.get_root() != null and steps < limit:
				steps += 1
				# PressureHoldUI deliberately integrates monotonic wall time (matching
				# browser RAF), so give real key-held time instead of spinning frames.
				await get_tree().create_timer(0.02).timeout
			_key_event(KEY_SPACE, false)
			await get_tree().process_frame
			continue
		if bootstrap.action_choice_ui.is_open():
			_send_key(KEY_1)
			await get_tree().process_frame
			continue
		if bootstrap.cutscene_manager.is_playing():
			_send_key(KEY_ESCAPE)
			await get_tree().process_frame
			continue
		var view: Dictionary = bootstrap.graph_dialogue_manager.get_dialogue_view_debug()
		if view.get("choiceStage") == "options":
			var selected := -1
			var preferred := 1 if view.get("graphId") == "寻狗_码头选择" else -1
			for choice: Dictionary in view.get("choices", []):
				if choice.get("enabled") == true and (preferred < 0 or int(choice.get("index", -1)) == preferred):
					selected = int(choice.get("index", -1)); break
			if selected < 0:
				for choice: Dictionary in view.get("choices", []):
					if choice.get("enabled") == true: selected = int(choice.get("index", -1)); break
			if selected < 0 or selected > 8: return false
			_send_key(KEY_1 + selected)
		else:
			_send_key(KEY_ENTER)
		if view.get("nodeType") == "runActions": await get_tree().create_timer(0.01).timeout
		else: await get_tree().process_frame
	if bootstrap.graph_dialogue_manager.is_active():
		print("MAINLINE_DRIVER_TIMEOUT ", {"view": bootstrap.graph_dialogue_manager.get_dialogue_view_debug(), "pressure": bootstrap.pressure_hold_manager.is_running(), "pressureRatio": bootstrap.pressure_hold_ui.current_ratio, "spaceDown": bootstrap.input_manager.is_key_down("Space"), "scripted": bootstrap.dialogue_manager.is_active(), "dialogueUi": {"open": bootstrap.dialogue_ui.is_open(), "full": bootstrap.dialogue_ui.showing_full_text, "advance": bootstrap.dialogue_ui.waiting_for_advance, "choice": bootstrap.dialogue_ui.waiting_for_choice, "text": bootstrap.dialogue_ui.full_text}, "choice": bootstrap.action_choice_ui.is_open(), "scene": bootstrap.scene_manager.get_current_scene_id(), "steps": steps})
	return not bootstrap.graph_dialogue_manager.is_active()


func _drive_scripted_dialogue(limit: int) -> bool:
	for _step in limit:
		if not bootstrap.dialogue_manager.is_active(): return true
		_send_key(KEY_ENTER)
		await get_tree().process_frame
	return not bootstrap.dialogue_manager.is_active()


func _drive_world_until_graph(graph_id: String, limit: int) -> bool:
	for _step in limit:
		if bootstrap.graph_dialogue_manager.is_active():
			return bootstrap.graph_dialogue_manager.get_dialogue_view_debug().get("graphId") == graph_id
		if bootstrap.dialogue_manager.is_active(): _send_key(KEY_ENTER)
		elif bootstrap.cutscene_manager.is_playing(): _send_key(KEY_ESCAPE)
		elif bootstrap.action_choice_ui.is_open(): _send_key(KEY_1)
		else: _send_key(KEY_ENTER)
		await get_tree().create_timer(0.01).timeout
	return false


func _drive_world_until_idle(limit: int) -> bool:
	for _step in limit:
		if bootstrap.graph_dialogue_manager.is_active():
			if not await _drive_runtime_until_dialogue_closed(limit): return false
		elif bootstrap.dialogue_manager.is_active(): _send_key(KEY_ENTER)
		elif bootstrap.cutscene_manager.is_playing(): _send_key(KEY_ESCAPE)
		elif bootstrap.action_choice_ui.is_open(): _send_key(KEY_1)
		elif bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING \
			and not bootstrap.scene_manager.is_switching() and not bootstrap.scene_manager.is_scene_enter_running() \
			and bootstrap.zone_system._action_running.is_empty(): return true
		else: _send_key(KEY_ENTER)
		await get_tree().create_timer(0.01).timeout
	return false


func _send_key(keycode: Key) -> void:
	_key_event(keycode, true); _key_event(keycode, false)


func _key_event(keycode: Key, pressed: bool) -> void:
	var event := InputEventKey.new(); event.keycode = keycode; event.physical_keycode = keycode; event.pressed = pressed
	bootstrap.input_manager._input(event)


func _wait_until(predicate: Callable, max_frames: int) -> bool:
	for _frame in max_frames:
		if predicate.call(): return true
		await get_tree().process_frame
	return bool(predicate.call())
