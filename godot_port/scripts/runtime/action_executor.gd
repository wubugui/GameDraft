class_name RuntimeActionExecutor
extends RefCounted

var _handlers: Dictionary = {}
var _param_names: Dictionary = {}
var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _state_controller: RuntimeGameStateController
var _policy_stack: Array[Dictionary] = []
var _resolve_notification_text := Callable()
var _choose_action := Callable()
var _random_value := Callable()
var _destroyed := false
var _wait_click_serial := 0
var _epoch := 0
var _pickup_notification := Callable()
var _post_action_hooks: Array[Callable] = []


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore, state_controller: RuntimeGameStateController = null) -> void:
	_event_bus = event_bus
	_flag_store = flag_store
	_state_controller = state_controller
	_register_builtin_handlers()


func set_resolve_notification_text(callback: Callable = Callable()) -> void:
	_resolve_notification_text = callback


func set_choose_action(callback: Callable = Callable()) -> void: _choose_action = callback
func set_random_value_provider(callback: Callable = Callable()) -> void: _random_value = callback
func set_pickup_notification(callback: Callable = Callable()) -> void: _pickup_notification = callback
func add_post_action_hook(callback: Callable) -> void:
	if callback.is_valid() and not _post_action_hooks.has(callback): _post_action_hooks.push_back(callback)


func register_scenario_narrative_handlers(scenario: RuntimeScenarioStateManager, narrative: RuntimeNarrativeStateManager) -> void:
	add_post_action_hook(Callable(narrative, "flush_scheduled_reactive_evaluation"))
	register("setScenarioPhase", func(params: Dictionary, _zone: Variant) -> bool:
		var id := str(params.get("scenarioId", "")).strip_edges(); var phase := str(params.get("phase", "")).strip_edges(); var status := str(params.get("status", "")).strip_edges()
		if not id.is_empty() and not phase.is_empty() and not status.is_empty():
			var payload := {"status": status}; if params.has("outcome") and params.outcome != null: payload.outcome = params.outcome
			return scenario.set_scenario_phase(id, phase, payload)
		return true
	, ["scenarioId", "phase", "status"])
	register("startScenario", func(params: Dictionary, _zone: Variant) -> bool:
		var id := str(params.get("scenarioId", "")).strip_edges(); return scenario.assert_scenario_line_entry_for_action(id) if not id.is_empty() else true
	, ["scenarioId"])
	register("activateScenario", func(params: Dictionary, _zone: Variant) -> bool:
		var id := str(params.get("scenarioId", "")).strip_edges(); return scenario.activate_scenario_line(id) if not id.is_empty() else true
	, ["scenarioId"])
	register("completeScenario", func(params: Dictionary, _zone: Variant) -> bool:
		var id := str(params.get("scenarioId", "")).strip_edges(); return scenario.complete_scenario_line(id) if not id.is_empty() else true
	, ["scenarioId"])
	register("emitNarrativeSignal", func(params: Dictionary, _zone: Variant) -> void:
		var signal_name := str(params.get("signal", "")).strip_edges()
		if signal_name.is_empty(): return
		var payload := {"signal": signal_name}; var source_type := str(params.get("sourceType", "")).strip_edges(); var source_id := str(params.get("sourceId", "")).strip_edges()
		if not source_type.is_empty() and not source_id.is_empty(): payload.sourceType = source_type; payload.sourceId = source_id
		await narrative.emit_narrative_signal(payload)
	, ["signal"])


func register_inventory_rule_quest_handlers(inventory: RuntimeInventoryManager, rules: RuntimeRulesManager, quests: RuntimeQuestManager, offers: RuntimeRuleOfferRegistry, strings: RuntimeStringsProvider) -> void:
	register("enableRuleOffers", func(params: Dictionary, zone: Variant) -> void:
		if zone is Dictionary and not str(zone.get("zoneId", "")).is_empty() and params.get("slots") is Array: offers.register(str(zone.zoneId), params.slots)
	, ["slots"])
	register("disableRuleOffers", func(_params: Dictionary, zone: Variant) -> void:
		if zone is Dictionary and not str(zone.get("zoneId", "")).is_empty(): offers.unregister(str(zone.zoneId))
	, [])
	register("giveItem", func(params: Dictionary, _zone: Variant) -> void: inventory.add_item(str(params.get("id", "")), int(params.get("count", 1)), {"bypassSlotLimit": true} if params.get("critical") == true else {}), ["id", "count", "critical"])
	register("removeItem", func(params: Dictionary, _zone: Variant) -> void: inventory.remove_item(str(params.get("id", "")), int(params.get("count", 1))), ["id", "count"])
	register("giveCurrency", func(params: Dictionary, _zone: Variant) -> void:
		var amount: Variant = _parse_currency_amount(params.get("amount") if params.has("amount") else null); if amount != null: inventory.add_coins(amount)
	, ["amount"])
	register("removeCurrency", func(params: Dictionary, _zone: Variant) -> void:
		var amount: Variant = _parse_currency_amount(params.get("amount") if params.has("amount") else null); if amount != null: inventory.remove_coins(amount)
	, ["amount"])
	register("giveRule", func(params: Dictionary, _zone: Variant) -> void: rules.give_rule(str(params.get("id", ""))), ["id"])
	register("grantRuleLayer", func(params: Dictionary, _zone: Variant) -> void:
		var id := str(params.get("ruleId", "")).strip_edges(); var layer := str(params.get("layer", "")).strip_edges(); if not id.is_empty() and layer in ["xiang", "li", "shu"]: rules.grant_layer(id, layer)
	, ["ruleId", "layer"])
	register("giveFragment", func(params: Dictionary, _zone: Variant) -> void: rules.give_fragment(str(params.get("id", ""))), ["id"])
	register("updateQuest", func(params: Dictionary, _zone: Variant) -> void: quests.accept_quest(str(params.get("id", ""))), ["id"])
	register("pickup", func(params: Dictionary, _zone: Variant) -> void:
		if params.get("isCurrency") == true:
			var amount: Variant = _parse_currency_amount(params.get("count") if params.has("count") else null); if amount != null and inventory.add_coins(amount) and _pickup_notification.is_valid(): _pickup_notification.call(str(params.get("itemName", "")), int(amount))
		else:
			var count := int(params.get("count", 1)); if inventory.add_item(str(params.get("itemId", "")), count) and _pickup_notification.is_valid(): _pickup_notification.call(str(params.get("itemName", "")), count)
	, ["itemId", "itemName", "count", "isCurrency"])
	register("shopPurchase", func(params: Dictionary, _zone: Variant) -> void:
		var item_id := str(params.get("itemId", "")); var price: Variant = params.get("price")
		if not inventory.remove_coins(price): _event_bus.emit("notification:show", {"text": strings.get_text("notifications", "currencyInsufficient"), "type": "warning"}); return
		if not inventory.add_item(item_id, 1): inventory.add_coins(price); return
		var definition: Variant = inventory.get_item_def(item_id); _event_bus.emit("notification:show", {"text": strings.get_text("notifications", "shopPurchased", {"name": definition.get("name", item_id) if definition is Dictionary else item_id}), "type": "info"})
	, ["itemId", "price"])
	register("inventoryDiscard", func(params: Dictionary, _zone: Variant) -> void: inventory.discard_item(str(params.get("itemId", ""))), ["itemId"])


