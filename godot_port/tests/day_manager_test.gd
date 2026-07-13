extends Node

var order: Array[String] = []
var day: RuntimeDayManager


func _ready() -> void:
	await _run()


func _run() -> void:
	var bus := RuntimeEventBus.new()
	bus.on("day:end", Callable(self, "_record_day").bind("end"))
	bus.on("day:start", Callable(self, "_record_day").bind("start"))
	var flags := RuntimeFlagStore.new(bus)
	var executor := RuntimeActionExecutor.new(bus, flags)
	executor.register("recordDayTest", Callable(self, "_record_action"), ["label"])
	executor.register("scheduleDayTest", Callable(self, "_schedule_action"), ["targetDay", "label"])
	executor.register("delayDayTest", Callable(self, "_delay_action"), ["seconds"])
	day = RuntimeDayManager.new(bus, flags, executor)
	day.init({})
	assert(day.get_current_day() == 1 and flags.get_value("current_day") == 1.0)
	day.add_delayed_event(3, [{"type": "recordDayTest", "params": {"label": "late"}}])
	day.add_delayed_event(2, [
		{"type": "recordDayTest", "params": {"label": "first"}},
		{"type": "scheduleDayTest", "params": {"targetDay": 2, "label": "added-during-processing"}},
	])
	day.add_delayed_event(2, [{"type": "recordDayTest", "params": {"label": "second"}}])
	await day.end_day()
	assert(day.get_current_day() == 2)
	assert(order == ["end:1", "action:first", "action:second", "start:2"])
	assert(day.serialize().delayedEvents.size() == 2)
	await day.end_day()
	assert(day.get_current_day() == 3)
	assert(order.slice(4) == ["end:2", "action:added-during-processing", "action:late", "start:3"])

	# Two unawaited requests remain serialized as complete end-day transactions.
	day.add_delayed_event(4, [{"type": "delayDayTest", "params": {"seconds": 0.01}}, {"type": "recordDayTest", "params": {"label": "day4"}}])
	day.end_day()
	day.end_day()
	await day.wait_until_idle()
	assert(day.get_current_day() == 5)
	assert(order.has("action:day4"))
	assert(order[-3] == "start:4" and order[-2] == "end:4" and order[-1] == "start:5")

	var snapshot := day.serialize()
	var restored := RuntimeDayManager.new(bus, flags, executor)
	restored.init({})
	restored.deserialize(snapshot)
	assert(restored.serialize() == snapshot and flags.get_value("current_day") == 5.0)
	restored.destroy(); restored.free()
	day.destroy(); day.free()
	executor.destroy(); flags.destroy(); bus.clear()
	print("DayManager contract test: PASS")
	get_tree().quit(0)


func _record_day(payload: Dictionary, kind: String) -> void:
	order.push_back("%s:%s" % [kind, payload.dayNumber])


func _record_action(params: Dictionary, _zone: Variant) -> void:
	order.push_back("action:%s" % params.get("label", ""))


func _schedule_action(params: Dictionary, _zone: Variant) -> void:
	day.add_delayed_event(int(params.get("targetDay", 1)), [{"type": "recordDayTest", "params": {"label": params.get("label", "")}}])


func _delay_action(params: Dictionary, _zone: Variant) -> void:
	await get_tree().create_timer(float(params.get("seconds", 0.01))).timeout
