class_name RuntimeShadowBlurFilter
extends RefCounted

const SHADER := preload("res://scripts/rendering/shadow_blur.gdshader")

# BlurFilter({ quality: 2 }) is two horizontal and two vertical kernel passes.
# Godot has no CanvasItem.filters list, so four nested CanvasGroups are the
# engine boundary for the same pass graph; the shadow mesh remains the filter's
# sole logical target.
const PASS_DIRECTIONS := [Vector2.RIGHT, Vector2.RIGHT, Vector2.DOWN, Vector2.DOWN]

var strength: float:
	set(value):
		strength = value
		_sync_pass_strengths()
var quality := 2
var destroyed := false

var _target: CanvasItem
var _parent: Node
var _sibling_index := -1
var _passes: Array[CanvasGroup] = []
var _materials: Array[ShaderMaterial] = []


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
	var child: Node = _target
	for index: int in PASS_DIRECTIONS.size():
		var pass_group := CanvasGroup.new()
		pass_group.name = "BlurPass%d" % index
		var material := ShaderMaterial.new()
		material.shader = SHADER
		material.set_shader_parameter("direction", PASS_DIRECTIONS[index])
		pass_group.material = material
		pass_group.add_child(child)
		_passes.push_back(pass_group)
		_materials.push_back(material)
		child = pass_group
	_parent.add_child(child)
	_parent.move_child(child, mini(_sibling_index, _parent.get_child_count() - 1))


func _sync_pass_strengths() -> void:
	if destroyed or _materials.size() != 4:
		return
	# Pixi BlurFilterPass quality=2 optimized schedule: s/sqrt(1+.5²), then /2.
	var first := strength / sqrt(1.25)
	var pass_strengths := [first, first * 0.5, first, first * 0.5]
	for index: int in _materials.size():
		_materials[index].set_shader_parameter("strength", pass_strengths[index])
		var margin := maxf(1.0, ceilf(absf(float(pass_strengths[index])) * 2.0) + 1.0)
		_passes[index].fit_margin = margin
		_passes[index].clear_margin = margin


func is_mounted() -> bool:
	return not destroyed and _passes.size() == 4 and _target != null and _target.get_parent() == _passes[0]


func destroy() -> void:
	if destroyed:
		return
	destroyed = true
	var outer: CanvasGroup = _passes.back() if not _passes.is_empty() else null
	if _target != null and is_instance_valid(_target) and _target.get_parent() != null:
		_target.get_parent().remove_child(_target)
	if outer != null and is_instance_valid(outer) and outer.get_parent() != null:
		outer.get_parent().remove_child(outer)
	if _parent != null and is_instance_valid(_parent) and _target != null and is_instance_valid(_target):
		_parent.add_child(_target)
		_parent.move_child(_target, mini(maxi(_sibling_index, 0), _parent.get_child_count() - 1))
	if outer != null and is_instance_valid(outer):
		outer.free()
	for pass_group: CanvasGroup in _passes:
		if is_instance_valid(pass_group):
			pass_group.material = null
	_passes.clear()
	_materials.clear()
	_target = null
	_parent = null
	_sibling_index = -1
