class_name RuntimeCutsceneManager
extends RuntimeSystem

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

const CUTSCENES_URL := "/assets/data/cutscenes/index.json"
const PARALLAX_URL := "/assets/data/parallax_scenes.json"
const CUTSCENE_EMOTE_OWNER := "cutscene"
const SAVE_BLOCKLIST := ["setFlag", "appendFlag", "setScenarioPhase", "startScenario", "activateScenario", "completeScenario", "giveItem", "removeItem", "giveCurrency", "removeCurrency", "giveRule", "grantRuleLayer", "giveFragment", "updateQuest", "startEncounter", "endDay", "addDelayedEvent", "addArchiveEntry", "openShop", "pickup", "shopPurchase", "inventoryDiscard", "revealDocument"]

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var cutscene_renderer: RuntimeCutsceneRenderer

var cutscene_defs: Dictionary = {}
var parallax_scenes: Variant = null
var playing := false
var wait_click_resolve := Callable()
var dialogue_resolve := Callable()
var dialogue_advance_not_before := 0
var wait_click_not_before := 0
var on_click_bound := Callable()

var entity_resolver := Callable()
var scene_switcher := Callable()
var temp_actors: Dictionary = {}
var emote_bubble_provider: Variant = null
var emote_target_resolver := Callable()
var input_manager: Variant = null
var audio_manager: Variant = null
var asset_manager: Variant = null
var unsub_pointer := Callable()
var unsub_key := Callable()
var destroyed := false
var skipping := false
var step_epoch := 0
var world_epoch := 0

var snapshot: Variant = null
var playback_cutscene_id: Variant = null
var playback_path_last: Variant = null
var playback_label_last: Variant = null
var scene_id_getter := Callable()
var player_position_getter := Callable()
var player_position_setter := Callable()
var camera_accessor: Variant = null
var spawn_point_resolver := Callable()
var scripted_speaker_resolver := Callable()
var colon_speaker_narrator_baseline_resolved: Variant = null
var display_text_resolver := Callable()
var scene_manager_api: Variant = null
var active_subtitle_voice_stops: Dictionary = {}


func _init(events: RuntimeEventBus, flags: RuntimeFlagStore, actions: RuntimeActionExecutor, renderer: RuntimeCutsceneRenderer) -> void:
	event_bus = events
	flag_store = flags
	action_executor = actions
	cutscene_renderer = renderer
	on_click_bound = Callable(self, "_on_click_bound")


func init(ctx: Dictionary) -> void:
	asset_manager = ctx.get("assetManager")
	destroyed = false
	playing = false
	skipping = false
	wait_click_resolve = Callable()
	dialogue_resolve = Callable()
	dialogue_advance_not_before = 0
	wait_click_not_before = 0
	snapshot = null
	playback_cutscene_id = null
	playback_path_last = null
	playback_label_last = null


func update(_dt: float) -> void:
	return


func set_input_manager(value: RuntimeInputManager) -> void:
	input_manager = value


func set_audio_manager(value: RuntimeAudioManager) -> void:
	audio_manager = value


func set_entity_resolver(resolver: Callable) -> void:
	entity_resolver = resolver


func set_emote_bubble_provider(provider: RuntimeEmoteBubbleManager) -> void:
	emote_bubble_provider = provider


func set_emote_target_resolver(resolver: Callable = Callable()) -> void:
	emote_target_resolver = resolver


func set_scene_switcher(switcher: Callable) -> void:
	scene_switcher = switcher


func set_scene_id_getter(callback: Callable) -> void:
	scene_id_getter = callback


func set_player_position_getter(callback: Callable) -> void:
	player_position_getter = callback


func set_player_position_setter(callback: Callable) -> void:
	player_position_setter = callback


func set_camera_accessor(value: RuntimeCamera) -> void:
	camera_accessor = value


func set_spawn_point_resolver(callback: Callable) -> void:
	spawn_point_resolver = callback


func set_scripted_speaker_resolver(callback: Callable = Callable()) -> void:
	scripted_speaker_resolver = callback


func set_display_text_resolver(callback: Callable = Callable()) -> void:
	display_text_resolver = callback


func set_colon_speaker_narrator_baseline_resolved(value: Variant) -> void:
	colon_speaker_narrator_baseline_resolved = value


func set_scene_manager(api: RuntimeSceneManager) -> void:
	scene_manager_api = api


func get_cutscene_ids() -> Array:
	return cutscene_defs.keys()


