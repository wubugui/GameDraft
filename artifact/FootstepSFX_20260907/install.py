# -*- coding: utf-8 -*-
"""把选中的 one-shot 入库：拷文件 + 登记 audio_config.json + 写 ATTRIBUTION。

## 入库三件套（`agent_docs/asset-pipeline/recipes/sfx-external-sourcing.md`）
1. 文件进 `public/resources/runtime/audio/`
2. `public/assets/data/audio_config.json` 的对应频道登记
3. `public/resources/runtime/audio/ATTRIBUTION.md` 记出处与许可

## ⚠ audio_config.json 是双进程共写

主编辑器与音频加工台都在写它，所以**写入必须是「只改目标键」的最小文本改动，
不许整份重序列化**（`agent_docs/editor-tools/mechanisms/audio-workbench-config-write.md`
硬契约 4）。本脚本因此走文本插入，不 json.dump 整份回写。

用法:
    sh scripts/py.sh artifact/FootstepSFX_20260907/install.py [--dry]
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SRC = HERE / "oneshot"
DST_DIR = REPO / "public" / "resources" / "runtime" / "audio" / "footsteps"
CONFIG = REPO / "public" / "assets" / "data" / "audio_config.json"
ATTRIB = REPO / "public" / "resources" / "runtime" / "audio" / "ATTRIBUTION.md"

#: 中文地面名 → 游戏内 id 前缀。沿用音效盘点里已经定好的命名。
PREFIX = {
    "纸钱": "sfx_step_paper_money",
    "木栈道": "sfx_step_plank_hollow",
    "石地": "sfx_step_stone",
    "纸灰": "sfx_step_burnt_paper",
}


def main(argv) -> int:
    dry = "--dry" in argv
    picked = json.loads((HERE / "picked.json").read_text(encoding="utf-8"))

    plan = []  # (audio_id, src_path, rel_url)
    for surface, names in picked.items():
        prefix = PREFIX[surface]
        for i, name in enumerate(names, start=1):
            aid = f"{prefix}_{i}"
            rel = f"/resources/runtime/audio/footsteps/{aid}.wav"
            plan.append((aid, SRC / name, rel, name))

    print(f"计划入库 {len(plan)} 条：")
    for aid, src, rel, orig in plan:
        print(f"  {aid:32s} <- {orig}")
    if dry:
        return 0

    DST_DIR.mkdir(parents=True, exist_ok=True)
    for aid, src, rel, _ in plan:
        shutil.copyfile(src, DST_DIR / f"{aid}.wav")
    print(f"\n已拷 {len(plan)} 个文件到 {DST_DIR}")

    # --- audio_config.json：只在 "sfx": { 之后插入我们的键，其余字节一字不动 ---
    text = CONFIG.read_text(encoding="utf-8")
    existing = json.loads(text)
    already = [aid for aid, *_ in plan if aid in existing.get("sfx", {})]
    if already:
        # 键已在配置里 = 只是换素材（重切/换候选/加工台重导出），文件已覆盖，配置不用动。
        print(f"这 {len(already)} 个 id 已登记，只覆盖了音频文件，配置未改动")
        return 0

    anchor = '"sfx": {'
    idx = text.index(anchor)
    insert_at = idx + len(anchor)
    # 复刻文件既有缩进风格（4 空格一级 → sfx 内的条目是 4 空格）
    lines = []
    for aid, _, rel, _ in plan:
        lines.append('\n    "%s": {\n      "src": "%s"\n    },' % (aid, rel))
    text = text[:insert_at] + "".join(lines) + text[insert_at:]
    CONFIG.write_text(text, encoding="utf-8", newline="\n")
    # 复核：插完必须仍是合法 JSON，且除新增键外内容不变
    after = json.loads(CONFIG.read_text(encoding="utf-8"))
    added = set(after["sfx"]) - set(existing["sfx"])
    assert added == {aid for aid, *_ in plan}, added
    for k in existing:
        if k != "sfx":
            assert after[k] == existing[k], k
    for k, v in existing["sfx"].items():
        assert after["sfx"][k] == v, k
    print(f"已登记 {len(added)} 个 sfx 键（最小文本插入，其余字节未动）")

    # --- ATTRIBUTION ---
    block = [
        "",
        "## 脚步声 one-shot（2026-09-07）",
        "",
        "- 生成：火山引擎 openspeech `seed-audio-1.0`（text_prompt → wav 48kHz）",
        "- 加工：`artifact/FootstepSFX_20260907/` 的 gen.py → slice.py → qc.py → install.py",
        "  连续脚步录音按能量包络切成单次触地 one-shot，归一到 RMS -20 dBFS / 峰值 -1 dBFS",
        "- 许可：模型生成物，无第三方素材",
        "- 覆盖地面：纸钱 / 木栈道（空鼓）/ 石地 / 纸灰，各 5 条变体",
        "",
    ]
    if ATTRIB.exists():
        cur = ATTRIB.read_text(encoding="utf-8")
        if "脚步声 one-shot（2026-09-07）" not in cur:
            ATTRIB.write_text(cur.rstrip("\n") + "\n" + "\n".join(block),
                              encoding="utf-8", newline="\n")
            print("已追加 ATTRIBUTION")
    else:
        ATTRIB.write_text("# 音频素材出处\n" + "\n".join(block),
                          encoding="utf-8", newline="\n")
        print("已新建 ATTRIBUTION")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
