class_name RuntimeAudioPlaybackHandle
extends RefCounted

var _stopped := false
var _stop_callback := Callable()


func _init(stop_callback: Callable) -> void:
	_stop_callback = stop_callback


func stop() -> void:
	if _stopped:
		return
	_stopped = true
	var callback := _stop_callback
	_stop_callback = Callable()
	if callback.is_valid():
		callback.call()


func _complete_naturally() -> bool:
	if _stopped:
		return false
	_stopped = true
	_stop_callback = Callable()
	return true


func is_stopped() -> bool:
	return _stopped
