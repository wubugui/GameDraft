"""挂点面板的流程探针（从最外层入口走，不测单个 commit 函数）。

钉死：
- 标一个点 → 面板置脏 → 保存 → sockets.json 落盘且形状与运行时契约一致；
- 清空全部挂点 → 保存 → 文件被删（不留空壳）；
- Discard → UI 回滚到磁盘值（否则关闭路径的统一 flush 会把已放弃的编辑写回）；
- 指纹对不上 → 面板亮失效横幅（游戏侧会整份忽略，这里必须让人看见）；
- 挂点面板的脏态并进 AnimEditor 的 confirm_close 门（两者都直写盘，不进 ProjectModel dirty）。
"""
from __future__ import annotations

import json
import shutil
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.editors.anim_editor import AnimEditor
from tools.editor.project_model import ProjectModel
from tools.editor.shared.animation_sockets import sockets_path_for_bundle
from tools.editor.tests.save_test_utils import repo_root_from_tests


def _mismatched_atlas_fingerprint(model: ProjectModel, key: str) -> dict[str, int]:
    """造一份**保证与该包对不上**的图集指纹。

    ⚠ 别再写死 ``{"cols":1,"rows":1,"slotCount":1}``：单帧静态动画包（占位包）本身就是
    1×1×1，硬编码那组值撞上它时「指纹对不上」这个前提自己失效，测试会莫名其妙地红。
    指纹必须从当前包算出来再故意错开。
    """
    anim = model.animations[key]
    return {
        "cols": int(anim.get("cols") or 1) + 7,
        "rows": int(anim.get("rows") or 1) + 7,
        "slotCount": len(anim.get("atlasFrames") or []) + 7,
    }


def _first_bundle_with_atlas(model: ProjectModel) -> str:
    for key, anim in sorted(model.animations.items()):
        if isinstance(anim, dict) and anim.get("states") and anim.get("atlasFrames"):
            return key
    raise AssertionError("工程里没有可用的动画包")


class SocketPanelFlowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)
        cls._repo = repo_root_from_tests()

    def setUp(self) -> None:
        self._td = TemporaryDirectory()
        root = Path(self._td.name) / "p"
        # 只拷数据面：动画包 JSON 与目录结构（图集 PNG 不必，画布无图也能标）
        (root / "public/resources/runtime/animation").mkdir(parents=True)
        src = self._repo / "public/resources/runtime/animation"
        for d in sorted(src.iterdir())[:3]:
            aj = d / "anim.json"
            if aj.is_file():
                dst = root / "public/resources/runtime/animation" / d.name
                dst.mkdir(parents=True, exist_ok=True)
                shutil.copy2(aj, dst / "anim.json")
        for sub in ("public/assets/data", "public/assets/scenes", "public/assets/dialogues/graphs"):
            (root / sub).mkdir(parents=True, exist_ok=True)
        self._root = root
        self._model = ProjectModel()
        self._model.project_path = root
        self._model.reload_animations_from_disk()

    def tearDown(self) -> None:
        self._td.cleanup()

    def _panel(self) -> tuple[AnimEditor, str]:
        ed = AnimEditor(self._model)
        key = _first_bundle_with_atlas(self._model)
        ed._on_select(key)
        return ed, key

    def test_mark_then_save_writes_sidecar(self) -> None:
        ed, key = self._panel()
        panel = ed._socket_panel
        panel._sockets()["right_hand"] = {"poses": {}}
        panel._rebuild_sockets()
        panel._socket_list.setCurrentRow(0)
        panel._on_pos_moved(0.62, 0.55)
        panel._on_angle_moved(-12.0)
        self.assertTrue(panel.is_dirty(), "标了点就该置脏")
        self.assertTrue(ed._dirty, "挂点脏态必须并进 AnimEditor（走同一条保存/关闭门）")

        self.assertIsNone(panel.save())
        path = sockets_path_for_bundle(self._model.animation_bundles_path, key)
        self.assertTrue(path.is_file())
        data = json.loads(path.read_text(encoding="utf-8"))
        pose = data["sockets"]["right_hand"]["poses"]
        slot = next(iter(pose))
        self.assertAlmostEqual(pose[slot]["x"], 0.62)
        self.assertAlmostEqual(pose[slot]["angle"], -12.0)
        # 指纹随图集写入，运行时据此判失效
        self.assertEqual(data["atlas"]["slotCount"], len(self._model.animations[key]["atlasFrames"]))
        self.assertFalse(panel.is_dirty(), "保存后不该还是脏的")

    def test_clearing_all_sockets_deletes_file(self) -> None:
        ed, key = self._panel()
        panel = ed._socket_panel
        panel._sockets()["h"] = {"poses": {}}
        panel._rebuild_sockets()
        panel._socket_list.setCurrentRow(0)
        panel._on_pos_moved(0.5, 0.9)
        panel.save()
        path = sockets_path_for_bundle(self._model.animation_bundles_path, key)
        self.assertTrue(path.is_file())

        panel._sockets().clear()
        panel.save()
        self.assertFalse(path.is_file(), "没有任何挂点时不该留一个空壳文件")

    def test_discard_rolls_back_to_disk(self) -> None:
        ed, _key = self._panel()
        panel = ed._socket_panel
        panel._sockets()["h"] = {"poses": {}}
        panel._rebuild_sockets()
        panel._socket_list.setCurrentRow(0)
        panel._on_pos_moved(0.3, 0.3)
        panel.save()

        panel._on_pos_moved(0.9, 0.9)
        self.assertTrue(panel.is_dirty())
        panel.discard()
        self.assertFalse(panel.is_dirty(), "Discard 后必须与磁盘一致，否则统一 flush 会把放弃的编辑写回")
        slot = next(iter(panel._poses("h")))
        self.assertAlmostEqual(panel._poses("h")[slot]["x"], 0.3)

    def test_atlas_refresh_keeps_unsaved_marks(self) -> None:
        """图集重载只换像素，不许把没保存的标注冲掉（审查 #3：静默数据丢失）。"""
        ed, _key = self._panel()
        panel = ed._socket_panel
        panel._sockets()["h"] = {"poses": {}}
        panel._rebuild_sockets()
        panel._socket_list.setCurrentRow(0)
        panel._on_pos_moved(0.42, 0.42)
        self.assertTrue(panel.is_dirty())

        panel.set_atlas(None)   # 图集解码完成后走的就是这条
        self.assertTrue(panel.is_dirty(), "刷新图集不该把未保存标注丢掉")
        slot = next(iter(panel._poses("h")))
        self.assertAlmostEqual(panel._poses("h")[slot]["x"], 0.42)

    def test_unrelated_save_does_not_bless_stale_sockets(self) -> None:
        """挂点没改时保存 anim.json，不许顺手刷新指纹（审查 #4：stale 保证被一键抹掉）。"""
        ed, key = self._panel()
        path = sockets_path_for_bundle(self._model.animation_bundles_path, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        stale = {
            "schemaVersion": 1,
            "atlas": _mismatched_atlas_fingerprint(self._model, key),
            "sockets": {"h": {"poses": {"0": {"x": 0.5, "y": 0.5}}}},
        }
        path.write_text(json.dumps(stale, ensure_ascii=False), encoding="utf-8")
        ed._on_select(key)
        self.assertTrue(ed._socket_panel._stale)

        # 改一个与挂点无关的字段并保存
        ed._mark_dirty()
        ed._save_current_bundle()

        after = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(after["atlas"], stale["atlas"], "挂点没动过，指纹不该被刷新")
        self.assertTrue(ed._socket_panel._stale, "失效状态必须保持，直到人真的重标")

    def test_stale_fingerprint_shows_banner_and_refreshes_on_save(self) -> None:
        ed, key = self._panel()
        path = sockets_path_for_bundle(self._model.animation_bundles_path, key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "schemaVersion": 1,
            "atlas": _mismatched_atlas_fingerprint(self._model, key),
            "sockets": {"h": {"poses": {"0": {"x": 0.5, "y": 0.5}}}},
        }, ensure_ascii=False), encoding="utf-8")

        ed._on_select(key)
        panel = ed._socket_panel
        self.assertTrue(panel._stale, "指纹对不上必须判失效")
        self.assertTrue(panel._banner.isVisibleTo(panel), "失效必须让人看见——游戏里会整份忽略")

        # 重标一个点（= 真的动过）后保存，才以当前图集刷新指纹
        panel._socket_list.setCurrentRow(0)
        panel._on_pos_moved(0.5, 0.5)
        panel.save()
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data["atlas"]["slotCount"], len(self._model.animations[key]["atlasFrames"]))
        self.assertFalse(panel._stale, "重标并保存后才认证为有效")

    def test_copy_prev_and_interpolate_do_not_overwrite(self) -> None:
        ed, _key = self._panel()
        panel = ed._socket_panel
        panel._sockets()["h"] = {"poses": {}}
        panel._rebuild_sockets()
        panel._socket_list.setCurrentRow(0)
        slots = list(dict.fromkeys(panel._slots))
        if len(slots) < 3:
            self.skipTest("该动画包帧太少，插值用例不适用")
        panel._frame_list.setCurrentRow(0)
        panel._on_pos_moved(0.0, 0.0)
        panel._frame_list.setCurrentRow(panel._frame_list.count() - 1)
        panel._on_pos_moved(1.0, 1.0)
        filled = panel._interpolate() or 0  # 返回 None，看落库结果
        poses = panel._poses("h")
        self.assertGreaterEqual(len(poses), 3, "中间空帧应被插值补上")
        self.assertAlmostEqual(poses[str(slots[0])]["x"], 0.0, msg="端点不许被插值改写")
        self.assertAlmostEqual(poses[str(slots[-1])]["x"], 1.0, msg="端点不许被插值改写")


if __name__ == "__main__":
    unittest.main()
