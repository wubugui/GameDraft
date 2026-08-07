from __future__ import annotations

import os
from types import SimpleNamespace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QWidget

from tools.editor import main_window


def test_npm_run_command_uses_cmd_shell_on_windows(monkeypatch):
    monkeypatch.setattr(main_window.os, "name", "nt", raising=False)
    monkeypatch.setitem(main_window.os.environ, "ComSpec", "C:/Windows/System32/cmd.exe")
    monkeypatch.setattr(main_window, "npm_command", lambda: r"C:\Program Files\nodejs\npm.cmd")

    program, args = main_window._npm_run_command("run", "dev")

    assert program == "C:/Windows/System32/cmd.exe"
    assert args == ["/d", "/c", r"C:\Program Files\nodejs\npm.cmd", "run", "dev"]


def test_npm_run_command_uses_direct_npm_on_unix(monkeypatch):
    monkeypatch.setattr(main_window.os, "name", "posix", raising=False)
    monkeypatch.setattr(main_window, "npm_command", lambda: "/opt/homebrew/bin/npm")

    program, args = main_window._npm_run_command("run", "dev")

    assert program == "/opt/homebrew/bin/npm"
    assert args == ["run", "dev"]


def test_reference_catalog_reload_isolates_one_broken_editor():
    app = QApplication.instance() or QApplication([])
    del app

    class BrokenEditor(QWidget):
        def reload_refs_from_model(self):
            raise RuntimeError("bad catalog")

    class HealthyEditor(QWidget):
        calls = 0

        def reload_refs_from_model(self):
            self.calls += 1

    broken = BrokenEditor()
    healthy = HealthyEditor()
    status = SimpleNamespace(showMessage=lambda *_args: None)
    owner = SimpleNamespace(
        _editor_instances=[broken, healthy],
        _model=SimpleNamespace(),
        _status=status,
    )
    # 假 owner 没有 _stack（拿不到"当前是哪页"）→ 走"退回全刷"分支，正是要锁的
    # "一页坏不拖累其它页"。逐页刷新的实现由 MainWindow 提供，这里显式接上。
    owner._refresh_page_reference_candidates = (
        lambda inst, **kw: main_window.MainWindow._refresh_page_reference_candidates(
            owner, inst, **kw,
        )
    )

    main_window.MainWindow._reload_all_reference_catalogs(owner)

    assert healthy.calls == 1
    # 水位被清空：其余页下次切过去时必刷（目录变了，所有页候选都过期）。
    assert owner._page_refresh_revisions.get(id(broken)) is None


def test_stack_teardown_suppresses_page_change_side_effects():
    """拆栈时 removeWidget 自己发的 currentChanged 不得触发提交/记水位。

    没有 guard 的话：换工程整栈重建，拆到一半的页会被"切页"逻辑当成正常离开，
    给正在销毁的编辑器提交 staging，并把水位写回刚被清空的表里。
    """
    app = QApplication.instance() or QApplication([])
    del app

    calls: list[str] = []

    class Page(QWidget):
        def commit_pending_on_leave(self):
            calls.append("commit")
            return True

        def reload_refs_from_model(self):
            calls.append("reload")

    from PySide6.QtWidgets import QStackedWidget

    stack = QStackedWidget()
    pages = [Page(), Page()]
    for p in pages:
        stack.addWidget(p)
    owner = SimpleNamespace(
        _stack=stack,
        _editor_instances=list(pages),
        _editor_labels=["a", "b"],
        _status=SimpleNamespace(showMessage=lambda *_args: None),
        _page_refresh_revisions={id(pages[0]): 3},
        _last_stack_page_index=0,
        _model_revision=3,
        _tearing_down_stack=False,
        _restoring_stack_after_task_flush_failure=False,
        _activated_editor_ids=set(),
        _stale_editor_locks={},
    )
    owner._commit_leaving_page = lambda i: main_window.MainWindow._commit_leaving_page(owner, i)
    owner._refresh_page_reference_candidates = (
        lambda inst, **kw: main_window.MainWindow._refresh_page_reference_candidates(owner, inst, **kw)
    )
    stack.currentChanged.connect(lambda i: main_window.MainWindow._on_stack_page_changed(owner, i))

    main_window.MainWindow._clear_editor_stack(owner)

    assert calls == [], f"拆栈期间不得有任何提交/刷新副作用，实际: {calls}"
    assert owner._page_refresh_revisions == {}, "拆完必须留下干净的水位表"
    assert owner._last_stack_page_index == -1
    assert owner._tearing_down_stack is False, "guard 必须复位"
    stack.deleteLater()


def test_catalog_reload_only_force_refreshes_the_visible_page():
    """目录变更挂在窗口激活上：不能一次把十几页的动作行全重建（会明显冻一下）。

    当前页立刻强刷；其余页只清水位，等切过去时由 _on_stack_page_changed 刷。
    """
    app = QApplication.instance() or QApplication([])
    del app

    class Page(QWidget):
        def __init__(self):
            super().__init__()
            self.calls = 0

        def reload_refs_from_model(self):
            self.calls += 1

    visible, hidden = Page(), Page()
    owner = SimpleNamespace(
        _editor_instances=[hidden, visible],
        _model=SimpleNamespace(),
        _status=SimpleNamespace(showMessage=lambda *_args: None),
        _stack=SimpleNamespace(currentIndex=lambda: 1),
        _page_refresh_revisions={id(hidden): 7, id(visible): 7},
        _model_revision=7,
    )
    owner._refresh_page_reference_candidates = (
        lambda inst, **kw: main_window.MainWindow._refresh_page_reference_candidates(
            owner, inst, **kw,
        )
    )

    main_window.MainWindow._reload_all_reference_catalogs(owner)

    assert visible.calls == 1, "当前页必须立刻刷新"
    assert hidden.calls == 0, "非当前页不该在这一刻重建"
    assert owner._page_refresh_revisions.get(id(hidden)) is None, "但它的水位必须被清掉，下次切过去要刷"


def test_dialogue_process_exit_refreshes_and_stops_watch_timer():
    class Process:
        def __init__(self, running: bool) -> None:
            self.running = running

        def poll(self):
            return None if self.running else 0

    events: list[str] = []
    owner = SimpleNamespace(
        _dialogue_external_processes=[Process(False), Process(True)],
        _dialogue_process_watch_timer=SimpleNamespace(
            stop=lambda: events.append("stop"),
        ),
        _reload_all_reference_catalogs=lambda: events.append("reload"),
    )

    main_window.MainWindow._poll_dialogue_external_processes(owner)
    assert len(owner._dialogue_external_processes) == 1
    assert events == ["reload"]

    owner._dialogue_external_processes[0].running = False
    main_window.MainWindow._poll_dialogue_external_processes(owner)
    assert events == ["reload", "reload", "stop"]
