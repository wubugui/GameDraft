extends SceneTree


func _init() -> void:
	assert(RuntimeDeterministicRandom.seed_utf8_fnv1a("gamedraft-runtime-v1") == 0x970a391f)
	var random := RuntimeDeterministicRandom.new("gamedraft-runtime-v1")
	assert(random.get_state() == 0x970a391f)
	var values := [random.next(), random.next(), random.next()]
	assert(values == [0.832512880442664, 0.7707309504039586, 0.7573286963161081])
	var factory_random := RuntimeDeterministicRandom.create_deterministic_random("gamedraft-runtime-v1")
	assert(factory_random.call() == 0.832512880442664)
	assert(factory_random.call() == 0.7707309504039586)
	var state_before_invalid := random.get_state()
	random.set_state("not-a-number")
	assert(random.get_state() == state_before_invalid)
	random.set_state(0)
	assert(random.get_state() == 1)
	print("DeterministicRandom UTF-8 seed/factory-closure/xorshift/state direct-translation test: PASS")
	quit(0)
