from __future__ import annotations

import os
from types import SimpleNamespace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QWidget

from tools.editor import main_window
from tools.editor.shared import npm_process


def test_npm_run_command_uses_cmd_shell_on_windows(monkeypatch):
    monkeypatch.setattr(npm_process.os, "name", "nt", raising=False)
    monkeypatch.setitem(npm_process.os.environ, "ComSpec", "C:/Windows/System32/cmd.exe")
    monkeypatch.setattr(npm_process, "npm_command", lambda: r"C:\Program Files\nodejs\npm.cmd")

    program, args = npm_process.npm_run_command("run", "dev")

    assert program == "C:/Windows/System32/cmd.exe"
    assert args == ["/d", "/c", r"C:\Program Files\nodejs\npm.cmd", "run", "dev"]


def test_npm_run_command_uses_direct_npm_on_unix(monkeypatch):
    monkeypatch.setattr(npm_process.os, "name", "posix", raising=False)
    monkeypatch.setattr(npm_process, "npm_command", lambda: "/opt/homebrew/bin/npm")

    program, args = npm_process.npm_run_command("run", "dev")

    assert program == "/opt/homebrew/bin/npm"
    assert args == ["run", "dev"]


def test_main_window_still_reaches_the_shared_npm_entrypoint():
    """main_window 用的是同一个出口（别再手搓第二份 program/args）。"""
    assert main_window._npm_run_command is npm_process.npm_run_command


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
    owner._refresh_open_pages_after_disk_change = (
        lambda: main_window.MainWindow._refresh_open_pages_after_disk_change(owner)
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
    owner._refresh_open_pages_after_disk_change = (
        lambda: main_window.MainWindow._refresh_open_pages_after_disk_change(owner)
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
        # 音频加工台也登记在这张监视表里：它退出时必须重读 audio_config.json，
        # 否则它改好的 src 会被主编辑器下一次 Save All 用内存里的旧值盖掉。
        _resync_audio_config_from_disk=lambda: events.append("audio"),
        # 轨迹工作台同表登记（2026-09-11）：它退出时必须重读 assets/data/trajectories/，
        # 且**排在目录刷新之前**——控件重建要用的就是那份刚换上的只读镜像。
        _resync_trajectories_from_disk=lambda: events.append("traj"),
        # 粒子工作台同理（2026-09-11；09-14 起连布置库一起）：它是 assets/data/vfx/ 与 vfx_placements.json
        # 的唯一写者，退出时不重读，它新建的效果不进 playVfx 下拉、刚挪的区域在场景画布上还是旧的那圈，且不报任何错。
        _resync_vfx_from_disk=lambda: events.append("vfx"),
        # 地形工作台同表登记（2026-09-14）：它退出时场景页的「地形 / 碰撞」块与画布红块要重读盘上的产物，
        # 不重读就是作者刚导出的碰撞在主编辑器里还是旧的那片红。
        _resync_terrain_from_disk=lambda: events.append("terrain"),
    )

    main_window.MainWindow._poll_dialogue_external_processes(owner)
    assert len(owner._dialogue_external_processes) == 1
    assert events == ["traj", "vfx", "terrain", "reload", "audio"]

    owner._dialogue_external_processes[0].running = False
    main_window.MainWindow._poll_dialogue_external_processes(owner)
    assert events == ["traj", "vfx", "terrain", "reload", "audio", "traj", "vfx", "terrain", "reload", "audio", "stop"]


def test_voice_workbench_launches_the_right_module_with_the_project_root(tmp_path):
    """外部工具菜单最典型的坏法是"点了没反应"：模块路径打错、或忘了把工程根传下去。
    前者要等到真去点才发现，后者更阴——工具起来了，但源库/导出目录指向另一个仓库，
    看起来像"素材全没了"。这里从菜单绑的那个方法进，把两件事都钉住。"""
    calls = []
    root = tmp_path / "repo"
    root.mkdir()
    owner = SimpleNamespace(
        _ensure_valid_tool_root=lambda: root,
        _launch_external_tool=lambda module, args, label, root=None: calls.append(
            (module, args, label, root)
        ),
    )

    main_window.MainWindow._launch_voice_workbench_external(owner)

    assert len(calls) == 1
    module, args, label, passed_root = calls[0]
    assert module == "tools.voice_workbench"
    assert args == [str(root.resolve())], "工程根必须传下去，否则工具会用它自己所在的仓库"
    assert label == "配音工作台"
    assert passed_root == root


def test_草木工作台起的是对的模块并带上工程根(tmp_path, monkeypatch):
    """与配音台同一类坏法:模块路径打错(点了没反应)、或 cwd 没指到工程根
    (工具起来了但读的是另一个仓库,看着像"这个场景没烘过")。草木台走 subprocess.Popen 这条,
    所以从 Popen 的入参钉。"""
    seen = {}
    root = tmp_path / "repo"
    root.mkdir()

    class FakeProc:
        pass

    def fake_popen(cmd, **kw):
        seen["cmd"] = cmd
        seen["kw"] = kw
        return FakeProc()

    monkeypatch.setattr(main_window.subprocess, "Popen", fake_popen)
    owner = SimpleNamespace(
        _ensure_valid_tool_root=lambda: root,
        _dialogue_external_processes=[],
        _dialogue_process_watch_timer=SimpleNamespace(start=lambda: None),
        _status=SimpleNamespace(showMessage=lambda *a: None),
    )

    main_window.MainWindow.open_sway_workbench(owner, "跑马梁")

    assert seen["cmd"][1:] == ["-m", "tools.sway_workbench", "--open", "跑马梁"]
    assert seen["kw"]["cwd"] == str(root.resolve()), "工程根必须传下去"
    assert len(owner._dialogue_external_processes) == 1, "外置进程要登记进监视表"


def test_草木工作台没有有效工程根就不起(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(main_window.subprocess, "Popen", lambda *a, **k: calls.append(a))
    owner = SimpleNamespace(_ensure_valid_tool_root=lambda: None)

    main_window.MainWindow.open_sway_workbench(owner)

    assert calls == []


def test_场景页那个按钮把当前场景递给起进程入口():
    """「草木摆动 → 在草木工作台中打开…」只负责把当前场景 id 递给主窗口。

    ⚠ 这个 handler 在钩子缺失时**静默 return**(与粒子那版同一写法):
    主窗口那个方法哪天被改名,按钮就变成点了没反应、零报错。所以这条必须钉着 ——
    三种情形各一断言,尤其是"递过去的确实是当前场景"。
    """
    from tools.editor.editors.scene_editor import ScenePropertyPanel

    got: list[str] = []
    owner = SimpleNamespace(
        _sc_id=SimpleNamespace(text=lambda: "跑马梁"),
        window=lambda: SimpleNamespace(open_sway_workbench=lambda sid: got.append(sid)),
    )
    ScenePropertyPanel._open_sway_workbench(owner)
    assert got == ["跑马梁"]

    got.clear()
    owner._sc_id = SimpleNamespace(text=lambda: "  雾津街头  ")
    ScenePropertyPanel._open_sway_workbench(owner)
    assert got == ["雾津街头"], "两头的空白要去掉,否则工作台按这个名字找不到场景"

    # 主窗口没有那个入口时静默返回,不许炸掉整个场景页
    owner.window = lambda: SimpleNamespace()
    ScenePropertyPanel._open_sway_workbench(owner)


def test_开发启动器认识草木工作台():
    """`tools/dev/launch.py` 的名字表是另一处入口,漏登记 = 命令行起不来(且只报"未知工具")。"""
    from tools.dev import launch

    assert launch.TOOL_MODULES["sway-workbench"][0] == "tools.sway_workbench"


def test_voice_workbench_is_not_launched_without_a_valid_root(tmp_path):
    calls = []
    owner = SimpleNamespace(
        _ensure_valid_tool_root=lambda: None,
        _launch_external_tool=lambda *a, **k: calls.append(a),
    )

    main_window.MainWindow._launch_voice_workbench_external(owner)

    assert calls == []


# ============================================================ 目录刷新的"真变了才重建"闸
def _catalog_owner(tmp_path):
    """够 _resync_dialogue_catalog_if_changed 跑起来的最小 owner。"""
    graphs = tmp_path / "dialogues" / "graphs"
    graphs.mkdir(parents=True)
    (graphs / "a.json").write_text("{}", encoding="utf-8")
    calls: list[str] = []
    owner = SimpleNamespace(
        _model=SimpleNamespace(dialogues_path=tmp_path / "dialogues"),
        _dialogue_catalog_signature=None,
        _reload_all_reference_catalogs=lambda: calls.append("reload"),
    )
    owner._dialogue_graph_catalog_signature = (
        lambda: main_window.MainWindow._dialogue_graph_catalog_signature(owner)
    )
    return owner, calls, graphs


def _resync(owner):
    main_window.MainWindow._resync_dialogue_catalog_if_changed(owner)


def test_主窗回前台_图对话目录没变就不重建(tmp_path):
    """每 alt-tab 一次就全页重建 = 每次回来白冻 0.2~1.1 秒（实测场景页）。

    契约见 mainwindow-editor-hooks 契约 6：自动路径必须"镜像真变了才重建"。
    """
    owner, calls, _graphs = _catalog_owner(tmp_path)

    _resync(owner)                 # 第一次没有基准 → 允许刷一次
    assert calls == ["reload"]

    _resync(owner)
    _resync(owner)
    assert calls == ["reload"], "目录一个字节没动，却又重建了整页"


def test_外置编辑器写了图_下一次回前台必须重建(tmp_path):
    owner, calls, graphs = _catalog_owner(tmp_path)
    _resync(owner)
    calls.clear()

    (graphs / "b.json").write_text("{}", encoding="utf-8")   # 外置编辑器新存了一张图
    _resync(owner)
    assert calls == ["reload"], "目录变了却没重建 —— 下拉里就永远看不见新图"

    _resync(owner)
    assert calls == ["reload"], "变化只该触发一次重建"


def test_取不到目录签名时宁可多刷一次(tmp_path):
    owner, calls, _graphs = _catalog_owner(tmp_path)
    owner._model = SimpleNamespace(dialogues_path=None)
    owner._dialogue_graph_catalog_signature = (
        lambda: main_window.MainWindow._dialogue_graph_catalog_signature(owner)
    )
    _resync(owner)
    _resync(owner)
    assert calls == ["reload", "reload"], "签名取不到时必须 fail-safe 地重建（不许当成没变）"
