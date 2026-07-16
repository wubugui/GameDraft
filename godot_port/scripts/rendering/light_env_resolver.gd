class_name RuntimeLightEnvResolver
extends RefCounted

const BASELINE := {
	"key": {"azimuthDeg": 125.0, "elevationDeg": 55.0, "color": [1.0, 0.97, 0.92], "intensity": 1.0},
	"ambient": {"color": [0.55, 0.6, 0.72], "intensity": 1.0},
	"shadow": {
		"mode": "real", "enabled": true, "darkness": 0.4, "softness": 1.0, "length": 0.0,
		"contact": 0.5, "contactSize": 1.0, "softSamples": 1, "softRadius": 0.05, "billboard": "light",
	},
	"toneStrength": 0.45,
	"toneEnabled": true,
	"ao": {"contact": 0.45, "form": 0.25},
}
const DEG2RAD := PI / 180.0


static func _num(value: Variant, fallback: float) -> float:
	return float(value) if (value is int or value is float) and is_finite(float(value)) else fallback


static func _explicit_num(value: Variant) -> Variant:
	return float(value) if (value is int or value is float) and is_finite(float(value)) else null


static func _color(value: Variant, fallback: Array) -> Array:
	if not value is Array or value.size() < 3:
		return fallback
	var output: Array = []
	for index in 3:
		var number := _js_number(value[index])
		output.push_back(clampf(number, 0.0, 4.0) if is_finite(number) else fallback[index])
	return output


static func _length_from_elevation(elevation_degrees: float) -> float:
	var elevation := clampf(elevation_degrees, 8.0, 85.0) * DEG2RAD
	var cotangent := cos(elevation) / maxf(sin(elevation), 0.001)
	return clampf(cotangent, 0.3, 1.6)


static func _merge_one(base: Dictionary, source: Variant) -> Dictionary:
	if source == null:
		return base
	var src: Dictionary = source if source is Dictionary else {}
	var source_key: Dictionary = src.get("key") if src.get("key") is Dictionary else {}
	var source_ambient: Dictionary = src.get("ambient") if src.get("ambient") is Dictionary else {}
	var source_shadow: Dictionary = src.get("shadow") if src.get("shadow") is Dictionary else {}
	var source_ao: Dictionary = src.get("ao") if src.get("ao") is Dictionary else {}
	var azimuth_degrees := _num(source_key.get("azimuthDeg"), base.key.azimuthDeg)
	var elevation_degrees := _num(source_key.get("elevationDeg"), base.key.elevationDeg)
	return {
		"key": {
			"azimuthDeg": azimuth_degrees,
			"elevationDeg": elevation_degrees,
			"color": _color(source_key.get("color"), base.key.color),
			"intensity": _num(source_key.get("intensity"), base.key.intensity),
		},
		"ambient": {
			"color": _color(source_ambient.get("color"), base.ambient.color),
			"intensity": _num(source_ambient.get("intensity"), base.ambient.intensity),
		},
		"shadow": {
			"mode": _nullish(source_shadow.get("mode"), base.shadow.mode),
			"enabled": _nullish(source_shadow.get("enabled"), base.shadow.enabled),
			"darkness": clampf(_num(source_shadow.get("darkness"), base.shadow.darkness), 0.0, 1.0),
			"softness": maxf(0.0, _num(source_shadow.get("softness"), base.shadow.softness)),
			"length": _num(source_shadow.get("length"), base.shadow.length),
			"contact": clampf(_num(source_shadow.get("contact"), base.shadow.contact), 0.0, 1.0),
			"contactSize": maxf(0.1, _num(source_shadow.get("contactSize"), base.shadow.contactSize)),
			"softSamples": clampi(roundi(_num(source_shadow.get("softSamples"), base.shadow.softSamples)), 1, 16),
			"softRadius": maxf(0.0, _num(source_shadow.get("softRadius"), base.shadow.softRadius)),
			"billboard": _nullish(source_shadow.get("billboard"), base.shadow.billboard),
		},
		"toneStrength": clampf(_num(src.get("toneStrength"), base.toneStrength), 0.0, 1.0),
		"toneEnabled": _nullish(src.get("toneEnabled"), base.toneEnabled),
		"ao": {
			"contact": clampf(_num(source_ao.get("contact"), base.ao.contact), 0.0, 1.0),
			"form": clampf(_num(source_ao.get("form"), base.ao.form), 0.0, 1.0),
		},
	}


static func resolve(scene_environment: Variant, global_config: Variant) -> Dictionary:
	var global: Dictionary = global_config if global_config is Dictionary else {}
	var base := {
		"key": BASELINE.key.duplicate(false),
		"ambient": BASELINE.ambient.duplicate(false),
		"shadow": BASELINE.shadow.duplicate(false),
		"toneStrength": BASELINE.toneStrength,
		"toneEnabled": BASELINE.toneEnabled,
		"ao": BASELINE.ao.duplicate(false),
	}
	var with_global := _merge_one(base, global.get("defaultLightEnv"))
	var resolved := _merge_one(with_global, scene_environment)
	var scene: Dictionary = scene_environment if scene_environment is Dictionary else {}
	var scene_shadow: Dictionary = scene.get("shadow") if scene.get("shadow") is Dictionary else {}
	var global_environment: Dictionary = global.get("defaultLightEnv") if global.get("defaultLightEnv") is Dictionary else {}
	var global_shadow: Dictionary = global_environment.get("shadow") if global_environment.get("shadow") is Dictionary else {}
	resolved.shadow.mode = _nullish(scene_shadow.get("mode"), _nullish(global.get("shadowMode"), resolved.shadow.mode))
	resolved.toneEnabled = _nullish(scene.get("toneEnabled"), _nullish(global.get("toneEnabled"), resolved.toneEnabled))
	var explicit_length: Variant = _explicit_num(scene_shadow.get("length"))
	if explicit_length == null:
		explicit_length = _explicit_num(global_shadow.get("length"))
	resolved.shadow.length = explicit_length if explicit_length != null else _length_from_elevation(resolved.key.elevationDeg)
	return resolved


static func _nullish(value: Variant, fallback: Variant) -> Variant:
	return fallback if value == null else value


static func _js_number(value: Variant) -> float:
	if value == null:
		return 0.0
	if value is bool:
		return 1.0 if value else 0.0
	if value is int or value is float:
		return float(value)
	if value is String:
		var text: String = value.strip_edges()
		if text.is_empty():
			return 0.0
		if text in ["Infinity", "+Infinity"]:
			return INF
		if text == "-Infinity":
			return -INF
		return text.to_float() if text.is_valid_float() else NAN
	return NAN
