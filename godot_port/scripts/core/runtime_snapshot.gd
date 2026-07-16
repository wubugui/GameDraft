class_name RuntimeSnapshot
extends RefCounted


static func capture(
	runtime_root: RuntimeRoot,
	reason: String,
	boot_id: String,
	last_results: Array = [],
	core_fragments: Dictionary = {},
) -> Dictionary:
	var snapshot := {
		"reason": reason,
		"capturedAt": Time.get_datetime_string_from_system(true),
		"currentSceneId": null,
		"gameState": "MainMenu",
		"previousGameState": null,
		"flags": {},
		"questState": {},
		"scenarioState": {},
		"narrativeEval": {},
		"narrativeState": {"activeStates": {}, "recentTrace": [], "recentTransitions": [], "recentIssues": []},
		"documentReveals": {},
		"eventTrace": [],
		"saveData": {},
		"runtimeRandomState": 1,
		"activeZones": [],
		"uiState": {"overlayReturnStack": [], "openPanels": []},
		"audioState": {"currentBgmId": null, "ambientIds": [], "volumes": {}},
		"inFlight": {},
		"dialogue": {},
		"dialogueView": {},
		"player": {"x": 0.0, "y": 0.0, "facing": "right"},
		"planes": {},
		"inventory": {},
		"interactables": [],
		"playerView": {
			"mode": "menu",
			"scene": null,
			"player": {"x": 0.0, "y": 0.0, "facing": "right"},
			"entities": [],
			"interactionPrompt": null,
			"dialogue": null,
			"hud": {"coins": 0, "questTracker": ""},
			"navTargetActive": false,
		},
		"runtimeCommands": {"lastResults": last_results.duplicate(true)},
		"recentPageErrors": [],
		"bootId": boot_id,
	}
	var fragments := runtime_root.debug_snapshot_fragments()
	for key: Variant in fragments:
		# The live parity protocol has a frozen canonical field set. Systems may
		# publish richer local debug fragments (archive/health/day/etc.); do not
		# leak those as runtime-specific top-level fields into the shared snapshot.
		if snapshot.has(key): snapshot[key] = fragments[key]
	for key: Variant in core_fragments:
		snapshot[key] = core_fragments[key]
	return snapshot
