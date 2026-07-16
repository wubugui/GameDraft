class_name RuntimeEncounterManager
extends RuntimeSystem

const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")

const ENCOUNTERS_URL := "/assets/data/encounters.json"

var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var action_executor: RuntimeActionExecutor
var condition_ctx_factory: Variant = null

var encounter_defs: Dictionary = {}
var current_encounter: Variant = null
var current_options: Array = []
var active := false
var resolving := false

var rule_name_resolver: Variant = null
var resolve_display: Variant = null

var strings: RuntimeStringsProvider = RuntimeStringsProvider.new()
var asset_manager: RuntimeAssetManager


func _init(next_event_bus: RuntimeEventBus, next_flag_store: RuntimeFlagStore, next_action_executor: RuntimeActionExecutor) -> void:
	event_bus = next_event_bus
	flag_store = next_flag_store
	action_executor = next_action_executor


func init(ctx: Dictionary) -> void:
	strings = ctx.strings
	asset_manager = ctx.assetManager


func update(_dt: float) -> void:
	return


func set_condition_eval_context_factory(factory: Variant = null) -> void:
	condition_ctx_factory = factory


func _eval_conditions(conditions: Array) -> bool:
	if conditions.is_empty():
		return true
	var context: Variant = condition_ctx_factory.call() if condition_ctx_factory is Callable and condition_ctx_factory.is_valid() else null
	if context:
		return RuntimeConditionEvalBridge.evaluate_condition_expr_list(conditions, context)
	return flag_store.check_conditions(conditions)


func set_rule_name_resolver(callback: Variant = null) -> void:
	rule_name_resolver = callback


func set_resolve_display(callback: Variant = null) -> void:
	resolve_display = callback


func _r(text: String) -> String:
	return str(resolve_display.call(text)) if resolve_display is Callable and resolve_display.is_valid() else text


func _layer_label(layer: String) -> String:
	if layer == "xiang":
		return strings.get_text("rulesPanel", "layerXiang")
	if layer == "li":
		return strings.get_text("rulesPanel", "layerLi")
	return strings.get_text("rulesPanel", "layerShu")


func load_defs() -> void:
	var definitions: Variant = asset_manager.load_json(ENCOUNTERS_URL) if asset_manager != null else null
	await RuntimeMicrotaskQueueScript.yield_turn()
	if not definitions is Array:
		push_warning("EncounterManager: encounters.json not found")
		return
	for definition: Variant in definitions:
		if not definition is Dictionary:
			push_warning("EncounterManager: encounters.json not found")
			return
		encounter_defs[definition.get("id")] = definition


func has_encounter(encounter_id: String) -> bool:
	return encounter_defs.has(encounter_id)


func start_encounter(encounter_id: String) -> void:
	var definition: Variant = encounter_defs.get(encounter_id)
	if not definition is Dictionary:
		push_warning("EncounterManager: unknown encounter \"%s\"" % encounter_id)
		return
	current_encounter = definition
	active = true
	event_bus.emit("encounter:start", {"encounterId": encounter_id})
	event_bus.emit("encounter:narrative", {"text": _r(str(definition.narrative))})


