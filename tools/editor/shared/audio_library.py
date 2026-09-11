"""音频目录共享层：条目元数据 / 时长探测 / 引用计数 / 未登记文件扫描。

**为什么单独一层**：音频 id 在编辑器里有一把消费点（playBgm/playSfx/stopSceneAmbient
三个 action 参数、场景 bgm 与 ambientSounds、过场字幕配音 subtitleVoice、
pressure_holds.holdSfx、document_reveals.revealSfx、audio_config.systemSfx 映射）
加上音频配置编辑器本身。
「选之前得先知道」的信息——这条音多长、文件还在不在、有没有人在用——此前一处都没有，
各处各写一份必然漂，所以收进这一层，选择器与配置编辑器共用同一份真相。

时长探测放后台线程：wav 直接读 RIFF 头（无依赖、瞬时），其余交给 ffprobe。
主线程只读缓存，**永不阻塞**；结果到位后发 :attr:`AudioMetaCache.updated` 让 UI 自刷。
探测失败/无 ffprobe 一律返回 ``None`` 显示「—」，绝不猜数字（fail-safe）。
"""
from __future__ import annotations

import json
import re
import struct
import subprocess
import threading
from collections import Counter, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from PySide6.QtCore import QObject, Signal

from ..project_model import ProjectModel
from .project_paths import URL_KIND_MEDIA

#: audio_config 里承载 ``{id: {src, volume?}}`` 的频道（systemSfx 是 id→id 映射，不在此列）。
#:
#: ``voice`` = 对白配音，独立成区（配音会长到近千条，混进 sfx 就没法管）。
#: **加频道必须把下列登记面一次扫齐**——漏一处的表现是"游戏能放但编辑器说 id 无效"：
#:   1. 本常量（驱动音频编辑器页签）
#:   2. ``audio_editor._CHANNEL_LABELS``（页签中文名）
#:   3. ``tools/audio_editor/audio_config_io.CHANNELS``（独立加工台）
#:   4. ``voice_spec_field``（配音选择器查哪个区）
#:   5. ``validator._audio_id_known``（校验认哪个区）
#:   6. 运行时 ``AudioManager.loadConfig`` 的装配白名单
AUDIO_CHANNELS: tuple[str, ...] = ("bgm", "ambient", "sfx", "voice")

#: 配音 id 所在的区。**只有这一个来源,不做回落**——
#: "这里没有就去那里找"会让配置写错在某些路径上表现正常、只在别处露馅。
VOICE_CHANNEL = "voice"

#: 各通道的**出厂音量**（玩家没动过设置时的值），镜像自 ``src/systems/AudioManager.ts``
#: 的 ``bgmVolume`` / ``sfxVolume`` / ``ambientVolume`` / ``voiceVolume`` 字段初值。
#:
#: 试听要按"游戏里实际多响"放，就必须乘上它——否则作者在编辑器里把某条环境音调到
#: 听着刚好，进游戏一听轻了一多半（环境音通道出厂就只有 0.4）。
#:
#: ⚠ 这是一份**跨语言镜像**，漂了不会报错、只会让试听说谎。
#: ``tools/editor/tests/test_audio_site_volume.py`` 直接从 TS 源里抠出那四个初值比对。
CHANNEL_DEFAULT_VOLUME: dict[str, float] = {
    "bgm": 0.6,
    "sfx": 0.8,
    "ambient": 0.4,
    "voice": 1.0,
}


def channel_default_volume(channel: str) -> float:
    """通道出厂音量；未知通道按满档（宁可试听偏响，也不要凭空猜一个衰减）。"""
    return CHANNEL_DEFAULT_VOLUME.get(channel, 1.0)


#: 编辑器认得的音频扩展名（与 audio_editor 的文件选择过滤器同源）。
AUDIO_SUFFIXES: frozenset[str] = frozenset(
    {".wav", ".ogg", ".mp3", ".m4a", ".flac", ".aif", ".aiff"},
)

_FFPROBE_TIMEOUT_S = 6.0


# --------------------------------------------------------------- 条目解析


def channel_dict(model: ProjectModel, channel: str) -> dict:
    """返回 ``audio_config[channel]``；非 dict 一律当空（只读，不改写模型）。"""
    raw = model.audio_config.get(channel)
    return raw if isinstance(raw, dict) else {}


def entry_src(entry: object) -> str:
    """条目取 src。历史上允许裸字符串形态，这里一并认。"""
    if isinstance(entry, dict):
        return str(entry.get("src") or "").strip()
    if isinstance(entry, str):
        return entry.strip()
    return ""