func register_wellbeing_handlers(day: RuntimeDayManager, archive: RuntimeArchiveManager, health: RuntimeHealthSystem, smell: RuntimeSmellSystem, documents: RuntimeDocumentRevealManager) -> void:
	register("endDay", func(_params: Dictionary, _zone: Variant) -> void: await day.end_day(), [])
	register("addDelayedEvent", func(params: Dictionary, _zone: Variant) -> void: day.add_delayed_event(int(params.get("targetDay", 0)), _action_list(params.get("actions"))), ["targetDay", "actions"])
	register("addArchiveEntry", func(params: Dictionary, _zone: Variant) -> void: archive.add_entry(str(params.get("bookType", "")), str(params.get("entryId", ""))), ["bookType", "entryId"])
	register("damagePlayer", func(params: Dictionary, _zone: Variant) -> void:
		var amount: Variant = _coerce_finite_number(params.get("amount", 0)); if amount != null and float(amount) > 0: await health.damage(float(amount))
	, ["amount"])
	register("healPlayer", func(params: Dictionary, _zone: Variant) -> void:
		var amount: Variant = _coerce_finite_number(params.get("amount", 0)); if amount != null and float(amount) > 0: health.heal(float(amount))
	, ["amount"])
	register("resetHealth", func(_params: Dictionary, _zone: Variant) -> void: health.set_health(health.get_max_health()), [])
	register("setHealth", func(params: Dictionary, _zone: Variant) -> void:
		var amount: Variant = _coerce_finite_number(params.get("amount")); if amount != null: health.set_health(float(amount))
	, ["amount"])
	register("incHealth", func(params: Dictionary, _zone: Variant) -> void:
		var amount: Variant = _coerce_finite_number(params.get("amount", 0)); if amount != null: health.set_health(health.get_health() + float(amount))
	, ["amount"])
	register("decHealth", func(params: Dictionary, _zone: Variant) -> void:
		var amount: Variant = _coerce_finite_number(params.get("amount", 0)); if amount != null: health.set_health(health.get_health() - float(amount))
	, ["amount"])
	register("triggerDeathTether", func(_params: Dictionary, _zone: Variant) -> void: await health.tether(), [])
	register("setSmell", func(params: Dictionary, _zone: Variant) -> void: smell.set_smell(str(params.get("scent", "")), params.get("intensity"), params.get("dir"), params.get("flicker", false)), ["scent", "intensity", "dir", "flicker"])
	register("clearSmell", func(_params: Dictionary, _zone: Variant) -> void: smell.clear_smell(), [])
	register("sniff", func(_params: Dictionary, _zone: Variant) -> void: smell.sniff(), [])
	register("revealDocument", func(params: Dictionary, _zone: Variant) -> void: await documents.check_and_reveal(str(params.get("documentId", ""))), ["documentId"])


func register_plane_handlers(planes: RuntimePlaneReconciler) -> void:
	register("activatePlane", func(params: Dictionary, _zone: Variant) -> void:
		var id := str(params.get("id", "")).strip_edges(); if not id.is_empty(): planes.activate_plane_manually(id)
	, ["id"])
	register("deactivatePlane", func(_params: Dictionary, _zone: Variant) -> void: planes.deactivate_manual_plane(), [])


