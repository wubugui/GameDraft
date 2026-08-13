# -*- coding: utf-8 -*-
"""导出台账 —— 「哪个 key 现在挂的是什么内容、什么时候挂上去的、料从哪来」。

## 两层身份(整个工具的地基,别混)

1. **加工指纹** ``fingerprint`` = hash(源文件字节) + 规范化编辑参数 + 输出格式规格。
   回答的是「这套料、这套参数,我以前加工出来的东西是哪一份」。它是**缓存键**,
   命中就不必再跑一遍 ffmpeg。
2. **成品字节 hash** ``contentHash`` = 落在项目里那个文件本身的 sha256。
   回答的是「磁盘上这份东西是什么内容」,也是「多个 key 共用同一个路径」的唯一判据。

项目里那份**永远是成品,不是料** —— 源文件字节与成品字节结构性地对不上
(ffmpeg 会把自己的版本戳 ``Lavf62.x`` 和源文件的元数据一起烘进去)。所以两层 hash
分别存在不同的字典、不同的字段名下,任何比较都必须显式写明比的是哪一层;
本模块里绝不出现 ``if h in ledger`` 这种不指明命名空间的判断。

## 为什么指纹里不含 ffmpeg 版本

实测:同机同版本连渲两次字节完全一致(wav / mp3 都一致),所以指纹当缓存可行;
但 ffmpeg 一升级,同源同参数渲出来的字节必变(版本串被烘进 LIST/INFO 与 ID3),
听感却一模一样。把版本放进指纹 = 升级当天全部 key 一起跳「待更新」、全量重渲换来
零听感变化,直接违反「重复导出必须廉价且幂等」。
所以:指纹是缓存键,可以宽;contentHash 是物理身份,必须准。ffmpeg 版本只作为
出处证据记进 ``origin.ffmpeg``,另留「强制重渲」逃生门。
"""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
from pathlib import Path
from typing import Any

LEDGER_VERSION = 1

#: 加工算法版本。滤镜链顺序、mp3 码率常量、格式规格的算法**任何一处**变了都要 +1,
#: 否则旧指纹会假命中一个用旧算法渲出来的成品(听起来对、其实不是这次要的东西)。
FINGERPRINT_ALGO = 1

#: 进指纹的编辑参数 —— 只有这几项会改变输出字节。
#: fadePref / normPeakDb 是界面记忆值(用户收窄选区时用来还原),不影响渲染,不进。
RENDER_KEYS: tuple[str, ...] = ("trim", "fadeIn", "fadeOut", "gainDb", "reverse", "normalize")

MP3_BITRATE = "192k"


# --------------------------------------------------------------- hash


