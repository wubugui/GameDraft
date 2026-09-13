"""纸钱粒子的贴图集(fx_paper_money/atlas.png + anim.json):程序化生成,可重跑、确定性。

四种纸,一格一种(粒子按自己的种子挑一格,不播放):
  0 方形白纸,印一枚朱红铜钱纹(外圆内方)+ 细边框 —— 与跑马梁原画路面上画的那几张同款;
  1 方形黄表纸,压了 3×3 的铜钱纹;
  2 圆形白纸钱(外圆内方,方孔镂空)—— 送葬撒的那种;
  3 圆形旧黄纸钱,带水渍。

纸是朗伯的:颜色就是反照率(白纸 ≈ 0.9),亮暗交给场景光(受光路径)或 tint(无光路径)。
边缘有细小的毛边(纸是剪 / 撕的,不是矢量切的);4× 超采样再缩,抗锯齿。

Run: sh scripts/py.sh tools/animation_pipeline/ambient_fx/paper_money_build.py
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parents[3] / 'public' / 'resources' / 'runtime' / 'animation' / 'fx_paper_money'
CELL = 64
SS = 4
WORLD = 16

#: 颜色压到原画的灰调里(阴天、湿、旧):纯白 / 正黄在这张画上读成"彩纸屑"
WHITE = np.array([226, 221, 207], np.float32)
YELLOW = np.array([204, 182, 124], np.float32)
OLD_YELLOW = np.array([194, 176, 136], np.float32)
CINNABAR = np.array([150, 62, 48], np.float32)
MUD = np.array([96, 82, 64], np.float32)


def _grid(n: int):
    c = (np.arange(n, dtype=np.float32) + 0.5) / n * 2 - 1
    return np.meshgrid(c, c)


def _noise(n: int, rng: np.random.Generator, scale: int) -> np.ndarray:
    """平滑噪声(低分辨率随机双线性放大),给纤维 / 毛边 / 水渍用。"""
    small = rng.random((scale, scale)).astype(np.float32)
    return np.asarray(Image.fromarray((small * 255).astype(np.uint8)).resize((n, n), Image.BICUBIC),
                      np.float32) / 255.0


def _coin(x: np.ndarray, y: np.ndarray, cx: float, cy: float, r: float, w: float, hole: float) -> np.ndarray:
    """铜钱纹线稿:外圆环 + 方孔框,返回 0..1 覆盖度。"""
    d = np.hypot(x - cx, y - cy)
    ring = np.clip(1 - np.abs(d - r) / w, 0, 1)
    sq = np.maximum(np.abs(x - cx), np.abs(y - cy))
    box = np.clip(1 - np.abs(sq - hole) / w, 0, 1)
    return np.maximum(ring, box)


def paper(kind: int, seed: int) -> np.ndarray:
    n = CELL * SS
    rng = np.random.default_rng(seed)
    x, y = _grid(n)
    fiber = _noise(n, rng, 48) * 0.5 + _noise(n, rng, 12) * 0.5
    edge = (_noise(n, rng, 40) - 0.5) * 0.035
    if kind in (0, 1):
        shape = np.maximum(np.abs(x), np.abs(y)) + edge
        alpha = np.clip((0.9 - shape) * n * 0.25, 0, 1)
    else:
        d = np.hypot(x, y) + edge
        hole = np.maximum(np.abs(x), np.abs(y))
        alpha = np.clip((0.9 - d) * n * 0.25, 0, 1) * np.clip((hole - 0.2) * n * 0.25, 0, 1)
    base = {0: WHITE, 1: YELLOW, 2: WHITE, 3: OLD_YELLOW}[kind]
    rgb = np.ones((n, n, 3), np.float32) * base
    rgb *= (0.94 + 0.06 * fiber)[..., None]
    if kind == 0:
        sq = np.maximum(np.abs(x), np.abs(y))
        border = np.clip(1 - np.abs(sq - 0.74) / 0.018, 0, 1) * 0.35
        rgb = rgb * (1 - border[..., None]) + CINNABAR * border[..., None] * 0.6
        ink = _coin(x, y, 0, 0, 0.36, 0.05, 0.12) * (0.75 + 0.25 * _noise(n, rng, 20))
        rgb = rgb * (1 - ink[..., None]) + CINNABAR * ink[..., None]
    elif kind == 1:
        ink = np.zeros((n, n), np.float32)
        for i in (-0.5, 0.0, 0.5):
            for j in (-0.5, 0.0, 0.5):
                ink = np.maximum(ink, _coin(x, y, i, j, 0.17, 0.03, 0.06))
        rgb *= (1 - 0.22 * ink)[..., None]
    elif kind == 3:
        stain = np.clip((_noise(n, rng, 6) - 0.55) * 4, 0, 1)
        rgb *= (1 - 0.18 * stain)[..., None]
    # 泥点:躺过地、被踩过(每张都有一点,程度随种子)
    mud = np.clip((_noise(n, rng, 9) - 0.62) * 5, 0, 1) * rng.uniform(0.15, 0.45)
    rgb = rgb * (1 - mud[..., None]) + MUD * mud[..., None]
    img = np.dstack([np.clip(rgb, 0, 255), alpha * 255]).astype(np.uint8)
    return np.asarray(Image.fromarray(img, 'RGBA').resize((CELL, CELL), Image.LANCZOS))


def main() -> None:
    cells = [paper(k, 20260912 + k) for k in range(4)]
    atlas = Image.new('RGBA', (CELL * len(cells), CELL), (0, 0, 0, 0))
    for i, c in enumerate(cells):
        atlas.paste(Image.fromarray(c, 'RGBA'), (i * CELL, 0))
    OUT.mkdir(parents=True, exist_ok=True)
    atlas.save(OUT / 'atlas.png', optimize=True)
    anim = {
        'spritesheet': 'atlas.png',
        'cols': len(cells),
        'rows': 1,
        'worldWidth': WORLD,
        'worldHeight': WORLD,
        # frameRate 写 1 不写 0:动画编辑器会把 0 规范成 1(打开即保存就改写文件);
        # 薄片渲染按粒子种子挑格、不播放,这个数对它不起作用
        'states': {
            'variants': {'frames': list(range(len(cells))), 'frameRate': 1, 'loop': False},
        },
    }
    (OUT / 'anim.json').write_text(json.dumps(anim, ensure_ascii=False, indent=2) + '\n', encoding='utf-8',
                                   newline='\n')
    print(f'→ {OUT.as_posix()}  {atlas.size[0]}×{atlas.size[1]}')


if __name__ == '__main__':
    main()
