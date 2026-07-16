class_name RuntimePressureHoldManager
extends RuntimeSystem

const DEFS_URL := "/assets/data/pressure_holds.json"
const DEFAULT_DECAY_PER_SECOND := 0.6
const RuntimeMicrotaskQueueScript := preload("res://scripts/runtime/microtask_queue.gd")

var action_executor: RuntimeActionExecutor
var asset_manager: RuntimeAssetManager
var binding: Variant = null
var defs: Dictionary = {}
var running := false


func _init(next_action_executor: RuntimeActionExecutor) -> void:
	action_executor = next_action_executor


func init(ctx: Dictionary) -> void:
	asset_manager = ctx.get("assetManager")


func update(_dt: float) -> void:
	return


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	return


func destroy() -> void:
	defs.clear()
	binding = null
	running = false


func bind_runtime(next_binding: Dictionary) -> void:
	binding = next_binding


func load_defs() -> void:
	var loaded: Variant = asset_manager.load_json(DEFS_URL) if asset_manager != null else null
	await RuntimeMicrotaskQueueScript.yield_turn()
	if not loaded is Array:
		push_warning("PressureHoldManager: pressure_holds.json not found")
		return
	for definition: Variant in loaded:
		if not definition is Dictionary or not _validate_def(definition):
			var invalid_id: Variant = definition.get("id") if definition is Dictionary else null
			push_warning("PressureHoldManager: 配置 \"%s\" 非法，已跳过" % str(invalid_id))
			continue
		defs[definition.id] = definition


func run_until_done(id: String) -> Variant:
	var definition: Variant = defs.get(id)
	if not definition is Dictionary:
		push_warning("PressureHoldManager: unknown pressure hold \"%s\"" % id)
		return "completed"
	if not binding is Dictionary:
		push_warning("PressureHoldManager: runtime 未绑定（bindRuntime）")
		return "completed"
	if running:
		push_warning("PressureHoldManager: 已有长按交互进行中，忽略 \"%s\"" % id)
		return "completed"
	running = true
	var result: Variant = await _run_flow(definition, binding)
	running = false
	return result


func get_debug_preview_request(id: String) -> Variant:
	var definition: Variant = defs.get(id)
	var current_binding: Variant = binding
	if not definition is Dictionary or not current_binding is Dictionary:
		return null
	var interrupts: Array = definition.get("interrupts", []).duplicate(false) if definition.get("interrupts") is Array else []
	interrupts.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return float(a.atRatio) < float(b.atRatio))
	var request := {
		"prompt": str(current_binding.resolveDisplayText.call(definition.prompt)),
		"startRatio": 0.0,
		"stopRatio": interrupts[0].atRatio if not interrupts.is_empty() else 1.0,
		"fillSeconds": definition.fillSeconds,
		"decayPerSecond": definition.decayPerSecond if definition.get("decayPerSecond") != null else DEFAULT_DECAY_PER_SECOND,
	}
	if definition.get("releaseHint"):
		request.releaseHint = str(current_binding.resolveDisplayText.call(definition.releaseHint))
	var bar_color: Variant = parse_hex_color(definition.get("barColor"))
	if bar_color != null:
		request.barColor = bar_color
	if definition.has("abortOnReleaseFromRatio"):
		request.abortOnReleaseFromRatio = definition.abortOnReleaseFromRatio
	return request


