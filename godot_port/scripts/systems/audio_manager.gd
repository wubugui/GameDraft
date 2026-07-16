class_name RuntimeAudioManager
extends RuntimeSystem

const CONFIG_URL := "/assets/data/audio_config.json"
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")


# Direct fields, in AudioManager.ts declaration order.
var event_bus: RuntimeEventBus
var config: Dictionary = {"bgm": {}, "ambient": {}, "sfx": {}, "systemSfx": {}}
var loaded := false
var current_bgm: AudioStreamPlayer = null
var current_bgm_id: Variant = null
var requested_bgm_id: Variant = null
var bgm_request_seq := 0
var current_bgm_base_volume := 1.0
var ambient_layers: Dictionary = {}
var requested_ambient_ids: Dictionary = {}
var ambient_base_volume: Dictionary = {}
var ambient_request_seq: Dictionary = {}
var sfx_cache: Dictionary = {}
var cutscene_sfx_active := false
var cutscene_sfx_sounds: Array[AudioStreamPlayer] = []
var bgm_volume := 0.6
var sfx_volume := 0.8
var ambient_volume := 0.4
var pending_timers: Dictionary = {}
var asset_manager: Variant = null
var audio_unblocked := false
var audio_unlocking := false
var pending_playback: Array[Callable] = []
var gesture_listeners_installed := false
var sfx_event_listeners: Array[Dictionary] = []
var last_map_travel_sfx_at := 0

# Godot engine adapters. Howler owns concurrent sound ids and fades internally;
# Godot needs one player per sound id plus a small fade scheduler.
var active_sfx: Array[AudioStreamPlayer] = []
var _fading_players: Dictionary = {}
var _volume_fades: Dictionary = {}


func _init(events: RuntimeEventBus) -> void:
	event_bus = events


func init(ctx: Dictionary) -> void:
	asset_manager = ctx.assetManager
	_install_audio_gesture_gate()
	_install_system_sfx_listeners()


func update(_dt: float) -> void:
	return


func load_config() -> void:
	var raw: Variant = asset_manager.load_json(CONFIG_URL)
	await RuntimeMicrotaskQueueScript.yield_turn()
	if not raw is Dictionary:
		push_warning("AudioManager: audio_config.json not found, running silent")
		loaded = true
		return
	var resolve_src := func(source: Variant) -> Dictionary:
		var output := {}
		if not source is Dictionary:
			return output
		for key: Variant in source:
			var value: Variant = source[key]
			if not value is Dictionary:
				continue
			var entry := {"src": _resolve_asset_path(str(value.get("src", "")))}
			if value.get("volume") is int or value.get("volume") is float:
				entry.volume = float(value.volume)
			output[str(key)] = entry
		return output
	var system_sfx := {}
	var raw_system_sfx: Variant = raw.get("systemSfx", {})
	if raw_system_sfx is Dictionary:
		for key: Variant in raw_system_sfx:
			var value: Variant = raw_system_sfx[key]
			if value is String and not value.strip_edges().is_empty():
				system_sfx[str(key)] = value
	config = {
		"bgm": resolve_src.call(raw.get("bgm", {})),
		"ambient": resolve_src.call(raw.get("ambient", {})),
		"sfx": resolve_src.call(raw.get("sfx", {})),
		"systemSfx": system_sfx,
	}
	loaded = true


