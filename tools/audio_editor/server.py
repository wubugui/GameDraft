# -*- coding: utf-8 -*-
"""音频加工台 —— 加工原始音频,并把成品挂到项目里已有的音频 key 上。

## 这不是一个文件搬运工具

主体是**项目的音频 key**(audio_config.json 的 bgm / ambient / sfx 三区已登记 id),
每次打开实时扫描,界面上不提供手写 id 的入口 —— 新 key 由主编辑器建,这里只往
已有的 key 上挂内容。工具为每个 key 记账:现在挂的是什么内容、什么时候挂的、
料从哪来、可以就地试听。

## 判同一性一律看 hash,从不看文件名(两层身份,别混)

* **加工指纹** = hash(源字节) + 规范化编辑参数 + 输出格式。命中就说明「这套料这套
  参数我加工过」,直接复用那份成品,**零渲染**。
* **成品字节 hash** = 物理文件的身份。两个 key 拿到同一份内容时,写的是**同一个
  路径字符串**,不再拷第二份文件。

项目里那份永远是成品、不是料:ffmpeg 会把版本戳和源文件元数据一起烘进去,
源字节与成品字节结构性对不上。所以两层 hash 分开存、分开比,细节见 ledger.py。

## 写 audio_config 只做一件事:换 src

不新增条目、不删条目、不动 volume 与任何别的键。文本级按 (区, id) 精确替换,
细节与那两处历史硬伤见 audio_config_io.py。

启动: python3 tools/audio_editor/server.py   (默认 http://127.0.0.1:8790)
"""
from __future__ import annotations

from tools.atomic_io import retry_transient

import hashlib
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
for _p in (str(REPO), str(HERE)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import audio_config_io as cio                       # noqa: E402
import ledger as led                                # noqa: E402
from tools.editor.shared.project_paths import (     # noqa: E402
    URL_KIND_MEDIA, ProjectPaths,
)

STATIC = HERE / "static"
IMPORTED = HERE / "imported"
CACHE = HERE / ".cache"
EDITS = HERE / "edits.json"
UISTATE = HERE / "ui_state.json"
#: 导出台账(进 git,要能 review diff)与本次会话的分配(工作态,改得飞快)分开存
EXPORTS = HERE / "exports.json"
ASSIGNMENTS = HERE / "assignments.json"
BACKUPS = HERE / ".backups"

# src <-> 磁盘的双向转换只有这一个权威,绝不自己拼字符串:
# 前缀怎么剥、public/ 在哪一层加、中文路径编不编码,三处(运行时/编辑器/校验器)
# 必须完全一致,各写一份必漂。
PATHS = ProjectPaths(REPO)

PROJECT_AUDIO = PATHS.runtime_audio_dir
AUDIO_CONFIG = PATHS.data_dir / "audio_config.json"
BATCH_OUT = REPO / "tmp/audio_batch_20260809/out"

#: 新成品落这里。文件名是内容寻址的,所以「先落文件、后写配置」是可回滚的:
#: 新文件名必然不与任何已有文件重名,落下去时还没有人引用它。
EXPORT_SUBDIR = "edited"
EXPORT_DIR = PROJECT_AUDIO / EXPORT_SUBDIR

#: 某个 key 从没接过文件时的默认输出格式。**有 src 时一律跟随现有扩展名** ——
#: 线上 180 条里有 52 条与「频道→格式」的老规则相反(ambient 里 16 条 .wav、
#: sfx 里 36 条 .mp3),照老规则推会把这 52 个 key 的格式全部翻面。
CHANNEL_DEFAULT_EXT = {"bgm": ".mp3", "ambient": ".mp3", "sfx": ".wav"}

PORT = int(os.environ.get("AUDIO_EDITOR_PORT", "8790"))

SOURCES: dict[str, Path] = {
    "batch": BATCH_OUT,
    "imported": IMPORTED,
    "project": PROJECT_AUDIO,
}

AUDIO_EXT = {".wav", ".mp3", ".ogg", ".flac", ".m4a", ".aif", ".aiff"}

HASHES = led.HashCache()


# ---------------------------------------------------------------- 工具

def ffprobe_duration(p: Path) -> float | None:
    try:
        r = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(p)],
            capture_output=True, text=True, errors="replace",
        )
    except OSError:
        # 机器上没装 ffprobe:返回 None(=不知道时长),不许整个请求炸掉
        return None
    try:
        # 不要 round:round(1.962404,3)=1.962 比真实时长短,
        # 前端按解码时长算出的合法值会被后端判成"超过总长"(实测 10.9% 的素材中招)。
        return float(r.stdout.strip())
    except ValueError:
        return None


def ffmpeg_version() -> str:
    """记进出处证据用。**绝不进指纹** —— 详见 ledger.py 顶部那段。"""
    if not hasattr(ffmpeg_version, "_v"):
        try:
            r = subprocess.run(["ffmpeg", "-version"], capture_output=True,
                               text=True, errors="replace")
            ffmpeg_version._v = r.stdout.splitlines()[0].strip() if r.stdout else ""
        except (OSError, IndexError):
            ffmpeg_version._v = ""
    return ffmpeg_version._v