func generate_options() -> void:
	if not current_encounter is Dictionary:
		return
	current_options = []
	var index := 0
	for option: Dictionary in current_encounter.options:
		var required_rule_id: Variant = option.get("requiredRuleId")
		if required_rule_id:
			var rule_id := str(required_rule_id)
			var rule_acquired: bool = flag_store.get_value("rule_%s_acquired" % rule_id) == true
			var rule_discovered: bool = flag_store.get_value("rule_%s_discovered" % rule_id) == true
			var layer_requirements: Variant = option.get("requiredRuleLayers")
			var needs_layers: bool = layer_requirements is Array and not layer_requirements.is_empty()
			var layers_ok: bool = needs_layers
			if needs_layers:
				for layer: Variant in layer_requirements:
					if flag_store.get_value("rule_%s_%s_done" % [rule_id, layer]) != true:
						layers_ok = false
			var requirement_met: bool = layers_ok if needs_layers else rule_acquired
			if not requirement_met:
				var visible: bool = rule_acquired or rule_discovered
				if not visible:
					continue
				var rule_info: Variant = rule_name_resolver.call(rule_id) if rule_name_resolver is Callable and rule_name_resolver.is_valid() else null
				var raw_incomplete_name: Variant = rule_info.get("incompleteName") if rule_info is Dictionary else null
				var display_name := _r(strings.get_text("encounter", "unknownRule") if raw_incomplete_name == null else str(raw_incomplete_name))
				if needs_layers:
					var labels: Array[String] = []
					for layer: Variant in layer_requirements:
						labels.push_back(_layer_label(str(layer)))
					var joined := "、".join(labels)
					current_options.push_back({
						"index": index,
						"text": "%s (%s)" % [display_name, joined],
						"type": option.type,
						"enabled": false,
						"disableReason": strings.get_text("encounter", "layerInsufficient", {"layers": joined}),
						"consumeItems": option.get("consumeItems"),
						"resultActions": option.resultActions,
						"resultText": _r(str(option.resultText)) if option.get("resultText") else option.get("resultText"),
					})
				else:
					var collected: Variant = flag_store.get_value("rule_%s_fragments_collected" % rule_id)
					if collected == null: collected = 0
					var total: Variant = flag_store.get_value("rule_%s_fragments_total" % rule_id)
					if total == null: total = 0
					current_options.push_back({
						"index": index,
						"text": "%s (%s/%s)" % [display_name, collected, total],
						"type": option.type,
						"enabled": false,
						"disableReason": strings.get_text("encounter", "fragmentInsufficient", {"collected": collected, "total": total}),
						"consumeItems": option.get("consumeItems"),
						"resultActions": option.resultActions,
						"resultText": _r(str(option.resultText)) if option.get("resultText") else option.get("resultText"),
					})
				index += 1
				continue

		var conditions: Variant = option.get("conditions")
		if conditions is Array and not conditions.is_empty() and not _eval_conditions(conditions):
			continue
		var enabled := true
		var disable_reason: Variant = null
		var consume_items: Variant = option.get("consumeItems")
		if consume_items:
			for requirement: Dictionary in consume_items:
				var count: Variant = flag_store.get_value("item_count_%s" % requirement.id)
				if count == null: count = 0
				if float(count) < float(requirement.count):
					enabled = false
					disable_reason = strings.get_text("encounter", "itemInsufficient")
					break
		current_options.push_back({
			"index": index,
			"text": _r(str(option.text)),
			"type": option.type,
			"enabled": enabled,
			"disableReason": disable_reason,
			"consumeItems": option.get("consumeItems"),
			"resultActions": option.resultActions,
			"resultText": _r(str(option.resultText)) if option.get("resultText") else option.get("resultText"),
		})
		index += 1

	if current_options.is_empty():
		push_error("EncounterManager: encounter \"%s\" 过滤后选项集为空，自动收束（检查各选项 conditions / requiredRuleId 配置）" % current_encounter.id)
		end_encounter()
		return
	event_bus.emit("encounter:options", {"options": current_options})


func choose_option(index: int) -> Variant:
	if resolving or not active:
		return
	var option: Variant = current_options[index] if index >= 0 and index < current_options.size() else null
	if not option is Dictionary or not option.get("enabled"):
		return
	resolving = true
	current_options = []
	var failed := false
	var consume_items: Variant = option.get("consumeItems")
	if consume_items:
		for requirement: Dictionary in consume_items:
			var result: Variant = await action_executor.execute_await({
				"type": "removeItem",
				"params": {"id": requirement.id, "count": requirement.count},
			})
			if result is bool and result == false:
				failed = true
				break
	if not failed:
		var result_actions: Variant = option.get("resultActions")
		if result_actions is Array and not result_actions.is_empty():
			var result: Variant = await action_executor.execute_batch_await(result_actions)
			if result is bool and result == false:
				push_warning("EncounterManager: resultActions failed")
		if option.get("resultText"):
			event_bus.emit("encounter:result", {"text": _r(str(option.resultText))})
		else:
			end_encounter()
	resolving = false
	return false if failed else null


func end_encounter() -> void:
	if not active:
		return
	active = false
	current_encounter = null
	current_options = []
	event_bus.emit("encounter:end", {})


func is_active() -> bool:
	return active


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	return


func destroy() -> void:
	current_encounter = null
	current_options = []
	active = false
	encounter_defs.clear()