func play_bgm(id: String, fade_ms: float = 1000.0) -> void:
	requested_bgm_id = id
	bgm_request_seq += 1
	var my_request := bgm_request_seq
	_run_when_audio_allowed(func() -> void:
		if my_request != bgm_request_seq:
			return
		if current_bgm_id == id and current_bgm != null:
			return
		var entry: Variant = config.bgm.get(id)
		if not entry is Dictionary:
			push_warning('AudioManager: unknown bgm "%s"' % id)
			return
		var stream: Variant = asset_manager.get_audio(str(entry.src), {"loop": true})
		if not stream is AudioStream:
			stream = asset_manager.load_audio(str(entry.src), {"loop": true})
			await RuntimeMicrotaskQueueScript.yield_turn()
		if not stream is AudioStream or my_request != bgm_request_seq:
			return
		if current_bgm_id == id and current_bgm != null and current_bgm.stream == stream:
			return

		var old := current_bgm
		var player: AudioStreamPlayer
		if old != null and old.stream == stream:
			player = old
			_cancel_volume_fade(player)
		else:
			player = _take_fading_player_for_stream(stream)
			if player == null:
				player = _new_audio_player("Bgm:%s" % id, stream)
			else:
				player.name = "Bgm:%s" % id
		if old != null and old != player:
			_start_linear_fade(old, _player_linear_volume(old), 0.0, fade_ms)
			_schedule_cleanup(func() -> void:
				if current_bgm != old:
					_stop_and_free(old)
			, fade_ms)
		player.stop()
		player.volume_db = _linear_db(0.0)
		player.play()
		var base_volume := float(entry.get("volume", 1.0))
		_start_linear_fade(player, 0.0, _clamp01(base_volume * bgm_volume), fade_ms)
		current_bgm = player
		current_bgm_id = id
		current_bgm_base_volume = base_volume
	)


func stop_bgm(fade_ms: float = 1000.0) -> void:
	requested_bgm_id = null
	bgm_request_seq += 1
	_run_when_audio_allowed(func() -> void:
		if current_bgm == null:
			return
		var bgm := current_bgm
		_start_linear_fade(bgm, _player_linear_volume(bgm), 0.0, fade_ms)
		_schedule_cleanup(func() -> void:
			if current_bgm != bgm:
				_stop_and_free(bgm)
		, fade_ms)
		current_bgm = null
		current_bgm_id = null
	)


func _bump_ambient_seq(id: String) -> int:
	var next := int(ambient_request_seq.get(id, 0)) + 1
	ambient_request_seq[id] = next
	return next


func add_ambient(id: String, volume: Variant = null) -> void:
	requested_ambient_ids[id] = true
	var my_request := _bump_ambient_seq(id)
	_run_when_audio_allowed(func() -> void:
		if my_request != int(ambient_request_seq.get(id, 0)):
			return
		if ambient_layers.has(id):
			return
		var entry: Variant = config.ambient.get(id)
		if not entry is Dictionary:
			push_warning('AudioManager: unknown ambient "%s"' % id)
			return
		var base_volume := float(volume) if volume != null else float(entry.get("volume", 1.0))
		var stream: Variant = asset_manager.get_audio(str(entry.src), {"loop": true})
		if not stream is AudioStream:
			stream = asset_manager.load_audio(str(entry.src), {"loop": true})
			await RuntimeMicrotaskQueueScript.yield_turn()
		if not stream is AudioStream or my_request != int(ambient_request_seq.get(id, 0)):
			return
		if ambient_layers.has(id):
			return
		var player := _take_fading_player_for_stream(stream)
		if player == null:
			player = _new_audio_player("Ambient:%s" % id, stream)
		else:
			player.name = "Ambient:%s" % id
		player.stop()
		player.volume_db = _linear_db(_clamp01(base_volume * ambient_volume))
		player.play()
		ambient_layers[id] = player
		ambient_base_volume[id] = base_volume
	)


func remove_ambient(id: String, fade_ms: float = 500.0) -> void:
	requested_ambient_ids.erase(id)
	_bump_ambient_seq(id)
	_run_when_audio_allowed(func() -> void:
		var player: Variant = ambient_layers.get(id)
		if not player is AudioStreamPlayer:
			return
		_start_linear_fade(player, _player_linear_volume(player), 0.0, fade_ms)
		_schedule_cleanup(func() -> void:
			if ambient_layers.get(id) != player:
				_stop_and_free(player)
		, fade_ms)
		ambient_layers.erase(id)
		ambient_base_volume.erase(id)
	)


