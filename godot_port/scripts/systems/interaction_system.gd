class_name RuntimeInteractionSystem
extends RuntimeSystem

const RuntimeConditionEvalBridgeScript := preload("res://scripts/runtime/condition_eval_bridge.gd")
const RuntimeHotspotInteractionScript := preload("res://scripts/runtime/hotspot_interaction.gd")

var hotspots: Array = []
var npcs: Array = []
var _nearest_target: Variant = null
var _auto_triggered_in_range: Dictionary = {}
var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var input_manager: RuntimeInputManager
var _condition_context_factory := Callable()
var _player_position_getter := Callable()
var _hotspot_base_reader := Callable()
var _npc_base_reader := Callable()
var _plane_policy := Callable()


func _init(events: RuntimeEventBus, flags: RuntimeFlagStore, input: RuntimeInputManager) -> void:
	event_bus = events
	flag_store = flags
	input_manager = input


func init(_ctx: Dictionary) -> void:
	return


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	return


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void:
	_condition_context_factory = factory


func set_entity_base_visibility_readers(
	hotspot_reader: Callable = Callable(),
	npc_reader: Callable = Callable(),
) -> void:
	_hotspot_base_reader = hotspot_reader
	_npc_base_reader = npc_reader


func _eval_conditions_list(conditions: Variant) -> bool:
	if not conditions is Array or conditions.is_empty():
		return true
	var context: Variant = _condition_context_factory.call() \
		if not _condition_context_factory.is_null() and _condition_context_factory.is_valid() else null
	return _eval_with(conditions, context)


func _eval_with(conditions: Variant, context: Variant) -> bool:
	if not conditions is Array or conditions.is_empty():
		return true
	if context is Dictionary:
		return RuntimeConditionEvalBridgeScript.evaluate_condition_expr_list(conditions, context)
	return flag_store.check_conditions(conditions)


func set_player_position_getter(getter: Callable) -> void:
	_player_position_getter = getter


func set_plane_interaction_policy(getter: Variant = null) -> void:
	_plane_policy = getter if getter is Callable else Callable()


func set_hotspots(next_hotspots: Array) -> void:
	clear_hotspots()
	hotspots = next_hotspots


func clear_hotspots() -> void:
	hotspots = []
	_clear_nearest_if_kind("hotspot")
	_auto_triggered_in_range.clear()


func set_npcs(next_npcs: Array) -> void:
	clear_npcs()
	npcs = next_npcs


func clear_npcs() -> void:
	npcs = []
	_clear_nearest_if_kind("npc")


func _clear_nearest_if_kind(kind: String) -> void:
	if _nearest_target is Dictionary and _nearest_target.kind == kind:
		if kind == "hotspot":
			var hotspot: Variant = _nearest_target.get("hotspot")
			if hotspot != null: hotspot.hide_prompt()
		if kind == "npc":
			var npc: Variant = _nearest_target.get("npc")
			if npc != null: npc.hide_prompt()
		_nearest_target = null


func _apply_hotspot_visibility_and_base(hotspot: RuntimeHotspot, context: Variant) -> bool:
	var conditions: Variant = hotspot.def.get("conditions")
	var condition_ok := _eval_with(conditions, context)
	var base: bool = _hotspot_base_reader.call(hotspot) == true \
		if not _hotspot_base_reader.is_null() and _hotspot_base_reader.is_valid() else true
	var hide_when_fail: bool = hotspot.def.get("conditionHidesEntity") == true \
		and conditions is Array and not conditions.is_empty()
	hotspot.set_derived_base_enabled(base)
	hotspot.set_condition_enabled(condition_ok if hide_when_fail else true)
	return condition_ok


func _apply_npc_visibility_and_base(npc: RuntimeNpc, context: Variant) -> bool:
	var conditions: Variant = npc.def.get("conditions")
	var condition_ok := _eval_with(conditions, context)
	var base: bool = _npc_base_reader.call(npc) == true \
		if not _npc_base_reader.is_null() and _npc_base_reader.is_valid() else true
	var hide_when_fail: bool = npc.def.get("conditionHidesEntity") == true \
		and conditions is Array and not conditions.is_empty()
	npc.set_derived_base_visible(base)
	npc.set_condition_visible(condition_ok if hide_when_fail else true)
	return condition_ok


