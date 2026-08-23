# -*- coding: utf-8 -*-
"""烘焙产物的 `meta.json` 必须与运行时的 TS 接口逐键对上。

## 为什么要有这条

同一个坑踩过两次，两次都是 `tsc` **全绿**而真机出事：

1. `scale` 段：TS 接口声明了 `scale: {char_wu, scene_per_wu}`，烘焙器忘了写。
   `tsc` 检查的是"读它的代码写得对不对"，管不着"数据里有没有"。
   真机装载时 `Cannot read properties of undefined (reading 'scene_per_wu')`。
2. `grid` / `band` / `depth_range`：声明为必填，烘焙器**从来没写过**，
   也没有任何消费端读 —— 于是它们静静躺了很久，纯误导后来者。

> **类型声明不是数据契约。** TS 那侧只描述"我打算怎么读"，Python 这侧才决定
> "实际写了什么"。两边靠人对齐必然漂，所以拿真实产物机械地对一遍。

放在 Python 侧而不是 vitest：`src/` 的 tsconfig 不含 node 类型，读不了文件；
而这条检查的对象本来就是**烘焙器的输出**。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
_TS = _ROOT / 'src' / 'core' / 'SceneLightingSystem.ts'
_SCENES = _ROOT / 'public' / 'resources' / 'runtime' / 'scenes'


def _declared_keys() -> tuple[list[str], set[str]]:
    """从 `LightingGeometryMeta` 抠出顶层键；返回 (必填, 全部声明)。"""
    src = _TS.read_text(encoding='utf-8')
    i = src.index('interface LightingGeometryMeta')
    body = src[i:src.index('\n}\n', i)]
    depth = 0
    required: list[str] = []
    declared: set[str] = set()
    for raw in body.split('\n'):
        line = raw.strip()
        m = re.match(r'^(\w+)\??:', line)
        if depth == 1 and m:
            declared.add(m.group(1))
            if '?:' not in line:
                required.append(m.group(1))
        depth += line.count('{') - line.count('}')
    return required, declared


def _current_version() -> int:
    """当前载荷代次，直接从烘焙器读 —— 不在测试里再抄一份数字。"""
    src = (_ROOT / 'tools' / 'scene_relight' / 'bake_gbuffer.py').read_text(encoding='utf-8')
    return int(re.search(r'^PAYLOAD_VERSION = (\d+)', src, re.M).group(1))


def _metas() -> list[Path]:
    """只验**当前代次**的载荷。

    ⚠ 代次不同的载荷运行时本来就整包忽略（`SceneLightingSystem` 那道版本闸），
      拿它来验接口只会在"改了格式、还没重烘完"的窗口里刷一屏假红。
      真正防漏烘的是 validator 那条（缺载荷/代次不符要报出来），不是这里。
    """
    if not _SCENES.exists():
        return []
    cur = _current_version()
    out = []
    for p in sorted(_SCENES.glob('*/lighting3/meta.json')):
        m = json.loads(p.read_text(encoding='utf-8'))
        if 'irradiance' in m and int(m.get('version', -1)) == cur:
            out.append(p)
    return out


def test_接口至少认出一批顶层键():
    required, declared = _declared_keys()
    # 解析崩了会让下面两条静默变成空跑 —— 先证明解析确实抠出了东西。
    assert len(required) > 8, f'只解析出 {required}，多半是接口结构变了'
    assert 'version' in declared and 'char_grid' in declared


@pytest.mark.parametrize('meta_path', _metas(), ids=lambda p: p.parents[1].name)
def test_必填键在真实产物里都在(meta_path: Path):
    required, _ = _declared_keys()
    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    missing = [k for k in required if k not in meta]
    assert not missing, (
        f'{meta_path.parents[1].name}: TS 接口把 {missing} 声明成必填，'
        f'但烘焙器没写。tsc 不会报 —— 只有真机装载时才炸')


@pytest.mark.parametrize('meta_path', _metas(), ids=lambda p: p.parents[1].name)
def test_产物里没有接口不认识的顶层键(meta_path: Path):
    _, declared = _declared_keys()
    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    extra = [k for k in meta if k not in declared]
    assert not extra, (
        f'{meta_path.parents[1].name}: 烘焙器写了 {extra}，TS 接口没声明。'
        f'不是错误但是**无名夹带** —— 读代码的人无从知道它是什么、能不能删')


@pytest.mark.parametrize('meta_path', _metas(), ids=lambda p: p.parents[1].name)
def test_解码必需的编码参数一个都不能少(meta_path: Path):
    """两份 HDR 载荷各有各的编码，参数缺一个画面就整体歪掉且不报错。"""
    meta = json.loads(meta_path.read_text(encoding='utf-8'))
    assert 'scale' in meta['irradiance'] and 'log_span' in meta['irradiance']
    assert 'scale' in meta['base']
    assert 'gi_scale' in meta['char_grid'] and 'gi_log_span' in meta['char_grid']
    # 2026-08-23 起载荷里没有自发光图了（制作人：「光都是单独打」）。
    assert 'emissive' not in meta
    assert not (meta_path.parent / 'emissive.png').exists()
    # 逃逸辐射是烘焙期输入，记在 meta 里备查（运行时不读）。
    assert 'sky_source' in meta['irradiance']
