"""一次性迁移：public/assets/data/*_anim.json -> public/assets/animation/<id>/anim.json + atlas.png。"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "public" / "assets" / "data"
ANIM_ROOT = ROOT / "public" / "assets" / "animation"
PUB = ROOT / "public"


def main() -> int:
    if not DATA.is_dir():
        print("missing", DATA, file=sys.stderr)
        return 1
    ANIM_ROOT.mkdir(parents=True, exist_ok=True)
    n = 0
    for p in sorted(DATA.glob("*_anim.json")):
        stem = p.stem
        with p.open(encoding="utf-8") as f:
            d = json.load(f)
        old = str(d.get("spritesheet", "") or "").strip()
        if not old:
            print("skip no spritesheet:", p.name, file=sys.stderr)
            continue
        rel = old.lstrip("/")
        src = PUB / Path(rel)
        if not src.is_file():
            print("missing image:", src, file=sys.stderr)
            continue
        out_dir = ANIM_ROOT / stem
        out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, out_dir / "atlas.png")
        d["spritesheet"] = "atlas.png"
        out_json = out_dir / "anim.json"
        with out_json.open("w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=2)
            f.write("\n")
        n += 1
        print("ok", stem, "->", out_json.relative_to(ROOT))
    print("bundles:", n)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
