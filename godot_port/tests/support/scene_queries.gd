extends RefCounted


static func hotspot(scene_manager: RuntimeSceneManager, id: String) -> Variant:
	var hotspots := scene_manager.get_current_hotspots()
	var index := hotspots.find_custom(func(candidate: RuntimeHotspot) -> bool: return candidate.get_id() == id)
	return hotspots[index] if index >= 0 else null
