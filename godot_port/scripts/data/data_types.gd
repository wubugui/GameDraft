class_name RuntimeDataTypes
extends RefCounted

const MAIN_MENU := "MainMenu"
const EXPLORING := "Exploring"
const ACTION_SEQUENCE := "ActionSequence"
const DIALOGUE := "Dialogue"
const ENCOUNTER := "Encounter"
const CUTSCENE := "Cutscene"
const UI_OVERLAY := "UIOverlay"
const MINIGAME := "Minigame"


static func entity_cutscene_ids(definition: Dictionary) -> Array[String]:
	var output: Array[String] = []
	var raw_ids: Variant = definition.get("cutsceneIds")
	if raw_ids is Array:
		for raw: Variant in raw_ids:
			var id: String = raw.strip_edges() if raw is String else ""
			if not id.is_empty() and not output.has(id):
				output.push_back(id)
	return output


static func is_entity_bound_to_cutscene(definition: Dictionary, active_id: Variant) -> bool:
	var id: String = active_id.strip_edges() if active_id is String else ""
	return not id.is_empty() and entity_cutscene_ids(definition).has(id)


static func has_cutscene_binding(definition: Dictionary) -> bool:
	return not entity_cutscene_ids(definition).is_empty()


static func is_cutscene_only_entity(definition: Dictionary) -> bool:
	var cutscene_only: Variant = definition.get("cutsceneOnly")
	return has_cutscene_binding(definition) and not (cutscene_only is bool and cutscene_only == false)


static func is_shared_cutscene_entity(definition: Dictionary) -> bool:
	var cutscene_only: Variant = definition.get("cutsceneOnly")
	return has_cutscene_binding(definition) and cutscene_only is bool and cutscene_only == false


const QUEST_INACTIVE := 0
const QUEST_ACTIVE := 1
const QUEST_COMPLETED := 2
const QUEST_STATUS_BY_NAME := {"Inactive": QUEST_INACTIVE, "Active": QUEST_ACTIVE, "Completed": QUEST_COMPLETED}
const QUEST_STATUS_NAME := {QUEST_INACTIVE: "Inactive", QUEST_ACTIVE: "Active", QUEST_COMPLETED: "Completed"}

const CUTSCENE_ACTION_WHITELIST := [
	"moveEntityTo", "faceEntity", "cutsceneSpawnActor", "cutsceneRemoveActor",
	"showEmoteAndWait", "showSpeechBubble", "showSpeechBubbleAndWait", "playNpcAnimation",
	"setEntityEnabled", "persistNpcDisablePatrol", "persistNpcEnablePatrol",
	"persistNpcEntityEnabled", "persistHotspotEnabled", "setZoneEnabled", "persistZoneEnabled",
	"persistNpcAt", "persistNpcAnimState", "persistPlayNpcAnimation", "setEntityField",
	"setSceneEntityPosition", "setHotspotDisplayImage", "tempSetHotspotDisplayFacing",
	"playSfx", "playBgm", "stopBgm", "playSignalCue", "startWaterMinigame",
	"startSugarWheelMinigame", "sugarWheelShowSpeech", "sugarWheelDismissSpeech",
	"sugarWheelDismissAllSpeech", "sugarWheelResetPointer", "randomBranch",
	"activatePlane", "deactivatePlane",
]

const CUTSCENE_ANON_SHOT_ID := "__anonShot"