func register_entity_handlers(scenes: RuntimeSceneManager, player: RuntimePlayer) -> void:
	register("playNpcAnimation", func(params: Dictionary, _zone: Variant) -> void:
		var target := str(params.get("target", "")).strip_edges(); var state := str(params.get("state", "")).strip_edges(); var actor: Variant = player if target == "player" else scenes.get_npc_by_id(target); if actor != null and not state.is_empty(): actor.play_animation(state)
	, ["target", "state"])
	register("setEntityEnabled", func(params: Dictionary, _zone: Variant) -> void:
		var target := str(params.get("target", "")).strip_edges(); var enabled: Variant = _parse_loose_boolean(params.get("enabled") if params.has("enabled") else null)
		if enabled == null or target.is_empty(): return
		if target == "player": player.set_visible(enabled)
		elif scenes.get_npc_by_id(target) != null: scenes.set_entity_session_enabled("npc", target, enabled)
	, ["target", "enabled"])
	register("stopNpcPatrol", func(params: Dictionary, _zone: Variant) -> void: scenes.stop_npc_patrol(str(params.get("npcId", ""))), ["npcId"])
	register("persistNpcDisablePatrol", func(params: Dictionary, _zone: Variant) -> void:
		var id := str(params.get("npcId", "")).strip_edges(); if not id.is_empty(): scenes.merge_persistent_npc_state(id, {"patrolDisabled": true}); scenes.stop_npc_patrol(id)
	, ["npcId"])
	register("persistNpcEnablePatrol", func(params: Dictionary, _zone: Variant) -> void:
		var id := str(params.get("npcId", "")).strip_edges(); if not id.is_empty(): scenes.merge_persistent_npc_state(id, {"patrolDisabled": false}); scenes.start_npc_patrol(id)
	, ["npcId"])
	register("persistNpcEntityEnabled", func(params: Dictionary, _zone: Variant) -> void:
		var target := str(params.get("target", "")).strip_edges(); var enabled: Variant = _parse_loose_boolean(params.get("enabled") if params.has("enabled") else null); if not target.is_empty() and enabled != null: scenes.merge_persistent_npc_state(target, {"enabled": enabled})
	, ["target", "enabled"])
	register("persistHotspotEnabled", func(params: Dictionary, _zone: Variant) -> void:
		var enabled: Variant = _parse_loose_boolean(params.get("enabled") if params.has("enabled") else null); if enabled != null: scenes.set_entity_runtime_field(str(params.get("sceneId", "")), "hotspot", str(params.get("hotspotId", "")), "enabled", enabled)
	, ["sceneId", "hotspotId", "enabled"])
	register("setZoneEnabled", func(params: Dictionary, _zone: Variant) -> void:
		var enabled: Variant = _parse_loose_boolean(params.get("enabled") if params.has("enabled") else null); if enabled != null: scenes.set_zone_enabled_session(str(params.get("sceneId", "")), str(params.get("zoneId", "")), enabled)
	, ["sceneId", "zoneId", "enabled"])
	register("persistZoneEnabled", func(params: Dictionary, _zone: Variant) -> void:
		var enabled: Variant = _parse_loose_boolean(params.get("enabled") if params.has("enabled") else null); if enabled != null: scenes.merge_persistent_zone_enabled(str(params.get("sceneId", "")), str(params.get("zoneId", "")), enabled)
	, ["sceneId", "zoneId", "enabled"])
	register("setSceneEntityPosition", func(params: Dictionary, _zone: Variant) -> void:
		var x: Variant = _coerce_finite_number(params.get("x")); var y: Variant = _coerce_finite_number(params.get("y")); var kind := "hotspot" if str(params.get("entityKind", "")).to_lower() == "hotspot" else "npc"
		if x != null and y != null:
			x = roundf(float(x) * 100.0) / 100.0; y = roundf(float(y) * 100.0) / 100.0; scenes.set_entity_runtime_field(str(params.get("sceneId", "")), kind, str(params.get("entityId", "")), "x", x); scenes.set_entity_runtime_field(str(params.get("sceneId", "")), kind, str(params.get("entityId", "")), "y", y)
	, ["sceneId", "entityKind", "entityId", "x", "y"])
	register("persistNpcAt", func(params: Dictionary, _zone: Variant) -> void:
		var x: Variant = _coerce_finite_number(params.get("x")); var y: Variant = _coerce_finite_number(params.get("y")); if x != null and y != null: scenes.merge_persistent_npc_state(str(params.get("target", "")), {"x": x, "y": y})
	, ["target", "x", "y"])
	var persist_animation := func(params: Dictionary, _zone: Variant) -> void:
		var target := str(params.get("target", "")).strip_edges(); var state := str(params.get("state", "")).strip_edges(); if not target.is_empty() and not state.is_empty(): scenes.merge_persistent_npc_state(target, {"animState": state})
	register("persistNpcAnimState", persist_animation, ["target", "state"]); register("persistPlayNpcAnimation", persist_animation, ["target", "state"])
	register("setHotspotDisplayImage", func(params: Dictionary, _zone: Variant) -> void: scenes.set_hotspot_display_image(str(params.get("sceneId", "")), str(params.get("hotspotId", "")), str(params.get("image", "")), params.get("worldWidth"), params.get("worldHeight"), str(params.get("facing", "")).to_lower()), ["sceneId", "hotspotId", "image", "worldWidth", "worldHeight", "facing"])
	register("tempSetHotspotDisplayFacing", func(params: Dictionary, _zone: Variant) -> void: scenes.temp_set_hotspot_display_facing(str(params.get("sceneId", "")), str(params.get("hotspotId", "")), str(params.get("facing", "")).to_lower()), ["sceneId", "hotspotId", "facing"])
	register("setEntityField", func(params: Dictionary, _zone: Variant) -> void: scenes.set_entity_runtime_field(str(params.get("sceneId", "")), str(params.get("entityKind", "")), str(params.get("entityId", "")), str(params.get("fieldName", "")), params.get("value")), ["sceneId", "entityKind", "entityId", "fieldName", "value"])


