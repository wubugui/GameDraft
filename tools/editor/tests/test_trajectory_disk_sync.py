"""轨迹工作台在另一个进程里存了盘 → 主编辑器怎么看见（2026-09-11 制作人点名的同步口）。

`assets/data/trajectories/` 的唯一写者是轨迹工作台；主编辑器只读它，用来喂
playTrajectory 的候选、位置引用的**命名插槽**下拉、曲线类型说明与校验器。
"编辑器开着、中途在工作台里改了轨迹"必须能同步过来，而同步是**两步**：

1. 重读磁盘换掉只读镜像 `ProjectModel.trajectories`；
2. 让已经打开的页把候选**重建**一遍——`ActionRow` 的候选是 `_rebuild_params()` 那一刻的
   静态快照，`set_project_context` 在 model/scene 未变时短路，只做第 1 步下拉里什么都不会变。

漏第 2 步的表现最像"没 bug"：菜单点了、状态栏说重读了 N 条，下拉里就是没有刚加的插槽。
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication, QWidget  # noqa: E402

from tools.editor import main_window  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared.action_editor import ActionEditor  # noqa: E402
from tools.editor.shared.position_ref_field import PositionRefField  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402


def _asset(scene_id: str, slots: list[dict] | None = None, binding: str = "scene") -> dict:
    doc: dict = {
        "id": "t1",
        "label": "测试曲线",
        "space": "screen",
        "binding": binding,
        "keyframes": [{"atMs": 0, "x": 0, "y": 0}, {"atMs": 500, "x": 10, "y": 10}],
        "authoring": {"sceneId": scene_id, "origin": {"x": 100, "y": 200}},
    }
    if binding == "free":
        doc["authoring"] = {}
    if slots is not None:
        doc["slots"] = slots
    return doc


class TrajectoryDiskSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def _project(self, root: Path) -> tuple[ProjectModel, Path, str]:
        write_minimal_loadable_project(root)
        model = ProjectModel()
        model.load_project(root)
        tdir = model.paths.trajectories_dir
        tdir.mkdir(parents=True, exist_ok=True)
        return model, tdir, next(iter(model.scenes.keys()))

    @staticmethod
    def _write(tdir: Path, doc: dict) -> None:
        (tdir / f"{doc['id']}.json").write_text(
            json.dumps(doc, ensure_ascii=False), encoding="utf-8")

    # ----- 第 1 步：只读镜像 ------------------------------------------------

    def test_reload_picks_up_new_slots_and_reports_change(self) -> None:
        with TemporaryDirectory() as td:
            model, tdir, sid = self._project(Path(td) / "p")
            self._write(tdir, _asset(sid, slots=[]))
            self.assertTrue(model.reload_trajectories_from_disk())
            self.assertEqual(model.trajectory_slots("t1"), [])

            # 工作台在另一个进程里加了个命名插槽
            self._write(tdir, _asset(sid, slots=[{"id": "落点", "x": 12, "y": 34, "label": "铜钱落点"}]))
            emitted: list[tuple[str, str]] = []
            model.data_changed.connect(lambda a, b: emitted.append((a, b)))
            self.assertTrue(model.reload_trajectories_from_disk(), "盘上变了必须报 True")
            self.assertEqual(emitted, [("trajectory", "")])
            self.assertEqual([s["id"] for s in model.trajectory_slots("t1")], ["落点"])
            self.assertEqual(model.trajectory_scene_id("t1"), sid)

    def test_reload_is_quiet_when_nothing_changed(self) -> None:
        """每次窗口回到前台都会调它：没变就不能发信号（否则白重建一遍全页动作行）。"""
        with TemporaryDirectory() as td:
            model, tdir, sid = self._project(Path(td) / "p")
            self._write(tdir, _asset(sid, slots=[{"id": "a", "x": 1, "y": 2}]))
            model.reload_trajectories_from_disk()
            emitted: list[tuple[str, str]] = []
            model.data_changed.connect(lambda a, b: emitted.append((a, b)))
            self.assertFalse(model.reload_trajectories_from_disk())
            self.assertEqual(emitted, [])

    def test_repeated_scans_do_not_pile_up_anomalies(self) -> None:
        """坏文件的告警不能每重扫一次记一条——自动路径一天能扫几十次。"""
        with TemporaryDirectory() as td:
            model, tdir, _sid = self._project(Path(td) / "p")
            (tdir / "bad.json").write_text("{not json", encoding="utf-8")
            for _ in range(3):
                model.reload_trajectories_from_disk()
            hits = [a for a in model.load_anomalies if "trajectories/bad.json" in a]
            self.assertEqual(len(hits), 1, model.load_anomalies)

    # ----- 第 2 步：已经打开的页 --------------------------------------------

    def test_open_action_row_sees_new_slot_after_reload_refs(self) -> None:
        """主窗刷新走的就是 ActionEditor.reload_refs_from_model：插槽下拉必须换上新的。"""
        with TemporaryDirectory() as td:
            model, tdir, sid = self._project(Path(td) / "p")
            self._write(tdir, _asset(sid, slots=[]))
            model.reload_trajectories_from_disk()

            editor = ActionEditor("Actions")
            try:
                editor.set_project_context(model, sid)
                editor.set_data([{"type": "playTrajectory", "params": {
                    "trajectoryId": "t1", "target": "player",
                    "at": {"kind": "slot", "trajectoryId": "t1", "slotId": "落点"}}}])
                field = editor._rows[0]._param_widgets.get("at")
                self.assertIsInstance(field, PositionRefField)
                self.assertIsNotNone(
                    field.slot_sel._orphan_row,
                    "前提：此刻资产里还没有这个插槽，下拉里它只能是「缺失」孤儿项（保值撑着）")

                # 工作台加了插槽 → 重读 + 重建
                self._write(tdir, _asset(sid, slots=[{"id": "落点", "x": 12, "y": 34, "label": "铜钱落点"}]))
                model.reload_trajectories_from_disk()
                editor.reload_refs_from_model()

                field2 = editor._rows[0]._param_widgets.get("at")
                self.assertIsInstance(field2, PositionRefField)
                self.assertIsNone(field2.slot_sel._orphan_row, "现在它是真候选，不该再是孤儿项")
                self.assertIn("铜钱落点", field2.slot_sel.currentText())
                self.assertIn("t1", list(getattr(field2.traj_sel, "_ids", [])))
                # 重建不许动数据
                self.assertEqual(editor.to_list()[0]["params"]["at"],
                                 {"kind": "slot", "trajectoryId": "t1", "slotId": "落点"})
            finally:
                editor.deleteLater()
                self._qt_app.processEvents()

    def test_position_action_slot_sources_follow_the_disk(self) -> None:
        """位置动作（这里 teleportEntityTo）的插槽来源 = 有插槽的场景曲线，随盘上变化。"""
        with TemporaryDirectory() as td:
            model, tdir, sid = self._project(Path(td) / "p")
            self._write(tdir, _asset(sid, binding="free", slots=[{"id": "x", "x": 1, "y": 2}]))
            model.reload_trajectories_from_disk()

            editor = ActionEditor("Actions")
            try:
                editor.set_project_context(model, sid)
                editor.set_data([{"type": "teleportEntityTo", "params": {
                    "target": "player", "x": 1, "y": 2}}])
                field = editor._rows[0]._param_widgets.get("at")
                self.assertNotIn("t1", list(getattr(field.traj_sel, "_ids", [])),
                                 "相对曲线的插槽没有场景位置，不该出现在来源里")

                self._write(tdir, _asset(sid, binding="scene", slots=[{"id": "x", "x": 1, "y": 2}]))
                model.reload_trajectories_from_disk()
                editor.reload_refs_from_model()
                field2 = editor._rows[0]._param_widgets.get("at")
                self.assertIn("t1", list(getattr(field2.traj_sel, "_ids", [])))
            finally:
                editor.deleteLater()
                self._qt_app.processEvents()

    # ----- 入口：菜单 / 自动 -------------------------------------------------

    def test_menu_entry_does_both_steps(self) -> None:
        """「工具 → 重读轨迹资产」必须重读磁盘**并**刷新当前页；只做一步就是"点了没反应"。"""
        calls: list[str] = []
        owner = SimpleNamespace(
            _model=SimpleNamespace(
                project_path=Path("."),
                trajectories={"a": {}},
                reload_trajectories_from_disk=lambda: (calls.append("model"), True)[1],
            ),
            _status=SimpleNamespace(showMessage=lambda *_a: calls.append("status")),
            _refresh_open_pages_after_disk_change=lambda: calls.append("pages"),
        )
        main_window.MainWindow._reload_trajectories_from_disk(owner)
        self.assertEqual(calls, ["model", "pages", "status"])

    def test_auto_resync_skips_the_rebuild_when_disk_is_unchanged(self) -> None:
        """自动路径（主窗回到前台 / 工作台退出）：没变就不重建，变了才重建。"""
        calls: list[str] = []
        owner = SimpleNamespace(
            _model=SimpleNamespace(
                project_path=Path("."),
                reload_trajectories_from_disk=lambda: (calls.append("model"), False)[1],
            ),
            _refresh_open_pages_after_disk_change=lambda: calls.append("pages"),
        )
        main_window.MainWindow._resync_trajectories_from_disk(owner)
        self.assertEqual(calls, ["model"])

        calls.clear()
        owner._model.reload_trajectories_from_disk = lambda: (calls.append("model"), True)[1]
        main_window.MainWindow._resync_trajectories_from_disk(owner)
        self.assertEqual(calls, ["model", "pages"])

    def test_workbench_launch_registers_for_auto_resync(self) -> None:
        """起工作台必须登记进外置进程监视表 + 开轮询，否则自动同步那条路根本不会跑。"""
        started: list[str] = []
        procs: list[object] = []
        fake_proc = object()
        owner = SimpleNamespace(
            _ensure_valid_tool_root=lambda: Path("."),
            _dialogue_external_processes=procs,
            _dialogue_process_watch_timer=SimpleNamespace(start=lambda: started.append("start")),
            _status=SimpleNamespace(showMessage=lambda *_a: None),
        )
        real_popen = main_window.subprocess.Popen
        main_window.subprocess.Popen = lambda *_a, **_k: fake_proc
        try:
            main_window.MainWindow.open_trajectory_workbench(owner, "t1")
        finally:
            main_window.subprocess.Popen = real_popen
        self.assertEqual(procs, [fake_proc])
        self.assertEqual(started, ["start"])


class _Page(QWidget):
    def __init__(self) -> None:
        super().__init__()
        self.calls = 0

    def reload_refs_from_model(self) -> None:
        self.calls += 1


class TrajectoryPageRefreshTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_only_the_visible_page_is_rebuilt_now(self) -> None:
        """与目录刷新同一条路：当前页立刻重建，其余页只清水位等切过去——不能一次冻十几页。"""
        visible, hidden = _Page(), _Page()
        owner = SimpleNamespace(
            _editor_instances=[hidden, visible],
            _stack=SimpleNamespace(currentIndex=lambda: 1),
            _page_refresh_revisions={id(hidden): 3, id(visible): 3},
            _model_revision=3,
            _status=SimpleNamespace(showMessage=lambda *_a: None),
        )
        owner._refresh_page_reference_candidates = (
            lambda inst, **kw: main_window.MainWindow._refresh_page_reference_candidates(
                owner, inst, **kw)
        )
        main_window.MainWindow._refresh_open_pages_after_disk_change(owner)
        self.assertEqual(visible.calls, 1)
        self.assertEqual(hidden.calls, 0)
        self.assertIsNone(owner._page_refresh_revisions.get(id(hidden)))


if __name__ == "__main__":
    unittest.main()


class TrajectoryMenuLiveTests(unittest.TestCase):
    """真开一个主窗口，从菜单项那一下进——菜单绑错方法 / 忘了刷页，只有这条能抓。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_menu_action_reloads_disk_and_starts_a_refresh_round(self) -> None:
        from tools.editor.main_window import MainWindow
        from tools.editor.shared.action_editor import _reference_refresh_epoch
        from tools.editor.tests.qt_teardown import destroy_leftover_qt_widgets

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            window = MainWindow()
            try:
                window._model.load_project(root)
                window._populate_tabs()
                sid = next(iter(window._model.scenes.keys()))
                tdir = window._model.paths.trajectories_dir
                tdir.mkdir(parents=True, exist_ok=True)
                (tdir / "t1.json").write_text(
                    json.dumps(_asset(sid, slots=[]), ensure_ascii=False), encoding="utf-8")

                action = None
                for act in window.findChildren(type(window.menuBar().actions()[0])):
                    if act.text() == "重读轨迹资产":
                        action = act
                        break
                self.assertIsNotNone(action, "「工具 → 重读轨迹资产」菜单项不见了")

                action.trigger()
                self.assertEqual(list(window._model.trajectories), ["t1"])

                # 工作台加了插槽 → 再点一次菜单：镜像跟上，且真的开了一轮候选重建
                (tdir / "t1.json").write_text(
                    json.dumps(_asset(sid, slots=[{"id": "落点", "x": 1, "y": 2}]),
                               ensure_ascii=False), encoding="utf-8")
                epoch = _reference_refresh_epoch()
                action.trigger()
                self.assertEqual(
                    [s["id"] for s in window._model.trajectory_slots("t1")], ["落点"])
                self.assertGreater(
                    _reference_refresh_epoch(), epoch,
                    "只换了模型没重建控件 = 下拉里永远看不见新插槽")
            finally:
                window.deleteLater()
                QApplication.processEvents()
                destroy_leftover_qt_widgets()