func get_cutscene_def(id: String) -> Variant:
	return cutscene_defs.get(id)


func get_playback_hud_snapshot() -> Dictionary:
	return {
		"cutsceneId": playback_cutscene_id,
		"path": playback_path_last,
		"label": playback_label_last,
	}


func fading_camera_zoom(target_zoom: float, duration_ms: float) -> void:
	var duration := maxf(0.0, duration_ms)
	await cutscene_renderer.camera_zoom(target_zoom, 1.0 if duration <= 0.0 else duration)


func show_overlay_image(overlay_id: String, image_path: String, x_percent: float, y_percent: float, width_percent: float) -> bool:
	return await cutscene_renderer.show_overlay_image(overlay_id, image_path, x_percent, y_percent, width_percent)


func hide_overlay_image(overlay_id: String) -> void:
	cutscene_renderer.hide_img(overlay_id)


func blend_overlay_image(overlay_id: String, from_path: String, to_path: String, x_percent: float, y_percent: float, width_percent: float, duration_ms: float, delay_ms: float) -> bool:
	return await cutscene_renderer.blend_overlay_image(overlay_id, from_path, to_path, x_percent, y_percent, width_percent, duration_ms, delay_ms)


func fade_world_to_black(duration_ms: float) -> void:
	var duration := maxf(0.0, duration_ms)
	await cutscene_renderer.fade_world_to_black(1.0 if duration <= 0.0 else duration)


func fade_world_from_black(duration_ms: float) -> void:
	var duration := maxf(0.0, duration_ms)
	await cutscene_renderer.fade_world_from_black(1.0 if duration <= 0.0 else duration)


func load_defs() -> void:
	if asset_manager == null:
		return
	var list: Variant = asset_manager.load_json(CUTSCENES_URL)
	if not list is Array:
		return
	for definition: Variant in list:
		if definition is Dictionary:
			var id := str(definition.get("id", ""))
			if not id.is_empty():
				cutscene_defs[id] = definition.duplicate(true)


func _get_parallax_scene(id: String) -> Variant:
	if parallax_scenes == null:
		var indexed: Dictionary = {}
		var list: Variant = asset_manager.load_json(PARALLAX_URL) if asset_manager != null else null
		if list is Array:
			for definition: Variant in list:
				if definition is Dictionary and definition.get("id") is String:
					indexed[str(definition.id)] = definition.duplicate(true)
		parallax_scenes = indexed
	return parallax_scenes.get(id) if parallax_scenes is Dictionary else null


func _collect_image_paths_from_steps(steps: Array, output: Dictionary) -> void:
	for step: Variant in steps:
		if not step is Dictionary:
			continue
		if step.get("kind") == "present" and step.get("type") == "showImg" and step.get("image") is String:
			output[str(step.image)] = true
		if step.get("kind") == "parallel" and step.get("tracks") is Array:
			_collect_image_paths_from_steps(step.tracks, output)


