"""NPC 精灵预览的动画驱动（宿主侧）。

**为什么住在宿主而不是视图**：解析 anim.json、读图集、跑定时器都是"读资源"，
视图那一层的硬约束是不读盘。视图只暴露 `refresh_sprite_frames()`，
由这里每拍推一次当前帧进去。

## 这一层解决的是"画布对 NPC 撒谎"

重建初版把**整张图集**当贴图塞进 NPC 的世界框里 —— 画布上每个 NPC 不是一个人，
而是一坨密密麻麻的缩微小人；而且完全不动。后果不是"不好看"：策划没法凭画布判断
这个角色是谁、朝哪边、占多大地方、动画配没配对，`initialAnimState` /
`initialAnimPlayback`（仓库里上百个 NPC 在用）的**唯一**可视化校验入口也随之消失，
状态名拼错、这个状态在 anim.json 里根本不存在，全都只能进游戏才发现。

帧推进语义在 `shared/anim_frame_cursor.AnimFrameCursor`，与老画布**同一份**。
"""
from __future__ import annotations

import json

from PySide6.QtGui import QPixmap

from ...shared.anim_atlas_preview import (
    crop_atlas_cell,
    resolved_anim_world_pair,
    spritesheet_public_path,
)
from ...shared.anim_frame_cursor import AnimFrameCursor

__all__ = ["NpcAnimBank", "initial_playback_tuple"]


def initial_playback_tuple(npc: dict) -> tuple[float, bool, int | None, int | None]:
    """`initialAnimPlayback` → ``(speed, reverse, holdFrame, startFrame)``。

    与运行时 `Npc.sanitizeInitialAnimPlayback` 同口径：speed>0、hold/start≥0，
    负值 / 非法 = 未设。
    """
    raw = npc.get("initialAnimPlayback")
    d = raw if isinstance(raw, dict) else {}

    def _num(key):
        try:
            v = int(d.get(key))
        except (TypeError, ValueError):
            return None
        return v if v >= 0 else None

    try:
        speed = float(d.get("speed", 1.0) or 1.0)
    except (TypeError, ValueError):
        speed = 1.0
    return (speed if speed > 0 else 1.0, bool(d.get("reverse")),
            _num("holdFrame"), _num("startFrame"))


class _AnimBundle:
    """一份 anim.json 解出来的图集与状态表（按 animFile 缓存，多个 NPC 共用）。"""

    __slots__ = ("atlas", "cols", "rows", "cell_w", "cell_h", "atlas_frames",
                 "states", "world_w", "world_h")

    def __init__(self, atlas, cols, rows, cell_w, cell_h, atlas_frames,
                 states, world_w, world_h) -> None:
        self.atlas = atlas
        self.cols = cols
        self.rows = rows
        self.cell_w = cell_w
        self.cell_h = cell_h
        self.atlas_frames = atlas_frames
        self.states = states
        self.world_w = world_w
        self.world_h = world_h

    def pick_state(self, npc: dict) -> tuple[str, dict]:
        """选状态：`initialAnimState` > `idle` > 表里第一个（与老画布同口径）。"""
        want = str(npc.get("initialAnimState", "") or "").strip()
        if want in self.states:
            name = want
        elif "idle" in self.states:
            name = "idle"
        else:
            name = next(iter(self.states.keys()))
        st = self.states.get(name)
        return name, st if isinstance(st, dict) else {}


