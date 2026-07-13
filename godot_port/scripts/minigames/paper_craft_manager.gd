class_name RuntimePaperCraftMinigameManager
extends RuntimeMinigameSessionManagerBase

const INDEX_URL := "/assets/data/paper_craft/index.json"

var event_bus: RuntimeEventBus
var action_executor: RuntimeActionExecutor
var resolve_display_text := Callable()


func init(ctx: Dictionary) -> void:
	super.init(ctx); event_bus = ctx.get("eventBus")


func bind_runtime(deps: Dictionary) -> void:
	bind_session_runtime(deps); action_executor = deps.get("actionExecutor"); resolve_display_text = deps.get("resolveDisplayText", Callable())


func runtime_ready() -> bool:
	return super.runtime_ready() and action_executor != null and not resolve_display_text.is_null() and resolve_display_text.is_valid()


func get_index_url() -> String: return INDEX_URL
func get_data_subdir() -> String: return "paper_craft"
func get_scope_prefix() -> String: return "minigame:paperCraft"


func build_instance_manifest_refs(next_instance: Dictionary) -> Array:
	var refs: Array = []
	var background := str(next_instance.get("backgroundImage", "")).strip_edges()
	if not background.is_empty(): refs.push_back({"type": "texture", "path": background, "label": "扎纸背景: %s" % next_instance.get("id", "")})
	for order_value: Variant in next_instance.get("orders", []):
		if not order_value is Dictionary: continue
		for part_value: Variant in order_value.get("parts", []):
			if part_value is Dictionary and not str(part_value.get("image", "")).strip_edges().is_empty(): refs.push_back({"type": "texture", "path": str(part_value.image), "label": "扎纸部件: %s" % part_value.get("id", "")})
	return refs


func create_scene(_instance: Dictionary) -> Variant:
	return RuntimePaperCraftMinigameScene.new(renderer, asset_manager, action_executor, resolve_display_text, Callable(self, "_publish_result"), Callable(self, "teardown_session"), Callable(self, "restore_minigame_state_after_action"))


func load_scene_content(next_scene: Variant, next_instance: Dictionary) -> void:
	await next_scene.load(next_instance)


func tick_scene(next_scene: Variant, dt: float) -> void:
	next_scene.update(dt)


func _publish_result(result: Dictionary) -> void:
	publish_result(result)
	if event_bus != null: event_bus.emit("minigame:paperCraftResult", result)


func get_debug_visual_state() -> Variant: return scene.get_debug_visual_state() if scene != null else null