def entry_volume(entry: object) -> float | None:
    """条目取 volume；未设 / 非数值一律 ``None``（区别于 0.0，勿合并）。"""
    if not isinstance(entry, dict):
        return None
    raw = entry.get("volume")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return None
    return float(raw)


def audio_config_src_for_id(model: ProjectModel, channel: str, audio_id: str) -> str:
    """``audio_config[channel][audio_id].src``（缺失返回空串）。"""
    return entry_src(channel_dict(model, channel).get(audio_id))


def src_to_local_file(model: ProjectModel, src: str) -> Path | None:
    """把 ``src`` 解析为**存在的**本地文件；解析不了/不存在返回 ``None``。"""
    if not src or model.project_path is None:
        return None
    path = model.paths.url_to_disk(src, kind=URL_KIND_MEDIA)
    if path is None:
        return None
    try:
        path = path.resolve()
    except OSError:
        return None
    return path if path.is_file() else None


def audio_config_file_for_id(model: ProjectModel, channel: str, audio_id: str) -> Path | None:
    """id → 存在的本地音频文件（id 未登记 / src 空 / 文件被移走都返回 ``None``）。"""
    return src_to_local_file(model, audio_config_src_for_id(model, channel, audio_id))


@dataclass(frozen=True)
class AudioEntryInfo:
    """一条音频登记的只读快照（给表格/选择器直接铺）。"""

    audio_id: str
    channel: str
    src: str
    volume: float | None
    path: Path | None          # 解析成功且文件存在时才非 None
    duration: float | None     # 秒；未探测完或探测失败为 None

    @property
    def missing(self) -> bool:
        """有 src 却找不到文件，或压根没填 src——两种都是「不能播」。"""
        return self.path is None

    @property
    def file_name(self) -> str:
        return self.path.name if self.path is not None else (self.src.rsplit("/", 1)[-1] if self.src else "")


def channel_entries(
    model: ProjectModel,
    channel: str,
    cache: "AudioMetaCache | None" = None,
) -> list[AudioEntryInfo]:
    """按 audio_config 里的**原键序**列出该频道所有条目（不排序，往返靠它）。"""
    out: list[AudioEntryInfo] = []
    for aid, entry in channel_dict(model, channel).items():
        src = entry_src(entry)
        path = src_to_local_file(model, src)
        dur = cache.duration(path) if (cache is not None and path is not None) else None
        out.append(
            AudioEntryInfo(
                audio_id=str(aid),
                channel=channel,
                src=src,
                volume=entry_volume(entry),
                path=path,
                duration=dur,
            ),
        )
    return out


def format_duration(seconds: float | None) -> str:
    """``None`` → ``—``；<60s 给两位小数（音效差 0.1s 都要挑），否则 ``m:ss``。"""
    if seconds is None or seconds < 0:
        return "—"
    if seconds < 60:
        return f"{seconds:.2f}s"
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    return f"{minutes}:{rest:04.1f}"


# --------------------------------------------------------------- 时长探测


def _wav_duration(path: Path) -> float | None:
    """纯 python 解析 RIFF/WAVE 头算时长；任何异常都返回 ``None``（不猜）。"""
    try:
        with path.open("rb") as fh:
            head = fh.read(12)
            if len(head) < 12 or head[:4] != b"RIFF" or head[8:12] != b"WAVE":
                return None
            byte_rate = 0
            while True:
                chunk_head = fh.read(8)
                if len(chunk_head) < 8:
                    return None
                cid, size = struct.unpack("<4sI", chunk_head)
                if cid == b"fmt ":
                    fmt = fh.read(size)
                    if len(fmt) < 16:
                        return None
                    byte_rate = struct.unpack("<I", fmt[8:12])[0]
                elif cid == b"data":
                    if byte_rate <= 0:
                        return None
                    return size / float(byte_rate)
                else:
                    fh.seek(size + (size & 1), 1)
    except (OSError, struct.error, ValueError):
        return None


def _ffprobe_duration(path: Path) -> float | None:
    """交给 ffprobe；没装 ffprobe / 超时 / 输出不是数字一律 ``None``。"""
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=_FFPROBE_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    try:
        value = float((proc.stdout or "").strip())
    except ValueError:
        return None
    return value if value >= 0 else None


def probe_duration(path: Path) -> float | None:
    """同步探测单个文件时长（wav 走头解析，其余走 ffprobe）。"""
    if path.suffix.lower() == ".wav":
        wav = _wav_duration(path)
        if wav is not None:
            return wav
    return _ffprobe_duration(path)


