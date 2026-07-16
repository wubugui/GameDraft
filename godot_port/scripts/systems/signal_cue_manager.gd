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


func update(_dt: float) -> void:
	return


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	return


func destroy() -> void:
	defs.clear()
	in_flight.clear()


func load_defs() -> void:
	var loaded: Variant = asset_manager.load_json(DEFS_URL) if asset_manager != null else null
	if not loaded is Array:
		push_warning("SignalCueManager: signal_cues.json not found")
		return
	for definition: Variant in loaded:
		var id := ""
		if definition is Dictionary and definition.get("id") is String:
			id = definition.id.strip_edges()
		if id.is_empty() or not definition is Dictionary or not definition.get("actions") is Array:
			push_warning("SignalCueManager: 非法 cue 配置，已跳过 %s" % str(definition))
			continue
		defs[id] = definition


func play(cue_id: Variant) -> void:
	var id := ("" if cue_id == null else str(cue_id)).strip_edges()
	var definition: Variant = defs.get(id)
	if not definition is Dictionary:
		push_warning("SignalCueManager: unknown signal cue \"%s\"" % id)
		return
	if in_flight.has(id):
		push_warning("SignalCueManager: cue \"%s\" 重入被忽略" % id)
		return
	in_flight[id] = true
	await action_executor.execute_batch_await(definition.actions)
	in_flight.erase(id)
