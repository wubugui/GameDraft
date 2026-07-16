extends RuntimeAssetManager

var textures: Dictionary = {}
var scenes: Dictionary = {}
var texture_calls: Array[String] = []
var scene_calls: Array[String] = []
var resolve_calls: Array[Dictionary] = []


func load_texture(path: String) -> Variant:
	texture_calls.push_back(path)
	if textures.has(path):
		return textures[path]
	_last_error = "missing texture: %s" % path
	return null


func resolve_scene_asset_path(scene_id: String, image_path: String) -> String:
	resolve_calls.push_back({"sceneId": scene_id, "imagePath": image_path})
	return "/virtual/scenes/%s/%s" % [scene_id, image_path]


func load_scene_data(scene_id: String) -> Dictionary:
	scene_calls.push_back(scene_id)
	var scene: Variant = scenes.get(scene_id)
	return scene.duplicate(true) if scene is Dictionary else {}
