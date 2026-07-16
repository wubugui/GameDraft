class_name RuntimeRulesManager
extends RuntimeSystem

const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")

const RULES_URL := "/assets/data/rules.json"
const LAYER_ORDER := ["xiang", "li", "shu"]


static func normalize_rule_def(raw: Dictionary) -> Variant:
	var id := ("" if raw.get("id") == null else str(raw.id)).strip_edges()
	if id.is_empty():
		return null
	var layers_unknown: Variant = raw.get("layers")
	if layers_unknown is Dictionary and not layers_unknown.is_empty():
		var definition: Dictionary = raw
		var rule_verified: Variant = raw.get("verified")
		if rule_verified:
			var new_layers := {}
			for layer: String in LAYER_ORDER:
				var layer_definition: Variant = definition.layers.get(layer)
				if layer_definition:
					if layer_definition.get("verified"):
						new_layers[layer] = layer_definition
					else:
						var next_layer: Dictionary = layer_definition.duplicate(false)
						next_layer.verified = rule_verified
						new_layers[layer] = next_layer
			var result: Dictionary = definition.duplicate(false)
			result.layers = new_layers
			return result
		return definition
	var legacy_verified: Variant = raw.get("verified")
	if legacy_verified == null:
		legacy_verified = "unverified"
	var raw_name: Variant = raw.get("name")
	var name: String = id if raw_name == null else str(raw_name)
	var raw_incomplete_name: Variant = raw.get("incompleteName")
	var raw_category: Variant = raw.get("category")
	var raw_description: Variant = raw.get("description")
	if raw_description == null:
		raw_description = raw_name
	return {
		"id": id,
		"name": name,
		"incompleteName": null if raw_incomplete_name == null else str(raw_incomplete_name),
		"category": "ward" if raw_category == null else raw_category,
		"layers": {
			"xiang": {
				"text": "" if raw_description == null else str(raw_description),
				"verified": legacy_verified,
			},
		},
	}


static func normalize_fragment_def(raw: Dictionary) -> Variant:
	var id := ("" if raw.get("id") == null else str(raw.id)).strip_edges()
	if id.is_empty():
		return null
	var rule_id := ("" if raw.get("ruleId") == null else str(raw.ruleId)).strip_edges()
	if rule_id.is_empty():
		return null
	var layer_raw: Variant = raw.get("layer")
	var layer := "xiang" if layer_raw == null else str(layer_raw)
	if not LAYER_ORDER.has(layer):
		layer = "xiang"
	return {
		"id": id,
		"text": "" if raw.get("text") == null else str(raw.text),
		"ruleId": rule_id,
		"layer": layer,
		"source": "" if raw.get("source") == null else str(raw.source),
	}


var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore

var rule_defs: Dictionary = {}
var fragment_defs: Dictionary = {}
var category_names: Dictionary = {}
var verified_labels: Dictionary = {}

var acquired_fragments: Dictionary = {}
var granted_layers: Dictionary = {}

var strings: RuntimeStringsProvider = RuntimeStringsProvider.new()
var asset_manager: RuntimeAssetManager


func _init(next_event_bus: RuntimeEventBus, next_flag_store: RuntimeFlagStore) -> void:
	event_bus = next_event_bus
	flag_store = next_flag_store


func init(ctx: Dictionary) -> void:
	strings = ctx.strings
	asset_manager = ctx.assetManager


func update(_dt: float) -> void:
	return


static func _defined_layers(definition: Dictionary) -> Array[String]:
	var result: Array[String] = []
	var layers: Variant = definition.get("layers")
	if not layers is Dictionary:
		return result
	for layer: String in LAYER_ORDER:
		if layers.get(layer) != null:
			result.push_back(layer)
	return result


func _layer_done_flag_key(rule_id: String, layer: String) -> String:
	return "rule_%s_%s_done" % [rule_id, layer]


func _snapshot_layer_done(rule_id: String) -> Dictionary:
	var result := {}
	var definition: Variant = rule_defs.get(rule_id)
	if not definition is Dictionary:
		return result
	for layer: String in _defined_layers(definition):
		result[layer] = _has_layer_impl(rule_id, layer)
	return result


