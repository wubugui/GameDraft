class_name RuntimeGameStateController
extends RefCounted

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

var _current_state := RuntimeDataTypes.EXPLORING
var _previous_state := RuntimeDataTypes.EXPLORING
var _overlay_return_stack: Array[String] = []
var _panels: Dictionary = {}
var _escape_fallback := Callable()
var _unsubscribe_key_down := Callable()
var _event_bus: RuntimeEventBus

var current_state: String:
	get: return _current_state

var previous_state: String:
	get: return _previous_state


func _init(input_manager: Variant, event_bus: RuntimeEventBus = null) -> void:
	_event_bus = event_bus
	_unsubscribe_key_down = input_manager.call("subscribe_key_down", Callable(self, "_handle_key_down"))


func get_debug_state() -> Dictionary:
	var open_panels: Array[String] = []
	for name: String in _panels:
		if _panel_is_open(_panels[name].panel):
			open_panels.push_back(name)
	open_panels.sort()
	return {
		"overlayReturnStack": _overlay_return_stack.duplicate(),
		"openPanels": open_panels,
	}


func set_state(new_state: String) -> void:
	_previous_state = _current_state
	_current_state = new_state


func restore_previous_state() -> void:
	var state: Variant = _overlay_return_stack.pop_back() if not _overlay_return_stack.is_empty() else null
	_current_state = state if state != null else _previous_state


func register_panel(
	name: String,
	panel: Variant,
	shortcut_key: Variant = null,
	options: Variant = null,
) -> void:
	var opts: Dictionary = options if options is Dictionary else {}
	_panels[name] = {
		"panel": panel,
		"shortcutKey": shortcut_key,
		"alwaysOpenable": opts.get("alwaysOpenable"),
		"additionalKeys": opts.get("additionalKeys"),
		"overlaysGameState": opts.get("overlaysGameState") != false,
		"openGuard": opts.get("openGuard"),
	}


func set_escape_fallback(callback: Callable) -> void:
	_escape_fallback = callback


func trigger_escape_from_touch() -> void:
	_handle_escape()


func close_all_panels() -> void:
	for entry: Dictionary in _panels.values():
		if _panel_is_open(entry.panel):
			entry.panel.call("close")


func close_panel(name: String, options: Variant = null) -> void:
	var entry: Variant = _panels.get(name)
	if not entry is Dictionary or not _panel_is_open(entry.panel):
		return
	entry.panel.call("close")
	var silent: bool = options is Dictionary and options.get("silent") == true
	if not silent and _event_bus != null:
		_event_bus.emit("ui:panelClose", {"name": name})
	if entry.overlaysGameState:
		var restored: Variant = _overlay_return_stack.pop_back() if not _overlay_return_stack.is_empty() else null
		_current_state = restored if restored != null else RuntimeDataTypes.EXPLORING


func toggle_panel(name: String) -> void:
	var entry: Variant = _panels.get(name)
	if not entry is Dictionary:
		return
	if _panel_is_open(entry.panel):
		close_panel(name)
		return
	var can_open: bool = _js_boolean(entry.alwaysOpenable) or _current_state == RuntimeDataTypes.EXPLORING
	if not can_open:
		return
	var guard: Variant = entry.openGuard
	if guard is Callable and guard.is_valid() and not _js_boolean(guard.call()):
		return
	if entry.overlaysGameState:
		_overlay_return_stack.push_back(_current_state)
		_current_state = RuntimeDataTypes.UI_OVERLAY
	entry.panel.call("open")
	if _panel_is_open(entry.panel) and _event_bus != null:
		_event_bus.emit("ui:panelOpen", {"name": name})
	if not _panel_is_open(entry.panel) and entry.overlaysGameState:
		var restored: Variant = _overlay_return_stack.pop_back() if not _overlay_return_stack.is_empty() else null
		_current_state = restored if restored != null else RuntimeDataTypes.EXPLORING


func _handle_key_down(event: Dictionary) -> void:
	if _js_boolean(event.get("repeat")):
		return
	var code := str(event.get("code", ""))
	var debug_entry: Variant = _panels.get("debug")
	if debug_entry is Dictionary and _panel_is_open(debug_entry.panel):
		if code == "F2":
			_prevent_default(event)
			toggle_panel("debug")
			return
		if code == "Escape":
			toggle_panel("debug")
			return
		return
	for name: String in _panels:
		var entry: Dictionary = _panels[name]
		var shortcut_key: Variant = entry.shortcutKey
		var additional_keys: Variant = entry.additionalKeys
		var matches: bool = (_js_boolean(shortcut_key) and code == shortcut_key) \
			or (additional_keys is Array and additional_keys.has(code))
		if matches:
			_prevent_default(event)
			toggle_panel(name)
			return
	if code == "Escape":
		_handle_escape()


func _handle_escape() -> void:
	if _current_state == RuntimeDataTypes.UI_OVERLAY:
		var overlay_names := _panels.keys()
		overlay_names.reverse()
		for name: String in overlay_names:
			var entry: Dictionary = _panels[name]
			if _panel_is_open(entry.panel) and entry.overlaysGameState:
				close_panel(name, {"silent": true})
				if _event_bus != null:
					_event_bus.emit("ui:cancel", {"name": name})
				return
	var names := _panels.keys()
	names.reverse()
	for name: String in names:
		var entry: Dictionary = _panels[name]
		if _panel_is_open(entry.panel) and not entry.overlaysGameState:
			close_panel(name, {"silent": true})
			if _event_bus != null:
				_event_bus.emit("ui:cancel", {"name": name})
			return
	if _current_state == RuntimeDataTypes.EXPLORING and _escape_fallback.is_valid():
		_escape_fallback.call()


func destroy() -> void:
	close_all_panels()
	for entry: Dictionary in _panels.values():
		if entry.panel.has_method("destroy"):
			entry.panel.call("destroy")
	_panels.clear()
	_overlay_return_stack.clear()
	if _unsubscribe_key_down.is_valid():
		_unsubscribe_key_down.call()
	_unsubscribe_key_down = Callable()


static func _panel_is_open(panel: Variant) -> bool:
	if panel.has_method("is_open"):
		return panel.call("is_open") == true
	return panel.get("is_open") == true


static func _prevent_default(event: Dictionary) -> void:
	var callback: Variant = event.get("preventDefault")
	if callback is Callable and callback.is_valid():
		callback.call()


static func _js_boolean(value: Variant) -> bool:
	if value == null:
		return false
	if value is bool:
		return value
	if value is int or value is float:
		return is_finite(float(value)) and float(value) != 0.0
	if value is String:
		return not value.is_empty()
	return true
