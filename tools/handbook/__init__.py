# -*- coding: utf-8 -*-
"""制作人手册(本地文档站)的启动器。

手册正文在 `handbook/docs/*.md`,由制作人决定写什么;本包只负责把它渲成网站并打开:
构建 → 本地 http(mkdocs 自带,改 md 即时刷新)→ 系统默认浏览器开一个标签页。

刻意与游戏、编辑器零耦合:不 import 任何 tools.editor / src 代码;console 与主编辑器里的
"打开手册"只是各自起一个 `python -m tools.handbook` 子进程。删掉那两条菜单项手册照常用。
"""
from __future__ import annotations

import os
import socket
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HANDBOOK_DIR = ROOT / "handbook"
CONFIG_PATH = HANDBOOK_DIR / "mkdocs.yml"
SITE_DIR = HANDBOOK_DIR / "site"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5344
REQUIREMENTS = ROOT / "tools" / "handbook" / "requirements.txt"

#: mkdocs 渲出的每一页都带这个 generator meta;探测"这个端口上跑的是不是手册"就认它
_GENERATOR_MARK = b"mkdocs"


def child_env(base: dict[str, str] | None = None) -> dict[str, str]:
    """子进程环境:Windows 上 python 子进程默认 GBK,mkdocs 打印中文路径会炸,统一 utf-8。"""
    env = dict(os.environ if base is None else base)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUTF8", "1")
    return env


def serve_argv(python: str | Path, config: Path = CONFIG_PATH, *, host: str = DEFAULT_HOST,
               port: int = DEFAULT_PORT, livereload: bool = True) -> list[str]:
    """`mkdocs serve` 的完整命令行(纯函数,测试钉它)。"""
    argv = [str(python), "-m", "mkdocs", "serve", "-f", str(config), "-a", f"{host}:{port}"]
    if not livereload:
        argv.append("--no-livereload")
    return argv


def build_argv(python: str | Path, config: Path = CONFIG_PATH, site_dir: Path | None = None) -> list[str]:
    """`mkdocs build` 的完整命令行:静态导出,产物整个文件夹拷走就能看。"""
    argv = [str(python), "-m", "mkdocs", "build", "--clean", "-f", str(config)]
    if site_dir is not None:
        argv += ["-d", str(site_dir)]
    return argv


def missing_dependency_hint() -> str | None:
    """依赖没装齐时返回一行可直接执行的修复命令;齐了返回 None。"""
    missing = []
    for mod in ("mkdocs", "material", "pymdownx", "jieba"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if not missing:
        return None
    return (f"手册依赖缺失({', '.join(missing)}),先装:\n"
            f"  sh scripts/py.sh -m pip install -r {REQUIREMENTS.relative_to(ROOT).as_posix()}\n"
            f"  (离线机器加 --no-index --find-links .tools/wheelhouse_py311)")


def handbook_url(host: str = DEFAULT_HOST, port: int = DEFAULT_PORT) -> str:
    return f"http://{host}:{port}/"


def is_handbook_serving(url: str, timeout: float = 1.5) -> bool:
    """端口上已经有一份手册在跑(点了两次"打开手册"不该起第二个服务,直接开浏览器)。"""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status == 200 and _GENERATOR_MARK in resp.read(65536)
    except (urllib.error.URLError, OSError, ValueError):
        return False


def wait_until_listening(host: str, port: int, proc: subprocess.Popen, timeout: float = 90.0) -> bool:
    """等 mkdocs 起好端口;子进程先死了立刻返回 False,不干等到超时。

    首次构建要装载 jieba 词典(≈ 1–2 s)再渲染全部页面,页数多时会更久,所以上限给得宽。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return False
        try:
            with socket.create_connection((host, port), timeout=0.5):
                return True
        except OSError:
            time.sleep(0.2)
    return False