func clear_ambient(fade_ms: float = 500.0) -> void:
	requested_ambient_ids.clear()
	for key: String in ambient_request_seq.keys():
		_bump_ambient_seq(key)
	_run_when_audio_allowed(func() -> void:
		for id: String in ambient_layers:
			var player: AudioStreamPlayer = ambient_layers[id]
			_start_linear_fade(player, _player_linear_volume(player), 0.0, fade_ms)
			_schedule_cleanup(func() -> void:
				if ambient_layers.get(id) != player:
					_stop_and_free(player)
			, fade_ms)
		ambient_layers.clear()
		ambient_base_volume.clear()
	)


func play_sfx(id: String, volume: Variant = null) -> void:
	var capture_for_cutscene := cutscene_sfx_active
	_run_when_audio_allowed(func() -> void:
		var entry: Variant = config.sfx.get(id)
		if not entry is Dictionary:
			return
		var stream: Variant = sfx_cache.get(id)
		if not stream is AudioStream:
			stream = asset_manager.get_audio(str(entry.src), {"loop": false})
		if not stream is AudioStream:
			stream = asset_manager.load_audio(str(entry.src), {"loop": false})
			await RuntimeMicrotaskQueueScript.yield_turn()
		if not stream is AudioStream:
			return
		if not sfx_cache.has(id):
			sfx_cache[id] = stream
		var option_volume: Variant = float(volume) \
			if (volume is int or volume is float) and is_finite(float(volume)) else null
		var base_volume := float(option_volume) if option_volume != null else float(entry.get("volume", 1.0))
		var player := _create_sfx_player(id, stream, _clamp01(base_volume * sfx_volume))
		if capture_for_cutscene and cutscene_sfx_active:
			cutscene_sfx_sounds.push_back(player)
	)


func begin_cutscene_sfx_capture() -> void:
	cutscene_sfx_active = true
	cutscene_sfx_sounds = []


func end_cutscene_sfx_capture(stop_playing: bool) -> void:
	cutscene_sfx_active = false
	if stop_playing:
		for player: AudioStreamPlayer in cutscene_sfx_sounds:
			_release_sfx(player)
	cutscene_sfx_sounds = []


func get_current_bgm_id() -> Variant:
	return current_bgm_id


func get_active_ambient_ids() -> Array:
	return ambient_layers.keys()


func get_requested_bgm_id() -> Variant:
	return requested_bgm_id


func get_requested_ambient_ids() -> Array:
	return requested_ambient_ids.keys()


func get_debug_output_state() -> Dictionary:
	_advance_volume_fades()
	var current_volume := _player_linear_volume(current_bgm) if current_bgm != null else 0.0
	var ambient: Array = []
	for id: String in ambient_layers:
		var player: AudioStreamPlayer = ambient_layers[id]
		ambient.push_back({
			"id": id,
			"linearVolume": _player_linear_volume(player),
			"playing": player.playing,
		})
	ambient.sort_custom(func(left: Dictionary, right: Dictionary) -> bool: return str(left.id) < str(right.id))
	return {
		"audioUnblocked": audio_unblocked,
		"bgm": {
			"requestedId": requested_bgm_id,
			"currentId": current_bgm_id,
			"linearVolume": current_volume if is_finite(current_volume) else 0.0,
			"playing": current_bgm.playing if current_bgm != null else false,
		},
		"ambient": ambient,
		"activeSfxCount": sfx_cache.size(),
	}


func restore_audio_baseline(bgm_id: Variant, ambient_ids: Array) -> void:
	if bgm_id is String and not bgm_id.is_empty():
		play_bgm(bgm_id)
	else:
		stop_bgm()
	for id: String in ambient_ids:
		add_ambient(id)


