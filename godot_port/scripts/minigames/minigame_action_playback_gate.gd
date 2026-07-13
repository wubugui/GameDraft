class_name RuntimeMinigameActionPlaybackGate
extends RefCounted

var _execute_batch: Callable
var _on_lock_changed: Callable
var _restore_minigame_state: Callable
var _depth := 0


func _init(execute_batch: Callable, hooks: Dictionary = {}) -> void:
	_execute_batch = execute_batch
	_on_lock_changed = hooks.get("onLockChanged", Callable())
	_restore_minigame_state = hooks.get("restoreMinigameState", Callable())


func is_locked() -> bool:
	return _depth > 0


func run(actions: Array) -> void:
	if actions.is_empty():
		return
	_depth += 1
	if _depth == 1 and not _on_lock_changed.is_null() and _on_lock_changed.is_valid():
		_on_lock_changed.call(true)
	if not _execute_batch.is_null() and _execute_batch.is_valid():
		await _execute_batch.call(actions)
	_depth = maxi(0, _depth - 1)
	if _depth == 0 and not _on_lock_changed.is_null() and _on_lock_changed.is_valid():
		_on_lock_changed.call(false)
	if not _restore_minigame_state.is_null() and _restore_minigame_state.is_valid():
		_restore_minigame_state.call()
