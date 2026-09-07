# -*- coding: utf-8 -*-
"""**走音频加工台的标准流程**把脚步素材入库。

## 我上一版错在哪（五处）

| 标准流程 | 我上一版 |
|---|---|
| 料平铺在 `tools/audio_editor/imported/`，sourceKey = `imported/<文件名>`（`do_import` 用 `Path(name).name`，**不建子目录**）| 拍进了 `imported/footsteps_20260907/` 子目录 → `source_path()` 根本找不到 |
| 成品由**导出**产生，落 `runtime/audio/edited/`，文件名 = `<源名>_<内容哈希前缀><ext>`（**内容寻址**）| 自己写进 `runtime/audio/footsteps/`，用 **key 当文件名** —— 正是机制卡里「文件名安全靠『根本不用 id 当文件名』解决」要避免的 |
| `assignments.json` 记 key→料 的挂接 | 没有 → 加工台里这 20 个 key 显示「没挂源」 |
| `exports.json` 台账按**内容哈希**记 `{src, bytes, firstSeen, origin}` | 没有条目、没有 origin，出处丢失 |
| `audio_config.json` 的 `src` 由导出步骤改写 | 我自己插的（口径对，但指向了非标准位置）|

## 这个脚本干什么

不重新实现任何一步，**直接调加工台自己的函数**：
`import`（平铺进料区）→ `assign`（写 assignments）→ `run_export`（渲染 + 内容寻址落盘 +
写台账 + 用它自己的文本级最小写入改 audio_config 的 src）。

所以产物与人在网页上点出来的**完全一致**，用户之后在加工台里换料、重导出也接得上。

用法:
    sh scripts/py.sh artifact/FootstepSFX_20260907/intake.py --clean   # 先撤掉上一版的非标准落盘
    sh scripts/py.sh artifact/FootstepSFX_20260907/intake.py
"""
from __future__ import annotations

import json
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(REPO))

from tools.audio_editor import ledger as led                      # noqa: E402
from tools.audio_editor import server as ws                       # noqa: E402

ONESHOT = HERE / "oneshot"
#: 上一版非标准的落点，要撤掉
BAD_PRODUCT_DIR = REPO / "public" / "resources" / "runtime" / "audio" / "footsteps"
BAD_IMPORT_DIR = ws.IMPORTED / "footsteps_20260907"

PREFIX = {
    "纸钱": "sfx_step_paper_money",
    "木栈道": "sfx_step_plank_hollow",
    "石地": "sfx_step_stone",
    "纸灰": "sfx_step_burnt_paper",
}
#: 料区文件名用 ASCII：成品名 = `sanitize_stem(源名) + _ + 内容哈希`，
#: 源名里带中文会被 sanitize 掉，成品名就没法看出是哪条料了。
ROMAN = {"纸钱": "paper_money", "木栈道": "plank_hollow", "石地": "stone", "纸灰": "burnt_paper"}


def clean() -> None:
    """撤掉上一版绕过加工台的落盘，并清掉本脚本自己导入过的料（幂等重跑）。

    ⚠ 只删**本脚本导入的那批**（`footstep_<地面>_*`）。料区是共享的，
    别人放的料一个都不能碰。
    """
    if BAD_IMPORT_DIR.exists():
        shutil.rmtree(BAD_IMPORT_DIR)
        print(f"已删 非标准料区子目录 {BAD_IMPORT_DIR}")
    if BAD_PRODUCT_DIR.exists():
        n = len(list(BAD_PRODUCT_DIR.glob("*.wav")))
        shutil.rmtree(BAD_PRODUCT_DIR)
        print(f"已删 非标准成品目录 {BAD_PRODUCT_DIR}（{n} 个 key 命名的 wav）")
    mine = sorted(ws.IMPORTED.glob("footstep_*.wav"))
    for p in mine:
        p.unlink()
    if mine:
        print(f"已清 料区里本脚本导入过的 {len(mine)} 条（重跑幂等；别人的料没动）")


