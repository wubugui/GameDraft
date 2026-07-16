class_name RuntimeDayManager
extends RuntimeSystem

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _action_executor: RuntimeActionExecutor

var _current_day := 1
var _delayed_events: Array = []
var _end_day_tail := RuntimeAsyncTail.new()


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore, action_executor: RuntimeActionExecutor) -> void:
	_event_bus = event_bus
	_flag_store = flag_store
	_action_executor = action_executor


func init(_ctx: Dictionary) -> void:
	_current_day = 1
	_delayed_events = []
	_end_day_tail = RuntimeAsyncTail.new()
	_sync_flag()


func update(_dt: float) -> void:
	return


func get_current_day() -> int:
	return _current_day


func end_day() -> void:
	await _end_day_tail.then(func() -> void:
		_event_bus.emit("day:end", {"dayNumber": _current_day})
		_current_day += 1
		var started_day := _current_day
		_sync_flag()
		await _finish_end_day_after_delayed(started_day)
	)


func _finish_end_day_after_delayed(day_number: int) -> void:
	await _process_delayed_events()
	_event_bus.emit("day:start", {"dayNumber": day_number})


func add_delayed_event(target_day: int, actions: Array) -> void:
	_delayed_events.push_back({"targetDay": target_day, "actions": actions})


func _process_delayed_events() -> void:
	var due: Array = []
	var remaining: Array = []
	for event: Dictionary in _delayed_events:
		if int(event.get("targetDay", 0)) <= _current_day:
			due.push_back(event)
		else:
			remaining.push_back(event)
	_delayed_events = remaining
	var sorted_due: Array = []
	for event: Dictionary in due:
		var insert_at := sorted_due.size()
		for index in sorted_due.size():
			if int(sorted_due[index].get("targetDay", 0)) > int(event.get("targetDay", 0)):
				insert_at = index
				break
		sorted_due.insert(insert_at, event)
	for event: Dictionary in sorted_due:
		var actions: Variant = event.get("actions")
		if actions is Array and not await _action_executor.execute_batch_await(actions):
			push_warning("DayManager: delayed actions failed")


func _sync_flag() -> void:
	_flag_store.set_value(RuntimeFlagKeys.CURRENT_DAY, float(_current_day))


func serialize() -> Dictionary:
	return {
		"currentDay": _current_day,
		"delayedEvents": _delayed_events,
	}


func deserialize(data: Dictionary) -> void:
	_current_day = int(data.get("currentDay", 1))
	_delayed_events = data.get("delayedEvents") if data.get("delayedEvents") is Array else []
	_sync_flag()


func destroy() -> void:
	_current_day = 1
	_delayed_events = []
	_end_day_tail = RuntimeAsyncTail.new()
