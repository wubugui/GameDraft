"""Qt 宿主里跑 WebGPU 页面(游戏 / engine2d / RHI 工具页)的唯一口径。

游戏渲染只有 WebGPU(engine2d → RHI,2026-09-25 起没有 WebGL 回落)。任何 Qt 窗口要嵌着播游戏、
或嵌一个用引擎 RHI 画东西的工具页,都走这里,别自己再发明一份。

## 结论(2026-09-27 本机实测 + Qt 源码;PySide6 6.11 / QtWebEngine 6.11 = Chromium 140 / RTX 4070 SUPER / Win10)

1. **QtWebEngine(`QWebEngineView` / `QWebEnginePage`)拿不到 WebGPU,任何开关都救不回来。**
   Qt 编 Chromium 时 gn 参数写死 `use_dawn=false`(qtwebengine `src/core/CMakeLists.txt`,6.11 与 dev 分支
   都是,不分平台),`Qt6WebEngineCore.dll` 里没有 Dawn / Tint(对照:Chrome 的 `chrome.dll` 里有 Dawn 的
   开关名 `lazy_clear_resource_on_first_use` / `skip_validation` 与 Tint 的 `unresolved identifier`,Qt 的 dll
   里一条都没有)。现象:`navigator.gpu` 在,`requestAdapter()` 恒为 null,页面 console 报
   `Failed to create WebGPU Context Provider`;chrome://gpu 上 WebGPU 却写着 "Hardware accelerated"
   (那只是特性开关状态,别被它骗)。真窗口、`QT_QPA_PLATFORM=offscreen` 一样。试过全部无效:
   `--enable-unsafe-webgpu`、`--ignore-gpu-blocklist`、`--enable-features=Vulkan,WebGPUService,SkiaGraphite`、
   `--use-angle=d3d11|vulkan|swiftshader-webgl`、`--use-webgpu-adapter=d3d12|swiftshader`、
   `--enable-unsafe-swiftshader`、`--enable-dawn-features=allow_unsafe_apis`、`--disable-gpu-sandbox --no-sandbox`、
   `QSG_RHI_BACKEND=d3d12|vulkan|opengl`、`AA_ShareOpenGLContexts`。
2. **Qt WebView(`PySide6.QtWebView.QWebView`)能拿到。** 它不带浏览器内核、用系统的:Windows 上是
   WebView2(Edge 的 Chromium,带 Dawn;本机 Edge 135 → `nvidia / lovelace` 适配器,建设备、配画布、出帧都通),
   macOS 上是 WKWebView(Safari 26 起缺省开 WebGPU)。PySide6 6.11 自带 `qtwebview_webview2.dll`,Windows
   缺省就选它(`QT_WEBVIEW_PLUGIN` 不用设)。
3. **QWebView 是原生窗口(`QWindow`)**,要经 `QWidget.createWindowContainer` 嵌进 widget 树——`WebGpuView`
   已包好。`QT_QPA_PLATFORM=offscreen` 下一建就**段错误**(`webgpu_view_available()` 挡在前面,改抛
   RuntimeError);窗口**最小化**时页面停摆(rAF / 定时器都不走);**移到屏幕外(负坐标)的真窗口一切正常**
   ——测试 / 无头自检用 `place_offscreen()`。

## 用法(宿主三件事)

    from tools.qt_webgpu import apply_webgpu_chromium_flags, WebGpuView, probe_webgpu

    apply_webgpu_chromium_flags()            # ① 进程最开始,QApplication / 任何 WebEngine、WebView 对象之前
    app = QApplication(sys.argv)
    view = WebGpuView(parent)                # ② 要跑 WebGPU 的页面一律用它,不用 QWebEngineView
    view.load('http://127.0.0.1:5173/?mode=dev')
    info = probe_webgpu(view)                # ③ 自检 / 测试:{'hasGpu', 'adapter': {'vendor', ...} | None, ...}

与 QWebEngineView 的差别(接这个模块时要知道的):
- `run_js(code, cb)` 的返回值已归一成与 QtWebEngine 相同的形状(数字 / 字符串 / 布尔 / None / dict / list);
  QWebView 原生的 `runJavaScript` 把对象、数组、null 都变成空串,别直接用。
- 没有 console 钩子、没有请求拦截、没有 profile:console 由 `WebGpuView` 在每次载入完成后注入一段捕获脚本、
  定时取回(`consoleMessage` 信号 + 缺省打到 stderr,格式同 `tools/editor/web_engine_page.py`),**载入完成
  之前**的报错(比如模块图断掉)抓不到——要从第一行起抓,由供页的一方把 `CONSOLE_CAPTURE_JS` 放进页面
  (`tools/build/scene_sweep.py` 的记录代理就是这么做的);请求记录同理走代理。
- 键盘焦点:Qt 的 WebView2 插件给 QWebView 打了 `WindowDoesNotAcceptFocus`、也不调 `MoveFocus`,Qt 层的
  setFocus / requestActivate 进不了网页(实测按键一个都收不到)。`WebGpuView` 在容器拿到 Qt 焦点时改用 Win32
  `SetFocus` 把焦点交给本进程里 WebView2 的 `Chrome_WidgetWin_*` 子窗口(实测可用;鼠标点进画面也行)。
  焦点在网页里时,宿主窗口的 QShortcut 收不到键(原生子窗口吞掉);F12 开的是 Edge DevTools。
- 可见性:在隐藏状态下建出来的 WebView2 永远认为自己不可见(visibilityState=hidden、rAF 停),之后再显示也不行
  (Qt 插件从不调 `put_IsVisible`)。`WebGpuView` 因此在**第一次显示时**才建底下的 QWebView;可见时建出来的
  一直是 visible(切走页签、最小化都不降级)。
- DPI:WebView2 按系统 DPI × Windows「文字大小」缩放算 `devicePixelRatio`(本机页面 1.24、Qt 这边 1.0),同样大
  的窗口 CSS 空间比 QtWebEngine 小;CSS px ↔ 屏幕像素换算用 `page_device_pixel_ratio()`(原生输入已处理)。
- 用户激活:宿主经 `run_js` 执行脚本(WebView2 的 ExecuteScript)本身算一次用户激活,还会传给同源子框架——
  页面里 `navigator.userActivation.hasBeenActive` 恒为 true,别拿它判"没点过"。
- 进程退出:WebView2 要在 QApplication 析构**之前**拆掉,否则退出时 access violation。第一个 `WebGpuView`
  建起来时已把 `release_all_webgpu_views` 挂到 `aboutToQuit`;不走 `app.exec()` 的脚本自己调 `release_webgpu_view`。
- 缓存:WebView2 的用户数据目录由本模块钉成**每进程一个新的临时目录**(永不复用,坏缓存喂不回来;退出时尽力删,
  WebView2 子进程还没退删不掉的,由下一个宿主进程启动时清掉),外加与
  `tools/webengine_cache_policy.py` 同一份禁缓存开关——满足"桌面窗口一律不留缓存"(见该模块)。
"""
from __future__ import annotations

import atexit
import json
import os
import shutil
import sys
import tempfile
import uuid
import weakref
from pathlib import Path
from typing import Any, Callable, Iterable

