"""叙事状态机「选中画布元素」跳转：主窗落点、导航历史重放、全局搜索命中元素。"""
from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tools.editor.editors.narrative_state_editor import NarrativeStateEditor
from tools.editor.main_window import MainWindow, _NavLocation


class _FakeWindow:
    _pointer_segments = staticmethod(MainWindow._pointer_segments)

    def __init__(self, narrative_graphs: dict | None = None) -> None:
        self._model = SimpleNamespace(narrative_graphs=narrative_graphs or {})
        self._editor_instances = [object(), NarrativeStateEditor.__new__(NarrativeStateEditor)]
        self._nav_replaying = False
        self.pages: list[int] = []
        self.recorded: list[_NavLocation] = []
        self.calls: list[tuple] = []
        self.messages: list[str] = []
        self._status = SimpleNamespace(showMessage=lambda msg, _ms=0: self.messages.append(msg))

    def _show_stack_page(self, index: int) -> None:
        self.pages.append(index)

    def _record_nav(self, loc: _NavLocation) -> None:
        self.recorded.append(loc)

    def _update_nav_buttons(self) -> None:
        pass

    def navigate_to_narrative_state(self, graph_id: str, state_id: str) -> None:
        self.calls.append(("state", graph_id, state_id))

    def navigate_to_narrative_element(self, composition_id: str, element_id: str) -> None:
        self.calls.append(("element", composition_id, element_id))

    def _nav_hit_generic(self, label: str, select_id: str = "", method: str = "select_by_id"):
        self.calls.append(("page", label))
        return None, label


_NARR = {"compositions": [{
    "id": "comp",
    "mainGraph": {"id": "flow", "states": {"s": {"id": "s"}}},
    "elements": [
        {"id": "bb", "kind": "dialogueBlackbox", "refId": "对话"},
        {"id": "w", "kind": "wrapperGraph", "graph": {"id": "wg", "states": {"引路": {"id": "引路"}}}},
    ],
}]}


class NarrativeElementNavigationTests(unittest.TestCase):
    def test_navigate_to_element_shows_page_records_history_and_focuses(self) -> None:
        win = _FakeWindow()
        with patch.object(NarrativeStateEditor, "focus_element", return_value=True) as focus:
            MainWindow.navigate_to_narrative_element(win, " comp ", "bb")
        focus.assert_called_once_with("comp", "bb")
        self.assertEqual(win.pages, [1])
        self.assertEqual(win.recorded, [_NavLocation("narrative_element", ("comp", "bb"))])
        self.assertEqual(win.messages, [])

    def test_navigate_to_element_reports_miss_in_status_bar(self) -> None:
        win = _FakeWindow()
        with patch.object(NarrativeStateEditor, "focus_element", return_value=False):
            MainWindow.navigate_to_narrative_element(win, "comp", "gone")
        self.assertEqual(len(win.messages), 1)
        self.assertIn("gone", win.messages[0])

    def test_navigate_to_element_ignores_empty_ids(self) -> None:
        win = _FakeWindow()
        with patch.object(NarrativeStateEditor, "focus_element", return_value=True) as focus:
            MainWindow.navigate_to_narrative_element(win, "comp", "  ")
        focus.assert_not_called()
        self.assertEqual(win.pages, [])

    def test_history_replay_and_label(self) -> None:
        win = _FakeWindow()
        loc = _NavLocation("narrative_element", ("comp", "bb"))
        MainWindow._replay_nav(win, loc)
        self.assertEqual(win.calls, [("element", "comp", "bb")])
        label = MainWindow._nav_location_label(win, loc)
        self.assertIn("comp", label)
        self.assertIn("bb", label)

    def test_search_hit_on_element_field_selects_element(self) -> None:
        win = _FakeWindow(_NARR)
        ok, _msg = MainWindow._navigate_to_search_hit_inner(
            win, "public/assets/data/narrative_graphs.json", "/compositions/0/elements/0/refId", [])
        self.assertTrue(ok)
        self.assertEqual(win.calls, [("element", "comp", "bb")])

    def test_search_hit_inside_wrapper_state_still_lands_on_state(self) -> None:
        win = _FakeWindow(_NARR)
        ok, _msg = MainWindow._navigate_to_search_hit_inner(
            win, "public/assets/data/narrative_graphs.json",
            "/compositions/0/elements/1/graph/states/引路/onEnterActions/0", [])
        self.assertTrue(ok)
        self.assertEqual(win.calls, [("state", "wg", "引路")])

    def test_search_hit_outside_compositions_opens_page(self) -> None:
        win = _FakeWindow(_NARR)
        MainWindow._navigate_to_search_hit_inner(
            win, "public/assets/data/narrative_graphs.json", "/signals/0/id", [])
        self.assertEqual(win.calls, [("page", "叙事状态机")])


if __name__ == "__main__":
    unittest.main()