class AudioMetaCache(QObject):
    """进程内时长缓存 + 单后台线程探测。

    契约：
    * :meth:`duration` **永不阻塞**——命中返回秒数，未命中排队并返回 ``None``；
    * 探测完成后合并发一次 :attr:`updated`，UI 收到就重刷可见行；
    * 缓存键含 ``(mtime_ns, size)``，文件被替换后自动重新探测。
    """

    updated = Signal()

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._lock = threading.Lock()
        self._done: dict[tuple[str, int, int], float | None] = {}
        self._queued: set[tuple[str, int, int]] = set()
        self._pending: deque[tuple[tuple[str, int, int], Path]] = deque()
        self._wake = threading.Event()
        self._worker: threading.Thread | None = None
        self._stopped = False
        # 宿主（面板/弹窗）被销毁后，后台线程还可能在跑：往已析构的 QObject 发信号会
        # 抛 RuntimeError（运气差时直接段错误）。用一个**不持有 self** 的共享标志来断路，
        # 这样 destroyed 连接不会把 cache 自己钉在内存里。
        self._alive = [True]
        self.destroyed.connect(
            lambda _obj=None, flag=self._alive: flag.__setitem__(0, False),
        )

    # -- 主线程 API -------------------------------------------------------
    def duration(self, path: Path | None) -> float | None:
        if path is None:
            return None
        key = self._key(path)
        if key is None:
            return None
        with self._lock:
            if key in self._done:
                return self._done[key]
            if key not in self._queued:
                self._queued.add(key)
                self._pending.append((key, path))
                self._ensure_worker()
        self._wake.set()
        return None

    def prefetch(self, paths: Iterable[Path | None]) -> None:
        """批量排队（表格铺行时调一次，别逐格触发线程唤醒）。"""
        for p in paths:
            self.duration(p)

    def stop(self) -> None:
        """进程收尾用；调用后线程自然退出，缓存仍可读。"""
        self._stopped = True
        self._wake.set()

    # -- 内部 -------------------------------------------------------------
    @staticmethod
    def _key(path: Path) -> tuple[str, int, int] | None:
        try:
            st = path.stat()
        except OSError:
            return None
        return (str(path), st.st_mtime_ns, st.st_size)

    def _ensure_worker(self) -> None:
        """调用方必须已持 ``_lock``。"""
        if self._worker is not None and self._worker.is_alive():
            return
        self._worker = threading.Thread(
            target=self._run, name="audio-duration-probe", daemon=True,
        )
        self._worker.start()

    def _run(self) -> None:
        while not self._stopped and self._alive[0]:
            batch: list[tuple[tuple[str, int, int], Path]] = []
            with self._lock:
                while self._pending and len(batch) < 24:
                    batch.append(self._pending.popleft())
            if not batch:
                self._wake.wait(timeout=0.5)
                self._wake.clear()
                with self._lock:
                    if not self._pending:
                        # 队列空且没人再排队：线程退出，下次 duration() 会重开。
                        self._worker = None
                        return
                continue
            results = [(key, probe_duration(path)) for key, path in batch]
            with self._lock:
                for key, value in results:
                    self._done[key] = value
                    self._queued.discard(key)
            self._emit_updated()

    def _emit_updated(self) -> None:
        """只在宿主还活着时发信号；对象已析构就让线程自己收摊（fail-safe，不 fail-open）。"""
        if self._stopped or not self._alive[0]:
            self._stopped = True
            return
        try:
            self.updated.emit()
        except RuntimeError:
            # destroyed 与本次 emit 之间的竞态窗口：宿主刚没，标记停机即可
            self._stopped = True


# --------------------------------------------------- 未登记文件 / 引用计数


def registered_disk_files(model: ProjectModel) -> set[Path]:
    """所有频道 src 已指向的磁盘文件（解析不了的 src 不计）。"""
    out: set[Path] = set()
    for channel in AUDIO_CHANNELS:
        for entry in channel_dict(model, channel).values():
            path = src_to_local_file(model, entry_src(entry))
            if path is not None:
                out.add(path)
    return out


def scan_unregistered_files(model: ProjectModel) -> list[Path]:
    """``runtime/audio`` 下存在、但没有任何 audio_config 条目指向的音频文件。"""
    if model.project_path is None:
        return []
    root = model.paths.runtime_audio_dir
    if not root.is_dir():
        return []
    registered = registered_disk_files(model)
    out: list[Path] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in AUDIO_SUFFIXES:
            continue
        try:
            resolved = path.resolve()
        except OSError:
            continue
        if resolved not in registered:
            out.append(resolved)
    return out


