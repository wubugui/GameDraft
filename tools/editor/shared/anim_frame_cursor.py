""""动画放到第几帧了" —— 帧游标的唯一实现，零 Qt。

两个画布的 NPC 精灵预览都靠它。抽出来的理由与本仓其它共享模块一致：
帧推进的语义（循环/不循环、反向、定格帧、起播帧、速度倍率）与运行时
`Npc.sanitizeInitialAnimPlayback` 对齐过一次，各写一份必然漂移，而漂移的表现是
"编辑器里看着播得好好的，游戏里是另一段" —— 属于最难归因的一类。

## 语义（与运行时对齐，改动前先读这一段）

- `hold` 定格：给了 `hold` 就恒定停在那一帧，不推进。
- 起播：`hold` > `start` > 「反向从末帧、正向从 0」。
- `hold` / `start` / `reverse` 只在**变化边沿**拨动游标 —— 每拍都拨的话动画会
  永远停在起点（老画布 `set_playback` 的注释专门写了这一条）。
- `speed` / `reverse` 是连续量，直接覆盖。
- 不循环时走到端点就停在端点，并清空累计时间。
"""
from __future__ import annotations

__all__ = ["AnimFrameCursor"]


class AnimFrameCursor:
    """一条状态的帧游标。`frames` 是"第几帧 → 图集第几格"的映射表。"""

    __slots__ = ("frames", "frame_rate", "loop", "frame_idx", "_accum",
                 "speed_mult", "reverse", "hold_frame", "start_frame")

    def __init__(self, frames, frame_rate: float = 8.0, loop: bool = True) -> None:
        self.frames = [int(f) for f in (frames or [0])] or [0]
        self.frame_rate = float(frame_rate) if frame_rate else 8.0
        self.loop = bool(loop)
        self.frame_idx = 0
        self._accum = 0.0
        self.speed_mult = 1.0
        self.reverse = False
        self.hold_frame: int | None = None
        self.start_frame: int | None = None

    # ---- 播放参数 ----------------------------------------------------------

    def set_playback(self, speed: float, reverse: bool,
                     hold: int | None, start: int | None) -> None:
        """每拍拉取式套用初始播放参数（语义见模块 docstring）。"""
        self.speed_mult = float(speed) if speed and speed > 0 else 1.0
        n = max(1, len(self.frames))
        rev = bool(reverse)
        rev_changed = rev != self.reverse
        self.reverse = rev
        hold_changed = hold != self.hold_frame
        self.hold_frame = hold
        start_changed = start != self.start_frame
        self.start_frame = start
        if hold is not None:
            if hold_changed:
                self.frame_idx = int(hold) % n
                self._accum = 0.0
            return
        if hold_changed or start_changed or rev_changed:
            if start is not None:
                self.frame_idx = int(start) % n
            else:
                self.frame_idx = (n - 1) if rev else 0
            self._accum = 0.0

    # ---- 推进 --------------------------------------------------------------

    def advance(self, dt: float) -> None:
        """推进 `dt` 秒。定格时是空操作。"""
        if self.hold_frame is not None:
            return
        self._accum += float(dt)
        step = 1.0 / max(1e-6, self.frame_rate * self.speed_mult)
        while self._accum >= step and len(self.frames) > 1:
            self._accum -= step
            self.frame_idx += -1 if self.reverse else 1
            if self.frame_idx < 0 or self.frame_idx >= len(self.frames):
                if self.loop:
                    self.frame_idx = (len(self.frames) - 1) if self.reverse else 0
                else:
                    self.frame_idx = 0 if self.reverse else (len(self.frames) - 1)
                    self._accum = 0.0
                    break

    @property
    def atlas_index(self) -> int:
        """当前该画图集里的第几格。"""
        if not self.frames:
            return 0
        return int(self.frames[self.frame_idx % len(self.frames)])
