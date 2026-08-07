#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""GameDraft 45度等距场景道具批量生成 / 处理流水线。

用法:
    python genprop.py list                 # 列出所有条目和完成状态
    python genprop.py next                 # 打印下一个未完成条目的 id
    python genprop.py gen <id> [--retry n] # 生成 + 抠图 + 校验单个道具
    python genprop.py process <id>         # 只对已有 raw 重跑抠图 + 校验
    python genprop.py status               # 汇总进度

产物:
    raw/<id>.png    grok GenerateImage 出的绿幕原图
    out/<id>.png    抠好的透明 PNG（最终交付）
    logs/state.json 每个道具的状态记录
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "props_manifest.json"
RAW = ROOT / "raw"
OUT = ROOT / "out"
LOGS = ROOT / "logs"
REFS = ROOT / "refs"
STATE = LOGS / "state.json"

# 出图后端：Grok CLI（走本地 7078 代理，等价于 shell 里的 grokvpn 函数）的 image_edit 工具
GROK_BIN = Path.home() / ".grok" / "bin" / "grok"
GROK_PROXY = "http://127.0.0.1:7078"
STYLE_REF = REFS / "ref_boxes.png"
MAX_EDGE = 2048

STYLE_PROMPT = """参考图**只提供画风**：笔触、勾线方式、配色倾向、材质质感。
【极其重要】绝对不要照搬参考图里画的东西。参考图里的木箱、货箱、箱堆一律不要出现在你的画面里，除非下面「要画的内容」明确要求。你要画的是一件全新的、与参考图内容完全无关的道具。

请用与参考图完全相同的绘画技法作画：手绘厚涂配细黑墨线勾边，非照片、非3D渲染、非写实摄影；低饱和灰褐冷色调，材质强调木纹磨损、脏污、旧漆剥落、铁件锈迹、霉斑水渍。

【背景】纯正的荧光绿幕背景（chroma key green #00FF00）。背景必须是**完全平的一整块单一纯绿色**：不要放射线、不要光芒、不要光晕、不要渐变、不要暗角、不要纹理、不要图案、不要任何装饰元素，就是一块死板的纯绿色块。物体本身不能带绿色。
【视角】严格45度等距俯视（isometric 3/4 top-down），必须明显看得见物体的顶面，同时看见两个侧面，物体要有明确的立体体积感。即使是小件道具也必须这样画——不要画成平摊在地上的俯视静物、不要正视图、不要侧视图、不要仰视。
【硬性禁止】不要地面投影、不要接地阴影、不要 drop shadow；不要画地面、草地、泥土、石板、桌面、台座、底盘——物体必须完全悬空在纯绿背景上；不要人物、不要动物、不要水印、不要边框。
【绝对不要文字】画面里不能出现任何汉字、字母、数字、印章字样、符箓咒文、刻度标注、以及任何像文字的笔画。符纸、书页、木牌、罗盘、匾额、票据一律画成空白或只有抽象的磨损污渍痕迹。
【构图】单件场景道具，居中，主体占满画面约90%。

要画的内容：{subject}{style_note}"""


# --------------------------------------------------------------------------- 基础

def load_manifest() -> list[dict]:
    return json.loads(MANIFEST.read_text(encoding="utf-8"))["props"]


def load_state() -> dict:
    if STATE.exists():
        return json.loads(STATE.read_text(encoding="utf-8"))
    return {}


def save_state(state: dict) -> None:
    LOGS.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def find(props: list[dict], pid: str) -> dict:
    for p in props:
        if p["id"] == pid:
            return p
    raise SystemExit(f"未知道具 id: {pid}")


# --------------------------------------------------------------------------- 生成

