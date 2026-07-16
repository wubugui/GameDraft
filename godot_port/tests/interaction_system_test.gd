extends Node

var hotspot_events: Array = []
var npc_events: Array = []
var context_calls := 0


func _ready() -> void:
	var events := RuntimeEventBus.new()
	var flags := RuntimeFlagStore.new(events)
	var input := RuntimeInputManager.new()
	var system := RuntimeInteractionSystem.new(events, flags, input)
	events.on("hotspot:triggered", Callable(self, "_hotspot_event"))
	events.on("npc:interact", Callable(self, "_npc_event"))
	var position := {"x": 0.0, "y": 0.0}
	system.set_player_position_getter(func() -> Dictionary: return position)
	system.set_condition_eval_context_factory(func() -> Dictionary:
		context_calls += 1
		return {"flagStore": flags}
	)
	system.init({})
	assert(system.serialize() == {})
	system.deserialize({"ignored": true})

	var inspect := _hotspot({"id": "inspect", "type": "inspect", "x": 10, "y": 0, "interactionRange": 20, "label": "查看", "data": {"text": "内容"}})
	var empty := _hotspot({"id": "empty", "type": "inspect", "x": 1, "y": 0, "interactionRange": 20, "data": {}})
	var pickup := _hotspot({"id": "pickup", "type": "pickup", "x": 5, "y": 0, "interactionRange": 20, "data": {"itemId": "herb", "itemName": "药", "count": 1}})
	var npc := _npc({"id": "npc", "name": "角色", "x": 2, "y": 0, "interactionRange": 20})
	var all_hotspots: Array = [inspect, empty, pickup]
	var all_npcs: Array = [npc]
	system.set_hotspots(all_hotspots)
	system.set_npcs(all_npcs)
	assert(is_same(system.hotspots, all_hotspots) and is_same(system.npcs, all_npcs), "setHotspots/setNpcs must preserve caller array identity")

	assert(RuntimeHotspotInteraction.hotspot_offers_player_interaction(inspect.def))
	assert(not RuntimeHotspotInteraction.hotspot_offers_player_interaction(empty.def))
	assert(RuntimeHotspotInteraction.hotspot_offers_player_interaction(pickup.def))
	assert(not RuntimeHotspotInteraction.hotspot_offers_player_interaction({"type": "pickup", "data": {"itemId": 7}}))
	assert(not RuntimeHotspotInteraction.inspect_data_has_interactable_payload({"graphId": 7, "text": null}))

	# InteractionSystem has no internal GameState gate. Game.tick owns the Exploring gate,
	# while scene:ready can call update(0) in any state.
	context_calls = 0
	system.update(0)
	assert(context_calls == 1)
	assert(system.get_nearest_prompt() == {"kind": "npc", "label": "角色", "x": 2.0, "y": 0.0})
	assert(npc.prompt_icon != null)
	input.inject_key_just_pressed("KeyE")
	system.update(0)
	input.end_frame()
	assert(npc_events.size() == 1 and hotspot_events.is_empty())
	assert(is_same(npc_events[0].npc, npc))

	# Plane policy uses the source's truthy field semantics: missing booleans deny.
	system.set_plane_interaction_policy(func() -> Dictionary: return {"canInteractHotspots": true, "canTalkNpcs": false, "canPickup": true})
	system.update(0)
	assert(system.get_nearest_prompt().label == "pickup")
	input.inject_key_just_pressed("KeyE")
	system.update(0)
	input.end_frame()
	assert(hotspot_events.size() == 1 and is_same(hotspot_events[0].hotspot, pickup) and is_same(hotspot_events[0].def, pickup.def))
	system.set_plane_interaction_policy(func() -> Dictionary: return {"canInteractHotspots": true, "canTalkNpcs": false})
	system.update(0)
	assert(system.get_nearest_prompt().label == "查看", "missing canPickup must reject pickup")

	# Conditions gate interaction and only hide the entity when conditionHidesEntity is set.
	inspect.def.conditions = [{"flag": "can_inspect", "value": true}]
	inspect.def.conditionHidesEntity = true
	system.update(0)
	assert(not inspect.container.visible and system.get_nearest_prompt() == null)
	flags.set_value("can_inspect", true)
	system.update(0)
	assert(inspect.container.visible and system.get_nearest_prompt().label == "查看")
	var listed := system.debug_list_interactables(0, 0)
	assert(listed.size() == 4 and listed.filter(func(value: Dictionary) -> bool: return value.id == "empty")[0].available == false)
	var visible := system.get_player_visible_entities()
	assert(visible.filter(func(value: Dictionary) -> bool: return value.kind == "npc").size() == 1)

	# update builds one shared context; debugList calls evalConditionsList per conditional entity.
	var conditional_npc := _npc({"id": "conditional_npc", "name": "条件角色", "x": 50, "y": 0, "interactionRange": 20, "conditions": [{"flag": "can_inspect", "value": true}]})
	all_npcs.push_back(conditional_npc)
	system.set_plane_interaction_policy(func() -> Dictionary: return {"canInteractHotspots": true, "canTalkNpcs": true, "canPickup": true})
	context_calls = 0
	system.update(0)
	assert(context_calls == 1)
	context_calls = 0
	system.debug_list_interactables(0, 0)
	assert(context_calls == 2, "debugList must construct one context for each entity that owns conditions")

	# Session/base hiding is not overwritten by per-frame condition refresh.
	inspect.set_enabled(false)
	system.update(0)
	assert(not inspect.container.visible)
	inspect.set_enabled(true)
	system.update(0)
	assert(inspect.container.visible)
	var base_enabled := {"value": false}
	system.set_entity_base_visibility_readers(func(_hotspot_value: RuntimeHotspot) -> bool: return base_enabled.value, func(_npc_value: RuntimeNpc) -> bool: return true)
	system.update(0)
	assert(not inspect.container.visible)
	base_enabled.value = true
	system.update(0)
	assert(inspect.container.visible)
	system.set_entity_base_visibility_readers()

	await _test_double_precision_distance(system, position)
	await _test_label_and_output_shape(system, position)
	await _test_auto_trigger_edges(system, input, position)

	var retained_factory: Callable = system._condition_context_factory
	system.destroy()
	assert(system.serialize() == {} and system.hotspots.is_empty() and system.npcs.is_empty())
	assert(system._condition_context_factory == retained_factory, "destroy must translate the current source lifecycle exactly")
	system.free()
	events.off("hotspot:triggered", Callable(self, "_hotspot_event"))
	events.off("npc:interact", Callable(self, "_npc_event"))
	flags.destroy()
	input.destroy()
	input.free()
	for entity: Variant in [inspect, empty, pickup]:
		entity.destroy_hotspot()
	for entity: Variant in [npc, conditional_npc]:
		entity.destroy_npc()
	hotspot_events.clear()
	npc_events.clear()
	events.clear()
	print("InteractionSystem source-order/distance/condition/plane/auto-trigger direct-translation test: PASS")
	get_tree().quit(0)


