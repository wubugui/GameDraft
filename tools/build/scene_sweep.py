"""全场景抓取扫描：无头把 dev 游戏的**每个场景真跑一遍**，记下运行时实际请求的每个资源，反向核对抽取清单。

为什么要有它
============

抽取清单是"四来源并集减不抽取"的**静态计算**，它漏了什么自己不知道；既有的验收门只做
"清单承诺 → 实际落地"的单向比对，清单里根本没有的文件它永远看不见。2026-09-05 的事故
正是这个形状：运行时 09-02 起进每个场景都要读 ``atlas_bin.bin``，规则文件却把它当调试
载荷排除，发行包 28 个场景角色照明整份失效，而构建 / 验收 / 素材审计三道门全绿。

唯一能证明"清单没漏"的办法，是让**运行时自己说它要什么**：把游戏真跑起来，进每一个
场景（含每个时段外观变体），拦下它发出的每一个请求，然后问清单"这些你都有吗"。
这就是本工具。它对代码里怎么拼路径一无所知，也不需要知道——新加一条运行期拼出来的
资源，它下一次跑就会看见。

怎么跑
======

    通常由 scripts/scene_sweep.mjs 调用（它负责起 / 停一个**隔离的** dev 服）：
        node scripts/scene_sweep.mjs --target release
    也可以对着任何在跑的 dev 服直接跑：
        python -m tools.build.scene_sweep --url http://127.0.0.1:5173 \\
            --manifest .build/manifest-release.json --out .build/sweep-release.json

驱动方式：``tools/qt_webgpu.WebGpuView``（Windows 上是 WebView2——游戏渲染只有 WebGPU，QtWebEngine
没编 Dawn、拿不到 WebGPU 适配器，见该模块头），**开一个真窗口**。请求由本工具自己起的**记录代理**
（``RecordingProxy``，127.0.0.1 临时端口，原样转发给 ``--url`` 那个 dev 服）逐条记下——fetch / <img> /
音频 / HEAD 探测一个不漏，与浏览器内核无关；代理顺手把 ``CONSOLE_CAPTURE_JS`` 塞进 HTML 的 ``<head>``
最前面，页面从第一行起的报错都进报告。每个场景用 ``?mode=dev&devScene=<id>`` 整页重载进入（dev 直达路由，
不依赖命令通道），等场景就绪 + 切场收尾 + 网络静默；有时段外观变体的场景再在页内执行
``advanceTimeTo`` 切到每个变体，让夜的背景与烘焙载荷也被请求到。

⚠ 窗口必须是真窗口：``QT_QPA_PLATFORM=offscreen`` 下 WebView2 一建就段错误，最小化的窗口 rAF 停摆
（切场收尾按 rAF 计时，``switching`` 永远落不下来，时段换装也就永远不消费）。``--offscreen`` =
真窗口**挪到屏幕外**跑（不挡人，WebView2 照常渲染、rAF 照常走——2026-09-27 实测），不是离屏 QPA。

判定
====

每个请求归一化成相对 ``public/`` 的路径，分四类：
- ``in_manifest``：清单里有（发行档音频转码后请求 ``.ogg`` 而清单记 ``.wav``，认作同一个）；
- ``gap``：**清单里没有、开发树里却有** —— 这就是漏抽，打包出去必 404，本工具据此判 FAIL；
- ``optional_probe``：可选 sidecar 的探测（挂点表 ``sockets.json`` / 法线图 ``*.normal.png``），
  开发树里本来就没有，按设计 404；
- ``missing_in_dev``：开发树里也没有的请求——这是数据/烘焙缺件，运行时两边同样降级，
  不是打包问题；只记进报告，不判 FAIL（但会打印，别装没看见）。

⚠ 只读：本工具不写仓库里任何东西，只写 ``--out`` 指定的报告。隔离的 dev 服由
scene_sweep.mjs 以 ``GAMEDRAFT_SWEEP_ISOLATED=1`` 起，命令队列 / 快照 / 存档都不碰真实的那份。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

from tools.webengine_cache_policy import disable_all_caches

_THIS = Path(__file__).resolve()
_PROJECT_ROOT_DEFAULT = _THIS.parent.parent.parent

# ---------------------------------------------------------------------------
# 纯逻辑（不依赖 Qt，tests/test_scene_sweep.py 直接测）
# ---------------------------------------------------------------------------

#: 与游戏内容无关的请求：vite 自己的模块 / HMR / dev 中间件 / 浏览器自动请求
IGNORED_PATH_PREFIXES = ("/@", "/src/", "/node_modules/", "/__gamedraft-api/", "/__verify", "/favicon.ico")
#: 游戏内容只住这两棵树下（src/core/projectPaths.ts）
GAME_PATH_PREFIXES = ("/assets/", "/resources/")
#: 产物自己的派生物，不在清单里也不该在（scripts/lib/scene_index.mjs）
DERIVED_FILES = frozenset({"assets/scene_index.json"})
#: 可选 sidecar 的探测：开发树里本来就没有，按设计 404（optional-asset-probe 机制卡）
OPTIONAL_PROBE_PATTERNS = (
    re.compile(r"/sockets\.json$"),        # 动画挂点表（109 个包里只有 2 个有）
    re.compile(r"\.normal\.png$"),         # 法线图集（缺了退平面法线）
    # 光照烘焙载荷的入口探测：「烘焙数据可以缺省，缺省不能影响运行」（projectPaths.sceneBakeDirUrl）。
    # 没烘过的场景（dev_room 等）进场景照样会去问一次 lighting.json / geometry.json；
    # 角色侧还会回落到迁移期的扁平布局 lighting/lighting.json 再问一次。
    re.compile(r"/lighting(/[^/]+)?/(lighting|geometry)\.json$"),
)


def normalize_request_url(url: str) -> str | None:
    """请求 URL → 相对 ``public/`` 的 POSIX 路径；不是游戏内容返回 None。"""
    parts = urlsplit(url)
    path = unquote(parts.path)
    if not path or path == "/" or path == "/index.html":
        return None
    if any(path.startswith(p) for p in IGNORED_PATH_PREFIXES):
        return None
    if not path.startswith(GAME_PATH_PREFIXES):
        return None
    return path.lstrip("/")


def classify_request(rel: str, manifest: set[str], public_root: Path) -> str:
    """一条归一化后的请求相对清单是什么：in_manifest / derived / gap / optional_probe / missing_in_dev。"""
    if rel in DERIVED_FILES:
        return "derived"
    if rel in manifest:
        return "in_manifest"
    # 发行档把 wav 转成 ogg 再落地，清单记的是源文件名——对着打包产物跑时请求的是 .ogg
    if rel.lower().endswith(".ogg") and f"{rel[:-4]}.wav" in manifest:
        return "in_manifest"
    if (public_root / rel).is_file():
        return "gap"
    if any(p.search(rel) for p in OPTIONAL_PROBE_PATTERNS):
        return "optional_probe"
    return "missing_in_dev"


@dataclass
class SceneSpec:
    """要扫的一个场景：id 以**文件名**为准（运行时按 ``scenes/<文件名>.json`` 拼路径）。"""

    id: str
    #: JSON 里写的 id（可能与文件名不同；运行时 currentSceneData.id 报的是它）
    json_id: str
    #: 开了日夜且配了时段外观变体时，要逐个切到的时段 id
    phases: list[str] = field(default_factory=list)


def scenes_from_disk(scenes_dir: Path) -> list[SceneSpec]:
    """枚举 ``public/assets/scenes/*.json``。一个坏 JSON 只让那个场景没有变体信息，不让整批消失。"""
    out: list[SceneSpec] = []
    for f in sorted(scenes_dir.glob("*.json")):
        data: object = {}
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            pass
        json_id = f.stem
        phases: list[str] = []
        if isinstance(data, dict):
            raw_id = data.get("id")
            if isinstance(raw_id, str) and raw_id.strip():
                json_id = raw_id.strip()
            day_night = data.get("dayNight")
            variants = data.get("timeVariants")
            if isinstance(day_night, dict) and day_night.get("enabled") is True and isinstance(variants, dict):
                phases = [k for k, v in variants.items() if isinstance(v, dict)]
        out.append(SceneSpec(id=f.stem, json_id=json_id, phases=phases))
    return out


def summarize(scene_results: list[dict]) -> dict:
    """把逐场景结果压成报告顶层：去重后的 gaps / missing_in_dev，计数与判定。"""
    gaps: dict[str, list[str]] = {}
    missing: dict[str, list[str]] = {}
    requests = 0
    errors = 0
    for sr in scene_results:
        requests += int(sr.get("requests", 0))
        if sr.get("error"):
            errors += 1
        for rel in sr.get("gaps", []):
            gaps.setdefault(rel, []).append(sr["id"])
        for rel in sr.get("missingInDev", []):
            missing.setdefault(rel, []).append(sr["id"])
    verdict = "PASS" if not gaps and not errors else "FAIL"
    return {
        "verdict": verdict,
        "gaps": [{"path": p, "scenes": s} for p, s in sorted(gaps.items())],
        "missingInDev": [{"path": p, "scenes": s} for p, s in sorted(missing.items())],
        "summary": {
            "scenes": len(scene_results),
            "scenesFailed": errors,
            "requests": requests,
            "gaps": len(gaps),
            "missingInDev": len(missing),
        },
    }


def _sha1_of(path: Path) -> str:
    return hashlib.sha1(path.read_bytes()).hexdigest()


def src_fingerprint(src_root: Path) -> str:
    """``src/`` 下每个 .ts 的 (相对路径, 大小, mtime_ns) 的指纹。

    报告记它是为了让 ``release.mjs`` 能判断"上一次扫描还作不作数"：清单哈希只能说明
    要抽的文件集合没变，运行时**请求哪些文件**还取决于代码；两者都没动才允许复用。
    Node 侧 ``scripts/release.mjs`` 用同一条公式算（每行 ``rel\\tsize\\tmtime_ns``，按 rel 排序）。
    算不出来时返回空串 = 永远不复用（安全方向）。
    """
    try:
        rows = []
        for p in src_root.rglob("*.ts"):
            if not p.is_file():
                continue
            st = p.stat()
            rows.append((p.relative_to(src_root).as_posix(), st.st_size, st.st_mtime_ns))
        rows.sort()
        h = hashlib.sha1()
        for rel, size, mtime in rows:
            h.update(f"{rel}\t{size}\t{mtime}\n".encode("utf-8"))
        return h.hexdigest()
    except OSError:
        return ""


# ---------------------------------------------------------------------------
# 驱动（Qt 只在这里 import：纯逻辑测试不需要装 WebEngine）
# ---------------------------------------------------------------------------

#: 页内探针：游戏起来没有、当前场景是谁、切场/换装在不在途、有没有致命错误页。
#: 直读 `window.__game` 私有字段（runtime-command-channel 配方：严肃断言不经共享快照）。
_STATE_JS = """
(() => {
  const fatal = !!document.getElementById('game-fatal-error');
  const blocked = !!document.getElementById('game-entry-blocked');
  const g = window.__game;
  if (!g) return JSON.stringify({ stage: 'boot', fatal, blocked });
  const sm = g.sceneManager;
  const sd = sm && sm.currentSceneData;
  const r = g.renderer && g.renderer.app && g.renderer.app.renderer;
  return JSON.stringify({
    stage: 'game', fatal, blocked,
    scene: sd && sd.id ? String(sd.id) : null,
    background: sd && sd.backgrounds && sd.backgrounds[0] ? String(sd.backgrounds[0].image || '') : null,
    state: g.stateController ? String(g.stateController.currentState) : null,
    switching: !!(sm && sm.switching),
    phasePending: !!g.pendingPhaseSwap,
    phaseInFlight: !!g.phaseSwapInFlight,
    renderer: r ? String(r.name || r.type) : null,
  });
})()
"""


def _phase_js(phase: str) -> str:
    # transition=cut：缺省 timelapse 是一段演出，扫描只要换装后的资源请求，不等它演完
    cmd = {"type": "debugExecuteAction", "action": {"type": "advanceTimeTo", "params": {"phase": phase, "transition": "cut"}}}
    return (
        "(() => { const g = window.__game; if (!g || typeof g.applyRuntimeCommand !== 'function') return 'no-game';"
        f" g.applyRuntimeCommand({json.dumps(cmd, ensure_ascii=False)}); return 'sent'; }})()"
    )


class RecordingProxy:
    """记录代理：把浏览器的每个请求原样转发给 ``upstream``，并记下 ``(时刻, URL, 方法)``。

    为什么不在浏览器里拦：游戏页现在跑在 WebView2 里（QtWebEngine 没有 WebGPU），Qt 的 WebView 没有请求拦截
    接口；在代理上记与浏览器内核无关，HEAD 探测 / 404 / 音频 Range 请求一条不漏。

    - 普通请求：转发方法、路径、头与请求体，回传状态、头与响应体（逐跳头去掉，长度重新算）；
    - 未压缩的 HTML 响应：``<head>`` 最前面塞 ``inject_head``（console 捕获脚本），页面从第一行起的报错都抓得到；
    - ``Upgrade`` 请求（vite 的 HMR websocket）：原样打通成 TCP 隧道，行为与直连一致。
    """

    #: 回给浏览器时不转发的响应头（逐跳头；长度由本代理重算）
    HOP_RESPONSE = frozenset({"connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te",
                              "trailers", "transfer-encoding", "upgrade", "content-length"})
    #: 发给上游时不转发的请求头
    HOP_REQUEST = frozenset({"connection", "keep-alive", "proxy-authorization", "te", "trailers",
                             "transfer-encoding", "upgrade", "host"})

    def __init__(self, upstream: str, *, inject_head: str = "", on_request=None) -> None:
        import http.client
        import socket
        import threading
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

        parts = urlsplit(upstream)
        self.upstream_host = parts.hostname or "127.0.0.1"
        self.upstream_port = parts.port or 80
        self.entries: list[tuple[float, str, str]] = []
        self._lock = threading.Lock()
        proxy = self
        inject = f"<script>{inject_head}</script>".encode("utf-8") if inject_head else b""
        upstream_hostport = f"{self.upstream_host}:{self.upstream_port}"

        def pipe(src, dst) -> None:
            try:
                while True:
                    data = src.recv(65536)
                    if not data:
                        break
                    dst.sendall(data)
            except OSError:
                pass
            finally:
                for sock in (src, dst):
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args) -> None:
                pass

            def _record(self) -> None:
                url = f"http://{self.headers.get('Host', '127.0.0.1')}{self.path}"
                with proxy._lock:
                    proxy.entries.append((time.monotonic(), url, self.command))
                if on_request is not None:
                    on_request(url, self.command)

            def _tunnel(self) -> None:
                upstream = socket.create_connection((proxy.upstream_host, proxy.upstream_port), timeout=10)
                upstream.settimeout(None)
                head = [f"{self.command} {self.path} {self.request_version}\r\n"]
                for k, v in self.headers.items():
                    head.append(f"{k}: {upstream_hostport if k.lower() == 'host' else v}\r\n")
                upstream.sendall(("".join(head) + "\r\n").encode("latin-1"))
                self.connection.settimeout(None)
                back = threading.Thread(target=pipe, args=(upstream, self.connection), daemon=True)
                back.start()
                pipe(self.connection, upstream)
                back.join(timeout=5)
                upstream.close()
                self.close_connection = True

            def _forward(self) -> None:
                self._record()
                if self.headers.get("Upgrade"):
                    self._tunnel()
                    return
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length > 0 else None
                headers = {k: v for k, v in self.headers.items() if k.lower() not in RecordingProxy.HOP_REQUEST}
                headers["Host"] = upstream_hostport
                conn = http.client.HTTPConnection(proxy.upstream_host, proxy.upstream_port, timeout=120)
                try:
                    conn.request(self.command, self.path, body=body, headers=headers)
                    resp = conn.getresponse()
                    data = resp.read() if self.command != "HEAD" else b""
                    ctype = (resp.getheader("Content-Type") or "").lower()
                    if inject and "text/html" in ctype and not resp.getheader("Content-Encoding"):
                        data = inject_into_head(data, inject)
                    self.send_response(resp.status, resp.reason)
                    for k, v in resp.getheaders():
                        if k.lower() not in RecordingProxy.HOP_RESPONSE:
                            self.send_header(k, v)
                    length_out = (resp.getheader("Content-Length") or "0") if self.command == "HEAD" else str(len(data))
                    self.send_header("Content-Length", length_out)
                    self.end_headers()
                    if data:
                        self.wfile.write(data)
                except (OSError, http.client.HTTPException) as e:
                    try:
                        msg = f"recording proxy: upstream failed ({e})".encode("utf-8")
                        self.send_response(502)
                        self.send_header("Content-Type", "text/plain; charset=utf-8")
                        self.send_header("Content-Length", str(len(msg)))
                        self.end_headers()
                        self.wfile.write(msg)
                    except OSError:
                        self.close_connection = True
                finally:
                    conn.close()

            do_GET = do_HEAD = do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _forward

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._server.daemon_threads = True
        self.port = int(self._server.server_address[1])
        self.url = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self._server.serve_forever, daemon=True).start()

    def snapshot(self) -> list[tuple[float, str, str]]:
        with self._lock:
            return list(self.entries)

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()


def inject_into_head(html: bytes, snippet: bytes) -> bytes:
    """把 ``snippet`` 塞到 ``<head>`` 开标签后面（没有 head 就放最前面）。"""
    m = re.search(rb"<head[^>]*>", html, re.IGNORECASE)
    if m is None:
        return snippet + html
    return html[: m.end()] + snippet + html[m.end():]


def run_sweep(
    *,
    base_url: str,
    scenes: list[SceneSpec],
    manifest_files: set[str],
    public_root: Path,
    offscreen: bool = False,
    window_size: tuple[int, int] = (1024, 768),
    scene_timeout: float = 150.0,
    idle_seconds: float = 2.0,
    settle_seconds: float = 0.8,
    log=print,
    meta: dict | None = None,
) -> list[dict]:
    """逐场景驱动并归类请求。返回逐场景结果列表（报告的 ``scenes`` 字段）。

    ``meta``（可选的 dict）会被填上 ``webgpu``：第一次进场后页内 ``navigator.gpu.requestAdapter()`` 的探测结果。
    ``offscreen``：真窗口挪到屏幕外（不是离屏 QPA——WebView2 在离屏平台下会段错误）。
    """
    from tools.qt_webgpu import (
        CONSOLE_CAPTURE_JS, WebGpuView, apply_webgpu_chromium_flags, describe_probe, is_hardware_adapter,
        place_offscreen, probe_webgpu, release_webgpu_view, webgpu_view_available,
    )
    # 两份开关都只在浏览器内核初始化时读一次：禁缓存 + WebGPU / 游戏宿主（免手势音频、不后台降级）
    disable_all_caches()
    apply_webgpu_chromium_flags()
    from PySide6.QtCore import QEventLoop, QTimer
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance() or QApplication([sys.argv[0]])
    if not webgpu_view_available():
        raise RuntimeError("建不了 WebGpuView（需要真窗口平台 + PySide6.QtWebView；离屏 QPA 下 WebView2 会段错误）")

    idle = {"last": time.monotonic()}

    def on_request(url: str, _method: str) -> None:
        # "网络静默"只看**游戏内容**请求：dev 游戏每 600ms 轮询一次 /__gamedraft-api/runtime-command，
        # 连它一起算的话静默永远等不到，每个场景都干等到上限（实测一场 5 分钟，全量要 3 小时）
        if normalize_request_url(url) is not None:
            idle["last"] = time.monotonic()

    proxy = RecordingProxy(base_url, inject_head=CONSOLE_CAPTURE_JS, on_request=on_request)
    console: list[tuple[str, str]] = []
    view = WebGpuView(forward_console=False)
    view.consoleMessage.connect(lambda level, message, _src, _line: console.append((level, message)))
    view.setWindowTitle("GameDraft 全场景抓取扫描（打包验收，跑完自动关）")
    # 窗口按 game_config.windowSize 开（编辑器预览窗与 exe 同一口径）：扫描截图/请求都在标准比例下发生
    view.resize(*window_size)
    if offscreen:
        place_offscreen(view)
    view.show()

    # 只记**失败**：loadFinished(true) 是正常完成，append 进去会把成功当失败（踩过）
    load_failed: list[str] = []
    view.loadFinished.connect(lambda ok: None if ok else load_failed.append("loadFinished=false"))

    def pump(seconds: float) -> None:
        loop = QEventLoop()
        QTimer.singleShot(max(1, int(seconds * 1000)), loop.quit)
        loop.exec()

    def eval_js(js: str, timeout: float = 5.0):
        loop = QEventLoop()
        box: dict = {}

        def done(value) -> None:
            box["v"] = value
            loop.quit()

        view.run_js(js, done)
        QTimer.singleShot(int(timeout * 1000), loop.quit)
        loop.exec()
        return box.get("v")

    def state() -> dict:
        raw = eval_js(_STATE_JS)
        if isinstance(raw, str):
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return {"stage": "unknown"}
        return {"stage": "unknown"}

    def wait_idle(max_seconds: float = 60.0) -> None:
        t0 = time.monotonic()
        while time.monotonic() - t0 < max_seconds:
            if time.monotonic() - idle["last"] >= idle_seconds:
                return
            pump(0.1)

    results: list[dict] = []
    probed = False
    try:
        for i, spec in enumerate(scenes, 1):
            start_idx = len(proxy.snapshot())
            console_idx = len(console)
            load_failed.clear()
            url = f"{proxy.url}/?mode=dev&devScene={quote(spec.id)}"
            log(f"[{i}/{len(scenes)}] {spec.id}" + (f"（时段变体：{', '.join(spec.phases)}）" if spec.phases else ""))
            view.load(url)
            idle["last"] = time.monotonic()
            t0 = time.monotonic()
            error: str | None = None
            seen_phases: list[dict] = []
            while True:
                pump(0.25)
                st = state()
                if st.get("fatal"):
                    error = "页面出现 #game-fatal-error（游戏启动失败）"
                    break
                if st.get("blocked"):
                    error = "页面出现 #game-entry-blocked（入口卫兵拦截）"
                    break
                if load_failed:
                    error = f"页面加载失败（{load_failed[0]}）"
                    break
                # 进到目标场景**且切场收尾完成**：devScene 路由是 dev_room → switchScene(目标)，
                # 尾部有按 rAF 计时的淡入；`switching` 没落下之前时段换装不会消费（drainPendingPhaseSwap）
                if (st.get("stage") == "game" and st.get("scene") in (spec.id, spec.json_id)
                        and not st.get("switching")):
                    break
                if time.monotonic() - t0 > scene_timeout:
                    error = f"{scene_timeout:.0f}s 内没进到场景（最后状态 {st}）"
                    break
            renderer = st.get("renderer") if error is None else None
            if error is None and not probed:
                probed = True
                probe = probe_webgpu(view, timeout_s=15.0, with_device=False)
                if meta is not None:
                    meta["webgpu"] = probe
                log(f"    {describe_probe(probe)}")
                if not is_hardware_adapter(probe):
                    log("    ⚠ 不是硬件 WebGPU 适配器：资源请求仍完整，但别拿这份去判画面。")
            if error is None:
                wait_idle()
                pump(settle_seconds)
                wait_idle()
                for phase in spec.phases:
                    before = state().get("background")
                    sent = eval_js(_phase_js(phase))
                    # 换装不在 phaseChanged 那一拍：tick 在探索态、无切场在途时才消费，之后
                    # unloadScene + loadScene（phaseSwapInFlight）。等它整个走完；变体没换背景的
                    # （只换灯/环境音）pending 消费掉即算完成。
                    t1 = time.monotonic()
                    swapped = False
                    while time.monotonic() - t1 < 45.0:
                        pump(0.25)
                        st2 = state()
                        if st2.get("background") != before and not st2.get("phaseInFlight") and not st2.get("switching"):
                            swapped = True
                            break
                        if (not st2.get("phasePending") and not st2.get("phaseInFlight") and not st2.get("switching")
                                and time.monotonic() - t1 > 3.0 and st2.get("background") == before):
                            break   # 消费了但外观没变（同一张图的时段）
                    wait_idle()
                    pump(settle_seconds)
                    wait_idle()
                    seen_phases.append({
                        "phase": phase, "sent": sent, "swapped": swapped,
                        "backgroundBefore": before, "backgroundAfter": state().get("background"),
                    })
            entries = proxy.snapshot()[start_idx:]
            gaps: set[str] = set()
            missing: set[str] = set()
            optional = 0
            in_manifest = 0
            seen_rel: set[str] = set()
            for _, raw_url, _method in entries:
                rel = normalize_request_url(raw_url)
                if rel is None or rel in seen_rel:
                    continue
                seen_rel.add(rel)
                kind = classify_request(rel, manifest_files, public_root)
                if kind == "gap":
                    gaps.add(rel)
                elif kind == "missing_in_dev":
                    missing.add(rel)
                elif kind == "optional_probe":
                    optional += 1
                elif kind == "in_manifest":
                    in_manifest += 1
            errs = [m for (lvl, m) in console[console_idx:] if lvl == "error"]
            results.append({
                "id": spec.id,
                "error": error,
                "renderer": renderer,
                "requests": len(entries),
                "uniqueGameFiles": len(seen_rel),
                "inManifest": in_manifest,
                "optionalProbes": optional,
                "gaps": sorted(gaps),
                "missingInDev": sorted(missing),
                # 运行时在这个场景**实际请求**的全部游戏文件——这份记录本身就是"运行时要什么"的证据，
                # 排查"包里某样东西没出现"时先来这里看它到底有没有被请求过
                "files": sorted(seen_rel),
                "phases": seen_phases,
                "consoleErrors": errs[:20],
                "consoleErrorCount": len(errs),
            })
            tag = "✖" if (error or gaps) else "✓"
            swaps = "".join(f"，{p['phase']}{'✓' if p['swapped'] else '(外观未变)'}" for p in seen_phases)
            log(f"    {tag} 请求 {len(entries)}，游戏文件 {len(seen_rel)}，漏抽 {len(gaps)}，开发树也没有 {len(missing)}"
                + (f"，渲染器 {renderer}" if renderer else "") + swaps
                + (f"，{error}" if error else ""))
            for rel in sorted(gaps):
                log(f"      漏抽：{rel}")
    finally:
        view.close()
        release_webgpu_view(view)
        proxy.close()
        app.processEvents()
    return results


def window_size_from_game_config(public_root: Path) -> tuple[int, int]:
    """``game_config.json`` 的 ``windowSize``（没有则 ``viewport``）；读不到回落标准的 1024×768。
    与 ``src-tauri/src/main.rs`` 的 ``window_size_from_config`` 同口径。"""
    cfg = public_root / "assets" / "data" / "game_config.json"
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return (1024, 768)
    for key in ("windowSize", "viewport"):
        node = data.get(key) if isinstance(data, dict) else None
        if isinstance(node, dict):
            w, h = node.get("width"), node.get("height")
            if isinstance(w, (int, float)) and isinstance(h, (int, float)) and 320 <= w <= 8192 and 240 <= h <= 8192:
                return (int(w), int(h))
    return (1024, 768)


def _load_manifest(path: Path) -> set[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    files = data.get("files") if isinstance(data, dict) else None
    if not isinstance(files, list):
        raise ValueError(f"清单文件没有 files 数组：{path}")
    return {str(f) for f in files}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True, help="在跑的 dev 服（或托着 dev 档产物的静态服务）的 origin")
    ap.add_argument("--manifest", required=True, help="要核对的抽取清单（.build/manifest-<target>.json）")
    ap.add_argument("--out", required=True, help="报告写到哪（.build/sweep-<target>.json）")
    ap.add_argument("--project-root", default=str(_PROJECT_ROOT_DEFAULT))
    ap.add_argument("--scenes", default="", help="只扫这些场景（逗号分隔的文件名 id）；缺省全部")
    ap.add_argument("--limit", type=int, default=0, help="只扫前 N 个（调试用）")
    ap.add_argument("--offscreen", action="store_true",
                    help="真窗口挪到屏幕外跑（不挡人；不是离屏 QPA——WebView2 在离屏平台下会段错误）")
    ap.add_argument("--scene-timeout", type=float, default=150.0, help="单个场景进不去判失败的秒数")
    ap.add_argument("--idle", type=float, default=2.0, help="多少秒没有新请求算静默")
    args = ap.parse_args(argv)

    root = Path(args.project_root).resolve()
    public_root = root / "public"
    scenes_dir = public_root / "assets" / "scenes"
    manifest_path = Path(args.manifest).resolve()
    out_path = Path(args.out).resolve()

    if not scenes_dir.is_dir():
        print(f"✖ 找不到场景目录 {scenes_dir}", file=sys.stderr)
        return 2
    if not manifest_path.is_file():
        print(f"✖ 找不到清单 {manifest_path}（先 npm run package:<target> 或 node scripts/scene_sweep.mjs）", file=sys.stderr)
        return 2

    manifest_files = _load_manifest(manifest_path)
    manifest_meta = json.loads(manifest_path.read_text(encoding="utf-8"))
    scenes = scenes_from_disk(scenes_dir)
    if args.scenes:
        wanted = {s.strip() for s in args.scenes.split(",") if s.strip()}
        unknown = wanted - {s.id for s in scenes}
        if unknown:
            print(f"✖ 没有这些场景：{sorted(unknown)}", file=sys.stderr)
            return 2
        scenes = [s for s in scenes if s.id in wanted]
    if args.limit > 0:
        scenes = scenes[: args.limit]
    if not scenes:
        print("✖ 一个场景都没有可扫的 —— 场景目录空了？", file=sys.stderr)
        return 2

    print(f"全场景抓取扫描：{len(scenes)} 个场景 ← {args.url}")
    print(f"  清单：{manifest_path}（{len(manifest_files)} 个文件，target={manifest_meta.get('target')}）")
    started = time.time()
    meta: dict = {}
    results = run_sweep(
        base_url=args.url,
        scenes=scenes,
        manifest_files=manifest_files,
        public_root=public_root,
        offscreen=args.offscreen,
        window_size=window_size_from_game_config(public_root),
        scene_timeout=args.scene_timeout,
        idle_seconds=args.idle,
        meta=meta,
    )
    summary = summarize(results)
    report = {
        "tool": "tools/build/scene_sweep.py",
        "target": manifest_meta.get("target"),
        "url": args.url,
        "manifest": str(manifest_path),
        "manifestSha1": _sha1_of(manifest_path),
        "srcFingerprint": src_fingerprint(root / "src"),
        "sweptAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "durationSeconds": round(time.time() - started, 1),
        "partial": bool(args.scenes or args.limit),
        # 宿主页里 navigator.gpu.requestAdapter() 的结果（tools/qt_webgpu.probe_webgpu）：判"这份扫描是不是在真 GPU 上跑的"
        "webgpu": meta.get("webgpu"),
        **summary,
        "scenes": results,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")

    s = summary["summary"]
    print()
    print(f"结果：{summary['verdict']} —— {s['scenes']} 个场景（{s['scenesFailed']} 个没跑起来），"
          f"{s['requests']} 次请求，漏抽 {s['gaps']}，开发树也没有 {s['missingInDev']}，"
          f"耗时 {report['durationSeconds']}s")
    non_webgpu = [r["id"] for r in results if r.get("renderer") and r["renderer"] != "webgpu"]
    if non_webgpu:
        print(f"\n⚠ {len(non_webgpu)} 个场景的渲染器不是 WebGPU（{non_webgpu[:3]}…）：与真机表现有差；"
              "资源请求仍完整，但别拿这份去判画面。")
    if summary["gaps"]:
        print("\n✖ 运行时真会请求、清单却没有的文件（打包出去必 404）：")
        for g in summary["gaps"][:40]:
            print(f"    {g['path']}    ← {', '.join(g['scenes'][:4])}{'…' if len(g['scenes']) > 4 else ''}")
        print("  补 tools/build/manifest_rules.json 的规则，或 asset_manifest.py 的展开器。")
    if summary["missingInDev"]:
        print("\n· 运行时请求了、但开发树里也没有的文件（数据/烘焙缺件，两边同样降级，不算漏抽）：")
        for g in summary["missingInDev"][:20]:
            print(f"    {g['path']}    ← {', '.join(g['scenes'][:4])}{'…' if len(g['scenes']) > 4 else ''}")
    for r in results:
        if r["error"]:
            print(f"\n✖ 场景 {r['id']} 没跑起来：{r['error']}")
            for m in r["consoleErrors"][:5]:
                print(f"    console: {m[:200]}")
    if report["partial"]:
        print("\n⚠ 这是部分扫描（--scenes/--limit），报告不能当作全量结论。")
    print(f"\n报告：{out_path}")
    return 0 if summary["verdict"] == "PASS" and not report["partial"] else (0 if summary["verdict"] == "PASS" else 1)


if __name__ == "__main__":
    raise SystemExit(main())