func start_cutscene(id: String) -> void:
	var definition: Variant = cutscene_defs.get(id)
	if not definition is Dictionary:
		push_warning('CutsceneManager: unknown cutscene "%s"' % id)
		return
	if playing:
		return
	playing = true
	skipping = false
	var step_epoch_at_start := step_epoch
	var world_epoch_at_start := world_epoch
	playback_cutscene_id = id
	event_bus.emit("cutscene:start", {"id": id})

	if definition.get("steps") is Array:
		var image_paths: Dictionary = {}
		_collect_image_paths_from_steps(definition.steps, image_paths)
		for path: String in image_paths:
			asset_manager.load_texture(path)

	if input_manager != null:
		unsub_pointer = input_manager.subscribe_pointer_down(on_click_bound)
		unsub_key = input_manager.subscribe_key_down(Callable(self, "_on_key_down"))

	var was_cross_scene := false
	_capture_snapshot()
	if audio_manager != null:
		audio_manager.begin_cutscene_sfx_capture()

	var target_scene_id := str(definition.get("targetScene", "")).strip_edges()
	var current_scene_id := str(scene_id_getter.call()).strip_edges() if scene_id_getter.is_valid() else ""
	var staging_scene_id := target_scene_id if not target_scene_id.is_empty() else current_scene_id
	if scene_manager_api != null and not staging_scene_id.is_empty():
		scene_manager_api.begin_cutscene_staging(id, staging_scene_id)

	was_cross_scene = await _save_and_transition_returning_cross_scene(definition)
	if not was_cross_scene and scene_manager_api != null:
		scene_manager_api.enter_cutscene_instances_for_current(id)

	if not definition.get("steps") is Array:
		push_warning('CutsceneManager: cutscene "%s" has no steps array (old commands format is no longer supported)' % id)
	else:
		action_executor.push_action_policy(SAVE_BLOCKLIST, "cutscene:%s" % id)
		await _execute_steps(definition.steps, step_epoch_at_start)
		action_executor.pop_action_policy()

	if world_epoch != world_epoch_at_start:
		if scene_manager_api != null:
			scene_manager_api.end_cutscene_staging()
		event_bus.emit("cutscene:end", {"id": id})
		return
	if destroyed:
		return

	var was_skipping := skipping
	_unsubscribe_inputs()
	skipping = false
	if not destroyed and not was_skipping:
		await cutscene_renderer.settle_fade_overlays_before_cleanup(500.0)

	if was_cross_scene:
		if not destroyed and definition.get("restoreState") != false:
			await _restore_snapshot()
		if scene_manager_api != null:
			scene_manager_api.end_cutscene_staging()
	else:
		if scene_manager_api != null:
			scene_manager_api.exit_cutscene_instances_for_current(id)
			scene_manager_api.end_cutscene_staging()
		if not destroyed and definition.get("restoreState") != false:
			await _restore_snapshot()

	snapshot = null
	_cleanup(was_skipping)
	playing = false
	playback_cutscene_id = null
	playback_path_last = null
	playback_label_last = null
	event_bus.emit("cutscene:step", {"cutsceneId": null, "path": null, "label": null})
	event_bus.emit("cutscene:end", {"id": id})


func skip() -> void:
	if not playing:
		return
	skipping = true
	skipping = true
	step_epoch += 1
	_stop_active_subtitle_voices()
	cutscene_renderer.abort_cutscene_ops()
	if wait_click_resolve.is_valid():
		var resolve := wait_click_resolve
		wait_click_resolve = Callable()
		wait_click_not_before = 0
		resolve.call()
	if dialogue_resolve.is_valid():
		var resolve := dialogue_resolve
		dialogue_resolve = Callable()
		dialogue_advance_not_before = 0
		resolve.call()


func _save_and_transition_returning_cross_scene(definition: Dictionary) -> bool:
	var current_scene_id := str(scene_id_getter.call()).strip_edges() if scene_id_getter.is_valid() else ""
	var target_scene_id := str(definition.get("targetScene", "")).strip_edges()
	var was_cross_scene := false
	if not target_scene_id.is_empty() and target_scene_id != current_scene_id and scene_switcher.is_valid():
		await scene_switcher.call({
			"targetScene": target_scene_id,
			"targetSpawnPoint": definition.get("targetSpawnPoint"),
		})
		was_cross_scene = true
	elif not str(definition.get("targetSpawnPoint", "")).is_empty() and spawn_point_resolver.is_valid():
		var spawn_position: Variant = spawn_point_resolver.call(str(definition.targetSpawnPoint))
		if spawn_position is Dictionary:
			if player_position_setter.is_valid():
				player_position_setter.call(float(spawn_position.x), float(spawn_position.y))
			if camera_accessor != null:
				camera_accessor.snap_to(float(spawn_position.x), float(spawn_position.y))

	if (definition.get("targetX") is int or definition.get("targetX") is float) and (definition.get("targetY") is int or definition.get("targetY") is float):
		if player_position_setter.is_valid():
			player_position_setter.call(float(definition.targetX), float(definition.targetY))
		if camera_accessor != null:
			camera_accessor.snap_to(float(definition.targetX), float(definition.targetY))
	return was_cross_scene


func _capture_snapshot() -> void:
	var current_scene_id := str(scene_id_getter.call()) if scene_id_getter.is_valid() else ""
	var position: Variant = player_position_getter.call() if player_position_getter.is_valid() else {"x": 0.0, "y": 0.0}
	snapshot = {
		"sceneId": current_scene_id,
		"playerX": float(position.get("x", 0.0)),
		"playerY": float(position.get("y", 0.0)),
		"cameraX": camera_accessor.get_x() if camera_accessor != null else 0.0,
		"cameraY": camera_accessor.get_y() if camera_accessor != null else 0.0,
		"cameraZoom": camera_accessor.get_zoom() if camera_accessor != null else 1.0,
		"bgmId": audio_manager.get_current_bgm_id() if audio_manager != null else null,
		"ambientIds": audio_manager.get_active_ambient_ids() if audio_manager != null else [],
	}


