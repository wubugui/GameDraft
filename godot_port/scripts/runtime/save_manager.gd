class_name RuntimeSaveManager
extends RefCounted

const STORAGE_PREFIX := "gamedraft_save_"
const MAX_SLOTS := 3
const SAVE_VERSION := 1

var _collector: Callable
var _distributor: Callable
var _scene_reloader: Callable
var _strings: RuntimeStringsProvider
var _fallback_scene: String
var _storage_root: String
var _can_save := Callable()
var _destroyed := false
var _operation_epoch := 0
var last_error := ""


func _init(
	collector: Callable,
	distributor: Callable,
	scene_reloader: Callable,
	strings: RuntimeStringsProvider,
	fallback_scene: String,
	storage_root: String = "user://saves",
) -> void:
	_collector = collector
	_distributor = distributor
	_scene_reloader = scene_reloader
	_strings = strings
	_fallback_scene = fallback_scene
	_storage_root = storage_root.trim_suffix("/")


func set_fallback_scene(scene: String) -> void:
	_fallback_scene = scene


func set_can_save_predicate(callback: Callable) -> void:
	_can_save = callback


func save(slot: int) -> bool:
	if _destroyed or not _valid_slot(slot):
		return false
	if not _can_save.is_null() and _can_save.is_valid() and not bool(_can_save.call()):
		return false
	var systems: Variant = _collector.call()
	if not systems is Dictionary:
		return false
	var payload := {
		"version": SAVE_VERSION,
		"timestamp": int(Time.get_unix_time_from_system() * 1000.0),
		"systems": systems,
	}
	return _write_payload_atomic(_slot_path(slot), payload)


func load(slot: int) -> bool:
	if _destroyed or not _valid_slot(slot):
		return false
	var payload := _read_payload(_slot_path(slot))
	if payload.is_empty():
		return false
	_operation_epoch += 1
	var epoch := _operation_epoch
	var snapshot: Variant = _collector.call()
	if not snapshot is Dictionary:
		return false
	var snapshot_scene := _scene_id(snapshot)
	var distribute_result: Variant = _distributor.call(payload.systems)
	if distribute_result == false:
		await _rollback(snapshot, snapshot_scene, epoch)
		return false
	if _destroyed or epoch != _operation_epoch:
		return false
	var target_scene := _scene_id(payload.systems)
	var reload_result: Variant = await _scene_reloader.call(target_scene)
	if reload_result == false or _destroyed or epoch != _operation_epoch:
		if not _destroyed and epoch == _operation_epoch:
			await _rollback(snapshot, snapshot_scene, epoch)
		return false
	return true


func get_slot_meta(slot: int) -> Variant:
	if not _valid_slot(slot):
		return null
	var payload := _read_payload(_slot_path(slot))
	if payload.is_empty():
		return null
	var systems: Dictionary = payload.systems
	var scene: Dictionary = systems.get("sceneManager", {}) if systems.get("sceneManager") is Dictionary else {}
	var day: Dictionary = systems.get("dayManager", {}) if systems.get("dayManager") is Dictionary else {}
	var game: Dictionary = systems.get("game", {}) if systems.get("game") is Dictionary else {}
	var scene_id := str(scene.get("currentSceneId", "unknown"))
	if scene_id.is_empty(): scene_id = "unknown"
	return {
		"slot": slot,
		"timestamp": int(payload.get("timestamp", 0)),
		"sceneId": scene_id,
		"sceneName": str(game.get("sceneName", scene_id if scene_id != "unknown" else _strings.get_text("menu", "unknownScene"))),
		"dayNumber": int(day.get("currentDay", 1)),
		"playTimeMs": int(game.get("playTimeMs", 0)),
	}


func has_save(slot: int) -> bool:
	return _valid_slot(slot) and FileAccess.file_exists(_slot_path(slot))


func delete_slot(slot: int) -> void:
	if _valid_slot(slot) and FileAccess.file_exists(_slot_path(slot)):
		DirAccess.remove_absolute(_slot_path(slot))


func has_any_save() -> bool:
	for slot in MAX_SLOTS:
		if has_save(slot): return true
	return false


func export_slot_payload(slot: int, destination: String) -> bool:
	if not _valid_slot(slot): return false
	var payload := _read_payload(_slot_path(slot))
	return not payload.is_empty() and _write_payload_atomic(destination, payload)


func import_slot_payload(slot: int, source: String) -> bool:
	if not _valid_slot(slot): return false
	var payload := _read_payload(source)
	return not payload.is_empty() and _write_payload_atomic(_slot_path(slot), payload)


func read_slot_payload(slot: int) -> Dictionary:
	return {} if not _valid_slot(slot) else _read_payload(_slot_path(slot))


func destroy() -> void:
	_destroyed = true
	_operation_epoch += 1
	_collector = Callable()
	_distributor = Callable()
	_scene_reloader = Callable()
	_can_save = Callable()


func _rollback(snapshot: Dictionary, scene_id: String, epoch: int) -> void:
	if _destroyed or epoch != _operation_epoch:
		return
	_distributor.call(snapshot)
	if _destroyed or epoch != _operation_epoch:
		return
	await _scene_reloader.call(scene_id)


func _read_payload(path: String) -> Dictionary:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		return {}
	var parser := JSON.new()
	if parser.parse(file.get_as_text()) != OK:
		last_error = "save JSON parse failed: %s" % parser.get_error_message()
		return {}
	var parsed: Variant = parser.data
	if not parsed is Dictionary or not parsed.get("systems") is Dictionary:
		last_error = "save payload missing systems object"
		return {}
	return parsed


func _write_payload_atomic(path: String, payload: Dictionary) -> bool:
	var directory := path.get_base_dir()
	if not directory.is_empty() and DirAccess.make_dir_recursive_absolute(directory) not in [OK, ERR_ALREADY_EXISTS]:
		return false
	var temporary := path + ".tmp"
	var file := FileAccess.open(temporary, FileAccess.WRITE)
	if file == null:
		return false
	file.store_string(JSON.stringify(payload, "  ") + "\n")
	file.close()
	if FileAccess.file_exists(path):
		if DirAccess.remove_absolute(path) != OK:
			DirAccess.remove_absolute(temporary)
			return false
	if DirAccess.rename_absolute(temporary, path) != OK:
		DirAccess.remove_absolute(temporary)
		return false
	return true


func _slot_path(slot: int) -> String:
	return _storage_root.path_join("%s%s.json" % [STORAGE_PREFIX, slot])


func _scene_id(systems: Dictionary) -> String:
	var scene: Variant = systems.get("sceneManager")
	if scene is Dictionary:
		var id := str(scene.get("currentSceneId", ""))
		if not id.is_empty(): return id
	return _fallback_scene


func _valid_slot(slot: int) -> bool:
	return slot >= 0 and slot < MAX_SLOTS