def load_edits() -> dict:
    if EDITS.exists():
        try:
            return json.loads(EDITS.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def save_edits(d: dict) -> None:
    # 只浏览不改也会留下 {} 空壳,档案就不再是"我改过什么"的干净记录了
    pruned = {k: v for k, v in d.items() if isinstance(v, dict) and v}
    EDITS.write_text(json.dumps(pruned, ensure_ascii=False, indent=1), encoding="utf-8")


def load_uistate() -> dict:
    """搜索词/筛选/当前选中条目。壳里 LocalStorage 是关的(防缓存),
    所以工作现场只能存服务端,否则刷一次页面就得在几百条里重新找。"""
    if UISTATE.exists():
        try:
            return json.loads(UISTATE.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {}


def prune_cache(keep: int = 40) -> None:
    """预览渲染只增不减,剪一天能堆出几个 G。只留最近的若干个。"""
    try:
        files = sorted((p for p in CACHE.glob("prev_*") if p.is_file()),
                       key=lambda p: p.stat().st_mtime, reverse=True)
        for p in files[keep:]:
            p.unlink(missing_ok=True)
    except OSError:
        pass


def safe_under(root: Path, rel: str) -> Path | None:
    """挡住 ../ 越权访问。"""
    p = (root / rel).resolve()
    try:
        p.relative_to(root.resolve())
    except ValueError:
        return None
    return p


def sanitize_stem(name: str) -> str:
    """成品文件名里那截给人看的前缀。纯装饰 —— 身份在后面那段 hash 上,
    所以这里怎么删都不会影响正确性(中文名被删光就退回 audio)。"""
    s = re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_")[:40]
    return s or "audio"


def rel_to_repo(p: Path) -> str:
    """给人看的相对路径。落在仓库外(测试沙盒)时退回绝对路径,
    绝不让一句显示用的字符串抛异常把整个接口打成 500。"""
    try:
        return str(p.relative_to(REPO))
    except ValueError:
        return str(p)


def iso_from_mtime(p: Path) -> str:
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(p.stat().st_mtime))
    except OSError:
        return time.strftime("%Y-%m-%dT%H:%M:%S")


# ---------------------------------------------------------------- 渲染

# 时长容差:容器时长 vs 解码时长的天然误差 + 浮点取整,10ms 足够覆盖
DUR_TOL = 0.01


class EditError(ValueError):
    """编辑参数本身非法 —— 必须报错,绝不能"猜一个合理值"继续。"""


def build_filter(ed: dict, dur: float) -> tuple[list[str], float]:
    """按编辑参数拼 ffmpeg 滤镜链,返回 (滤镜列表, 输出时长)。

    非法裁剪一律抛 EditError。曾经这里遇到 end<=start 会默默退回"整条",
    结果界面显示裁到 0.6s、导出却是完整 2.78s——错得无声无息,最坑。

    ⚠ 这个函数的行为是**加工指纹的语义基础**:同一套参数必须永远拼出同一条链,
    改动它必须同步抬高 ledger.FINGERPRINT_ALGO,否则旧指纹会假命中。
    """
    trim = ed.get("trim") or {}
    try:
        start = float(trim.get("start") or 0)
        end = float(trim.get("end")) if trim.get("end") is not None else dur
    except (TypeError, ValueError):
        raise EditError(f"裁剪起止点不是数字: {trim!r}")
    if start < 0 or end < 0:
        raise EditError(f"裁剪起止点不能为负: 起点 {start}, 终点 {end}")
    # 容器报的时长和解码时长天生差几毫秒,前端拿的是解码时长。
    # 差在容差内就钳制,只有明显越界才报错——零容差会把工具自己填的值判非法。
    if end > dur + DUR_TOL:
        raise EditError(f"裁剪终点 {end:.3f}s 超过音频总长 {dur:.3f}s")
    end = min(end, dur)
    if end <= start:
        raise EditError(f"裁剪终点必须大于起点(起点 {start:.3f}s, 终点 {end:.3f}s)")
    out_dur = end - start

    filters = [f"atrim=start={start:.4f}:end={end:.4f}", "asetpts=PTS-STARTPTS"]
    # 反向必须排在淡入淡出之前:排在后面会把"淡入"翻到成品结尾,
    # 用户填的淡入在听感上变成淡出,界面还不吭声。
    if ed.get("reverse"):
        filters.append("areverse")

    fi = float(ed.get("fadeIn") or 0)
    fo = float(ed.get("fadeOut") or 0)
    if fi < 0 or fo < 0:
        raise EditError(f"淡入淡出不能为负(淡入 {fi}, 淡出 {fo})")
    if fi + fo > out_dur + DUR_TOL:
        raise EditError(
            f"淡入 {fi}s + 淡出 {fo}s 超过输出时长 {out_dur:.3f}s")
    if fi + fo > out_dur:          # 容差内的溢出按比例缩掉,别拒
        k = out_dur / (fi + fo)
        fi, fo = fi * k, fo * k
    if fi > 0:
        filters.append(f"afade=t=in:st=0:d={fi:.4f}")
    if fo > 0:
        filters.append(f"afade=t=out:st={out_dur - fo:.4f}:d={fo:.4f}")

    gain = float(ed.get("gainDb") or 0)
    if gain:
        filters.append(f"volume={gain:.2f}dB")

    norm = ed.get("normalize") or {}
    if norm.get("enabled"):
        tgt = float(norm.get("peakDb", -3))
        if tgt > 0:
            raise EditError(f"归一目标 {tgt}dBFS 是正数,必然削顶(0 已是满刻度)")

    return filters, out_dur


def measure_peak(p: Path, filters: list[str]) -> float | None:
    af = ",".join(filters + ["volumedetect"]) if filters else "volumedetect"
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(p), "-af", af, "-f", "null", "-"],
        capture_output=True, text=True, errors="replace",
    )
    for line in r.stderr.splitlines():
        if "max_volume:" in line:
            try:
                return float(line.split("max_volume:")[1].strip().split()[0])
            except (ValueError, IndexError):
                return None
    return None


