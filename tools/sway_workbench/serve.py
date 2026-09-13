# -*- coding: utf-8 -*-
"""草木工作台本地服务。

  GET  /                              viewer
  GET  /api/scenes                    场景清单 + 拆层状态
  GET  /api/layers?scene=             一个场景的拆层描述(尺寸 / sway.json / 有哪些图 / 实例表)
  GET  /api/img?scene=&kind=          原画 / 底板 / matte / ids / 刚体 / 作者涂层(PNG 原样)
  GET  /api/ch?scene=&name=           涂层的一层(**不透明灰度**;freeze 会并上旧的 sway_lock.png)
  POST /api/paint  {scene, channels, baseMtime?, force?}
                                      四层各一张不透明灰度图 → 合成 RGBA 原子写;顺带迁移掉旧锁定图。
                                      三道闸:盘上更新 ⇒ 拒(乐观并发)、大面积删除 ⇒ 要 force、每次留历史
  GET  /api/history?scene=            历史版本清单
  POST /api/restore {scene, name}     恢复某一份历史(恢复前当前这份也进历史)
  POST /api/bake   {scene}            **开线程**重烘(第一次要跑分割,几十秒),立刻返回;烘完自动推给游戏
  GET  /api/bake/status               烘到哪了(状态行 + 用时 + 完没完)
  GET  /api/inspect?scene=&x=&y=      点一下画面:这一点属于哪株、alpha / 叶度 / 自由度 / 刚体度
  POST /api/push   {scene}            只推不烘(游戏原地重装一次当前盘上的拆层)
  GET  /api/link/status               游戏在不在、在哪个场景
  POST /api/link/open {scene}         让在跑的游戏切到这个场景(= 重新装一次拆层,看真效果)

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
            if u.path == "/api/boot":
                sid = BOOT_OPEN.pop(0) if BOOT_OPEN else ""
                return self._json({"ok": True, "open": sid, "game": game_link.discover_game_url(ROOT)})
            if u.path == "/api/scenes":
                return self._json({"ok": True, "scenes": layers.scenes()})
            if u.path == "/api/layers":
                return self._json({"ok": True, **layers.layers(one("scene"))})
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
            if u.path == "/api/bake/status":
                return self._json({"ok": True, **layers.bake_status()})
            if u.path == "/api/inspect":
                return self._json({"ok": True, **layers.inspect(one("scene"), float(one("x", "0")), float(one("y", "0")))})
            if u.path == "/api/history":
                return self._json({"ok": True, "items": layers.history(one("scene"))})
            if u.path == "/api/link/status":
                # ⚠ 按**推送用的那条槽**判在不在(`find_game` 实探),别拿控制台状态判:
                # 控制台是另一个服务,游戏跑着它也可能没应答,徽章就会长期显示"没开着"(实测过)
                base = layers.find_game()
                st = game_link.console_state() or {}
                return self._json({"ok": True, "game": base, "alive": bool(base), "state": st})
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
            if u.path == "/api/restore":
                return self._json(layers.restore(str(b.get("scene") or ""), str(b.get("name") or "")))
            if u.path == "/api/bake":
                return self._json(layers.bake_start(str(b.get("scene") or "")))
            if u.path == "/api/push":
                return self._json({"ok": True, **layers.push_to_game(str(b.get("scene") or ""))})
            if u.path == "/api/link/open":
                sid = str(b.get("scene") or "")
                ok, msg = game_link.console_open_dev_entry(sid)
                if not ok:
                    msg2 = game_link.enqueue_switch_scene(sid, ROOT)
                    return self._json({"ok": True, "via": "queue", "detail": msg2, "console": msg})
                return self._json({"ok": True, "via": "console", "detail": msg})
        except Exception as e:                                 # noqa: BLE001
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)
        return self._json({"ok": False, "err": f"未知路由 {u.path}"}, 404)


def serve(port: int = PORT) -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", port), H)
    print(f"草木工作台 → http://127.0.0.1:{port}")
    srv.serve_forever()