from tools.webengine_cache_policy import NO_CACHE_CHROMIUM_FLAGS

#: QtWebEngine 用的环境变量(只在 WebEngine 初始化时读一次)。
QTWEBENGINE_FLAGS_ENV = "QTWEBENGINE_CHROMIUM_FLAGS"
#: WebView2 读的环境变量(在第一个 WebView2 环境建起来时读一次)。
WEBVIEW2_ARGS_ENV = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"
WEBVIEW2_USER_DATA_ENV = "WEBVIEW2_USER_DATA_FOLDER"

#: 放开 WebGPU 的 Chromium 开关。QtWebEngine 吃了也没用(没有 Dawn,见模块头),照样并进去:
#: 哪天 Qt 发了带 Dawn 的构建,老宿主不改代码就亮;WebView2 里 WebGPU 本来就开着,这两条管黑名单驱动。
WEBGPU_CHROMIUM_FLAGS: tuple[str, ...] = (
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
)

#: 游戏宿主的"这是游戏,不是网页"开关(与 `tools/dev/game_preview.py` 同口径,制作人 2026-09-08 定):
#: 音频不等手势;没焦点 / 被盖住不降级(rAF、定时器、音频调度全速)。
GAME_HOST_CHROMIUM_FLAGS: tuple[str, ...] = (
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=IntensiveWakeUpThrottling,CalculateNativeWinOcclusion",
)

#: WebView2 额外的禁缓存开关(QtWebEngine 那边由 profile 的 NoCache 管,WebView2 没有 profile 可设)。
WEBVIEW2_NO_CACHE_FLAGS: tuple[str, ...] = (*NO_CACHE_CHROMIUM_FLAGS, "--disable-http-cache")

#: ``WebGpuView`` 里页面的 User-Agent 末尾追加的标记。游戏据此认出"这是桌面工具宿主"(编辑器预览 / 工作台 /
#: 打包验收扫描),触屏判据一律出桌面 UI(``src/ui/TouchMobileControls.ts`` 的 ``decideTouchUi``)——与 QtWebEngine
#: 时代认 ``QtWebEngine`` UA 同一口径。不加的话,在带触摸数字化仪、屏幕短边 ≤ 820 CSS px 的机器上(本机就是)
#: 宿主里会出一整套触屏 HUD,打包扫描请求到的资源也跟发行版桌面 UI 不一样。
HOST_UA_TOKEN = "GameDraftQtHost/1"

_LIST_SWITCHES = ("--enable-features", "--disable-features", "--enable-blink-features", "--disable-blink-features")

_state: dict[str, Any] = {"user_data_dir": None, "applied": False, "quit_hooked": False}
#: 还活着的 WebGpuView(退出前统一同步拆掉,见 release_all_webgpu_views)
_LIVE_VIEWS: "weakref.WeakSet" = weakref.WeakSet()


# ---------------------------------------------------------------------------
# 环境(纯函数 + 环境变量;不碰 Qt)
# ---------------------------------------------------------------------------

def merge_chromium_switches(existing: str, extra: Iterable[str]) -> str:
    """把 ``extra`` 并进一串 Chromium 命令行开关,返回新串。**并,不覆盖**:

    - ``--enable-features=`` / ``--disable-features=`` 这类列表开关取并集、合成一条——Chromium 同名开关只认
      最后一条,两条并排会静默吃掉前一条;
    - 其它 ``--name=value``:已有同名的保留已有的(用户 / 别的宿主显式设过的值优先);
    - 无值开关:已有就不重复。
    """
    tokens = [t for t in existing.split() if t]
    lists: dict[str, list[str]] = {}
    order: list[str] = []
    for tok in [*tokens, *extra]:
        name, sep, value = tok.partition("=")
        if name in _LIST_SWITCHES and sep:
            items = lists.setdefault(name, [])
            if name not in order:
                order.append(name)
            for item in value.split(","):
                if item and item not in items:
                    items.append(item)
            continue
        if tok in order:
            continue
        if sep and any(o.partition("=")[0] == name for o in order):
            continue
        order.append(tok)
    out = [f"{t}={','.join(lists[t])}" if t in lists else t for t in order]
    return " ".join(out)


def _pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        k32.OpenProcess.restype = wintypes.HANDLE
        k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        handle = k32.OpenProcess(0x1000, False, pid)            # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() == 5                 # ERROR_ACCESS_DENIED = 活着、只是不让看
        try:
            code = wintypes.DWORD()
            if not k32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == 259                            # STILL_ACTIVE
        finally:
            k32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _user_data_root() -> Path:
    return Path(tempfile.gettempdir()) / "gamedraft-webview2"


def _purge_stale_user_data(root: Path) -> None:
    """删掉已经退出的进程留下的 WebView2 用户数据目录(目录名 ``<pid>-<随机>``)。

    进程还活着的一个不碰(删一半会弄坏正在跑的 WebView2);pid 被复用的误判只会让目录多留一轮。
    """
    if not root.is_dir():
        return
    for child in root.iterdir():
        pid_text = child.name.split("-", 1)[0]
        if not child.is_dir() or not pid_text.isdigit() or _pid_alive(int(pid_text)):
            continue
        shutil.rmtree(child, ignore_errors=True)


def webview2_user_data_dir() -> Path | None:
    """本进程 WebView2 用户数据目录(``apply_webgpu_chromium_flags`` 之后才有;外部显式设过则为那一个)。"""
    explicit = os.environ.get(WEBVIEW2_USER_DATA_ENV)
    return Path(explicit) if explicit else _state["user_data_dir"]


def apply_webgpu_chromium_flags() -> None:
    """让本进程里的 Qt 网页视图能跑 WebGPU 页面。**必须在 QApplication 与任何 WebEngine / WebView 对象之前调用。**

    做三件事,全是**并进**已有环境变量、不覆盖(各宿主自己的开关、用户显式设的值都保留),重复调用幂等:

    1. ``QTWEBENGINE_CHROMIUM_FLAGS`` 并进 ``WEBGPU_CHROMIUM_FLAGS``。⚠ 这**不会**让 QWebEngineView 拿到 WebGPU
       (QtWebEngine 没编 Dawn,见模块头),只是给将来带 Dawn 的 Qt 构建留好开关;要跑 WebGPU 用 ``WebGpuView``。
    2. ``WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`` 并进 WebGPU + 游戏宿主(免手势音频、不后台降级)+ 禁缓存开关——
       ``WebGpuView``(Windows 上是 WebView2)吃这一份。
    3. ``WEBVIEW2_USER_DATA_FOLDER`` 没设过就指到每进程一个新的临时目录(退出时尽力删;顺手清掉已退出进程的残留)——
       WebView2 不设的话会在 ``%LOCALAPPDATA%/python/WebView2`` 落一份常驻 profile(含 HTTP / shader 缓存),
       违反"桌面窗口一律不留缓存"。
    """
    os.environ[QTWEBENGINE_FLAGS_ENV] = merge_chromium_switches(
        os.environ.get(QTWEBENGINE_FLAGS_ENV, ""), WEBGPU_CHROMIUM_FLAGS)
    os.environ[WEBVIEW2_ARGS_ENV] = merge_chromium_switches(
        os.environ.get(WEBVIEW2_ARGS_ENV, ""),
        (*WEBGPU_CHROMIUM_FLAGS, *GAME_HOST_CHROMIUM_FLAGS, *WEBVIEW2_NO_CACHE_FLAGS))
    if not os.environ.get(WEBVIEW2_USER_DATA_ENV) and _state["user_data_dir"] is None:
        root = _user_data_root()
        _purge_stale_user_data(root)
        folder = root / f"{os.getpid()}-{uuid.uuid4().hex[:8]}"
        folder.mkdir(parents=True, exist_ok=True)
        _state["user_data_dir"] = folder
        atexit.register(shutil.rmtree, folder, True)
    if _state["user_data_dir"] is not None:
        os.environ[WEBVIEW2_USER_DATA_ENV] = str(_state["user_data_dir"])
    _state["applied"] = True


