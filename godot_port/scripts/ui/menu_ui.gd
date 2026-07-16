class_name RuntimeMenuUI
extends RuntimeTextPanel
var events: RuntimeEventBus
var saves: RuntimeSaveManager
var audio: RuntimeAudioManager
var mode := "pause"
func _init(renderer: RuntimeRenderer, event_bus: RuntimeEventBus, save_manager: RuntimeSaveManager, audio_manager: RuntimeAudioManager, strings: RuntimeStringsProvider) -> void: super._init(renderer, strings); events = event_bus; saves = save_manager; audio = audio_manager
func panel_title() -> String: return strings.get_text("menu", "gameTitle") if mode == "main" else strings.get_text("menu", mode if mode in ["save", "load"] else "pause")
func open() -> void: mode = "pause"; super.open()
func open_main_menu() -> void:
	mode = "main"
	if is_open(): refresh()
	else: super.open()
func refresh() -> void:
	if content == null: return
	title_label.text = panel_title(); var lines: Array[String] = []; var actions: Array = []
	if mode == "main": lines = ["1. " + strings.get_text("menu", "newGame"), "2. " + strings.get_text("menu", "continueGame"), "3. " + strings.get_text("menu", "settings")]
	elif mode == "pause": lines = ["1. " + strings.get_text("menu", "resume"), "2. " + strings.get_text("menu", "save"), "3. " + strings.get_text("menu", "load"), "4. " + strings.get_text("menu", "settings"), "5. " + strings.get_text("menu", "returnToMain")]
	elif mode in ["save", "load"]:
		for slot in 3:
			var meta: Variant = saves.get_slot_meta(slot); var label := str(meta) if meta is Dictionary else strings.get_text("menu", "slotEmpty", {"slot": slot + 1}); lines.push_back(label); actions.push_back({"label": label, "callback": Callable(self, "_slot_action").bind(slot)})
			if meta is Dictionary: actions.push_back({"label": "JSON ↓  %s" % (slot + 1), "callback": Callable(self, "_open_export_dialog").bind(slot)})
			actions.push_back({"label": "JSON ↑  %s" % (slot + 1), "callback": Callable(self, "_open_import_dialog").bind(slot)})
	else: lines = ["BGM %.0f%%" % (audio.get_volume("bgm") * 100), "SFX %.0f%%" % (audio.get_volume("sfx") * 100), "Ambient %.0f%%" % (audio.get_volume("ambient") * 100)]
	if mode == "main": actions = [{"label": strings.get_text("menu", "newGame"), "callback": Callable(self, "_emit_and_close").bind("menu:newGame")}, {"label": strings.get_text("menu", "continueGame"), "enabled": saves.has_any_save(), "callback": Callable(self, "_set_mode").bind("load")}, {"label": strings.get_text("menu", "settings"), "callback": Callable(self, "_set_mode").bind("settings")}]
	elif mode == "pause": actions = [{"label": strings.get_text("menu", "resume"), "callback": Callable(self, "_emit_and_close").bind("menu:resume")}, {"label": strings.get_text("menu", "save"), "callback": Callable(self, "_set_mode").bind("save")}, {"label": strings.get_text("menu", "load"), "callback": Callable(self, "_set_mode").bind("load")}, {"label": strings.get_text("menu", "settings"), "callback": Callable(self, "_set_mode").bind("settings")}, {"label": strings.get_text("menu", "returnToMain"), "callback": Callable(self, "_emit_and_close").bind("menu:returnToMain")}]
	elif mode == "settings":
		for channel: String in ["bgm", "sfx", "ambient"]: actions.push_back({"label": "%s −" % channel.to_upper(), "callback": Callable(self, "_adjust_volume").bind(channel, -0.1)}); actions.push_back({"label": "%s +" % channel.to_upper(), "callback": Callable(self, "_adjust_volume").bind(channel, 0.1)})
		actions.push_back({"label": strings.get_text("menu", "back"), "callback": Callable(self, "_set_mode").bind("pause")})
	content.text = "\n".join(lines)
	set_action_rows(actions)
func debug_mode(next: String) -> void: _set_mode(next)
func _set_mode(next: String) -> void: if next in ["main", "pause", "save", "load", "settings"]: mode = next; refresh()
func _emit_and_close(event_name: String) -> void: close(); events.emit(event_name, {})
func _slot_action(slot: int) -> void:
	if mode == "save": debug_save(slot)
	elif mode == "load": await debug_load(slot)
func _adjust_volume(channel: String, delta: float) -> void: debug_set_volume(channel, clampf(audio.get_volume(channel) + delta, 0.0, 1.0))
func _open_export_dialog(slot: int) -> void:
	if root == null: return
	var raw: Variant = saves.export_slot_payload(slot)
	if not raw is String or raw.is_empty(): events.emit("notification:show", {"text": strings.get_text("menu", "saveFailed"), "type": "error"}); return
	var dialog := FileDialog.new(); dialog.title = "JSON ↓"; dialog.file_mode = FileDialog.FILE_MODE_SAVE_FILE; dialog.access = FileDialog.ACCESS_FILESYSTEM; dialog.use_native_dialog = true; dialog.filters = PackedStringArray(["*.json ; JSON"]); dialog.current_file = "gamedraft_save_%s.json" % (slot + 1); root.add_child(dialog)
	dialog.file_selected.connect(func(path: String) -> void:
		var file := FileAccess.open(path, FileAccess.WRITE)
		var ok := file != null
		if ok:
			file.store_string(raw if raw.ends_with("\n") else raw + "\n")
			file.close()
		events.emit("notification:show", {"text": strings.get_text("menu", "saveSlot", {"slot": slot + 1}) if ok else strings.get_text("menu", "saveFailed"), "type": "info" if ok else "error"})
		dialog.queue_free()
	)
	dialog.popup_centered_ratio(0.75)
func _open_import_dialog(slot: int) -> void:
	if root == null: return
	var dialog := FileDialog.new(); dialog.title = "JSON ↑"; dialog.file_mode = FileDialog.FILE_MODE_OPEN_FILE; dialog.access = FileDialog.ACCESS_FILESYSTEM; dialog.use_native_dialog = true; dialog.filters = PackedStringArray(["*.json ; JSON"]); root.add_child(dialog)
	dialog.file_selected.connect(func(path: String) -> void:
		var file := FileAccess.open(path, FileAccess.READ)
		var ok := file != null and saves.import_slot_payload(slot, file.get_as_text())
		events.emit("notification:show", {"text": strings.get_text("menu", "loadSlot", {"slot": slot + 1}) if ok else strings.get_text("menu", "loadFailed"), "type": "info" if ok else "error"})
		dialog.queue_free()
		if ok:
			refresh()
	)
	dialog.popup_centered_ratio(0.75)
func debug_save(slot: int) -> bool: var ok := saves.save(slot); refresh(); return ok
func debug_load(slot: int) -> bool:
	var ok := await saves.load(slot)
	if ok: close()
	return ok
func debug_set_volume(channel: String, value: float) -> void: audio.set_volume(channel, value); refresh()
