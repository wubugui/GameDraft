extends Node

var result_value := ""


func _ready() -> void:
	var stable := _make_panel("stable", "escape", 8.0); add_child(stable)
	for _index: int in 600:
		stable.set_lift_held(stable.get_marker() < stable.get_green_center()); stable.update(0.02)
		if stable.is_done(): break
	assert(result_value == "success" and stable.get_progress() >= 0.995)
	stable.queue_free()
	for policy: String in ["escape", "snap", "bite"]:
		result_value = ""; var panel := _make_panel("heavy_sink", policy, 2.0); add_child(panel); panel.debug_set_state(0.02, 0.9)
		for _index: int in 40:
			panel.set_lift_held(false); panel.update(0.084)
			if panel.is_done(): break
		assert(result_value == ("fail_escape" if policy == "escape" else ("fail_snap" if policy == "snap" else "fail_bite")), "policy=%s result=%s elapsed=%s limit=%s params=%s done=%s" % [policy, result_value, panel.elapsed, panel.time_limit, panel.params, panel.done]); panel.queue_free()
	result_value = ""; var abort_panel := _make_panel("spasm", "bite", 10.0); add_child(abort_panel); abort_panel.abort(); assert(result_value == "abort" and abort_panel.is_done()); abort_panel.queue_free()
	print("WaterPullPanel stable-success/rhythm/three-failures/abort contract test: PASS"); get_tree().quit(0)


func _make_panel(rhythm: String, policy: String, limit: float) -> RuntimeWaterPullPanel:
	return RuntimeWaterPullPanel.new({"zoneSize": 0.18, "sliderSpeed": 0.75, "rhythm": rhythm, "failurePolicy": policy, "timeLimitSec": limit, "resolveText": func(raw: String) -> String: return raw, "onResult": Callable(self, "_capture")}, func() -> float: return 0.5)


func _capture(value: String) -> void: result_value = value
