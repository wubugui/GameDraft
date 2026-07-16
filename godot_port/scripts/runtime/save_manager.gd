class_name RuntimeSaveManager
extends RefCounted

const RuntimeLocalStorageScript := preload("res://scripts/runtime/local_storage.gd")
const STORAGE_PREFIX := "gamedraft_save_"
const MAX_SLOTS := 3
const SAVE_VERSION := 1

var _collector: Callable
var _distributor: Callable
var _scene_reloader: Callable
var _fallback_scene: String
var _strings: RuntimeStringsProvider
var _can_save: Variant = null


func _init(
	collector: Callable,
	distributor: Callable,
	scene_reloader: Callable,
	strings: RuntimeStringsProvider,
	fallback_scene: String,
) -> void:
	_collector = collector
	_distributor = distributor
	_scene_reloader = scene_reloader
	_strings = strings
	_fallback_scene = fallback_scene


func set_fallback_scene(scene: String) -> void:
	_fallback_scene = scene


func set_can_save_predicate(callback: Callable) -> void:
	_can_save = callback


func save(slot: int) -> bool:
	if slot < 0 or slot >= MAX_SLOTS:
		return false
	if _can_save is Callable and _can_save.is_valid() and not bool(_can_save.call()):
		return false
	var systems: Variant = _collector.call()
	if not systems is Dictionary:
		return false
	var payload := {
		"version": SAVE_VERSION,
		"timestamp": int(Time.get_unix_time_from_system() * 1000.0),
		"systems": systems,
	}
	return RuntimeLocalStorageScript.set_item(STORAGE_PREFIX + str(slot), JSON.stringify(payload))


func load(slot: int) -> bool:
	if slot < 0 or slot >= MAX_SLOTS:
		return false
	var raw: Variant = RuntimeLocalStorageScript.get_item(STORAGE_PREFIX + str(slot))
	if not raw is String or raw.is_empty():
		return false
	var parser := JSON.new()
	if parser.parse(raw) != OK:
		return false
	var payload: Variant = parser.data
	if not payload is Dictionary or not payload.get("systems") is Dictionary:
		return false
	if payload.get("version") is float and float(payload.version) > SAVE_VERSION:
		push_warning("SaveManager: 存档版本 %s 高于当前支持的 %s，将尽力加载，部分数据可能缺失" % [payload.version, SAVE_VERSION])
	var snapshot: Variant = _collector.call()
	if not snapshot is Dictionary:
		return false
	var snapshot_scene_data: Variant = snapshot.get("sceneManager")
	var snapshot_scene_value: Variant = snapshot_scene_data.get("currentSceneId") if snapshot_scene_data is Dictionary else null
	var snapshot_scene_id := str(snapshot_scene_value) if snapshot_scene_value != null else _fallback_scene
	var distribute_result: Variant = _distributor.call(payload.systems)
	if distribute_result == false:
		_distributor.call(snapshot)
		await _scene_reloader.call(snapshot_scene_id)
		return false
	var scene_data: Variant = payload.systems.get("sceneManager")
	var scene_value: Variant = scene_data.get("currentSceneId") if scene_data is Dictionary else null
	var scene_id := str(scene_value) if scene_value != null else _fallback_scene
	var reload_result: Variant = await _scene_reloader.call(scene_id)
	if reload_result == false:
		_distributor.call(snapshot)
		await _scene_reloader.call(snapshot_scene_id)
		return false
	return true


func get_slot_meta(slot: int) -> Variant:
	if slot < 0 or slot >= MAX_SLOTS:
		return null
	var raw: Variant = RuntimeLocalStorageScript.get_item(STORAGE_PREFIX + str(slot))
	if not raw is String or raw.is_empty():
		return null
	var parser := JSON.new()
	if parser.parse(raw) != OK:
		return null
	var payload: Variant = parser.data
	if not payload is Dictionary or not payload.get("systems") is Dictionary:
		return null
	var systems: Dictionary = payload.systems
	var scene: Variant = systems.get("sceneManager")
	var day: Variant = systems.get("dayManager")
	var game: Variant = systems.get("game")
	var scene_value: Variant = scene.get("currentSceneId") if scene is Dictionary else null
	var scene_id := str(scene_value) if scene_value != null else "unknown"
	var scene_name_value: Variant = game.get("sceneName") if game is Dictionary else null
	var scene_name: String
	if scene_name_value != null:
		scene_name = str(scene_name_value)
	elif scene_value != null:
		scene_name = str(scene_value)
	else:
		scene_name = _strings.get_text("menu", "unknownScene")
	var timestamp: Variant = payload.get("timestamp")
	var day_number: Variant = day.get("currentDay") if day is Dictionary else null
	var play_time: Variant = game.get("playTimeMs") if game is Dictionary else null
	return {
		"slot": slot,
		"timestamp": timestamp if timestamp != null else 0,
		"sceneId": scene_id,
		"sceneName": scene_name,
		"dayNumber": day_number if day_number != null else 1,
		"playTimeMs": play_time if play_time != null else 0,
	}


func has_save(slot: int) -> bool:
	return RuntimeLocalStorageScript.get_item(STORAGE_PREFIX + str(slot)) != null


func delete_slot(slot: int) -> void:
	RuntimeLocalStorageScript.remove_item(STORAGE_PREFIX + str(slot))


func has_any_save() -> bool:
	for slot in MAX_SLOTS:
		if has_save(slot):
			return true
	return false


func export_slot_payload(slot: int) -> Variant:
	if slot < 0 or slot >= MAX_SLOTS:
		return null
	var raw: Variant = RuntimeLocalStorageScript.get_item(STORAGE_PREFIX + str(slot))
	if not raw is String or raw.is_empty():
		return null
	var parser := JSON.new()
	if parser.parse(raw) != OK:
		return null
	var parsed: Variant = parser.data
	return raw if parsed is Dictionary and parsed.get("systems") is Dictionary else null


func import_slot_payload(slot: int, raw: String) -> bool:
	if slot < 0 or slot >= MAX_SLOTS or raw.strip_edges().is_empty():
		return false
	var parser := JSON.new()
	if parser.parse(raw) != OK:
		return false
	var parsed: Variant = parser.data
	if not parsed is Dictionary or not parsed.get("systems") is Dictionary:
		return false
	return RuntimeLocalStorageScript.set_item(STORAGE_PREFIX + str(slot), JSON.stringify(parsed))