def reset_my_ledger() -> None:
    """清掉**我自己**在台账里留下的条目，让下一次导出重新如实记账。

    为什么需要：我在两次导出之间手工删过 `edited/` 下的成品（又一次绕过工具），
    于是 `files[hash].src` 还指着被我删掉的旧文件名，而 `keys` 与 audio_config
    已经指向新名字。台账因此内部不一致。

    机制卡说「状态一律由磁盘反算，台账只是缓存」，所以这条漂移不会让工具出错
    （`resolve_ledger_file` 会 `is_file()` 复核，最多多渲一次）。但既然是我弄脏的，
    清掉重记一次比留着强。

    ⚠ 只删**能证明是本次产出**的条目：`origin.sourceKey` 以 `imported/footstep_` 开头，
    以及 `sfx/sfx_step_*` 这些 key。别人的账一条都不碰。
    """
    ledger = led.load_ledger(ws.EXPORTS)
    mine_hashes = {
        h for h, v in ledger["files"].items()
        if str(((v.get("origin") or {}).get("sourceKey")) or "").startswith("imported/footstep_")
    }
    mine_keys = [k for k in ledger["keys"] if k.startswith("sfx/sfx_step_")]
    mine_fps = [fp for fp, h in ledger.get("fingerprints", {}).items() if h in mine_hashes]
    for h in mine_hashes:
        ledger["files"].pop(h, None)
    for k in mine_keys:
        ledger["keys"].pop(k, None)
    for fp in mine_fps:
        ledger["fingerprints"].pop(fp, None)
    led.save_ledger(ws.EXPORTS, ledger)
    print(f"已清 台账里本次产出的 {len(mine_hashes)} 条 files / "
          f"{len(mine_keys)} 条 keys / {len(mine_fps)} 条 fingerprints")
    edited = ws.EXPORT_DIR
    if edited.exists():
        gone = [p for p in edited.glob("footstep_*") if p.is_file()]
        for p in gone:
            p.unlink()
        if gone:
            print(f"已删 edited/ 下本次产出的 {len(gone)} 个成品")


def do_import(src: Path, name: str) -> str:
    """等价于 HTTP `POST /import`：平铺落进料区，返回 sourceKey。

    重名时加 `_1`/`_2`，与 `Handler.do_import` 同规则。
    """
    ws.IMPORTED.mkdir(parents=True, exist_ok=True)
    dst = ws.IMPORTED / name
    i = 1
    while dst.exists():
        dst = ws.IMPORTED / f"{Path(name).stem}_{i}{Path(name).suffix}"
        i += 1
    dst.write_bytes(src.read_bytes())
    return f"imported/{dst.name}"


def main(argv) -> int:
    if "--clean" in argv:
        clean()
        reset_my_ledger()
        return 0

    picked = json.loads((HERE / "picked.json").read_text(encoding="utf-8"))
    all_cuts = sorted(ONESHOT.glob("*.wav"))

    # ---- 1. import：**全部**候选都进料区（用户之后要能在加工台里换）----
    #      文件名转成 ASCII 且带序号，成品名才认得出来。
    key_for_cut: dict[str, str] = {}
    n_imported = 0
    for surface, roman in ROMAN.items():
        cuts = [p for p in all_cuts if p.name.startswith(surface)]
        for i, p in enumerate(cuts, start=1):
            sk = do_import(p, f"footstep_{roman}_{i:02d}.wav")
            key_for_cut[p.name] = sk
            n_imported += 1
    print(f"[import] {n_imported} 条候选已平铺进料区 {ws.IMPORTED}")

    # ---- 2. assign：给 20 个 key 各挂一份料 ----
    assignments = led.load_assignments(ws.ASSIGNMENTS)
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    n_assigned = 0
    for surface, names in picked.items():
        for i, cut_name in enumerate(names, start=1):
            key = ws.key_id("sfx", f"{PREFIX[surface]}_{i}")
            sk = key_for_cut[cut_name]
            assignments[key] = {"sourceKey": sk, "at": now, "ext": ".wav"}
            n_assigned += 1
    led.save_assignments(ws.ASSIGNMENTS, assignments)
    print(f"[assign] {n_assigned} 个 key 已挂源 -> {ws.ASSIGNMENTS.name}")

    # ---- 3. export：加工台自己的导出（渲染 + 内容寻址 + 台账 + 改 config 的 src）----
    ledger = led.load_ledger(ws.EXPORTS)
    plan = ws.build_plan(ledger, assignments)
    print(f"[plan] {len(plan['rows'])} 行；blocked={plan['blocked']}")
    for r in plan["rows"][:3]:
        print(f"       {r['key']:34s} {r['action']}")
    if plan["blocked"]:
        for r in plan["rows"]:
            if r["action"] == "blocked":
                print(f"  ✗ {r['key']}: {r.get('why') or r.get('error')}")
        return 1

    res = ws.run_export(ledger, assignments)
    if not res.get("ok"):
        print("导出失败:", res.get("error"))
        for r in (res.get("rows") or [])[:5]:
            print("   ", r)
        return 1
    rows = res.get("rows") or []
    print(f"[export] ok，{len(rows)} 行")
    for r in rows[:4]:
        print(f"       {r['key']:34s} {r.get('action')} -> {r.get('targetSrc')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
