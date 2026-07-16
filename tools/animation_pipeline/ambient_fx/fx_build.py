"""Build game-ready sprite atlases (atlas.png + anim.json) for teahouse ambient FX
from LibTV-generated stills. Luminance->alpha keying (assets are drawn on pure black),
then loop-safe procedural motion (sinusoidal -> seamless).

Run: .tools/venv/bin/python fx_build.py steam|glow
"""
from __future__ import annotations
import sys, os, math, json
import numpy as np
from PIL import Image

OUT_ANIM_DIR = "/Users/dannyteng/AIWork/GameDraft/public/resources/runtime/animation"
HERE = os.path.dirname(os.path.abspath(__file__))


def lum_to_rgba(img: Image.Image, warm=(255, 248, 236), gain=1.18, floor=10, gamma=0.92, warp=0.5):
    """Black-bg image -> RGBA where alpha=luminance. RGB nudged toward a warm white."""
    arr = np.asarray(img.convert('RGB')).astype(np.float32)
    lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
    a = np.clip((lum / 255.0) ** gamma * 255.0 * gain, 0, 255)
    a[a < floor] = 0
    warm_arr = np.array(warm, np.float32)
    rgb = arr * (1.0 - warp) + warm_arr * warp
    return np.dstack([rgb, a]).astype(np.uint8)


