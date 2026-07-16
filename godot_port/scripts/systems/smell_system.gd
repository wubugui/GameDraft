class_name RuntimeSmellSystem
extends RuntimeSystem

const MANUAL_ZONE_KEY := "__manual__"
# GDScript collapses an omitted optional argument and an explicit `null` into the
# same value.  JavaScript does not: Number(undefined) is NaN while Number(null)
# is 0.  A StringName cannot arrive from JSON, so it is a lossless platform-edge
# representation of JavaScript `undefined` here.
const JS_UNDEFINED: StringName = &"__gamedraft_js_undefined__"

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore

var action: Dictionary = _empty_layer()
var zone: Dictionary = _empty_layer()
var active_zone_smells: Dictionary = {}

var on_zone_enter: Callable
var on_zone_exit: Callable


static func _empty_layer() -> Dictionary:
	return {"scent": "", "intensity": 0.0, "dir": 0.0, "flicker": false}


static func _normalize_layer(
	scent: Variant,
	intensity: Variant = JS_UNDEFINED,
	dir: Variant = JS_UNDEFINED,
	flicker: Variant = false,
) -> Dictionary:
	var id := str(scent) if scent != null else ""
	if id.is_empty():
		return _empty_layer()
	var numeric_intensity := _js_number(intensity)
	var numeric_dir := _js_number(dir)
	return {
		"scent": id,
		"intensity": clampf(numeric_intensity, 0.0, 100.0) if is_finite(numeric_intensity) else 60.0,
		"dir": clampf(numeric_dir, -1.0, 1.0) if not _is_js_undefined(dir) and is_finite(numeric_dir) else 0.0,
		"flicker": _js_boolean(flicker),
	}


# Platform adapters for JavaScript Number()/Boolean() at the typed runtime edge.
static func _js_number(value: Variant) -> float:
	if _is_js_undefined(value):
		return NAN
	if value == null:
		return 0.0
	if value is bool:
		return 1.0 if value else 0.0
	if value is int or value is float:
		return float(value)
	if value is Array:
		return _js_number(_js_array_string(value))
	if value is Dictionary or value is Object:
		return NAN
	var text := str(value).strip_edges()
	if text.is_empty():
		return 0.0
	if text == "Infinity" or text == "+Infinity":
		return INF
	if text == "-Infinity":
		return -INF
	if text.to_lower().begins_with("0x") and text.substr(2).is_valid_hex_number():
		return float(text.substr(2).hex_to_int())
	if text.to_lower().begins_with("0b"):
		return _parse_prefixed_integer(text.substr(2), 2)
	if text.to_lower().begins_with("0o"):
		return _parse_prefixed_integer(text.substr(2), 8)
	return text.to_float() if text.is_valid_float() else NAN


static func _is_js_undefined(value: Variant) -> bool:
	return value is StringName and value == JS_UNDEFINED


static func _js_array_string(value: Array) -> String:
	var parts: Array[String] = []
	for item: Variant in value:
		if item == null:
			parts.push_back("")
		elif item is Array:
			parts.push_back(_js_array_string(item))
		else:
			parts.push_back(str(item))
	return ",".join(parts)


static func _parse_prefixed_integer(digits: String, base: int) -> float:
	if digits.is_empty():
		return NAN
	var result := 0.0
	for code: int in digits.to_ascii_buffer():
		var digit := code - 48
		if digit < 0 or digit >= base:
			return NAN
		result = result * float(base) + float(digit)
	return result


static func _js_boolean(value: Variant) -> bool:
	if value == null:
		return false
	if value is bool:
		return value
	if value is int or value is float:
		return float(value) != 0.0 and not is_nan(float(value))
	if value is String:
		return not value.is_empty()
	return true


func _init(next_event_bus: RuntimeEventBus, next_flag_store: RuntimeFlagStore) -> void:
	event_bus = next_event_bus
	flag_store = next_flag_store
	on_zone_enter = func(payload: Variant = null) -> void:
		var entered_zone: Variant = payload.get("zone") if payload is Dictionary else null
		if not entered_zone is Dictionary:
			return
		var id := str(entered_zone.get("id", ""))
		var config: Variant = entered_zone.get("smell")
		if id.is_empty() or not config is Dictionary or str(config.get("scent", "")).is_empty():
			return
		active_zone_smells[id] = _normalize_layer(
			config.get("scent"),
			config.get("intensity", JS_UNDEFINED),
			config.get("dir", JS_UNDEFINED),
			config.get("flicker"),
		)
		_refresh_zone_layer()
	on_zone_exit = func(payload: Variant = null) -> void:
		if not payload is Dictionary:
			return
		var id_value: Variant = payload.get("zoneId") if payload.has("zoneId") and payload.get("zoneId") != null else null
		if id_value == null and payload.get("zone") is Dictionary:
			id_value = payload.zone.get("id")
		var id := str(id_value) if id_value != null else ""
		if not id.is_empty() and active_zone_smells.erase(id):
			_refresh_zone_layer()


