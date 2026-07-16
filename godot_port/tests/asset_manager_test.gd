extends SceneTree


func _init() -> void:
	var project_dir := ProjectSettings.globalize_path("res://").trim_suffix("/")
	var repository_root := project_dir.get_base_dir()
	var locator := RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository_root)
	var assets := RuntimeAssetManager.new({}, locator)

	assert(assets.get_json("/assets/data/game_config.json") == null)
	var config: Variant = assets.load_json("/assets/data/game_config.json")
	assert(config is Dictionary)
	assert(assets.load_json("/assets/data/game_config.json") == config)
	assert(assets.get_stats().json.loads == 1 and assets.get_stats().json.hits >= 1)
	var text: Variant = assets.load_text("/assets/data/game_config.json")
	assert(text is String and not text.is_empty())

	var image_url := "/resources/runtime/images/inspect/back_carry/pale_waterlogged_heel.png"
	var bitmap: Variant = assets.load_bitmap(image_url)
	var texture: Variant = assets.load_texture(image_url)
	assert(bitmap is Image and bitmap.get_width() == 768 and bitmap.get_height() == 512)
	assert(texture is Texture2D and texture.get_width() == 768 and texture.get_height() == 512)
	assert(assets.get_texture(image_url) == texture)

	var audio_url := "/resources/runtime/audio/demo/sfx_ui_paper_tick.wav"
	var audio: Variant = assets.load_audio(audio_url)
	var loop_audio: Variant = assets.load_audio(audio_url, {"loop": true})
	assert(audio is AudioStream and loop_audio is AudioStream and audio != loop_audio)
	for filename: String in ["sfx_abnormal_breath.wav", "sfx_night_bird_startle.wav", "amb_light_rain_loop.wav", "sfx_heartbeat_bed.wav", "sfx_lamp_oil_flame.wav", "sfx_well_childlike_cry_loop.wav", "amb_riverbank_loop.wav", "sfx_well_cry_stop.wav"]:
		var extensible_audio: Variant = assets.load_audio("/resources/runtime/audio/demo/%s" % filename)
		assert(extensible_audio is AudioStreamWAV and extensible_audio.format == AudioStreamWAV.FORMAT_16_BITS and extensible_audio.stereo and extensible_audio.mix_rate == 44100 and not extensible_audio.data.is_empty())
	var odd_pcm8: Variant = assets.load_audio("/resources/runtime/audio/BGS/SWDRSLGDIR_0025_wind01.wav", {"loop": true})
	assert(odd_pcm8 is AudioStreamWAV and odd_pcm8.format == AudioStreamWAV.FORMAT_8_BITS and not odd_pcm8.stereo and odd_pcm8.mix_rate == 8000 and odd_pcm8.data.size() == 240065 and odd_pcm8.loop_mode == AudioStreamWAV.LOOP_FORWARD)
	assert(assets.get_stats().audio.loads == 11 and assets.get_stats().audio.errors == 0)
	var filter: Variant = assets.load_filter("night")
	assert(filter is ShaderMaterial and filter.get_shader_parameter("color_matrix") is Projection and filter.get_shader_parameter("filter_alpha") == 1.0)

	var scene_a := assets.load_scene_data("temple")
	assert(not scene_a.is_empty() and scene_a.backgrounds[0].image == "/resources/runtime/scenes/temple/background.png")
	var original_x := float(scene_a.spawnPoint.x)
	scene_a.spawnPoint.x = original_x + 999.0
	var scene_b := assets.load_scene_data("temple")
	assert(float(scene_b.spawnPoint.x) == original_x)

	var limited := RuntimeAssetManager.new({"json": {"entries": 1}}, locator)
	assert(limited.load_json("/assets/data/game_config.json") is Dictionary)
	limited.pin_scope("scope:a", [{"type": "json", "path": "/assets/data/game_config.json"}])
	assert(limited.load_json("/assets/data/strings.json") is Dictionary)
	assert(limited.get_json("/assets/data/game_config.json") != null)
	assert(limited.get_json("/assets/data/strings.json") == null)
	limited.release_scope("scope:a")
	assert(limited.load_json("/assets/data/items.json") is Array)
	assert(limited.get_stats().json.entries == 1)

	var progress: Array = []
	assert(limited.preload_manifest({
		"scopeId": "manifest",
		"refs": [
			{"type": "json", "path": "/assets/data/items.json"},
			{"type": "json", "path": "/assets/data/items.json"},
		],
	}, {"onProgress": func(ratio: float, _label: String) -> void: progress.push_back(ratio)}))
	assert(progress == [0.0, 1.0] and limited.get_stats().json.pinned == 1)

	assets.dispose()
	for type: String in RuntimeAssetManager.ASSET_TYPES:
		assert(assets.get_stats()[type].entries == 0)
	assert(assets.load_json("/assets/data/game_config.json") is Dictionary)
	assert(assets.get_json("/assets/data/game_config.json") == null)
	limited.dispose()
	print("AssetManager contract test: PASS")
	quit(0)
