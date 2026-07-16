class_name RuntimePromiseObserver
extends RefCounted

# Engine adapter for `void promise.catch(...)`. Calling observe() is deliberately
# fire-and-forget: the target callable starts immediately and this continuation
# only reports the translated rejected-Promise false channel.
static func observe(callback: Callable, args: Array, failure_warning: String) -> void:
	var result: Variant = await callback.callv(args)
	callback = Callable()
	args.clear()
	if result is bool and result == false:
		push_warning(failure_warning)
