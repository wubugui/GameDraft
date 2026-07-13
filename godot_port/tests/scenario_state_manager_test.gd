extends SceneTree

var events: Array = []


func _init() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var bus := RuntimeEventBus.new()
	bus.on("notification:show", Callable(self, "_record"))
	var flags := RuntimeFlagStore.new(bus)
	flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	var scenarios := RuntimeScenarioStateManager.new(bus, flags)
	scenarios.init({"eventBus": bus, "flagStore": flags, "strings": null, "assetManager": assets})
	assert(scenarios.load_catalog() and scenarios.catalog_count() == 2)
	assert(scenarios.get_catalog_scenario_ids() == ["码头水鬼", "外国人捞箱子"])
	assert(scenarios.has_manual_line_lifecycle("码头水鬼"))
	assert(scenarios.get_line_lifecycle_state("码头水鬼") == "inactive")
	assert(not scenarios.set_scenario_phase("码头水鬼", "看板初读", {"status": "done"}))
	assert(events[-1].payload.type == "error")
	assert(scenarios.activate_scenario_line("码头水鬼"))
	assert(not scenarios.set_scenario_phase("码头水鬼", "官差已套近乎", {"status": "active"}))
	assert(scenarios.phase_status_equals("码头水鬼", "官差已套近乎", "pending"))
	assert(scenarios.set_scenario_phase("码头水鬼", "看板初读", {"status": " done ", "outcome": "read"}))
	assert(scenarios.get_scenario_phase("码头水鬼", "看板初读") == {"status": "done", "outcome": "read"})
	assert(scenarios.set_scenario_phase("码头水鬼", "看板初读", {"status": "done"}))
	assert(scenarios.get_scenario_phase("码头水鬼", "看板初读").outcome == "read")
	assert(scenarios.set_scenario_phase("码头水鬼", "官差已套近乎", {"status": "active"}))
	assert(scenarios.set_scenario_phase("码头水鬼", "真相揭示", {"status": "done"}))
	assert(flags.get_value("码头水鬼真相已揭示") == true)
	assert(scenarios.complete_scenario_line("码头水鬼"))
	assert(scenarios.get_line_lifecycle_state("码头水鬼") == "completed")
	assert(not scenarios.set_scenario_phase("码头水鬼", "询问官差", {"status": "done"}))
	assert(not scenarios.activate_scenario_line("码头水鬼"))

	# Synthetic catalog covers nested requires, entry guard and typed exposes.
	var synthetic := {"scenarios": [
		{"id": "auto", "phases": {
			"base": {},
			"branch": {"requires": {"all": ["base", {"not": "never"}]}},
			"finish": {},
		}, "exposeAfterPhase": "finish", "exposes": {
			"player_health": "12.5", "current_smell": 7, "heard_teahouse_story": "1",
		}},
		{"id": "blocked", "requires": {"any": ["gate"]}, "phases": {"gate": {}}},
	]}
	scenarios.configure_runtime(flags, synthetic, bus)
	assert(scenarios.set_scenario_phase("auto", "base", {"status": "done"}))
	assert(scenarios.set_scenario_phase("auto", "branch", {"status": "active"}))
	assert(scenarios.check_prerequisites("auto", ["base"]))
	assert(scenarios.set_scenario_phase("auto", "finish", {"status": "done"}))
	assert(flags.get_value("player_health") == 12.5)
	assert(flags.get_value("current_smell") == "7")
	assert(flags.get_value("heard_teahouse_story") == true)
	assert(not scenarios.assert_scenario_line_entry_for_action("blocked"))
	assert(scenarios.get_scenario_phase("blocked", "gate") == null)

	var snapshot := scenarios.serialize()
	var restored := RuntimeScenarioStateManager.new(bus, flags)
	restored.configure_runtime(flags, synthetic, bus)
	restored.deserialize(snapshot)
	assert(restored.serialize() == snapshot)
	restored.deserialize({
		"scenarios": {"ok": {"p": {"status": "done", "outcome": 3}}, "bad": {"p": {"status": 2}}},
		"lineLifecycle": {"a": "active", "b": "completed", "c": "inactive", "d": "bad"},
	})
	assert(restored.get_scenario_phase("ok", "p") == {"status": "done", "outcome": 3})
	assert(restored.get_scenario_phase("bad", "p") == null)
	assert(restored.get_line_lifecycle_state("a") == "active")
	assert(restored.get_line_lifecycle_state("b") == "completed")
	assert(restored.get_line_lifecycle_state("c") == "inactive")

	scenarios.destroy(); scenarios.free()
	restored.destroy(); restored.free()
	flags.destroy(); bus.clear(); assets.dispose()
	print("ScenarioStateManager contract test: PASS")
	quit(0)


func _record(payload: Variant) -> void:
	events.push_back({"payload": payload})
