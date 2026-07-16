class_name RuntimePlanarEntityShadow
extends RefCounted

const DEG2RAD := PI / 180.0
const SHADER := preload("res://scripts/rendering/planar_shadow.gdshader")
const ShadowMeshGeometryScript := preload("res://scripts/rendering/shadow_mesh_geometry.gd")
const ShadowBlurFilterScript := preload("res://scripts/rendering/shadow_blur_filter.gd")
const CONTACT_TEXTURE_SIZE := 128

static var _contact_texture_cache: Texture2D = null
static var _white_texture_cache: Texture2D = null

var _ctx: Variant
var _cast_mesh: Polygon2D
var _cast_shader: ShaderMaterial
var _cast_positions: PackedVector2Array
var _cast_uvs: PackedVector2Array
var _cast_geometry: RuntimeShadowMeshGeometry
var _contact_mesh: Polygon2D
var _contact_shader: ShaderMaterial
var _contact_positions: PackedVector2Array
var _contact_geometry: RuntimeShadowMeshGeometry
var _blur: RuntimeShadowBlurFilter = null
var _last_softness := -1.0
var _bound_source: Texture2D = null


func _init(layer: Node2D, context: Variant = null) -> void:
	_ctx = context if context is Dictionary else null
	var quad_indices := PackedInt32Array([0, 1, 2, 0, 2, 3])

	_cast_positions = PackedVector2Array([Vector2.ZERO, Vector2.ZERO, Vector2.ZERO, Vector2.ZERO])
	_cast_uvs = PackedVector2Array([Vector2.ZERO, Vector2.ZERO, Vector2.ZERO, Vector2.ZERO])
	_cast_geometry = ShadowMeshGeometryScript.new(_cast_positions, _cast_uvs, quad_indices.duplicate())
	_cast_shader = _make_planar_shader(_ctx, _white_texture(), true)
	_cast_mesh = Polygon2D.new()
	_cast_mesh.name = "Cast"
	_cast_geometry.bind(_cast_mesh)
	_cast_mesh.material = _cast_shader
	_cast_mesh.texture = _white_texture()
	_cast_mesh.visible = false
	layer.add_child(_cast_mesh)

	_contact_positions = PackedVector2Array([Vector2.ZERO, Vector2.ZERO, Vector2.ZERO, Vector2.ZERO])
	var contact_uvs := PackedVector2Array([
		Vector2(0.0, 0.0),
		Vector2(1.0, 0.0),
		Vector2(1.0, 1.0),
		Vector2(0.0, 1.0),
	])
	_contact_geometry = ShadowMeshGeometryScript.new(_contact_positions, contact_uvs, quad_indices.duplicate())
	var contact_texture := _get_contact_texture()
	_contact_shader = _make_planar_shader(_ctx, contact_texture, false)
	_contact_mesh = Polygon2D.new()
	_contact_mesh.name = "Contact"
	_contact_geometry.bind(_contact_mesh, Vector2(CONTACT_TEXTURE_SIZE, CONTACT_TEXTURE_SIZE))
	_contact_mesh.material = _contact_shader
	_contact_mesh.texture = contact_texture
	_contact_mesh.visible = false
	layer.add_child(_contact_mesh)


