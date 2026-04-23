"""EventBus：多 sink + 异常隔离。"""
from __future__ import annotations

from tools.chronicle_sim_v3.engine.eventbus import CookEvent, EventBus


def test_emit_to_subscribers() -> None:
    bus = EventBus()
    seen: list[dict] = []
    bus.subscribe(lambda e: seen.append(e))
    bus.emit({"event": "cook.start"})
    assert seen == [{"event": "cook.start"}]


def test_multi_sink() -> None:
    bus = EventBus()
    a, b = [], []
    bus.subscribe(lambda e: a.append(e))
    bus.subscribe(lambda e: b.append(e))
    bus.emit({"x": 1})
    assert a == [{"x": 1}]
    assert b == [{"x": 1}]


def test_unsubscribe() -> None:
    bus = EventBus()
    seen: list = []
    h = bus.subscribe(lambda e: seen.append(e))
    bus.emit({"a": 1})
    h.unsubscribe()
    bus.emit({"a": 2})
    assert seen == [{"a": 1}]


def test_sink_exception_isolated() -> None:
    bus = EventBus()
    good: list = []

    def boom(_):
        raise RuntimeError("sink crash")

    bus.subscribe(boom)
    bus.subscribe(lambda e: good.append(e))
    bus.emit({"x": 1})
    assert good == [{"x": 1}]


def test_cook_event_enum_values() -> None:
    assert CookEvent.cook_start.value == "cook.start"
    assert CookEvent.node_end.value == "node.end"
