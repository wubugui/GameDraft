class_name RuntimeUniformShadowField
extends RefCounted

var environment: Dictionary


func _init(env: Dictionary) -> void: environment = env
func sample(_world_x: float = 0.0, _world_y: float = 0.0) -> Dictionary:
	var key: Variant = environment.get("key", {})
	var shadow: Variant = environment.get("shadow", {})
	return {
		"angleRad": deg_to_rad(float(key.get("azimuthDeg", 125.0)) + 180.0),
		"length": float(shadow.get("length", 0.7)),
	}