func register_scene_camera_handlers(scenes: RuntimeSceneManager, camera: RuntimeCamera, baseline_zoom_getter: Callable = Callable()) -> void:
	register("switchScene", func(params: Dictionary, _zone: Variant) -> void:
		var target := str(params.get("targetScene", "")).strip_edges(); if target.is_empty(): return
		var previous := _state_controller.current_state if _state_controller != null else ""; if _state_controller != null: _state_controller.set_state(RuntimeGameStateController.CUTSCENE)
		await scenes.switch_scene_and_wait(target, str(params.get("targetSpawnPoint", "")))
		if _state_controller != null and _state_controller.current_state == RuntimeGameStateController.CUTSCENE: _state_controller.set_state(previous)
	, ["targetScene", "targetSpawnPoint"])
	register("changeScene", func(params: Dictionary, _zone: Variant) -> void:
		var target := str(params.get("targetScene", "")).strip_edges(); if target.is_empty(): return
		var position: Variant = null; var raw_x: Variant = params.get("cameraX"); var raw_y: Variant = params.get("cameraY")
		if (raw_x is int or raw_x is float) and (raw_y is int or raw_y is float) and is_finite(float(raw_x)) and is_finite(float(raw_y)): position = {"x": float(raw_x), "y": float(raw_y)}
		var previous := _state_controller.current_state if _state_controller != null else ""; if _state_controller != null: _state_controller.set_state(RuntimeGameStateController.CUTSCENE)
		await scenes.switch_scene_and_wait(target, str(params.get("targetSpawnPoint", "")), position)
		if _state_controller != null and _state_controller.current_state == RuntimeGameStateController.CUTSCENE: _state_controller.set_state(previous)
	, ["targetScene", "targetSpawnPoint", "cameraX", "cameraY"])
	register("setCameraZoom", func(params: Dictionary, _zone: Variant) -> void:
		var zoom: Variant = _coerce_finite_number(params.get("zoom")); if zoom != null and float(zoom) > 0: camera.set_zoom(float(zoom))
	, ["zoom"])
	register("restoreSceneCameraZoom", func(_params: Dictionary, _zone: Variant) -> void:
		camera.set_zoom(_camera_baseline_zoom(scenes, baseline_zoom_getter))
	, [])


func register_graph_dialogue_handler(dialogue: RuntimeGraphDialogueManager, scenes: RuntimeSceneManager, ambient_owner_provider: Callable = Callable()) -> void:
	register("startDialogueGraph", func(params: Dictionary, _zone: Variant) -> void:
		var graph_id := str(params.get("graphId", "")).strip_edges()
		if graph_id.is_empty(): return
		if _state_controller != null: _state_controller.set_state(RuntimeGameStateController.DIALOGUE)
		var npc_id := str(params.get("npcId", "")).strip_edges(); var npc_name := ""
		if not npc_id.is_empty():
			var npc: Variant = scenes.get_npc_by_id(npc_id)
			if npc != null: npc_name = str(npc.def.get("name", ""))
		var owner_type := str(params.get("ownerType", "")).strip_edges(); var owner_id := str(params.get("ownerId", "")).strip_edges()
		if owner_type.is_empty() and not npc_id.is_empty(): owner_type = "npc"
		if owner_id.is_empty(): owner_id = npc_id
		if owner_type.is_empty() and owner_id.is_empty() and not ambient_owner_provider.is_null() and ambient_owner_provider.is_valid():
			var ambient: Variant = ambient_owner_provider.call()
			if ambient is Dictionary: owner_type = str(ambient.get("ownerType", "")); owner_id = str(ambient.get("ownerId", ""))
		await dialogue.start_dialogue_graph({"graphId": graph_id, "entry": str(params.get("entry", "")), "npcName": npc_name, "npcId": npc_id, "ownerType": owner_type, "ownerId": owner_id, "dimBackground": params.get("dimBackground") == true})
		if _state_controller != null and not dialogue.is_active() and not dialogue.has_pending_chain_continuation(): _state_controller.set_state(RuntimeGameStateController.EXPLORING)
	, ["graphId", "entry", "npcId", "ownerType", "ownerId", "dimBackground"])


func register_scripted_dialogue_handler(callback: Callable) -> void:
	register("playScriptedDialogue", func(params: Dictionary, _zone: Variant) -> void:
		if callback.is_valid() and params.get("lines") is Array and not params.lines.is_empty(): await callback.call(params)
	, ["lines", "scriptedNpcId", "dimBackground"])


func register_encounter_handler(encounter: RuntimeEncounterManager) -> void:
	register("startEncounter", func(params: Dictionary, _zone: Variant) -> void:
		var id := str(params.get("id", "")).strip_edges()
		if id.is_empty() or not encounter.has_encounter(id): return
		if _state_controller != null: _state_controller.set_state(RuntimeGameStateController.ENCOUNTER)
		encounter.start_encounter(id)
	, ["id"])


func register_audio_handlers(audio: RuntimeAudioManager, signals: RuntimeSignalCueManager) -> void:
	register("playBgm", func(params: Dictionary, _zone: Variant) -> void:
		audio.play_bgm(str(params.get("id", "")), float(params.get("fadeMs", 1000)))
	, ["id", "fadeMs"])
	register("stopBgm", func(params: Dictionary, _zone: Variant) -> void:
		audio.stop_bgm(float(params.get("fadeMs", 1000)))
	, ["fadeMs"])
	register("playSfx", func(params: Dictionary, _zone: Variant) -> void:
		audio.play_sfx(str(params.get("id", "")), params.get("volume"))
	, ["id", "volume"])
	register("stopSceneAmbient", func(params: Dictionary, _zone: Variant) -> void:
		var id := str(params.get("id", "")).strip_edges()
		if id.is_empty(): audio.clear_ambient(float(params.get("fadeMs", 500)))
		else: audio.remove_ambient(id, float(params.get("fadeMs", 500)))
	, ["id", "fadeMs"])
	register("playSignalCue", func(params: Dictionary, _zone: Variant) -> void:
		await signals.play(str(params.get("id", "")))
	, ["id"])


func register_cutscene_handler(cutscenes: RuntimeCutsceneManager) -> void:
	register("startCutscene", func(params: Dictionary, _zone: Variant) -> void:
		var id := str(params.get("id", "")).strip_edges()
		if id.is_empty() or not cutscenes.has_cutscene(id): return
		var previous := _state_controller.current_state if _state_controller != null else ""
		if _state_controller != null: _state_controller.set_state(RuntimeGameStateController.CUTSCENE)
		await cutscenes.start_cutscene(id)
		if _state_controller != null and _state_controller.current_state == RuntimeGameStateController.CUTSCENE: _state_controller.set_state(previous)
	, ["id"])


