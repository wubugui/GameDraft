extends Node

var ui_under_test: RuntimePressureHoldUI
var saw_release_root := false
var saw_cancel_root := false


func _ready() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var strings := RuntimeStringsProvider.new()
	strings.load(assets)
	var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.init()
	var input := RuntimeInputManager.new(); add_child(input)
	ui_under_test = RuntimePressureHoldUI.new(renderer, strings, input)
	ui_under_test.set_debug_input(true, 0.2)
	get_tree().process_frame.connect(Callable(self, "_release_then_press"), CONNECT_ONE_SHOT)
	var reached := await ui_under_test.run_segment({"prompt": "撑住", "startRatio": 0.0, "stopRatio": 0.5, "fillSeconds": 1.0, "decayPerSecond": 0.6, "barColor": 0x123456})
	assert(reached == "reached" and ui_under_test.get_root() == null and is_equal_approx(ui_under_test.current_ratio, 0.5))
	ui_under_test.set_debug_input(false, 0.05)
	get_tree().process_frame.connect(Callable(self, "_press_then_release"), CONNECT_ONE_SHOT)
	var released := await ui_under_test.run_segment({"prompt": "不要松手", "releaseHint": "松了", "startRatio": 0.6, "stopRatio": 1.0, "fillSeconds": 1.0, "decayPerSecond": 0.6, "abortOnReleaseFromRatio": 0.5})
	assert(saw_release_root and released == "released" and ui_under_test.get_root() == null)
	ui_under_test.set_debug_input(false, 0.05)
	get_tree().process_frame.connect(Callable(self, "_cancel_next_frame"), CONNECT_ONE_SHOT)
	var cancelled := await ui_under_test.run_segment({"prompt": "取消", "startRatio": 0.0, "stopRatio": 1.0, "fillSeconds": 4.0, "decayPerSecond": 0.6})
	assert(saw_cancel_root and cancelled == "reached" and ui_under_test.get_root() == null)
	assert(await ui_under_test.run_segment({"startRatio": 0.0}) == "invalid")
	ui_under_test.destroy(); input.destroy(); renderer.destroy(); remove_child(input); input.free(); remove_child(renderer); renderer.free(); assets.dispose()
	print("PressureHoldUI hold/release/cancel/cleanup contract test: PASS")
	get_tree().quit(0)


func _release_next_frame() -> void:
	saw_release_root = ui_under_test.get_root() != null and ui_under_test.get_root().name == "PressureHoldUI"
	ui_under_test.set_debug_input(false, 0.05)


func _release_then_press() -> void:
	assert(is_equal_approx(ui_under_test.current_ratio, 0.0))
	ui_under_test.set_debug_input(false, 0.2)
	get_tree().process_frame.connect(func() -> void: ui_under_test.set_debug_input(true, 0.2), CONNECT_ONE_SHOT)


func _press_then_release() -> void:
	ui_under_test.set_debug_input(true, 0.05)
	get_tree().process_frame.connect(Callable(self, "_release_next_frame"), CONNECT_ONE_SHOT)


func _cancel_next_frame() -> void:
	saw_cancel_root = ui_under_test.get_root() != null
	ui_under_test.cancel()