#: id 里不许出现的字符：空白（首尾会被各处 ``.strip()`` 吃掉、中间的在表格里看不见）、
#: ``"`` 与 ``\`` （打断 :func:`build_reference_counts` 的字符串取词，引用数直接失真）、
#: ``/`` （id 长得像路径，跟 ``src`` 混淆）、控制字符。
#: **其余一律保留——中文是这个项目 id 的常态**，见 :func:`suggest_audio_id`。
_ID_BAD_CHAR_RE = re.compile(r'[\s"\\/\x00-\x1f]')


def sanitize_audio_id(raw: str) -> str:
    """把任意串清成合法 audio id：只换掉会出事的字符，中文与大小写原样保留。"""
    return _ID_BAD_CHAR_RE.sub("_", str(raw or "")).strip("_")


def audio_id_problem(raw: str) -> str | None:
    """这个 id 哪里不合法；合法返回 ``None``。

    编辑器录入面与 validator 共用同一条口径——两边分别写判据必然漂成
    "编辑器让存、校验器报错"。
    """
    s = str(raw or "")
    if not s.strip():
        return "id 不能为空"
    if s != s.strip():
        return "id 首尾不能有空白（各处读 id 都会 strip，存进去就对不上了）"
    bad = sorted({c for c in s if _ID_BAD_CHAR_RE.match(c)})
    if bad:
        shown = "、".join(repr(c) for c in bad)
        return f"id 不能含 {shown}（会打断引用扫描或被当成路径）"
    return None


def suggest_audio_id(path: Path, taken: Iterable[str]) -> str:
    """由文件名推 id：**直接用文件名**（同一目录下文件名本就唯一，天然是个好 id）。

    不加频道前缀、不转小写、不动中文。旧版把非 ASCII 全抹成 ``_`` 再 strip，
    于是 ``茶馆开场_瞎子李_1.wav`` 建议出来的 id 是 ``1``、``说书9.wav`` 是 ``9``
    ——那套白名单是给早年全英文 sfx 文件名写的，项目 id 全中文之后纯属作对。

    撞名时先拿父目录名兜（配音按场次分文件夹，``说书重庆话/1.wav`` → ``说书重庆话_1``
    比 ``1_2`` 认得出），仍撞才补数字后缀。
    """
    used = set(taken)
    base = sanitize_audio_id(path.stem) or "audio"
    if base not in used:
        return base
    parent = sanitize_audio_id(path.parent.name)
    if parent:
        withdir = f"{parent}_{base}"
        if withdir not in used:
            return withdir
    n = 2
    while f"{base}_{n}" in used:
        n += 1
    return f"{base}_{n}"


_STRING_TOKEN_RE = re.compile(r'"((?:[^"\\]|\\.)*)"')
_TS_STRING_RE = re.compile(r"""'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\\n$]*)`""")


def build_reference_counts(model: ProjectModel) -> dict[str, int]:
    """统计每个字符串在内容 JSON（当值）+ 运行时 TS 源码里出现的次数。

    **为什么连 TS 一起扫**：有的音频 id 是代码里写死的常量（例如
    `OBJECT_EXAMINE_FLY_BUZZ_AMBIENT_ID = 'fly_buzz'`），只扫 JSON 会把它报成
    「0 引用」——那是最危险的假零：看着没人用，删了就静音。

    这是**文本级**统计，不是语义级：够用来回答「删掉这条会不会伤到人」，
    不该拿来当权威引用图（权威在 json_lang LSP 的「查引用」）。
    只看磁盘文件，编辑器里未保存的改动不计——调用方需在文案里说清。
    """
    if model.project_path is None:
        return {}
    paths = model.paths
    skip = {(paths.data_dir / "audio_config.json").resolve()}
    counter: Counter[str] = Counter()
    for root in (paths.data_dir, paths.scenes_dir, paths.dialogues_dir):
        if not root.is_dir():
            continue
        for file in root.rglob("*.json"):
            try:
                if file.resolve() in skip:
                    continue
                text = file.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            counter.update(_iter_json_string_values(text))
    src_root = model.project_path / "src"
    if src_root.is_dir():
        for pattern in ("*.ts", "*.tsx"):
            for file in src_root.rglob(pattern):
                try:
                    text = file.read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    continue
                counter.update(
                    next(g for g in match.groups() if g is not None)
                    for match in _TS_STRING_RE.finditer(text)
                )
    return dict(counter)


def _iter_json_string_values(text: str) -> Iterable[str]:
    """从 JSON 文本里取所有**值**位置的字符串（跳过键，避免把键名算成引用）。"""
    for match in _STRING_TOKEN_RE.finditer(text):
        tail = text[match.end():match.end() + 4].lstrip()
        if tail.startswith(":"):
            continue  # 是键，不是值
        raw = match.group(1)
        if "\\" in raw:
            try:
                raw = json.loads(f'"{raw}"')
            except ValueError:
                continue
        yield raw
