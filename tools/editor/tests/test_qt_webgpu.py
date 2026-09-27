"""`tools/qt_webgpu.py`(Qt 宿主跑 WebGPU 页面的唯一口径)的常规回归:纯函数、环境变量、页内脚本、门。

真 GPU / 真窗口那一半在 `test_qt_webgpu_real_gpu.py`(`GAMEDRAFT_REAL_GPU=1` 才跑)。这里全部离屏可跑:
页内脚本用 node 跑(与浏览器同一份 JS 语义),Qt 部分只验"离屏下拒建而不是段错误"。
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools import qt_webgpu as qw  # noqa: E402

_NODE = shutil.which("node")
needs_node = pytest.mark.skipif(_NODE is None, reason="没有 node(页内脚本用 node 验)")


# ---------------------------------------------------------------------------
# 开关合并
# ---------------------------------------------------------------------------

def test_merge_appends_missing_and_keeps_existing_values() -> None:
    merged = qw.merge_chromium_switches("--foo --autoplay-policy=user-gesture-required",
                                        ["--foo", "--bar", "--autoplay-policy=no-user-gesture-required"])
    assert merged.split() == ["--foo", "--autoplay-policy=user-gesture-required", "--bar"], \
        "已有的同名 --x=值 要保留(用户 / 别的宿主显式设的优先),无值开关不重复"


def test_merge_unions_feature_lists_into_one_switch() -> None:
    """Chromium 同名开关只认最后一条:两条 --disable-features 并排会静默吃掉前一条。"""
    merged = qw.merge_chromium_switches("--disable-features=A,B --x", ["--disable-features=B,C", "--enable-features=Vulkan"])
    parts = merged.split()
    assert [p for p in parts if p.startswith("--disable-features=")] == ["--disable-features=A,B,C"]
    assert "--enable-features=Vulkan" in parts and "--x" in parts


def test_merge_is_idempotent() -> None:
    once = qw.merge_chromium_switches("", qw.GAME_HOST_CHROMIUM_FLAGS)
    assert qw.merge_chromium_switches(once, qw.GAME_HOST_CHROMIUM_FLAGS) == once


# ---------------------------------------------------------------------------
# apply_webgpu_chromium_flags
# ---------------------------------------------------------------------------

@pytest.fixture()
def fresh_env(monkeypatch, tmp_path):
    for key in (qw.QTWEBENGINE_FLAGS_ENV, qw.WEBVIEW2_ARGS_ENV, qw.WEBVIEW2_USER_DATA_ENV):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(qw, "_state", {"user_data_dir": None, "applied": False})
    monkeypatch.setattr(qw, "_user_data_root", lambda: tmp_path / "wv2")
    monkeypatch.setattr(qw.atexit, "register", lambda *a, **k: None)
    return tmp_path


def test_apply_merges_into_qtwebengine_flags_without_eating_existing(fresh_env, monkeypatch) -> None:
    monkeypatch.setenv(qw.QTWEBENGINE_FLAGS_ENV, "--disk-cache-size=1 --use-gl=angle")
    qw.apply_webgpu_chromium_flags()
    flags = os.environ[qw.QTWEBENGINE_FLAGS_ENV].split()
    assert "--disk-cache-size=1" in flags and "--use-gl=angle" in flags
    for f in qw.WEBGPU_CHROMIUM_FLAGS:
        assert f in flags


def test_apply_configures_webview2_args_and_private_user_data(fresh_env) -> None:
    qw.apply_webgpu_chromium_flags()
    args = os.environ[qw.WEBVIEW2_ARGS_ENV].split()
    for f in (*qw.WEBGPU_CHROMIUM_FLAGS, "--autoplay-policy=no-user-gesture-required", "--disable-http-cache",
              "--disable-gpu-shader-disk-cache", "--v8-cache-options=none"):
        assert f in args, f
    udf = Path(os.environ[qw.WEBVIEW2_USER_DATA_ENV])
    assert udf.is_dir() and udf.parent == fresh_env / "wv2"
    assert udf.name.startswith(f"{os.getpid()}-"), "目录名带 pid,下一个进程才能判断它是不是残留"
    assert qw.webview2_user_data_dir() == udf


def test_apply_is_idempotent(fresh_env) -> None:
    qw.apply_webgpu_chromium_flags()
    first = {k: os.environ[k] for k in (qw.QTWEBENGINE_FLAGS_ENV, qw.WEBVIEW2_ARGS_ENV, qw.WEBVIEW2_USER_DATA_ENV)}
    qw.apply_webgpu_chromium_flags()
    assert {k: os.environ[k] for k in first} == first
    assert len(list((fresh_env / "wv2").iterdir())) == 1


def test_apply_respects_explicit_user_data_folder(fresh_env, monkeypatch) -> None:
    mine = fresh_env / "mine"
    monkeypatch.setenv(qw.WEBVIEW2_USER_DATA_ENV, str(mine))
    qw.apply_webgpu_chromium_flags()
    assert os.environ[qw.WEBVIEW2_USER_DATA_ENV] == str(mine)
    assert not (fresh_env / "wv2").exists()


def test_purge_removes_only_dead_process_folders(tmp_path) -> None:
    dead = tmp_path / "999999-deadbeef"          # Windows 的 pid 是 4 的倍数,999999 不可能活着
    alive = tmp_path / f"{os.getpid()}-cafe"
    other = tmp_path / "not-a-pid"
    for d in (dead, alive, other):
        (d / "EBWebView").mkdir(parents=True)
    assert qw._pid_alive(os.getpid())
    qw._purge_stale_user_data(tmp_path)
    assert not dead.exists()
    assert alive.exists() and other.exists()


# ---------------------------------------------------------------------------
# 页内脚本(node 跑,与浏览器同一份 JS 语义)
# ---------------------------------------------------------------------------

def _node(script: str) -> str:
    r = subprocess.run([_NODE, "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


@needs_node
@pytest.mark.parametrize(("code", "expected"), [
    ("1 + 1", 2),
    ("1.5", 1.5),
    ("'s'", "s"),
    ("true", True),
    ("null", None),
    ("undefined", None),
    ("({a: 1, b: [1, 'x']})", {"a": 1, "b": [1, "x"]}),
    ("[1, 2]", [1, 2]),
    ("Promise.resolve(1)", {}),
    ("(() => { throw new Error('boom'); })()", None),
    ("var __qtw_g = 3; __qtw_g", 3),
])
def test_normalized_script_restores_qtwebengine_result_shapes(code, expected) -> None:
    """QWebView 原生把对象 / 数组 / null 全变成空串;包一层 JSON 之后形状与 QtWebEngine 一致。"""
    raw = _node(f"console.log(eval({json.dumps(qw.normalize_js_script(code))}))")
    assert qw.decode_normalized_result(raw) == expected


@needs_node
def test_normalized_script_runs_in_global_scope() -> None:
    """间接 eval:脚本里的 var 落在全局,与 runJavaScript 语义一致(后续脚本要能读到)。"""
    out = _node(
        f"eval({json.dumps(qw.normalize_js_script('var __qtw_x = 7;'))});"
        "console.log(typeof globalThis.__qtw_x === 'number' ? globalThis.__qtw_x : 'missing')")
    assert out == "7"


def test_decode_tolerates_garbage() -> None:
    for raw in ("", None, "not json", "[1]", '{"e": "x"}', '{"u": 1}'):
        assert qw.decode_normalized_result(raw) is None


@needs_node
def test_console_capture_script_buffers_and_drains() -> None:
    js = qw.CONSOLE_CAPTURE_JS
    out = _node(
        "const listeners = {}; globalThis.window = globalThis;"
        "window.addEventListener = (t, f) => { listeners[t] = f; };"
        "const orig = console.error; console.error = () => {}; console.warn = () => {};"
        f"eval({json.dumps(js)}); eval({json.dumps(js)});"   # 幂等:装两次只包一层
        "console.error('boom', {k: 1}); console.warn('careful');"
        "listeners.error({ message: 'x is not defined', filename: 'a.js', lineno: 3, error: null, target: window });"
        "listeners.unhandledrejection({ reason: new Error('nope') });"
        "const first = JSON.parse(window.__qtConsole.drain()); const second = JSON.parse(window.__qtConsole.drain());"
        "console.log(JSON.stringify({ first, second }));"
    )
    data = json.loads(out)
    levels = [row[0] for row in data["first"]]
    assert levels == ["error", "warn", "error", "error"]
    assert data["first"][0][1] == 'boom {"k":1}'
    assert data["first"][2][2:] == ["a.js", 3]
    assert "Uncaught (in promise)" in data["first"][3][1]
    assert data["second"] == [], "drain 取走即清空"


@needs_node
def test_probe_script_reports_missing_navigator_gpu() -> None:
    out = _node(
        "globalThis.window = globalThis; globalThis.isSecureContext = true;"
        f"console.log(eval({json.dumps(qw.webgpu_probe_start_js(True))}));"
        f"setTimeout(() => console.log(eval({json.dumps(qw.WEBGPU_PROBE_RESULT_JS)})), 50);"
    )
    started, raw = out.splitlines()
    assert started == "started"
    result = qw.parse_probe_result(raw)
    assert result["adapter"] is None and result["hasGpu"] is False


# ---------------------------------------------------------------------------
# 探测结果判读
# ---------------------------------------------------------------------------

def test_probe_result_interpretation() -> None:
    assert qw.parse_probe_result("pending") is None
    assert qw.parse_probe_result("") is None
    nvidia = {"hasGpu": True, "adapter": {"vendor": "nvidia", "architecture": "lovelace", "isFallbackAdapter": False},
              "deviceOk": True}
    assert qw.is_hardware_adapter(nvidia)
    assert "nvidia" in qw.describe_probe(nvidia)
    qt = {"hasGpu": True, "adapter": None}
    assert not qw.is_hardware_adapter(qt)
    assert "QtWebEngine" in qw.describe_probe(qt), "拿不到适配器时要把人指到正确的宿主上"
    swift = {"hasGpu": True, "adapter": {"vendor": "google", "architecture": "swiftshader"}}
    assert not qw.is_hardware_adapter(swift)
    assert not qw.is_hardware_adapter({"hasGpu": True, "adapter": {"vendor": "x", "isFallbackAdapter": True}})
    assert "没出结果" in qw.describe_probe(None)


# ---------------------------------------------------------------------------
# Qt:离屏平台下拒建(QWebView 在离屏 QPA 下会段错误)
# ---------------------------------------------------------------------------

def test_offscreen_platform_refuses_webgpu_view() -> None:
    pytest.importorskip("PySide6.QtWebView")
    from PySide6.QtWidgets import QApplication
    app = QApplication.instance() or QApplication([])
    if app.platformName() != "offscreen":
        pytest.skip("本条只在离屏平台上有意义")
    assert qw.webgpu_view_available() is False
    with pytest.raises(RuntimeError):
        qw.WebGpuView()


# ---------------------------------------------------------------------------
# 门:播游戏(WebGPU)的 Qt 宿主一律走 WebGpuView;QWebView 只在 qt_webgpu 里造
# ---------------------------------------------------------------------------

#: 页面里跑游戏 / 引擎渲染(只有 WebGPU)的 Qt 宿主。新增宿主时加进来。
_GAME_HOSTS = (
    "tools/editor/editors/game_browser.py",          # 编辑器内嵌预览 / 弹出游戏窗
    "tools/editor/editors/smell_profile_editor.py",  # 气味预览(engine2d Application)
    "tools/scene_workbench/app.py",                   # 「运行时」页签的 iframe 是真游戏
    "tools/build/scene_sweep.py",                     # 打包验收全场景扫描
)


def _code_lines(path: Path) -> str:
    return "\n".join(line.split("#", 1)[0] for line in path.read_text(encoding="utf-8").splitlines())


@pytest.mark.parametrize("rel", _GAME_HOSTS)
def test_game_hosts_use_webgpu_view_not_qtwebengine(rel: str) -> None:
    code = _code_lines(_ROOT / rel)
    assert "WebGpuView" in code, f"{rel} 播的是 WebGPU 游戏,要用 tools.qt_webgpu.WebGpuView"
    assert not re.search(r"QWebEngineView\s*\(|QWebEnginePage\s*\(", code), \
        f"{rel} 又造了 QtWebEngine 视图:QtWebEngine 没编 Dawn,游戏在里面起不来(见 tools/qt_webgpu.py)"


def test_only_qt_webgpu_constructs_qwebview() -> None:
    """QWebView 的坑(离屏段错误、返回值形状、焦点、UA 标记、缓存目录)都收在 WebGpuView 里,别处直接造就全漏了。"""
    offenders = []
    for p in (_ROOT / "tools").rglob("*.py"):
        if {"node_modules", "__pycache__"} & set(p.parts) or p.name.startswith("test_"):
            continue
        rel = p.relative_to(_ROOT).as_posix()
        if rel == "tools/qt_webgpu.py":
            continue
        if re.search(r"\bQWebView\s*\(", _code_lines(p)):
            offenders.append(rel)
    assert offenders == []


def test_desktop_shell_offers_webgpu_mode() -> None:
    """共用桌面壳要给迁到 RHI 的工作台留 WebGPU 口子(别的工作台打开 webgpu=True 就行)。"""
    import inspect

    from tools import desktop_shell
    assert "webgpu" in inspect.signature(desktop_shell.run_desktop).parameters
