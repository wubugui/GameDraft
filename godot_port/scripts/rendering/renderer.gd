class_name RuntimeRenderer
extends Node

const RuntimeFilterLoaderScript := preload("res://scripts/rendering/filter/filter_loader.gd")

# RuntimeRenderer itself is the Godot equivalent of Pixi Application: it owns
# the render-tree root and the engine viewport/window adapter.
var app: Node
var world_container: CanvasGroup
var background_layer: Node2D
var shadow_layer: Node2D
var entity_layer: Node2D
var cutscene_overlay: CanvasLayer
var ui_layer: CanvasLayer
var world_filter_pipeline: RuntimeWorldFilterPipeline
var _asset_manager: RuntimeAssetManager = null

var _initialized := false
var _torn_down := false
var _after_resize_callbacks: Array[Callable] = []
var _viewport_width := 0
var _viewport_height := 0

var screen_width: float:
	get:
		if _torn_down or not _initialized:
			return _fallback_screen_size().x
		return get_viewport().get_visible_rect().size.x if is_inside_tree() else _fallback_screen_size().x

var screen_height: float:
	get:
		if _torn_down or not _initialized:
			return _fallback_screen_size().y
		return get_viewport().get_visible_rect().size.y if is_inside_tree() else _fallback_screen_size().y


func _init() -> void:
	app = self
	world_container = CanvasGroup.new()
	world_container.name = "WorldContainer"
	background_layer = Node2D.new()
	background_layer.name = "BackgroundLayer"
	shadow_layer = Node2D.new()
	shadow_layer.name = "ShadowLayer"
	entity_layer = Node2D.new()
	entity_layer.name = "EntityLayer"
	cutscene_overlay = CanvasLayer.new()
	cutscene_overlay.name = "CutsceneOverlay"
	cutscene_overlay.layer = 50
	ui_layer = CanvasLayer.new()
	ui_layer.name = "UILayer"
	ui_layer.layer = 100
	world_filter_pipeline = RuntimeWorldFilterPipeline.new(world_container)


func set_asset_manager(asset_manager: RuntimeAssetManager) -> void:
	_asset_manager = asset_manager


func init(options: Dictionary = {}) -> void:
	if _initialized:
		return
	_torn_down = false
	var requested_resolution: Variant = options.get("resolution")
	var _resolution_adapter := float(requested_resolution) if (requested_resolution is int or requested_resolution is float) and is_finite(float(requested_resolution)) and float(requested_resolution) > 0.0 else 1.0
	RenderingServer.set_default_clear_color(Color("1a1a2e"))
	world_container.add_child(background_layer)
	world_container.add_child(shadow_layer)
	world_container.add_child(entity_layer)
	add_child(world_container)
	add_child(cutscene_overlay)
	add_child(ui_layer)
	_initialized = true


func subscribe_after_resize(callback: Callable) -> Callable:
	if callback.is_valid() and not _after_resize_callbacks.has(callback):
		_after_resize_callbacks.push_back(callback)
	return func() -> void: _after_resize_callbacks.erase(callback)


func _notify_after_resize() -> void:
	for callback: Callable in _after_resize_callbacks.duplicate():
		if callback.is_valid():
			callback.call()


func set_viewport_size(width: int, height: int) -> void:
	_viewport_width = width
	_viewport_height = height
	if is_inside_tree():
		get_tree().root.content_scale_size = Vector2i(width, height) if width > 0 and height > 0 else Vector2i.ZERO
	_notify_after_resize()


func get_viewport_size() -> Variant:
	if _viewport_width > 0 and _viewport_height > 0:
		return {"width": _viewport_width, "height": _viewport_height}
	return null


func set_window_size(width: int, height: int) -> void:
	if DisplayServer.get_name() == "headless":
		return
	if width > 0 and height > 0:
		DisplayServer.window_set_size(Vector2i(width, height))
	elif is_inside_tree():
		DisplayServer.window_set_size(Vector2i(ProjectSettings.get_setting("display/window/size/window_width_override", 1024), ProjectSettings.get_setting("display/window/size/window_height_override", 768)))
	if _initialized and not _torn_down and not (_viewport_width > 0 and _viewport_height > 0):
		_notify_after_resize()


func sort_entity_layer(player_foot_x: Variant = null, player_foot_y: Variant = null) -> void:
	if entity_layer == null:
		return
	var has_player := (player_foot_x is int or player_foot_x is float) and (player_foot_y is int or player_foot_y is float)
	for child: Node in entity_layer.get_children():
		if not child is Node2D:
			continue
		var node: Node2D = child
		var band := str(node.get_meta("entitySortBand")) if node.has_meta("entitySortBand") else ""
		var polygon: Variant = node.get_meta("entityOcclusionPolygon") if node.has_meta("entityOcclusionPolygon") else null
		if has_player and polygon is Array and polygon.size() >= 3:
			var side: Variant = RuntimeZoneGeometry.point_polygon_vertical_side(polygon, float(player_foot_x), float(player_foot_y))
			if side == "below":
				band = "back"
			elif side == "above" or side == "inside":
				band = "front"
		var base := roundi(node.position.y)
		node.z_index = clampi(base + (-2048 if band == "back" else (2048 if band == "front" else 0)), -4096, 4096)


func is_initialized() -> bool:
	return _initialized


func destroy() -> void:
	if _torn_down:
		return
	_torn_down = true
	_initialized = false
	_after_resize_callbacks.clear()
	if world_filter_pipeline != null:
		world_filter_pipeline.clear()
	for child: Node in get_children():
		remove_child(child)
		child.free()
	world_container = null
	background_layer = null
	shadow_layer = null
	entity_layer = null
	cutscene_overlay = null
	ui_layer = null
	world_filter_pipeline = null


func set_world_filters(filters: Array) -> void:
	world_filter_pipeline.set_filters(filters)


func set_world_filter(filter: Variant) -> void:
	world_filter_pipeline.set_filters([filter] if filter != null else [])


func load_and_set_world_filter(filter_id: String) -> bool:
	var filter: Variant = _asset_manager.load_filter(filter_id) if _asset_manager != null else RuntimeFilterLoaderScript.load_filter(filter_id)
	if not filter is Material:
		return false
	set_world_filter(filter)
	return true


func clear_world_filter() -> void:
	world_filter_pipeline.clear()


func get_debug_render_state() -> Dictionary:
	var logical_position := world_container.position - RuntimeCamera.RASTER_PHASE
	return {
		"worldX": logical_position.x,
		"worldY": logical_position.y,
		"worldScaleX": world_container.scale.x,
		"worldScaleY": world_container.scale.y,
		"worldFilterCount": world_filter_pipeline.get_filters().size(),
		"worldFilterApplied": world_filter_pipeline.has_filters(),
	}


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_SIZE_CHANGED and _initialized and not _torn_down and not (_viewport_width > 0 and _viewport_height > 0):
		_notify_after_resize()


func _fallback_screen_size() -> Vector2:
	if DisplayServer.get_name() != "headless":
		var size := DisplayServer.window_get_size()
		if size.x > 0 and size.y > 0:
			return Vector2(size)
	return Vector2(800, 600)
