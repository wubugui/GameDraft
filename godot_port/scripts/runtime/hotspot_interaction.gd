class_name RuntimeHotspotInteraction
extends RefCounted


static func inspect_data_has_interactable_payload(data: Dictionary) -> bool:
	var graph_id := str(data.get("graphId", "")).strip_edges() if data.get("graphId") is String else ""
	if not graph_id.is_empty():
		return true
	var text := str(data.get("text", "")).strip_edges() if data.get("text") is String else ""
	if not text.is_empty():
		return true
	return data.get("actions") is Array and not data.actions.is_empty()


static func hotspot_offers_player_interaction(definition: Dictionary) -> bool:
	var data: Variant = definition.get("data")
	if not data is Dictionary:
		return false
	match str(definition.get("type", "")):
		"inspect":
			return inspect_data_has_interactable_payload(data)
		"pickup":
			return data.get("itemId") is String and not str(data.itemId).strip_edges().is_empty()
		"transition":
			return data.get("targetScene") is String and not str(data.targetScene).strip_edges().is_empty()
		"encounter":
			return data.get("encounterId") is String and not str(data.encounterId).strip_edges().is_empty()
		"npc":
			return data.get("npcId") is String and not str(data.npcId).strip_edges().is_empty()
	return false
