# -*- coding: utf-8 -*-
"""粒子工作台本地服务。

  GET  /                                  viewer
  GET  /vendor/<name>.js                  轨迹工作台 viewer 下的共用件原样转发（common.js / gizmo.js / history.js）
                                          —— 不 fork：声学台内联抄过一份 GZ，那是已知欠账，不加第三份
  GET  /gen/vfx.bundle.js                 运行时 vfxSim + vfxSpace + sceneSpace + 两个场 + 场景风 + 透视打成的 ESM
  GET  /api/boot                          启动参数（--open 的效果 id，只发一次；游戏地址；打包状态；布置库路径）
  GET  /api/scenes                        工程场景清单（深度 / 时段背景 / 行走面场状态 / 时段外观 phases / dayNight）
  GET  /api/scene?id=&phase=[&bg=]        场景描述：标定、尺寸、NPC、出生点 / NPC 脚下的世界点、风、透视、
                                          时段外观（phase 选背景；bg 只给老调用方，phase 优先）
  GET  /api/scene_bg?id=&bg=[&w=1600]     背景图（服务端缩放缓存）
  GET  /api/scene_mesh|scene_ground|scene_shell|scene_heightfield?id=&bg=   3D 数据（与轨迹工作台同格式、同一份几何）
  POST /api/shell_probe {id, bg, points}  服务端 SceneGeometry.shell_contact（页面拿它跟运行时 shellContactAt 对）
  GET  /api/effects                       效果资产清单
  GET  /api/effect?id=                    一份效果 + ``externalRefs``（布置库之外按 id 引用它的：挂件预设 / playVfx，只读）
  GET  /api/instance_refs?id=             布置库之外按实例 id 引用一条布置的：``{refs:[{file, path, kind}]}``，
                                          kind = playVfx / stopVfx / setVfxState / condition（只读；删布置 / 改 id 前列清单）
  GET  /api/sfx                           音效 id 清单（声音模块的选择器候选）
  GET  /api/anims                         可用动画包 ``[{path, states[]}]`` / 单图清单（外观模块的选择器候选）
  POST /api/save      {doc}               归一化校验后原子写盘
  POST /api/create    {id, sceneId?, background?, label?}
  POST /api/delete    {id, withPlacements?, confirmExternal?}   全库有布置引用它 / 挂件预设或 playVfx 还按 id 用它
                                          → 不删，回 needConfirm + refs + externalRefs；确认后连布置一起删（外部引用只列不改）
  POST /api/rename    {id, to}            布置里引用旧 id 的一起改（先写库再改名，失败回滚库）；外部引用还在 → 拒绝
  POST /api/duplicate {id, to, doc?}      不动布置；带 doc = 副本取页面上的工作态（源文件不动）
  POST /api/validate  {doc}               只校验不写盘（保存前给状态栏用）
  GET  /api/placements                    整份布置库（读不懂 → ok:false，页面据此拒绝覆盖）
  POST /api/placements/validate {doc}     形状闸门 + 语义检查，不写盘
  POST /api/placements/save     {changes} 只保存明确修改的场景 × 外观；拒绝旧整库 doc（本工作台是这份文件唯一的写入者）
  GET  /api/link/config     POST /api/link/config {gameUrl}
  POST /api/link/publish {effectId, def, probe?, sceneId?, placements?{library, sceneId, phase}, phaseRequest?{timePhase}}
                                          → 游戏 dev server 的槽（placements 过形状闸门，过不了就不推它、效果照推；
                                          效果过不了闸门就推上一份过了闸门的（没有就盘上那份）、布置照推，回 defErr）
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

from tools.editor.shared import vfx_placements as vp                                  # noqa: E402
from tools.trajectory_workbench.geometry import SCENES_RT, list_scenes, scene_paths  # noqa: E402
from tools.trajectory_workbench.serve import get_geometry, scaled_background         # noqa: E402
from tools.vfx_workbench import assets, bundle, placements                           # noqa: E402
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
    # 页内下拉（不走系统原生弹窗：Qt 在高 DPI 下那个弹窗每开一次再乘一次缩放，白边越开越大）
    "dropdown.js": "tools/trajectory_workbench/viewer/dropdown.js",
}


def scene_list() -> list[dict]:
    """轨迹工作台的场景清单 + 每个场景的时段外观（布置按「场景 × 时段外观」分份，顶栏 / 左栏都要它）。"""
    dn = placements.day_night_phases()
    out = []
    for row in list_scenes():
        data = placements.scene_doc(row["id"]) or {}
        row = dict(row)
        row["phases"] = placements.scene_phases(data, dn)
        row["dayNight"] = isinstance(data.get("dayNight"), dict) and data["dayNight"].get("enabled") is True
        out.append(row)
    return out


def scene_summary(sid: str, bg: str | None, phase: str | None = None) -> dict:
    """轨迹工作台的场景描述 + 粒子要的几样：出生点与 NPC 脚下的世界点（坐标自证 / 放玩家标记用）、
    场景风、时段外观。

    ``phase`` 给了就按那套外观装背景（几何共用：深度一张、行走面按背景基名分目录）；``bg`` 只给老调用方。
    **不再读场景 JSON 的 ``vfx``**——布置搬到了布置库（场景里残留的 ``vfx`` 由校验器报 error，这里不吞也不用）。
    """
    data = placements.scene_doc(sid)
    if data is None:
        raise FileNotFoundError(f"场景「{sid}」不存在")
    phases = placements.scene_phases(data)
    cur = None
    if phase is not None:
        cur = next((p for p in phases if p["key"] == phase), None)
        if cur is None:
            raise ValueError(f"场景「{sid}」没有时段外观「{phase}」（有：{[p['key'] or '基底' for p in phases]}）")
        bg = cur["background"]
    elif bg:
        cur = next((p for p in phases if p["background"] == bg), None)
    cur = cur or phases[0]
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
    # 场景风原样给（页面用打包进来的 SceneWindState 解析，与游戏同一份）：薄片只吃它，没有就吹不动
    s["wind"] = d.get("wind") if isinstance(d.get("wind"), dict) else None
    s["phases"] = phases
    s["phase"] = cur["key"]
    s["timePhase"] = cur["timePhase"]
    s["dayNight"] = isinstance(d.get("dayNight"), dict) and d["dayNight"].get("enabled") is True
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
    """外观可选的贴图来源：``anim.json`` 动画包（连同它的 ``states`` 键）与 ``images/vfx/`` 下的单图（工作台只读）。

    ``states`` 给检视器的「状态 / 栖息状态」做下拉：原来是裸文本框，打错一个字母运行时静默退回第一个状态
    （``VfxSystem`` 的 ``def.states[ap.state] ? ap.state : 第一个``），蝙蝠整群飞着倒挂，本地预览按点画看不出来。
    """
    anims: list[dict] = []
    base = ROOT / "public" / "resources" / "runtime" / "animation"
    if base.is_dir():
        for p in sorted(base.glob("*/anim.json")):
            try:
                doc = json.loads(p.read_bytes().decode("utf-8"))
                states = [str(k) for k in doc["states"].keys()] if isinstance(doc, dict) and isinstance(doc.get("states"), dict) else []
            except (OSError, ValueError):
                states = []
            anims.append({"path": "/resources/runtime/animation/" + p.parent.name + "/anim.json", "states": states})
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
                                   "bundle": {"ok": bool(p and not err), "err": err},
                                   "placements": {"path": _rel(placements.lib_path()),
                                                  "real": placements.is_real_library()}})
            if u.path == "/api/scenes":
                return self._json({"ok": True, "scenes": scene_list()})
            if u.path == "/api/scene":
                phase = q.get("phase", [None])[0]
                return self._json({"ok": True, "scene": scene_summary(arg("id"), arg("bg") or None, phase)})
            if u.path == "/api/placements":
                doc, err = placements.load()
                if err:
                    return self._json({"ok": False, "err": err, "path": _rel(placements.lib_path())})
                return self._json({"ok": True, "doc": doc, "path": _rel(placements.lib_path())})
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
                # 布置库之外按 id 用它的（挂件预设 / playVfx）：左栏据此不再说"游戏里不会出现"，删 / 改名前也先列给作者
                return self._json({"ok": True, "doc": doc, "externalRefs": placements.external_refs_to_effect(arg("id"))})
            if u.path == "/api/instance_refs":
                # 布置库之外按实例 id 用一条布置的（playVfx / stopVfx / setVfxState 的 instanceId、条件叶 vfx）：删 / 改 id 前列给作者
                return self._json({"ok": True, "refs": placements.external_refs_to_instance(arg("id"))})
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
                path, norm, warn = assets.save_asset(doc, body.get("base", assets.UNCHECKED_BASE))
                return self._json({"ok": True, "doc": norm, "path": _rel(path), "warnings": warn})
            if u.path == "/api/create":
                eid = str(body.get("id") or "").strip()
                if assets.asset_path(eid).exists():
                    return self._json({"ok": False, "err": f"效果 {eid!r} 已存在"}, 400)
                doc = assets.new_effect(eid, str(body.get("label") or ""), str(body.get("sceneId") or ""),
                                       str(body.get("background") or ""))
                path, norm, warn = assets.save_asset(doc, base=None)
                return self._json({"ok": True, "doc": norm, "path": _rel(path), "warnings": warn})
            if u.path == "/api/delete":
                r = placements.delete_effect(str(body.get("id") or ""), bool(body.get("withPlacements")),
                                             bool(body.get("confirmExternal")))
                return self._json({"ok": True, **r})
            if u.path == "/api/rename":
                r = placements.rename_effect(str(body.get("id") or ""), str(body.get("to") or "").strip())
                return self._json({"ok": True, **r, "path": _rel(r["path"])})
            if u.path == "/api/placements/validate":
                doc = body.get("doc") if "doc" in body else body
                disk, _err = placements.load()
                norm, warn = placements.validate(doc, disk)
                return self._json({"ok": True, "doc": norm, "warnings": warn})
            if u.path == "/api/placements/save":
                # 未编辑范围不可从旧窗口的整库副本推定。
                path, norm, warn = placements.save_changes(body.get("changes"), body.get("base", assets.UNCHECKED_BASE))
                return self._json({"ok": True, "doc": norm, "path": _rel(path), "warnings": warn})
            if u.path == "/api/duplicate":
                working = body.get("doc") if isinstance(body.get("doc"), dict) else None
                p, norm = assets.duplicate_asset(str(body.get("id") or ""), str(body.get("to") or "").strip(), working)
                return self._json({"ok": True, "doc": norm, "path": _rel(p)})
            if u.path == "/api/link/config":
                return self._json({"ok": True, "gameUrl": LINK.set_base(str(body.get("gameUrl") or ""))})
            if u.path == "/api/link/publish":
                eid = str(body.get("effectId") or "").strip()
                d = body.get("def")
                if not eid or not isinstance(d, dict):
                    return self._json({"ok": False, "err": "需要 effectId + def"}, 400)
                # 发出去的就是校验过的落盘形：游戏那边的形状闸门与这里同口径。
                # 效果此刻过不了闸门（作者正改到一半：删掉唯一的恐惧标签、池容量清空再打数……）**不许连布置一起卡住**：
                # 原来整发 500，这段时间拉的区域 / 挪的锚点一个都到不了游戏，芯片还挂着红字像是断线。
                # 改推上一份过了闸门的定义（没有就盘上那份），布置照推，形状问题回 defErr 给页面黄字提示。
                def_err = ""
                try:
                    norm = assets.normalize_effect(d)
                    LINK.remember_good_def(eid, norm)
                except ValueError as e:
                    def_err = f"效果形状不对，没推效果（布置照推）：{e}"
                    norm = LINK.good_def(eid) or _disk_def(eid)
                    if norm is None:
                        return self._json({"ok": False, "err": def_err, "defErr": def_err, "skipped": True})
                probe = body.get("probe") if isinstance(body.get("probe"), dict) else None
                # 布置库也过形状闸门再推（与盘上同一道）：过不了就**不推它**、效果照推，err 给页面状态栏
                pl = body.get("placements") if isinstance(body.get("placements"), dict) else None
                pl_out, pl_err = None, ""
                if pl is not None:
                    try:
                        if pl.get("mode") != "scoped":
                            raise ValueError("旧版整库预览已停用，请刷新粒子工作台")
                        pl_out = {"mode": "scoped", "library": placements.normalize_changes(pl.get("library")),
                                  "sceneId": str(pl.get("sceneId") or ""), "phase": str(pl.get("phase") or "")}
                    except ValueError as e:
                        pl_err = f"布置库没推给游戏（形状不对）：{e}"
                pr = body.get("phaseRequest") if isinstance(body.get("phaseRequest"), dict) else None
                r = LINK.publish(eid, norm, probe, str(body.get("sceneId") or "") or None, pl_out, pr)
                if pl_err:
                    r["placementsErr"] = pl_err
                if def_err:
                    r["defErr"] = def_err
                return self._json(r)
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


def _disk_def(eid: str) -> dict | None:
    """盘上那份效果的落盘形（推给游戏的退路）；不存在 / 读不懂 / 过不了闸门 = None。"""
    try:
        doc = assets.load_asset(eid)
        return assets.normalize_effect(doc) if doc is not None else None
    except (OSError, ValueError):
        return None


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