func init(_ctx: Dictionary) -> void:
	event_bus.off("zone:enter", on_zone_enter)
	event_bus.off("zone:exit", on_zone_exit)
	event_bus.on("zone:enter", on_zone_enter)
	event_bus.on("zone:exit", on_zone_exit)
	action = _empty_layer()
	zone = _empty_layer()
	active_zone_smells.clear()
	_sync_flags()
	_emit_changed()


func update(_dt: float) -> void:
	return


func _resolve() -> Dictionary:
	if not action.scent.is_empty():
		return {"layer": action, "source": "action"}
	if not zone.scent.is_empty():
		return {"layer": zone, "source": "zone"}
	return {"layer": _empty_layer(), "source": "none"}


func _refresh_zone_layer() -> void:
	var dominant := _empty_layer()
	for layer: Dictionary in active_zone_smells.values():
		dominant = layer
	zone = dominant.duplicate(false)
	_sync_flags()
	_emit_changed()


func set_smell(scent: String, intensity: Variant = null, dir: Variant = null, flicker: Variant = false) -> void:
	# The typed source API cannot receive null; the Godot action/debug adapters use
	# null to carry an omitted optional argument across their dynamic boundary.
	action = _normalize_layer(
		scent,
		JS_UNDEFINED if intensity == null else intensity,
		JS_UNDEFINED if dir == null else dir,
		flicker,
	)
	_sync_flags()
	_emit_changed()


func clear_smell() -> void:
	action = _empty_layer()
	_sync_flags()
	_emit_changed()


func set_zone_smell(scent: String, intensity: Variant = null, dir: Variant = null, flicker: Variant = false) -> void:
	var layer := _normalize_layer(
		scent,
		JS_UNDEFINED if intensity == null else intensity,
		JS_UNDEFINED if dir == null else dir,
		flicker,
	)
	if not layer.scent.is_empty():
		active_zone_smells[MANUAL_ZONE_KEY] = layer
	else:
		active_zone_smells.erase(MANUAL_ZONE_KEY)
	_refresh_zone_layer()


func clear_zone_smell() -> void:
	if active_zone_smells.erase(MANUAL_ZONE_KEY):
		_refresh_zone_layer()


func sniff() -> void:
	var resolved := _resolve()
	if resolved.layer.scent.is_empty():
		return
	event_bus.emit("player:smellSniff", {"scent": resolved.layer.scent})


func get_scent() -> String:
	return str(_resolve().layer.scent)


func get_intensity() -> float:
	return float(_resolve().layer.intensity)


func get_source() -> String:
	return str(_resolve().source)


func get_debug_state() -> Dictionary:
	var resolved := _resolve()
	return {
		"source": resolved.source,
		"effective": resolved.layer.duplicate(false),
		"action": action.duplicate(false),
		"zone": zone.duplicate(false),
	}


func _sync_flags() -> void:
	var resolved := _resolve()
	flag_store.set_value("current_smell", resolved.layer.scent)
	flag_store.set_value("smell_intensity", resolved.layer.intensity)
	flag_store.set_value("current_smell_dir", resolved.layer.dir)
	flag_store.set_value("current_smell_flicker", resolved.layer.flicker)
	flag_store.set_value("current_smell_source", resolved.source)


func _emit_changed() -> void:
	var resolved := _resolve()
	event_bus.emit("player:smellChanged", {
		"scent": resolved.layer.scent,
		"intensity": resolved.layer.intensity,
		"dir": resolved.layer.dir,
		"flicker": resolved.layer.flicker,
		"source": resolved.source,
	})


func serialize() -> Dictionary:
	return {"action": action.duplicate(false)}


func deserialize(data: Dictionary) -> void:
	var source: Variant = data.get("action") if data.has("action") and data.get("action") != null else null
	if source == null and data.get("scent") is String:
		source = data
	if _js_boolean(source):
		var source_dict: Dictionary = source if source is Dictionary else {}
		action = {
			"scent": source_dict.scent if source_dict.get("scent") is String else "",
			"intensity": source_dict.intensity if source_dict.get("intensity") is int or source_dict.get("intensity") is float else 0.0,
			"dir": source_dict.dir if source_dict.get("dir") is int or source_dict.get("dir") is float else 0.0,
			"flicker": source_dict.flicker if source_dict.get("flicker") is bool else false,
		}
	_sync_flags()
	_emit_changed()


func destroy() -> void:
	event_bus.off("zone:enter", on_zone_enter)
	event_bus.off("zone:exit", on_zone_exit)
	active_zone_smells.clear()
