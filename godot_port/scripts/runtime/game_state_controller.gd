class_name RuntimeGameStateController
extends RefCounted

const MAIN_MENU := "MainMenu"
const EXPLORING := "Exploring"
const ACTION_SEQUENCE := "ActionSequence"
const DIALOGUE := "Dialogue"
const ENCOUNTER := "Encounter"
const CUTSCENE := "Cutscene"
const UI_OVERLAY := "UIOverlay"
const MINIGAME := "Minigame"
const STATES := [MAIN_MENU, EXPLORING, ACTION_SEQUENCE, DIALOGUE, ENCOUNTER, CUTSCENE, UI_OVERLAY, MINIGAME]

var current_state := EXPLORING
var previous_state := EXPLORING

var _event_bus: RuntimeEventBus
var _overlay_return_stack: Array[String] = []
var _panels: Dictionary = {}
var _escape_fallback := Callable()
var _unsubscribe_key_down := Callable()


func _init(input_manager: Variant = null, event_bus: RuntimeEventBus = null) -> void:
	_event_bus = event_bus
	if input_manager != null:
		bind_input_manager(input_manager)


func bind_input_manager(input_manager: Variant) -> bool:
	if not _unsubscribe_key_down.is_null() and _unsubscribe_key_down.is_valid():
		_unsubscribe_key_down.call()
	_unsubscribe_key_down = Callable()
	if input_manager == null or not input_manager.has_method("subscribe_key_down"):
		return false
	var unsubscribe: Variant = input_manager.call("subscribe_key_down", Callable(self, "handle_key_down"))
	if unsubscribe is Callable:
		_unsubscribe_key_down = unsubscribe
		return true
	return false


func set_state(new_state: String) -> bool:
	if not STATES.has(new_state):
		push_error("GameStateController: invalid state %s" % new_state)
		return false
	previous_state = current_state
	current_state = new_state
	return true


func restore_previous_state() -> void:
	current_state = _overlay_return_stack.pop_back() if not _overlay_return_stack.is_empty() else previous_state


func register_panel(
	name: String,
	panel: Variant,
	shortcut_key: String = "",
	options: Dictionary = {},
) -> bool:
	if panel == null or not panel.has_method("open") or not panel.has_method("close"):
		push_error("GameStateController: panel %s does not implement open/close" % name)
		return false
	_panels[name] = {
		"panel": panel,
		"shortcutKey": shortcut_key,
		"alwaysOpenable": bool(options.get("alwaysOpenable", false)),
		"additionalKeys": options.get("additionalKeys", []).duplicate(),
		"overlaysGameState": options.get("overlaysGameState", true) != false,
		"openGuard": options.get("openGuard", Callable()),
	}
	return true


func set_escape_fallback(callback: Callable) -> void:
	_escape_fallback = callback


func trigger_escape_from_touch() -> void:
	_handle_escape()


func close_all_panels() -> void:
	for entry: Dictionary in _panels.values():
		if _panel_is_open(entry.panel):
			entry.panel.call("close")


func close_panel(name: String, silent: bool = false) -> void:
	var entry: Variant = _panels.get(name)
	if not entry is Dictionary or not _panel_is_open(entry.panel):
		return
	entry.panel.call("close")
	if not silent and _event_bus != null:
		_event_bus.emit("ui:panelClose", {"name": name})
	if bool(entry.overlaysGameState):
		current_state = _overlay_return_stack.pop_back() if not _overlay_return_stack.is_empty() else EXPLORING


func toggle_panel(name: String) -> void:
	var entry: Variant = _panels.get(name)
	if not entry is Dictionary:
		return
	if _panel_is_open(entry.panel):
		close_panel(name)
		return
	if not bool(entry.alwaysOpenable) and current_state != EXPLORING:
		return
	var guard: Variant = entry.openGuard
	if guard is Callable and not guard.is_null() and guard.is_valid() and not bool(guard.call()):
		return
	if bool(entry.overlaysGameState):
		_overlay_return_stack.push_back(current_state)
		current_state = UI_OVERLAY
	entry.panel.call("open")
	if _panel_is_open(entry.panel) and _event_bus != null:
		_event_bus.emit("ui:panelOpen", {"name": name})
	if not _panel_is_open(entry.panel) and bool(entry.overlaysGameState):
		current_state = _overlay_return_stack.pop_back() if not _overlay_return_stack.is_empty() else EXPLORING


func handle_key_down(event: Dictionary) -> void:
	if bool(event.get("repeat", false)):
		return
	var code := str(event.get("code", ""))
	var debug_entry: Variant = _panels.get("debug")
	if debug_entry is Dictionary and _panel_is_open(debug_entry.panel):
		if code == "F2":
			_prevent_default(event)
			toggle_panel("debug")
		elif code == "Escape":
			toggle_panel("debug")
		return
	for name: String in _panels:
		var entry: Dictionary = _panels[name]
		var matches: bool = (not str(entry.shortcutKey).is_empty() and code == entry.shortcutKey) \
			or (entry.additionalKeys is Array and entry.additionalKeys.has(code))
		if matches:
			_prevent_default(event)
			toggle_panel(name)
			return
	if code == "Escape":
		_handle_escape()


func destroy() -> void:
	close_all_panels()
	for entry: Dictionary in _panels.values():
		if entry.panel.has_method("destroy"):
			entry.panel.call("destroy")
	_panels.clear()
	_overlay_return_stack.clear()
	if not _unsubscribe_key_down.is_null() and _unsubscribe_key_down.is_valid():
		_unsubscribe_key_down.call()
	_unsubscribe_key_down = Callable()
	_escape_fallback = Callable()


func overlay_depth() -> int:
	return _overlay_return_stack.size()


func debug_snapshot() -> Dictionary:
	var open_panels: Array[String] = []
	for name: String in _panels:
		if _panel_is_open(_panels[name].panel): open_panels.push_back(name)
	open_panels.sort()
	return {"overlayReturnStack": _overlay_return_stack.duplicate(), "openPanels": open_panels}


func _handle_escape() -> void:
	if current_state == UI_OVERLAY:
		var names := _panels.keys()
		names.reverse()
		for name: String in names:
			var entry: Dictionary = _panels[name]
			if _panel_is_open(entry.panel) and bool(entry.overlaysGameState):
				close_panel(name, true)
				if _event_bus != null:
					_event_bus.emit("ui:cancel", {"name": name})
				return
	var names := _panels.keys()
	names.reverse()
	for name: String in names:
		var entry: Dictionary = _panels[name]
		if _panel_is_open(entry.panel) and not bool(entry.overlaysGameState):
			close_panel(name, true)
			if _event_bus != null:
				_event_bus.emit("ui:cancel", {"name": name})
			return
	if current_state == EXPLORING and not _escape_fallback.is_null() and _escape_fallback.is_valid():
		_escape_fallback.call()


func _panel_is_open(panel: Variant) -> bool:
	if panel == null:
		return false
	if panel.has_method("is_open"):
		return panel.call("is_open") == true
	return panel.get("is_open") == true


func _prevent_default(event: Dictionary) -> void:
	var callback: Variant = event.get("preventDefault")
	if callback is Callable and callback.is_valid():
		callback.call()
