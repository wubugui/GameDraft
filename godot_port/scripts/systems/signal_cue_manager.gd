class_name RuntimeSignalCueManager
extends RuntimeSystem

const DEFS_URL := "/assets/data/signal_cues.json"

var action_executor: RuntimeActionExecutor
var asset_manager: RuntimeAssetManager
var defs: Dictionary = {}
var in_flight: Dictionary = {}


func _init(actions: RuntimeActionExecutor) -> void:
	action_executor = actions


func init(ctx: Dictionary) -> void:
	asset_manager = ctx.get("assetManager")


func load_defs() -> bool:
	var raw: Variant = asset_manager.load_json(DEFS_URL) if asset_manager != null else null
	if not raw is Array:
		return false
	defs.clear()
	for definition: Variant in raw:
		if not definition is Dictionary:
			continue
		var id := str(definition.get("id", "")).strip_edges()
		if not id.is_empty() and definition.get("actions") is Array:
			defs[id] = definition.duplicate(true)
	return not defs.is_empty()


func has_cue(id: String) -> bool:
	return defs.has(id.strip_edges())


func play(id: String) -> bool:
	var key := id.strip_edges()
	var definition: Variant = defs.get(key)
	if not definition is Dictionary or in_flight.has(key):
		return false
	in_flight[key] = true
	await action_executor.execute_batch_await(definition.actions)
	in_flight.erase(key)
	return true


func deserialize(_data: Dictionary) -> void:
	in_flight.clear()


func destroy() -> void:
	defs.clear()
	in_flight.clear()
	asset_manager = null