def render(src: Path, ed: dict, dst: Path) -> tuple[bool, str]:
    dur = ffprobe_duration(src) or 0
    try:
        filters, _ = build_filter(ed, dur)
    except EditError as ex:
        return False, str(ex)

    norm = ed.get("normalize") or {}
    if norm.get("enabled"):
        target = float(norm.get("peakDb", -3))
        gain = float(ed.get("gainDb") or 0)
        # 测峰必须在**不含增益**的链上做:volumedetect 走 int16,
        # 增益一旦把波形推过 0dBFS,它读到的是被削平的 0.0,
        # 据此算的补偿量是错的(实测 +12dB 时归一目标 -3 却导出 0dB 削顶)。
        # 增益是线性的,加完的峰值可以直接推算,不必真跑一遍。
        probe = [f for f in filters if not f.startswith("volume=")]
        peak = measure_peak(src, probe)
        if peak is not None:
            filters.append(f"volume={target - (peak + gain):.2f}dB")

    warn = None
    gain_only = float(ed.get("gainDb") or 0)
    if gain_only > 0 and not norm.get("enabled"):
        probe = [f for f in filters if not f.startswith("volume=")]
        pk = measure_peak(src, probe)
        if pk is not None and pk + gain_only > 0:
            warn = (f"增益 +{gain_only:g}dB 会把峰值推到 {pk + gain_only:+.1f}dBFS,"
                    "超过 0 的部分会被削平失真")

    dst.parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-y", "-hide_banner", "-nostats", "-i", str(src)]
    if filters:
        cmd += ["-af", ",".join(filters)]
    if dst.suffix.lower() == ".mp3":
        cmd += ["-b:a", led.MP3_BITRATE]
    cmd.append(str(dst))
    r = subprocess.run(cmd, capture_output=True, text=True, errors="replace")
    if r.returncode != 0 or not dst.exists():
        return False, r.stderr[-400:]
    return True, warn or ""


# ---------------------------------------------------------------- key 扫描

def read_config() -> tuple[str, dict, cio.Node, tuple[int, int]]:
    """读一次配置,同时拿到文本、解析结果、带区间的树,以及 (size, mtime_ns)。

    那个 stat 要一路带到落盘那一刻做复核:主编辑器 Save All 会拿它内存里的旧
    audio_config 整份覆盖磁盘,中间被它插一脚就等于我们刚写的 src 全被抹掉。
    """
    text = AUDIO_CONFIG.read_text(encoding="utf-8")
    st = AUDIO_CONFIG.stat()
    return text, json.loads(text), cio._SpanParser(text).parse(), (st.st_size, st.st_mtime_ns)


def key_id(channel: str, audio_id: str) -> str:
    return f"{channel}/{audio_id}"


def split_key(key: str) -> tuple[str, str]:
    channel, _, audio_id = key.partition("/")
    return channel, audio_id


def src_to_disk(src: str) -> Path | None:
    """src 字符串 -> 磁盘路径(不保证存在)。形状不合法一律 None。"""
    if not src or cio.validate_src(src) is not None:
        return None
    return PATHS.url_to_disk(src, kind=URL_KIND_MEDIA)


def disk_to_src(path: Path) -> str | None:
    return PATHS.disk_to_runtime_url(path)


def is_product_file(path: Path) -> bool:
    """这份文件是不是本工具的产出。

    唯一可靠、且不靠猜名字的判据:它在本工具的导出目录里。存量回填就靠这一条
    区分「本工具导出过的 44 个」和「别处来的 136 个」。
    """
    try:
        path.resolve().relative_to(EXPORT_DIR.resolve())
        return True
    except (ValueError, OSError):
        return False


def derived_ext(src: str, channel: str) -> str:
    """这个 key 该导出成什么格式:**跟随它现在挂的文件**,没挂过才按频道给默认值。"""
    if src:
        suffix = Path(src).suffix.lower()
        if suffix in AUDIO_EXT:
            return suffix
    return CHANNEL_DEFAULT_EXT.get(channel, ".wav")


def backfill(ledger: dict, rows: list[dict]) -> int:
    """把已经存在的成品认领进台账(每个 key 只在第一次建账时做一次)。

    * 文件在导出目录里 -> 记成本工具的产出,key 直接标「已导出」,
      时间取文件 mtime 并标 ``inferred``(那不是真的导出时刻,界面必须如实说)。
    * 文件在别处 -> 只登记这份内容存在过,``origin=None``(来源未知),
      **不**给 key 记导出 —— 它本来就不是我们导的。

    绝不反推来料出处:名字像不像某个源文件,与它是不是那份料无关。
    """
    n = 0
    for row in rows:
        f = row.get("file")
        if not f or not f.get("hash"):
            continue
        if row["key"] in ledger["keys"]:
            continue                      # 已经建过账,磁盘对不上是「漂移」,交给状态推导
        h = f["hash"]
        path = Path(f["path"])
        product = is_product_file(path)
        led.record_file(ledger, h, src=row["src"], size=f["bytes"],
                        origin={"backfilled": True} if product else None)
        if product:
            led.record_key_export(ledger, row["key"], content_hash=h, src=row["src"],
                                  inferred=True, at=iso_from_mtime(path))
            n += 1
    return n


