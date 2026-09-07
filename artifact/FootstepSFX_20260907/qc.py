# -*- coding: utf-8 -*-
"""对切出来的 one-shot 做几何质检并排名。

## 判据（我听不了，所以只用能量几何，不做"听着像"的主观判断）

一次真实的脚步是**冲击**：起振极快、随即衰减。而模型偶尔混进来的东西
（人声、持续摩擦、环境嗡鸣）是**能量摊平**的。三个量就能分开：

- `attack_ms`  起振点 → 峰值的时间。冲击应当很短。
- `sustain`    包络高于峰值 25% 的样本占比。冲击低，持续音高。
- `decay`      后 40% 的 RMS ÷ 前 20% 的 RMS。冲击应当远小于 1。

另外报 `dc_ratio`（低频能量占比）用来区分"闷响"和"脆响"——不参与打分，
只是给人看：木栈道该偏低频、纸灰该偏高频，偏反了说明 prompt 没起作用。

用法:
    sh scripts/py.sh artifact/FootstepSFX_20260907/qc.py
    sh scripts/py.sh artifact/FootstepSFX_20260907/qc.py --pick 5   # 每种地面选前 N 条
"""
from __future__ import annotations

import json
import math
import struct
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE / "oneshot"

SURFACES = ("纸钱", "木栈道", "石地", "纸灰")


def read_wav(p: Path):
    with wave.open(str(p), "rb") as w:
        n, sr = w.getnframes(), w.getframerate()
        raw = w.readframes(n)
    return list(struct.unpack("<%dh" % (len(raw) // 2), raw)), sr


def envelope(x, sr, win_sec=0.004):
    win = max(1, int(sr * win_sec))
    out, acc = [], 0.0
    for i, v in enumerate(x):
        acc += v * v
        if i >= win:
            acc -= x[i - win] * x[i - win]
        out.append(math.sqrt(acc / win))
    return out


def rms(seg):
    return math.sqrt(sum(v * v for v in seg) / len(seg)) if seg else 0.0


def low_ratio(x, sr):
    """低频能量占比的廉价代理：一阶低通后的 RMS ÷ 原 RMS。截止约 500 Hz。"""
    a = math.exp(-2 * math.pi * 500 / sr)
    y, prev = [], 0.0
    for v in x:
        prev = (1 - a) * v + a * prev
        y.append(prev)
    r = rms(x)
    return (rms(y) / r) if r > 0 else 0.0


def count_hits(env, sr, rel=0.30, min_gap_s=0.045) -> int:
    """一条 one-shot 里到底有**几次冲击**。

    🔴 这是最重要的一条判据，而第一版**根本没有它**：当时只量了起振快慢与衰减，
    于是 20 条里 14 条裹了 2–5 次冲击（`burnt_paper_2` 里有 5 声）都过了筛。
    "一个脚步声就是一声很干脆的声音"——这条要机械地判，不能靠别的指标间接推。
    """
    pk = max(env) if env else 0.0
    if pk <= 0:
        return 0
    thr = pk * rel
    gap = int(sr * min_gap_s)
    hits, i, n = [], 0, len(env)
    while i < n:
        if env[i] >= thr:
            j, best, bi = i, env[i], i
            while j < n and env[j] >= thr * 0.6:
                if env[j] > best:
                    best, bi = env[j], j
                j += 1
            if not hits or bi - hits[-1] >= gap:
                hits.append(bi)
            i = j
        else:
            i += 1
    return len(hits)


def measure(p: Path):
    x, sr = read_wav(p)
    if not x:
        return None
    env = envelope(x, sr)
    peak_i = max(range(len(env)), key=lambda i: env[i])
    peak = env[peak_i]
    if peak <= 0:
        return None
    thr = peak * 0.12
    on = peak_i
    while on > 0 and env[on] > thr:
        on -= 1
    attack_ms = (peak_i - on) / sr * 1000
    sustain = sum(1 for v in env if v >= peak * 0.25) / len(env)
    head = x[: int(len(x) * 0.20)]
    tail = x[int(len(x) * 0.60):]
    decay = (rms(tail) / rms(head)) if rms(head) > 0 else 9.9
    return {
        "name": p.name,
        "hits": count_hits(env, sr),
        "dur_ms": len(x) / sr * 1000,
        "attack_ms": attack_ms,
        "sustain": sustain,
        "decay": decay,
        "low_ratio": low_ratio(x, sr),
        "peak_db": 20 * math.log10(max(abs(v) for v in x) / 32768.0),
    }


#: 超过这个分数一律不用（= 被否决）
REJECT = 900.0


def score(m) -> float:
    """越小越像一次干净的落脚。**多于一声直接否决**，不是扣分。"""
    if m["hits"] != 1:
        return REJECT + m["hits"]
    s = 0.0
    s += min(m["attack_ms"] / 40.0, 3.0)      # 起振慢 → 罚
    s += min(m["sustain"] / 0.30, 3.0)        # 摊平 → 罚
    s += min(m["decay"] / 0.35, 3.0)          # 不衰减 → 罚
    return s


def main(argv) -> int:
    pick = 0
    if "--pick" in argv:
        pick = int(argv[argv.index("--pick") + 1])
    rows = []
    for p in sorted(SRC.glob("*.wav")):
        m = measure(p)
        if m:
            m["score"] = score(m)
            rows.append(m)
    by_surface = {s: [] for s in SURFACES}
    for m in rows:
        for s in SURFACES:
            if m["name"].startswith(s):
                by_surface[s].append(m)
                break

    chosen = {}
    short = 0
    for s in SURFACES:
        lst = sorted(by_surface[s], key=lambda m: m["score"])
        usable = [m for m in lst if m["score"] < REJECT]
        sel = usable[:pick] if pick else []
        print(f"\n=== {s}  共 {len(lst)} 条，单声可用 {len(usable)} 条")
        print("    %-32s %5s %7s %7s %7s %6s %7s %7s" %
              ("name", "声数", "时长", "attack", "sustain", "decay", "low%", "score"))
        for m in lst:
            mark = "  <== 选用" if m in sel else ("   ✗ 多声，否决" if m["hits"] != 1 else "")
            print("    %-32s %4d %6.0fms %6.1fms %6.2f %6.2f %6.2f %7.2f%s" %
                  (m["name"], m["hits"], m["dur_ms"], m["attack_ms"], m["sustain"],
                   m["decay"], m["low_ratio"], min(m["score"], 99.9), mark))
        if pick:
            if len(sel) < pick:
                print(f"    ⚠ 只凑到 {len(sel)}/{pick} 条 —— 变体不足会听成机枪，需要补生成")
                short += 1
            chosen[s] = [m["name"] for m in sel]
    if pick:
        (HERE / "picked.json").write_text(
            json.dumps(chosen, ensure_ascii=False, indent=2), encoding="utf-8")
        print("\n已写 picked.json" + ("（有地面变体不足，见上）" if short else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
