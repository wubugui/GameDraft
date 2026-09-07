# -*- coding: utf-8 -*-
"""调火山引擎 openspeech (seed-audio-1.0) 生成脚步声素材。

用法:
    sh scripts/py.sh artifact/FootstepSFX_20260907/gen.py [--only id1,id2]

调用姿势照抄 `artifact/BeishiAtmosphere_20260906/gen_sfx.py::run_openspeech`
（那条是跑通过的）：X-Api-Key 直调，不走方舟 Endpoint，音频 base64 内联返回，
服务端有并发/时长限流，必须退避重试——连着打会整批 500，把限流当成生成失败就白花钱。

⚠ 本脚本只落 `raw/`，**不碰** `public/resources` 与 `audio_config.json`。
入库是单独一步（见同目录 README 的入库三件套）。
"""
from __future__ import annotations

import base64
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "raw"
OPENSPEECH = "https://openspeech.bytedance.com/api/v3/tts/create"

#: `.env.local` 只在主检出里（gitignore，不会进 worktree）。两处都找。
ENV_CANDIDATES = [
    HERE.parent.parent / ".env.local",
    Path("E:/GameDev/GameDraft/.env.local"),
]


def load_env(name: str) -> str:
    for p in ENV_CANDIDATES:
        if not p.exists():
            continue
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip()
    raise SystemExit(f"{name} 不在 {[str(p) for p in ENV_CANDIDATES]} 里")


def run_one(spec: dict, key: str) -> bool:
    sid = spec["id"]
    payload = {
        "model": spec.get("ms_model", "seed-audio-1.0"),
        "text_prompt": spec["prompt"],
        "audio_config": {
            "format": spec.get("format", "wav"),
            "sample_rate": int(spec.get("sample_rate", 48000)),
            "pitch_rate": 0,
            "speech_rate": 0,
            "loudness_rate": 0,
        },
        "watermark": {},
    }
    OUT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    print(f"[{sid}] -> openspeech {payload['model']} "
          f"{payload['audio_config']['format']}/{payload['audio_config']['sample_rate']}")
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    data = None
    for attempt in range(6):
        req = urllib.request.Request(
            OPENSPEECH, data=body,
            headers={"Content-Type": "application/json", "X-Api-Key": key},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                data = json.loads(r.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            overload = ("Overload" in detail or "Exceeded" in detail
                        or "limit" in detail.lower())
            if overload and attempt < 5:
                wait = 20 * (attempt + 1)
                print(f"[{sid}] 限流，{wait}s 后重试 ({attempt + 1}/5)")
                time.sleep(wait)
                continue
            print(f"[{sid}] HTTP {e.code}: {detail[:400]}")
            return False
        except Exception as e:  # noqa: BLE001 - 网络层什么都可能抛
            if attempt < 5:
                print(f"[{sid}] {type(e).__name__}，20s 后重试")
                time.sleep(20)
                continue
            print(f"[{sid}] 失败: {e}")
            return False
    if data is None:
        return False

    b64 = data.get("audio")
    if not b64:
        keep = {k: v for k, v in data.items() if k != "audio"}
        print(f"[{sid}] !! 返回里没有 audio: {json.dumps(keep, ensure_ascii=False)[:400]}")
        return False
    raw = base64.b64decode(b64)
    dst = OUT / f"{sid}.{payload['audio_config']['format']}"
    dst.write_bytes(raw)
    meta = {k: v for k, v in data.items() if k != "audio"}
    (OUT / f"{sid}.json").write_text(
        json.dumps({"spec": spec, "endpoint": OPENSPEECH, "request": payload,
                    "response_meta": meta}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"[{sid}] OK {dst.name}  {len(raw)} bytes  {time.time() - t0:.1f}s")
    return True


def main(argv) -> int:
    only = None
    if "--only" in argv:
        only = set(argv[argv.index("--only") + 1].split(","))
    spec_name = "spec.json"
    if "--spec" in argv:
        spec_name = argv[argv.index("--spec") + 1]
    specs = json.loads((HERE / spec_name).read_text(encoding="utf-8"))
    if only:
        specs = [s for s in specs if s["id"] in only]
    key = load_env("OPENSPEECH_KEY")
    ok = 0
    for i, s in enumerate(specs):
        if run_one(s, key):
            ok += 1
        # 串行 + 间隔：服务端按并发时长限流，并行打过去是整批 500
        if i < len(specs) - 1:
            time.sleep(3)
    print(f"\n完成 {ok}/{len(specs)}")
    return 0 if ok == len(specs) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
