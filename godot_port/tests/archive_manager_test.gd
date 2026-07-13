extends Node

var updates: Array[Dictionary] = []
var notifications := 0
var first_views: Array = []
var flags: RuntimeFlagStore


func _ready() -> void: await _run()


func _run() -> void:
	var repository := ProjectSettings.globalize_path("res://").trim_suffix("/").get_base_dir()
	var assets := RuntimeAssetManager.new(RuntimeResourceLocator.new(RuntimeResourceLocator.DEVELOPMENT, repository))
	var strings := RuntimeStringsProvider.new(); assert(strings.load(assets))
	var bus := RuntimeEventBus.new()
	bus.on("archive:updated", Callable(self, "_updated")); bus.on("notification:show", Callable(self, "_notified")); bus.on("archive:firstView", Callable(self, "_first_view"))
	flags = RuntimeFlagStore.new(bus); flags.configure_registry(assets.load_json("/assets/data/flag_registry.json"))
	# A startup flag is silently seeded; character archives remain action-only.
	flags.set_value("prologue_started", true); flags.set_value("archive_book_book_erta_guide", true)
	var archive := RuntimeArchiveManager.new(bus, flags)
	archive.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets})
	archive.set_condition_eval_context_factory(func() -> Dictionary: return {"evaluateList": Callable(self, "_evaluate_list")})
	archive.set_resolve_for_display(func(raw: String) -> String: return raw.replace("[tag:string:place:wujin]", "雾津"))
	assert(archive.load_defs())
	assert(archive.definition_counts() == {"characters": 8, "lore": 11, "documents": 4, "books": 1, "bookEntries": 4, "items": 17})
	assert(archive.get_unlocked_documents().map(func(x: Dictionary) -> String: return x.id) == ["doc_city_defense_notice"])
	assert(archive.get_unlocked_books()[0].id == "book_erta_guide")
	assert(archive.get_unlocked_characters().is_empty() and updates.is_empty() and notifications == 0)
	assert(archive.get_item_display_names().iron_box == "铁盒子")
	assert(archive.get_lore_category_name("legend") == "传说")

	archive.add_entry("character", "blind_li")
	archive.add_entry("character", "blind_li")
	assert(archive.get_unlocked_characters().size() == 1 and flags.get_value("archive_character_blind_li") == true)
	assert(updates.size() == 1 and notifications == 1)
	assert(archive.has_unread("character")); archive.mark_read("char_blind_li"); assert(not archive.has_unread("character"))

	# Declarative unlocks batch after the source flag change.
	flags.set_value("heard_ghost_story", true)
	flags.set_value("has_item_iron_hoop", true)
	await get_tree().process_frame
	await get_tree().process_frame
	assert(archive.get_unlocked_lore().any(func(x: Dictionary) -> bool: return x.id == "lore_ghost_mountain"))
	assert(flags.get_value("archive_book_entry_erta_geo_iron_ring") == true)
	var book: Dictionary = archive.get_books()[0]
	assert(archive.get_book_toc_chapters(book).size() == 5)
	assert(archive.get_book_page_slice(book, 1).content.contains("雾津"))
	assert(archive.get_book_entry_slice(book, 2, "erta_geo_iron_ring").entryId == "erta_geo_iron_ring")
	assert(archive.get_book_entry_slice(book, 2, "book_entry_2") == null)

	var action := [{"type": "setFlag", "params": {"key": "first", "value": true}}]
	archive.trigger_first_view_if_needed("synthetic", action)
	action[0].params.key = "mutated"
	archive.trigger_first_view_if_needed("synthetic", action)
	assert(first_views.size() == 1 and first_views[0][0].params.key == "first")

	var snapshot := archive.serialize()
	var restored := RuntimeArchiveManager.new(bus, flags)
	restored.init({"eventBus": bus, "flagStore": flags, "strings": strings, "assetManager": assets}); assert(restored.load_defs())
	restored.deserialize(snapshot)
	assert(restored.serialize() == snapshot)
	restored.destroy(); restored.free(); archive.destroy(); archive.free()
	flags.destroy(); bus.clear(); assets.dispose()
	print("ArchiveManager contract test: PASS"); get_tree().quit(0)


func _evaluate_list(conditions: Array) -> bool: return flags.check_conditions(conditions)
func _updated(payload: Dictionary) -> void: updates.push_back(payload.duplicate(true))
func _notified(payload: Dictionary) -> void:
	if payload.get("type") == "archive": notifications += 1
func _first_view(payload: Dictionary) -> void: first_views.push_back(payload.actions)
