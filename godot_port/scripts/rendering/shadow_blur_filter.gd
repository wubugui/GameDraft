class_name RuntimeShadowBlurFilter
extends RefCounted

const SHADER := preload("res://scripts/rendering/shadow_blur.gdshader")

# Godot has no CanvasItem.filters list. A single CanvasGroup is the engine
# boundary for the final filtered mesh output. Pixi quality=2 halves the second
# pass after normalizing the first by sqrt(1 + .5²), so its total Gaussian
# variance equals one pass at `strength`; the shader evaluates that separable
# kernel in one 2D pass and keeps quality=2 as source-owned filter state.

var strength: float:
	set(value):
		strength = value
		_sync_pass_strengths()
var quality := 2
var destroyed := false

var _target: CanvasItem
var _parent: Node
var _sibling_index := -1
var _host: CanvasGroup = null
var _material: ShaderMaterial = null


func _init(target: CanvasItem, initial_strength: float, initial_quality := 2) -> void:
	_target = target
	quality = initial_quality
	_mount()
	strength = initial_strength


func _mount() -> void:
	_parent = _target.get_parent()
	if _parent == null:
		return
	_sibling_index = _target.get_index()
	_parent.remove_child(_target)
	_host = CanvasGroup.new()
	_host.name = "BlurFilterHost"
	_material = ShaderMaterial.new()
	_material.shader = SHADER
	_host.material = _material
	_host.add_child(_target)
	_parent.add_child(_host)
	_parent.move_child(_host, mini(_sibling_index, _parent.get_child_count() - 1))


func _sync_pass_strengths() -> void:
	if destroyed or _material == null or _host == null:
		return
	_material.set_shader_parameter("strength", strength)
	var margin := maxf(1.0, ceilf(absf(strength) * 2.0) + 1.0)
	_host.fit_margin = margin
	_host.clear_margin = margin


func is_mounted() -> bool:
	return not destroyed and _host != null and _target != null and _target.get_parent() == _host


func destroy() -> void:
	if destroyed:
		return
	destroyed = true
	if _target != null and is_instance_valid(_target) and _target.get_parent() != null:
		_target.get_parent().remove_child(_target)
	if _host != null and is_instance_valid(_host) and _host.get_parent() != null:
		_host.get_parent().remove_child(_host)
	if _parent != null and is_instance_valid(_parent) and _target != null and is_instance_valid(_target):
		_parent.add_child(_target)
		_parent.move_child(_target, mini(maxi(_sibling_index, 0), _parent.get_child_count() - 1))
	if _host != null and is_instance_valid(_host):
		_host.material = null
		_host.free()
	_host = null
	_material = null
	_target = null
	_parent = null
	_sibling_index = -1
