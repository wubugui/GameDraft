#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 out/ 下已完成的道具拼成接触表，便于人眼一次性验收。"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "out"
CELL = 300
COLS = 6
LABEL = 26


def main() -> int:
    dst = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "logs" / "contact_sheet.png"
    manifest = {p["id"]: p["name_cn"] for p in
                json.loads((ROOT / "props_manifest.json").read_text(encoding="utf-8"))["props"]}
    files = sorted(OUT.glob("*.png"))
    if len(sys.argv) > 2:  # 第二个参数：只收录该 manifest 文件里的 id
        only = {p["id"] for p in
                json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))["props"]}
        files = [f for f in files if f.stem in only]
    if not files:
        print("out/ 为空")
        return 1
    rows = math.ceil(len(files) / COLS)
    sheet = Image.new("RGB", (COLS * CELL, rows * (CELL + LABEL)), (44, 44, 48))
    draw = ImageDraw.Draw(sheet)
    for i, f in enumerate(files):
        im = Image.open(f).convert("RGBA")
        im.thumbnail((CELL - 12, CELL - 12), Image.LANCZOS)
        cx, cy = (i % COLS) * CELL, (i // COLS) * (CELL + LABEL)
        # 棋盘格底，方便看透明是否干净
        for by in range(cy, cy + CELL, 16):
            for bx in range(cx, cx + CELL, 16):
                tone = 82 if ((bx // 16 + by // 16) % 2 == 0) else 62
                draw.rectangle([bx, by, bx + 15, by + 15], fill=(tone, tone, tone))
        sheet.paste(im, (cx + (CELL - im.width) // 2, cy + (CELL - im.height) // 2), im)
        draw.text((cx + 6, cy + CELL + 6), f"{i + 1:02d} {manifest.get(f.stem, f.stem)}",
                  fill=(230, 230, 230))
    dst.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(dst)
    print(f"{dst} ({len(files)} 件)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
