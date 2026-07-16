extends Node

const RuntimeFilterLoaderScript := preload("res://scripts/rendering/filter/filter_loader.gd")

var resize_count := 0


func _ready() -> void:
	var renderer := RuntimeRenderer.new(); add_child(renderer); renderer.init()
	assert(renderer.is_initialized() and renderer.app == renderer)
	assert(renderer.get_children().map(func(node: Node) -> String: return node.name) == ["WorldContainer", "CutsceneOverlay", "UILayer"] and renderer.world_container is CanvasGroup)
	assert(renderer.world_container.get_children().map(func(node: Node) -> String: return node.name) == ["BackgroundLayer", "ShadowLayer", "EntityLayer"])
	assert(renderer.background_layer is Node2D and not renderer.background_layer is CanvasGroup)
	assert(renderer.cutscene_overlay.layer < renderer.ui_layer.layer)
	var unsubscribe := renderer.subscribe_after_resize(Callable(self, "_resized"))
	renderer.set_viewport_size(640, 360)
	assert(renderer.get_viewport_size() == {"width": 640, "height": 360})
	assert(renderer.screen_width == 640 and renderer.screen_height == 360 and resize_count == 1)
	renderer.set_window_size(1024, 768); assert(resize_count == 1)
	unsubscribe.call(); renderer.set_viewport_size(800, 600); assert(resize_count == 1)

	var normal := Node2D.new(); normal.position.y = 50; renderer.entity_layer.add_child(normal)
	var back := Node2D.new(); back.position.y = 500; back.set_meta("entitySortBand", "back"); renderer.entity_layer.add_child(back)
	var front := Node2D.new(); front.position.y = -500; front.set_meta("entitySortBand", "front"); renderer.entity_layer.add_child(front)
	renderer.sort_entity_layer(); assert(back.z_index < normal.z_index and normal.z_index < front.z_index)
	var occluder := Node2D.new(); occluder.set_meta("entityOcclusionPolygon", [{"x": 0, "y": 0}, {"x": 100, "y": 0}, {"x": 100, "y": 100}, {"x": 0, "y": 100}]); renderer.entity_layer.add_child(occluder)
	renderer.sort_entity_layer(50, 150); assert(occluder.z_index < normal.z_index)
	renderer.sort_entity_layer(50, -20); assert(occluder.z_index > normal.z_index)
	var matrix := [0.9, 0.15, 0.05, 0.0, 0.02, 0.1, 0.8, 0.1, 0.0, 0.02, 0.05, 0.1, 0.75, 0.0, 0.02, 0.0, 0.0, 0.0, 1.0, 0.0]
	renderer.set_world_filters([RuntimeFilterLoaderScript.create_filter_from_def({"matrix": matrix, "alpha": 0.75})]); assert(renderer.world_filter_pipeline.get_filters().size() == 1 and renderer.world_filter_pipeline.has_filters() and renderer.world_container.material is ShaderMaterial)
	var filter_material: ShaderMaterial = renderer.world_container.material; var projection: Projection = filter_material.get_shader_parameter("color_matrix"); var transformed: Vector4 = projection * Vector4(0.2, 0.4, 0.6, 1.0) + filter_material.get_shader_parameter("color_offset")
	assert(transformed.is_equal_approx(Vector4(0.29, 0.42, 0.52, 1.0)) and is_equal_approx(float(filter_material.get_shader_parameter("filter_alpha")), 0.75))
	renderer.clear_world_filter(); assert(renderer.world_filter_pipeline.get_filters().is_empty() and renderer.world_container.material == null)
	renderer.destroy(); assert(not renderer.is_initialized() and renderer.get_child_count() == 0 and renderer.screen_width == 800 and renderer.screen_height == 600)
	remove_child(renderer); renderer.free(); print("Renderer layer/resize lifecycle test: PASS"); get_tree().quit(0)


func _resized() -> void: resize_count += 1
