class_name RuntimePlanarEntityShadow
extends RefCounted

const SHADER := preload("res://scripts/rendering/planar_shadow.gdshader")
const CONTACT_TEXTURE_SIZE := 128

static var _shared_contact_texture: Texture2D

var layer: Node2D
var context: Dictionary
var root := Node2D.new()
var cast := Polygon2D.new()
var contact := Polygon2D.new()
var cast_material := ShaderMaterial.new()
var contact_material := ShaderMaterial.new()
var depth_params := {"tolerance": 0.0, "floorOffset": 0.0, "occlusionBlendFactor": 0.28}


func _init(next_layer: Node2D, next_context: Dictionary = {}) -> void:
	layer = next_layer
	context = next_context
	root.name = "PlanarEntityShadow"
	cast.name = "Cast"
	contact.name = "Contact"
	root.add_child(contact)
	root.add_child(cast)
	layer.add_child(root)
	cast_material.shader = SHADER
	contact_material.shader = SHADER
	cast.material = cast_material
	contact.material = contact_material
	contact.texture = _contact_texture()
	_configure_cast_material()
	contact_material.set_shader_parameter("collision_enabled", 0.0)
	contact_material.set_shader_parameter("occlusion_enabled", 0.0)
	contact_material.set_shader_parameter("softness", 0.0)
	root.visible = false


func update(source: Variant, env: Dictionary, field: Variant = null) -> void:
	var texture: Variant = _read(source, "texture", null)
	var visible := bool(_read(source, "visible", true))
	var shadow: Variant = env.get("shadow", {})
	if not texture is Texture2D or not visible or shadow.get("enabled", true) != true:
		root.visible = false
		return
	root.visible = true
	var foot := Vector2(float(_read(source, "footX", 0.0)), float(_read(source, "footY", 0.0)))
	var width := maxf(1.0, float(_read(source, "width", 1.0)))
	var height := maxf(1.0, float(_read(source, "height", 1.0)))
	var contact_size := maxf(0.1, float(shadow.get("contactSize", 1.0)))
	var contact_width := width * 1.3 * contact_size
	var contact_height := width * 0.6 * contact_size
	contact.polygon = PackedVector2Array([
		foot + Vector2(-contact_width * 0.5, -contact_height * 0.5),
		foot + Vector2(contact_width * 0.5, -contact_height * 0.5),
		foot + Vector2(contact_width * 0.5, contact_height * 0.5),
		foot + Vector2(-contact_width * 0.5, contact_height * 0.5),
	])
	contact.uv = PackedVector2Array([Vector2.ZERO, Vector2(CONTACT_TEXTURE_SIZE, 0), Vector2(CONTACT_TEXTURE_SIZE, CONTACT_TEXTURE_SIZE), Vector2(0, CONTACT_TEXTURE_SIZE)])
	contact_material.set_shader_parameter("darkness", clampf(float(shadow.get("contact", 0.5)), 0.0, 1.0))
	contact.visible = float(shadow.get("contact", 0.5)) > 0.0 and contact_size > 0.0

	if float(shadow.get("darkness", 0.4)) <= 0.0:
		cast.visible = false
		return
	cast.visible = true
	var projection: Dictionary = field.sample(foot.x, foot.y) if field != null and field.has_method("sample") else {"angleRad": deg_to_rad(float(env.get("key", {}).get("azimuthDeg", 125.0)) + 180.0), "length": float(shadow.get("length", 0.7))}
	var offset := Vector2.from_angle(float(projection.get("angleRad", 0.0))) * height * float(projection.get("length", 0.7))
	var half := maxf(0.5, width * 0.5)
	cast.polygon = PackedVector2Array([foot + Vector2(-half, 0), foot + Vector2(half, 0), foot + Vector2(half, 0) + offset, foot + Vector2(-half, 0) + offset])
	var frame_size := RuntimeEntityPixelDensityMatch.texture_frame_size(texture)
	cast.uv = PackedVector2Array([Vector2(0, frame_size.y), Vector2(frame_size.x, frame_size.y), Vector2(frame_size.x, 0), Vector2(0, 0)])
	if float(_read(source, "facing", 1.0)) < 0.0:
		cast.uv = PackedVector2Array([Vector2(frame_size.x, frame_size.y), Vector2(0, frame_size.y), Vector2(0, 0), Vector2(frame_size.x, 0)])
	cast.texture = texture
	cast_material.set_shader_parameter("darkness", clampf(float(shadow.get("darkness", 0.4)), 0.0, 1.0))
	cast_material.set_shader_parameter("foot", foot)
	cast_material.set_shader_parameter("softness", maxf(0.0, float(shadow.get("softness", 0.0))))


func set_depth_params(tolerance: float, floor_offset: float, occlusion_blend_factor: float) -> void:
	depth_params = {"tolerance": tolerance, "floorOffset": floor_offset, "occlusionBlendFactor": occlusion_blend_factor}
	cast_material.set_shader_parameter("tolerance", tolerance)
	cast_material.set_shader_parameter("floor_offset", floor_offset)
	cast_material.set_shader_parameter("occlusion_blend", occlusion_blend_factor)


