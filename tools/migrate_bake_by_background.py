"""烘焙产物迁移:扁平 `lighting/` `lighting2/` → 按背景图名分的 `<family>/<图名>/`。

## 为什么

制作人 2026-08-30 定的规矩:**场景背景与它的烘焙数据绑死**,运行时拿当前生效的背景
图名当 key 去找同名 bake。原布局是「一个场景一份、目录名写死」,于是「白天一张图、
夜里另一张图」根本没地方放第二份 —— 换背景必然错配(实测雾津街头就是这么黑掉的:
背景重画后哈希失配,整份载荷被禁用,两条角色着色路一起断)。

## 迁哪些

`runtime/scenes/<场景>/lighting/*` 与 `lighting2/*` 里的**文件**,搬进
`lighting/<背景基名>/` 与 `lighting2/<背景基名>/`。背景基名取场景 JSON 的
`backgrounds[0].image` 去扩展名(与运行时 `bakeKeyFromBackground` 同口径)。

`lighting3/` **不迁**:它是 origin/lighting-rebuild 那条已停分支的产物,master 上零引用。

## 安全性

- 幂等:已经是新布局(目录下没有散落文件)就跳过。
- 只搬不删:同名冲突时报错退出,不覆盖。
- `--dry-run` 只打印计划。

运行时在迁移期**两条布局都认**(先找新的,没有就回落扁平),所以这个脚本可以分批跑、
跑一半也不会把游戏搞坏。
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCENES_JSON = ROOT / 'public' / 'assets' / 'scenes'
SCENES_RT = ROOT / 'public' / 'resources' / 'runtime' / 'scenes'
FAMILIES = ('lighting', 'lighting2')


def bake_key(image: str) -> str:
    """与 `src/core/projectPaths.ts` 的 bakeKeyFromBackground 同口径。"""
    base = image.replace('\\', '/').split('/')[-1]
    dot = base.rfind('.')
    key = base[:dot] if dot > 0 else base
    if not key:
        raise ValueError(f'取不出烘焙基名: {image!r}')
    return key


def scene_background(sid: str) -> str | None:
    f = SCENES_JSON / f'{sid}.json'
    if not f.exists():
        return None
    data = json.loads(f.read_text(encoding='utf-8'))
    bgs = data.get('backgrounds') or []
    if not bgs or not isinstance(bgs[0], dict):
        return None
    img = bgs[0].get('image')
    return img if isinstance(img, str) and img.strip() else None


def plan_scene(sid: str) -> list[tuple[Path, Path]]:
    """返回 (源文件, 目标文件) 列表;已是新布局或无产物时返回空。"""
    img = scene_background(sid)
    if not img:
        return []
    key = bake_key(img)
    moves: list[tuple[Path, Path]] = []
    for fam in FAMILIES:
        d = SCENES_RT / sid / fam
        if not d.is_dir():
            continue
        loose = [p for p in d.iterdir() if p.is_file()]
        if not loose:
            continue                       # 已经是新布局(只剩子目录)
        dest = d / key
        for p in loose:
            moves.append((p, dest / p.name))
    return moves


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--scene', default=None, help='只迁一个场景(调试用)')
    args = ap.parse_args()

    sids = [args.scene] if args.scene else sorted(p.name for p in SCENES_RT.iterdir() if p.is_dir())
    total = 0
    for sid in sids:
        moves = plan_scene(sid)
        if not moves:
            continue
        img = scene_background(sid)
        print(f'{sid}: {len(moves)} 个文件 → {bake_key(img)}/  (背景 {img})')
        for src, dst in moves:
            if dst.exists():
                print(f'  ✗ 目标已存在,拒绝覆盖: {dst}', file=sys.stderr)
                return 2
            if not args.dry_run:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
        total += len(moves)
    print(f'{"[dry-run] 计划迁移" if args.dry_run else "已迁移"} {total} 个文件')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
