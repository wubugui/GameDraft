extends SceneTree


func _init() -> void:
	var project_dir := ProjectSettings.globalize_path("res://").trim_suffix("/")
	var repository_root := project_dir.get_base_dir()
	var locator := RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository_root)
	assert(locator.scene_json_url("码头白天") == "/assets/scenes/码头白天.json")
	assert(locator.dialogue_graph_json_url("寻狗_说书人") == "/assets/dialogues/graphs/寻狗_说书人.json")
	assert(locator.scene_json_url("../escape").is_empty())
	assert(locator.scene_runtime_asset_url("码头白天", "background.png") == "/resources/runtime/scenes/码头白天/background.png")
	assert(locator.scene_runtime_asset_url("ignored", "/resources/runtime/images/x.png") == "/resources/runtime/images/x.png")
	assert(locator.media_url_from_short_path("images/backgrounds/x.png") == "/resources/runtime/images/backgrounds/x.png")
	assert(locator.media_url_from_short_path("/assets/images/x.png").is_empty())
	assert(locator.media_url_for_root("audio", "bgm/y.wav") == "/resources/runtime/audio/bgm/y.wav")
	assert(locator.resolve_anim_relative("/resources/runtime/animation/player_anim/anim.json", "atlas.png") == "/resources/runtime/animation/player_anim/atlas.png")
	assert(locator.resolve_url("/assets/data/strings.json", RuntimeResourceLocator.TEXT) == repository_root.path_join("public/assets/data/strings.json"))
	assert(locator.resolve_url("/resources/runtime/audio/bgm/x.wav", RuntimeResourceLocator.MEDIA) == repository_root.path_join("public/resources/runtime/audio/bgm/x.wav"))
	assert(locator.resolve_url("/assets/data/strings.json", RuntimeResourceLocator.MEDIA).is_empty())
	assert(locator.resolve_url("/resources/runtime/audio/x.wav", RuntimeResourceLocator.TEXT).is_empty())
	assert(locator.resolve_url("/assets/../secret", RuntimeResourceLocator.TEXT).is_empty())

	var exported := RuntimeResourceLocator.new(RuntimeResourceLocator.EXPORTED, repository_root, "res://generated/public")
	assert(exported.resolve_url("/assets/data/strings.json", RuntimeResourceLocator.TEXT) == "res://generated/public/assets/data/strings.json")
	assert(exported.resolve_url("/resources/runtime/images/x.png", RuntimeResourceLocator.MEDIA) == "res://generated/public/resources/runtime/images/x.png")

	var graph_file := FileAccess.open(project_dir.path_join("compatibility/resource-graph.json"), FileAccess.READ)
	assert(graph_file != null)
	var graph: Variant = JSON.parse_string(graph_file.get_as_text())
	assert(graph is Dictionary and graph.exportFiles is Array)
	var checked := 0
	for raw_entry: Variant in graph.exportFiles:
		assert(raw_entry is Dictionary)
		var target := str(raw_entry.get("path", ""))
		var url := ""
		var kind := RuntimeResourceLocator.ANY
		if target.begins_with("public/assets/"):
			url = "/" + target.trim_prefix("public/")
			kind = RuntimeResourceLocator.TEXT
		elif target.begins_with("public/resources/runtime/"):
			url = "/" + target.trim_prefix("public/")
			kind = RuntimeResourceLocator.MEDIA
		else:
			assert(false, "resource graph contains target outside export public roots: %s" % target)
		var resolved := locator.resolve_url(url, kind)
		assert(not resolved.is_empty() and FileAccess.file_exists(resolved), "unresolved graph target: %s" % target)
		checked += 1
	var expected := int(graph.get("summary", {}).get("localTargets", -1))
	assert(expected == graph.exportFiles.size() and checked == expected and checked >= 745)
	print("ResourceLocator contract test: PASS (%s graph targets)" % checked)
	quit(0)
