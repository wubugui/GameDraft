class_name RuntimeAudioManager
extends RuntimeSystem

const CONFIG_URL := "/assets/data/audio_config.json"

var event_bus: RuntimeEventBus
var asset_manager: RuntimeAssetManager
var config: Dictionary = {"bgm": {}, "ambient": {}, "sfx": {}, "systemSfx": {}}
var current_bgm_id: Variant = null
var requested_bgm_id: Variant = null
var current_bgm: AudioStreamPlayer
var ambient_layers: Dictionary = {}
var requested_ambient_ids: Dictionary = {}
var ambient_base_volumes: Dictionary = {}
var active_sfx: Array[AudioStreamPlayer] = []
var _capturing_cutscene_sfx := false
var _captured_cutscene_sfx: Array[AudioStreamPlayer] = []
var bgm_volume := 0.6
var ambient_volume := 0.4
var sfx_volume := 0.8
var current_bgm_base_volume := 1.0
var _event_listeners: Array[Dictionary] = []
var _last_map_travel_sfx_at := 0
var _fading_players: Dictionary = {}
var _volume_fades: Dictionary = {}


func _init(events: RuntimeEventBus) -> void:
	event_bus = events


func init(ctx: Dictionary) -> void:
	asset_manager = ctx.get("assetManager")
	_install_system_sfx_listeners()


func load_config() -> bool:
	var raw: Variant = asset_manager.load_json(CONFIG_URL) if asset_manager != null else null
	if not raw is Dictionary:
		return false
	for section: String in ["bgm", "ambient", "sfx", "systemSfx"]:
		config[section] = raw.get(section, {}).duplicate(true) if raw.get(section) is Dictionary else {}
	return true


func has_audio(kind: String, id: String) -> bool:
	return config.get(kind) is Dictionary and config[kind].get(id) is Dictionary


func play_bgm(id: String, fade_ms: float = 1000.0) -> bool:
	requested_bgm_id = id
	if current_bgm_id == id and current_bgm != null:
		return true
	var stream: Variant = _load_entry("bgm", id, true)
	if not stream is AudioStream:
		return false
	var old := current_bgm
	current_bgm = AudioStreamPlayer.new()
	current_bgm.name = "Bgm:%s" % id
	current_bgm.stream = stream
	current_bgm_base_volume = _entry_volume("bgm", id)
	var target_linear := clampf(current_bgm_base_volume * bgm_volume, 0.0, 1.0)
	current_bgm.volume_db = _linear_db(0.0 if fade_ms > 0 else target_linear)
	add_child(current_bgm)
	current_bgm.play()
	current_bgm_id = id
	if old != null: _fade_and_free(old, fade_ms)
	if fade_ms > 0: _tween_linear_volume(current_bgm, 0.0, target_linear, fade_ms)
	return true


func stop_bgm(fade_ms: float = 1000.0) -> void:
	requested_bgm_id = null
	if current_bgm != null: _fade_and_free(current_bgm, fade_ms)
	current_bgm = null
	current_bgm_id = null
	current_bgm_base_volume = 1.0


func add_ambient(id: String, volume: Variant = null) -> bool:
	requested_ambient_ids[id] = true
	if ambient_layers.has(id):
		return true
	var stream: Variant = _load_entry("ambient", id, true)
	if not stream is AudioStream:
		return false
	var player := AudioStreamPlayer.new()
	player.name = "Ambient:%s" % id
	player.stream = stream
	var base := float(volume) if volume is int or volume is float else _entry_volume("ambient", id)
	player.volume_db = _linear_db(base * ambient_volume)
	add_child(player)
	player.play()
	ambient_layers[id] = player
	ambient_base_volumes[id] = base
	return true


func remove_ambient(id: String, fade_ms: float = 500.0) -> void:
	requested_ambient_ids.erase(id)
	var player: Variant = ambient_layers.get(id)
	if player is AudioStreamPlayer: _fade_and_free(player, fade_ms)
	ambient_layers.erase(id)
	ambient_base_volumes.erase(id)


func clear_ambient(fade_ms: float = 500.0) -> void:
	requested_ambient_ids.clear()
	for id: String in ambient_layers.keys().duplicate():
		remove_ambient(id, fade_ms)


func play_sfx(id: String, volume: Variant = null) -> bool:
	return _create_sfx_player(id, volume) != null


