class_name RuntimeRulesManager
extends RuntimeSystem

const RULES_URL := "/assets/data/rules.json"
const LAYER_ORDER := ["xiang", "li", "shu"]

var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _rule_defs: Dictionary = {}
var _fragment_defs: Dictionary = {}
var _category_names: Dictionary = {}
var _verified_labels: Dictionary = {}
var _acquired_fragments: Dictionary = {}
var _granted_layers: Dictionary = {}
var _strings: RuntimeStringsProvider
var _asset_manager: RuntimeAssetManager


func _init(event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore) -> void:
	_event_bus = event_bus
	_flag_store = flag_store


func init(ctx: Dictionary) -> void:
	_strings = ctx.strings
	_asset_manager = ctx.assetManager


func update(_dt: float) -> void:
	return


func load_defs() -> bool:
	var data: Variant = _asset_manager.load_json(RULES_URL)
	if not data is Dictionary:
		return false
	_rule_defs.clear()
	_fragment_defs.clear()
	for raw: Variant in data.get("rules", []):
		var definition := _normalize_rule(raw)
		if not definition.is_empty(): _rule_defs[definition.id] = definition
	for raw: Variant in data.get("fragments", []):
		var definition := _normalize_fragment(raw)
		if not definition.is_empty(): _fragment_defs[definition.id] = definition
	_category_names = data.get("categories", {}).duplicate(true)
	_verified_labels = data.get("verifiedLabels", {}).duplicate(true)
	return true


func give_rule(rule_id: String) -> void:
	if _has_rule_internal(rule_id): return
	var definition: Variant = _rule_defs.get(rule_id)
	if not definition is Dictionary: return
	var keys := _defined_layers(definition)
	if keys.is_empty(): return
	var granted: Dictionary = _granted_layers.get(rule_id, {})
	for layer: String in keys: granted[layer] = true
	_granted_layers[rule_id] = granted
	_sync_rule_flags(rule_id)
	_emit_rule_acquired(rule_id)


func grant_layer(rule_id: String, layer: String) -> void:
	var definition: Variant = _rule_defs.get(rule_id)
	if not definition is Dictionary or not definition.layers.get(layer) is Dictionary or _has_layer_impl(rule_id, layer): return
	var before_full := _has_rule_internal(rule_id)
	var granted: Dictionary = _granted_layers.get(rule_id, {})
	granted[layer] = true
	_granted_layers[rule_id] = granted
	_sync_rule_flags(rule_id)
	_event_bus.emit("rule:layer", {"ruleId": rule_id, "layer": layer, "source": "grant"})
	if not before_full and _has_rule_internal(rule_id): _emit_rule_acquired(rule_id)


func give_fragment(fragment_id: String) -> void:
	if _acquired_fragments.has(fragment_id): return
	var fragment: Variant = _fragment_defs.get(fragment_id)
	if not fragment is Dictionary: return
	var rule_id := str(fragment.ruleId)
	var before_full := _has_rule_internal(rule_id)
	var before_layers := _snapshot_layer_done(rule_id)
	_acquired_fragments[fragment_id] = true
	_flag_store.set_value("fragment_%s_acquired" % fragment_id, true)
	_sync_rule_flags(rule_id)
	var after_layers := _snapshot_layer_done(rule_id)
	for layer: String in LAYER_ORDER:
		if after_layers.get(layer) == true and before_layers.get(layer) != true:
			_event_bus.emit("rule:layer", {"ruleId": rule_id, "layer": layer, "source": "fragment"})
	_event_bus.emit("rule:fragment", {"fragmentId": fragment_id, "ruleId": rule_id})
	_event_bus.emit("notification:show", {"text": _strings.get_text("notifications", "fragmentAcquired"), "type": "rule"})
	_try_auto_synthesize(rule_id, before_full)


func has_rule(rule_id: String) -> bool: return _has_rule_internal(rule_id)
func has_layer(rule_id: String, layer: String) -> bool: return _has_layer_impl(rule_id, layer)
func has_fragment(fragment_id: String) -> bool: return _acquired_fragments.has(fragment_id)
func get_rule_def(rule_id: String) -> Variant: return _rule_defs.get(rule_id)
func get_category_name(key: String) -> String: return str(_category_names.get(key, key))
func get_verified_label(key: String) -> String: return str(_verified_labels.get(key, key))


func is_discovered(rule_id: String) -> bool:
	if _has_rule_internal(rule_id): return false
	for fragment_id: String in _acquired_fragments:
		var fragment: Variant = _fragment_defs.get(fragment_id)
		if fragment is Dictionary and fragment.ruleId == rule_id: return true
	return not _granted_layers.get(rule_id, {}).is_empty()


