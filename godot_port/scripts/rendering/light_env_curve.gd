class_name RuntimeLightEnvCurve
extends RefCounted


static func prepare(definition: Variant) -> Variant:
	var points: Variant = definition.get("points") if definition is Dictionary else null
	if not points is Array or points.size() < 2:
		return null
	var cumulative: Array = [0.0]
	for index in range(1, points.size()):
		var delta_x := float(points[index].x) - float(points[index - 1].x)
		var delta_y := float(points[index].y) - float(points[index - 1].y)
		cumulative.push_back(float(cumulative[index - 1]) + sqrt(delta_x * delta_x + delta_y * delta_y))
	var total := float(cumulative[cumulative.size() - 1])
	if not total > 0.000001:
		return null
	return {"points": points, "cum": cumulative, "total": total}


static func project_to_t(curve: Dictionary, point_x: float, point_y: float) -> float:
	var points: Array = curve.points
	var cumulative: Array = curve.cum
	var total := float(curve.total)
	var best_distance_squared := INF
	var best_arc := 0.0
	for index in range(points.size() - 1):
		var anchor_x := float(points[index].x)
		var anchor_y := float(points[index].y)
		var end_x := float(points[index + 1].x)
		var end_y := float(points[index + 1].y)
		var segment_x := end_x - anchor_x
		var segment_y := end_y - anchor_y
		var length_squared := segment_x * segment_x + segment_y * segment_y
		var segment_t := ((point_x - anchor_x) * segment_x + (point_y - anchor_y) * segment_y) / length_squared if length_squared > 0.000000001 else 0.0
		if segment_t < 0.0:
			segment_t = 0.0
		elif segment_t > 1.0:
			segment_t = 1.0
		var closest_x := anchor_x + segment_x * segment_t
		var closest_y := anchor_y + segment_y * segment_t
		var delta_x := point_x - closest_x
		var delta_y := point_y - closest_y
		var distance_squared := delta_x * delta_x + delta_y * delta_y
		if distance_squared < best_distance_squared:
			best_distance_squared = distance_squared
			best_arc = float(cumulative[index]) + segment_t * (float(cumulative[index + 1]) - float(cumulative[index]))
	return clampf(best_arc / total, 0.0, 1.0)


static func _lerp(a: float, b: float, u: float) -> float:
	return a + (b - a) * u


static func _lerp_rgb(a: Array, b: Array, u: float) -> Array:
	return [_lerp(a[0], b[0], u), _lerp(a[1], b[1], u), _lerp(a[2], b[2], u)]


static func _lerp_angle_degrees(a: float, b: float, u: float) -> float:
	var delta := fmod(fmod(b - a, 360.0) + 540.0, 360.0) - 180.0
	var result := a + delta * u
	result = fmod(fmod(result, 360.0) + 360.0, 360.0)
	return result


static func _pair(a: Variant, b: Variant) -> Variant:
	if a == null and b == null:
		return null
	if a == null:
		return [b]
	if b == null:
		return [a]
	return [a, b]


static func _blend_number(a: Variant, b: Variant, u: float) -> Variant:
	var pair: Variant = _pair(a, b)
	if pair == null:
		return null
	return pair[0] if pair.size() == 1 else _lerp(pair[0], pair[1], u)


static func _blend_angle(a: Variant, b: Variant, u: float) -> Variant:
	var pair: Variant = _pair(a, b)
	if pair == null:
		return null
	return pair[0] if pair.size() == 1 else _lerp_angle_degrees(pair[0], pair[1], u)


static func _blend_color(a: Variant, b: Variant, u: float) -> Variant:
	var pair: Variant = _pair(a, b)
	if pair == null:
		return null
	return pair[0] if pair.size() == 1 else _lerp_rgb(pair[0], pair[1], u)


static func _pick(a: Variant, b: Variant, u: float) -> Variant:
	var pair: Variant = _pair(a, b)
	if pair == null:
		return null
	if pair.size() == 1:
		return pair[0]
	return pair[0] if u < 0.5 else pair[1]


static func _compact(object: Dictionary) -> Dictionary:
	for key: Variant in object.keys():
		if object[key] == null:
			object.erase(key)
	return object


