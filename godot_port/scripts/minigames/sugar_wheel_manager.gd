class_name RuntimeSugarWheelMinigameManager
extends RuntimeMinigameSessionManagerBase

const INDEX_URL := "/assets/data/sugar_wheel/index.json"

var event_bus: RuntimeEventBus
var action_executor: RuntimeActionExecutor
var resolve_display_text := Callable()
var play_sfx := Callable()
var debug_panel_log := Callable()
var evaluate_before_charge_condition := Callable()


func init(ctx: Dictionary) -> void:
	super.init(ctx); event_bus = ctx.get("eventBus")


func bind_runtime(deps: Dictionary) -> void:
	bind_session_runtime(deps); action_executor = deps.get("actionExecutor"); resolve_display_text = deps.get("resolveDisplayText", Callable()); play_sfx = deps.get("playSfx", Callable()); debug_panel_log = deps.get("debugPanelLog", Callable()); evaluate_before_charge_condition = deps.get("evaluateBeforeChargeCondition", Callable())


func runtime_ready() -> bool: return super.runtime_ready() and action_executor != null and resolve_display_text.is_valid()
func get_index_url() -> String: return INDEX_URL
func get_data_subdir() -> String: return "sugar_wheel"
func get_scope_prefix() -> String: return "minigame:sugarWheel"
func validate_instance(next_instance: Dictionary) -> bool: return next_instance.get("sectors") is Array and not next_instance.sectors.is_empty()


func build_instance_manifest_refs(next_instance: Dictionary) -> Array:
	var refs: Array = []
	for entry: Dictionary in [{"field": "backgroundImage", "label": "糖画背景"}, {"field": "foregroundImage", "label": "糖画前景"}, {"field": "wheelImage", "label": "糖画转盘"}, {"field": "pointerImage", "label": "糖画指针"}]:
		var path := str(next_instance.get(entry.field, "")).strip_edges()
		if not path.is_empty(): refs.push_back({"type": "texture", "path": path, "label": "%s: %s" % [entry.label, next_instance.get("id", "")]})
	return refs


func create_scene(_instance: Dictionary) -> Variant:
	return RuntimeSugarWheelMinigameScene.new(renderer, asset_manager, action_executor, resolve_display_text, Callable(self, "_publish_result"), Callable(self, "teardown_session"), debug_panel_log, evaluate_before_charge_condition, play_sfx, Callable(self, "restore_minigame_state_after_action"))


func load_scene_content(next_scene: Variant, next_instance: Dictionary) -> void: await next_scene.load(next_instance)
func tick_scene(next_scene: Variant, dt: float) -> void: next_scene.update(dt)
func on_session_key_down(record: Dictionary) -> void: if str(record.get("code", "")) == "KeyD" and scene != null: scene.toggle_geom_debug_overlay()


func _publish_result(result: Dictionary) -> void:
	publish_result(result)
	if event_bus != null: event_bus.emit("minigame:sugarWheelResult", result)


func show_speech(role: String, text: String, duration_ms: Variant = null) -> void: if scene != null: scene.show_speech(role, text, duration_ms)
func dismiss_speech(role: String) -> void: if scene != null: scene.dismiss_speech(role)
func dismiss_all_speech() -> void: if scene != null: scene.dismiss_all_speech()
func reset_pointer_geom_angle_deg(angle_deg: float) -> void: if scene != null: scene.reset_pointer_geom_angle_deg(angle_deg)
func get_debug_visual_state() -> Variant: return scene.get_debug_visual_state() if scene != null else null
