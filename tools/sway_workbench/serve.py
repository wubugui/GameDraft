# -*- coding: utf-8 -*-
"""草木工作台本地服务。

  GET  /                              viewer
  GET  /vendor/dropdown.js            轨迹工作台 viewer 下的页内下拉列表原样转发(白名单;不 fork)
  GET  /api/scenes                    场景清单 + 拆层状态
  GET  /api/boot                      启动 / 刷新后先开哪个场景(--open 带进来的,取空后 = 最近一次装上的)
  GET  /api/layers?scene=             一个场景的拆层描述(尺寸 / sway.json / 有哪些图 / 实例表 / needsExport)
  GET  /api/img?scene=&kind=          原画 / 底板 / matte / ids / 刚体 / 作者涂层(PNG 原样)
  GET  /api/ch?scene=&name=           涂层的一层(**不透明灰度**;freeze 会并上旧的 sway_lock.png)
  POST /api/paint  {scene, channels, baseMtime?, force?}
                                      四层各一张不透明灰度图 → 合成 RGBA 原子写;顺带迁移掉旧锁定图。
                                      三道闸:盘上更新 ⇒ 拒(乐观并发)、大面积删除 ⇒ 要 force、每次留历史;
                                      回 needsExport(写完之后按输入指纹算,页面据它亮 / 灭「待导出」)
  GET  /api/history?scene=            历史版本清单
  GET  /api/draft?scene=              本地草稿(local/sway_drafts/;没有 = null)
  POST /api/draft {scene, draft}      存草稿(覆盖上一份)      POST /api/draft/clear {scene}  删草稿
  POST /api/draft/stash {scene}       把草稿收起来(「先不管」;自动草稿 / 存盘不碰它)
  GET  /api/draft/stashes?scene=      收起来的草稿清单        GET /api/draft/stash?scene=&name=   取一份
  POST /api/draft/stash/delete {scene, name}
  POST /api/restore {scene, name}     恢复某一份历史(恢复前当前这份也进历史)
  POST /api/push   {scene, channels?, overrides?}
                                      **推给游戏**:页面上此刻那份(存没存都算)开线程烘进预览目录
                                      (local/sway_preview/),烘完让在跑的游戏从那里原地重装;**资源不动**
  POST /api/push/notify {scene}       只再告诉游戏一次"去装预览"(游戏刚被拉起来、没赶上那一次时用)
  POST /api/push/revoke {scene}       丢弃没保存的改动时撤掉推过的预览:与盘上这份内容不同才删 local/sway_preview/<场景>
                                      (只删本机预览,资源不动),并在后台让游戏换回资源那份(不等游戏)
  POST /api/export {scene}            **导出到游戏**:盘上的涂层开线程烘进资源(各时段照明载荷目录),烘完让游戏换回资源
  GET  /api/job/status                推送 / 导出跑到哪了(状态行 + 用时 + 完没完)
  POST /api/warm {scene}              装场景时后台预热(按推送的口径算一遍、不写盘),第一次推给游戏就快
  GET  /api/inspect?scene=&x=&y=      点一下画面:这一点属于哪株、alpha / 叶度 / 自由度 / 刚体度
  GET  /api/link/status               游戏在不在、在哪个场景、是不是正在装场景(pageBusy)
  POST /api/link/open {scene}         让游戏切到这个场景(没开着就由控制台拉起来;控制台没开时经在跑的 dev server
                                      排一条会过期的切场景命令 → via:'queue',dev server 也没有 → via:'none' + console 原因)

一切响应 ``Cache-Control: no-store``;错误以 ``{ok:false, err}`` 回给前端而不是断连
(与轨迹 / 声学 / 粒子三台同一条)。**游戏是预览器**:这里只管画与存,动起来长什么样去游戏里看。
"""
from __future__ import annotations

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.acoustic_workbench import game_link                # noqa: E402
from tools.sway_workbench import layers                       # noqa: E402