class NpcAnimBank:
    """按 NPC 维护帧游标，并按需裁出当前帧。

    `resolve_path(anim_id) -> Path | None` 由宿主注入（本模块不知道工程布局）。
    """

    def __init__(self, model, resolve_path) -> None:
        self._model = model
        self._resolve_path = resolve_path
        self._bundles: dict[str, _AnimBundle | None] = {}
        self._cursors: dict[str, tuple[str, AnimFrameCursor]] = {}

    def clear(self) -> None:
        """换场景时丢掉逐 NPC 的游标；图集缓存保留（换场景常常还是那批角色）。"""
        self._cursors.clear()

    # ---- 资源 --------------------------------------------------------------

    def _bundle(self, anim_id: str) -> _AnimBundle | None:
        if anim_id in self._bundles:
            return self._bundles[anim_id]
        self._bundles[anim_id] = None
        path = self._resolve_path(anim_id)
        if path is None or not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, ValueError):
            return None
        pair = resolved_anim_world_pair(data, self._model, anim_manifest_url=anim_id)
        states = data.get("states")
        sheet = str(data.get("spritesheet", "") or "").strip()
        if not pair or not sheet or not isinstance(states, dict) or not states:
            return None
        sheet_path = spritesheet_public_path(self._model, sheet, anim_id)
        if sheet_path is None or not sheet_path.is_file():
            return None
        atlas = QPixmap(str(sheet_path))
        if atlas.isNull():
            return None
        atlas_frames = data.get("atlasFrames")
        bundle = _AnimBundle(
            atlas,
            max(1, int(data.get("cols", 1) or 1)),
            max(1, int(data.get("rows", 1) or 1)),
            int(data.get("cellWidth", 0) or 0) or None,
            int(data.get("cellHeight", 0) or 0) or None,
            atlas_frames if isinstance(atlas_frames, list) else None,
            states,
            float(pair[0]), float(pair[1]),
        )
        self._bundles[anim_id] = bundle
        return bundle

    def _anim_id(self, npc: dict) -> str:
        return str(self._model.character_field(npc, "animFile") or "").strip()

    # ---- 查询 --------------------------------------------------------------

    def world_size(self, npc: dict) -> tuple[float, float] | None:
        """精灵的世界尺寸；动画包解不出来返回 None（视图据此不建精灵图元）。"""
        anim_id = self._anim_id(npc)
        bundle = self._bundle(anim_id) if anim_id else None
        if bundle is None:
            return None
        return (bundle.world_w, bundle.world_h)

    def _cursor_for(self, npc_id: str, npc: dict, bundle: _AnimBundle):
        """取（或按状态变化重建）该 NPC 的帧游标。"""
        name, st = bundle.pick_state(npc)
        cached = self._cursors.get(npc_id)
        if cached is not None and cached[0] == name:
            cursor = cached[1]
        else:
            frames = st.get("frames")
            cursor = AnimFrameCursor(
                frames if isinstance(frames, list) and frames else [0],
                float(st.get("frameRate", 8) or 8),
                bool(st.get("loop", True)))
            self._cursors[npc_id] = (name, cursor)
        # 播放参数每拍拉取（与老画布同口径：变化边沿才拨游标）
        cursor.set_playback(*initial_playback_tuple(npc))
        return cursor

    def frame_pixmap(self, npc: dict) -> QPixmap | None:
        """当前帧。**裁出图集里的一格**，不是整张图集。"""
        anim_id = self._anim_id(npc)
        bundle = self._bundle(anim_id) if anim_id else None
        if bundle is None:
            return None
        npc_id = str(npc.get("id", "") or "")
        cursor = self._cursor_for(npc_id, npc, bundle)
        idx = cursor.atlas_index
        sw = sh = None
        if bundle.atlas_frames and 0 <= idx < len(bundle.atlas_frames):
            box = bundle.atlas_frames[idx]
            if isinstance(box, dict):
                sw = int(box.get("width", 0) or 0) or None
                sh = int(box.get("height", 0) or 0) or None
        return crop_atlas_cell(
            bundle.atlas, bundle.cols, bundle.rows, idx,
            cell_w=bundle.cell_w, cell_h=bundle.cell_h, slice_w=sw, slice_h=sh)

    def advance(self, dt: float) -> bool:
        """推进全部游标。返回是否**有可能**换了帧（用于跳过无谓重绘）。"""
        moved = False
        for _name, cursor in self._cursors.values():
            before = cursor.frame_idx
            cursor.advance(dt)
            moved = moved or cursor.frame_idx != before
        return moved
