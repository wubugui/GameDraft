extends Node

var log_values: Array[String] = []
var rng_value := 0.0


func _ready() -> void:
	var context := {"rng": Callable(self, "_rng"), "vars": {"lines": ["甲", "乙"]}, "slots": {}}
	var runner := RuntimeMinigameScriptRunner.new({"mark": Callable(self, "_mark")}, context)
	rng_value = 0.0
	runner.run_phase([{"op": "chance", "p": 1.0, "then": [{"op": "mark", "text": "A"}, {"op": "wait", "sec": 1.0}, {"op": "mark", "text": "B"}], "else": [{"op": "mark", "text": "E"}]}])
	assert(log_values == ["A"] and runner.is_running())
	runner.tick(0.5); assert(log_values == ["A"])
	runner.tick(0.6); assert(log_values == ["A", "B"] and not runner.is_running())
	log_values.clear(); rng_value = 0.9
	runner.run_phase([{"op": "chance", "p": 0.0, "then": [{"op": "mark", "text": "T"}], "else": [{"op": "mark", "text": "E"}]}]); assert(log_values == ["E"])
	rng_value = 0.5
	runner.run_phase([{"op": "pick", "pool": "lines", "slot": "chosen"}]); assert(context.slots.chosen == "乙")
	runner.run_phase([{"op": "unknown_probe"}, {"op": "mark", "text": "after"}]); assert(runner.unknown_ops == ["unknown_probe"] and log_values[-1] == "after" and not runner.is_running())
	runner.run_phase([{"op": "wait", "sec": 10.0}]); assert(runner.is_running()); runner.cancel(); assert(not runner.is_running())
	print("MinigameScript pick/wait/chance/children/unknown/cancel contract test: PASS")
	get_tree().quit(0)


func _rng() -> float:
	return rng_value


func _mark(step: Dictionary, _context: Dictionary, _children: Callable) -> Variant:
	log_values.push_back(str(step.get("text", ""))); return null