def sha256_file(path: Path) -> str | None:
    """文件内容的 sha256(全 64 位十六进制)。读不了一律 None,绝不猜。"""
    try:
        h = hashlib.sha256()
        with path.open("rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


class HashCache:
    """按 ``(路径, mtime_ns, 大小)`` 缓存文件 hash。

    全量 hash 项目里 240 个音频(255MB)实测只要 273ms,所以状态一律**由磁盘反算**,
    台账只是缓存。缓存键带 mtime+size:文件被换掉会自动重算,不会拿旧 hash 骗人。
    """

    def __init__(self) -> None:
        self._done: dict[tuple[str, int, int], str | None] = {}

    def get(self, path: Path) -> str | None:
        try:
            st = path.stat()
        except OSError:
            return None
        key = (str(path), st.st_mtime_ns, st.st_size)
        if key not in self._done:
            self._done[key] = sha256_file(path)
        return self._done[key]


# --------------------------------------------------------------- 指纹


def _q(value: Any, digits: int) -> float | None:
    """量化到 ffmpeg 命令里实际用的精度,并把 falsy 折叠成 None。

    后端拼命令时 trim/fade 用 ``:.4f``、gain 用 ``:.2f``,所以比这更细的差别根本
    到不了 ffmpeg —— 不折叠的话同一份成品会挂上好几个不同指纹,缓存全废。
    0 / 缺失 / False / None 在 build_filter 里完全等价,一律折叠成 None(=不出现)。
    """
    if value is None or value is False:
        return None
    try:
        num = round(float(value), digits)
    except (TypeError, ValueError):
        return None
    return None if num == 0 else num


def normalized_render_params(edits: dict | None) -> dict:
    """把 edits.json 里那条编辑参数规范化成「决定输出字节的最小集合」。

    刻意存**原始参数**而不是 build_filter 算出来的生效参数:生效值依赖源文件时长,
    存进去等于把源信息重复编码一遍,还容易和真实渲染错位。
    """
    ed = edits or {}
    out: dict[str, Any] = {}

    trim = ed.get("trim")
    if isinstance(trim, dict):
        start = _q(trim.get("start"), 4)
        end = _q(trim.get("end"), 4)
        # 注意 start=0 会被折叠掉,这没问题:end 在就说明有裁剪
        if start is not None or end is not None:
            out["trim"] = {"start": start or 0.0, "end": end}

    for k in ("fadeIn", "fadeOut"):
        v = _q(ed.get(k), 4)
        if v is not None:
            out[k] = v

    gain = _q(ed.get("gainDb"), 2)
    if gain is not None:
        out["gainDb"] = gain

    if ed.get("reverse"):
        out["reverse"] = True

    norm = ed.get("normalize")
    if isinstance(norm, dict) and norm.get("enabled"):
        # 只有开着的时候 peakDb 才影响输出;关着时它只是界面记忆值
        peak = norm.get("peakDb", -3)
        try:
            peak = round(float(peak), 2)
        except (TypeError, ValueError):
            peak = -3.0
        out["normalize"] = {"peakDb": peak}

    return out


def output_spec(ext: str) -> dict:
    """输出格式规格。**必须进指纹** —— 实测同源同参数只换扩展名就是两份不同字节。

    推论:跨格式的 key 共用不成立。同一份料出 .wav 和出 .mp3 是两个 contentHash、
    两条 files 记录,只有同格式的 key 之间才谈得上共用同一个路径。
    """
    ext = (ext or "").lower()
    spec: dict[str, Any] = {"ext": ext}
    if ext == ".mp3":
        spec["bitrate"] = MP3_BITRATE
    return spec


def make_fingerprint(source_hash: str, params: dict, spec: dict) -> str:
    """加工指纹。绝不能用 python 内置 ``hash()`` —— 它是进程级加盐的,重启即全废
    (旧代码在预览缓存文件名上就踩过:``abs(hash((key, json)))``)。"""
    payload = {
        "algo": FINGERPRINT_ALGO,
        "source": source_hash,
        "params": params,
        "out": spec,
    }
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False,
                      separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


# --------------------------------------------------------------- 台账读写


def _now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def empty_ledger() -> dict:
    return {"version": LEDGER_VERSION, "files": {}, "keys": {}, "fingerprints": {}}


def load_ledger(path: Path) -> dict:
    """读台账。坏了/缺了一律退回空台账 —— 台账只是缓存,磁盘才是真值,
    读不出来最多是多渲一次,绝不能因此拦住用户干活。"""
    if not path.exists():
        return empty_ledger()
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty_ledger()
    if not isinstance(doc, dict):
        return empty_ledger()
    base = empty_ledger()
    # 逐条过滤,不是整份放行:只校验到「这两层是 dict」的话,一条类型坏掉的记录
    # (手改过、旧版本写的、别的工具塞的)会在读它的地方抛异常,把整个 /api/keys
    # 打成 500 —— 台账只是缓存,坏了最多多渲一次,绝不该拦住用户干活。
    for k in ("files", "keys"):
        raw = doc.get(k)
        if isinstance(raw, dict):
            base[k] = {kk: vv for kk, vv in raw.items()
                       if isinstance(kk, str) and isinstance(vv, dict)}
    raw_fp = doc.get("fingerprints")
    if isinstance(raw_fp, dict):
        base["fingerprints"] = {kk: vv for kk, vv in raw_fp.items()
                                if isinstance(kk, str) and isinstance(vv, str)}
    base["version"] = doc.get("version", LEDGER_VERSION)
    return base


def save_ledger(path: Path, ledger: dict) -> None:
    ledger["version"] = LEDGER_VERSION
    _atomic_write_json(path, ledger)


def load_assignments(path: Path) -> dict:
    """本次会话的分配:``{"<channel>/<id>": {"sourceKey":..., "at":..., "ext":...}}``。

    刻意与台账分开存:台账是要进 git、要能 review diff 的账本,分配是会话工作态,
    改得飞快。混在一起会让台账的 diff 全是噪音。
    """
    if not path.exists():
        return {}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return doc if isinstance(doc, dict) else {}


def save_assignments(path: Path, data: dict) -> None:
    _atomic_write_json(path, data)


def _atomic_write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=1)
            fh.write("\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


# --------------------------------------------------------------- 台账操作


def record_file(ledger: dict, content_hash: str, *, src: str, size: int,
                origin: dict | None, duration: float | None = None) -> dict:
    """登记一份**成品文件**(按内容 hash 索引)。已存在则补齐缺的字段,不覆盖出处。

    ``origin=None`` 表示「来源未知」:存量回填、别的工具放的、人手工塞的都算。
    绝不许因为文件名像某个源文件就去反推出处 —— 名字一律不参与任何判定。
    """
    rec = ledger["files"].get(content_hash)
    if rec is None:
        rec = {"src": src, "bytes": size, "firstSeen": _now(), "origin": origin}
        if duration is not None:
            rec["duration"] = round(duration, 3)
        ledger["files"][content_hash] = rec
        return rec
    # 已有记录:src 以先到的为准(多 key 共用时大家指的就是这一个路径)
    if origin is not None and rec.get("origin") is None:
        rec["origin"] = origin
    if duration is not None and "duration" not in rec:
        rec["duration"] = round(duration, 3)
    return rec


def record_key_export(ledger: dict, key: str, *, content_hash: str, src: str,
                      inferred: bool = False, at: str | None = None) -> None:
    """记一次「这个 key 现在挂的是这份内容」。

    ``inferred=True`` 用于存量回填 —— 时间是从文件 mtime 推断的,不是真的导出时刻,
    界面上必须如实标注,不能假装知道。
    """
    ledger["keys"][key] = {
        "hash": content_hash,
        "src": src,
        "exportedAt": at or _now(),
        **({"inferred": True} if inferred else {}),
    }


def remember_fingerprint(ledger: dict, fingerprint: str, content_hash: str) -> None:
    ledger["fingerprints"][fingerprint] = content_hash


def lookup_fingerprint(ledger: dict, fingerprint: str, resolve: Any) -> str | None:
    """指纹 -> 成品 hash,但**必须核对那份成品现在还在、内容还对**才算命中。

    ``resolve(content_hash) -> (磁盘路径|None, 当前hash|None)``。
    对不上一律当未命中(退回重渲染),绝不 fail-open 拿一个已经不存在的路径去写配置。
    """
    ch = ledger["fingerprints"].get(fingerprint)
    if not ch:
        return None
    path, cur = resolve(ch)
    if path is None or cur != ch:
        return None
    return ch


# --------------------------------------------------------------- 状态

#: key 的状态。**一律由磁盘真值反算**,不信台账自称。
STATUS_UNLINKED = "unlinked"     # src 为空 —— 还没接任何文件
STATUS_MISSING = "missing"       # src 有,但磁盘上找不到那个文件
STATUS_EXPORTED = "exported"     # 磁盘内容 == 台账记的、且这份内容是本工具产出的
STATUS_FOREIGN = "foreign"       # 磁盘有文件,但这份内容不是本工具产出的(含存量回填)
STATUS_DRIFTED = "drifted"       # 台账记过,但磁盘上的内容已经不是那一份了


def derive_status(ledger: dict, key: str, *, src: str, disk_hash: str | None) -> str:
    """六态里的五个静态态(第六个「本次待导出」是叠加标记,不在这里)。"""
    if not src:
        return STATUS_UNLINKED
    if disk_hash is None:
        return STATUS_MISSING
    recorded = (ledger["keys"].get(key) or {}).get("hash")
    if recorded and recorded != disk_hash:
        return STATUS_DRIFTED
    origin = (ledger["files"].get(disk_hash) or {}).get("origin")
    if recorded == disk_hash and origin is not None:
        return STATUS_EXPORTED
    return STATUS_FOREIGN