func register_pressure_hold_handler(pressure_holds: RuntimePressureHoldManager) -> void:
	register("startPressureHold", func(params: Dictionary, _zone: Variant) -> bool:
		var id := str(params.get("id", "")).strip_edges()
		if not id.is_empty():
			return await pressure_holds.run_until_done(id) != RuntimePressureHoldManager.FAILED
		return true
	, ["id"])


func register_paper_craft_handler(paper_craft: RuntimePaperCraftMinigameManager) -> void:
	register("startPaperCraftMinigame", func(params: Dictionary, _zone: Variant) -> void:
		var id := str(params.get("id", "")).strip_edges()
		if not id.is_empty(): await paper_craft.run_until_done(id)
	, ["id"])


func register_sugar_wheel_handlers(sugar_wheel: RuntimeSugarWheelMinigameManager) -> void:
	register("startSugarWheelMinigame", func(params: Dictionary, _zone: Variant) -> void:
		var id := str(params.get("id", "")).strip_edges()
		if not id.is_empty(): await sugar_wheel.run_until_done(id)
	, ["id"])
	register("sugarWheelShowSpeech", func(params: Dictionary, _zone: Variant) -> void:
		var role := str(params.get("role", "")).strip_edges(); var speech := str(params.get("text", "")).strip_edges()
		if not role.is_empty() and not speech.is_empty(): sugar_wheel.show_speech(role, speech, params.get("durationMs"))
	, ["role", "text"])
	register("sugarWheelDismissSpeech", func(params: Dictionary, _zone: Variant) -> void:
		var role := str(params.get("role", "")).strip_edges()
		if not role.is_empty(): sugar_wheel.dismiss_speech(role)
	, ["role"])
	register("sugarWheelDismissAllSpeech", func(_params: Dictionary, _zone: Variant) -> void: sugar_wheel.dismiss_all_speech(), [])
	register("sugarWheelResetPointer", func(params: Dictionary, _zone: Variant) -> void:
		var raw: Variant = params.get("angleDeg", params.get("angle"))
		if raw is int or raw is float: sugar_wheel.reset_pointer_geom_angle_deg(float(raw))
		elif raw is String and raw.is_valid_float(): sugar_wheel.reset_pointer_geom_angle_deg(raw.to_float())
	, ["angleDeg"])


func register_water_minigame_handler(water: RuntimeWaterMinigameManager) -> void:
	register("startWaterMinigame", func(params: Dictionary, _zone: Variant) -> void:
		var id := str(params.get("id", "")).strip_edges()
		if not id.is_empty(): await water.run_until_done(id)
	, ["id"])


func register_shop_depth_handlers(shop: RuntimeShopUI, depth: RuntimeSceneDepthSystem) -> void:
	register("openShop", func(params: Dictionary, _zone: Variant) -> void:
		if _state_controller != null: _state_controller.set_state(RuntimeGameStateController.UI_OVERLAY)
		shop.open_shop(str(params.get("shopId", "")))
	, ["shopId"])
	register("setSceneDepthFloorOffset", func(params: Dictionary, _zone: Variant) -> void:
		var raw: Variant = params.get("floor_offset")
		var value: Variant = raw if raw is int or raw is float else (raw.to_float() if raw is String and raw.is_valid_float() else null)
		if value != null and is_finite(float(value)): depth.set_floor_offset(float(value))
	, ["floor_offset"])
	register("resetSceneDepthFloorOffset", func(_params: Dictionary, _zone: Variant) -> void: depth.reset_floor_offset(), [])


func register_debug_alert_handler(callback: Callable) -> void:
	register("debugAlertActionParams", func(params: Dictionary, _zone: Variant) -> void:
		if not callback.is_null() and callback.is_valid(): callback.call(params.duplicate(true))
	, ["title"])


func register_wait_click_handler(input: RuntimeInputManager, renderer: RuntimeRenderer) -> void:
	register("waitClickContinue", func(params: Dictionary, _zone: Variant) -> void:
		var label := Label.new(); label.name = "ClickContinuePrompt"; label.text = _resolve_text(str(params.get("text", "点击或按任意键继续"))); label.position = Vector2(0, renderer.get_screen_height() - 52); label.size = Vector2(renderer.get_screen_width(), 28); label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; label.vertical_alignment = VERTICAL_ALIGNMENT_BOTTOM; label.add_theme_font_size_override("font_size", 16); label.add_theme_color_override("font_color", Color("aaaaaa")); renderer.ui_layer.add_child(label)
		await Engine.get_main_loop().process_frame; await Engine.get_main_loop().process_frame
		var serial := _wait_click_serial; var start_epoch := _epoch; var unsubscribe := input.subscribe_any_input(func() -> void: if Time.get_ticks_msec() >= int(label.get_meta("notBefore", 0)): _wait_click_serial += 1); label.set_meta("notBefore", Time.get_ticks_msec() + 120)
		while not _destroyed and start_epoch == _epoch and _wait_click_serial == serial: await Engine.get_main_loop().process_frame
		if not unsubscribe.is_null() and unsubscribe.is_valid(): unsubscribe.call()
		if is_instance_valid(label): if label.get_parent() != null: label.get_parent().remove_child(label); label.free()
	, ["text"])


func register_player_avatar_handlers(apply_avatar: Callable, reset_avatar: Callable) -> void:
	register("setPlayerAvatar", func(params: Dictionary, _zone: Variant) -> void:
		var path := str(params.get("animManifest", "")).strip_edges(); var bundle := str(params.get("bundleId", "")).strip_edges(); if path.is_empty() and not bundle.is_empty(): path = "/resources/runtime/animation/%s/anim.json" % bundle
		if not path.is_empty() and apply_avatar.is_valid(): apply_avatar.call(path, params.get("stateMap"), str(params.get("portraitSlug", "")).strip_edges())
	, ["animManifest", "bundleId", "stateMap", "portraitSlug"])
	register("resetPlayerAvatar", func(_params: Dictionary, _zone: Variant) -> void: if reset_avatar.is_valid(): reset_avatar.call(), [])


