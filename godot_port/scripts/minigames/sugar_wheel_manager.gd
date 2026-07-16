class_name RuntimeSugarWheelMinigameManager
extends RuntimeMinigameSessionManagerBase

const INDEX_URL := "/assets/data/sugar_wheel/index.json"

var event_bus: RuntimeEventBus
var resolve_text_fn: Variant = null
var action_executor: RuntimeActionExecutor
var play_sfx: Variant = null
var debug_sugar_log: Variant = null
var evaluate_before_charge_condition: Variant = null


func _init() -> void:
	index_url = INDEX_URL
	data_subdir = "sugar_wheel"
	scope_prefix = "minigame:sugarWheel"
	system_label = "SugarWheelMinigameManager"


func init(ctx: Dictionary) -> void:
	super.init(ctx); event_bus = ctx.get("eventBus")


func bind_runtime(deps: Dictionary) -> void:
	renderer = deps.get("renderer")
	input_manager = deps.get("inputManager")
	state_controller = deps.get("stateController")
	action_executor = deps.get("actionExecutor")
	play_sfx = deps.get("playSfx")
	resolve_text_fn = deps.get("resolveDisplayText")
	debug_sugar_log = deps.get("debugPanelLog")
	evaluate_before_charge_condition = deps.get("evaluateBeforeChargeCondition")


func runtime_ready() -> bool:
	return super.runtime_ready() and action_executor != null and resolve_text_fn is Callable and resolve_text_fn.is_valid()


func warn_session(message: String, detail: Variant = null) -> void:
	var text := "%s: %s" % [message, str(detail)] if detail != null else message
	if debug_sugar_log is Callable and debug_sugar_log.is_valid():
		debug_sugar_log.call("[糖画转盘] %s" % text)


func validate_instance(next_instance: Dictionary) -> bool:
	if not next_instance.get("sectors") is Array or next_instance.sectors.is_empty():
		warn_session("实例 \"%s\" 无扇区" % next_instance.get("id", ""))
		return false
	return true


func create_scene(_instance: Dictionary) -> Variant:
	return RuntimeSugarWheelMinigameScene.new(
		renderer,
		asset_manager,
		action_executor,
		resolve_text_fn,
		Callable(self, "_publish_result"),
		Callable(self, "teardown_session"),
		debug_sugar_log if debug_sugar_log is Callable else Callable(),
		evaluate_before_charge_condition if evaluate_before_charge_condition is Callable else Callable(),
		play_sfx if play_sfx is Callable else Callable(),
		Callable(self, "restore_minigame_state_after_action")
	)


func load_scene_content(next_scene: Variant, next_instance: Dictionary) -> Variant:
	return await next_scene.load(next_instance)


func tick_scene(next_scene: Variant, dt: float) -> void:
	next_scene.update(dt)


func on_session_key_down(record: Dictionary) -> void:
	if OS.is_debug_build() and str(record.get("code", "")) == "KeyD":
		var prevent_default: Variant = record.get("preventDefault")
		if prevent_default is Callable and prevent_default.is_valid():
			prevent_default.call()
		if scene != null:
			scene.toggle_geom_debug_overlay()


func build_instance_manifest_refs(next_instance: Dictionary) -> Array:
	var refs: Array = []
	var add_texture := func(path: Variant, label: String) -> void:
		if path is String and not path.strip_edges().is_empty():
			refs.push_back({"type": "texture", "path": path, "label": label})
	add_texture.call(next_instance.get("backgroundImage"), "糖画背景: %s" % next_instance.id)
	add_texture.call(next_instance.get("foregroundImage"), "糖画前景: %s" % next_instance.id)
	add_texture.call(next_instance.get("wheelImage"), "糖画转盘: %s" % next_instance.id)
	add_texture.call(next_instance.get("pointerImage"), "糖画指针: %s" % next_instance.id)
	return refs


func _publish_result(result: Dictionary) -> void:
	last_result = result
	event_bus.emit("minigame:sugarWheelResult", result)


func show_speech(role: String, text: String, duration_ms: Variant = null) -> void: if scene != null: scene.show_speech(role, text, duration_ms)
func dismiss_speech(role: String) -> void: if scene != null: scene.dismiss_speech(role)
func dismiss_all_speech() -> void: if scene != null: scene.dismiss_all_speech()
func reset_pointer_geom_angle_deg(angle_deg: float) -> void: if scene != null: scene.reset_pointer_geom_angle_deg(angle_deg)
func get_debug_visual_state() -> Variant: return scene.get_debug_visual_state() if scene != null else null
