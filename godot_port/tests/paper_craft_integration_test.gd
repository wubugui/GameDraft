extends Node

const BootstrapScript := preload("res://scripts/bootstrap.gd")

var bootstrap: Node
var result_seen: Dictionary = {}
var saw_attached_ui := false
var score_levels_ok := false
var missing_guard_ok := false
var invalid_slot_ok := false


func _ready() -> void:
	bootstrap = BootstrapScript.new(); bootstrap.set_meta("suppressSceneOnEnter", true); add_child(bootstrap); await get_tree().process_frame
	assert(bootstrap.paper_craft_minigame_manager.get_instance_list() == [{"id": "wujin_paper_servant_daywork", "label": "雾津纸扎铺：糊纸人日工"}])
	bootstrap.runtime_root.event_bus.on("minigame:paperCraftResult", Callable(self, "_capture_result"))
	_schedule_second_frame(Callable(self, "_solve_and_submit"))
	await bootstrap.action_executor.execute_await({"type": "startPaperCraftMinigame", "params": {"id": "wujin_paper_servant_daywork"}})
	assert(saw_attached_ui and score_levels_ok and missing_guard_ok and invalid_slot_ok)
	assert(result_seen.get("level") == "success" and result_seen.get("score") == 92 and result_seen.get("paperId") == "white" and result_seen.get("finishId") == "paste_plain")
	assert(result_seen.get("placed") is Array and result_seen.placed.size() == 4 and bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING)
	assert(not bootstrap.paper_craft_minigame_manager.active and bootstrap.paper_craft_minigame_manager.scene == null and bootstrap.action_executor.has_handler("startPaperCraftMinigame"))
	_schedule_second_frame(Callable(self, "_escape_session"))
	assert(await bootstrap.paper_craft_minigame_manager.run_until_done("wujin_paper_servant_daywork") == null)
	assert(bootstrap.state_controller.current_state == RuntimeGameStateController.EXPLORING and not bootstrap.paper_craft_minigame_manager.active)
	bootstrap.runtime_root.event_bus.off("minigame:paperCraftResult", Callable(self, "_capture_result")); bootstrap.audio_manager.stop_all_playback(); bootstrap.asset_manager.clear_cache(); await get_tree().process_frame
	remove_child(bootstrap); bootstrap.free(); await get_tree().create_timer(0.15).timeout
	print("PaperCraft real instance/drag-click/score/action/session integration test: PASS")
	get_tree().quit(0)


func _schedule_second_frame(callback: Callable) -> void:
	get_tree().process_frame.connect(func() -> void: get_tree().process_frame.connect(callback, CONNECT_ONE_SHOT), CONNECT_ONE_SHOT)


func _solve_and_submit() -> void:
	var scene: RuntimePaperCraftMinigameScene = bootstrap.paper_craft_minigame_manager.scene
	var textured_part_count := 0
	for sprite: Sprite2D in scene.get_root().find_children("*", "Sprite2D", true, false):
		if sprite.texture != null: textured_part_count += 1
	var work: Control = scene.get_root().find_child("WorkTable", true, false); var palette: Control = scene.get_root().find_child("PartPalette", true, false)
	var layout_ok := work.position.distance_to(Vector2(61.996, 170.97)) < 0.1 and is_equal_approx(work.scale.x, 1.122) and palette.position.distance_to(Vector2(714.316, 80.0)) < 0.1 and is_equal_approx(palette.scale.x, 642.0 / 648.0)
	var debug_state := scene.get_debug_visual_state(); var debug_ok: bool = debug_state.instanceId == "wujin_paper_servant_daywork" and debug_state.orderId == "paper_servant_plain" and debug_state.selectedPaperId == "white" and debug_state.selectedFinishId == "paste_plain" and debug_state.placed.is_empty()
	saw_attached_ui = scene != null and scene.get_root().get_parent() == bootstrap.renderer.cutscene_overlay and scene.get_root().find_children("*", "Button", true, false).size() >= 20 and textured_part_count >= 15 and layout_ok and debug_ok
	missing_guard_ok = not await scene.debug_submit() and scene.get_feedback_text().contains("还缺")
	invalid_slot_ok = not scene.debug_place("head", "legs_plain") and scene.get_feedback_text().contains("放不上")
	_prepare_bad(scene); var bad := scene.calculate_result()
	_prepare_warn(scene); var warn := scene.calculate_result()
	_prepare_success(scene); var success := scene.calculate_result()
	score_levels_ok = bad.level == "bad" and bad.tags.has("红白相冲") and warn.level == "warn" and success.level == "success" and success.score == 92
	await scene.debug_submit()


func _prepare_bad(scene: RuntimePaperCraftMinigameScene) -> void:
	scene.debug_select_paper("red"); scene.debug_select_finish("paint_eye"); scene.debug_place("head", "head_smile"); scene.debug_place("arms", "arms_open"); scene.debug_place("body", "body_hunched"); scene.debug_place("legs", "legs_stump")


func _prepare_warn(scene: RuntimePaperCraftMinigameScene) -> void:
	scene.debug_select_paper("white"); scene.debug_select_finish("paste_plain"); scene.debug_place("head", "head_tilted"); scene.debug_place("arms", "arms_open"); scene.debug_place("body", "body_hunched"); scene.debug_place("legs", "legs_bound")


func _prepare_success(scene: RuntimePaperCraftMinigameScene) -> void:
	scene.debug_select_paper("white"); scene.debug_select_finish("paste_plain"); scene.debug_place("head", "head_plain"); scene.debug_place("arms", "arms_down"); scene.debug_place("body", "body_straight"); scene.debug_place("legs", "legs_plain")


func _capture_result(payload: Variant) -> void:
	if payload is Dictionary: result_seen = payload.duplicate(true)


func _escape_session() -> void:
	bootstrap.input_manager.debug_key_down("Escape"); bootstrap.input_manager.debug_key_up("Escape")