func _run_flow(definition: Dictionary, current_binding: Dictionary) -> Variant:
	var raw_interrupts: Variant = definition.get("interrupts")
	if raw_interrupts != null and not raw_interrupts is Array:
		# TypeScript's spread rejects a non-array here. `false` is the translated
		# rejected-Promise channel used by RuntimeActionExecutor.
		return false
	var interrupts: Array = raw_interrupts.duplicate(false) if raw_interrupts is Array else []
	interrupts.sort_custom(func(a: Dictionary, b: Dictionary) -> bool: return float(a.atRatio) < float(b.atRatio))
	var prompt := str(current_binding.resolveDisplayText.call(definition.prompt))
	var release_hint: Variant = str(current_binding.resolveDisplayText.call(definition.releaseHint)) if definition.get("releaseHint") else null
	var bar_color: Variant = parse_hex_color(definition.get("barColor"))
	var decay: Variant = definition.decayPerSecond if definition.get("decayPerSecond") != null else DEFAULT_DECAY_PER_SECOND

	if definition.get("holdSfx"):
		if not await action_executor.execute_await({"type": "playSfx", "params": {"id": definition.holdSfx}}):
			return false

	var start_ratio := 0.0
	for interrupt: Dictionary in interrupts:
		var request := {
			"prompt": prompt,
			"releaseHint": release_hint,
			"barColor": bar_color,
			"startRatio": start_ratio,
			"stopRatio": interrupt.atRatio,
			"fillSeconds": definition.fillSeconds,
			"decayPerSecond": decay,
			"abortOnReleaseFromRatio": definition.get("abortOnReleaseFromRatio"),
		}
		var segment: Variant = await current_binding.runSegment.call(request)
		if segment is bool and segment == false:
			return false
		if segment == "released":
			return await _finish_aborted(definition)
		var interrupt_actions: Variant = interrupt.get("actions")
		if interrupt_actions == null:
			interrupt_actions = []
		if not interrupt_actions is Array or not await action_executor.execute_batch_await(interrupt_actions):
			return false
		if interrupt.get("abort"):
			return "aborted"
		var reset: Variant = interrupt.get("resetToRatio")
		start_ratio = RuntimeHoldProgress.clamp01(float(reset if reset != null else 0))

	var final_request := {
		"prompt": prompt,
		"releaseHint": release_hint,
		"barColor": bar_color,
		"startRatio": start_ratio,
		"stopRatio": 1.0,
		"fillSeconds": definition.fillSeconds,
		"decayPerSecond": decay,
		"abortOnReleaseFromRatio": definition.get("abortOnReleaseFromRatio"),
	}
	var last_segment: Variant = await current_binding.runSegment.call(final_request)
	if last_segment is bool and last_segment == false:
		return false
	if last_segment == "released":
		return await _finish_aborted(definition)
	var on_complete: Variant = definition.get("onComplete")
	if on_complete:
		if not on_complete is Array or not await action_executor.execute_batch_await(on_complete):
			return false
	return "completed"


func _finish_aborted(definition: Dictionary) -> Variant:
	var on_aborted: Variant = definition.get("onAborted")
	if on_aborted:
		if not on_aborted is Array or not await action_executor.execute_batch_await(on_aborted):
			return false
	return "aborted"


func _validate_def(definition: Dictionary) -> bool:
	if not definition.get("id") is String or definition.id.strip_edges().is_empty():
		return false
	if not _js_number(definition.get("fillSeconds")) > 0.0:
		return false
	if definition.has("abortOnReleaseFromRatio"):
		var release_abort := _js_number(definition.abortOnReleaseFromRatio)
		if not (release_abort > 0.0 and release_abort < 1.0):
			return false
	var raw_interrupts: Variant = definition.get("interrupts")
	if raw_interrupts != null and not raw_interrupts is Array:
		return false
	var interrupts: Array = raw_interrupts if raw_interrupts is Array else []
	return RuntimeHoldProgress.validate_interrupt_chain(interrupts)


static func parse_hex_color(raw: Variant) -> Variant:
	var value := ("" if raw == null else str(raw)).strip_edges()
	var regex := RegEx.new()
	if regex.compile("^#[0-9a-fA-F]{6}$") != OK or regex.search(value) == null:
		return null
	return value.substr(1).hex_to_int()


static func _js_number(value: Variant) -> float:
	if value == null:
		return 0.0
	if value is bool:
		return 1.0 if value else 0.0
	if value is int or value is float:
		return float(value)
	var text := str(value).strip_edges()
	if text.is_empty():
		return 0.0
	if text.to_lower().begins_with("0x") and text.substr(2).is_valid_hex_number():
		return float(text.substr(2).hex_to_int())
	return text.to_float() if text.is_valid_float() else NAN
