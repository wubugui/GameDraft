extends RefCounted


static func wait_until_idle(day_manager: RuntimeDayManager) -> void:
	var tail: Variant = day_manager.get("_end_day_tail")
	await tail.wait_until_idle()
