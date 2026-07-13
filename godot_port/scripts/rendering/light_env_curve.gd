class_name RuntimeLightEnvCurve
extends RefCounted


static func prepare(definition: Variant) -> Variant:
	var points: Variant = definition.get("points") if definition is Dictionary else null
	if not points is Array or points.size() < 2:
		return null
	var cumulative: Array = [0.0]
	for index in range(1, points.size()):
		if not points[index - 1] is Dictionary or not points[index] is Dictionary:
			return null
		var dx := float(points[index].get("x", 0.0)) - float(points[index - 1].get("x", 0.0))
		var dy := float(points[index].get("y", 0.0)) - float(points[index - 1].get("y", 0.0))
		cumulative.push_back(float(cumulative[-1]) + Vector2(dx, dy).length())
	var total := float(cumulative[-1])
	if not total > 0.000001:
		return null
	return {"points": points.duplicate(true), "cum": cumulative, "total": total}


static func project_to_t(curve: Dictionary, px: float, py: float) -> float:
	var points: Array = curve.get("points", [])
	var cumulative: Array = curve.get("cum", [])
	var total := float(curve.get("total", 0.0))
	if points.size() < 2 or cumulative.size() != points.size() or total <= 0.000001:
		return 0.0
	var best_distance_squared := INF
	var best_arc := 0.0
	for index in range(points.size() - 1):
		var a: Dictionary = points[index]
		var b: Dictionary = points[index + 1]
		var ab := Vector2(float(b.get("x", 0.0)) - float(a.get("x", 0.0)), float(b.get("y", 0.0)) - float(a.get("y", 0.0)))
		var relative := Vector2(px - float(a.get("x", 0.0)), py - float(a.get("y", 0.0)))
		var segment_t := clampf(relative.dot(ab) / ab.length_squared(), 0.0, 1.0) if ab.length_squared() > 0.000000001 else 0.0
		var closest := Vector2(float(a.get("x", 0.0)), float(a.get("y", 0.0))) + ab * segment_t
		var distance_squared := closest.distance_squared_to(Vector2(px, py))
		if distance_squared < best_distance_squared:
			best_distance_squared = distance_squared
			best_arc = float(cumulative[index]) + segment_t * (float(cumulative[index + 1]) - float(cumulative[index]))
	return clampf(best_arc / total, 0.0, 1.0)


static func interpolate(curve: Dictionary, t01: float) -> Dictionary:
	var points: Array = curve.get("points", [])
	var cumulative: Array = curve.get("cum", [])
	var total := float(curve.get("total", 0.0))
	if points.size() < 2 or cumulative.size() != points.size() or total <= 0.000001:
		return {}
	var arc := clampf(t01, 0.0, 1.0) * total
	var segment := 0
	while segment < points.size() - 2 and float(cumulative[segment + 1]) < arc:
		segment += 1
	var segment_length := float(cumulative[segment + 1]) - float(cumulative[segment])
	var raw_u := (arc - float(cumulative[segment])) / segment_length if segment_length > 0.000000001 else 0.0
	var u := raw_u * raw_u * (3.0 - 2.0 * raw_u)
	var a: Dictionary = points[segment].get("env", {}) if points[segment].get("env") is Dictionary else {}
	var b: Dictionary = points[segment + 1].get("env", {}) if points[segment + 1].get("env") is Dictionary else {}
	var output: Dictionary = {}
	var key := _blend_group(a.get("key"), b.get("key"), u, ["elevationDeg", "intensity"], ["azimuthDeg"], ["color"], [])
	var ambient := _blend_group(a.get("ambient"), b.get("ambient"), u, ["intensity"], [], ["color"], [])
	var shadow := _blend_group(a.get("shadow"), b.get("shadow"), u, ["darkness", "softness", "length", "contact", "contactSize", "softSamples", "softRadius"], [], [], ["mode", "enabled", "billboard"])
	var ao := _blend_group(a.get("ao"), b.get("ao"), u, ["contact", "form"], [], [], [])
	if not key.is_empty(): output.key = key
	if not ambient.is_empty(): output.ambient = ambient
	if not shadow.is_empty(): output.shadow = shadow
	if not ao.is_empty(): output.ao = ao
	var tone: Variant = _blend_number(_read(a, "toneStrength"), _read(b, "toneStrength"), u)
	if tone != null: output.toneStrength = tone
	var tone_enabled: Variant = _pick(_read(a, "toneEnabled"), _read(b, "toneEnabled"), u)
	if tone_enabled != null: output.toneEnabled = tone_enabled
	return output


static func copy_resolved_into(destination: Dictionary, source: Dictionary) -> void:
	for group: String in ["key", "ambient", "shadow", "ao"]:
		if not destination.get(group) is Dictionary: destination[group] = {}
		var source_group: Variant = source.get(group)
		if source_group is Dictionary:
			destination[group].clear()
			for field: Variant in source_group: destination[group][field] = source_group[field]
	for field: String in ["toneStrength", "toneEnabled"]:
		if source.has(field): destination[field] = source[field]


static func _blend_group(a_value: Variant, b_value: Variant, u: float, number_fields: Array, angle_fields: Array, color_fields: Array, discrete_fields: Array) -> Dictionary:
	var a: Dictionary = a_value if a_value is Dictionary else {}
	var b: Dictionary = b_value if b_value is Dictionary else {}
	var output: Dictionary = {}
	for field: String in number_fields:
		var result: Variant = _blend_number(_read(a, field), _read(b, field), u)
		if result != null: output[field] = result
	for field: String in angle_fields:
		var result: Variant = _blend_angle(_read(a, field), _read(b, field), u)
		if result != null: output[field] = result
	for field: String in color_fields:
		var result: Variant = _blend_color(_read(a, field), _read(b, field), u)
		if result != null: output[field] = result
	for field: String in discrete_fields:
		var result: Variant = _pick(_read(a, field), _read(b, field), u)
		if result != null: output[field] = result
	return output


static func _read(value: Dictionary, key: String) -> Variant:
	return value[key] if value.has(key) else null


static func _blend_number(a: Variant, b: Variant, u: float) -> Variant:
	if a == null and b == null: return null
	if a == null: return b
	if b == null: return a
	return lerpf(float(a), float(b), u)


static func _blend_angle(a: Variant, b: Variant, u: float) -> Variant:
	if a == null and b == null: return null
	if a == null: return b
	if b == null: return a
	var delta := fposmod(float(b) - float(a) + 540.0, 360.0) - 180.0
	return fposmod(float(a) + delta * u, 360.0)


static func _blend_color(a: Variant, b: Variant, u: float) -> Variant:
	if a == null and b == null: return null
	if a == null: return b
	if b == null: return a
	if not a is Array or not b is Array or a.size() < 3 or b.size() < 3: return a
	return [lerpf(float(a[0]), float(b[0]), u), lerpf(float(a[1]), float(b[1]), u), lerpf(float(a[2]), float(b[2]), u)]


static func _pick(a: Variant, b: Variant, u: float) -> Variant:
	if a == null and b == null: return null
	if a == null: return b
	if b == null: return a
	return a if u < 0.5 else b
