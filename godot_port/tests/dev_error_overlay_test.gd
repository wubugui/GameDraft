extends SceneTree


func _init() -> void:
	process_frame.connect(_run, CONNECT_ONE_SHOT)


func _run() -> void:
	RuntimeDevErrorOverlay.clear_dev_errors()
	assert(RuntimeDevErrorOverlay.describe_error({"code": "bad", "count": 2}) == '{"code":"bad","count":2}')
	assert(RuntimeDevErrorOverlay.describe_error("plain") == "plain")
	RuntimeDevErrorOverlay._ensure_overlay()
	if OS.is_debug_build() and DisplayServer.get_name() != "headless":
		assert(RuntimeDevErrorOverlay.container != null)
		assert(RuntimeDevErrorOverlay.list_el != null)
		assert(RuntimeDevErrorOverlay.container.name == "GameDraftDevErrorOverlay")
	else:
		assert(RuntimeDevErrorOverlay.container == null and RuntimeDevErrorOverlay.list_el == null)
	RuntimeDepthLog.depth_log("DepthProbe", ["value", {"enabled": true}, 3])
	RuntimeDevErrorOverlay.clear_dev_errors()
	assert(RuntimeDevErrorOverlay.container == null and RuntimeDevErrorOverlay.list_el == null)
	print("DevErrorOverlay/depthLog direct-translation test: PASS")
	quit(0)
