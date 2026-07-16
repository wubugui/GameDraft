class_name RuntimeNpc
extends RefCounted

const RuntimeCharacterRegistryScript := preload("res://scripts/data/character_registry.gd")


class _MoveCompletion:
	extends RefCounted

	signal completed

	var settled := false


	func resolve() -> void:
		if settled:
			return
		settled = true
		call_deferred("_emit_completed")


	func wait() -> void:
		if not settled:
			await completed


	func _emit_completed() -> void:
		completed.emit()

const MARKER_SIZE := 20.0

var def: Dictionary
var container: Node2D
var sprite: RuntimeSpriteEntity
var name_label: Label
var prompt_icon: Label
var marker: Polygon2D

var _x := 0.0
var _y := 0.0
var _move_target: Dictionary = {}
var _rest_anim_state := ""
var _patrol_paused := false
var _patrol_skip_waypoint_advance := false
var _facing_scale_x_before_dialogue: Variant = null
var _derived_base_visible := true
var _condition_visible := true
var _session_enabled_override: Variant = null
var _destroyed := false


func _init(definition: Dictionary) -> void:
	def = definition.duplicate(true)
	_x = float(def.get("x", 0.0)); _y = float(def.get("y", 0.0))
	container = Node2D.new(); container.name = str(def.get("id", "Npc")); _sync_container_position()
	marker = Polygon2D.new(); marker.name = "PlaceholderMarker"; marker.polygon = _circle_polygon(Vector2(0, -MARKER_SIZE), MARKER_SIZE, 20); marker.color = Color(0.333, 0.667, 0.333, 0.8)
	var foot := Polygon2D.new(); foot.name = "PlaceholderFoot"; foot.polygon = PackedVector2Array([Vector2(-3, -2), Vector2(3, -2), Vector2(3, 2), Vector2(-3, 2)]); foot.color = marker.color; marker.add_child(foot); container.add_child(marker)
	name_label = Label.new(); name_label.name = "NameLabel"; name_label.text = str(def.get("name", "")); name_label.position = Vector2(-50, 6); name_label.size = Vector2(100, 20); name_label.pivot_offset = Vector2(50, 0); name_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; name_label.add_theme_font_size_override("font_size", 11); name_label.add_theme_color_override("font_color", Color(0.667, 0.867, 0.667)); container.add_child(name_label)
	apply_initial_facing()


static func apply_runtime_override(definition: Dictionary, override: Variant) -> Dictionary:
	if not override is Dictionary: return definition
	var output := definition.duplicate(true)
	for field: String in ["x", "y", "animFile", "initialAnimState", "portraitSlug"]:
		if not override.has(field): continue
		var value: Variant = override[field]
		if value == null: output.erase(field)
		elif field in ["x", "y"] and (value is int or value is float): output[field] = value
		elif field not in ["x", "y"] and value is String: output[field] = value
	return output


func load_sprite_from_path(manifest_path: String, asset_manager: RuntimeAssetManager, initial_state := "") -> bool:
	var definition: Variant = asset_manager.load_json(manifest_path)
	if not definition is Dictionary: return false
	var sheet := str(definition.get("spritesheet", ""))
	if sheet.is_empty(): return false
	var texture: Variant = asset_manager.load_texture("%s/%s" % [manifest_path.get_base_dir(), sheet])
	if not texture is Texture2D: return false
	load_sprite(texture, definition, initial_state); return true


func load_sprite(texture: Texture2D, animation_def: Dictionary, initial_state := "") -> void:
	if sprite != null:
		container.remove_child(sprite); sprite.destroy(); sprite.free()
	if marker != null:
		container.remove_child(marker); marker.free(); marker = null
	sprite = RuntimeSpriteEntity.new(); sprite.name = "SpriteEntity"; sprite.load_from_def(texture, animation_def)
	var wanted := str(initial_state).strip_edges(); var states: Dictionary = animation_def.get("states", {})
	if not wanted.is_empty() and states.has(wanted): _rest_anim_state = wanted
	elif states.has("idle"): _rest_anim_state = "idle"
	elif not states.is_empty(): _rest_anim_state = str(states.keys()[0])
	else: _rest_anim_state = ""
	if not _rest_anim_state.is_empty(): sprite.play_animation(_rest_anim_state)
	container.add_child(sprite); container.move_child(sprite, 0); sprite.x = 0; sprite.y = 0; apply_initial_facing()


