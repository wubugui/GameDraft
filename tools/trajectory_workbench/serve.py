# -*- coding: utf-8 -*-
"""轨迹工作台本地服务。

  GET  /                                  viewer
  GET  /gen/runtime.bundle.js             运行时 sceneSpace + trajectoryProjection 打成的 ESM
                                          （页面拿它跟自己的 SceneCal 对一次坐标，见 bundle.py）
  GET  /api/boot                          启动参数（--open 的资产 id，只发一次）
  GET  /api/scenes                        工程场景清单（深度 / 时段背景 / 行走面场状态）
  GET  /api/scene?id=&bg=                 场景描述：标定、尺寸、NPC 清单、时段背景
  GET  /api/scene_bg?id=&bg=[&w=1600]     背景图（w= 时按宽缩放成 PNG，服务端缓存；不给 w 原文件直出）
  GET  /api/scene_mesh?id=&bg=&stride=    3D 视图三角网（世界 wu + uv，二进制）
  GET  /api/scene_ground?id=&bg=          行走面深度场（work 分辨率 f32，二进制；前端拾取用）
  GET  /api/scene_shell?id=&bg=           深度壳（可见表面）深度场，同格式；前端把点放到桌面/台阶上 + 画障碍层用
  GET  /api/scene_heightfield?id=&bg=     世界 XZ 地面高度场（前端把 {x,z,h} 控制点抬到地面用）
  GET  /api/entity?scene=&bg=&npc=        实体预览元信息（世界尺寸 / 锚点 / 接地偏移）
  GET  /api/entity_png?scene=&bg=&npc=    实体首帧 PNG
  GET  /api/trajectories                  资产清单
  GET  /api/trajectory?id=                一份资产
  POST /api/bake        body=资产文档     只烘不存：帧 + 预览曲线 + 告警（前端每次改动都调）
  POST /api/save        body=资产文档     烘一次再原子写盘（source 与 keyframes 永远同一次烘的）
  POST /api/delete      body={id}
  POST /api/rename      body={id, to}

一切响应 ``Cache-Control: no-store``；错误以 ``{ok:false, err}`` 回给前端而不是断连。
几何按 (场景, 背景) 缓存（LRU 3；背景 / 深度图改了自动重载）。
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

from tools.trajectory_workbench import assets                                   # noqa: E402
from tools.trajectory_workbench import bundle                                   # noqa: E402
from tools.trajectory_workbench.baking import bake_asset, binding_of             # noqa: E402
from tools.trajectory_workbench.geometry import (                                # noqa: E402
    SCENES_RT,
    SceneGeometry,
    contact_offset_y,
    entity_preview,
    list_scenes,
    scene_paths,
)

PORT = 5321
#: ``--open <id>``：桌面壳启动时带进来的资产 id，前端 ``/api/boot`` 取一次即清。
BOOT_OPEN: list[str] = []

_geoms: dict[tuple[str, str], tuple[tuple[float, float], SceneGeometry]] = {}
_GEOM_CACHE_MAX = 3
_bg_cache: dict[tuple[str, str, int], tuple[float, bytes]] = {}
_BG_CACHE_MAX = 6


def scaled_background(sid: str, name: str, width: int) -> bytes:
    """背景图按宽缩放成 PNG（原图 2048–4096 宽、几 MB，画布与 3D 贴图不需要那么大）。按 mtime 缓存。"""
    import io
    from PIL import Image
    f = SCENES_RT / sid / name
    mt = f.stat().st_mtime
    key = (sid, name, width)
    hit = _bg_cache.get(key)
    if hit and hit[0] == mt:
        return hit[1]
    img = Image.open(f).convert("RGB")
    if img.width > width:
        img = img.resize((width, max(1, round(img.height * width / img.width))), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=False, compress_level=3)
    data = buf.getvalue()
    _bg_cache.pop(key, None)
    _bg_cache[key] = (mt, data)
    while len(_bg_cache) > _BG_CACHE_MAX:
        _bg_cache.pop(next(iter(_bg_cache)))
    return data


def _stamp(sid: str, bg: str) -> tuple[float, float]:
    rt = SCENES_RT / sid
    bgp = rt / bg
    cfg = (scene_paths(sid)["depth_cfg"]) or {}
    dp = rt / cfg.get("depth_map", "raw_depth_rg.png")
    return (bgp.stat().st_mtime if bgp.exists() else 0.0, dp.stat().st_mtime if dp.exists() else 0.0)


def get_geometry(sid: str, bg: str | None) -> SceneGeometry:
    """按 (场景, 背景) 缓存；背景或深度图 mtime 变了就重载。"""
    if not sid:
        raise ValueError("缺 scene id")
    p = scene_paths(sid)
    bg_name = bg or p["bg_name"]
    key = (sid, bg_name)
    st = _stamp(sid, bg_name)
    hit = _geoms.get(key)
    if hit and hit[0] == st:
        _geoms[key] = _geoms.pop(key)
        return hit[1]
    g = SceneGeometry(sid, bg_name)
    _geoms.pop(key, None)
    _geoms[key] = (st, g)
    while len(_geoms) > _GEOM_CACHE_MAX:
        _geoms.pop(next(iter(_geoms)))
    return g


def _doc_geometry(doc: dict, backdrop: dict | None = None) -> SceneGeometry | None:
    """场景曲线用 ``authoring.sceneId``；相对曲线不绑场景，用前端此刻的背景场景 ``backdrop={scene,bg}``（不写进数据）。"""
    au = doc.get("authoring") if isinstance(doc.get("authoring"), dict) else {}
    sid = str(au.get("sceneId") or "").strip()
    bg = str(au.get("background") or "").strip() or None
    if binding_of(doc) == "free" or not sid:
        bd = backdrop if isinstance(backdrop, dict) else {}
        if str(bd.get("scene") or "").strip():
            sid = str(bd.get("scene") or "").strip()
            bg = str(bd.get("bg") or "").strip() or None
    if not sid:
        return None
    return get_geometry(sid, bg)


def bake_document(doc: dict, backdrop: dict | None = None) -> dict:
    """烘一份资产文档（不写盘）。场景装不上时返回带告警的空产物。"""
    empty = {"keyframes": [], "authoring": dict(doc.get("authoring") or {}), "slots": doc.get("slots") or [],
             "source": doc.get("source") or {}, "binding": binding_of(doc), "segments": [], "totalMs": 0.0,
             "preview": {"screen": [], "world": []}}
    try:
        geom = _doc_geometry(doc, backdrop)
    except FileNotFoundError as e:
        return {**empty, "warnings": [f"场景装不上：{e}"]}
    if geom is None:
        return {**empty, "warnings": ["不知道在哪个场景烘：场景曲线要有 authoring.sceneId，相对曲线要带当前背景场景"]}
    return bake_asset(doc, geom)


def save_document(doc: dict, backdrop: dict | None = None) -> dict:
    """烘一次再写盘。烘不出帧时**保留旧帧**（磁盘上的那份），绝不拿空表清盘。
    相对曲线（``binding:'free'``）落盘时剥掉 ``authoring.sceneId / background``——它不绑场景，画在哪只是这一次的背景。"""
    tid = str(doc.get("id") or "").strip()
    if not assets.valid_id(tid):
        raise ValueError(f"非法轨迹 id: {tid!r}")
    baked = bake_document(doc, backdrop)
    out = dict(doc)
    out["id"] = tid
    out["binding"] = baked["binding"]
    out["slots"] = baked["slots"]
    out["source"] = baked["source"]   # 迁移过的副本（bake 参数回填、第 0 段起点明写）
    out["authoring"] = dict(baked["authoring"])
    if out["binding"] == "free":
        out["authoring"].pop("sceneId", None)
        out["authoring"].pop("background", None)
    elif not str(out["authoring"].get("sceneId") or "").strip():
        raise ValueError("场景曲线必须绑定作者场景（authoring.sceneId 为空）")
    if baked["keyframes"]:
        out["keyframes"] = baked["keyframes"]
        if baked.get("worldKeyframes"):
            out["worldKeyframes"] = baked["worldKeyframes"]
        else:
            out.pop("worldKeyframes", None)
    else:
        old = assets.load_asset(tid) if assets.asset_path(tid).is_file() else None
        if old and old.get("keyframes"):
            out["keyframes"] = old["keyframes"]
            if old.get("worldKeyframes"):
                out["worldKeyframes"] = old["worldKeyframes"]
            baked["warnings"].append("这次没烘出帧，磁盘上的旧帧原样保留")
        else:
            raise ValueError("没有可保存的帧：至少要有一段能烘出东西（" + "；".join(baked["warnings"]) + "）")
    path = assets.save_asset(out)
    saved = assets.load_asset(tid) or out
    return {"doc": saved, "path": _rel(path), "bake": baked}


def _rel(path: Path) -> str:
    """工程内路径显示成相对仓库根；资产目录被指到仓库外（测试用 tmp）时原样给绝对路径。"""
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


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

    def _bytes(self, data: bytes, ctype: str, extra: dict | None = None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (extra or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(data)

    def _body_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > 64 * 1024 * 1024:
            raise ValueError("请求体为空或过大")
        return json.loads(self.rfile.read(n) or b"{}")

    def log_message(self, *a):  # noqa: D401 — 工具服务不刷请求日志
        pass

    def handle(self):
        # 桌面窗口关掉时在飞的请求会被对端掐断：这是收尾噪音，不是错误，别在控制台刷一段回溯
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
            if u.path == "/gen/runtime.bundle.js":
                p, err = bundle.ensure_bundle()
                if not p or not p.exists():
                    return self._json({"ok": False, "err": err or "没有打包产物"}, 404)
                return self._bytes(p.read_bytes(), "text/javascript; charset=utf-8")
            if u.path == "/api/boot":
                open_id = BOOT_OPEN.pop() if BOOT_OPEN else ""
                p, err = bundle.ensure_bundle()
                return self._json({"ok": True, "open": open_id,
                                   "bundle": {"ok": bool(p and not err), "err": err}})
            if u.path == "/api/scenes":
                return self._json({"ok": True, "scenes": list_scenes()})
            if u.path == "/api/scene":
                g = get_geometry(arg("id"), arg("bg") or None)
                return self._json({"ok": True, "scene": g.summary()})
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
            if u.path == "/api/scene_mesh":
                g = get_geometry(arg("id"), arg("bg") or None)
                if not g.has_depth:
                    return self._json({"ok": False, "err": "场景没有深度"}, 404)
                stride = max(1, min(8, int(arg("stride", "2"))))
                return self._bytes(g.mesh_bytes(stride=stride), "application/octet-stream")
            if u.path == "/api/scene_heightfield":
                g = get_geometry(arg("id"), arg("bg") or None)
                if not g.has_depth:
                    return self._json({"ok": False, "err": "场景没有深度"}, 404)
                return self._bytes(g.heightfield_bytes(), "application/octet-stream")
            if u.path == "/api/scene_ground":
                g = get_geometry(arg("id"), arg("bg") or None)
                if not g.has_depth:
                    return self._json({"ok": False, "err": "场景没有深度"}, 404)
                return self._bytes(g.ground_bytes(), "application/octet-stream")
            if u.path == "/api/scene_shell":
                g = get_geometry(arg("id"), arg("bg") or None)
                if not g.has_depth:
                    return self._json({"ok": False, "err": "场景没有深度"}, 404)
                return self._bytes(g.shell_bytes(), "application/octet-stream")
            if u.path in ("/api/entity", "/api/entity_png"):
                g = get_geometry(arg("scene"), arg("bg") or None)
                pv = entity_preview(g.data, arg("npc"))
                if pv is None:
                    return self._json({"ok": False, "err": "实体没有可预览的图"}, 404)
                if u.path == "/api/entity_png":
                    return self._bytes(pv["png"], "image/png")
                meta = {k: v for k, v in pv.items() if k != "png"}
                meta["contactOffsetY"] = contact_offset_y(pv)
                return self._json({"ok": True, "entity": meta})
            if u.path == "/api/trajectories":
                return self._json({"ok": True, "trajectories": assets.list_assets()})
            if u.path == "/api/trajectory":
                doc = assets.load_asset(arg("id"))
                if doc is None:
                    return self._json({"ok": False, "err": "资产不存在"}, 404)
                return self._json({"ok": True, "doc": doc})
            return super().do_GET()
        except Exception as e:  # noqa: BLE001 — 工具服务：报错给前端而不是断连
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)

    # ----------------------------------------------------------------- POST
    def do_POST(self):
        u = urlparse(self.path)
        try:
            body = self._body_json()
            if u.path == "/api/bake":
                doc = body.get("doc") if isinstance(body.get("doc"), dict) else body
                return self._json({"ok": True, **bake_document(doc, body.get("backdrop"))})
            if u.path == "/api/save":
                doc = body.get("doc") if isinstance(body.get("doc"), dict) else body
                return self._json({"ok": True, **save_document(doc, body.get("backdrop"))})
            if u.path == "/api/delete":
                tid = str(body.get("id") or "")
                return self._json({"ok": True, "deleted": assets.delete_asset(tid)})
            if u.path == "/api/rename":
                p = assets.rename_asset(str(body.get("id") or ""), str(body.get("to") or ""))
                return self._json({"ok": True, "path": _rel(p)})
            return self._json({"ok": False, "err": "unknown endpoint"}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)


def main(port: int = PORT) -> None:
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    main()
