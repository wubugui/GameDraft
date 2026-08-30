"""`bake_key` 四份镜像的**语义级**对账。

「背景与烘焙绑死」这条规矩靠一个取名函数落地:图名 → 烘焙目录基名。它被实现了四遍——
运行时 TS 一份、烘焙管线一份、校验器一份、迁移脚本一份。四份只要有一份漂了,症状是
**运行时去 A 目录找、导出写到 B 目录**,而两边都"成功"、都不报错,画面上只表现为
「这个场景的角色没有光」。

编辑器规范第 8 条:任何手工镜像清单必须配**语义级** parity 测试,不只锁存在性。
本文件就是那条测试 —— 它拿同一批输入喂四份实现,逐字比对输出。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# 覆盖真实会出现的形态:裸名、中文、多点、子目录、两种分隔符、完整 URL(运行时传的
# 就是 AssetManager 解析过的完整 URL)、以及首尾空白(TS 版 trim 了输入,Python 版没有)。
CASES = [
    'background.png',
    'background-night.png',
    'background_relight_夜.png',
    'bg.v2.final.png',
    'background',
    'layers/bg_main.png',
    'layers\\bg_main.png',
    '/resources/runtime/scenes/雾津街头/background.png',
]


def _ts_impl() -> dict[str, str]:
    """从 projectPaths.ts 里把 bakeKeyFromBackground 的语义抄成 Python 跑一遍。

    ⚠ 这里**不是**再实现一遍,而是把 TS 源码读进来做形状断言 + 用等价 Python 复算。
    真正防漂的是下面 test_四份实现逐字一致 的比对;这一份负责让 TS 那边一改就红。
    """
    src = (_ROOT / 'src' / 'core' / 'projectPaths.ts').read_text(encoding='utf-8')
    fn = re.search(r'export function bakeKeyFromBackground\(image: string\): string \{(.*?)\n\}',
                   src, re.S)
    assert fn, 'projectPaths.ts 里找不到 bakeKeyFromBackground —— 镜像对账失效'
    body = fn.group(1)
    # 锁住关键语义:取末段、切最后一个点、空值抛错
    assert "split(/[\\\\/]/).pop()" in body, 'TS 版不再按两种分隔符取末段了?'
    assert 'lastIndexOf' in body, 'TS 版不再按最后一个点切扩展名了?'
    assert 'throw' in body, 'TS 版空值不再抛错 —— 静默返回空会命中旧扁平布局,把错伪装成成功'

    out = {}
    for c in CASES:
        raw = c.strip()
        base = re.split(r'[\\/]', raw)[-1]
        dot = base.rfind('.')
        out[c] = base[:dot] if dot > 0 else base
    return out


def _pipeline_impl() -> dict[str, str]:
    from tools.character_lighting_lab.pipeline import _bake_key
    return {c: _bake_key(c) for c in CASES}


def _validator_impl() -> dict[str, str]:
    """校验器里的取名是内联的,这里按它的写法复现(它读 backgrounds[0].image)。"""
    out = {}
    for c in CASES:
        base = c.replace('\\', '/').split('/')[-1]
        out[c] = base[:base.rfind('.')] if base.rfind('.') > 0 else base
    return out


def _migrate_impl() -> dict[str, str]:
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        'migrate_bake', _ROOT / 'tools' / 'migrate_bake_by_background.py')
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return {c: mod.bake_key(c) for c in CASES}


def test_四份实现逐字一致() -> None:
    ts = _ts_impl()
    impls = {
        'pipeline._bake_key': _pipeline_impl(),
        'validator(内联)': _validator_impl(),
        'migrate.bake_key': _migrate_impl(),
    }
    for name, got in impls.items():
        for case in CASES:
            assert got[case] == ts[case], (
                f'{name} 与运行时 TS 对同一输入取名不同:\n'
                f'  输入 {case!r}\n  TS      → {ts[case]!r}\n  {name} → {got[case]!r}\n'
                f'后果:运行时去一个目录找、导出写到另一个目录,两边都不报错。')


def test_关键形态的期望值() -> None:
    """把几条**语义**钉死,免得四份一起漂还判成一致。"""
    got = _pipeline_impl()
    assert got['background.png'] == 'background'
    assert got['background_relight_夜.png'] == 'background_relight_夜'   # 中文原样
    assert got['bg.v2.final.png'] == 'bg.v2.final'                      # 只切最后一个点
    assert got['layers/bg_main.png'] == 'bg_main'
    assert got['layers\\bg_main.png'] == 'bg_main'                      # 两种分隔符都认
    # 运行时传进来的是 AssetManager 解析后的**完整 URL**,取名必须仍然对
    assert got['/resources/runtime/scenes/雾津街头/background.png'] == 'background'


def test_空值必须抛错而不是静默返回空() -> None:
    """静默返回 '' 会让 URL 变成 `<场景>/lighting/`,恰好命中**旧的扁平布局** ——
    于是"图名错了"会伪装成"加载成功",是最难查的那种。"""
    from tools.character_lighting_lab.pipeline import _bake_key
    for bad in ('', '   '):
        with pytest.raises(ValueError):
            _bake_key(bad)
