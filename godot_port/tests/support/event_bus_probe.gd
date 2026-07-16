class_name EventBusProbe
extends RefCounted


static func listener_count(bus: RuntimeEventBus, event: String = "") -> int:
	if not event.is_empty():
		return bus._listeners.get(event, []).size()
	var total := 0
	for callbacks: Array in bus._listeners.values():
		total += callbacks.size()
	return total
