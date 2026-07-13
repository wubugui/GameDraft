class_name RuntimeRuleOfferRegistry
extends RefCounted

var _by_zone: Dictionary = {}


func register(zone_id: String, slots: Array) -> void:
	var copy: Array = []
	for raw: Variant in slots:
		if not raw is Dictionary: continue
		var slot := {"ruleId": raw.get("ruleId"), "resultActions": raw.get("resultActions")}
		if raw.get("requiredLayers") is Array and not raw.requiredLayers.is_empty(): slot["requiredLayers"] = raw.requiredLayers
		if raw.has("resultText"): slot["resultText"] = raw.resultText
		copy.push_back(slot)
	_by_zone[zone_id] = copy


func unregister(zone_id: String) -> void: _by_zone.erase(zone_id)
func clear() -> void: _by_zone.clear()
func destroy() -> void: clear()


func get_aggregated_slots() -> Array:
	var result: Array = []
	for slots: Array in _by_zone.values(): result.append_array(slots)
	return result
