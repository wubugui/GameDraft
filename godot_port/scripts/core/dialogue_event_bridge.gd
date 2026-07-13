class_name RuntimeDialogueEventBridge
extends RefCounted

var event_bus: RuntimeEventBus
var graph_dialogue: RuntimeGraphDialogueManager
var scripted_dialogue: RuntimeDialogueManager
var encounter_manager: RuntimeEncounterManager
var state_controller: RuntimeGameStateController
var _destroyed := false


func _init(events: RuntimeEventBus, graph: RuntimeGraphDialogueManager, scripted: RuntimeDialogueManager, encounter: RuntimeEncounterManager, state: RuntimeGameStateController) -> void:
	event_bus = events; graph_dialogue = graph; scripted_dialogue = scripted; encounter_manager = encounter; state_controller = state
	event_bus.on("dialogue:advance", Callable(self, "_on_advance")); event_bus.on("dialogue:advanceEnd", Callable(self, "_on_advance_end")); event_bus.on("dialogue:choiceSelected", Callable(self, "_on_choice")); event_bus.on("dialogue:end", Callable(self, "_on_end")); event_bus.on("encounter:narrativeDone", Callable(self, "_on_encounter_narrative_done")); event_bus.on("encounter:choiceSelected", Callable(self, "_on_encounter_choice")); event_bus.on("encounter:resultDone", Callable(self, "_on_encounter_result_done")); event_bus.on("encounter:end", Callable(self, "_on_encounter_end"))


func destroy() -> void:
	if _destroyed: return
	_destroyed = true; event_bus.off("dialogue:advance", Callable(self, "_on_advance")); event_bus.off("dialogue:advanceEnd", Callable(self, "_on_advance_end")); event_bus.off("dialogue:choiceSelected", Callable(self, "_on_choice")); event_bus.off("dialogue:end", Callable(self, "_on_end")); event_bus.off("encounter:narrativeDone", Callable(self, "_on_encounter_narrative_done")); event_bus.off("encounter:choiceSelected", Callable(self, "_on_encounter_choice")); event_bus.off("encounter:resultDone", Callable(self, "_on_encounter_result_done")); event_bus.off("encounter:end", Callable(self, "_on_encounter_end"))


func _on_advance(_payload: Variant = null) -> void:
	if scripted_dialogue.is_active(): scripted_dialogue.advance()
	elif graph_dialogue.is_active(): graph_dialogue.advance()
func _on_advance_end(_payload: Variant = null) -> void:
	if scripted_dialogue.is_active(): scripted_dialogue.end_dialogue()
	elif graph_dialogue.is_active(): graph_dialogue.end_dialogue()
func _on_choice(payload: Variant) -> void:
	if not payload is Dictionary: return
	event_bus.emit("ui:confirm", {})
	if scripted_dialogue.is_active(): scripted_dialogue.choose_option(int(payload.get("index", -1)))
	elif graph_dialogue.is_active(): graph_dialogue.choose_option(int(payload.get("index", -1)))
func _on_end(payload: Variant) -> void:
	if scripted_dialogue.is_active() or graph_dialogue.is_active(): return
	if payload is Dictionary and payload.get("willContinue") == true: return
	state_controller.set_state(RuntimeGameStateController.EXPLORING)
func _on_encounter_narrative_done(_payload: Variant = null) -> void: encounter_manager.generate_options()
func _on_encounter_choice(payload: Variant) -> void:
	if payload is Dictionary: event_bus.emit("ui:confirm", {}); encounter_manager.choose_option(int(payload.get("index", -1)))
func _on_encounter_result_done(_payload: Variant = null) -> void: encounter_manager.end_encounter()
func _on_encounter_end(_payload: Variant = null) -> void: state_controller.set_state(RuntimeGameStateController.EXPLORING)
