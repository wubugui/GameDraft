# -*- coding: utf-8 -*-
"""把生成出来的「连续脚步」录音切成**单次触地**的 one-shot 变体。

## 为什么要切

上一批的教训（`artifact/BeishiAtmosphere_20260906/音效盘点.md`）：
模型做不出「只有一步」的结构——prompt 写 "One step only" 它照样给你连续多事件，
当时没人复核，三条脚步素材全是 2.5 秒的连续录音，**当 one-shot 用会是每走一步响 3 秒沙沙**。

反过来想，这恰恰是好事：一段连续脚步录音里本来就有 N 个**天然互不相同**的落脚，
切出来正好就是「每种地面 3–6 个变体」所需要的那一批——而多变体不重复正是
脚步不听成机枪的唯一办法。所以不跟模型较劲，切就是了。

## 判据

短时能量包络 → 找峰 → 峰前回溯到起振点 → 截固定长度。
按**相对全局峰值**的阈值判峰（不是绝对值），所以对整体响度不敏感。
峰之间强制最小间隔，避免把一次落脚的余震当成第二步。

用法:
    sh scripts/py.sh artifact/FootstepSFX_20260907/slice.py            # 全部
    sh scripts/py.sh artifact/FootstepSFX_20260907/slice.py --report   # 只看包络不切
"""
from __future__ import annotations

import json
import math
import struct
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE / "raw"
OUT = HERE / "oneshot"

#: 单个 one-shot 的**上限**长度（秒）。真实脚步是 100–200ms 的事，
#: 第一版取 0.42 是错的——20 条里 14 条因此裹进了 2–5 次冲击（实测）。
CLIP_SEC = 0.22
#: 起振点往前留一点，别把冲击的头切掉（切掉了就没有"啪"那一下）
PRE_ROLL_SEC = 0.015
#: 下一次冲击之前留出的安全距离：切到这儿为止，保证**绝不裹进第二声**。
GUARD_SEC = 0.018
#: 一条 one-shot 的最短可用长度。比这还短说明两次冲击贴得太近，这条候选直接丢，
#: 不要为了凑数发一个 40ms 的碎片出去。
MIN_CLIP_SEC = 0.12
#: 冲击检测的最小间隔。
#: 🔴 这个数决定「算几声」。第一版 0.28 把 280ms 内的连续冲击**合并成一次**，
#: 于是切片器以为只有一声、实际裹了好几声。要数得清就必须比一次冲击本身还短。
MIN_GAP_SEC = 0.045
#: 判峰阈值：相对全局最大包络。
PEAK_REL = 0.30
#: 起振回溯阈值：相对该峰自身。
ONSET_REL = 0.12
#: 包络窗（秒）
ENV_WIN_SEC = 0.005
#: 一次性音效的目标 RMS（dBFS）与峰值上限，与既有 normalize.py 同口径
TARGET_RMS_DB = -20.0
PEAK_CEIL_DB = -1.0


