# -*- coding: utf-8 -*-
"""草木工作台的数据面:读拆层产物、存作者涂层、推给游戏 / 导出到游戏。

两个按钮的意思是制作人 2026-09-14 定死的(原话:"推给游戏是指立即推送给运行时的游戏!资源写游戏应该叫做导出到游戏"):

- **推给游戏**:页面上**此刻**那份涂层(存没存都算)烘一份预览,落本机临时目录 ``local/sway_preview/``,
  告诉在跑的游戏去那里装——**资源一个字节不动**;
- **导出到游戏**:存盘的涂层烘进资源(各时段 ``lighting/<背景基名>/``),发行包里就是这一份,再让游戏换回资源。

⚠ 原先的「推给游戏」只让游戏重装**盘上已经烘好的**拆层:涂了、存了、按一百次,游戏里都是上一次烘的样子。

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
import threading
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

#: 推给游戏的预览落在哪:``<这里>/<场景 id>/<烘焙目录名>/sway*``。
#: ⚠ 必须在 ``local/``(gitignore、不归 DVC、不在 public/ 下所以打包抽不到);游戏经 dev server 的
#: ``/__gamedraft-api/runtime-sway/preview/...`` 读(`src/dev/runtimeSwayApiPlugin.ts`,两边路径各写一处,测试对着断言)。
PREVIEW_ROOT = ROOT / "local" / "sway_preview"
#: 烘焙拆层产物的文件(预览目录里只会有这些;游戏读预览也只认这些名字)
DERIVED = ("sway.json", "sway_plate.png", "sway_matte.png", "sway_ids.png", "sway_rigid.png",
           "sway_plate_normal.png", "sway_plate_albedo.png", "sway_plate_depth.png")


def preview_root(sid: str) -> Path:
    return PREVIEW_ROOT / sid


def _mtime(p: Path) -> float:
    return round(p.stat().st_mtime, 3) if p.is_file() else 0.0


def _mtime_ns(p: Path) -> int | None:
    try:
        return p.stat().st_mtime_ns if p.is_file() else None
    except OSError:
        return None


#: 烘焙盖进 sway.json 的输入**内容**指纹字段(`sway_field.content_fingerprint`;预览与导出同一个口径)
CONTENT_KEY = "inputsContentSha1"
#: 烘焙盖进 sway.json 的**非涂层**输入指纹字段(`sway_field.bake_inputs_fingerprint`:原画 / 场景几何配置 / 各时段法线 albedo 深度)
BAKE_INPUTS_KEY = "bakeInputsSha1"
#: 盘上输入的内容指纹缓存:``{烘焙目录: (三份输入文件的 (mtime_ns, size), 指纹)}``——
#: 装一次场景要取 4 张图 + layers + 检视,每次都解一遍整幅涂层 PNG 不值
_DISK_FP: dict[str, tuple[tuple, str]] = {}


def disk_content_sha1(sc) -> str:
    """盘上这份输入(涂层 / 逐株设置 / 旧锁定图)的内容指纹;三份文件没变就用缓存。"""
    def sig(p: Path) -> tuple:
        try:
            s = p.stat()
            return (s.st_mtime_ns, s.st_size)
        except OSError:
            return (0, -1)
    bd = sc.bake_dir
    key = tuple(sig(bd / n) for n in (sway_field.PAINT_FILE, sway_field.OVERRIDES_FILE, sway_field.LOCK_FILE))
    hit = _DISK_FP.get(str(bd))
    if hit and hit[0] == key:
        return hit[1]
    fp = sway_field.disk_content_fingerprint(bd, sc.native)
    _DISK_FP[str(bd)] = (key, fp)
    return fp


def _export_content_sha1(sc, res_meta: dict | None) -> str | None:
    """资源里那份是拿什么内容烘的:盖了内容指纹就用它;老的只盖了文件指纹、而且与盘上现在的一致 ⇒ 就是盘上这份;
    都说不清 ⇒ None。"""
    if not res_meta:
        return None
    got = res_meta.get(CONTENT_KEY)
    if isinstance(got, str) and got:
        return got
    stamp = res_meta.get("inputs")
    if isinstance(stamp, dict) and isinstance(stamp.get("paintSha1"), str) and isinstance(stamp.get("overridesSha1"), str):
        now = sway_field.input_fingerprint(sc.bake_dir)
        if now["paintSha1"] == stamp["paintSha1"] and now["overridesSha1"] == stamp["overridesSha1"]:
            return disk_content_sha1(sc)
    return None


def preview_state(sc, *, with_disk: bool = False) -> dict:
    """推给游戏的预览是什么状况:``{exists, differsFromExport, matchesDisk}``。

    🔴 **按内容判,不按写盘时刻**:原来"预览的 sway.json 比资源的新"就算游戏里是预览——
    推了一版试验、不满意、不保存丢掉,这份预览的时刻照样最新:之后哪天打开这个场景,「已抠出的植被 / 实例分区 /
    已判定的刚体」和 Alt+点检视全是被丢掉的那版,徽章还叫作者按 P 再推、说资源还没导出(直到下一次导出);
    撤销回导出的样子再推一次、内容与资源一模一样,徽章也一直说「资源还没导出」。
    - ``differsFromExport``:预览的输入内容(与版本)和资源里那份不同 ⇒ 游戏里 / 叠加层才真是另一份。
      老预览没盖内容指纹 ⇒ 退回原来的时刻比较;资源说不清是拿什么烘的 ⇒ 按不同算(宁可多说一句)。
      涂层一样、**非涂层输入**(``bakeInputsSha1``:原画 / 场景几何配置 / 各时段法线 albedo 深度)不同也算不同
      (原画重画 / 照明重烘之后推的预览是另一份拆层);资源没盖这个字段而预览盖了 ⇒ 按不同算。
      🔴 **资源的 sway.json 不比预览的旧 ⇒ 一律不算不同**:导出在推送之后跑(两者串行),预览已被它取代——
      推了 A、又涂几笔、按 B 导出 B,只比内容的话 A ≠ B,工作台就一直说"资源还没导出"、叠加层读被取代的 A
      (导出成功本来会删掉本机预览,这条兜住删失败 / 老进程留下的)。
    - ``matchesDisk``(``with_disk`` 才算,要解一次涂层):预览就是盘上这份(只看涂层——撤预览据它定,
      原画变了而涂层没变的预览没被丢掉,不许撤)。
    """
    pv = preview_root(sc.sid) / sc.bake_dir.name / "sway.json"
    pv_meta = _read_json(pv)
    if not isinstance(pv_meta, dict):
        return {"exists": False, "differsFromExport": False, "matchesDisk": False}
    res = sc.bake_dir / "sway.json"
    res_meta = _read_json(res)
    psha = pv_meta.get(CONTENT_KEY)
    stamped = isinstance(psha, str) and bool(psha)
    matches = bool(with_disk and stamped and psha == disk_content_sha1(sc))
    res_ns, pv_ns = _mtime_ns(res), _mtime_ns(pv)
    if res_ns is not None and pv_ns is not None and res_ns >= pv_ns:
        return {"exists": True, "differsFromExport": False, "matchesDisk": matches}
    if not stamped:
        # 老预览没盖内容指纹:走到这里就是预览比资源新(或资源没有)——退回原来的时刻口径
        return {"exists": True, "differsFromExport": True, "matchesDisk": False}
    esha = _export_content_sha1(sc, res_meta)
    differs = (esha is None or esha != psha
               or (res_meta or {}).get("version") != pv_meta.get("version")
               or (res_meta or {}).get(BAKE_INPUTS_KEY) != pv_meta.get(BAKE_INPUTS_KEY))
    return {"exists": True, "differsFromExport": bool(differs), "matchesDisk": matches}


def bake_inputs_changed(sid: str, res_meta: dict | None) -> bool:
    """资源 ``sway.json`` 盖了非涂层输入指纹,而盘上现在算出来的与它不同(原画重画 / 照明重烘 / 加了时段)⇒ True。

    资源没盖(今天之前导出的)或算不出来 ⇒ False:说不清就不亮——否则每个老场景一打开都喊「待导出」。
    指纹里的文件字节按 (mtime_ns, size) 缓存(`sway_field._file_sha1_cached`),装场景 / 存盘各算一次不贵。
    """
    stamp = (res_meta or {}).get(BAKE_INPUTS_KEY)
    if not (isinstance(stamp, str) and stamp):
        return False
    try:
        return sway_field.bake_inputs_fingerprint(sid) != stamp
    except Exception:                                        # noqa: BLE001 — 说不清就不报,不拖垮装场景 / 存盘
        return False


def derived_dir(sc) -> tuple[Path, str]:
    """工作台上"已抠出的植被 / 实例分区 / 已判定的刚体"这几层该从哪儿读,以及它是哪一份。

    推给游戏的预览与资源里那份**内容不同** ⇒ 读预览(游戏里正显示的就是它);否则读资源(见 `preview_state`)。
    两份都看不到就回资源目录(调用方按"没烘过"处理)。
    """
    if preview_state(sc)["differsFromExport"]:
        return preview_root(sc.sid) / sc.bake_dir.name, "preview"
    return sc.bake_dir, "export"


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
    pst = preview_state(sc, with_disk=True)
    dd, source = (preview_root(sid) / bd.name, "preview") if pst["differsFromExport"] else (bd, "export")
    meta = _read_json(dd / "sway.json")
    nw, nh = sc.native
    st = _paint_state(sc)          # 完整读一遍涂层 PNG,一次就够(原先这一份被算了两遍)
    res_meta = meta if source == "export" else _read_json(bd / "sway.json")
    art_changed = bake_inputs_changed(sid, res_meta)
    have = {k: (dd / v).is_file() for k, v in (
        ("plate", "sway_plate.png"), ("matte", "sway_matte.png"), ("ids", "sway_ids.png"),
        ("rigid", "sway_rigid.png"),
    )}
    have.update({"paint": (bd / sway_field.PAINT_FILE).is_file(), "lock": (bd / sway_field.LOCK_FILE).is_file()})
    return {
        "id": sid,
        "background": sc.bg_name,
        "native": [nw, nh],
        "bakeDir": _rel(bd),
        "meta": meta,
        # 叠加层 / 实例表是哪一份:"preview" = 推给游戏的预览(比导出的新,资源里还不是它)/ "export" = 资源里那份
        "source": source,
        "version": sway_field.SWAY_VERSION,
        "stale": bool(meta) and meta.get("version") != sway_field.SWAY_VERSION,
        "have": have,
        "instances": (meta or {}).get("instances") or [],
        "paintMtime": st["mtime"],
        # 作者点的逐株设置(锚点 / 整体摆),原画像素位置;与涂层一起存、一起留历史
        "overrides": sway_field.read_overrides(bd),
        # 资源里的拆层是什么时候导出的。涂层比它新 = 存过了但没导出,资源(发行包)里还是上一版
        # —— 这是最会骗人的一档:作者以为工具没生效,其实只是差一次导出。
        "bakedMtime": _mtime(bd / "sway.json"),
        # 「● 待导出」以这个为准(前端别再拿 paintMtime > bakedMtime 自己算):见 `needs_export`
        # 涂层没进资源,或者原画 / 照明烘焙在导出之后变过(资源里的底板 / matte 是按旧原画烘的)都算
        "needsExport": needs_export(bd, res_meta, st["mtime"]) or art_changed,
        # 「待导出」是因为原画 / 照明烘焙变了(不是涂层):徽章据此说清楚,免得作者去找自己哪笔没导出
        "bakeInputsChanged": art_changed,
        # 最近一次推给游戏的预览是什么时候烘的(0 = 没推过)。⚠ 判"游戏里是不是另一份"别拿它比 bakedMtime,看下面两个
        "previewMtime": _mtime(preview_root(sid) / bd.name / "sway.json"),
        # 预览与资源里那份内容不同(「资源还没导出」徽章、叠加层读哪份都按它);预览就是盘上这份(丢弃改动时据此决定撤不撤)
        "previewDiffersFromExport": pst["differsFromExport"],
        "previewMatchesDisk": pst["matchesDisk"],
        "counts": st["counts"],
        # 场景 JSON 配没配风(与运行时 resolveSceneWind 同一个判据;读不到场景 JSON = None,页面不报)。
        # ⚠ 没配风的场景游戏里草木层根本不建:推送 / 导出烘得再好、游戏也收下了,画面一株不动——页面必须直说
        "hasWind": scene_has_wind(sid),
    }


def wind_def_usable(d: object) -> bool:
    """场景 JSON 的 ``wind`` 能不能让草木动起来:**逐条照抄** `src/utils/sceneWind.ts` 的 `resolveSceneWind`
    (``direction`` 是数组、``speed`` > 0、水平分量 |(dx, dz)| > 1e-6;非有限数一律按 0)。
    两边判据不一致 = 页面说"没配风"而游戏在动,或反过来——`WindCheckTests` 对着同样的几种写法断言。"""
    import math

    def fin(v: object) -> float:
        # JS 的 typeof v === 'number':布尔不算数(Python 里 True 是 int,要单独排掉)
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) else 0.0

    if not isinstance(d, dict) or not isinstance(d.get("direction"), list):
        return False
    if not fin(d.get("speed")) > 0:
        return False
    dirv = d["direction"]
    dx = fin(dirv[0]) if len(dirv) > 0 else 0.0
    dz = fin(dirv[2]) if len(dirv) > 2 else 0.0
    return math.hypot(dx, dz) > 1e-6


def scene_has_wind(sid: str) -> bool | None:
    """这个场景的 JSON 配没配能用的风;场景 JSON 读不到 ⇒ None(说不清,不下结论)。"""
    try:
        data = scene_paths(sid)["data"]
    except Exception:                                    # noqa: BLE001 — 说不清就不报,不拖垮装场景
        return None
    return wind_def_usable(data.get("wind") if isinstance(data, dict) else None)


def needs_export(bd: Path, res_meta: dict | None, paint_mtime: float) -> bool:
    """盘上的输入(涂层 / 逐株设置)是不是还没进资源。

    按资源 ``sway.json`` 里导出时盖的**输入指纹**(`sway_field.input_fingerprint`,烘焙**读输入之前**取的)
    与盘上现在的比。⚠ 原来比写盘时刻(涂层 mtime > sway.json mtime):导出要烘好几秒,期间作者又涂又存,
    烘完 sway.json 最后写、时刻更晚,「待导出」就此永久熄灭——资源里其实没有那几笔(发行包也没有),没人知道。
    老的 sway.json 没有指纹 ⇒ 退回原来的时刻比较。
    """
    stamp = (res_meta or {}).get("inputs")
    if isinstance(stamp, dict) and isinstance(stamp.get("paintSha1"), str) and isinstance(stamp.get("overridesSha1"), str):
        now = sway_field.input_fingerprint(bd)
        return now["paintSha1"] != stamp["paintSha1"] or now["overridesSha1"] != stamp["overridesSha1"]
    return paint_mtime > _mtime(bd / "sway.json")


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
    """取一张图:原画 / 底板 / matte / ids / 作者涂层。返回 (字节, content-type)。

    拆层产物(底板 / matte / ids / 刚体)跟 `derived_dir` 走:推给游戏的预览更新就给预览那份,
    与游戏里正显示的对得上;作者的输入(涂层 / 旧锁定图)永远在资源目录。
    """
    sc = Scene(sid)
    if kind == "background":
        p = sc.rt_dir / sc.bg_name
    elif kind in ("plate", "matte", "ids", "rigid"):
        p = derived_dir(sc)[0] / f"sway_{kind}.png"
    else:
        name = {"paint": sway_field.PAINT_FILE, "lock": sway_field.LOCK_FILE}.get(kind)
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


def _history_stamp(mtime: float) -> str:
    """历史文件名里的时刻(到毫秒):**被替换那份内容自己的存盘时刻**,涂层与逐株设置两套历史共用。"""
    import time

    ms = int(round(mtime * 1000))        # 先整体取整到毫秒再拆秒 / 毫秒:浮点的 .678 常是 .67799…,直接截断会差一毫秒
    return time.strftime("%Y%m%d-%H%M%S", time.localtime(ms // 1000)) + f"-{ms % 1000:03d}"


def _same_bytes_in(paths, data: bytes) -> bool:
    """这些文件里有没有与 ``data`` 逐字节相同的(先比大小,大小对得上才读、按 sha1 比)。"""
    import hashlib

    want = None
    for p in paths:
        try:
            if p.stat().st_size != len(data):
                continue
            if want is None:
                want = hashlib.sha1(data).digest()
            if hashlib.sha1(p.read_bytes()).digest() == want:
                return True
        except OSError:
            continue
    return False


def keep_history(sc, protect: Path | None = None) -> None:
    """把当前这份挪进历史目录(带时间戳),保留最近 `HISTORY_KEEP` 份。

    作者的涂层是**手工劳动**,一次误存可能是半小时的活。改这个工具时谁也别把这段删了。

    ``protect``:这一份历史**不许**被这次裁剪删掉(`restore` 传它正要恢复的那份)。
    ⚠ 原来恢复最底下(最旧)那一份时,这里先塞进一份新的、再把最旧的剪掉——剪掉的正是要恢复的那份,
    接着读它就 FileNotFoundError,页面报「恢复失败」,而那一版(往往正是作者要找的)从此没了。
    """
    src = sc.bake_dir / sway_field.PAINT_FILE
    if not src.is_file():
        return
    hist = history_dir(sc)
    hist.mkdir(parents=True, exist_ok=True)
    try:
        data = src.read_bytes()
        mtime = src.stat().st_mtime
    except OSError:
        return
    # ⚠ 时间戳取**这份内容自己被存下的时刻**(涂层的 mtime),不是现在:历史里放的是"被替换掉的那一版",
    # 按现在命名的话 15:30 那一行装的是 15:00 存的内容,作者点"15:00"拿到的是更早的一版,整张表错开一格。
    # ⚠ 文件名要到毫秒并且重名再加序号:只精确到秒的话,同一秒内的两次保存会**互相覆盖**,
    # 中间那一版就没了(单测 test_每次保存留一份历史 抓到过:抹掉前的那份被抹掉后的顶掉)。
    # ⚠ 同样字节的已经在历史里(**不论名字 / 时刻**)⇒ 不写、也不裁剪:它本来就撤得回来。
    # 原来只认"同一时刻 + 同样字节":恢复把历史字节经临时文件写回涂层,mtime 变成现在,下一次恢复 / 保存
    # 按新时刻再留一份同样的,裁剪接着删掉一版独一无二的最旧历史——作者在「历史…」里逐个点恢复找旧版,
    # 每点一下就多一份副本、少一版真历史,删的正是他在找的那一头。撤销回原样再存也一样。
    if _same_bytes_in(hist.glob("*.png"), data):
        return
    stamp = _history_stamp(mtime)
    dest = hist / f"{stamp}.png"
    n = 1
    while dest.exists():
        dest = hist / f"{stamp}_{n}.png"
        n += 1
    try:
        dest.write_bytes(data)
    except OSError:
        return
    try:
        os.utime(dest, (mtime, mtime))   # 历史清单回的 mtime 与名字说的是同一个时刻
    except OSError:
        pass
    # 刚留的这份与要保护的那份不参与裁剪(名字按内容的存盘时刻排,刚留的这份不一定排在最新),其余按旧到新剪
    pinned = {dest.name} | ({protect.name} if protect is not None and protect.is_file() else set())
    olds = [p for p in sorted(hist.glob("*.png")) if p.name not in pinned]
    spare = max(0, HISTORY_KEEP - len(pinned))
    for p in olds[:max(0, len(olds) - spare)]:      # ⚠ 别写成 olds[:len - spare]:不足时是负下标,反倒从旧的剪起
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
    """写作者的逐株设置。覆盖前把上一份挪进历史(与涂层同一个目录,``overrides-<那份的存盘时刻>.json``,保留 20 份)。

    ⚠ **内容与盘上那份相同就一个字节都不写、也不留备份**:页面每次 Ctrl+S 都带着 ``overrides``(只改涂层也带),
    原来照样重写 + 按"现在"留一份备份——二十次只改涂层的保存就是二十份一模一样的备份,误删锚点之前那一版被 20 份上限挤掉,
    而名字标着"现在"、装的却是更早存下的内容(与 `keep_history` 修过的同一个错位)。
    ⚠ **盘上没有这个文件、这次也是空的 ⇒ 不创建**:凭空多一个空文件,输入指纹就从 ''(没文件)变成空文件的 sha1,
    什么都没改却亮一次「● 待导出」、骗作者白导出一遍。
    返回的 ``changed`` = 这次真写了盘。
    """
    nw, nh = sc.native
    clean = {"version": 1,
             "anchors": _clean_points(overrides.get("anchors"), nw, nh),
             "coherent": _clean_points(overrides.get("coherent"), nw, nh)}
    counts = {"anchors": len(clean["anchors"]), "coherent": len(clean["coherent"])}
    dest = sc.bake_dir / sway_field.OVERRIDES_FILE
    if dest.is_file():
        try:
            same = json.loads(dest.read_text(encoding="utf-8")) == clean
        except (OSError, ValueError):
            same = False                 # 读不懂的旧文件:照常备份后重写
        if same:
            return {**counts, "changed": False}
        _backup_overrides(sc, dest)
    elif not clean["anchors"] and not clean["coherent"]:
        return {**counts, "changed": False}
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(clean, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
    retry_transient(os.replace, tmp, dest)
    return {**counts, "changed": True}


def _backup_overrides(sc, dest: Path) -> None:
    """把要被替换的那份逐株设置挪进历史:名字是**那份内容自己的存盘时刻**(mtime,到毫秒、重名加序号),
    同样字节的已经在历史里(不论名字)就不再留、也不裁剪(与 `keep_history` 同一套规矩),保留最近 `HISTORY_KEEP` 份。"""
    hist = history_dir(sc)
    hist.mkdir(parents=True, exist_ok=True)
    try:
        data = dest.read_bytes()
        mtime = dest.stat().st_mtime
    except OSError:
        return
    if _same_bytes_in(hist.glob("overrides-*.json"), data):
        return                           # 同一份已经在历史里了:再留一份只会挤掉一版真历史
    stamp = _history_stamp(mtime)
    bk = hist / f"overrides-{stamp}.json"
    n = 1
    while bk.exists():
        bk = hist / f"overrides-{stamp}_{n}.json"
        n += 1
    try:
        bk.write_bytes(data)
        os.utime(bk, (mtime, mtime))
    except OSError:
        return
    olds = [p for p in sorted(hist.glob("overrides-*.json")) if p.name != bk.name]
    for p in olds[:max(0, len(olds) - (HISTORY_KEEP - 1))]:
        try:
            p.unlink()
        except OSError:
            pass


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

    dest = sc.bake_dir / sway_field.PAINT_FILE
    # 四层与盘上逐字节相同(只改了锚点 / 整体摆,包括「导出到游戏」前自动的那次保存)⇒ 不留历史、不重写 PNG。
    # ⚠ 原来照样 keep_history + 重写:调二十轮锚点,「历史…」里就是二十份一模一样的涂层,真正不同的旧版本被 20 份上限挤掉;
    # 重写还会换掉 mtime / 字节,让"存了没导出"误亮。mtime 回盘上原来那个,页面的 baseMtime 才对得上。
    unchanged = False
    if dest.is_file() and before["mtime"] > 0:
        try:
            disk = np.asarray(Image.open(dest).convert("RGBA"))
            unchanged = disk.shape == out.shape and bool(np.array_equal(disk, out))
        except (OSError, ValueError):
            unchanged = False
    if not unchanged:
        keep_history(sc)
        buf = io.BytesIO()
        Image.fromarray(out, "RGBA").save(buf, format="PNG", optimize=True)
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
    mtime = before["mtime"] if unchanged else _paint_state(sc)["mtime"]
    return {"ok": True, "path": _rel(dest), "coverage": cover, "lockMigrated": migrated,
            "counts": after, "mtime": mtime, "overrides": ov,
            "paintUnchanged": unchanged,
            # 写完之后按输入指纹算的「待导出」(与 `layers()` 同一个判据):页面据它亮 / 灭徽章。
            # ⚠ 原来页面存完一律亮「● 待导出」:撤销回原样 / 加了又删的锚点再 Ctrl+S,盘上字节没变,徽章照亮,作者白导出十几秒
            "needsExport": _saved_needs_export(sid, sc.bake_dir, mtime)}


def _saved_needs_export(sid: str, bd: Path, paint_mtime: float) -> bool:
    """存完之后的「待导出」:与 `layers()` 同一个判据(涂层没进资源,或原画 / 照明烘焙在导出之后变过)。"""
    res_meta = _read_json(bd / "sway.json")
    return needs_export(bd, res_meta, paint_mtime) or bake_inputs_changed(sid, res_meta)


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
    # ⚠ 先把要恢复的内容读进内存,再留当前这份历史,并且让裁剪绕开它:
    # 历史满 20 份时恢复最旧那一份,原来是先留历史(剪掉的正是它)再读——恢复失败,那一版永久丢了。
    data = src.read_bytes()
    keep_history(sc, protect=src)
    dest = sc.bake_dir / sway_field.PAINT_FILE
    tmp = dest.with_suffix(".png.tmp")
    tmp.write_bytes(data)
    retry_transient(os.replace, tmp, dest)
    return {"ok": True, "restored": name, **_paint_state(sc)}


#: 本地草稿(页面每 8 秒存一次没保存的涂层增量)落哪儿:``<这里>/<场景 id>.json``。
#: ⚠ 不能放浏览器 localStorage:桌面壳是纯内存 profile、端口每次随机,关窗 / 崩了草稿跟着没,
#: "只丢 8 秒"那句承诺在主入口里根本不成立。放 ``local/``(gitignore、不归 DVC、打包不抽)。
#: 自检进程把它指到临时目录(`app.py`),绝不碰作者的真草稿。
DRAFT_ROOT = ROOT / "local" / "sway_drafts"
#: 一份草稿的上限(四层 PNG dataURL + 逐株设置):防一个坏请求把磁盘写爆
DRAFT_MAX_BYTES = 64 * 1024 * 1024


def _draft_path(sid: str) -> Path:
    s = str(sid or "")
    if not s or s in (".", "..") or any(c in s for c in '/\\:*?"<>|\x00') or not (SCENES_RT / s).is_dir():
        raise ValueError(f"场景不合法:{sid!r}")
    return DRAFT_ROOT / f"{s}.json"


def draft_get(sid: str) -> dict | None:
    """这个场景的本地草稿(没有 / 读不懂 ⇒ None)。"""
    d = _read_json(_draft_path(sid))
    return d if isinstance(d, dict) else None


def draft_put(sid: str, draft: dict) -> dict:
    """原子写一份草稿(覆盖上一份)。"""
    if not isinstance(draft, dict):
        raise ValueError("草稿要是对象")
    raw = json.dumps(draft, ensure_ascii=False).encode("utf-8")
    if len(raw) > DRAFT_MAX_BYTES:
        raise ValueError(f"草稿太大({len(raw) // 1024 // 1024} MB),没存")
    p = _draft_path(sid)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_bytes(raw)
    retry_transient(os.replace, tmp, p)
    return {"ok": True, "bytes": len(raw)}


def draft_clear(sid: str) -> dict:
    p = _draft_path(sid)
    if p.is_file():
        retry_transient(os.unlink, p)
        return {"ok": True, "cleared": True}
    return {"ok": True, "cleared": False}


#: 收起来的草稿每个场景留几份(作者在「发现没保存的草稿」里选了「先不管」)
DRAFT_STASH_KEEP = 5


def _stash_name_ok(sid: str, name: str) -> bool:
    # 名字是从请求里来的,动作是"读 / 删这个文件":只认 `<场景>.stash-<毫秒>.json` 这一种纯文件名
    import re
    return bool(name) and Path(name).name == name and re.fullmatch(re.escape(sid) + r"\.stash-\d+\.json", name) is not None


def draft_stash(sid: str) -> dict:
    """把这个场景的草稿收起来(改名成 ``<场景>.stash-<at>.json``):之后的自动草稿与存盘都不碰它,
    「历史…」里随时能恢复或删除。原来「先不管」只在内存里记一笔,8 秒后的自动草稿就把它覆盖了、一存盘就删了。"""
    p = _draft_path(sid)
    d = _read_json(p)
    if not isinstance(d, dict):
        return {"ok": True, "stashed": ""}
    at = int(d.get("at") or 0) if isinstance(d.get("at"), (int, float)) else 0
    dest = p.with_name(f"{sid}.stash-{at}.json")
    retry_transient(os.replace, p, dest)
    rows = sorted(p.parent.glob(f"{sid}.stash-*.json"), key=lambda x: x.name, reverse=True)
    for old in [r for r in rows if _stash_name_ok(sid, r.name)][DRAFT_STASH_KEEP:]:
        retry_transient(os.unlink, old)
    return {"ok": True, "stashed": dest.name}


def draft_stashes(sid: str) -> list[dict]:
    """收起来的草稿(新的在前):``[{name, at, channels, ov}]``。"""
    p = _draft_path(sid)
    if not p.parent.is_dir():
        return []
    out = []
    for f in sorted(p.parent.glob(f"{sid}.stash-*.json"), key=lambda x: x.name, reverse=True):
        if not _stash_name_ok(sid, f.name):
            continue
        d = _read_json(f) or {}
        ch = d.get("ch") if isinstance(d.get("ch"), dict) else {}
        out.append({"name": f.name, "at": d.get("at"), "channels": [k for k in CHANNELS if ch.get(k)], "ov": bool(d.get("ov"))})
    return out


def draft_stash_get(sid: str, name: str) -> dict | None:
    _draft_path(sid)
    if not _stash_name_ok(sid, name):
        raise ValueError(f"草稿名不合法:{name!r}")
    d = _read_json(DRAFT_ROOT / name)
    return d if isinstance(d, dict) else None


def draft_stash_delete(sid: str, name: str) -> dict:
    _draft_path(sid)
    if not _stash_name_ok(sid, name):
        raise ValueError(f"草稿名不合法:{name!r}")
    f = DRAFT_ROOT / name
    if f.is_file():
        retry_transient(os.unlink, f)
        return {"ok": True, "deleted": True}
    return {"ok": True, "deleted": False}


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


#: 游戏页的心跳多久算"还开着"：游戏每 0.9 s 轮询一次，连不上时退避到 3 s
GAME_PAGE_FRESH_MS = 4000


def page_alive(game: object) -> bool:
    """dev server 回的 ``game``（游戏页最近一次轮询的心跳）说明游戏页此刻开着吗。老插件没有这个字段 ⇒ False。"""
    return isinstance(game, dict) and isinstance(game.get("ageMs"), (int, float)) and game["ageMs"] < GAME_PAGE_FRESH_MS


def page_busy(game: object) -> bool:
    """游戏页开着、但正在启动 / 装场景 / 原地重装草木（心跳里 ``loading: true``，这时 ``sceneId`` 可能是空的）。

    ⚠ 这一段游戏页照样在：原来心跳只在场景装好之后才发，装场景那几秒（冷启动直达场景更久）按 P，
    工作台以为没有游戏页，又拉起第二个游戏窗口 / 排一条切场景命令把玩家送回入口。老插件没有 ``loading`` ⇒ False（行为照旧）。
    """
    return page_alive(game) and game.get("loading") is True           # type: ignore[union-attr]


def game_page(base: str) -> dict | None:
    """游戏页的心跳 ``{sceneId, bootId, preview, ageMs}``（槽的 GET 顺带回的）；拿不到 ⇒ None。

    ⚠ dev server 应答 ≠ 游戏页开着：原来只要槽应答就说「游戏在」「✔ 游戏里已换上」，游戏页根本没开也这么说，
    作者打开游戏看到的却是资源那份。
    """
    import urllib.error
    import urllib.request
    if not base:
        return None
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/__gamedraft-api/runtime-sway", timeout=0.6) as r:  # noqa: S310
            got = json.loads(r.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, OSError, ValueError):
        return None
    g = got.get("game") if isinstance(got, dict) else None
    return g if isinstance(g, dict) else None


def push_note(push: dict, sid: str) -> str:
    """推送结果给人看的一行:分清"游戏页换上了""游戏在别的场景""dev server 收下了但没有游戏页"。"""
    if not push.get("pushed"):
        return "没送到游戏:%s" % push.get("why")
    rev = push.get("rev")
    game = push.get("game")
    if push.get("inScene"):
        return f"游戏已收到,正在原地换上(第 {rev} 次)"
    if push.get("pageBusy"):
        return f"游戏页正在装场景:装好进到 {sid} 就是这份(第 {rev} 次)"
    if push.get("pageAlive"):
        return f"游戏现在在「{game.get('sceneId')}」:进到 {sid} 就是这份(第 {rev} 次)"
    if game is None and "pageAlive" not in push:
        return f"dev server 已收下(第 {rev} 次)"
    return f"dev server 收下了(第 {rev} 次),但没有游戏页开着——开了游戏进 {sid} 再推一次"


def push_to_game(sid: str, source: str = "export") -> dict:
    """告诉在跑的游戏"这个场景的拆层变了"(走 dev server 的槽,与声学 / 粒子两台同一条路)。

    推的不是内容是**一行 rev + 来源**:草木的载荷是几张 PNG,游戏看到 rev 变大就带缓存戳重装——
    ``source = "preview"`` 从预览目录装(`PREVIEW_ROOT`,推给游戏),``"export"`` 从资源装(导出到游戏)。
    游戏没开着不算错(作者可能就在纯抠图),回 {"pushed": False, ...} 让前端说一句就好。
    """
    import urllib.error
    import urllib.request

    if source not in ("preview", "export"):
        raise ValueError(f"source 只能是 preview / export:{source!r}")
    base = find_game()
    if not base:
        return {"pushed": False, "why": "没找到在跑的游戏(试过 devstate 与 5173/5178/5174/5180/5188)"}
    url = base.rstrip("/") + "/__gamedraft-api/runtime-sway"
    body = json.dumps({"sceneId": sid, "writer": "sway_workbench", "source": source}).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=2.5) as r:          # noqa: S310 — 本机 dev server
            got = json.loads(r.read().decode("utf-8") or "{}")
        game = got.get("game") if isinstance(got.get("game"), dict) else None
        # pushed = dev server 收下了这一行；pageAlive / inScene 才是"游戏页真会看到"；
        # pageBusy = 游戏页在但正在装场景 / 重装（前端据它别去拉第二个游戏窗口，等它装好）
        return {"pushed": True, "rev": got.get("rev"), "url": base, "game": game,
                "pageAlive": page_alive(game), "inScene": page_alive(game) and game.get("sceneId") == sid,
                "pageBusy": page_busy(game)}
    except (urllib.error.URLError, OSError, ValueError) as e:
        _GAME_BASE.clear()
        return {"pushed": False, "why": f"{type(e).__name__}: {e}", "url": base}


#: 撤掉预览之后通知游戏的那条线程（测试 join 它；关窗时它不是 daemon，进程等它发完再退——最多几秒）
_REVOKE_NOTIFY: list[threading.Thread] = []


def _checked_preview_root(sid: str) -> Path:
    """``local/sway_preview/<场景>``,场景名拼路径(``..`` / 斜杠 / 盘符…)一律 ValueError——下面要整目录删。"""
    s = str(sid or "")
    if not s or s in (".", "..") or any(c in s for c in '/\\:*?"<>|\x00'):
        raise ValueError(f"场景不合法:{sid!r}")
    root = preview_root(s)
    if root.resolve().parent != PREVIEW_ROOT.resolve():
        raise ValueError(f"场景不合法:{sid!r}")
    return root


def drop_preview_after_export(sid: str, log) -> None:
    """导出成功之后删掉这个场景推过的本机预览(**只删 local/sway_preview/<场景>,资源不动**)。

    游戏收到导出那一行就忘了预览(`runtimeSwaySync.ts` 的 previews.delete),本机预览再留着就是
    "工作台说游戏里是预览、资源还没导出、叠加层 / Alt+点读被取代的那版"——推 A、再涂几笔、按 B 导出 B 这条日常路就中招。
    不单独通知游戏(导出自己那一行已经让它换回资源)。**删不掉只记一行日志、绝不把导出报成失败**
    (dev server 正读着那几张图时 Windows 会锁文件;`preview_state` 另有"资源不比预览旧就不算不同"兜着)。
    """
    import shutil

    try:
        root = _checked_preview_root(sid)
        if root.is_dir():
            retry_transient(shutil.rmtree, root)
            log("本机推过的预览已被这次导出取代,删掉了(资源里就是游戏现在这份)")
    except Exception as e:                                   # noqa: BLE001 — 导出已经成了,删预览失败不许翻成失败
        log(f"⚠ 本机推过的预览没删掉:{type(e).__name__}: {e}(不影响导出;工作台照样按资源那份显示)")


def revoke_preview(sid: str) -> dict:
    """丢弃没保存的改动时撤掉推给游戏的预览:删 ``local/sway_preview/<场景>``(**只删本机预览,资源一个字节不动**),
    再让游戏换回资源里那份(往槽里写一行 ``source: 'export'``,游戏原地重装)。

    只在"预览存在、而且与盘上这份内容不同"时撤:预览就是盘上这份(推之前存过)就留着,它没被丢掉。
    通知游戏在后台线程里发、不等:丢弃的路径(关窗 / 刷新选「不保存」)壳只等 2 秒,探游戏端口可能就要两三秒。
    回 ``{ok, revoked, why?, hasExport?}``。``hasExport`` = 资源里有游戏装得上的这一层(与运行时
    ``loadBackgroundSwayInput`` 同一判据:``sway.json`` 在、版本对、至少一株);False 时游戏没东西可换回,
    刚推的那层要出场再进才拿掉 —— 页面据此换说法,不许说"游戏换回资源里这份"。
    """
    import shutil

    s = str(sid or "")
    root = _checked_preview_root(s)
    if not root.is_dir():
        return {"ok": True, "revoked": False, "why": "没有推过的预览"}
    if _JOB["running"] and _JOB["kind"] == "push" and _JOB["scene"] == s:
        return {"ok": True, "revoked": False, "why": "正在推送这个场景,等它跑完"}
    sc = Scene(s)
    st = preview_state(sc, with_disk=True)
    if not st["exists"]:
        return {"ok": True, "revoked": False, "why": "没有推过的预览"}
    if st["matchesDisk"]:
        return {"ok": True, "revoked": False, "why": "预览就是盘上这份,留着"}
    retry_transient(shutil.rmtree, root)

    def notify() -> None:
        try:
            push_to_game(s, "export")
        except Exception:                                    # noqa: BLE001 — 游戏没开 / 送不到都不是错,预览已经撤了
            pass

    t = threading.Thread(target=notify, daemon=False, name="sway-revoke-notify")
    _REVOKE_NOTIFY[:] = [t]
    t.start()
    res = _read_json(sc.bake_dir / "sway.json")
    has_export = bool(res) and res.get("version") == sway_field.SWAY_VERSION and bool(res.get("instances"))
    return {"ok": True, "revoked": True, "hasExport": has_export}


#: dev server 的运行时命令队列(游戏页轮询它;POST 时服务端给每条盖 ``enqueuedAt``、过了 TTL 就剪掉)
RUNTIME_COMMAND_API = "/__gamedraft-api/runtime-command"


def enqueue_switch_scene_via_game(base: str, sid: str) -> dict:
    """经**在跑的 dev server** 排一条"切到这个场景"的运行时命令:``{ok, detail}``。

    ⚠ 不许直接写队列文件(`game_link.enqueue_switch_scene` 那条):那样写进去的命令没有 ``enqueuedAt``,
    dev server 的 TTL 剪枝对它无效、永远留着——作者按了 P、控制台和游戏都没开,几个小时后(甚至第二天)
    打开游戏,游戏一进来就被拽到那个场景,谁也不知道为什么。走 POST 服务端才会盖时间戳、到点自动过期。
    POST 是**整队替换**:先 GET 现有的(已剪过期的)再追加,别把别人排着的命令冲掉。
    """
    import urllib.error
    import urllib.request

    from tools.production_workbench.runtime_command import new_runtime_command

    url = base.rstrip("/") + RUNTIME_COMMAND_API
    try:
        with urllib.request.urlopen(url, timeout=1.5) as r:                          # noqa: S310 — 本机 dev server
            got = json.loads(r.read().decode("utf-8") or "{}")
        cur = got.get("commands") if isinstance(got, dict) and isinstance(got.get("commands"), list) else []
        cmd = new_runtime_command("debugSwitchScene", reason="sway-workbench: 切到正在编辑的场景",
                                  payload={"sceneId": sid})
        body = json.dumps({"commands": [*cur, cmd]}, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=2.5) as r:                          # noqa: S310
            back = json.loads(r.read().decode("utf-8") or "{}")
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"ok": False, "detail": f"排不进 dev server 的命令队列:{type(e).__name__}: {e}"}
    if not (isinstance(back, dict) and back.get("ok")):
        return {"ok": False, "detail": f"dev server 没收下切场景命令:{back!r}"[:300]}
    return {"ok": True, "detail": f"已排进 {base} 的命令队列(过一会儿没人取就自动过期)"}


def decode_inputs(sid: str, channels: dict | None, overrides: dict | None) -> dict:
    """页面上此刻的四层 + 逐株设置 → ``sway_field.bake_sway(inputs=)`` 要的形状(推给游戏用,不落盘)。

    四层与保存同一套解码(**不透明灰度**,尺寸不对拉回原画分辨率);缺的层按空处理。
    逐株设置与保存同一套清洗(越界点丢掉)。旧的 ``sway_lock.png`` 烘焙那边照样并进来。
    """
    import numpy as np

    sc = Scene(sid)
    nw, nh = sc.native
    paint = {}
    for name in CHANNELS:
        g = _decode_gray(str((channels or {}).get(name) or ""), (nw, nh))
        paint[name] = g if g is not None else np.zeros((nh, nw), np.uint8)
    ov = overrides if isinstance(overrides, dict) else {}
    return {"paint": paint,
            "overrides": {"anchors": _clean_points(ov.get("anchors"), nw, nh),
                          "coherent": _clean_points(ov.get("coherent"), nw, nh)}}


#: 后台的活(推给游戏 / 导出到游戏,同一时刻只允许一个——分割很吃内存,两个一起跑还会抢同一批产物)
#: ⚠ 字段别叫 `ok`:响应信封外层已经有一个 `ok`,同名会把它盖掉,前端一律当成"请求失败"
_JOB: dict = {"running": False, "kind": "", "scene": "", "log": [], "done": False, "succeeded": False, "err": "",
              "started": 0.0}
_JOB_NAMES = {"push": "推给游戏", "export": "导出到游戏"}
#: 烘焙类的活(推送 / 导出 / 预热)一个一个来:它们共用 `sway_field` 的进程内缓存,并发改 LRU 会互相踩
_BAKE_LOCK = threading.Lock()
#: ``want`` = 页面最近一次要预热的场景(最后一次说了算):正在预热别的场景时记下,那一轮跑完接着热它
_WARM: dict = {"running": False, "scene": "", "done": "", "err": "", "want": ""}
#: 预热"查忙 + 开跑"要一口气做完:HTTP 线程(装场景)与后台线程(上一轮刚跑完)会同时来开
_WARM_LOCK = threading.Lock()


def job_status() -> dict:
    """前端每 0.7 秒问一次:跑到哪了。

    ⚠ 烘焙**不能同步做完再回**:第一次要跑分割,几十秒到几分钟,浏览器那边看着就是一个卡死的按钮
    (作者会以为工具挂了,然后去点第二次)。所以开线程做、把状态行一行行攒起来给前端轮。
    """
    import time
    b = dict(_JOB)
    b["log"] = list(_JOB["log"])
    b["elapsed"] = round(time.time() - _JOB["started"], 1) if _JOB["started"] else 0.0
    return b


def _start_job(kind: str, sid: str, bake, source: str) -> dict:
    """开一条后台线程:先烘(`bake(status)`),烘成了再告诉游戏(`source`)。"""
    import time

    if _JOB["running"]:
        return {"ok": False, "err": f"正在{_JOB_NAMES.get(_JOB['kind'], '烘')} {_JOB['scene']},等它跑完", "busy": True}
    _JOB.clear()
    _JOB.update({"running": True, "kind": kind, "scene": sid, "log": [], "done": False, "succeeded": False,
                 "err": "", "started": time.time()})

    def run() -> None:
        try:
            if _WARM["running"]:
                # ⚠ 只有预热的正是这个场景,才能说"缓存这一次用得上":原来一律这么说,
                # 作者在 A 预热期间切到 C 按 P,等完 A 的预热 C 照样冷跑,日志却许诺会快
                if _WARM["scene"] == sid:
                    _JOB["log"].append(f"等后台预热 {sid} 跑完(预热填的缓存这一次就用得上)…")
                else:
                    _JOB["log"].append(f"等后台预热 {_WARM['scene']} 跑完(那是别的场景,帮不上这一次)…")
            with _BAKE_LOCK:
                rows = bake(lambda m: _JOB["log"].append(str(m)))
            # 一个时段目录都没写(没有照明载荷 / 全被跳过)却报「✔ 已写进资源」= 作者以为导出了、其实什么都没进
            if isinstance(rows, list) and not rows:
                raise RuntimeError("一个时段目录都没写(没有照明载荷,或每个时段都被跳过了——原因在上面的日志里)")
            _JOB["succeeded"] = True
            if kind == "push":
                _WARM["done"] = sid          # 推送就是按预热的口径算的,缓存已经热了,别再白热一遍
        except Exception as e:                               # noqa: BLE001 — 失败原文回前端
            _JOB["succeeded"] = False
            _JOB["err"] = f"{type(e).__name__}: {e}"
            _JOB["done"] = True
            _JOB["running"] = False
            _warm_wanted()
            return
        if kind == "export":
            drop_preview_after_export(sid, lambda m: _JOB["log"].append(str(m)))   # 自带 try:删不掉不算导出失败
        # ⚠ 通知游戏**单独一个 try**:它跟烘焙成不成功没关系。合在一起的话,游戏那边一出岔子
        # 就会把一次**已经烘好、产物都落盘了**的烘焙报成失败,作者会再烘一遍(第一次要跑分割,几十秒)。
        try:
            push = push_to_game(sid, source)
            _JOB["push"] = push
            _JOB["log"].append(push_note(push, sid))
        except Exception as e:                               # noqa: BLE001 — 送不到不影响烘焙的成败
            _JOB["push"] = {"pushed": False, "why": f"{type(e).__name__}: {e}"}
            _JOB["log"].append(f"没送到游戏:{type(e).__name__}: {e}(已经烘好了,游戏里重进一次场景也能看到)")
        finally:
            _JOB["done"] = True
            _JOB["running"] = False
            _warm_wanted()

    threading.Thread(target=run, daemon=True, name=f"sway-{kind}").start()
    return {"ok": True, "started": True}


def push_start(sid: str, channels: dict | None = None, overrides: dict | None = None) -> dict:
    """推给游戏:页面上此刻那份(``channels`` / ``overrides``;都不给 = 用盘上的)烘进预览目录,再让游戏从那里装。

    资源一个字节不动——这是和导出唯一的、也是全部的区别。
    """
    inputs = decode_inputs(sid, channels, overrides) if channels is not None else None
    out = preview_root(sid)
    return _start_job("push", sid, lambda status: sway_field.bake_sway(sid, status, inputs=inputs, out_root=out),
                      "preview")


def export_start(sid: str) -> dict:
    """导出到游戏:盘上的涂层烘进资源(各时段照明载荷目录),再让游戏换回资源那份。"""
    return _start_job("export", sid, lambda status: sway_field.bake_sway(sid, status), "export")


def warm_start(sid: str) -> dict:
    """装场景时在后台把这个场景按推送的口径全算一遍、**一个字节都不写**(`bake_sway(dry=True)`)。

    第一次推给游戏要从盘上解分割、做去重、补两三张整幅底板,跑马梁实测 15 s 以上;预热过的只要 1 s 左右。
    正在推送 / 导出 / 预热就不叠一个,但**记下这是最近想热的场景**(`_WARM['want']`),手上那一轮跑完接着热它;
    失败只记一行(预热失败不影响之后照常推送,只是那一次慢)。

    ⚠ 原来忙的时候直接回 started:false、没人再补:从菜单起工作台会先自动装第一个有拆层的场景并开始冷预热(约 16 s),
    作者在这期间切到真正要干活的场景,那个场景就永远没热过,第一次推送先等别人的预热、再自己冷跑,前后半分钟。
    """
    if not sid:
        return {"ok": True, "started": False}
    with _WARM_LOCK:
        _WARM["want"] = sid
        return {"ok": True, "started": _warm_launch_locked()}


def _warm_launch_locked() -> bool:
    """(持 `_WARM_LOCK` 调)闲着且想热的场景还没热过 ⇒ 开一轮预热。"""
    sid = _WARM.get("want") or ""
    if not sid or _JOB["running"] or _WARM["running"] or _WARM["done"] == sid:
        return False
    _WARM.update({"running": True, "scene": sid, "err": ""})

    def run() -> None:
        try:
            with _BAKE_LOCK:
                sway_field.bake_sway(sid, lambda _m: None, dry=True)
            _WARM["done"] = sid
        except Exception as e:                               # noqa: BLE001 — 预热失败不是错,推送时照常算
            _WARM["err"] = f"{type(e).__name__}: {e}"
            with _WARM_LOCK:
                if _WARM["want"] == sid:
                    _WARM["want"] = ""                       # 别原地重试个没完;作者再装一次这个场景会再试
        finally:
            _WARM["running"] = False
            _warm_wanted()

    threading.Thread(target=run, daemon=True, name="sway-warm").start()
    return True


def _warm_wanted() -> None:
    """一轮预热 / 推送 / 导出刚跑完:作者期间切去的场景(最后一个)还没热 ⇒ 接着热它。"""
    with _WARM_LOCK:
        _warm_launch_locked()


def run_sync(kind: str, sid: str) -> dict:
    """同步跑一次(命令行 `--push` / `--export` 用;页面走 `push_start` / `export_start` + `job_status`)。"""
    lines: list[str] = []
    try:
        if kind == "push":
            rows = sway_field.bake_sway(sid, status=lambda m: lines.append(str(m)), out_root=preview_root(sid))
        else:
            rows = sway_field.bake_sway(sid, status=lambda m: lines.append(str(m)))
    except Exception as e:                                   # noqa: BLE001 — 烘焙失败要把原文回给前端,不是断连
        return {"ok": False, "err": f"{type(e).__name__}: {e}", "log": lines}
    if kind != "push":
        drop_preview_after_export(sid, lambda m: lines.append(str(m)))
    push = push_to_game(sid, "preview" if kind == "push" else "export")
    lines.append(push_note(push, sid))
    return {"ok": True, "log": lines, "targets": rows, "push": push}


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
    bd, source = derived_dir(sc)                  # 与叠加层同一份:预览更新就问预览
    out: dict = {"at": [ix, iy], "instance": None, "matte": None, "rigid": None, "source": source}
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
