# -*- coding: utf-8 -*-
"""燃烧工作台本地服务（一切响应 ``Cache-Control: no-store``；错误以 ``{ok:false, err}`` 回给页面而不是断连）。

  GET  /                                  viewer
  GET  /vendor/dropdown.js                页内下拉（轨迹台那份原样，不 fork；不走系统原生弹窗）
  GET  /gen/burn.bundle.js                运行时燃烧纯函数 + 世界空间 + 站位打成的 ESM（``bundle.py``）
  GET  /gen/burnShade.glsl                ``src/rendering/burn/burnShade.glsl`` 原文（页面按标记切片，与游戏滤镜同一份）
  GET  /resources/… /assets/…             工程 public 下的图片 / JSON（原画、场景视图里各模板的图；只放行图与 JSON）
  GET  /api/boot                          启动参数（--open 的模板 id 只发一次；游戏地址；打包状态；工程根自证）
  GET  /api/burnables                     模板清单
  GET  /api/burnable?id=                  一份模板 + 「用在哪」
  GET  /api/refs?id=                      「用在哪」：引用这份模板的所有宿主（热点 / NPC 带场景与实体、挂件预设、spawn 规格所在文件、粒子效果）
  GET  /api/images                        原画候选（public/resources/runtime 下全部图 + 哪些模板在用 + 热点展示图写过的世界尺寸）
  GET  /api/player                        玩家动画包 anim.json + sockets.json + 图集像素尺寸 + stateMap + playerActs.ignite
  GET  /api/presets                       写了 igniter 的挂件预设 + 贴图像素尺寸（站位用）
  GET  /api/effects                       粒子效果 id（particles.effect 下拉）
  GET  /api/scene?id=                     只读场景视图：尺寸、开了可燃的实体（transform / 透视与朝向原始字段 / burnable 块）、风、透视、几何标定
  GET  /api/scene_bg?id=&w=               背景图（缩放）
  GET  /api/scene_ground|scene_shell?id=  行走面 / 深度壳（与轨迹 / 粒子台同格式同一份几何；只有真工程有）
  POST /api/walk_check {sceneId, points}  站位能不能站（本地：边界 + 与 isCollision 同一条反投影）
  POST /api/validate {doc}                只过形状闸门不写盘
  POST /api/save {doc, base}              形状闸门 → 原子写（盘上被别处改过拒绝；内容没变不写）
  POST /api/create {id, image, widthCm, heightCm, label?, mode?, orientation?}   尺寸必填
  POST /api/duplicate {id, to, doc?}      带 doc = 副本取页面工作态（源文件不动）
  POST /api/rename_plan {id, to}          改名要改哪些文件（每个几处）+ 确认单 expect（文件摘要）
  POST /api/rename {id, to, expect}       一次事务：新模板文件 + 每个引用处的 template 值 + 删旧文件；确认之后有文件被改过就拒绝
  POST /api/delete {id}                   还有引用 ⇒ 不删、回 refs；没有才删
  GET  /api/link/config  POST /api/link/config {gameUrl}
  POST /api/link/publish {burnables?, probe?, walk?}   推给游戏（工作态过闸门；过不了的那份推盘上那份并说原因）
  GET  /api/link/status                   游戏回传的状态页
  POST /api/link/launch {sceneId}         一键拉起游戏进那个场景
"""
from __future__ import annotations

import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

TOOL = Path(__file__).resolve().parent
ROOT = TOOL.parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.burn_workbench import bundle, scenes, store     # noqa: E402
from tools.burn_workbench.game_link import BurnLink        # noqa: E402

PORT = 5351
BOOT_OPEN: list[str] = []
LINK = BurnLink()

VENDOR = {"dropdown.js": "tools/trajectory_workbench/viewer/dropdown.js"}
_JS_MIME = "text/javascript; charset=utf-8"


