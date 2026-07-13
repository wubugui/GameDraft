class_name RuntimeRenderer
extends Node

var world_container: CanvasGroup
var background_layer: Node2D
var shadow_layer: Node2D
var entity_layer: Node2D
var cutscene_overlay: CanvasLayer
var ui_layer: CanvasLayer
var _asset_manager: RuntimeAssetManager
var _initialized := false
var _torn_down := false
var _viewport_width := 0
var _viewport_height := 0
var _window_width := 0
var _window_height := 0
var _after_resize_callbacks: Array[Callable] = []
var _world_filters: Array = []
var world_filter_pipeline: RuntimeWorldFilterPipeline


func set_asset_manager(asset_manager: RuntimeAssetManager) -> void: _asset_manager = asset_manager


func init_renderer() -> void:
	if _initialized: return
	_torn_down = false
	RenderingServer.set_default_clear_color(Color("1a1a2e"))
	world_container = CanvasGroup.new(); world_container.name = "WorldContainer"
	background_layer = Node2D.new(); background_layer.name = "BackgroundLayer"
	shadow_layer = Node2D.new(); shadow_layer.name = "ShadowLayer"
	entity_layer = Node2D.new(); entity_layer.name = "EntityLayer"
	cutscene_overlay = CanvasLayer.new(); cutscene_overlay.name = "CutsceneOverlay"; cutscene_overlay.layer = 50
	ui_layer = CanvasLayer.new(); ui_layer.name = "UILayer"; ui_layer.layer = 100
	add_child(world_container); world_container.add_child(background_layer); world_container.add_child(shadow_layer); world_container.add_child(entity_layer); add_child(cutscene_overlay); add_child(ui_layer)
	world_filter_pipeline = RuntimeWorldFilterPipeline.new(world_container)
	_initialized = true


func subscribe_after_resize(callback: Callable) -> Callable:
	if callback.is_valid() and not _after_resize_callbacks.has(callback): _after_resize_callbacks.push_back(callback)
	return Callable(self, "_unsubscribe_after_resize").bind(callback)


func set_viewport_size(width: int, height: int) -> void:
	_viewport_width = width; _viewport_height = height
	if is_inside_tree():
		if width > 0 and height > 0:
			get_tree().root.content_scale_size = Vector2i(width, height)
		else:
			get_tree().root.content_scale_size = Vector2i.ZERO
	_notify_after_resize()


func get_viewport_size() -> Variant:
	return {"width": _viewport_width, "height": _viewport_height} if _viewport_width > 0 and _viewport_height > 0 else null


func set_window_size(width: int, height: int) -> void:
	_window_width = width; _window_height = height
	if DisplayServer.get_name() != "headless":
		if width > 0 and height > 0: DisplayServer.window_set_size(Vector2i(width, height))
	_notify_after_resize()


func get_window_size_request() -> Variant:
	return {"width": _window_width, "height": _window_height} if _window_width > 0 and _window_height > 0 else null


func sort_entity_layer(player_foot_x: Variant = null, player_foot_y: Variant = null) -> void:
	if entity_layer == null: return
	var has_player := (player_foot_x is int or player_foot_x is float) and (player_foot_y is int or player_foot_y is float)
	for child: Node in entity_layer.get_children():
		if not child is Node2D: continue
		var node: Node2D = child
		var band := str(node.get_meta("entitySortBand")) if node.has_meta("entitySortBand") else ""
		var polygon: Variant = node.get_meta("entityOcclusionPolygon") if node.has_meta("entityOcclusionPolygon") else null
		if has_player and polygon is Array and polygon.size() >= 3:
			var side := _point_polygon_vertical_side(polygon, float(player_foot_x), float(player_foot_y))
			if side == "below": band = "back"
			elif side in ["above", "inside"]: band = "front"
		var base := clampi(int(round(node.global_position.y)), -1500, 1500)
		node.z_index = clampi(base + (-2000 if band == "back" else (2000 if band == "front" else 0)), -4096, 4096)


func get_screen_width() -> float:
	if _torn_down: return 800.0
	if _viewport_width > 0: return float(_viewport_width)
	return get_viewport().get_visible_rect().size.x if is_inside_tree() else 800.0


func get_screen_height() -> float:
	if _torn_down: return 600.0
	if _viewport_height > 0: return float(_viewport_height)
	return get_viewport().get_visible_rect().size.y if is_inside_tree() else 600.0


func is_initialized() -> bool: return _initialized


func set_world_filters(filters: Array) -> void: _world_filters = filters.duplicate(); world_filter_pipeline.set_filters(filters)
func set_world_filter(filter: Variant) -> void: set_world_filters([] if filter == null else [filter])
func clear_world_filter() -> void: _world_filters.clear(); world_filter_pipeline.clear()
func get_world_filters() -> Array: return _world_filters.duplicate()


func get_debug_render_state() -> Dictionary:
	var logical_position := world_container.position - RuntimeCamera.RASTER_PHASE
	return {
		"worldX": logical_position.x,
		"worldY": logical_position.y,
		"worldScaleX": world_container.scale.x,
		"worldScaleY": world_container.scale.y,
		"worldFilterCount": world_filter_pipeline.get_filters().size(),
		"worldFilterApplied": world_container.material != null,
	}


func load_and_set_world_filter(filter_id: String) -> bool:
	if _asset_manager == null: return false
	var definition: Variant = _asset_manager.load_filter(filter_id)
	if not definition is Dictionary: return false
	set_world_filter(definition)
	return world_filter_pipeline.has_filters()


func destroy_renderer() -> void:
	if _torn_down: return
	_torn_down = true; _initialized = false; _after_resize_callbacks.clear(); _world_filters.clear()
	if world_filter_pipeline != null: world_filter_pipeline.clear()
	for child: Node in get_children(): remove_child(child); child.free()
	world_container = null; background_layer = null; shadow_layer = null; entity_layer = null; cutscene_overlay = null; ui_layer = null
	world_filter_pipeline = null


func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_SIZE_CHANGED and _initialized and not _torn_down and not (_viewport_width > 0 and _viewport_height > 0): _notify_after_resize()


func _unsubscribe_after_resize(callback: Callable) -> void: _after_resize_callbacks.erase(callback)


func _notify_after_resize() -> void:
	for callback: Callable in _after_resize_callbacks.duplicate():
		if callback.is_valid(): callback.call()


func _point_polygon_vertical_side(polygon: Array, x: float, y: float) -> String:
	var inside := false; var crossings: Array[float] = []
	for index in polygon.size():
		var a: Variant = polygon[index]; var b: Variant = polygon[(index + 1) % polygon.size()]
		if not a is Dictionary or not b is Dictionary: continue
		var ax := float(a.get("x", 0)); var ay := float(a.get("y", 0)); var bx := float(b.get("x", 0)); var by := float(b.get("y", 0))
		if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax: inside = not inside
		if (ax <= x and bx >= x) or (bx <= x and ax >= x):
			if ax != bx: crossings.push_back(ay + (x - ax) * (by - ay) / (bx - ax))
	if inside: return "inside"
	if crossings.is_empty(): return "outside"
	var min_y: float = crossings.min(); var max_y: float = crossings.max()
	if y > max_y: return "below"
	if y < min_y: return "above"
	return "inside"
