"""画布 z 分层的次序契约。

画布的 z 分成两段，规则完全不同：

- **内容**（热点展示图、NPC 动画精灵）= 运行时画面上真实存在的东西，前后关系必须
  与运行时一致，由 `_resort_canvas_content_z` 按 `entity_sort_math` 派名次。
- **装饰品**（把手、碰撞面、辅助线、gizmo、组框、标尺）= 只存在于编辑器，恒在
  内容之上（标尺恒在之下），不参与内容排序。

本文件锁两件事：
1. 装饰品之间的**相对次序**与整体搬迁前一字不差（原值写在常量行注释里）；
2. 内容区间与装饰品区间**不重叠** —— 否则内容一旦按脚底 y 排到高处，就会盖住
   把手/碰撞顶点，画布变得点不动。
"""
from __future__ import annotations

import unittest

from tools.editor.editors import scene_editor as se


class DecorLayerOrderTests(unittest.TestCase):
    """装饰品相对次序：整体平移前后必须一致。"""

    def test_layers_are_strictly_increasing(self) -> None:
        """从下到上逐层递增。括号里是搬迁前的原值，用来核对次序没被改动。"""
        layers = [
            ("背景", se._Z_BACKGROUND),               # 原 -100
            ("背景缺件占位文字", se._Z_BG_PLACEHOLDER),  # 原 -90
            ("NPC 比例参考框", se._NPC_REF_Z),          # 原 -20
            ("内容区间下界", se._Z_CONTENT_LO),          # 原 -10(精灵) / -4(展示图)
            ("内容区间上界", se._Z_CONTENT_HI),
            ("碰撞多边形 / 透视幽灵", se._Z_DECOR_COLLISION),  # 原 -2
            ("独立 Zone 与各类把手", se._Z_DECOR_ENTITY),      # 原 0（默认）
            ("巡逻折线", se._PATROL_OVERLAY_Z),          # 原 2.0
            ("光环境曲线", se._LIGHTCURVE_OVERLAY_Z),     # 原 2.5
            ("场景分组框", se._Z_DECOR_GROUP_BOX),        # 原 6_000
            ("透视深度轴", se._Z_DECOR_PERSP_AXIS),       # 原 8_000
            ("transform gizmo", se._Z_DECOR_GIZMO),      # 原 9_000
        ]
        for (lo_name, lo), (hi_name, hi) in zip(layers, layers[1:]):
            self.assertLess(lo, hi, f"{lo_name} 应当低于 {hi_name}")

    def test_ruler_stays_below_content(self) -> None:
        """NPC 比例参考框是尺子，必须在内容之下 —— 否则它会盖住精灵。

        搬迁时最容易搞错的一条：装饰品整体上移很顺手，但标尺跟着上移就会
        压在 NPC 头上。原值 -20 本来就在精灵(-10)、展示图(-4) 之下。
        """
        self.assertLess(se._NPC_REF_Z, se._Z_CONTENT_LO)

    def test_content_band_does_not_collide_with_decor(self) -> None:
        """内容区间必须整个夹在标尺与碰撞面之间，两头都不许重叠。"""
        self.assertLess(se._NPC_REF_Z, se._Z_CONTENT_LO)
        self.assertLess(se._Z_CONTENT_LO, se._Z_CONTENT_HI)
        self.assertLess(se._Z_CONTENT_HI, se._Z_DECOR_COLLISION)

    def test_content_band_is_wide_enough(self) -> None:
        """内容按名次 +1 递增，区间格数必须远超任何场景的实体数。"""
        slots = (se._Z_CONTENT_HI - se._Z_CONTENT_LO) / se._Z_CONTENT_STEP
        self.assertGreaterEqual(slots, 100_000, "内容区间格数不足，实体多了会排到装饰区")

    def test_collision_sits_below_zone_and_handles(self) -> None:
        """碰撞面压在独立 Zone 与把手之下 —— 这是原来 -2 vs 0 的刻意差。"""
        self.assertLess(se._Z_DECOR_COLLISION, se._Z_DECOR_ENTITY)

    def test_pick_raise_must_stay_below_gesture_handles(self) -> None:
        """叠放循环点选的临时抬升**不许**盖过手柄类装饰品。

        这条曾经写反过，而且写反的版本还把回归当契约锁死了 —— 教训值得留在这。

        `mousePressEvent` 里抬 z 发生在 `super().mousePressEvent()` **之前**，
        直接决定 Qt 按 z 把这一 press 派给谁。栈里只有实体图元（把手 / 独立 Zone /
        碰撞面），所以「栈内 z_top + 1」最高只到 `_Z_DECOR_ENTITY + 1`，仍在
        巡逻折线 / 分组框 / 透视轴 / gizmo 之下 —— 那四类的手柄照常拿得到按下。
        换成固定的全画布顶（比如 1_000_000）就会把它们全压住：gizmo 的旋转手柄
        点不动，整个手势变成拖那块被抬起来的多边形。
        """
        raised = se._Z_DECOR_ENTITY + 1.0   # 栈内最高的实体图元被抬起后的 z
        for name, z in [
            ("巡逻折线", se._PATROL_OVERLAY_Z),
            ("光环境曲线", se._LIGHTCURVE_OVERLAY_Z),
            ("分组框", se._Z_DECOR_GROUP_BOX),
            ("透视轴", se._Z_DECOR_PERSP_AXIS),
            ("gizmo", se._Z_DECOR_GIZMO),
        ]:
            self.assertLess(raised, z, f"临时抬升压过了 {name} 的手柄，会抢走鼠标按下")

    def test_no_absolute_pick_raise_constant(self) -> None:
        """别再引入「固定抬到全画布顶」的常量 —— 它必须是栈内相对值。"""
        self.assertFalse(
            hasattr(se, "_Z_PICK_RAISED"),
            "_Z_PICK_RAISED 又回来了：叠放点选的抬升只能是 z_top+1 这样的相对值")


class GroupBoxSubdivisionTests(unittest.TestCase):
    """分组框「小框压大框」的细分公式必须在搬迁后仍然有效。"""

    @staticmethod
    def _z(area: float, index: int) -> float:
        """复刻 sync_group_boxes 里的公式（改那边必须同步改这里）。"""
        return se._Z_DECOR_GROUP_BOX + 1.0 / (1.0 + area / 1_000_000.0) + index * 1e-4

    def test_smaller_box_sits_above_bigger_box(self) -> None:
        """否则大框会把套在它里面的小组彻底挡住、永远点不中。"""
        big = self._z(area=4_000_000.0, index=0)
        small = self._z(area=100_000.0, index=0)
        self.assertGreater(small, big)

    def test_subdivision_stays_inside_its_own_band(self) -> None:
        """细分项再大也不许溢出到透视轴那一层去。"""
        z = self._z(area=0.0, index=50)
        self.assertLess(z, se._Z_DECOR_PERSP_AXIS)
        self.assertGreater(z, se._LIGHTCURVE_OVERLAY_Z)


if __name__ == "__main__":
    unittest.main()
