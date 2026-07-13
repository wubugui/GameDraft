extends SceneTree


func _init() -> void:
	var registry := RuntimeRuleOfferRegistry.new()
	var actions := [{"type": "setFlag", "params": {"key": "a", "value": true}}]
	var source := [{"ruleId": "r1", "resultActions": actions, "requiredLayers": ["xiang"], "resultText": "one"}, {"ruleId": "r2", "resultActions": []}]
	registry.register("zone_a", source)
	source[0].ruleId = "mutated"
	registry.register("zone_b", [{"ruleId": "r3", "resultActions": []}])
	assert(registry.get_aggregated_slots().map(func(slot: Dictionary) -> Variant: return slot.ruleId) == ["r1", "r2", "r3"])
	assert(registry.get_aggregated_slots()[0].requiredLayers == ["xiang"] and registry.get_aggregated_slots()[0].resultText == "one")
	assert(not registry.get_aggregated_slots()[1].has("requiredLayers") and not registry.get_aggregated_slots()[1].has("resultText"))
	# TS copies slot records but intentionally retains nested action/layer references.
	actions[0].params.key = "shared"
	assert(registry.get_aggregated_slots()[0].resultActions[0].params.key == "shared")
	registry.register("zone_a", [{"ruleId": "replacement", "resultActions": []}])
	assert(registry.get_aggregated_slots().map(func(slot: Dictionary) -> Variant: return slot.ruleId) == ["replacement", "r3"])
	registry.unregister("zone_a")
	assert(registry.get_aggregated_slots().map(func(slot: Dictionary) -> Variant: return slot.ruleId) == ["r3"])
	registry.destroy(); assert(registry.get_aggregated_slots().is_empty())
	print("RuleOfferRegistry contract test: PASS"); quit(0)