func _restore_snapshot() -> void:
	if not snapshot is Dictionary:
		return
	var current_scene_id := str(scene_id_getter.call()).strip_edges() if scene_id_getter.is_valid() else ""
	if str(snapshot.sceneId).strip_edges() == current_scene_id:
		if player_position_setter.is_valid():
			player_position_setter.call(float(snapshot.playerX), float(snapshot.playerY))
		if camera_accessor != null:
			camera_accessor.snap_to(float(snapshot.cameraX), float(snapshot.cameraY))
			camera_accessor.set_zoom(float(snapshot.cameraZoom))
		if audio_manager != null:
			audio_manager.restore_audio_baseline(snapshot.get("bgmId"), snapshot.get("ambientIds", []))
		return
	if not str(snapshot.sceneId).is_empty() and scene_switcher.is_valid():
		await scene_switcher.call({"targetScene": str(snapshot.sceneId)})
	if player_position_setter.is_valid():
		player_position_setter.call(float(snapshot.playerX), float(snapshot.playerY))
	if camera_accessor != null:
		camera_accessor.snap_to(float(snapshot.cameraX), float(snapshot.cameraY))
		camera_accessor.set_zoom(float(snapshot.cameraZoom))


func _is_step_stale(epoch: int) -> bool:
	return destroyed or step_epoch != epoch


func _can_arm_wait() -> bool:
	return not skipping and not destroyed and playing


func _execute_steps(steps: Array, epoch: int) -> void:
	for index in steps.size():
		if _is_step_stale(epoch):
			return
		var step: Variant = steps[index]
		if step is Dictionary:
			await _execute_one_step(step, str(index), epoch)


func _format_playback_step_label(step: Dictionary) -> String:
	match str(step.get("kind", "")):
		"action":
			var raw := JSON.stringify(step.get("params", {})) if step.get("params") is Dictionary and not step.params.is_empty() else ""
			var params := raw.left(69) + "…" if raw.length() > 72 else raw
			return "action:%s %s" % [step.get("type", ""), params] if not params.is_empty() else "action:%s" % step.get("type", "")
		"present":
			var type := str(step.get("type", ""))
			if type == "showDialogue":
				var text := str(step.get("text", "")).replace("\n", " ")
				return 'present:showDialogue "%s"' % (text.left(33) + "…" if text.length() > 36 else text)
			if type == "showTitle":
				var text := str(step.get("text", ""))
				return 'present:showTitle "%s"' % (text.left(25) + "…" if text.length() > 28 else text)
			if type in ["waitTime", "fadeToBlack", "fadeIn", "flashWhite", "cameraMove", "cameraZoom"]:
				return "present:%s%s" % [type, " %sms" % step.duration if step.has("duration") else ""]
			if type == "showImg":
				return "present:showImg id=%s" % step.get("id", "")
			if type == "showSubtitle":
				var emote := ""
				var raw_emote: Variant = step.get("subtitleEmote")
				if raw_emote is Dictionary and not str(raw_emote.get("target", "")).strip_edges().is_empty() and not str(raw_emote.get("emote", "")).strip_edges().is_empty():
					emote = " emote=%s@%s" % [JSON.stringify(str(raw_emote.emote).strip_edges()), str(raw_emote.target).strip_edges()]
				return "present:showSubtitle%s" % emote
			return "present:%s" % type
		"parallel":
			return "parallel (%s tracks)" % (step.get("tracks", []) as Array).size()
	return str(step.get("kind", "?"))


func _emit_playback_step(path: String, step: Dictionary) -> void:
	if playback_cutscene_id == null:
		return
	var label := _format_playback_step_label(step)
	playback_path_last = path
	playback_label_last = label
	event_bus.emit("cutscene:step", {"cutsceneId": playback_cutscene_id, "path": path, "label": label})


