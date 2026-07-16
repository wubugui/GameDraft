class_name RuntimeShadowMeshGeometry
extends RefCounted

# Pixi keeps MeshGeometry separate from Mesh and mutates its position/UV
# buffers in place. Polygon2D fuses those engine objects, so this adapter keeps
# the source-owned geometry/buffer identity and performs only the final upload.
var positions: PackedVector2Array
var uvs: PackedVector2Array
var indices: PackedInt32Array
var destroyed := false

var _mesh: Polygon2D = null
var _uv_scale := Vector2.ONE


func _init(
	next_positions: PackedVector2Array,
	next_uvs: PackedVector2Array,
	next_indices: PackedInt32Array,
) -> void:
	positions = next_positions
	uvs = next_uvs
	indices = next_indices


func bind(mesh: Polygon2D, uv_scale := Vector2.ONE) -> void:
	_mesh = mesh
	_uv_scale = uv_scale
	update_position_buffer()
	update_uv_buffer()


func set_uv_scale(value: Vector2) -> void:
	_uv_scale = value


func update_position_buffer() -> void:
	if _mesh != null:
		_mesh.polygon = positions


func update_uv_buffer() -> void:
	if _mesh == null:
		return
	var engine_uvs := PackedVector2Array()
	engine_uvs.resize(uvs.size())
	for index: int in uvs.size():
		engine_uvs[index] = uvs[index] * _uv_scale
	_mesh.uv = engine_uvs


func destroy() -> void:
	if destroyed:
		return
	destroyed = true
	_mesh = null
	positions = PackedVector2Array()
	uvs = PackedVector2Array()
	indices = PackedInt32Array()
