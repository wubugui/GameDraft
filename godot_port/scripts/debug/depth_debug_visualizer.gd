class_name RuntimeDepthDebugVisualizer
extends RefCounted

const MODE_MAP := {
	"off": 0.0,
	"depth": 1.0,
	"collision": 2.0,
	"uv": 3.0,
}

var _depth_system: RuntimeSceneDepthSystem
var _camera: RuntimeCamera
var _renderer: RuntimeRenderer
var _asset_manager: RuntimeAssetManager

var _filter := RuntimeBackgroundDebugFilter.new()
var _filter_attached := false
var _current_mode := "off"
var _collision_texture_loaded := false
var _current_scene_id := ""
var _collision_map_name := ""
var _scene_w := 0.0
var _scene_h := 0.0
var _panel_log := Callable()
var _attached_background_materials: Dictionary = {}


func _init(
	depth_system: RuntimeSceneDepthSystem,
	camera: RuntimeCamera,
	renderer: RuntimeRenderer,
	asset_manager: RuntimeAssetManager,
	panel_log: Callable = Callable(),
) -> void:
	_depth_system = depth_system
	_camera = camera
	_renderer = renderer
	_asset_manager = asset_manager
	_panel_log = panel_log


var mode: String:
	get:
		return _current_mode


func set_mode(next_mode: String) -> void:
	if not MODE_MAP.has(next_mode):
		return
	_current_mode = next_mode
	_filter.set_mode(float(MODE_MAP[next_mode]))
	if next_mode == "off":
		_detach_filter()
	else:
		_attach_filter()

	if next_mode == "collision" and not _collision_texture_loaded:
		_load_collision_texture()

	if next_mode == "depth" and _panel_log.is_valid():
		var world_container := _renderer.world_container
		var projection_scale := _camera.get_projection_scale()
		var depth_texture := _depth_system.current_depth_texture
		_panel_log.call(
			"F2深度模式: sceneId=%s depthEnabled=%s curTex=%s wc=(%.1f,%.1f) S=%.3f scenePx=%.1fx%.1f appScreen=%.0fx%.0f renderer=Godot" % [
				_current_scene_id if not _current_scene_id.is_empty() else "—",
				_depth_system.is_enabled,
				"%sx%s" % [depth_texture.get_width(), depth_texture.get_height()] if depth_texture != null else "null",
				world_container.position.x,
				world_container.position.y,
				projection_scale,
				_scene_w * projection_scale,
				_scene_h * projection_scale,
				_renderer.screen_width,
				_renderer.screen_height,
			]
		)


func on_scene_loaded(
	scene_id: String,
	depth_texture: Texture2D,
	texture_width: float,
	texture_height: float,
	world_width: float,
	world_height: float,
	config: Dictionary,
) -> void:
	_current_scene_id = scene_id
	_collision_texture_loaded = false
	_collision_map_name = str(config.get("collision_map", "collision.png"))
	_scene_w = world_width
	_scene_h = world_height
	_filter.load_scene_data(depth_texture, texture_width, texture_height, config)
	if _filter_attached:
		_sync_filter_targets()

	if _panel_log.is_valid():
		var mapping: Dictionary = config.get("depth_mapping", {}) if config.get("depth_mapping") is Dictionary else {}
		_panel_log.call(
			"onSceneLoaded: %s depthTex=%sx%s depth_map=%s invert=%s scale=%s offset=%s" % [
				scene_id,
				texture_width,
				texture_height,
				config.get("depth_map", ""),
				mapping.get("invert", false),
				mapping.get("scale", 1.0),
				mapping.get("offset", 0.0),
			]
		)

	if _current_mode == "collision":
		_load_collision_texture()


func update_scene_world_size(world_width: float, world_height: float) -> void:
	_scene_w = world_width
	_scene_h = world_height


func on_scene_unloaded() -> void:
	_restore_filter_targets()
	_collision_texture_loaded = false
	_current_scene_id = ""


func _load_collision_texture() -> void:
	if _current_scene_id.is_empty():
		return
	var path := "/resources/runtime/scenes/%s/%s" % [_current_scene_id, _collision_map_name]
	var texture: Variant = _asset_manager.load_texture(path)
	if texture is Texture2D:
		_filter.set_collision_texture(texture)
		_collision_texture_loaded = true
	else:
		push_warning("[BgDebug] Failed to load collision texture: %s" % path)


func update() -> void:
	if _current_mode == "off":
		return
	var logical_world_position := _renderer.world_container.position - RuntimeCamera.RASTER_PHASE
	_filter.set_world_container_pos(logical_world_position.x, logical_world_position.y)
	var projection_scale := _camera.get_projection_scale()
	_filter.set_scene_size(_scene_w * projection_scale, _scene_h * projection_scale)


func _attach_filter() -> void:
	if _renderer.background_layer == null:
		return
	if _filter_attached:
		_sync_filter_targets()
		return
	_filter_attached = true
	_sync_filter_targets()


func _detach_filter() -> void:
	if not _filter_attached:
		return
	_restore_filter_targets()
	_filter_attached = false


func _sync_filter_targets() -> void:
	_prune_filter_targets()
	var targets: Array[CanvasItem] = []
	_collect_filter_targets(_renderer.background_layer, targets)
	for target: CanvasItem in targets:
		var id := target.get_instance_id()
		if not _attached_background_materials.has(id):
			_attached_background_materials[id] = {"target": target, "material": target.material}
		target.material = _filter.material


func _collect_filter_targets(node: Node, output: Array[CanvasItem]) -> void:
	for child: Node in node.get_children():
		if child is Sprite2D or child is Polygon2D:
			output.push_back(child)
		_collect_filter_targets(child, output)


func _prune_filter_targets() -> void:
	for id: Variant in _attached_background_materials.keys():
		var entry: Dictionary = _attached_background_materials[id]
		var target: Variant = entry.get("target")
		if target == null or not is_instance_valid(target):
			_attached_background_materials.erase(id)


func _restore_filter_targets() -> void:
	for entry: Dictionary in _attached_background_materials.values():
		var target: Variant = entry.get("target")
		if target != null and is_instance_valid(target) and target.material == _filter.material:
			target.material = entry.get("material")
	_attached_background_materials.clear()


func destroy() -> void:
	_filter.set_mode(0.0)
	_detach_filter()
	_panel_log = Callable()