func play_transient_sfx(id: String, options: Variant = null) -> Variant:
	var entry: Variant = config.sfx.get(id)
	if not entry is Dictionary:
		push_warning('AudioManager: unknown transient sfx "%s"' % id)
		return null
	var state := {"stopped": false, "player": null}
	var handle := RuntimeAudioPlaybackHandle.new(func() -> void:
		if state.stopped == true:
			return
		state.stopped = true
		var player: Variant = state.player
		if player is AudioStreamPlayer:
			_release_sfx(player)
		state.player = null
	)
	_run_when_audio_allowed(func() -> void:
		if state.stopped == true:
			return
		var stream: Variant = asset_manager.get_audio(str(entry.src), {"loop": false})
		if not stream is AudioStream:
			stream = asset_manager.load_audio(str(entry.src), {"loop": false})
			await RuntimeMicrotaskQueueScript.yield_turn()
		if not stream is AudioStream:
			state.stopped = true
			return
		if state.stopped == true:
			return
		var raw_volume: Variant = options.get("volume") if options is Dictionary else null
		var option_volume: Variant = float(raw_volume) \
			if (raw_volume is int or raw_volume is float) and is_finite(float(raw_volume)) else null
		var base_volume := float(option_volume) if option_volume != null else float(entry.get("volume", 1.0))
		var player := _create_sfx_player(id, stream, _clamp01(base_volume * sfx_volume))
		state.player = player
		var on_end: Variant = options.get("onEnd") if options is Dictionary else null
		player.finished.connect(func() -> void:
			if state.stopped == true:
				return
			state.stopped = true
			state.player = null
			if not handle._complete_naturally():
				return
			if on_end is Callable and on_end.is_valid():
				on_end.call()
		, CONNECT_ONE_SHOT)
	)
	return handle


func set_volume(channel: String, volume: float) -> void:
	var next := maxf(0.0, minf(1.0, volume))
	match channel:
		"bgm":
			bgm_volume = next
			if current_bgm != null:
				current_bgm.volume_db = _linear_db(_clamp01(current_bgm_base_volume * next))
		"sfx":
			sfx_volume = next
		"ambient":
			ambient_volume = next
			for id: String in ambient_layers:
				var player: AudioStreamPlayer = ambient_layers[id]
				player.volume_db = _linear_db(_clamp01(float(ambient_base_volume.get(id, 1.0)) * next))


func get_volume(channel: String) -> float:
	match channel:
		"bgm":
			return bgm_volume
		"sfx":
			return sfx_volume
		"ambient":
			return ambient_volume
	return 0.0


func apply_scene_audio(bgm_id: Variant = null, ambient_ids: Variant = null) -> void:
	if bgm_id is String and not bgm_id.is_empty():
		play_bgm(bgm_id)
	else:
		stop_bgm()
	clear_ambient()
	if ambient_ids is Array:
		for id: String in ambient_ids:
			add_ambient(id)


func serialize() -> Dictionary:
	return {
		"bgmVolume": bgm_volume,
		"sfxVolume": sfx_volume,
		"ambientVolume": ambient_volume,
	}


func deserialize(data: Dictionary) -> void:
	if data.has("bgmVolume"):
		bgm_volume = float(data.bgmVolume)
	if data.has("sfxVolume"):
		sfx_volume = float(data.sfxVolume)
	if data.has("ambientVolume"):
		ambient_volume = float(data.ambientVolume)


func _clamp01(value: float) -> float:
	return maxf(0.0, minf(1.0, value))


func _schedule_cleanup(callback: Callable, milliseconds: float) -> void:
	var timer := Timer.new()
	timer.one_shot = true
	timer.wait_time = maxf(milliseconds / 1000.0, 0.000001)
	add_child(timer)
	pending_timers[timer] = true
	timer.timeout.connect(func() -> void:
		pending_timers.erase(timer)
		callback.call()
		timer.queue_free()
	, CONNECT_ONE_SHOT)
	timer.start()


