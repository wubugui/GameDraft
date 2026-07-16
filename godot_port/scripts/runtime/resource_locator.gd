class_name RuntimeResourceLocator
extends RefCounted

const DEVELOPMENT := "development"
const EXPORTED := "exported"
const TEXT := "text"
const MEDIA := "media"
const ANY := "any"
const ASSETS_PREFIX := "/assets/"
const RUNTIME_PREFIX := "/resources/runtime/"

static var _default_instance: Variant = null

var mode: String
var repository_root: String
var export_public_root: String


func _init(next_mode: String = "", next_repository_root: String = "", next_export_public_root: String = "") -> void:
	mode = next_mode if [DEVELOPMENT, EXPORTED].has(next_mode) else _detect_mode()
	var default_repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	repository_root = next_repository_root.trim_suffix("/") if not next_repository_root.is_empty() else default_repository
	export_public_root = next_export_public_root.trim_suffix("/") if not next_export_public_root.is_empty() else _default_export_public_root()


static func get_default() -> RuntimeResourceLocator:
	if _default_instance == null:
		_default_instance = RuntimeResourceLocator.new()
	return _default_instance


func is_media_url(url: String) -> bool:
	return url.begins_with(RUNTIME_PREFIX) or url.begins_with(RUNTIME_PREFIX.trim_prefix("/"))


func is_text_url(url: String) -> bool:
	return url.begins_with(ASSETS_PREFIX) or url.begins_with(ASSETS_PREFIX.trim_prefix("/"))


func scene_json_url(scene_id: String) -> String:
	var value := scene_id.strip_edges()
	return "" if not _valid_id(value) else "/assets/scenes/%s.json" % value


func dialogue_graph_json_url(graph_id: String) -> String:
	var value := graph_id.strip_edges()
	return "" if not _valid_id(value) else "/assets/dialogues/graphs/%s.json" % value


func filter_json_url(filter_id: String) -> String:
	var value := filter_id.strip_edges()
	return "" if not _valid_id(value) else "/assets/data/filters/%s.json" % value


func data_subdir_json_url(subdir: String, file: String) -> String:
	var name := file.strip_edges()
	if name.is_empty():
		return ""
	if name.begins_with("/"):
		return name
	var directory := _normalize_relative(subdir)
	return "" if directory.is_empty() else "/assets/data/%s/%s" % [directory, name]


func scene_runtime_dir_url(scene_id: String) -> String:
	var value := scene_id.strip_edges()
	return "" if not _valid_id(value) else "/resources/runtime/scenes/%s" % value


func scene_runtime_asset_url(scene_id: String, ref: String) -> String:
	var value := ref.strip_edges().replace("\\", "/")
	if value.is_empty():
		return ""
	if _is_remote(value) or value.begins_with(ASSETS_PREFIX) or value.begins_with("assets/"):
		return value
	if value.begins_with(RUNTIME_PREFIX):
		return value
	if value.begins_with("resources/"):
		return "/" + value
	if _is_local_absolute(value):
		return value
	var relative := _normalize_relative(value)
	var directory := scene_runtime_dir_url(scene_id)
	return "" if relative.is_empty() or directory.is_empty() else directory + "/" + relative


func media_url_from_short_path(ref: String) -> String:
	var value := ref.strip_edges().replace("\\", "/")
	if value.is_empty():
		return ""
	if _is_remote(value) or value.begins_with(RUNTIME_PREFIX):
		return value
	if value.begins_with("resources/runtime/"):
		return "/" + value
	if value.begins_with(ASSETS_PREFIX) or value.begins_with("assets/") or value.begins_with("/"):
		return ""
	if _is_windows_absolute(value):
		return value
	var relative := _normalize_relative(value.trim_prefix("images/"))
	return "" if relative.is_empty() else "/resources/runtime/images/" + relative


func media_url_for_root(root_kind: String, ref: String) -> String:
	var value := ref.strip_edges().replace("\\", "/")
	if value.is_empty() or not ["images", "audio", "animation", "scenes"].has(root_kind):
		return ""
	if value.begins_with(RUNTIME_PREFIX):
		return value
	if value.begins_with(ASSETS_PREFIX) or value.begins_with("assets/"):
		return ""
	var relative := _normalize_relative(value)
	return "" if relative.is_empty() else "/resources/runtime/%s/%s" % [root_kind, relative]


func resolve_anim_relative(manifest_url: String, ref: String) -> String:
	var value := ref.strip_edges()
	if value.is_empty():
		return value
	if value.begins_with("http://") or value.begins_with("https://"):
		return value
	if value.begins_with("/assets/") or value.begins_with("/resources/"):
		return value
	var base := manifest_url
	var last_slash := base.rfind("/")
	if last_slash >= 0 and last_slash < base.length() - 1:
		base = base.substr(0, last_slash)
	var part := value.substr(2) if value.begins_with("./") else value
	var joined := "%s/%s" % [base, part]
	while joined.contains("//"):
		joined = joined.replace("//", "/")
	return joined if joined.begins_with("/") else "/%s" % joined


func resolve_url(url: String, kind: String = ANY) -> String:
	if not [TEXT, MEDIA, ANY].has(kind):
		return ""
	var value := url.strip_edges().replace("\\", "/").uri_decode()
	if value.is_empty() or _is_remote(value):
		return value
	var relative := ""
	if is_text_url(value):
		if kind == MEDIA:
			return ""
		relative = "assets/" + value.trim_prefix("/").trim_prefix("assets/")
	elif is_media_url(value):
		if kind == TEXT:
			return ""
		relative = "resources/runtime/" + value.trim_prefix("/").trim_prefix("resources/runtime/")
	elif _is_local_absolute(value):
		return value if kind == ANY else ""
	else:
		return ""
	if _normalize_relative(relative).is_empty():
		return ""
	if mode == DEVELOPMENT:
		return repository_root.path_join("public").path_join(relative)
	return export_public_root.path_join(relative)


func path_exists(path: String) -> bool:
	return FileAccess.file_exists(path) or DirAccess.dir_exists_absolute(path)


func _detect_mode() -> String:
	return DEVELOPMENT if OS.has_feature("editor") else EXPORTED


func _default_export_public_root() -> String:
	var executable_dir := OS.get_executable_path().get_base_dir()
	if OS.get_name() == "macOS": return executable_dir.get_base_dir().path_join("Resources/shared/public")
	return executable_dir.path_join("shared/public")


func _valid_id(value: String) -> bool:
	return not value.is_empty() and not value.contains("/") and not value.contains("\\") and value not in [".", ".."]


func _normalize_relative(value: String) -> String:
	var parts: Array[String] = []
	for raw_part in value.strip_edges().replace("\\", "/").split("/"):
		var part := str(raw_part)
		if part.is_empty() or part == ".":
			continue
		if part == "..":
			return ""
		parts.push_back(part)
	return "/".join(parts)


func _is_remote(value: String) -> bool:
	var lower := value.to_lower()
	return lower.begins_with("http://") or lower.begins_with("https://")


func _is_windows_absolute(value: String) -> bool:
	return value.length() >= 3 and value[1] == ":" and value[2] == "/" and value[0].to_lower() != value[0].to_upper()


func _is_local_absolute(value: String) -> bool:
	return value.begins_with("/") or value.begins_with("res://") or value.begins_with("user://") or _is_windows_absolute(value)
