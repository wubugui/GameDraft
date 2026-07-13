class_name RuntimeInteractionSystem
extends RuntimeSystem

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var input_manager: RuntimeInputManager
var condition_evaluator: RuntimeConditionEvaluator
var hotspots: Array[RuntimeHotspot] = []
var npcs: Array[RuntimeNpc] = []
var _nearest_target: Variant = null
var _auto_triggered_in_range: Dictionary = {}
var _condition_context_factory := Callable()
var _player_position_getter := Callable()
var _update_enabled_getter := Callable()
var _hotspot_base_reader := Callable()
var _npc_base_reader := Callable()
var _plane_policy := Callable()


func _init(events: RuntimeEventBus, flags: RuntimeFlagStore, input: RuntimeInputManager, evaluator: RuntimeConditionEvaluator) -> void:
	event_bus = events; flag_store = flags; input_manager = input; condition_evaluator = evaluator


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void: _condition_context_factory = factory
func set_player_position_getter(getter: Callable = Callable()) -> void: _player_position_getter = getter
func set_update_enabled_getter(getter: Callable = Callable()) -> void: _update_enabled_getter = getter
func set_entity_base_visibility_readers(hotspot_reader: Callable = Callable(), npc_reader: Callable = Callable()) -> void: _hotspot_base_reader = hotspot_reader; _npc_base_reader = npc_reader
func set_plane_interaction_policy(getter: Variant = null) -> void: _plane_policy = getter if getter is Callable else Callable()


func set_entities(next_hotspots: Array, next_npcs: Array) -> void: set_hotspots(next_hotspots); set_npcs(next_npcs)
func set_hotspots(next: Array) -> void:
	clear_hotspots()
	for item: Variant in next:
		if item is RuntimeHotspot: hotspots.push_back(item)
func set_npcs(next: Array) -> void:
	clear_npcs()
	for item: Variant in next:
		if item is RuntimeNpc: npcs.push_back(item)
func clear_hotspots() -> void: hotspots.clear(); _clear_nearest_if_kind("hotspot"); _auto_triggered_in_range.clear()
func clear_npcs() -> void: npcs.clear(); _clear_nearest_if_kind("npc")


func update(_dt: float) -> void:
	if not _update_enabled_getter.is_null() and _update_enabled_getter.is_valid() and not bool(_update_enabled_getter.call()): return
	if _player_position_getter.is_null() or not _player_position_getter.is_valid() or (hotspots.is_empty() and npcs.is_empty()): return
	var position: Variant = _player_position_getter.call()
	if not position is Dictionary: return
	var closest: Variant = null; var closest_distance := INF
	var context: Variant = _condition_context_factory.call() if not _condition_context_factory.is_null() and _condition_context_factory.is_valid() else null
	var policy: Variant = _plane_policy.call() if not _plane_policy.is_null() and _plane_policy.is_valid() else null
	for hotspot: RuntimeHotspot in hotspots:
		var conditions: Variant = hotspot.def.get("conditions"); var condition_ok := _eval_conditions(conditions, context); var base := bool(_hotspot_base_reader.call(hotspot)) if not _hotspot_base_reader.is_null() and _hotspot_base_reader.is_valid() else true
		hotspot.set_derived_base_enabled(base); hotspot.set_condition_enabled(condition_ok if hotspot.def.get("conditionHidesEntity") == true and conditions is Array and not conditions.is_empty() else true)
		var distance := Vector2(float(position.get("x", 0)) - hotspot.get_center_x(), float(position.get("y", 0)) - hotspot.get_center_y()).length()
		if hotspot.def.get("autoTrigger") == true and _auto_triggered_in_range.has(hotspot) and distance > hotspot.get_interaction_range(): _auto_triggered_in_range.erase(hotspot)
		if not hotspot.get_active() or not hotspot_offers_player_interaction(hotspot.def) or (policy is Dictionary and policy.get("canInteractHotspots") == false) or (policy is Dictionary and policy.get("canPickup") == false and hotspot.def.get("type") == "pickup") or (conditions is Array and not conditions.is_empty() and not condition_ok): continue
		if distance <= hotspot.get_interaction_range() and distance < closest_distance: closest = {"kind": "hotspot", "instance": hotspot}; closest_distance = distance
	for npc: RuntimeNpc in npcs:
		var conditions: Variant = npc.def.get("conditions"); var condition_ok := _eval_conditions(conditions, context); var base := bool(_npc_base_reader.call(npc)) if not _npc_base_reader.is_null() and _npc_base_reader.is_valid() else true
		npc.set_derived_base_visible(base); npc.set_condition_visible(condition_ok if npc.def.get("conditionHidesEntity") == true and conditions is Array and not conditions.is_empty() else true)
		if not npc.container.visible or (policy is Dictionary and policy.get("canTalkNpcs") == false) or (conditions is Array and not conditions.is_empty() and not condition_ok): continue
		var distance := Vector2(float(position.get("x", 0)) - npc.get_x(), float(position.get("y", 0)) - npc.get_y()).length()
		if distance <= npc.get_interaction_range() and distance < closest_distance: closest = {"kind": "npc", "instance": npc}; closest_distance = distance
	if not _same_target(_nearest_target, closest): _hide_current_prompt(); _nearest_target = closest; _show_current_prompt()
	if closest != null and input_manager.was_key_just_pressed("KeyE"):
		if closest.kind == "hotspot" and closest.instance.def.get("autoTrigger") == true: _auto_triggered_in_range[closest.instance] = true
		_trigger_target(closest)
	elif closest != null and closest.kind == "hotspot" and closest.instance.def.get("autoTrigger") == true and not _auto_triggered_in_range.has(closest.instance): _auto_triggered_in_range[closest.instance] = true; _trigger_target(closest)