static func interpolate(curve: Dictionary, t01: float) -> Dictionary:
	var points: Array = curve.points
	var cumulative: Array = curve.cum
	var total := float(curve.total)
	var arc := clampf(t01, 0.0, 1.0) * total
	var segment := 0
	while segment < points.size() - 2 and float(cumulative[segment + 1]) < arc:
		segment += 1
	var segment_length := float(cumulative[segment + 1]) - float(cumulative[segment])
	var raw_u := (arc - float(cumulative[segment])) / segment_length if segment_length > 0.000000001 else 0.0
	var u := raw_u * raw_u * (3.0 - 2.0 * raw_u)
	var a: Dictionary = points[segment].env if points[segment].get("env") is Dictionary else {}
	var b: Dictionary = points[segment + 1].env if points[segment + 1].get("env") is Dictionary else {}
	var a_key: Dictionary = a.key if a.get("key") is Dictionary else {}
	var b_key: Dictionary = b.key if b.get("key") is Dictionary else {}
	var key := _compact({
		"azimuthDeg": _blend_angle(a_key.get("azimuthDeg"), b_key.get("azimuthDeg"), u),
		"elevationDeg": _blend_number(a_key.get("elevationDeg"), b_key.get("elevationDeg"), u),
		"color": _blend_color(a_key.get("color"), b_key.get("color"), u),
		"intensity": _blend_number(a_key.get("intensity"), b_key.get("intensity"), u),
	})
	var a_ambient: Dictionary = a.ambient if a.get("ambient") is Dictionary else {}
	var b_ambient: Dictionary = b.ambient if b.get("ambient") is Dictionary else {}
	var ambient := _compact({
		"color": _blend_color(a_ambient.get("color"), b_ambient.get("color"), u),
		"intensity": _blend_number(a_ambient.get("intensity"), b_ambient.get("intensity"), u),
	})
	var a_shadow: Dictionary = a.shadow if a.get("shadow") is Dictionary else {}
	var b_shadow: Dictionary = b.shadow if b.get("shadow") is Dictionary else {}
	var shadow := _compact({
		"mode": _pick(a_shadow.get("mode"), b_shadow.get("mode"), u),
		"enabled": _pick(a_shadow.get("enabled"), b_shadow.get("enabled"), u),
		"darkness": _blend_number(a_shadow.get("darkness"), b_shadow.get("darkness"), u),
		"softness": _blend_number(a_shadow.get("softness"), b_shadow.get("softness"), u),
		"length": _blend_number(a_shadow.get("length"), b_shadow.get("length"), u),
		"contact": _blend_number(a_shadow.get("contact"), b_shadow.get("contact"), u),
		"contactSize": _blend_number(a_shadow.get("contactSize"), b_shadow.get("contactSize"), u),
		"softSamples": _blend_number(a_shadow.get("softSamples"), b_shadow.get("softSamples"), u),
		"softRadius": _blend_number(a_shadow.get("softRadius"), b_shadow.get("softRadius"), u),
		"billboard": _pick(a_shadow.get("billboard"), b_shadow.get("billboard"), u),
	})
	var output: Dictionary = {}
	if not key.is_empty():
		output.key = key
	if not ambient.is_empty():
		output.ambient = ambient
	if not shadow.is_empty():
		output.shadow = shadow
	var tone: Variant = _blend_number(a.get("toneStrength"), b.get("toneStrength"), u)
	if tone != null:
		output.toneStrength = tone
	var tone_enabled: Variant = _pick(a.get("toneEnabled"), b.get("toneEnabled"), u)
	if tone_enabled != null:
		output.toneEnabled = tone_enabled
	var a_ao: Dictionary = a.ao if a.get("ao") is Dictionary else {}
	var b_ao: Dictionary = b.ao if b.get("ao") is Dictionary else {}
	var ao := _compact({
		"contact": _blend_number(a_ao.get("contact"), b_ao.get("contact"), u),
		"form": _blend_number(a_ao.get("form"), b_ao.get("form"), u),
	})
	if not ao.is_empty():
		output.ao = ao
	return output


static func copy_resolved_into(destination: Dictionary, source: Dictionary) -> void:
	destination.key.azimuthDeg = source.key.azimuthDeg
	destination.key.elevationDeg = source.key.elevationDeg
	destination.key.color = source.key.color
	destination.key.intensity = source.key.intensity
	destination.ambient.color = source.ambient.color
	destination.ambient.intensity = source.ambient.intensity
	destination.shadow.mode = source.shadow.mode
	destination.shadow.enabled = source.shadow.enabled
	destination.shadow.darkness = source.shadow.darkness
	destination.shadow.softness = source.shadow.softness
	destination.shadow.length = source.shadow.length
	destination.shadow.contact = source.shadow.contact
	destination.shadow.contactSize = source.shadow.contactSize
	destination.shadow.softSamples = source.shadow.softSamples
	destination.shadow.softRadius = source.shadow.softRadius
	destination.shadow.billboard = source.shadow.billboard
	destination.toneStrength = source.toneStrength
	destination.toneEnabled = source.toneEnabled
	destination.ao.contact = source.ao.contact
	destination.ao.form = source.ao.form
