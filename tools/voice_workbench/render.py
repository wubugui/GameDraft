"""渲染管线:源 → 切 → 降噪 → 淡入淡出 → 手动增益 → 归一化 → 产物。

顺序不是随手排的:

1. **先切再降噪**——降噪要看整段的噪声统计,但切之前整条录音里可能混着不同环境;
   按切片分别降噪,每条各自干净。
2. **归一化放最后**——它测的必须是"最终听到的那段声音"。先归一化再降噪的话,
   降噪削掉能量,响度就又偏了(而且偏多少取决于噪声量,每条还不一样)。
3. **淡入淡出在归一化之前**——淡入淡出改的是首尾几十毫秒,对整段响度影响可忽略,
   但放在归一化之后会让真峰上限的保证失效(理论上不会超,但没必要冒这个险)。

产物写盘走"临时文件 + 就位",与工程存盘同一套原子写(Windows 上就位会瞬时失败)。
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from tools.atomic_io import retry_transient

from . import audio_io as aio
from . import dsp
from .library import SourceLibrary
from .project import Project, Slice


@dataclass
class RenderReport:
    """一条产物的渲染结果。**成败与数字都要留痕**——批量导出后要能一眼看出哪条没对齐。"""

    slice_id: str
    name: str
    ok: bool
    message: str = ""
    seconds: float = 0.0
    measured_lufs: float = float("-inf")
    applied_gain_db: float = 0.0
    out_lufs: float = float("-inf")
    out_true_peak_db: float = float("-inf")
    peak_limited_db: float = 0.0
    limiter_reduction_db: float = 0.0
    limiter_touched_ratio: float = 0.0
    out_path: str = ""
    skipped: bool = False
    #: 因为用户中途取消而没轮到的那些。**与"跳过"分开记**:
    #: "已存在所以跳过"是结果,"你按了取消"是过程,混成一句话会让人以为导完了
    cancelled: bool = False

    @property
    def hit_target(self) -> bool:
        return self.ok and self.peak_limited_db <= 0.05


class SourceCache:
    """按需读源并缓存:一条源常被切几十刀,读几十遍纯属白等。"""

    def __init__(self, lib: SourceLibrary, limit: int = 6):
        self._lib = lib
        self._limit = limit
        self._cache: dict[str, aio.Audio] = {}
        self._order: list[str] = []

    def get(self, rel: str) -> aio.Audio:
        if rel in self._cache:
            self._order.remove(rel)
            self._order.append(rel)
            return self._cache[rel]
        audio = aio.read(self._lib.root / rel)
        self._cache[rel] = audio
        self._order.append(rel)
        while len(self._order) > self._limit:
            self._cache.pop(self._order.pop(0), None)
        return audio

    def clear(self) -> None:
        self._cache.clear()
        self._order.clear()


def noise_sample_for(project: Project, cache: SourceCache) -> np.ndarray | None:
    """工程里标出来的那段纯底噪(没标就返回 None,降噪自己估)。"""
    st = project.settings
    if not st.has_noise_sample:
        return None
    try:
        src = cache.get(st.noise_source)
    except (aio.AudioIOError, OSError):
        return None
    return src.slice_seconds(st.noise_start, st.noise_end).samples


def render_slice(
    project: Project,
    sl: Slice,
    cache: SourceCache,
    *,
    noise: np.ndarray | None = None,
    normalize: bool = True,
) -> tuple[aio.Audio | None, RenderReport]:
    """渲一条。返回 (音频, 报告);失败时音频为 None 且报告里写清原因。"""
    st = project.settings
    rep = RenderReport(slice_id=sl.id, name=sl.name, ok=False)
    if sl.seconds <= 0:
        rep.message = f"起止点无效（{sl.start:.2f}s → {sl.end:.2f}s）"
        return None, rep
    try:
        source = cache.get(sl.source)
    except (aio.AudioIOError, OSError) as ex:
        rep.message = f"读不了源：{ex}"
        return None, rep

    seg = source.slice_seconds(sl.start, sl.end)
    if seg.frames == 0:
        rep.message = "切出来是空的（起止点落在文件范围外？）"
        return None, rep
    x = seg.samples

    if sl.denoise and st.denoise_reduction_db > 0:
        try:
            x = dsp.denoise(x, seg.rate, noise, reduction_db=st.denoise_reduction_db)
        except (ValueError, RuntimeError) as ex:
            rep.message = f"降噪失败（已按不降噪继续）：{ex}"

    x = dsp.fade(x, seg.rate, sl.fade_in_s, sl.fade_out_s)
    if sl.gain_db:
        x = dsp.apply_gain_db(x, sl.gain_db)
    if st.export_mono and x.shape[1] > 1:
        # **只在两声道确实是同一份内容时才转**:两路不同的信号求平均会梳状滤波,
        # 人声发闷发空。转不了就保持立体声并如实说一句,不静默照转。
        if dsp.is_dual_mono(x):
            x = x.mean(axis=1, keepdims=True)
        else:
            _note = "两声道内容不同（真立体声），未转单声道（求平均会梳状滤波）"
            rep.message = f"{rep.message}；{_note}" if rep.message else _note

    if normalize:
        norm = dsp.normalize_lufs(
            x, seg.rate, st.target_lufs, st.true_peak_ceiling_db,
            use_limiter=st.limiter,
        )
        x = norm.samples
        rep.measured_lufs = norm.measured_lufs
        rep.applied_gain_db = norm.applied_gain_db
        rep.out_lufs = norm.out_lufs
        rep.out_true_peak_db = norm.out_true_peak_db
        rep.peak_limited_db = norm.peak_limited_db
        rep.limiter_reduction_db = norm.limiter_reduction_db
        rep.limiter_touched_ratio = norm.limiter_touched_ratio
        if not math.isfinite(norm.measured_lufs):
            rep.message = (rep.message + "；" if rep.message else "") + "这一段没有声音（全静音）"
    else:
        rep.measured_lufs = dsp.loudness_lufs(x, seg.rate)
        rep.out_lufs = rep.measured_lufs
        rep.out_true_peak_db = dsp.true_peak_db(x, seg.rate)

    rep.ok = True
    rep.seconds = x.shape[0] / seg.rate
    return seg.with_samples(x), rep


def export_project(
    project: Project,
    lib: SourceLibrary,
    out_dir: Path,
    *,
    targets: list[Slice] | None = None,
    overwrite: bool = False,
    progress=None,
    ledger=None,
    sha_cache=None,
    out_dir_setting: str = "",
) -> list[RenderReport]:
    """把选定的切片渲染并写盘。返回逐条报告(顺序同传入顺序)。

    - ``targets``:这一批到底导哪些。**由调用方算好再传进来**——
      界面上"要导哪些"是按产物状态查出来的,不是靠人一条条打钩
      (见 ledger 模块开头)。缺省沿用老行为:全部勾了「产」的。
    - ``overwrite=False``(默认)时**已存在的产物一律跳过并如实报告**。
      界面走的是"需要更新的"那条路,那里已经按状态判过一次,所以传 True。
    - ``progress(i, total, name)``:**返回 ``False`` 就停**。剩下的如实记成
      "已取消",不是"跳过"——不然界面上看起来像是导完了。
    - ``ledger``:给了就把每条成功的产物记一笔(哪个参数指纹、写出的 sha)。
    """
    from . import ledger as ldg

    out_dir = Path(out_dir)
    cache = SourceCache(lib)
    noise = noise_sample_for(project, cache)
    todo = list(targets) if targets is not None else [s for s in project.slices if s.enabled]
    shas = sha_cache if sha_cache is not None else ldg.SourceShaCache()
    reports: list[RenderReport] = []
    for i, sl in enumerate(todo):
        if progress is not None and progress(i, len(todo), sl.name) is False:
            reports.extend(
                RenderReport(
                    slice_id=rest.id, name=rest.name, ok=False, skipped=True, cancelled=True,
                    message="已取消（这条没有导出）",
                )
                for rest in todo[i:]
            )
            break
        dest = out_dir / f"{sl.name}.wav"
        if dest.exists() and not overwrite:
            reports.append(RenderReport(
                slice_id=sl.id, name=sl.name, ok=False, skipped=True,
                out_path=str(dest),
                message="目标已存在，未覆盖（要替换请显式勾选覆盖）",
            ))
            continue
        audio, rep = render_slice(project, sl, cache, noise=noise)
        if audio is None:
            reports.append(rep)
            continue
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            tmp = dest.with_suffix(".wav.tmp")
            aio.write(tmp, audio, bits=project.settings.export_bits)
            retry_transient(os.replace, tmp, dest)
            rep.out_path = str(dest)
            if ledger is not None:
                src_sha = shas.sha_of(lib.root / sl.source)
                if src_sha:
                    ldg.record_export(ledger, project, sl, dest, src_sha, out_dir_setting)
        except (aio.AudioIOError, OSError) as ex:
            rep.ok = False
            rep.message = f"写不出去：{ex}"
        reports.append(rep)
    if progress is not None:
        progress(len(todo), len(todo), "")
    cache.clear()
    return reports


def summarize(reports: list[RenderReport]) -> str:
    """一行总结,给状态栏与命令行共用。"""
    ok = [r for r in reports if r.ok]
    cancelled = [r for r in reports if r.cancelled]
    skipped = [r for r in reports if r.skipped and not r.cancelled]
    failed = [r for r in reports if not r.ok and not r.skipped]
    parts = [f"成功 {len(ok)}"]
    if skipped:
        parts.append(f"跳过 {len(skipped)}")
    if failed:
        parts.append(f"失败 {len(failed)}")
    if cancelled:
        parts.append(f"取消后未导 {len(cancelled)}")
    if ok:
        lufs = [r.out_lufs for r in ok if math.isfinite(r.out_lufs)]
        if lufs:
            spread = max(lufs) - min(lufs)
            parts.append(f"产物响度离散 {spread:.2f} LU")
        limited = [r for r in ok if not r.hit_target]
        if limited:
            parts.append(f"{len(limited)} 条被真峰上限拦住没到目标")
        lim = [r.limiter_reduction_db for r in ok if r.limiter_reduction_db > 0.05]
        if lim:
            parts.append(f"限幅最多压 {max(lim):.1f} dB")
    return "，".join(parts)
