# -*- coding: utf-8 -*-
"""交互层端到端回归门：同一份 `viewer/tests/selftest.js` 在两个宿主里跑真页面——

* **桌面壳**（工作台的真宿主：`run_desktop(webgpu=True)` → WebView2 / WKWebView，离屏平台下是挪到屏幕外、尺寸固定的
  无边框真窗口）：全部断言，**一条 SKIP 都不许有**（着色层是游戏的 WebGPU 渲染器，这个宿主拿得到）；
* **真 GPU 的 Chrome**（`tools/workbench_rhi/chrome_page.mjs`）：同一份脚本，`--no-skip`——着色层每一条都必须真跑、真过；
  另有一条冒烟：拿到 WebGPU、画面非空、控制台无 error。没有 node / playwright-core / Chrome 就 skip。

覆盖：启动只有模板没有场景、「用在哪」列出全部宿主、模板预览是运行时本体且按真实尺寸摆（同样的事件半尺寸烧得更快）、
检视器数值保值（整数 / 越界 / 清空删键 / 必填）、真实尺寸锁比例 / 解锁 / 偏离提示 / 必填、着火点与握点增删拖（撤销重做）、
燃料涂层笔刷（写 data URL、网格跟着变、撤销重做重解码）、预览推进 / 时间轴确定性重放 / 熄灭 / 复原 / 消耗燃烧 / 预览风吹熄、
游戏同一份燃烧滤镜（burnShade.wgsl，经 BurnRenderer）真画出焦黑烧没自发光（读像素；没点的不挂着色）、场景视图的热点是游戏 Hotspot 本体、只读场景视图（一个模拟里各用各的模板、透视与朝向口径、
initial 在烧、拖不动、当前模板用工作态、跨实例蔓延）、左右站位残差≈0 与朝向、接触帧没标 / 片段不存在 / 状态点不了的显式提示、
本地能不能站 + 游戏判定覆盖本地、保存（值、浮点表示、没改不写、保存锁、别处改过拒写）、新建（尺寸必填、选图给初始尺寸）/ 复制 / 换图 /
改名（先确认、跟着改所有引用）/ 删除（有引用拒绝）、非法与重名 id、联动协议 v2（载荷形状、从游戏回传的实例里选用这份模板的）、视图手势。

自检进程整个读写指在临时样例工程（`app.py`）：真工程的模板目录必须逐字节不变，真工程里也不许出现自检改名用的 id。
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import sys
import warnings
from pathlib import Path

import pytest

if str(Path(__file__).resolve().parents[3]) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from tools.workbench_rhi import browser  # noqa: E402

_ROOT = Path(__file__).resolve().parents[3]
_BURN = _ROOT / "public" / "assets" / "data" / "burnables"
_ASSETS = _ROOT / "public" / "assets"
_SELFTEST_RENAME_ID = b"zz_paper_renamed"



def _fingerprint() -> dict:
    return {p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(_BURN.glob("*.json"))} if _BURN.is_dir() else {}


def _real_files_mentioning_selftest_id() -> list[str]:
    out = []
    for p in _ASSETS.rglob("*.json"):
        try:
            if _SELFTEST_RENAME_ID in p.read_bytes():
                out.append(p.as_posix())
        except OSError:
            continue
    return out


#: 明确标注的已知差异（KNOWN）：S7 里撞上 master 同一 bug 的几条——燃烧材质滤镜排在滤镜链中间时燃烧 uv 按相对 bounds 的坐标算
#: （Pixi 中间几道 pass 的 uOutputFrame.xy 是 0）。本分支与 master 一致、不改（制作人规矩），修复在 wt/burnfix 等制作人定。
#: 自检碰上时会「只挂材质那一道」重读、证实就是这个 bug 才记 KNOWN（不然照常 FAIL）；这里核对 KNOWN 只出现在这几条上、带着记录路径，
#: 并报成 pytest 警告（警告汇总里看得见，别被悄悄忘掉）。修好之后这几条是 PASS，把这张表删掉即可。
_MID_CHAIN_DOC = "agent_docs/_meta/inbox/2026-09-28-filters-mid-chain-screen-pos.md"
_KNOWN_S7 = {
    "S7 burnt out = background shows through (material + glow chain)": _MID_CHAIN_DOC,
    "S7 burnt out stays burnt out wherever the camera puts the sprite": _MID_CHAIN_DOC,
    "S7 at t=1 the fire line glows (emission added) over the scorched paper": _MID_CHAIN_DOC,
}


def _report_known(report: str, host: str) -> None:
    known = browser.check_known(report, _KNOWN_S7)
    if known:
        lines = "; ".join(ln[:160] for ln in known)
        warnings.warn(f"燃烧工作台自检（{host}）有 {len(known)} 条已知差异（master 同一 bug，待制作人定，见 {_MID_CHAIN_DOC}）：{lines}",
                      UserWarning, stacklevel=2)


@pytest.mark.skipif(bool(browser.qt_host_unavailable()), reason=browser.qt_host_unavailable() or "ok")
def test_interaction_layer_selftest() -> None:
    before = _fingerprint()
    assert not _real_files_mentioning_selftest_id(), "真工程里本来就有自检改名用的 id：换一个"
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1", PYTHONUTF8="1", QT_QPA_PLATFORM="offscreen")
    r = subprocess.run([sys.executable, "-m", "tools.burn_workbench", "--selftest"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600, env=env)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr[-4000:])
    after = _fingerprint()
    assert after == before, f"自检改动了真工程的模板目录：{set(after) ^ set(before) or '内容变了'}"
    leaked = _real_files_mentioning_selftest_id()
    assert not leaked, f"自检的改名写进了真工程：{leaked}"
    assert r.returncode == 0, "selftest 有 FAIL/EXC 或超时（看上面的报告）"
    assert "passed, 0 failed" in r.stdout
    assert "[selftest]" in r.stdout and "PASS S1" in r.stdout and "PASS S14" in r.stdout
    assert not browser.skip_lines(r.stdout), f"Qt（WebGPU）宿主里不许有 SKIP：{browser.skip_lines(r.stdout)}"
    _report_known(r.stdout, "Qt / WebView2")


_SELFTEST_JS = _ROOT / "tools" / "burn_workbench" / "viewer" / "tests" / "selftest.js"


def _fixture_server(tmp_path: Path):
    # 目录名带 burnwb_selftest_：自检脚本凭它（与 /api/boot 的 real === false）自证读写不在真库
    proj = tmp_path / "burnwb_selftest_chrome"
    return browser.serving([sys.executable, "-m", "tools.burn_workbench", "--serve", "--port", "{port}", "--fixture", str(proj)])


@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_selftest_in_chrome_with_real_webgpu(tmp_path: Path) -> None:
    """同一份自检在真 GPU 的 Chrome 里：着色层（游戏的 WebGPU 渲染器 + 燃烧滤镜）每一条都真跑，一条 SKIP 都不许有。"""
    before = _fingerprint()
    with _fixture_server(tmp_path) as base:
        r = browser.run_page(base + "/", selftest=_SELFTEST_JS, no_skip=True)
    sys.stdout.write(r.stdout[-6000:])
    sys.stderr.write(r.stderr[-2000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert _fingerprint() == before, "自检改动了真工程的模板目录"
    assert not _real_files_mentioning_selftest_id(), "自检的改名写进了真工程"
    assert "WebGPU 适配器：没有" not in r.stdout, "这台机器的 Chrome 拿不到 WebGPU"
    assert r.returncode == 0, "Chrome 里的自检有 FAIL / EXC / SKIP 或控制台 error（看上面的报告）"
    assert " 0 failed, 0 skipped" in r.stdout and "PASS S1 the GPU layer" in r.stdout and "PASS S7 the game burn filters" in r.stdout
    _report_known(r.stdout, "Chrome")


@pytest.mark.skipif(bool(browser.unavailable()), reason=browser.unavailable() or "ok")
def test_page_smoke_in_chrome(tmp_path: Path) -> None:
    """冒烟：Chrome 打开燃烧工作台，拿到 WebGPU、画面非空（与清屏色不同的像素够多）、控制台无 error。"""
    shot = tmp_path / "burn_workbench_smoke.png"
    with _fixture_server(tmp_path) as base:
        r = browser.run_page(base + "/", smoke=True, shot=shot)
    sys.stdout.write(r.stdout[-4000:])
    if r.returncode == browser.EXIT_NO_BROWSER:
        pytest.skip("起不来 Chrome")
    assert r.returncode == 0, "冒烟没过（看上面）"
    assert '"ok":true' in r.stdout and "控制台无 error" in r.stdout and shot.is_file()
