extends Node


func _ready() -> void:
	var renderer := RuntimeRenderer.new()
	add_child(renderer)
	renderer.init()
	var events := RuntimeEventBus.new()
	var hud := RuntimeHUD.new(renderer, events, RuntimeStringsProvider.new())

	assert(hud.smell == null)
	assert(hud.get_smell_form() == null)
	events.emit("player:smellChanged", {"scent": "corpse", "intensity": 80.0, "dir": -0.5, "flicker": true})
	events.emit("player:smellSniff", {})
	assert(hud.smell == null)
	assert(hud.smell_last == {"scent": "corpse", "intensity": 80.0, "dir": -0.5, "flicker": true})

	var profiles := {
		"profiles": {"corpse": {"name": "尸臭", "color": "#8b7a62"}},
		"baseline": {"color": "#969aa2", "breatheFreq": 0.9},
		"transition": {"fadeMs": 800.0},
	}
	hud.set_smell_profiles(profiles)
	var first: RuntimeSmellIndicatorRenderer = hud.smell
	var first_root: Node2D = first.root
	assert(first.get_state() == {"scent": "corpse", "intensity": 80.0, "dir": -0.5, "flicker": true})
	assert(first.display_intensity == 0.0)
	events.emit("player:smellSniff", {})
	assert(first.display_intensity > 0.0)

	hud.set_smell_profiles(profiles)
	assert(hud.smell != first)
	assert(not is_instance_valid(first_root))
	assert(hud.smell.get_state() == {"scent": "corpse", "intensity": 80.0, "dir": -0.5, "flicker": true})

	hud.destroy()
	events.clear()
	renderer.destroy()
	remove_child(renderer)
	renderer.free()
	print("HUD deferred smell profiles/state replay direct-translation test: PASS")
	get_tree().quit(0)
