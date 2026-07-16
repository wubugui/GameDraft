class_name RuntimeRulesPanelUI
extends RuntimeTextPanel

var rules: RuntimeRulesManager
func _init(next_renderer: RuntimeRenderer, data: RuntimeRulesManager, next_strings: RuntimeStringsProvider) -> void: super._init(next_renderer, next_strings); rules = data
func panel_title() -> String: return strings.get_text("rulesPanel", "title")
func refresh() -> void:
	if content == null: return
	title_label.text = panel_title()
	var lines: Array[String] = [strings.get_text("rulesPanel", "mastered")]
	var acquired := rules.get_acquired_rules()
	if acquired.is_empty(): lines.push_back(strings.get_text("rulesPanel", "empty"))
	for acquired_entry: Dictionary in acquired:
		lines.push_back("\n%s" % resolve(str(acquired_entry.def.get("name", acquired_entry.def.id))))
		for layer: String in ["xiang", "li", "shu"]:
			var value: Variant = acquired_entry.def.get("layers", {}).get(layer)
			if value is Dictionary and not str(value.get("text", "")).is_empty(): lines.push_back("「%s」%s" % [strings.get_text("rulesPanel", "layer" + layer.capitalize()), resolve(str(value.text))])
	var discovered := rules.get_discovered_rules()
	lines.push_back("\n" + strings.get_text("rulesPanel", "collecting"))
	for discovered_entry: Dictionary in discovered: lines.push_back("%s (%s/%s)" % [resolve(str(discovered_entry.def.get("incompleteName", strings.get_text("rulesPanel", "unknown")))), discovered_entry.collected, discovered_entry.total])
	content.text = "\n".join(lines)