def generate(prop: dict, out_path: Path) -> None:
    """驱动 Grok CLI 的 image_edit 工具做图生图（参考图锁画风），落到 out_path。

    等价于 shell 里的 grokvpn 函数：把 grok 二进制套在本地 7078 代理上跑。
    """
    RAW.mkdir(parents=True, exist_ok=True)
    before = out_path.stat().st_mtime if out_path.exists() else 0.0

    prompt = STYLE_PROMPT.format(subject=prop["subject"],
                                 style_note=prop.get("style_note", ""))
    instruction = (
        "调用 image_edit 工具做一次图生图，参数如下。"
        "prompt 必须原样传进去，一个字都不许改写、精简或翻译。\n\n"
        f"image = {STYLE_REF}\n"
        'aspect_ratio = "1:1"\n'
        f"prompt = {prompt}\n\n"
        f"生成的图必须保存到这个绝对路径：{out_path}\n"
        "做完只回复 DONE，不要解释、不要做别的事。"
    )
    env = {
        **os.environ,
        "HTTP_PROXY": GROK_PROXY, "HTTPS_PROXY": GROK_PROXY, "ALL_PROXY": GROK_PROXY,
        "http_proxy": GROK_PROXY, "https_proxy": GROK_PROXY, "all_proxy": GROK_PROXY,
        "NO_PROXY": "localhost,127.0.0.1,::1", "no_proxy": "localhost,127.0.0.1,::1",
    }
    cmd = [str(GROK_BIN), "-p", instruction, "--always-approve"]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=900, env=env)
    if res.returncode != 0:
        raise RuntimeError(f"grok 失败: {res.stdout[-400:]} {res.stderr[-400:]}")
    if not out_path.exists() or out_path.stat().st_mtime <= before:
        raise RuntimeError(f"image_edit 未产出 {out_path}（grok 回复: {res.stdout[-300:]}）")


# --------------------------------------------------------------------------- 抠图

def _border_connected(mask: np.ndarray) -> np.ndarray:
    """只保留与画面边缘连通的 True 区域 —— 防止把物体内部的苔藓/绿渍抠掉。"""
    lab, n = ndimage.label(mask)
    if n == 0:
        return np.zeros_like(mask, dtype=bool)
    edge = np.concatenate([lab[0, :], lab[-1, :], lab[:, 0], lab[:, -1]])
    keep = np.unique(edge[edge > 0])
    return np.isin(lab, keep)


def _bleed_edges(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """把不透明像素的颜色外扩填进透明区，避免引擎双线性采样时吃到绿边/黑边。"""
    opaque = alpha > 8
    if not opaque.any():
        return rgb
    _, idx = ndimage.distance_transform_edt(~opaque, return_distances=True, return_indices=True)
    return rgb[idx[0], idx[1]]


def check_backdrop(arr: np.ndarray, high: float) -> float:
    """原图外缘一圈里"纯绿"像素的占比。出图把背景画成放射光/渐变时这个值会塌下来。

    抠图算法救不了被画成装饰底纹的背景，只能在这里判死、让上层重出。
    """
    h, w = arr.shape[:2]
    band = max(4, round(min(h, w) * 0.03))
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    keyv = g - np.maximum(r, b)
    ring = np.zeros((h, w), dtype=bool)
    ring[:band, :] = ring[-band:, :] = True
    ring[:, :band] = ring[:, -band:] = True
    return float((keyv[ring] > high).mean())


def chroma_key(src: Path, dst: Path, low: float = 18.0, high: float = 60.0) -> dict:
    """绿幕抠图 + 去绿边 + 裁边 + 限尺寸。返回质检指标。"""
    img = Image.open(src).convert("RGB")
    arr = np.asarray(img).astype(np.float32)
    backdrop = check_backdrop(arr, high)
    if backdrop < 0.90:
        raise RuntimeError(
            f"背景不是干净绿幕（外缘纯绿占比 {backdrop:.2f}，要求 >=0.90）——"
            f"多半被画成了放射光/渐变/实景底，需重出")
    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]

    # 绿色主导度：绿通道超出红蓝最大值多少
    keyv = g - np.maximum(r, b)

    # 硬背景种子 -> 只取与边缘连通的部分，再沿"宽松绿"区域向内生长。
    # 生长这一步是为了吃掉出图时画在背景上的暗绿放射线/光晕：它们绿得不够纯，
    # 过不了 high 阈值，但与边缘纯绿是连通的。
    bg_seed = _border_connected(keyv > high)
    bg = ndimage.binary_propagation(bg_seed, mask=(keyv > low))

    # 软边过渡：在连通背景的膨胀范围内，用 keyv 做线性 alpha
    alpha = np.ones(keyv.shape, dtype=np.float32)
    soft = (keyv > low) & (~bg)
    ramp = np.clip((keyv - low) / (high - low), 0.0, 1.0)
    alpha[soft] = 1.0 - ramp[soft]
    alpha[bg] = 0.0

    # 去绿边（despill）：残留半透明像素把绿压回红蓝水平
    spill = (keyv > 0) & (alpha > 0)
    g2 = g.copy()
    g2[spill] = np.minimum(g[spill], np.maximum(r[spill], b[spill]) + 6.0)

    # 丢掉零碎连通块（背景光晕留下的环、飞点），只保留主体及成规模的配件
    solid = alpha > 0.5
    lab, n = ndimage.label(solid)
    if n > 1:
        areas = ndimage.sum_labels(solid, lab, index=np.arange(1, n + 1))
        keep = np.isin(lab, 1 + np.nonzero(areas >= areas.max() * 0.02)[0])
        alpha[~keep & solid] = 0.0

    a8f = alpha * 255.0
    rgb = np.stack([r, g2, b], axis=-1)
    rgb = _bleed_edges(rgb, a8f)
    out = np.concatenate([rgb, a8f[..., None]], axis=-1).astype(np.uint8)
    rgba = Image.fromarray(out, mode="RGBA")

    # 裁到有效包围盒（留 8px 边）
    a8 = out[..., 3]
    ys, xs = np.nonzero(a8 > 8)
    if ys.size == 0:
        raise RuntimeError("抠图后全透明，绿幕参数或原图有问题")
    pad = 8
    y0, y1 = max(0, ys.min() - pad), min(a8.shape[0], ys.max() + 1 + pad)
    x0, x1 = max(0, xs.min() - pad), min(a8.shape[1], xs.max() + 1 + pad)
    rgba = rgba.crop((x0, y0, x1, y1))

    # 限最大边
    w, h = rgba.size
    if max(w, h) > MAX_EDGE:
        s = MAX_EDGE / max(w, h)
        rgba = rgba.resize((round(w * s), round(h * s)), Image.LANCZOS)

    dst.parent.mkdir(parents=True, exist_ok=True)
    rgba.save(dst, "PNG", optimize=True)
    return qa(dst)


