extends Node

var hotspot_events: Array = []
var npc_events: Array = []


func _ready() -> void:
	var events := RuntimeEventBus.new(); var flags := RuntimeFlagStore.new(events); var input := RuntimeInputManager.new(); var evaluator := RuntimeConditionEvaluator.new(); var system := RuntimeInteractionSystem.new(events, flags, input, evaluator)
	events.on("hotspot:triggered", Callable(self, "_hotspot_event")); events.on("npc:interact", Callable(self, "_npc_event"))
	var position := {"x": 0.0, "y": 0.0}; system.set_player_position_getter(func() -> Dictionary: return position); system.set_condition_eval_context_factory(func() -> Dictionary: return {"flagStore": flags})
	var inspect := RuntimeHotspot.new({"id": "inspect", "type": "inspect", "x": 10, "y": 0, "interactionRange": 20, "label": "查看", "data": {"text": "内容"}}); var empty := RuntimeHotspot.new({"id": "empty", "type": "inspect", "x": 1, "y": 0, "interactionRange": 20, "data": {}}); var pickup := RuntimeHotspot.new({"id": "pickup", "type": "pickup", "x": 5, "y": 0, "interactionRange": 20, "data": {"itemId": "herb", "itemName": "药", "count": 1}}); var npc := RuntimeNpc.new({"id": "npc", "name": "角色", "x": 2, "y": 0, "interactionRange": 20})
	for node: Node2D in [inspect.container, empty.container, pickup.container, npc.container]: add_child(node)
	assert(RuntimeInteractionSystem.hotspot_offers_player_interaction(inspect.def) and not RuntimeInteractionSystem.hotspot_offers_player_interaction(empty.def)); assert(RuntimeInteractionSystem.hotspot_offers_player_interaction(pickup.def))
	var update_enabled := {"value": false}; system.set_update_enabled_getter(func() -> bool: return update_enabled.value)
	system.set_entities([inspect, empty, pickup], [npc]); system.update(0); assert(system.get_nearest_prompt() == null)
	update_enabled.value = true; system.update(0); assert(system.get_nearest_prompt() == {"kind": "npc", "label": "角色", "x": 2.0, "y": 0.0} and npc.prompt_icon != null)
	input.inject_key_just_pressed("KeyE"); system.update(0); input.end_frame(); assert(npc_events.size() == 1 and hotspot_events.is_empty())
	# The pickup is closest after NPC talking is gated; pickup-only plane policy also works independently.
	system.set_plane_interaction_policy(func() -> Dictionary: return {"canInteractHotspots": true, "canTalkNpcs": false, "canPickup": true}); system.update(0); assert(system.get_nearest_prompt().label == "pickup")
	input.inject_key_just_pressed("KeyE"); system.update(0); input.end_frame(); assert(hotspot_events.size() == 1 and hotspot_events[0].def.id == "pickup")
	system.set_plane_interaction_policy(func() -> Dictionary: return {"canInteractHotspots": true, "canTalkNpcs": false, "canPickup": false}); system.update(0); assert(system.get_nearest_prompt().label == "查看")
	# Conditions gate interaction and only hide the entity when conditionHidesEntity is set.
	inspect.def.conditions = [{"flag": "can_inspect", "value": true}]; inspect.def.conditionHidesEntity = true; system.update(0); assert(not inspect.container.visible and system.get_nearest_prompt() == null)
	flags.set_value("can_inspect", true); system.update(0); assert(inspect.container.visible and system.get_nearest_prompt().label == "查看")
	var listed := system.debug_list_interactables(0, 0); assert(listed.size() == 4 and listed.filter(func(v: Dictionary) -> bool: return v.id == "empty")[0].available == false)
	var visible := system.get_player_visible_entities(); assert(visible.filter(func(v: Dictionary) -> bool: return v.kind == "npc").size() == 1)
	# Session/base hiding is not overwritten by per-frame condition refresh.
	inspect.set_enabled(false); system.update(0); assert(not inspect.container.visible); inspect.set_enabled(true); system.update(0); assert(inspect.container.visible)
	# Auto trigger fires once while inside, stays latched when another target wins, and rearms only after exit.
	var auto := RuntimeHotspot.new({"id": "auto", "type": "inspect", "x": 0, "y": 0, "interactionRange": 10, "autoTrigger": true, "data": {"text": "自动"}}); add_child(auto.container); system.set_entities([auto], []); system.set_plane_interaction_policy(); hotspot_events.clear(); system.update(0); system.update(0); assert(hotspot_events.size() == 1 and auto.prompt_icon == null)
	position.x = 30; system.update(0); position.x = 0; system.update(0); assert(hotspot_events.size() == 2)
	input.inject_key_just_pressed("KeyE"); system.update(0); input.end_frame(); system.update(0); assert(hotspot_events.size() == 3)

	system.destroy(); system.free(); events.off("hotspot:triggered", Callable(self, "_hotspot_event")); events.off("npc:interact", Callable(self, "_npc_event")); flags.destroy(); input.destroy(); input.free()
	for entity: Variant in [inspect, empty, pickup, auto]: entity.destroy_hotspot()
	npc.destroy_npc(); hotspot_events.clear(); npc_events.clear(); events.clear()
	print("InteractionSystem distance/condition/plane/auto-trigger contract test: PASS"); get_tree().quit(0)


func _hotspot_event(payload: Variant) -> void: hotspot_events.push_back(payload)
func _npc_event(payload: Variant) -> void: npc_events.push_back(payload)
