extends "res://scripts/bootstrap.gd"


func _load_game_config() -> void:
	await super()
	# Keep startup itself silent and side-effect free.  The contract test loads
	# both target scenes explicitly after every Game listener has been installed.
	game_config.initialScene = "test_room_b"
	game_config.initialQuest = ""
	game_config.erase("initialCutscene")
	game_config.erase("initialCutsceneDoneFlag")

