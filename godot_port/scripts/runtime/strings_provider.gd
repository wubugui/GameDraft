class_name RuntimeStringsProvider
extends RefCounted

const STRINGS_URL := "/assets/data/strings.json"

var _data: Dictionary = {}
var _resolve_display := Callable()


func load(asset_manager: Variant) -> bool:
	if asset_manager == null or not asset_manager.has_method("load_json"):
		return false
	var loaded: Variant = asset_manager.call("load_json", STRINGS_URL)
	if not loaded is Dictionary:
		return false
	_data = loaded
	return true


func set_resolve_display(callback: Callable = Callable()) -> void:
	_resolve_display = callback


func get_raw(category: String, key: String) -> String:
	var category_data: Variant = _data.get(category)
	if not category_data is Dictionary or not category_data.has(key):
		return key
	var value: Variant = category_data[key]
	if value == null:
		return key
	if value is bool:
		return "true" if value else "false"
	if value is float:
		if not is_finite(value):
			return str(value)
		if value == floor(value):
			return str(int(value))
	return str(value)


func get_text(category: String, key: String, variables: Dictionary = {}) -> String:
	var template := get_raw(category, key)
	if not variables.is_empty():
		var matcher := RegEx.new()
		matcher.compile("\\{(\\w+)\\}")
		var offset := 0
		var output := ""
		for match: RegExMatch in matcher.search_all(template):
			output += template.substr(offset, match.get_start() - offset)
			var variable_name := match.get_string(1)
			output += str(variables[variable_name]) if variables.has(variable_name) else match.get_string(0)
			offset = match.get_end()
		template = output + template.substr(offset)
	if not _resolve_display.is_null() and _resolve_display.is_valid():
		return str(_resolve_display.call(template))
	return template


func category_count() -> int:
	return _data.size()


func leaf_count() -> int:
	var result := 0
	for category: Variant in _data.values():
		if category is Dictionary:
			result += category.size()
	return result