func play_transient_sfx(id: String, volume: Variant = null) -> Variant:
	return _create_sfx_player(id, volume)


func stop_transient_sfx(player: Variant) -> void:
	if player is AudioStreamPlayer:
		_release_sfx(player)


func _create_sfx_player(id: String, volume: Variant = null) -> Variant:
	var stream: Variant = _load_entry("sfx", id, false)
	if not stream is AudioStream:
		return null
	var player := AudioStreamPlayer.new()
	player.name = "Sfx:%s" % id
	player.stream = stream
	var base := float(volume) if volume is int or volume is float else _entry_volume("sfx", id)
	player.volume_db = _linear_db(base * sfx_volume)
	add_child(player)
	active_sfx.push_back(player)
	player.finished.connect(Callable(self, "_on_sfx_finished").bind(player.get_instance_id()), CONNECT_ONE_SHOT)
	player.play()
	if _capturing_cutscene_sfx:
		_captured_cutscene_sfx.push_back(player)
	return player


func begin_cutscene_sfx_capture() -> void:
	_capturing_cutscene_sfx = true
	_captured_cutscene_sfx.clear()


func end_cutscene_sfx_capture(stop_playing: bool) -> void:
	_capturing_cutscene_sfx = false
	if stop_playing:
		for player: AudioStreamPlayer in _captured_cutscene_sfx.duplicate():
			_release_sfx(player)
	_captured_cutscene_sfx.clear()


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
	var ambient: Array = []
	for id: String in ambient_layers:
		var layer: AudioStreamPlayer = ambient_layers[id]
		ambient.push_back({"id": id, "linearVolume": db_to_linear(layer.volume_db), "playing": layer.playing})
	ambient.sort_custom(func(left: Dictionary, right: Dictionary) -> bool: return str(left.id) < str(right.id))
	return {
		"audioUnblocked": true,
		"bgm": {
			"requestedId": requested_bgm_id,
			"currentId": current_bgm_id,
			"linearVolume": db_to_linear(current_bgm.volume_db) if current_bgm != null else 0.0,
			"playing": current_bgm.playing if current_bgm != null else false,
		},
		"ambient": ambient,
		"activeSfxCount": active_sfx.size(),
	}


func restore_audio_baseline(bgm_id: Variant, ambient_ids: Array) -> void:
	if bgm_id is String and not bgm_id.is_empty():
		play_bgm(bgm_id)
	else:
		stop_bgm()
	for id: Variant in ambient_ids:
		add_ambient(str(id))


func set_volume(channel: String, value: float) -> void:
	var next := clampf(value, 0.0, 1.0)
	match channel:
		"bgm":
			bgm_volume = next
			if current_bgm != null: current_bgm.volume_db = _linear_db(current_bgm_base_volume * next)
		"sfx": sfx_volume = next
		"ambient":
			ambient_volume = next
			for id: String in ambient_layers:
				var player: AudioStreamPlayer = ambient_layers[id]; player.volume_db = _linear_db(float(ambient_base_volumes.get(id, 1.0)) * next)


func get_volume(channel: String) -> float:
	match channel:
		"bgm": return bgm_volume
		"sfx": return sfx_volume
		"ambient": return ambient_volume
	return 0.0


func apply_scene_audio(bgm_id: Variant = null, ambient_ids: Variant = null) -> void:
	if bgm_id is String and not bgm_id.strip_edges().is_empty(): play_bgm(bgm_id)
	else: stop_bgm()
	clear_ambient()
	if ambient_ids is Array:
		for id: Variant in ambient_ids: add_ambient(str(id))


func get_scene_audio_refs(bgm_id: Variant = null, ambient_ids: Variant = null) -> Array:
	var refs: Array = []
	if bgm_id is String and has_audio("bgm", bgm_id): refs.push_back({"type": "audio", "path": config.bgm[bgm_id].src, "options": {"loop": true}, "label": "BGM: %s" % bgm_id})
	if ambient_ids is Array:
		for id: Variant in ambient_ids:
			if has_audio("ambient", str(id)): refs.push_back({"type": "audio", "path": config.ambient[str(id)].src, "options": {"loop": true}, "label": "环境音: %s" % id})
	return refs


func debug_active_sfx_count() -> int:
	return active_sfx.size()


func serialize() -> Dictionary:
	return {"bgmVolume": bgm_volume, "sfxVolume": sfx_volume, "ambientVolume": ambient_volume}


