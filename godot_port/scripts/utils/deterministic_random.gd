class_name RuntimeDeterministicRandom
extends RefCounted

## Direct translation of src/utils/deterministicRandom.ts.

var state: int


func _init(seed_text: String) -> void:
	state = seed_utf8_fnv1a(seed_text)


static func seed_utf8_fnv1a(text: String) -> int:
	var hash := 0x811c9dc5
	for byte: int in text.to_utf8_buffer():
		hash = ((hash ^ byte) * 0x01000193) & 0xffffffff
	return hash if hash != 0 else 1


static func create_deterministic_random(seed_text: String) -> Callable:
	var random := RuntimeDeterministicRandom.new(seed_text)
	# The source arrow closure owns `random`. A bound Callable does not retain a
	# local RefCounted target in Godot, so capture it explicitly in a closure.
	return func() -> float: return random.next()


func next() -> float:
	var x := state & 0xffffffff
	x = (x ^ ((x << 13) & 0xffffffff)) & 0xffffffff
	x = (x ^ (x >> 17)) & 0xffffffff
	x = (x ^ ((x << 5) & 0xffffffff)) & 0xffffffff
	state = x
	return float(state) / 4294967296.0


func get_state() -> int:
	return state & 0xffffffff


func set_state(value: Variant) -> void:
	var numeric: Variant = null
	if value is int or value is float:
		numeric = float(value)
	elif value is bool:
		numeric = 1.0 if value else 0.0
	elif value == null:
		numeric = 0.0
	elif value is String and (value.is_valid_float() or value.is_valid_int()):
		numeric = value.to_float()
	if numeric == null or is_nan(float(numeric)) or is_inf(float(numeric)):
		return
	state = int(float(numeric)) & 0xffffffff
	if state == 0: state = 1
