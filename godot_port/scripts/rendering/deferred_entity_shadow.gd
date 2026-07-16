class_name RuntimeDeferredEntityShadow
extends RefCounted

const DEG2RAD := PI / 180.0
const SHADER := preload("res://scripts/rendering/deferred_shadow.gdshader")
const ShadowMeshGeometryScript := preload("res://scripts/rendering/shadow_mesh_geometry.gd")
const ShadowBlurFilterScript := preload("res://scripts/rendering/shadow_blur_filter.gd")

static var _white_texture_cache: Texture2D = null

var _ctx: Dictionary
var _mesh: Polygon2D
var _shader: ShaderMaterial
var _positions: PackedVector2Array
var _geometry: RuntimeShadowMeshGeometry
var _blur: RuntimeShadowBlurFilter = null
var _last_softness := -1.0
var _bound_silhouette: Texture2D = null


func _init(layer: Node2D, context: Dictionary) -> void:
	_ctx = context
	_positions = PackedVector2Array([Vector2.ZERO, Vector2.ZERO, Vector2.ZERO, Vector2.ZERO])
	var uvs := PackedVector2Array([
		Vector2(0.0, 0.0),
		Vector2(1.0, 0.0),
		Vector2(1.0, 1.0),
		Vector2(0.0, 1.0),
	])
	_geometry = ShadowMeshGeometryScript.new(
		_positions,
		uvs,
		PackedInt32Array([0, 1, 2, 0, 2, 3]),
	)

	_shader = ShaderMaterial.new()
	_shader.shader = SHADER
	_shader.set_shader_parameter("scene_size", Vector2(float(_ctx.sceneW), float(_ctx.sceneH)))
	_shader.set_shader_parameter("world_to_pixel", Vector2(float(_ctx.worldToPixelX), float(_ctx.worldToPixelY)))
	_shader.set_shader_parameter("matrix_ppu", float(_ctx.ppu))
	_shader.set_shader_parameter("matrix_center", Vector2(float(_ctx.cx), float(_ctx.cy)))
	_shader.set_shader_parameter("matrix_row0", Vector3(float(_ctx.r00), float(_ctx.r01), float(_ctx.r02)))
	_shader.set_shader_parameter("matrix_row1", Vector3(float(_ctx.r10), float(_ctx.r11), float(_ctx.r12)))
	_shader.set_shader_parameter("matrix_row2", Vector3(float(_ctx.r20), float(_ctx.r21), float(_ctx.r22)))
	_shader.set_shader_parameter("depth_invert", float(_ctx.invert))
	_shader.set_shader_parameter("depth_scale", float(_ctx.scale))
	_shader.set_shader_parameter("depth_offset", float(_ctx.offset))
	_shader.set_shader_parameter("foot", Vector2.ZERO)
	_shader.set_shader_parameter("height_m", 1.0)
	_shader.set_shader_parameter("width_m", 1.0)
	_shader.set_shader_parameter("facing", 1.0)
	_shader.set_shader_parameter("billboard_mode", 0.0)
	_shader.set_shader_parameter("light_direction", Vector3(0.0, 1.0, 0.0))
	_shader.set_shader_parameter("darkness", 0.4)
	_shader.set_shader_parameter("soft_samples", 1.0)
	_shader.set_shader_parameter("soft_radius", 0.05)
	_shader.set_shader_parameter("contact_ao", 0.0)
	_shader.set_shader_parameter("contact_radius", 1.0)
	_shader.set_shader_parameter("silhouette_frame", Vector4(0.0, 0.0, 1.0, 1.0))
	_shader.set_shader_parameter("depth_map", _ctx.depthTexture)
	_shader.set_shader_parameter("silhouette_map", _white_texture())

	_mesh = Polygon2D.new()
	_mesh.name = "DeferredEntityShadow"
	_geometry.bind(_mesh)
	_mesh.material = _shader
	_mesh.texture = _white_texture()
	_mesh.visible = false
	layer.add_child(_mesh)