def scan_keys(ledger: dict, assignments: dict) -> dict:
    """实时扫出项目的音频 key 全量 + 每个 key 的真实状态。

    状态**一律由磁盘反算**:读 src -> 解析成磁盘路径 -> 算 hash -> 与台账比。
    台账只是缓存;它说「已导出」而磁盘上是别的东西,那就是漂移,以磁盘为准。
    """
    text, doc, root, _stat = read_config()
    rows: list[dict] = []
    for channel in cio.CHANNELS:
        sec = doc.get(channel)
        if not isinstance(sec, dict):
            continue
        for audio_id in sec:
            entry = cio.read_entry(doc, channel, audio_id) or {"src": "", "volume": None, "extra": {}}
            key = key_id(channel, audio_id)
            src = entry["src"]

            # 能不能安全地把这一行写回配置 —— 判据只有后端这一处,
            # 前端不许另写一套正则(否则两边必漂)。
            reason = cio.key_is_writable(audio_id)
            if reason is None and cio.entry_src_span(root, channel, audio_id) is None:
                reason = "这条登记的结构不认识(没有可替换的 src 字符串),本工具不敢改"

            path = src_to_disk(src)
            file_info = None
            if path is not None and path.is_file():
                h = HASHES.get(path)
                file_info = {
                    "name": path.name,
                    "path": str(path),
                    "bytes": path.stat().st_size,
                    "hash": h,
                    "mtime": iso_from_mtime(path),
                    "url": f"/keyfile?key={urllib.parse.quote(key)}",
                    "product": is_product_file(path),
                }
            rows.append({
                "key": key, "channel": channel, "audio_id": audio_id,
                "src": src, "volume": entry["volume"],
                "extraKeys": sorted(entry["extra"]),
                "file": file_info,
                "exportable": reason is None,
                "reason": reason or "",
                "outExt": derived_ext(src, channel),
            })

    filled = backfill(ledger, rows)
    if filled:
        led.save_ledger(EXPORTS, ledger)

    # 台账/分配态叠加上去(状态由磁盘反算,台账只提供「上次记的是什么」)
    for row in rows:
        disk_hash = (row["file"] or {}).get("hash")
        row["status"] = led.derive_status(ledger, row["key"], src=row["src"],
                                          disk_hash=disk_hash)
        rec = ledger["keys"].get(row["key"])
        row["ledger"] = ({
            "exportedAt": rec.get("exportedAt"),
            "inferred": bool(rec.get("inferred")),
            "origin": (ledger["files"].get(rec.get("hash")) or {}).get("origin"),
        } if rec else None)
        asn = assignments.get(row["key"])
        row["assigned"] = asn or None

    # 分配到了已经不存在的 key(主编辑器里被改名/删了)也要报出来,不能默默消失
    known = {r["key"] for r in rows}
    orphans = [{"key": k, **v} for k, v in assignments.items() if k not in known]

    stats = {"total": len(rows), "assigned": sum(1 for r in rows if r["assigned"])}
    for st in (led.STATUS_UNLINKED, led.STATUS_MISSING, led.STATUS_EXPORTED,
               led.STATUS_FOREIGN, led.STATUS_DRIFTED):
        stats[st] = sum(1 for r in rows if r["status"] == st)
    stats["unexportable"] = sum(1 for r in rows if not r["exportable"])
    return {"keys": rows, "stats": stats, "orphans": orphans,
            "config": rel_to_repo(AUDIO_CONFIG),
            "exportDir": rel_to_repo(EXPORT_DIR)}


# ---------------------------------------------------------------- 导出计划

def resolve_ledger_file(ledger: dict, content_hash: str) -> tuple[Path | None, str | None]:
    """台账里这份内容现在还在不在、内容还对不对。给 lookup_fingerprint 当核对器。"""
    rec = ledger["files"].get(content_hash)
    if not rec:
        return None, None
    path = src_to_disk(rec.get("src", ""))
    if path is None or not path.is_file():
        return None, None
    return path, HASHES.get(path)


def source_path(key: str) -> Path | None:
    src, _, rel = key.partition("/")
    root = SOURCES.get(src)
    return safe_under(root, rel) if root else None


