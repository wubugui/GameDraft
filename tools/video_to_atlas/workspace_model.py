"""
Workspace data model: VideoSource, FrameItem, SlotRef, AnimationClip,
ExportJob, GlobalSettings, ChromaParams — plus save/load persistence.

Workspace directory layout (.vtaw):
    project.json          manifest
    frames/{id}.png       RGBA per-frame
    thumbnails/{id}.png   64x64 cache (rebuildable)
"""
from __future__ import annotations

import json
import os
import shutil
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import cv2
import numpy as np
from PIL import Image

from .atlas_core import flip_bgra_horizontal

_WORKSPACE_VERSION = 1
_THUMB_SIZE = 64


def new_id() -> str:
    return uuid.uuid4().hex[:16]


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class ChromaParams:
    enabled: bool = False
    key_rgb: Tuple[int, int, int] = (255, 255, 255)
    tolerance: float = 40.0

    def to_dict(self) -> dict:
        return {
            "enabled": self.enabled,
            "keyRgb": list(self.key_rgb),
            "tolerance": self.tolerance,
        }

    @staticmethod
    def from_dict(d: dict) -> ChromaParams:
        rgb = tuple(d.get("keyRgb", [255, 255, 255]))
        return ChromaParams(
            enabled=bool(d.get("enabled", False)),
            key_rgb=(int(rgb[0]), int(rgb[1]), int(rgb[2])),
            tolerance=float(d.get("tolerance", 40.0)),
        )


@dataclass
class VideoSource:
    video_id: str
    source_path: str
    display_name: str
    duration_sec: float = 0.0
    fps: float = 30.0
    frame_ids: List[str] = field(default_factory=list)
    chroma_params: Optional[ChromaParams] = None

    def to_dict(self) -> dict:
        d: dict = {
            "videoId": self.video_id,
            "sourcePath": self.source_path,
            "displayName": self.display_name,
            "durationSec": self.duration_sec,
            "fps": self.fps,
            "frameIds": list(self.frame_ids),
        }
        if self.chroma_params is not None:
            d["chromaParams"] = self.chroma_params.to_dict()
        return d

    @staticmethod
    def from_dict(d: dict) -> VideoSource:
        cp = None
        if "chromaParams" in d and d["chromaParams"] is not None:
            cp = ChromaParams.from_dict(d["chromaParams"])
        return VideoSource(
            video_id=str(d["videoId"]),
            source_path=str(d.get("sourcePath", "")),
            display_name=str(d.get("displayName", "")),
            duration_sec=float(d.get("durationSec", 0.0)),
            fps=float(d.get("fps", 30.0)),
            frame_ids=list(d.get("frameIds", [])),
            chroma_params=cp,
        )


@dataclass
class FrameItem:
    id: str
    video_id: str
    rgba: np.ndarray
    t_sec: float

    def meta_dict(self) -> dict:
        return {"videoId": self.video_id, "tSec": self.t_sec}


@dataclass
class SlotRef:
    frame_id: str
    flip_h: bool = False

    def to_dict(self) -> dict:
        return {"frameId": self.frame_id, "flipH": self.flip_h}

    @staticmethod
    def from_dict(d: dict) -> SlotRef:
        return SlotRef(
            frame_id=str(d["frameId"]),
            flip_h=bool(d.get("flipH", False)),
        )


@dataclass
class AnimationClip:
    id: str
    name: str
    slots: List[SlotRef] = field(default_factory=list)
    frame_rate: float = 12.0
    loop: bool = True

    @property
    def frame_ids(self) -> List[str]:
        return [s.frame_id for s in self.slots]

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "slots": [s.to_dict() for s in self.slots],
            "frameRate": self.frame_rate,
            "loop": self.loop,
        }

    @staticmethod
    def from_dict(d: dict) -> AnimationClip:
        slots = [SlotRef.from_dict(s) for s in d.get("slots", [])]
        return AnimationClip(
            id=str(d["id"]),
            name=str(d["name"]),
            slots=slots,
            frame_rate=float(d.get("frameRate", 12.0)),
            loop=bool(d.get("loop", True)),
        )


