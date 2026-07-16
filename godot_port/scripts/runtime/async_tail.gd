class_name RuntimeAsyncTail
extends RefCounted

signal progressed

var _queue: Array[Dictionary] = []
var _running := false
var _next_token := 0
var _completed_token := 0


func then(run: Callable, failure_warning: String = "") -> void:
	_next_token += 1
	var token := _next_token
	_queue.push_back({"token": token, "run": run, "failureWarning": failure_warning})
	if not _running:
		_drain()
	while _completed_token < token:
		await progressed


func wait_until_idle() -> void:
	while _running or not _queue.is_empty():
		await progressed


func _drain() -> void:
	_running = true
	while not _queue.is_empty():
		var entry: Dictionary = _queue.pop_front()
		var token := int(entry.token)
		var run: Callable = entry.run
		if run.is_valid():
			var result: Variant = await run.call()
			if result is bool and result == false and not str(entry.get("failureWarning", "")).is_empty():
				push_warning(str(entry.failureWarning))
		# A settled JavaScript Promise releases its reaction callbacks.  Godot keeps
		# coroutine locals alive until the function-state object is reclaimed, so
		# explicitly release the translated callback here; otherwise a completed tail
		# can keep its owner script's lambda alive until engine shutdown.
		run = Callable()
		entry.clear()
		_completed_token = token
		progressed.emit()
	_running = false
	progressed.emit()
