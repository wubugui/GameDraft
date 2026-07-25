"""anim.json 图集的编辑器侧读取 + 「气泡头顶锚」数学镜像。

两件事，都要求与运行时逐字段同口径（防"预览撒谎"）：

1. **图集切分与世界尺寸推导** —— 镜像 ``SpriteEntity.loadFromDef`` /
   ``resolveAnimationSet``。这几个函数原先私有在 ``editors/scene_editor.py``，
   场景画布与气泡锚控件都要用，抽到 shared 避免两份口径各自漂移。
2. **当前帧内容框与头顶锚** —— 镜像 ``SpriteEntity.getContentBoxLocal`` 与
   ``Npc/Player.getEmoteBubbleAnchorLocalY``。

为什么需要"内容框"：``worldWidth/worldHeight`` 是**整张图集的格子**尺寸，per-atlas
恒定、覆盖最高帧；蹲/躺/跑这些矮帧上方全是透明留白，拿格子顶边当头顶锚会飘出角色
一大截（实测最矮帧只占格高 16%~25%）。运行时已改为按 ``atlasFrames[].contentHeight``
求当前帧真实内容顶边，编辑器预览必须跟着同一套算。
"""
from __future__ import annotations

import math
from pathlib import Path, PurePosixPath

from PySide6.QtCore import QRect
from PySide6.QtGui import QPixmap

from .entity_transform_math import (
    content_top_local_y_around_foot,
    quad_top_local_y_around_foot,
    transform_local_vec,
)

#: 气泡底边与头顶之间的空隙（世界单位）；与运行时 Npc/Player 的 headGap 同值。
HEAD_GAP = 8.0


# ---------------------------------------------------------------------------
# 图集寻址与切分（原 scene_editor 私有实现，行为逐字不变）
# ---------------------------------------------------------------------------

def anim_bundle_key_from_manifest_url(url: str) -> str:
    p = PurePosixPath(str(url).strip().replace("\\", "/").lstrip("/"))
    if p.name == "anim.json":
        return p.parent.name
    return p.stem


def anim_manifest_url_for_bundle(bundle_key: str) -> str:
    """动画包名 → 运行时 animFile URL（与 npc.animFile / player animManifest 同形）。"""
    return f"/resources/runtime/animation/{str(bundle_key).strip()}/anim.json"


def spritesheet_public_path(
    model,
    spritesheet: str,
    anim_manifest_url: str | None,
) -> Path | None:
    """与运行时 resolvePathRelativeToAnimManifest 一致，返回 public 下的绝对路径。"""
    if model is None or not getattr(model, "project_path", None):
        return None
    pub = model.project_path / "public"
    sh = str(spritesheet or "").strip()
    if not sh:
        return None
    if sh.startswith("/assets/"):
        return pub / sh.lstrip("/")
    if not anim_manifest_url:
        return None
    base = PurePosixPath(anim_manifest_url.strip().lstrip("/")).parent
    part = sh[2:] if sh.startswith("./") else sh
    return pub / (base / PurePosixPath(part))