def _rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def _publish_burnables(body: dict) -> tuple[dict | None, list[str]]:
    """推给游戏之前过同一道形状闸门：过不了的模板推盘上那份（没有就不推它）并说原因。"""
    notes: list[str] = []
    raw = body.get("burnables")
    if not isinstance(raw, dict):
        return None, notes
    out: dict = {}
    for bid, doc in raw.items():
        try:
            norm, _w = store.normalize(doc, bid)
            out[bid] = norm
        except ValueError as e:
            try:
                disk = store.load_asset(bid) if store.valid_id(bid) else None
                if disk is not None:
                    out[bid] = store.normalize(disk, bid)[0]
                    notes.append(f"「{bid}」形状不对，推的是盘上那份：{e}")
                else:
                    notes.append(f"「{bid}」形状不对，没推：{e}")
            except (OSError, ValueError):
                notes.append(f"「{bid}」形状不对，没推：{e}")
    return out, notes


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(TOOL), **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def guess_type(self, path):  # noqa: D401 — Windows 注册表常把 .js 映射成 text/plain，模块脚本会被拒
        if str(path).endswith(".js"):
            return _JS_MIME
        return super().guess_type(path)

    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data: bytes, ctype: str, code: int = 200):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body_json(self) -> dict:
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > 64 * 1024 * 1024:
            raise ValueError("请求体为空或过大")
        v = json.loads(self.rfile.read(n) or b"{}")
        if not isinstance(v, dict):
            raise ValueError("请求体必须是对象")
        return v

    def log_message(self, *a):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    # ------------------------------------------------------------------ GET
    def do_GET(self):  # noqa: C901 — 路由表
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = unquote(u.path)

        def arg(name: str, default: str = "") -> str:
            return q.get(name, [default])[0]

        try:
            if path == "/":
                self.path = "/viewer/index.html"
                return super().do_GET()
            if path.startswith("/viewer/"):
                if "/_gen/" in path:
                    return self._json({"ok": False, "err": "生成物走 /gen/"}, 404)
                return super().do_GET()
            if path.startswith("/vendor/"):
                rel = VENDOR.get(path[len("/vendor/"):])
                if not rel or not (ROOT / rel).is_file():
                    return self._json({"ok": False, "err": "不在共用件白名单里"}, 404)
                return self._bytes((ROOT / rel).read_bytes(), _JS_MIME)
            if path == "/gen/burn.bundle.js":
                p, err = bundle.ensure_bundle()
                if not p or not p.exists():
                    return self._json({"ok": False, "err": err or "没有打包产物"}, 404)
                return self._bytes(p.read_bytes(), _JS_MIME)
            if path == "/gen/burnShade.glsl":
                return self._bytes(bundle.shade_glsl().encode("utf-8"), "text/plain; charset=utf-8")
            if path.startswith(("/resources/", "/assets/")):
                hit = scenes.public_file(path)
                if hit is None:
                    return self._json({"ok": False, "err": f"不存在或不放行：{path}"}, 404)
                return self._bytes(hit[0], hit[1])
            if path == "/api/boot":
                open_id = BOOT_OPEN.pop() if BOOT_OPEN else ""
                try:
                    p, err = bundle.ensure_bundle()
                except Exception as e:  # noqa: BLE001 — 打包失败不许把启动参数一起拖垮
                    p, err = None, f"{type(e).__name__}: {e}"
                return self._json({"ok": True, "open": open_id, "gameUrl": LINK.base,
                                   "bundle": {"ok": bool(p and not err), "err": err},
                                   "project": str(store.PROJECT), "data": str(store.DATA), "real": store.is_real_data(),
                                   "burnablesDir": _rel(store.burn_dir()), "aspectTolerance": store.ASPECT_TOLERANCE})
            if path == "/api/burnables":
                return self._json({"ok": True, "burnables": store.list_assets()})
            if path == "/api/burnable":
                bid = arg("id")
                doc = store.load_asset(bid)
                if doc is None:
                    return self._json({"ok": False, "err": f"可燃物模板「{bid}」不存在"}, 404)
                return self._json({"ok": True, "doc": doc, "refs": scenes.refs_detail(bid)})
            if path == "/api/refs":
                bid = arg("id")
                if not store.valid_id(bid):
                    return self._json({"ok": False, "err": f"模板 id 不合法：{bid!r}"}, 400)
                return self._json({"ok": True, "refs": scenes.refs_detail(bid)})
            if path == "/api/images":
                return self._json({"ok": True, **scenes.image_candidates()})
            if path == "/api/player":
                return self._json({"ok": True, **scenes.player_data()})
            if path == "/api/presets":
                return self._json({"ok": True, "presets": scenes.igniter_presets()})
            if path == "/api/effects":
                return self._json({"ok": True, "effects": scenes.effect_ids()})
            if path == "/api/scene":
                return self._json({"ok": True, "scene": scenes.scene_summary(arg("id"))})
            if path == "/api/scene_bg":
                hit = scenes.scene_background(arg("id"), int(arg("w", "1600") or 1600))
                if hit is None:
                    return self._json({"ok": False, "err": "背景图不存在"}, 404)
                return self._bytes(hit[0], hit[1])
            if path in ("/api/scene_ground", "/api/scene_shell"):
                data = scenes.geometry_bytes(arg("id"), "ground" if path.endswith("ground") else "shell")
                if data is None:
                    return self._json({"ok": False, "err": "场景没有深度载荷"}, 404)
                return self._bytes(data, "application/octet-stream")
            if path == "/api/link/config":
                return self._json({"ok": True, "gameUrl": LINK.base, "writer": LINK.writer})
            if path == "/api/link/status":
                return self._json(LINK.status())
            return self._json({"ok": False, "err": "unknown endpoint"}, 404)
        except FileNotFoundError as e:
            return self._json({"ok": False, "err": str(e)}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)

    # ----------------------------------------------------------------- POST
    def do_POST(self):  # noqa: C901
        u = urlparse(self.path)
        try:
            body = self._body_json()
            if u.path == "/api/walk_check":
                return self._json({"ok": True, **scenes.walk_check(str(body.get("sceneId") or ""), body.get("points") or [])})
            if u.path == "/api/validate":
                doc = body.get("doc")
                norm, warn = store.normalize(doc, doc.get("id") if isinstance(doc, dict) else None)
                return self._json({"ok": True, "doc": norm, "warnings": warn})
            if u.path == "/api/save":
                base = body["base"] if "base" in body else store.UNCHECKED
                p, norm, warn, written = store.save_asset(body.get("doc"), base)
                return self._json({"ok": True, "doc": norm, "path": _rel(p), "warnings": warn, "written": written})
            if u.path == "/api/create":
                bid = str(body.get("id") or "").strip()
                p, norm = store.create_asset(bid, str(body.get("image") or ""), str(body.get("label") or ""),
                                             str(body.get("mode") or "spread"), str(body.get("orientation") or "upright"),
                                             body.get("widthCm"), body.get("heightCm"))
                return self._json({"ok": True, "doc": norm, "path": _rel(p)})
            if u.path == "/api/duplicate":
                working = body.get("doc") if isinstance(body.get("doc"), dict) else None
                p, norm = store.duplicate_asset(str(body.get("id") or ""), str(body.get("to") or "").strip(), working)
                return self._json({"ok": True, "doc": norm, "path": _rel(p)})
            if u.path == "/api/rename_plan":
                plan = store.rename_plan(str(body.get("id") or ""), str(body.get("to") or "").strip())
                return self._json({"ok": True, **plan})
            if u.path == "/api/rename":
                expect = body["expect"] if "expect" in body else store.UNCHECKED
                r = store.rename_asset(str(body.get("id") or ""), str(body.get("to") or "").strip(), expect)
                return self._json({"ok": True, **r, "path": _rel(r["path"])})
            if u.path == "/api/delete":
                r = store.delete_asset(str(body.get("id") or ""))
                return self._json({"ok": True, **r})
            if u.path == "/api/link/config":
                return self._json({"ok": True, "gameUrl": LINK.set_base(str(body.get("gameUrl") or ""))})
            if u.path == "/api/link/publish":
                burn_out, notes = _publish_burnables(body)
                probe = body.get("probe") if isinstance(body.get("probe"), dict) else None
                walk = body.get("walk") if isinstance(body.get("walk"), dict) else None
                r = LINK.publish(burn_out, probe, walk)
                if notes:
                    r["notes"] = notes
                return self._json(r)
            if u.path == "/api/link/launch":
                sid = str(body.get("sceneId") or "").strip()
                if not sid:
                    return self._json({"ok": False, "err": "需要 sceneId"}, 400)
                r = LINK.launch(sid)
                if not r.get("ok"):
                    r["err"] = r.get("message") or "拉不起来"
                return self._json(r)
            return self._json({"ok": False, "err": "unknown endpoint"}, 404)
        except (ValueError, FileExistsError, FileNotFoundError) as e:
            return self._json({"ok": False, "err": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)


def main(port: int = PORT) -> None:
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    main()