func _has_layer_impl(rule_id: String, layer: String) -> bool:
	var definition: Variant = rule_defs.get(rule_id)
	if not definition is Dictionary:
		return false
	var layers: Variant = definition.get("layers")
	if not layers is Dictionary or not layers.get(layer):
		return false
	var granted: Variant = granted_layers.get(rule_id)
	if granted is Dictionary and granted.has(layer):
		return true
	var fragments: Array = []
	for fragment: Dictionary in fragment_defs.values():
		if fragment.ruleId == rule_id and fragment.layer == layer:
			fragments.push_back(fragment)
	if fragments.is_empty():
		return false
	return fragments.all(func(fragment: Dictionary) -> bool: return acquired_fragments.has(fragment.id))


func _has_rule_internal(rule_id: String) -> bool:
	var definition: Variant = rule_defs.get(rule_id)
	if not definition is Dictionary:
		return false
	var keys := _defined_layers(definition)
	if keys.is_empty():
		return false
	return keys.all(func(layer: String) -> bool: return _has_layer_impl(rule_id, layer))


func load_defs() -> void:
	var data: Variant = asset_manager.load_json(RULES_URL) if asset_manager != null else null
	await RuntimeMicrotaskQueueScript.yield_turn()
	if not data is Dictionary:
		push_warning("RulesManager: rules.json not found, running without rule definitions")
		return
	rule_defs.clear()
	fragment_defs.clear()
	var raw_rules: Variant = data.get("rules")
	if raw_rules == null:
		raw_rules = []
	if not raw_rules is Array:
		push_warning("RulesManager: rules.json not found, running without rule definitions")
		return
	for raw: Variant in raw_rules:
		if not raw is Dictionary:
			push_warning("RulesManager: rules.json not found, running without rule definitions")
			return
		var definition: Variant = normalize_rule_def(raw)
		if definition != null:
			rule_defs[definition.id] = definition
	var raw_fragments: Variant = data.get("fragments")
	if raw_fragments == null:
		raw_fragments = []
	if not raw_fragments is Array:
		push_warning("RulesManager: rules.json not found, running without rule definitions")
		return
	for raw: Variant in raw_fragments:
		if not raw is Dictionary:
			push_warning("RulesManager: rules.json not found, running without rule definitions")
			return
		var definition: Variant = normalize_fragment_def(raw)
		if definition != null:
			fragment_defs[definition.id] = definition
	var categories: Variant = data.get("categories")
	if categories != null:
		category_names = categories
	var labels: Variant = data.get("verifiedLabels")
	if labels != null:
		verified_labels = labels


func _emit_rule_acquired(rule_id: String) -> void:
	var definition: Variant = rule_defs.get(rule_id)
	var raw_name: Variant = definition.get("name") if definition is Dictionary else null
	var name: Variant = rule_id if raw_name == null else raw_name
	event_bus.emit("rule:acquired", {"ruleId": rule_id, "name": name})
	event_bus.emit("notification:show", {
		"text": strings.get_text("notifications", "ruleAcquired", {"name": name}),
		"type": "rule",
	})


func give_rule(rule_id: String) -> void:
	if _has_rule_internal(rule_id):
		return
	var definition: Variant = rule_defs.get(rule_id)
	if not definition is Dictionary:
		return
	var keys := _defined_layers(definition)
	if keys.is_empty():
		return
	var granted: Variant = granted_layers.get(rule_id)
	if not granted is Dictionary:
		granted = {}
	for layer: String in keys:
		granted[layer] = true
	granted_layers[rule_id] = granted
	_sync_rule_flags(rule_id)
	_emit_rule_acquired(rule_id)


func grant_layer(rule_id: String, layer: String) -> void:
	var definition: Variant = rule_defs.get(rule_id)
	if not definition is Dictionary:
		return
	var layers: Variant = definition.get("layers")
	if not layers is Dictionary or not layers.get(layer):
		return
	if _has_layer_impl(rule_id, layer):
		return
	var before_full := _has_rule_internal(rule_id)
	var granted: Variant = granted_layers.get(rule_id)
	if not granted is Dictionary:
		granted = {}
	granted[layer] = true
	granted_layers[rule_id] = granted
	_sync_rule_flags(rule_id)
	event_bus.emit("rule:layer", {"ruleId": rule_id, "layer": layer, "source": "grant"})
	if not before_full and _has_rule_internal(rule_id):
		_emit_rule_acquired(rule_id)


