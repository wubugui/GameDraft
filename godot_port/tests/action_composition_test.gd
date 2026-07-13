extends Node

var log: Array = []
var choice_calls: Array = []
var picked: Variant = 1
var random_sample := 0.9
var state_ref: RuntimeGameStateController


func _ready() -> void:
	var events := RuntimeEventBus.new(); var flags := RuntimeFlagStore.new(events); var input := RuntimeInputManager.new(); var state := RuntimeGameStateController.new(input, events); state_ref = state; var executor := RuntimeActionExecutor.new(events, flags, state)
	executor.set_resolve_notification_text(func(text: String) -> String: return text.replace("{{name}}", "阿明")); executor.set_choose_action(Callable(self, "_choose")); executor.set_random_value_provider(func() -> float: return random_sample)
	executor.register("record", func(params: Dictionary, zone: Variant) -> void: log.push_back({"id": params.id, "zone": zone.get("zoneId") if zone is Dictionary else null}), ["id"])
	await executor.execute_await({"type": "runActions", "params": {"actions": [{"type": "record", "params": {"id": "a"}}, {"bogus": true}, {"type": "runActions", "params": {"actions": [{"type": "record", "params": {"id": "b"}}]}}]}}, {"zoneId": "zone_a"})
	assert(log == [{"id": "a", "zone": "zone_a"}, {"id": "b", "zone": "zone_a"}] and state.current_state == RuntimeGameStateController.EXPLORING)
	await executor.execute_await({"type": "chooseAction", "params": {"prompt": "你好 {{name}}", "options": [{"text": "", "actions": []}, {"text": "第一 {{name}}", "actions": [{"type": "record", "params": {"id": "first"}}]}, {"text": "第二", "actions": [{"type": "record", "params": {"id": "second"}}]}], "allowCancel": true}}, {"zoneId": "choice_zone"})
	assert(choice_calls == [{"prompt": "你好 阿明", "options": [{"text": "第一 阿明"}, {"text": "第二"}], "allowCancel": true, "state": RuntimeGameStateController.UI_OVERLAY}] and log[-1] == {"id": "second", "zone": "choice_zone"} and state.current_state == RuntimeGameStateController.EXPLORING)
	picked = null; var before := log.size(); await executor.execute_await({"type": "chooseAction", "params": {"options": [{"text": "取消", "actions": [{"type": "record", "params": {"id": "no"}}]}], "allowCancel": true}}); assert(log.size() == before)
	random_sample = 0.9; await executor.execute_await({"type": "randomBranch", "params": {"probability": 0.5, "aboveActions": [{"type": "record", "params": {"id": "above"}}], "belowActions": [{"type": "record", "params": {"id": "below"}}]}}); assert(log[-1].id == "above")
	random_sample = 0.5; await executor.execute_await({"type": "randomBranch", "params": {"probability": 0.5, "aboveActions": [{"type": "record", "params": {"id": "wrong"}}], "belowActions": [{"type": "record", "params": {"id": "equal-below"}}]}}); assert(log[-1].id == "equal-below")
	random_sample = 0.4; await executor.execute_await({"type": "randomBranch", "params": {"probability": "bad", "aboveActions": [{"type": "record", "params": {"id": "wrong"}}], "belowActions": [{"type": "record", "params": {"id": "default-below"}}]}}); assert(log[-1].id == "default-below")
	random_sample = 0.1; await executor.execute_await({"type": "randomBranch", "params": {"probability": -4, "aboveActions": [{"type": "record", "params": {"id": "clamped-above"}}]}}); assert(log[-1].id == "clamped-above")
	assert(executor.get_registered_action_types().has("runActions") and executor.get_param_names("chooseAction") == ["prompt", "options", "allowCancel"])
	executor.destroy(); state.destroy(); flags.destroy(); input.destroy(); input.free(); events.clear()
	print("Action composition/choice/random contract test: PASS"); get_tree().quit(0)


func _choose(prompt: String, options: Array, allow_cancel: bool) -> Variant:
	choice_calls.push_back({"prompt": prompt, "options": options.duplicate(true), "allowCancel": allow_cancel, "state": state_ref.current_state})
	await get_tree().process_frame
	return picked
