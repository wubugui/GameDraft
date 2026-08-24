"""产物落盘:原子写 + meta.json + PAYLOAD_VERSION(方案 §4)。

原子写走全仓唯一实现 `tools/atomic_io.retry_transient`(机制卡
atomic-write-windows:「写 .tmp 再 os.replace 就位」在 Windows 上是概率性
失败的;就位类调用必须退避重试,且全仓只有这一份实现,不许复制)。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:                       # 允许 python -m tools.lightbake
    sys.path.insert(0, str(_ROOT))

from tools.atomic_io import retry_transient          # noqa: E402 — 全仓唯一原子写实现

from .const import PAYLOAD_VERSION                   # noqa: E402
from .encode import encode_moments, encode_unit, png_bytes  # noqa: E402


def atomic_bytes(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.tmp')
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, dest)


def build_products(ctx: dict) -> dict[str, bytes]:
    """ctx(pipeline 的结果)→ {文件名: 字节}。§4.1 的清单,一个不多一个不少。

    ⚠ 没有 base.png:base 不落盘,运行时由 `to_hdr(原画)/E_q` 现算(§5.7)。
    """
    e8 = ctx['e8']                                   # (h,w,3) u8 log2
    normal = ctx['normal']                           # (h,w,3) f32 全值域世界法线
    a0f, a1f = ctx['moments_smooth']                 # 平滑后的遮蔽矩
    ao = ctx['ao']                                   # (h,w) f32 [0,1]
    vol = ctx['volume']
    nrm8 = np.round(np.clip(normal * 0.5 + 0.5, 0, 1) * 255).astype(np.uint8)
    return {
        'irradiance.png': png_bytes(e8, 'RGB'),
        'normal.png': png_bytes(nrm8, 'RGB'),
        'sky_moments.png': png_bytes(encode_moments(a0f, a1f), 'RGBA'),
        'ao.png': png_bytes(encode_unit(ao), 'L'),
        'char_volume.bin': vol['packed'].tobytes(),
    }


def build_meta(ctx: dict) -> dict:
    """§4.4 的字段,集中在这,别散在各节猜。"""
    inp = ctx['inp']
    vol = ctx['volume']
    nw, nh = inp.native
    w, h = inp.work
    return {
        'version': PAYLOAD_VERSION,
        'work': {'w': w, 'h': h},
        'native': {'w': nw, 'h': nh},
        'cal': {'ppu': float(inp.ppu), 'cx': float(inp.cx), 'cy': float(inp.cy)},
        'M': [[float(v) for v in row] for row in inp.R],
        # 刻度链:运行时靠 scene_per_wu 把作者面的 wu 折进 q 空间
        'scale': {'char_wu': float(inp.char_wu),
                  'scene_per_wu': float(inp.scene_per_wu),
                  'band': float(inp.band)},
        'encoding': {
            'irradiance': {'file': 'irradiance.png',
                           'codec': 'u8 log2; decode: scale * 2^((px/255-0.5)*span)',
                           'scale': ctx['e_scale'], 'log_span': ctx['e_span']},
            'sky_moments': {'file': 'sky_moments.png',
                            'codec': 'rgba8 fixed; R=2*a0, GBA=a1+0.5; '
                                     'a0 in [0,1/2], a1 comp in [-1/2,1/2]',
                            'derived': 'V(N)=clamp((a0+a1.N)/cap0(N),0,1); '
                                       'Bdir=normalize(a1); '
                                       'V_dir(w)=clamp(a+b.w,0,1), a=8a0-6a1y, '
                                       'by=12a1y-12a0, bx=3a1x, bz=3a1z'},
            'normal': {'file': 'normal.png',
                       'codec': 'rgb8 linear; n = tex*2-1, world full-range'},
            'ao': {'file': 'ao.png', 'codec': 'u8 linear',
                   'range_q': ctx['ao_range']},
            'base': 'NOT STORED — runtime computes to_hdr(painting)/E_q at load; '
                    'gi=1 display is byte-identical to painting (§5.7)',
        },
        'gather': {'gain': ctx['gain'], 'spp': ctx['spp'],
                   'seed': ctx['seed'], 'moment_spp': ctx['moment_spp'],
                   'ao_spp': ctx['ao_spp'], 'hdr_max': ctx['hdr_max'],
                   # NEE+MIS(无偏)与 clamp(有偏)的采样配置 —— 回溯 firefly
                   # 口径必看(§5.4 采样扩展)
                   'nee': ctx['bake_params']['nee'],
                   'nee_emitters': ctx['bake_params']['nee_emitters'],
                   'clamp_indirect': ctx['bake_params']['clamp_indirect'],
                   'denoise': ctx['bake_params']['denoise']},
        'haze': ctx['haze'],
        'sun': ctx['sun'],
        'volume': {
            'file': 'char_volume.bin',
            'format': 'u8 RGBA, C order (channel, x, y, z, rgba)',
            'channels': vol['channels'],
            'encoding': {
                'sky_moments': 'R=2*a0, GBA=a1+0.5 (same as sky_moments.png)',
                'ao_moments': 'R=a0 (full-sphere M0/4pi in [0,1]), GBA=a1+0.5; '
                              'AO(N)=a0+a1.N',
                'gi': ('DISABLED — channels 2..4 are placeholder zero bytes '
                       '(R=0, GBA=128); runtime MUST skip them when no_gi'
                       if vol['no_gi'] else
                       'R=u8 log2 of a0 (gi_scale/gi_log_span); '
                       'GBA=a1/(4*a0)+0.5 => a1=(GBA*2-1)*2*a0; E(N)=a0+a1.N'),
            },
            **vol['grid'], **vol['bounds'],
            'index_mapping': 'i = clamp((p-lo)/(hi-lo), 0, 1) * (n-1); '
                             'trilinear on nodes(linspace 端点节点制,'
                             '格距 = span/(n-1),不是 span/n)',
            'gi_scale': vol['gi_scale'], 'gi_log_span': vol['gi_span'],
            'spp': vol['spp'], 'moment_spp': vol['moment_spp'],
            'no_gi': vol['no_gi'],
            'validity_coverage': vol['validity_coverage'],
            'residual_invalid': vol['residual_invalid'],
            'dilation_iters': vol['dilation_iters'],
            'selfcheck': vol['selfcheck'],
        },
        'exposure': ctx['exposure'],
        'bake_sky': ctx['sky_spec'],
        # 分段墙钟(§13 P1「收工记基准」/ P3「记 AO 墙钟」的归档载体)
        'timing': ctx.get('timing', {}),
    }


def write_payload(out_dir: Path, products: dict[str, bytes], meta: dict) -> None:
    """落盘序刻意如此(审查纠正):

    1. 先删旧 meta.json —— 单文件原子、整体不原子,中途失败只能留下
       「无 meta」的目录(运行时判不启用,fail-safe),**绝不能**留下
       「旧 meta + 新图」的撕裂态(版本判定会收下、再用旧 scale 解新图);
    2. 写全部图/бин;
    3. 最后写新 meta(meta 在 ⇔ 与图同代);
    4. 白名单清掉上一代残留(v5 的 base.png/vis_linear.png/sky_occlusion.png/
       sky_sh_grid.bin 等)—— 不清的话 v6 目录是两代混装,「省 ~5MB」在盘上
       不成立,diff 也一直报幽灵文件。
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    old_meta = out_dir / 'meta.json'
    if old_meta.exists():
        retry_transient(os.remove, old_meta)
    for name, data in products.items():
        atomic_bytes(out_dir / name, data)
    atomic_bytes(out_dir / 'meta.json',
                 (json.dumps(meta, ensure_ascii=False, indent=1) + '\n'
                  ).encode('utf-8'))
    keep = set(products) | {'meta.json'}
    for p in out_dir.iterdir():
        if p.is_file() and p.name not in keep and not p.name.endswith('.tmp'):
            retry_transient(os.remove, p)
        elif p.is_file() and p.name.endswith('.tmp'):
            retry_transient(os.remove, p)