func apply_initial_facing() -> void:
	var facing := str(def.get("initialFacing", "right"))
	if facing == "left": set_facing(-1, 0)
	elif facing == "right": set_facing(1, 0)


func get_entity_id() -> String: return str(def.get("id", ""))
func get_id() -> String: return get_entity_id()
func get_x() -> float: return _x
func set_x(value: float) -> void: _x = value; _sync_container_position()
func get_y() -> float: return _y
func set_y(value: float) -> void: _y = value; _sync_container_position()
func get_interaction_range() -> float: return float(def.get("interactionRange", 0.0))
func get_display_object() -> Node2D: return container
func get_display_texture() -> Variant: return sprite.get_display_texture() if sprite != null else null
func get_world_size() -> Dictionary: return sprite.get_world_size() if sprite != null else {"width": 0.0, "height": 0.0}
func get_facing() -> int: return -1 if container.scale.x < 0 else 1
func get_rest_anim_state() -> String: return _rest_anim_state
func get_emote_bubble_anchor_local_y() -> float: return -maxf(float(get_world_size().height), MARKER_SIZE * 2.0) - 8.0
func is_patrol_paused_for_dialogue() -> bool: return _patrol_paused
func is_moving_to_target() -> bool: return not _move_target.is_empty()
func is_destroyed() -> bool: return _destroyed


func get_debug_visual_state() -> Dictionary:
	return {
		"id": get_id(),
		"x": _x,
		"y": _y,
		"visible": container.visible,
		"scaleX": container.scale.x,
		"scaleY": container.scale.y,
		"animation": sprite.get_debug_visual_state() if sprite != null else null,
	}


func reset_animation_clock() -> void:
	if sprite != null: sprite.reset_animation_clock()


func get_current_portrait_slug() -> Variant:
	var explicit := str(def.get("portraitSlug", "")).strip_edges()
	return explicit if not explicit.is_empty() else RuntimeCharacterRegistryScript.portrait_slug_from_anim_file(def.get("animFile"))


func set_facing(dx: float, dy: float) -> void:
	if dx * dx + dy * dy < 0.00000001: return
	var direction := 1.0
	if absf(dx) >= 0.000001: direction = 1.0 if dx > 0 else -1.0
	else: direction = 1.0 if dy >= 0 else -1.0
	container.scale = Vector2(direction * (absf(container.scale.x) if container.scale.x != 0 else 1.0), absf(container.scale.y) if container.scale.y != 0 else 1.0)
	name_label.scale.x = direction
	if prompt_icon != null: prompt_icon.scale.x = direction
	if marker != null: marker.scale.x = direction
	if sprite != null: sprite.set_direction(1, 0)


func set_visible(value: bool) -> void: set_session_enabled_override(null if value else false)
func set_session_enabled_override(value: Variant) -> void: _session_enabled_override = value; _apply_effective_visible()
func set_derived_base_visible(value: bool) -> void: _derived_base_visible = value; _apply_effective_visible()
func set_condition_visible(value: bool) -> void: _condition_visible = value; _apply_effective_visible()
func play_animation(name: String) -> void:
	if sprite != null: sprite.play_animation(name)


func apply_entity_pixel_density_match(enabled: bool, background_density: Variant = null, strength_scale := 1.0) -> void:
	if sprite == null:
		return
	sprite.set_pixel_density_match_active(enabled)
	sprite.apply_pixel_density_match(background_density, strength_scale)


func cancel_active_move() -> void:
	if _move_target.is_empty(): return
	var completion: _MoveCompletion = _move_target.completion
	_move_target.clear()
	completion.resolve()


func pause_patrol_and_face_for_dialogue(player_x: float, player_y: float) -> void:
	if def.get("patrol") is Dictionary:
		cancel_active_move(); _patrol_skip_waypoint_advance = true; _patrol_paused = true
	_facing_scale_x_before_dialogue = container.scale.x
	set_facing(player_x - _x, player_y - _y)


