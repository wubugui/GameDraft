class_name RuntimeJavaScriptRuntimeAdapter
extends RefCounted


static func failure_result(id: String, type: String, message: String) -> Dictionary:
	return {"id": id, "type": type, "ok": false, "message": message}


static func truthy_string_or(value: Variant, fallback: String) -> String:
	var text := string_value(value).strip_edges()
	return text if not text.is_empty() else fallback


static func number_from_trimmed_string(value: Variant) -> Dictionary:
	if value is int or value is float:
		return {"ok": true, "value": float(value)} if is_finite(float(value)) else {"ok": false}
	var text := string_value(value).strip_edges()
	if text.is_empty():
		return {"ok": true, "value": 0.0}
	if not text.is_valid_float():
		return {"ok": false}
	var parsed := text.to_float()
	return {"ok": true, "value": parsed} if is_finite(parsed) else {"ok": false}


static func number_direct(value: Variant) -> Dictionary:
	if value == null:
		return {"ok": true, "value": 0.0}
	if value is bool:
		return {"ok": true, "value": 1.0 if value else 0.0}
	return number_from_trimmed_string(value)


static func string_value(value: Variant) -> String:
	if value == null:
		return ""
	if value is bool:
		return "true" if value else "false"
	return str(value)
