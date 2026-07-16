class_name RuntimeDocumentRevealManager
extends RuntimeSystem

const DOCUMENT_REVEALS_URL := "/assets/data/document_reveals.json"
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")

var asset_manager: RuntimeAssetManager
var event_bus: RuntimeEventBus
var flag_store: RuntimeFlagStore
var quest_manager: RuntimeQuestManager
var scenario_state: RuntimeScenarioStateManager
var defs: Dictionary = {}
var revealed: Dictionary = {}
var revealing: Dictionary = {}
var blend := Callable()
var resolve_condition_literal := Callable()
var condition_ctx_factory := Callable()


func _init(
		initial_asset_manager: RuntimeAssetManager,
		initial_event_bus: RuntimeEventBus,
		initial_flag_store: RuntimeFlagStore,
		initial_quest_manager: RuntimeQuestManager,
		initial_scenario_state: RuntimeScenarioStateManager
) -> void:
	asset_manager = initial_asset_manager
	event_bus = initial_event_bus
	flag_store = initial_flag_store
	quest_manager = initial_quest_manager
	scenario_state = initial_scenario_state


func set_blend_executor(fn: Callable) -> void:
	blend = fn


func set_resolve_condition_literal(fn: Callable = Callable()) -> void:
	resolve_condition_literal = fn


func set_condition_eval_context_factory(factory: Callable = Callable()) -> void:
	condition_ctx_factory = factory


func load_definitions() -> void:
	defs.clear()
	if asset_manager == null:
		push_warning("DocumentRevealManager: 无法加载 document_reveals.json")
		return
	var list: Variant = asset_manager.load_json(DOCUMENT_REVEALS_URL)
	# AssetManager.loadJson is a Promise in the source. Local Godot reads are
	# synchronous, so this is the language-level await continuation boundary.
	await RuntimeMicrotaskQueueScript.yield_turn()
	if list == null and not asset_manager.get_last_error().is_empty():
		push_warning("DocumentRevealManager: 无法加载 document_reveals.json: %s" % asset_manager.get_last_error())
		return
	if not list is Array:
		return
	for definition: Variant in list:
		if definition is Dictionary and definition.get("id") is String:
			var id: String = definition.id.strip_edges()
			if not id.is_empty():
				# Map.set stores the source definition object itself; do not clone it.
				defs[id] = definition


func init(_ctx: Dictionary) -> void:
	return


func update(_dt: float) -> void:
	return


func destroy() -> void:
	defs.clear()
	revealed.clear()
	revealing.clear()
	# These closures retain CutsceneManager/Game-side references in the source.
	blend = Callable()
	resolve_condition_literal = Callable()
	condition_ctx_factory = Callable()


func _ctx() -> Dictionary:
	if condition_ctx_factory.is_valid():
		var injected: Variant = condition_ctx_factory.call()
		if injected is Dictionary:
			return injected
	var base := {
		"flagStore": flag_store,
		"questManager": quest_manager,
		"scenarioState": scenario_state,
	}
	if resolve_condition_literal.is_valid():
		base.resolveConditionLiteral = resolve_condition_literal
	return base


func _overlay_id_for(definition: Dictionary) -> String:
	var raw_overlay_id: Variant = definition.get("overlayId")
	if raw_overlay_id is String:
		var overlay_id: String = raw_overlay_id.strip_edges()
		if not overlay_id.is_empty():
			return overlay_id
	var id := str(definition.get("id", "")).strip_edges()
	var regex := RegEx.new()
	regex.compile("[^a-zA-Z0-9_-]")
	return "docReveal_%s" % regex.sub(id, "_", true)


func get_document_phase(document_id: String) -> String:
	var id := document_id.strip_edges()
	if id.is_empty() or not defs.has(id):
		return "hidden"
	if revealed.has(id):
		return "revealed"
	if revealing.has(id):
		return "revealing"
	return "blurred"


func get_display_image(document_id: String) -> Variant:
	var id := document_id.strip_edges()
	var definition: Variant = defs.get(id)
	if not definition is Dictionary:
		return null
	return definition.get("clearImagePath") if revealed.has(id) else definition.get("blurredImagePath")


func is_revealed(document_id: String) -> bool:
	return revealed.has(document_id.strip_edges())


func check_and_reveal(document_id: String) -> void:
	var id := document_id.strip_edges()
	var definition: Variant = defs.get(id)
	if not definition is Dictionary:
		push_warning("DocumentRevealManager: 未知 documentId %s" % id)
		return
	if revealed.has(id):
		return
	if revealing.has(id):
		return
	if not RuntimeConditionEvaluator.evaluate(definition.get("revealCondition"), _ctx()):
		return
	var blend_fn := blend
	if not blend_fn.is_valid():
		push_warning("DocumentRevealManager: blend 未注入")
		return

	var overlay_id := _overlay_id_for(definition)
	var x: Variant = definition.get("xPercent")
	if x == null:
		x = 50
	var y: Variant = definition.get("yPercent")
	if y == null:
		y = 50
	var width: Variant = definition.get("widthPercent")
	if width == null:
		width = 40
	var animation: Variant = definition.get("animation")
	var duration: Variant = animation.get("durationMs") if animation is Dictionary else null
	if duration == null:
		duration = 2000
	var delay: Variant = animation.get("delayMs") if animation is Dictionary else null
	if delay == null:
		delay = 0

	revealing[id] = true
	event_bus.emit("document:revealed", {"documentId": id})
	var blend_result: Variant = await blend_fn.call(
		overlay_id,
		definition.get("blurredImagePath"),
		definition.get("clearImagePath"),
		x,
		y,
		width,
		duration,
		delay,
	)
	# `await blendFn(...)` resumes through a Promise reaction even for an already
	# settled callback; false is the target adapter's rejected-Promise channel.
	await RuntimeMicrotaskQueueScript.yield_turn()
	if blend_result is bool and blend_result == false:
		push_warning("DocumentRevealManager: reveal %s failed" % id)
	else:
		revealed[id] = true
		var revealed_flag: Variant = definition.get("revealedFlag")
		if revealed_flag is String:
			var flag_id: String = revealed_flag.strip_edges()
			if not flag_id.is_empty():
				flag_store.set_value(flag_id, true)
	revealing.erase(id)


func debug_snapshot() -> Dictionary:
	var phase_by_def_id := {}
	for id: String in defs:
		phase_by_def_id[id] = get_document_phase(id)
	return {
		"revealedInSave": revealed.keys(),
		"revealingTransient": revealing.keys(),
		"phaseByDefId": phase_by_def_id,
	}


func serialize() -> Dictionary:
	return {"revealed": revealed.keys()}


func deserialize(data: Dictionary) -> void:
	revealed.clear()
	revealing.clear()
	var raw: Variant = data.get("revealed")
	if not raw is Array:
		return
	for value: Variant in raw:
		if value is String:
			var id: String = value.strip_edges()
			if not id.is_empty():
				revealed[id] = true
