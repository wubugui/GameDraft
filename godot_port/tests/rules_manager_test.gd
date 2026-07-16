extends SceneTree


class AssetManagerStub extends RuntimeAssetManager:
	var responses: Array = []
	var load_count := 0

	func load_json(_path: String) -> Variant:
		var response: Variant = responses[load_count] if load_count < responses.size() else null
		load_count += 1
		return response


var events: Array = []


func _init() -> void:
	_run()


func _run() -> void:
	var modern_xiang := {"text": "象"}
	var modern_li := {"text": "理", "verified": "effective"}
	var modern_raw := {"id": " modern ", "name": "现代", "layers": {"xiang": modern_xiang, "li": modern_li}}
	assert(is_same(RuntimeRulesManager.normalize_rule_def(modern_raw), modern_raw))
	var verified_raw := modern_raw.duplicate(false)
	verified_raw.layers = modern_raw.layers
	verified_raw.verified = "false"
	var verified_norm: Dictionary = RuntimeRulesManager.normalize_rule_def(verified_raw)
	assert(not is_same(verified_norm, verified_raw) and not is_same(verified_norm.layers, verified_raw.layers))
	assert(not is_same(verified_norm.layers.xiang, modern_xiang) and verified_norm.layers.xiang.verified == "false")
	assert(is_same(verified_norm.layers.li, modern_li) and not modern_xiang.has("verified"))
	var legacy_norm: Dictionary = RuntimeRulesManager.normalize_rule_def({"id": " legacy ", "name": "旧规", "description": "旧文"})
	assert(legacy_norm.id == "legacy" and legacy_norm.category == "ward" and legacy_norm.layers.xiang.text == "旧文" and legacy_norm.layers.xiang.verified == "unverified")
	assert(RuntimeRulesManager.normalize_rule_def({"id": " "}) == null)
	assert(RuntimeRulesManager.normalize_fragment_def({"id": " frag ", "ruleId": " rule ", "layer": "bad", "text": 7}).layer == "xiang")
	assert(RuntimeRulesManager.normalize_fragment_def({"id": "", "ruleId": "rule"}) == null)

	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var strings := RuntimeStringsProvider.new(); strings.load(assets)
	var bus := RuntimeEventBus.new()
	for event in ["rule:acquired", "rule:layer", "rule:fragment", "notification:show"]:
		bus.on(event, Callable(self, "_record").bind(event))
	var flags := RuntimeFlagStore.new(bus); flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))

	# loadDefs clears rule/fragment maps only after a successful root load, keeps
	# normalized source references, and does not reset absent category/label maps.
	var categories := {"probe": "分类"}
	var labels := {"probe": "标记"}
	var first_rule := {"id": "first", "name": "一", "layers": {"xiang": {"text": "象"}}}
	var second_rule := {"id": "second", "name": "二", "layers": {"xiang": {"text": "象"}}}
	var stub_assets := AssetManagerStub.new()
	stub_assets.responses = [
		{"rules": [first_rule], "fragments": [], "categories": categories, "verifiedLabels": labels},
		{"rules": [second_rule], "fragments": []},
		null,
	]
	var load_probe := RuntimeRulesManager.new(bus, flags)
	load_probe.init({"strings": strings, "assetManager": stub_assets})
	await load_probe.load_defs()
	assert(is_same(load_probe.rule_defs.first, first_rule))
	assert(is_same(load_probe.category_names, categories) and is_same(load_probe.verified_labels, labels))
	await load_probe.load_defs()
	assert(not load_probe.rule_defs.has("first") and is_same(load_probe.rule_defs.second, second_rule))
	assert(is_same(load_probe.category_names, categories) and is_same(load_probe.verified_labels, labels))
	await load_probe.load_defs()
	assert(load_probe.rule_defs.has("second"))
	load_probe.destroy(); load_probe.free()

	var rules := RuntimeRulesManager.new(bus, flags)
	rules.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	await rules.load_defs()
	assert(rules.rule_defs.size() == 8 and rules.fragment_defs.size() == 5)
	assert(rules.get_category_name("taboo") == "禁忌" and rules.get_verified_label("effective") == "有效")
	rules.give_fragment("unknown")

	rules.give_fragment("frag_zombie_fire_01")
	assert(rules.has_fragment("frag_zombie_fire_01") and not rules.has_rule("rule_zombie_fire"))
	assert(rules.is_discovered("rule_zombie_fire") and rules.get_fragment_progress("rule_zombie_fire").collected == 1)
	assert(rules.get_pending_fragments().size() == 1 and rules.get_discovered_rules().size() >= 1)
	assert(rules.get_layer_fragment_progress("rule_zombie_fire").xiang.collected == 1)
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
	assert(not rules.is_discovered("rule_no_answer_name") and rules.get_acquired_rules().size() >= 2)

	var snapshot := rules.serialize()
	var restored := RuntimeRulesManager.new(bus, flags)
	restored.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	await restored.load_defs()
	var old_acquired_fragments := restored.acquired_fragments
	var old_granted_layers := restored.granted_layers
	restored.deserialize(snapshot)
	assert(not is_same(restored.acquired_fragments, old_acquired_fragments))
	assert(not is_same(restored.granted_layers, old_granted_layers))
	assert(restored.has_rule("rule_zombie_fire") and restored.has_rule("rule_no_answer_name"))
	assert(restored.serialize() == snapshot)
	var legacy := RuntimeRulesManager.new(bus, flags)
	legacy.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	await legacy.load_defs()
	legacy.deserialize({"acquiredRules": ["rule_drowned_corpse"]})
	assert(legacy.has_rule("rule_drowned_corpse"))

	var owned_categories := rules.category_names
	var owned_labels := rules.verified_labels
	var owned_strings := rules.strings
	var owned_assets := rules.asset_manager
	for manager in [rules, restored, legacy]:
		manager.destroy(); manager.free()
	assert(not owned_categories.is_empty() and not owned_labels.is_empty() and owned_strings == strings and owned_assets == assets)
	flags.destroy(); bus.clear(); assets.dispose(); stub_assets.dispose()
	print("RulesManager normalize/field/load/layer/save direct-translation test: PASS")
	quit(0)


func _record(payload: Variant, event: String) -> void:
	events.push_back({"event": event, "payload": payload})
