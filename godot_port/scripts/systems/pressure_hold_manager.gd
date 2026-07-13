class_name RuntimePressureHoldManager
extends RuntimeSystem

const DEFS_URL := "/assets/data/pressure_holds.json"
const DEFAULT_DECAY_PER_SECOND := 0.6
const COMPLETED := "completed"
const ABORTED := "aborted"
const FAILED := "failed"

var action_executor: RuntimeActionExecutor
var asset_manager: RuntimeAssetManager
var defs: Dictionary = {}
var running := false
var _run_segment := Callable()
var _resolve_display_text := Callable()
var _cancel_segment := Callable()


func _init(actions: RuntimeActionExecutor) -> void:
	action_executor = actions


func init(ctx: Dictionary) -> void:
	asset_manager = ctx.get("assetManager")


func bind_runtime(binding: Dictionary) -> void:
	_run_segment = binding.get("runSegment", Callable())
	_resolve_display_text = binding.get("resolveDisplayText", Callable())
	_cancel_segment = binding.get("cancelSegment", Callable())


func load_defs() -> bool:
	var raw: Variant = asset_manager.load_json(DEFS_URL) if asset_manager != null else null
	if not raw is Array:
		return false
	defs.clear()
	for value: Variant in raw:
		if value is Dictionary and _validate_def(value):
			var definition: Dictionary = value
			defs[str(definition.id).strip_edges()] = definition.duplicate(true)
	return not defs.is_empty()


func register_def_for_test(definition: Dictionary) -> bool:
	if not _validate_def(definition):
		return false
	defs[str(definition.id).strip_edges()] = definition.duplicate(true)
	return true


func has_def(id: String) -> bool:
	return defs.has(id.strip_edges())


func get_def_count() -> int:
	return defs.size()


func is_running() -> bool:
	return running


func get_debug_preview_request(id: String) -> Variant:
	var definition: Variant = defs.get(id.strip_edges())
	if not definition is Dictionary: return null
	var interrupts: Array = definition.get("interrupts", []).duplicate(true) if definition.get("interrupts") is Array else []
	interrupts.sort_custom(func(a: Variant, b: Variant) -> bool: return float(a.get("atRatio", 0)) < float(b.get("atRatio", 0)))
	var stop_ratio := float(interrupts[0].atRatio) if not interrupts.is_empty() else 1.0
	var prompt := _resolve_text(str(definition.get("prompt", "")))
	var release_hint: Variant = _resolve_text(str(definition.releaseHint)) if definition.has("releaseHint") else null
	var bar_color: Variant = parse_hex_color(definition.get("barColor"))
	var decay := float(definition.get("decayPerSecond", DEFAULT_DECAY_PER_SECOND))
	return _make_segment_request(definition, prompt, release_hint, bar_color, decay, 0.0, stop_ratio)


func run_until_done(id: String) -> String:
	var definition: Variant = defs.get(id.strip_edges())
	if not definition is Dictionary or _run_segment.is_null() or not _run_segment.is_valid() or running:
		return COMPLETED
	running = true
	var outcome := await _run_flow(definition)
	running = false
	return outcome


func _run_flow(definition: Dictionary) -> String:
	var interrupts: Array = definition.get("interrupts", []).duplicate(true) if definition.get("interrupts") is Array else []
	interrupts.sort_custom(func(a: Variant, b: Variant) -> bool: return float(a.get("atRatio", 0)) < float(b.get("atRatio", 0)))
	var prompt := _resolve_text(str(definition.get("prompt", "")))
	var release_hint: Variant = _resolve_text(str(definition.releaseHint)) if definition.has("releaseHint") else null
	var bar_color: Variant = parse_hex_color(definition.get("barColor"))
	var decay := float(definition.get("decayPerSecond", DEFAULT_DECAY_PER_SECOND))
	if not str(definition.get("holdSfx", "")).strip_edges().is_empty():
		await action_executor.execute_await({"type": "playSfx", "params": {"id": str(definition.holdSfx)}})
	var start_ratio := 0.0
	for value: Variant in interrupts:
		var interrupt: Dictionary = value
		var outcome: Variant = await _run_segment.call(_make_segment_request(definition, prompt, release_hint, bar_color, decay, start_ratio, float(interrupt.atRatio)))
		if outcome == "invalid": return FAILED
		if outcome == "released":
			return await _finish_aborted(definition)
		await action_executor.execute_batch_await(_action_list(interrupt.get("actions")))
		if interrupt.get("abort") == true:
			return ABORTED
		start_ratio = clampf(float(interrupt.get("resetToRatio", 0)), 0.0, 1.0)
	var final_outcome: Variant = await _run_segment.call(_make_segment_request(definition, prompt, release_hint, bar_color, decay, start_ratio, 1.0))
	if final_outcome == "invalid": return FAILED
	if final_outcome == "released":
		return await _finish_aborted(definition)
	await action_executor.execute_batch_await(_action_list(definition.get("onComplete")))
	return COMPLETED


