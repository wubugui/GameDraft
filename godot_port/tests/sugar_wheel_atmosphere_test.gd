extends Node

var speeches: Array[Dictionary] = []
var angle := 0.0
var current_instance: Dictionary = {}
var rng_value := 0.0


func _ready() -> void:
	var sectors: Array = []
	for index: int in 12: sectors.push_back({"id": "dragon" if index == 3 else "s%d" % index, "label": str(index)})
	current_instance = {"id": "atmos", "sectors": sectors, "atmosphereGroups": [{"id": "g", "weight": 1, "vars": {"start": ["开场"], "spin": ["旋转"]}, "start": [{"op": "say", "role": "a", "pool": "start"}, {"op": "wait", "sec": 0.4}, {"op": "say", "role": "b", "text": "接句"}], "spinning": [{"op": "say", "role": "c", "pool": "spin"}], "slowing": [{"op": "when_near_sector", "sectorId": "dragon", "degBuffer": 20, "then": [{"op": "say", "role": "near", "text": "龙"}], "else": [{"op": "say", "role": "far", "text": "别处"}]}]}]}
	var scheduler := RuntimeSugarWheelAtmosphereScheduler.new({"showSpeech": Callable(self, "_show_speech"), "getWheelGeomAngleMod": Callable(self, "_get_angle"), "getSpinOmega": func() -> float: return 0.0, "getInstance": Callable(self, "_get_instance")}, Callable(self, "_rng"))
	scheduler.select_group(current_instance); scheduler.notify_phase("start"); assert(speeches.map(func(v: Dictionary) -> String: return v.text) == ["开场"])
	scheduler.notify_phase("spinning"); assert(scheduler.pending_phase == "spinning")
	scheduler.tick(0.5); assert(speeches.map(func(v: Dictionary) -> String: return v.text) == ["开场", "接句", "旋转"] and scheduler.current_phase == "spinning")
	angle = (3.0 + 0.5) * RuntimeSugarWheelSpinPhysics.TAU / 12.0; scheduler.notify_phase("slowing"); assert(speeches[-1].role == "near" and speeches[-1].text == "龙")
	scheduler.select_group(current_instance); angle = 0.0; scheduler.notify_phase("slowing"); assert(speeches[-1].role == "far" and speeches[-1].text == "别处")
	assert(RuntimeSugarWheelAtmosphereScheduler.resolve_atmosphere_phase("idle", 9.0) == null and RuntimeSugarWheelAtmosphereScheduler.resolve_atmosphere_phase("spinning", 3.0) == "spinning" and RuntimeSugarWheelAtmosphereScheduler.resolve_atmosphere_phase("spinning", 2.0) == "slowing")
	var deterministic_instance := current_instance.duplicate(true); deterministic_instance.id = "转盘_生肖"; deterministic_instance.atmosphereGroups[0].vars.start = ["甲", "乙", "丙"]
	var deterministic := RuntimeSugarWheelAtmosphereScheduler.new({"showSpeech": Callable(self, "_show_speech"), "getWheelGeomAngleMod": Callable(self, "_get_angle"), "getSpinOmega": func() -> float: return 0.0, "getInstance": Callable(self, "_get_instance")}); current_instance = deterministic_instance; speeches.clear(); deterministic.select_group(deterministic_instance); deterministic.notify_phase("start"); assert(speeches[0].text == "乙")
	scheduler.cancel(); deterministic.cancel(); print("SugarWheel atmosphere phase/pending/near-sector script contract test: PASS"); get_tree().quit(0)


func _show_speech(role: String, text: String, duration: Variant = null) -> void:
	speeches.push_back({"role": role, "text": text, "duration": duration})


func _get_angle() -> float: return angle
func _get_instance() -> Dictionary: return current_instance
func _rng() -> float: return rng_value
