"""独立光照 Baker —— 统一光影管线的全部烘焙产物,从场景输入到可判读预览。

规格唯一来源:`artifact/Design/独立光照Baker-lightbake-实施方案-2026-08-23.md`。
本包独立于旧工作台:**绝不 import `tools/scene_relight`**;只读工程其余部分
(场景 JSON / 原画 / 深度图),产物落
`public/resources/runtime/scenes/<sid>/lighting3/`(v6)。
仅有的两个受认可外部依赖:`tools/atomic_io`(全仓唯一原子写实现,机制卡
atomic-write-windows)与 `tools/editor/file_io`(场景 JSON 的统一写盘出口)。

模块划分见方案 §8;公开入口:

    from tools.lightbake import bake_scene          # 库函数,GUI/CLI 同一条链
    sh scripts/py.sh -m tools.lightbake bake --scene X
"""
from __future__ import annotations

__all__ = ['bake_scene']


def bake_scene(*args, **kwargs):
    """P2 起的完整烘焙管线(懒 import,避免 `import tools.lightbake` 就编译 numba)。"""
    from .pipeline import bake_scene as _bake
    return _bake(*args, **kwargs)