func get_scene_audio_refs(bgm_id: Variant = null, ambient_ids: Variant = null) -> Array:
	var refs: Array = []
	if bgm_id is String and config.bgm.get(bgm_id) is Dictionary:
		refs.push_back({
			"type": "audio",
			"path": config.bgm[bgm_id].src,
			"options": {"loop": true},
			"label": "BGM: %s" % bgm_id,
		})
	var ids: Array = ambient_ids if ambient_ids is Array else []
	for id: String in ids:
		var entry: Variant = config.ambient.get(id)
		if entry is Dictionary:
			refs.push_back({
				"type": "audio",
				"path": entry.src,
				"options": {"loop": true},
				"label": "环境音: %s" % id,
			})
	return refs


func _run_when_audio_allowed(callback: Callable) -> void:
	if audio_unblocked:
		callback.call()
		return
	pending_playback.push_back(callback)


func _play_audio_unlock_cue() -> void:
	var cue_id := str(
		config.systemSfx.get("audioUnlock", config.systemSfx.get("uiHover", config.systemSfx.get("uiConfirm", "")))
	).strip_edges()
	var entry: Variant = config.sfx.get(cue_id) if not cue_id.is_empty() else null
	if not entry is Dictionary:
		return
	var stream: Variant = asset_manager.load_audio(str(entry.src), {"loop": false})
	if not stream is AudioStream:
		return
	var base_volume := float(entry.get("volume", 1.0))
	var cue := _new_audio_player("AudioUnlockCue", stream)
	cue.volume_db = _linear_db(maxf(0.0, minf(0.18, base_volume * sfx_volume * 0.35)))
	var cleanup := func() -> void:
		if cue != null and is_instance_valid(cue):
			_stop_and_free(cue)
	cue.finished.connect(cleanup, CONNECT_ONE_SHOT)
	cue.play()
	_schedule_cleanup(cleanup, 3000.0)


func _flush_pending_playback() -> void:
	audio_unblocked = true
	audio_unlocking = false
	_play_audio_unlock_cue()
	var queued := pending_playback.duplicate()
	pending_playback.clear()
	for callback: Callable in queued:
		callback.call()


func _on_first_gesture(event: Variant = null) -> void:
	if audio_unblocked or audio_unlocking:
		return
	var should_reserve_gesture_for_audio := not pending_playback.is_empty()
	if should_reserve_gesture_for_audio and event != null:
		if event.has_method("set_input_as_handled"):
			event.set_input_as_handled()
	audio_unlocking = true
	_remove_audio_gesture_listeners()
	_flush_pending_playback()


func _install_audio_gesture_gate() -> void:
	if gesture_listeners_installed:
		return
	if _page_has_user_activation():
		audio_unblocked = true
		audio_unlocking = false
		return
	gesture_listeners_installed = true


func _page_has_user_activation() -> bool:
	# Native Godot has no browser autoplay gate; entering the tree is the native
	# platform equivalent of the already-activated page fast path.
	return true


func _remove_audio_gesture_listeners() -> void:
	if not gesture_listeners_installed:
		return
	gesture_listeners_installed = false


func _play_system_sfx(key: String) -> void:
	var id := str(config.systemSfx.get(key, ""))
	if id.is_empty():
		return
	play_sfx(id)


func _on_sfx(event: String, callback: Callable) -> void:
	event_bus.on(event, callback)
	sfx_event_listeners.push_back({"event": event, "callback": callback})


