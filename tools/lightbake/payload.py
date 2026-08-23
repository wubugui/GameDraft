"""原子写 + `meta.json` 装配 + `PAYLOAD_VERSION`。

⚠ 载荷版本 **v6**。三处常量必须同时改、且被测试钉死（历史上一天内漂过两次）：

| 位置 | 常量 |
|---|---|
| `tools/lightbake/payload.py` | `PAYLOAD_VERSION` |
| `src/core/SceneLightingSystem.ts` | `LIGHTING3_VERSION` |
| `tools/editor/validator.py` | `_LIGHTING3_VERSION` |

本工具只负责产出 `PAYLOAD_VERSION = 6` 的载荷；运行时接线（P6）由接手方在三处
同步改。`tests/test_payload_version.py` 里只钉死本文件，另两处留给接线时补。
"""
from __future__ import annotations

import io
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image

from . import const

#: 载荷代次。改产物布局必须 +1（见模块 docstring 的三处同步）。
PAYLOAD_VERSION = 6


def _png_bytes(arr: np.ndarray, mode: str) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr, mode=mode).save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def _atomic_bytes(dest: Path, data: bytes) -> None:
    """原子写：写临时文件再 replace。Windows 瞬时句柄冲突退避重试。"""
    from tools.atomic_io import retry_transient
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.tmp')
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, dest)


def assemble_meta(bundle: dict) -> dict:
    """把一次烘焙的 bundle 装配成 `meta.json`。"""
    b = bundle
    inp = b['inp']
    nw, nh = inp.native
    w, h = inp.work
    sh = b['volume']
    return {
        'version': PAYLOAD_VERSION,
        'background_sha1': None,
        'work': {'w': w, 'h': h},
        'native': {'w': nw, 'h': nh},
        'cal': {'ppu': float(inp.ppu), 'cx': float(inp.cx), 'cy': float(inp.cy)},
        'M': [[float(v) for v in row] for row in inp.R],
        'scale': {'char_wu': inp.char_wu, 'scene_per_wu': inp.scene_per_wu},
        'vis_linear': {
            'file': 'vis_linear.png',
            'encoding': 'rgba8; rgb = b/(2*b_max)+0.5, a = a0. V(w) = clamp(a0 + b.w, 0, 1)',
            'b_max': b['vb_max'],
            'note': '可见度对方向的线性重建（同一批光线做的加权最小二乘）。',
        },
        'direct_light': b['sun'],
        'sky_occlusion': {
            'file': 'sky_occlusion.png',
            'encoding': 'rgba8; rgb = bent_dir*0.5+0.5, a = cosine-weighted visibility',
            'spp': const.GATHER_SPP,
            'note': '与 irradiance 同一趟 MC 出（上半球逃逸那一半）；'
                    '天空不在载荷里，是运行时的全局 SH（src/rendering/lighting/skySh.ts）',
        },
        'march': {
            'step_px': const.GATHER_STEP_PX,
            'bias': const.MARCH_BIAS, 'bias_growth': const.MARCH_BIAS_GROWTH,
            'thickness': const.MARCH_THICKNESS,
            'spp': const.GATHER_SPP, 'seed': const.GATHER_SEED,
            'note': '无射程参数：终止条件 = 命中/出画/前穿，见方案 §5.4',
        },
        'ao': {'file': 'ao.png', 'encoding': 'r8',
               'min': float(b['ao'].min()), 'max': float(b['ao'].max()),
               'mean': float(b['ao'].mean())},
        'irradiance': {
            'file': 'irradiance.png',
            'note': '烘焙 GI —— 正式载荷。gi=1 时 base·E ≡ 原画（到量化）',
            'method': 'pseudo-world final gather; L_in = HDR(painting) at hit, sky on escape',
            'encoding': 'u8 log2; decode: scale * 2^((px/255 - 0.5) * log_span)',
            'scale': b['e_scale'], 'log_span': b['e_span'],
            'w': w, 'h': h,
            'hdr_max': const.HDR_MAX,
            'gather_gain': b['gather_gain'],
            'sky_source': dict(b['sky_spec']),
            'spp': const.GATHER_SPP,
            'min': float(b['e_lum'].min()), 'max': float(b['e_lum'].max()),
            'mean': float(b['e_lum'].mean()),
        },
        'runtime_fit': b['rt_fit'],
        'base': {
            'file': 'base.png',
            'encoding': 'u8 log2, byte 0 means exactly 0; '
                        'decode: px>0 ? scale * 2^((px/255 - 0.5) * log_span) : 0',
            'log_span': b['base_span'],
            'w': nw, 'h': nh,
            'note': 'I_原画 / E —— 比例式的中间因子，不是 albedo；'
                    'native 分辨率，它替代 background.png 进渲染路径',
            'scale': b['base_scale'],
            'median': float(np.median(b['base'])),
            'p99_9': float(np.percentile(b['base'], 99.9)),
            'chroma': [float(v) for v in (b['base'].reshape(-1, 3).mean(0)
                                          / max(float(b['base'].mean()), 1e-9))],
        },
        'haze': {**b['haze'], 'keep': const.HAZE_KEEP},
        'roundtrip': b['roundtrip'],
        'char_grid': {
            'file': 'char_volume.bin',
            'format': 'u8 RGBA, C order (channel, x, y, z, rgba)',
            'encoding': ('T_k(N) = a0_k + a1_k . N (clamped-cosine L1). '
                         'sky/ao channels: R=a0, GBA=a1*0.5+0.5. '
                         'gi channels: R=u8 log2 of a0 (see gi_scale/log_span), '
                         'GBA=a1/(4*a0)+0.5 => a1=(GBA*2-1)*2*a0'),
            'channels': (['sky_occlusion_l1', 'local_ao']
                         if b['no_gi'] else
                         ['sky_occlusion_l1', 'local_ao', 'gi_r', 'gi_g', 'gi_b']),
            **sh['grid'], **sh['bounds'],
            'gi_scale': sh['gi_scale'], 'gi_log_span': sh['gi_span'],
            'char_wu': inp.char_wu, 'band': inp.band,
            'validity_coverage': sh['validity_coverage'],
            'dilation_iters': sh['dilation_iters'],
            'selfcheck': sh['selfcheck'],
        },
    }