PORT = 5351
#: ``--open <场景 id>``:桌面壳启动时带进来的场景,前端 ``/api/boot`` 取一次即清
BOOT_OPEN: list[str] = []
#: 页面最近一次装上的场景(``/api/layers`` 成功回过的那个)。``/api/boot`` 在 ``BOOT_OPEN`` 取空之后回它:
#: ⚠ 原来 F5 / Ctrl+R(含「保存并刷新」)之后 boot 回空,页面去开清单里第一个烘过的场景——作者正在干活的场景没了、
#: 还可能被问一句别的场景的草稿。服务与窗口同寿,所以刷新留得住、重开工具不留(那正是想要的),不用 localStorage。
LAST_OPEN: list[str] = []
#: 轨迹工作台 viewer 下原样借用的共用件(白名单,不许拿路径拼任意文件;与粒子工作台 `VENDOR` 同一条路)。
#: dropdown.js = 页内下拉列表:QtWebEngine 150% 缩放下原生 `<select>` 弹窗框按设备像素、内容按 CSS 像素画,
#: 越开越大还不吃暗色(制作人在粒子 / 轨迹两台实拍过),下拉框一律走页内列表
VENDOR = {
    "dropdown.js": "tools/trajectory_workbench/viewer/dropdown.js",
}


def _body(h: SimpleHTTPRequestHandler) -> dict:
    n = int(h.headers.get("Content-Length") or 0)
    if n <= 0:
        return {}
    try:
        return json.loads(h.rfile.read(n).decode("utf-8"))
    except ValueError:
        return {}


