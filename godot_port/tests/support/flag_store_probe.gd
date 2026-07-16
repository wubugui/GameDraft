class_name FlagStoreProbe
extends RefCounted


static func registry_counts(store: RuntimeFlagStore) -> Dictionary:
	var registry: Variant = store._registry_runtime
	if registry == null:
		return {"static": 0, "patterns": 0}
	return {"static": registry.staticKeys.size(), "patterns": registry.patterns.size()}