func _execute_one_step(step: Dictionary, path: String, epoch: int) -> void:
	if _is_step_stale(epoch):
		return
	_emit_playback_step(path, step)
	match str(step.get("kind", "")):
		"action":
			var type := str(step.get("type", ""))
			if type in SAVE_BLOCKLIST:
				push_warning('CutsceneManager: Action type "%s" modifies global save state and is ignored inside cutscenes' % type)
				return
			if type not in RuntimeDataTypes.CUTSCENE_ACTION_WHITELIST:
				push_warning('CutsceneManager: Action type "%s" is not in the Cutscene whitelist — skipped' % type)
				return
			await action_executor.execute_await({"type": type, "params": step.get("params", {})})
		"present":
			await _execute_present(step)
		"parallel":
			await _execute_parallel(step.get("tracks", []), path, epoch)
		_:
			push_warning('CutsceneManager: unknown step kind "%s"' % step.get("kind", ""))


func _execute_parallel(tracks: Variant, path: String, epoch: int) -> void:
	if not tracks is Array or tracks.is_empty():
		return
	var state := {"completed": 0}
	for index in tracks.size():
		var step: Variant = tracks[index]
		if step is Dictionary:
			_run_parallel_track(step, "%s.p%s" % [path, index], epoch, state)
		else:
			state.completed += 1
	while not _is_step_stale(epoch) and int(state.completed) < tracks.size():
		await Engine.get_main_loop().process_frame


func _run_parallel_track(step: Dictionary, path: String, epoch: int, state: Dictionary) -> void:
	await _execute_one_step(step, path, epoch)
	state.completed = int(state.completed) + 1


func _execute_present(step: Dictionary) -> void:
	if skipping or destroyed:
		return
	match str(step.get("type", "")):
		"fadeToBlack": await cutscene_renderer.fade_to_black(float(step.get("duration", 1000)))
		"fadeIn": await cutscene_renderer.fade_from_black(float(step.get("duration", 1000)))
		"flashWhite": await cutscene_renderer.flash_white(float(step.get("duration", 200)))
		"waitTime": await cutscene_renderer.wait_ms(float(step.get("duration", 1000)))
		"waitClick": await _wait_for_click()
		"showTitle": await cutscene_renderer.show_title(str(step.get("text", "")), float(step.get("duration", 2000)))
		"showDialogue":
			var raw_speaker := str(step.get("speaker", "")).strip_edges() if step.has("speaker") and step.get("speaker") != null else ""
			var scripted_npc_id := str(step.get("scriptedNpcId", "")).strip_edges()
			var speaker_out: Variant = null
			if not raw_speaker.is_empty() and scripted_speaker_resolver.is_valid():
				speaker_out = scripted_speaker_resolver.call(raw_speaker, scripted_npc_id)
			elif not raw_speaker.is_empty():
				speaker_out = raw_speaker
			var merged := _merge_present_show_dialogue_line(str(step.get("text", "")), speaker_out)
			await _show_dialogue_text(merged.text, merged.get("speaker"))
		"showImg":
			cutscene_renderer.show_img(str(step.get("image", "")), _resolve_cutscene_image_handle(step.get("id")), step.get("kenBurns"), step.get("zIndex"))
		"animLayer":
			cutscene_renderer.show_anim_layer(str(step.get("animFile", "")), str(step.get("id", "anim")), {
				"state": step.get("state"), "xPercent": step.get("xPercent"), "yPercent": step.get("yPercent"),
				"widthPercent": step.get("widthPercent"), "alpha": step.get("alpha"), "zIndex": step.get("zIndex"),
			})
		"parallaxScene":
			var inline: Variant = step.get("scene") if step.get("scene") is Dictionary else null
			var scene_id := str(step.get("id", "")).strip_edges()
			var definition: Variant = inline if inline != null else _get_parallax_scene(scene_id) if not scene_id.is_empty() else null
			if definition is Dictionary and definition.get("layers") is Array:
				cutscene_renderer.show_parallax_scene(definition, _resolve_cutscene_image_handle(step.get("handle")))
			else:
				push_warning('CutsceneManager: parallaxScene 未找到场景 "%s"' % scene_id)
		"hideImg": cutscene_renderer.hide_img(_resolve_cutscene_image_handle(step.get("id")))
		"showMovieBar": cutscene_renderer.show_movie_bar(float(step.get("heightPercent", 0.1)))
		"hideMovieBar": cutscene_renderer.hide_movie_bar()
		"showSubtitle":
			await _show_subtitle_text(
				str(step.get("text", "")),
				_resolve_show_subtitle_layout(step),
				_parse_subtitle_emote_spec(step),
				_parse_subtitle_voice_spec(step),
				_parse_subtitle_auto_advance_spec(step),
			)
		"cameraMove": await cutscene_renderer.camera_move(float(step.get("x", 0.0)), float(step.get("y", 0.0)), float(step.get("duration", 1000)))
		"cameraZoom": await cutscene_renderer.camera_zoom(float(step.get("scale", 1.0)), float(step.get("duration", 500)))
		"showCharacter": _entity_set_visible("player", step.get("visible") != false)
		_: push_warning('CutsceneManager: unknown present type "%s"' % step.get("type", ""))