func update(_dt: float) -> void:
	if _player_position_getter.is_null() or not _player_position_getter.is_valid():
		return
	if hotspots.is_empty() and npcs.is_empty():
		return

	var position: Dictionary = _player_position_getter.call()
	var closest_target: Variant = null
	var closest_distance := INF
	var context: Variant = _condition_context_factory.call() \
		if not _condition_context_factory.is_null() and _condition_context_factory.is_valid() else null
	var policy: Variant = _plane_policy.call() \
		if not _plane_policy.is_null() and _plane_policy.is_valid() else null

	for hotspot: RuntimeHotspot in hotspots:
		var condition_ok := _apply_hotspot_visibility_and_base(hotspot, context)

		if hotspot.def.get("autoTrigger") == true and _auto_triggered_in_range.has(hotspot):
			var auto_dx := float(position.x) - hotspot.get_center_x()
			var auto_dy := float(position.y) - hotspot.get_center_y()
			if sqrt(auto_dx * auto_dx + auto_dy * auto_dy) > hotspot.get_interaction_range():
				_auto_triggered_in_range.erase(hotspot)

		if not hotspot.get_active():
			continue
		if not RuntimeHotspotInteractionScript.hotspot_offers_player_interaction(hotspot.def):
			continue
		if policy is Dictionary and policy.get("canInteractHotspots") != true:
			continue
		if policy is Dictionary and policy.get("canPickup") != true and hotspot.def.get("type") == "pickup":
			continue
		var conditions: Variant = hotspot.def.get("conditions")
		if conditions is Array and not conditions.is_empty() and not condition_ok:
			continue

		var dx := float(position.x) - hotspot.get_center_x()
		var dy := float(position.y) - hotspot.get_center_y()
		var distance := sqrt(dx * dx + dy * dy)
		if distance <= hotspot.get_interaction_range() and distance < closest_distance:
			closest_target = {"kind": "hotspot", "hotspot": hotspot}
			closest_distance = distance

	for npc: RuntimeNpc in npcs:
		var condition_ok := _apply_npc_visibility_and_base(npc, context)
		if not npc.container.visible:
			continue
		if policy is Dictionary and policy.get("canTalkNpcs") != true:
			continue
		var conditions: Variant = npc.def.get("conditions")
		if conditions is Array and not conditions.is_empty() and not condition_ok:
			continue
		var dx := float(position.x) - npc.get_x()
		var dy := float(position.y) - npc.get_y()
		var distance := sqrt(dx * dx + dy * dy)
		if distance <= npc.get_interaction_range() and distance < closest_distance:
			closest_target = {"kind": "npc", "npc": npc}
			closest_distance = distance

	if not _is_same_target(_nearest_target, closest_target):
		_hide_current_prompt()
		_nearest_target = closest_target
		_show_current_prompt()

	if closest_target != null and input_manager.was_key_just_pressed("KeyE"):
		if closest_target.kind == "hotspot" \
			and closest_target.hotspot.def.get("autoTrigger") == true:
			_auto_triggered_in_range[closest_target.hotspot] = true
		_trigger_target(closest_target)
	elif closest_target != null and closest_target.kind == "hotspot" \
		and closest_target.hotspot.def.get("autoTrigger") == true:
		var hotspot: RuntimeHotspot = closest_target.hotspot
		if not _auto_triggered_in_range.has(hotspot):
			_auto_triggered_in_range[hotspot] = true
			_trigger_target(closest_target)


func get_player_visible_entities() -> Array:
	var output: Array = []
	for hotspot: RuntimeHotspot in hotspots:
		if not hotspot.get_active():
			continue
		var raw_label: Variant = hotspot.def.get("label")
		if hotspot.def.get("type") == "transition":
			var item := {
				"kind": "exit",
				"label": raw_label if raw_label is String and not raw_label.is_empty() else "出口",
				"x": hotspot.get_center_x(),
				"y": hotspot.get_center_y(),
			}
			var data: Variant = hotspot.def.get("data")
			if data is Dictionary and data.has("targetScene"):
				item.leadsTo = data.targetScene
			output.push_back(item)
		else:
			var item := {
				"kind": "hotspot",
				"label": raw_label if raw_label is String and not raw_label.is_empty() else hotspot.get_id(),
				"x": hotspot.get_center_x(),
				"y": hotspot.get_center_y(),
			}
			var display_image: Variant = hotspot.def.get("displayImage")
			if display_image is Dictionary and display_image.has("image"):
				item.image = display_image.image
			output.push_back(item)
	for npc: RuntimeNpc in npcs:
		if not npc.container.visible:
			continue
		output.push_back({
			"kind": "npc",
			"label": npc.def.get("name"),
			"x": npc.get_x(),
			"y": npc.get_y(),
		})
	return output


