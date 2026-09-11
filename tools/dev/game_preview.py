# -*- coding: utf-8 -*-
"""游戏预览窗：用本机 Chromium（Chrome / Edge）起一个**专用**窗口跑游戏页，不丢给系统默认浏览器。

制作人 2026-09-08 定死：**这是游戏，不是网页。浏览器那套"没点过页面不许出声""窗口没焦点 / 被挡住就把页面
掐成后台、定时器节流、rAF 停"的行为一律禁止**——没有任何一个桌面客户端会这样。之前工作台 / 控制台把
``?mode=dev`` 丢给系统浏览器：进场景后要去游戏里点一下菜单声音才出得来；工作台窗口盖住游戏窗口时声音播着播着
断掉，要点回去再播一下才续上。

做法：不动用户浏览器的全局设置，而是起一个带自己 ``--user-data-dir`` 的 Chromium 实例——Chromium 的命令行开关
只对**新起的实例**生效，共用日常 profile 时会被已在跑的 Chrome 静默吞掉、一个字不报。开关：

- ``--autoplay-policy=no-user-gesture-required``：AudioContext 一建就是 running，不等手势；
- ``--disable-background-timer-throttling`` / ``--disable-renderer-backgrounding`` /
  ``--disable-backgrounding-occluded-windows`` + ``--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion``：
  没焦点、被别的窗口盖住也不降级——联动轮询、rAF、音频调度全速跑；
- 禁缓存（同 ``tools/webengine_cache_policy`` 那四件 + ``--disable-http-cache``）：桌面窗口一律禁缓存；
- ``--app=<url>``：无地址栏无标签页，就是一个游戏窗口。

找不到 Chrome / Edge（或 ``GAMEDRAFT_PREVIEW_BROWSER=default``）退回系统默认浏览器，那时上面那些恶习回来，
返回的说明里明说，别让人以为修了。运行时那侧另有保活（``AudioManager.installAudioKeepAlive``）：上下文一 running
就开播放门、挂起就 resume、``Howler.autoSuspend`` 关掉——两边合起来才是"打开就有声、一直有声"。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import webbrowser
from pathlib import Path

#: 环境变量：指到某个 Chromium 可执行文件；写 ``default`` = 强制用系统默认浏览器（排障用）。
ENV_BROWSER = "GAMEDRAFT_PREVIEW_BROWSER"

#: 专用实例的开关。顺序无所谓；``--app`` / ``--user-data-dir`` 由 build_command 另加。
PREVIEW_FLAGS: tuple[str, ...] = (
    # 音频不等手势
    "--autoplay-policy=no-user-gesture-required",
    # 没焦点 / 被盖住不降级
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion",
    # 桌面窗口一律禁缓存（与 tools/webengine_cache_policy 同口径，外加 HTTP 缓存整个关掉）
    "--disable-http-cache",
    "--disk-cache-size=1",
    "--media-cache-size=1",
    "--v8-cache-options=none",
    "--disable-gpu-shader-disk-cache",
    # 专用 profile 的杂音
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--hide-crash-restore-bubble",
)

_WIN_REG_KEYS = (
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe",
    r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe",
)
_WIN_KNOWN = (
    r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
    r"%LocalAppData%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
    r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
)
_MAC_KNOWN = (
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
)
_UNIX_NAMES = ("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable")


def _win_registry_paths() -> list[str]:
    try:
        import winreg  # type: ignore[import-not-found]
    except ImportError:  # 非 Windows
        return []
    found: list[str] = []
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for sub in _WIN_REG_KEYS:
            for view in (0, getattr(winreg, "KEY_WOW64_32KEY", 0)):
                try:
                    with winreg.OpenKey(hive, sub, 0, winreg.KEY_READ | view) as k:
                        v, _ = winreg.QueryValueEx(k, "")
                        if v:
                            found.append(str(v))
                except OSError:
                    continue
    return found


def find_chromium() -> Path | None:
    """本机的 Chrome / Edge / Chromium。``GAMEDRAFT_PREVIEW_BROWSER`` 指了就用它；``default`` = 不用专用窗。"""
    override = (os.environ.get(ENV_BROWSER) or "").strip()
    if override.lower() == "default":
        return None
    if override:
        p = Path(override).expanduser()
        return p if p.is_file() else None
    cands: list[str] = []
    if sys.platform.startswith("win"):
        cands += _win_registry_paths()
        cands += [os.path.expandvars(p) for p in _WIN_KNOWN]
    elif sys.platform == "darwin":
        cands += list(_MAC_KNOWN)
    for name in _UNIX_NAMES:
        w = shutil.which(name)
        if w:
            cands.append(w)
    for c in cands:
        p = Path(c)
        if p.is_file():
            return p
    return None


def profile_dir() -> Path:
    """专用实例的 profile（不在仓库里；禁缓存之后里面基本只剩窗口位置与偏好）。"""
    base = os.environ.get("LOCALAPPDATA") if sys.platform.startswith("win") else None
    root = Path(base) if base else Path.home() / ".gamedraft"
    return root / "GameDraft" / "preview-profile"


def build_command(exe: Path | str, url: str, profile: Path | str | None = None) -> list[str]:
    """完整命令行：可执行文件 + 开关 + profile + ``--app=url``（纯函数，测试钉它）。"""
    prof = Path(profile) if profile is not None else profile_dir()
    return [str(exe), *PREVIEW_FLAGS, f"--user-data-dir={prof}", f"--app={url}"]


def open_game_preview(url: str) -> str:
    """打开游戏页。返回一句人话说明走的是哪条路（调用方写日志 / 状态）。

    专用实例已经在跑时（同一个 ``--user-data-dir``），Chromium 会把 ``--app=url`` 交给它再开一个窗口，
    不会起第二个实例；但开关是老实例的——它本来就带着同一套。
    """
    exe = find_chromium()
    if exe is None:
        webbrowser.open(url)
        return "没找到 Chrome / Edge，用了系统默认浏览器：音频要在页里点一下才解锁、没焦点会被降级"
    prof = profile_dir()
    try:
        prof.mkdir(parents=True, exist_ok=True)
    except OSError:
        pass
    cmd = build_command(exe, url, prof)
    kwargs: dict = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL, "close_fds": True}
    if sys.platform.startswith("win"):
        kwargs["creationflags"] = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen(cmd, **kwargs)
    except OSError as e:
        webbrowser.open(url)
        return f"专用预览窗起不来（{e}），用了系统默认浏览器：音频要在页里点一下才解锁"
    return f"专用预览窗（{exe.name}，免手势音频、不后台降级、不缓存）"


if __name__ == "__main__":  # python -m tools.dev.game_preview <url>
    target = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173/?mode=dev"
    print(open_game_preview(target))