func destroy() -> void:
	if root != null and is_instance_valid(root): root.queue_free()
	root = null
	cast = null
	contact = null
	layer = null


func _configure_cast_material() -> void:
	var cfg: Dictionary = context.get("config", {}) if context.get("config") is Dictionary else {}
	var mapping: Dictionary = cfg.get("depth_mapping", {}) if cfg.get("depth_mapping") is Dictionary else {}
	var shader_cfg: Dictionary = cfg.get("shader", {}) if cfg.get("shader") is Dictionary else {}
	var matrix: Dictionary = cfg.get("M", {}) if cfg.get("M") is Dictionary else {}
	var collision_cfg: Dictionary = cfg.get("collision", {}) if cfg.get("collision") is Dictionary else {}
	var rows: Array = matrix.get("R", []) if matrix.get("R") is Array else []
	var row0 := _matrix_row(rows, 0)
	var row2 := _matrix_row(rows, 2)
	cast_material.set_shader_parameter("depth_map", context.get("depthTexture"))
	cast_material.set_shader_parameter("collision_map", context.get("collisionTexture"))
	cast_material.set_shader_parameter("collision_enabled", 1.0 if context.get("collisionTexture") is Texture2D else 0.0)
	cast_material.set_shader_parameter("occlusion_enabled", 1.0 if context.get("depthTexture") is Texture2D else 0.0)
	cast_material.set_shader_parameter("scene_size", context.get("sceneSize", Vector2.ONE))
	cast_material.set_shader_parameter("world_to_pixel", context.get("worldToPixel", Vector2.ONE))
	cast_material.set_shader_parameter("depth_invert", 1.0 if mapping.get("invert") == true else 0.0)
	cast_material.set_shader_parameter("depth_scale", float(mapping.get("scale", 1.0)))
	cast_material.set_shader_parameter("depth_offset", float(mapping.get("offset", 0.0)))
	cast_material.set_shader_parameter("floor_a", float(shader_cfg.get("floor_depth_A", 0.0)))
	cast_material.set_shader_parameter("floor_b", float(shader_cfg.get("floor_depth_B", 0.0)))
	cast_material.set_shader_parameter("floor_offset", float(cfg.get("floor_offset", 0.0)))
	cast_material.set_shader_parameter("tolerance", float(cfg.get("depth_tolerance", 0.0)))
	cast_material.set_shader_parameter("occlusion_blend", float(context.get("occlusionBlendFactor", 0.28)))
	cast_material.set_shader_parameter("matrix_ppu", maxf(0.000001, float(matrix.get("ppu", 1.0))))
	cast_material.set_shader_parameter("matrix_center", Vector2(float(matrix.get("cx", 0.0)), float(matrix.get("cy", 0.0))))
	cast_material.set_shader_parameter("matrix_row0", row0)
	cast_material.set_shader_parameter("matrix_row2", row2)
	cast_material.set_shader_parameter("collision_origin", Vector2(float(collision_cfg.get("x_min", 0.0)), float(collision_cfg.get("z_min", 0.0))))
	cast_material.set_shader_parameter("collision_cell", maxf(0.000001, float(collision_cfg.get("cell_size", 1.0))))
	cast_material.set_shader_parameter("collision_grid", Vector2(float(collision_cfg.get("grid_width", 0.0)), float(collision_cfg.get("grid_height", 0.0))))


func _matrix_row(rows: Array, index: int) -> Vector3:
	if index >= 0 and index < rows.size() and rows[index] is Array and rows[index].size() >= 3:
		return Vector3(float(rows[index][0]), float(rows[index][1]), float(rows[index][2]))
	return Vector3.ZERO


static func _contact_texture() -> Texture2D:
	if _shared_contact_texture != null:
		return _shared_contact_texture
	var image := Image.create_empty(CONTACT_TEXTURE_SIZE, CONTACT_TEXTURE_SIZE, false, Image.FORMAT_RGBA8)
	var center := Vector2(CONTACT_TEXTURE_SIZE * 0.5, CONTACT_TEXTURE_SIZE * 0.5)
	for y in CONTACT_TEXTURE_SIZE:
		for x in CONTACT_TEXTURE_SIZE:
			var distance := Vector2(x + 0.5, y + 0.5).distance_to(center) / (CONTACT_TEXTURE_SIZE * 0.5)
			var alpha := lerpf(1.0, 0.6, distance / 0.5) if distance <= 0.5 else lerpf(0.6, 0.0, (distance - 0.5) / 0.5)
			image.set_pixel(x, y, Color(1, 1, 1, clampf(alpha, 0.0, 1.0)))
	_shared_contact_texture = ImageTexture.create_from_image(image)
	return _shared_contact_texture


func _read(source: Variant, key: String, fallback: Variant) -> Variant:
	if source is Dictionary: return source.get(key, fallback)
	var method: String = {"texture": "get_texture", "visible": "is_visible", "footX": "get_foot_x", "footY": "get_foot_y", "width": "get_world_width", "height": "get_world_height", "facing": "get_facing"}.get(key, "")
	return source.call(method) if source != null and source.has_method(method) else fallback