func _install_system_sfx_listeners() -> void:
	_on_sfx("quest:accepted", func(payload: Variant = null) -> void:
		if payload is Dictionary and payload.get("restored") == true:
			return
		_play_system_sfx("questAccepted")
	)
	_on_sfx("quest:completed", func(_payload: Variant = null) -> void: _play_system_sfx("questCompleted"))
	_on_sfx("dialogue:start", func(_payload: Variant = null) -> void: _play_system_sfx("dialogueStart"))
	_on_sfx("dialogue:end", func(payload: Variant = null) -> void:
		if payload is Dictionary and (payload.get("willContinue") == true or payload.get("nestedInGraph") == true):
			return
		_play_system_sfx("dialogueEnd")
	)
	_on_sfx("dialogue:advanceInput", func(_payload: Variant = null) -> void: _play_system_sfx("dialogueAdvance"))
	_on_sfx("dialogue:choiceSelected:log", func(_payload: Variant = null) -> void: _play_system_sfx("dialogueChoice"))
	_on_sfx("ui:hover", func(_payload: Variant = null) -> void: _play_system_sfx("uiHover"))
	_on_sfx("ui:confirm", func(_payload: Variant = null) -> void: _play_system_sfx("uiConfirm"))
	_on_sfx("ui:cancel", func(_payload: Variant = null) -> void: _play_system_sfx("uiCancel"))
	_on_sfx("ui:panelOpen", func(_payload: Variant = null) -> void: _play_system_sfx("uiPanelOpen"))
	_on_sfx("ui:panelClose", func(_payload: Variant = null) -> void: _play_system_sfx("uiPanelClose"))
	_on_sfx("notification:show", func(payload: Variant = null) -> void:
		var type := str(payload.get("type", "")) if payload is Dictionary else ""
		if type == "warning":
			_play_system_sfx("uiWarning")
			return
		if type in ["quest", "rule", "archive"]:
			return
		_play_system_sfx("uiNotification")
	)
	_on_sfx("hotspot:interact", func(_payload: Variant = null) -> void: _play_system_sfx("hotspotInteract"))
	_on_sfx("scene:transition", func(_payload: Variant = null) -> void:
		if Time.get_ticks_msec() - last_map_travel_sfx_at < 500:
			return
		_play_system_sfx("sceneTransition")
	)
	_on_sfx("map:travel", func(_payload: Variant = null) -> void:
		last_map_travel_sfx_at = Time.get_ticks_msec()
		_play_system_sfx("mapTravel")
	)
	_on_sfx("item:acquired", func(_payload: Variant = null) -> void: _play_system_sfx("itemAcquired"))
	_on_sfx("item:consumed", func(_payload: Variant = null) -> void: _play_system_sfx("itemConsumed"))
	_on_sfx("inventory:full", func(_payload: Variant = null) -> void: _play_system_sfx("inventoryFull"))
	_on_sfx("currency:changed", func(payload: Variant = null) -> void:
		var amount := float(payload.get("amount", 0.0)) if payload is Dictionary else 0.0
		if amount > 0.0:
			_play_system_sfx("coinGain")
		if amount < 0.0:
			_play_system_sfx("coinSpend")
	)
	_on_sfx("rule:fragment", func(_payload: Variant = null) -> void: _play_system_sfx("ruleFragment"))
	_on_sfx("rule:layer", func(payload: Variant = null) -> void:
		if payload is Dictionary and payload.get("source") == "fragment":
			return
		_play_system_sfx("ruleLayer")
	)
	_on_sfx("rule:acquired", func(_payload: Variant = null) -> void: _play_system_sfx("ruleAcquired"))
	_on_sfx("ruleUse:apply", func(_payload: Variant = null) -> void: _play_system_sfx("ruleUseApply"))
	_on_sfx("zone:ruleAvailable", func(_payload: Variant = null) -> void: _play_system_sfx("zoneRuleAvailable"))
	_on_sfx("zone:ruleUnavailable", func(_payload: Variant = null) -> void: _play_system_sfx("zoneRuleUnavailable"))
	_on_sfx("archive:updated", func(_payload: Variant = null) -> void: _play_system_sfx("archiveUpdated"))
	_on_sfx("encounter:start", func(_payload: Variant = null) -> void: _play_system_sfx("encounterStart"))
	_on_sfx("encounter:choiceSelected", func(_payload: Variant = null) -> void: _play_system_sfx("encounterChoice"))
	_on_sfx("encounter:result", func(_payload: Variant = null) -> void: _play_system_sfx("encounterResult"))
	_on_sfx("cutscene:start", func(_payload: Variant = null) -> void: _play_system_sfx("cutsceneStart"))
	_on_sfx("cutscene:end", func(_payload: Variant = null) -> void: _play_system_sfx("cutsceneEnd"))
	_on_sfx("day:start", func(_payload: Variant = null) -> void: _play_system_sfx("dayStart"))
	_on_sfx("day:end", func(_payload: Variant = null) -> void: _play_system_sfx("dayEnd"))
	_on_sfx("shop:opened", func(_payload: Variant = null) -> void: _play_system_sfx("shopOpen"))
	_on_sfx("shop:closed", func(_payload: Variant = null) -> void: _play_system_sfx("shopClose"))
	_on_sfx("minigame:sugarWheelResult", func(_payload: Variant = null) -> void: _play_system_sfx("minigameResult"))
	_on_sfx("document:revealed", func(_payload: Variant = null) -> void: _play_system_sfx("documentReveal"))


