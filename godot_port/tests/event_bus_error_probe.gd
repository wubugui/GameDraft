extends SceneTree

var bus := RuntimeEventBus.new()
var calls: Array[String] = []


func _init() -> void:
	bus.on("event", Callable(self, "_broken"))
	bus.on("event", Callable(self, "_after"))
	bus.emit("event", null)
	if calls != ["broken", "after"]:
		print("EventBus listener isolation probe: FAIL %s" % calls)
		quit(1)
		return
	print("EventBus listener isolation probe: PASS")
	quit(0)


func _broken(_payload: Variant) -> void:
	calls.push_back("broken")
	assert(false, "intentional listener failure probe")


func _after(_payload: Variant) -> void:
	calls.push_back("after")
