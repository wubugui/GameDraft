# -*- coding: utf-8 -*-
"""查看器端到端回归门:同一份 `viewer/tests/selftest.js` 在两个宿主里跑真页面(真工程已烘的场景)——

* **真 GPU 的 Chrome**(`tools/workbench_rhi/chrome_page.mjs`):`--no-skip`,每一条都必须真跑、真过;
* **桌面壳**(`python -m tools.character_lighting_lab --selftest`,`webgpu=True` → WebView2 宿主):同一份脚本;
  这个宿主拿不到 WebGPU 时着色层那几条记 SKIP 并写明原因(不算失败),其余照断。
另有一条冒烟:Chrome 打开实验室,拿到 WebGPU、载荷装上、画面非空、控制台无 error(可选的编辑 PNG 不存在时浏览器记的 404 放过)。

覆盖:2D 画面是游戏渲染器 + 游戏装载器读虚拟烘焙目录、角色是游戏 lit 网格且绑的是载荷纹理、四档切换走游戏的
ensureProbeAtlas / ensureVolumes、遮挡是游戏的深度遮挡滤镜、改 amb 换一份合成并重装(改回来逐字节复原)、背景各视图是 CPU 图、
2D 标注层、3D 调试件(画面非空 / 投影 == 画法 / 深度遮挡)、3D 角色 quad 贴的是离屏画出的游戏着色、全景球。

自检只动视图参数,不点烘焙 / 导出 / 存盘:本机工作台与真工程一个字节不碰(这里对 runtime 的场景目录做指纹核对)。
没有已烘场景(`out/` 空)⇒ skip;没有 node / playwright-core / Chrome ⇒ skip;没有 PySide6 WebEngine ⇒ skip。
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.workbench_rhi import browser  # noqa: E402

_LAB = _ROOT / "tools" / "character_lighting_lab"
_SELFTEST_JS = _LAB / "viewer" / "tests" / "selftest.js"
_RUNTIME_SCENES = _ROOT / "public" / "resources" / "runtime" / "scenes"


def _baked_scenes() -> list[str]:
    out = _LAB / "out"
    return sorted(p.parent.name for p in out.glob("*/manifest.json")) if out.is_dir() else []


def _has_webengine() -> bool:
    try:
        import PySide6.QtWebEngineWidgets  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        return False


def _fingerprint() -> dict:
    """本机工作台 + 真工程里实验室会写的那几类产物(自检前后必须逐字节不变)"""
    files: list[Path] = []
    for sid in _baked_scenes():
        d = _LAB / "out" / sid
        files += [p for p in d.iterdir() if p.is_file() and p.suffix in (".json", ".png")]
        rt = _RUNTIME_SCENES / sid / "lighting"
        if rt.is_dir():
            files += [p for p in rt.rglob("*.json")]
    return {p.as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}


def _serve():
    return browser.serving([sys.executable, "-m", "tools.character_lighting_lab", "--serve", "--port", "{port}", "--no-open"])


_NEED_SCENE = pytest.mark.skipif(not _baked_scenes(), reason="本机工作台没有已烘场景(tools/character_lighting_lab/out/*/manifest.json)")


@_NEED_SCENE
@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_selftest_in_chrome_with_real_webgpu() -> None:
    before = _fingerprint()
    with _serve() as base:
        r = browser.run_page(base + "/", selftest=_SELFTEST_JS, no_skip=True)
    sys.stdout.write(r.stdout[-8000:])
    sys.stderr.write(r.stderr[-2000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert _fingerprint() == before, "自检改动了工作台 / 真工程的产物"
    assert "WebGPU 适配器:没有" not in r.stdout.replace("：", ":"), "这台机器的 Chrome 拿不到 WebGPU"
    assert r.returncode == 0, "Chrome 里的自检有 FAIL / EXC / SKIP 或控制台 error(看上面的报告)"
    assert " 0 failed, 0 skipped" in r.stdout
    for tag in ("PASS S1 ", "PASS S2 ", "PASS S3 ", "PASS S4 ", "PASS S6 ", "PASS S9 3D debug view: depth", "PASS S10 "):
        assert tag in r.stdout, f"缺 {tag.strip()}"


@_NEED_SCENE
@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_page_smoke_in_chrome(tmp_path: Path) -> None:
    """冒烟:拿到 WebGPU、角色受光载荷装上、画面非空、3D 调试件建起来、控制台无 error。"""
    shot = tmp_path / "character_lighting_lab_smoke.png"
    with _serve() as base:
        # 可选的编辑图(edit_depth.png 等)没存过时浏览器会记一条 404 资源错误:那是「没有」的正常回答,不是页面错
        r = browser.run_page(base + "/", smoke=True, shot=shot, extra=["--allow", "Failed to load resource: the server responded with a status of 404"])
    sys.stdout.write(r.stdout[-4000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert r.returncode == 0, "冒烟没过(看上面)"
    assert '"ok":true' in r.stdout and "控制台无 error" in r.stdout and shot.is_file()


@_NEED_SCENE
@pytest.mark.skipif(not _has_webengine(), reason="没有 PySide6 QtWebEngine")
def test_selftest_in_desktop_shell() -> None:
    before = _fingerprint()
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONUTF8="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "tools.character_lighting_lab", "--selftest"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=900, env=env)
    sys.stdout.write(r.stdout[-8000:])
    sys.stderr.write(r.stderr[-4000:])
    assert _fingerprint() == before, "自检改动了工作台 / 真工程的产物"
    assert r.returncode == 0, "桌面壳里的自检有 FAIL / EXC 或超时(看上面的报告)"
    assert "[selftest]" in r.stdout and " 0 failed" in r.stdout and "PASS S1 " in r.stdout and "PASS S8 " in r.stdout
