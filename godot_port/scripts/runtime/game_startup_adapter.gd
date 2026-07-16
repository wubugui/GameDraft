class_name RuntimeGameStartupAdapter
extends RefCounted

const STRING_OPTIONS := {
	"playCutscene": ["playCutscene", "play-cutscene", "play_cutscene"],
	"devScene": ["devScene", "dev-scene", "dev_scene"],
	"narrativeWarp": ["narrativeWarp", "narrative-warp", "narrative_warp"],
	"waterPreview": ["waterPreview", "water-preview", "water_preview"],
	"sugarWheelPreview": ["sugarWheelPreview", "sugar-wheel-preview", "sugar_wheel_preview"],
	"paperCraftPreview": ["paperCraftPreview", "paper-craft-preview", "paper_craft_preview"],
}


static func from_engine(engine_owner: Object, user_args: Variant) -> Dictionary:
	var command_line := _parse_command_line(user_args)
	var options := {
		"devMode": _read_command_line_bool(command_line, ["devMode"], false),
		"playCutscene": _read_command_line_string(command_line, STRING_OPTIONS.playCutscene),
		"devScene": _read_command_line_string(command_line, STRING_OPTIONS.devScene),
		"narrativeWarp": _read_command_line_string(command_line, STRING_OPTIONS.narrativeWarp),
		"waterPreview": _read_command_line_string(command_line, STRING_OPTIONS.waterPreview),
		"sugarWheelPreview": _read_command_line_string(command_line, STRING_OPTIONS.sugarWheelPreview),
		"paperCraftPreview": _read_command_line_string(command_line, STRING_OPTIONS.paperCraftPreview),
		"visualCapture": _read_command_line_bool(command_line, ["visualCapture", "visual-capture", "visual_capture"], false),
		# This is an explicit Godot-shell adapter field, not a ninth GameStartOption.
		"_godotInitialScene": _read_command_line_string(command_line, ["_godotInitialScene"]),
	}

	var metadata: Variant = engine_owner.get_meta("startOptions", {}) if engine_owner != null else {}
	if not metadata is Dictionary:
		return options
	var start_options: Dictionary = metadata
	if start_options.has("devMode"):
		options.devMode = _coerce_bool(start_options.devMode)
	for canonical: String in STRING_OPTIONS:
		if start_options.has(canonical):
			options[canonical] = _coerce_string(start_options[canonical])
	if start_options.has("visualCapture"):
		options.visualCapture = _coerce_bool(start_options.visualCapture)
	if start_options.has("_godotInitialScene"):
		options._godotInitialScene = _coerce_string(start_options._godotInitialScene)
	elif start_options.has("parity-start-scene"):
		options._godotInitialScene = _coerce_string(start_options["parity-start-scene"])
	return options


static func _parse_command_line(user_args: Variant) -> Dictionary:
	var result := {}
	if not user_args is Array and not user_args is PackedStringArray:
		return result
	for raw_argument: Variant in user_args:
		var argument := str(raw_argument)
		if not argument.begins_with("--"):
			continue
		var pair := argument.trim_prefix("--").split("=", true, 1)
		var raw_name := str(pair[0])
		var value: Variant = pair[1] if pair.size() == 2 else true
		var canonical := _canonical_command_line_key(raw_name)
		if canonical.is_empty():
			result[raw_name] = value
		elif raw_name == "mode":
			result[canonical] = str(value).strip_edges().to_lower() == "dev"
		else:
			# Walk the real argument stream: aliases of one source option share a
			# canonical slot, so the final occurrence wins before metadata overlays it.
			result[canonical] = value
	return result


static func _canonical_command_line_key(name: String) -> String:
	if name in ["mode", "devMode", "dev-mode"]: return "devMode"
	for canonical: String in STRING_OPTIONS:
		if name in STRING_OPTIONS[canonical]: return canonical
	if name in ["visualCapture", "visual-capture", "visual_capture"]: return "visualCapture"
	if name in ["parity-start-scene", "parity_start_scene"]: return "_godotInitialScene"
	return ""


static func _read_command_line_string(values: Dictionary, names: Array) -> String:
	for raw_name: Variant in names:
		var name := str(raw_name)
		if values.has(name):
			return _coerce_string(values[name])
	return ""


static func _read_command_line_bool(values: Dictionary, names: Array, fallback: bool) -> bool:
	for raw_name: Variant in names:
		var name := str(raw_name)
		if values.has(name):
			return _coerce_bool(values[name])
	return fallback


static func _coerce_string(value: Variant) -> String:
	return value.strip_edges() if value is String else ""


static func _coerce_bool(value: Variant) -> bool:
	if value is bool:
		return value
	if value is int or value is float:
		return float(value) != 0.0
	if value is String:
		return value.strip_edges().to_lower() in ["1", "true", "yes", "on", "dev"]
	return false