def build_plan(ledger: dict, assignments: dict) -> dict:
    """算出「点导出会发生什么」。预览、确认框、真导出三处共用这一个函数。"""
    text, doc, root, stat = read_config()
    edits = load_edits()
    rows: list[dict] = []

    for key, asn in sorted(assignments.items()):
        channel, audio_id = split_key(key)
        source_key = (asn or {}).get("sourceKey") or ""
        row = {"key": key, "channel": channel, "audio_id": audio_id,
               "sourceKey": source_key, "action": "blocked", "reason": "",
               "currentSrc": "", "targetSrc": None, "ext": "",
               "warn": "", "reuse": False}
        rows.append(row)

        if channel not in cio.CHANNELS:
            # assignments.json 是持久文件,只堵入口挡不住存量(旧文件、手改的)
            row["reason"] = (f"「{channel}」不是承载文件的频道,不在扫描清单里")
            continue
        entry = cio.read_entry(doc, channel, audio_id)
        if entry is None:
            row["reason"] = "这个 key 在配置里已经没有了(可能在主编辑器里被改名或删除)"
            continue
        row["currentSrc"] = entry["src"]

        why = cio.key_is_writable(audio_id)
        if why:
            row["reason"] = why
            continue
        if cio.entry_src_span(root, channel, audio_id) is None:
            row["reason"] = "这条登记的结构不认识(没有可替换的 src 字符串)"
            continue

        spath = source_path(source_key)
        if spath is None or not spath.is_file():
            row["reason"] = f"分配的源文件已经不在了: {source_key}"
            continue

        ed = edits.get(source_key) or {}
        dur = ffprobe_duration(spath)
        if dur is None:
            row["reason"] = "读不出这个源文件的时长(装了 ffprobe 吗?文件是不是坏的?)"
            continue
        try:
            build_filter(ed, dur)          # 参数非法必须在这里就拦住,不能等到渲染
        except EditError as ex:
            row["reason"] = f"编辑参数非法: {ex}"
            continue

        ext = (asn.get("ext") or "").lower() or derived_ext(entry["src"], channel)
        row["ext"] = ext
        cur_ext = Path(entry["src"]).suffix.lower() if entry["src"] else ""
        if cur_ext and cur_ext != ext:
            row["warn"] = f"格式会从 {cur_ext} 变成 {ext}"

        shash = HASHES.get(spath)
        if shash is None:
            row["reason"] = "读不了这个源文件"
            continue
        params = led.normalized_render_params(ed)
        fp = led.make_fingerprint(shash, params, led.output_spec(ext))
        row["fingerprint"] = fp

        hit = led.lookup_fingerprint(ledger, fp,
                                     lambda h: resolve_ledger_file(ledger, h))
        cur_hash = None
        cur_path = src_to_disk(entry["src"])
        if cur_path is not None and cur_path.is_file():
            cur_hash = HASHES.get(cur_path)

        if hit:
            target = (ledger["files"].get(hit) or {}).get("src")
            row["targetSrc"] = target
            row["reuse"] = True
            if target == entry["src"] and cur_hash == hit:
                row["action"] = "unchanged"       # 幂等:已经是这份内容了,什么都不用做
            else:
                row["action"] = "relink"          # 内容已在项目里:只改映射,零渲染零拷贝
        else:
            row["action"] = "render"              # 没见过这套料+参数,要渲一次

    counts = {a: sum(1 for r in rows if r["action"] == a)
              for a in ("render", "relink", "unchanged", "blocked")}
    return {"rows": rows, "counts": counts, "blocked": counts["blocked"] > 0,
            "stat": stat,
            "config": rel_to_repo(AUDIO_CONFIG),
            "exportDir": rel_to_repo(EXPORT_DIR)}


# ---------------------------------------------------------------- 导出执行