def write_payload(bundle: dict, out_dir: Path) -> Path:
    """把 bundle 的全部产物原子写进 `out_dir`（lighting3/）。返回 out_dir。"""
    b = bundle
    inp = b['inp']
    meta = assemble_meta(b)

    _atomic_bytes(out_dir / 'base.png', _png_bytes(b['base8'], 'RGB'))
    occ8 = np.empty(b['bent'].shape[:2] + (4,), np.uint8)
    occ8[..., :3] = np.round(np.clip(b['bent'] * 0.5 + 0.5, 0, 1) * 255.0)
    occ8[..., 3] = np.round(np.clip(b['vis'], 0, 1) * 255.0)
    _atomic_bytes(out_dir / 'sky_occlusion.png', _png_bytes(occ8, 'RGBA'))
    vb_max = b['vb_max']
    vf8 = np.empty(b['vfit'].shape[:2] + (4,), np.uint8)
    vf8[..., :3] = np.round(np.clip(b['vfit'][..., 1:] / (2.0 * vb_max) + 0.5, 0, 1) * 255.0)
    vf8[..., 3] = np.round(np.clip(b['vfit'][..., 0], 0, 1) * 255.0)
    _atomic_bytes(out_dir / 'vis_linear.png', _png_bytes(vf8, 'RGBA'))
    _atomic_bytes(out_dir / 'ao.png',
                  _png_bytes(np.round(np.clip(b['ao'], 0, 1) * 255).astype(np.uint8), 'L'))
    _atomic_bytes(out_dir / 'irradiance.png', _png_bytes(b['e8'], 'RGB'))
    nrm8 = np.round(np.clip(inp.normal * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8)
    _atomic_bytes(out_dir / 'normal.png', _png_bytes(nrm8, 'RGB'))
    _atomic_bytes(out_dir / 'char_volume.bin', b['volume']['packed'].tobytes())
    _atomic_bytes(out_dir / 'meta.json',
                  (json.dumps(meta, ensure_ascii=False, indent=1) + '\n').encode('utf-8'))
    return out_dir


def load_meta(out_dir: Path) -> dict:
    return json.loads((out_dir / 'meta.json').read_text(encoding='utf-8'))
