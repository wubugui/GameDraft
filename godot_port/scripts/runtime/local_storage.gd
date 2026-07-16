class_name RuntimeLocalStorage
extends RefCounted

const ROOT_ENV := "GAMEDRAFT_LOCAL_STORAGE_ROOT"
const DEFAULT_ROOT := "user://local-storage"


static func get_item(key: String) -> Variant:
	var file := FileAccess.open(_key_path(key), FileAccess.READ)
	return file.get_as_text() if file != null else null


static func set_item(key: String, value: String) -> bool:
	var path := _key_path(key)
	var directory := path.get_base_dir()
	if DirAccess.make_dir_recursive_absolute(directory) not in [OK, ERR_ALREADY_EXISTS]:
		return false
	var temporary := path + ".tmp"
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null:
		return false
	file.store_string(value)
	file.close()
	if FileAccess.file_exists(path) and DirAccess.remove_absolute(path) != OK:
		DirAccess.remove_absolute(temporary)
		return false
	if DirAccess.rename_absolute(temporary, path) != OK:
		DirAccess.remove_absolute(temporary)
		return false
	return true


static func remove_item(key: String) -> bool:
	var path := _key_path(key)
	return true if not FileAccess.file_exists(path) else DirAccess.remove_absolute(path) == OK


static func _key_path(key: String) -> String:
	var configured := OS.get_environment(ROOT_ENV).strip_edges()
	var root := configured if not configured.is_empty() else DEFAULT_ROOT
	return root.trim_suffix("/").path_join(key.uri_encode() + ".storage")
