"""烘焙产物收束:`lighting2/<背景基名>/` → `lighting/<背景基名>/`,`meta.json` → `geometry.json`。

## 为什么

一张背景图派生出来的东西曾被切成两半放:probe 图集 / 体素卷 / 行走面深度在
`lighting/<图名>/`(角色照明实验室出),法线 / 天穹可见性 / 3D 网格 / GI 命中图在
`lighting2/<图名>/`(另一个工具 `tools/scene_relight` 出)。而后者其实是**下游**——
深度与标定本来就是实验室导出的,几何却在另一个工具里又重建了一遍。

2026-08-31 制作人拍板收束:烘焙只留一个工具、一个目录。本脚本搬存量数据。

## 搬什么

`runtime/scenes/<场景>/lighting2/<图名>/` 下的文件 → `lighting/<图名>/`,
其中 `meta.json` 改名 `geometry.json` 并把 `version` 抬到 2(载荷字节不变,
**改的只是布局与文件名** —— 已逐字节验证过搬家前后四个二进制产物完全相同)。

⚠ 老载荷没有 `depth_sha1`(v2 新增,用来抓"深度重导了但几何场没重烘")。
本脚本**不给它补**:补出来的只能是"当前深度的哈希",而当前深度未必就是当初烘它用的
那份 —— 那样等于伪造一个永远通过的门。校验器对缺这个键的老载荷跳过该检查,
等场景下次重烘时自然补上。

## 安全性

- **幂等**:目标已存在同名文件且内容相同 = 跳过;不同 = 报错退出,不覆盖。
- **只搬不删**:源目录搬空后才删空目录本身;任何一步失败都不会丢数据。
- `--dry-run` 只打印计划。
- 运行时**没有回落布局**(这次刻意不留兼容,留兼容就是留第二个真相源)——
  所以要么整批搬完,要么就没搬;搬到一半也只是那几个场景暂时"没烘",不会串台。

用法:

    sh scripts/py.sh tools/migrate_lighting_payloads.py --dry-run
    sh scripts/py.sh tools/migrate_lighting_payloads.py
    sh scripts/py.sh tools/migrate_lighting_payloads.py --scene 雾津街头
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCENES_RT = ROOT / 'public' / 'resources' / 'runtime' / 'scenes'

#: 旧文件名 → 新文件名。只有 meta.json 改名(同目录下已经有个 lighting.json,
#: 再来个 meta.json 谁也说不清是谁的 meta)。
RENAME = {'meta.json': 'geometry.json'}

#: 几何场载荷代次。与 `scene_fields.PAYLOAD_VERSION` /
#: `SceneLightingSystem.LIGHTING_GEOMETRY_VERSION` / `validator._LIGHTING_GEOMETRY_VERSION` 一致。
GEOMETRY_VERSION = 3   # v3(2026-09-01):新增 skyao_probe.bin —— 每格 4 个 f32 的天穹遮蔽矩,角色按任意法线求值。旧的 skyvis_grid.bin 降为它的派生标量。


def _plan_one(scene_dir: Path) -> list[tuple[Path, Path]]:
    """返回 [(源, 目标)];空表 = 这个场景没什么可搬的。"""
    src_root = scene_dir / 'lighting2'
    if not src_root.is_dir():
        return []
    moves: list[tuple[Path, Path]] = []
    for src in sorted(src_root.rglob('*')):
        if not src.is_file():
            continue
        rel = src.relative_to(src_root)
        # 扁平布局(rel 只有文件名)在 2026-08-30 那次迁移后应当已经不存在,
        # 但真碰上也不要静默丢掉:它没有图名可归,只能报给人看。
        if len(rel.parts) == 1:
            print(f'  ⚠ 扁平布局的散落文件,不自动搬(不知道属于哪张背景): {src}')
            continue
        dst = scene_dir / 'lighting' / rel.parent / RENAME.get(rel.name, rel.name)
        moves.append((src, dst))
    return moves


def _same_bytes(a: Path, b: Path) -> bool:
    return a.stat().st_size == b.stat().st_size and a.read_bytes() == b.read_bytes()


def _is_current_payload(geometry_json: Path) -> bool:
    """这份 `geometry.json` 是不是**收束后的 baker** 直接烘出来的(而非迁移搬来的)。"""
    try:
        return json.loads(geometry_json.read_text(encoding='utf-8')).get('version') == GEOMETRY_VERSION
    except Exception:                                # noqa: BLE001 — 读不动就当它不是
        return False


def migrate(scene_dir: Path, dry_run: bool) -> tuple[int, int]:
    """返回 (搬了几个, 跳过几个)。冲突直接抛。"""
    moved = skipped = 0
    for src, dst in _plan_one(scene_dir):
        if dst.exists():
            if _same_bytes(src, dst):
                print(f'  = 已在位,跳过 {dst.relative_to(SCENES_RT)}')
                skipped += 1
                if not dry_run:
                    src.unlink()
                continue
            # 目标是**新版 baker 直接烘出来的**(version 已经是 v2)⇒ 它比老的新,认它。
            # 这不是"内容不同就覆盖",是"目标已经是这次收束后的产物"这一个具体情形:
            # 老载荷没有 depth_sha1、version 还是 1,搬过去反而是倒退。
            if dst.name == 'geometry.json' and _is_current_payload(dst):
                print(f'  = 目标已是 v{GEOMETRY_VERSION} 新烘载荷,弃用旧的 {src.name}')
                skipped += 1
                if not dry_run:
                    src.unlink()
                continue
            raise SystemExit(
                f'目标已存在且内容不同,拒绝覆盖:\n  源 {src}\n  目标 {dst}\n'
                f'(若确认目标是新烘的,先删掉源目录再跑;本脚本不做这个判断)')
        print(f'  → {src.relative_to(SCENES_RT)}  ⇒  {dst.relative_to(SCENES_RT)}')
        if dry_run:
            moved += 1
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        if dst.name == 'geometry.json':
            m = json.loads(dst.read_text(encoding='utf-8'))
            m['version'] = GEOMETRY_VERSION
            dst.write_text(json.dumps(m, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
        moved += 1
    # 搬空之后把空目录收掉(只删空的,非空说明有没识别的东西,留着让人看见)
    if not dry_run:
        root = scene_dir / 'lighting2'
        if root.is_dir():
            for d in sorted(root.rglob('*'), reverse=True):
                if d.is_dir() and not any(d.iterdir()):
                    d.rmdir()
            if not any(root.iterdir()):
                root.rmdir()
    return moved, skipped


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    ap = argparse.ArgumentParser(prog='migrate_lighting_payloads')
    ap.add_argument('--scene', help='只迁这一个场景;缺省全部')
    ap.add_argument('--dry-run', action='store_true', help='只打印计划,不动文件')
    args = ap.parse_args()

    if not SCENES_RT.is_dir():
        raise SystemExit(f'找不到场景运行时目录: {SCENES_RT}(DVC 没拉?)')
    dirs = ([SCENES_RT / args.scene] if args.scene
            else sorted(p for p in SCENES_RT.iterdir() if p.is_dir()))
    total_moved = total_skipped = 0
    for d in dirs:
        if not (d / 'lighting2').is_dir():
            continue
        print(f'{d.name}:')
        mv, sk = migrate(d, args.dry_run)
        total_moved += mv
        total_skipped += sk
    verb = '将搬' if args.dry_run else '已搬'
    print(f'\n{verb} {total_moved} 个文件,跳过 {total_skipped} 个(已在位)。')
    if total_moved and not args.dry_run:
        print('别忘了:`dvc add public/resources/runtime` + 提交指针。')


if __name__ == '__main__':
    main()
