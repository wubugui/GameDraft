class_name RuntimeUniformShadowField
extends RefCounted

const DEG2RAD := PI / 180.0

var env: Dictionary


func _init(next_env: Dictionary) -> void:
	env = next_env


func sample(_world_x: float = 0.0, _world_y: float = 0.0) -> Dictionary:
	return {
		"angleRad": (float(env.key.azimuthDeg) + 180.0) * DEG2RAD,
		"length": env.shadow.length,
	}