func deserialize(data: Dictionary) -> void:
	if data.get("bgmVolume") is int or data.get("bgmVolume") is float: set_volume("bgm", float(data.bgmVolume))
	if data.get("sfxVolume") is int or data.get("sfxVolume") is float: set_volume("sfx", float(data.sfxVolume))
	if data.get("ambientVolume") is int or data.get("ambientVolume") is float: set_volume("ambient", float(data.ambientVolume))


func stop_all_playback() -> void:
	stop_bgm(0)
	clear_ambient(0)
	for player: AudioStreamPlayer in _fading_players.values().duplicate():
		if is_instance_valid(player): _stop_and_free(player)
	_fading_players.clear()
	_volume_fades.clear()
	for player: AudioStreamPlayer in active_sfx.duplicate():
		_release_sfx(player)
	_capturing_cutscene_sfx = false
	_captured_cutscene_sfx.clear()


func destroy() -> void:
	stop_all_playback()
	for entry: Dictionary in _event_listeners: event_bus.off(str(entry.event), entry.callback)
	_event_listeners.clear()
	config = {"bgm": {}, "ambient": {}, "sfx": {}, "systemSfx": {}}
	requested_bgm_id = null
	requested_ambient_ids.clear()
	asset_manager = null


func _load_entry(kind: String, id: String, loop: bool) -> Variant:
	var section: Variant = config.get(kind)
	var entry: Variant = section.get(id) if section is Dictionary else null
	if not entry is Dictionary or str(entry.get("src", "")).is_empty():
		return null
	return asset_manager.load_audio(str(entry.src), {"loop": loop})


func _entry_volume(kind: String, id: String) -> float:
	var section: Variant = config.get(kind)
	var entry: Variant = section.get(id) if section is Dictionary else null
	return float(entry.get("volume", 1.0)) if entry is Dictionary else 1.0


func _linear_db(value: float) -> float:
	return linear_to_db(clampf(value, 0.0001, 1.0))


func _release_sfx(player: AudioStreamPlayer) -> void:
	if player == null or not is_instance_valid(player):
		return
	active_sfx.erase(player)
	_captured_cutscene_sfx.erase(player)
	_stop_and_free(player)


func _on_sfx_finished(instance_id: int) -> void:
	call_deferred("_release_sfx_by_id", instance_id)


func _release_sfx_by_id(instance_id: int) -> void:
	for player: AudioStreamPlayer in active_sfx:
		if player.get_instance_id() == instance_id:
			_release_sfx(player)
			return


func _stop_and_free(player: AudioStreamPlayer) -> void:
	_volume_fades.erase(player.get_instance_id())
	player.stop()
	player.stream = null
	if player.get_parent() != null:
		player.get_parent().remove_child(player)
	player.free()


func _fade_and_free(player: AudioStreamPlayer, duration_ms: float) -> void:
	if duration_ms <= 0:
		_stop_and_free(player); return
	var instance_id := player.get_instance_id(); _fading_players[instance_id] = player
	_start_linear_fade(player, db_to_linear(player.volume_db), 0.0, duration_ms, true)


func _tween_linear_volume(player: AudioStreamPlayer, from: float, to: float, duration_ms: float) -> void:
	_start_linear_fade(player, from, to, duration_ms, false)


func _start_linear_fade(player: AudioStreamPlayer, from: float, to: float, duration_ms: float, stop_on_complete: bool) -> void:
	if player == null or not is_instance_valid(player): return
	var instance_id := player.get_instance_id()
	_volume_fades[instance_id] = {
		"player": player,
		"from": clampf(from, 0.0, 1.0),
		"to": clampf(to, 0.0, 1.0),
		"startedUs": Time.get_ticks_usec(),
		"durationUs": maxf(1.0, duration_ms * 1000.0),
		"stopOnComplete": stop_on_complete,
	}
	_set_linear_volume_by_id(instance_id, from)


func _process(_delta: float) -> void:
	_advance_volume_fades()


