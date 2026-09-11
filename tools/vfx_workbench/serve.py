# -*- coding: utf-8 -*-
"""粒子工作台本地服务。

  GET  /                                  viewer
  GET  /vendor/<name>.js                  轨迹工作台 viewer 下的共用件原样转发（common.js / gizmo.js / history.js）
                                          —— 不 fork：声学台内联抄过一份 GZ，那是已知欠账，不加第三份
  GET  /gen/vfx.bundle.js                 运行时 vfxSim + vfxSpace + sceneSpace + 两个场打成的 ESM
  GET  /api/boot                          启动参数（--open 的效果 id，只发一次；游戏地址；打包状态）
  GET  /api/scenes                        工程场景清单（深度 / 时段背景 / 行走面场状态）
  GET  /api/scene?id=&bg=                 场景描述：标定、尺寸、NPC、出生点 / NPC 脚下的世界点
  GET  /api/scene_bg?id=&bg=[&w=1600]     背景图（服务端缩放缓存）
  GET  /api/scene_mesh|scene_ground|scene_shell|scene_heightfield?id=&bg=   3D 数据（与轨迹工作台同格式、同一份几何）
  POST /api/shell_probe {id, bg, points}  服务端 SceneGeometry.shell_contact（页面拿它跟运行时 shellContactAt 对）
  GET  /api/effects                       效果资产清单
  GET  /api/effect?id=                    一份效果
  GET  /api/sfx                           音效 id 清单（声音模块的选择器候选）
  GET  /api/anims                         可用动画包 / 单图清单（外观模块的选择器候选）
  POST /api/save      {doc}               归一化校验后原子写盘
  POST /api/create    {id, sceneId?, background?, label?}
  POST /api/delete    {id}
  POST /api/rename    {id, to}
  POST /api/duplicate {id, to}
  POST /api/validate  {doc}               只校验不写盘（保存前给状态栏用）
  GET  /api/link/config     POST /api/link/config {gameUrl}
  POST /api/link/publish {effectId, def, probe?, sceneId?}   → 游戏 dev server 的槽
  GET  /api/link/status                   游戏回传的状态（场景 / 实例 / stats / 玩家脚点）
  POST /api/link/launch  {sceneId}        一键拉起游戏进本场景

一切响应 ``Cache-Control: no-store``；错误以 ``{ok:false, err}`` 回给前端而不是断连。
几何直接用轨迹工作台的 ``get_geometry``（同一份 LRU 缓存、同一份 ``SceneGeometry``）。
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

from tools.trajectory_workbench.geometry import SCENES_RT, list_scenes, scene_paths  # noqa: E402
from tools.trajectory_workbench.serve import get_geometry, scaled_background         # noqa: E402
from tools.vfx_workbench import assets, bundle                                       # noqa: E402
from tools.vfx_workbench.game_link import VfxLink                                    # noqa: E402

PORT = 5341
#: ``--open <id>``：桌面壳启动时带进来的效果 id，前端 ``/api/boot`` 取一次即清。
BOOT_OPEN: list[str] = []
#: 与游戏的联动（进程内一份；页面刷新不丢连接状态）
LINK = VfxLink()

#: 轨迹工作台 viewer 下可以原样借用的共用件（白名单，不许拿路径拼任意文件）
VENDOR = {
    "common.js": "tools/trajectory_workbench/viewer/common.js",
    "gizmo.js": "tools/trajectory_workbench/viewer/gizmo.js",
    "history.js": "tools/trajectory_workbench/viewer/history.js",
}


def scene_summary(sid: str, bg: str | None) -> dict:
    """轨迹工作台的场景描述 + 粒子要的几样：出生点与 NPC 脚下的世界点（坐标自证 / 放玩家标记用）。"""
    g = get_geometry(sid, bg)
    s = g.summary()
    d = g.data
    marks = []
    sp = d.get("spawnPoint")
    if g.has_depth and isinstance(sp, dict):
        w = g.scene_to_world_ground(float(sp.get("x", 0)), float(sp.get("y", 0)))
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
    # 场景里已经摆着的实例（主编辑器写的），工作台左栏显示"这个效果被谁用着"
    s["vfx"] = [v for v in (d.get("vfx") or []) if isinstance(v, dict)]
    return s


def shell_probe(sid: str, bg: str | None, points: list) -> list:
    """服务端的壳接触（``SceneGeometry.shell_contact``），给页面跟运行时 ``shellContactAt`` 对齐用。"""
    g = get_geometry(sid, bg)
    out: list = []
    for p in points:
        if not (isinstance(p, (list, tuple)) and len(p) == 3):
            out.append(None)
            continue
        c = g.shell_contact(float(p[0]), float(p[1]), float(p[2]))
        out.append(None if c is None else {"penWu": c["pen_wu"], "normal": list(c["normal"]),
                                          "px": c["px"], "py": c["py"], "groundLike": bool(c["ground_like"])})
    return out


def sfx_ids() -> list[dict]:
    """``audio_config.json`` 里的 sfx 清单（声音模块的候选；工作台只读它）。"""
    p = ROOT / "public" / "assets" / "data" / "audio_config.json"
    try:
        cfg = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    rows: list[dict] = []
    sfx = cfg.get("sfx") if isinstance(cfg, dict) else None
    if isinstance(sfx, dict):
        for k, v in sfx.items():
            rows.append({"id": str(k), "label": str((v or {}).get("label") or "") if isinstance(v, dict) else ""})
    elif isinstance(sfx, list):
        for v in sfx:
            if isinstance(v, dict) and v.get("id"):
                rows.append({"id": str(v["id"]), "label": str(v.get("label") or "")})
    return sorted(rows, key=lambda r: r["id"])


def appearance_sources() -> dict:
    """外观可选的贴图来源：``anim.json`` 动画包与 ``images/vfx/`` 下的单图（工作台只读）。"""
    anims: list[str] = []
    base = ROOT / "public" / "resources" / "runtime" / "animation"
    if base.is_dir():
        for p in sorted(base.glob("*/anim.json")):
            anims.append("/resources/runtime/animation/" + p.parent.name + "/anim.json")
    images: list[str] = []
    imgs = ROOT / "public" / "resources" / "runtime" / "images" / "vfx"
    if imgs.is_dir():
        for p in sorted(imgs.iterdir()):
            if p.suffix.lower() in (".png", ".webp", ".jpg", ".jpeg"):
                images.append("/resources/runtime/images/vfx/" + p.name)
    return {"anims": anims, "images": images}


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(TOOL), **k)

    def end_headers(self):
        # 零缓存三件套：HTTP/1.1、HTTP/1.0、过期时间。桌面壳那边还有纯内存 profile + NoCache 兜着。
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
        if n <= 0 or n > 32 * 1024 * 1024:
            raise ValueError("请求体为空或过大")
        return json.loads(self.rfile.read(n) or b"{}")

    def log_message(self, *a):  # noqa: D401 — 工具服务不刷请求日志
        pass

    def handle(self):
        # 桌面窗口关掉时在飞的请求会被对端掐断：这是收尾噪音，不是错误
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
            if u.path == "/gen/vfx.bundle.js":
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
                return self._json({"ok": True, "scenes": list_scenes()})
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
            if u.path == "/api/effects":
                return self._json({"ok": True, "effects": assets.list_assets()})
            if u.path == "/api/effect":
                doc = assets.load_asset(arg("id"))
                if doc is None:
                    return self._json({"ok": False, "err": "效果不存在"}, 404)
                return self._json({"ok": True, "doc": doc})
            if u.path == "/api/sfx":
                return self._json({"ok": True, "sfx": sfx_ids()})
            if u.path == "/api/anims":
                return self._json({"ok": True, **appearance_sources()})
            if u.path == "/api/link/config":
                return self._json({"ok": True, "gameUrl": LINK.base, "writer": LINK.writer})
            if u.path == "/api/link/status":
                return self._json(LINK.status())
            return super().do_GET()
        except Exception as e:  # noqa: BLE001 — 工具服务：报错给前端而不是断连
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)

    # ----------------------------------------------------------------- POST
    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = self._body_json()
            if u.path == "/api/shell_probe":
                pts = body.get("points") if isinstance(body.get("points"), list) else []
                return self._json({"ok": True, "contacts": shell_probe(str(body.get("id") or ""),
                                                                      str(body.get("bg") or "") or None, pts)})
            if u.path == "/api/validate":
                doc = body.get("doc") if isinstance(body.get("doc"), dict) else body
                warn: list[str] = []
                norm = assets.normalize_effect(doc, warn)
                return self._json({"ok": True, "def": norm, "warnings": warn})
            if u.path == "/api/save":
                doc = body.get("doc") if isinstance(body.get("doc"), dict) else body
                path, norm, warn = assets.save_asset(doc)
                return self._json({"ok": True, "doc": norm, "path": _rel(path), "warnings": warn})
            if u.path == "/api/create":
                eid = str(body.get("id") or "").strip()
                if assets.asset_path(eid).exists():
                    return self._json({"ok": False, "err": f"效果 {eid!r} 已存在"}, 400)
                doc = assets.new_effect(eid, str(body.get("label") or ""), str(body.get("sceneId") or ""),
                                       str(body.get("background") or ""))
                path, norm, warn = assets.save_asset(doc)
                return self._json({"ok": True, "doc": norm, "path": _rel(path), "warnings": warn})
            if u.path == "/api/delete":
                return self._json({"ok": True, "deleted": assets.delete_asset(str(body.get("id") or ""))})
            if u.path == "/api/rename":
                p = assets.rename_asset(str(body.get("id") or ""), str(body.get("to") or "").strip())
                return self._json({"ok": True, "path": _rel(p)})
            if u.path == "/api/duplicate":
                p, norm = assets.duplicate_asset(str(body.get("id") or ""), str(body.get("to") or "").strip())
                return self._json({"ok": True, "doc": norm, "path": _rel(p)})
            if u.path == "/api/link/config":
                return self._json({"ok": True, "gameUrl": LINK.set_base(str(body.get("gameUrl") or ""))})
            if u.path == "/api/link/publish":
                eid = str(body.get("effectId") or "").strip()
                d = body.get("def")
                if not eid or not isinstance(d, dict):
                    return self._json({"ok": False, "err": "需要 effectId + def"}, 400)
                # 发出去的就是校验过的落盘形：游戏那边的形状闸门与这里同口径
                norm = assets.normalize_effect(d)
                probe = body.get("probe") if isinstance(body.get("probe"), dict) else None
                return self._json(LINK.publish(eid, norm, probe, str(body.get("sceneId") or "") or None))
            if u.path == "/api/link/launch":
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
    """工程内路径显示成相对仓库根；资产目录被指到仓库外（测试用 tmp）时原样给绝对路径。"""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main(port: int = PORT) -> None:
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    main()