# ---------------------------------------------------------------------------
# 页内脚本
# ---------------------------------------------------------------------------

#: 页内 console 捕获:console.error / warn、未捕获异常、未处理的 rejection、资源加载失败,进 ``window.__qtConsole``
#: 的环形缓冲(上限 500 条),``window.__qtConsole.drain()`` 取走(JSON 串:``[[level, message, source, line], ...]``)。
#: 幂等;可由宿主载入后注入,也可由供页方放进 ``<head>`` 最前面从第一行抓起。
CONSOLE_CAPTURE_JS = r"""(function(){
  if (window.__qtConsole) return;
  var buf = [], MAX = 500, dropped = 0;
  function text(a){
    try {
      if (a instanceof Error) return a.stack || String(a);
      if (a && typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
      return String(a);
    } catch (e) { return '?'; }
  }
  function push(level, message, source, line){
    if (buf.length >= MAX) { dropped++; return; }
    buf.push([level, String(message), String(source || ''), Number(line) || 0]);
  }
  ['error', 'warn'].forEach(function(level){
    var orig = console[level];
    console[level] = function(){
      try { push(level, Array.prototype.map.call(arguments, text).join(' ')); } catch (e) {}
      return orig.apply(this, arguments);
    };
  });
  window.addEventListener('error', function(e){
    var t = e && e.target;
    if (t && t !== window && (t.src || t.href)) { push('error', 'Failed to load resource: ' + (t.src || t.href)); return; }
    push('error', 'Uncaught ' + ((e && e.error && e.error.stack) || (e && e.message) || 'error'), e && e.filename, e && e.lineno);
  }, true);
  window.addEventListener('unhandledrejection', function(e){
    var r = e && e.reason;
    push('error', 'Uncaught (in promise) ' + ((r && (r.stack || r.message)) || String(r)));
  });
  window.__qtConsole = { drain: function(){
    var out = buf; buf = [];
    if (dropped) { out.push(['warn', '[qt-console] 缓冲满,丢了 ' + dropped + ' 条', '', 0]); dropped = 0; }
    return JSON.stringify(out);
  } };
})();"""

_CONSOLE_DRAIN_JS = "window.__qtConsole ? window.__qtConsole.drain() : ''"


def webgpu_probe_start_js(with_device: bool = True) -> str:
    """开始一次适配器探测(异步),结果落在 ``window.__qtWebgpuProbe``(JSON 串;在途时是 ``'pending'``)。"""
    device = "true" if with_device else "false"
    return """(function(){
  var cur = window.__qtWebgpuProbe;
  if (cur === 'pending') return 'pending';
  window.__qtWebgpuProbe = 'pending';
  (async function(){
    var r = { hasGpu: !!navigator.gpu, secureContext: !!window.isSecureContext, userAgent: navigator.userAgent, adapter: null };
    try {
      if (navigator.gpu) {
        var a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (a) {
          var i = a.info || {};
          r.adapter = { vendor: String(i.vendor || ''), architecture: String(i.architecture || ''),
                        device: String(i.device || ''), description: String(i.description || ''),
                        isFallbackAdapter: !!(a.isFallbackAdapter || i.isFallbackAdapter) };
          if (%s) {
            var d = await a.requestDevice();
            r.deviceOk = !!d;
            if (d) d.destroy();
          }
        }
      }
    } catch (e) { r.error = String((e && e.message) || e); }
    window.__qtWebgpuProbe = JSON.stringify(r);
  })();
  return 'started';
})()""" % device


WEBGPU_PROBE_RESULT_JS = "(function(){ var v = window.__qtWebgpuProbe; return typeof v === 'string' ? v : ''; })()"


def parse_probe_result(raw: object) -> dict | None:
    """``window.__qtWebgpuProbe`` 的值 → dict;还没出结果(空 / pending)返回 None。"""
    if not isinstance(raw, str) or not raw or raw == "pending":
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return {"hasGpu": None, "adapter": None, "error": f"探测结果不是 JSON:{raw[:200]}"}
    return data if isinstance(data, dict) else None


def is_hardware_adapter(result: dict | None) -> bool:
    """探测结果里拿到的是不是**硬件**适配器(不是 SwiftShader / 软件回落)。"""
    adapter = (result or {}).get("adapter")
    if not isinstance(adapter, dict) or adapter.get("isFallbackAdapter"):
        return False
    blob = " ".join(str(adapter.get(k, "")) for k in ("vendor", "architecture", "description")).lower()
    return "swiftshader" not in blob and "microsoft basic" not in blob


def describe_probe(result: dict | None) -> str:
    """一行人话,给日志 / 报错用。"""
    if not result:
        return "WebGPU 探测没出结果(页面没跑到 / 超时)"
    if result.get("error"):
        return f"WebGPU 探测出错:{result['error']}"
    if not result.get("hasGpu"):
        return "没有 navigator.gpu(不是安全上下文,或这个浏览器内核没开 WebGPU)"
    adapter = result.get("adapter")
    if not adapter:
        return ("navigator.gpu 在但 requestAdapter() 返回 null——QtWebEngine 就是这样(没编 Dawn),"
                "换 tools.qt_webgpu.WebGpuView")
    kind = "硬件" if is_hardware_adapter(result) else "软件/回落"
    name = " / ".join(x for x in (adapter.get("vendor"), adapter.get("architecture"), adapter.get("description")) if x)
    dev = "" if "deviceOk" not in result else ("，建设备成功" if result.get("deviceOk") else "，建设备失败")
    return f"WebGPU {kind}适配器:{name or '(无描述)'}{dev}"


def normalize_js_script(code: str) -> str:
    """把任意一段脚本包成"返回 JSON 串"的表达式,让 QWebView 的返回值能还原成 QtWebEngine 那样的形状。

    用间接 eval 在全局作用域跑(``var`` 仍是全局变量、返回值 = 脚本的完成值,与 ``runJavaScript`` 语义一致)。
    """
    return (
        "(function(){try{var __v=(0,eval)(" + json.dumps(code) + ");"
        "if(__v===undefined)return '{\"u\":1}';"
        "if(__v&&typeof __v.then==='function')return '{\"v\":{}}';"
        "return JSON.stringify({v:__v});}"
        "catch(e){try{return JSON.stringify({e:String((e&&e.message)||e)});}catch(_){return '{\"e\":\"?\"}';}}})()"
    )