func update(source: Variant, env: Dictionary, _field: Variant = null) -> void:
	# Real mode takes its world-convention light vector from env.key; the source
	# deliberately does not consume the optional planar projection field here.
	var texture: Variant = source.get_texture()
	if not texture is Texture2D or not source.is_visible() or env.shadow.enabled != true \
		or (float(env.shadow.darkness) <= 0.0 and float(env.shadow.contact) <= 0.0):
		_mesh.visible = false
		return
	_mesh.visible = true

	var foot_x := float(source.get_foot_x())
	var foot_y := float(source.get_foot_y())
	var world_width := maxf(1.0, float(source.get_world_width()))
	var world_height := maxf(1.0, float(source.get_world_height()))

	var texture_source: Texture2D = texture.atlas if texture is AtlasTexture and texture.atlas != null else texture
	if not is_same(texture_source, _bound_silhouette):
		_shader.set_shader_parameter("silhouette_map", texture_source)
		_mesh.texture = texture
		_bound_silhouette = texture_source
	var frame: Rect2 = texture.region if texture is AtlasTexture else Rect2(0.0, 0.0, texture.get_width(), texture.get_height())
	var source_width := float(texture_source.get_width()) if texture_source.get_width() > 0 else 1.0
	var source_height := float(texture_source.get_height()) if texture_source.get_height() > 0 else 1.0

	var reach := world_height * float(env.shadow.length)
	var half := reach + world_width * 1.5
	var x0 := foot_x - half
	var x1 := foot_x + half
	var y0 := foot_y - half
	var y1 := foot_y + half
	_positions[0] = Vector2(x0, y0)
	_positions[1] = Vector2(x1, y0)
	_positions[2] = Vector2(x1, y1)
	_positions[3] = Vector2(x0, y1)
	_geometry.positions = _positions
	_geometry.update_position_buffer()

	var azimuth := float(env.key.azimuthDeg) * DEG2RAD
	var elevation := float(env.key.elevationDeg) * DEG2RAD
	var elevation_cosine := cos(elevation)
	_shader.set_shader_parameter("light_direction", Vector3(
		elevation_cosine * cos(azimuth),
		sin(elevation),
		elevation_cosine * sin(azimuth),
	))
	_shader.set_shader_parameter("foot", Vector2(foot_x, foot_y))
	var up_y := absf(float(_ctx.r11)) if absf(float(_ctx.r11)) > 0.001 else 1.0
	_shader.set_shader_parameter("height_m", world_height * float(_ctx.worldToPixelY) / (maxf(float(_ctx.ppu), 0.000001) * up_y))
	_shader.set_shader_parameter("width_m", world_width * float(_ctx.worldToPixelX) / maxf(float(_ctx.ppu), 0.000001))
	_shader.set_shader_parameter("facing", float(source.get_facing()))
	_shader.set_shader_parameter("billboard_mode", 1.0 if env.shadow.billboard == "camera" else 0.0)
	_shader.set_shader_parameter("darkness", clampf(float(env.shadow.darkness), 0.0, 1.0))
	_shader.set_shader_parameter("soft_samples", float(clampi(roundi(float(env.shadow.softSamples)), 1, 8)))
	_shader.set_shader_parameter("soft_radius", float(env.shadow.softRadius))
	_shader.set_shader_parameter("contact_ao", clampf(float(env.shadow.contact), 0.0, 1.0))
	_shader.set_shader_parameter("contact_radius", world_width * maxf(0.1, float(env.shadow.contactSize)) * 0.65)
	_shader.set_shader_parameter("silhouette_frame", Vector4(
		frame.position.x / source_width,
		frame.position.y / source_height,
		frame.size.x / source_width,
		frame.size.y / source_height,
	))

	var softness := float(env.shadow.softness)
	if softness > 0.0:
		var strength := maxf(0.5, softness * 4.0)
		if _blur == null:
			_blur = ShadowBlurFilterScript.new(_mesh, strength, 2)
			_last_softness = softness
		elif absf(softness - _last_softness) > 0.001:
			_blur.strength = strength
			_last_softness = softness
	elif _blur != null:
		_blur.destroy()
		_blur = null
		_last_softness = -1.0


func destroy() -> void:
	if _blur != null:
		_blur.destroy()
		_blur = null
	if _mesh != null and is_instance_valid(_mesh):
		if _mesh.get_parent() != null:
			_mesh.get_parent().remove_child(_mesh)
		_mesh.material = null
		_mesh.texture = null
		_mesh.free()
	_mesh = null
	_shader = null
	if _geometry != null:
		_geometry.destroy()
	_geometry = null
	_bound_silhouette = null


static func _white_texture() -> Texture2D:
	if _white_texture_cache == null:
		var image := Image.create_empty(1, 1, false, Image.FORMAT_RGBA8)
		image.fill(Color.WHITE)
		_white_texture_cache = ImageTexture.create_from_image(image)
	return _white_texture_cache