func _test_double_precision_distance(system: RuntimeInteractionSystem, position: Dictionary) -> void:
	position.x = 0.0
	position.y = 0.0
	system.set_plane_interaction_policy()
	var boundary := _hotspot({"id": "boundary", "type": "inspect", "x": 100.0, "y": 0.01, "interactionRange": 100.0, "label": "boundary", "data": {"text": "x"}})
	system.set_hotspots([boundary])
	system.set_npcs([])
	system.update(0)
	assert(system.get_nearest_prompt() == null, "scalar double sqrt must keep 100.0000005 outside range=100")

	var farther := _hotspot({"id": "farther", "type": "inspect", "x": 100.0, "y": 0.02, "interactionRange": 101.0, "label": "farther", "data": {"text": "x"}})
	var nearer := _hotspot({"id": "nearer", "type": "inspect", "x": 100.0, "y": 0.01, "interactionRange": 101.0, "label": "nearer", "data": {"text": "x"}})
	system.set_hotspots([farther, nearer])
	system.update(0)
	assert(system.get_nearest_prompt().label == "nearer", "double precision must not collapse distinct distances into a traversal-order tie")
	system.clear_hotspots()
	for entity: RuntimeHotspot in [boundary, farther, nearer]:
		entity.destroy_hotspot()
	await get_tree().process_frame


