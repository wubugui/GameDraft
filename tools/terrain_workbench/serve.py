# -*- coding: utf-8 -*-
"""地形工作台本地服务。

  GET  /                                   viewer
  GET  /vendor/<name>.js                   轨迹工作台 viewer 下的共用件原样转发（common / gizmo / history / dropdown；不 fork）
  GET  /api/boot                           启动参数（--open 的场景 id，取一次即清；之后 = 最近装上的场景）
  GET  /api/scenes                         场景清单 + 地形状态（深度 / 网格 / 自动结果 / 作者层 / 待导出 / 有草稿）
  GET  /api/scene?id=[&bg=]                场景描述：标定、尺寸、标记点（出生点 / 出口 / 跨点 / NPC）、网格、时段目录
  GET  /api/scene_bg?id=&bg=[&w=]          背景图（服务端缩放缓存）
  GET  /api/scene_mesh|scene_ground|scene_shell|scene_heightfield?id=&bg=   3D 数据（与轨迹 / 粒子两台同一份几何）
  GET  /api/terrain?id=                    盘上的作者层 → 工作态 {doc, brush, height, auto, disk}
  POST /api/compose  {id, state}           服务端合成（真相）：blocked / src 栅格 + 统计
  POST /api/validate {id, state}           形状闸门 + 连通性（不写盘）
  POST /api/save     {id, state, baseUpdated?, force?}   写作者层（乐观并发；先留历史）
  GET  /api/history?id=    POST /api/restore {id, name}
  GET  /api/draft?id=      POST /api/draft {id, draft}    POST /api/draft/clear {id}
  POST /api/push     {id, state}           **推给游戏**：工作态合成进 local/terrain_preview/，让游戏原地换上；资源不动
  POST /api/push/notify {id}               只再告诉游戏一次"去装预览"
  POST /api/push/revoke {id}               撤掉预览（丢弃没保存的改动时），让游戏换回资源
  POST /api/export   {id}                  **导出到游戏**：盘上的作者层合成进资源，让游戏换回资源
  GET  /api/job/status                     推送 / 导出跑到哪了
  GET  /api/link/status                    游戏在不在、在哪个场景、探测结果
  POST /api/link/open {id}                 让游戏切到这个场景
  POST /api/link/probe {id, points}        请游戏用它自己的 isCollision 判这些画面点（运行时对齐）
  GET  /api/check?id=                      形状 + 磁盘一致 + 连通性（命令行 --check 同一份）

一切响应 ``Cache-Control: no-store``；错误以 ``{ok:false, err}`` 回给前端而不是断连（与另外四台同一条）。
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

from tools.acoustic_workbench import game_link                                   # noqa: E402
from tools.terrain_workbench import authoring                                    # noqa: E402
from tools.trajectory_workbench.geometry import SCENES_RT, scene_paths          # noqa: E402
from tools.trajectory_workbench.serve import get_geometry, scaled_background     # noqa: E402

PORT = 5361
BOOT_OPEN: list[str] = []
LAST_OPEN: list[str] = []
VENDOR = {
    "common.js": "tools/trajectory_workbench/viewer/common.js",
    "gizmo.js": "tools/trajectory_workbench/viewer/gizmo.js",
    "history.js": "tools/trajectory_workbench/viewer/history.js",
    "dropdown.js": "tools/trajectory_workbench/viewer/dropdown.js",
}


class H(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
        ".html": "text/html", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
    }

    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(TOOL), **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data: bytes, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > 96 * 1024 * 1024:
            raise ValueError("请求体为空或过大")
        return json.loads(self.rfile.read(n) or b"{}")

    def log_message(self, *a):  # noqa: D401 — 工具服务不刷请求日志
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    # ------------------------------------------------------------------ GET
    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)

        def arg(name: str, default: str = "") -> str:
            return q.get(name, [default])[0]

        try:
            if u.path == "/":
                self.path = "/viewer/index.html"
                return super().do_GET()
            if u.path.startswith("/vendor/"):
                rel = VENDOR.get(u.path[len("/vendor/"):])
                if not rel:
                    return self._json({"ok": False, "err": "不在共用件白名单里"}, 404)
                p = ROOT / rel
                if not p.is_file():
                    return self._json({"ok": False, "err": f"共用件不存在: {rel}"}, 404)
                return self._bytes(p.read_bytes(), "text/javascript; charset=utf-8")
            if u.path == "/api/boot":
                sid = BOOT_OPEN.pop() if BOOT_OPEN else (LAST_OPEN[0] if LAST_OPEN else "")
                return self._json({"ok": True, "open": sid, "game": game_link.discover_game_url(ROOT)})
            if u.path == "/api/scenes":
                return self._json({"ok": True, "scenes": authoring.scenes()})
            if u.path == "/api/scene":
                s = authoring.scene_summary(arg("id"), arg("bg") or None)
                LAST_OPEN[:] = [s["id"]]
                return self._json({"ok": True, "scene": s})
            if u.path == "/api/scene_bg":
                sid, bg = authoring.safe_sid(arg("id")), arg("bg")
                p = scene_paths(sid)
                name = bg or p["bg_name"]
                f = SCENES_RT / sid / name
                if not f.is_file():
                    return self._json({"ok": False, "err": f"背景不存在: {name}"}, 404)
                w = int(arg("w", "0") or 0)
                if w > 0:
                    return self._bytes(scaled_background(sid, name, max(64, min(w, 4096))), "image/png")
                ctype = "image/jpeg" if f.suffix.lower() in (".jpg", ".jpeg") else "image/png"
                return self._bytes(f.read_bytes(), ctype)
            if u.path in ("/api/scene_mesh", "/api/scene_heightfield", "/api/scene_ground", "/api/scene_shell"):
                g = get_geometry(authoring.safe_sid(arg("id")), arg("bg") or None)
                if not g.has_depth:
                    return self._json({"ok": False, "err": "场景没有深度（先在照明实验室烘一次）"}, 404)
                if u.path == "/api/scene_mesh":
                    stride = max(1, min(8, int(arg("stride", "2"))))
                    return self._bytes(g.mesh_bytes(stride=stride), "application/octet-stream")
                if u.path == "/api/scene_heightfield":
                    return self._bytes(g.heightfield_bytes(), "application/octet-stream")
                if u.path == "/api/scene_ground":
                    return self._bytes(g.ground_bytes(), "application/octet-stream")
                return self._bytes(g.shell_bytes(), "application/octet-stream")
            if u.path == "/api/terrain":
                return self._json({"ok": True, **authoring.layer_state(arg("id"))})
            if u.path == "/api/history":
                return self._json({"ok": True, "items": authoring.history(arg("id"))})
            if u.path == "/api/draft":
                return self._json({"ok": True, "draft": authoring.draft_get(arg("id"))})
            if u.path == "/api/job/status":
                return self._json({"ok": True, **authoring.job_status()})
            if u.path == "/api/link/status":
                return self._json({"ok": True, **authoring.link_status()})
            if u.path == "/api/check":
                return self._json({"ok": True, **authoring.check_scene(arg("id"))})
            return super().do_GET()
        except Exception as e:  # noqa: BLE001 — 报错给前端而不是断连
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)

    # ----------------------------------------------------------------- POST
    def do_POST(self):
        u = urlparse(self.path)
        try:
            b = self._body_json()
            sid = str(b.get("id") or "")
            if u.path == "/api/compose":
                return self._json({"ok": True, **authoring.compose(sid, b.get("state"))})
            if u.path == "/api/validate":
                return self._json(authoring.validate(sid, b.get("state")))
            if u.path == "/api/save":
                bu = b.get("baseUpdated")
                return self._json(authoring.save(sid, b.get("state"), str(bu) if bu else None, bool(b.get("force"))))
            if u.path == "/api/restore":
                return self._json(authoring.restore(sid, str(b.get("name") or "")))
            if u.path == "/api/draft":
                return self._json(authoring.draft_put(sid, b.get("draft")))
            if u.path == "/api/draft/clear":
                return self._json(authoring.draft_clear(sid))
            if u.path == "/api/push":
                return self._json(authoring.push_start(sid, b.get("state")))
            if u.path == "/api/push/notify":
                return self._json({"ok": True, **authoring.push_to_game(authoring.safe_sid(sid), "preview")})
            if u.path == "/api/push/revoke":
                return self._json(authoring.revoke_preview(sid))
            if u.path == "/api/export":
                return self._json(authoring.export_start(sid))
            if u.path == "/api/link/open":
                return self._json(authoring.open_in_game(sid))
            if u.path == "/api/link/probe":
                pts = b.get("points") if isinstance(b.get("points"), list) else []
                return self._json(authoring.probe_request(sid, pts))
            return self._json({"ok": False, "err": f"未知路由 {u.path}"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)


def main(port: int = PORT) -> None:
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    main()
