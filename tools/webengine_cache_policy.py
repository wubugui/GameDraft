"""桌面窗口一律禁缓存 —— 全仓 Qt WebEngine 壳的唯一口径。

制作人 2026-09-08 定死:**这是用 web 技术搭的游戏,不是网页,任何 desktop 窗口都不许留
任何缓存。** 缘由是当天那次事故:编辑器给游戏预览留的持久磁盘缓存烂了
(`net/disk_cache/blockfile/entry_impl.cc ... No file for 8000xxxx`),坏条目在 revalidate 时
照样被当响应体喂回渲染进程,`/src/ui/debugLightingSection.ts` 变成
`Uncaught SyntaxError`,模块图断掉、`main.ts` 一行没跑,窗口停在 `#111` 上——
**纯黑、点不动、`loadFinished` 还是 True、日志里一个字都没有**,外部浏览器却一切正常。
缓存给桌面壳买不到任何东西(内容全在本机 localhost / exe 旁边),却能这样静默毁掉一整天。

用法(两件都要,缺一不可):

1. **进程最开始**、任何 `QApplication` / WebEngine 初始化之前:`disable_all_caches()`
   —— Chromium 的开关只在启动时读一次,晚了不生效且不报错。
2. 每个自己造的 profile:`apply_no_cache(profile)`;共享默认 profile 用
   `apply_no_cache_to_default_profile()`(要在 `QApplication` 之后)。

⚠ 别再给任何壳设 `setCachePath()` / `DiskHttpCache`。要落盘的是**存档**,那条走 dev server
的文件后端(`src/core/storage/persistentStore.ts`),跟浏览器缓存没有半点关系。
"""
from __future__ import annotations

import os

#: 关掉 profile 之外、只能靠 Chromium 开关关的那几层缓存。
#: - `--v8-cache-options=none`:V8 编译产物缓存(会随 profile 落盘,同样能喂回坏字节)
#: - `--disable-gpu-shader-disk-cache`:GPU 着色器二进制缓存(唯一代价是每次启动重编译 shader)
#: - `--disk-cache-size=1` / `--media-cache-size=1`:兜底,`NoCache` 之外再把容量掐死
_NO_CACHE_FLAGS = (
    "--v8-cache-options=none",
    "--disable-gpu-shader-disk-cache",
    "--disk-cache-size=1",
    "--media-cache-size=1",
)

_ENV_KEY = "QTWEBENGINE_CHROMIUM_FLAGS"

#: Qt 自己那份落盘缓存(`<AppLocalData>/cache/qtpipelinecache-*`,RHI 图形管线),
#: 和 Chromium 无关,只能靠这个环境变量关。代价同样只是每次启动重编译。
_QT_ENV = {"QT_DISABLE_SHADER_DISK_CACHE": "1"}


def disable_all_caches() -> None:
    """关掉一个桌面壳能落盘的所有缓存。**必须在 WebEngine / Qt 初始化之前调用。**

    Chromium 那几个开关是"并进"`QTWEBENGINE_CHROMIUM_FLAGS`,不是覆盖:各壳有自己的
    GPU/自动播放开关(scene_sweep 的 swiftshader 等),直接赋值会把它们静默吃掉。
    重复调用幂等;用户显式设过的 Qt 环境变量不动。
    """
    existing = os.environ.get(_ENV_KEY, "")
    present = set(existing.split())
    missing = [f for f in _NO_CACHE_FLAGS if f not in present]
    if missing:
        os.environ[_ENV_KEY] = " ".join([existing, *missing]).strip()
    for key, value in _QT_ENV.items():
        os.environ.setdefault(key, value)


def apply_no_cache(profile) -> None:
    """把一个 `QWebEngineProfile` 钉成不缓存、不落盘。

    `setCachePath("")` 不能省:具名 profile 即使从没设过路径,Qt 也会给它一个标准位置,
    `NoCache` 只挡 HTTP 缓存,挡不住那个目录里的 code cache / GPUCache。
    """
    from PySide6.QtWebEngineCore import QWebEngineProfile

    profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.NoCache)
    profile.setCachePath("")


def apply_no_cache_to_default_profile() -> None:
    """共享默认 profile 同样收口——编辑器里没自己造 profile 的内嵌页都吃这一份。"""
    from PySide6.QtWebEngineCore import QWebEngineProfile

    apply_no_cache(QWebEngineProfile.defaultProfile())