func get_nearest_prompt() -> Variant:
	var target: Variant = _nearest_target
	if target == null:
		return null
	if target.kind == "hotspot" and target.get("hotspot") != null:
		var hotspot: RuntimeHotspot = target.hotspot
		var raw_label: Variant = hotspot.def.get("label")
		return {
			"kind": "hotspot",
			"label": raw_label if raw_label is String and not raw_label.is_empty() else hotspot.get_id(),
			"x": hotspot.get_center_x(),
			"y": hotspot.get_center_y(),
		}
	if target.kind == "npc" and target.get("npc") != null:
		var npc: RuntimeNpc = target.npc
		return {"kind": "npc", "label": npc.def.get("name"), "x": npc.get_x(), "y": npc.get_y()}
	return null


func debug_list_interactables(px: float, py: float) -> Array:
	var output: Array = []
	var plane_policy: Variant = _plane_policy.call() \
		if not _plane_policy.is_null() and _plane_policy.is_valid() else null
	for hotspot: RuntimeHotspot in hotspots:
		var conditions: Variant = hotspot.def.get("conditions")
		var available: bool = hotspot.get_active() \
			and RuntimeHotspotInteractionScript.hotspot_offers_player_interaction(hotspot.def) \
			and (not plane_policy is Dictionary or (plane_policy.get("canInteractHotspots") == true \
				and (plane_policy.get("canPickup") == true or hotspot.def.get("type") != "pickup"))) \
			and (not conditions is Array or conditions.is_empty() or _eval_conditions_list(conditions))
		var dx := px - hotspot.get_center_x()
		var dy := py - hotspot.get_center_y()
		var distance := sqrt(dx * dx + dy * dy)
		output.push_back({
			"kind": "hotspot",
			"id": hotspot.get_id(),
			"type": hotspot.def.get("type"),
			"x": hotspot.get_center_x(),
			"y": hotspot.get_center_y(),
			"interactionRange": hotspot.get_interaction_range(),
			"available": available,
			"inRange": available and distance <= hotspot.get_interaction_range(),
			"distance": roundf(distance * 10.0) / 10.0,
		})
	for npc: RuntimeNpc in npcs:
		var conditions: Variant = npc.def.get("conditions")
		var available: bool = npc.container.visible \
			and (not plane_policy is Dictionary or plane_policy.get("canTalkNpcs") == true) \
			and (not conditions is Array or conditions.is_empty() or _eval_conditions_list(conditions))
		var dx := px - npc.get_x()
		var dy := py - npc.get_y()
		var distance := sqrt(dx * dx + dy * dy)
		output.push_back({
			"kind": "npc",
			"id": npc.get_entity_id(),
			"x": npc.get_x(),
			"y": npc.get_y(),
			"interactionRange": npc.get_interaction_range(),
			"available": available,
			"inRange": available and distance <= npc.get_interaction_range(),
			"distance": roundf(distance * 10.0) / 10.0,
		})
	return output


func _is_same_target(a: Variant, b: Variant) -> bool:
	if a == null and b == null:
		return true
	if a == null or b == null:
		return false
	if a.kind != b.kind:
		return false
	if a.kind == "hotspot":
		return is_same(a.get("hotspot"), b.get("hotspot"))
	return is_same(a.get("npc"), b.get("npc"))


func _hide_current_prompt() -> void:
	if _nearest_target == null:
		return
	if _nearest_target.kind == "hotspot":
		var hotspot: Variant = _nearest_target.get("hotspot")
		if hotspot != null: hotspot.hide_prompt()
	if _nearest_target.kind == "npc":
		var npc: Variant = _nearest_target.get("npc")
		if npc != null: npc.hide_prompt()


func _show_current_prompt() -> void:
	if _nearest_target == null:
		return
	if _nearest_target.kind == "hotspot":
		var hotspot: Variant = _nearest_target.get("hotspot")
		if hotspot != null and hotspot.def.get("autoTrigger") != true:
			hotspot.show_prompt()
	if _nearest_target.kind == "npc":
		var npc: Variant = _nearest_target.get("npc")
		if npc != null:
			npc.show_prompt()


func _trigger_target(target: Dictionary) -> void:
	if target.kind == "hotspot":
		event_bus.emit("hotspot:triggered", {"hotspot": target.hotspot, "def": target.hotspot.def})
	elif target.kind == "npc":
		event_bus.emit("npc:interact", {"npc": target.npc})


func destroy() -> void:
	clear_hotspots()
	clear_npcs()
	_nearest_target = null
	_auto_triggered_in_range.clear()
	_player_position_getter = Callable()
	_hotspot_base_reader = Callable()
	_npc_base_reader = Callable()
	_plane_policy = Callable()
