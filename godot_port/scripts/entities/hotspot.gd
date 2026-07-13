class_name RuntimeHotspot
extends RefCounted

const TYPE_COLORS := {"inspect": Color("44aaff"), "pickup": Color("ffcc44"), "transition": Color("44ff88")}

var def: Dictionary
var container: Node2D
var marker: Polygon2D
var display_sprite: Sprite2D
var prompt_icon: Node2D
var _base_enabled := true
var _condition_enabled := true
var _session_enabled_override: Variant = null
var _picked_up := false
var _active := true
var _runtime_display_facing_override: Variant = null
var _display_world_height := 0.0
var _depth_occlusion_filter: Variant = null
var _pixel_density_match_active := false
var _destroyed := false


func _init(definition: Dictionary) -> void:
	def = definition.duplicate(true); container = Node2D.new(); container.name = str(def.get("id", "Hotspot"))
	marker = Polygon2D.new(); marker.name = "Marker"; marker.polygon = _circle_polygon(8.0, 20); marker.color = TYPE_COLORS.get(str(def.get("type", "")), Color.WHITE); marker.modulate.a = 0.6
	var ring := Line2D.new(); ring.name = "MarkerRing"; ring.points = _circle_polygon(12.0, 40); ring.closed = true; ring.width = 1.0; ring.default_color = Color(marker.color, 0.5); marker.add_child(ring)
	container.add_child(marker)
	_sync_container_position(); _sync_entity_sort_band()


static func is_valid_display_image(value: Variant) -> bool:
	return value is Dictionary and not str(value.get("image", "")).strip_edges().is_empty() and (value.get("worldWidth") is int or value.get("worldWidth") is float) and is_finite(float(value.worldWidth)) and float(value.worldWidth) > 0 and (value.get("worldHeight") is int or value.get("worldHeight") is float) and is_finite(float(value.worldHeight)) and float(value.worldHeight) > 0


static func apply_runtime_override(definition: Dictionary, override: Variant) -> Dictionary:
	if not override is Dictionary: return definition
	var output := definition.duplicate(true)
	for field: String in ["x", "y", "displayImage"]:
		if not override.has(field): continue
		var value: Variant = override[field]
		if value == null: output.erase(field)
		elif field in ["x", "y"] and (value is int or value is float): output[field] = value
		elif field == "displayImage" and is_valid_display_image(value): output[field] = value.duplicate(true)
	return output


static func collision_polygon_to_world(definition: Dictionary) -> Variant:
	var polygon: Variant = definition.get("collisionPolygon")
	if not _is_valid_polygon(polygon): return null
	var output: Array = []
	var is_local: bool = definition.get("collisionPolygonLocal") == true; var anchor := Vector2(float(definition.get("x", 0)), float(definition.get("y", 0)))
	for point: Dictionary in polygon:
		output.push_back({"x": float(point.x) + (anchor.x if is_local else 0.0), "y": float(point.y) + (anchor.y if is_local else 0.0)})
	return output


func load_display_image(asset_manager: RuntimeAssetManager) -> bool:
	var image_def: Variant = def.get("displayImage")
	if not is_valid_display_image(image_def): set_display_texture(null, 0, 0); return false
	var texture: Variant = asset_manager.load_texture(str(image_def.image))
	if not texture is Texture2D: return false
	set_display_texture(texture, float(image_def.worldWidth), float(image_def.worldHeight)); return true


func set_display_texture(texture: Variant, world_width: float, world_height: float) -> void:
	if display_sprite != null:
		container.remove_child(display_sprite); display_sprite.free(); display_sprite = null
	_display_world_height = 0.0
	if not texture is Texture2D or world_width <= 0 or world_height <= 0:
		marker.visible = true; _sync_entity_sort_band(); return
	display_sprite = Sprite2D.new(); display_sprite.name = "DisplaySprite"; display_sprite.texture = texture; display_sprite.centered = true; display_sprite.position = Vector2(0, -world_height / 2.0); display_sprite.scale = Vector2(world_width / maxf(1.0, texture.get_width()), world_height / maxf(1.0, texture.get_height())); _apply_display_image_facing(); container.add_child(display_sprite); container.move_child(display_sprite, 0)
	_display_world_height = world_height; marker.visible = false; _sync_entity_sort_band()


func set_runtime_display_facing(value: Variant) -> void:
	_runtime_display_facing_override = value if value in ["left", "right"] else null
	_apply_display_image_facing()


func get_effective_display_facing() -> String:
	if _runtime_display_facing_override != null: return str(_runtime_display_facing_override)
	var image_def: Variant = def.get("displayImage")
	return "left" if image_def is Dictionary and image_def.get("facing") == "left" else "right"


func get_center_x() -> float: return float(def.get("x", 0.0))
func get_center_y() -> float: return float(def.get("y", 0.0))
func get_id() -> String: return str(def.get("id", ""))
func get_interaction_range() -> float: return float(def.get("interactionRange", 0.0))
func get_active() -> bool: return _active
func get_picked_up() -> bool: return _picked_up
func get_display_object() -> Node2D: return container
func get_display_texture() -> Variant: return display_sprite.texture if display_sprite != null else null
func get_facing() -> int: return -1 if get_effective_display_facing() == "left" else 1
func get_world_size() -> Dictionary:
	var image_def: Variant = def.get("displayImage")
	return {"width": float(image_def.get("worldWidth", 0.0)) if image_def is Dictionary else 0.0, "height": _display_world_height}
