class_name RuntimeDevModeUI
extends RuntimeTextPanel

const SECTIONS := ["cutscene", "scene", "minigames", "narrative"]

var callbacks: Dictionary = {}
var section := "cutscene"
var entries: Array = []
var button_host: VBoxContainer


func _init(next_renderer: RuntimeRenderer, next_strings: RuntimeStringsProvider, next_callbacks: Dictionary = {}) -> void:
	super._init(next_renderer, next_strings)
	callbacks = next_callbacks


func panel_title() -> String: return "Dev Mode · %s" % section


func close() -> void:
	button_host = null
	super.close()


func select_section(id: String) -> bool:
	if not SECTIONS.has(id): return false
	section = id
	if is_open(): refresh()
	return true


func refresh() -> void:
	if content == null: return
	title_label.text = panel_title()
	entries = _load_entries()
	content.text = ""
	if button_host != null and is_instance_valid(button_host): button_host.queue_free()
	button_host = VBoxContainer.new(); button_host.position = content.position; button_host.size = content.size; panel.add_child(button_host)
	var tabs := HBoxContainer.new(); button_host.add_child(tabs)
	for id: String in SECTIONS:
		var tab := Button.new(); tab.text = id; tab.disabled = id == section; tab.pressed.connect(func() -> void: select_section(id)); tabs.add_child(tab)
	var reload := Button.new(); reload.text = "Reload"; reload.pressed.connect(func() -> void: _invoke("reload")); tabs.add_child(reload)
	var scroll := ScrollContainer.new(); scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL; button_host.add_child(scroll)
	var list := VBoxContainer.new(); list.size_flags_horizontal = Control.SIZE_EXPAND_FILL; scroll.add_child(list)
	if entries.is_empty():
		var empty := Label.new(); empty.text = "(empty)"; list.add_child(empty)
	for index in entries.size():
		var entry: Variant = entries[index]
		var row := Button.new(); row.text = _entry_label(entry); row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		row.pressed.connect(func() -> void: debug_select(index)); list.add_child(row)


func debug_select(index: int) -> bool:
	if index < 0 or index >= entries.size(): return false
	var entry: Variant = entries[index]
	match section:
		"cutscene": _invoke("playCutscene", str(entry))
		"scene": _invoke("loadScene", str(entry.get("id", "")) if entry is Dictionary else str(entry))
		"minigames": _invoke("launchMinigame", entry)
		"narrative": _invoke("enterNarrativeWarp", str(entry.get("id", "")) if entry is Dictionary else str(entry))
	return true


func _load_entries() -> Array:
	var key: String = {"cutscene": "getCutsceneIds", "scene": "getScenes", "minigames": "getMinigameEntries", "narrative": "getNarrativeWarps"}.get(section, "")
	var value: Variant = _invoke(str(key))
	return value.duplicate(true) if value is Array else []


func _entry_label(entry: Variant) -> String:
	if entry is Dictionary:
		var prefix := "[%s] " % str(entry.get("kind")) if entry.has("kind") else ""
		return prefix + str(entry.get("label", entry.get("name", entry.get("id", ""))))
	return str(entry)


func _invoke(key: String, arg: Variant = null) -> Variant:
	var callback: Variant = callbacks.get(key)
	if not callback is Callable or callback.is_null() or not callback.is_valid(): return null
	return callback.call() if arg == null else callback.call(arg)


func destroy() -> void:
	super.destroy(); callbacks.clear(); entries.clear(); button_host = null
