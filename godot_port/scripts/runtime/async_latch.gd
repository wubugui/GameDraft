class_name RuntimeAsyncLatch
extends RefCounted

signal resolved

var _is_resolved := false
var _is_rejected := false
var _reason: Variant = null


func resolve() -> void:
	if _is_resolved:
		return
	_is_resolved = true
	resolved.emit()


func reject(reason: Variant = null) -> void:
	if _is_resolved:
		return
	_is_rejected = true
	_reason = reason
	_is_resolved = true
	resolved.emit()


func wait() -> bool:
	if not _is_resolved:
		await resolved
	return not _is_rejected


func is_rejected() -> bool:
	return _is_rejected


func get_reason() -> Variant:
	return _reason
