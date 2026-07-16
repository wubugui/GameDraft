extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const BootstrapScript := preload("res://scripts/bootstrap.gd")
const RuntimeFillTemplateScript := preload("res://scripts/utils/fill_template.gd")

var bootstrap: Node
var result_seen: Dictionary = {}
var direct_architecture_ok := false
var actual_input_ok := false
var drag_ok := false
var score_levels_ok := false
var missing_guard_ok := false
var invalid_slot_ok := false


func _ready() -> void:
	bootstrap = BootstrapScript.new()
	bootstrap.set_meta("suppressSceneOnEnter", true)
	add_child(bootstrap)
	await get_tree().process_frame
	var manager: RuntimePaperCraftMinigameManager = bootstrap.paper_craft_minigame_manager
	assert(manager.get_instance_list() == [{"id": "wujin_paper_servant_daywork", "label": "雾津纸扎铺：糊纸人日工"}])
	assert(manager.index_url == "/assets/data/paper_craft/index.json")
	assert(manager.data_subdir == "paper_craft")
	assert(manager.scope_prefix == "minigame:paperCraft")
	assert(manager.system_label == "PaperCraftMinigameManager")
	var manifest_refs: Array = manager.build_instance_manifest_refs({
		"id": "probe",
		"backgroundImage": " bg.png ",
		"orders": [{"parts": [{"id": "part", "image": " part.png "}, {"id": "null", "image": null}]}],
	})
	assert(manifest_refs == [
		{"type": "texture", "path": " bg.png ", "label": "扎纸背景: probe"},
		{"type": "texture", "path": " part.png ", "label": "扎纸部件: part"},
	])
	assert(RuntimeFillTemplateScript.fill_token("A{x}B{x}", "{x}", "$&") == "A$&B{x}")
	assert(RuntimeFillTemplateScript.fill_template("{a}/{b}/{a}", {"{a}": "$1", "{b}": "$&"}) == "$1/$&/{a}")

	bootstrap.event_bus.on("minigame:paperCraftResult", Callable(self, "_capture_result"))
	_schedule_second_frame(Callable(self, "_solve_and_submit"))
	await bootstrap.action_executor.execute_await({"type": "startPaperCraftMinigame", "params": {"id": "wujin_paper_servant_daywork"}})
	assert(direct_architecture_ok and actual_input_ok and drag_ok and score_levels_ok and missing_guard_ok and invalid_slot_ok)
	assert(result_seen.get("level") == "success")
	assert(result_seen.get("score") == 92)
	assert(result_seen.get("paperId") == "white")
	assert(result_seen.get("finishId") == "paste_plain")
	assert(result_seen.get("placed") is Array and result_seen.placed.size() == 4)
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING)
	assert(not manager.active and manager.scene == null and bootstrap.action_executor.has_handler("startPaperCraftMinigame"))

	_schedule_second_frame(Callable(self, "_escape_session"))
	assert(await manager.run_until_done("wujin_paper_servant_daywork") == null)
	assert(bootstrap.state_controller.current_state == RuntimeDataTypes.EXPLORING and not manager.active)
	bootstrap.event_bus.off("minigame:paperCraftResult", Callable(self, "_capture_result"))
	bootstrap.audio_manager.stop_all_playback()
	bootstrap.asset_manager.clear_cache()
	await get_tree().process_frame
	remove_child(bootstrap)
	bootstrap.free()
	await get_tree().create_timer(0.15).timeout
	print("PaperCraft direct-object/layer/drag/score/action/session integration test: PASS")
	get_tree().quit(0)


func _schedule_second_frame(callback: Callable) -> void:
	get_tree().process_frame.connect(
		func() -> void: get_tree().process_frame.connect(callback, CONNECT_ONE_SHOT),
		CONNECT_ONE_SHOT,
	)


