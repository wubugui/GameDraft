class_name RuntimeMapUI
extends RuntimeTextPanel
var events: RuntimeEventBus
var asset_manager: RuntimeAssetManager
var evaluate_conditions := Callable()
var nodes: Array = []
var current_scene_id := ""
func _init(renderer: RuntimeRenderer, event_bus: RuntimeEventBus, assets: RuntimeAssetManager, strings: RuntimeStringsProvider) -> void: super._init(renderer, strings); events = event_bus; asset_manager = assets
func load_config() -> bool: var raw: Variant = asset_manager.load_json("/assets/data/map_config.json"); nodes = raw.get("nodes", []).duplicate(true) if raw is Dictionary and raw.get("nodes") is Array else (raw.duplicate(true) if raw is Array else []); return not nodes.is_empty()
func set_condition_evaluator(callback: Callable) -> void: evaluate_conditions = callback
func set_current_scene(id: String) -> void:
	current_scene_id = id
	if is_open(): refresh()
func panel_title() -> String: return resolve(strings.get_text("map", "title"))
func get_configured_scene_ids() -> Array:
	var out: Array = []
	for node: Variant in nodes:
		if node is Dictionary and not out.has(node.get("sceneId")): out.push_back(node.sceneId)
	return out
func refresh() -> void:
	if content == null: return
	title_label.text = panel_title()
	var lines: Array[String] = []; var actions: Array = []
	for index in nodes.size():
		var node: Variant = nodes[index]
		if not node is Dictionary or node.get("runtimeVisible") == false or node.get("devOnly") == true: continue
		var unlocked: bool = node.get("unlockConditions", []).is_empty() or (evaluate_conditions.is_valid() and evaluate_conditions.call(node.unlockConditions) == true)
		if unlocked or str(node.get("sceneId")) == current_scene_id or node.get("lockedDisplay") in ["hint", "secret"]:
			var scene_id := str(node.get("sceneId", "")); var label := resolve(str(node.get("name", "???"))) if unlocked or scene_id == current_scene_id else strings.get_text("map", "locked"); lines.push_back("%s. %s%s" % [index + 1, label, " ←" if scene_id == current_scene_id else ""]); actions.push_back({"id": scene_id, "label": label, "enabled": unlocked and scene_id != current_scene_id, "callback": Callable(self, "_travel").bind(scene_id)})
	content.text = "\n".join(lines) if not lines.is_empty() else strings.get_text("map", "noData")
	set_action_rows(actions)
func debug_travel(scene_id: String) -> void:
	_travel(scene_id)
func _travel(scene_id: String) -> void:
	if scene_id.is_empty() or scene_id == current_scene_id: return
	for node: Variant in nodes:
		if node is Dictionary and str(node.get("sceneId")) == scene_id and (node.get("unlockConditions", []).is_empty() or (evaluate_conditions.is_valid() and evaluate_conditions.call(node.unlockConditions) == true)):
			close()
			events.emit("map:travel", {"sceneId": scene_id})
			return