func register_cutscene_actor_handlers(cutscenes: RuntimeCutsceneManager, bubbles: RuntimeEmoteBubbleManager, scenes: RuntimeSceneManager, player: RuntimePlayer, baseline_zoom_getter: Callable = Callable()) -> void:
	var resolve_actor := func(id: String) -> Variant:
		if id == "player": return player
		var temp: Variant = cutscenes.get_temp_actor(id)
		if temp != null: return temp
		var npc: Variant = scenes.get_npc_by_id(id)
		if npc != null: return npc
		return scenes.get_hotspot_by_id(id)
	register("waitMs", func(params: Dictionary, _zone: Variant) -> void:
		await cutscenes.cutscene_renderer.wait_ms(maxf(0.0, float(params.get("durationMs", 600))))
	, ["durationMs"])
	register("showOverlayImage", func(params: Dictionary, _zone: Variant) -> void:
		cutscenes.cutscene_renderer.show_overlay_image(str(params.get("id", "")), str(params.get("image", "")), float(params.get("xPercent", 50)), float(params.get("yPercent", 50)), float(params.get("widthPercent", 100)))
	, ["id", "image", "xPercent", "yPercent", "widthPercent"])
	register("hideOverlayImage", func(params: Dictionary, _zone: Variant) -> void: cutscenes.cutscene_renderer.hide_img(str(params.get("id", ""))), ["id"])
	register("blendOverlayImage", func(params: Dictionary, _zone: Variant) -> void:
		await cutscenes.cutscene_renderer.blend_overlay_image(str(params.get("id", "")), str(params.get("fromImage", "")), str(params.get("toImage", "")), float(params.get("xPercent", 50)), float(params.get("yPercent", 50)), float(params.get("widthPercent", 100)), maxf(0.0, float(params.get("durationMs", 600))), maxf(0.0, float(params.get("delayMs", 0))))
	, ["id", "fromImage", "toImage", "durationMs", "delayMs", "xPercent", "yPercent", "widthPercent"])
	register("fadeWorldToBlack", func(params: Dictionary, _zone: Variant) -> void: await cutscenes.cutscene_renderer.fade_world_to_black(_duration_ms(params, 600.0)), ["durationMs", "duration"])
	register("fadeWorldFromBlack", func(params: Dictionary, _zone: Variant) -> void: await cutscenes.cutscene_renderer.fade_world_from_black(_duration_ms(params, 600.0)), ["durationMs", "duration"])
	register("fadingZoom", func(params: Dictionary, _zone: Variant) -> void:
		var zoom: Variant = _coerce_finite_number(params.get("zoom")); if zoom != null and float(zoom) > 0: await cutscenes.cutscene_renderer.camera_zoom(float(zoom), _duration_ms(params, 600.0))
	, ["zoom", "durationMs", "duration"])
	register("fadingRestoreSceneCameraZoom", func(params: Dictionary, _zone: Variant) -> void:
		await cutscenes.cutscene_renderer.camera_zoom(_camera_baseline_zoom(scenes, baseline_zoom_getter), _duration_ms(params, 600.0))
	, ["durationMs", "duration"])
	register("moveEntityTo", func(params: Dictionary, _zone: Variant) -> void:
		var actor: Variant = resolve_actor.call(str(params.get("target", "")).strip_edges())
		if actor == null or not actor.has_method("move_to"): return
		var points: Array = []
		if params.get("waypoints") is Array:
			for point: Variant in params.waypoints:
				if point is Dictionary and point.has("x") and point.has("y"):
					var waypoint_x: Variant = _coerce_finite_number(point.x); var waypoint_y: Variant = _coerce_finite_number(point.y); if waypoint_x != null and waypoint_y != null: points.push_back({"x": waypoint_x, "y": waypoint_y})
		if not params.has("x") or not params.has("y"): return
		var target_x: Variant = _coerce_finite_number(params.x); var target_y: Variant = _coerce_finite_number(params.y); if target_x == null or target_y == null: return
		points.push_back({"x": target_x, "y": target_y})
		var speed: Variant = _coerce_finite_number(params.speed) if params.has("speed") else 80.0; var movement_speed := float(speed) if speed != null and float(speed) > 0.0 else 80.0
		var face_toward := _parse_movement_facing(params.get("faceTowardMovement") if params.has("faceTowardMovement") else null)
		for point: Dictionary in points:
			await actor.move_to(float(point.x), float(point.y), movement_speed, str(params.get("moveAnimState", "")).strip_edges(), face_toward)
	, ["target", "x", "y", "speed", "waypoints", "moveAnimState", "faceTowardMovement"])
	register("faceEntity", func(params: Dictionary, _zone: Variant) -> void:
		var actor: Variant = resolve_actor.call(str(params.get("target", "")).strip_edges())
		if actor == null or not actor.has_method("set_facing"): return
		var face_target := str(params.get("faceTarget", "")).strip_edges()
		var other: Variant = resolve_actor.call(face_target) if not face_target.is_empty() else null
		if other != null and other.has_method("get_x") and other.has_method("get_y"): actor.set_facing(float(other.get_x()) - float(actor.get_x()), float(other.get_y()) - float(actor.get_y())); return
		match str(params.get("direction", "")):
			"left": actor.set_facing(-1, 0)
			"right": actor.set_facing(1, 0)
			"up": actor.set_facing(0, -1)
			"down": actor.set_facing(0, 1)
	, ["target", "direction", "faceTarget"])
	register("cutsceneSpawnActor", func(params: Dictionary, _zone: Variant) -> void:
		if (params.get("x") is int or params.get("x") is float) and (params.get("y") is int or params.get("y") is float): cutscenes.spawn_temp_actor(str(params.get("id", "")), str(params.get("name", params.get("id", ""))), float(params.x), float(params.y))
	, ["id", "name", "x", "y"])
	register("cutsceneRemoveActor", func(params: Dictionary, _zone: Variant) -> void: cutscenes.remove_temp_actor(str(params.get("id", ""))), ["id"])
	register("showEmoteAndWait", func(params: Dictionary, _zone: Variant) -> void:
		var actor: Variant = resolve_actor.call(str(params.get("target", "")).strip_edges())
		if actor != null: await bubbles.show_and_wait(actor, str(params.get("emote", "")), float(params.get("duration", 1500)), params, "cutscene" if cutscenes.is_playing() else "action")
	, ["target", "emote", "duration", "anchorOffsetX", "anchorOffsetY"])
	register("showEmote", func(params: Dictionary, _zone: Variant) -> void:
		var actor: Variant = resolve_actor.call(str(params.get("target", "")).strip_edges())
		if actor != null: bubbles.show(actor, str(params.get("emote", "")), float(params.get("duration", 1500)), params, "cutscene" if cutscenes.is_playing() else "action")
	, ["target", "emote", "duration", "anchorOffsetX", "anchorOffsetY"])
	register("showSpeechBubbleAndWait", func(params: Dictionary, _zone: Variant) -> void:
		var actor: Variant = resolve_actor.call(str(params.get("target", "")).strip_edges()); var text := _resolve_text(str(params.get("text", "")))
		if actor != null and not text.is_empty(): await bubbles.show_and_wait(actor, text, float(params.get("duration", 1500)), params, "cutscene" if cutscenes.is_playing() else "action")
	, ["target", "text", "duration", "anchorOffsetX", "anchorOffsetY"])
	register("showSpeechBubble", func(params: Dictionary, _zone: Variant) -> void:
		var actor: Variant = resolve_actor.call(str(params.get("target", "")).strip_edges()); var text := _resolve_text(str(params.get("text", "")))
		if actor != null and not text.is_empty(): bubbles.show(actor, text, float(params.get("duration", 1500)), params, "cutscene" if cutscenes.is_playing() else "action")
	, ["target", "text", "duration", "anchorOffsetX", "anchorOffsetY"])