func is_playing() -> bool:
	return playing


func get_temp_actors() -> Dictionary:
	return temp_actors


func spawn_temp_actor(id: String, display_name: String, x: float, y: float) -> void:
	_entity_spawn(id, display_name, x, y)


func remove_temp_actor(id: String) -> void:
	_entity_remove(id)


func _entity_spawn(id: String, display_name: String, x: float, y: float) -> void:
	if temp_actors.has(id):
		push_warning('CutsceneManager entity_spawn: "%s" already exists' % id)
		return
	var npc := RuntimeNpc.new({"id": id, "name": display_name if not display_name.is_empty() else id, "x": x, "y": y, "interactionRange": 0})
	temp_actors[id] = npc
	cutscene_renderer.add_to_entity_layer(npc.container)


func _entity_remove(id: String) -> void:
	var npc: Variant = temp_actors.get(id)
	if not npc is RuntimeNpc:
		push_warning('CutsceneManager entity_remove: "%s" not found in temp actors' % id)
		return
	npc.destroy_npc()
	temp_actors.erase(id)


func _entity_set_visible(target_id: String, visible: bool) -> void:
	var actor: Variant = entity_resolver.call(target_id) if entity_resolver.is_valid() else null
	if actor == null:
		push_warning('CutsceneManager entity_visible: entity "%s" not found' % target_id)
		return
	actor.set_visible(visible)


func _wait_for_click() -> void:
	await Engine.get_main_loop().process_frame
	await Engine.get_main_loop().process_frame
	if not _can_arm_wait():
		return
	var latch := RuntimeAsyncLatch.new()
	wait_click_not_before = Time.get_ticks_msec() + 120
	wait_click_resolve = func() -> void:
		wait_click_resolve = Callable()
		wait_click_not_before = 0
		latch.resolve()
	await latch.wait()


func _merge_present_show_dialogue_line(raw_text: String, speaker_out: Variant) -> Dictionary:
	var text_resolved := _resolve_display_text(raw_text)
	var split := RuntimeTextResolver.split_speaker_body_after_resolve(text_resolved)
	var raw_speaker := str(speaker_out).strip_edges() if speaker_out != null else ""
	if raw_speaker.is_empty():
		return {"speaker": split.speaker, "text": split.body} if not split.is_empty() else {"text": text_resolved}
	var speaker_resolved := _resolve_display_text(raw_speaker)
	if not split.is_empty() and colon_speaker_narrator_baseline_resolved != null and speaker_resolved == colon_speaker_narrator_baseline_resolved:
		return {"speaker": split.speaker, "text": split.body}
	return {"speaker": speaker_resolved, "text": text_resolved}


func _show_dialogue_text(text: String, speaker: Variant = null) -> void:
	var box := cutscene_renderer.show_dialogue_box(text, str(speaker) if speaker != null else "")
	await Engine.get_main_loop().process_frame
	await Engine.get_main_loop().process_frame
	if _can_arm_wait():
		var latch := RuntimeAsyncLatch.new()
		dialogue_advance_not_before = Time.get_ticks_msec() + 120
		dialogue_resolve = func() -> void:
			dialogue_resolve = Callable()
			dialogue_advance_not_before = 0
			latch.resolve()
		await latch.wait()
	cutscene_renderer.dismiss_dialogue_box(box)


func _resolve_show_subtitle_layout(step: Dictionary) -> Variant:
	var band := str(step.get("subtitleBand", "")).strip_edges()
	var align := str(step.get("subtitleAlign", "")).strip_edges()
	if band in ["movieTop", "movieBottom"] and align in ["left", "center", "right"]:
		return {"subtitleBand": band, "subtitleAlign": align}
	var position: Variant = step.get("position")
	if position in ["top", "center", "bottom"] or position is int or position is float:
		return position
	return "bottom"


