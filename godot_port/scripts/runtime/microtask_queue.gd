class_name RuntimeMicrotaskQueue
extends RefCounted

# Platform adapter for JavaScript queueMicrotask(). Domain systems enqueue the
# same callbacks as the TypeScript source; translated await boundaries drain them.
static var _queue: Array[Callable] = []
static var _flushing := false
static var _flush_scheduled := false
static var _tick_boundary_flush := false


static func queue_microtask(callback: Callable, schedule_flush: bool = true) -> void:
	if callback.is_valid():
		_queue.push_back(callback)
	if schedule_flush:
		_schedule_flush()


static func flush() -> void:
	if _flushing:
		return
	_flushing = true
	while not _queue.is_empty():
		var callback: Callable = _queue.pop_front()
		if callback.is_valid():
			# JavaScript 的微任务检查点不会等待回调返回的 Promise；回调运行到
			# 自己的下一个 await 后，队列继续处理其余微任务。
			callback.call()
	_flushing = false


static func flush_one() -> void:
	if _flushing or _queue.is_empty():
		return
	var callback: Callable = _queue.pop_front()
	if callback.is_valid():
		callback.call()


static func flush_one_at_tick_boundary() -> void:
	_tick_boundary_flush = true
	flush_one()
	_tick_boundary_flush = false


static func yield_turn() -> void:
	# `await Promise.resolve(value)` 即便 value 同步，也一定把续体排进下一条
	# JavaScript 微任务。Latch 只替换该语言原语，不包含任何游戏判断。
	var latch := RuntimeAsyncLatch.new()
	queue_microtask(Callable(latch, "resolve"))
	await latch.wait()


static func clear() -> void:
	_queue.clear()
	_flushing = false
	_flush_scheduled = false
	_tick_boundary_flush = false


static func _schedule_flush() -> void:
	if _flush_scheduled:
		return
	_flush_scheduled = true
	if _tick_boundary_flush:
		var tree: Variant = Engine.get_main_loop()
		if tree is SceneTree:
			tree.process_frame.connect(func() -> void:
				_flush_scheduled = false
				flush()
			, CONNECT_ONE_SHOT)
			return
	# Callable.call_deferred runs in the idle/deferred phase without advancing a
	# world frame. That is the engine-level counterpart of a JS microtask checkpoint;
	# process_frame would incorrectly advance movement, patrol and wall-clock systems.
	var scheduled := func() -> void:
		_flush_scheduled = false
		flush()
	scheduled.call_deferred()
