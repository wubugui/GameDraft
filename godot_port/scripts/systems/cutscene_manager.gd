class_name RuntimeCutsceneManager
extends RuntimeSystem

signal parallel_progress

const CUTSCENES_URL := "/assets/data/cutscenes/index.json"
const PARALLAX_URL := "/assets/data/parallax_scenes.json"
const ACTION_ALLOWLIST := ["moveEntityTo", "faceEntity", "cutsceneSpawnActor", "cutsceneRemoveActor", "showEmoteAndWait", "showSpeechBubble", "showSpeechBubbleAndWait", "playNpcAnimation", "setEntityEnabled", "persistNpcDisablePatrol", "persistNpcEnablePatrol", "persistNpcEntityEnabled", "persistHotspotEnabled", "setZoneEnabled", "persistZoneEnabled", "persistNpcAt", "persistNpcAnimState", "persistPlayNpcAnimation", "setEntityField", "setSceneEntityPosition", "setHotspotDisplayImage", "tempSetHotspotDisplayFacing", "playSfx", "playBgm", "stopBgm", "playSignalCue", "startWaterMinigame", "startSugarWheelMinigame", "sugarWheelShowSpeech", "sugarWheelDismissSpeech", "sugarWheelDismissAllSpeech", "sugarWheelResetPointer", "randomBranch", "activatePlane", "deactivatePlane"]
const SAVE_BLOCKLIST := ["setFlag", "appendFlag", "setScenarioPhase", "startScenario", "activateScenario", "completeScenario", "giveItem", "removeItem", "giveCurrency", "removeCurrency", "giveRule", "grantRuleLayer", "giveFragment", "updateQuest", "startEncounter", "endDay", "addDelayedEvent", "addArchiveEntry", "openShop", "pickup", "shopPurchase", "inventoryDiscard", "revealDocument"]

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var cutscene_renderer: RuntimeCutsceneRenderer
var input_manager: RuntimeInputManager
var asset_manager: RuntimeAssetManager
var camera: RuntimeCamera
var player: RuntimePlayer
var scene_manager: RuntimeSceneManager
var cutscene_defs: Dictionary = {}
var parallax_scenes: Dictionary = {}
var temp_actors: Dictionary = {}
var playing := false
var skipping := false
var destroyed := false
var step_epoch := 0
var world_epoch := 0
var snapshot: Variant = null
var playback_cutscene_id := ""
var playback_path: Variant = null
var playback_label: Variant = null
var _advance_serial := 0
var _unsubscribe_pointer := Callable()
var _unsubscribe_key := Callable()
var _resolve_display := Callable()
var _resolve_scripted_speaker := Callable()
var _narrator_baseline := "旁白"
var _parallel_counts: Dictionary = {}
var _time_scale := 1.0
var audio_manager: RuntimeAudioManager
var emote_bubbles: RuntimeEmoteBubbleManager


func _init(events: RuntimeEventBus, flags: RuntimeFlagStore, actions: RuntimeActionExecutor, next_renderer: RuntimeCutsceneRenderer, input: RuntimeInputManager, assets: RuntimeAssetManager, next_camera: RuntimeCamera, next_player: RuntimePlayer, scenes: RuntimeSceneManager) -> void:
	event_bus = events; flag_store = flags; action_executor = actions; cutscene_renderer = next_renderer; input_manager = input; asset_manager = assets; camera = next_camera; player = next_player; scene_manager = scenes


func init(_ctx: Dictionary) -> void: destroyed = false
func set_resolve_display(callback: Callable = Callable()) -> void: _resolve_display = callback; cutscene_renderer.set_resolve_display(callback)
func set_scripted_speaker_resolver(callback: Callable = Callable()) -> void: _resolve_scripted_speaker = callback
func set_narrator_baseline(value: String) -> void: _narrator_baseline = value
func set_runtime_support(audio: RuntimeAudioManager, bubbles: RuntimeEmoteBubbleManager) -> void: audio_manager = audio; emote_bubbles = bubbles
func set_time_scale(value: float) -> void: _time_scale = maxf(0.0, value); cutscene_renderer.set_time_scale(_time_scale)
func is_playing() -> bool: return playing
func has_cutscene(id: String) -> bool: return cutscene_defs.has(id.strip_edges())
func get_cutscene_ids() -> Array: return cutscene_defs.keys()
func get_cutscene_def(id: String) -> Variant: return cutscene_defs.get(id)
func get_playback_hud_snapshot() -> Dictionary: return {"cutsceneId": playback_cutscene_id if not playback_cutscene_id.is_empty() else null, "path": playback_path, "label": playback_label}
func get_temp_actor(id: String) -> Variant: return temp_actors.get(id)