func give_fragment(fragment_id: String) -> void:
	if acquired_fragments.has(fragment_id):
		return
	var fragment: Variant = fragment_defs.get(fragment_id)
	if not fragment is Dictionary:
		push_warning("RulesManager: unknown fragment \"%s\"" % fragment_id)
		return
	var rule_id := str(fragment.ruleId)
	var before_rule_full := _has_rule_internal(rule_id)
	var before_layers := _snapshot_layer_done(rule_id)
	acquired_fragments[fragment_id] = true
	flag_store.set_value("fragment_%s_acquired" % fragment_id, true)
	_sync_rule_flags(rule_id)
	var after_layers := _snapshot_layer_done(rule_id)
	for layer: String in LAYER_ORDER:
		if after_layers.get(layer) == true and before_layers.get(layer) != true:
			event_bus.emit("rule:layer", {"ruleId": rule_id, "layer": layer, "source": "fragment"})
	event_bus.emit("rule:fragment", {"fragmentId": fragment_id, "ruleId": rule_id})
	event_bus.emit("notification:show", {"text": strings.get_text("notifications", "fragmentAcquired"), "type": "rule"})
	_try_auto_synthesize(rule_id, before_rule_full)


func _sync_rule_flags(rule_id: String) -> void:
	var definition: Variant = rule_defs.get(rule_id)
	if not definition is Dictionary:
		return
	var fragments: Array = []
	for fragment: Dictionary in fragment_defs.values():
		if fragment.ruleId == rule_id:
			fragments.push_back(fragment)
	var collected := fragments.filter(func(fragment: Dictionary) -> bool: return acquired_fragments.has(fragment.id)).size()
	var total := fragments.size()
	flag_store.set_value("rule_%s_fragments_collected" % rule_id, float(collected))
	flag_store.set_value("rule_%s_fragments_total" % rule_id, float(total))
	for layer: String in _defined_layers(definition):
		flag_store.set_value(_layer_done_flag_key(rule_id, layer), _has_layer_impl(rule_id, layer))
	var full := _has_rule_internal(rule_id)
	flag_store.set_value("rule_%s_acquired" % rule_id, full)
	var granted: Variant = granted_layers.get(rule_id)
	var granted_size: int = granted.size() if granted is Dictionary else 0
	var any_progress: bool = collected > 0 or granted_size > 0
	if any_progress and not full:
		flag_store.set_value("rule_%s_discovered" % rule_id, true)


func _resync_all_rule_flags() -> void:
	for fragment: Dictionary in fragment_defs.values():
		if acquired_fragments.has(fragment.id):
			flag_store.set_value("fragment_%s_acquired" % fragment.id, true)
	for rule_id: Variant in rule_defs:
		_sync_rule_flags(str(rule_id))


func _try_auto_synthesize(rule_id: String, before_rule_full: bool) -> void:
	var progress := get_fragment_progress(rule_id)
	if progress.total == 0:
		return
	if progress.collected < progress.total:
		return
	var definition: Variant = rule_defs.get(rule_id)
	if not definition is Dictionary:
		return
	if not _has_rule_internal(rule_id):
		give_rule(rule_id)
		event_bus.emit("notification:show", {
			"text": strings.get_text("notifications", "fragmentSynthesized", {"name": definition.name}),
			"type": "rule",
		})
		return
	if not before_rule_full:
		_emit_rule_acquired(rule_id)
		event_bus.emit("notification:show", {
			"text": strings.get_text("notifications", "fragmentSynthesized", {"name": definition.name}),
			"type": "rule",
		})


func has_rule(rule_id: String) -> bool:
	return _has_rule_internal(rule_id)


func has_layer(rule_id: String, layer: String) -> bool:
	return _has_layer_impl(rule_id, layer)


func has_fragment(fragment_id: String) -> bool:
	return acquired_fragments.has(fragment_id)


func get_rule_def(rule_id: String) -> Variant:
	return rule_defs.get(rule_id)


func get_category_name(key: String) -> String:
	var value: Variant = category_names.get(key)
	return key if value == null else str(value)


func get_verified_label(key: String) -> String:
	var value: Variant = verified_labels.get(key)
	return key if value == null else str(value)


func is_discovered(rule_id: String) -> bool:
	if _has_rule_internal(rule_id):
		return false
	var fragment_hit := false
	for fragment_id: Variant in acquired_fragments:
		var fragment: Variant = fragment_defs.get(fragment_id)
		if fragment is Dictionary and fragment.ruleId == rule_id:
			fragment_hit = true
	if fragment_hit:
		return true
	var granted: Variant = granted_layers.get(rule_id)
	return granted is Dictionary and granted.size() > 0


func get_discovered_rules() -> Array:
	var result: Array = []
	for definition: Dictionary in rule_defs.values():
		if _has_rule_internal(definition.id):
			continue
		if not is_discovered(definition.id):
			continue
		var progress := get_fragment_progress(definition.id)
		result.push_back({"def": definition, "collected": progress.collected, "total": progress.total})
	return result


