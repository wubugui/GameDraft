class_name RuntimeSystem
extends Node


# Godot has no structural interface declaration equivalent to TypeScript's
# IGameSystem.  RuntimeRoot validates these five methods on every factory
# product; this base class provides neutral defaults without claiming gameplay.
func init(_ctx: Dictionary) -> void:
	return


func update(_dt: float) -> void:
	return


func serialize() -> Dictionary:
	return {}


func deserialize(_data: Dictionary) -> void:
	return


func destroy() -> void:
	return
