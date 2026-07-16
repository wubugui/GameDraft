extends Node


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(
		{},
		RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository),
	)
	var events := RuntimeEventBus.new()
	var audio := RuntimeAudioManager.new(events)
	add_child(audio)
	audio.init({"assetManager": assets})
	await audio.load_config()
	assert(audio.loaded and audio.audio_unblocked and EventBusProbe.listener_count(events) >= 30)
	assert(audio.config.bgm.has("bgm_placeholder_low_tension"))
	assert(audio.serialize() == {"bgmVolume": 0.6, "sfxVolume": 0.8, "ambientVolume": 0.4})

	# Channel clamping and source deserialize semantics: deserialize assigns the
	# three stored values directly and does not remix already-playing instances.
	audio.set_volume("bgm", 2.0)
	audio.set_volume("sfx", -1.0)
	audio.set_volume("ambient", 0.25)
	assert(audio.get_volume("bgm") == 1.0 and audio.get_volume("sfx") == 0.0 and audio.get_volume("ambient") == 0.25)
	audio.deserialize({"bgmVolume": 0.5, "sfxVolume": 0.75, "ambientVolume": 0.2})
	assert(audio.serialize() == {"bgmVolume": 0.5, "sfxVolume": 0.75, "ambientVolume": 0.2})

	# BGM intent commits only after the source-shaped async load boundary; same
	# id is idempotent and a replacement fades old/new players concurrently.
	audio.config.bgm.bgm_placeholder_low_tension.volume = 0.5
	audio.play_bgm("bgm_placeholder_low_tension", 0.0)
	await _settle_turns()
	assert(audio.current_bgm != null and audio.get_current_bgm_id() == "bgm_placeholder_low_tension")
	assert(is_equal_approx(audio.get_debug_output_state().bgm.linearVolume, 0.25))
	var bgm_instance := audio.current_bgm.get_instance_id()
	audio.play_bgm("bgm_placeholder_low_tension", 0.0)
	assert(audio.current_bgm.get_instance_id() == bgm_instance)
	audio.play_bgm("bgm_placeholder_dark_shadows", 1000.0)
	await _settle_turns()
	var fading_in: AudioStreamPlayer = audio.current_bgm
	var fading_out: AudioStreamPlayer = instance_from_id(bgm_instance)
	OS.delay_msec(250)
	audio.get_debug_output_state()
	var fade_in_linear := db_to_linear(fading_in.volume_db)
	var fade_out_linear := db_to_linear(fading_out.volume_db)
	assert(fade_in_linear > 0.08 and fade_in_linear < 0.18)
	assert(fade_out_linear > 0.17 and fade_out_linear < 0.23)

	# Request epochs reject queued/stale BGM and ambient work before it can revive
	# audio after stop/remove, while requested intent updates synchronously.
	audio.stop_all_playback()
	await _settle_turns()
	audio.audio_unblocked = false
	var bgm_seq_before := audio.bgm_request_seq
	audio.play_bgm("bgm_placeholder_low_tension", 0.0)
	audio.stop_bgm(0.0)
	assert(audio.requested_bgm_id == null and audio.bgm_request_seq == bgm_seq_before + 2)
	assert(audio.pending_playback.size() == 2)
	audio._flush_pending_playback()
	await _settle_turns()
	assert(audio.current_bgm == null and audio.current_bgm_id == null)
	audio.audio_unblocked = false
	audio.add_ambient("teahouse_roomtone")
	audio.remove_ambient("teahouse_roomtone", 0.0)
	assert(not audio.requested_ambient_ids.has("teahouse_roomtone") and audio.pending_playback.size() == 2)
	audio._flush_pending_playback()
	await _settle_turns()
	assert(not audio.ambient_layers.has("teahouse_roomtone"))

	# Ambient base volume is preserved under global remix. deserialize changes the
	# stored preference only, matching source (no implicit setVolume side effect).
	audio.add_ambient("teahouse_roomtone", 0.5)
	await _settle_turns()
	assert(audio.get_active_ambient_ids() == ["teahouse_roomtone"])
	audio.set_volume("ambient", 0.2)
	var roomtone: AudioStreamPlayer = audio.ambient_layers.teahouse_roomtone
	assert(is_equal_approx(db_to_linear(roomtone.volume_db), 0.1))
	audio.deserialize({"ambientVolume": 0.9})
	assert(audio.get_volume("ambient") == 0.9 and is_equal_approx(db_to_linear(roomtone.volume_db), 0.1))
	audio.set_volume("ambient", 0.2)
	var refs := audio.get_scene_audio_refs("bgm_placeholder_low_tension", ["teahouse_roomtone", "missing"])
	assert(refs.size() == 2 and refs[0].type == "audio" and refs[1].options.loop == true)

	# playSfx captures the synchronous scope intent but only registers after load
	# if the capture is still active. Interrupt stops; natural completion retains.
	audio.begin_cutscene_sfx_capture()
	audio.play_sfx("sfx_gavel_rap")
	await _settle_turns()
	assert(audio.debug_active_sfx_count() == 1 and audio.cutscene_sfx_sounds.size() == 1)
	audio.end_cutscene_sfx_capture(true)
	assert(audio.debug_active_sfx_count() == 0)
	audio.begin_cutscene_sfx_capture()
	audio.play_sfx("sfx_gavel_rap")
	await _settle_turns()
	audio.end_cutscene_sfx_capture(false)
	assert(audio.debug_active_sfx_count() == 1 and audio.cutscene_sfx_sounds.is_empty())
	audio.stop_all_playback()
	assert(audio.debug_active_sfx_count() == 0)

	# Transient handle is returned immediately, stops only its player, excludes
	# itself from cutscene capture, and calls onEnd once only on natural finish.
	var transient: Variant = audio.play_transient_sfx("voice_001", {"volume": 0.6})
	assert(transient is RuntimeAudioPlaybackHandle)
	await _settle_turns()
	assert(audio.debug_active_sfx_count() == 1)
	transient.stop()
	assert(transient.is_stopped() and audio.debug_active_sfx_count() == 0)
	var natural_state := {"handle": null, "ended": 0}
	var natural_handle: Variant = audio.play_transient_sfx("voice_001", {
		"onEnd": func() -> void:
			natural_state.ended += 1
			natural_state.handle.stop()
	})
	natural_state.handle = natural_handle
	await _settle_turns()
	assert(natural_handle is RuntimeAudioPlaybackHandle and audio.debug_active_sfx_count() == 1)
	var natural_player: AudioStreamPlayer = audio.active_sfx[-1]
	natural_player.finished.emit()
	assert(natural_state.ended == 1 and natural_handle.is_stopped())
	await _settle_turns()
	assert(audio.debug_active_sfx_count() == 0)
	assert(audio.play_transient_sfx("missing", {}) == null)
	audio.begin_cutscene_sfx_capture()
	var uncaptured_voice: Variant = audio.play_transient_sfx("voice_001", {})
	await _settle_turns()
	audio.end_cutscene_sfx_capture(true)
	assert(uncaptured_voice is RuntimeAudioPlaybackHandle and not uncaptured_voice.is_stopped())
	uncaptured_voice.stop()

	# Debug activeSfxCount is the source sfx cache size, not live player count.
	assert(audio.debug_active_sfx_count() == 0 and audio.get_debug_output_state().activeSfxCount >= 1)

	# System-SFX filters: restored quest, nested/continued dialogue and immediate
	# scene transition after map travel do not create duplicate UI sounds.
	audio.stop_all_playback()
	events.emit("quest:accepted", {"restored": true})
	await _settle_turns()
	assert(audio.debug_active_sfx_count() == 0)
	events.emit("quest:accepted", {})
	await _settle_turns()
	assert(audio.debug_active_sfx_count() == 1)
	audio.stop_all_playback()
	events.emit("dialogue:end", {"willContinue": true})
	events.emit("dialogue:end", {"nestedInGraph": true})
	await _settle_turns()
	assert(audio.debug_active_sfx_count() == 0)
	events.emit("map:travel", {})
	events.emit("scene:transition", {})
	await _settle_turns()
	assert(audio.debug_active_sfx_count() == 1)
	audio.stop_all_playback()

	# Scene audio and restore baseline preserve source intent collections/order.
	audio.apply_scene_audio(null, ["night_alley_wind"])
	await _settle_turns()
	assert(audio.get_requested_bgm_id() == null and audio.get_requested_ambient_ids() == ["night_alley_wind"])
	assert(audio.get_active_ambient_ids() == ["night_alley_wind"])
	audio.restore_audio_baseline(null, ["teahouse_roomtone"])
	await _settle_turns()
	assert(audio.get_active_ambient_ids() == ["night_alley_wind", "teahouse_roomtone"])
	audio.apply_scene_audio(null, ["amb_light_rain_loop", "amb_riverbank_loop"])
	await _settle_turns()
	assert(audio.get_active_ambient_ids() == ["amb_light_rain_loop", "amb_riverbank_loop"])

	# destroy invalidates all generations, timers, queued work, listeners and
	# engine players while retaining only inert config/asset references as source.
	var cleanup_fired := {"value": false}
	audio._schedule_cleanup(func() -> void: cleanup_fired.value = true, 5000.0)
	audio.audio_unblocked = false
	audio.play_bgm("bgm_placeholder_low_tension")
	assert(not audio.pending_timers.is_empty() and not audio.pending_playback.is_empty())
	audio.destroy()
	assert(EventBusProbe.listener_count(events) == 0)
	assert(audio.pending_timers.is_empty() and audio.pending_playback.is_empty())
	assert(audio.current_bgm == null and audio.ambient_layers.is_empty() and audio.active_sfx.is_empty())
	assert(not cleanup_fired.value and not audio.cutscene_sfx_active)

	remove_child(audio)
	audio.free()
	assets.clear_cache()
	assets.dispose()
	await get_tree().create_timer(0.1).timeout
	print("AudioManager module/field/config/epoch/mix/capture/transient/gate/system-SFX/lifecycle direct-translation test: PASS")
	get_tree().quit(0)


func _settle_turns(count: int = 3) -> void:
	for _index: int in count:
		await get_tree().process_frame