def run_export(ledger: dict, assignments: dict) -> dict:
    plan = build_plan(ledger, assignments)
    if plan["blocked"]:
        bad = [r for r in plan["rows"] if r["action"] == "blocked"]
        return {"ok": False, "error": f"有 {len(bad)} 条过不了检查,整批没有导出",
                "rows": plan["rows"]}
    todo = [r for r in plan["rows"] if r["action"] in ("render", "relink")]
    if not todo and not plan["rows"]:
        return {"ok": False, "error": "还没有给任何 key 分配素材"}

    edits = load_edits()
    import tempfile
    staging = Path(tempfile.mkdtemp(prefix="audio_export_"))
    placed: list[Path] = []          # 本次真正新落到项目里的文件(失败要删掉)
    results: list[dict] = []
    failed: list[dict] = []
    # 同一批里把同一份料分给好几个 key 是常事(用户明说的用法)。指纹一样就只渲一次,
    # 不然 N 个 key 就是 N 遍 ffmpeg —— 「重复导出必须廉价」在批内也得成立。
    batch_done: dict[str, tuple[str, str]] = {}     # fingerprint -> (contentHash, src)
    batch_content: dict[str, str] = {}              # contentHash -> src(本批已落的)
    try:
        for row in plan["rows"]:
            if row["action"] == "unchanged":
                results.append({**row, "contentHash": None})
                continue
            if row["action"] != "render" and row["targetSrc"]:
                results.append({**row, "contentHash":
                                ledger["fingerprints"].get(row["fingerprint"])})
                continue
            memo = batch_done.get(row["fingerprint"])
            if memo:
                results.append({**row, "action": "relink", "reuse": True,
                                "targetSrc": memo[1], "contentHash": memo[0]})
                continue

            spath = source_path(row["sourceKey"])
            ed = edits.get(row["sourceKey"]) or {}
            tmp = staging / f"{sanitize_stem(Path(row['sourceKey']).stem)}{row['ext']}"
            ok, warn = render(spath, ed, tmp)
            if not ok:
                failed.append({"key": row["key"], "error": warn})
                continue
            content_hash = led.sha256_file(tmp)
            if content_hash is None:
                failed.append({"key": row["key"], "error": "渲染完读不出成品文件"})
                continue

            # 内容级去重,三层依次问:台账里有没有 -> 本批刚落过没有 -> 都没有才落新文件。
            # 第一层是主力(跨会话复用,有用例锁);中间那层是廉价兜底 —— 要在一批之内
            # 撞出「指纹不同、字节相同」,得两份不同的源渲出完全一样的字节,而 ffmpeg 会把
            # 源的元数据一起搬进成品,实际构造不出来,所以它没有对应用例,只是不留缝。
            known_path, known_hash = resolve_ledger_file(ledger, content_hash)
            if known_path is not None and known_hash == content_hash:
                target_src = ledger["files"][content_hash]["src"]
                row = {**row, "reuse": True, "action": "relink"}
            elif content_hash in batch_content:
                target_src = batch_content[content_hash]
                row = {**row, "reuse": True, "action": "relink"}
            else:
                dst, err = _place_product(tmp, row, content_hash, placed)
                if dst is None:
                    failed.append({"key": row["key"], "error": err})
                    continue
                target_src = disk_to_src(dst)
                if not target_src:
                    failed.append({"key": row["key"], "error": f"算不出 src: {dst}"})
                    continue
            batch_done[row["fingerprint"]] = (content_hash, target_src)
            batch_content.setdefault(content_hash, target_src)
            results.append({**row, "targetSrc": target_src, "contentHash": content_hash,
                            "renderWarn": warn or ""})

        if failed:
            removed = _rollback(placed)
            return {"ok": False,
                    "error": (f"{len(failed)} 条渲染失败,整批取消"
                              + (f"(已撤掉本次新建的 {removed} 个文件)" if removed
                                 else "(项目目录未改动)")),
                    "failed": failed, "rows": plan["rows"]}

        updates = [{"channel": r["channel"], "audio_id": r["audio_id"], "src": r["targetSrc"]}
                   for r in results if r["targetSrc"]]
        cfg = cio.apply_src_updates(AUDIO_CONFIG, updates, backup_dir=BACKUPS,
                                    expect_stat=plan["stat"])
        if not cfg["ok"]:
            # 配置没写成 -> 刚落的新文件全部撤掉,项目零变化。
            # 内容寻址的文件名让这一步是安全的:那些名字里带 hash 的新文件还没有人引用
            # (_place_product 保证 placed 里只有本次新建的)。
            removed = _rollback(placed)
            return {"ok": False,
                    "error": ("配置写入失败,已取消整批导出"
                              + (f"(已撤掉本次新建的 {removed} 个文件)" if removed
                                 else "(项目目录未改动)")
                              + ": " + str(cfg.get("error", ""))),
                    "config": cfg, "rows": plan["rows"]}

        # ---- 落账。到这一步项目里的事实已经成立,台账只是把它记下来 ----
        now_src = {}
        for r in results:
            if not r.get("contentHash"):
                continue
            ch = r["contentHash"]
            path = src_to_disk(r["targetSrc"])
            led.record_file(
                ledger, ch, src=r["targetSrc"],
                size=path.stat().st_size if path and path.is_file() else 0,
                origin={
                    "sourceKey": r["sourceKey"],
                    "sourceHash": HASHES.get(source_path(r["sourceKey"])),
                    "params": led.normalized_render_params(edits.get(r["sourceKey"]) or {}),
                    "fingerprint": r["fingerprint"],
                    "ffmpeg": ffmpeg_version(),
                },
                duration=ffprobe_duration(path) if path else None,
            )
            led.remember_fingerprint(ledger, r["fingerprint"], ch)
            now_src[r["key"]] = (ch, r["targetSrc"])

        for r in results:
            if r["action"] == "unchanged":
                continue                    # 内容没变就别刷新时间,「上次导出」得是真的
            ch_src = now_src.get(r["key"])
            if ch_src:
                led.record_key_export(ledger, r["key"], content_hash=ch_src[0],
                                      src=ch_src[1])
        led.save_ledger(EXPORTS, ledger)

        done = {r["key"] for r in results}
        left = {k: v for k, v in assignments.items() if k not in done}
        led.save_assignments(ASSIGNMENTS, left)

        return {"ok": True, "config": cfg, "rows": results,
                "counts": plan["counts"],
                "newFiles": [p.name for p in placed],
                "warnings": [{"key": r["key"], "warn": r["renderWarn"]}
                             for r in results if r.get("renderWarn")]}
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _place_product(tmp: Path, row: dict, content_hash: str,
                   placed: list[Path]) -> tuple[Path | None, str]:
    """把渲染好的成品放进导出目录,返回 (落位路径, 错误说明)。

    ``placed`` 只收**本次真正新建**的文件 —— 回滚只许删自己刚创建的东西。
    以前把「覆盖了一个已存在的同名文件」也算进去,回滚时会把那份**别的 key 可能正在
    引用**的文件一起删掉,还对用户说「项目目录未改动」。

    文件名是内容寻址的,所以同名基本意味着同内容(直接复用,零动作)。真撞上同名异内容
    (hash 前缀撞车,或有人就地改过这个文件),**绝不覆盖** —— 换更长的后缀另落一份;
    再撞就报错,让整批停下来,而不是赌一把。
    """
    stem = sanitize_stem(Path(row["sourceKey"]).stem)
    for width in (8, 16, 32):
        dst = EXPORT_DIR / f"{stem}_{content_hash[:width]}{row['ext']}"
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            retry_transient(shutil.move, str(tmp), str(dst))
            placed.append(dst)
            return dst, ""
        if HASHES.get(dst) == content_hash:
            return dst, ""          # 同内容同名:上一次导出留下的,直接用
    return None, (f"导出目录里已有同名但内容不同的文件({stem}_…{row['ext']}),"
                  "为免覆盖别人正在引用的文件,这条没有导出")