func depth_occlusion_foot_world_y() -> float: return container.position.y
func has_depth_display_image() -> bool: return display_sprite != null and _display_world_height > 0
func get_depth_occlusion_filter() -> Variant: return _depth_occlusion_filter
func is_destroyed() -> bool: return _destroyed


func set_position(x: float, y: float) -> void: def.x = x; def.y = y; _sync_container_position(); _sync_entity_sort_band()
func set_enabled(value: bool) -> void: set_session_enabled_override(null if value else false)
func set_session_enabled_override(value: Variant) -> void: _session_enabled_override = value; _apply_effective_active()
func set_derived_base_enabled(value: bool) -> void: _base_enabled = value; _apply_effective_active()
func set_condition_enabled(value: bool) -> void: _condition_enabled = value; _apply_effective_active()
func mark_picked_up() -> void: _picked_up = true; _apply_effective_active()


func attach_depth_occlusion_filter(filter: Variant) -> void: _depth_occlusion_filter = filter
func detach_depth_occlusion_filter() -> Variant: var result: Variant = _depth_occlusion_filter; _depth_occlusion_filter = null; return result


func apply_entity_pixel_density_match(enabled: bool, background_density: Variant = null, _strength_scale := 1.0) -> void:
	_pixel_density_match_active = enabled and display_sprite != null and background_density != null
	if display_sprite != null: display_sprite.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR if _pixel_density_match_active else CanvasItem.TEXTURE_FILTER_PARENT_NODE
func get_pixel_density_match_active() -> bool: return _pixel_density_match_active


func get_emote_bounds_probe() -> Node2D: return display_sprite if display_sprite != null else container
func get_emote_world_quad() -> Dictionary:
	var size := get_world_size()
	if display_sprite != null and float(size.width) > 0 and float(size.height) > 0: return {"left": container.position.x - float(size.width) / 2.0, "top": container.position.y - float(size.height), "width": float(size.width), "height": float(size.height)}
	return {"left": container.position.x - 8.0, "top": container.position.y - 8.0, "width": 16.0, "height": 16.0}
func get_emote_bubble_anchor_local_y() -> float: return -_display_world_height - 8.0 if display_sprite != null and _display_world_height > 0 else -24.0


func show_prompt() -> void:
	if prompt_icon != null: return
	prompt_icon = Node2D.new(); prompt_icon.name = "PromptIcon"; var background := Polygon2D.new(); background.polygon = PackedVector2Array([Vector2(-14, -28), Vector2(14, -28), Vector2(14, -6), Vector2(-14, -6)]); background.color = Color(0, 0, 0, 0.7); prompt_icon.add_child(background)
	var label := Label.new(); label.text = "E"; label.position = Vector2(-14, -28); label.size = Vector2(28, 22); label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER; label.add_theme_font_size_override("font_size", 14); prompt_icon.add_child(label); container.add_child(prompt_icon)


func hide_prompt() -> void:
	if prompt_icon == null: return
	container.remove_child(prompt_icon); prompt_icon.free(); prompt_icon = null


func destroy_hotspot() -> void:
	if _destroyed: return
	_destroyed = true; hide_prompt(); _depth_occlusion_filter = null; display_sprite = null
	if container != null and is_instance_valid(container):
		if container.get_parent() != null: container.get_parent().remove_child(container)
		container.free()


func _apply_effective_active() -> void:
	var next: bool = _base_enabled and _condition_enabled and _session_enabled_override != false and not _picked_up
	_active = next
	if not next: hide_prompt()
	container.visible = next


func _sync_container_position() -> void: container.position = Vector2(float(def.get("x", 0)), float(def.get("y", 0)))


func _sync_entity_sort_band() -> void:
	container.remove_meta("entitySortBand"); container.remove_meta("entityOcclusionPolygon")
	var image_def: Variant = def.get("displayImage")
	if display_sprite != null and is_valid_display_image(image_def) and image_def.get("spriteSort") in ["back", "front"]: container.set_meta("entitySortBand", image_def.spriteSort)
	var polygon: Variant = collision_polygon_to_world(def)
	if polygon is Array: container.set_meta("entityOcclusionPolygon", polygon)


func _apply_display_image_facing() -> void:
	if display_sprite == null: return
	display_sprite.scale.x = (-1.0 if get_effective_display_facing() == "left" else 1.0) * absf(display_sprite.scale.x)


static func _is_valid_polygon(polygon: Variant) -> bool:
	if not polygon is Array or polygon.size() < 3: return false
	for point: Variant in polygon:
		if not point is Dictionary or not (point.get("x") is int or point.get("x") is float) or not (point.get("y") is int or point.get("y") is float) or not is_finite(float(point.x)) or not is_finite(float(point.y)): return false
	return true


func _circle_polygon(radius: float, segments: int) -> PackedVector2Array:
	var points := PackedVector2Array()
	for index in segments: points.push_back(Vector2.from_angle(TAU * index / segments) * radius)
	return points
