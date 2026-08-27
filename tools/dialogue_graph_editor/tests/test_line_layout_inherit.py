"""图对话 line 节点的版式层级：节点级 = 统一设置，拍级 = 破例覆盖。

层级共三层，运行时口径见 `GraphDialogueManager.lineBeatsFor`：

    拍级 layout  >  节点级 layout  >  运行时缺省（bottom）

编辑器必须把这三层如实往返，两个方向都要钉：

* 拍级留「跟随上层」→ **不写** layout 键（否则每拍都固化一份，节点级改了各拍不跟）
* 拍级显式选 bottom → **要写**（节点级可能是 top，这是真覆盖，不写就被继承盖掉）

第二条是最容易写反的：顶层的 bottom 是「缺省、不写」，子层的 bottom 是「覆盖、要写」，
两个口径混用就会静默丢掉作者的破例。
"""
from __future__ import annotations

import copy
import os
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from pathlib import Path

from PySide6.QtWidgets import QApplication

from tools.dialogue_graph_editor.node_inspector import NodeInspector
from tools.editor.project_model import ProjectModel

_PROJECT_ROOT = Path(__file__).resolve().parents[3]


def _beat(text: str, **extra) -> dict:
    return {"speaker": {"kind": "player"}, "text": text, **extra}


def _node(beats: list[dict], **extra) -> dict:
    return {
        "type": "line",
        "speaker": {"kind": "player"},
        "text": beats[0]["text"],
        "next": "n_x",
        "lines": beats,
        **extra,
    }


class LineLayoutInheritTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._app = QApplication.instance() or QApplication([])
        # 与真实编辑器一致：inspector 需要一个已加载工程的 ProjectModel，
        # 否则依赖 id 选择器的子控件回填不了、会误报成「丢字段」（同 test_inspector_roundtrip）。
        cls._pm = ProjectModel()
        cls._pm.load_project(_PROJECT_ROOT)

    def _roundtrip(self, node: dict) -> dict:
        insp = NodeInspector(
            lambda: ["n_test", "n_x"],
            project_root=_PROJECT_ROOT,
            project_model_getter=lambda: self._pm,
            dialogue_graph_id_getter=lambda: "",
        )
        try:
            insp.set_node("n_test", copy.deepcopy(node))
            out = insp.get_node()
        finally:
            insp.deleteLater()
        assert out is not None, "getter 返回空"
        return out

    # --- 节点级：统一设置 -------------------------------------------------------
    def test_node_level_layout_survives(self) -> None:
        for lay in ("top", "bubble"):
            with self.subTest(lay):
                out = self._roundtrip(_node([_beat("甲"), _beat("乙")], layout=lay))
                self.assertEqual(out.get("layout"), lay)

    def test_node_level_bottom_is_not_written(self) -> None:
        """顶层的缺省档不写：默认行为不该在数据里留噪音。"""
        out = self._roundtrip(_node([_beat("甲")], layout="bottom"))
        self.assertNotIn("layout", out)

    # --- 拍级：不写 = 继承 ------------------------------------------------------
    def test_beats_without_layout_stay_clean(self) -> None:
        """各拍留「跟随上层」时一个 layout 键都不该冒出来——冒出来就固化了，
        节点级再改各拍不跟，「统一设置」当场失效。"""
        out = self._roundtrip(_node([_beat("甲"), _beat("乙"), _beat("丙")], layout="top"))
        for i, b in enumerate(out["lines"]):
            self.assertNotIn("layout", b, f"第 {i} 拍被固化了版式")

    # --- 拍级：显式覆盖要写得出来 -----------------------------------------------
    def test_beat_level_override_survives(self) -> None:
        for lay in ("top", "bubble"):
            with self.subTest(lay):
                out = self._roundtrip(_node([_beat("甲", layout=lay), _beat("乙")]))
                self.assertEqual(out["lines"][0].get("layout"), lay)
                self.assertNotIn("layout", out["lines"][1])

    def test_beat_level_bottom_overrides_node_top(self) -> None:
        """最容易写反的一条：子层的 bottom 不是缺省，是对节点级 top 的真覆盖。"""
        out = self._roundtrip(_node([_beat("甲", layout="bottom"), _beat("乙")], layout="top"))
        self.assertEqual(out.get("layout"), "top")
        self.assertEqual(
            out["lines"][0].get("layout"), "bottom",
            "拍级显式屏底被当成缺省吃掉了——节点级是屏顶，这一拍会跟着变屏顶",
        )
        self.assertNotIn("layout", out["lines"][1])

    # --- 混合形态 ---------------------------------------------------------------
    def test_mixed_tiers_all_survive(self) -> None:
        out = self._roundtrip(_node(
            [_beat("甲"), _beat("乙", layout="bubble"), _beat("丙", layout="bottom")],
            layout="top",
        ))
        self.assertEqual(out.get("layout"), "top")
        self.assertNotIn("layout", out["lines"][0])
        self.assertEqual(out["lines"][1].get("layout"), "bubble")
        self.assertEqual(out["lines"][2].get("layout"), "bottom")

    # --- 节点级分边：同样是「统一设置」 ---------------------------------------
    def test_node_level_speaker_side_survives(self) -> None:
        for sd in ("left", "right"):
            with self.subTest(sd):
                out = self._roundtrip(_node([_beat("甲"), _beat("乙")], speakerSide=sd))
                self.assertEqual(out.get("speakerSide"), sd)

    def test_node_level_side_auto_is_not_written(self) -> None:
        """空 = 按说话实体自动推导。写死一边会把默认推导按掉，所以不许凭空注入。"""
        out = self._roundtrip(_node([_beat("甲")]))
        self.assertNotIn("speakerSide", out)

    def test_beat_level_side_override_survives(self) -> None:
        out = self._roundtrip(_node([_beat("甲", speakerSide="right"), _beat("乙")], speakerSide="left"))
        self.assertEqual(out.get("speakerSide"), "left")
        self.assertEqual(out["lines"][0].get("speakerSide"), "right")
        self.assertNotIn("speakerSide", out["lines"][1], "没设的拍不该被固化")

    # --- 四层一起 ---------------------------------------------------------------
    def test_layout_and_side_coexist_across_tiers(self) -> None:
        out = self._roundtrip(_node(
            [_beat("甲"), _beat("乙", layout="bubble", speakerSide="right")],
            layout="top", speakerSide="left",
        ))
        self.assertEqual(out.get("layout"), "top")
        self.assertEqual(out.get("speakerSide"), "left")
        self.assertNotIn("layout", out["lines"][0])
        self.assertNotIn("speakerSide", out["lines"][0])
        self.assertEqual(out["lines"][1].get("layout"), "bubble")
        self.assertEqual(out["lines"][1].get("speakerSide"), "right")


if __name__ == "__main__":
    unittest.main()