func on_dialogue_start(player_x: float, player_y: float) -> void: pause_patrol_and_face_for_dialogue(player_x, player_y)


func on_dialogue_end() -> void:
	if def.get("patrol") is Dictionary: _patrol_paused = false
	if _facing_scale_x_before_dialogue == null: return
	if container == null or not is_instance_valid(container): _facing_scale_x_before_dialogue = null; return
	var saved := float(_facing_scale_x_before_dialogue); _facing_scale_x_before_dialogue = null; container.scale.x = saved
	var direction := signf(saved) if saved != 0 else 1.0; name_label.scale.x = direction
	if prompt_icon != null: prompt_icon.scale.x = direction
	if marker != null: marker.scale.x = direction
	if sprite != null: sprite.set_direction(1, 0)


func consume_patrol_skip_waypoint_advance() -> bool:
	if not _patrol_skip_waypoint_advance: return false
	_patrol_skip_waypoint_advance = false; return true


func move_to(target_x: float, target_y: float, speed: float, move_anim_state: Variant = null, face_toward_movement: Variant = null) -> void:
	if _destroyed: return
	cancel_active_move()
	var delta := Vector2(target_x - _x, target_y - _y)
	if delta.length_squared() < 0.000001: return
	var completion := _MoveCompletion.new()
	var anim: String = move_anim_state.strip_edges() if move_anim_state is String else ""
	_move_target = {"x": target_x, "y": target_y, "speed": speed, "faceTowardMovement": face_toward_movement == true, "completion": completion}
	set_facing(delta.x, delta.y)
	if not anim.is_empty(): play_animation(anim)
	await completion.wait()


func cutscene_update(dt: float) -> void:
	if not _move_target.is_empty():
		var delta := Vector2(float(_move_target.x) - _x, float(_move_target.y) - _y); var distance := delta.length(); var step := float(_move_target.speed) * dt
		if distance <= step:
			set_x(float(_move_target.x)); set_y(float(_move_target.y))
			if not _rest_anim_state.is_empty(): play_animation(_rest_anim_state)
			var completion: _MoveCompletion = _move_target.completion
			_move_target.clear()
			completion.resolve()
		elif distance > 0:
			if _move_target.faceTowardMovement: set_facing(delta.x, delta.y)
			set_x(_x + delta.x / distance * step); set_y(_y + delta.y / distance * step)
	if sprite != null: sprite.update(dt)


func show_prompt() -> void:
	if prompt_icon != null: return
	prompt_icon = Label.new(); prompt_icon.name = "PromptIcon"; prompt_icon.text = "E"; prompt_icon.position = Vector2(-12, -(MARKER_SIZE * 2.0 + 24)); prompt_icon.size = Vector2(24, 24); prompt_icon.pivot_offset = Vector2(12, 12); prompt_icon.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER; prompt_icon.vertical_alignment = VERTICAL_ALIGNMENT_CENTER; prompt_icon.add_theme_font_size_override("font_size", 14); prompt_icon.add_theme_color_override("font_color", Color(1.0, 0.933, 0.533)); prompt_icon.scale.x = signf(container.scale.x) if container.scale.x != 0 else 1.0; container.add_child(prompt_icon)


func hide_prompt() -> void:
	if prompt_icon == null: return
	container.remove_child(prompt_icon); prompt_icon.free(); prompt_icon = null


func destroy_npc() -> void:
	if _destroyed: return
	_destroyed = true; hide_prompt(); cancel_active_move()
	if sprite != null:
		container.remove_child(sprite); sprite.destroy(); sprite.free(); sprite = null
	if container != null and is_instance_valid(container):
		if container.get_parent() != null: container.get_parent().remove_child(container)
		container.free()


func _sync_container_position() -> void:
	if container != null: container.position = Vector2(_x, _y)


func _apply_effective_visible() -> void:
	container.visible = _derived_base_visible and _condition_visible and _session_enabled_override != false


func _circle_polygon(center: Vector2, radius: float, segments: int) -> PackedVector2Array:
	var points := PackedVector2Array()
	for index in segments: points.push_back(center + Vector2.from_angle(TAU * index / segments) * radius)
	return points
