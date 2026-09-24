# -*- coding: utf-8 -*-
"""出片:页面用**同一份运行时模拟与着色**逐帧渲染、读回像素、一帧帧 POST 过来,这里存帧、最后拼成成品。

  begin  {kind: loop|story, id, fps, width, height}   → token + 输出目录
  frame  原始 RGBA(readPixels 自下而上)               → 翻正存 JPEG(剧情)/ PNG(循环)
  finish {token, meta}                                  → 循环:半尺寸 GIF + 逐帧标注接触表;剧情:MP4(旁白字幕 / 黑场按 meta 合成)

成品落 ``local/breathing_renders/<id>_<kind>_<时间>/``(``local/`` 不进版本),同目录留 ``参数.txt`` 与 ``meta.json``。
剧情 MP4 需要 ffmpeg(PATH 上);没有就只留帧与说明,不假装成功。
"""
from __future__ import annotations

import json
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

from tools.breathing_workbench import store

RENDERS_REL = "local/breathing_renders"
FONT = "C:/Windows/Fonts/msyh.ttc"
_LOCK = threading.Lock()
_JOBS: dict[str, dict] = {}


def renders_root() -> Path:
    return store.DATA / RENDERS_REL


def _font(size: int):
    from PIL import ImageFont
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default()


def begin(kind: str, bid: str, fps: float, width: int, height: int, params_text: str = "") -> dict:
    if kind not in ("loop", "story"):
        raise ValueError("kind 只能是 loop / story")
    if not store.valid_id(bid):
        raise ValueError(f"呼吸图 id 不合法:{bid!r}")
    if not (0 < width <= 8192 and 0 < height <= 8192) or not (0 < fps <= 120):
        raise ValueError("尺寸 / 帧率不合理")
    out = renders_root() / f"{bid}_{kind}_{time.strftime('%Y%m%d-%H%M%S')}"
    (out / "frames").mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    with _LOCK:
        _JOBS[token] = {"kind": kind, "id": bid, "fps": fps, "w": width, "h": height, "dir": out, "n": 0}
    if params_text:
        (out / "参数.txt").write_text(params_text, encoding="utf-8", newline="\n")
    return {"token": token, "dir": str(out)}


def _job(token: str) -> dict:
    with _LOCK:
        job = _JOBS.get(token)
    if not job:
        raise ValueError("出片任务不存在(页面刷新过?重新开始出片)")
    return job


def frame(token: str, index: int, raw: bytes) -> None:
    import numpy as np
    from PIL import Image
    job = _job(token)
    w, h = job["w"], job["h"]
    if len(raw) != w * h * 4:
        raise ValueError(f"帧大小不对:{len(raw)} 字节,应为 {w}×{h}×4")
    a = np.frombuffer(raw, np.uint8).reshape(h, w, 4)[::-1, :, :3]
    im = Image.fromarray(np.ascontiguousarray(a))
    ext = "png" if job["kind"] == "loop" else "jpg"
    path = job["dir"] / "frames" / f"{index:05d}.{ext}"
    if ext == "png":
        im.save(path, compress_level=1)
    else:
        im.save(path, quality=93)
    with _LOCK:
        job["n"] = max(job["n"], index + 1)


