extends "res://scripts/bootstrap.gd"

var pixel_density_sync_calls := 0


func _ready() -> void:
	pass


func _sync_entity_pixel_density_match() -> void:
	pixel_density_sync_calls += 1