# --------------------------------------------------------------------------- 质检

_REF_SIGS: list[np.ndarray] | None = None


def _signature(im: Image.Image) -> np.ndarray:
    """按不透明包围盒归一化成 32x32 灰度+剪影特征向量，用于内容雷同比对。"""
    a = np.asarray(im.convert("RGBA"))
    ys, xs = np.nonzero(a[..., 3] > 16)
    if ys.size:
        im = im.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    a = np.asarray(im.convert("RGBA").resize((32, 32), Image.LANCZOS)).astype(np.float32)
    gray = a[..., :3].mean(axis=2) * (a[..., 3] / 255.0)
    v = np.concatenate([gray.ravel(), a[..., 3].ravel()])
    v -= v.mean()
    n = np.linalg.norm(v)
    return v / n if n > 0 else v


def ref_similarity(img: Image.Image) -> float:
    """与风格参考图的最大相关系数。>0.95 基本就是把参考图内容原样抄了一遍。"""
    global _REF_SIGS
    if _REF_SIGS is None:
        _REF_SIGS = [_signature(Image.open(f)) for f in sorted(REFS.glob("*.png"))]
    if not _REF_SIGS:
        return 0.0
    s = _signature(img)
    return max(float(np.dot(s, r)) for r in _REF_SIGS)


def qa(path: Path) -> dict:
    img = Image.open(path).convert("RGBA")
    arr = np.asarray(img).astype(np.float32)
    a = arr[..., 3]
    w, h = img.size
    corners = [a[0, 0], a[0, -1], a[-1, 0], a[-1, -1]]
    opaque = a > 16
    coverage = float(opaque.mean())

    r, g, b = arr[..., 0], arr[..., 1], arr[..., 2]
    keyv = g - np.maximum(r, b)
    green_residue = float(((keyv > 40) & opaque).mean())

    checks = {
        "size": [w, h],
        "max_edge_ok": max(w, h) <= MAX_EDGE,
        "corners_transparent": all(c <= 8 for c in corners),
        "coverage": round(coverage, 4),
        "coverage_ok": 0.05 <= coverage <= 0.93,
        "green_residue": round(green_residue, 5),
        "green_ok": green_residue < 0.004,
    }
    # i2i 退化闸：把风格参考图的内容原样抄了一遍（画出一堆木箱），构图质检看不出来
    rc = ref_similarity(img)
    checks["ref_corr"] = round(rc, 4)
    checks["not_ref_copy"] = rc < 0.95
    checks["pass"] = bool(
        checks["max_edge_ok"] and checks["corners_transparent"]
        and checks["coverage_ok"] and checks["green_ok"] and checks["not_ref_copy"]
    )
    return checks