func update(source: Variant, env: Dictionary, field: Variant = null) -> void:
	var texture: Variant = source.get_texture()
	if not texture is Texture2D or not source.is_visible() or env.shadow.enabled != true:
		_cast_mesh.visible = false
		_contact_mesh.visible = false
		return

	var foot_x := float(source.get_foot_x())
	var foot_y := float(source.get_foot_y())
	var world_width := maxf(1.0, float(source.get_world_width()))
	var world_height := maxf(1.0, float(source.get_world_height()))

	if float(env.shadow.contact) > 0.0 and float(env.shadow.contactSize) > 0.0:
		var contact_width := world_width * 1.3 * float(env.shadow.contactSize)
		var contact_height := world_width * 0.6 * float(env.shadow.contactSize)
		_contact_positions[0] = Vector2(foot_x - contact_width / 2.0, foot_y - contact_height / 2.0)
		_contact_positions[1] = Vector2(foot_x + contact_width / 2.0, foot_y - contact_height / 2.0)
		_contact_positions[2] = Vector2(foot_x + contact_width / 2.0, foot_y + contact_height / 2.0)
		_contact_positions[3] = Vector2(foot_x - contact_width / 2.0, foot_y + contact_height / 2.0)
		_contact_geometry.positions = _contact_positions
		_contact_geometry.update_position_buffer()
		_set_u(_contact_shader, "darkness", minf(1.0, float(env.shadow.contact)))
		_contact_mesh.visible = true
	else:
		_contact_mesh.visible = false

	if float(env.shadow.darkness) <= 0.0:
		_cast_mesh.visible = false
		return
	_cast_mesh.visible = true

	var texture_source: Texture2D = texture.atlas if texture is AtlasTexture and texture.atlas != null else texture
	if not is_same(texture_source, _bound_source):
		_cast_shader.set_shader_parameter("silhouette_map", texture_source)
		_cast_mesh.texture = texture_source
		_cast_geometry.set_uv_scale(Vector2(texture_source.get_width(), texture_source.get_height()))
		_bound_source = texture_source

	var projection: Dictionary = field.sample(foot_x, foot_y) if field != null else {
		"angleRad": (float(env.key.azimuthDeg) + 180.0) * DEG2RAD,
		"length": float(env.shadow.length),
	}
	var half_width := maxf(0.5, world_width * 0.5)
	var reach := world_height * float(projection.length)
	var offset_x := cos(float(projection.angleRad)) * reach
	var offset_y := sin(float(projection.angleRad)) * reach
	_cast_positions[0] = Vector2(foot_x - half_width, foot_y)
	_cast_positions[1] = Vector2(foot_x + half_width, foot_y)
	_cast_positions[2] = Vector2(foot_x + half_width + offset_x, foot_y + offset_y)
	_cast_positions[3] = Vector2(foot_x - half_width + offset_x, foot_y + offset_y)

	var frame: Rect2 = texture.region if texture is AtlasTexture else Rect2(0.0, 0.0, texture.get_width(), texture.get_height())
	var source_width := float(texture_source.get_width()) if texture_source.get_width() > 0 else 1.0
	var source_height := float(texture_source.get_height()) if texture_source.get_height() > 0 else 1.0
	var u0 := frame.position.x / source_width
	var u1 := frame.end.x / source_width
	if float(source.get_facing()) < 0.0:
		var swap := u0
		u0 = u1
		u1 = swap
	var v_top := frame.position.y / source_height
	var v_bottom := frame.end.y / source_height
	_cast_uvs[0] = Vector2(u0, v_bottom)
	_cast_uvs[1] = Vector2(u1, v_bottom)
	_cast_uvs[2] = Vector2(u1, v_top)
	_cast_uvs[3] = Vector2(u0, v_top)
	_cast_geometry.positions = _cast_positions
	_cast_geometry.uvs = _cast_uvs
	_cast_geometry.update_position_buffer()
	_cast_geometry.update_uv_buffer()

	_set_u(_cast_shader, "darkness", clampf(float(env.shadow.darkness), 0.0, 1.0))
	_set_u(_cast_shader, "foot_x", foot_x)
	_set_u(_cast_shader, "foot_y", foot_y)

	var softness := float(env.shadow.softness)
	if softness > 0.0:
		var strength := maxf(0.5, softness * 4.0)
		if _blur == null:
			_blur = ShadowBlurFilterScript.new(_cast_mesh, strength, 2)
			_last_softness = softness
		elif absf(softness - _last_softness) > 0.001:
			_blur.strength = strength
			_last_softness = softness
	elif _blur != null:
		_blur.destroy()
		_blur = null
		_last_softness = -1.0


func set_depth_params(tolerance: float, floor_offset: float, occlusion_blend_factor: float) -> void:
	_set_u(_cast_shader, "tolerance", tolerance)
	_set_u(_cast_shader, "floor_offset", floor_offset)
	_set_u(_cast_shader, "occlusion_blend", occlusion_blend_factor)


func destroy() -> void:
	if _blur != null:
		_blur.destroy()
		_blur = null
	if _cast_mesh != null and is_instance_valid(_cast_mesh):
		if _cast_mesh.get_parent() != null:
			_cast_mesh.get_parent().remove_child(_cast_mesh)
		_cast_mesh.material = null
		_cast_mesh.texture = null
		_cast_mesh.free()
	_cast_mesh = null
	_cast_shader = null
	if _cast_geometry != null:
		_cast_geometry.destroy()
	_cast_geometry = null
	if _contact_mesh != null and is_instance_valid(_contact_mesh):
		if _contact_mesh.get_parent() != null:
			_contact_mesh.get_parent().remove_child(_contact_mesh)
		_contact_mesh.material = null
		_contact_mesh.texture = null
		_contact_mesh.free()
	_contact_mesh = null
	_contact_shader = null
	if _contact_geometry != null:
		_contact_geometry.destroy()
	_contact_geometry = null
	_bound_source = null


