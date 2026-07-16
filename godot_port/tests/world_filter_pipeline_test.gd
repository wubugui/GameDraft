extends SceneTree

const RuntimeFilterLoaderScript := preload("res://scripts/rendering/filter/filter_loader.gd")


func _initialize() -> void:
	call_deferred("_run")


func _run() -> void:
	var target := CanvasGroup.new()
	target.name = "Target"
	root.add_child(target)
	var swatch := ColorRect.new()
	swatch.position = Vector2(32, 32)
	swatch.size = Vector2(64, 64)
	swatch.color = Color(1, 0, 0, 1)
	target.add_child(swatch)

	var red_to_green := RuntimeFilterLoaderScript.create_filter_from_def({"matrix": [
		0, 0, 0, 0, 0,
		1, 0, 0, 0, 0,
		0, 0, 0, 0, 0,
		0, 0, 0, 1, 0,
	]})
	var green_to_blue := RuntimeFilterLoaderScript.create_filter_from_def({"matrix": [
		0, 0, 0, 0, 0,
		0, 0, 0, 0, 0,
		0, 1, 0, 0, 0,
		0, 0, 0, 1, 0,
	]})
	var initial_filters: Array = [red_to_green, green_to_blue]
	var pipeline := RuntimeWorldFilterPipeline.new(target)
	pipeline.set_filters(initial_filters)
	assert(is_same(pipeline.get_filters(), initial_filters))
	assert(target.material == red_to_green)
	assert(target.get_parent() is CanvasGroup and target.get_parent().material == green_to_blue)

	if DisplayServer.get_name() != "headless":
		RenderingServer.force_draw(true)
		await process_frame
		RenderingServer.force_draw(true)
		var rendered := root.get_texture().get_image().get_pixel(64, 64)
		assert(rendered.b > 0.9 and rendered.r < 0.1 and rendered.g < 0.1, "ordered filter passes must transform red -> green -> blue")

	var set_identity := pipeline.get_filters()
	pipeline.push_filter(red_to_green)
	assert(not is_same(pipeline.get_filters(), set_identity), "pushFilter spread must replace the array")
	var pushed_identity := pipeline.get_filters()
	assert(pipeline.pop_filter() == red_to_green)
	assert(is_same(pipeline.get_filters(), pushed_identity), "popFilter must mutate the current array")
	pipeline.clear()
	assert(not is_same(pipeline.get_filters(), pushed_identity), "clear must replace the array")
	assert(not pipeline.has_filters() and target.material == null and target.get_parent() == root)
	print("WorldFilterPipeline ordered-pass/reference direct-translation test: PASS")
	quit(0)
