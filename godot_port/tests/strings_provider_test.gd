extends SceneTree

class FakeAssets:
	extends RefCounted

	func load_json(_path: String) -> Dictionary:
		return {
			"test": {
				"template": "你好 {name}，剩余 {count}，未知 {missing} [flag:x]",
				"truth": true,
				"falsehood": false,
				"number": 3.5,
				"nullValue": null,
			}
		}


func _init() -> void:
	var project_dir := ProjectSettings.globalize_path("res://").trim_suffix("/")
	var repository_root := project_dir.get_base_dir()
	var locator := RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository_root)
	var assets := RuntimeAssetManager.new(locator)
	var provider := RuntimeStringsProvider.new()
	assert(provider.load(assets))
	assert(provider.category_count() == 31 and provider.leaf_count() == 185)
	assert(provider.get_raw("价格", "抽糖画价格") == "5")
	assert(provider.get_raw("missing", "fallback_key") == "fallback_key")

	var fake := RuntimeStringsProvider.new()
	assert(fake.load(FakeAssets.new()))
	assert(fake.get_raw("test", "truth") == "true")
	assert(fake.get_raw("test", "falsehood") == "false")
	assert(fake.get_raw("test", "number") == "3.5")
	assert(fake.get_raw("test", "nullValue") == "nullValue")
	var resolve_inputs: Array[String] = []
	fake.set_resolve_display(func(value: String) -> String:
		resolve_inputs.push_back(value)
		return value.replace("[flag:x]", "已解析")
	)
	var rendered := fake.get_text("test", "template", {"name": "二狗", "count": 2})
	assert(rendered == "你好 二狗，剩余 2，未知 {missing} 已解析")
	assert(resolve_inputs == ["你好 二狗，剩余 2，未知 {missing} [flag:x]"])
	fake.set_resolve_display()
	assert(fake.get_text("test", "template", {"name": "二狗"}).contains("[flag:x]"))
	assets.dispose()
	print("StringsProvider contract test: PASS")
	quit(0)
