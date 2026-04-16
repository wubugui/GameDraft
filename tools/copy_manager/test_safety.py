"""Safety test suite for exporters."""
from tools.copy_manager.exporters.json_exporter import _set_value_safe, _parse_field_path
from tools.copy_manager.exporters.backfiller import _set_json_value_safe

print("=== Safety Test Suite ===")
print()

# Test 1: Field path parsing
print("Test 1: Field path parsing")
tests = [
    ("quests[opening_01].title", [("quests", "opening_01"), ("title", None)]),
    ("items[copper_coins].dynamicDescriptions[0].text",
     [("items", "copper_coins"), ("dynamicDescriptions", "0"), ("text", None)]),
    ("rules.rules[rule_zombie_fire].name",
     [("rules", None), ("rules", "rule_zombie_fire"), ("name", None)]),
]
all_pass = True
for path, expected in tests:
    result = _parse_field_path(path)
    status = "PASS" if result == expected else "FAIL"
    print(f"  {status}: {path}")
    if status == "FAIL":
        print(f"    expected: {expected}")
        print(f"    got:      {result}")
        all_pass = False

# Test 2: Only replaces existing string values
print()
print("Test 2: Only replaces string values")
test_data = {"items": [
    {"id": "copper_coins", "name": "铜钱", "type": "key", "buyPrice": 10, "maxStack": 999}
]}
_set_value_safe(test_data, "items[copper_coins].name", "Copper Coins")
assert test_data["items"][0]["name"] == "Copper Coins", "String replacement failed"
print("  PASS: String value replaced")

_set_value_safe(test_data, "items[copper_coins].buyPrice", "free")
assert test_data["items"][0]["buyPrice"] == 10, "Numeric replaced!"
print("  PASS: Numeric NOT replaced")

_set_value_safe(test_data, "items[copper_coins].maxStack", "100")
assert test_data["items"][0]["maxStack"] == 999, "Numeric replaced!"
print("  PASS: Another numeric NOT replaced")

# Test 3: Never creates new keys
print()
print("Test 3: Never creates new keys")
test_data2 = {"items": [{"id": "test_item", "name": "测试"}]}
_set_value_safe(test_data2, "items[test_item].nonexistent_field", "hacked")
assert "nonexistent_field" not in test_data2["items"][0]
print("  PASS: No new keys created")

# Test 4: Cannot navigate nonexistent paths
print()
print("Test 4: Nonexistent paths silently skipped")
test_data3 = {"items": [{"id": "test", "name": "测试"}]}
_set_value_safe(test_data3, "nonexistent[test].name", "hacked")
assert test_data3["items"][0]["name"] == "测试"
print("  PASS: Nonexistent path skipped")

# Test 5: Backfiller string-only safety
print()
print("Test 5: Backfiller string-only safety")
test_data4 = {"items": [{"id": "test", "name": "原名", "price": 100}]}
r1 = _set_json_value_safe(test_data4, "items[test].name", "新名字")
assert r1 is True and test_data4["items"][0]["name"] == "新名字"
print("  PASS: String backfill works")

r2 = _set_json_value_safe(test_data4, "items[test].price", "free")
assert r2 is False and test_data4["items"][0]["price"] == 100
print("  PASS: Numeric backfill rejected")

# Test 6: Idempotent modification
print()
print("Test 6: Idempotent modification")
test_data5 = {"items": [{"id": "test", "name": "原名"}]}
r3 = _set_json_value_safe(test_data5, "items[test].name", "原名")
assert r3 is False, "Same value returned True!"
print("  PASS: Same value returns False")

# Test 7: strings.json structure preservation (uses special export path)
print()
print("Test 7: strings.json structure preservation")
test_strings = {
    "notifications": {"ruleAcquired": "规矩本新增", "questAccepted": "新任务"},
    "menu": {"gameTitle": "七日惊魂", "newGame": "新游戏"}
}
# strings.json is exported via _export_strings which strips "strings." prefix
# So _set_value_safe should use the actual key path without the "strings." prefix
_set_value_safe(test_strings, "notifications.ruleAcquired", "New rule")
assert test_strings["notifications"]["ruleAcquired"] == "New rule"
assert test_strings["notifications"]["questAccepted"] == "新任务"
assert test_strings["menu"]["gameTitle"] == "七日惊魂"
print("  PASS: strings.json structure preserved")