def _loop(job: dict, meta: dict) -> list[str]:
    from PIL import Image, ImageDraw
    frames = sorted((job["dir"] / "frames").glob("*.png"))
    if not frames:
        raise ValueError("没有收到帧")
    ims = [Image.open(p).convert("RGB") for p in frames]
    w, h = max(2, ims[0].width // 2), max(2, ims[0].height // 2)
    small = [im.resize((w, h), Image.LANCZOS) for im in ims]
    pal = small[len(small) // 2].quantize(colors=255, method=Image.MEDIANCUT)
    q = [im.quantize(palette=pal, dither=Image.NONE) for im in small]
    gif = job["dir"] / f"{job['id']}_一口循环.gif"
    q[0].save(gif, save_all=True, append_images=q[1:], duration=max(10, round(1000 / job["fps"])), loop=0, optimize=True)
    fr = meta.get("frames") if isinstance(meta.get("frames"), list) else []
    n = len(ims)
    pick = [round(k * n / 12) for k in range(12) if round(k * n / 12) < n]
    cw, ch = ims[0].width // 2, ims[0].height // 2
    sheet = Image.new("RGB", (3 * cw, ((len(pick) + 2) // 3) * ch))
    dr = ImageDraw.Draw(sheet)
    font = _font(max(12, ch // 16))
    t0 = fr[0]["t"] if fr else 0
    for j, i in enumerate(pick):
        x, y = (j % 3) * cw, (j // 3) * ch
        sheet.paste(ims[i].resize((cw, ch), Image.LANCZOS), (x, y))
        if i < len(fr):
            m = fr[i]
            dr.text((x + 8, y + 6), f"{m['t'] - t0:.2f}s  {m.get('ph', '')}  胸口 {m.get('V', 0):.2f}  纸 {m.get('mm', 0):+.1f}mm",
                    fill=(255, 210, 120), font=font)
    sheet_path = job["dir"] / f"{job['id']}_接触表.jpg"
    sheet.save(sheet_path, quality=88)
    return [str(gif), str(sheet_path)]


def _story(job: dict, meta: dict) -> list[str]:
    from PIL import Image, ImageDraw
    frames = sorted((job["dir"] / "frames").glob("*.jpg"))
    if not frames:
        raise ValueError("没有收到帧")
    fr = meta.get("frames") if isinstance(meta.get("frames"), list) else []
    W, H = job["w"], job["h"]
    iw, ih = round(W * 0.82), round(H * 0.82)
    ox, oy = round(W * 0.09), round(H * 0.07)
    f_line, f_who = _font(max(14, H // 31)), _font(max(12, H // 42))
    comp = job["dir"] / "_comp"
    comp.mkdir(exist_ok=True)
    for i, p in enumerate(frames):
        m = fr[i] if i < len(fr) else {}
        canvas = Image.new("RGB", (W, H))
        canvas.paste(Image.open(p).convert("RGB").resize((iw, ih), Image.LANCZOS), (ox, oy))
        blk = float(m.get("black") or 0)
        if blk > 0:
            canvas = Image.blend(canvas, Image.new("RGB", (W, H)), min(1.0, blk))
        line = m.get("line")
        if isinstance(line, dict) and line.get("text"):
            dr = ImageDraw.Draw(canvas, "RGBA")
            x0, x1, y1 = round(W * 0.08), round(W * 0.92), round(H * 0.97)
            y0 = y1 - round(H * 0.112)
            dr.rectangle((x0, y0, x1, y1), fill=(14, 11, 8, 225), outline=(42, 35, 27, 255))
            dr.text((x0 + 22, y0 + 10), str(line.get("speaker") or ""), fill=(208, 146, 79), font=f_who)
            dr.text((x0 + 22, y0 + 10 + round(H * 0.037)), str(line["text"]), fill=(221, 208, 184), font=f_line)
        canvas.save(comp / f"{i:05d}.jpg", quality=92)
    ff = shutil.which("ffmpeg")
    out: list[str] = []
    if ff:
        mp4 = job["dir"] / f"{job['id']}_剧情全程.mp4"
        subprocess.run([ff, "-y", "-loglevel", "error", "-framerate", str(job["fps"]), "-i", str(comp / "%05d.jpg"),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", str(mp4)],
                       check=True, timeout=1800)
        out.append(str(mp4))
        shutil.rmtree(comp, ignore_errors=True)
    else:
        (job["dir"] / "没有ffmpeg.txt").write_text("PATH 上找不到 ffmpeg:合成好的帧在 _comp/ 里,没有拼成 MP4。\n", encoding="utf-8")
        out.append(str(comp))
    return out


def finish(token: str, meta: dict) -> dict:
    job = _job(token)
    (job["dir"] / "meta.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8", newline="\n")
    files = _loop(job, meta) if job["kind"] == "loop" else _story(job, meta)
    with _LOCK:
        _JOBS.pop(token, None)
    return {"dir": str(job["dir"]), "files": files, "frames": job["n"]}


def reveal(path: str) -> bool:
    """在资源管理器里打开出片目录(只放行 local/breathing_renders 之下)。"""
    import os
    p = Path(path).resolve()
    try:
        p.relative_to(renders_root().resolve())
    except ValueError:
        return False
    if not p.exists():
        return False
    target = p if p.is_dir() else p.parent
    if hasattr(os, "startfile"):
        os.startfile(str(target))  # noqa: S606 — 打开本机文件夹
        return True
    return False
