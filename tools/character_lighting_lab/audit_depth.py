"""深度/地形数据一致性体检 —— `./dev.sh audit-depth`

烘焙链路横跨三处落点(场景 JSON 的 depthConfig、runtime 的深度/碰撞图、
lighting/ 照明载荷),它们必须互相对得上;对不上时游戏**不会报错**,只会静静地
把角色遮挡/碰撞算错——这正是 2026-07-23 那次「所有实体遮挡全错」拖了一整晚
才被发现的原因。所以这道体检要能随时跑、跑完给硬结论。

查五类:
1. 资产存在性(背景/深度图/碰撞图/ground_d)
2. **标定与资产同尺寸**:M.cx/cy 必须是深度图半幅(不然整套反投影平移)
3. **碰撞图与网格声明同尺寸**(不然按错误的列宽读格子)
4. **照明载荷可用**:version≥2 且背景哈希未失配(否则运行时整包丢弃 → 无行走面场
   → 遮挡直接关闭)
5. 已废除字段残留(floor_depth_A/B):它们是旧遮挡模型的遗物,重烘导出即消失
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]


def audit_scene(scene_json: Path) -> tuple[str, list[str]]:
    name = scene_json.stem
    data = json.loads(scene_json.read_text(encoding='utf-8'))
    cfg = data.get('depthConfig')
    if not cfg:
        return name, []
    base = ROOT / 'public' / 'resources' / 'runtime' / 'scenes' / name
    issues: list[str] = []

    bg_path = base / 'background.png'
    depth_path = base / cfg['depth_map']
    bg = Image.open(bg_path).size if bg_path.exists() else None
    depth = Image.open(depth_path).size if depth_path.exists() else None
    if not bg:
        issues.append('缺 background.png')
    if not depth:
        issues.append(f"缺 {cfg['depth_map']}")

    M = cfg['M']
    if depth and (abs(M['cx'] - depth[0] / 2) > 1 or abs(M['cy'] - depth[1] / 2) > 1):
        issues.append(f"标定主点 ({M['cx']:.0f},{M['cy']:.0f}) ≠ 深度图半幅 "
                      f"({depth[0] / 2:.0f},{depth[1] / 2:.0f}) —— 反投影整体平移,重导深度可修")

    col = cfg.get('collision')
    col_path = base / cfg.get('collision_map', 'collision.png')
    if col and col_path.exists():
        size = Image.open(col_path).size
        if size != (col['grid_width'], col['grid_height']):
            issues.append(f"碰撞图 {size[0]}x{size[1]} ≠ 声明 "
                          f"{col['grid_width']}x{col['grid_height']} —— 会按错误列宽读格子")
    elif col:
        issues.append('缺碰撞图')

    # 烘焙产物按**当前生效的第一层背景**分目录(与运行时 bakeKeyFromBackground 同口径)。
    # ⚠ 这里一度写死成扁平的 `lighting/lighting.json`;2026-08-30 分目录之后就再也命中
    #   不了,于是本审计对 **28/28** 个场景一律报「缺 lighting/」—— 全量误报等于没有门。
    _bgs = (data.get('backgrounds') or [])
    _img = (_bgs[0].get('image') if _bgs and isinstance(_bgs[0], dict) else None) or 'background.png'
    _b = str(_img).replace(chr(92), '/').rsplit('/', 1)[-1]
    bake_dir = base / 'lighting' / (_b[:_b.rfind('.')] if _b.rfind('.') > 0 else _b)
    lighting = bake_dir / 'lighting.json'
    if not lighting.exists():
        issues.append(f'缺 {bake_dir.name}/ 的照明载荷 —— 无行走面场,运行时遮挡整体关闭')
    else:
        meta = json.loads(lighting.read_text())
        if meta.get('version', 0) < 2:
            issues.append(f"照明载荷 v{meta.get('version')} (<2 会被运行时整包丢弃)")
        if not (bake_dir / 'ground_d.png').exists():
            issues.append('缺 ground_d.png —— 遮挡脚点没有来源')
        if bg_path.exists():
            digest = hashlib.sha1(bg_path.read_bytes()).hexdigest()[:12]
            if digest != meta.get('background_sha1'):
                issues.append('照明载荷哈希失配(背景改过而没重烘)→ 运行时禁用')

    if 'floor_depth_A' in cfg.get('shader', {}):
        issues.append('仍含已废除的 floor_depth_A/B(运行时已不读;重烘导出即清)')
    return name, issues


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    strict = '--strict' in argv
    scenes = sorted((ROOT / 'public' / 'assets' / 'scenes').glob('*.json'))
    checked = 0
    bad: list[str] = []
    for p in scenes:
        name, issues = audit_scene(p)
        if not (json.loads(p.read_text(encoding='utf-8')).get('depthConfig')):
            continue
        checked += 1
        if issues:
            bad.append(name)
            print(f'✗ {name:18s} ' + '; '.join(issues))
        else:
            print(f'✓ {name:18s} OK')
    print(f'\n{checked} 张场景含 depthConfig,{len(bad)} 张有问题'
          + (f': {", ".join(bad)}' if bad else ''))
    # 只剩「已废除字段残留」时不算失败:那是等下一次重烘导出自然清掉的历史包袱
    hard = [n for n in bad
            if any('floor_depth' not in i for i in audit_scene(
                ROOT / 'public' / 'assets' / 'scenes' / f'{n}.json')[1])]
    if hard:
        print(f'其中 {len(hard)} 张是硬问题(非历史字段残留): {", ".join(hard)}')
    return 1 if (hard or (strict and bad)) else 0


if __name__ == '__main__':
    raise SystemExit(main())
