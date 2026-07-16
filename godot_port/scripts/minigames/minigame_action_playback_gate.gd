class_name RuntimeMinigameActionPlaybackGate
extends RefCounted

var depth := 0
var execute_batch: Callable
var hooks: Variant = null


func _init(next_execute_batch: Callable, next_hooks: Variant = null) -> void:
	execute_batch = next_execute_batch
	hooks = next_hooks


func is_locked() -> bool:
	return depth > 0


func run(actions: Variant) -> void:
	if actions == null or actions.is_empty():
		return
	depth += 1
	if depth == 1 and hooks is Dictionary and hooks.get("onLockChanged") is Callable:
		hooks.onLockChanged.call(true)
	await execute_batch.call(actions)
	depth -= 1
	if depth == 0 and hooks is Dictionary and hooks.get("onLockChanged") is Callable:
		hooks.onLockChanged.call(false)
	if hooks is Dictionary and hooks.get("restoreMinigameState") is Callable:
		hooks.restoreMinigameState.call()