def resolved_anim_world_pair(
    data: dict,
    model,
    *,
    anim_manifest_url: str | None = None,
) -> tuple[float, float] | None:
    """与运行时 normalizeAnimationSetDef 一致：worldWidth/worldHeight 可只填其一。"""
    cols = max(1, int(data.get("cols", 1) or 1))
    rows = max(1, int(data.get("rows", 1) or 1))
    w = float(data.get("worldWidth", 0) or 0)
    h = float(data.get("worldHeight", 0) or 0)
    if w > 0 and h > 0:
        return (w, h)
    sheet = str(data.get("spritesheet", "") or "").strip()
    sp = spritesheet_public_path(model, sheet, anim_manifest_url)
    if sp is None or not sp.is_file():
        return None
    pm = QPixmap(str(sp))
    if pm.isNull() or pm.width() <= 0:
        return None
    cw = int(data.get("cellWidth", 0) or 0)
    ch = int(data.get("cellHeight", 0) or 0)
    fw = max(1, cw if cw > 0 else pm.width() // cols)
    fh = max(1, ch if ch > 0 else pm.height() // rows)
    aspect_hw = fh / fw
    if w > 0:
        return (w, w * aspect_hw)
    if h > 0:
        return (h / aspect_hw, h)
    return None


def crop_atlas_cell(
    atlas: QPixmap,
    cols: int,
    rows: int,
    atlas_index: int,
    *,
    cell_w: int | None = None,
    cell_h: int | None = None,
    slice_w: int | None = None,
    slice_h: int | None = None,
) -> QPixmap | None:
    if atlas is None or atlas.isNull():
        return None
    pw = atlas.width()
    ph = atlas.height()
    c = max(1, cols)
    r = max(1, rows)
    stride_w = max(1, int(cell_w) if cell_w and cell_w > 0 else pw // c)
    stride_h = max(1, int(cell_h) if cell_h and cell_h > 0 else ph // r)
    sw = max(1, int(slice_w) if slice_w and slice_w > 0 else stride_w)
    sh = max(1, int(slice_h) if slice_h and slice_h > 0 else stride_h)
    col = atlas_index % c
    row = atlas_index // c
    if col >= c or row >= r:
        return None
    x, y = col * stride_w, row * stride_h
    if x + sw > pw or y + sh > ph:
        return None
    return atlas.copy(QRect(x, y, sw, sh))


def reference_world_size(model) -> tuple[float, float]:
    """参考角色世界尺寸：取 player_anim，否则任一动画的推导尺寸；都取不到用 100×160。

    用途：画布上的 NPC 比例参考框，以及气泡锚预览取不到真实对象时的"至少量级不离谱"兜底。
    """
    pa = (getattr(model, "animations", {}) or {}).get("player_anim")
    if isinstance(pa, dict):
        r = resolved_anim_world_pair(
            pa, model, anim_manifest_url=anim_manifest_url_for_bundle("player_anim"))
        if r:
            return r
    for stem, data in sorted((getattr(model, "animations", {}) or {}).items()):
        if not isinstance(data, dict):
            continue
        r = resolved_anim_world_pair(
            data, model, anim_manifest_url=anim_manifest_url_for_bundle(stem))
        if r:
            return r
    return (100.0, 160.0)


# ---------------------------------------------------------------------------
# 内容框 / 头顶锚（运行时 SpriteEntity + Npc/Player 的镜像）
# ---------------------------------------------------------------------------

def _pos_num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    if not math.isfinite(f) or f <= 0:
        return None
    return f


def cell_pixel_size(anim_data: dict, atlas: QPixmap | None = None) -> tuple[float, float] | None:
    """格像素尺寸：cellWidth/cellHeight 优先，缺省由图集尺寸 ÷ 行列推。"""
    cw = _pos_num(anim_data.get("cellWidth"))
    ch = _pos_num(anim_data.get("cellHeight"))
    if cw and ch:
        return (cw, ch)
    if atlas is None or atlas.isNull():
        return None
    cols = max(1, int(anim_data.get("cols", 1) or 1))
    rows = max(1, int(anim_data.get("rows", 1) or 1))
    return (cw or atlas.width() / cols, ch or atlas.height() / rows)


def content_bottom_pad_px(anim_data: dict, cell_h: float) -> float | None:
    """反推格内内容底部留白：打包器每格上下各留同样的 pad，故 pad=(格高-最高帧内容高)/2。

    镜像运行时 ``computeContentBottomPadPx``。缺 atlasFrames / 数据非法 → None
    （调用方回落格子 quad 口径，与运行时一致）。
    """
    boxes = anim_data.get("atlasFrames")
    if not isinstance(boxes, list) or not boxes:
        return None
    if not (isinstance(cell_h, (int, float)) and math.isfinite(cell_h) and cell_h > 0):
        return None
    max_content = 0.0
    for box in boxes:
        if not isinstance(box, dict):
            continue
        h = _pos_num(box.get("contentHeight"))
        if h and h > max_content:
            max_content = h
    if max_content <= 0:
        return None
    return max(0.0, (cell_h - max_content) / 2.0)


def frame_slots_of_state(anim_data: dict, state: str) -> list[int]:
    """状态的图集槽位序列；状态不存在/非法返回空表。"""
    states = anim_data.get("states")
    sd = states.get(state) if isinstance(states, dict) else None
    frames = sd.get("frames") if isinstance(sd, dict) else None
    if not isinstance(frames, list):
        return []
    out: list[int] = []
    for f in frames:
        if isinstance(f, bool) or not isinstance(f, (int, float)):
            continue
        out.append(int(f))
    return out


def frame_content_box_px(anim_data: dict, slot: int) -> tuple[float, float] | None:
    """某槽位登记的内容包围盒（格像素）；无登记/非法 → None。"""
    boxes = anim_data.get("atlasFrames")
    if not isinstance(boxes, list) or not (0 <= slot < len(boxes)):
        return None
    box = boxes[slot]
    if not isinstance(box, dict):
        return None
    w = _pos_num(box.get("contentWidth"))
    h = _pos_num(box.get("contentHeight"))
    if w is None or h is None:
        return None
    return (w, h)


def frame_pixel_size(anim_data: dict, slot: int, cell_w: float, cell_h: float) -> tuple[float, float]:
    """当前帧被裁切出来的像素尺寸：atlasFrames[slot].width/height 优先，缺省用格尺寸。
    镜像运行时 ``getCurrentFramePixelSize``。"""
    boxes = anim_data.get("atlasFrames")
    if isinstance(boxes, list) and 0 <= slot < len(boxes) and isinstance(boxes[slot], dict):
        w = _pos_num(boxes[slot].get("width"))
        h = _pos_num(boxes[slot].get("height"))
        if w and h:
            return (w, h)
    return (cell_w, cell_h)


def content_box_local(
    anim_data: dict,
    slot: int,
    world_w: float,
    world_h: float,
    *,
    atlas: QPixmap | None = None,
    depth_scale: float = 1.0,
) -> tuple[float, float, float] | None:
    """当前帧内容框（世界单位，不含实例 scale）→ ``(width, height, bottom_gap)``。

    镜像 ``SpriteEntity.getContentBoxLocal``（跳跃视觉抬升是纯运行时态，编辑器恒 0）。
    无 atlasFrames 等数据缺失 → None，调用方回落格子 quad。
    """
    cell = cell_pixel_size(anim_data, atlas)
    if cell is None:
        return None
    cell_w, cell_h = cell
    pad = content_bottom_pad_px(anim_data, cell_h)
    if pad is None:
        return None
    box = frame_content_box_px(anim_data, slot)
    if box is None:
        return None
    frame_w, frame_h = frame_pixel_size(anim_data, slot, cell_w, cell_h)
    if not (frame_w > 0 and frame_h > 0):
        return None
    d = depth_scale if (isinstance(depth_scale, (int, float)) and math.isfinite(depth_scale) and depth_scale > 0) else 1.0
    scale_x = (world_w * d) / frame_w
    scale_y = (world_h * d) / frame_h
    return (box[0] * scale_x, box[1] * scale_y, pad * scale_y)


def authored_state_anchor(anim_data: dict, state: str) -> float | None:
    """状态授权的头顶锚比例（``states[*].bubbleAnchor``，格高归一化）；未授权/非法 → None。"""
    states = anim_data.get("states")
    sd = states.get(state) if isinstance(states, dict) else None
    return _pos_num(sd.get("bubbleAnchor")) if isinstance(sd, dict) else None


def auto_bubble_anchor_y(
    anim_data: dict,
    slot: int,
    world_w: float,
    world_h: float,
    *,
    state: str = "",
    atlas: QPixmap | None = None,
    inst_scale: float = 1.0,
    inst_rot_deg: float = 0.0,
    depth_scale: float = 1.0,
) -> float:
    """当前生效的头顶锚（实体局部 y，脚点 0、向上为负，已含 headGap）。

    镜像运行时解析链（``Npc/Player.getEmoteBubbleAnchorLocalY``）：
    图集授权锚 → 当前帧内容框 → 格子 quad 顶边。
    """
    s = inst_scale if (isinstance(inst_scale, (int, float)) and math.isfinite(inst_scale) and inst_scale > 0) else 1.0
    d = depth_scale if (isinstance(depth_scale, (int, float)) and math.isfinite(depth_scale) and depth_scale > 0) else 1.0
    rot = math.radians(inst_rot_deg or 0.0)

    authored = authored_state_anchor(anim_data, state) if state else None
    if authored is not None:
        # 授权锚是轴上一个点（不是框），按实例 transform 直接变换即可
        _, y = transform_local_vec(0.0, -authored * world_h * d, s, inst_rot_deg or 0.0)
        return y - HEAD_GAP

    box = content_box_local(anim_data, slot, world_w, world_h, atlas=atlas, depth_scale=d)
    if box is not None:
        cw, ch, gap = box
        return content_top_local_y_around_foot(
            max(cw * s, 1.0), max(ch * s, 1.0), gap * s, rot,
        ) - HEAD_GAP
    return quad_top_local_y_around_foot(
        max(world_w * d * s, 1.0), max(world_h * d * s, 1.0), rot,
    ) - HEAD_GAP
