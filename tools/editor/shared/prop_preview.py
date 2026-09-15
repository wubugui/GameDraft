"""编辑器侧"这支挂件此刻长什么样"的解析：挂点标注面板与挂件预设页的预览共用。

⚠ 本模块是运行时 ``src/data/propPresets.ts`` 里 ``parsePropPresets`` 的清洗口径
+ ``resolvePropStateName`` + ``resolvePropAttach`` 贴图/摆放那一半的**跨语言镜像**，
以及 ``src/data/resolveAnimationSet.ts::resolveAnimationWorldSize`` 的镜像。
两边答案必须一致（``test_prop_preview.py`` 按 TS 测试同一组用例钉死；norms 第 8 条）——
预览与游戏不一致就是"编辑器里对齐了、游戏里歪着"。

只镜像预览要用的那几项（贴图、支点、自转、缩放、挂点驱动帧号）；
灯 / 效果 / 持久化与预览无关，不在这里重写一遍。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

#: 摆放字段的运行时缺省（`SpriteEntity.syncAttachments` 里的 `?? 0.5` / `?? 1` / `?? 0`）
PLACEMENT_DEFAULTS: dict[str, float] = {"anchorX": 0.5, "anchorY": 0.5, "rotation": 0.0, "scale": 1.0}

#: 动画包 worldWidth / worldHeight 都没写时运行时用的宽（`DEFAULT_WORLD_WIDTH`）
DEFAULT_WORLD_WIDTH = 100.0


def _finite(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def _image_list(block: dict | None) -> list[str]:
    """`image` 在前、`images` 在后，空串滤掉（同 `propPresetImages` / `propStateImages`）。"""
    if not isinstance(block, dict):
        return []
    out: list[str] = []
    one = block.get("image")
    if isinstance(one, str) and one.strip():
        out.append(one.strip())
    many = block.get("images")
    if isinstance(many, list):
        out.extend(s.strip() for s in many if isinstance(s, str) and s.strip())
    return out


def _placement_value(block: dict | None, key: str) -> float | None:
    """一个摆放字段按运行时解析口径清洗：支点夹到 0..1、缩放非正当没填、非有限数当没填。"""
    if not isinstance(block, dict):
        return None
    v = _finite(block.get(key))
    if v is None:
        return None
    if key in ("anchorX", "anchorY"):
        return min(1.0, max(0.0, v))
    if key == "scale" and not v > 0:
        return None
    return v


def resolve_prop_state_name(preset: dict | None, requested: str = "") -> str:
    """挂上时用哪个状态：显式给的 → ``defaultState`` → ``states`` 第一个键 → 空串。

    给了**不存在**的状态名返回空串（同 `resolvePropStateName`：调用方据此报警，不静默挑一个）。
    """
    states = preset.get("states") if isinstance(preset, dict) else None
    if not isinstance(states, dict) or not states:
        return ""
    want = str(requested or "").strip()
    if want:
        return want if isinstance(states.get(want), dict) else ""
    preferred = str(preset.get("defaultState") or "").strip()
    if preferred and isinstance(states.get(preferred), dict):
        return preferred
    for name, st in states.items():
        if isinstance(st, dict) and str(name).strip():
            return str(name).strip()
    return ""


@dataclass(frozen=True)
class PropPreview:
    """一次挂载真正要画的样子（预设 + 状态合并后）。"""

    images: list[str] = field(default_factory=list)
    anchor_x: float = PLACEMENT_DEFAULTS["anchorX"]
    anchor_y: float = PLACEMENT_DEFAULTS["anchorY"]
    rotation: float = PLACEMENT_DEFAULTS["rotation"]
    scale: float = PLACEMENT_DEFAULTS["scale"]


def resolve_prop_preview(preset: dict | None, state_name: str = "") -> PropPreview:
    """合并预设与状态（同 `resolvePropAttach`，只是没有"本次调用的显式覆盖"那一层）。

    贴图：状态给了图就**整体替换**，没给才用基础块的。摆放：状态里写了的赢，没写的沿用基础块。
    """
    base = preset if isinstance(preset, dict) else {}
    states = base.get("states")
    st = states.get(state_name) if state_name and isinstance(states, dict) else None
    st = st if isinstance(st, dict) else None
    images = _image_list(st) or _image_list(base)
    vals: dict[str, float] = {}
    for key, default in PLACEMENT_DEFAULTS.items():
        v = _placement_value(st, key)
        if v is None:
            v = _placement_value(base, key)
        vals[key] = default if v is None else v
    return PropPreview(
        images=images,
        anchor_x=vals["anchorX"],
        anchor_y=vals["anchorY"],
        rotation=vals["rotation"],
        scale=vals["scale"],
    )


def frame_image_index(image_count: int, pose_frame: object) -> int:
    """挂点驱动帧号选第几张（同 `syncAttachments`：多于一张且标了帧号才取模，否则第一张）。"""
    n = int(image_count)
    if n <= 1:
        return 0
    f = _finite(pose_frame)
    if f is None:
        return 0
    return int(math.trunc(f)) % n


def prop_image_file(project_path: Path | None, url: str) -> Path | None:
    """挂件贴图 URL（``/resources/...``）→ 磁盘文件；找不到返回 None。"""
    if project_path is None:
        return None
    rel = str(url or "").strip().replace("\\", "/").lstrip("/")
    if not rel or ".." in rel.split("/"):
        return None
    for root in (Path(project_path) / "public", Path(project_path)):
        candidate = root / rel
        if candidate.is_file():
            return candidate
    return None


def anim_world_size(anim: dict | None, atlas_w: float, atlas_h: float) -> tuple[float, float] | None:
    """动画包的世界宽高（同 `resolveAnimationWorldSize`）：两个都写沿用、写一个按格长宽比推另一个、
    都没写宽取 100。格像素尺寸取不到（没写 cellWidth/Height 又没有图集尺寸）返回 None。
    """
    if not isinstance(anim, dict):
        return None
    cols = max(1, int(_finite(anim.get("cols")) or 1))
    rows = max(1, int(_finite(anim.get("rows")) or 1))
    cw = _finite(anim.get("cellWidth"))
    ch = _finite(anim.get("cellHeight"))
    frame_w = cw if cw is not None and cw > 0 else (float(atlas_w) / cols if atlas_w and atlas_w > 0 else None)
    frame_h = ch if ch is not None and ch > 0 else (float(atlas_h) / rows if atlas_h and atlas_h > 0 else None)
    w = _finite(anim.get("worldWidth"))
    h = _finite(anim.get("worldHeight"))
    w = w if w is not None and w > 0 else None
    h = h if h is not None and h > 0 else None
    if w is not None and h is not None:
        return (w, h)
    if not frame_w or not frame_h:
        return None
    aspect_hw = frame_h / frame_w
    if w is not None:
        return (w, _js_round_6(w * aspect_hw))
    if h is not None:
        return (_js_round_6(h / aspect_hw), h)
    return (DEFAULT_WORLD_WIDTH, _js_round_6(DEFAULT_WORLD_WIDTH * aspect_hw))


def _js_round_6(x: float) -> float:
    """`Math.round(x * 1e6) / 1e6`。Python 的 round 是银行家舍入，恰好 .5 时与 JS 答案不同。"""
    return math.floor(x * 1e6 + 0.5) / 1e6
