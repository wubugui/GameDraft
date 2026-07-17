"""实例 transform 数学镜像的跨语言 parity 锁（审查 P1-2）。

`tools/editor/shared/entity_transform_math.py` ↔ `src/utils/entityTransform.ts`
是手工镜像——本文件与 `src/utils/entityTransform.test.ts` 钉死**同一组黄金数值**，
任一侧漂移即红（norms 第 8 条：手工镜像必配语义级 parity；注释写"同口径"不算护栏）。

新增/修改用例时必须同步改两个文件（黄金常量一字不差）。

另含：编辑器动作往返（moveGroupBy 未填 speed 不得被注入，审查 P1-1）与
含新字段场景的 save_all 合成夹具往返（审查 P2-5）。
"""
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.shared.action_editor import ActionEditor
from tools.editor.shared.entity_transform_math import (
    entity_rotation_deg_of,
    entity_scale_of,
    inverse_transform_world_vec,
    transform_local_vec,
)
from tools.editor.tests.save_test_utils import write_minimal_loadable_project

# ---- 黄金用例（与 entityTransform.test.ts 完全一致；改一处必改两处） ----
GOLDEN_SCALE_CASES = [
    ({}, 1.0),
    ({"scale": 2.5}, 2.5),
    ({"scale": 2}, 2.0),
    ({"scale": "2"}, 1.0),      # 字符串数字：双侧一律拒绝回落（防预览撒谎）
    ({"scale": True}, 1.0),
    ({"scale": 0}, 1.0),
    ({"scale": -3}, 1.0),
    ({"scale": float("nan")}, 1.0),
]
GOLDEN_ROT_CASES = [
    ({}, 0.0),
    ({"rotation": 37.5}, 37.5),
    ({"rotation": -400}, -400.0),
    ({"rotation": "90"}, 0.0),
    ({"rotation": float("inf")}, 0.0),
]
# (lx, ly, scale, rot_deg) -> (x, y)（6 位小数）
GOLDEN_LOCAL_VEC_CASES = [
    ((10.0, 0.0, 2.0, 90.0), (0.0, 20.0)),
    ((3.0, 4.0, 1.5, 37.0), (-0.01703, 7.499981)),
    ((-5.0, -8.0, 0.5, -120.0), (-2.214102, 4.165064)),
    ((7.0, 2.0, 1.0, 0.0), (7.0, 2.0)),
]


class EntityTransformParityTests(unittest.TestCase):
    def test_scale_golden(self) -> None:
        for d, want in GOLDEN_SCALE_CASES:
            self.assertEqual(entity_scale_of(d), want, f"scale case {d!r}")

    def test_rotation_golden(self) -> None:
        for d, want in GOLDEN_ROT_CASES:
            self.assertEqual(entity_rotation_deg_of(d), want, f"rot case {d!r}")

    def test_local_vec_golden(self) -> None:
        for (lx, ly, s, deg), (wx, wy) in GOLDEN_LOCAL_VEC_CASES:
            x, y = transform_local_vec(lx, ly, s, deg)
            self.assertAlmostEqual(x, wx, places=5, msg=f"case {(lx, ly, s, deg)}")
            self.assertAlmostEqual(y, wy, places=5, msg=f"case {(lx, ly, s, deg)}")

    def test_inverse_is_true_inverse(self) -> None:
        for (lx, ly, s, deg), _ in GOLDEN_LOCAL_VEC_CASES:
            x, y = transform_local_vec(lx, ly, s, deg)
            bx, by = inverse_transform_world_vec(x, y, s, deg)
            self.assertAlmostEqual(bx, lx, places=6)
            self.assertAlmostEqual(by, ly, places=6)


class GroupActionEditorRoundtripTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def test_move_group_by_without_speed_not_injected(self) -> None:
        """moveGroupBy 未填可选 speed：编辑器打开→保存不得注入 speed 键（审查 P1-1）。"""
        action = {"type": "moveGroupBy", "params": {"group": "夜巡", "dx": 25, "dy": -10}}
        ed = ActionEditor("test")
        ed.set_data([action])
        out = ed.to_list()
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0], action, "moveGroupBy 往返注入/漂移了参数")

    def test_set_group_enabled_roundtrip(self) -> None:
        action = {"type": "setGroupEnabled", "params": {"group": "夜巡", "enabled": False}}
        ed = ActionEditor("test")
        ed.set_data([action])
        out = ed.to_list()
        self.assertEqual(out[0], action)


class SyntheticTransformSceneRoundtripTests(unittest.TestCase):
    """含 scale/rotation/group + 组动作的合成场景：save_all → 重载语义零变化
    （真实工程 JSON 尚无这些字段，黄金往返对它们零覆盖——潜伏破口，审查 P2-5）。"""

    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication(sys.argv)

    def test_save_reload_semantic_identity(self) -> None:
        scene = {
            "id": "sc_tf",
            "name": "sc_tf",
            "hotspots": [
                {"id": "h1", "type": "inspect", "label": "", "x": 50, "y": 50,
                 "interactionRange": 0, "data": {"text": ""},
                 "scale": 2.0, "rotation": 37.5, "group": "夜巡"},
            ],
            "npcs": [
                {"id": "n1", "name": "甲", "x": 100, "y": 100,
                 "interactionRange": 50, "scale": 1.5, "rotation": -20.0,
                 "group": "夜巡"},
            ],
            "zones": [
                {"id": "z1", "group": "夜巡",
                 "polygon": [{"x": 0, "y": 0}, {"x": 10, "y": 0}, {"x": 10, "y": 10}],
                 "onEnter": [
                     {"type": "setGroupEnabled",
                      "params": {"group": "夜巡", "enabled": False}},
                     {"type": "moveGroupBy",
                      "params": {"group": "夜巡", "dx": 25, "dy": -10}},
                 ]},
            ],
            "spawnPoints": {},
        }
        import copy as _c
        golden = _c.deepcopy(scene)
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            model = ProjectModel()
            model.load_project(root)
            model.scenes["sc_tf"] = scene
            model.mark_dirty("scene", "sc_tf")
            model.save_all()  # 无返回值；成败以重载断言
            model2 = ProjectModel()
            model2.load_project(root)
            got = model2.scenes.get("sc_tf")
            self.assertEqual(got, golden, "含 transform/group/组动作的场景往返语义漂移")
            # int/float 表示保真抽查
            self.assertIsInstance(got["hotspots"][0]["interactionRange"], int)
            self.assertIsInstance(got["npcs"][0]["interactionRange"], int)


if __name__ == "__main__":
    unittest.main()
