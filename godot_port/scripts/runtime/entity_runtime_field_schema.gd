class_name RuntimeEntityRuntimeFieldSchema
extends RefCounted

const SCHEMA_URL := "/assets/data/runtime_field_schema.json"

static var _schemas: Dictionary = {}


static func configure(asset_manager: RuntimeAssetManager) -> void:
	var raw: Variant = asset_manager.load_json(SCHEMA_URL)
	_schemas = raw.duplicate(true) if raw is Dictionary else {}


static func get_descriptor(kind: String, field_name: String) -> Variant:
	var schema: Variant = _schemas.get(kind)
	if not schema is Dictionary:
		return null
	var descriptor: Variant = schema.get(field_name)
	return descriptor if descriptor is Dictionary else null


static func coerce_value(kind: String, field_name: String, raw: Variant) -> Dictionary:
	var descriptor: Variant = get_descriptor(kind, field_name)
	if not descriptor is Dictionary or descriptor.get("persistent") != true:
		return {"ok": false, "error": "%s.%s 不是可存档运行时字段" % [kind, field_name]}
	if raw == null:
		return {"ok": true, "value": null, "descriptor": descriptor}
	match str(descriptor.get("kind", "")):
		"string":
			var string_value := str(raw).strip_edges()
			if string_value.is_empty():
				return {"ok": false, "error": "%s.%s 需要非空字符串" % [kind, field_name]}
			return {"ok": true, "value": string_value, "descriptor": descriptor}
		"number":
			var number_value: Variant = _js_number(raw)
			if number_value == null:
				return {"ok": false, "error": "%s.%s 需要有限数值" % [kind, field_name]}
			return {"ok": true, "value": number_value, "descriptor": descriptor}
		"boolean":
			var boolean_value: Variant = _loose_boolean(raw)
			if boolean_value == null:
				return {"ok": false, "error": "%s.%s 需要布尔值" % [kind, field_name]}
			return {"ok": true, "value": boolean_value, "descriptor": descriptor}
		"object":
			if field_name == "displayImage":
				if not is_hotspot_display_image(raw):
					return {"ok": false, "error": "hotspot.displayImage 需要 image/worldWidth/worldHeight"}
				return {"ok": true, "value": raw, "descriptor": descriptor}
			if not raw is Dictionary:
				return {"ok": false, "error": "%s.%s 需要对象" % [kind, field_name]}
			return {"ok": true, "value": raw, "descriptor": descriptor}
	return {"ok": false, "error": "%s.%s 字段类型无效" % [kind, field_name]}


static func is_hotspot_display_image(raw: Variant) -> bool:
	if not raw is Dictionary:
		return false
	var image: Variant = raw.get("image")
	var width: Variant = raw.get("worldWidth")
	var height: Variant = raw.get("worldHeight")
	return image is String and not image.strip_edges().is_empty() \
		and (width is int or width is float) and is_finite(float(width)) and float(width) > 0.0 \
		and (height is int or height is float) and is_finite(float(height)) and float(height) > 0.0


static func _js_number(raw: Variant) -> Variant:
	if raw is bool:
		return 1.0 if raw else 0.0
	if raw is int or raw is float:
		return float(raw) if is_finite(float(raw)) else null
	var text := str(raw).strip_edges()
	if text.is_empty():
		return 0.0
	if text.to_lower().begins_with("0x") and text.substr(2).is_valid_hex_number():
		return float(text.substr(2).hex_to_int())
	return text.to_float() if text.is_valid_float() and is_finite(text.to_float()) else null


static func _loose_boolean(raw: Variant) -> Variant:
	if raw is bool:
		return raw
	if raw is int or raw is float:
		return float(raw) != 0.0
	var text := str(raw).strip_edges().to_lower()
	if text in ["true", "1"]:
		return true
	if text in ["false", "0"]:
		return false
	return null