func destroy() -> void:
	bgm_request_seq += 1
	for key: String in ambient_request_seq.keys():
		_bump_ambient_seq(key)
	for entry: Dictionary in sfx_event_listeners:
		event_bus.off(str(entry.event), entry.callback)
	sfx_event_listeners = []
	_remove_audio_gesture_listeners()
	audio_unlocking = false
	pending_playback = []
	if current_bgm != null:
		var bgm := current_bgm
		current_bgm = null
		current_bgm_id = null
		_stop_and_free(bgm)
	for timer: Variant in pending_timers.keys():
		if timer is Timer and is_instance_valid(timer):
			timer.stop()
			timer.free()
	pending_timers.clear()
	for player: AudioStreamPlayer in ambient_layers.values():
		_stop_and_free(player)
	ambient_layers.clear()
	ambient_base_volume.clear()
	requested_bgm_id = null
	requested_ambient_ids.clear()
	current_bgm_base_volume = 1.0
	for player: AudioStreamPlayer in active_sfx.duplicate():
		_release_sfx(player)
	sfx_cache.clear()
	cutscene_sfx_active = false
	cutscene_sfx_sounds = []
	_fading_players.clear()
	_volume_fades.clear()


# ---- Godot engine/test adapters (no independent game-domain decisions) ----

func has_audio(kind: String, id: String) -> bool:
	return config.get(kind) is Dictionary and config[kind].get(id) is Dictionary


func debug_active_sfx_count() -> int:
	return active_sfx.size()


func stop_all_playback() -> void:
	stop_bgm(0.0)
	clear_ambient(0.0)
	# This adapter is the native equivalent of synchronously stopping every Howl.
	# The two direct calls above schedule zero-delay source cleanups; cancel those
	# engine Timers before freeing their captured AudioStreamPlayers.
	for timer: Variant in pending_timers.keys():
		if timer is Timer and is_instance_valid(timer):
			timer.stop()
			timer.queue_free()
	pending_timers.clear()
	for player: AudioStreamPlayer in _fading_players.values().duplicate():
		if is_instance_valid(player):
			_stop_and_free(player)
	_fading_players.clear()
	_volume_fades.clear()
	for player: AudioStreamPlayer in active_sfx.duplicate():
		_release_sfx(player)
	cutscene_sfx_active = false
	cutscene_sfx_sounds = []


func _resolve_asset_path(path: String) -> String:
	return path


func _new_audio_player(name_value: String, stream: AudioStream) -> AudioStreamPlayer:
	var player := AudioStreamPlayer.new()
	player.name = name_value
	player.stream = stream
	add_child(player)
	return player


func _create_sfx_player(id: String, stream: AudioStream, linear_volume: float) -> AudioStreamPlayer:
	var player := _new_audio_player("Sfx:%s" % id, stream)
	player.volume_db = _linear_db(linear_volume)
	active_sfx.push_back(player)
	player.finished.connect(Callable(self, "_on_sfx_finished").bind(player.get_instance_id()), CONNECT_ONE_SHOT)
	# Game.destroy() tears systems down while their browser audio objects are still
	# usable.  Godot can enter the same ordered destroy loop from _exit_tree(), where
	# the AudioStreamPlayer already has no scene-tree playback server; that last
	# teardown-only SFX is immediately reclaimed by AudioManager.destroy() anyway.
	if player.is_inside_tree():
		player.play()
	return player