@dataclass
class ExportJob:
    id: str
    clip_id: str
    scale: float = 1.0
    padding: int = 4
    feather_ignore_px: int = 0
    world_w: Optional[float] = None
    world_h: Optional[float] = None
    # 合并导出时是否包含本行（写入 project.json）
    include_in_merge: bool = True

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "clipId": self.clip_id,
            "scale": self.scale,
            "padding": self.padding,
            "featherIgnorePx": self.feather_ignore_px,
            "worldW": self.world_w,
            "worldH": self.world_h,
            "includeInMerge": self.include_in_merge,
        }

    @staticmethod
    def from_dict(d: dict) -> ExportJob:
        return ExportJob(
            id=str(d["id"]),
            clip_id=str(d["clipId"]),
            scale=float(d.get("scale", 1.0)),
            padding=int(d.get("padding", 4)),
            feather_ignore_px=int(d.get("featherIgnorePx", 0)),
            world_w=d.get("worldW"),
            world_h=d.get("worldH"),
            include_in_merge=bool(d.get("includeInMerge", True)),
        )


@dataclass
class GlobalSettings:
    frame_index_base: int = 0
    save_meta: bool = True
    dedup_merge: bool = True
    # 以下两项仅兼容旧 project.json；UI 已移除，导出固定 atlas.png，世界尺寸看各 ExportJob
    spritesheet_rel_path: str = "atlas.png"
    world_size_mode: int = 0

    def to_dict(self) -> dict:
        return {
            "frameIndexBase": self.frame_index_base,
            "saveMeta": self.save_meta,
            "dedupMerge": self.dedup_merge,
            "spritesheetRelPath": self.spritesheet_rel_path,
            "worldSizeMode": self.world_size_mode,
        }

    @staticmethod
    def from_dict(d: dict) -> GlobalSettings:
        return GlobalSettings(
            frame_index_base=int(d.get("frameIndexBase", 0)),
            save_meta=bool(d.get("saveMeta", True)),
            dedup_merge=bool(d.get("dedupMerge", True)),
            spritesheet_rel_path=str(d.get("spritesheetRelPath", "atlas.png")),
            world_size_mode=int(d.get("worldSizeMode", 0)),
        )


# ---------------------------------------------------------------------------
# Helper: frame PNG I/O  (BGRA <-> RGBA PNG)
# ---------------------------------------------------------------------------

def _save_frame_png(bgra: np.ndarray, path: Path) -> None:
    rgba = cv2.cvtColor(bgra, cv2.COLOR_BGRA2RGBA)
    Image.fromarray(rgba, "RGBA").save(str(path), format="PNG")


def _load_frame_png(path: Path) -> np.ndarray:
    img = Image.open(str(path)).convert("RGBA")
    rgba = np.asarray(img, dtype=np.uint8)
    return cv2.cvtColor(rgba, cv2.COLOR_RGBA2BGRA)


def _save_thumbnail(bgra: np.ndarray, path: Path) -> None:
    h, w = bgra.shape[:2]
    scale = _THUMB_SIZE / max(w, h, 1)
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    small = cv2.resize(bgra, (nw, nh), interpolation=cv2.INTER_AREA)
    _save_frame_png(small, path)


# ---------------------------------------------------------------------------
# Workspace
# ---------------------------------------------------------------------------

def make_animation_clip(name: str, frame_rate: float = 12.0,
                        loop: bool = True) -> AnimationClip:
    return AnimationClip(id=new_id(), name=name, slots=[], frame_rate=frame_rate, loop=loop)