func load_defs() -> bool:
	var raw: Variant = asset_manager.load_json(CUTSCENES_URL)
	if not raw is Array: return false
	cutscene_defs.clear()
	for definition: Variant in raw:
		if definition is Dictionary and not str(definition.get("id", "")).strip_edges().is_empty(): cutscene_defs[str(definition.id).strip_edges()] = definition.duplicate(true)
	var parallax_raw: Variant = asset_manager.load_json(PARALLAX_URL); parallax_scenes.clear()
	if parallax_raw is Array:
		for definition: Variant in parallax_raw:
			if definition is Dictionary and not str(definition.get("id", "")).is_empty(): parallax_scenes[str(definition.id)] = definition.duplicate(true)
	return not cutscene_defs.is_empty()


func start_cutscene(id: String) -> bool:
	var definition: Variant = cutscene_defs.get(id.strip_edges())
	if not definition is Dictionary or playing or destroyed: return false
	playing = true; skipping = false; var epoch := step_epoch; var world_at_start := world_epoch; playback_cutscene_id = str(definition.id); _advance_serial = 0; _capture_snapshot(); event_bus.emit("cutscene:start", {"id": playback_cutscene_id})
	if audio_manager != null:
		audio_manager.begin_cutscene_sfx_capture()
	_bind_input()
	var target_scene := str(definition.get("targetScene", "")).strip_edges()
	var scene_before := scene_manager.get_current_scene_id(); var staging_scene := target_scene if not target_scene.is_empty() else scene_before; var was_cross_scene := not target_scene.is_empty() and target_scene != scene_before
	if not staging_scene.is_empty(): scene_manager.begin_cutscene_staging(id, staging_scene)
	if was_cross_scene: await scene_manager.switch_scene_and_wait(target_scene, str(definition.get("targetSpawnPoint", "")))
	elif not str(definition.get("targetSpawnPoint", "")).strip_edges().is_empty(): scene_manager.switch_scene(scene_manager.get_current_scene_id(), str(definition.targetSpawnPoint))
	if not was_cross_scene: scene_manager.enter_cutscene_instances_for_current(id)
	if (definition.get("targetX") is int or definition.get("targetX") is float) and (definition.get("targetY") is int or definition.get("targetY") is float): player.set_x(float(definition.targetX)); player.set_y(float(definition.targetY)); camera.snap_to(float(definition.targetX), float(definition.targetY))
	action_executor.push_action_policy(SAVE_BLOCKLIST, "cutscene:%s" % id)
	await _execute_steps(definition.get("steps", []), epoch)
	action_executor.pop_action_policy()
	if world_epoch == world_at_start:
		if not skipping: await cutscene_renderer.settle_fade_overlays_before_cleanup(500.0)
		if was_cross_scene:
			if definition.get("restoreState") != false: await _restore_snapshot()
			scene_manager.end_cutscene_staging()
		else:
			scene_manager.exit_cutscene_instances_for_current(id)
			scene_manager.end_cutscene_staging()
			if definition.get("restoreState") != false: await _restore_snapshot()
	var was_skipping := skipping
	_unbind_input()
	cutscene_renderer.cleanup()
	if emote_bubbles != null:
		emote_bubbles.cleanup_by_owner("cutscene")
	if audio_manager != null:
		audio_manager.end_cutscene_sfx_capture(was_skipping)
	_destroy_temp_actors(); snapshot = null; playing = false; skipping = false; playback_cutscene_id = ""; playback_path = null; playback_label = null; event_bus.emit("cutscene:step", {"cutsceneId": null, "path": null, "label": null}); event_bus.emit("cutscene:end", {"id": id, "interrupted": was_skipping})
	return true


func skip() -> void:
	if not playing: return
	skipping = true; step_epoch += 1; _advance_serial += 1; cutscene_renderer.abort_cutscene_ops()
	if emote_bubbles != null:
		emote_bubbles.cleanup_by_owner("cutscene")
	parallel_progress.emit()


func debug_advance() -> void: _advance_serial += 1


func update(dt: float) -> void:
	cutscene_renderer.update(dt)
	for npc: RuntimeNpc in temp_actors.values(): npc.cutscene_update(dt)


func serialize() -> Dictionary: return {"playing": playing}


