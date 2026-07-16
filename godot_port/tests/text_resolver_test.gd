extends SceneTree

class FakeFlags:
	extends RefCounted
	var values := {"truth": true, "falsehood": false, "count": 5.0, "note": "纸人"}

	func get_value(key: String) -> Variant:
		return values.get(key)

	func has_value(key: String) -> bool:
		return values.has(key)


func _init() -> void:
	var locator := RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir())
	var strings := {
		"gameTags": {"flagUnset": "未设置", "flagTrue": "是", "flagFalse": "否", "unknownItem": "未知物品（{id}）"},
		"nested": {"a": "[tag:string:nested:b]", "b": "[tag:string:nested:c]", "c": "[tag:string:nested:d]", "d": "[tag:string:nested:e]", "e": "完成"},
		"中文分类": {"键:带冒号": "中文值"},
	}
	var context := {
		"stringsRaw": func(category: String, key: String) -> String: return str(strings.get(category, {}).get(key, key)),
		"flagStore": FakeFlags.new(),
		"itemNames": {"bone": "白骨"},
		"npcName": func(id: String) -> Variant: return {"dog": "阿黄", "ctx": "掌柜"}.get(id),
		"playerDisplayName": func() -> String: return "关二狗",
		"questTitle": func(id: String) -> Variant: return {"q1": "寻狗"}.get(id),
		"ruleName": func(id: String) -> Variant: return {"r1": "莫回头"}.get(id),
		"sceneDisplayName": func(id: String) -> Variant: return {"s1": "茶馆"}.get(id),
		"contextNpcId": "ctx",
	}
	assert(RuntimeTextResolver.resolve_text("［tag:string:中文分类:键:带冒号］", context) == "中文值")
	assert(RuntimeTextResolver.resolve_text("[tag:flag:truth]/[tag:flag:falsehood]/[tag:flag:count]/[tag:flag:note]/[tag:flag:missing]", context) == "是/否/5/纸人/未设置")
	assert(RuntimeTextResolver.resolve_text("[tag:item:bone]/[tag:item:none]", context) == "白骨/未知物品（none）")
	assert(RuntimeTextResolver.resolve_text("[tag:npc:dog]/[tag:npc:@context]/[tag:npc:unknown]/[tag:npc: ]", context) == "阿黄/掌柜/unknown/掌柜")
	assert(RuntimeTextResolver.resolve_text("[tag:player] [tag:quest:q1] [tag:quest:q2] [tag:rule:r1] [tag:scene:s1]", context) == "关二狗 寻狗 q2 莫回头 茶馆")
	assert(RuntimeTextResolver.resolve_text("[tag:string:nested:a]", context) == "[tag:string:nested:e]")
	assert(RuntimeTextResolver.resolve_text("[tag:unknown:x]", context) == "[tag:unknown:x]")

	assert(RuntimeTextResolver.split_speaker_body_after_resolve("掌柜：天色:不早了").body == "天色:不早了")
	assert(RuntimeTextResolver.split_speaker_body_after_resolve(":空").is_empty())
	assert(RuntimeTextResolver.apply_dialogue_colon_speaker_from_resolved_text("旁白", "掌柜：走吧", "旁白") == {"speaker": "掌柜", "text": "走吧"})
	assert(RuntimeTextResolver.apply_dialogue_colon_speaker_from_resolved_text("二狗", "掌柜：走吧", "旁白") == {"speaker": "二狗", "text": "掌柜：走吧"})

	var segments := RuntimeRichContent.parse_segments("前文 [img:images/backgrounds/x.png] 后文 [img:/assets/images/bad.png]")
	assert(segments.size() == 4)
	assert(segments[0] == {"type": "text", "text": "前文"})
	assert(RuntimeRichContent.resolve_content_image_url(segments[1].path, locator) == "/resources/runtime/images/backgrounds/x.png")
	assert(segments[2] == {"type": "text", "text": "后文"})
	assert(RuntimeRichContent.resolve_content_image_url(segments[3].path, locator) == "")
	print("TextResolver/Rich tag contract test: PASS")
	quit(0)