static func hotspot_offers_player_interaction(definition: Dictionary) -> bool:
	var data: Variant = definition.get("data")
	if not data is Dictionary: return false
	match str(definition.get("type", "")):
		"inspect": return not str(data.get("graphId", "")).strip_edges().is_empty() or not str(data.get("text", "")).strip_edges().is_empty() or (data.get("actions") is Array and not data.actions.is_empty())
		"pickup": return not str(data.get("itemId", "")).strip_edges().is_empty()
		"transition": return not str(data.get("targetScene", "")).strip_edges().is_empty()
		"encounter": return not str(data.get("encounterId", "")).strip_edges().is_empty()
		"npc": return not str(data.get("npcId", "")).strip_edges().is_empty()
	return false


func get_player_visible_entities() -> Array:
	var output: Array = []
	for hotspot: RuntimeHotspot in hotspots:
		if not hotspot.get_active(): continue
		if hotspot.def.get("type") == "transition": output.push_back({"kind": "exit", "label": str(hotspot.def.get("label", "出口")), "x": hotspot.get_center_x(), "y": hotspot.get_center_y(), "leadsTo": hotspot.def.get("data", {}).get("targetScene")})
		else:
			var label := str(hotspot.def.get("label", "")).strip_edges(); var item := {"kind": "hotspot", "label": label if not label.is_empty() else hotspot.get_id(), "x": hotspot.get_center_x(), "y": hotspot.get_center_y()}; var image: Variant = hotspot.def.get("displayImage", {}).get("image")
			if image is String and not image.is_empty(): item.image = image
			output.push_back(item)
	for npc: RuntimeNpc in npcs:
		if npc.container.visible: output.push_back({"kind": "npc", "label": str(npc.def.get("name", "")), "x": npc.get_x(), "y": npc.get_y()})
	return output


func get_nearest_prompt() -> Variant:
	if _nearest_target == null: return null
	var instance: Variant = _nearest_target.instance
	return {"kind": _nearest_target.kind, "label": str(instance.def.get("label", instance.get_id())) if _nearest_target.kind == "hotspot" else str(instance.def.get("name", "")), "x": instance.get_center_x() if _nearest_target.kind == "hotspot" else instance.get_x(), "y": instance.get_center_y() if _nearest_target.kind == "hotspot" else instance.get_y()}


func debug_list_interactables(px: float, py: float) -> Array:
	var output: Array = []; var policy: Variant = _plane_policy.call() if not _plane_policy.is_null() and _plane_policy.is_valid() else null; var context: Variant = _condition_context_factory.call() if not _condition_context_factory.is_null() and _condition_context_factory.is_valid() else null
	for hotspot: RuntimeHotspot in hotspots:
		var available: bool = hotspot.get_active() and hotspot_offers_player_interaction(hotspot.def) and (not policy is Dictionary or (policy.get("canInteractHotspots") != false and (policy.get("canPickup") != false or hotspot.def.get("type") != "pickup"))) and _eval_conditions(hotspot.def.get("conditions"), context); var distance := Vector2(px - hotspot.get_center_x(), py - hotspot.get_center_y()).length()
		output.push_back({"kind": "hotspot", "id": hotspot.get_id(), "type": hotspot.def.get("type"), "x": hotspot.get_center_x(), "y": hotspot.get_center_y(), "interactionRange": hotspot.get_interaction_range(), "available": available, "inRange": available and distance <= hotspot.get_interaction_range(), "distance": roundf(distance * 10.0) / 10.0})
	for npc: RuntimeNpc in npcs:
		var available: bool = npc.container.visible and (not policy is Dictionary or policy.get("canTalkNpcs") != false) and _eval_conditions(npc.def.get("conditions"), context); var distance := Vector2(px - npc.get_x(), py - npc.get_y()).length()
		output.push_back({"kind": "npc", "id": npc.get_id(), "x": npc.get_x(), "y": npc.get_y(), "interactionRange": npc.get_interaction_range(), "available": available, "inRange": available and distance <= npc.get_interaction_range(), "distance": roundf(distance * 10.0) / 10.0})
	return output


func destroy() -> void: clear_hotspots(); clear_npcs(); _nearest_target = null; _auto_triggered_in_range.clear(); _condition_context_factory = Callable(); _player_position_getter = Callable(); _update_enabled_getter = Callable(); _hotspot_base_reader = Callable(); _npc_base_reader = Callable(); _plane_policy = Callable()
func _eval_conditions(conditions: Variant, context: Variant) -> bool:
	if not conditions is Array or conditions.is_empty(): return true
	if context is Dictionary: return condition_evaluator.evaluate_list(conditions, context)
	return flag_store.check_conditions(conditions)
func _same_target(a: Variant, b: Variant) -> bool: return (a == null and b == null) or (a is Dictionary and b is Dictionary and a.kind == b.kind and a.instance == b.instance)
func _clear_nearest_if_kind(kind: String) -> void:
	if _nearest_target is Dictionary and _nearest_target.kind == kind: _hide_current_prompt(); _nearest_target = null
func _hide_current_prompt() -> void:
	if _nearest_target is Dictionary: _nearest_target.instance.hide_prompt()
func _show_current_prompt() -> void:
	if not _nearest_target is Dictionary: return
	if _nearest_target.kind == "npc" or _nearest_target.instance.def.get("autoTrigger") != true: _nearest_target.instance.show_prompt()
func _trigger_target(target: Dictionary) -> void:
	if target.kind == "hotspot": event_bus.emit("hotspot:triggered", {"hotspot": target.instance, "def": target.instance.def})
	else: event_bus.emit("npc:interact", {"npc": target.instance})
