"""桌面窗口一律禁缓存——把这条规矩钉成可执行的门,而不是一句注释。

制作人 2026-09-08 定死:**这是用 web 技术搭的游戏,不是网页,任何 desktop 窗口都不许留缓存。**
当天的代价是一整天:编辑器给游戏预览留的持久磁盘缓存烂了,坏条目在 revalidate 时被当成响应体
喂回渲染进程,某个 `/src/*.ts` 变成 `Uncaught SyntaxError`,模块图断掉、`main.ts` 一行没跑,
窗口停在 `#111` 上——**纯黑、点不动、`loadFinished` 还是 True、日志里一个字都没有**,
而外部浏览器(另一份缓存)一切正常,于是"浏览器没问题"把人往完全相反的方向带。

缓存给桌面壳买不到任何东西(内容全在本机 localhost / exe 旁边),所以这里不留"权衡",只留禁令。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

_TOOLS = _ROOT / "tools"
_THIS = Path(__file__).resolve()

#: 只扫我们自己的 Qt 壳;第三方/产物目录不在疆域内。
_SKIP_DIR_PARTS = {"__pycache__", "node_modules", "out", "target", ".venv"}


def _tool_sources() -> list[Path]:
    return [
        p for p in _TOOLS.rglob("*.py")
        if p != _THIS and not _SKIP_DIR_PARTS.intersection(p.parts)
    ]


def test_no_disk_http_cache_anywhere() -> None:
    """`setHttpCacheType(... DiskHttpCache)` 是这条规矩的反面,一个都不许有。

    只认**调用**、不认散文:讲清楚"为什么不许"的注释里必然出现这个词。
    """
    call = re.compile(r"setHttpCacheType\([^)]*DiskHttpCache")
    offenders = [
        str(p.relative_to(_ROOT))
        for p in _tool_sources()
        if call.search(p.read_text(encoding="utf-8", errors="replace"))
    ]
    assert offenders == [], (
        f"桌面窗口不许开磁盘 HTTP 缓存(见 tools/webengine_cache_policy.py):{offenders}"
    )


def test_no_profile_points_at_a_cache_dir() -> None:
    """`setCachePath('<路径>')` 同样禁止——`NoCache` 只挡 HTTP 缓存,
    挡不住那个目录里的 code cache / GPUCache。只允许 `setCachePath("")`(显式清空)。"""
    pattern = re.compile(r"setCachePath\(\s*(?!['\"]{2}\s*\))(?!\s*\))")
    offenders = [
        str(p.relative_to(_ROOT))
        for p in _tool_sources()
        if pattern.search(p.read_text(encoding="utf-8", errors="replace"))
    ]
    assert offenders == [], (
        f"profile 不许指向任何缓存目录,只能 setCachePath(''):{offenders}"
    )


def test_every_webengine_shell_disables_caches() -> None:
    """每个自己造 profile 的壳都必须走统一口径(`apply_no_cache`)。

    漏掉的表现不是报错,是**多年以后某台机器上的一屏黑**——所以这里靠门,不靠人记得。
    """
    policy = "webengine_cache_policy"
    offenders = []
    for p in _tool_sources():
        text = p.read_text(encoding="utf-8", errors="replace")
        if "QWebEngineProfile(" not in text:
            continue
        if policy not in text:
            offenders.append(str(p.relative_to(_ROOT)))
    assert offenders == [], (
        f"这些壳自己造了 profile 却没走 tools/{policy}.py 的统一口径:{offenders}"
    )


def test_shipped_game_serves_no_store() -> None:
    """发行版那扇窗(Tauri + WebView2)同样受这条规矩管:自定义协议一律 `no-store`。

    这里原本是 `max-age=31536000, immutable` —— 内容躺在 exe 旁边的 `game/` 文件夹里、
    换图不换名是设计卖点,那条头等于允许 WebView2 一年内喂旧字节。
    """
    src = (_ROOT / "src-tauri" / "src" / "web_root.rs").read_text(encoding="utf-8")
    # 只看真正发出去的头值(注释里必然写着那条被废掉的 max-age,不该被算成违规)。
    sent = re.findall(r'header\(\s*"Cache-Control"\s*,\s*"([^"]*)"', src)
    assert sent, "web_root.rs 里找不到 Cache-Control 头——协议处理被改动过,这道门要跟着改"
    assert set(sent) == {"no-store"}, f"发行版窗口只许发 no-store,实际发的是:{sent}"