def decode_normalized_result(raw: object) -> object:
    """``normalize_js_script`` 包过的脚本的返回值 → Python 值(undefined / null / 抛异常都是 None)。"""
    if not isinstance(raw, str) or not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data.get("v")


# ---------------------------------------------------------------------------
# Qt 部分
# ---------------------------------------------------------------------------

def webgpu_view_available() -> bool:
    """当前进程能不能建 ``WebGpuView``:装了 QtWebView,且平台插件是真窗口系统(离屏下 QWebView 一建就段错误)。"""
    try:
        import PySide6.QtWebView  # noqa: F401
        from PySide6.QtGui import QGuiApplication
    except ImportError:
        return False
    platform = QGuiApplication.platformName() if QGuiApplication.instance() else os.environ.get("QT_QPA_PLATFORM", "")
    return platform.split(":", 1)[0].lower() not in ("offscreen", "minimal", "vnc")


def _js_runner(target) -> Callable[[str, Callable[[object], None]], None]:
    """把 WebGpuView / QWebView / QWebEngineView / QWebEnginePage 统一成 ``run(code, callback)``(返回值已归一)。"""
    if callable(getattr(target, "run_js", None)) and hasattr(target, "run_js_raw"):
        return target.run_js
    page = target.page() if callable(getattr(target, "page", None)) else target
    run = getattr(page, "runJavaScript", None)
    if run is None:
        raise TypeError(f"{type(target).__name__} 不能跑页内脚本")
    if type(page).__name__ == "QWebView" or page.__class__.__module__.startswith("PySide6.QtWebView"):
        return lambda code, cb: run(normalize_js_script(code), lambda raw: cb(decode_normalized_result(raw)))

    def engine_run(code: str, cb) -> None:
        try:
            run(code, 0, cb)
        except TypeError:
            run(code, cb)
    return engine_run


def probe_webgpu(target, timeout_s: float = 20.0, *, with_device: bool = True) -> dict | None:
    """在 ``target`` 当前页面里探测 ``navigator.gpu.requestAdapter()``,**阻塞**到出结果或超时(转 Qt 事件循环)。

    ``target`` 可以是 ``WebGpuView`` / ``QWebView`` / ``QWebEngineView`` / ``QWebEnginePage``。
    返回 ``{'hasGpu', 'secureContext', 'userAgent', 'adapter': {'vendor','architecture','device','description',
    'isFallbackAdapter'} | None, 'deviceOk'?, 'error'?}``;超时返回 None。页面要先载入完成(同源安全上下文:
    http://127.0.0.1 / localhost / https)。配套:``is_hardware_adapter`` / ``describe_probe``。
    """
    from PySide6.QtCore import QEventLoop, QTimer
    import time

    run = _js_runner(target)
    run(webgpu_probe_start_js(with_device), lambda _v: None)
    deadline = time.monotonic() + timeout_s
    box: dict[str, Any] = {}
    while time.monotonic() < deadline:
        loop = QEventLoop()

        def got(value, loop=loop) -> None:
            box["v"] = value
            loop.quit()
        run(WEBGPU_PROBE_RESULT_JS, got)
        QTimer.singleShot(1000, loop.quit)
        loop.exec()
        result = parse_probe_result(box.pop("v", None))
        if result is not None:
            return result
        pause = QEventLoop()
        QTimer.singleShot(150, pause.quit)
        pause.exec()
    return None


def _settle(settle_ms: int) -> None:
    """转一小会儿事件(不用嵌套 QEventLoop:在 aboutToQuit 里主循环已经在退出,processEvents 仍然有效)。"""
    import time
    from PySide6.QtCore import QCoreApplication

    deadline = time.monotonic() + max(1, settle_ms) / 1000
    while time.monotonic() < deadline:
        QCoreApplication.processEvents()
        time.sleep(0.01)


def release_webgpu_view(view, settle_ms: int = 400) -> None:
    """**同步**拆掉一个 ``WebGpuView``(连同底下的 WebView2),再转一小会儿事件让它收完尾。

    只 ``close()`` / ``deleteLater()`` 的话,视图留到解释器退出、QApplication 析构之后才被拆,WebView2 的原生线程
    在那时回调进已经没了的对象——进程以 ``Windows fatal exception: access violation`` 退出(2026-09-27 实测:
    扫描报告已写完、退出码却变成崩溃码,编排脚本据此判失败)。跑 ``app.exec()`` 的宿主不用自己调:第一个
    WebGpuView 建起来时已把 ``release_all_webgpu_views`` 挂到 ``aboutToQuit`` 上;不走 ``app.exec()`` 的脚本式宿主
    (扫描、自检)收尾时自己调。
    """
    import shiboken6

    if view is None or not shiboken6.isValid(view):
        return
    view.hide()
    shiboken6.delete(view)
    _settle(settle_ms)


def release_all_webgpu_views(settle_ms: int = 400) -> None:
    """同步拆掉本进程里所有还活着的 ``WebGpuView``(挂在 ``aboutToQuit`` 上,见 ``release_webgpu_view``)。"""
    import shiboken6

    views = [v for v in list(_LIVE_VIEWS) if shiboken6.isValid(v)]
    for v in views:
        v.hide()
        shiboken6.delete(v)
    if views:
        _settle(settle_ms)


# ---------------------------------------------------------------------------
# 原生输入(Windows):自检给 WebGpuView 里的网页发"真"鼠标 / 键盘事件
# ---------------------------------------------------------------------------
#
# QtWebEngine 时代自检用 QTest 往 view.focusProxy() 发事件;WebView2 是另一个进程的原生窗口,Qt 事件进不去,
# 只能走系统输入队列(SendInput)——**会真动鼠标**,窗口要在最前、目标位置没被别的窗口挡住(自检时置顶)。
# 坐标一律是网页视图里的 CSS px(即页面里 getBoundingClientRect 的值);换算用页面自己的 devicePixelRatio。

_VK_NAMES = {
    "Tab": 0x09, "Return": 0x0D, "Enter": 0x0D, "Escape": 0x1B, "Space": 0x20, "Backspace": 0x08,
    "Delete": 0x2E, "Left": 0x25, "Up": 0x26, "Right": 0x27, "Down": 0x28, "Home": 0x24, "End": 0x23,
    "Shift": 0x10, "Control": 0x11, "Ctrl": 0x11, "Alt": 0x12,
}


def native_input_supported() -> bool:
    return sys.platform == "win32"


def _vk(key: str) -> int:
    if key in _VK_NAMES:
        return _VK_NAMES[key]
    if len(key) == 1 and key.isalnum():
        return ord(key.upper())
    if key.startswith("F") and key[1:].isdigit():
        return 0x6F + int(key[1:])
    raise ValueError(f"不认识的键名:{key}")


