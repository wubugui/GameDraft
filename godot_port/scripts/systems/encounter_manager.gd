class_name RuntimeEncounterManager
extends RuntimeSystem

const ENCOUNTERS_URL := "/assets/data/encounters.json"
const RULE_LAYERS := ["xiang", "li", "shu"]

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var strings: RuntimeStringsProvider
var asset_manager: RuntimeAssetManager
var encounter_defs: Dictionary = {}
var current_encounter: Variant = null
var current_options: Array = []
var active := false
var resolving := false
var _condition_context_factory := Callable()
var _rule_name_resolver := Callable()
var _resolve_display := Callable()


func _init(events: RuntimeEventBus, flags: RuntimeFlagStore, actions: RuntimeActionExecutor) -> void: event_bus = events; flag_store = flags; action_executor = actions
func init(ctx: Dictionary) -> void: strings = ctx.strings; asset_manager = ctx.assetManager
func set_condition_eval_context_factory(factory: Callable = Callable()) -> void: _condition_context_factory = factory
func set_rule_name_resolver(callback: Callable = Callable()) -> void: _rule_name_resolver = callback
func set_resolve_display(callback: Callable = Callable()) -> void: _resolve_display = callback
func is_active() -> bool: return active
func is_resolving() -> bool: return resolving
func has_encounter(id: String) -> bool: return encounter_defs.has(id.strip_edges())
func get_current_options() -> Array: return current_options.duplicate(true)


func load_defs() -> bool:
	var raw: Variant = asset_manager.load_json(ENCOUNTERS_URL)
	if not raw is Array: return false
	encounter_defs.clear()
	for definition: Variant in raw:
		if definition is Dictionary and not str(definition.get("id", "")).strip_edges().is_empty(): encounter_defs[str(definition.id).strip_edges()] = definition.duplicate(true)
	return not encounter_defs.is_empty()


func start_encounter(id: String) -> bool:
	var definition: Variant = encounter_defs.get(id.strip_edges())
	if not definition is Dictionary: return false
	current_encounter = definition; current_options.clear(); active = true; resolving = false
	event_bus.emit("encounter:start", {"encounterId": str(definition.id)}); event_bus.emit("encounter:narrative", {"text": _r(str(definition.get("narrative", "")))})
	return true


func generate_options() -> void:
	if not current_encounter is Dictionary or not active: return
	current_options.clear(); var visible_index := 0
	for raw: Variant in current_encounter.get("options", []):
		if not raw is Dictionary: continue
		var option: Dictionary = raw; var rule_id := str(option.get("requiredRuleId", "")).strip_edges()
		if not rule_id.is_empty():
			var acquired: bool = flag_store.get_value("rule_%s_acquired" % rule_id) == true
			var discovered: bool = flag_store.get_value("rule_%s_discovered" % rule_id) == true
			var layer_req: Variant = option.get("requiredRuleLayers")
			var needs_layers: bool = layer_req is Array and not layer_req.is_empty()
			var layers_ok: bool = needs_layers
			if needs_layers:
				for layer: Variant in layer_req:
					if str(layer) not in RULE_LAYERS or flag_store.get_value("rule_%s_%s_done" % [rule_id, layer]) != true: layers_ok = false
			var requirement_met: bool = layers_ok if needs_layers else acquired
			if not requirement_met:
				if not acquired and not discovered: continue
				var info: Variant = _rule_name_resolver.call(rule_id) if not _rule_name_resolver.is_null() and _rule_name_resolver.is_valid() else null
				var display_name: String = _r(str(info.get("incompleteName", strings.get_text("encounter", "unknownRule"))) if info is Dictionary else strings.get_text("encounter", "unknownRule"))
				var reason := ""
				if needs_layers:
					var labels: Array[String] = []
					for layer: Variant in layer_req: labels.push_back(_layer_label(str(layer)))
					var joined := "、".join(labels); display_name += " (%s)" % joined; reason = strings.get_text("encounter", "layerInsufficient", {"layers": joined})
				else:
					var collected := int(flag_store.get_value("rule_%s_fragments_collected" % rule_id) if flag_store.get_value("rule_%s_fragments_collected" % rule_id) != null else 0); var total := int(flag_store.get_value("rule_%s_fragments_total" % rule_id) if flag_store.get_value("rule_%s_fragments_total" % rule_id) != null else 0); display_name += " (%s/%s)" % [collected, total]; reason = strings.get_text("encounter", "fragmentInsufficient", {"collected": collected, "total": total})
				current_options.push_back(_resolved_option(option, visible_index, display_name, false, reason)); visible_index += 1; continue
		if not _evaluate_conditions(option.get("conditions", [])): continue
		var enabled := true; var disable_reason: Variant = null
		for requirement: Variant in option.get("consumeItems", []):
			if requirement is Dictionary and int(flag_store.get_value("item_count_%s" % requirement.get("id")) if flag_store.get_value("item_count_%s" % requirement.get("id")) != null else 0) < int(requirement.get("count", 0)): enabled = false; disable_reason = strings.get_text("encounter", "itemInsufficient"); break
		current_options.push_back(_resolved_option(option, visible_index, _r(str(option.get("text", ""))), enabled, disable_reason)); visible_index += 1
	if current_options.is_empty(): end_encounter(); return
	event_bus.emit("encounter:options", {"options": current_options.duplicate(true)})


func choose_option(index: int) -> bool:
	if resolving or not active or index < 0 or index >= current_options.size(): return false
	var option: Dictionary = current_options[index]
	if option.get("enabled") != true: return false
	resolving = true; current_options.clear()
	for requirement: Variant in option.get("consumeItems", []):
		if requirement is Dictionary: await action_executor.execute_await({"type": "removeItem", "params": {"id": requirement.get("id"), "count": requirement.get("count")}})
	await action_executor.execute_batch_await(option.get("resultActions", []))
	if not str(option.get("resultText", "")).is_empty(): event_bus.emit("encounter:result", {"text": _r(str(option.resultText))})
	else: end_encounter()
	resolving = false; return true


func end_encounter() -> void:
	if not active: return
	active = false; resolving = false; current_encounter = null; current_options.clear(); event_bus.emit("encounter:end", {})


func serialize() -> Dictionary: return {}
func deserialize(_data: Dictionary) -> void: return
func destroy() -> void: current_encounter = null; current_options.clear(); encounter_defs.clear(); active = false; resolving = false; _condition_context_factory = Callable(); _rule_name_resolver = Callable(); _resolve_display = Callable()


func _evaluate_conditions(raw: Variant) -> bool:
	if not raw is Array or raw.is_empty(): return true
	if not _condition_context_factory.is_null() and _condition_context_factory.is_valid(): return RuntimeConditionEvaluator.new().evaluate_list(raw, _condition_context_factory.call())
	return flag_store.check_conditions(raw)
func _resolved_option(option: Dictionary, index: int, text: String, enabled: bool, reason: Variant) -> Dictionary: return {"index": index, "text": text, "type": str(option.get("type", "general")), "enabled": enabled, "disableReason": reason, "consumeItems": option.get("consumeItems", []).duplicate(true), "resultActions": option.get("resultActions", []).duplicate(true), "resultText": _r(str(option.get("resultText", ""))) if option.has("resultText") else null}
func _layer_label(layer: String) -> String: return strings.get_text("rulesPanel", "layerXiang" if layer == "xiang" else ("layerLi" if layer == "li" else "layerShu"))
func _r(text: String) -> String: return str(_resolve_display.call(text)) if not _resolve_display.is_null() and _resolve_display.is_valid() else text
