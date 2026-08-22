"""导出与逐场景参数持久化。

- 变体图命名:`background_relight_<预设>.png`,与原图同目录
  (public/resources/runtime/scenes/<id>/)。带 `relight_` 前缀是为了
  一眼区分"本工具产物"与历史上手工放进去的各种 background_*.png。
- 覆盖已存在的变体前,先把旧文件备份到 out/<id>/backup/(素材管线规范红线:
  覆盖游戏在用文件前必须有备份与返修路径)。
- 一切就位走 tools/atomic_io.retry_transient(Windows 上 os.replace 不原子)。
- 逐场景参数存 out/<id>/params_<预设>.json,含完整参数(非补丁),重开即恢复。
"""
from __future__ import annotations

import io
import json
import os
import time
from pathlib import Path

import numpy as np
from PIL import Image

import sys
_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))
from tools.atomic_io import retry_transient        # noqa: E402

from . import geometry                              # noqa: E402
from .geometry import Scene                         # noqa: E402
from .relight import merge_params, relight          # noqa: E402


def _rel(p: Path) -> str:
    """仓库内路径给相对(可读),测试/异地路径退回绝对。"""
    try:
        return str(p.relative_to(_ROOT))
    except ValueError:
        return str(p)

VARIANT_PREFIX = 'background_relight_'


def variant_name(preset: str) -> str:
    return f'{VARIANT_PREFIX}{preset}.png'


def _atomic_write_bytes(dest: Path, data: bytes) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + '.tmp')
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, dest)


def _backup_existing(sid: str, dest: Path) -> Path | None:
    if not dest.exists():
        return None
    bdir = geometry.OUT / sid / 'backup'
    bdir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime('%Y%m%d-%H%M%S')
    bak = bdir / f'{dest.stem}.{stamp}{dest.suffix}'
    bak.write_bytes(dest.read_bytes())
    return bak


def save_params(sid: str, preset: str, params: dict) -> Path:
    full = merge_params(params)                     # 校验 + 补全
    f = geometry.OUT / sid / f'params_{preset}.json'
    _atomic_write_bytes(f, json.dumps(full, ensure_ascii=False, indent=1).encode('utf-8'))
    return f


def load_params(sid: str, preset: str) -> dict | None:
    f = geometry.OUT / sid / f'params_{preset}.json'
    if not f.exists():
        return None
    return json.loads(f.read_text(encoding='utf-8'))


def saved_presets(sid: str) -> list[str]:
    d = geometry.OUT / sid
    if not d.is_dir():
        return []
    return sorted(p.stem[len('params_'):] for p in d.glob('params_*.json'))


def render_png_bytes(scene: Scene, params: dict, width: int | None = None) -> bytes:
    arr = relight(scene, params, width=width)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format='PNG', optimize=(width is None))
    return buf.getvalue()


def export_variant(scene: Scene, preset: str, params: dict) -> dict:
    """全分辨率渲染 → 备份旧变体 → 原子就位 → 存参数。返回落点与接线提示。"""
    data = render_png_bytes(scene, params, width=None)
    dest = scene.rt_dir / variant_name(preset)
    bak = _backup_existing(scene.sid, dest)
    _atomic_write_bytes(dest, data)
    pf = save_params(scene.sid, preset, params)
    snippet = {
        'timeVariants': {
            preset: {'backgrounds': [{'image': variant_name(preset), 'x': 0, 'y': 0}]},
        },
    }
    return {
        'dest': _rel(dest),
        'bytes': len(data),
        'backup': _rel(bak) if bak else None,
        'params_file': _rel(pf),
        'snippet': snippet,
    }
