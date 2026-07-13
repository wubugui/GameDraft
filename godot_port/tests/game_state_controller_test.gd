extends SceneTree

class FakePanel:
	extends RefCounted
	var is_open := false
	var allow_open := true
	var destroyed := false

	func open() -> void:
		is_open = allow_open

	func close() -> void:
		is_open = false

	func destroy() -> void:
		destroyed = true


class FakeInput:
	extends RefCounted
	var callback := Callable()
	var unsubscribed := false

	func subscribe_key_down(next: Callable) -> Callable:
		callback = next
		return func() -> void:
			callback = Callable()
			unsubscribed = true

	func send(code: String, repeat: bool = false, prevent: Callable = Callable()) -> void:
		callback.call({"code": code, "repeat": repeat, "preventDefault": prevent})


var events: Array[String] = []
var fallback_count := 0
var guard_allows := false
var prevent_count := 0


func _init() -> void:
	assert(RuntimeGameStateController.STATES == [
		"MainMenu", "Exploring", "ActionSequence", "Dialogue",
		"Encounter", "Cutscene", "UIOverlay", "Minigame",
	])
	var input := FakeInput.new()
	var bus := RuntimeEventBus.new()
	bus.on("ui:panelOpen", func(payload: Variant) -> void: events.push_back("open:" + payload.name))
	bus.on("ui:panelClose", func(payload: Variant) -> void: events.push_back("close:" + payload.name))
	bus.on("ui:cancel", func(payload: Variant) -> void: events.push_back("cancel:" + payload.name))
	var controller := RuntimeGameStateController.new(input, bus)
	controller.set_escape_fallback(func() -> void: fallback_count += 1)
	assert(controller.set_state(RuntimeGameStateController.DIALOGUE))
	assert(controller.current_state == "Dialogue" and controller.previous_state == "Exploring")
	controller.restore_previous_state()
	assert(controller.current_state == "Exploring")

	var inventory := FakePanel.new()
	var nested := FakePanel.new()
	var rejected := FakePanel.new()
	rejected.allow_open = false
	var guarded := FakePanel.new()
	var debug := FakePanel.new()
	assert(controller.register_panel("inventory", inventory, "KeyI"))
	assert(controller.register_panel("nested", nested, "KeyN", {"alwaysOpenable": true, "additionalKeys": ["KeyO"]}))
	assert(controller.register_panel("rejected", rejected, "KeyX"))
	assert(controller.register_panel("guarded", guarded, "KeyG", {"openGuard": func() -> bool: return guard_allows}))
	assert(controller.register_panel("debug", debug, "F2", {"alwaysOpenable": true, "overlaysGameState": false}))

	input.send("KeyI", false, func() -> void: prevent_count += 1)
	assert(inventory.is_open and controller.current_state == "UIOverlay" and controller.overlay_depth() == 1)
	input.send("KeyO")
	assert(nested.is_open and controller.overlay_depth() == 2)
	controller.trigger_escape_from_touch()
	assert(not nested.is_open and inventory.is_open and controller.current_state == "UIOverlay")
	controller.trigger_escape_from_touch()
	assert(not inventory.is_open and controller.current_state == "Exploring" and controller.overlay_depth() == 0)
	assert(events.slice(-2) == ["cancel:nested", "cancel:inventory"])

	input.send("KeyX")
	assert(not rejected.is_open and controller.current_state == "Exploring" and controller.overlay_depth() == 0)
	input.send("KeyG")
	assert(not guarded.is_open)
	guard_allows = true
	input.send("KeyG")
	assert(guarded.is_open)
	controller.close_panel("guarded")
	assert(events.slice(-1) == ["close:guarded"])

	controller.toggle_panel("inventory")
	controller.toggle_panel("debug")
	assert(inventory.is_open and debug.is_open and controller.current_state == "UIOverlay")
	input.send("Escape")
	assert(not debug.is_open and inventory.is_open and controller.current_state == "UIOverlay")
	input.send("Escape")
	assert(not inventory.is_open and controller.current_state == "Exploring")
	input.send("Escape")
	assert(fallback_count == 1)
	input.send("KeyI", true)
	assert(not inventory.is_open)
	assert(prevent_count == 1)

	controller.destroy()
	assert(inventory.destroyed and nested.destroyed and rejected.destroyed and guarded.destroyed and debug.destroyed)
	assert(input.unsubscribed)
	print("GameStateController parity test: PASS")
	quit(0)
