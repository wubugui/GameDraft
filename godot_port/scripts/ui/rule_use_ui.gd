class_name RuntimeRuleUseUI
extends RuntimeTextPanel

var event_bus: RuntimeEventBus
var zones: RuntimeZoneSystem
var rules: RuntimeRulesManager
var resolved_slots: Array[Dictionary] = []

func _init(next_renderer: RuntimeRenderer, events: RuntimeEventBus, zone_data: RuntimeZoneSystem, rule_data: RuntimeRulesManager, next_strings: RuntimeStringsProvider) -> void: super._init(next_renderer, next_strings); event_bus = events; zones = zone_data; rules = rule_data
func panel_title() -> String: return strings.get_text("ruleUse", "title")
func open() -> void:
	_resolve_slots()
	if resolved_slots.is_empty(): return
	super.open()
func refresh() -> void:
	if content == null: return
	title_label.text = panel_title(); var lines: Array[String] = []; var actions: Array = []
	for index in resolved_slots.size(): var slot: Dictionary = resolved_slots[index]; var label := "%s%s" % [slot.name, "" if slot.enabled else " (%s)" % slot.progress]; lines.push_back("%s. %s" % [index + 1, label]); actions.push_back({"label": label, "enabled": slot.enabled, "callback": Callable(self, "_select").bind(index)}); content.text = "\n".join(lines)
	set_action_rows(actions)
func debug_select(index: int) -> void:
	_select(index)
func _select(index: int) -> void:
	if index < 0 or index >= resolved_slots.size() or resolved_slots[index].enabled != true: return
	var slot: Dictionary = resolved_slots[index].slot; event_bus.emit("ruleUse:apply", {"ruleId": slot.ruleId, "actions": slot.get("resultActions", []), "resultText": slot.get("resultText")})
func _resolve_slots() -> void:
	resolved_slots.clear()
	for slot: Variant in zones.get_current_rule_slots():
		if not slot is Dictionary: continue
		var definition: Variant = rules.get_rule_def(str(slot.get("ruleId", ""))); if not definition is Dictionary: continue
		var ok := rules.has_rule(str(slot.ruleId)); var required: Variant = slot.get("requiredLayers")
		if required is Array and not required.is_empty(): ok = required.all(func(layer: Variant) -> bool: return rules.has_layer(str(slot.ruleId), str(layer)))
		if ok: resolved_slots.push_back({"slot": slot, "name": resolve(str(definition.name)), "enabled": true, "progress": ""})
		elif rules.is_discovered(str(slot.ruleId)): var p := rules.get_fragment_progress(str(slot.ruleId)); resolved_slots.push_back({"slot": slot, "name": resolve(str(definition.get("incompleteName", strings.get_text("ruleUse", "unknown")))), "enabled": false, "progress": "%s/%s" % [p.collected, p.total]})
