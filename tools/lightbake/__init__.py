"""独立光照 Baker `tools/lightbake`。

全新、独立、自带预览的离线 baker，产出统一光影管线（`lighting3/`）的全部烘焙产物。
预览是单文件自包含 HTML（图全部内联），结构上不可能看到浏览器缓存的旧图。

模块划分见 `artifact/Design/独立光照Baker-lightbake-实施方案-2026-08-23.md` §8。

用法：`sh scripts/py.sh -m tools.lightbake bake --scene 雾津街头`
"""
from __future__ import annotations

__version__ = '6.0.0'