func _test_label_and_output_shape(system: RuntimeInteractionSystem, position: Dictionary) -> void:
	position.x = 0.0
	position.y = 0.0
	var empty_transition := _hotspot({"id": "empty_transition", "type": "transition", "x": 1, "y": 0, "interactionRange": 20, "label": "", "data": {"targetScene": "next"}})
	var missing_transition := _hotspot({"id": "missing_transition", "type": "transition", "x": 30, "y": 0, "interactionRange": 20, "label": "", "data": {}})
	var empty_inspect := _hotspot({"id": "empty_inspect", "type": "inspect", "x": 2, "y": 0, "interactionRange": 20, "label": "", "data": {"text": "x"}, "displayImage": {"image": ""}})
	var spaced_inspect := _hotspot({"id": "spaced", "type": "inspect", "x": 3, "y": 0, "interactionRange": 20, "label": "   ", "data": {"text": "x"}})
	system.set_hotspots([empty_transition, missing_transition, empty_inspect, spaced_inspect])
	system.set_npcs([])
	system.update(0)
	assert(system.get_nearest_prompt().label == "empty_transition")
	var visible := system.get_player_visible_entities()
	var exit_row: Dictionary = visible.filter(func(value: Dictionary) -> bool: return value.kind == "exit" and value.x == 1.0)[0]
	var missing_exit_row: Dictionary = visible.filter(func(value: Dictionary) -> bool: return value.kind == "exit" and value.x == 30.0)[0]
	var inspect_row: Dictionary = visible.filter(func(value: Dictionary) -> bool: return value.kind == "hotspot" and value.x == 2.0)[0]
	var spaced_row: Dictionary = visible.filter(func(value: Dictionary) -> bool: return value.kind == "hotspot" and value.x == 3.0)[0]
	assert(exit_row.label == "出口" and exit_row.leadsTo == "next")
	assert(missing_exit_row.label == "出口" and not missing_exit_row.has("leadsTo"))
	assert(inspect_row.label == "empty_inspect" and inspect_row.has("image") and inspect_row.image == "")
	assert(spaced_row.label == "   ", "JS || preserves non-empty whitespace labels")
	system.clear_hotspots()
	for entity: RuntimeHotspot in [empty_transition, missing_transition, empty_inspect, spaced_inspect]:
		entity.destroy_hotspot()
	await get_tree().process_frame


func _test_auto_trigger_edges(system: RuntimeInteractionSystem, input: RuntimeInputManager, position: Dictionary) -> void:
	position.x = 0.0
	position.y = 0.0
	hotspot_events.clear()
	var auto := _hotspot({"id": "auto", "type": "inspect", "x": 5, "y": 0, "interactionRange": 10, "autoTrigger": true, "data": {"text": "自动"}})
	var blocker := _npc({"id": "blocker", "name": "抢最近", "x": 1, "y": 0, "interactionRange": 20})
	system.set_hotspots([auto])
	system.set_npcs([])
	system.update(0)
	assert(hotspot_events.size() == 1 and auto.prompt_icon == null)
	system.set_npcs([blocker])
	system.update(0)
	system.clear_npcs()
	system.update(0)
	assert(hotspot_events.size() == 1, "NPC stealing nearest must not rearm an in-range auto hotspot")
	position.x = 15.0
	system.update(0)
	position.x = 0.0
	system.update(0)
	assert(hotspot_events.size() == 1, "distance == range must keep the auto latch")
	position.x = 15.01
	system.update(0)
	position.x = 0.0
	system.update(0)
	assert(hotspot_events.size() == 2, "distance > range must rearm the auto hotspot")

	var e_auto := _hotspot({"id": "e_auto", "type": "inspect", "x": 0, "y": 0, "interactionRange": 10, "autoTrigger": true, "data": {"text": "E自动"}})
	system.set_hotspots([e_auto])
	input.inject_key_just_pressed("KeyE")
	system.update(0)
	input.end_frame()
	system.update(0)
	assert(hotspot_events.size() == 3, "same-frame E must latch autoTrigger and prevent a next-frame duplicate")
	system.clear_hotspots()
	for entity: RuntimeHotspot in [auto, e_auto]:
		entity.destroy_hotspot()
	blocker.destroy_npc()
	await get_tree().process_frame


func _hotspot(definition: Dictionary) -> RuntimeHotspot:
	var entity := RuntimeHotspot.new(definition)
	add_child(entity.container)
	return entity


func _npc(definition: Dictionary) -> RuntimeNpc:
	var entity := RuntimeNpc.new(definition)
	add_child(entity.container)
	return entity


func _hotspot_event(payload: Variant) -> void:
	hotspot_events.push_back(payload)


func _npc_event(payload: Variant) -> void:
	npc_events.push_back(payload)
