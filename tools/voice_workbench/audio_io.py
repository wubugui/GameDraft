"""音频读写:磁盘 ↔ float64 声道矩阵。薄薄一层,重活交给 libsndfile。

**为什么不用 ffmpeg**:处理链要在没装 ffmpeg 的机器上照跑(策划机、CI)。
`soundfile` 的 wheel 自带 libsndfile,pip 装完即用,还顺手支持 FLAC/AIFF/OGG——
比 ffmpeg 子进程既快又不用解析 stderr。

**为什么仍拒 m4a/mp3**:libsndfile 不认 AAC,而手机默认就录这两个。与其在渲染阶段
炸掉,不如在导入口说清"请录 WAV"——录音要求里已经写死这条。

样本一律 **float64、[-1,1]、形状 (帧数, 声道数)**:整条链只认这一种形态,
位深/字节序差异在这层吃掉。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

#: 本工作台能读的扩展名 = libsndfile 能解的那些(实测 1.2.2 含 MP3)。
#: **不按"有损/无损"划线**:损失在录音那一刻就发生了,拒收挽回不了任何东西,
#: 只会把"手上只有一条有损录音"的人挡在工具外面。该做的是**如实标记**,见 LOSSY_EXT。
SUPPORTED_EXT = (".wav", ".flac", ".aiff", ".aif", ".caf", ".ogg", ".mp3")

#: 有损来源:能收,但要在库里标出来。已经掉的信息补不回来,
#: 降噪/归一化都会把编码噪声一起放大,所以"这条素材先天差一截"必须是可见的。
LOSSY_EXT = (".mp3", ".ogg")

#: libsndfile 真的解不了的(AAC 系,专利历史遗留)。**不是"我们不收",是"解不开"**——
#: 报错必须给出路,不能只说"请重录"。
UNDECODABLE_EXT = (".m4a", ".aac", ".mp4", ".amr", ".wma", ".opus")

#: 解不了时给的可执行出路(按对普通人的可操作性排序)
_CONVERT_HINT = (
    "可以这样转成 wav 再导入：\n"
    "  · Windows：右键 → 用「音乐/媒体」类工具另存为 WAV；或装 ffmpeg 后\n"
    "    ffmpeg -i 输入.m4a -c:a pcm_s16le -ar 48000 输出.wav\n"
    "  · Mac：用「音乐」或 QuickTime 导出，或同样用 ffmpeg\n"
    "转出来的 wav 仍是有损来源（信息补不回来），但至少能进工作台处理。\n"
    "下次录音请直接选 WAV，避免这一步。"
)

#: 导出默认位深。16bit 对配音足够(动态 96 dB),文件小一半
DEFAULT_EXPORT_BITS = 16

_SUBTYPE_BY_BITS = {16: "PCM_16", 24: "PCM_24", 32: "PCM_32", 8: "PCM_U8"}


class AudioIOError(ValueError):
    """读写失败:必须让调用方看见原因,不许静默返回空音频。"""


@dataclass(frozen=True)
class Audio:
    """一段音频:``samples`` 形状 (帧数, 声道数),float64,[-1, 1]。"""

    samples: np.ndarray
    rate: int
    #: 源位深(导出时默认沿用;非 PCM 源为 None)
    source_bits: int | None = 16

    @property
    def frames(self) -> int:
        return int(self.samples.shape[0])

    @property
    def channels(self) -> int:
        return int(self.samples.shape[1])

    @property
    def seconds(self) -> float:
        return self.frames / self.rate if self.rate else 0.0

    def slice_seconds(self, start: float, end: float) -> "Audio":
        """按秒切一段(端点钳制到有效范围)。"""
        a = max(0, int(round(start * self.rate)))
        b = max(a, min(self.frames, int(round(end * self.rate))))
        return Audio(self.samples[a:b].copy(), self.rate, self.source_bits)

    def to_mono(self) -> "Audio":
        if self.channels == 1:
            return self
        return Audio(self.samples.mean(axis=1, keepdims=True), self.rate, self.source_bits)

    def with_samples(self, samples: np.ndarray) -> "Audio":
        return Audio(np.atleast_2d(samples), self.rate, self.source_bits)


def _bits_of(info: "sf._SoundFileInfo | sf.SoundFile") -> int | None:
    sub = str(getattr(info, "subtype", "") or "")
    for bits, name in _SUBTYPE_BY_BITS.items():
        if sub == name:
            return bits
    if sub == "PCM_S8":
        return 8
    return None                      # FLOAT/VORBIS 等:导出时回落到默认位深


def is_lossy(path: str | Path) -> bool:
    return Path(path).suffix.lower() in LOSSY_EXT


def read(path: str | Path) -> Audio:
    p = Path(path)
    ext = p.suffix.lower()
    if ext in UNDECODABLE_EXT:
        raise AudioIOError(
            f"{p.name} 是 {ext}（AAC 系），本工作台用的 libsndfile 解不开这类编码。\n"
            f"{_CONVERT_HINT}"
        )
    if ext not in SUPPORTED_EXT:
        raise AudioIOError(f"{p.name} 不是本工作台认得的音频（收 {'/'.join(SUPPORTED_EXT)}）")
    try:
        data, rate = sf.read(str(p), dtype="float64", always_2d=True)
        bits = _bits_of(sf.info(str(p)))
    except (RuntimeError, sf.LibsndfileError, OSError) as ex:
        raise AudioIOError(f"读不了 {p.name}：{ex}") from ex
    if rate <= 0:
        raise AudioIOError(f"{p.name} 的采样率非法（{rate}）")
    return Audio(np.asarray(data, dtype=np.float64), int(rate), bits)


def write(
    path: str | Path, audio: Audio, bits: int | None = None, fmt: str = "WAV",
) -> Path:
    """写音频。父目录自动建;位深缺省沿用源位深。

    ``fmt`` **显式传**而不是让 libsndfile 从扩展名猜:写盘走"临时文件 + 就位",
    临时名是 ``xxx.wav.tmp``,猜扩展名会直接抛 TypeError。

    **写前先钳制到 [-1,1]**:超幅样本交给 libsndfile 会绕回成反相的大负值,
    听感是"咔"的一声爆音——归一化守着真峰上限,但手动增益可以把人推过去。
    """
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    out_bits = int(bits or audio.source_bits or DEFAULT_EXPORT_BITS)
    subtype = _SUBTYPE_BY_BITS.get(out_bits, _SUBTYPE_BY_BITS[DEFAULT_EXPORT_BITS])
    data = np.clip(audio.samples, -1.0, 1.0)
    try:
        sf.write(str(p), data, audio.rate, subtype=subtype, format=fmt)
    except (RuntimeError, sf.LibsndfileError, OSError, TypeError) as ex:
        raise AudioIOError(f"写不了 {p.name}：{ex}") from ex
    return p


def probe(path: str | Path) -> dict:
    """只读文件头,不解全部样本——列表页扫几百条时不该把音频全读进内存。"""
    p = Path(path)
    try:
        info = sf.info(str(p))
    except (RuntimeError, sf.LibsndfileError, OSError) as ex:
        raise AudioIOError(f"读不了 {p.name} 的文件头：{ex}") from ex
    return {
        "channels": int(info.channels),
        "rate": int(info.samplerate),
        "frames": int(info.frames),
        "seconds": float(info.duration),
        "bits": _bits_of(info),
        "format": f"{info.format}/{info.subtype}",
    }