func _release_sfx(player: AudioStreamPlayer) -> void:
	if player == null or not is_instance_valid(player):
		return
	active_sfx.erase(player)
	cutscene_sfx_sounds.erase(player)
	_stop_and_free(player)


func _on_sfx_finished(instance_id: int) -> void:
	call_deferred("_release_sfx_by_id", instance_id)


func _release_sfx_by_id(instance_id: int) -> void:
	for player: AudioStreamPlayer in active_sfx:
		if player.get_instance_id() == instance_id:
			_release_sfx(player)
			return


func _linear_db(value: float) -> float:
	return linear_to_db(clampf(value, 0.0001, 1.0))


func _player_linear_volume(player: AudioStreamPlayer) -> float:
	return db_to_linear(player.volume_db)


func _stop_and_free(player: AudioStreamPlayer) -> void:
	if player == null or not is_instance_valid(player):
		return
	var instance_id := player.get_instance_id()
	_volume_fades.erase(instance_id)
	_fading_players.erase(instance_id)
	# Howl.stop() leaves a reusable object, while Godot releases the player node.
	# Remove every live map alias before queue_free so the translated Map never
	# exposes a previously freed engine object on the next scene-audio pass.
	for id: Variant in ambient_layers.keys():
		if ambient_layers.get(id) == player:
			ambient_layers.erase(id)
			ambient_base_volume.erase(id)
	if current_bgm == player:
		current_bgm = null
		current_bgm_id = null
	active_sfx.erase(player)
	cutscene_sfx_sounds.erase(player)
	player.stop()
	player.stream = null
	if not player.is_queued_for_deletion():
		player.queue_free()


func _cancel_volume_fade(player: AudioStreamPlayer) -> void:
	if player != null and is_instance_valid(player):
		_volume_fades.erase(player.get_instance_id())
		_fading_players.erase(player.get_instance_id())


func _start_linear_fade(
	player: AudioStreamPlayer,
	from: float,
	to: float,
	duration_ms: float,
) -> void:
	if player == null or not is_instance_valid(player):
		return
	var instance_id := player.get_instance_id()
	if duration_ms <= 0.0:
		player.volume_db = _linear_db(to)
		_volume_fades.erase(instance_id)
		return
	_fading_players[instance_id] = player
	_volume_fades[instance_id] = {
		"player": player,
		"from": clampf(from, 0.0, 1.0),
		"to": clampf(to, 0.0, 1.0),
		"startedUs": Time.get_ticks_usec(),
		"durationUs": maxf(1.0, duration_ms * 1000.0),
	}
	player.volume_db = _linear_db(from)


func _process(_delta: float) -> void:
	_advance_volume_fades()


func _advance_volume_fades() -> void:
	var now := Time.get_ticks_usec()
	for raw_id: Variant in _volume_fades.keys().duplicate():
		var record: Variant = _volume_fades.get(raw_id)
		if not record is Dictionary:
			_volume_fades.erase(raw_id)
			continue
		var player: Variant = record.player
		if not player is AudioStreamPlayer or not is_instance_valid(player):
			_volume_fades.erase(raw_id)
			_fading_players.erase(raw_id)
			continue
		var ratio := clampf(float(now - int(record.startedUs)) / float(record.durationUs), 0.0, 1.0)
		player.volume_db = _linear_db(lerpf(float(record.from), float(record.to), ratio))
		if ratio >= 1.0:
			_volume_fades.erase(raw_id)
			_fading_players.erase(raw_id)


func _take_fading_player_for_stream(stream: AudioStream) -> AudioStreamPlayer:
	for player: AudioStreamPlayer in _fading_players.values().duplicate():
		if is_instance_valid(player) and player.stream == stream:
			_cancel_volume_fade(player)
			return player
	return null
