"""全局帧库与多动画序列数据模型、合并导出索引构建。"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import numpy as np

from .atlas_core import (
    build_atlas_native_equal_cells,
    export_gamedraft_anim,
    export_gamedraft_anim_multi,
)


def new_id() -> str:
    return uuid.uuid4().hex[:16]


def make_animation_clip(name: str, frame_rate: float = 12.0, loop: bool = True) -> AnimationClip:
    return AnimationClip(id=new_id(), name=name, frame_ids=[], frame_rate=frame_rate, loop=loop)


@dataclass
class FrameItem:
    id: str
    rgba: np.ndarray
    source_path: str
    t_sec: float


@dataclass
class AnimationClip:
    id: str
    name: str
    frame_ids: List[str] = field(default_factory=list)
    frame_rate: float = 12.0
    loop: bool = True


@dataclass
class VideoProject:
    frames: List[FrameItem] = field(default_factory=list)
    clips: List[AnimationClip] = field(default_factory=list)

    def frame_map(self) -> Dict[str, FrameItem]:
        return {f.id: f for f in self.frames}

    def append_decoded(
        self,
        rgba_list: List[np.ndarray],
        times: List[float],
        source_path: str,
    ) -> List[str]:
        """追加解码帧，返回新建 id 列表。"""
        ids: List[str] = []
        for rgba, t in zip(rgba_list, times):
            fid = new_id()
            self.frames.append(FrameItem(id=fid, rgba=rgba, source_path=source_path, t_sec=float(t)))
            ids.append(fid)
        return ids

    def clip_by_id(self, cid: str) -> Optional[AnimationClip]:
        for c in self.clips:
            if c.id == cid:
                return c
        return None

    def resolve_rgba_ordered(self, frame_ids: List[str]) -> Tuple[List[np.ndarray], List[float]]:
        m = self.frame_map()
        rgba: List[np.ndarray] = []
        times: List[float] = []
        for fid in frame_ids:
            item = m.get(fid)
            if item is None:
                raise KeyError(f"未知帧 id: {fid}")
            rgba.append(item.rgba)
            times.append(item.t_sec)
        return rgba, times


def build_merge_atlas_and_states(
    project: VideoProject,
    clips: List[AnimationClip],
    *,
    padding: int,
    feather_ignore_px: int,
    dedup: bool,
    frame_index_base: int,
) -> Tuple[Any, dict[str, Any], dict[str, dict[str, Any]]]:
    """
    合并多个 clip 到一张图集。
返回 (PIL.Image, meta, states_spec) 供 export_gamedraft_anim_multi。
    """
    m = project.frame_map()
    cell_rgba: List[np.ndarray] = []
    id_to_cell: Dict[str, int] = {}
    states_spec: dict[str, dict[str, Any]] = {}

    for clip in clips:
        indices: List[int] = []
        for fid in clip.frame_ids:
            if fid not in m:
                raise KeyError(f"未知帧 id: {fid}")
            if dedup and fid in id_to_cell:
                cell_i = id_to_cell[fid]
            else:
                cell_i = len(cell_rgba)
                cell_rgba.append(m[fid].rgba.copy())
                if dedup:
                    id_to_cell[fid] = cell_i
            indices.append(frame_index_base + cell_i)
        states_spec[clip.name] = {
            "frames": indices,
            "frameRate": clip.frame_rate,
            "loop": clip.loop,
        }

    if not cell_rgba:
        raise RuntimeError("合并导出：没有任何帧")

    atlas, meta = build_atlas_native_equal_cells(
        cell_rgba,
        padding=padding,
        feather_ignore_px=feather_ignore_px,
        cols=0,
        rows=0,
        frame_index_base=frame_index_base,
        export_fps=12.0,
        frame_times=[0.0] * len(cell_rgba),
        video_path="",
    )
    return atlas, meta, states_spec


def export_single_clip_native(
    project: VideoProject,
    clip: AnimationClip,
    *,
    padding: int,
    feather_ignore_px: int,
    frame_index_base: int,
    spritesheet_rel: str,
    world_w: Optional[float],
    world_h: Optional[float],
) -> Tuple[Any, dict[str, Any], dict[str, Any]]:
    if not clip.frame_ids:
        raise RuntimeError("动画序列为空")
    rgba, times = project.resolve_rgba_ordered(clip.frame_ids)
    atlas, meta = build_atlas_native_equal_cells(
        rgba,
        padding=padding,
        feather_ignore_px=feather_ignore_px,
        cols=0,
        rows=0,
        frame_index_base=frame_index_base,
        export_fps=clip.frame_rate,
        frame_times=times,
        video_path="",
    )
    anim = export_gamedraft_anim(
        meta,
        spritesheet_rel,
        world_w,
        world_h,
        clip.name,
        clip.loop,
        frame_rate=clip.frame_rate,
    )
    return atlas, meta, anim
