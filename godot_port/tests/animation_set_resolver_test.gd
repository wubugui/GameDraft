extends SceneTree

const AnimationSetResolver = preload("res://scripts/utils/animation_set_resolver.gd")


func _init() -> void:
	_test_effective_cell_pixel_size()
	_test_resolve_animation_world_size()
	_test_normalize_animation_set_def()
	print("AnimationSet normalization direct-translation test: PASS")
	quit(0)


func _test_effective_cell_pixel_size() -> void:
	assert(AnimationSetResolver.effective_cell_pixel_size(
		{"cols": 4, "rows": 2}, 800.0, 200.0,
	) == {"cellW": 200.0, "cellH": 100.0})
	assert(AnimationSetResolver.effective_cell_pixel_size(
		{"cols": 0, "rows": -2, "cellWidth": 24, "cellHeight": 0}, 800.0, 200.0,
	) == {"cellW": 24.0, "cellH": 200.0})


func _test_resolve_animation_world_size() -> void:
	var base := {"cols": 3, "rows": 2, "cellWidth": 10, "cellHeight": 7}
	var both := base.duplicate()
	both.worldWidth = 48
	both.worldHeight = 77
	assert(AnimationSetResolver.resolve_animation_world_size(both, 30.0, 14.0) == {
		"worldWidth": 48,
		"worldHeight": 77,
	})
	var width_only := base.duplicate()
	width_only.worldWidth = 100
	assert(AnimationSetResolver.resolve_animation_world_size(width_only, 30.0, 14.0) == {
		"worldWidth": 100,
		"worldHeight": 70.0,
	})
	var height_only := base.duplicate()
	height_only.worldHeight = 70
	assert(AnimationSetResolver.resolve_animation_world_size(height_only, 30.0, 14.0) == {
		"worldWidth": 100.0,
		"worldHeight": 70,
	})
	assert(AnimationSetResolver.resolve_animation_world_size(base, 30.0, 14.0) == {
		"worldWidth": 100.0,
		"worldHeight": 70.0,
	})


func _test_normalize_animation_set_def() -> void:
	var states := {"idle": {"frames": [0, 1], "frameRate": 2, "loop": true}}
	var input := {
		"spritesheet": "atlas.png",
		"cols": 3,
		"rows": 2,
		"worldHeight": 70,
		"states": states,
	}
	var normalized: Dictionary = AnimationSetResolver.normalize_animation_set_def(input, 10.0, 7.0)
	assert(normalized == {
		"spritesheet": "atlas.png",
		"cols": 3,
		"rows": 2,
		"worldHeight": 70,
		"states": states,
		"worldWidth": 66.666667,
		"cellWidth": 3.333333,
		"cellHeight": 3.5,
	})
	assert(normalized.keys() == [
		"spritesheet", "cols", "rows", "worldHeight", "states", "worldWidth", "cellWidth", "cellHeight",
	])
	assert(not input.has("worldWidth") and not input.has("cellWidth") and not input.has("cellHeight"))
	normalized.states.idle.frames.push_back(2)
	assert(input.states.idle.frames == [0, 1, 2])
