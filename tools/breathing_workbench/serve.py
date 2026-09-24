# -*- coding: utf-8 -*-
"""呼吸工作台本地服务(一切响应 ``Cache-Control: no-store``;错误以 ``{ok:false, err}`` 回给页面而不是断连)。

  GET  /                                  viewer
  GET  /vendor/dropdown.js                页内下拉(轨迹台那份原样,不 fork;不走系统原生弹窗)
  GET  /gen/breathing.bundle.js           运行时呼吸图纯逻辑打成的 ESM(``bundle.py``)
  GET  /gen/breathingShade.glsl           ``src/rendering/breathingShade.glsl`` 原文(页面按同一对标记切片)
  GET  /resources/…                       呼吸图的分层图与位移场(只放行 png / jpg / bin)
  GET  /api/boot                          启动参数(--open 的 id 只发一次;游戏地址;打包状态;工程根自证;开场场景)
  GET  /api/breathing                     呼吸图清单
  GET  /api/breathing/doc?id=             一张呼吸图 + 体检(错误 / 告警)+ 用在哪(对话图里那几段的时间轴)
  POST /api/save {doc, base}              导出到游戏:形状闸门 → 原子写(烘焙产物不许改;盘上被别处改过拒绝;内容没变不写)
  GET  /api/link/config  POST /api/link/config {gameUrl}
  POST /api/link/publish {breathing?, probe?}   推给游戏(工作态过闸门;过不了的那份推盘上那份并说原因)
  GET  /api/link/status                   游戏回传的状态页
  POST /api/link/launch {sceneId}         一键拉起游戏进那个场景
  POST /api/render/begin {kind, id, fps, width, height, paramsText}   出片开始
  POST /api/render/frame?token=&i=        一帧原始 RGBA(readPixels 自下而上)
  POST /api/render/finish {token, meta}   拼成品(循环 GIF + 接触表 / 剧情 MP4)
  POST /api/render/reveal {path}          在资源管理器里打开出片目录
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

from tools.breathing_workbench import bundle, render, store, story   # noqa: E402
from tools.breathing_workbench.game_link import BreathingLink       # noqa: E402

PORT = 5352
BOOT_OPEN: list[str] = []
LINK = BreathingLink()

VENDOR = {"dropdown.js": "tools/trajectory_workbench/viewer/dropdown.js"}
_JS_MIME = "text/javascript; charset=utf-8"
_MEDIA_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".bin": "application/octet-stream"}
#: 一帧原始 RGBA 的上限(8192² × 4)
_FRAME_MAX = 8192 * 8192 * 4


def _rel(path: Path) -> str:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return str(path)


def _initial_scene() -> str:
    try:
        cfg = json.loads((store.PROJECT / "public/assets/data/game_config.json").read_bytes().decode("utf-8"))
        return str(cfg.get("initialScene") or "")
    except (OSError, ValueError):
        return ""


def _publish_docs(body: dict) -> tuple[dict | None, list[str]]:
    """推给游戏之前过同一道形状闸门:过不了的推盘上那份(没有就不推它)并说原因。"""
    notes: list[str] = []
    raw = body.get("breathing")
    if not isinstance(raw, dict):
        return None, notes
    out: dict = {}
    for bid, doc in raw.items():
        try:
            out[bid] = store.normalize(doc, bid)[0]
        except ValueError as e:
            try:
                disk = store.load_asset(bid) if store.valid_id(bid) else None
            except (OSError, ValueError):
                disk = None
            if disk is not None:
                try:
                    out[bid] = store.normalize(disk, bid)[0]
                    notes.append(f"「{bid}」形状不对,推的是盘上那份:{e}")
                    continue
                except ValueError:
                    pass
            notes.append(f"「{bid}」形状不对,没推:{e}")
    return out, notes


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=str(TOOL), **k)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def guess_type(self, path):  # noqa: D401 — Windows 注册表常把 .js 映射成 text/plain,模块脚本会被拒
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

    def _raw_body(self, limit: int) -> bytes:
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > limit:
            raise ValueError("请求体为空或过大")
        return self.rfile.read(n)

    def _body_json(self) -> dict:
        v = json.loads(self._raw_body(64 * 1024 * 1024) or b"{}")
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
            if path == "/gen/breathing.bundle.js":
                p, err = bundle.ensure_bundle()
                if not p or not p.exists():
                    return self._json({"ok": False, "err": err or "没有打包产物"}, 404)
                return self._bytes(p.read_bytes(), _JS_MIME)
            if path == "/gen/breathingShade.glsl":
                return self._bytes(bundle.shade_glsl().encode("utf-8"), "text/plain; charset=utf-8")
            if path.startswith("/resources/"):
                f = store.media_file(path)
                mime = _MEDIA_MIME.get(f.suffix.lower()) if f is not None else None
                if f is None or mime is None:
                    return self._json({"ok": False, "err": f"不存在或不放行:{path}"}, 404)
                return self._bytes(f.read_bytes(), mime)
            if path == "/api/boot":
                open_id = BOOT_OPEN.pop() if BOOT_OPEN else ""
                try:
                    p, err = bundle.ensure_bundle()
                except Exception as e:  # noqa: BLE001 — 打包失败不许把启动参数一起拖垮
                    p, err = None, f"{type(e).__name__}: {e}"
                return self._json({"ok": True, "open": open_id, "gameUrl": LINK.base,
                                   "bundle": {"ok": bool(p and not err), "err": err},
                                   "project": str(store.PROJECT), "real": store.is_real_data(),
                                   "breathingDir": _rel(store.breathing_dir()), "initialScene": _initial_scene()})
            if path == "/api/breathing":
                return self._json({"ok": True, "breathing": store.list_assets()})
            if path == "/api/breathing/doc":
                bid = arg("id")
                doc = store.load_asset(bid)
                if doc is None:
                    return self._json({"ok": False, "err": f"呼吸图「{bid}」不存在"}, 404)
                errs, warns = store.check_asset(bid)
                return self._json({"ok": True, "doc": doc, "check": {"errors": errs, "warnings": warns},
                                   "stories": story.stories_for(bid)})
            if path == "/api/link/config":
                return self._json({"ok": True, "gameUrl": LINK.base, "writer": LINK.writer})
            if path == "/api/link/status":
                return self._json(LINK.status())
            return self._json({"ok": False, "err": "unknown endpoint"}, 404)
        except FileNotFoundError as e:
            return self._json({"ok": False, "err": str(e)}, 404)
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)

    def do_POST(self):  # noqa: C901
        u = urlparse(self.path)
        q = parse_qs(u.query)
        try:
            if u.path == "/api/render/frame":
                raw = self._raw_body(_FRAME_MAX)
                render.frame(q.get("token", [""])[0], int(q.get("i", ["0"])[0]), raw)
                return self._json({"ok": True})
            body = self._body_json()
            if u.path == "/api/save":
                base = body["base"] if "base" in body else store.UNCHECKED
                p, norm, warn, written = store.save_asset(body.get("doc"), base)
                return self._json({"ok": True, "doc": norm, "path": _rel(p), "warnings": warn, "written": written})
            if u.path == "/api/link/config":
                return self._json({"ok": True, "gameUrl": LINK.set_base(str(body.get("gameUrl") or ""))})
            if u.path == "/api/link/publish":
                docs, notes = _publish_docs(body)
                probe = body.get("probe") if isinstance(body.get("probe"), dict) else None
                r = LINK.publish(docs, probe)
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
            if u.path == "/api/render/begin":
                r = render.begin(str(body.get("kind") or ""), str(body.get("id") or ""), float(body.get("fps") or 0),
                                 int(body.get("width") or 0), int(body.get("height") or 0), str(body.get("paramsText") or ""))
                return self._json({"ok": True, **r})
            if u.path == "/api/render/finish":
                meta = body.get("meta") if isinstance(body.get("meta"), dict) else {}
                return self._json({"ok": True, **render.finish(str(body.get("token") or ""), meta)})
            if u.path == "/api/render/reveal":
                return self._json({"ok": render.reveal(str(body.get("path") or ""))})
            return self._json({"ok": False, "err": "unknown endpoint"}, 404)
        except (ValueError, FileExistsError, FileNotFoundError) as e:
            return self._json({"ok": False, "err": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({"ok": False, "err": f"{type(e).__name__}: {e}"}, 500)


def main(port: int = PORT) -> None:
    ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()


if __name__ == "__main__":
    main()