func deserialize(_data: Dictionary) -> void:
	step_epoch += 1; world_epoch += 1; _advance_serial += 1; cutscene_renderer.abort_cutscene_ops(); _unbind_input()
	if playing:
		cutscene_renderer.cleanup()
		if emote_bubbles != null:
			emote_bubbles.cleanup_by_owner("cutscene")
		if audio_manager != null:
			audio_manager.end_cutscene_sfx_capture(true)
		_destroy_temp_actors()
		event_bus.emit("cutscene:step", {"cutsceneId": null, "path": null, "label": null})
	playing = false; skipping = false; snapshot = null; playback_cutscene_id = ""; playback_path = null; playback_label = null; parallel_progress.emit()
	scene_manager.end_cutscene_staging()


func destroy() -> void:
	destroyed = true; deserialize({}); cutscene_defs.clear(); parallax_scenes.clear(); cutscene_renderer.destroy(); _resolve_display = Callable(); _resolve_scripted_speaker = Callable()


func spawn_temp_actor(id: String, display_name: String, x: float, y: float) -> bool:
	var key := id.strip_edges(); if key.is_empty() or temp_actors.has(key): return false
	var npc := RuntimeNpc.new({"id": key, "name": display_name if not display_name.is_empty() else key, "x": x, "y": y, "interactionRange": 0}); renderer_entity_layer().add_child(npc.container); temp_actors[key] = npc; return true
func remove_temp_actor(id: String) -> bool:
	var npc: Variant = temp_actors.get(id.strip_edges()); if not npc is RuntimeNpc: return false
	npc.destroy_npc(); temp_actors.erase(id.strip_edges()); return true
func renderer_entity_layer() -> Node2D: return cutscene_renderer.renderer.entity_layer


func _execute_steps(raw: Variant, epoch: int) -> void:
	if not raw is Array: return
	for index in raw.size():
		if _stale(epoch): return
		var step: Variant = raw[index]
		if step is Dictionary: await _execute_step(step, str(index), epoch)


func _execute_step(step: Dictionary, path: String, epoch: int) -> void:
	if _stale(epoch): return
	_emit_step(path, step)
	match str(step.get("kind", "")):
		"action":
			var type := str(step.get("type", ""))
			if type in SAVE_BLOCKLIST or type not in ACTION_ALLOWLIST: return
			await action_executor.execute_await({"type": type, "params": step.get("params", {})})
		"present": await _execute_present(step, epoch)
		"parallel": await _execute_parallel(step.get("tracks", []), path, epoch)


func _execute_parallel(raw: Variant, path: String, epoch: int) -> void:
	if not raw is Array or raw.is_empty(): return
	var token := "%s:%s:%s" % [get_instance_id(), path, Time.get_ticks_usec()]; _parallel_counts[token] = 0
	for index in raw.size():
		var step: Variant = raw[index]
		if step is Dictionary: _run_parallel_track(step, "%s.p%s" % [path, index], epoch, token)
		else: _parallel_counts[token] = int(_parallel_counts[token]) + 1
	while not _stale(epoch) and int(_parallel_counts.get(token, 0)) < raw.size(): await parallel_progress
	_parallel_counts.erase(token)


func _run_parallel_track(step: Dictionary, path: String, epoch: int, token: String) -> void:
	await _execute_step(step, path, epoch)
	if _parallel_counts.has(token): _parallel_counts[token] = int(_parallel_counts[token]) + 1; parallel_progress.emit()