def read_wav(p: Path):
    with wave.open(str(p), "rb") as w:
        n, sr, ch, sw = w.getnframes(), w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    if sw != 2:
        raise SystemExit(f"{p.name}: 只支持 16-bit，实际 {sw * 8}-bit")
    vals = struct.unpack("<%dh" % (len(raw) // 2), raw)
    if ch > 1:  # 混单声道：脚步是点声源，立体声宽度由运行时空间化给
        vals = [sum(vals[i:i + ch]) / ch for i in range(0, len(vals), ch)]
    return list(vals), sr


def write_wav(p: Path, samples, sr: int) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    clipped = [max(-32768, min(32767, int(round(v)))) for v in samples]
    with wave.open(str(p), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(struct.pack("<%dh" % len(clipped), *clipped))


def envelope(x, sr: int):
    win = max(1, int(sr * ENV_WIN_SEC))
    out, acc = [], 0.0
    for i, v in enumerate(x):
        acc += v * v
        if i >= win:
            acc -= x[i - win] * x[i - win]
        out.append(math.sqrt(acc / win))
    return out


def find_onsets(env, sr: int):
    peak = max(env) if env else 0.0
    if peak <= 0:
        return []
    thr = peak * PEAK_REL
    min_gap = int(sr * MIN_GAP_SEC)
    peaks = []
    i, n = 0, len(env)
    while i < n:
        if env[i] >= thr:
            j, best, bi = i, env[i], i
            while j < n and env[j] >= thr * 0.5:
                if env[j] > best:
                    best, bi = env[j], j
                j += 1
            if not peaks or bi - peaks[-1][0] >= min_gap:
                peaks.append((bi, best))
            elif best > peaks[-1][1]:
                peaks[-1] = (bi, best)
            i = j
        else:
            i += 1
    onsets = []
    for bi, best in peaks:
        k, floor = bi, best * ONSET_REL
        while k > 0 and env[k] > floor:
            k -= 1
        onsets.append(max(0, k - int(sr * PRE_ROLL_SEC)))
    # 回溯之后必须**排序去重并重新拉开间隔**：不同的峰可能回溯到同一处、甚至回溯出
    # 比前一个峰更早的位置。不收拾的话「下一次冲击」的边界会算错（甚至为负），
    # 一条 one-shot 里只许有一声的硬闸就白设了。
    onsets.sort()
    merged = []
    for o in onsets:
        if not merged or o - merged[-1] >= min_gap:
            merged.append(o)
    return merged


def normalize(seg):
    if not seg:
        return seg
    rms = math.sqrt(sum(v * v for v in seg) / len(seg))
    if rms <= 0:
        return seg
    gain = (10 ** (TARGET_RMS_DB / 20) * 32768.0) / rms
    peak = max(abs(v) for v in seg) * gain
    ceil = 10 ** (PEAK_CEIL_DB / 20) * 32768.0
    if peak > ceil:
        gain *= ceil / peak
    return [v * gain for v in seg]


def fade(seg, sr: int, ms_in=2.0, ms_out=55.0):
    """收尾淡出按**片段长度**取，别在 120ms 的短片上砍掉半条。"""
    n_in = int(sr * ms_in / 1000)
    n_out = min(int(sr * ms_out / 1000), int(len(seg) * 0.35))
    for i in range(min(n_in, len(seg))):
        seg[i] *= i / max(1, n_in)
    for i in range(min(n_out, len(seg))):
        seg[len(seg) - 1 - i] *= i / max(1, n_out)
    return seg


def db(v: float) -> float:
    return 20 * math.log10(v / 32768.0) if v > 0 else -99.0


def process(p: Path, report_only: bool):
    x, sr = read_wav(p)
    env = envelope(x, sr)
    onsets = find_onsets(env, sr)
    dur = len(x) / sr
    print(f"=== {p.stem}  {dur:.2f}s  {sr}Hz  峰值 {db(max(abs(v) for v in x)):.1f} dBFS")
    print(f"    检出 {len(onsets)} 个落脚: " +
          ", ".join(f"{o / sr:.2f}s" for o in onsets[:14]) +
          (" …" if len(onsets) > 14 else ""))
    if report_only:
        return []

    made, dropped = [], 0
    clip_n = int(sr * CLIP_SEC)
    guard_n = int(sr * GUARD_SEC)
    min_n = int(sr * MIN_CLIP_SEC)
    for idx, o in enumerate(onsets):
        # 🔴 硬闸：切到**下一次冲击之前**为止。一条 one-shot 里只许有一声。
        limit = (onsets[idx + 1] - guard_n) if idx + 1 < len(onsets) else len(x)
        end = min(o + clip_n, limit, len(x))
        if end - o < min_n:
            dropped += 1          # 两声贴太近，这条没法用；丢掉，不发碎片
            continue
        seg = [float(v) for v in x[o:end]]
        seg = fade(normalize(seg), sr)
        name = f"{p.stem}_{idx + 1:02d}.wav"
        write_wav(OUT / name, seg, sr)
        made.append(name)
    print(f"    -> 切出 {len(made)} 条 one-shot" +
          (f"（另丢弃 {dropped} 条：与下一声贴得太近）" if dropped else ""))
    return made


def main(argv) -> int:
    report_only = "--report" in argv
    files = sorted(RAW.glob("*.wav"))
    if not files:
        print("raw/ 里没有 wav，先跑 gen.py")
        return 1
    index = {}
    for p in files:
        index[p.stem] = process(p, report_only)
    if not report_only:
        (OUT / "index.json").write_text(
            json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
