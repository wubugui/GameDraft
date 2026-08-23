""""哪些页是场景页"的**唯一登记处**，以及跨页跳转该落在哪一个。

## 为什么需要它

主窗口有五处硬写 `SceneEditor` 的判定：任务编排前的强制提交（会替换编辑器）、
页签注册、两处"改完数据要刷新哪些页"的映射、以及全局搜索的跳转路由。

只要新增第二个场景页，这五处**每漏一处就是一种静默失效**：

- 漏了编排那处 → 新页不会被强制提交，编排替换后编辑丢失；
- 漏了刷新映射 → 别的编辑器改了场景，新页显示的是旧数据；
- 漏了跳转路由 → 全局搜索永远落在**先注册**的那个页（老代码遇到第一个
  `isinstance(ed, SceneEditor)` 就 return），点过去发现是空的。

所以把它收成一处定义、五处引用。

## 跳转开关（`NAV_TARGET`）

**同一时刻只有一个场景页可被跳转到。** 两个页同时可导航会让"点搜索结果跳过去，
发现不是自己正在编辑的那个页"变成日常。切换靠改这一个常量，不靠改五处判定。
"""
from __future__ import annotations

from typing import Literal

__all__ = ["NAV_TARGET", "scene_page_types", "navigation_scene_page_types"]

#: 跨页跳转（全局搜索、引用跳转）落在哪个场景页。改这一个常量即可整体切换。
#: `"v1"` = 老画布 `SceneEditor`；`"v2"` = 新画布 `SceneEditorV2`。
NAV_TARGET: Literal["v1", "v2"] = "v1"


def _v1() -> type:
    from .editors.scene_editor import SceneEditor
    return SceneEditor


def _v2() -> type | None:
    """新画布页；尚未落地时返回 None（本文件因此可以先于它存在）。"""
    try:
        from .editors.scene_v2.page import SceneEditorV2
    except ImportError:
        return None
    return SceneEditorV2


def scene_page_types() -> tuple[type, ...]:
    """**全部**场景页类型。门控 / 编排 / 引用刷新一律按这个元组判定。

    注意与 :func:`navigation_scene_page_types` 的区别：那些动作要覆盖**所有**场景页
    （否则未被覆盖的那个页会静默拿着旧数据或丢编辑），而跳转只能有一个落点。
    """
    v2 = _v2()
    return (_v1(), v2) if v2 is not None else (_v1(),)


def navigation_scene_page_types() -> tuple[type, ...]:
    """跨页跳转的落点，按 :data:`NAV_TARGET` 选一个。

    返回元组而不是单个类型，只是为了让调用方的 `isinstance` 写法保持一致。
    """
    if NAV_TARGET == "v2":
        v2 = _v2()
        if v2 is not None:
            return (v2,)
    return (_v1(),)
