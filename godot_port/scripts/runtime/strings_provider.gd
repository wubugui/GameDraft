class_name RuntimeStringsProvider
extends RefCounted

const STRINGS_URL := "/assets/data/strings.json"

var _data: Dictionary = {}
var _resolve_display := Callable()


func load(asset_manager: Variant) -> void:
	var loaded: Variant = asset_manager.call("load_json", STRINGS_URL)
	if not loaded is Dictionary:
		push_warning("StringsProvider: strings.json not found, using fallback strings")
		return
	_data = loaded


func set_resolve_display(callback: Variant = null) -> void:
	_resolve_display = callback if callback is Callable else Callable()


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


func get_text(category: String, key: String, variables: Variant = null) -> String:
	var template := get_raw(category, key)
	if variables is Dictionary:
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
