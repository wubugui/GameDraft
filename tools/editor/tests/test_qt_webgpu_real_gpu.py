"""真 GPU / 真窗口回归:Qt 宿主里的 WebGPU 页面真的拿到硬件适配器、真的出画面。

**只在 `GAMEDRAFT_REAL_GPU=1` 时跑**(Windows + 有显卡 + 有桌面会话;常规套件是离屏的,WebView2 在离屏平台下会段错误):

    GAMEDRAFT_REAL_GPU=1 sh scripts/py.sh -m pytest tools/editor/tests/test_qt_webgpu_real_gpu.py -n0 -v

每条都在子进程里跑、去掉 `QT_QPA_PLATFORM=offscreen`,窗口挪到屏幕外(`place_offscreen`,真窗口照常渲染);
原生按键那条会把测试窗口短暂提到前台。要连真游戏的两条另需 `GAMEDRAFT_TEST_GAME_URL=http://127.0.0.1:<端口>`
(一个在跑的 dev 服;别拿制作人手上的 5173,起一个 `GAMEDRAFT_SWEEP_ISOLATED=1` 的)。
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[3]

pytestmark = pytest.mark.skipif(
    os.environ.get("GAMEDRAFT_REAL_GPU") != "1" or sys.platform != "win32",
    reason="真 GPU / 真窗口测试:设 GAMEDRAFT_REAL_GPU=1(Windows + 显卡 + 桌面会话)才跑",
)
_GAME_URL = os.environ.get("GAMEDRAFT_TEST_GAME_URL", "").rstrip("/")
needs_game = pytest.mark.skipif(not _GAME_URL, reason="要一个在跑的 dev 服:GAMEDRAFT_TEST_GAME_URL")


def _env(**extra: str) -> dict:
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUTF8="1", PYTHONUNBUFFERED="1")
    env.pop("QT_QPA_PLATFORM", None)
    env.update(extra)
    return env


def _run(code: str, timeout: float = 240, **env) -> dict:
    """跑一段宿主脚本;脚本最后一行打印 ``RESULT <json>``。"""
    r = subprocess.run([sys.executable, "-X", "faulthandler", "-c", textwrap.dedent(code)], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
                       env=_env(**env))
    lines = [ln for ln in r.stdout.splitlines() if ln.startswith("RESULT ")]
    assert r.returncode == 0 and lines, f"exit {r.returncode}\nstdout:\n{r.stdout[-3000:]}\nstderr:\n{r.stderr[-3000:]}"
    return json.loads(lines[-1][len("RESULT "):])


_PAGE_SERVER = '''
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
PAGE = b"""<!doctype html><meta charset=utf-8><title>t</title><body style='margin:0;background:#202020'>
<canvas id=c width=320 height=200 style='width:320px;height:200px'></canvas><script>
window.keys = [];
addEventListener('keydown', e => keys.push(e.code));
(async () => {
  const a = await navigator.gpu.requestAdapter();
  const d = await a.requestDevice();
  const ctx = document.getElementById('c').getContext('webgpu');
  ctx.configure({ device: d, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
  const draw = () => {
    const e = d.createCommandEncoder();
    e.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear',
      clearValue: { r: 0.1, g: 0.6, b: 0.3, a: 1 }, storeOp: 'store' }] }).end();
    d.queue.submit([e.finish()]);
    requestAnimationFrame(draw);
  };
  draw();
  window.drawn = true;
  console.error('after-load error from page');
})();
</script>"""
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Cache-Control', 'no-store'); self.end_headers(); self.wfile.write(PAGE)
    def log_message(self, *a): pass
_srv = ThreadingHTTPServer(('127.0.0.1', 0), H)
threading.Thread(target=_srv.serve_forever, daemon=True).start()
PAGE_URL = f'http://127.0.0.1:{_srv.server_address[1]}/'
'''

_HELPERS = '''
import json, sys, time
from PySide6.QtCore import QEventLoop, QTimer
def pump(s):
    loop = QEventLoop(); QTimer.singleShot(max(1, int(s * 1000)), loop.quit); loop.exec()
def js(run, code, timeout=5.0):
    loop = QEventLoop(); box = {}
    def done(v): box['v'] = v; loop.quit()
    run(code, done); QTimer.singleShot(int(timeout * 1000), loop.quit); loop.exec()
    return box.get('v')
def wait(pred, timeout=30.0):
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout:
        if pred(): return True
        pump(0.2)
    return False
'''


def test_selftest_cli_gets_hardware_adapter() -> None:
    r = subprocess.run([sys.executable, "-m", "tools.qt_webgpu", "--offscreen-window"], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120, env=_env())
    assert r.returncode == 0, r.stdout + r.stderr
    data = json.loads(r.stdout.strip().splitlines()[-1])
    assert data["ok"] and data["probe"]["deviceOk"], data


def test_webgpu_view_behaviours() -> None:
    """WebGpuView 的承诺逐条过:适配器、返回值形状、UA 标记、console 捕获、原生焦点 + 按键、PrintWindow 截图、同步拆除。"""
    out = _run(_PAGE_SERVER + _HELPERS + '''
from tools.qt_webgpu import (apply_webgpu_chromium_flags, WebGpuView, probe_webgpu, is_hardware_adapter, place_offscreen,
                             bring_to_foreground, native_key, release_webgpu_view, HOST_UA_TOKEN)
apply_webgpu_chromium_flags()
from PySide6.QtWidgets import QApplication
app = QApplication([sys.argv[0]])
v = WebGpuView(forward_console=False)
console = []
v.consoleMessage.connect(lambda lvl, msg, src, line: console.append([lvl, msg]))
finished = []
v.loadFinished.connect(finished.append)
v.resize(400, 260); place_offscreen(v); v.show()
v.load(PAGE_URL)
assert wait(lambda: finished and js(v.run_js, 'window.drawn === true'), 30), 'page did not draw'
res = {'finished': finished}
res['probe'] = probe_webgpu(v)
res['hardware'] = is_hardware_adapter(res['probe'])
res['shapes'] = [js(v.run_js, c) for c in ('({a: [1, "x"]})', '[1, 2]', 'null', '42', '"s"')]
res['ua_has_token'] = HOST_UA_TOKEN in (js(v.run_js, 'navigator.userAgent') or '')
wait(lambda: console, 5)
res['console'] = console
res['foreground'] = bring_to_foreground(v)
v.focus_page(); pump(0.4)
native_key('K'); pump(0.6)
res['keys'] = js(v.run_js, 'window.keys')
img = v.grab_image()
px = img.pixelColor(20, 20)
res['pixel'] = [px.red(), px.green(), px.blue()]
v.close(); release_webgpu_view(v)
res['alive_after_release'] = v.is_alive() if hasattr(v, 'is_alive') else None
print('RESULT ' + json.dumps(res))
''')
    assert out["finished"] == [True], "载入完成只报一次(启动期换 UA 的那张空页不对外报)"
    assert out["hardware"], out["probe"]
    assert out["shapes"] == [{"a": [1, "x"]}, [1, 2], None, 42, "s"]
    assert out["ua_has_token"]
    assert ["error", "after-load error from page"] in out["console"]
    assert out["foreground"] and out["keys"] == ["KeyK"], out
    r, g, b = out["pixel"]
    assert abs(r - 25) <= 3 and abs(g - 153) <= 3 and abs(b - 76) <= 3, f"截到的不是 WebGPU 清屏色:{out['pixel']}"


def test_editor_game_play_window_on_webgpu() -> None:
    """编辑器的游戏弹窗(GamePlayWindow)就是 WebGpuView:硬件适配器 + run_js_result 同步取值 + 关窗。"""
    out = _run(_PAGE_SERVER + _HELPERS + '''
from tools.webengine_cache_policy import disable_all_caches
from tools.qt_webgpu import apply_webgpu_chromium_flags, probe_webgpu, is_hardware_adapter, place_offscreen
disable_all_caches(); apply_webgpu_chromium_flags()
import PySide6.QtWebEngineWidgets  # 与编辑器入口同序:QtWebEngine 与 WebView2 同进程共存
from PySide6.QtWidgets import QApplication
app = QApplication([sys.argv[0]])
from tools.editor.editors.game_browser import GamePlayWindow, GameBrowserTab
w = GamePlayWindow(480, 320)
place_offscreen(w); w.show()
w.load_url(PAGE_URL)
assert wait(lambda: w.run_js_result('window.drawn === true') is True, 30)
res = {'available': w.is_available(), 'probe': probe_webgpu(w._view)}
res['hardware'] = is_hardware_adapter(res['probe'])
res['sync'] = w.run_js_result('({n: 1 + 1})')
tab = GameBrowserTab()
res['tab_available'] = tab.is_webengine_available()
closed = []
w.closed.connect(lambda: closed.append(True))
w.close(); pump(1.0)
res['closed'] = closed
print('RESULT ' + json.dumps(res))
''')
    assert out["available"] and out["tab_available"]
    assert out["hardware"], out["probe"]
    assert out["sync"] == {"n": 2}
    assert out["closed"] == [True]


def test_desktop_shell_webgpu_selftest(tmp_path) -> None:
    """共用桌面壳 webgpu=True:离屏平台下自动改成屏幕外真窗口,页面里拿到硬件适配器。"""
    selftest = tmp_path / "selftest.js"
    selftest.write_text(textwrap.dedent('''
        (async () => {
          const a = navigator.gpu && await navigator.gpu.requestAdapter();
          const info = a && a.info ? a.info.vendor + '/' + a.info.architecture : '';
          window.__selftestResult = a && !a.isFallbackAdapter ? 'PASS adapter ' + info : 'FAIL no hardware adapter';
        })();
    '''), encoding="utf-8")
    code = _PAGE_SERVER + f'''
from http.server import SimpleHTTPRequestHandler
from tools.desktop_shell import run_desktop
class Page(SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers()
        self.wfile.write(b'<!doctype html><title>shell</title><p>shell</p>')
    def log_message(self, *a): pass
code = run_desktop(Page, title='webgpu-shell-test', app_id='webgpu-shell-test', webgpu=True,
                   selftest={str(selftest)!r}, selftest_timeout_s=60)
print('RESULT ' + json.dumps({{'code': code}}))
'''
    r = subprocess.run([sys.executable, "-X", "faulthandler", "-c", "import json\n" + code], cwd=str(_ROOT),
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180,
                       env=_env(QT_QPA_PLATFORM="offscreen"))
    assert "PASS adapter" in r.stdout, r.stdout + r.stderr
    assert 'RESULT {"code": 0}' in r.stdout, r.stdout + r.stderr
    assert r.returncode == 0, r.stderr[-2000:]


@needs_game
def test_real_game_boots_on_webgpu_in_editor_window() -> None:
    """真游戏:编辑器弹窗进场景、渲染器是 webgpu、硬件适配器、切一次场景、开背包面板,F2 日志没有 GPU 报错。"""
    out = _run(_HELPERS + f'''
from tools.webengine_cache_policy import disable_all_caches
from tools.qt_webgpu import apply_webgpu_chromium_flags, probe_webgpu, is_hardware_adapter, place_offscreen
disable_all_caches(); apply_webgpu_chromium_flags()
from PySide6.QtWidgets import QApplication
app = QApplication([sys.argv[0]])
from tools.editor.editors.game_browser import GamePlayWindow
STATE = """(() => {{ const g = window.__game; if (!g) return null; const sm = g.sceneManager;
  const lines = (g.debugPanelUI && g.debugPanelUI.logLines) || [];
  return {{ scene: sm.currentSceneData && sm.currentSceneData.id, switching: !!sm.switching,
    renderer: g.renderer.app.renderer && g.renderer.app.renderer.name, state: String(g.stateController.currentState),
    bad: lines.filter(l => /\\[GPU诊断\\] (错误|告警)|\\[JS错误\\]|\\[未处理Promise\\]|设备丢失/.test(l)) }}; }})()"""
w = GamePlayWindow(800, 600); place_offscreen(w); w.show()
w.load_url({_GAME_URL + "/?mode=dev&devScene=雾津街头"!r})
st = {{}}
def at(scene):
    global st
    st = w.run_js_result(STATE) or {{}}
    return st.get('scene') == scene and not st.get('switching') and st.get('renderer')
res = {{'boot': wait(lambda: at('雾津街头'), 150)}}
res['probe'] = probe_webgpu(w._view); res['hardware'] = is_hardware_adapter(res['probe'])
w.run_js('window.__game.applyRuntimeCommand({{type: "debugExecuteAction", action: {{type: "switchScene", params: {{targetScene: "河边"}}}}}})')
res['switch'] = wait(lambda: at('河边'), 90)
pump(1.5)
w.run_js("window.__game.stateController.togglePanel('inventory')"); pump(1.0)
res['state'] = w.run_js_result(STATE)
w.close(); pump(0.5)
print('RESULT ' + json.dumps(res, ensure_ascii=False))
''', timeout=360)
    assert out["boot"] and out["switch"], out
    assert out["hardware"], out["probe"]
    assert out["state"]["renderer"] == "webgpu" and out["state"]["state"] == "UIOverlay"
    assert out["state"]["bad"] == [], out["state"]["bad"]


@needs_game
def test_scene_sweep_runs_on_webgpu(tmp_path) -> None:
    """打包验收扫描:WebView2 里真进场景、渲染器 webgpu、报告记下硬件适配器(清单给空的,只验驱动)。"""
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"target": "test", "files": []}), encoding="utf-8")
    out = tmp_path / "sweep.json"
    subprocess.run([sys.executable, "-X", "faulthandler", "-m", "tools.build.scene_sweep", "--url", _GAME_URL,
                    "--manifest", str(manifest), "--out", str(out), "--scenes", "dev_room", "--offscreen"],
                   cwd=str(_ROOT), capture_output=True, text=True, encoding="utf-8", errors="replace",
                   timeout=300, env=_env())
    report = json.loads(out.read_text(encoding="utf-8"))
    scene = report["scenes"][0]
    assert scene["error"] is None and scene["renderer"] == "webgpu", scene
    assert (report.get("webgpu") or {}).get("adapter"), report.get("webgpu")
    assert scene["requests"] > 0
