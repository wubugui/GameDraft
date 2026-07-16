class_name RuntimeDepthLog
extends RefCounted


static func depth_log(tag: String, args: Array = []) -> void:
	if not OS.is_debug_build():
		return
	var parts: PackedStringArray = []
	for value: Variant in args:
		parts.push_back(_stringify(value, false))
	print("[%s] %s" % [tag, " ".join(parts)])


static func depth_error(tag: String, args: Array = []) -> void:
	var parts: PackedStringArray = []
	for value: Variant in args:
		parts.push_back(_stringify(value, true))
	var message := "[%s] ERROR: %s" % [tag, " ".join(parts)]
	printerr(message)
	RuntimeDevErrorOverlay.report_dev_error(message)


static func _stringify(value: Variant, _include_error_stack: bool) -> String:
	if value is Dictionary or value is Array:
		return JSON.stringify(value)
	return RuntimeJavaScriptRuntimeAdapter.string_value(value)
