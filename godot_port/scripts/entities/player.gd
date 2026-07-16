class_name RuntimePlayer
extends RefCounted


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

const DEFAULT_WALK_SPEED := 100.0
const DEFAULT_RUN_SPEED := 180.0

var sprite: RuntimeSpriteEntity
var _input_manager: RuntimeInputManager
var _depth_collision := Callable()
var _movement_modifier := Callable()
var _move_target: Dictionary = {}
var _collisions_enabled := true
var _walk_speed := DEFAULT_WALK_SPEED
var _run_speed := DEFAULT_RUN_SPEED
var _world_width := 0.0
var _world_height := 0.0


func _init(input_manager: RuntimeInputManager) -> void: _input_manager = input_manager; sprite = RuntimeSpriteEntity.new()
func get_entity_id() -> String: return "player"
func set_depth_collision(callback: Callable = Callable()) -> void: _depth_collision = callback
func set_movement_modifier(callback: Variant = null) -> void: _movement_modifier = callback if callback is Callable else Callable()
func set_collisions_enabled(enabled: bool) -> void: _collisions_enabled = enabled
func get_collisions_enabled_state() -> bool: return _collisions_enabled


func sync_movement_from_scene(scene: Variant) -> void:
	_walk_speed = float(scene.get("playerWalkSpeed", DEFAULT_WALK_SPEED)) if scene is Dictionary else DEFAULT_WALK_SPEED
	_run_speed = float(scene.get("playerRunSpeed", DEFAULT_RUN_SPEED)) if scene is Dictionary else DEFAULT_RUN_SPEED
	_world_width = float(scene.get("worldWidth", 0.0)) if scene is Dictionary else 0.0
	_world_height = float(scene.get("worldHeight", 0.0)) if scene is Dictionary else 0.0


func get_x() -> float: return sprite.x
func set_x(value: float) -> void: sprite.x = value
func get_y() -> float: return sprite.y
func set_y(value: float) -> void: sprite.y = value
func get_facing_direction() -> String: return sprite.get_facing_direction()
func get_display_object() -> Node2D: return sprite
func get_emote_bubble_anchor_local_y() -> float: return -maxf(float(sprite.get_world_size().height), 1.0) - 8.0
func set_facing(dx: float, dy: float) -> void: sprite.set_direction(dx, dy)
func set_visible(value: bool) -> void: sprite.visible = value
func play_animation(name: String) -> void: sprite.play_animation(name)
func is_moving_to_target() -> bool: return not _move_target.is_empty()


func move_to(target_x: float, target_y: float, speed: float, move_anim_state: Variant = null, face_toward_movement: Variant = null) -> void:
	if not _move_target.is_empty():
		var previous: _MoveCompletion = _move_target.completion
		previous.resolve()
	var completion := _MoveCompletion.new()
	var anim: String = move_anim_state.strip_edges() if move_anim_state is String else ""; var toward: bool = face_toward_movement == true
	_move_target = {"x": target_x, "y": target_y, "speed": speed, "playIdleOnArrive": not anim.is_empty(), "faceTowardMovement": toward, "completion": completion}
	var delta := Vector2(target_x - sprite.x, target_y - sprite.y); sprite.set_direction(delta.x, delta.y if toward else 0)
	if not anim.is_empty(): sprite.play_animation(anim)
	await completion.wait()


func cutscene_update(dt: float) -> void:
	if not _move_target.is_empty():
		var delta := Vector2(float(_move_target.x) - sprite.x, float(_move_target.y) - sprite.y); var distance := delta.length(); var step := float(_move_target.speed) * dt
		if distance <= step:
			sprite.x = float(_move_target.x); sprite.y = float(_move_target.y)
			if _move_target.playIdleOnArrive: sprite.play_animation("idle")
			var completion: _MoveCompletion = _move_target.completion
			_move_target.clear()
			completion.resolve()
		elif distance > 0:
			if _move_target.faceTowardMovement: set_facing(delta.x, delta.y)
			sprite.x += delta.x / distance * step; sprite.y += delta.y / distance * step
	sprite.update(dt)


func update(dt: float) -> void:
	if not _move_target.is_empty(): cutscene_update(dt); return
	var direction := _input_manager.get_movement_direction(); var is_moving := direction != Vector2.ZERO
	var modifier: Variant = _movement_modifier.call() if not _movement_modifier.is_null() and _movement_modifier.is_valid() else null
	var allow_run: bool = modifier.get("allowRun", true) if modifier is Dictionary else true
	var running: bool = _input_manager.is_running() and allow_run
	var scale := float(modifier.get("speedScale", 1.0)) if modifier is Dictionary else 1.0
	var speed := (_run_speed if running else _walk_speed) * scale
	var step := direction * speed * dt
	if modifier is Dictionary: step += Vector2(float(modifier.get("driftX", 0)), float(modifier.get("driftY", 0))) * dt
	if step != Vector2.ZERO:
		var new_x := sprite.x + step.x; var new_y := sprite.y + step.y
		if not _collides_at(new_x, sprite.y) and not _out_of_bounds(new_x, sprite.y): sprite.x = new_x
		if not _collides_at(sprite.x, new_y) and not _out_of_bounds(sprite.x, new_y): sprite.y = new_y
	if is_moving:
		sprite.set_direction(direction.x, direction.y); sprite.play_animation("run" if running else "walk")
	else: sprite.play_animation("idle")
	sprite.update(dt)


func destroy_player() -> void:
	if not _move_target.is_empty():
		var completion: _MoveCompletion = _move_target.completion
		_move_target.clear()
		completion.resolve()
	_depth_collision = Callable(); _movement_modifier = Callable(); sprite.destroy()


func _collides_at(x: float, y: float) -> bool: return _collisions_enabled and not _depth_collision.is_null() and _depth_collision.is_valid() and _depth_collision.call(x, y) == true
func _out_of_bounds(x: float, y: float) -> bool: return _world_width > 0 and _world_height > 0 and (x < 0 or x > _world_width or y < 0 or y > _world_height)
