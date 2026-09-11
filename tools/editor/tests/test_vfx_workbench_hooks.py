"""粒子工作台在另一个进程里存了盘 → 主编辑器怎么看见（与轨迹工作台同一套口子）。

`assets/data/vfx/` 的唯一写者是粒子工作台；主编辑器只读它，用来喂场景页 vfx 实例的
`effect` 候选、`playVfx` 的效果选择器和 `validate-data` 的结构校验。
"编辑器开着、中途在工作台里新建/改了效果"必须能同步过来，而同步是**两步**：

1. 重读磁盘换掉只读镜像 `ProjectModel.vfx_effects`；
2. 让已经打开的页把候选**重建**一遍（控件候选是构造期快照，只换模型下拉里什么都不会变）。

漏第 2 步的表现最像"没 bug"：状态栏说重读了 N 份，下拉里就是没有刚建的那份。
2026-09-11 接上之前，`reload_vfx_from_disk` 在全仓**零调用者**——菜单、按钮、自动重读三处
都不存在，等于工作台和编辑器完全没连上。
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

from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor import main_window  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.tests.qt_teardown import destroy_leftover_qt_widgets  # noqa: E402
from tools.editor.tests.save_test_utils import write_minimal_loadable_project  # noqa: E402

_EFFECT = {
    "id": "zz_probe",
    "label": "探针效果",
    "emitters": [{
        "id": "e",
        "appearance": {"image": "/resources/runtime/images/vfx/dust.png", "sizeWu": 3},
        "spawn": {"max": 5, "rate": 1},
    }],
}


class VfxDiskSyncTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    # ----- 模型侧：重读返回"真的变了吗" ------------------------------------

    def test_reload_reports_whether_disk_actually_differs(self) -> None:
        """自动路径每次激活窗口都会调它；内容没变必须返回 False，否则等于每次都重建全页。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            vdir = Path(model.paths.vfx_dir)
            vdir.mkdir(parents=True, exist_ok=True)

            self.assertFalse(model.reload_vfx_from_disk(), "盘上没东西、内存也没有 → 没变")

            (vdir / "zz_probe.json").write_text(
                json.dumps(_EFFECT, ensure_ascii=False), encoding="utf-8")
            self.assertTrue(model.reload_vfx_from_disk(), "工作台新建了一份 → 必须报变了")
            self.assertIn("zz_probe", model.vfx_effects)
            self.assertFalse(model.reload_vfx_from_disk(), "再读一次、盘没动 → 不能再报变")

            doc = dict(_EFFECT, label="改过的名字")
            (vdir / "zz_probe.json").write_text(
                json.dumps(doc, ensure_ascii=False), encoding="utf-8")
            self.assertTrue(model.reload_vfx_from_disk(), "改了内容也算变")
            self.assertEqual(model.vfx_effects["zz_probe"]["label"], "改过的名字")

    # ----- 入口：菜单 / 自动 -------------------------------------------------

    def test_menu_entry_does_both_steps(self) -> None:
        """「工具 → 重读粒子资产」必须重读磁盘**并**刷新当前页；只做一步就是"点了没反应"。"""
        calls: list[str] = []
        owner = SimpleNamespace(
            _model=SimpleNamespace(
                project_path=Path("."),
                vfx_effects={"a": {}},
                reload_vfx_from_disk=lambda: (calls.append("model"), True)[1],
            ),
            _status=SimpleNamespace(showMessage=lambda *_a: calls.append("status")),
            _refresh_open_pages_after_disk_change=lambda: calls.append("pages"),
        )
        main_window.MainWindow._reload_vfx_from_disk(owner)
        self.assertEqual(calls, ["model", "pages", "status"])

    def test_auto_resync_skips_the_rebuild_when_disk_is_unchanged(self) -> None:
        calls: list[str] = []
        owner = SimpleNamespace(
            _model=SimpleNamespace(
                project_path=Path("."),
                reload_vfx_from_disk=lambda: (calls.append("model"), False)[1],
            ),
            _refresh_open_pages_after_disk_change=lambda: calls.append("pages"),
        )
        main_window.MainWindow._resync_vfx_from_disk(owner)
        self.assertEqual(calls, ["model"])

        calls.clear()
        owner._model.reload_vfx_from_disk = lambda: (calls.append("model"), True)[1]
        main_window.MainWindow._resync_vfx_from_disk(owner)
        self.assertEqual(calls, ["model", "pages"])

    def test_auto_paths_actually_call_the_vfx_resync(self) -> None:
        """工作台退出、主窗回到前台这两条自动路径里必须真有这一行——漏了就只剩手动菜单。

        用源码断言：这两处一个是 QTimer.singleShot（不好在离屏里驱动），一个要真子进程。
        """
        src = Path(main_window.__file__).read_text(encoding="utf-8")
        self.assertIn("self._resync_vfx_from_disk()", src, "工作台退出后没有自动重读")
        self.assertIn("QTimer.singleShot(0, self, self._resync_vfx_from_disk)", src,
                      "主窗回到前台时没有自动重读")

    def test_menu_actions_exist(self) -> None:
        from tools.editor.main_window import MainWindow

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            window = MainWindow()
            try:
                window._model.load_project(root)
                window._populate_tabs()
                texts = {a.text() for a in window.findChildren(
                    type(window.menuBar().actions()[0]))}
                self.assertIn("粒子工作台…", texts, "外部工具菜单里没有粒子工作台入口")
                self.assertIn("重读粒子资产", texts, "没有手动重读入口")
            finally:
                window.deleteLater()
                QApplication.processEvents()
                destroy_leftover_qt_widgets()

    def test_menu_action_reloads_disk(self) -> None:
        from tools.editor.main_window import MainWindow

        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            window = MainWindow()
            try:
                window._model.load_project(root)
                window._populate_tabs()
                vdir = Path(window._model.paths.vfx_dir)
                vdir.mkdir(parents=True, exist_ok=True)
                (vdir / "zz_probe.json").write_text(
                    json.dumps(_EFFECT, ensure_ascii=False), encoding="utf-8")

                action = None
                for act in window.findChildren(type(window.menuBar().actions()[0])):
                    if act.text() == "重读粒子资产":
                        action = act
                        break
                self.assertIsNotNone(action, "「工具 → 重读粒子资产」菜单项不见了")
                action.trigger()
                self.assertIn("zz_probe", window._model.vfx_effects)
            finally:
                window.deleteLater()
                QApplication.processEvents()
                destroy_leftover_qt_widgets()

    # ----- 场景页那个按钮 ----------------------------------------------------

    def test_scene_page_button_hands_the_current_effect_id_to_the_window(self) -> None:
        """「在粒子工作台中打开…」只负责把当前选中的 effect 递给主窗口的起进程入口。"""
        from tools.editor.editors.scene_editor import ScenePropertyPanel

        got: list[str] = []
        owner = SimpleNamespace(
            _sc_vfx_effect=SimpleNamespace(current_id=lambda: "bat_cliff"),
            window=lambda: SimpleNamespace(open_vfx_workbench=lambda eid: got.append(eid)),
        )
        ScenePropertyPanel._open_vfx_workbench(owner)
        self.assertEqual(got, ["bat_cliff"])

        got.clear()
        owner._sc_vfx_effect = SimpleNamespace(current_id=lambda: "")
        ScenePropertyPanel._open_vfx_workbench(owner)
        self.assertEqual(got, [""], "没选效果也要能开（工作台里新建）")

        # 主窗口没有那个入口时静默返回，不许炸掉场景页
        owner.window = lambda: SimpleNamespace()
        ScenePropertyPanel._open_vfx_workbench(owner)


    def test_vfx_section_opens_itself_when_the_scene_has_instances(self) -> None:
        """场景里配了粒子，属性页那一栏必须**自己展开**、标题带条数。

        2026-09-11 制作人报的就是这条：`start_open=False` 且标题不带条数，于是场景里明明摆了
        两个实例，属性页上看过去只有一行折起来的标题，看起来像"这编辑器根本没有粒子配置"。
        本页灯光 / on_enter 早就是 `set_expanded(bool(有数据))`，vfx 漏了。
        """
        from tools.editor.editors.scene_editor import ScenePropertyPanel

        class _Fold:
            def __init__(self) -> None:
                self.title = ""
                self.expanded = False

            def set_title(self, t: str) -> None:
                self.title = t

            def set_expanded(self, on: bool) -> None:
                self.expanded = on

        for n, want_open in ((0, False), (1, True), (2, True)):
            fold = _Fold()
            owner = SimpleNamespace(
                _sc_vfx_fold=fold,
                _sc_vfx_list=SimpleNamespace(count=lambda n=n: n),
            )
            ScenePropertyPanel._sync_vfx_fold(owner)
            self.assertEqual(fold.expanded, want_open, f"{n} 个实例时展开态不对")
            if n:
                self.assertIn(f"{n} 个实例", fold.title, fold.title)
            else:
                self.assertNotIn("实例", fold.title, "空场景的标题不该报条数")

        # 面板还没建好（懒建）时不许炸
        ScenePropertyPanel._sync_vfx_fold(SimpleNamespace())


if __name__ == "__main__":
    unittest.main()