def _send_inputs(items: list) -> None:
    import ctypes
    from ctypes import wintypes

    class _Mouse(ctypes.Structure):
        _fields_ = [("dx", wintypes.LONG), ("dy", wintypes.LONG), ("mouseData", wintypes.DWORD),
                    ("dwFlags", wintypes.DWORD), ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

    class _Key(ctypes.Structure):
        _fields_ = [("wVk", wintypes.WORD), ("wScan", wintypes.WORD), ("dwFlags", wintypes.DWORD),
                    ("time", wintypes.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

    class _Union(ctypes.Union):
        _fields_ = [("mi", _Mouse), ("ki", _Key), ("pad", ctypes.c_byte * 32)]

    class _Input(ctypes.Structure):
        _fields_ = [("type", wintypes.DWORD), ("u", _Union)]

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    arr = (_Input * len(items))()
    for i, (kind, data) in enumerate(items):
        if kind == "mouse":
            arr[i].type = 0
            arr[i].u.mi = _Mouse(data[0], data[1], 0, data[2], 0, 0)
        else:
            arr[i].type = 1
            arr[i].u.ki = _Key(data[0], data[1], data[2], 0, 0)
    user32.SendInput(len(items), arr, ctypes.sizeof(_Input))


def _abs_coords(x: int, y: int) -> tuple[int, int]:
    import ctypes
    user32 = ctypes.WinDLL("user32")
    vx, vy = user32.GetSystemMetrics(76), user32.GetSystemMetrics(77)      # SM_X/YVIRTUALSCREEN
    vw, vh = user32.GetSystemMetrics(78), user32.GetSystemMetrics(79)      # SM_CX/CYVIRTUALSCREEN
    return (round((x - vx) * 65535 / max(1, vw - 1)), round((y - vy) * 65535 / max(1, vh - 1)))


def _screen_point(view, x: float, y: float) -> tuple[int, int]:
    import ctypes
    from ctypes import wintypes
    from PySide6.QtCore import QPoint

    container = view.native_container() or view
    top = container.window()
    origin = container.mapTo(top, QPoint(0, 0))
    qt_dpr = top.devicePixelRatioF()
    # 页面坐标是 CSS px,换物理像素要用**页面**的 devicePixelRatio:WebView2 按系统 DPI 缩放(本机 1.24),
    # Qt 进程这边可能是 1.0——两者不等时拿 Qt 的比例换会点偏(实测点 100,50 落到 80,40)
    page_dpr = view.page_device_pixel_ratio() if hasattr(view, "page_device_pixel_ratio") else qt_dpr
    pt = wintypes.POINT(round(origin.x() * qt_dpr + x * page_dpr), round(origin.y() * qt_dpr + y * page_dpr))
    ctypes.WinDLL("user32").ClientToScreen(wintypes.HWND(int(top.winId())), ctypes.byref(pt))
    return pt.x, pt.y


_MOVE_ABS = 0x0001 | 0x8000 | 0x4000        # MOVE | ABSOLUTE | VIRTUALDESK
_BUTTONS = {"left": (0x0002, 0x0004), "right": (0x0008, 0x0010), "middle": (0x0020, 0x0040)}


def bring_to_foreground(widget, tries: int = 5) -> bool:
    """Windows:把 ``widget`` 所在顶层窗口提成**系统**前台窗口,返回是否成功。

    原生键盘输入只进系统前台窗口;Qt 的 ``activateWindow()`` 在别的进程占着前台时只会闪任务栏
    (``QApplication.activeWindow()`` 却照样说是自己——2026-09-27 实测前台被一个 GameInputServiceWindow 占着,
    按键全丢)。这里挂到前台线程的输入队列上再 SetForegroundWindow,并先发一个无害按键(F24)满足前台锁
    "最近一次输入归本进程"的条件。
    """
    import ctypes
    import time
    from ctypes import wintypes

    if not native_input_supported():
        return False
    user32 = ctypes.WinDLL("user32")
    kernel32 = ctypes.WinDLL("kernel32")
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.c_void_p)
    hwnd = int(widget.window().winId())
    for _ in range(max(1, tries)):
        fg = user32.GetForegroundWindow() or 0
        if int(fg) == hwnd:
            return True
        fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
        me = kernel32.GetCurrentThreadId()
        attached = bool(fg_tid) and fg_tid != me and bool(user32.AttachThreadInput(me, fg_tid, True))
        try:
            _send_inputs([("key", (0x87, 0, 0)), ("key", (0x87, 0, 0x0002))])      # VK_F24 按下 / 抬起
            user32.ShowWindow(wintypes.HWND(hwnd), 5)                                 # SW_SHOW
            user32.BringWindowToTop(wintypes.HWND(hwnd))
            user32.SetForegroundWindow(wintypes.HWND(hwnd))
        finally:
            if attached:
                user32.AttachThreadInput(me, fg_tid, False)
        time.sleep(0.1)
    return int(user32.GetForegroundWindow() or 0) == hwnd


def native_mouse(view, x: float, y: float, action: str = "click", button: str = "left") -> None:
    """在网页视图的 (x, y) 处发原生鼠标事件。``action``:``move`` / ``press`` / ``release`` / ``click``。"""
    if not native_input_supported():
        raise RuntimeError("原生输入只在 Windows 上实现")
    ax, ay = _abs_coords(*_screen_point(view, x, y))
    down, up = _BUTTONS[button]
    items = [("mouse", (ax, ay, _MOVE_ABS))]
    if action in ("press", "click"):
        items.append(("mouse", (ax, ay, _MOVE_ABS | down)))
    if action in ("release", "click"):
        items.append(("mouse", (ax, ay, _MOVE_ABS | up)))
    _send_inputs(items)


def native_key(key: str, *, modifiers: tuple[str, ...] = ()) -> None:
    """发一次原生按键(按下 + 抬起),可带修饰键,如 ``native_key('A', modifiers=('Ctrl',))``。发给当前焦点窗口。"""
    import ctypes
    if not native_input_supported():
        raise RuntimeError("原生输入只在 Windows 上实现")
    user32 = ctypes.WinDLL("user32")

    def key_event(vk: int, up: bool):
        scan = user32.MapVirtualKeyW(vk, 0)    # Chromium 的 KeyboardEvent.code 由扫描码推出,不给就是空串
        ext = 0x0001 if vk in (0x25, 0x26, 0x27, 0x28, 0x2E, 0x24, 0x23) else 0
        return ("key", (vk, scan, ext | (0x0002 if up else 0)))

    mods = [_vk(m) for m in modifiers]
    vk = _vk(key)
    _send_inputs([key_event(m, False) for m in mods] + [key_event(vk, False), key_event(vk, True)]
                 + [key_event(m, True) for m in reversed(mods)])


def native_type(text: str) -> None:
    """按 Unicode 逐字发原生键盘输入(中文也行)。发给当前焦点窗口。"""
    if not native_input_supported():
        raise RuntimeError("原生输入只在 Windows 上实现")
    items = []
    data = text.encode("utf-16-le")
    for i in range(0, len(data), 2):                         # UTF-16 码元(代理对拆成两个,系统会拼回去)
        code = int.from_bytes(data[i:i + 2], "little")
        items.append(("key", (0, code, 0x0004)))            # KEYEVENTF_UNICODE
        items.append(("key", (0, code, 0x0004 | 0x0002)))
    if items:
        _send_inputs(items)


def place_offscreen(widget) -> None:
    """把顶层窗口挪到所有屏幕之外(真窗口、不最小化):测试 / 无头自检用。

    WebView2 在最小化 / 隐藏的窗口里停摆;挪到虚拟桌面外面的窗口照常渲染、rAF 照常走(2026-09-27 实测)。
    """
    from PySide6.QtGui import QGuiApplication

    top = widget.window()
    screens = QGuiApplication.screens()
    left = min((s.geometry().left() for s in screens), default=0)
    upper = min((s.geometry().top() for s in screens), default=0)
    top.move(left - top.width() - 400, upper - top.height() - 400)


def _focus_webview2_child(host_hwnd: int) -> bool:
    """Windows:把键盘焦点交给 ``host_hwnd``(QWebView 的原生窗口)底下、本进程所有的 WebView2 子窗口。

    WebView2 的 ``ICoreWebView2Controller::MoveFocus`` 做的也是这件事;Qt 插件不调它,这里用 Win32 补上。
    跨进程的那几层(``Chrome_RenderWidgetHostHWND`` 等)不碰——SetFocus 只对本线程输入队列的窗口有效。
    """
    if sys.platform != "win32" or not host_hwnd:
        return False
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    found: list[int] = []
    pid = os.getpid()
    enum_proc = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)

    def visit(hwnd, _lparam):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        name = ctypes.create_unicode_buffer(64)
        user32.GetClassNameW(hwnd, name, 64)
        if owner.value == pid and name.value.startswith("Chrome_WidgetWin"):
            found.append(int(hwnd))
            return False
        return True

    user32.EnumChildWindows(wintypes.HWND(host_hwnd), enum_proc(visit), 0)
    if not found:
        return False
    user32.SetFocus.argtypes = (wintypes.HWND,)
    return bool(user32.SetFocus(found[0]))


def _print_window(hwnd: int):
    """Windows:``PrintWindow(PW_RENDERFULLCONTENT)`` 截一个原生窗口 → QImage(失败 None)。

    经 DWM 取窗口自己的内容:WebView2 的 WebGPU 画面截得到,被别的窗口挡住、挪到屏幕外也截得到
    (2026-09-27 实测;屏幕截图在多人共用的机器上会截到盖在上面的别的窗口)。
    """
    if sys.platform != "win32" or not hwnd:
        return None
    import ctypes
    from ctypes import wintypes
    from PySide6.QtGui import QImage

    user32 = ctypes.WinDLL("user32")
    gdi32 = ctypes.WinDLL("gdi32")
    user32.GetDC.restype = wintypes.HDC
    gdi32.CreateCompatibleDC.restype = wintypes.HDC
    gdi32.CreateCompatibleBitmap.restype = wintypes.HBITMAP
    gdi32.CreateCompatibleDC.argtypes = (wintypes.HDC,)
    gdi32.CreateCompatibleBitmap.argtypes = (wintypes.HDC, ctypes.c_int, ctypes.c_int)
    gdi32.SelectObject.argtypes = (wintypes.HDC, wintypes.HGDIOBJ)
    gdi32.DeleteObject.argtypes = (wintypes.HGDIOBJ,)
    gdi32.DeleteDC.argtypes = (wintypes.HDC,)
    user32.ReleaseDC.argtypes = (wintypes.HWND, wintypes.HDC)
    user32.PrintWindow.argtypes = (wintypes.HWND, wintypes.HDC, wintypes.UINT)
    gdi32.GetDIBits.argtypes = (wintypes.HDC, wintypes.HBITMAP, wintypes.UINT, wintypes.UINT,
                                ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT)

    class _Bih(ctypes.Structure):
        _fields_ = [("biSize", wintypes.DWORD), ("biWidth", wintypes.LONG), ("biHeight", wintypes.LONG),
                    ("biPlanes", wintypes.WORD), ("biBitCount", wintypes.WORD), ("biCompression", wintypes.DWORD),
                    ("biSizeImage", wintypes.DWORD), ("biXPelsPerMeter", wintypes.LONG),
                    ("biYPelsPerMeter", wintypes.LONG), ("biClrUsed", wintypes.DWORD), ("biClrImportant", wintypes.DWORD)]

    rect = wintypes.RECT()
    user32.GetWindowRect(wintypes.HWND(hwnd), ctypes.byref(rect))
    w, h = rect.right - rect.left, rect.bottom - rect.top
    if w <= 0 or h <= 0:
        return None
    screen_dc = user32.GetDC(None)
    mem_dc = gdi32.CreateCompatibleDC(screen_dc)
    bmp = gdi32.CreateCompatibleBitmap(screen_dc, w, h)
    try:
        gdi32.SelectObject(mem_dc, bmp)
        if not user32.PrintWindow(wintypes.HWND(hwnd), mem_dc, 2):        # PW_RENDERFULLCONTENT
            return None
        bih = _Bih(ctypes.sizeof(_Bih), w, -h, 1, 32, 0, 0, 0, 0, 0, 0)
        buf = ctypes.create_string_buffer(w * h * 4)
        if not gdi32.GetDIBits(mem_dc, bmp, 0, h, buf, ctypes.byref(bih), 0):
            return None
        return QImage(buf.raw, w, h, w * 4, QImage.Format.Format_RGB32).copy()
    finally:
        gdi32.DeleteObject(bmp)
        gdi32.DeleteDC(mem_dc)
        user32.ReleaseDC(None, screen_dc)


try:
    from PySide6.QtCore import QEvent, QPoint, Qt, QTimer, QUrl, Signal
    from PySide6.QtWidgets import QVBoxLayout, QWidget
except ImportError:  # pragma: no cover - 没装 PySide6 时只剩纯函数可用
    QWidget = None  # type: ignore[assignment,misc]


if QWidget is not None:

    class WebGpuView(QWidget):
        """能跑 WebGPU 的网页视图(Windows = WebView2,macOS = WKWebView),接口照 QWebEngineView 的常用子集。

        信号:``loadStarted()`` / ``loadFinished(bool)`` / ``titleChanged(str)`` / ``urlChanged(QUrl)`` /
        ``consoleMessage(level, message, source, line)``(level 为 ``'error'`` / ``'warn'``)。
        ``forward_console=True``(缺省)时页内 error / warn 同时打到 stderr:``js:error: <msg>  @<src>:<line>``,
        与编辑器 ``QuietWebEnginePage`` 同格式(dev_console 收的是 stderr)。

        ⚠ 底下的 QWebView **第一次显示时才建**:在隐藏状态下(编辑器没切到的页签、还没 show 的窗口)建出来的
        WebView2 永远认为自己不可见——``document.visibilityState`` 一直是 hidden、rAF 不走,之后再显示也救不回来
        (Qt 的 WebView2 插件从不调 ``put_IsVisible``;2026-09-27 实测)。可见时建出来的则一直是 visible
        (切走 / 最小化也不降级,正合"这是游戏不是网页")。所以建之前的 ``load`` / ``set_html`` 排队、``run_js``
        的回调拿到 None;``webview()`` / ``native_container()`` 在那之前是 None。

        没 ``apply_webgpu_chromium_flags()`` 过就建,会在这里补调一次——但那时 QtWebEngine 可能已经初始化,
        宿主入口仍应在最开始自己调。离屏平台下建它抛 RuntimeError(QWebView 在离屏下会段错误)。
        """

        loadStarted = Signal()
        loadFinished = Signal(bool)
        titleChanged = Signal(str)
        urlChanged = Signal(QUrl)
        consoleMessage = Signal(str, str, str, int)

        #: 取 console 缓冲的节奏(毫秒)
        CONSOLE_POLL_MS = 400

        #: 启动期等 WebView2 起来、换好 User-Agent 的上限(毫秒);超时就不带标记直接导航
        UA_BOOT_TIMEOUT_MS = 8000

        def __init__(self, parent=None, *, forward_console: bool = True) -> None:
            if not webgpu_view_available():
                raise RuntimeError("WebGpuView 需要真窗口平台与 PySide6.QtWebView(离屏平台下 QWebView 会段错误)")
            if not _state["applied"]:
                apply_webgpu_chromium_flags()

            super().__init__(parent)
            self._forward_console = forward_console
            self._loaded = False
            self._draining = False
            self._page_dpr: float | None = None
            self._wv = None
            self._container = None
            self._layout = QVBoxLayout(self)
            self._layout.setContentsMargins(0, 0, 0, 0)
            self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
            self._console_timer = QTimer(self)
            self._console_timer.setInterval(self.CONSOLE_POLL_MS)
            self._console_timer.timeout.connect(self._drain_console)
            # User-Agent 要追加 HOST_UA_TOKEN,但 WebView2 起来之前拿不到它的缺省 UA(httpUserAgentString() 是空串):
            # 建好后先载一张空页把 WebView2 叫起来,读到缺省 UA、换好,再放行调用方的第一次导航(期间的导航排队)。
            self._booting = True
            self._pending_nav: tuple | None = None
            _LIVE_VIEWS.add(self)
            if not _state.get("quit_hooked"):
                from PySide6.QtCore import QCoreApplication
                instance = QCoreApplication.instance()
                if instance is not None:
                    instance.aboutToQuit.connect(release_all_webgpu_views)
                    _state["quit_hooked"] = True

        def showEvent(self, event) -> None:  # noqa: N802 — Qt 覆写
            super().showEvent(event)
            if self._wv is None:
                QTimer.singleShot(0, self, self._create_webview)

        def _create_webview(self) -> None:
            import shiboken6
            from PySide6.QtWebView import QWebView

            if self._wv is not None or not shiboken6.isValid(self) or not self.isVisible():
                return
            had_focus = self.hasFocus()
            self._wv = QWebView()
            self._container = QWidget.createWindowContainer(self._wv, self)
            self._container.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
            self._container.setMinimumSize(0, 0)
            self._container.installEventFilter(self)
            self.setFocusProxy(self._container)
            self._layout.addWidget(self._container)
            self._wv.loadingChanged.connect(self._on_loading)
            self._wv.titleChanged.connect(self.titleChanged)
            self._wv.urlChanged.connect(self.urlChanged)
            self._wv.loadHtml("<!doctype html><meta charset=utf-8><title></title>")
            QTimer.singleShot(self.UA_BOOT_TIMEOUT_MS, self, self._finish_boot)
            if had_focus:
                self._container.setFocus(Qt.FocusReason.OtherFocusReason)

        # ---- 导航 ---------------------------------------------------------
        def load(self, url) -> None:
            self._loaded = False
            target = url if isinstance(url, QUrl) else QUrl(str(url))
            if self._booting:
                self._pending_nav = ("url", target)
                return
            self._wv.setUrl(target)

        def reload(self) -> None:
            self._loaded = False
            if self._booting:
                return
            self._wv.reload()

        def stop(self) -> None:
            if not self._booting:
                self._wv.stop()

        def set_html(self, html: str, base_url: str | QUrl | None = None) -> None:
            self._loaded = False
            if self._booting:
                self._pending_nav = ("html", html, base_url)
                return
            if base_url is None:
                self._wv.loadHtml(html)
            else:
                self._wv.loadHtml(html, base_url if isinstance(base_url, QUrl) else QUrl(str(base_url)))

        def url(self) -> QUrl:
            if self._booting:
                pending = self._pending_nav
                return pending[1] if pending and pending[0] == "url" else QUrl()
            return self._wv.url()

        def title(self) -> str:
            return "" if self._booting else self._wv.title()

        def is_loaded(self) -> bool:
            """最近一次导航已载入完成(占位页也算)。"""
            return self._loaded

        def page_device_pixel_ratio(self) -> float:
            """页面的 ``devicePixelRatio``(每次载入完成时取一次)。WebView2 按系统 DPI 缩放,可能与 Qt 这边的
            ``devicePixelRatioF()`` 不同(本机:页面 1.24、Qt 1.0)——CSS px ↔ 物理像素换算要用这个。"""
            return self._page_dpr or self.devicePixelRatioF()

        # ---- 页内脚本 -----------------------------------------------------
        def is_alive(self) -> bool:
            """底下的 QWebView 已建且还在(``release_webgpu_view`` 之后为 False)。"""
            import shiboken6
            return shiboken6.isValid(self) and self._wv is not None and shiboken6.isValid(self._wv)

        def run_js(self, code: str, callback: Callable[[object], None] | None = None) -> None:
            """在页面全局作用域跑一段脚本;``callback(value)`` 拿到的值形状与 QtWebEngine 相同
            (dict / list / int / float / str / bool / None;抛异常或 undefined 为 None)。异步,不阻塞。
            WebView2 还没建(视图没显示过)时回调异步拿到 None;视图已拆掉时什么都不做(关窗收尾时宿主的
            定时器可能还会再打一拍)。"""
            if not self.is_alive():
                import shiboken6
                if callback is not None and self._wv is None and shiboken6.isValid(self):
                    QTimer.singleShot(0, self, lambda: callback(None))
                return
            if callback is None:
                self._wv.runJavaScript(code, lambda _raw: None)
                return
            self._wv.runJavaScript(normalize_js_script(code),
                                   lambda raw: callback(decode_normalized_result(raw)))

        def run_js_raw(self, code: str, callback: Callable[[object], None]) -> None:
            """QWebView 原生语义(对象 / 数组 / null 回来是空串,数字是 float)。一般用 ``run_js``。"""
            if self.is_alive():
                self._wv.runJavaScript(code, callback)

        # ---- 杂项 ---------------------------------------------------------
        def webview(self):
            """底下的 ``QWebView``(QWindow);第一次显示之前是 None。"""
            return self._wv

        def page(self) -> "_PageShim":
            """兼容 QWebEngineView 调用方的最小替身:只有 ``runJavaScript(code[, worldId][, callback])``
            (返回值同 ``run_js`` 已归一)。让 ``view.page().runJavaScript(...)`` 这类老代码不改就能跑。"""
            return _PageShim(self)

        def native_container(self):
            """包着原生窗口的那个 widget(给焦点 / 坐标换算用);第一次显示之前是 None。"""
            return self._container

        def focus_page(self) -> None:
            """把键盘焦点给网页(原生子窗口)。窗口要已经显示、是前台窗口。"""
            if self._container is None:
                self.setFocus(Qt.FocusReason.OtherFocusReason)      # 建好时会把焦点转过去
            elif self._container.hasFocus():
                self._focus_native()
            else:
                self._container.setFocus(Qt.FocusReason.OtherFocusReason)   # FocusIn → _focus_native

        def eventFilter(self, watched, event) -> bool:  # noqa: N802 — Qt 覆写
            if watched is self._container and event.type() == QEvent.Type.FocusIn:
                QTimer.singleShot(0, self, self._focus_native)
            return False

        def grab_from_screen(self):
            """从屏幕上截这块区域(QPixmap)。原生窗口 ``QWidget.grab()`` 截不到内容;窗口要在屏幕上、没被挡。"""
            from PySide6.QtGui import QGuiApplication

            target = self._container or self
            top_left = target.mapToGlobal(QPoint(0, 0))
            screen = QGuiApplication.screenAt(top_left) or self.screen() or QGuiApplication.primaryScreen()
            origin = screen.geometry().topLeft()
            return screen.grabWindow(0, top_left.x() - origin.x(), top_left.y() - origin.y(),
                                     target.width(), target.height())

        def grab_image(self):
            """截网页当前画面(QImage)。Windows 走 ``PrintWindow``:被挡住、在屏幕外也截得到;
            别的平台退回 ``grab_from_screen``。原生窗口的 ``QWidget.grab()`` 截不到网页内容,别用。"""
            img = _print_window(int(self._wv.winId())) if self.is_alive() else None
            return img if img is not None else self.grab_from_screen().toImage()

        # ---- internals ----------------------------------------------------
        def _focus_native(self) -> None:
            if not self.is_alive():
                return
            if not _focus_webview2_child(int(self._wv.winId())):
                self._wv.requestActivate()

        def _finish_boot(self, user_agent: object = None) -> None:
            if not self._booting or not self.is_alive():
                return
            if isinstance(user_agent, str) and user_agent and HOST_UA_TOKEN not in user_agent:
                self._wv.setHttpUserAgentString(f"{user_agent} {HOST_UA_TOKEN}")
            self._booting = False
            pending, self._pending_nav = self._pending_nav, None
            if pending is None:
                return
            if pending[0] == "url":
                self.load(pending[1])
            else:
                self.set_html(pending[1], pending[2])

        def _on_loading(self, info) -> None:
            from PySide6.QtWebView import QWebViewLoadingInfo

            status = info.status()
            if self._booting:
                if status == QWebViewLoadingInfo.LoadStatus.Succeeded:
                    self._wv.runJavaScript("navigator.userAgent", self._finish_boot)
                elif status == QWebViewLoadingInfo.LoadStatus.Failed:
                    self._finish_boot()
                return
            if status == QWebViewLoadingInfo.LoadStatus.Started:
                self._loaded = False
                self.loadStarted.emit()
            elif status == QWebViewLoadingInfo.LoadStatus.Succeeded:
                self._loaded = True
                self._wv.runJavaScript(CONSOLE_CAPTURE_JS, lambda _raw: None)
                self._wv.runJavaScript("window.devicePixelRatio", self._on_page_dpr)
                if not self._console_timer.isActive():
                    self._console_timer.start()
                self.loadFinished.emit(True)
            elif status == QWebViewLoadingInfo.LoadStatus.Failed:
                self.loadFinished.emit(False)

        def _on_page_dpr(self, value) -> None:
            if isinstance(value, (int, float)) and value > 0:
                self._page_dpr = float(value)

        def _drain_console(self) -> None:
            if self._draining or not self.is_alive():
                return
            self._draining = True
            self._wv.runJavaScript(_CONSOLE_DRAIN_JS, self._on_console_batch)

        def _on_console_batch(self, raw) -> None:
            self._draining = False
            if not isinstance(raw, str) or not raw:
                return
            try:
                rows = json.loads(raw)
            except json.JSONDecodeError:
                return
            for row in rows if isinstance(rows, list) else ():
                if not isinstance(row, list) or len(row) < 2:
                    continue
                level, message = str(row[0]), str(row[1])
                source = str(row[2]) if len(row) > 2 else ""
                line = int(row[3]) if len(row) > 3 and isinstance(row[3], (int, float)) else 0
                if "ResizeObserver loop" in message:
                    continue
                self.consoleMessage.emit(level, message, source, line)
                if self._forward_console:
                    try:
                        sys.stderr.write(f"js:{level}: {message}  @{source}:{line}\n")
                        sys.stderr.flush()
                    except Exception:  # pragma: no cover - 控制台编码 / 句柄异常不该拖垮页面
                        pass

    class _PageShim:
        """``WebGpuView.page()`` 的返回值:QWebEnginePage 最常用的那一个方法。"""

        def __init__(self, view: "WebGpuView") -> None:
            self._view = view

        def runJavaScript(self, code: str, *args) -> None:  # noqa: N802 — 对齐 Qt 命名
            callback = next((a for a in args if callable(a)), None)
            self._view.run_js(code, callback)

else:  # pragma: no cover
    WebGpuView = None  # type: ignore[assignment,misc]


# ---------------------------------------------------------------------------
# 自检入口:python -m tools.qt_webgpu [url] [--offscreen-window] [--timeout 30]
# ---------------------------------------------------------------------------

_SELFTEST_PAGE = b"""<!doctype html><meta charset=utf-8><title>qt-webgpu selftest</title>
<body style="margin:0;background:#202020;color:#ddd;font:14px sans-serif"><canvas id=c width=320 height=180></canvas>
<script>
(async () => {
  const a = navigator.gpu && await navigator.gpu.requestAdapter();
  if (!a) { document.body.append(' no WebGPU adapter'); return; }
  const d = await a.requestDevice();
  const ctx = document.getElementById('c').getContext('webgpu');
  ctx.configure({ device: d, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: 'opaque' });
  const e = d.createCommandEncoder();
  e.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear',
    clearValue: { r: 0.1, g: 0.6, b: 0.3, a: 1 }, storeOp: 'store' }] }).end();
  d.queue.submit([e.finish()]);
  document.body.append(' WebGPU clear OK');
})();
</script>"""


def _serve_selftest_page() -> str:
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(_SELFTEST_PAGE)

        def log_message(self, *_args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{httpd.server_address[1]}/"


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description="Qt 宿主 WebGPU 自检:开一个 WebGpuView,探测适配器并打印 JSON")
    ap.add_argument("url", nargs="?", default="", help="要探测的页面(缺省用内置的 WebGPU 清屏页)")
    ap.add_argument("--offscreen-window", action="store_true", help="真窗口但挪到屏幕外(无人值守)")
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args(argv)

    apply_webgpu_chromium_flags()
    from PySide6.QtCore import QEventLoop
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([sys.argv[0]])
    if not webgpu_view_available():
        print(json.dumps({"ok": False, "error": "当前平台建不了 WebGpuView(离屏 / 缺 QtWebView)"}, ensure_ascii=False))
        return 2
    view = WebGpuView()
    view.resize(480, 300)
    view.setWindowTitle("qt-webgpu selftest")
    if args.offscreen_window:
        place_offscreen(view)
    view.show()
    loop = QEventLoop()
    view.loadFinished.connect(lambda _ok: loop.quit())
    QTimer.singleShot(int(args.timeout * 1000), loop.quit)
    view.load(args.url or _serve_selftest_page())
    loop.exec()
    result = probe_webgpu(view, timeout_s=args.timeout)
    ok = is_hardware_adapter(result)
    print(json.dumps({"ok": ok, "summary": describe_probe(result), "probe": result}, ensure_ascii=False))
    view.close()
    release_webgpu_view(view)
    app.processEvents()
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