func register(type: String, handler: Callable, param_names: Array[String] = []) -> void:
	_handlers[type] = handler
	if not param_names.is_empty():
		_param_names[type] = param_names.duplicate()


func get_param_names(type: Variant) -> Variant:
	var key := normalize_action_type_key(type)
	return null if key.is_empty() or not _param_names.has(key) else _param_names[key].duplicate()


func get_registered_action_types() -> Array[String]:
	var result: Array[String] = []
	result.assign(_handlers.keys())
	return result


func push_action_policy(blocked_types: Array, label: String) -> void:
	var blocked := {}
	for type: Variant in blocked_types:
		blocked[normalize_action_type_key(type)] = true
	_policy_stack.push_back({"blockedTypes": blocked, "label": label})


func pop_action_policy() -> void:
	if not _policy_stack.is_empty():
		_policy_stack.pop_back()


func has_handler(type: Variant) -> bool:
	var key := normalize_action_type_key(type)
	return not key.is_empty() and _handlers.has(key)


func execute(action: Dictionary) -> void:
	if not _destroyed:
		execute_await(action)


func execute_await(action: Dictionary, zone_context: Variant = null) -> bool:
	if _destroyed:
		return true
	var type_key := normalize_action_type_key(action.get("type"))
	if type_key.is_empty() or _find_blocking_policy(type_key) != null:
		return true
	var applied_lock := false
	if _state_controller != null and _state_controller.current_state == RuntimeGameStateController.EXPLORING:
		_state_controller.set_state(RuntimeGameStateController.ACTION_SEQUENCE)
		applied_lock = true
	var start_epoch := _epoch
	var handler: Variant = _handlers.get(type_key)
	var succeeded := true
	if handler is Callable and handler.is_valid():
		var params: Variant = action.get("params", {})
		var result: Variant = await handler.call(params if params is Dictionary else {}, zone_context)
		succeeded = result != false
	if succeeded:
		for hook: Callable in _post_action_hooks:
			if hook.is_valid(): await hook.call()
	if applied_lock and not _destroyed and start_epoch == _epoch \
		and _state_controller.current_state == RuntimeGameStateController.ACTION_SEQUENCE:
		_state_controller.set_state(RuntimeGameStateController.EXPLORING)
	return succeeded


func execute_batch_await(actions: Array, zone_context: Variant = null) -> bool:
	for action: Variant in actions:
		if action is Dictionary:
			if not await execute_await(action, zone_context): return false
	return true


func execute_batch_in_zone_context(actions: Array, context: Dictionary) -> bool:
	return await execute_batch_await(actions, context)


func destroy() -> void:
	if _destroyed:
		return
	_destroyed = true
	_epoch += 1
	_handlers.clear()
	_param_names.clear()
	_policy_stack.clear()
	_resolve_notification_text = Callable()
	_choose_action = Callable()
	_random_value = Callable()
	_pickup_notification = Callable()
	_post_action_hooks.clear()


func policy_depth() -> int:
	return _policy_stack.size()


static func normalize_action_type_key(raw: Variant) -> String:
	if raw == null:
		return ""
	return str(raw).trim_prefix("﻿").strip_edges()


