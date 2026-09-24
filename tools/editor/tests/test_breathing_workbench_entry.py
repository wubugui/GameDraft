# -*- coding: utf-8 -*-
"""主编辑器的呼吸工作台入口:菜单起对的模块、带上 --open、登记进外置进程监视表(退出 / 回前台时静默重读只读镜像);
静默重读真变了才刷已打开页;回前台那条也挂上了。"""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def test_main_window_breathing_workbench_entry(monkeypatch) -> None:
    from tools.editor import main_window

    launched: list[list[str]] = []

    class _Proc:
        def poll(self):
            return None

    def fake_popen(cmd, **_kw):
        launched.append(list(cmd))
        return _Proc()

    monkeypatch.setattr(main_window.subprocess, "Popen", fake_popen)
    procs: list = []
    msgs: list[str] = []
    owner = SimpleNamespace(
        _ensure_valid_tool_root=lambda: _ROOT,
        _dialogue_external_processes=procs,
        _dialogue_process_watch_timer=SimpleNamespace(start=lambda: None),
        _status=SimpleNamespace(showMessage=lambda m, *_a: msgs.append(m)),
    )
    main_window.MainWindow.open_breathing_workbench(owner, "dream_face_paper")
    assert launched[0][1:] == ["-m", "tools.breathing_workbench", "--open", "dream_face_paper"]
    assert procs, "要登记进外置进程监视表(退出时自动重读)"
    main_window.MainWindow.open_breathing_workbench(owner)
    assert launched[1][1:] == ["-m", "tools.breathing_workbench"]

    calls: list[str] = []
    changed = {"v": False}
    owner2 = SimpleNamespace(
        _model=SimpleNamespace(project_path=Path("."), reload_breathing_from_disk=lambda: (calls.append("model"), changed["v"])[1]),
        _refresh_open_pages_after_disk_change=lambda: calls.append("pages"),
    )
    main_window.MainWindow._resync_breathing_from_disk(owner2)
    assert calls == ["model"], "没变不刷页"
    changed["v"] = True
    main_window.MainWindow._resync_breathing_from_disk(owner2)
    assert calls == ["model", "model", "pages"]

    src = (_ROOT / "tools/editor/main_window.py").read_text(encoding="utf-8")
    assert "self._resync_breathing_from_disk()" in src
    assert "QTimer.singleShot(0, self, self._resync_breathing_from_disk)" in src
    assert '"呼吸工作台…", self.open_breathing_workbench' in src
