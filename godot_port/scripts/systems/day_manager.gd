class_name RuntimeDayManager
extends RuntimeSystem

signal end_day_progress

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _action_executor: RuntimeActionExecutor
var _current_day := 1
var _delayed_events: Array[Dictionary] = []
var _end_day_requests: Array[int] = []
var _next_request_token := 0
var _completed_request_token := 0
var _end_day_running := false
var _destroyed := false


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore, action_executor: RuntimeActionExecutor) -> void:
	_event_bus = event_bus
	_flag_store = flag_store
	_action_executor = action_executor


func init(_ctx: Dictionary) -> void:
	_current_day = 1
	_delayed_events.clear()
	_end_day_requests.clear()
	_next_request_token = 0
	_completed_request_token = 0
	_end_day_running = false
	_destroyed = false
	_sync_flag()


func update(_dt: float) -> void:
	return


func get_current_day() -> int:
	return _current_day


func end_day() -> void:
	if _destroyed:
		return
	_next_request_token += 1
	var token := _next_request_token
	_end_day_requests.push_back(token)
	if not _end_day_running:
		_drain_end_day_requests()
	while not _destroyed and _completed_request_token < token:
		await end_day_progress
	if not _destroyed:
		await Engine.get_main_loop().process_frame


func wait_until_idle() -> void:
	while not _destroyed and (_end_day_running or not _end_day_requests.is_empty()):
		await end_day_progress
	if not _destroyed:
		await Engine.get_main_loop().process_frame


func add_delayed_event(target_day: int, actions: Array) -> void:
	_delayed_events.push_back({"targetDay": target_day, "actions": actions.duplicate(true)})


func serialize() -> Dictionary:
	return {"currentDay": _current_day, "delayedEvents": _delayed_events.duplicate(true)}


func deserialize(data: Dictionary) -> void:
	_current_day = int(data.get("currentDay", 1))
	_delayed_events.clear()
	var events: Variant = data.get("delayedEvents", [])
	if events is Array:
		for event: Variant in events:
			if event is Dictionary:
				_delayed_events.push_back(event.duplicate(true))
	_sync_flag()


func destroy() -> void:
	_destroyed = true
	_current_day = 1
	_delayed_events.clear()
	_end_day_requests.clear()
	_end_day_running = false
	_notify_progress()


func debug_snapshot_fragment() -> Dictionary:
	return {"day": serialize()}


func _drain_end_day_requests() -> void:
	_end_day_running = true
	while not _end_day_requests.is_empty() and not _destroyed:
		var token: int = _end_day_requests.pop_front()
		_event_bus.emit("day:end", {"dayNumber": _current_day})
		_current_day += 1
		var started_day := _current_day
		_sync_flag()
		await _process_delayed_events()
		if _destroyed:
			break
		_event_bus.emit("day:start", {"dayNumber": started_day})
		_completed_request_token = token
		_notify_progress()
	_end_day_running = false
	_notify_progress()


func _process_delayed_events() -> void:
	var due: Array[Dictionary] = []
	var remaining: Array[Dictionary] = []
	for event: Dictionary in _delayed_events:
		if int(event.get("targetDay", 0)) <= _current_day:
			# Stable insertion by targetDay: equal targets stay in registration order.
			var insert_at := due.size()
			for index in due.size():
				if int(due[index].get("targetDay", 0)) > int(event.get("targetDay", 0)):
					insert_at = index
					break
			due.insert(insert_at, event)
		else:
			remaining.push_back(event)
	_delayed_events = remaining
	for event: Dictionary in due:
		var actions: Variant = event.get("actions", [])
		if actions is Array:
			await _action_executor.execute_batch_await(actions)


func _sync_flag() -> void:
	_flag_store.set_value("current_day", float(_current_day))


func _notify_progress() -> void:
	# Promise continuations in TypeScript run after the current stack.  Deferred
	# emission gives GDScript awaiters the same boundary and avoids freeing a
	# manager while its drain method is still on the signal-emission stack.
	call_deferred("_emit_progress")


func _emit_progress() -> void:
	end_day_progress.emit()
