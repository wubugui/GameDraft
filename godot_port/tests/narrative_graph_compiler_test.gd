extends SceneTree

const EXPECTED_IDS := [
	"flow_dock_water_monkey", "npc_ringboy", "quest_return_ring", "scenario_码头官差套近乎",
	"scenario_码头真相", "scenario_外国人捞箱子", "flow_1", "wrapper_graph_1",
	"flow_xungou_main", "wrap_读人_婆子", "wrap_读人_儿子", "wrap_码头选择",
	"wrap_守夜", "wrap_镇尸_撒米", "wrap_镇尸_墨斗", "wrap_镇尸_石子", "wrap_镇尸_剪子",
	"scenario_义庄镇尸", "scenario_背尸", "scenario_听书", "scenario_吹牛", "scenario_婆子家",
	"scenario_河边", "scenario_码头", "scenario_枯井", "scenario_向导", "scenario_送货",
	"scenario_招募", "scenario_终幕", "scenario_梦待死之礼", "wrap_喊名_点二", "wrap_喊名_点三",
	"wrap_喊名_恍然", "wrap_瞎子李算命", "wrap_踩铜板", "wrap_摸橘子", "wrap_叫花子结仇",
	"wrap_偷鸡", "wrap_踢狗", "wrap_踢猫", "wrap_袍哥", "wrap_壮汉", "wrap_街头闲话",
	"flow_背尸_淹尸活", "flow_背尸_零工活", "wrap_验缢死尸", "wrap_背尸守忌讳",
	"wrap_野道变重", "wrap_野道别应", "wrap_野道别回头", "wrap_野道岔路",
]


func _init() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new({}, RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var raw: Variant = assets.load_json("/assets/data/narrative_graphs.json")
	var graphs := RuntimeNarrativeStateManager.compile_narrative_graphs(raw)
	assert(graphs.size() == 51)
	var ids: Array = graphs.map(func(graph: Dictionary) -> String: return graph.id)
	assert(ids == EXPECTED_IDS)
	assert(ids.duplicate().all(func(id: String) -> bool: return ids.count(id) == 1))
	assert(graphs.all(func(graph: Variant) -> bool: return RuntimeNarrativeStateManager._is_narrative_graph(graph)))
	assert(raw.compositions.size() == 5 and raw.signals.size() == 121)

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
	assert(RuntimeNarrativeStateManager.compile_narrative_graphs(synthetic).size() == 3)
	assert(RuntimeNarrativeStateManager.compile_narrative_graphs({"compositions": [], "graphs": [valid]}).is_empty())
	assert(RuntimeNarrativeStateManager.compile_narrative_graphs({"graphs": [valid, {"id": "bad"}, null]}) == [valid])
	assert(RuntimeNarrativeStateManager.compile_narrative_graphs(null).is_empty())

	assets.dispose()
	print("Narrative graph compiler contract test: PASS")
	quit(0)