# Test 8: Nested dynamicDescriptions
print()
print("Test 8: Nested array with index-based access")
test_nested = {
    "items": [{
        "id": "nuomi",
        "name": "糯米",
        "dynamicDescriptions": [
            {"conditions": [{"flag": "day:1"}], "text": "白天用的糯米"},
            {"conditions": [{"flag": "night:1"}], "text": "夜晚用的糯米"},
        ]
    }]
}
_set_value_safe(test_nested, "items[nuomi].dynamicDescriptions[0].text", "Daytime rice")
assert test_nested["items"][0]["dynamicDescriptions"][0]["text"] == "Daytime rice"
assert test_nested["items"][0]["dynamicDescriptions"][0]["conditions"] == [{"flag": "day:1"}]
assert test_nested["items"][0]["dynamicDescriptions"][1]["text"] == "夜晚用的糯米"
print("  PASS: Nested array correctly modified, structure preserved")

# Test 9: rules.json dict-wrapped structure
print()
print("Test 9: Dict-wrapped rules.json")
test_rules = {
    "categories": {"ward": "护卫", "taboo": "禁忌"},
    "rules": [
        {"id": "rule_zombie_fire", "name": "白毛僵尸怕火", "category": "ward"},
        {"id": "rule_salt", "name": "盐能驱邪", "category": "streetwise"}
    ],
    "fragments": [
        {"id": "frag_1", "text": "白毛的...怕火", "ruleId": "rule_zombie_fire"},
    ]
}
_set_value_safe(test_rules, "rules.rules[rule_zombie_fire].name", "White zombies fear fire")
assert test_rules["rules"][0]["name"] == "White zombies fear fire"
assert test_rules["categories"]["ward"] == "护卫"
assert test_rules["rules"][1]["name"] == "盐能驱邪"
print("  PASS: Dict-wrapped rules.json correctly modified")

# Test 10: Boolean values not replaced
print()
print("Test 10: Boolean values NOT replaced")
test_bool = {"items": [{"id": "test", "name": "测试", "active": True}]}
_set_value_safe(test_bool, "items[test].active", "false")
assert test_bool["items"][0]["active"] is True
print("  PASS: Boolean NOT replaced")

# Test 11: Array values not replaced
print()
print("Test 11: Array values NOT replaced")
test_arr = {"items": [{"id": "test", "name": "测试", "tags": ["a", "b"]}]}
_set_value_safe(test_arr, "items[test].tags", "no tags")
assert test_arr["items"][0]["tags"] == ["a", "b"]
print("  PASS: Array NOT replaced")

# Test 12: Object values not replaced
print()
print("Test 12: Object values NOT replaced")
test_obj = {"items": [{"id": "test", "name": "测试", "meta": {"x": 1}}]}
_set_value_safe(test_obj, "items[test].meta", "no meta")
assert test_obj["items"][0]["meta"] == {"x": 1}
print("  PASS: Object NOT replaced")

# Test 13: Null value field not replaced
print()
print("Test 13: Null value NOT replaced")
test_null = {"items": [{"id": "test", "name": None}]}
_set_value_safe(test_null, "items[test].name", "something")
assert test_null["items"][0]["name"] is None
print("  PASS: Null value NOT replaced")

# Test 14: Real quest data structure test
print()
print("Test 14: Real quest data structure integrity")
test_quest = {
    "id": "opening_01",
    "title": "听张叨叨摆书",
    "description": "张叨叨又在茶馆里说书。",
    "preconditions": [],
    "completionConditions": [{"flag": "day:1"}],
    "rewards": [],
    "nextQuests": [{"questId": "opening_02", "conditions": []}]
}
test_quests = {"quests": [test_quest]}
_set_value_safe(test_quests, "quests[opening_01].title", "Listen to Zhang")
assert test_quest["title"] == "Listen to Zhang"
assert test_quest["preconditions"] == []
assert test_quest["completionConditions"] == [{"flag": "day:1"}]
assert test_quest["nextQuests"] == [{"questId": "opening_02", "conditions": []}]
print("  PASS: Quest structure fully preserved after title change")

print()
print("=== All 14 safety tests passed! ===")
