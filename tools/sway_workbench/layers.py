# -*- coding: utf-8 -*-
"""草木工作台的数据面:读拆层产物、存作者涂层、按需重烘。

写盘一律走 ``tools.atomic_io.retry_transient``(见 agent_docs ``atomic-write-windows``:
vite 的 watcher / 杀软 / 索引器随时可能持着刚写出的文件,裸 ``os.replace`` 会变成用户可见的保存失败)。

**这里不重写任何拆层逻辑**:分割、底板补带、自由度、刚体度全部调
``tools.character_lighting_lab.sway_field`` 那一份——工作台只是它的作者面。
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tools.atomic_io import retry_transient                              # noqa: E402
from tools.character_lighting_lab import sway_field                      # noqa: E402
from tools.character_lighting_lab.scene_geometry import SCENES_RT, Scene, bake_key, scene_paths  # noqa: E402
from tools.trajectory_workbench.geometry import list_scenes              # noqa: E402

#: 工作台能画的四层 → ``sway_paint.png`` 的 RGBA 分量
#: (veg 补植被 / freeze 锁死 / rigid 加刚体 / unrigid 减刚体)
CHANNELS = {"veg": 0, "freeze": 1, "rigid": 2, "unrigid": 3}


def scenes() -> list[dict]:
    """场景清单 + 每个场景的拆层状态(有没有烘过、版本、株数、作者涂层在不在)。"""
    rows: list[dict] = []
    for s in list_scenes():
        sid = str(s.get("id") or "")
        if not sid:
            continue
        row = {"id": sid, "depth": bool(s.get("depth")), "sway": None, "hasBackground": False}
        try:
            # ⚠ 别在清单里 new Scene():它会打开原画读尺寸,36 个场景就是 36 次解 PNG,页面要等好几秒。
            # 烘焙目录只由「场景 id + 第一张背景的文件名」决定,直接拼。
            p = scene_paths(sid)
            bd = SCENES_RT / sid / "lighting" / bake_key(p["bg_name"])
            # 没有背景图的场景装不了(装载会 500):清单上直接标出来、不让选,别让作者选了以后"没反应"
            row["hasBackground"] = p["bg"].is_file()
        except Exception:                                    # noqa: BLE001 — 单个场景坏了不拖垮清单
            rows.append(row)
            continue
        meta = _read_json(bd / "sway.json")
        row["sway"] = {
            "version": meta.get("version") if meta else None,
            "instances": len(meta.get("instances") or []) if meta else 0,
            "paint": (bd / sway_field.PAINT_FILE).is_file(),
            "lock": (bd / sway_field.LOCK_FILE).is_file(),
            "stale": bool(meta) and meta.get("version") != sway_field.SWAY_VERSION,
        } if meta else None
        rows.append(row)
    return rows


def _read_json(p: Path) -> dict | None:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def bake_dir(sid: str) -> Path:
    return Scene(sid).bake_dir


def layers(sid: str) -> dict:
    """一个场景的拆层描述:原画尺寸、``sway.json``、有哪些图可取。"""
    sc = Scene(sid)
    bd = sc.bake_dir
    meta = _read_json(bd / "sway.json")
    nw, nh = sc.native
    st = _paint_state(sc)          # 完整读一遍涂层 PNG,一次就够(原先这一份被算了两遍)
    have = {k: (bd / v).is_file() for k, v in (
        ("plate", "sway_plate.png"), ("matte", "sway_matte.png"), ("ids", "sway_ids.png"),
        ("rigid", "sway_rigid.png"),
        ("paint", sway_field.PAINT_FILE), ("lock", sway_field.LOCK_FILE),
    )}
    return {
        "id": sid,
        "background": sc.bg_name,
        "native": [nw, nh],
        "bakeDir": _rel(bd),
        "meta": meta,
        "version": sway_field.SWAY_VERSION,
        "stale": bool(meta) and meta.get("version") != sway_field.SWAY_VERSION,
        "have": have,
        "instances": (meta or {}).get("instances") or [],
        "paintMtime": st["mtime"],
        # 作者点的逐株设置(锚点 / 整体摆),原画像素位置;与涂层一起存、一起留历史
        "overrides": sway_field.read_overrides(bd),
        # 拆层是什么时候烘的。涂层比它新 = 存过了但没重烘,游戏里看到的还是上一版
        # —— 这是最会骗人的一档:作者以为工具没生效,其实只是差一次重烘。
        "bakedMtime": round((bd / "sway.json").stat().st_mtime, 3) if (bd / "sway.json").is_file() else 0.0,
        "counts": st["counts"],
    }


def channel_bytes(sid: str, name: str) -> tuple[bytes, str] | None:
    """涂层的一层 → **不透明灰度** PNG(前端装载用)。

    旧的 ``sway_lock.png`` 还在时,把它并进 ``freeze`` 这一层一起给出去 —— 页面上看得见、
    也改得动;作者一存,`save_paint` 就把旧文件删掉,来源归一。
    """
    import numpy as np
    from PIL import Image

    if name not in CHANNELS:
        return None
    sc = Scene(sid)
    nw, nh = sc.native
    arr = np.zeros((nh, nw), np.uint8)
    p = sc.bake_dir / sway_field.PAINT_FILE
    if p.is_file():
        a = np.asarray(Image.open(p).convert("RGBA"))
        if a.shape[:2] == (nh, nw):
            arr = a[..., CHANNELS[name]].copy()
    if name == "freeze":
        lk = sway_field.read_lock(sc.bake_dir, sc.native, lambda _m: None)
        if lk is not None:
            arr = np.maximum(arr, (lk * 255).astype(np.uint8))
    buf = io.BytesIO()
    Image.fromarray(arr, "L").save(buf, format="PNG", optimize=True)
    return buf.getvalue(), "image/png"


def image_bytes(sid: str, kind: str) -> tuple[bytes, str] | None:
    """取一张图:原画 / 底板 / matte / ids / 作者涂层。返回 (字节, content-type)。"""
    sc = Scene(sid)
    if kind == "background":
        p = sc.rt_dir / sc.bg_name
    else:
        name = {"plate": "sway_plate.png", "matte": "sway_matte.png", "ids": "sway_ids.png", "rigid": "sway_rigid.png",
                "paint": sway_field.PAINT_FILE, "lock": sway_field.LOCK_FILE}.get(kind)
        if not name:
            return None
        p = sc.bake_dir / name
    if not p.is_file():
        return None
    return p.read_bytes(), "image/png"


def _decode_gray(data_url: str, size: tuple[int, int]):
    """前端给的**不透明灰度** PNG → 单通道数组。

    ⚠ 四层一律各走一张不透明图,**不许让浏览器碰带 alpha 的数据图**:canvas 按 alpha 预乘,
    alpha=0 的像素 RGB 会被清零 —— 这条已经坑过两次(matte 的 alpha、涂层的第四通道)。
    """
    import numpy as np
    from PIL import Image

    if not data_url:
        return None
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    im = Image.open(io.BytesIO(base64.b64decode(data_url))).convert("L")
    if im.size != size:
        im = im.resize(size, Image.NEAREST)
    return np.asarray(im)


#: 一次保存要抹掉的已有内容超过这个比例,就要作者点头(防"空画布覆盖")
BIG_DELETE_RATIO = 0.35
#: 保留多少份历史(每次保存把上一版挪进 history/)
HISTORY_KEEP = 20


def _paint_state(sc) -> dict:
    """盘上这份涂层的状态:改动时间戳(乐观并发用)与各层的像素数。"""
    import numpy as np
    from PIL import Image

    p = sc.bake_dir / sway_field.PAINT_FILE
    if not p.is_file():
        return {"mtime": 0.0, "counts": {k: 0 for k in CHANNELS}}
    a = np.asarray(Image.open(p).convert("RGBA"))
    return {
        "mtime": round(p.stat().st_mtime, 3),
        "counts": {k: int((a[..., i] > 128).sum()) for k, i in CHANNELS.items()},
    }


def paint_state(sid: str) -> dict:
    return _paint_state(Scene(sid))


def history_dir(sc) -> Path:
    """涂层历史存哪儿:涂层旁边的 ``sway_paint_history/``。

    ⚠ 它落在 DVC 管的那棵树里,所以**必须同时在 `.dvcignore` 里排掉**(每场景 20 份历史,
    不排就进推送体积 —— validator 2026-09-13 指出)。历史是本机的撤销记录,不跟着仓库走。
    放在涂层旁边而不是 `.tools/`:作者要找回一版时,东西就在他正在看的那个目录里。
    """
    return sc.bake_dir / "sway_paint_history"


def keep_history(sc) -> None:
    """把当前这份挪进历史目录(带时间戳),保留最近 `HISTORY_KEEP` 份。

    作者的涂层是**手工劳动**,一次误存可能是半小时的活。改这个工具时谁也别把这段删了。
    """
    import time

    src = sc.bake_dir / sway_field.PAINT_FILE
    if not src.is_file():
        return
    hist = history_dir(sc)
    hist.mkdir(parents=True, exist_ok=True)
    # ⚠ 文件名要到毫秒并且重名再加序号:只精确到秒的话,同一秒内的两次保存会**互相覆盖**,
    # 中间那一版就没了(单测 test_每次保存留一份历史 抓到过:抹掉前的那份被抹掉后的顶掉)。
    stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
    dest = hist / f"{stamp}.png"
    n = 1
    while dest.exists():
        dest = hist / f"{stamp}_{n}.png"
        n += 1
    try:
        dest.write_bytes(src.read_bytes())
    except OSError:
        return
    olds = sorted(hist.glob("*.png"))
    for p in olds[:-HISTORY_KEEP]:
        try:
            p.unlink()
        except OSError:
            pass


def _clean_points(v, nw: int, nh: int) -> list[list[float]]:
    out = []
    for pt in v or []:
        if isinstance(pt, (list, tuple)) and len(pt) == 2 and all(isinstance(c, (int, float)) for c in pt):
            x, y = float(pt[0]), float(pt[1])
            if 0 <= x < nw and 0 <= y < nh:
                out.append([round(x, 1), round(y, 1)])
    return out


def save_overrides(sc, overrides: dict) -> dict:
    """写作者的逐株设置。覆盖前把上一份挪进历史(与涂层同一个目录,``overrides-*.json``,保留 20 份)。"""
    import time

    nw, nh = sc.native
    clean = {"version": 1,
             "anchors": _clean_points(overrides.get("anchors"), nw, nh),
             "coherent": _clean_points(overrides.get("coherent"), nw, nh)}
    dest = sc.bake_dir / sway_field.OVERRIDES_FILE
    if dest.is_file():
        hist = history_dir(sc)
        hist.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
        bk = hist / f"overrides-{stamp}.json"
        n = 1
        while bk.exists():
            bk = hist / f"overrides-{stamp}_{n}.json"
            n += 1
        try:
            bk.write_bytes(dest.read_bytes())
        except OSError:
            pass
        for p in sorted(hist.glob("overrides-*.json"))[:-HISTORY_KEEP]:
            try:
                p.unlink()
            except OSError:
                pass
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    retry_transient(os.replace, tmp, dest)
    return {"anchors": len(clean["anchors"]), "coherent": len(clean["coherent"])}


def save_paint(sid: str, channels: dict, *, base_mtime: float | None = None, force: bool = False,
               overrides: dict | None = None) -> dict:
    """存作者涂层:四张不透明灰度图合成一张 RGBA 落盘。

    三道数据安全闸(作者的涂层是手工劳动,一次误存可能是半小时的活):

    1. **乐观并发**:`base_mtime` 是页面装载时那份的时间戳。盘上的比它新 ⇒ 拒绝,让作者先刷新
       ——否则两个窗口互相覆盖,谁也不知道丢了什么;
    2. **大面积删除要点头**:这次保存抹掉的已有内容超过 `BIG_DELETE_RATIO` ⇒ 拒绝并报出每层的
       前后数,`force` 才写。空画布覆盖(页面没装好就点了保存)正是这么发生的;
    3. **每次保存留一份历史**(`sway_paint_history/`,保留 20 份),错了能捡回来。

    **顺带把旧的 ``sway_lock.png`` 迁移掉**:它在页面上已经并进「锁死」层了,内容这一次写进了
    涂层的 G 通道;不删它的话它仍是另一个权威来源 —— 作者清空锁死层、保存、刷新,它又被读回来,
    看起来就是"保存丢了"(制作人 2026-09-13 实测撞上)。一份内容只许有一个来源。
    """
    import numpy as np
    from PIL import Image

    sc = Scene(sid)
    nw, nh = sc.native
    before = _paint_state(sc)
    if base_mtime is not None and before["mtime"] > 0 and base_mtime > 0 \
            and round(float(base_mtime), 3) < before["mtime"]:
        return {"ok": False, "conflict": True, "diskMtime": before["mtime"], "yourMtime": base_mtime,
                "err": "盘上这份比你装载的新(另一个窗口存过?)。先刷新再改,别互相覆盖。"}

    out = np.zeros((nh, nw, 4), np.uint8)
    for name, idx in CHANNELS.items():
        g = _decode_gray(str(channels.get(name) or ""), (nw, nh))
        if g is not None:
            out[..., idx] = g
    after = {k: int((out[..., i] > 128).sum()) for k, i in CHANNELS.items()}

    had = sum(before["counts"].values())
    lost = sum(max(0, before["counts"][k] - after[k]) for k in CHANNELS)
    if not force and had > 0 and lost > BIG_DELETE_RATIO * had:
        return {"ok": False, "needConfirm": True, "err": f"这次保存会抹掉已有内容的 {lost / had * 100:.0f}%",
                "before": before["counts"], "after": after}

    keep_history(sc)
    buf = io.BytesIO()
    Image.fromarray(out, "RGBA").save(buf, format="PNG", optimize=True)
    dest = sc.bake_dir / sway_field.PAINT_FILE
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".png.tmp")
    tmp.write_bytes(buf.getvalue())
    retry_transient(os.replace, tmp, dest)
    migrated = False
    old = sc.bake_dir / sway_field.LOCK_FILE
    if old.is_file():
        old.unlink()
        migrated = True
    cover = {k: round(float((out[..., i] > 128).mean()), 4) for k, i in CHANNELS.items()}
    ov = save_overrides(sc, overrides) if isinstance(overrides, dict) else None
    return {"ok": True, "path": _rel(dest), "coverage": cover, "lockMigrated": migrated,
            "counts": after, "mtime": _paint_state(sc)["mtime"], "overrides": ov}


def history(sid: str) -> list[dict]:
    """历史版本清单(新的在前)。"""
    sc = Scene(sid)
    hist = history_dir(sc)
    if not hist.is_dir():
        return []
    rows = []
    for p in sorted(hist.glob("*.png"), reverse=True):
        rows.append({"name": p.stem, "bytes": p.stat().st_size, "mtime": round(p.stat().st_mtime, 3)})
    return rows


def restore(sid: str, name: str) -> dict:
    """把某一份历史恢复成当前涂层(恢复前把当前这份也存进历史,所以恢复本身也可撤)。

    ``name`` 必须是**历史目录里的一个纯文件名**。它是从请求里来的,而这个函数的动作是
    "拿它的内容盖掉作者的涂层" —— 前端哪天把它拼错成带路径的东西(或者别的调用方手写一个),
    就会**不声不响地拿一个无关文件覆盖掉半小时的手工活**。这条守卫挡的是那个。
    """
    sc = Scene(sid)
    if not name or Path(name).name != name or name in (".", ".."):
        return {"ok": False, "err": f"历史名不合法:{name!r}"}
    src = history_dir(sc) / f"{name}.png"
    if not src.is_file():
        return {"ok": False, "err": f"没有这一份历史:{name}"}
    keep_history(sc)
    dest = sc.bake_dir / sway_field.PAINT_FILE
    tmp = dest.with_suffix(".png.tmp")
    tmp.write_bytes(src.read_bytes())
    retry_transient(os.replace, tmp, dest)
    return {"ok": True, "restored": name, **_paint_state(sc)}


def _rel(p: Path) -> str:
    """仓库内的相对路径;测试 / 临时目录里给绝对路径(别为了好看的路径把保存整个抛掉)。"""
    try:
        return p.relative_to(ROOT).as_posix()
    except ValueError:
        return p.as_posix()


#: 上一次推成功的游戏地址(进程内记着,省得每次都探)
_GAME_BASE: list[str] = []
#: 探测顺序:devstate 里记的那个优先,再试 .claude/launch.json 里列过的几个常用 dev 端口
_PROBE_PORTS = (5173, 5178, 5174, 5180, 5188)


def _slot_alive(base: str, timeout: float = 0.4) -> bool:
    import urllib.error
    import urllib.request
    try:
        with urllib.request.urlopen(                                  # noqa: S310 — 本机 dev server
                base.rstrip("/") + "/__gamedraft-api/runtime-sway", timeout=timeout) as r:
            return r.status == 200
    except (urllib.error.URLError, OSError):
        return False


def find_game() -> str:
    """找在跑的游戏 dev server。

    ⚠ 别只信 `discover_game_url`:它读 devstate / 缺省回 5173,而作者常常跑在别的端口
    (本仓 launch.json 里就并列着 5173/5174/5178/5180/5188)。推错端口的症状是"推了没反应",
    还不报错——所以这里按槽是否应答**实探**一遍。
    """
    from tools.acoustic_workbench import game_link

    if _GAME_BASE and _slot_alive(_GAME_BASE[0]):
        return _GAME_BASE[0]
    _GAME_BASE.clear()
    cands: list[str] = []
    try:
        d = game_link.discover_game_url(ROOT)
        if d:
            cands.append(d)
    except Exception:                                                 # noqa: BLE001 — 探测失败不拖垮保存
        pass
    cands += [f"http://127.0.0.1:{p}" for p in _PROBE_PORTS]
    seen = set()
    for c in cands:
        c = c.rstrip("/")
        if c in seen:
            continue
        seen.add(c)
        if _slot_alive(c):
            _GAME_BASE.append(c)
            return c
    return ""


def push_to_game(sid: str) -> dict:
    """告诉在跑的游戏"拆层变了,原地重装一次"(走 dev server 的槽,与声学 / 粒子两台同一条路)。

    推的不是内容是**一行 rev**:草木的载荷是盘上那几张 PNG,游戏看到 rev 变大就带缓存戳重装。
    游戏没开着不算错(作者可能就在纯抠图),回 {"pushed": False, ...} 让前端说一句就好。
    """
    import urllib.error
    import urllib.request

    base = find_game()
    if not base:
        return {"pushed": False, "why": "没找到在跑的游戏(试过 devstate 与 5173/5178/5174/5180/5188)"}
    url = base.rstrip("/") + "/__gamedraft-api/runtime-sway"
    body = json.dumps({"sceneId": sid, "writer": "sway_workbench"}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=2.5) as r:          # noqa: S310 — 本机 dev server
            got = json.loads(r.read().decode("utf-8") or "{}")
        return {"pushed": True, "rev": got.get("rev"), "url": base}
    except (urllib.error.URLError, OSError, ValueError) as e:
        _GAME_BASE.clear()
        return {"pushed": False, "why": f"{type(e).__name__}: {e}", "url": base}


#: 后台烘焙的活（同一时刻只允许一个）
#: ⚠ 字段别叫 `ok`:响应信封外层已经有一个 `ok`,同名会把它盖掉,前端一律当成"请求失败"
_BAKE: dict = {"running": False, "scene": "", "log": [], "done": False, "succeeded": False, "err": "",
               "started": 0.0}


def bake_status() -> dict:
    """前端每秒问一次:跑到哪了。

    ⚠ 烘焙**不能同步做完再回**:第一次要跑分割,几十秒到几分钟,浏览器那边看着就是一个卡死的按钮
    (作者会以为工具挂了,然后去点第二次)。所以开线程做、把状态行一行行攒起来给前端轮。
    """
    import time
    b = dict(_BAKE)
    b["log"] = list(_BAKE["log"])
    b["elapsed"] = round(time.time() - _BAKE["started"], 1) if _BAKE["started"] else 0.0
    return b


def bake_start(sid: str) -> dict:
    """开一条后台线程去烘。已经在烘就直说,别叠第二个(分割很吃内存)。"""
    import threading
    import time

    if _BAKE["running"]:
        return {"ok": False, "err": f"正在烘 {_BAKE['scene']},等它跑完", "busy": True}
    _BAKE.update({"running": True, "scene": sid, "log": [], "done": False, "succeeded": False, "err": "",
                  "started": time.time()})

    def run() -> None:
        try:
            sway_field.bake_sway(sid, status=lambda m: _BAKE["log"].append(str(m)))
            _BAKE["succeeded"] = True
        except Exception as e:                               # noqa: BLE001 — 失败原文回前端
            _BAKE["succeeded"] = False
            _BAKE["err"] = f"{type(e).__name__}: {e}"
            _BAKE["done"] = True
            _BAKE["running"] = False
            return
        # ⚠ 推送**单独一个 try**:它跟烘焙成不成功没关系。合在一起的话,游戏那边一出岔子
        # 就会把一次**已经烘好、产物都落盘了**的重烘报成"烘焙失败",作者会去重烘第二遍。
        try:
            push = push_to_game(sid)
            _BAKE["push"] = push
            _BAKE["log"].append("已推给游戏(第 %s 次)" % push.get("rev") if push.get("pushed")
                                else "没推给游戏:%s" % push.get("why"))
        except Exception as e:                               # noqa: BLE001 — 推不动不影响烘焙的成败
            _BAKE["push"] = {"pushed": False, "why": f"{type(e).__name__}: {e}"}
            _BAKE["log"].append(f"没推给游戏:{type(e).__name__}: {e}(拆层已经烘好了,去游戏里手动切一下场景也能看到)")
        finally:
            _BAKE["done"] = True
            _BAKE["running"] = False

    threading.Thread(target=run, daemon=True, name="sway-bake").start()
    return {"ok": True, "started": True}


def bake(sid: str) -> dict:
    """同步烘一次(命令行 `--bake` 用;页面走 `bake_start` + `bake_status`)。"""
    lines: list[str] = []
    try:
        rows = sway_field.bake_sway(sid, status=lambda m: lines.append(str(m)))
    except Exception as e:                                   # noqa: BLE001 — 烘焙失败要把原文回给前端,不是断连
        return {"ok": False, "err": f"{type(e).__name__}: {e}", "log": lines}
    return {"ok": True, "log": lines, "targets": rows, "layers": layers(sid)}


def inspect(sid: str, x: float, y: float) -> dict:
    """点一下画面:这一点属于哪一株、什么脾气。

    作者面最常问的三句话——"这块到底抠出来没有""它是整株刚转还是弯的""我涂的刚体落上了吗"——
    都在这一个回答里。
    """
    import numpy as np
    from PIL import Image

    sc = Scene(sid)
    nw, nh = sc.native
    ix = max(0, min(nw - 1, int(x)))
    iy = max(0, min(nh - 1, int(y)))
    out: dict = {"at": [ix, iy], "instance": None, "matte": None, "rigid": None}
    bd = sc.bake_dir
    ids_p, matte_p, rigid_p = bd / "sway_ids.png", bd / "sway_matte.png", bd / "sway_rigid.png"
    if not ids_p.is_file():
        return {**out, "err": "这个场景还没烘过拆层"}
    ids = np.asarray(Image.open(ids_p).convert("RGB")).astype(np.int32)
    iid = int(ids[iy, ix, 0] + 256 * ids[iy, ix, 1])
    meta = _read_json(bd / "sway.json") or {}
    if iid:
        for r in meta.get("instances") or []:
            if int(r.get("id", -1)) == iid:
                out["instance"] = r
                break
        if out["instance"] is None:
            out["instance"] = {"id": iid}
    if matte_p.is_file():
        m = np.asarray(Image.open(matte_p).convert("RGB"))[iy, ix]
        out["matte"] = {"alpha": int(m[0]), "leafy": int(m[1]), "freedom": int(m[2])}
    if rigid_p.is_file():
        out["rigid"] = int(np.asarray(Image.open(rigid_p).convert("L"))[iy, ix])
    return out
