class_name AvatarAssetManagerProbe
extends RuntimeAssetManager

var json_by_path: Dictionary = {}
var texture_by_path: Dictionary = {}
var json_calls: Array[String] = []
var texture_calls: Array[String] = []
var preload_calls: Array[Dictionary] = []


func load_json(path: String) -> Variant:
	json_calls.push_back(path)
	return json_by_path.get(path)


func load_texture(path: String) -> Variant:
	texture_calls.push_back(path)
	return texture_by_path.get(path)


func preload_manifest(manifest: Dictionary, options: Dictionary = {}) -> bool:
	preload_calls.push_back({"manifest": manifest.duplicate(true), "options": options.duplicate(true)})
	return true
