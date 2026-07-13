extends SceneTree

var events: Array = []


func _init() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var strings := RuntimeStringsProvider.new(); assert(strings.load(assets))
	var bus := RuntimeEventBus.new()
	for event in ["rule:acquired", "rule:layer", "rule:fragment", "notification:show"]: bus.on(event, Callable(self, "_record").bind(event))
	var flags := RuntimeFlagStore.new(bus); flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	var rules := RuntimeRulesManager.new(bus, flags)
	rules.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	assert(rules.load_defs() and rules.definition_counts() == {"rules": 8, "fragments": 5})
	assert(rules.get_category_name("taboo") == "禁忌" and rules.get_verified_label("effective") == "有效")

	rules.give_fragment("frag_zombie_fire_01")
	assert(rules.has_fragment("frag_zombie_fire_01") and not rules.has_rule("rule_zombie_fire"))
	assert(rules.is_discovered("rule_zombie_fire") and rules.get_fragment_progress("rule_zombie_fire").collected == 1)
	assert(flags.get_value("rule_rule_zombie_fire_fragments_collected") == 1.0)
	rules.give_fragment("frag_zombie_fire_02")
	assert(rules.has_rule("rule_zombie_fire") and rules.has_layer("rule_zombie_fire", "xiang"))
	assert(flags.get_value("rule_rule_zombie_fire_acquired") == true)
	assert(events.any(func(entry: Dictionary) -> bool: return entry.event == "rule:acquired" and entry.payload.ruleId == "rule_zombie_fire"))
	var event_count := events.size(); rules.give_fragment("frag_zombie_fire_02"); assert(events.size() == event_count)

	rules.grant_layer("rule_no_answer_name", "li")
	assert(rules.has_layer("rule_no_answer_name", "li") and not rules.has_rule("rule_no_answer_name"))
	assert(rules.get_rule_depth("rule_no_answer_name") == {"unlocked": 1, "total": 2})
	rules.give_rule("rule_no_answer_name")
	assert(rules.has_rule("rule_no_answer_name") and rules.get_unlocked_layer_texts("rule_no_answer_name").size() == 2)
	assert(not rules.is_discovered("rule_no_answer_name"))

	var snapshot := rules.serialize()
	var restored := RuntimeRulesManager.new(bus, flags)
	restored.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	assert(restored.load_defs())
	restored.deserialize(snapshot)
	assert(restored.has_rule("rule_zombie_fire") and restored.has_rule("rule_no_answer_name"))
	assert(restored.serialize() == snapshot)
	var legacy := RuntimeRulesManager.new(bus, flags)
	legacy.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets}); assert(legacy.load_defs())
	legacy.deserialize({"acquiredRules": ["rule_drowned_corpse"]})
	assert(legacy.has_rule("rule_drowned_corpse"))

	for manager in [rules, restored, legacy]: manager.destroy(); manager.free()
	flags.destroy(); bus.clear(); assets.dispose()
	print("RulesManager contract test: PASS")
	quit(0)


func _record(payload: Variant, event: String) -> void: events.push_back({"event": event, "payload": payload})
