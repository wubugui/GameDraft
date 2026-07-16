class_name RuntimeFilterLoader
extends RefCounted

const RuntimeFilterTypesScript := preload("res://scripts/rendering/filter/types.gd")
const COLOR_MATRIX_SHADER := preload("res://scripts/rendering/color_matrix_filter.gdshader")
const FILTER_ASSET_BASE := "assets/data/filters"

static var filter_cache: Dictionary = {}
static var last_error := ""


static func create_filter_from_def(definition: Dictionary) -> ShaderMaterial:
	var filter := ShaderMaterial.new()
	filter.shader = COLOR_MATRIX_SHADER
	var raw: Variant = definition.get("matrix")
	var matrix: Array = raw if raw is Array and raw.size() == 20 else RuntimeFilterTypesScript.IDENTITY_MATRIX.duplicate()
	var values: Array[float] = []
	for index in 20:
		values.push_back(float(matrix[index]))
	filter.set_shader_parameter("color_matrix", Projection(
		Vector4(values[0], values[5], values[10], values[15]),
		Vector4(values[1], values[6], values[11], values[16]),
		Vector4(values[2], values[7], values[12], values[17]),
		Vector4(values[3], values[8], values[13], values[18]),
	))
	filter.set_shader_parameter("color_offset", Vector4(values[4], values[9], values[14], values[19]))
	var alpha: Variant = definition.get("alpha")
	filter.set_shader_parameter("filter_alpha", float(alpha) if alpha is int or alpha is float else 1.0)
	return filter


static func load_filter(filter_id: String, use_cache := true) -> Variant:
	last_error = ""
	if use_cache and filter_cache.has(filter_id):
		return filter_cache[filter_id]
	var path := "%s/%s.json" % [FILTER_ASSET_BASE, filter_id]
	var locator := RuntimeResourceLocator.get_default()
	var resolved := locator.resolve_url(path, RuntimeResourceLocator.TEXT)
	if resolved.is_empty() or not FileAccess.file_exists(resolved):
		last_error = "Filter load failed: %s" % filter_id
		return null
	var parser := JSON.new()
	if parser.parse(FileAccess.get_file_as_string(resolved)) != OK:
		last_error = "Filter load failed: %s" % filter_id
		return null
	var data: Variant = parser.data
	if not RuntimeFilterTypesScript.is_valid_filter_def(data):
		last_error = "Invalid filter definition: %s" % filter_id
		return null
	var filter := create_filter_from_def(data)
	if use_cache:
		filter_cache[filter_id] = filter
	return filter


static func create_filter_from_json(json: Dictionary) -> ShaderMaterial:
	return create_filter_from_def(json)


static func clear_filter_cache() -> void:
	filter_cache.clear()
