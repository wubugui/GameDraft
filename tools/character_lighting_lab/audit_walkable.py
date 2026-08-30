"""出生点 / 过场移动目标的可走性体检 —— `./dev.sh audit-walkable`

为什么要单独一道门:给一张**原本没有碰撞**的场景导出 depthConfig,等于第一次给它装上墙。
出生点、`moveEntityTo` 的目标点、NPC 巡逻点这些坐标当初是在"哪儿都能站"的前提下摆的,
装上墙之后可能正好落在墙里——**运行时不会报错**,只会表现为"人卡住不动 / 过场走不到位
就卡死在那一步"。所以每次给场景新增或重导碰撞,都要把这些点重新过一遍。

判据与运行时同源:`SceneDepthSystem.isCollision` 的反投影口径——
世界 (wx,wy) → 行走面深度 d → M-world (X,Z) → 碰撞格 (gi,gj) → 红通道 255 即阻挡。
这里用 CPU 复刻同一条链路(读 lighting/ground_d.png 取 d,读 collision.png 取格子)。
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SCENES = ROOT / 'public' / 'assets' / 'scenes'
RUNTIME = ROOT / 'public' / 'resources' / 'runtime' / 'scenes'

def _bake_dir(scene_id, runtime_root, scenes_root):
    """该场景当前背景对应的烘焙目录(2026-08-30「背景与烘焙绑死」);找不到回落扁平布局。"""
    import json as _json
    from pathlib import PurePosixPath
    d = runtime_root / scene_id / 'lighting'
    sj = scenes_root / (str(scene_id) + '.json')
    if sj.exists():
        try:
            bgs = (_json.loads(sj.read_text(encoding='utf-8')).get('backgrounds') or [])
            img = bgs[0].get('image') if bgs and isinstance(bgs[0], dict) else None
            if isinstance(img, str) and img.strip():
                k = PurePosixPath(img.replace(chr(92), '/')).stem
                if k and (d / k / 'lighting.json').exists():
                    return d / k
        except Exception:
            pass
    return d


# --suggest：给每个阻挡落点附一个最近可走点。**只报不改**——落点是内容，
# NPC 站在"墙里"有时是有意的（站台阶上、碰撞格粗），批量吸附会把摆好的人打散。
SUGGEST = False

# --npc：把**全部** NPC 落点也拿去查(默认只查配了 collisionPolygon 的那些)。纯自查用:
# 普通 NPC 站在阻挡格里没有任何运行时后果,详见 check_scene 里那段证据注释。
LIST_NPC = False


def _ground_sampler(scene_id: str):
    """lighting/ground_d.png (RG16) → f(u,v)->depth；无载荷返回 None"""
    meta_p = _bake_dir(scene_id, RUNTIME, SCENES) / 'lighting.json'
    png_p = _bake_dir(scene_id, RUNTIME, SCENES) / 'ground_d.png'
    if not (meta_p.exists() and png_p.exists()):
        return None
    meta = json.loads(meta_p.read_text(encoding='utf-8'))
    gd = meta.get('ground_d')
    if not gd:
        return None
    arr = np.asarray(Image.open(png_p).convert('RGB'), np.float32)
    lo, hi = float(gd['min']), float(gd['max'])
    t = (arr[:, :, 0] * 256.0 + arr[:, :, 1]) / 65535.0
    dep = lo + t * (hi - lo)
    h, w = dep.shape

    def sample(u: float, v: float) -> float:
        """u,v ∈ [0,1] → work 像素双线性（与 sampleGroundField 同式，含同样的钳制）"""
        xi = min(max(u * w, 0.0), w - 1.001)
        yi = min(max(v * h, 0.0), h - 1.001)
        x0, y0 = int(math.floor(xi)), int(math.floor(yi))
        fx, fy = xi - x0, yi - y0
        return float(
            dep[y0, x0] * (1 - fx) * (1 - fy) + dep[y0, x0 + 1] * fx * (1 - fy)
            + dep[y0 + 1, x0] * (1 - fx) * fy + dep[y0 + 1, x0 + 1] * fx * fy
        )

    return sample


def _collision_reader(scene_id: str, cfg: dict):
    col = cfg.get('collision')
    name = cfg.get('collision_map', 'collision.png')
    p = RUNTIME / scene_id / name
    if not (col and p.exists()):
        return None
    img = np.asarray(Image.open(p).convert('RGB'), np.uint8)
    gh, gw = img.shape[0], img.shape[1]
    if (gw, gh) != (col['grid_width'], col['grid_height']):
        return ('MISMATCH', gw, gh)
    blocked = img[:, :, 0] > 127

    def is_blocked(X: float, Z: float) -> bool | None:
        gi = int(math.floor((X - col['x_min']) / col['cell_size']))
        gj = int(math.floor((Z - col['z_min']) / col['cell_size']))
        if not (0 <= gi < gw and 0 <= gj < gh):
            return None                       # 界外:运行时按"不阻挡"处理
        return bool(blocked[gj, gi])

    return is_blocked


# 注：曾有一套「全库扫 moveEntityTo → 按场景归档 → 查目标是否在阻挡格」的逻辑，立意抓
# 「过场走不到位卡死」。读源码确认 Player/Npc.cutsceneUpdate **完全不查碰撞**（直接朝目标
# x+=step），目标落在阻挡格里演员照样直达、根本不卡——整套是假阳性，已删。若日后要查过场，
# 正确对象是走**普通 update（会查碰撞）**的位移（反应式/巡逻），不是 cutscene moveEntityTo。



class _Geom:
    """一张场景的反投影 + 碰撞 + 最近可走点，check 与 fix 共用同一份数学（防漂移）。"""

    def __init__(self, blocked_at, nearest_walkable, WW, HH):
        self.blocked_at = blocked_at
        self.nearest_walkable = nearest_walkable
        self.WW = WW
        self.HH = HH


def _scene_geometry(name: str, data: dict, cfg: dict) -> _Geom | str:
    """返回可复用的几何闭包；不可用时返回一句 SKIP/错误说明字符串。"""
    ground = _ground_sampler(name)
    col = _collision_reader(name, cfg)
    if ground is None:
        return '缺 lighting/ground_d —— 无法反投影，跳过'
    if col is None:
        return 'NO_COLLISION'
    if isinstance(col, tuple):
        return f'碰撞图 {col[1]}x{col[2]} 与声明不符，先修 audit-depth'

    M = cfg['M']
    R = M['R']
    ppu, cx, cy = M['ppu'], M['cx'], M['cy']
    WW = float(data.get('worldWidth') or 0)
    HH = float(data.get('worldHeight') or 0)
    if WW > 0 and HH <= 0:
        # worldHeight 允许缺省，按背景图纵横比推导（与运行时同规则）——
        # 有 3 张场景就是这样（dev_teahouse_alive / 城门口 / 梦_农家院）。
        bg = RUNTIME / name / 'background.png'
        if bg.exists():
            bw, bh = Image.open(bg).size
            HH = WW * bh / bw
    if WW <= 0 or HH <= 0:
        return 'SKIP: worldWidth 缺失且无法从背景推导'

    def blocked_at(wx: float, wy: float) -> bool | None:
        d = ground(wx / WW, wy / HH)
        sx = wx / WW * (2 * cx)
        sy = wy / HH * (2 * cy)
        px = (sx - cx) / ppu
        py = (cy - sy) / ppu
        X = R[0][0] * px + R[0][1] * py + R[0][2] * d
        Z = R[2][0] * px + R[2][1] * py + R[2][2] * d
        return col(X, Z)

    def nearest_walkable(wx: float, wy: float) -> tuple[float, float, float] | None:
        """世界平面上螺旋外扩找最近可走点 → (x, y, 距离)。"""
        step = max(WW, HH) / 400.0
        for ring in range(1, 61):
            r = ring * step
            for k in range(max(8, ring * 6)):
                a = 2 * math.pi * k / max(8, ring * 6)
                nx, ny = wx + r * math.cos(a), wy + r * math.sin(a)
                if not (0 <= nx <= WW and 0 <= ny <= HH):
                    continue
                if blocked_at(nx, ny) is False:
                    return nx, ny, r
        return None

    return _Geom(blocked_at, nearest_walkable, WW, HH)


def check_scene(scene_json: Path) -> tuple[str, list[str]]:
    name = scene_json.stem
    data = json.loads(scene_json.read_text(encoding='utf-8'))
    cfg = data.get('depthConfig')
    if not cfg:
        return name, []
    g = _scene_geometry(name, data, cfg)
    if isinstance(g, str):
        return name, ([] if g == 'NO_COLLISION' else [g])
    blocked_at, nearest_walkable = g.blocked_at, g.nearest_walkable

    issues: list[str] = []

    def probe(label: str, wx: float, wy: float) -> None:
        # 逐行对齐 SceneDepthSystem.isCollision：worldToPixel 用 2*cx/2*cy（深度图幅面），
        # py **翻 Y**（cy - sy），px/py **不乘深度**，落格用 floor。任何一处偏了都会得到
        # 完全可信但完全错误的结论——本文件第一版就是三处全错，把玩家实际站得住的出生点
        # 报成"落在阻挡格内"。
        b = blocked_at(wx, wy)
        if b is None:
            issues.append(f'{label} ({wx:.0f},{wy:.0f}) 反投影出碰撞网格范围')
            return
        if b is not True:
            return
        msg = f'{label} ({wx:.0f},{wy:.0f}) 落在**阻挡格**内'
        if SUGGEST:
            n = nearest_walkable(wx, wy)
            msg += (f' → 最近可走点 ({n[0]:.0f},{n[1]:.0f})，挪 {n[2]:.0f} 世界单位'
                    if n else ' → 附近找不到可走点(碰撞可能整体过严)')
        issues.append(msg)

    sp = data.get('spawnPoint')
    if isinstance(sp, dict):
        probe('spawnPoint', float(sp.get('x', 0)), float(sp.get('y', 0)))
    for key, v in (data.get('spawnPoints') or {}).items():
        if isinstance(v, dict):
            probe(f'spawnPoints[{key}]', float(v.get('x', 0)), float(v.get('y', 0)))
    # ⚠⚠ NPC 落点**不再无差别报**(2026-07-25 修正,读运行时源码核实)。这一项曾把 8 张
    # 场景报成"有问题",全部是假阳性——与本文件早已清理掉的 moveEntityTo 那条是**同一个
    # 陷阱**:判据本身没错,但被判对象根本不走那条代码路径。证据:
    #   · src/entities/Npc.ts 全文 0 处碰撞引用;全项目 isCollision 只有两个调用点——
    #     src/core/Game.ts:2254(玩家碰撞回调)与 src/entities/Player.ts:353。
    #   · Npc 类**没有 update()**,每帧唯一入口是 Npc.ts:601 cutsceneUpdate;静止 NPC 在
    #     里面只落到 Npc.ts:643 sprite.update(dt) 推进动画——不被推开、不卡住、不报错。
    #   · patrol 推进是 Npc.ts:637-638 的裸直线插值(this.x += nx*step),前后无任何碰撞
    #     守卫 → 起点在阻挡格里**照样走得出去**,不会原地卡死。
    #   · NPC 的 x/y **不写入**玩家碰撞:Game.ts:2260-2264 只在该 NPC 配了 collisionPolygon
    #     时才参与(utils/hotspotCollision.ts:27-28 无此字段即 return null)。
    #   · fx_* 是住在 npcs 数组里的装饰特效(无 patrol / 无 collisionPolygon /
    #     interactionRange:0 / castShadow:false),热气灯光本来就该长在灶台柱子这类阻挡几何
    #     上——摆到可走地面反而是错的。
    # 只保留**真有运行时后果**的一类:配了 collisionPolygon 的 NPC 会往玩家碰撞里写多边形,
    # 与深度图阻挡叠在一起可能把窄通道彻底封死、把玩家关在外面。
    # 注:静止 NPC 真正值得担心的是"玩家能否走进 interactionRange 触发对话",那是**可达性**
    # 问题,要拿玩家可达区做 flood fill 才测得准,不能用"落点是否阻挡"顶替。
    for npc in (data.get('npcs') or []):
        if not (isinstance(npc, dict) and 'x' in npc and 'y' in npc):
            continue
        if not (npc.get('collisionPolygon') or LIST_NPC):
            continue
        tag = '<带collisionPolygon>' if npc.get('collisionPolygon') else '<--npc 参考项>'
        probe(f"npc[{npc.get('id', '?')}]{tag}", float(npc['x']), float(npc['y']))
    # ⚠ moveEntityTo 目标**故意不查**：过场位移走 cutsceneUpdate，那条路径**完全不查碰撞**
    # （Player/Npc.cutsceneUpdate 都是直接 x+=step 走向目标，无 collidesAt）。所以目标落在
    # 阻挡格里演员照样直达、不会卡死——把它报成走位问题是彻头彻尾的假阳性。本文件早期版本
    # 犯过这个错（README「完全可信但完全错误」那条正是说它），别再加回来。
    return name, issues


def fix_spawns(scene_json: Path, apply: bool, max_move: float = float('inf')) -> tuple[str, list[str]]:
    """把落在阻挡格里的**出生点**挪到最近可走点。只动 spawnPoint / spawnPoints——
    NPC 是作者摆位（靠墙/门口常是有意），过场目标另说，都不在此函数职责内。

    出生点的定义就是"玩家该能站住并走动的落点"，落在墙里必然是 bug，挪到最近可走点
    是位移最小的正确修法。写盘走编辑器往返契约（ensure_ascii=False / indent=2 / 末尾换行 /
    不排序键），只改 x/y 数值不塞字段。
    """
    name = scene_json.stem
    data = json.loads(scene_json.read_text(encoding='utf-8'))
    cfg = data.get('depthConfig')
    if not cfg:
        return name, []
    g = _scene_geometry(name, data, cfg)
    if isinstance(g, str):
        return name, ([] if g == 'NO_COLLISION' else [f'SKIP: {g}'])

    changes: list[str] = []

    def fix_one(label: str, node: dict) -> None:
        wx, wy = float(node.get('x', 0)), float(node.get('y', 0))
        oob = not (0.0 <= wx <= g.WW and 0.0 <= wy <= g.HH)
        # 两类都得修:①落在阻挡格里;②**整个落在世界之外**(反投影出碰撞网格)。
        # ② 是真踩到的:mountain_pass 的 spawn_0 在 (1597,1538) 而世界只有 1500x941,
        # 从河边 warp 过去玩家直接落到图外——而界外运行时按"不阻挡"处理,所以人可以
        # 在虚空里乱走,既不报错也没人拦。老版本只查 `is True`,把这一类整个漏掉了。
        if not oob and g.blocked_at(wx, wy) is not True:
            return
        if oob:      # 先夹回世界内(保留原本的边缘意图),再就近吸附到可走点
            inset = max(g.WW, g.HH) * 0.02
            wx = min(max(wx, inset), g.WW - inset)
            wy = min(max(wy, inset), g.HH - inset)
            if g.blocked_at(wx, wy) is False:
                changes.append(f'{label} 越界 → 夹回 ({wx:.0f},{wy:.0f})')
                if apply:
                    node['x'] = round(wx, 2); node['y'] = round(wy, 2)
                return
        n = g.nearest_walkable(wx, wy)
        if not n:
            changes.append(f'{label} ({wx:.0f},{wy:.0f}) 阻挡，但附近找不到可走点——未改，需人工')
            return
        nx, ny, dist = n
        if dist > max_move:
            changes.append(f'{label} ({wx:.0f},{wy:.0f}) → ({nx:.0f},{ny:.0f}) 挪 {dist:.0f}'
                           f'  ⚠超出 {max_move:.0f} 阈值，**保留原样待人工复核**')
            return
        changes.append(f'{label} ({wx:.0f},{wy:.0f}) → ({nx:.0f},{ny:.0f}) 挪 {dist:.0f}')
        if apply:
            node['x'] = round(nx, 2)
            node['y'] = round(ny, 2)

    sp = data.get('spawnPoint')
    if isinstance(sp, dict):
        fix_one('spawnPoint', sp)
    for key, v in (data.get('spawnPoints') or {}).items():
        if isinstance(v, dict):
            fix_one(f'spawnPoints[{key}]', v)

    if apply and changes:
        scene_json.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n',
                              encoding='utf-8')
    return name, changes


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    global SUGGEST, LIST_NPC
    SUGGEST = '--suggest' in argv
    LIST_NPC = '--npc' in argv

    # --fix-spawns[=apply]：把阻挡的出生点挪到最近可走点。默认 dry-run（只列改动），
    # 带 apply 才真写盘。NPC / 过场目标不在此模式内。
    fix_mode = next((a for a in argv if a.startswith('--fix-spawns')), None)
    if fix_mode:
        do_apply = fix_mode.endswith('=apply')
        mm_arg = next((a for a in argv if a.startswith('--max-move=')), None)
        max_move = float(mm_arg.split('=', 1)[1]) if mm_arg else float('inf')
        only = {a for a in argv if not a.startswith('-')}
        any_change = False
        for p in sorted(SCENES.glob('*.json')):
            if only and p.stem not in only:
                continue
            nm, ch = fix_spawns(p, do_apply, max_move)
            if ch:
                any_change = True
                print(('✎ ' if do_apply else '· ') + nm)
                for c in ch:
                    print(f'    {c}')
        if not any_change:
            print('没有需要修正的出生点')
        elif not do_apply:
            print('\n(dry-run；加 =apply 真写盘：./dev.sh audit-walkable -- --fix-spawns=apply)')
        return 0
    only = {a for a in argv if not a.startswith('-')}
    bad: list[str] = []
    skipped: list[str] = []
    checked = 0
    for p in sorted(SCENES.glob('*.json')):
        if only and p.stem not in only:
            continue
        if not json.loads(p.read_text(encoding='utf-8')).get('depthConfig'):
            continue
        name, issues = check_scene(p)
        # 跳过 ≠ 通过，也 ≠ 失败：单列一档，免得"没检成"被当成"检过了"
        if issues and all(i.startswith('SKIP:') for i in issues):
            skipped.append(name)
            print(f'– {name:18s} {issues[0][5:].strip()}')
            continue
        checked += 1
        if issues:
            bad.append(name)
            print(f'✗ {name}')
            for i in issues:
                print(f'    {i}')
        else:
            print(f'✓ {name:18s} 全部落点可走')
    print(f'\n{checked} 张已检，{len(bad)} 张有问题'
          + (f': {", ".join(bad)}' if bad else '')
          + (f'；{len(skipped)} 张未能检查: {", ".join(skipped)}' if skipped else ''))
    return 1 if bad else 0


if __name__ == '__main__':
    raise SystemExit(main())
