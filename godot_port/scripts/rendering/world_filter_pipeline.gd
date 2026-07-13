class_name RuntimeWorldFilterPipeline
extends RefCounted

const COLOR_MATRIX_SHADER := preload("res://scripts/rendering/color_matrix_filter.gdshader")
const IDENTITY_MATRIX := [1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0]

var target: CanvasItem
var filters: Array[Material] = []


func _init(next_target: CanvasItem) -> void: target = next_target
func set_filters(next_filters: Array) -> void:
	filters.clear()
	for value: Variant in next_filters:
		if value is Material:
			filters.push_back(value)
		elif value is Dictionary:
			var material := _material_from_definition(value)
			if material != null: filters.push_back(material)
	_apply()
func push_filter(filter: Material) -> void: if filter != null: filters.push_back(filter); _apply()
func pop_filter() -> Variant:
	var removed: Variant = filters.pop_back() if not filters.is_empty() else null
	_apply(); return removed
func clear() -> void: filters.clear(); _apply()
func get_filters() -> Array: return filters.duplicate()
func has_filters() -> bool: return not filters.is_empty()
func _apply() -> void: if target != null: target.material = filters.back() if not filters.is_empty() else null


func _material_from_definition(definition: Dictionary) -> ShaderMaterial:
	var raw: Variant = definition.get("matrix", IDENTITY_MATRIX)
	var matrix: Array = raw if raw is Array and raw.size() == 20 else IDENTITY_MATRIX
	var values: Array[float] = []
	for index in 20:
		values.push_back(float(matrix[index]))
	var columns := Projection(
		Vector4(values[0], values[5], values[10], values[15]),
		Vector4(values[1], values[6], values[11], values[16]),
		Vector4(values[2], values[7], values[12], values[17]),
		Vector4(values[3], values[8], values[13], values[18])
	)
	var material := ShaderMaterial.new()
	material.shader = COLOR_MATRIX_SHADER
	material.set_shader_parameter("color_matrix", columns)
	material.set_shader_parameter("color_offset", Vector4(values[4], values[9], values[14], values[19]))
	material.set_shader_parameter("filter_alpha", float(definition.get("alpha", 1.0)))
	return material
