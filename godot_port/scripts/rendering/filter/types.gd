class_name RuntimeFilterTypes
extends RefCounted

const IDENTITY_MATRIX := [
	1, 0, 0, 0, 0,
	0, 1, 0, 0, 0,
	0, 0, 1, 0, 0,
	0, 0, 0, 1, 0,
]


static func is_valid_filter_def(definition: Variant) -> bool:
	if definition == null or not definition is Dictionary:
		return false
	var matrix: Variant = definition.get("matrix")
	if not matrix is Array or matrix.size() != 20:
		return false
	return matrix.all(func(value: Variant) -> bool: return value is int or value is float)
