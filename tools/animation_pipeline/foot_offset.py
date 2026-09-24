"""从图集像素**量出**每个动画状态的脚底偏移（`anim.json` 的 `states[*].footOffset`）。

## 这个数是什么、谁用它

运行时把每一格的格底中点当作角色踩地的那一点（接地点）：阴影、遮挡排序、透视缩放都按它算。
可有些图集的格底并不是脚——旧产线把一个角色的所有动作塞进同一种格子，格高按「往下伸得最远的
那一帧」定（跳跃的蹲起、躺下那几帧），于是站立、走、跑、蹲全部比格底高出一截，游戏里整个人
悬空 5–11 世界单位（2026-09-24 扫描）。

制作人定（2026-09-24）：**素材像素不动**，给每个动画的每个状态记一个偏移，运行时按它把画往下挪，
脚落回接地点（`SpriteEntity` 把它打进画面锚点；接地点本身不动）。

## 判据（几何，不是拟合）

一个状态的偏移 = 这个状态里**最贴地的那一帧**，其最低不透明行（alpha ≥ 128，与运行时
`footprintExtent.FOOTPRINT_ALPHA_THRESHOLD` 同一个口径）的下沿到帧底的距离 ÷ 帧高。

- 取最贴地的那一帧，不取每帧各自的：状态内所有帧一起挪，动作里的起伏（走路的颠、跳起的腾空）原样保留；
- 帧高 = 这一帧的帧框高（`atlasFrames[slot].height`，没登记就是格高），与运行时画面锚点同一个基准；
- 空帧（整格透明）不参与；整个状态都是空帧 ⇒ 量不出（None）。

## 哪些包不量

`fx_*`：特效与「烤入背景人物」叠层（茶馆 `fx_patron_*` 是对着原画逐像素对齐的），它们不站在地上，
挪了就和原画错位。其余一律是摆在地上的东西（角色、动物、占位立绘、道具）。

## 用法

    sh scripts/py.sh -m tools.animation_pipeline.foot_offset                        # 全部可量的包，只打印
    sh scripts/py.sh -m tools.animation_pipeline.foot_offset npc_popo_anim          # 指定包
    sh scripts/py.sh -m tools.animation_pipeline.foot_offset --write                # 写进各包 anim.json

`--write` 只动 `states[*].footOffset` 这一个键（量出 0 的状态删掉该键 = 缺省），其余键与键序原样，
落盘走编辑器同一个写出口（`tools.editor.file_io.write_json`）。编辑器动画面板的「按图测」用同一个函数。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Iterable, Optional, Sequence

import numpy as np
from PIL import Image

ANIM_ROOT = Path('public') / 'resources' / 'runtime' / 'animation'
#: 不透明判据（alpha 字节）。与运行时接触阴影找脚那一处同口径：半透明的发梢、烟雾边不算脚。
ALPHA_THRESHOLD = 128
#: 不站在地上的包（特效、对着原画对齐的叠层），不量、不写。
EXCLUDED_PREFIXES = ('fx_',)
#: 写盘保留的小数位（与编辑器写 bubbleAnchor 同一精度）。
ROUND_DIGITS = 4


def is_ground_bundle(bundle_id: str) -> bool:
    return not any(bundle_id.startswith(p) for p in EXCLUDED_PREFIXES)


def load_alpha(sheet_path: Path | str) -> np.ndarray:
    """图集的 alpha 通道（行 × 列，uint8）。"""
    return np.asarray(Image.open(sheet_path).convert('RGBA'))[:, :, 3]


def cell_stride(anim: dict, alpha: np.ndarray) -> tuple[float, float]:
    """单格步进像素（与运行时 `effectiveCellPixelSize` 同口径：显式 cellWidth/cellHeight 优先）。"""
    cols = max(1, int(anim.get('cols', 1)))
    rows = max(1, int(anim.get('rows', 1)))
    cw = anim.get('cellWidth')
    ch = anim.get('cellHeight')
    sw = float(cw) if isinstance(cw, (int, float)) and cw > 0 else alpha.shape[1] / cols
    sh = float(ch) if isinstance(ch, (int, float)) and ch > 0 else alpha.shape[0] / rows
    return sw, sh


def frame_rect(anim: dict, alpha: np.ndarray, slot: int) -> Optional[tuple[int, int, int, int]]:
    """槽位的帧框 (x, y, w, h)（与运行时 `loadFromDef` 切帧同口径）；越界 ⇒ None。"""
    cols = max(1, int(anim.get('cols', 1)))
    sw, sh = cell_stride(anim, alpha)
    w, h = sw, sh
    boxes = anim.get('atlasFrames')
    if isinstance(boxes, list) and 0 <= slot < len(boxes) and isinstance(boxes[slot], dict):
        bw, bh = boxes[slot].get('width'), boxes[slot].get('height')
        if isinstance(bw, (int, float)) and bw > 0:
            w = float(bw)
        if isinstance(bh, (int, float)) and bh > 0:
            h = float(bh)
    x = int(round((slot % cols) * sw))
    y = int(round((slot // cols) * sh))
    wi, hi = int(round(w)), int(round(h))
    if slot < 0 or x + wi > alpha.shape[1] or y + hi > alpha.shape[0] or wi <= 0 or hi <= 0:
        return None
    return x, y, wi, hi


def slot_bottom_margin(anim: dict, alpha: np.ndarray, slot: int) -> Optional[tuple[int, int]]:
    """``(帧底到最低不透明行下沿的像素, 帧高)``；空帧 / 越界 ⇒ None。"""
    r = frame_rect(anim, alpha, slot)
    if r is None:
        return None
    x, y, w, h = r
    cell = alpha[y:y + h, x:x + w]
    rows = np.flatnonzero((cell >= ALPHA_THRESHOLD).any(axis=1))
    if rows.size == 0:
        return None
    return h - 1 - int(rows[-1]), h


def state_foot_offset(anim: dict, alpha: np.ndarray, frames: Iterable[int]) -> Optional[float]:
    """状态的脚底偏移（帧高比例，未取整）：最贴地那一帧的留白。整个状态没有不透明像素 ⇒ None。"""
    best: Optional[float] = None
    for f in frames:
        if isinstance(f, bool) or not isinstance(f, (int, float)):
            continue
        m = slot_bottom_margin(anim, alpha, int(f))
        if m is None:
            continue
        frac = m[0] / m[1]
        best = frac if best is None else min(best, frac)
    return best


def measure_bundle(bundle_dir: Path) -> tuple[dict, dict[str, Optional[float]]]:
    """``(anim, {状态名: 偏移})``。"""
    anim = json.loads((bundle_dir / 'anim.json').read_text(encoding='utf-8'))
    alpha = load_alpha(bundle_dir / str(anim.get('spritesheet', 'atlas.png')))
    out: dict[str, Optional[float]] = {}
    for name, sd in (anim.get('states') or {}).items():
        frames = sd.get('frames') if isinstance(sd, dict) else None
        out[name] = state_foot_offset(anim, alpha, frames or [])
    return anim, out


def apply_offsets(anim: dict, offsets: dict[str, Optional[float]]) -> bool:
    """把量出来的偏移写进 anim（就地）；返回是否有变化。0 / 量不出 ⇒ 删键（缺省即 0）。"""
    changed = False
    for name, sd in (anim.get('states') or {}).items():
        if not isinstance(sd, dict):
            continue
        v = offsets.get(name)
        v = round(v, ROUND_DIGITS) if v else 0.0
        if v > 0:
            if sd.get('footOffset') != v:
                sd['footOffset'] = v
                changed = True
        elif 'footOffset' in sd:
            del sd['footOffset']
            changed = True
    return changed


def _bundles(root: Path, names: Sequence[str]) -> list[Path]:
    base = root / ANIM_ROOT
    if names:
        return [base / n for n in names]
    return [d for d in sorted(base.iterdir()) if (d / 'anim.json').is_file() and is_ground_bundle(d.name)]


def main(argv: Sequence[str]) -> int:
    root = Path(os.environ.get('GAMEDRAFT_ROOT', '.'))
    write = '--write' in argv
    names = [a for a in argv if not a.startswith('--')]
    from tools.editor.file_io import write_json

    n_written = 0
    for d in _bundles(root, names):
        if not is_ground_bundle(d.name):
            print(f'{d.name}: 跳过（fx_* 不站在地上）')
            continue
        anim, offs = measure_bundle(d)
        parts = [f'{name}=空' if v is None else f'{name}={v:.4f}' for name, v in offs.items()]
        wh = anim.get('worldHeight')
        idle = offs.get('idle') if 'idle' in offs else next(iter(offs.values()), None)
        wu = f'  站立≈{idle * float(wh):.1f} 世界单位' if idle and isinstance(wh, (int, float)) else ''
        line = f'{d.name}:{wu}  ' + '  '.join(parts)
        if write and apply_offsets(anim, offs):
            write_json(d / 'anim.json', anim)
            n_written += 1
            line += '   → 已写入'
        print(line)
    if write:
        print(f'写入 {n_written} 个包的 anim.json')
    else:
        print('只打印；加 --write 才落盘')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
