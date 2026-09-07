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

驱动方式：PySide6 QtWebEngine（编辑器内嵌预览用的同一套 Chromium），**开一个真窗口**；
``QWebEngineUrlRequestInterceptor`` 拦下页面发出的**全部**请求（fetch / <img> / 音频 /
HEAD 探测一个不漏）。每个场景用 ``?mode=dev&devScene=<id>`` 整页重载进入（dev 直达路由，
不依赖命令通道），等场景就绪 + 切场收尾 + 网络静默；有时段外观变体的场景再在页内执行
``advanceTimeTo`` 切到每个变体，让夜的背景与烘焙载荷也被请求到。

⚠ 为什么不离屏（``--offscreen`` 只留作实验）：实测 2026-09-06（QtWebEngine 6.11 / Chromium 140 /
Windows）离屏 QPA 下 GPU 进程上下文会间歇丢失（"Context lost during MakeCurrent"），Pixi 的
WebGL 探测随之失败退到 Canvas2D；而且隐藏页 rAF 停摆，切场收尾（按 rAF 计时的淡入淡出）
永远不结束，``switching`` 一直为 true，时段换装也就永远不消费。真窗口下两者都正常
（headless-visual-verification 配方里"隐藏页 rAF 完全暂停"那条坑的又一个形态）。

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
import os
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

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
) -> list[dict]:
    """逐场景驱动并归类请求。返回逐场景结果列表（报告的 ``scenes`` 字段）。"""
    # 缺省真窗口（见模块头：离屏下 GPU 上下文会丢、rAF 停摆）；--offscreen 只作实验用
    if offscreen:
        os.environ["QT_QPA_PLATFORM"] = "offscreen"
    os.environ.setdefault(
        "QTWEBENGINE_CHROMIUM_FLAGS",
        # 没有 GPU 的环境退到 SwiftShader 软 WebGL；自动播放不等手势（音频请求也要看见）
        "--ignore-gpu-blocklist --enable-unsafe-swiftshader --autoplay-policy=no-user-gesture-required",
    )
    from PySide6.QtCore import QEventLoop, Qt, QTimer, QUrl
    from PySide6.QtWebEngineCore import (
        QWebEnginePage, QWebEngineProfile, QWebEngineScript, QWebEngineSettings,
        QWebEngineUrlRequestInterceptor,
    )
    from PySide6.QtWebEngineWidgets import QWebEngineView
    from PySide6.QtWidgets import QApplication

    class Recorder(QWebEngineUrlRequestInterceptor):
        """拦下每一个请求。只记录，不改写、不拦截。"""

        def __init__(self) -> None:
            super().__init__()
            self.entries: list[tuple[float, str, str]] = []
            self.last = time.monotonic()

        def interceptRequest(self, info) -> None:  # noqa: N802 (Qt 命名)
            now = time.monotonic()
            url = info.requestUrl().toString()
            self.entries.append((now, url, bytes(info.requestMethod()).decode("ascii", "replace")))
            # "网络静默"只看**游戏内容**请求：dev 游戏每 600ms 轮询一次 /__gamedraft-api/runtime-command，
            # 连它一起算的话静默永远等不到，每个场景都干等到上限（实测一场 5 分钟，全量要 3 小时）
            if normalize_request_url(url) is not None:
                self.last = now

    class Page(QWebEnginePage):
        """把页面 console 收进来：加载失败 / 运行时报错都要进报告。"""

        def __init__(self, profile, sink: list) -> None:
            super().__init__(profile)
            self._sink = sink

        def javaScriptConsoleMessage(self, level, message, line_number, source_id) -> None:  # noqa: N802
            lvl = getattr(level, "value", level)
            self._sink.append((int(lvl), str(message), int(line_number), str(source_id)))

    QApplication.setAttribute(Qt.ApplicationAttribute.AA_ShareOpenGLContexts, True)
    app = QApplication.instance() or QApplication([sys.argv[0]])

    recorder = Recorder()
    console: list[tuple[int, str, int, str]] = []
    profile = QWebEngineProfile()                      # 无参构造 = off-the-record，不落磁盘
    profile.setHttpCacheType(QWebEngineProfile.HttpCacheType.NoCache)   # 每个请求都要被看见
    profile.setUrlRequestInterceptor(recorder)
    # 把 navigator.gpu 藏起来，让 PixiJS 直接走 WebGL。
    # 实测（2026-09-06，QtWebEngine 6.11 / Chromium 140，离屏）：Pixi 的 autoDetectRenderer 先试
    # WebGPU，"Failed to create WebGPU Context Provider" 之后 GPU 进程上下文一起丢
    # （"Context lost during MakeCurrent"），随后的 WebGL 也建不出来 → 退到 Canvas2D，
    # 所有滤镜被跳过、每帧抛 validateRenderable。单独建 WebGL 是好的（GTX 970 / ANGLE D3D11），
    # 罪魁只是那一次 WebGPU 尝试。`--disable-features=WebGPU` 压不住它，藏掉 navigator.gpu 才行。
    no_webgpu = QWebEngineScript()
    no_webgpu.setName("gamedraft-sweep-no-webgpu")
    no_webgpu.setInjectionPoint(QWebEngineScript.InjectionPoint.DocumentCreation)
    no_webgpu.setWorldId(QWebEngineScript.ScriptWorldId.MainWorld)
    no_webgpu.setRunsOnSubFrames(False)
    no_webgpu.setSourceCode(
        "try { Object.defineProperty(navigator, 'gpu', { get() { return undefined; }, configurable: true }); }"
        " catch (e) {}"
    )
    profile.scripts().insert(no_webgpu)
    page = Page(profile, console)
    page.settings().setAttribute(QWebEngineSettings.WebAttribute.WebGLEnabled, True)
    page.settings().setAttribute(QWebEngineSettings.WebAttribute.Accelerated2dCanvasEnabled, True)
    page.settings().setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
    view = QWebEngineView()
    view.setPage(page)
    view.setWindowTitle("GameDraft 全场景抓取扫描（打包验收，跑完自动关）")
    # 窗口按 game_config.windowSize 开（编辑器预览窗与 exe 同一口径）：扫描截图/请求都在标准比例下发生
    view.resize(*window_size)
    view.show()

    # 只记**失败**：loadFinished(true) 是正常完成，append 进去会把成功当失败（踩过）
    load_failed: list[str] = []
    page.loadFinished.connect(lambda ok: None if ok else load_failed.append("loadFinished=false"))
    page.renderProcessTerminated.connect(
        lambda status, code: load_failed.append(f"渲染进程退出（{status}，code {code}）"),
    )

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

        try:
            page.runJavaScript(js, 0, done)
        except TypeError:
            page.runJavaScript(js, done)
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
            if time.monotonic() - recorder.last >= idle_seconds:
                return
            pump(0.1)

    results: list[dict] = []
    for i, spec in enumerate(scenes, 1):
        start_idx = len(recorder.entries)
        console_idx = len(console)
        load_failed.clear()
        url = f"{base_url.rstrip('/')}/?mode=dev&devScene={quote(spec.id)}"
        log(f"[{i}/{len(scenes)}] {spec.id}" + (f"（时段变体：{', '.join(spec.phases)}）" if spec.phases else ""))
        page.load(QUrl(url))
        recorder.last = time.monotonic()
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
        entries = recorder.entries[start_idx:]
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
        errs = [m for (lvl, m, _l, _s) in console[console_idx:] if lvl >= 2]
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

    view.close()
    del page
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
                    help="离屏跑（实验用：本机实测 GPU 上下文会丢、rAF 停摆，结果不可信）")
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
    results = run_sweep(
        base_url=args.url,
        scenes=scenes,
        manifest_files=manifest_files,
        public_root=public_root,
        offscreen=args.offscreen,
        window_size=window_size_from_game_config(public_root),
        scene_timeout=args.scene_timeout,
        idle_seconds=args.idle,
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
    non_webgl = [r["id"] for r in results if r.get("renderer") and r["renderer"] != "webgl"]
    if non_webgl:
        print(f"\n⚠ {len(non_webgl)} 个场景 Pixi 没跑在 WebGL 上（{non_webgl[:3]}…）：滤镜被跳过，"
              "与真机表现有差；资源请求仍完整，但别拿这份去判画面。")
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