func _parse_subtitle_emote_spec(step: Dictionary) -> Variant:
	var raw: Variant = step.get("subtitleEmote")
	if not raw is Dictionary:
		return null
	var target := str(raw.get("target", "")).strip_edges()
	var emote := str(raw.get("emote", "")).strip_edges()
	if target.is_empty() or emote.is_empty():
		return null
	var duration_parsed := float(raw.get("duration", 0.0))
	return {
		"target": target,
		"emote": emote,
		"durationMs": duration_parsed if duration_parsed > 0.0 else 1500.0,
		"opts": {
			"anchorOffsetX": float(raw.get("anchorOffsetX", 0.0)),
			"anchorOffsetY": float(raw.get("anchorOffsetY", 0.0)),
		},
	}


func _parse_subtitle_voice_spec(step: Dictionary) -> Variant:
	var raw: Variant = step.get("subtitleVoice")
	if raw is String:
		var string_id: String = raw.strip_edges()
		return {"id": string_id} if not string_id.is_empty() else null
	if not raw is Dictionary:
		return null
	var object_id := str(raw.get("id", raw.get("sfxId", ""))).strip_edges()
	if object_id.is_empty():
		return null
	return {"id": object_id, "volume": float(raw.volume)} if raw.get("volume") is int or raw.get("volume") is float else {"id": object_id}


func _parse_subtitle_auto_advance_spec(step: Dictionary) -> Variant:
	var raw: Variant = step.get("subtitleAutoAdvance")
	if raw is String and raw == "voice":
		return {"mode": "voice"}
	if (raw is int or raw is float) and float(raw) > 0.0:
		return {"mode": "timer", "ms": float(raw)}
	return null


func _show_subtitle_text(text: String, layout: Variant, subtitle_emote: Variant, subtitle_voice: Variant, auto_advance: Variant = null) -> void:
	var resolved := _resolve_display_text(text)
	var split := RuntimeTextResolver.split_speaker_body_after_resolve(resolved)
	var content: Variant = {"speaker": split.speaker, "separator": split.separator, "body": split.body} if not split.is_empty() else resolved
	var container := cutscene_renderer.show_subtitle(content, layout)
	var dismiss_subtitle_emote := Callable()
	var voice_state := {"handle": null}
	var stop_voice := Callable()
	var voice_stop_key := 0
	var state := {"voiceEndedBeforeArm": false, "settled": false, "resolver": Callable(), "latch": RuntimeAsyncLatch.new()}
	var on_voice_end := func() -> void:
		if auto_advance is Dictionary and auto_advance.get("mode") == "voice":
			if state.resolver is Callable and state.resolver.is_valid(): state.resolver.call()
			else: state.voiceEndedBeforeArm = true
	if subtitle_voice is Dictionary and audio_manager != null:
		var voice: Variant = audio_manager.play_transient_sfx(str(subtitle_voice.id), {"volume": subtitle_voice.get("volume"), "onEnd": on_voice_end})
		if voice is RuntimeAudioPlaybackHandle:
			voice_state.handle = voice
			voice_stop_key = voice.get_instance_id()
			stop_voice = func() -> void:
				var handle: Variant = voice_state.handle
				if handle is RuntimeAudioPlaybackHandle:
					handle.stop()
				voice_state.handle = null
			active_subtitle_voice_stops[voice_stop_key] = stop_voice
	if subtitle_emote is Dictionary and emote_bubble_provider != null:
		var anchor: Variant = emote_target_resolver.call(str(subtitle_emote.target)) if emote_target_resolver.is_valid() else null
		if anchor != null:
			dismiss_subtitle_emote = emote_bubble_provider.show_sticky(
				anchor,
				_resolve_display_text(str(subtitle_emote.emote)),
				subtitle_emote.opts,
				CUTSCENE_EMOTE_OWNER,
			)
		else:
			push_warning('CutsceneManager showSubtitle: subtitleEmote 目标未解析 "%s"' % subtitle_emote.target)

	await Engine.get_main_loop().process_frame
	await Engine.get_main_loop().process_frame
	if not _can_arm_wait() or state.voiceEndedBeforeArm == true:
		state.settled = true
	else:
		state.resolver = func() -> void: _finish_subtitle_wait(state)
		dialogue_advance_not_before = Time.get_ticks_msec() + 120
		dialogue_resolve = state.resolver
		if auto_advance is Dictionary and auto_advance.get("mode") == "timer":
			_run_subtitle_auto_timer(state, float(auto_advance.ms))
		await state.latch.wait()

	if stop_voice.is_valid():
		stop_voice.call()
		active_subtitle_voice_stops.erase(voice_stop_key)
	if dismiss_subtitle_emote.is_valid():
		dismiss_subtitle_emote.call()
	cutscene_renderer.dismiss_subtitle(container)