func _solve_and_submit() -> void:
	var manager: RuntimePaperCraftMinigameManager = bootstrap.paper_craft_minigame_manager
	await _wait_scene_ready(manager)
	var scene: RuntimePaperCraftMinigameScene = manager.scene
	assert(scene != null)
	var cached_instance: Variant = manager.instance_cache.get("wujin_paper_servant_daywork")
	var direct_children := scene.root.get_children()
	var layer_identity := [scene.bg, scene.work_layer, scene.palette_layer, scene.ui_layer]
	var layout_ok := scene.work_layer.position.distance_to(Vector2(61.996, 170.97)) < 0.12 \
		and is_equal_approx(scene.work_layer.scale.x, 1.122) \
		and scene.palette_layer.position.distance_to(Vector2(714.316, 80.0)) < 0.12 \
		and is_equal_approx(scene.palette_layer.scale.x, 642.0 / 648.0)
	var state := scene.get_debug_visual_state()
	direct_architecture_ok = scene.root.get_parent() == bootstrap.renderer.cutscene_overlay \
		and direct_children.size() == 4 \
		and direct_children[0] == scene.bg \
		and direct_children[1] == scene.work_layer \
		and direct_children[2] == scene.palette_layer \
		and direct_children[3] == scene.ui_layer \
		and scene.root.find_child("PixiComposite", true, false) == null \
		and is_same(scene.instance, cached_instance) \
		and is_same(scene.order, scene.instance.orders[0]) \
		and is_same(scene.selected_paper, scene.order.paperOptions[0]) \
		and is_same(scene.selected_finish, scene.order.finishOptions[0]) \
		and scene.textures.size() >= 15 \
		and layout_ok \
		and state.instanceId == "wujin_paper_servant_daywork" \
		and state.orderId == "paper_servant_plain" \
		and state.selectedPaperId == "white" \
		and state.selectedFinishId == "paste_plain" \
		and state.placed.is_empty()

	missing_guard_ok = not scene.finishing
	await scene._finish()
	missing_guard_ok = missing_guard_ok and scene.feedback.text.contains("还缺") and not scene.finishing and manager.active

	_press(scene, "Part_legs_plain")
	var selected_legs: Variant = _part(scene, "legs_plain")
	actual_input_ok = is_same(scene.selected_part, selected_legs)
	_press(scene, "Slot_head")
	invalid_slot_ok = scene.feedback.text.contains("放不上") and scene.placed.is_empty() and is_same(scene.selected_part, selected_legs)

	var dragged_part: Dictionary = _part(scene, "arms_down")
	var dragged_visual := scene._make_part_visual(dragged_part, 72.0, 72.0)
	scene.root.add_child(dragged_visual)
	scene.drag = {"part": dragged_part, "sprite": dragged_visual, "dx": 0.0, "dy": 0.0}
	var arms_slot: Dictionary = _slot(scene, "arms")
	var local_drop := Vector2(float(arms_slot.x) + float(arms_slot.width) / 2.0, float(arms_slot.y) + float(arms_slot.height) / 2.0)
	var global_drop := scene.work_layer.get_global_transform_with_canvas() * local_drop
	scene._on_drag_end({"global": global_drop})
	drag_ok = is_same(scene.placed.get("arms"), dragged_part) and scene.selected_part == null and scene.drag == null

	scene.placed.clear()
	scene.selected_part = null
	scene._rebuild()
	_prepare_bad(scene)
	var bad: Dictionary = scene._calculate_result()
	_prepare_warn(scene)
	var warn: Dictionary = scene._calculate_result()
	_prepare_success(scene)
	var success: Dictionary = scene._calculate_result()
	var raw_identity_ok := true
	for slot_id: Variant in scene.placed:
		raw_identity_ok = raw_identity_ok and is_same(scene.placed[slot_id], _part(scene, str(scene.placed[slot_id].id)))
	var layer_identity_preserved := layer_identity == [scene.bg, scene.work_layer, scene.palette_layer, scene.ui_layer]
	actual_input_ok = actual_input_ok and raw_identity_ok and layer_identity_preserved
	score_levels_ok = bad.level == "bad" \
		and bad.tags.has("红白相冲") \
		and warn.level == "warn" \
		and success.level == "success" \
		and success.score == 92
	await scene._finish()


func _wait_scene_ready(manager: RuntimePaperCraftMinigameManager) -> void:
	for _index: int in 240:
		var next_scene: Variant = manager.scene
		if next_scene is RuntimePaperCraftMinigameScene \
			and next_scene.root.get_parent() == bootstrap.renderer.cutscene_overlay \
			and next_scene.root.find_child("Part_legs_plain", true, false) != null:
			return
		await get_tree().process_frame
	assert(false, "paper-craft scene did not finish direct load/rebuild")


func _prepare_bad(scene: RuntimePaperCraftMinigameScene) -> void:
	_reset_order_choices(scene, "red", "paint_eye")
	_place_by_click(scene, "head", "head_smile")
	_place_by_click(scene, "arms", "arms_open")
	_place_by_click(scene, "body", "body_hunched")
	_place_by_click(scene, "legs", "legs_stump")


func _prepare_warn(scene: RuntimePaperCraftMinigameScene) -> void:
	_reset_order_choices(scene, "white", "paste_plain")
	_place_by_click(scene, "head", "head_tilted")
	_place_by_click(scene, "arms", "arms_open")
	_place_by_click(scene, "body", "body_hunched")
	_place_by_click(scene, "legs", "legs_bound")


func _prepare_success(scene: RuntimePaperCraftMinigameScene) -> void:
	_reset_order_choices(scene, "white", "paste_plain")
	_place_by_click(scene, "head", "head_plain")
	_place_by_click(scene, "arms", "arms_down")
	_place_by_click(scene, "body", "body_straight")
	_place_by_click(scene, "legs", "legs_plain")


func _reset_order_choices(scene: RuntimePaperCraftMinigameScene, paper_id: String, finish_id: String) -> void:
	scene.placed.clear()
	scene.selected_part = null
	scene._rebuild()
	_press(scene, "Paper_%s" % paper_id)
	_press(scene, "Finish_%s" % finish_id)


func _place_by_click(scene: RuntimePaperCraftMinigameScene, slot_id: String, part_id: String) -> void:
	_press(scene, "Part_%s" % part_id)
	var expected: Dictionary = _part(scene, part_id)
	assert(is_same(scene.selected_part, expected))
	_press(scene, "Slot_%s" % slot_id)
	assert(is_same(scene.placed.get(slot_id), expected))
	assert(scene.selected_part == null)


func _press(scene: RuntimePaperCraftMinigameScene, name: String) -> void:
	var button: Button = scene.root.find_child(name, true, false)
	assert(button != null, "missing paper-craft button %s" % name)
	button.emit_signal("pressed")


func _part(scene: RuntimePaperCraftMinigameScene, id: String) -> Dictionary:
	for value: Variant in scene.order.parts:
		if value is Dictionary and str(value.get("id", "")) == id:
			return value
	assert(false, "missing part %s" % id)
	return {}


func _slot(scene: RuntimePaperCraftMinigameScene, id: String) -> Dictionary:
	for value: Variant in scene.order.slots:
		if value is Dictionary and str(value.get("id", "")) == id:
			return value
	assert(false, "missing slot %s" % id)
	return {}


func _capture_result(payload: Variant) -> void:
	if payload is Dictionary:
		result_seen = payload.duplicate(true)


func _escape_session() -> void:
	InputManagerProbe.key_down(bootstrap.input_manager, "Escape")
	InputManagerProbe.key_up(bootstrap.input_manager, "Escape")
