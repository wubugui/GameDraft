class_name RuntimeSmellSystem
extends RuntimeSystem

const MANUAL_ZONE_KEY := "__manual__"

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _action: Dictionary = _empty_layer()
var _zone: Dictionary = _empty_layer()
var _active_zone_smells: Dictionary = {}


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore) -> void:
	_event_bus = event_bus
	_flag_store = flag_store


func init(_ctx: Dictionary) -> void:
	_event_bus.off("zone:enter", Callable(self, "_on_zone_enter"))
	_event_bus.off("zone:exit", Callable(self, "_on_zone_exit"))
	_event_bus.on("zone:enter", Callable(self, "_on_zone_enter"))
	_event_bus.on("zone:exit", Callable(self, "_on_zone_exit"))
	_action = _empty_layer()
	_zone = _empty_layer()
	_active_zone_smells.clear()
	_sync_flags()
	_emit_changed()


func update(_dt: float) -> void:
	return


func set_smell(scent: String, intensity: Variant = null, dir: Variant = null, flicker: Variant = false) -> void:
	_action = _normalize_layer(scent, intensity, dir, flicker)
	_sync_flags()
	_emit_changed()


func clear_smell() -> void:
	_action = _empty_layer()
	_sync_flags()
	_emit_changed()


func set_zone_smell(scent: String, intensity: Variant = null, dir: Variant = null, flicker: Variant = false) -> void:
	var layer := _normalize_layer(scent, intensity, dir, flicker)
	if not layer.scent.is_empty(): _active_zone_smells[MANUAL_ZONE_KEY] = layer
	else: _active_zone_smells.erase(MANUAL_ZONE_KEY)
	_refresh_zone_layer()


func clear_zone_smell() -> void:
	if _active_zone_smells.erase(MANUAL_ZONE_KEY): _refresh_zone_layer()


func sniff() -> void:
	var resolved := _resolve()
	if not resolved.layer.scent.is_empty(): _event_bus.emit("player:smellSniff", {"scent": resolved.layer.scent})


func get_scent() -> String: return str(_resolve().layer.scent)
func get_intensity() -> float: return float(_resolve().layer.intensity)
func get_source() -> String: return str(_resolve().source)


func get_debug_state() -> Dictionary:
	var resolved := _resolve()
	return {"source": resolved.source, "effective": resolved.layer.duplicate(true), "action": _action.duplicate(true), "zone": _zone.duplicate(true)}


func serialize() -> Dictionary:
	return {"action": _action.duplicate(true)}


func deserialize(data: Dictionary) -> void:
	var source: Variant = data.get("action")
	if not source is Dictionary and data.get("scent") is String: source = data
	if source is Dictionary:
		_action = {
			"scent": str(source.get("scent", "")) if source.get("scent") is String else "",
			"intensity": float(source.get("intensity", 0.0)) if source.get("intensity") is int or source.get("intensity") is float else 0.0,
			"dir": float(source.get("dir", 0.0)) if source.get("dir") is int or source.get("dir") is float else 0.0,
			"flicker": source.get("flicker") if source.get("flicker") is bool else false,
		}
	_sync_flags(); _emit_changed()


func destroy() -> void:
	_event_bus.off("zone:enter", Callable(self, "_on_zone_enter"))
	_event_bus.off("zone:exit", Callable(self, "_on_zone_exit"))
	_active_zone_smells.clear()


func debug_snapshot_fragment() -> Dictionary: return {"smell": get_debug_state()}


func _on_zone_enter(payload: Variant) -> void:
	if not payload is Dictionary or not payload.get("zone") is Dictionary: return
	var zone: Dictionary = payload.zone
	var id := str(zone.get("id", "")); var config: Variant = zone.get("smell")
	if id.is_empty() or not config is Dictionary or str(config.get("scent", "")).is_empty(): return
	_active_zone_smells[id] = _normalize_layer(str(config.scent), config.get("intensity"), config.get("dir"), config.get("flicker"))
	_refresh_zone_layer()


func _on_zone_exit(payload: Variant) -> void:
	if not payload is Dictionary: return
	var id := str(payload.get("zoneId", ""))
	if id.is_empty() and payload.get("zone") is Dictionary: id = str(payload.zone.get("id", ""))
	if not id.is_empty() and _active_zone_smells.erase(id): _refresh_zone_layer()


func _resolve() -> Dictionary:
	if not _action.scent.is_empty(): return {"layer": _action, "source": "action"}
	if not _zone.scent.is_empty(): return {"layer": _zone, "source": "zone"}
	return {"layer": _empty_layer(), "source": "none"}


func _refresh_zone_layer() -> void:
	var dominant := _empty_layer()
	for layer: Dictionary in _active_zone_smells.values(): dominant = layer
	_zone = dominant.duplicate(true)
	_sync_flags(); _emit_changed()


func _sync_flags() -> void:
	var resolved := _resolve()
	_flag_store.set_value("current_smell", resolved.layer.scent)
	_flag_store.set_value("smell_intensity", resolved.layer.intensity)
	_flag_store.set_value("current_smell_dir", resolved.layer.dir)
	_flag_store.set_value("current_smell_flicker", resolved.layer.flicker)
	_flag_store.set_value("current_smell_source", resolved.source)


func _emit_changed() -> void:
	var resolved := _resolve()
	_event_bus.emit("player:smellChanged", {"scent": resolved.layer.scent, "intensity": resolved.layer.intensity, "dir": resolved.layer.dir, "flicker": resolved.layer.flicker, "source": resolved.source})


static func _empty_layer() -> Dictionary:
	return {"scent": "", "intensity": 0.0, "dir": 0.0, "flicker": false}


static func _normalize_layer(scent: Variant, intensity: Variant, dir: Variant, flicker: Variant) -> Dictionary:
	var id := str(scent) if scent != null else ""
	if id.is_empty(): return _empty_layer()
	var raw_intensity := _js_number(intensity); var raw_dir := _js_number(dir)
	return {"scent": id, "intensity": clampf(raw_intensity, 0.0, 100.0) if is_finite(raw_intensity) else 60.0, "dir": clampf(raw_dir, -1.0, 1.0) if dir != null and is_finite(raw_dir) else 0.0, "flicker": _js_boolean(flicker)}


static func _js_number(value: Variant) -> float:
	if value == null: return NAN
	if value is bool: return 1.0 if value else 0.0
	if value is int or value is float: return float(value)
	var text := str(value).strip_edges()
	return 0.0 if text.is_empty() else (text.to_float() if text.is_valid_float() else NAN)


static func _js_boolean(value: Variant) -> bool:
	if value == null: return false
	if value is bool: return value
	if value is int or value is float: return float(value) != 0.0 and not is_nan(float(value))
	if value is String: return not value.is_empty()
	return true