func get_acquired_rules() -> Array:
	var result: Array = []
	for definition: Dictionary in rule_defs.values():
		if _has_rule_internal(definition.id):
			result.push_back({"def": definition, "acquired": true})
	return result


func get_fragment_progress(rule_id: String) -> Dictionary:
	var fragments: Array = []
	var collected := 0
	for fragment: Dictionary in fragment_defs.values():
		if fragment.ruleId == rule_id:
			fragments.push_back(fragment)
			if acquired_fragments.has(fragment.id):
				collected += 1
	return {"collected": collected, "total": fragments.size(), "fragments": fragments}


func get_rule_depth(rule_id: String) -> Dictionary:
	var definition: Variant = rule_defs.get(rule_id)
	if not definition is Dictionary:
		return {"unlocked": 0, "total": 0}
	var keys := _defined_layers(definition)
	var unlocked := 0
	for layer: String in keys:
		if _has_layer_impl(rule_id, layer):
			unlocked += 1
	return {"unlocked": unlocked, "total": keys.size()}


func get_unlocked_layer_texts(rule_id: String) -> Dictionary:
	var definition: Variant = rule_defs.get(rule_id)
	if not definition is Dictionary:
		return {}
	var result := {}
	for layer: String in _defined_layers(definition):
		if _has_layer_impl(rule_id, layer):
			var text: Variant = definition.layers[layer].get("text")
			if text:
				result[layer] = text
	return result


func get_layer_fragment_progress(rule_id: String) -> Dictionary:
	var definition: Variant = rule_defs.get(rule_id)
	if not definition is Dictionary:
		return {}
	var result := {}
	for layer: String in _defined_layers(definition):
		var fragments: Array = []
		for fragment: Dictionary in fragment_defs.values():
			if fragment.ruleId == rule_id and fragment.layer == layer:
				fragments.push_back(fragment)
		var collected := 0
		for fragment: Dictionary in fragments:
			if acquired_fragments.has(fragment.id):
				collected += 1
		result[layer] = {"collected": collected, "total": fragments.size(), "fragments": fragments}
	return result


func get_pending_fragments() -> Array:
	var result: Array = []
	for fragment_id: Variant in acquired_fragments:
		var fragment: Variant = fragment_defs.get(fragment_id)
		if fragment is Dictionary and not _has_rule_internal(fragment.ruleId):
			result.push_back(fragment)
	return result


func serialize() -> Dictionary:
	var granted := {}
	for raw_rule_id: Variant in granted_layers:
		var rule_id := str(raw_rule_id)
		var set: Variant = granted_layers[raw_rule_id]
		if set is Dictionary and set.size() > 0:
			var layers: Array = []
			for layer: String in LAYER_ORDER:
				if set.has(layer):
					layers.push_back(layer)
			granted[rule_id] = layers
	return {"acquiredFragments": acquired_fragments.keys(), "grantedLayers": granted}


func deserialize(data: Dictionary) -> void:
	acquired_fragments = {}
	var raw_acquired: Variant = data.get("acquiredFragments")
	if raw_acquired == null:
		raw_acquired = []
	for fragment_id: Variant in raw_acquired:
		acquired_fragments[str(fragment_id)] = true
	granted_layers = {}
	var raw_granted: Variant = data.get("grantedLayers")
	if raw_granted == null:
		raw_granted = {}
	if raw_granted is Dictionary:
		for raw_rule_id: Variant in raw_granted:
			var rule_id := str(raw_rule_id)
			var set := {}
			var raw_layers: Variant = raw_granted[raw_rule_id]
			if raw_layers == null:
				raw_layers = []
			for layer: Variant in raw_layers:
				if LAYER_ORDER.has(layer):
					set[layer] = true
			granted_layers[rule_id] = set
	var legacy_rules: Variant = data.get("acquiredRules")
	if legacy_rules == null:
		legacy_rules = []
	for rule_id: Variant in legacy_rules:
		var id := str(rule_id)
		var definition: Variant = rule_defs.get(id)
		if not definition is Dictionary:
			continue
		var set: Variant = granted_layers.get(id)
		if not set is Dictionary:
			set = {}
		for layer: String in _defined_layers(definition):
			set[layer] = true
		granted_layers[id] = set
	_resync_all_rule_flags()


func destroy() -> void:
	acquired_fragments.clear()
	granted_layers.clear()
	rule_defs.clear()
	fragment_defs.clear()