# --------------------------------------------------------------------------- 命令

def cmd_gen(pid: str, retry: int) -> int:
    props = load_manifest()
    prop = find(props, pid)
    state = load_state()
    raw_path = RAW / f"{pid}.png"
    out_path = OUT / f"{pid}.png"

    last_err = None
    for attempt in range(1, retry + 1):
        try:
            generate(prop, raw_path)
            checks = chroma_key(raw_path, out_path)
            state[pid] = {"name_cn": prop["name_cn"], "cat": prop["cat"],
                          "scenes": prop["scenes"], "attempt": attempt, **checks}
            save_state(state)
            flag = "PASS" if checks["pass"] else "WARN"
            print(f"[{flag}] {pid} ({prop['name_cn']}) {checks['size']} "
                  f"cov={checks['coverage']} green={checks['green_residue']}")
            if checks["pass"]:
                return 0
            last_err = f"质检未过: {checks}"
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)
            print(f"[RETRY {attempt}/{retry}] {pid}: {exc}", file=sys.stderr)

    fails = (state.get(pid) or {}).get("fail_rounds", 0) + 1
    state[pid] = {"name_cn": prop["name_cn"], "cat": prop["cat"],
                  "scenes": prop["scenes"], "pass": False,
                  "fail_rounds": fails, "error": str(last_err)}
    save_state(state)
    print(f"[FAIL] {pid}: {last_err}", file=sys.stderr)
    return 1


def cmd_process(pid: str) -> int:
    props = load_manifest()
    prop = find(props, pid)
    checks = chroma_key(RAW / f"{pid}.png", OUT / f"{pid}.png")
    state = load_state()
    state[pid] = {"name_cn": prop["name_cn"], "cat": prop["cat"],
                  "scenes": prop["scenes"], **checks}
    save_state(state)
    print(json.dumps(checks, ensure_ascii=False))
    return 0 if checks["pass"] else 1


def cmd_list() -> int:
    state = load_state()
    for p in load_manifest():
        st = state.get(p["id"])
        mark = "OK " if (st and st.get("pass")) else ("BAD" if st else "-  ")
        print(f"{mark} {p['id']:36s} {p['name_cn']}")
    return 0


def cmd_next() -> int:
    state = load_state()
    for p in load_manifest():
        st = state.get(p["id"]) or {}
        # 连续失败 3 轮的条目跳过，避免队列卡死在同一件上空转
        if st.get("pass") or st.get("fail_rounds", 0) >= 3:
            continue
        print(p["id"])
        return 0
    print("")
    return 1


def cmd_status() -> int:
    state = load_state()
    props = load_manifest()
    done = [p for p in props if state.get(p["id"], {}).get("pass")]
    bad = [p for p in props if p["id"] in state and not state[p["id"]].get("pass")]
    print(f"total={len(props)} done={len(done)} bad={len(bad)} todo={len(props) - len(done) - len(bad)}")
    for p in bad:
        print(f"  BAD {p['id']}: {state[p['id']].get('error') or state[p['id']]}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("gen"); g.add_argument("id"); g.add_argument("--retry", type=int, default=3)
    p = sub.add_parser("process"); p.add_argument("id")
    sub.add_parser("list"); sub.add_parser("next"); sub.add_parser("status")
    ns = ap.parse_args()
    if ns.cmd == "gen":
        return cmd_gen(ns.id, ns.retry)
    if ns.cmd == "process":
        return cmd_process(ns.id)
    if ns.cmd == "list":
        return cmd_list()
    if ns.cmd == "next":
        return cmd_next()
    return cmd_status()


if __name__ == "__main__":
    raise SystemExit(main())
