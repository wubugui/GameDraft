""""让 NPC 沿巡逻路线走一遍给你看" —— 走位推进的唯一实现，零 Qt。

## 为什么需要它

巡逻路线在画布上是一条静态折线。路线走不走得通、速度合不合适、拐点顺序对不对，
光看折线判断不了；老画布为此有一个「画布预览巡逻（不写回 x,y）」开关，勾上以后
NPC 就沿路线走起来。

新画布复用的是**同一个属性面板**，所以那个复选框照常显示、照常可勾 —— 但勾了
什么都不发生。这比缺功能更糟：策划会以为"勾了不动 = 我的路线/速度配错了"，
去改一堆本来没问题的数据。

## 语义

- 端点**折返**（走到最后一个点掉头往回，不是绕回起点）；
- 速度取 `patrol.speed`，缺省 60；
- 少于两个路点时原地不动（那不是"路线"）；
- **只动预览位置，绝不写回 x/y** —— 复选框的名字就是这么承诺的。
"""
from __future__ import annotations

import math

__all__ = ["PatrolWalker"]


class PatrolWalker:
    """一个 NPC 的巡逻预览游标。"""

    __slots__ = ("px", "py", "target_index", "step", "_started")

    def __init__(self) -> None:
        self.px = 0.0
        self.py = 0.0
        self.target_index = 0
        self.step = 1
        self._started = False

    def reset(self) -> None:
        self._started = False

    def advance(self, npc: dict, dt: float) -> tuple[float, float]:
        """推进 `dt` 秒，返回预览位置。数据一个字节都不动。"""
        route = (npc.get("patrol") or {}).get("route")
        if not isinstance(route, list) or len(route) < 2:
            return float(npc.get("x", 0) or 0), float(npc.get("y", 0) or 0)
        if not self._started:
            self.px = float(npc.get("x", 0) or 0)
            self.py = float(npc.get("y", 0) or 0)
            self.target_index = 0
            self.step = 1
            self._started = True
        try:
            speed = float((npc.get("patrol") or {}).get("speed", 60) or 60)
        except (TypeError, ValueError):
            speed = 60.0
        n = len(route)
        self.target_index = max(0, min(self.target_index, n - 1))
        target = route[self.target_index]
        try:
            tx = float(target["x"])
            ty = float(target["y"])
        except (TypeError, ValueError, KeyError):
            return self.px, self.py
        dx, dy = tx - self.px, ty - self.py
        dist = math.hypot(dx, dy)
        move = speed * float(dt)
        if dist <= 1e-5 or dist <= move:
            self.px, self.py = tx, ty
            self.target_index += self.step
            # **端点折返**，不是绕回起点 —— 与老画布同口径
            if self.target_index >= n:
                self.target_index = max(0, n - 1)
                self.step = -1
            elif self.target_index < 0:
                self.target_index = 0
                self.step = 1
        else:
            self.px += dx / dist * move
            self.py += dy / dist * move
        return self.px, self.py
