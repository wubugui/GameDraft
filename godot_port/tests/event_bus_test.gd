extends SceneTree

var bus := RuntimeEventBus.new()
var calls: Array[String] = []


func _init() -> void:
	var first := Callable(self, "_first")
	var second := Callable(self, "_second")
	bus.on("event", first)
	bus.on("event", first)
	bus.on("event", second)
	assert(EventBusProbe.listener_count(bus, "event") == 2)
	bus.emit("event", "one")
	assert(calls == ["first:one", "second:one"])
	bus.emit("event", "two")
	assert(calls == ["first:one", "second:one", "second:two"])
	bus.on("outer", Callable(self, "_outer"))
	bus.on("inner", Callable(self, "_inner"))
	bus.emit("outer", "start")
	assert(calls.slice(-3) == ["outer:start", "inner:nested", "outer:end"])
	bus.on("mutating", Callable(self, "_add_late"))
	bus.on("mutating", Callable(self, "_stable"))
	bus.emit("mutating", "first")
	assert(calls.slice(-2) == ["add:first", "stable:first"])
	bus.emit("mutating", "second")
	assert(calls.slice(-3) == ["add:second", "stable:second", "late:second"])
	bus.enable_debug_trace(2)
	bus.emit("traced", {"z": 2, "a": [1, null]})
	bus.emit("traced-empty")
	bus.emit("traced-final", {"ok": true})
	assert(bus.get_debug_trace() == [{"seq": 2, "event": "traced-empty", "payload": null}, {"seq": 3, "event": "traced-final", "payload": {"ok": true}}])
	bus.clear_debug_trace(); bus.emit("after-clear", {"nested": {"value": "x"}})
	assert(bus.get_debug_trace() == [{"seq": 1, "event": "after-clear", "payload": {"nested": {"value": "x"}}}])
	bus.clear()
	assert(EventBusProbe.listener_count(bus) == 0)
	print("RuntimeEventBus semantics test: PASS")
	quit(0)


func _first(payload: Variant) -> void:
	calls.push_back("first:%s" % payload)
	bus.off("event", Callable(self, "_first"))


func _second(payload: Variant) -> void:
	calls.push_back("second:%s" % payload)


func _outer(payload: Variant) -> void:
	calls.push_back("outer:%s" % payload)
	bus.emit("inner", "nested")
	calls.push_back("outer:end")


func _inner(payload: Variant) -> void:
	calls.push_back("inner:%s" % payload)


func _add_late(payload: Variant) -> void:
	calls.push_back("add:%s" % payload)
	bus.on("mutating", Callable(self, "_late"))


func _stable(payload: Variant) -> void:
	calls.push_back("stable:%s" % payload)


func _late(payload: Variant) -> void:
	calls.push_back("late:%s" % payload)
