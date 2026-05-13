import json, sys
sys.path.insert(0, 'f:/GameDraft/tools/chronicle_sim')
from tools.chronicle_sim.core.llm.json_extract import parse_json_lenient, parse_json_object

JSON_TEXT = '''
{
  "world_setting": {
    "title": "雾津纪事",
    "logline": "test"
  },
  "design_pillars": [],
  "custom_sections": [],
  "agents": [
    { "id": "guan_ergou", "name": "关二狗", "suggested_tier": "S", "reason": "核心。", "faction_hint": "无", "location_hint": "街头", "personality_tags": [], "secret_tags": ["a"] },
    { "id": "blind_li", "name": "瞎子李", "suggested_tier": "A", "reason": "引路。", "faction_hint": "散人", "location_hint": "茶馆", "personality_tags": [], "secret_tags": ["b"] },
    { "id": "old_braid", "name": "老辫子", "suggested_tier": "A", "reason": "脚帮。", "faction_hint": "脚帮", "location_hint": "驻地", "personality_tags": [], "secret_tags": ["c"] },
    { "id": "teahouse_helmsman", "name": "茶馆舵爷", "suggested_tier": "A", "reason": "头目。", "faction_hint": "袍哥", "location_hint": "茶馆", "personality_tags": [], "secret_tags": ["茶馆即香堂码头", "渗透地方治安", '知晓脚帮与船帮暗斗'] }
  ],
  "factions": [],
  "locations": [],
  "relationships": [],
  "anchor_events": [],
  "social_graph_edges": [],
  "event_type_candidates": []
}
'''

print("=== parse_json_lenient ===")
try:
    result = parse_json_lenient(JSON_TEXT)
    print(f"Result type: {type(result).__name__}")
    if isinstance(result, dict):
        print(f"Dict keys: {list(result.keys())}")
    elif isinstance(result, list):
        print(f"List length: {len(result)}")
        for i, item in enumerate(result):
            print(f"  [{i}] type={type(item).__name__}")
            if isinstance(item, dict):
                print(f"       keys={list(item.keys())[:5]}")
except Exception as e:
    print(f"Exception: {type(e).__name__}: {e}")

print("\n=== parse_json_object ===")
try:
    result = parse_json_object(JSON_TEXT)
    print(f"Result type: {type(result).__name__}")
    print(f"Dict keys: {list(result.keys())}")
except Exception as e:
    print(f"Exception: {type(e).__name__}: {e}")
