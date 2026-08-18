"""产物记账与状态引擎:哪条切片、用什么参数、导出成了盘上哪个文件。

## 为什么必须有这一层

导出目录里的 wav 不会自己说"我是谁、用什么参数渲的"。没有这份记账,
"这条导过没有 / 导出的还是不是当前参数的结果"就只能靠人脑记——
于是每导一批都要重新一条条打钩,隔一段时间再导第二批就只能从头再勾一遍。

**状态是算出来的,不是手工维护的。** 界面上没有任何一个复选框表示"已导出":
那种复选框第一天就会和现实脱节。

## 判据只认 sha,不认 mtime

任何一次拷贝、还原、换机、解压都会刷新 mtime。``(大小, mtime)`` 只作**缓存加速**:
对得上就信记账里的 sha;对不上就重算,重算后 sha 相同则**只刷缓存、状态不动**。

## 源读不到就说读不到

源库在 ``resources/audio_sources/``,不进版本控制。换台机器打开工程时源可能根本不在,
那时**算不出**当前指纹——状态是「源不在本机 · 无法判断」,不是「已过时」。
fail-safe 不 fail-open:读不到就如实说读不到,绝不拿"大概没变"糊过去。

## 为什么不塞进工程 json

工程 json 是**人编辑的意图**,记账是**机器写的事实**。混在一起,每次导出都会让
``ui.is_dirty()``(按内容比对)翻脏,于是"什么都没干关闭却弹保存"——编辑器规范的红线。
记账放工程旁边的 ``<工程名>.export.json``:不进 ``public``(那里的东西会被打进游戏包),
又能跟着工程走(导出目录随时可改,记账跟着工程才连续)。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from tools.atomic_io import retry_transient

from . import dsp
from .library import SourceLibrary, sha256_of
from .project import Project, Settings, Slice

LEDGER_VERSION = 1

#: 产物扩展名。渲染管线只写 wav(见 render.export_project)
OUT_EXT = ".wav"


# --------------------------------------------------------------------- 状态

STATE_CURRENT = "current"
STATE_STALE = "stale"
STATE_NEVER = "never"
STATE_MISSING = "missing"
STATE_MODIFIED = "modified"
STATE_FOREIGN = "foreign"
STATE_NO_SOURCE = "no_source"
STATE_INVALID = "invalid"
STATE_EXCLUDED = "excluded"

#: 界面上显示的短标签(表格一列只有几个字的宽度)
STATE_LABELS = {
    STATE_CURRENT: "最新",
    STATE_STALE: "已过时",
    STATE_NEVER: "未导出",
    STATE_MISSING: "产物丢了",
    STATE_MODIFIED: "被改过",
    STATE_FOREIGN: "来历不明",
    STATE_NO_SOURCE: "源不在",
    STATE_INVALID: "不可导",
    STATE_EXCLUDED: "不产",
}

#: 状态色(浅色主题下都能看清;不靠颜色单独承载信息,文字自己已经说清了)
STATE_COLORS = {
    STATE_CURRENT: "#2f9e44",
    STATE_STALE: "#e8590c",
    STATE_NEVER: "#1971c2",
    STATE_MISSING: "#c92a2a",
    STATE_MODIFIED: "#9c36b5",
    STATE_FOREIGN: "#868e96",
    STATE_NO_SOURCE: "#868e96",
    STATE_INVALID: "#c92a2a",
    STATE_EXCLUDED: "#adb5bd",
}

#: "需要更新"= 按一下导出就该被写出来的那些。
#: **不含 FOREIGN**:盘上那个同名文件不是本工程的记账产物,覆盖它得由人点头。
NEEDS_EXPORT = (STATE_NEVER, STATE_STALE, STATE_MISSING, STATE_MODIFIED)


@dataclass
class SliceStatus:
    """一条切片此刻的产物状态。``reason`` 是给人看的一行话,不是给代码判断用的。"""

    state: str
    reason: str = ""
    #: 按当前产物名算出来的目标文件(不代表它存在)
    dest: Path | None = None
    #: 记账里那个、但已经不是当前目标的旧产物(改过名/换过导出目录才有)
    orphan: Path | None = None

    @property
    def label(self) -> str:
        return STATE_LABELS.get(self.state, self.state)

    @property
    def color(self) -> str:
        return STATE_COLORS.get(self.state, "#868e96")

    @property
    def needs_export(self) -> bool:
        return self.state in NEEDS_EXPORT


# ----------------------------------------------------------------- 渲染指纹

#: 指纹分项 → 人话。顺序即"过时原因"的展示优先级(先说最要命的)
_KEY_LABELS = {
    "pipeline": "处理管线升级了",
    "source": "换了源文件",
    "source_sha": "源被换过",
    "start": "切点变了",
    "end": "切点变了",
    "gain_db": "增益变了",
    "fade_in_s": "淡入淡出变了",
    "fade_out_s": "淡入淡出变了",
    "denoise": "降噪开关变了",
    "denoise_db": "降噪量变了",
    "noise": "底噪样本变了",
    "target_lufs": "响度目标变了",
    "ceiling_db": "真峰上限变了",
    "limiter": "限幅开关变了",
    "bits": "位深变了",
    "mono": "单声道设置变了",
}


def render_key(settings: Settings, sl: Slice, source_sha: str) -> dict:
    """这条切片的渲染指纹:**只装会改变输出字节的东西**。

    不装 ``name`` / ``note`` / ``tags`` / ``enabled`` / 自动切分参数——
    改名字或打个标签就让一批产物变"过时",那是在制造假警报。

    降噪相关的分项**只在真的会降噪时才进指纹**(``denoise`` 且降噪量 > 0):
    否则关掉降噪的条目会因为别人调了降噪量而假过时。
    """
    denoising = bool(sl.denoise) and float(settings.denoise_reduction_db) > 0
    key = {
        "pipeline": dsp.PIPELINE_VERSION,
        "source": str(sl.source),
        "source_sha": str(source_sha or "")[:16],
        "start": round(float(sl.start), 3),
        "end": round(float(sl.end), 3),
        "gain_db": round(float(sl.gain_db), 3),
        "fade_in_s": round(float(sl.fade_in_s), 4),
        "fade_out_s": round(float(sl.fade_out_s), 4),
        "denoise": denoising,
        "target_lufs": round(float(settings.target_lufs), 3),
        "ceiling_db": round(float(settings.true_peak_ceiling_db), 3),
        "limiter": bool(settings.limiter),
        "bits": int(settings.export_bits),
        "mono": bool(settings.export_mono),
    }
    if denoising:
        key["denoise_db"] = round(float(settings.denoise_reduction_db), 3)
        key["noise"] = (
            [
                str(settings.noise_source),
                round(float(settings.noise_start), 3),
                round(float(settings.noise_end), 3),
            ]
            if settings.has_noise_sample
            else None
        )
    return key


def describe_key_change(old: object, new: dict) -> str:
    """两份指纹的差异 → 一行人话。只说前两条,再多就是让人读 diff 了。"""
    if not isinstance(old, dict):
        return "记账里没留下当时的参数"
    names: list[str] = []
    for field_name in _KEY_LABELS:
        if old.get(field_name) != new.get(field_name):
            label = _KEY_LABELS[field_name]
            if label not in names:
                names.append(label)
    extra = [k for k in sorted(set(old) | set(new)) if k not in _KEY_LABELS and old.get(k) != new.get(k)]
    names.extend(extra)
    if not names:
        return "参数有变化"
    return "、".join(names[:2]) + ("…" if len(names) > 2 else "")


# ------------------------------------------------------------------- 记账

@dataclass
class Record:
    """一条已经落过盘的产物。``out_dir`` 存的是**当时的导出目录设置原文**
    (可能是相对仓库根的),不存绝对路径——绝对路径换台机器就没意义了。"""

    slice_id: str
    name: str
    out_dir: str
    out_name: str
    key: dict = field(default_factory=dict)
    out_sha256: str = ""
    out_bytes: int = 0
    out_mtime_ns: int = 0
    exported_at: str = ""

    def to_json(self) -> dict:
        return {
            "slice_id": self.slice_id,
            "name": self.name,
            "out_dir": self.out_dir,
            "out_name": self.out_name,
            "key": self.key,
            "out_sha256": self.out_sha256,
            "out_bytes": self.out_bytes,
            # mtime 只是缓存键,存成字符串免得超出 JSON 数字精度
            "out_mtime_ns": str(self.out_mtime_ns),
            "exported_at": self.exported_at,
        }

    @staticmethod
    def from_json(d: dict) -> "Record":
        try:
            mtime = int(d.get("out_mtime_ns") or 0)
        except (TypeError, ValueError):
            mtime = 0
        return Record(
            slice_id=str(d.get("slice_id") or ""),
            name=str(d.get("name") or ""),
            out_dir=str(d.get("out_dir") or ""),
            out_name=str(d.get("out_name") or ""),
            key=d.get("key") if isinstance(d.get("key"), dict) else {},
            out_sha256=str(d.get("out_sha256") or ""),
            out_bytes=int(d.get("out_bytes") or 0),
            out_mtime_ns=mtime,
            exported_at=str(d.get("exported_at") or ""),
        )


class Ledger:
    """按 slice_id 记账。脏了才写盘(``dirty``),免得每次扫描都动文件。"""

    def __init__(self, items: dict[str, Record] | None = None):
        self._items: dict[str, Record] = dict(items or {})
        self.dirty = False

    def __len__(self) -> int:
        return len(self._items)

    def get(self, slice_id: str) -> Record | None:
        return self._items.get(str(slice_id))

    def records(self) -> list[Record]:
        return list(self._items.values())

    def put(self, rec: Record) -> None:
        self._items[rec.slice_id] = rec
        self.dirty = True

    def drop(self, slice_id: str) -> None:
        if self._items.pop(str(slice_id), None) is not None:
            self.dirty = True

    def touch_cache(self, slice_id: str, size: int, mtime_ns: int) -> None:
        """sha 重算后确认没变:只刷缓存键,**不动状态**。"""
        rec = self._items.get(str(slice_id))
        if rec is None:
            return
        if rec.out_bytes != size or rec.out_mtime_ns != mtime_ns:
            rec.out_bytes, rec.out_mtime_ns = size, mtime_ns
            self.dirty = True

    def to_json(self) -> dict:
        return {
            "version": LEDGER_VERSION,
            "items": [r.to_json() for r in sorted(self._items.values(), key=lambda x: x.name)],
        }

    @staticmethod
    def load(path: Path | None) -> "Ledger":
        """读不了就当空记账。**记账坏了不该拦住人干活**——
        最坏的后果是所有条目显示"来历不明",按一次「按现状认账」就回来了。"""
        if path is None:
            return Ledger()
        try:
            raw = json.loads(Path(path).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return Ledger()
        items: dict[str, Record] = {}
        for it in (raw.get("items") if isinstance(raw, dict) else None) or []:
            if isinstance(it, dict) and it.get("slice_id"):
                rec = Record.from_json(it)
                items[rec.slice_id] = rec
        return Ledger(items)

    def save(self, path: Path | None) -> bool:
        """写盘(工程还没存过时 ``path`` 为 None,留在内存里,等工程另存时一起落)。"""
        if path is None:
            return False
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_text(json.dumps(self.to_json(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        retry_transient(os.replace, tmp, p)      # Windows 上就位会瞬时失败,见 atomic-write-windows
        self.dirty = False
        return True


def ledger_path_for(project_path: Path | None) -> Path | None:
    """``<工程>.json`` → ``<工程>.export.json``;工程还没存过则没有路径。"""
    if project_path is None:
        return None
    p = Path(project_path)
    return p.with_name(f"{p.stem}.export.json")


def resolve_out_dir(repo_root: Path, out_dir: str) -> Path:
    """导出目录设置(通常相对仓库根)→ 真实路径。"""
    p = Path(str(out_dir or ""))
    return p if p.is_absolute() else Path(repo_root) / p


# --------------------------------------------------------------- 源指纹缓存

class SourceShaCache:
    """源文件 sha 的内存缓存,按 ``(大小, mtime)`` 失效。

    **不信 ``_library.json`` 里的 sha**:那是"导入当时"的值,正是
    ``SourceLibrary.verify()`` 用来发现"源被覆盖过"的对照物。拿它当现值,
    等于把"源被人换了"这件事静默吃掉,产物却还显示"最新"。
    """

    def __init__(self) -> None:
        self._cache: dict[str, tuple[int, int, str]] = {}

    def clear(self) -> None:
        self._cache.clear()

    def sha_of(self, path: Path) -> str | None:
        """文件不在返回 None(**不猜**)。"""
        p = Path(path)
        try:
            st = p.stat()
        except OSError:
            return None
        hit = self._cache.get(str(p))
        if hit is not None and hit[0] == st.st_size and hit[1] == st.st_mtime_ns:
            return hit[2]
        try:
            digest = sha256_of(p)
        except OSError:
            return None
        self._cache[str(p)] = (st.st_size, st.st_mtime_ns, digest)
        return digest


# ------------------------------------------------------------------- 计算

def _out_sha(dest: Path, rec: Record | None, ledger: Ledger) -> str | None:
    """产物 sha。``(大小, mtime)`` 命中记账缓存就直接用,否则重算并刷缓存。"""
    try:
        st = dest.stat()
    except OSError:
        return None
    if rec is not None and rec.out_sha256 and rec.out_bytes == st.st_size and rec.out_mtime_ns == st.st_mtime_ns:
        return rec.out_sha256
    try:
        digest = sha256_of(dest)
    except OSError:
        return None
    if rec is not None and digest == rec.out_sha256:
        ledger.touch_cache(rec.slice_id, st.st_size, st.st_mtime_ns)
    return digest


def record_path(rec: Record, repo_root: Path, fallback: Path) -> Path:
    """记账里那条产物此刻在哪。导出目录设置换过时,老产物仍在老地方。"""
    if not rec.out_dir:
        return fallback / rec.out_name
    return resolve_out_dir(repo_root, rec.out_dir) / rec.out_name


def _same_file(a: Path, b: Path) -> bool:
    """路径等价判断。**必须归一化**:Windows 上 ``D:/x`` 与 ``D:\\x`` 是同一个地方,
    直接比 Path 对象会把"没改过名"误判成"改过名",于是凭空多出一个孤儿。"""
    try:
        return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))
    except (OSError, ValueError):
        return str(a) == str(b)


def compute_status(
    project: Project,
    sl: Slice,
    lib: SourceLibrary,
    ledger: Ledger,
    out_dir: Path,
    *,
    repo_root: Path,
    sha_cache: SourceShaCache,
) -> SliceStatus:
    """一条切片的产物状态。纯读,不写盘(只可能就地刷新记账里的 sha 缓存键)。"""
    rec = ledger.get(sl.id)
    if not sl.enabled:
        return SliceStatus(STATE_EXCLUDED, "没勾「产」，不参与导出")
    if not sl.source:
        return SliceStatus(STATE_INVALID, "没有指定源文件")
    if sl.seconds <= 0:
        return SliceStatus(STATE_INVALID, f"起止点无效（{sl.start:.2f}s → {sl.end:.2f}s）")

    dest = out_dir / f"{sl.name}{OUT_EXT}"
    old_path = record_path(rec, repo_root, out_dir) if rec is not None else None
    same_target = old_path is not None and _same_file(old_path, dest)
    orphan = old_path if (old_path is not None and not same_target and old_path.is_file()) else None

    src_sha = sha_cache.sha_of(lib.root / sl.source)
    if src_sha is None:
        return SliceStatus(
            STATE_NO_SOURCE,
            f"源不在本机：{sl.source}（源库不进版本控制，换台机器要先把它放回来）",
            dest, orphan,
        )
    key = render_key(project.settings, sl, src_sha)

    if rec is None or not same_target:
        # 这个名字（或这个目录）下本工程还没导过东西
        if dest.is_file():
            return SliceStatus(
                STATE_FOREIGN,
                "导出目录里已有同名文件，但不是本工程记账里的产物（别的工程？手工放的？）",
                dest, orphan,
            )
        return SliceStatus(
            STATE_NEVER,
            "还没导出过" + (f"；改名前的产物还在：{orphan.name}" if orphan else ""),
            dest, orphan,
        )

    if not dest.is_file():
        return SliceStatus(STATE_MISSING, "记账里有，磁盘上没了（被删或被移走）", dest, orphan)
    if rec.key != key:
        return SliceStatus(STATE_STALE, describe_key_change(rec.key, key), dest, orphan)
    got = _out_sha(dest, rec, ledger)
    if got is not None and rec.out_sha256 and got != rec.out_sha256:
        return SliceStatus(STATE_MODIFIED, "产物被本工具以外的东西改过", dest, orphan)
    return SliceStatus(STATE_CURRENT, f"导出于 {rec.exported_at or '未知时间'}", dest, orphan)


def compute_all(
    project: Project,
    lib: SourceLibrary,
    ledger: Ledger,
    out_dir: Path,
    *,
    repo_root: Path,
    sha_cache: SourceShaCache,
) -> dict[str, SliceStatus]:
    return {
        sl.id: compute_status(
            project, sl, lib, ledger, out_dir, repo_root=repo_root, sha_cache=sha_cache,
        )
        for sl in project.slices
    }


# ------------------------------------------------------------------- 写记账

def record_export(
    ledger: Ledger,
    project: Project,
    sl: Slice,
    dest: Path,
    source_sha: str,
    out_dir_setting: str = "",
) -> Record:
    """刚写出一条产物 → 记一笔。sha 现算(文件刚写完,还在页缓存里)。

    ``out_dir_setting`` 是**当时的导出目录设置原文**(通常相对仓库根)。留空表示
    "就是当前那个目录",后续解析时回落到调用方给的目录——批处理/测试里不必关心它。
    """
    st = dest.stat()
    rec = Record(
        slice_id=sl.id,
        name=sl.name,
        out_dir=str(out_dir_setting or ""),
        out_name=dest.name,
        key=render_key(project.settings, sl, source_sha),
        out_sha256=sha256_of(dest),
        out_bytes=st.st_size,
        out_mtime_ns=st.st_mtime_ns,
        exported_at=datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M"),
    )
    ledger.put(rec)
    return rec


def claim_existing(
    project: Project,
    lib: SourceLibrary,
    ledger: Ledger,
    out_dir: Path,
    *,
    repo_root: Path,
    sha_cache: SourceShaCache,
) -> list[str]:
    """把导出目录里已有的同名文件**认作**当前参数的产物,返回认下的产物名。

    只处理「来历不明」——那正是"这套记账上线之前就已经导出去的那一批"。
    **不碰「已过时」**:那些是参数真的变过了,认账等于把变更抹掉。
    """
    claimed: list[str] = []
    for sl in project.slices:
        st = compute_status(
            project, sl, lib, ledger, out_dir, repo_root=repo_root, sha_cache=sha_cache,
        )
        if st.state != STATE_FOREIGN or st.dest is None or not st.dest.is_file():
            continue
        src_sha = sha_cache.sha_of(lib.root / sl.source)
        if src_sha is None:
            continue
        record_export(ledger, project, sl, st.dest, src_sha, project.settings.export_dir)
        claimed.append(sl.name)
    return claimed


def rename_artifact(ledger: Ledger, rec: Record, old_path: Path, new_path: Path) -> None:
    """把已导出的产物连同记账一起改名。**目标已存在时由调用方先拦住**——
    这里用 ``os.replace`` 就位(Windows 上的 ``os.rename`` 遇到同名会抛,
    行为与 POSIX 不一致),它会覆盖,所以"绝不覆盖"这条护栏必须在外面。"""
    new_path.parent.mkdir(parents=True, exist_ok=True)
    retry_transient(os.replace, old_path, new_path)   # 见 atomic-write-windows
    st = new_path.stat()
    rec.out_name = new_path.name
    rec.name = new_path.stem
    rec.out_bytes, rec.out_mtime_ns = st.st_size, st.st_mtime_ns
    ledger.put(rec)
