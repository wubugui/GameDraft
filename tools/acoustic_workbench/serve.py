# -*- coding: utf-8 -*-
"""声学工作台本地服务。

  GET  /                                  viewer
  GET  /gen/acoustic.bundle.js            运行时 acousticSpace.ts 打成的 ESM（抽头 / IR 与游戏同一份实现）
  GET  /api/boot                          启动参数（--open 的空间 id，只发一次；游戏地址；打包状态）
  GET  /api/scenes                        工程场景清单（深度 / 背景 / 绑定的空间）
  GET  /api/scene?id=&bg=                 场景描述：标定、尺寸、NPC、出生点脚下的世界点、声学绑定
  GET  /api/scene_bg?id=&bg=[&w=1600]     背景图（服务端缩放缓存）
  GET  /api/scene_mesh|scene_ground|scene_shell|scene_heightfield?id=&bg=   3D 视图数据（与轨迹工作台同格式、同一份几何）
  GET  /api/spaces                        空间库清单
  GET  /api/space?id=                     一个空间
  GET  /api/probes                        试听干声清单（id / 标签 / 时长）
  POST /api/save        {id, def}         校验后原子写盘（.bak）
  POST /api/create      {id, sceneId, background?, label?}
  POST /api/delete      {id}
  POST /api/rename      {id, to}          被场景绑定着时拒绝
  POST /api/duplicate   {id, to}
  GET  /api/link/config                   游戏地址
  POST /api/link/config {gameUrl}
  POST /api/link/publish {spaceId, def, probe?, sceneId?}   → 游戏 dev server 的槽
  GET  /api/link/status                   游戏回传的状态（场景 / 听者 / 抽头 / 耗时 / 音频解锁）
  POST /api/link/switch_scene {sceneId}   让游戏切场景（运行时命令队列）
  POST /api/link/launch {sceneId}         一键拉起：游戏在跑→切场景；dev server 在跑→开页；都没有→让开发控制台起（没控制台就自己起）

一切响应 ``Cache-Control: no-store``；错误以 ``{ok:false, err}`` 回给前端而不是断连。
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

from tools.acoustic_workbench import bundle, spaces                                # noqa: E402
from tools.acoustic_workbench.game_link import GameLink, enqueue_switch_scene       # noqa: E402
from tools.trajectory_workbench.geometry import SCENES_RT, list_scenes, scene_paths  # noqa: E402
from tools.trajectory_workbench.serve import get_geometry, scaled_background       # noqa: E402

PORT = 5331
#: ``--open <id>``：桌面壳启动时带进来的空间 id，前端 ``/api/boot`` 取一次即清。
BOOT_OPEN: list[str] = []
#: 与游戏的联动（进程内一份；页面刷新不丢连接状态）
LINK = GameLink()

#: 试听干声：必须是干声，自带回音的素材会叠两层。与 F2 页 `ACOUSTIC_PROBES` 同一批。
PROBES = [
    {"id": "sfx_pebble_scatter_dry", "label": "碎石 0.8s", "seconds": 0.79},
    {"id": "sfx_gibbon_dry_a", "label": "猿啼 3.0s", "seconds": 3.0},
    {"id": "sfx_jump_takeoff_dry", "label": "起跳 1.3s", "seconds": 1.34},
    {"id": "sfx_land_scree_dry", "label": "落地 6.0s", "seconds": 6.0},
]


def scene_summary(sid: str, bg: str | None) -> dict:
    """轨迹工作台的场景描述 + 声学要的几样：绑定、听者模式、出生点与 NPC 脚下的世界点。"""
    g = get_geometry(sid, bg)
    s = g.summary()
    d = g.data
    s["acousticSpace"] = d.get("acousticSpace")
    s["acousticListener"] = d.get("acousticListener")
    marks = []
    sp = d.get("spawnPoint")
    if g.has_depth and isinstance(sp, dict):
        w = g.scene_to_world_ground(float(sp.get("x", 0)), float(sp.get("y", 0)))
        # scene 一并给：页面拿它过运行时打包来的 groundWorldAt，与这里算的 world 对一次（坐标对齐自证）
        marks.append({"kind": "spawn", "id": "出生点", "scene": [float(sp.get("x", 0)), float(sp.get("y", 0))],
                      "world": [float(w[0]), float(w[1]), float(w[2])]})
    for n in (d.get("npcs") or []):
        if not isinstance(n, dict) or not g.has_depth:
            continue
        try:
            w = g.scene_to_world_ground(float(n.get("x", 0)), float(n.get("y", 0)))
        except Exception:  # noqa: BLE001 — 单个 NPC 坐标坏了不拖垮整份描述
            continue
        marks.append({"kind": "npc", "id": str(n.get("id") or "?"), "scene": [float(n.get("x", 0)), float(n.get("y", 0))],
                      "world": [float(w[0]), float(w[1]), float(w[2])]})
    s["marks"] = marks
    return s


def scenes_with_bindings() -> list[dict]:
    rows = list_scenes()
    for r in rows:
        try:
            d = json.loads((ROOT / "public" / "assets" / "scenes" / f"{r['id']}.json").read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 — 坏 JSON 只是这一行没有绑定信息
            d = {}
        r["acousticSpace"] = d.get("acousticSpace") if isinstance(d, dict) else None
        r["acousticListener"] = d.get("acousticListener") if isinstance(d, dict) else None
    return rows


class H(SimpleHTTPRequestHandler):
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
        if n <= 0 or n > 16 * 1024 * 1024:
            raise ValueError("请求体为空或过大")
        return json.loads(self.rfile.read(n) or b"{}")

    def log_message(self, *a):  # noqa: D401
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
            if u.path == "/gen/acoustic.bundle.js":
                p, err = bundle.ensure_bundle()
                if not p or not p.exists():
                    return self._json({"ok": False, "err": err or "没有打包产物"}, 404)
                return self._bytes(p.read_bytes(), "text/javascript; charset=utf-8")
            if u.path == "/api/boot":
                open_id = BOOT_OPEN.pop() if BOOT_OPEN else ""
                p, err = bundle.ensure_bundle()
                return self._json({"ok": True, "open": open_id, "gameUrl": LINK.base,
                                   "bundle": {"ok": bool(p and not err), "err": err}})
            if u.path == "/api/scenes":
                return self._json({"ok": True, "scenes": scenes_with_bindings()})
            if u.path == "/api/scene":
                return self._json({"ok": True, "scene": scene_summary(arg("id"), arg("bg") or None)})
            if u.path == "/api/scene_bg":
                sid, bg = arg("id"), arg("bg")
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
                g = get_geometry(arg("id"), arg("bg") or None)
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
            if u.path == "/api/spaces":
                return self._json({"ok": True, "spaces": spaces.list_spaces()})
            if u.path == "/api/space":
                d = spaces.get_space(arg("id"))
                if d is None:
                    return self._json({"ok": False, "err": "空间不存在"}, 404)
                return self._json({"ok": True, "id": arg("id"), "def": d})
            if u.path == "/api/probes":
                return self._json({"ok": True, "probes": PROBES})
            if u.path == "/api/link/config":
                return self._json({"ok": True, "gameUrl": LINK.base, "writer": LINK.writer})
            if u.path == "/api/link/status":
                return self._json(LINK.status())
            return super().do_GET()
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)

    # ----------------------------------------------------------------- POST
    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = self._body_json()
            if u.path == "/api/save":
                sid = str(body.get("id") or "").strip()
                path, norm = spaces.save_space(sid, body.get("def") or {})
                return self._json({"ok": True, "id": sid, "def": norm, "path": _rel(path)})
            if u.path == "/api/create":
                sid = str(body.get("id") or "").strip()
                d = spaces.create_space(sid, str(body.get("sceneId") or "").strip(),
                                        str(body.get("background") or "").strip(),
                                        str(body.get("label") or "").strip())
                return self._json({"ok": True, "id": sid, "def": d})
            if u.path == "/api/delete":
                return self._json({"ok": True, "deleted": spaces.delete_space(str(body.get("id") or ""))})
            if u.path == "/api/rename":
                spaces.rename_space(str(body.get("id") or ""), str(body.get("to") or "").strip())
                return self._json({"ok": True})
            if u.path == "/api/duplicate":
                d = spaces.duplicate_space(str(body.get("id") or ""), str(body.get("to") or "").strip())
                return self._json({"ok": True, "def": d})
            if u.path == "/api/link/config":
                return self._json({"ok": True, "gameUrl": LINK.set_base(str(body.get("gameUrl") or ""))})
            if u.path == "/api/link/publish":
                sid = str(body.get("spaceId") or "").strip()
                d = body.get("def")
                if not sid or not isinstance(d, dict):
                    return self._json({"ok": False, "err": "需要 spaceId + def"}, 400)
                # 发出去的就是校验过的落盘形：游戏那边的形状闸门与这里同口径
                norm = spaces.normalize_def(d)
                probe = body.get("probe") if isinstance(body.get("probe"), dict) else None
                return self._json(LINK.publish(sid, norm, probe, str(body.get("sceneId") or "") or None))
            if u.path == "/api/link/switch_scene":
                sid = str(body.get("sceneId") or "").strip()
                if not sid:
                    return self._json({"ok": False, "err": "需要 sceneId"}, 400)
                return self._json(enqueue_switch_scene(sid))
            if u.path == "/api/link/launch":
                # 一键拉起：游戏在跑就切场景，dev server 在跑就开页，都没有就让控制台（或自己）起
                sid = str(body.get("sceneId") or "").strip()
                if not sid:
                    return self._json({"ok": False, "err": "需要 sceneId"}, 400)
                r = LINK.launch(sid, force_open=bool(body.get("forceOpen")))
                if not r.get("ok"):
                    r["err"] = r.get("message") or "拉不起来"
                return self._json(r)
            return self._json({"ok": False, "err": "unknown endpoint"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)


def _rel(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main(port: int = PORT) -> None:
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    main()