func _make_segment_request(definition: Dictionary, prompt: String, release_hint: Variant, bar_color: Variant, decay: float, start_ratio: float, stop_ratio: float) -> Dictionary:
	var request := {
		"prompt": prompt,
		"startRatio": start_ratio,
		"stopRatio": stop_ratio,
		"fillSeconds": float(definition.fillSeconds),
		"decayPerSecond": decay,
	}
	if release_hint != null:
		request.releaseHint = release_hint
	if bar_color != null:
		request.barColor = bar_color
	if definition.has("abortOnReleaseFromRatio"):
		request.abortOnReleaseFromRatio = float(definition.abortOnReleaseFromRatio)
	return request


func _finish_aborted(definition: Dictionary) -> String:
	await action_executor.execute_batch_await(_action_list(definition.get("onAborted")))
	return ABORTED


func _resolve_text(raw: String) -> String:
	return str(_resolve_display_text.call(raw)) if not _resolve_display_text.is_null() and _resolve_display_text.is_valid() else raw


func _validate_def(definition: Dictionary) -> bool:
	if str(definition.get("id", "")).strip_edges().is_empty() or not _is_finite_number(definition.get("fillSeconds")) or float(definition.fillSeconds) <= 0:
		return false
	if definition.has("abortOnReleaseFromRatio"):
		var threshold: Variant = definition.abortOnReleaseFromRatio
		if not _is_finite_number(threshold) or float(threshold) <= 0 or float(threshold) >= 1:
			return false
	var interrupts: Array = definition.get("interrupts", []) if definition.get("interrupts") is Array else []
	var sorted := interrupts.duplicate(true)
	for value: Variant in sorted:
		if not value is Dictionary or not _is_finite_number(value.get("atRatio")):
			return false
	sorted.sort_custom(func(a: Variant, b: Variant) -> bool: return float(a.atRatio) < float(b.atRatio))
	for index: int in sorted.size():
		var interrupt: Dictionary = sorted[index]
		var ratio := float(interrupt.atRatio)
		if ratio <= 0 or ratio >= 1 or (index > 0 and ratio == float(sorted[index - 1].atRatio)):
			return false
		if interrupt.get("abort") == true:
			continue
		var reset := clampf(float(interrupt.get("resetToRatio", 0)), 0.0, 1.0)
		var next_stop := float(sorted[index + 1].atRatio) if index + 1 < sorted.size() else 1.0
		if reset >= next_stop:
			return false
	return true


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	if not _cancel_segment.is_null() and _cancel_segment.is_valid():
		_cancel_segment.call()
	running = false


func destroy() -> void:
	if not _cancel_segment.is_null() and _cancel_segment.is_valid():
		_cancel_segment.call()
	defs.clear()
	running = false
	_run_segment = Callable()
	_resolve_display_text = Callable()
	_cancel_segment = Callable()
	asset_manager = null


static func parse_hex_color(raw: Variant) -> Variant:
	if not raw is String:
		return null
	var value: String = raw.strip_edges()
	var regex := RegEx.new()
	if regex.compile("^#[0-9a-fA-F]{6}$") != OK or regex.search(value) == null:
		return null
	return value.trim_prefix("#").hex_to_int()


static func _is_finite_number(value: Variant) -> bool:
	return (value is int or value is float) and is_finite(float(value))


static func _action_list(value: Variant) -> Array:
	return value if value is Array else []
