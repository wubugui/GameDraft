extends SceneTree

const EXPECTED_IDS := [
	"flow_dock_water_monkey", "npc_ringboy", "quest_return_ring", "flow_1", "wrapper_graph_1",
	"flow_xungou_main", "wrap_读人_婆子", "wrap_读人_儿子", "wrap_脸皮基调", "wrap_码头选择",
	"wrap_守夜", "wrap_镇尸_撒米", "wrap_镇尸_墨斗", "wrap_镇尸_石子", "wrap_镇尸_剪子",
	"scenario_义庄镇尸", "scenario_背尸", "scenario_听书", "scenario_吹牛", "scenario_婆子家",
	"scenario_河边", "scenario_码头", "scenario_枯井", "scenario_向导", "scenario_送货",
	"scenario_招募", "scenario_终幕", "scenario_梦待死之礼", "wrap_喊名_点二", "wrap_喊名_点三",
	"wrap_喊名_恍然", "flow_2", "wrapper_graph_2", "flow_背尸_淹尸活", "flow_背尸_零工活",
]


func _init() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var raw: Variant = assets.load_json("/assets/data/narrative_graphs.json")
	var graphs := RuntimeNarrativeGraphCompiler.compile(raw)
	assert(graphs.size() == 35)
	var ids: Array = graphs.map(func(graph: Dictionary) -> String: return graph.id)
	assert(ids == EXPECTED_IDS)
	assert(ids.duplicate().all(func(id: String) -> bool: return ids.count(id) == 1))
	assert(graphs.all(func(graph: Variant) -> bool: return RuntimeNarrativeGraphCompiler.is_narrative_graph(graph)))
	assert(raw.compositions.size() == 6 and raw.signals.size() == 91)

	var valid := {"id": "g", "initialState": "a", "states": {"a": {"id": "a"}}, "transitions": []}
	var synthetic := {"compositions": [
		{"mainGraph": valid, "elements": [
			{"kind": "wrapperGraph", "graph": valid.duplicate(true)},
			{"kind": "scenarioSubgraph", "graph": valid.duplicate(true)},
			{"kind": "dialogueBlackbox", "graph": valid.duplicate(true)},
			{"kind": "wrapperGraph", "graph": {"id": "invalid"}},
		]},
		null,
	]}
	assert(RuntimeNarrativeGraphCompiler.compile(synthetic).size() == 3)
	assert(RuntimeNarrativeGraphCompiler.compile({"compositions": [], "graphs": [valid]}).is_empty())
	assert(RuntimeNarrativeGraphCompiler.compile({"graphs": [valid, {"id": "bad"}, null]}) == [valid])
	assert(RuntimeNarrativeGraphCompiler.compile(null).is_empty())

	assets.dispose()
	print("Narrative graph compiler contract test: PASS")
	quit(0)
