extends Node

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")


func _ready() -> void:
	var regular := {}
	var cutscene_only := {"cutsceneIds": ["intro", "dock"]}
	var shared := {"cutsceneIds": ["intro"], "cutsceneOnly": false}

	assert(RuntimeDataTypes.entity_cutscene_ids(regular) == [])
	assert(not RuntimeDataTypes.has_cutscene_binding(regular))
	assert(not RuntimeDataTypes.is_cutscene_only_entity(regular))

	assert(RuntimeDataTypes.entity_cutscene_ids(cutscene_only) == ["intro", "dock"])
	assert(RuntimeDataTypes.is_entity_bound_to_cutscene(cutscene_only, "dock"))
	assert(RuntimeDataTypes.is_cutscene_only_entity(cutscene_only))
	assert(not RuntimeDataTypes.is_shared_cutscene_entity(cutscene_only))

	assert(RuntimeDataTypes.is_entity_bound_to_cutscene(shared, "intro"))
	assert(not RuntimeDataTypes.is_cutscene_only_entity(shared))
	assert(RuntimeDataTypes.is_shared_cutscene_entity(shared))
	assert(RuntimeDataTypes.entity_cutscene_ids({"cutsceneIds": [" intro ", 1, "", "intro", null, "dock"]}) == ["intro", "dock"])
	assert(RuntimeDataTypes.is_entity_bound_to_cutscene(cutscene_only, " dock "))
	assert(not RuntimeDataTypes.is_entity_bound_to_cutscene(cutscene_only, null))
	assert(RuntimeDataTypes.is_cutscene_only_entity({"cutsceneIds": ["intro"], "cutsceneOnly": 0}))
	assert(not RuntimeDataTypes.is_shared_cutscene_entity({"cutsceneIds": ["intro"], "cutsceneOnly": 0}))

	assert(RuntimeDataTypes.MAIN_MENU == "MainMenu" and RuntimeDataTypes.EXPLORING == "Exploring")
	assert(RuntimeDataTypes.ACTION_SEQUENCE == "ActionSequence" and RuntimeDataTypes.MINIGAME == "Minigame")
	assert([RuntimeDataTypes.QUEST_INACTIVE, RuntimeDataTypes.QUEST_ACTIVE, RuntimeDataTypes.QUEST_COMPLETED] == [0, 1, 2])
	assert(RuntimeDataTypes.QUEST_STATUS_BY_NAME == {"Inactive": 0, "Active": 1, "Completed": 2})
	assert(RuntimeDataTypes.QUEST_STATUS_NAME == {0: "Inactive", 1: "Active", 2: "Completed"})
	assert(RuntimeDataTypes.CUTSCENE_ANON_SHOT_ID == "__anonShot")
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var allowlist: Variant = JSON.parse_string(FileAccess.get_file_as_string("%s/src/data/cutscene_action_allowlist.json" % repository))
	assert(allowlist is Array and RuntimeDataTypes.CUTSCENE_ACTION_WHITELIST == allowlist)

	print("Data types runtime enum/cutscene-binding/allowlist contract test: PASS")
	get_tree().quit(0)
