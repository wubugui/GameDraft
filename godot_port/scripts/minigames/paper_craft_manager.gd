class_name RuntimePaperCraftMinigameManager
extends RuntimeMinigameSessionManagerBase

const INDEX_URL := "/assets/data/paper_craft/index.json"

var event_bus: RuntimeEventBus
var action_executor: RuntimeActionExecutor
var resolve_text_fn: Variant = null


func _init() -> void:
	index_url = INDEX_URL
	data_subdir = "paper_craft"
	scope_prefix = "minigame:paperCraft"
	system_label = "PaperCraftMinigameManager"


func init(ctx: Dictionary) -> void:
	super.init(ctx); event_bus = ctx.get("eventBus")


func bind_runtime(deps: Dictionary) -> void:
	renderer = deps.get("renderer")
	input_manager = deps.get("inputManager")
	state_controller = deps.get("stateController")
	action_executor = deps.get("actionExecutor")
	resolve_text_fn = deps.get("resolveDisplayText")


func runtime_ready() -> bool:
	return super.runtime_ready() and action_executor != null and resolve_text_fn is Callable and resolve_text_fn.is_valid()


func create_scene(_instance: Dictionary) -> Variant:
	return RuntimePaperCraftMinigameScene.new(renderer, asset_manager, action_executor, resolve_text_fn, Callable(self, "_publish_result"), Callable(self, "teardown_session"), Callable(self, "restore_minigame_state_after_action"))


func load_scene_content(next_scene: Variant, next_instance: Dictionary) -> Variant:
	return await next_scene.load(next_instance)


func tick_scene(next_scene: Variant, dt: float) -> void:
	next_scene.update(dt)


func build_instance_manifest_refs(next_instance: Dictionary) -> Array:
	var refs: Array = []
	var add_texture := func(path: Variant, label: String) -> void:
		if path is String and not path.strip_edges().is_empty():
			refs.push_back({"type": "texture", "path": path, "label": label})
	add_texture.call(next_instance.get("backgroundImage"), "扎纸背景: %s" % next_instance.get("id", ""))
	for order: Variant in next_instance.orders:
		for part: Variant in order.parts:
			add_texture.call(part.get("image"), "扎纸部件: %s" % part.id)
	return refs


func _publish_result(result: Dictionary) -> void:
	last_result = result
	event_bus.emit("minigame:paperCraftResult", result)


func get_debug_visual_state() -> Variant: return scene.get_debug_visual_state() if scene != null else null
