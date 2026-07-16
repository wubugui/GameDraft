class_name RuntimeEntityShadowSource
extends RefCounted

enum EntityKind {
	PLAYER,
	NPC,
	HOTSPOT,
}

var _kind: EntityKind
var _entity: Variant


func _init(kind: EntityKind, entity: Variant) -> void:
	_kind = kind
	_entity = entity


static func for_player(player: RuntimePlayer) -> RuntimeEntityShadowSource:
	return RuntimeEntityShadowSource.new(EntityKind.PLAYER, player)


static func for_npc(npc: RuntimeNpc) -> RuntimeEntityShadowSource:
	return RuntimeEntityShadowSource.new(EntityKind.NPC, npc)


static func for_hotspot(hotspot: RuntimeHotspot) -> RuntimeEntityShadowSource:
	return RuntimeEntityShadowSource.new(EntityKind.HOTSPOT, hotspot)


func get_foot_x() -> float:
	if _kind == EntityKind.PLAYER or _kind == EntityKind.NPC:
		return _entity.get_x()
	return _entity.container.position.x


func get_foot_y() -> float:
	if _kind == EntityKind.PLAYER or _kind == EntityKind.NPC:
		return _entity.get_y()
	return _entity.depth_occlusion_foot_world_y()


func get_world_width() -> float:
	var size: Dictionary = _entity.sprite.get_world_size() if _kind == EntityKind.PLAYER else _entity.get_world_size()
	return float(size.get("width", 0.0))


func get_world_height() -> float:
	var size: Dictionary = _entity.sprite.get_world_size() if _kind == EntityKind.PLAYER else _entity.get_world_size()
	return float(size.get("height", 0.0))


func get_texture() -> Variant:
	return _entity.sprite.get_display_texture() if _kind == EntityKind.PLAYER else _entity.get_display_texture()


func get_facing() -> float:
	if _kind == EntityKind.PLAYER:
		return -1.0 if _entity.get_facing_direction() == "left" else 1.0
	return float(_entity.get_facing())


func is_visible() -> bool:
	return _entity.sprite.visible if _kind == EntityKind.PLAYER else _entity.container.visible
