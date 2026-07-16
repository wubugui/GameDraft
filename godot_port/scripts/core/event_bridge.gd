class_name RuntimeEventBridge
extends RefCounted

const RuntimeDataTypes := preload("res://scripts/data/data_types.gd")

var _event_bus: RuntimeEventBus
var _deps: Dictionary
var _bound_callbacks: Array[Dictionary] = []
var _has_started_session := false


func _init(event_bus: RuntimeEventBus, deps: Dictionary) -> void:
	_event_bus = event_bus
	_deps = deps


func init() -> void:
	var dialogue_manager: RuntimeDialogueManager = _deps.dialogueManager
	var graph_dialogue_manager: RuntimeGraphDialogueManager = _deps.graphDialogueManager
	var encounter_manager: RuntimeEncounterManager = _deps.encounterManager
	var state_controller: RuntimeGameStateController = _deps.stateController
	var action_executor: RuntimeActionExecutor = _deps.actionExecutor
	var map_ui: RuntimeMapUI = _deps.mapUI
	var menu_ui: RuntimeMenuUI = _deps.menuUI
	var inspect_box: RuntimeInspectBox = _deps.inspectBox

	_listen("dialogue:advance", func(_payload: Variant = null) -> void:
		if dialogue_manager.is_active():
			await dialogue_manager.advance()
		else:
			await graph_dialogue_manager.advance()
	)
	_listen("dialogue:advanceEnd", func(_payload: Variant = null) -> void:
		if dialogue_manager.is_active():
			dialogue_manager.end_dialogue()
		elif graph_dialogue_manager.is_active():
			graph_dialogue_manager.end_dialogue()
	)
	_listen("dialogue:choiceSelected", func(payload: Dictionary) -> void:
		_event_bus.emit("ui:confirm", {})
		if dialogue_manager.is_active():
			await dialogue_manager.choose_option(int(payload.index))
		else:
			await graph_dialogue_manager.choose_option(int(payload.index))
	)
	_listen("dialogue:end", func(payload: Variant = null) -> void:
		if dialogue_manager.is_active() or graph_dialogue_manager.is_active():
			return
		if payload is Dictionary and payload.get("willContinue") == true:
			return
		state_controller.set_state(RuntimeDataTypes.EXPLORING)
	)

	_listen("encounter:narrativeDone", func(_payload: Variant = null) -> void:
		encounter_manager.generate_options()
	)
	_listen("encounter:choiceSelected", func(payload: Dictionary) -> void:
		_event_bus.emit("ui:confirm", {})
		var result: Variant = await encounter_manager.choose_option(int(payload.index))
		if result is bool and result == false:
			push_warning("EventBridge: encounter chooseOption failed")
	)
	_listen("encounter:resultDone", func(_payload: Variant = null) -> void:
		encounter_manager.end_encounter()
	)
	_listen("encounter:end", func(_payload: Variant = null) -> void:
		state_controller.set_state(RuntimeDataTypes.EXPLORING)
	)

	_listen("shop:purchase", func(payload: Dictionary) -> void:
		if not await action_executor.execute_await({"type": "shopPurchase", "params": {"itemId": payload.itemId, "price": payload.price}}):
			push_warning("EventBridge: shopPurchase failed")
	)
	_listen("inventory:discard", func(payload: Dictionary) -> void:
		if not await action_executor.execute_await({"type": "inventoryDiscard", "params": {"itemId": payload.itemId}}):
			push_warning("EventBridge: inventoryDiscard failed")
	)
	_listen("shop:closed", func(_payload: Variant = null) -> void:
		state_controller.set_state(RuntimeDataTypes.EXPLORING)
	)

	_listen("map:travel", func(payload: Dictionary) -> void:
		if state_controller.current_state == RuntimeDataTypes.UI_OVERLAY:
			state_controller.restore_previous_state()
		if not bool(_deps.guardMapTravel.call()):
			return
		if not await action_executor.execute_await({"type": "switchScene", "params": {"targetScene": payload.sceneId}}):
			push_warning("EventBridge: map:travel switchScene action failed")
	)

	_listen("menu:newGame", func(_payload: Variant = null) -> void:
		if _has_started_session:
			_restart_page_for_new_game()
			return
		_has_started_session = true
		menu_ui.close()
		state_controller.set_state(RuntimeDataTypes.EXPLORING)
	)
	_listen("menu:returnToMain", func(_payload: Variant = null) -> void:
		_has_started_session = true
		state_controller.set_state(RuntimeDataTypes.MAIN_MENU)
		menu_ui.open_main_menu()
	)
	_listen("menu:resume", func(_payload: Variant = null) -> void:
		if state_controller.current_state == RuntimeDataTypes.UI_OVERLAY:
			state_controller.restore_previous_state()
	)

	_listen("scene:enter", func(payload: Dictionary) -> void:
		map_ui.set_current_scene(str(payload.sceneId))
	)

	_listen("ruleUse:apply", func(payload: Dictionary) -> void:
		state_controller.close_panel("ruleUse")
		if not await action_executor.execute_batch_await(payload.actions):
			push_warning("EventBridge: ruleUse:apply actions failed")
		if not await action_executor.execute_await({"type": "setFlag", "params": {"key": RuntimeFlagKeys.rule_used(str(payload.ruleId)), "value": true}}):
			return
		var result_text := str(payload.get("resultText", ""))
		if not result_text.is_empty():
			state_controller.set_state(RuntimeDataTypes.UI_OVERLAY)
			await inspect_box.show(result_text)
			if state_controller.current_state == RuntimeDataTypes.UI_OVERLAY:
				state_controller.set_state(RuntimeDataTypes.EXPLORING)
	)


func _restart_page_for_new_game() -> void:
	# Godot has no browser URL query string. Reloading the bootstrap scene is the
	# platform counterpart of window.location.reload() for this shell.
	Engine.get_main_loop().reload_current_scene()


func _listen(event: String, fn: Callable) -> void:
	_event_bus.on(event, fn)
	_bound_callbacks.push_back({"event": event, "fn": fn})


func destroy() -> void:
	for binding: Dictionary in _bound_callbacks:
		_event_bus.off(str(binding.event), binding.fn)
	_bound_callbacks = []
