"""粒子工作台在另一个进程里存了盘 → 主编辑器怎么看见（与轨迹工作台同一套口子）。

`assets/data/vfx/`（效果资产）与 `assets/data/vfx_placements.json`（布置库）的唯一写者都是粒子工作台；
主编辑器只读两者：`playVfx` 的效果 / 实例候选、场景画布上**只读显示**的发射区域 / 范围区域、
`validate-data` 的结构校验。"编辑器开着、中途在工作台里新建效果 / 改了布置"必须能同步过来，而同步是**两步**：

1. 重读磁盘换掉只读镜像 `ProjectModel.vfx_effects` **与** `ProjectModel.vfx_placements`（一起判、只发一次）；
2. 让已经打开的页把候选**重建**一遍（控件候选是构造期快照，只换模型下拉里什么都不会变）——
   场景页那一拍顺带重画 vfx 块与画布区域。

漏第 2 步的表现最像"没 bug"：状态栏说重读了 N 份，下拉里就是没有刚建的那份。
2026-09-11 接上之前，`reload_vfx_from_disk` 在全仓**零调用者**。2026-09-14 布置从场景 JSON 搬进布置库之后，
重读只管效果 = 工作台里挪完区域，场景画布上永远是旧的那圈。
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

from PySide6.QtCore import Qt  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from tools.editor import main_window  # noqa: E402
from tools.editor.project_model import ProjectModel  # noqa: E402
from tools.editor.shared import vfx_placements  # noqa: E402
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

_AREA = [[10, 10], [200, 10], [200, 150], [10, 150]]


def _lib(**scenes) -> dict:
    lib = vfx_placements.empty_library()
    lib["scenes"].update(scenes)
    return lib


def _write_lib(root: Path, lib: dict) -> None:
    vfx_placements.library_path(root).write_bytes(vfx_placements.dumps(lib))


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

    def test_reload_covers_the_placement_library_and_emits_once(self) -> None:
        """布置库同一条重读：只改布置也算变；效果与布置一起变只发**一次** data_changed。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            self.assertEqual(model.vfx_placements, vfx_placements.empty_library(), "没有布置库 = 空库")
            self.assertEqual(model.vfx_placements_error, "")
            emitted: list[tuple[str, str]] = []
            model.data_changed.connect(lambda a, b: emitted.append((a, b)))

            row = {"id": "纸钱", "effect": "zz_probe", "anchor": {"x": 50, "y": 60}, "area": _AREA}
            _write_lib(root, _lib(sc_a={"base": [row]}))
            self.assertTrue(model.reload_vfx_from_disk(), "工作台只改了布置 → 必须报变了")
            self.assertEqual(vfx_placements.rows_for(model.vfx_placements, "sc_a", ""), [row])
            self.assertEqual(emitted, [("vfx", "")])
            self.assertFalse(model.reload_vfx_from_disk(), "盘没动 → 不能再报变")
            self.assertEqual(emitted, [("vfx", "")], "没变也发了信号")

            emitted.clear()
            vdir = Path(model.paths.vfx_dir)
            vdir.mkdir(parents=True, exist_ok=True)
            (vdir / "zz_probe.json").write_text(json.dumps(_EFFECT, ensure_ascii=False), encoding="utf-8")
            _write_lib(root, _lib(sc_a={"base": [row], "variants": {"夜": [row]}}))
            self.assertTrue(model.reload_vfx_from_disk())
            self.assertEqual(emitted, [("vfx", "")], "效果与布置一起变只许发一次")

            emitted.clear()
            vfx_placements.library_path(root).write_bytes(b"[1, 2")
            self.assertTrue(model.reload_vfx_from_disk(), "布置库坏掉也是变了（画布要清空、红字要报）")
            self.assertIn("读不懂", model.vfx_placements_error)
            self.assertEqual(model.vfx_placements, vfx_placements.empty_library(), "读不懂退成空库，不留旧的骗人")
            self.assertEqual(emitted, [("vfx", "")])

    def test_placement_library_stays_out_of_dirty_and_save(self) -> None:
        """唯一写者是工作台：主编辑器不许有脏桶、不许在 save_all / 外部改动基线里碰它。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            _write_lib(root, _lib(sc_a={"base": [{"id": "v", "effect": "e", "anchor": {"x": 1, "y": 2}}]}))
            model = ProjectModel()
            model.load_project(root)
            self.assertTrue(vfx_placements.rows_for(model.vfx_placements, "sc_a", ""))
            self.assertNotIn("vfx_placements", ProjectModel.KNOWN_DIRTY_BUCKETS)
            baseline_keys = " ".join(str(k) for k in model._file_baselines)
            self.assertNotIn("vfx_placements", baseline_keys, "布置库进了外部改动基线")
            src = Path(sys.modules[ProjectModel.__module__].__file__).read_text(encoding="utf-8")
            for fn_name in ("def save_all", "def _planned_write_paths"):
                start = src.index(fn_name)
                end = src.find("\n    def ", start + 1)
                self.assertNotIn("vfx_placements", src[start:end], f"{fn_name} 碰了布置库")

    def test_instance_candidates_come_from_the_library_union(self) -> None:
        """playVfx / 条件叶的 instanceId 候选 = 本场景各时段外观 id 的并集，label 写上效果与出现在哪几份。"""
        model = ProjectModel()
        model.vfx_placements = _lib(崖=({
            "base": [{"id": "bats", "effect": "bat_cliff", "anchor": {"x": 1, "y": 1}}],
            "variants": {"夜": [
                {"id": "bats", "effect": "bat_cliff", "anchor": {"x": 1, "y": 1}},
                {"id": "萤火", "effect": "fireflies", "anchor": {"x": 2, "y": 2}},
            ]},
        }))
        model.scenes = {"崖": {"id": "崖", "vfx": [{"id": "旧的", "effect": "x"}]}}
        self.assertEqual(model.vfx_instance_ids_for_scene("崖"), [
            ("bats", "bats（bat_cliff · 基底/夜）"),
            ("萤火", "萤火（fireflies · 夜）"),
        ], "候选没读布置库（或者还在读场景 JSON 里残留的 vfx）")
        self.assertEqual(model.vfx_instance_ids_for_scene(None), [])
        self.assertEqual(model.vfx_instance_ids_for_scene("没有的"), [])

    # ----- 入口：菜单 / 自动 / 场景页按钮 -------------------------------------

    def test_menu_entry_does_both_steps(self) -> None:
        """「工具 → 刷新粒子数据」必须重读磁盘**并**刷新当前页；只做一步就是"点了没反应"。"""
        calls: list[str] = []
        msgs: list[str] = []
        owner = SimpleNamespace(
            _model=SimpleNamespace(
                project_path=Path("."),
                vfx_effects={"a": {}},
                vfx_placements=_lib(s={"base": [{"id": "x"}, {"id": "y"}], "variants": {"夜": [{"id": "x"}]}}),
                vfx_placements_error="",
                reload_vfx_from_disk=lambda: (calls.append("model"), True)[1],
            ),
            _status=SimpleNamespace(showMessage=lambda m, *_a: (calls.append("status"), msgs.append(m))),
            _refresh_open_pages_after_disk_change=lambda: calls.append("pages"),
        )
        main_window.MainWindow._reload_vfx_from_disk(owner)
        self.assertEqual(calls, ["model", "pages", "status"])
        self.assertIn("1 份效果、3 条布置", msgs[0], "状态栏要带上布置条数")

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
                self.assertIn("刷新粒子数据", texts, "没有手动刷新入口")
                self.assertNotIn("重读粒子资产", texts, "旧名字的菜单项还在")
            finally:
                window.deleteLater()
                QApplication.processEvents()
                destroy_leftover_qt_widgets()

    def test_menu_action_and_scene_page_button_reload_disk(self) -> None:
        """真主窗：菜单项与场景页 vfx 块里的按钮都落到同一条重读，效果与布置一起进镜像、画布区域跟着画。"""
        from PySide6.QtTest import QTest

        from tools.editor.editors.scene_editor import SceneEditor
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
                _write_lib(root, _lib(sc_a={"base": [
                    {"id": "探针", "effect": "zz_probe", "anchor": {"x": 50, "y": 60}, "area": _AREA}]}))

                action = None
                for act in window.findChildren(type(window.menuBar().actions()[0])):
                    if act.text() == "刷新粒子数据":
                        action = act
                        break
                self.assertIsNotNone(action, "「工具 → 刷新粒子数据」菜单项不见了")
                action.trigger()
                self.assertIn("zz_probe", window._model.vfx_effects)
                self.assertEqual(vfx_placements.rows_for(window._model.vfx_placements, "sc_a", "")[0]["id"], "探针")

                # 场景页那个按钮：盘上再改一次 → 点按钮 → 画布上是新的那圈
                scene_ed = next(e for e in window._editor_instances if isinstance(e, SceneEditor))
                scene_ed._refresh_scene_list()
                scene_ed._load_scene("sc_a")
                QApplication.processEvents()
                self.assertIsNotNone(scene_ed._canvas.vfx_area_item("探针", "emit"))
                moved = [[20, 20], [300, 20], [300, 200], [20, 200]]
                _write_lib(root, _lib(sc_a={"base": [
                    {"id": "探针", "effect": "zz_probe", "anchor": {"x": 50, "y": 60}, "area": moved}]}))
                QTest.mouseClick(scene_ed._props._sc_vfx_refresh, Qt.MouseButton.LeftButton)
                for _ in range(4):
                    QApplication.processEvents()
                self.assertEqual(scene_ed._canvas.vfx_area_item("探针", "emit").area_points(),
                                 [[float(x), float(y)] for x, y in moved], "场景页按钮点了，画布上还是旧的那圈")
                self.assertIn("条布置", window._status.currentMessage(), "场景页按钮没走主窗那条重读")
            finally:
                window.deleteLater()
                QApplication.processEvents()
                destroy_leftover_qt_widgets()

    def test_scene_page_has_no_workbench_opener_anymore(self) -> None:
        """场景页不再从 vfx 块起工作台（入口只剩「工具 → 粒子工作台…」），也不再调 open_vfx_workbench。"""
        src = (Path(main_window.__file__).parent / "editors" / "scene_editor.py").read_text(encoding="utf-8")
        self.assertNotIn("open_vfx_workbench", src)
        self.assertNotIn("在粒子工作台中打开", src)


if __name__ == "__main__":
    unittest.main()