func _execute_present(step: Dictionary, epoch: int) -> void:
	if _stale(epoch): return
	match str(step.get("type", "")):
		"fadeToBlack": await cutscene_renderer.fade_to_black(float(step.get("duration", 1000)))
		"fadeIn": await cutscene_renderer.fade_from_black(float(step.get("duration", 1000)))
		"flashWhite": await cutscene_renderer.flash_white(float(step.get("duration", 200)))
		"waitTime": await cutscene_renderer.wait_ms(float(step.get("duration", 1000)))
		"waitClick": await _wait_for_advance(epoch)
		"showTitle": await cutscene_renderer.show_title(_r(str(step.get("text", ""))), float(step.get("duration", 2000)))
		"showDialogue":
			var raw_speaker := str(step.get("speaker", "")).strip_edges(); var scripted_id := str(step.get("scriptedNpcId", "")).strip_edges(); var speaker := str(_resolve_scripted_speaker.call(raw_speaker, scripted_id)) if not raw_speaker.is_empty() and not _resolve_scripted_speaker.is_null() and _resolve_scripted_speaker.is_valid() else raw_speaker; var merged := _merge_dialogue(_r(str(step.get("text", ""))), _r(speaker)); var box := cutscene_renderer.show_dialogue_box(merged.text, merged.speaker); await _wait_for_advance(epoch); cutscene_renderer.dismiss_dialogue_box(box)
		"showImg": cutscene_renderer.show_img(str(step.get("image", "")), _image_handle(step.get("id")), step.get("kenBurns"), step.get("zIndex"))
		"animLayer": cutscene_renderer.show_anim_layer(str(step.get("animFile", "")), str(step.get("id", "anim")), step)
		"parallaxScene":
			var definition: Variant = step.get("scene") if step.get("scene") is Dictionary else parallax_scenes.get(str(step.get("id", ""))); if definition is Dictionary: cutscene_renderer.show_parallax_scene(definition, _image_handle(step.get("handle")))
		"hideImg": cutscene_renderer.hide_img(_image_handle(step.get("id")))
		"showMovieBar": cutscene_renderer.show_movie_bar(float(step.get("heightPercent", 0.1)))
		"hideMovieBar": cutscene_renderer.hide_movie_bar()
		"showSubtitle":
			var layout: Variant = {"subtitleBand": step.subtitleBand, "subtitleAlign": step.subtitleAlign} if str(step.get("subtitleBand", "")) in ["movieTop", "movieBottom"] and str(step.get("subtitleAlign", "")) in ["left", "center", "right"] else step.get("position", "bottom")
			var resolved_text: String = _r(str(step.get("text", ""))); var split: Dictionary = RuntimeTextResolver.new().split_speaker_body_after_resolve(resolved_text); var subtitle_text: String = "%s%s%s" % [split.speaker, split.separator, split.body] if not split.is_empty() else resolved_text
			var subtitle := cutscene_renderer.show_subtitle(subtitle_text, layout)
			var emote_id: int = _show_subtitle_emote(step.get("subtitleEmote"))
			var voice: Variant = _play_subtitle_voice(step.get("subtitleVoice"))
			var voice_instance_id: int = voice.get_instance_id() if voice is AudioStreamPlayer else 0; voice = null
			await _wait_for_subtitle_advance(epoch, step.get("subtitleAutoAdvance"), voice_instance_id)
			var active_voice: Variant = instance_from_id(voice_instance_id) if voice_instance_id > 0 else null
			if audio_manager != null and active_voice is AudioStreamPlayer: audio_manager.stop_transient_sfx(active_voice)
			if emote_bubbles != null and emote_id >= 0: emote_bubbles.dismiss(emote_id)
			cutscene_renderer.dismiss_subtitle(subtitle)
		"cameraMove": await cutscene_renderer.camera_move(float(step.get("x", camera.get_x())), float(step.get("y", camera.get_y())), float(step.get("duration", 1000)))
		"cameraZoom": await cutscene_renderer.camera_zoom(float(step.get("scale", camera.get_zoom())), float(step.get("duration", 500)))
		"showCharacter": player.set_visible(step.get("visible") != false)


func _wait_for_advance(epoch: int, timeout_ms: float = -1.0) -> void:
	await Engine.get_main_loop().process_frame; await Engine.get_main_loop().process_frame
	if _stale(epoch): return
	var serial := _advance_serial; var arm_ms := 0.0 if _time_scale == 0 else 120.0; var start := Time.get_ticks_msec(); var timeout := timeout_ms * _time_scale if timeout_ms >= 0 else -1.0
	while not _stale(epoch):
		var elapsed := float(Time.get_ticks_msec() - start)
		if elapsed >= arm_ms and _advance_serial != serial: return
		if timeout >= 0 and elapsed >= timeout: return
		await Engine.get_main_loop().process_frame


func _wait_for_subtitle_advance(epoch: int, auto: Variant, voice_instance_id: int) -> void:
	await Engine.get_main_loop().process_frame; await Engine.get_main_loop().process_frame
	if _stale(epoch): return
	var serial: int = _advance_serial; var arm_ms: float = 0.0 if _time_scale == 0 else 120.0; var start: int = Time.get_ticks_msec(); var timeout: float = float(auto) * _time_scale if (auto is int or auto is float) and float(auto) > 0 else -1.0; var voice_mode: bool = auto is String and auto == "voice" and voice_instance_id > 0
	if voice_mode:
		var voice_before_arm: Variant = instance_from_id(voice_instance_id)
		if not voice_before_arm is AudioStreamPlayer or not voice_before_arm.playing: return
	while not _stale(epoch):
		var elapsed := float(Time.get_ticks_msec() - start)
		if elapsed >= arm_ms and _advance_serial != serial: return
		if timeout >= 0 and elapsed >= timeout: return
		if voice_mode and elapsed >= arm_ms:
			var voice: Variant = instance_from_id(voice_instance_id)
			if not voice is AudioStreamPlayer or not voice.playing: return
		await Engine.get_main_loop().process_frame