class H(SimpleHTTPRequestHandler):
    #: ⚠ Windows 上 `.js` 常被注册表映射成 text/plain,浏览器按 HTML 规范**拒绝**这种 MIME 的模块脚本
    #: (症状:页面白着、控制台只有一行 "Strict MIME type checking")。自己钉死,别信系统表。
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
        ".html": "text/html", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(TOOL / "viewer"), **kw)

    def log_message(self, *a):                                # noqa: D102 — 工作台不刷屏
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    # ------------------------------------------------------------------ 出口
    def _json(self, obj, code: int = 200) -> None:
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _bin(self, raw: bytes, ctype: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    # ------------------------------------------------------------------ 路由
    def do_GET(self):                                          # noqa: N802
        u = urlparse(self.path)
        q = parse_qs(u.query)
        one = lambda k, d="": (q.get(k) or [d])[0]             # noqa: E731
        try:
            if u.path.startswith("/vendor/"):
                rel = VENDOR.get(u.path[len("/vendor/"):])
                if not rel:
                    return self._json({"ok": False, "err": "不在共用件白名单里"}, 404)
                return self._bin((ROOT / rel).read_bytes(), "text/javascript; charset=utf-8")
            if u.path == "/api/boot":
                sid = BOOT_OPEN.pop() if BOOT_OPEN else (LAST_OPEN[0] if LAST_OPEN else "")
                return self._json({"ok": True, "open": sid, "game": game_link.discover_game_url(ROOT)})
            if u.path == "/api/scenes":
                return self._json({"ok": True, "scenes": layers.scenes()})
            if u.path == "/api/layers":
                got = layers.layers(one("scene"))
                LAST_OPEN[:] = [got["id"]]       # 装不上(抛了)的不记:刷新后别去开一个装不上的场景
                return self._json({"ok": True, **got})
            if u.path == "/api/ch":
                got = layers.channel_bytes(one("scene"), one("name"))
                if not got:
                    return self._json({"ok": False, "err": "没有这一层"}, 404)
                return self._bin(*got)
            if u.path == "/api/img":
                got = layers.image_bytes(one("scene"), one("kind"))
                if not got:
                    return self._json({"ok": False, "err": "没有这张图"}, 404)
                return self._bin(*got)
            if u.path == "/api/job/status":
                return self._json({"ok": True, **layers.job_status()})
            if u.path == "/api/inspect":
                return self._json({"ok": True, **layers.inspect(one("scene"), float(one("x", "0")), float(one("y", "0")))})
            if u.path == "/api/history":
                return self._json({"ok": True, "items": layers.history(one("scene"))})
            if u.path == "/api/draft":
                return self._json({"ok": True, "draft": layers.draft_get(one("scene"))})
            if u.path == "/api/draft/stashes":
                return self._json({"ok": True, "items": layers.draft_stashes(one("scene"))})
            if u.path == "/api/draft/stash":
                return self._json({"ok": True, "draft": layers.draft_stash_get(one("scene"), one("name"))})
            if u.path == "/api/link/status":
                # ⚠ 按**推送用的那条槽**判在不在(`find_game` 实探),别拿控制台状态判:
                # 控制台是另一个服务,游戏跑着它也可能没应答,徽章就会长期显示"没开着"(实测过)。
                # alive = dev server 应答;page = 游戏页的心跳(游戏页真开着、在哪个场景、用没用预览)
                base = layers.find_game()
                page = layers.game_page(base) if base else None
                return self._json({"ok": True, "game": base, "alive": bool(base),
                                   "page": page, "pageAlive": layers.page_alive(page),
                                   "pageBusy": layers.page_busy(page)})
        except Exception as e:                                 # noqa: BLE001 — 错误回前端,不断连
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)
        return super().do_GET()

    def do_POST(self):                                         # noqa: N802
        u = urlparse(self.path)
        b = _body(self)
        try:
            if u.path == "/api/paint":
                ch = b.get("channels")
                if not isinstance(ch, dict):
                    return self._json({"ok": False, "err": "需要 channels{veg,freeze,rigid,unrigid}"}, 400)
                return self._json(layers.save_paint(
                    str(b.get("scene") or ""), ch,
                    base_mtime=(float(b["baseMtime"]) if isinstance(b.get("baseMtime"), (int, float)) else None),
                    force=bool(b.get("force")),
                    overrides=(b.get("overrides") if isinstance(b.get("overrides"), dict) else None)))
            if u.path == "/api/draft":
                return self._json(layers.draft_put(str(b.get("scene") or ""), b.get("draft")))
            if u.path == "/api/draft/clear":
                return self._json(layers.draft_clear(str(b.get("scene") or "")))
            if u.path == "/api/draft/stash":
                return self._json(layers.draft_stash(str(b.get("scene") or "")))
            if u.path == "/api/draft/stash/delete":
                return self._json(layers.draft_stash_delete(str(b.get("scene") or ""), str(b.get("name") or "")))
            if u.path == "/api/restore":
                return self._json(layers.restore(str(b.get("scene") or ""), str(b.get("name") or "")))
            if u.path == "/api/push":
                ch = b.get("channels")
                return self._json(layers.push_start(
                    str(b.get("scene") or ""), ch if isinstance(ch, dict) else None,
                    b.get("overrides") if isinstance(b.get("overrides"), dict) else None))
            if u.path == "/api/push/notify":
                return self._json({"ok": True, **layers.push_to_game(str(b.get("scene") or ""), "preview")})
            if u.path == "/api/push/revoke":
                return self._json(layers.revoke_preview(str(b.get("scene") or "")))
            if u.path == "/api/export":
                return self._json(layers.export_start(str(b.get("scene") or "")))
            if u.path == "/api/warm":
                return self._json(layers.warm_start(str(b.get("scene") or "")))
            if u.path == "/api/link/open":
                sid = str(b.get("scene") or "")
                ok, msg = game_link.console_open_dev_entry(sid)
                if ok:
                    return self._json({"ok": True, "via": "console", "detail": msg})
                # 控制台没开:只有 dev server 在跑时才排切场景命令,而且**经它的 POST 排**(盖 enqueuedAt、到点过期)。
                # ⚠ 原来一律直接写队列文件:没有时间戳的命令永不过期,控制台和游戏都没开时按一次 P,
                #   几个小时后打开游戏被拽进那个场景;页面日志还只写"已请求(queue)",控制台为什么没开一个字不提。
                base = layers.find_game()
                if not base:
                    return self._json({"ok": True, "via": "none", "console": msg,
                                       "detail": "dev server 也没在跑,没排切场景命令"})
                q = layers.enqueue_switch_scene_via_game(base, sid)
                return self._json({"ok": True, "via": "queue" if q["ok"] else "none", "console": msg,
                                   "detail": q["detail"], "game": base})
        except Exception as e:                                 # noqa: BLE001
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)
        return self._json({"ok": False, "err": f"未知路由 {u.path}"}, 404)


def serve(port: int = PORT) -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print(f"草木工作台 → http://127.0.0.1:{port}")
    srv.serve_forever()