func _advance_volume_fades() -> void:
	var now := Time.get_ticks_usec()
	for raw_id: Variant in _volume_fades.keys().duplicate():
		var record: Variant = _volume_fades.get(raw_id)
		if not record is Dictionary: _volume_fades.erase(raw_id); continue
		var player: Variant = record.get("player")
		if not player is AudioStreamPlayer or not is_instance_valid(player):
			_volume_fades.erase(raw_id); _fading_players.erase(raw_id); continue
		var ratio := clampf(float(now - int(record.startedUs)) / float(record.durationUs), 0.0, 1.0)
		_set_linear_volume_by_id(int(raw_id), lerpf(float(record.from), float(record.to), ratio))
		if ratio >= 1.0:
			_volume_fades.erase(raw_id)
			if record.stopOnComplete == true: _stop_player_by_id(int(raw_id))


func _set_linear_volume_by_id(instance_id: int, value: float) -> void:
	var player: Variant = instance_from_id(instance_id)
	if player is AudioStreamPlayer: player.volume_db = _linear_db(value)


func _stop_player_by_id(instance_id: int) -> void:
	var player: Variant = instance_from_id(instance_id)
	if player is AudioStreamPlayer: _stop_and_free(player)
	_fading_players.erase(instance_id)


func _listen(event: String, callback: Callable) -> void:
	event_bus.on(event, callback); _event_listeners.push_back({"event": event, "callback": callback})


func _system_sfx(key: String) -> void:
	var id := str(config.systemSfx.get(key, "")); if not id.is_empty(): play_sfx(id)


func _install_system_sfx_listeners() -> void:
	_listen("quest:accepted", func(payload: Variant) -> void: if not (payload is Dictionary and payload.get("restored") == true): _system_sfx("questAccepted"))
	_listen("quest:completed", func(_payload: Variant) -> void: _system_sfx("questCompleted"))
	_listen("dialogue:start", func(_payload: Variant) -> void: _system_sfx("dialogueStart"))
	_listen("dialogue:end", func(payload: Variant) -> void: if not (payload is Dictionary and (payload.get("willContinue") == true or payload.get("nestedInGraph") == true)): _system_sfx("dialogueEnd"))
	for pair: Array in [["dialogue:advanceInput", "dialogueAdvance"], ["dialogue:choiceSelected:log", "dialogueChoice"], ["ui:hover", "uiHover"], ["ui:confirm", "uiConfirm"], ["ui:cancel", "uiCancel"], ["ui:panelOpen", "uiPanelOpen"], ["ui:panelClose", "uiPanelClose"], ["hotspot:interact", "hotspotInteract"], ["item:acquired", "itemAcquired"], ["item:consumed", "itemConsumed"], ["inventory:full", "inventoryFull"], ["rule:fragment", "ruleFragment"], ["rule:acquired", "ruleAcquired"], ["ruleUse:apply", "ruleUseApply"], ["zone:ruleAvailable", "zoneRuleAvailable"], ["zone:ruleUnavailable", "zoneRuleUnavailable"], ["archive:updated", "archiveUpdated"], ["encounter:start", "encounterStart"], ["encounter:choiceSelected", "encounterChoice"], ["encounter:result", "encounterResult"], ["cutscene:start", "cutsceneStart"], ["cutscene:end", "cutsceneEnd"], ["day:start", "dayStart"], ["day:end", "dayEnd"], ["shop:opened", "shopOpen"], ["shop:closed", "shopClose"], ["minigame:sugarWheelResult", "minigameResult"], ["document:revealed", "documentReveal"]]:
		var event: String = pair[0]; var key: String = pair[1]; _listen(event, func(_payload: Variant) -> void: _system_sfx(key))
	_listen("notification:show", func(payload: Variant) -> void:
		var type := str(payload.get("type", "")) if payload is Dictionary else ""
		if type == "warning": _system_sfx("uiWarning")
		elif type not in ["quest", "rule", "archive"]: _system_sfx("uiNotification")
	)
	_listen("currency:changed", func(payload: Variant) -> void:
		var amount := float(payload.get("amount", 0)) if payload is Dictionary else 0.0
		if amount > 0: _system_sfx("coinGain")
		elif amount < 0: _system_sfx("coinSpend")
	)
	_listen("rule:layer", func(payload: Variant) -> void: if not (payload is Dictionary and payload.get("source") == "fragment"): _system_sfx("ruleLayer"))
	_listen("map:travel", func(_payload: Variant) -> void: _last_map_travel_sfx_at = Time.get_ticks_msec(); _system_sfx("mapTravel"))
	_listen("scene:transition", func(_payload: Variant) -> void: if Time.get_ticks_msec() - _last_map_travel_sfx_at >= 500: _system_sfx("sceneTransition"))
