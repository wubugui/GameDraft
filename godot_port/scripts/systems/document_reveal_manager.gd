class_name RuntimeDocumentRevealManager
extends RuntimeSystem

const DEFINITIONS_URL := "/assets/data/document_reveals.json"

var _asset_manager: RuntimeAssetManager
var _event_bus: RuntimeEventBus
var _flag_store: RuntimeFlagStore
var _quest_manager: RuntimeQuestManager
var _scenario_state: RuntimeScenarioStateManager
var _defs: Dictionary = {}
var _revealed: Dictionary = {}
var _revealing: Dictionary = {}
var _blend := Callable()
var _resolve_condition_literal := Callable()
var _condition_context_factory := Callable()


func _init(asset_manager: RuntimeAssetManager, event_bus: RuntimeEventBus, flag_store: RuntimeFlagStore, quest_manager: RuntimeQuestManager, scenario_state: RuntimeScenarioStateManager) -> void:
	_asset_manager = asset_manager; _event_bus = event_bus; _flag_store = flag_store; _quest_manager = quest_manager; _scenario_state = scenario_state


func init(_ctx: Dictionary) -> void: return
func update(_dt: float) -> void: return
func set_blend_executor(callback: Callable = Callable()) -> void: _blend = callback
func set_resolve_condition_literal(callback: Callable = Callable()) -> void: _resolve_condition_literal = callback
func set_condition_eval_context_factory(factory: Callable = Callable()) -> void: _condition_context_factory = factory


func load_definitions() -> bool:
	var list: Variant = _asset_manager.load_json(DEFINITIONS_URL)
	return load_definitions_from_data(list) if list is Array else false


func load_definitions_from_data(list: Array) -> bool:
	_defs.clear()
	for raw: Variant in list:
		if raw is Dictionary:
			var id := str(raw.get("id", "")).strip_edges()
			if not id.is_empty(): _defs[id] = raw
	return true


func get_document_phase(document_id: String) -> String:
	var id := document_id.strip_edges()
	if id.is_empty() or not _defs.has(id): return "hidden"
	if _revealed.has(id): return "revealed"
	if _revealing.has(id): return "revealing"
	return "blurred"


func get_display_image(document_id: String) -> Variant:
	var id := document_id.strip_edges(); var definition: Variant = _defs.get(id)
	if not definition is Dictionary: return null
	return definition.get("clearImagePath") if _revealed.has(id) else definition.get("blurredImagePath")


func is_revealed(document_id: String) -> bool: return _revealed.has(document_id.strip_edges())


func check_and_reveal(document_id: String) -> void:
	var id := document_id.strip_edges(); var definition: Variant = _defs.get(id)
	if not definition is Dictionary or _revealed.has(id) or _revealing.has(id): return
	var context := _condition_context()
	var evaluator := RuntimeConditionEvaluator.new()
	if not evaluator.evaluate(definition.get("revealCondition"), context): return
	if _blend.is_null() or not _blend.is_valid(): return
	var overlay_id := str(definition.get("overlayId", "")).strip_edges()
	if overlay_id.is_empty(): overlay_id = "docReveal_%s" % _safe_id(id)
	_revealing[id] = true
	_event_bus.emit("document:revealed", {"documentId": id})
	await _blend.call(
		overlay_id,
		str(definition.get("blurredImagePath", "")),
		str(definition.get("clearImagePath", "")),
		float(definition.get("xPercent", 50.0)),
		float(definition.get("yPercent", 50.0)),
		float(definition.get("widthPercent", 40.0)),
		float(definition.get("animation", {}).get("durationMs", 2000.0)),
		float(definition.get("animation", {}).get("delayMs", 0.0)),
	)
	_revealed[id] = true
	var revealed_flag := str(definition.get("revealedFlag", "")).strip_edges()
	if not revealed_flag.is_empty(): _flag_store.set_value(revealed_flag, true)
	_revealing.erase(id)


func debug_snapshot() -> Dictionary:
	var phases := {}
	for id: String in _defs: phases[id] = get_document_phase(id)
	return {"revealedInSave": _revealed.keys(), "revealingTransient": _revealing.keys(), "phaseByDefId": phases}


func serialize() -> Dictionary: return {"revealed": _revealed.keys()}


func deserialize(data: Dictionary) -> void:
	_revealed.clear(); _revealing.clear()
	if data.get("revealed") is Array:
		for raw: Variant in data.revealed:
			if raw is String and not raw.strip_edges().is_empty(): _revealed[raw.strip_edges()] = true


func destroy() -> void:
	_defs.clear(); _revealed.clear(); _revealing.clear(); _blend = Callable(); _resolve_condition_literal = Callable(); _condition_context_factory = Callable()


func definition_count() -> int: return _defs.size()
func debug_snapshot_fragment() -> Dictionary: return {"documentReveal": debug_snapshot()}


func _condition_context() -> Dictionary:
	if not _condition_context_factory.is_null() and _condition_context_factory.is_valid():
		var injected: Variant = _condition_context_factory.call()
		if injected is Dictionary: return injected
	var context := {"flagStore": _flag_store, "questManager": _quest_manager, "scenarioState": _scenario_state}
	if not _resolve_condition_literal.is_null() and _resolve_condition_literal.is_valid(): context["resolveConditionLiteral"] = _resolve_condition_literal
	return context


func _safe_id(id: String) -> String:
	var regex := RegEx.new(); regex.compile("[^a-zA-Z0-9_-]")
	return regex.sub(id, "_", true)