static func _make_planar_shader(context: Variant, texture: Texture2D, collision_and_occlusion: bool) -> ShaderMaterial:
	var material := ShaderMaterial.new()
	material.shader = SHADER
	var on := collision_and_occlusion and context is Dictionary
	material.set_shader_parameter("darkness", 0.4)
	material.set_shader_parameter("collision_enabled", 1.0 if on and context.collisionTexture is Texture2D else 0.0)
	material.set_shader_parameter("occlusion_enabled", 1.0 if on else 0.0)
	material.set_shader_parameter("scene_size", Vector2(float(context.sceneW), float(context.sceneH)) if context is Dictionary else Vector2.ONE)
	material.set_shader_parameter("foot_x", 0.0)
	material.set_shader_parameter("foot_y", 0.0)
	material.set_shader_parameter("world_to_pixel", Vector2(float(context.worldToPixelX), float(context.worldToPixelY)) if context is Dictionary else Vector2.ONE)
	material.set_shader_parameter("depth_invert", float(context.invert) if context is Dictionary else 0.0)
	material.set_shader_parameter("depth_scale", float(context.scale) if context is Dictionary else 1.0)
	material.set_shader_parameter("depth_offset", float(context.offset) if context is Dictionary else 0.0)
	material.set_shader_parameter("floor_a", float(context.floorA) if context is Dictionary else 0.0)
	material.set_shader_parameter("floor_b", float(context.floorB) if context is Dictionary else 0.0)
	material.set_shader_parameter("floor_offset", float(context.floorOffset) if context is Dictionary else 0.0)
	material.set_shader_parameter("tolerance", float(context.tolerance) if context is Dictionary else 0.0)
	material.set_shader_parameter("occlusion_blend", float(context.occlusionBlendFactor) if context is Dictionary else 0.28)
	material.set_shader_parameter("matrix_ppu", float(context.ppu) if context is Dictionary else 1.0)
	material.set_shader_parameter("matrix_center", Vector2(float(context.cx), float(context.cy)) if context is Dictionary else Vector2.ZERO)
	material.set_shader_parameter("matrix_row0", Vector3(float(context.r00), float(context.r01), float(context.r02)) if context is Dictionary else Vector3.ZERO)
	material.set_shader_parameter("matrix_row2", Vector3(float(context.r20), float(context.r21), float(context.r22)) if context is Dictionary else Vector3.ZERO)
	material.set_shader_parameter("collision_origin", Vector2(float(context.colXMin), float(context.colZMin)) if context is Dictionary else Vector2.ZERO)
	material.set_shader_parameter("collision_cell", float(context.colCellSize) if context is Dictionary else 1.0)
	material.set_shader_parameter("collision_grid", Vector2(float(context.colGridW), float(context.colGridH)) if context is Dictionary else Vector2.ZERO)
	material.set_shader_parameter("silhouette_map", texture)
	material.set_shader_parameter("depth_map", context.depthTexture if context is Dictionary and context.depthTexture is Texture2D else _white_texture())
	material.set_shader_parameter("collision_map", context.collisionTexture if context is Dictionary and context.collisionTexture is Texture2D else _white_texture())
	return material


static func _set_u(shader: ShaderMaterial, key: StringName, value: float) -> void:
	shader.set_shader_parameter(key, value)


static func _get_contact_texture() -> Texture2D:
	if _contact_texture_cache != null:
		return _contact_texture_cache
	var image := Image.create_empty(CONTACT_TEXTURE_SIZE, CONTACT_TEXTURE_SIZE, false, Image.FORMAT_RGBA8)
	var center := Vector2(CONTACT_TEXTURE_SIZE / 2.0, CONTACT_TEXTURE_SIZE / 2.0)
	for y_index: int in CONTACT_TEXTURE_SIZE:
		for x_index: int in CONTACT_TEXTURE_SIZE:
			var distance := Vector2(x_index + 0.5, y_index + 0.5).distance_to(center) / (CONTACT_TEXTURE_SIZE / 2.0)
			var alpha := lerpf(1.0, 0.6, distance / 0.5) if distance <= 0.5 else lerpf(0.6, 0.0, (distance - 0.5) / 0.5)
			image.set_pixel(x_index, y_index, Color(1.0, 1.0, 1.0, clampf(alpha, 0.0, 1.0)))
	_contact_texture_cache = ImageTexture.create_from_image(image)
	return _contact_texture_cache


static func _white_texture() -> Texture2D:
	if _white_texture_cache == null:
		var image := Image.create_empty(1, 1, false, Image.FORMAT_RGBA8)
		image.fill(Color.WHITE)
		_white_texture_cache = ImageTexture.create_from_image(image)
	return _white_texture_cache
