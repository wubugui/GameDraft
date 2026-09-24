# -*- coding: utf-8 -*-
"""自检 / 测试用的临时样例工程:一张合成的小呼吸图(几层纯色块 + 一个鼓包位移场)+ 参数表 + 一张用到它的对话图。

真库一个字节都不碰:``store.PROJECT`` / ``store.DATA`` 指到这里。参数表从仓库原样拷(它是唯一真相源,样例不另写一份)。
"""
from __future__ import annotations

import json
import shutil
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSET_ID = "sample_breath"
W, H = 320, 180
FW, FH = 160, 90
MEDIA = f"/resources/runtime/images/breathing/{ASSET_ID}"


def _half(x: float) -> int:
    return struct.unpack("<H", struct.pack("<e", x))[0]


def _png(path: Path, color: tuple[int, int, int, int], box: tuple[int, int, int, int] | None) -> None:
    from PIL import Image
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0) if box else color)
    if box:
        im.paste(Image.new("RGBA", (box[2] - box[0], box[3] - box[1]), color), box[:2])
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path)


def build_project(dst: Path) -> None:
    dst = Path(dst)
    (dst / "src/data").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(ROOT / "src/data/breathingParams.json", dst / "src/data/breathingParams.json")
    media = dst / "public" / MEDIA.lstrip("/")
    _png(media / "base.png", (40, 34, 28, 255), None)
    _png(media / "body.png", (90, 80, 70, 255), (120, 110, 320, 180))
    _png(media / "sheet.png", (220, 208, 184, 255), (40, 40, 140, 90))
    _png(media / "flap.png", (200, 190, 170, 255), (130, 80, 150, 120))
    # 位移场:① 纸面鼓包(朝上的单位方向 × 一个圆斑权重)② 胸口朝上权重(右下角)
    f1 = bytearray()
    f2 = bytearray()
    for y in range(FH):
        for x in range(FW):
            dx, dy = (x - 45) / 25.0, (y - 32) / 14.0
            w = max(0.0, 1.0 - (dx * dx + dy * dy))
            f1 += struct.pack("<4H", _half(0.0), _half(-w), _half(w), _half(0.0))
            c = 1.0 if (x > 60 and y > 55) else 0.0
            f2 += struct.pack("<4H", _half(-c), _half(0.0), _half(0.0), _half(0.0))
    (media / "fields.bin").write_bytes(bytes(f1) + bytes(f2))
    doc = {
        "id": ASSET_ID,
        "label": "自检样例",
        "size": [W, H],
        "layers": {"base": f"{MEDIA}/base.png", "body": f"{MEDIA}/body.png", "sheet": f"{MEDIA}/sheet.png", "flap": f"{MEDIA}/flap.png"},
        "fields": {"file": f"{MEDIA}/fields.bin", "width": FW, "height": FH},
        "rig": {"pxPerMm": 1.0, "root": [140.0, 80.0], "rootDisp": [0.0, -0.5], "flapLengthPx": 40.0,
                "flapNormal": [0.94, -0.35], "lampDir": [0.985, 0.17], "shade": 0.12,
                "limits": {"sheetMm": 15, "ventMm": 24, "cranMm": 12}},
        "params": {"ti": 2.7, "te": 3.75, "lag": 0.0, "inflate": 10.0},
    }
    ad = dst / "public/assets/data/breathing"
    ad.mkdir(parents=True, exist_ok=True)
    (ad / f"{ASSET_ID}.json").write_bytes((json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    (dst / "public/assets/data/game_config.json").write_text(json.dumps({"initialScene": "sample_scene"}), encoding="utf-8")
    graph = {
        "schemaVersion": 1, "id": "sample_graph", "entry": "a",
        "nodes": {
            "a": {"type": "runActions", "next": "b", "actions": [
                {"type": "fadeWorldToBlack", "params": {"durationMs": 300}},
                {"type": "showBreathingOverlay", "params": {"id": "paper", "breathing": ASSET_ID, "xPercent": 50, "yPercent": 48, "widthPercent": 82}},
            ]},
            "b": {"type": "line", "speaker": {"kind": "literal", "name": "旁白"}, "text": "纸随他的呼吸。", "next": "c"},
            "c": {"type": "runActions", "next": "d", "actions": [
                {"type": "breathingPerform", "params": {"id": "paper", "act": "fadeOut", "wait": True}},
            ]},
            "d": {"type": "line", "speaker": {"kind": "literal", "name": "旁白"}, "text": "然后,不动了。", "next": "e"},
            "e": {"type": "runActions", "next": "f", "actions": [
                {"type": "breathingPerform", "params": {"id": "paper", "act": "gasp"}},
                {"type": "waitMs", "params": {"durationMs": 200}},
            ]},
            "f": {"type": "line", "speaker": {"kind": "literal", "name": "旁白"}, "text": "纸猛地一颤。", "next": "g"},
            "g": {"type": "runActions", "next": "h", "actions": [
                {"type": "waitMs", "params": {"durationMs": 400}},
                {"type": "hideOverlayImage", "params": {"id": "paper"}},
            ]},
            "h": {"type": "end"},
        },
    }
    gd = dst / "public/assets/dialogues/graphs"
    gd.mkdir(parents=True, exist_ok=True)
    (gd / "sample_graph.json").write_bytes((json.dumps(graph, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