func _register_builtin_handlers() -> void:
	register("setFlag", func(params: Dictionary, _zone: Variant) -> void:
		_flag_store.set_value(str(params.get("key", "")), params.get("value"))
	, ["key", "value"])
	register("appendFlag", func(params: Dictionary, _zone: Variant) -> void:
		var fragment: Variant = params.get("text", "")
		_flag_store.append_string_flag(str(params.get("key", "")), "" if fragment == null else fragment)
	, ["key", "text"])
	register("addFlagValue", func(params: Dictionary, _zone: Variant) -> void:
		var key := str(params.get("key", "")).strip_edges()
		var delta: Variant = _coerce_finite_number(params.get("delta"))
		if not key.is_empty() and delta != null:
			_flag_store.add_numeric_flag(key, delta)
	, ["key", "delta"])
	register("showNotification", func(params: Dictionary, _zone: Variant) -> void:
		var text := "" if not params.has("text") or params.get("text") == null else _js_string(params.get("text"))
		if not _resolve_notification_text.is_null() and _resolve_notification_text.is_valid():
			text = str(_resolve_notification_text.call(text))
		_event_bus.emit("notification:show", {"text": text, "type": params.get("type")})
	, ["text", "type"])
	register("runActions", func(params: Dictionary, zone: Variant) -> void:
		await execute_batch_await(_action_list(params.get("actions")), zone)
	, ["actions"])
	register("chooseAction", func(params: Dictionary, zone: Variant) -> void:
		var options: Array = []
		for raw: Variant in params.get("options", []):
			if not raw is Dictionary: continue
			var text := _resolve_text(str(raw.get("text", ""))).strip_edges()
			if not text.is_empty(): options.push_back({"text": text, "actions": _action_list(raw.get("actions"))})
		if options.is_empty() or _choose_action.is_null() or not _choose_action.is_valid(): return
		var previous := _state_controller.current_state if _state_controller != null else ""; if _state_controller != null: _state_controller.set_state(RuntimeGameStateController.UI_OVERLAY)
		var picked: Variant = await _choose_action.call(_resolve_text(str(params.get("prompt", ""))), options.map(func(value: Dictionary) -> Dictionary: return {"text": value.text}), params.get("allowCancel") == true)
		if _state_controller != null and _state_controller.current_state == RuntimeGameStateController.UI_OVERLAY: _state_controller.set_state(previous)
		if picked is int and picked >= 0 and picked < options.size(): await execute_batch_await(options[picked].actions, zone)
	, ["prompt", "options", "allowCancel"])
	register("randomBranch", func(params: Dictionary, zone: Variant) -> void:
		var threshold: Variant = _coerce_finite_number(params.get("probability")) if params.has("probability") else null
		if threshold == null: threshold = 0.5
		threshold = clampf(float(threshold), 0.0, 1.0)
		var sample := float(_random_value.call()) if not _random_value.is_null() and _random_value.is_valid() else randf()
		await execute_batch_await(_action_list(params.get("aboveActions") if sample > threshold else params.get("belowActions")), zone)
	, ["probability", "aboveActions", "belowActions"])


func _find_blocking_policy(type_key: String) -> Variant:
	for index in range(_policy_stack.size() - 1, -1, -1):
		var policy: Dictionary = _policy_stack[index]
		if policy.blockedTypes.has(type_key):
			return policy
	return null


func _coerce_finite_number(value: Variant) -> Variant:
	if value == null:
		return 0.0
	if value is bool:
		return 1.0 if value else 0.0
	if value is int or value is float:
		return float(value) if is_finite(float(value)) else null
	var text := str(value).strip_edges()
	if text.is_empty():
		return 0.0
	if text.to_lower().begins_with("0x") and text.substr(2).is_valid_hex_number():
		return float(text.substr(2).hex_to_int())
	return text.to_float() if text.is_valid_float() and is_finite(text.to_float()) else null


func _duration_ms(params: Dictionary, fallback: float) -> float:
	var raw: Variant = params.get("durationMs")
	if raw == null: raw = params.get("duration")
	if raw == null: return fallback
	var parsed: Variant = _coerce_finite_number(raw)
	return float(parsed) if parsed != null and float(parsed) >= 0.0 else fallback


func _parse_movement_facing(value: Variant) -> bool:
	if value == null: return false
	if value is bool: return value
	if value is int or value is float: return float(value) != 0.0
	return str(value).strip_edges().to_lower() in ["true", "1", "yes"]


func _camera_baseline_zoom(scenes: RuntimeSceneManager, getter: Callable) -> float:
	if getter.is_valid():
		var runtime_value: Variant = getter.call()
		if (runtime_value is int or runtime_value is float) and is_finite(float(runtime_value)) and float(runtime_value) > 0.0: return float(runtime_value)
	var scene := scenes.get_current_scene_data(); var config: Variant = scene.get("camera") if scene is Dictionary else null; var zoom: Variant = config.get("zoom") if config is Dictionary else null
	return float(zoom) if (zoom is int or zoom is float) and is_finite(float(zoom)) and float(zoom) > 0.0 else 1.0


func _js_string(value: Variant) -> String:
	if value == null: return "null"
	if value is bool: return "true" if value else "false"
	if value is float and is_finite(value) and value == floor(value): return str(int(value))
	return str(value)


func _resolve_text(value: String) -> String: return str(_resolve_notification_text.call(value)) if not _resolve_notification_text.is_null() and _resolve_notification_text.is_valid() else value
func _action_list(value: Variant) -> Array:
	var output: Array = []
	if value is Array:
		for action: Variant in value:
			if action is Dictionary and action.get("type") is String: output.push_back(action)
	return output


func _parse_currency_amount(raw: Variant) -> Variant:
	var resolved := _resolve_text("" if raw == null else str(raw)).strip_edges()
	if resolved.is_empty() or not resolved.is_valid_float(): return null
	var value := resolved.to_float()
	if not is_finite(value): return null
	var whole := int(value)
	return whole if whole >= 0 else null


func _parse_loose_boolean(raw: Variant) -> Variant:
	if raw == null: return null
	if raw is bool: return raw
	if raw is int or raw is float: return float(raw) != 0.0
	var text := str(raw).strip_edges().to_lower()
	if text in ["true", "1"]: return true
	if text in ["false", "0"]: return false
	return null
