extends Node

class Harness:
	extends RefCounted
	var state: Dictionary
	var distributed: Array = []
	var reloaded: Array[String] = []
	var fail_distribute_once := false
	var fail_scene := ""

	func _init(initial: Dictionary) -> void: state = initial.duplicate(true)
	func collect() -> Dictionary: return state.duplicate(true)
	func distribute(next: Dictionary) -> bool:
		distributed.push_back(next.duplicate(true))
		if fail_distribute_once:
			fail_distribute_once = false
			return false
		state = next.duplicate(true)
		return true
	func reload(scene_id: String) -> bool:
		reloaded.push_back(scene_id)
		await Engine.get_main_loop().process_frame
		return scene_id != fail_scene


func _ready() -> void:
	await _run()


func _run() -> void:
	var test_root := "user://save-manager-test-%s" % get_instance_id()
	_remove_tree(test_root)
	var previous_storage_root := OS.get_environment(RuntimeLocalStorage.ROOT_ENV)
	OS.set_environment(RuntimeLocalStorage.ROOT_ENV, test_root)
	var strings := RuntimeStringsProvider.new()
	var saved := {"sceneManager": {"currentSceneId": "dock"}, "dayManager": {"currentDay": 2}, "game": {"playTimeMs": 1234}, "flagStore": {"saved": true}}
	var saved_wire: Dictionary = JSON.parse_string(JSON.stringify(saved))
	var harness := Harness.new(saved)
	var manager := RuntimeSaveManager.new(Callable(harness, "collect"), Callable(harness, "distribute"), Callable(harness, "reload"), strings, "fallback")
	assert(not manager.save(-1) and not manager.save(3))
	manager.set_can_save_predicate(func() -> bool: return false)
	assert(not manager.save(0))
	manager.set_can_save_predicate(func() -> bool: return true)
	assert(manager.save(1) and manager.has_save(1) and manager.has_any_save())
	var payload: Dictionary = JSON.parse_string(manager.export_slot_payload(1))
	assert(payload.version == 1 and (payload.timestamp is int or payload.timestamp is float) and payload.systems == saved_wire)
	var meta: Dictionary = manager.get_slot_meta(1)
	assert(meta.slot == 1 and meta.sceneId == "dock" and meta.dayNumber == 2 and meta.playTimeMs == 1234)

	harness.state = {"sceneManager": {"currentSceneId": "street"}, "flagStore": {"live": true}}
	assert(await manager.load(1))
	assert(harness.state == saved_wire and harness.reloaded == ["dock"])

	# Scene reload failure: saved state is applied, then full live snapshot + live scene are restored.
	harness.state = {"sceneManager": {"currentSceneId": "street"}, "flagStore": {"live": true}}
	harness.distributed.clear()
	harness.reloaded.clear()
	harness.fail_scene = "dock"
	assert(not await manager.load(1))
	assert(harness.distributed == [saved_wire, {"sceneManager": {"currentSceneId": "street"}, "flagStore": {"live": true}}])
	assert(harness.reloaded == ["dock", "street"])
	harness.fail_scene = ""

	# Distributor failure also rolls back before any saved-scene reload.
	harness.state = {"sceneManager": {"currentSceneId": "street"}, "flagStore": {"live": true}}
	harness.distributed.clear()
	harness.reloaded.clear()
	harness.fail_distribute_once = true
	assert(not await manager.load(1))
	assert(harness.distributed.size() == 2 and harness.distributed[1] == harness.state)
	assert(harness.reloaded == ["street"])

	# Corrupt/truncated/missing-system payloads fail before distributor/reloader.
	assert(RuntimeLocalStorage.set_item("gamedraft_save_0", "{broken"))
	harness.distributed.clear(); harness.reloaded.clear()
	assert(not await manager.load(0) and harness.distributed.is_empty() and harness.reloaded.is_empty())
	assert(RuntimeLocalStorage.set_item("gamedraft_save_0", JSON.stringify({"version": 1, "timestamp": 1})))
	assert(not await manager.load(0) and harness.distributed.is_empty())
	manager.delete_slot(0)

	# Browser/Godot interop uses the exact same raw payload; import/export never rewrites systems.
	var exported: String = manager.export_slot_payload(1)
	assert(not exported.is_empty())
	manager.delete_slot(1)
	assert(not manager.has_save(1))
	assert(manager.import_slot_payload(2, exported))
	assert(JSON.parse_string(manager.export_slot_payload(2)).systems == saved_wire)
	manager.delete_slot(2)
	assert(not manager.has_any_save())
	OS.set_environment(RuntimeLocalStorage.ROOT_ENV, previous_storage_root)
	_remove_tree(test_root)
	print("SaveManager atomic/interoperable test: PASS")
	get_tree().quit(0)

func _remove_tree(path: String) -> void:
	if not DirAccess.dir_exists_absolute(path): return
	var dir := DirAccess.open(path)
	if dir == null: return
	for name in dir.get_files(): DirAccess.remove_absolute(path.path_join(name))
	for name in dir.get_directories(): _remove_tree(path.path_join(name))
	DirAccess.remove_absolute(path)