func get_discovered_rules() -> Array:
	var result: Array = []
	for definition: Dictionary in _rule_defs.values():
		if not _has_rule_internal(definition.id) and is_discovered(definition.id):
			var progress := get_fragment_progress(definition.id)
			result.push_back({"def": definition, "collected": progress.collected, "total": progress.total})
	return result


func get_acquired_rules() -> Array:
	var result: Array = []
	for definition: Dictionary in _rule_defs.values():
		if _has_rule_internal(definition.id): result.push_back({"def": definition, "acquired": true})
	return result


func get_fragment_progress(rule_id: String) -> Dictionary:
	var fragments: Array = []
	var collected := 0
	for fragment: Dictionary in _fragment_defs.values():
		if fragment.ruleId == rule_id:
			fragments.push_back(fragment)
			if _acquired_fragments.has(fragment.id): collected += 1
	return {"collected": collected, "total": fragments.size(), "fragments": fragments}


func get_rule_depth(rule_id: String) -> Dictionary:
	var definition: Variant = _rule_defs.get(rule_id)
	if not definition is Dictionary: return {"unlocked": 0, "total": 0}
	var keys := _defined_layers(definition)
	var unlocked := 0
	for layer: String in keys:
		if _has_layer_impl(rule_id, layer): unlocked += 1
	return {"unlocked": unlocked, "total": keys.size()}


func get_unlocked_layer_texts(rule_id: String) -> Dictionary:
	var definition: Variant = _rule_defs.get(rule_id)
	if not definition is Dictionary: return {}
	var result := {}
	for layer: String in _defined_layers(definition):
		if _has_layer_impl(rule_id, layer) and not str(definition.layers[layer].get("text", "")).is_empty():
			result[layer] = definition.layers[layer].text
	return result


func get_layer_fragment_progress(rule_id: String) -> Dictionary:
	var definition: Variant = _rule_defs.get(rule_id)
	if not definition is Dictionary: return {}
	var result := {}
	for layer: String in _defined_layers(definition):
		var fragments: Array = []
		var collected := 0
		for fragment: Dictionary in _fragment_defs.values():
			if fragment.ruleId == rule_id and fragment.layer == layer:
				fragments.push_back(fragment)
				if _acquired_fragments.has(fragment.id): collected += 1
		result[layer] = {"collected": collected, "total": fragments.size(), "fragments": fragments}
	return result


func get_pending_fragments() -> Array:
	var result: Array = []
	for fragment_id: String in _acquired_fragments:
		var fragment: Variant = _fragment_defs.get(fragment_id)
		if fragment is Dictionary and not _has_rule_internal(fragment.ruleId): result.push_back(fragment)
	return result


func serialize() -> Dictionary:
	var granted := {}
	for rule_id: String in _granted_layers:
		var layers: Array = []
		for layer: String in LAYER_ORDER:
			if _granted_layers[rule_id].has(layer): layers.push_back(layer)
		if not layers.is_empty(): granted[rule_id] = layers
	return {"acquiredFragments": _acquired_fragments.keys(), "grantedLayers": granted}


func deserialize(data: Dictionary) -> void:
	_acquired_fragments.clear()
	for fragment_id: Variant in data.get("acquiredFragments", []): _acquired_fragments[str(fragment_id)] = true
	_granted_layers.clear()
	var raw_granted: Variant = data.get("grantedLayers", {})
	if raw_granted is Dictionary:
		for rule_id: String in raw_granted:
			var layers := {}
			for layer: Variant in raw_granted[rule_id]:
				if LAYER_ORDER.has(str(layer)): layers[str(layer)] = true
			_granted_layers[rule_id] = layers
	for rule_id: Variant in data.get("acquiredRules", []):
		var definition: Variant = _rule_defs.get(str(rule_id))
		if definition is Dictionary:
			var layers: Dictionary = _granted_layers.get(str(rule_id), {})
			for layer: String in _defined_layers(definition): layers[layer] = true
			_granted_layers[str(rule_id)] = layers
	_resync_all_rule_flags()


func destroy() -> void:
	_acquired_fragments.clear(); _granted_layers.clear(); _rule_defs.clear(); _fragment_defs.clear()


func definition_counts() -> Dictionary: return {"rules": _rule_defs.size(), "fragments": _fragment_defs.size()}


func _has_layer_impl(rule_id: String, layer: String) -> bool:
	var definition: Variant = _rule_defs.get(rule_id)
	if not definition is Dictionary or not definition.layers.get(layer) is Dictionary: return false
	if _granted_layers.get(rule_id, {}).has(layer): return true
	var fragments: Array = []
	for fragment: Dictionary in _fragment_defs.values():
		if fragment.ruleId == rule_id and fragment.layer == layer: fragments.push_back(fragment)
	if fragments.is_empty(): return false
	return fragments.all(func(fragment: Dictionary) -> bool: return _acquired_fragments.has(fragment.id))