def _rollback(placed: list[Path]) -> int:
    """撤掉本次新建的文件,返回真正删掉的个数(失败回报要按真实结果说话)。"""
    n = 0
    for p in placed:
        try:
            if p.exists():
                p.unlink()
                n += 1
        except OSError:
            pass
    return n


# ---------------------------------------------------------------- HTTP

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def handle_one_request(self):
        """浏览器取消请求(切歌、关窗、重载)会把连接直接掐掉。
        stdlib 默认会把它当未捕获异常打整段 traceback,刷屏且吓人——这里咽掉。"""
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError, TimeoutError):
            self.close_connection = True

    # -------- helpers
    def _json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, download=False):
        if not path.exists() or not path.is_file():
            self._json({"error": "not found"}, 404)
            return
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Accept-Ranges", "none")
        self.send_header("Cache-Control", "no-store")
        if download:
            self.send_header("Content-Disposition",
                             f'attachment; filename="{path.name}"')
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    # -------- 统一异常出口
    def _guard(self, fn):
        """任何未捕获异常都变成 500 JSON。以前会直接掐连接,
        前端只看到 Failed to fetch,「确认导出」按钮永久卡在"导出中…"。"""
        try:
            fn()
        except Exception as ex:
            import traceback
            traceback.print_exc()
            try:
                self._json({"ok": False,
                            "error": f"{type(ex).__name__}: {ex}"}, 500)
            except Exception:
                pass

    # -------- GET
    def do_GET(self):
        self._guard(self._do_GET)

    def do_POST(self):
        self._guard(self._do_POST)

    def _do_GET(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        q = urllib.parse.parse_qs(u.query)

        if p in ("/", "/index.html"):
            return self._file(STATIC / "app.html")
        if p.startswith("/static/"):
            f = safe_under(STATIC, p[len("/static/"):])
            return self._file(f) if f else self._json({"error": "bad path"}, 400)
        if p == "/api/library":
            return self._json(self.library())
        if p == "/api/keys":
            ledger = led.load_ledger(EXPORTS)
            return self._json(scan_keys(ledger, led.load_assignments(ASSIGNMENTS)))
        if p == "/api/edits":
            return self._json(load_edits())
        if p == "/api/uistate":
            return self._json(load_uistate())
        if p == "/keyfile":
            return self._keyfile((q.get("key") or [""])[0])
        if p.startswith("/media/"):
            rest = p[len("/media/"):]
            src, _, rel = rest.partition("/")
            root = SOURCES.get(src)
            if not root:
                return self._json({"error": "bad source"}, 400)
            f = safe_under(root, urllib.parse.unquote(rel))
            return self._file(f) if f else self._json({"error": "bad path"}, 400)
        if p.startswith("/preview/"):
            f = safe_under(CACHE, p[len("/preview/"):])
            return self._file(f) if f else self._json({"error": "bad path"}, 400)
        if p == "/api/export/plan":
            ledger = led.load_ledger(EXPORTS)
            plan = build_plan(ledger, led.load_assignments(ASSIGNMENTS))
            plan.pop("stat", None)          # 内部复核用,不必给前端
            return self._json(plan)
        return self._json({"error": "not found"}, 404)

    # -------- POST
    def _do_POST(self):
        u = urllib.parse.urlparse(self.path)
        p = u.path
        if p == "/api/edits":
            try:
                save_edits(json.loads(self._body().decode("utf-8")))
                return self._json({"ok": True})
            except Exception as ex:
                return self._json({"ok": False, "error": str(ex)}, 400)
        if p == "/api/uistate":
            try:
                UISTATE.write_text(self._body().decode("utf-8"), encoding="utf-8")
                return self._json({"ok": True})
            except Exception as ex:
                return self._json({"ok": False, "error": str(ex)}, 400)
        if p == "/api/assign":
            return self._json(self.do_assign())
        if p == "/api/import":
            return self._json(self.do_import())
        if p == "/api/render":
            return self._json(self.do_render())
        if p == "/api/export":
            ledger = led.load_ledger(EXPORTS)
            return self._json(run_export(ledger, led.load_assignments(ASSIGNMENTS)))
        return self._json({"error": "not found"}, 404)

    # -------- 业务
    def _keyfile(self, key: str):
        """key 现在挂着的那份文件 —— 给「就地试听」用。

        路径一律由 ProjectPaths 从 src 解析,再核一次它确实落在 runtime 根下面,
        所以 src 里就算写了 ../ 或绝对路径也出不去。
        """
        if not key:
            return self._json({"error": "bad key"}, 400)
        channel, audio_id = split_key(key)
        try:
            _text, doc, _root, _st = read_config()
        except (OSError, json.JSONDecodeError, cio.ConfigIOError) as ex:
            return self._json({"error": str(ex)}, 500)
        entry = cio.read_entry(doc, channel, audio_id)
        path = src_to_disk(entry["src"]) if entry else None
        if path is None or not path.is_file():
            return self._json({"error": "not found"}, 404)
        try:
            path.resolve().relative_to(PATHS.runtime_root.resolve())
        except ValueError:
            return self._json({"error": "bad path"}, 400)
        return self._file(path)

    def library(self) -> dict:
        edits = load_edits()
        items = []
        for src, root in SOURCES.items():
            if not root.exists():
                continue
            for f in sorted(root.rglob("*")):
                if not f.is_file() or f.suffix.lower() not in AUDIO_EXT:
                    continue
                rel = f.relative_to(root).as_posix()
                key = f"{src}/{rel}"
                ed = edits.get(key, {})
                items.append({
                    "key": key, "source": src, "rel": rel,
                    "name": f.name, "stem": f.stem,
                    "group": rel.rsplit("/", 1)[0] if "/" in rel else "",
                    "size": f.stat().st_size,
                    "url": f"/media/{src}/{urllib.parse.quote(rel)}",
                    "edited": bool(ed) and any(
                        ed.get(k) for k in led.RENDER_KEYS),
                    # 源清单里混着本工具自己的成品(project 源根目录**包含**导出目录),
                    # 不标出来的话「来料出处」会出现自指的环
                    "product": is_product_file(f),
                })
        return {"items": items, "sources": list(SOURCES)}

    def do_assign(self) -> dict:
        """给 key 分配/取消分配一份料。key 必须来自实时扫描的清单,不接受手写。"""
        req = json.loads(self._body().decode("utf-8") or "{}")
        key = str(req.get("key") or "")
        source_key = req.get("sourceKey")
        assignments = led.load_assignments(ASSIGNMENTS)

        if not key:
            return {"ok": False, "error": "没给 key"}
        if source_key in (None, ""):
            assignments.pop(key, None)
            led.save_assignments(ASSIGNMENTS, assignments)
            return {"ok": True, "assignments": assignments}

        channel, audio_id = split_key(key)
        if channel not in cio.CHANNELS:
            return {"ok": False,
                    "error": f"「{channel}」不是承载文件的频道(只有 "
                             + " / ".join(cio.CHANNELS) + " 是)"}
        try:
            _text, doc, root, _st = read_config()
        except (OSError, json.JSONDecodeError, cio.ConfigIOError) as ex:
            return {"ok": False, "error": f"读不了 audio_config.json: {ex}"}
        if cio.read_entry(doc, channel, audio_id) is None:
            return {"ok": False, "error": f"配置里没有这个 key: {key}"}
        why = cio.key_is_writable(audio_id)
        if why:
            return {"ok": False, "error": why}
        if cio.entry_src_span(root, channel, audio_id) is None:
            return {"ok": False, "error": "这条登记的结构不认识,本工具不敢改它"}
        if source_path(str(source_key)) is None or not source_path(str(source_key)).is_file():
            return {"ok": False, "error": f"找不到这份料: {source_key}"}

        entry = cio.read_entry(doc, channel, audio_id)
        rec = {"sourceKey": str(source_key), "at": time.strftime("%Y-%m-%dT%H:%M:%S")}
        ext = (req.get("ext") or "").lower()
        if ext in AUDIO_EXT:
            rec["ext"] = ext
        else:
            rec["ext"] = derived_ext(entry["src"], channel)
        assignments[key] = rec
        led.save_assignments(ASSIGNMENTS, assignments)
        return {"ok": True, "assignments": assignments}

    def do_import(self) -> dict:
        name = urllib.parse.unquote(self.headers.get("X-Filename") or "")
        name = Path(name).name
        if not name or Path(name).suffix.lower() not in AUDIO_EXT:
            return {"ok": False, "error": f"不支持的文件: {name}"}
        IMPORTED.mkdir(parents=True, exist_ok=True)
        dst = IMPORTED / name
        i = 1
        while dst.exists():
            dst = IMPORTED / f"{Path(name).stem}_{i}{Path(name).suffix}"
            i += 1
        dst.write_bytes(self._body())
        return {"ok": True, "key": f"imported/{dst.name}",
                "url": f"/media/imported/{urllib.parse.quote(dst.name)}"}

    def do_render(self) -> dict:
        req = json.loads(self._body().decode("utf-8"))
        key = req.get("key", "")
        src = source_path(key)
        if not src or not src.exists():
            return {"ok": False, "error": f"找不到源文件: {key}"}
        ed = req.get("edits") or {}
        CACHE.mkdir(parents=True, exist_ok=True)
        # 不能用内置 hash():它是进程级加盐的,重启后同一份参数换个文件名,缓存全废
        tag = hashlib.sha256(
            json.dumps([key, ed], sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()[:16]
        out = CACHE / f"prev_{tag}{src.suffix}"
        ok, err = render(src, ed, out)
        if not ok:
            return {"ok": False, "error": err}
        prune_cache()
        warn = err or None
        return {"ok": True, "url": f"/preview/{out.name}?t={int(time.time())}",
                "duration": ffprobe_duration(out), "warn": warn}


def main() -> None:
    for d in (IMPORTED, CACHE):
        d.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}/"
    print(f"音频加工台: {url}\n源目录: " +
          ", ".join(f"{k}={v}" for k, v in SOURCES.items()) +
          f"\n导出目标: {rel_to_repo(AUDIO_CONFIG)} 的 " +
          " / ".join(cio.CHANNELS) + " 三区已登记 key" +
          "\n(Ctrl+C 停止)")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