def _pack(cells, out_id, world_w, world_h, fps, cols=None):
    n = len(cells)
    if cols is None:
        cols = n
    rows = math.ceil(n / cols)
    cellH, cellW = cells[0].shape[0], cells[0].shape[1]
    atlas = Image.new('RGBA', (cols * cellW, rows * cellH), (0, 0, 0, 0))
    for i, c in enumerate(cells):
        atlas.paste(Image.fromarray(c, 'RGBA'), ((i % cols) * cellW, (i // cols) * cellH))
    outdir = os.path.join(OUT_ANIM_DIR, out_id)
    os.makedirs(outdir, exist_ok=True)
    atlas.save(os.path.join(outdir, 'atlas.png'))
    anim = {
        "spritesheet": "atlas.png",
        "cols": cols,
        "rows": rows,
        "worldWidth": world_w,
        "worldHeight": world_h,
        "states": {"idle": {"frames": list(range(n)), "frameRate": fps, "loop": True}},
    }
    with open(os.path.join(outdir, 'anim.json'), 'w', encoding='utf-8') as f:
        json.dump(anim, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f"[{out_id}] atlas {atlas.size} cells {n} ({cols}x{rows}) cell={cellW}x{cellH} -> {outdir}")


def build_steam(src=os.path.join(HERE, 'steam_v1.png'), out_id='fx_teapot_steam',
                frames=10, cell_h=340, sway_px=8, wavelength=150,
                world_w=30, world_h=58, fps=12, alpha_scale=0.72):
    img = Image.open(src)
    scale = cell_h / img.height
    img = img.resize((max(1, int(img.width * scale)), cell_h), Image.LANCZOS)
    base = lum_to_rgba(img)
    H, W, _ = base.shape
    pad = sway_px + 4
    canvasW = W + 2 * pad
    cells = []
    for f in range(frames):
        phase = 2 * math.pi * f / frames
        cell = np.zeros((H, canvasW, 4), np.uint8)
        for y in range(H):
            frac = 1.0 - (y / H)          # 0 at base(bottom), 1 at top
            amp = sway_px * frac          # top sways most, base pinned
            dx = int(round(amp * math.sin(2 * math.pi * y / wavelength + phase)))
            x0 = pad + dx
            cell[y, x0:x0 + W, :] = base[y]
        # gentle alpha breathing (seamless) + overall softening
        breathe = 0.9 + 0.1 * math.sin(phase)
        cell[..., 3] = np.clip(cell[..., 3].astype(np.float32) * alpha_scale * breathe, 0, 255).astype(np.uint8)
        cells.append(cell)
    _pack(cells, out_id, world_w, world_h, fps, cols=5)


def build_glow(src=os.path.join(HERE, 'glow_v1.png'), out_id='fx_lantern_glow',
               frames=8, cell=220, world_w=44, world_h=44, fps=8, alpha_scale=0.5):
    img = Image.open(src).convert('RGB')
    # center-crop square then resize
    w, h = img.size
    s = min(w, h)
    img = img.crop(((w - s) // 2, (h - s) // 2, (w + s) // 2, (h + s) // 2)).resize((cell, cell), Image.LANCZOS)
    base = lum_to_rgba(img, warm=(255, 196, 120), gain=1.0, floor=6, gamma=1.0, warp=0.35)
    cells = []
    for f in range(frames):
        phase = 2 * math.pi * f / frames
        flick = 0.82 + 0.18 * (0.6 * math.sin(phase) + 0.4 * math.sin(2.7 * phase))
        c = base.copy()
        c[..., 3] = np.clip(c[..., 3].astype(np.float32) * alpha_scale * flick, 0, 255).astype(np.uint8)
        cells.append(c)
    _pack(cells, out_id, world_w, world_h, fps, cols=frames)


def build_curtain(src=os.path.join(HERE, 'curtain_v1.png'), out_id='fx_door_curtain',
                  frames=12, cell_h=440, sway_px=9, world_h=120, fps=9, alpha_scale=1.0,
                  darken=0.58, desat=0.2):
    img = Image.open(src).convert('RGB')
    scale = cell_h / img.height
    img = img.resize((round(img.width * scale), cell_h), Image.LANCZOS)
    import sys as _sys
    if '/Users/dannyteng/AIWork/GameDraft' not in _sys.path:
        _sys.path.insert(0, '/Users/dannyteng/AIWork/GameDraft')
    from tools.animation_pipeline.matting import matte_rgba
    base = matte_rgba(np.asarray(img).astype(np.uint8), 'fusion').copy()
    # despill residual magenta/red cast (frayed edges), desaturate + darken to match the dim scene
    rgb = base[..., :3].astype(np.float32)
    R, G, B = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    spill = (np.minimum(R, B) - G) > 3.0
    R = np.where(spill, np.minimum(R, G + 4.0), R)
    B = np.where(spill, np.minimum(B, G + 4.0), B)
    rgb = np.dstack([R, G, B])
    grey = rgb.mean(axis=2, keepdims=True)
    rgb = (rgb * (1.0 - desat) + grey * desat) * darken
    base = np.dstack([np.clip(rgb, 0, 255), base[..., 3]]).astype(np.uint8)
    if alpha_scale != 1.0:
        base[..., 3] = np.clip(base[..., 3].astype(np.float32) * alpha_scale, 0, 255).astype(np.uint8)
    alpha = base[..., 3].astype(np.float32)
    # crop to cloth bounding box
    ys, xs = np.where(alpha > 40)
    if len(xs):
        x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
        base = base[y0:y1 + 1, x0:x1 + 1]
    H, W, _ = base.shape
    pad = sway_px + 3
    canvasW = W + 2 * pad
    cells = []
    for f in range(frames):
        phase = 2 * math.pi * f / frames
        lean = sway_px * math.sin(phase)          # pendulum sway; top pinned, bottom leans
        cell = np.zeros((H, canvasW, 4), np.uint8)
        for y in range(H):
            frac = y / max(1, H - 1)               # 0 top -> 1 bottom
            dx = int(round(lean * frac))
            x0 = pad + dx
            cell[y, x0:x0 + W, :] = base[y]
        cells.append(cell)
    world_w = round(world_h * canvasW / H)
    cols = frames
    while cols * canvasW > 2048 or (math.ceil(frames / cols)) * H > 2048:
        cols -= 1
    _pack(cells, out_id, world_w, world_h, fps, cols=max(1, cols))


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'steam'
    if which == 'steam':
        build_steam()
    elif which == 'glow':
        build_glow()
    elif which == 'curtain':
        build_curtain()
    else:
        print('usage: fx_build.py steam|glow|curtain')