class Workspace:
    """Central project state — replaces the old VideoProject."""

    def __init__(self) -> None:
        self.video_sources: List[VideoSource] = []
        self.clips: List[AnimationClip] = []
        self.export_jobs: List[ExportJob] = []
        self.settings: GlobalSettings = GlobalSettings()
        self.active_video_id: Optional[str] = None
        self.dir_path: Optional[Path] = None

        self._frame_store: Dict[str, FrameItem] = {}
        self._id_to_video_local: Dict[str, Tuple[str, int]] = {}

    # -- cache helpers -------------------------------------------------------

    def _rebuild_reverse_index(self) -> None:
        self._id_to_video_local.clear()
        for vs in self.video_sources:
            for local_idx, fid in enumerate(vs.frame_ids):
                self._id_to_video_local[fid] = (vs.video_id, local_idx)

    def frame_by_id(self, fid: str) -> Optional[FrameItem]:
        return self._frame_store.get(fid)

    def frame_map(self) -> Dict[str, FrameItem]:
        return self._frame_store

    def id_to_local_index(self, fid: str) -> Optional[Tuple[str, int]]:
        return self._id_to_video_local.get(fid)

    # -- VideoSource ---------------------------------------------------------

    def video_by_id(self, vid: str) -> Optional[VideoSource]:
        for vs in self.video_sources:
            if vs.video_id == vid:
                return vs
        return None

    def active_video(self) -> Optional[VideoSource]:
        if self.active_video_id is None:
            return None
        return self.video_by_id(self.active_video_id)

    def add_video_source(self, vs: VideoSource) -> None:
        self.video_sources.append(vs)

    def generate_display_name(self, base_name: str) -> str:
        existing = {vs.display_name for vs in self.video_sources}
        if base_name not in existing:
            return base_name
        i = 2
        while f"{base_name} ({i})" in existing:
            i += 1
        return f"{base_name} ({i})"

    # -- Frame CRUD ----------------------------------------------------------

    def append_frames_to_video(self, video_id: str,
                               items: List[FrameItem]) -> None:
        vs = self.video_by_id(video_id)
        if vs is None:
            raise KeyError(f"VideoSource not found: {video_id}")
        for item in items:
            item.video_id = video_id
            self._frame_store[item.id] = item
            vs.frame_ids.append(item.id)
            local_idx = len(vs.frame_ids) - 1
            self._id_to_video_local[item.id] = (video_id, local_idx)
            if self.dir_path is not None:
                frames_dir = self.dir_path / "frames"
                frames_dir.mkdir(parents=True, exist_ok=True)
                _save_frame_png(item.rgba, frames_dir / f"{item.id}.png")
                thumb_dir = self.dir_path / "thumbnails"
                thumb_dir.mkdir(parents=True, exist_ok=True)
                _save_thumbnail(item.rgba, thumb_dir / f"{item.id}.png")

    def delete_frames_scan(self, frame_ids: Set[str]) -> List[Tuple[str, str, int]]:
        """Return references (clip_id, clip_name, slot_index) without deleting."""
        refs: List[Tuple[str, str, int]] = []
        for clip in self.clips:
            for slot_idx, slot in enumerate(clip.slots):
                if slot.frame_id in frame_ids:
                    refs.append((clip.id, clip.name, slot_idx))
        return refs

    def commit_frame_deletion(self, frame_ids: Set[str]) -> None:
        """Actually remove frames from store and video sources.
        Clip slots that reference deleted ids are left as-is (missing state)."""
        for fid in frame_ids:
            self._frame_store.pop(fid, None)
            self._id_to_video_local.pop(fid, None)
            if self.dir_path is not None:
                for subdir in ("frames", "thumbnails"):
                    p = self.dir_path / subdir / f"{fid}.png"
                    if p.exists():
                        p.unlink(missing_ok=True)
        for vs in self.video_sources:
            vs.frame_ids = [fid for fid in vs.frame_ids if fid not in frame_ids]
        self._rebuild_reverse_index()

    def delete_video_source(self, video_id: str) -> List[Tuple[str, str, int]]:
        """Delete a VideoSource and all its frames. Returns refs first."""
        vs = self.video_by_id(video_id)
        if vs is None:
            return []
        ids = set(vs.frame_ids)
        refs = self.delete_frames_scan(ids)
        return refs

    def commit_video_source_deletion(self, video_id: str) -> None:
        vs = self.video_by_id(video_id)
        if vs is None:
            return
        ids = set(vs.frame_ids)
        self.commit_frame_deletion(ids)
        self.video_sources = [v for v in self.video_sources if v.video_id != video_id]
        self.export_jobs = [j for j in self.export_jobs
                            if self.clip_by_id(j.clip_id) is not None]
        if self.active_video_id == video_id:
            self.active_video_id = (self.video_sources[0].video_id
                                    if self.video_sources else None)

    # -- AnimationClip -------------------------------------------------------

    def clip_by_id(self, cid: str) -> Optional[AnimationClip]:
        for c in self.clips:
            if c.id == cid:
                return c
        return None

    def add_clip(self, clip: AnimationClip) -> None:
        self.clips.append(clip)

    def delete_clip(self, clip_id: str) -> None:
        self.clips = [c for c in self.clips if c.id != clip_id]
        self.export_jobs = [j for j in self.export_jobs if j.clip_id != clip_id]

    def validate_clip(self, clip: AnimationClip) -> List[int]:
        """Return slot indices that reference missing frames."""
        missing: List[int] = []
        for i, slot in enumerate(clip.slots):
            if slot.frame_id not in self._frame_store:
                missing.append(i)
        return missing

    def add_slots_to_clip(self, clip_id: str,
                          new_slots: List[SlotRef]) -> List[str]:
        """Add slots, skipping duplicates. Returns list of skipped frame_ids."""
        clip = self.clip_by_id(clip_id)
        if clip is None:
            raise KeyError(f"Clip not found: {clip_id}")
        existing = {s.frame_id for s in clip.slots}
        skipped: List[str] = []
        for slot in new_slots:
            if slot.frame_id in existing:
                skipped.append(slot.frame_id)
                continue
            clip.slots.append(slot)
            existing.add(slot.frame_id)
        return skipped

    def clip_range_from_active(self, i: int, j: int) -> List[SlotRef]:
        """Slice [i, j] (inclusive) from active video's frame_ids as SlotRefs."""
        vs = self.active_video()
        if vs is None:
            return []
        ids = vs.frame_ids
        i = max(0, min(i, len(ids) - 1))
        j = max(i, min(j, len(ids) - 1))
        return [SlotRef(frame_id=fid) for fid in ids[i:j + 1]]

    # -- Resolve for preview / export ----------------------------------------

    def resolve_for_preview(self, slots: List[SlotRef]) -> List[Optional[np.ndarray]]:
        """Return RGBA list with None for missing frames. Applies flip_h."""
        result: List[Optional[np.ndarray]] = []
        for slot in slots:
            item = self._frame_store.get(slot.frame_id)
            if item is None:
                result.append(None)
            elif slot.flip_h:
                result.append(flip_bgra_horizontal(item.rgba))
            else:
                result.append(item.rgba)
        return result

    def resolve_for_export(self, slots: List[SlotRef]) -> List[np.ndarray]:
        """Return RGBA list — raises on missing. Applies flip_h."""
        result: List[np.ndarray] = []
        for slot in slots:
            item = self._frame_store.get(slot.frame_id)
            if item is None:
                raise KeyError(f"Missing frame: {slot.frame_id}")
            if slot.flip_h:
                result.append(flip_bgra_horizontal(item.rgba))
            else:
                result.append(item.rgba)
        return result

    # -- ExportJob -----------------------------------------------------------

    def add_export_job(self, job: ExportJob) -> None:
        self.export_jobs.append(job)

    def remove_export_job(self, job_id: str) -> None:
        self.export_jobs = [j for j in self.export_jobs if j.id != job_id]

    # -- Persistence ---------------------------------------------------------

    def save_workspace(self, dir_path: Optional[Path] = None) -> None:
        target = dir_path or self.dir_path
        if target is None:
            raise ValueError("No workspace path specified")
        target = Path(target)
        target.mkdir(parents=True, exist_ok=True)
        frames_dir = target / "frames"
        frames_dir.mkdir(exist_ok=True)
        thumb_dir = target / "thumbnails"
        thumb_dir.mkdir(exist_ok=True)

        for fid, item in self._frame_store.items():
            fp = frames_dir / f"{fid}.png"
            if not fp.exists():
                _save_frame_png(item.rgba, fp)
            tp = thumb_dir / f"{fid}.png"
            if not tp.exists():
                _save_thumbnail(item.rgba, tp)

        frames_meta: Dict[str, Any] = {}
        for fid, item in self._frame_store.items():
            frames_meta[fid] = item.meta_dict()

        doc: Dict[str, Any] = {
            "version": _WORKSPACE_VERSION,
            "activeVideoId": self.active_video_id,
            "settings": self.settings.to_dict(),
            "videoSources": [vs.to_dict() for vs in self.video_sources],
            "frames": frames_meta,
            "clips": [c.to_dict() for c in self.clips],
            "exportJobs": [j.to_dict() for j in self.export_jobs],
        }

        json_path = target / "project.json"
        tmp_path = target / "project.json.tmp"
        tmp_path.write_text(json.dumps(doc, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        if json_path.exists():
            json_path.unlink()
        tmp_path.rename(json_path)
        self.dir_path = target

    @staticmethod
    def load_workspace(dir_path: Path) -> Workspace:
        dir_path = Path(dir_path)
        json_path = dir_path / "project.json"
        if not json_path.is_file():
            raise FileNotFoundError(f"project.json not found in {dir_path}")
        doc = json.loads(json_path.read_text(encoding="utf-8"))
        version = int(doc.get("version", 0))
        if version < 1:
            raise ValueError(f"Unsupported workspace version: {version}")

        ws = Workspace()
        ws.dir_path = dir_path
        ws.active_video_id = doc.get("activeVideoId")
        ws.settings = GlobalSettings.from_dict(doc.get("settings", {}))
        ws.video_sources = [VideoSource.from_dict(d)
                            for d in doc.get("videoSources", [])]
        ws.clips = [AnimationClip.from_dict(d)
                    for d in doc.get("clips", [])]
        ws.export_jobs = [ExportJob.from_dict(d)
                          for d in doc.get("exportJobs", [])]

        frames_dir = dir_path / "frames"
        frames_meta = doc.get("frames", {})
        for fid, meta in frames_meta.items():
            png_path = frames_dir / f"{fid}.png"
            if png_path.is_file():
                rgba = _load_frame_png(png_path)
            else:
                rgba = np.zeros((1, 1, 4), dtype=np.uint8)
            ws._frame_store[fid] = FrameItem(
                id=fid,
                video_id=str(meta.get("videoId", "")),
                rgba=rgba,
                t_sec=float(meta.get("tSec", 0.0)),
            )

        ws._rebuild_reverse_index()
        return ws

    def find_best_tail_candidates(
        self, video_id: str, head_idx: int,
        search_start: int, search_end: int, top_k: int = 5,
    ) -> List[Tuple[int, float]]:
        """Find top-K tail candidates by MSE similarity to head frame.
        Returns [(local_index, score), ...] sorted by ascending score."""
        vs = self.video_by_id(video_id)
        if vs is None:
            return []
        ids = vs.frame_ids
        if head_idx < 0 or head_idx >= len(ids):
            return []
        head_item = self._frame_store.get(ids[head_idx])
        if head_item is None:
            return []
        head_small = cv2.resize(head_item.rgba, (64, 64),
                                interpolation=cv2.INTER_AREA)
        head_f = head_small.astype(np.float32)
        lo = max(head_idx + 1, search_start)
        hi = min(len(ids) - 1, search_end)
        candidates: List[Tuple[int, float]] = []
        for i in range(hi, lo - 1, -1):
            item = self._frame_store.get(ids[i])
            if item is None:
                continue
            small = cv2.resize(item.rgba, (64, 64),
                               interpolation=cv2.INTER_AREA)
            if small.shape != head_small.shape:
                continue
            mse = float(np.mean((head_f - small.astype(np.float32)) ** 2))
            candidates.append((i, mse))
        candidates.sort(key=lambda x: x[1])
        return candidates[:top_k]

    def get_thumbnail_path(self, frame_id: str) -> Optional[Path]:
        if self.dir_path is None:
            return None
        p = self.dir_path / "thumbnails" / f"{frame_id}.png"
        if p.exists():
            return p
        item = self._frame_store.get(frame_id)
        if item is not None:
            thumb_dir = self.dir_path / "thumbnails"
            thumb_dir.mkdir(exist_ok=True)
            _save_thumbnail(item.rgba, p)
            if p.exists():
                return p
        return None
