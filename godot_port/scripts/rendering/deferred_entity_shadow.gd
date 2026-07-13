class_name RuntimeDeferredEntityShadow
extends RefCounted

const SHADER := preload("res://scripts/rendering/deferred_shadow.gdshader")

var layer: Node2D
var context: Dictionary
var root := Node2D.new()
var silhouette := Polygon2D.new()
var material := ShaderMaterial.new()
var depth_params := {"tolerance": 0.0, "floorOffset": 0.0, "occlusionBlendFactor": 0.28}
var _matrix_rows: Array = []


func _init(next_layer: Node2D, next_context: Dictionary) -> void:
	layer = next_layer
	context = next_context
	root.name = "DeferredEntityShadow"
	silhouette.name = "DeferredSilhouette"
	root.add_child(silhouette)
	layer.add_child(root)
	material.shader = SHADER
	silhouette.material = material
	_configure_material()
	root.visible = false


func update(source: Variant, env: Dictionary, _field: Variant = null) -> void:
	var texture: Variant = _read(source, "texture", null)
	var shadow: Variant = env.get("shadow", {})
	if not texture is Texture2D or not bool(_read(source, "visible", true)) or shadow.get("enabled", true) != true or (float(shadow.get("darkness", 0.0)) <= 0.0 and float(shadow.get("contact", 0.0)) <= 0.0):
		root.visible = false
		return
	root.visible = true
	var foot := Vector2(float(_read(source, "footX", 0.0)), float(_read(source, "footY", 0.0)))
	var width := maxf(1.0, float(_read(source, "width", 1.0)))
	var height := maxf(1.0, float(_read(source, "height", 1.0)))
	var source_texture: Texture2D = texture.atlas if texture is AtlasTexture and texture.atlas != null else texture
	var frame: Rect2 = texture.region if texture is AtlasTexture else Rect2(0, 0, texture.get_width(), texture.get_height())
	silhouette.texture = source_texture
	material.set_shader_parameter("silhouette_map", source_texture)
	material.set_shader_parameter("silhouette_frame", Vector4(frame.position.x / source_texture.get_width(), frame.position.y / source_texture.get_height(), frame.size.x / source_texture.get_width(), frame.size.y / source_texture.get_height()))
	material.set_shader_parameter("silhouette_texel_size", Vector2(1.0 / maxf(1.0, source_texture.get_width()), 1.0 / maxf(1.0, source_texture.get_height())))
	var reach := height * float(shadow.get("length", 0.7))
	var half := reach + width * 1.5
	silhouette.polygon = PackedVector2Array([foot + Vector2(-half, -half), foot + Vector2(half, -half), foot + Vector2(half, half), foot + Vector2(-half, half)])
	silhouette.uv = PackedVector2Array([Vector2.ZERO, Vector2(source_texture.get_width(), 0), Vector2(source_texture.get_width(), source_texture.get_height()), Vector2(0, source_texture.get_height())])
	var key: Dictionary = env.get("key", {}) if env.get("key") is Dictionary else {}
	var azimuth := deg_to_rad(float(key.get("azimuthDeg", 125.0)))
	var elevation := deg_to_rad(float(key.get("elevationDeg", 55.0)))
	var horizontal := cos(elevation)
	material.set_shader_parameter("light_direction", Vector3(horizontal * cos(azimuth), sin(elevation), horizontal * sin(azimuth)))
	material.set_shader_parameter("foot", foot)
	var matrix: Dictionary = context.get("config", {}).get("M", {}) if context.get("config") is Dictionary and context.config.get("M") is Dictionary else {}
	var ppu := maxf(0.000001, float(matrix.get("ppu", 1.0)))
	var row1 := _matrix_row(_matrix_rows, 1)
	var up_y := absf(row1.y) if absf(row1.y) > 0.001 else 1.0
	var world_to_pixel: Vector2 = context.get("worldToPixel", Vector2.ONE)
	material.set_shader_parameter("height_m", height * world_to_pixel.y / (ppu * up_y))
	material.set_shader_parameter("width_m", width * world_to_pixel.x / ppu)
	material.set_shader_parameter("facing", float(_read(source, "facing", 1.0)))
	material.set_shader_parameter("billboard_mode", 1.0 if shadow.get("billboard") == "camera" else 0.0)
	material.set_shader_parameter("darkness", clampf(float(shadow.get("darkness", 0.4)), 0.0, 1.0))
	material.set_shader_parameter("soft_samples", float(clampi(int(round(float(shadow.get("softSamples", 1)))), 1, 8)))
	material.set_shader_parameter("soft_radius", float(shadow.get("softRadius", 0.05)))
	material.set_shader_parameter("contact_ao", clampf(float(shadow.get("contact", 0.0)), 0.0, 1.0))
	material.set_shader_parameter("contact_radius", width * maxf(0.1, float(shadow.get("contactSize", 1.0))) * 0.65)
	material.set_shader_parameter("silhouette_softness", maxf(0.0, float(shadow.get("softness", 0.0))))


func set_depth_params(tolerance: float, floor_offset: float, occlusion_blend_factor: float) -> void:
	depth_params = {"tolerance": tolerance, "floorOffset": floor_offset, "occlusionBlendFactor": occlusion_blend_factor}


func destroy() -> void:
	if root != null and is_instance_valid(root): root.queue_free()
	root = null
	silhouette = null
	layer = null


func _configure_material() -> void:
	var cfg: Dictionary = context.get("config", {}) if context.get("config") is Dictionary else {}
	var mapping: Dictionary = cfg.get("depth_mapping", {}) if cfg.get("depth_mapping") is Dictionary else {}
	var matrix: Dictionary = cfg.get("M", {}) if cfg.get("M") is Dictionary else {}
	_matrix_rows = matrix.get("R", []) if matrix.get("R") is Array else []
	material.set_shader_parameter("depth_map", context.get("depthTexture"))
	material.set_shader_parameter("scene_size", context.get("sceneSize", Vector2.ONE))
	material.set_shader_parameter("world_to_pixel", context.get("worldToPixel", Vector2.ONE))
	material.set_shader_parameter("matrix_ppu", maxf(0.000001, float(matrix.get("ppu", 1.0))))
	material.set_shader_parameter("matrix_center", Vector2(float(matrix.get("cx", 0.0)), float(matrix.get("cy", 0.0))))
	material.set_shader_parameter("matrix_row0", _matrix_row(_matrix_rows, 0))
	material.set_shader_parameter("matrix_row1", _matrix_row(_matrix_rows, 1))
	material.set_shader_parameter("matrix_row2", _matrix_row(_matrix_rows, 2))
	material.set_shader_parameter("depth_invert", 1.0 if mapping.get("invert") == true else 0.0)
	material.set_shader_parameter("depth_scale", float(mapping.get("scale", 1.0)))
	material.set_shader_parameter("depth_offset", float(mapping.get("offset", 0.0)))


func _matrix_row(rows: Array, index: int) -> Vector3:
	if index >= 0 and index < rows.size() and rows[index] is Array and rows[index].size() >= 3:
		return Vector3(float(rows[index][0]), float(rows[index][1]), float(rows[index][2]))
	return Vector3.ZERO


func _read(source: Variant, key: String, fallback: Variant) -> Variant:
	if source is Dictionary: return source.get(key, fallback)
	var method: String = {"texture": "get_texture", "visible": "is_visible", "footX": "get_foot_x", "footY": "get_foot_y", "width": "get_world_width", "height": "get_world_height", "facing": "get_facing"}.get(key, "")
	return source.call(method) if source != null and source.has_method(method) else fallback
