extends Node

const RuntimeFilterTypesScript := preload("res://scripts/rendering/filter/types.gd")
const RuntimeFilterLoaderScript := preload("res://scripts/rendering/filter/filter_loader.gd")


func _ready() -> void:
	assert(RuntimeFilterTypesScript.IDENTITY_MATRIX == [
		1, 0, 0, 0, 0,
		0, 1, 0, 0, 0,
		0, 0, 1, 0, 0,
		0, 0, 0, 1, 0,
	])
	assert(not RuntimeFilterTypesScript.is_valid_filter_def(null))
	assert(not RuntimeFilterTypesScript.is_valid_filter_def({}))
	assert(not RuntimeFilterTypesScript.is_valid_filter_def({"matrix": [1, 2]}))
	var numeric_matrix := RuntimeFilterTypesScript.IDENTITY_MATRIX.duplicate()
	numeric_matrix[0] = NAN
	assert(RuntimeFilterTypesScript.is_valid_filter_def({"matrix": numeric_matrix}))
	numeric_matrix[0] = "1"
	assert(not RuntimeFilterTypesScript.is_valid_filter_def({"matrix": numeric_matrix}))

	var identity := RuntimeFilterLoaderScript.create_filter_from_def({})
	assert(identity is ShaderMaterial and identity.get_shader_parameter("filter_alpha") == 1.0)
	var identity_projection: Projection = identity.get_shader_parameter("color_matrix")
	assert((identity_projection * Vector4(0.2, 0.4, 0.6, 1.0) + identity.get_shader_parameter("color_offset")).is_equal_approx(Vector4(0.2, 0.4, 0.6, 1.0)))
	assert(RuntimeFilterLoaderScript.create_filter_from_json({"alpha": "bad"}).get_shader_parameter("filter_alpha") == 1.0)

	RuntimeFilterLoaderScript.clear_filter_cache()
	var night: Variant = RuntimeFilterLoaderScript.load_filter("night")
	assert(night is ShaderMaterial and night.get_shader_parameter("filter_alpha") == 1.0)
	assert(RuntimeFilterLoaderScript.load_filter("night") == night)
	assert(RuntimeFilterLoaderScript.load_filter("night", false) != night)
	RuntimeFilterLoaderScript.clear_filter_cache()
	assert(RuntimeFilterLoaderScript.load_filter("night") != night)
	assert(RuntimeFilterLoaderScript.load_filter("missing_filter") == null)
	assert(RuntimeFilterLoaderScript.last_error == "Filter load failed: missing_filter")

	print("Filter types/loader validation/cache/material translation test: PASS")
	get_tree().quit(0)