func _run_subtitle_auto_timer(state: Dictionary, duration_ms: float) -> void:
	await cutscene_renderer.wait_ms(duration_ms)
	_finish_subtitle_wait(state)


func _finish_subtitle_wait(state: Dictionary) -> void:
	if state.get("settled") == true:
		return
	state.settled = true
	var resolver: Callable = state.resolver
	if dialogue_resolve == resolver:
		dialogue_resolve = Callable()
	state.resolver = Callable()
	dialogue_advance_not_before = 0
	state.latch.resolve()


func _stop_active_subtitle_voices() -> void:
	for stop: Callable in active_subtitle_voice_stops.values():
		if stop.is_valid():
			stop.call()
	active_subtitle_voice_stops.clear()


func _cleanup(stop_cutscene_sfx: bool) -> void:
	_stop_active_subtitle_voices()
	if audio_manager != null:
		audio_manager.end_cutscene_sfx_capture(stop_cutscene_sfx)
	cutscene_renderer.cleanup()
	if emote_bubble_provider != null:
		emote_bubble_provider.cleanup_by_owner(CUTSCENE_EMOTE_OWNER)
	for npc: RuntimeNpc in temp_actors.values():
		npc.destroy_npc()
	temp_actors.clear()


func serialize() -> Dictionary:
	return {"playing": playing}


func deserialize(_data: Dictionary) -> void:
	step_epoch += 1
	world_epoch += 1
	if wait_click_resolve.is_valid():
		var resolve := wait_click_resolve
		wait_click_resolve = Callable()
		resolve.call()
	if dialogue_resolve.is_valid():
		var resolve := dialogue_resolve
		dialogue_resolve = Callable()
		resolve.call()
	if playing:
		_unsubscribe_inputs()
		_cleanup(true)
		event_bus.emit("cutscene:step", {"cutsceneId": null, "path": null, "label": null})
	playing = false
	skipping = false
	snapshot = null
	playback_cutscene_id = null
	playback_path_last = null
	playback_label_last = null
	dialogue_advance_not_before = 0
	wait_click_not_before = 0


func destroy() -> void:
	destroyed = true
	step_epoch += 1
	world_epoch += 1
	skipping = false
	snapshot = null
	playback_cutscene_id = null
	playback_path_last = null
	playback_label_last = null
	if wait_click_resolve.is_valid():
		var resolve := wait_click_resolve
		wait_click_resolve = Callable()
		resolve.call()
	if dialogue_resolve.is_valid():
		var resolve := dialogue_resolve
		dialogue_resolve = Callable()
		resolve.call()
	dialogue_advance_not_before = 0
	wait_click_not_before = 0
	_unsubscribe_inputs()
	_cleanup(true)
	cutscene_defs.clear()


func _on_click_bound() -> void:
	var now := Time.get_ticks_msec()
	if wait_click_resolve.is_valid():
		if now < wait_click_not_before:
			return
		var resolve := wait_click_resolve
		wait_click_resolve = Callable()
		wait_click_not_before = 0
		resolve.call()
	if dialogue_resolve.is_valid():
		if now < dialogue_advance_not_before:
			return
		var resolve := dialogue_resolve
		dialogue_resolve = Callable()
		dialogue_advance_not_before = 0
		resolve.call()


func _on_key_down(record: Dictionary) -> void:
	if not playing or record.get("repeat") == true:
		return
	var code := str(record.get("code", ""))
	if code == "Escape":
		var prevent_default: Variant = record.get("preventDefault")
		if prevent_default is Callable and prevent_default.is_valid():
			prevent_default.call()
		skip()
		return
	if code in ["Space", "Enter", "NumpadEnter", "KeyE"]:
		on_click_bound.call()


func _unsubscribe_inputs() -> void:
	if unsub_pointer.is_valid():
		unsub_pointer.call()
	unsub_pointer = Callable()
	if unsub_key.is_valid():
		unsub_key.call()
	unsub_key = Callable()


func _resolve_display_text(text: String) -> String:
	return str(display_text_resolver.call(text)) if display_text_resolver.is_valid() else text


static func _resolve_cutscene_image_handle(raw: Variant) -> String:
	var value := str(raw).strip_edges() if raw is String else ""
	return value if not value.is_empty() else RuntimeDataTypes.CUTSCENE_ANON_SHOT_ID
