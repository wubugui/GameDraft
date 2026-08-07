#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""抓 i2i 退化：出图直接照抄参考图内容、或多件道具画成同一个东西。

质检脚本查不出这类问题（构图/透明度全合格，只是画错了内容），只能靠图像相似度。
做法：把每张图按不透明包围盒归一化成 32x32 灰度块（含 alpha 剪影通道），
再算两两之间的相关系数。相关系数越接近 1 越像。

用法: python dupcheck.py [相关系数阈值，默认 0.86]
"""
from __future__ import annotations

import sys
from itertools import combinations
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
REFS = ROOT / "refs"
N = 32


def signature(path: Path) -> np.ndarray:
    """归一化特征：32x32 灰度 + 32x32 alpha 剪影，拼成一条向量并去均值。"""
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im)
    alpha = a[..., 3]
    ys, xs = np.nonzero(alpha > 16)
    if ys.size:
        im = im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    im = im.resize((N, N), Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    gray = a[..., :3].mean(axis=2) * (a[..., 3] / 255.0)
    sil = a[..., 3]
    v = np.concatenate([gray.ravel(), sil.ravel()])
    v -= v.mean()
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def corr(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b))


def main() -> int:
    thresh = float(sys.argv[1]) if len(sys.argv) > 1 else 0.86
    files = sorted(OUT.glob("*.png"))
    if not files:
        print("out/ 为空")
        return 1

    ref_sig = {f.stem: signature(f) for f in sorted(REFS.glob("*.png"))}
    out_sig = {f.stem: signature(f) for f in files}

    print(f"# 内容雷同检查（阈值 corr>{thresh}，共 {len(files)} 件）\n")

    copied = sorted(
        ((corr(s, rs), pid, rn) for pid, s in out_sig.items() for rn, rs in ref_sig.items()
         if corr(s, rs) > thresh), reverse=True)
    print(f"## 疑似照抄参考图（{len(copied)} 件）")
    for c, pid, rn in copied:
        print(f"  corr={c:.3f}  {pid}  ~  refs/{rn}")

    pairs = sorted(
        ((corr(sa, sb), a, b) for (a, sa), (b, sb) in combinations(out_sig.items(), 2)
         if corr(sa, sb) > thresh), reverse=True)
    print(f"\n## 疑似互相雷同（{len(pairs)} 对）")
    for c, a, b in pairs:
        print(f"  corr={c:.3f}  {a}  ~  {b}")

    flagged = {p for _, p, _ in copied} | {x for _, a, b in pairs for x in (a, b)}
    print(f"\n## 需返工合计 {len(flagged)} 件")
    for p in sorted(flagged):
        print(f"  {p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
