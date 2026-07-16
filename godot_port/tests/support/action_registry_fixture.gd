class_name ActionRegistryFixture
extends RefCounted

const ActionRegistryScript := preload("res://scripts/runtime/action_registry.gd")


class PickupNotificationStub:
	extends RefCounted
	func show(_name: String, _count: int) -> void: pass
	func force_cleanup() -> void: pass


class InspectBoxStub:
	extends RefCounted
	func is_open() -> bool: return false
	func close() -> void: pass


class CutsceneManagerStub:
	extends RefCounted
	func start_cutscene(_id: String) -> bool: return true
	func fading_camera_zoom(_zoom: float, _duration_ms: float) -> void: pass
	func fade_world_to_black(_duration_ms: float) -> bool: return true
	func fade_world_from_black(_duration_ms: float) -> bool: return true


class NarrativeStateManagerStub:
	extends RefCounted
	func emit_narrative_signal(_payload: Dictionary) -> void: pass


class SignalCueManagerStub:
	extends RefCounted
	func play(_id: String) -> bool: return true


static func register(executor: RuntimeActionExecutor, overrides: Dictionary = {}) -> void:
	ActionRegistryScript.register_action_handlers(executor, deps(overrides))


static func deps(overrides: Dictionary = {}) -> Dictionary:
	var result := {
		"randomValue": func() -> float: return 0.0,
		"resolveScriptedSpeaker": func(raw: String, _npc_id: String = "") -> String: return raw,
		"resolveScriptedLineExtras": func(_speaker: String, _portrait: Variant, _npc_id: String = "") -> Dictionary: return {},
		"ruleOfferRegistry": null,
		"inventoryManager": null,
		"rulesManager": null,
		"questManager": null,
		"encounterManager": null,
		"audioManager": null,
		"dayManager": null,
		"archiveManager": null,
		"cutsceneManager": CutsceneManagerStub.new(),
		"sceneManager": null,
		"emoteBubbleManager": null,
		"stateController": null,
		"stringsProvider": null,
		"eventBus": null,
		"resolveActor": func(_id: String) -> Variant: return null,
		"resolveEmoteTarget": func(_id: String) -> Variant: return null,
		"pickupNotification": PickupNotificationStub.new(),
		"inspectBox": InspectBoxStub.new(),
		"shopUI": null,
		"applyPlayerAvatar": func(_path: String, _state_map: Variant, _portrait_slug: Variant) -> bool: return true,
		"resetPlayerAvatar": func() -> bool: return true,
		"setSceneDepthFloorOffset": func(_value: float) -> void: pass,
		"resetSceneDepthFloorOffset": func() -> void: pass,
		"setCameraZoom": func(_value: float) -> void: pass,
		"restoreSceneCameraZoom": func() -> void: pass,
		"fadingRestoreSceneCameraZoom": func(_duration_ms: float) -> void: pass,
		"stopNpcPatrol": func(_id: String) -> void: pass,
		"startNpcPatrol": func(_id: String) -> void: pass,
		"showOverlayImage": func(_id: String, _image: String, _x: float, _y: float, _width: float) -> bool: return true,
		"resolveOverlayImagePath": func(image: String) -> String: return image,
		"hideOverlayImage": func(_id: String) -> void: pass,
		"blendOverlayImage": func(_id: String, _from: String, _to: String, _x: float, _y: float, _width: float, _duration: float, _delay: float) -> bool: return true,
		"startDialogueGraph": func(_graph_id: String, _entry: String, _npc_id: String, _owner_type: String, _owner_id: String, _dim: bool) -> void: pass,
		"playScriptedDialogue": func(_lines: Array) -> bool: return true,
		"waitClickContinue": func(_hint: String) -> void: pass,
		"resolveDisplayText": func(raw: String) -> String: return raw,
		"chooseAction": func(_prompt: String, _options: Array, _allow_cancel: bool) -> Variant: return null,
		"resolveDisplayTextForPlayScripted": func(raw: String, _npc_id: String = "") -> String: return raw,
		"scenarioStateManager": null,
		"narrativeStateManager": NarrativeStateManagerStub.new(),
		"documentRevealManager": null,
		"spawnCutsceneActor": func(_id: String, _name: String, _x: float, _y: float) -> void: pass,
		"removeCutsceneActor": func(_id: String) -> void: pass,
		"setSceneEntityField": func(_scene_id: String, _kind: String, _entity_id: String, _field_name: String, _value: Variant) -> void: pass,
		"setHotspotDisplayImage": func(_scene_id: String, _hotspot_id: String, _image: String, _width: Variant, _height: Variant, _facing: Variant) -> void: pass,
		"tempSetHotspotDisplayFacing": func(_scene_id: String, _hotspot_id: String, _facing: String) -> void: pass,
		"debugPanelLog": func(_message: String) -> void: pass,
		"waterMinigameManager": null,
		"sugarWheelMinigameManager": null,
		"paperCraftMinigameManager": null,
		"pressureHoldManager": null,
		"signalCueManager": SignalCueManagerStub.new(),
		"healthSystem": null,
		"smellSystem": null,
		"planeReconciler": null,
	}
	for key: Variant in overrides:
		result[key] = overrides[key]
	return result