func _has_rule_internal(rule_id: String) -> bool:
	var definition: Variant = _rule_defs.get(rule_id)
	if not definition is Dictionary: return false
	var keys := _defined_layers(definition)
	return not keys.is_empty() and keys.all(func(layer: String) -> bool: return _has_layer_impl(rule_id, layer))


func _sync_rule_flags(rule_id: String) -> void:
	var definition: Variant = _rule_defs.get(rule_id)
	if not definition is Dictionary: return
	var progress := get_fragment_progress(rule_id)
	_flag_store.set_value("rule_%s_fragments_collected" % rule_id, float(progress.collected))
	_flag_store.set_value("rule_%s_fragments_total" % rule_id, float(progress.total))
	for layer: String in _defined_layers(definition): _flag_store.set_value("rule_%s_%s_done" % [rule_id, layer], _has_layer_impl(rule_id, layer))
	var full := _has_rule_internal(rule_id)
	_flag_store.set_value("rule_%s_acquired" % rule_id, full)
	if (progress.collected > 0 or not _granted_layers.get(rule_id, {}).is_empty()) and not full:
		_flag_store.set_value("rule_%s_discovered" % rule_id, true)


func _resync_all_rule_flags() -> void:
	for fragment_id: String in _acquired_fragments:
		if _fragment_defs.has(fragment_id): _flag_store.set_value("fragment_%s_acquired" % fragment_id, true)
	for rule_id: String in _rule_defs: _sync_rule_flags(rule_id)


func _try_auto_synthesize(rule_id: String, before_full: bool) -> void:
	var progress := get_fragment_progress(rule_id)
	if progress.total == 0 or progress.collected < progress.total: return
	var definition: Variant = _rule_defs.get(rule_id)
	if not definition is Dictionary: return
	if not _has_rule_internal(rule_id):
		give_rule(rule_id)
		_event_bus.emit("notification:show", {"text": _strings.get_text("notifications", "fragmentSynthesized", {"name": definition.name}), "type": "rule"})
	elif not before_full:
		_emit_rule_acquired(rule_id)
		_event_bus.emit("notification:show", {"text": _strings.get_text("notifications", "fragmentSynthesized", {"name": definition.name}), "type": "rule"})


func _emit_rule_acquired(rule_id: String) -> void:
	var definition: Variant = _rule_defs.get(rule_id)
	var name := str(definition.get("name", rule_id)) if definition is Dictionary else rule_id
	_event_bus.emit("rule:acquired", {"ruleId": rule_id, "name": name})
	_event_bus.emit("notification:show", {"text": _strings.get_text("notifications", "ruleAcquired", {"name": name}), "type": "rule"})


func _snapshot_layer_done(rule_id: String) -> Dictionary:
	var result := {}
	var definition: Variant = _rule_defs.get(rule_id)
	if definition is Dictionary:
		for layer: String in _defined_layers(definition): result[layer] = _has_layer_impl(rule_id, layer)
	return result


func _defined_layers(definition: Dictionary) -> Array[String]:
	var result: Array[String] = []
	for layer: String in LAYER_ORDER:
		if definition.get("layers", {}).get(layer) is Dictionary: result.push_back(layer)
	return result


func _normalize_rule(raw: Variant) -> Dictionary:
	if not raw is Dictionary: return {}
	var id := str(raw.get("id", "")).strip_edges()
	if id.is_empty(): return {}
	var layers: Variant = raw.get("layers")
	if layers is Dictionary and not layers.is_empty():
		var result: Dictionary = raw.duplicate(true)
		if raw.get("verified") != null:
			for layer: String in LAYER_ORDER:
				if result.layers.get(layer) is Dictionary and result.layers[layer].get("verified") == null: result.layers[layer].verified = raw.verified
		return result
	return {"id": id, "name": str(raw.get("name", id)), "incompleteName": raw.get("incompleteName"), "category": str(raw.get("category", "ward")), "layers": {"xiang": {"text": str(raw.get("description", raw.get("name", ""))), "verified": str(raw.get("verified", "unverified"))}}}


func _normalize_fragment(raw: Variant) -> Dictionary:
	if not raw is Dictionary: return {}
	var id := str(raw.get("id", "")).strip_edges(); var rule_id := str(raw.get("ruleId", "")).strip_edges()
	if id.is_empty() or rule_id.is_empty(): return {}
	var layer := str(raw.get("layer", "xiang")); if not LAYER_ORDER.has(layer): layer = "xiang"
	return {"id": id, "text": str(raw.get("text", "")), "ruleId": rule_id, "layer": layer, "source": str(raw.get("source", ""))}