func _show_subtitle_emote(raw: Variant) -> int:
	if not raw is Dictionary or emote_bubbles == null: return -1
	var target: String = str(raw.get("target", "")).strip_edges(); var emote: String = _r(str(raw.get("emote", "")).strip_edges()); var actor: Variant = _resolve_actor(target)
	return emote_bubbles.show_sticky(actor, emote, raw, "cutscene") if actor != null and not emote.is_empty() else -1


func _play_subtitle_voice(raw: Variant) -> Variant:
	if audio_manager == null: return null
	var id: String = raw.strip_edges() if raw is String else str(raw.get("id", raw.get("sfxId", ""))).strip_edges() if raw is Dictionary else ""
	var volume: Variant = raw.get("volume") if raw is Dictionary else null
	return audio_manager.play_transient_sfx(id, volume) if not id.is_empty() else null


func _resolve_actor(id: String) -> Variant:
	if id == "player": return player
	var actor: Variant = temp_actors.get(id)
	if actor != null: return actor
	actor = scene_manager.get_npc_by_id(id)
	return actor if actor != null else scene_manager.get_hotspot_by_id(id)


func _bind_input() -> void:
	_unbind_input(); _unsubscribe_pointer = input_manager.subscribe_pointer_down(Callable(self, "_on_pointer")); _unsubscribe_key = input_manager.subscribe_key_down(Callable(self, "_on_key"))
func _unbind_input() -> void:
	if not _unsubscribe_pointer.is_null() and _unsubscribe_pointer.is_valid(): _unsubscribe_pointer.call()
	if not _unsubscribe_key.is_null() and _unsubscribe_key.is_valid(): _unsubscribe_key.call()
	_unsubscribe_pointer = Callable(); _unsubscribe_key = Callable()
func _on_pointer() -> void: _advance_serial += 1
func _on_key(record: Dictionary) -> void:
	if record.get("repeat") == true: return
	var code := str(record.get("code", "")); if code == "Escape": var prevent: Variant = record.get("preventDefault"); if prevent is Callable and prevent.is_valid(): prevent.call(); skip(); return
	if code in ["Space", "Enter", "NumpadEnter", "KeyE"]: _advance_serial += 1


func _capture_snapshot() -> void: snapshot = {"sceneId": scene_manager.get_current_scene_id(), "playerX": player.get_x(), "playerY": player.get_y(), "cameraX": camera.get_x(), "cameraY": camera.get_y(), "cameraZoom": camera.get_zoom(), "bgmId": audio_manager.get_current_bgm_id() if audio_manager != null else null, "ambientIds": audio_manager.get_active_ambient_ids() if audio_manager != null else []}
func _restore_snapshot() -> void:
	if not snapshot is Dictionary: return
	var same_scene := str(snapshot.sceneId) == scene_manager.get_current_scene_id()
	if not same_scene and not str(snapshot.sceneId).is_empty(): await scene_manager.switch_scene_and_wait(str(snapshot.sceneId))
	player.set_x(float(snapshot.playerX)); player.set_y(float(snapshot.playerY)); camera.snap_to(float(snapshot.cameraX), float(snapshot.cameraY)); camera.set_zoom(float(snapshot.cameraZoom))
	if same_scene and audio_manager != null: audio_manager.restore_audio_baseline(snapshot.get("bgmId"), snapshot.get("ambientIds", []))
func _destroy_temp_actors() -> void:
	for npc: RuntimeNpc in temp_actors.values(): npc.destroy_npc()
	temp_actors.clear()
func _stale(epoch: int) -> bool: return destroyed or step_epoch != epoch
func _image_handle(raw: Variant) -> String: var value := str(raw).strip_edges() if raw != null else ""; return value if not value.is_empty() else RuntimeCutsceneRenderer.ANON_SHOT_ID
func _r(text: String) -> String: return str(_resolve_display.call(text)) if not _resolve_display.is_null() and _resolve_display.is_valid() else text
func _merge_dialogue(text: String, speaker: String) -> Dictionary:
	var split := RuntimeTextResolver.new().split_speaker_body_after_resolve(text)
	if split.is_empty(): return {"speaker": speaker, "text": text}
	if speaker.is_empty() or speaker == _narrator_baseline: return {"speaker": split.speaker, "text": split.body}
	return {"speaker": speaker, "text": text}
func _emit_step(path: String, step: Dictionary) -> void: playback_path = path; playback_label = "%s:%s" % [step.get("kind", "?"), step.get("type", "")]; event_bus.emit("cutscene:step", {"cutsceneId": playback_cutscene_id, "path": path, "label": playback_label})
