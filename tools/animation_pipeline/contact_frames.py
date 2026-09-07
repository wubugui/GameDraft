"""从动画原画**推导**落脚帧（脚触地在第几帧），给动画包 `sockets.json` 的 `contactSlots` 当建议值。

## 落脚帧住在哪、谁说了算

落脚帧是**看着图逐帧标**的数据：住在动画包目录的 `sockets.json`（`contactSlots`，图集槽位），
在编辑器「动画浏览」页的「挂点 / 落脚帧」区勾，与挂点同一份文件、同一份图集指纹。
运行时 `SpriteEntity.isContactFrameAt` 按它决定哪一帧播脚步声；**没标的动作一律不响**。

本工具只是给人一个起点：从原画量出来、打印成人能复核的曲线，`--write` 才落盘。
落盘走编辑器同一套读写（`tools.editor.shared.animation_sockets`），所以指纹、去重、
文件删留规则与手标完全一致。

## 为什么要有这个工具，而不是手填几个数

脚步声必须响在脚真正落地的那一帧。差一帧听得出来，差半个循环（我第一版按「0 与中点」
猜的 `walk: [0, 8]`，实测真值是 `[3, 11]`）听起来就是「声音和画面对不上」，
而且**没有任何报错**——只有人耳能发现。手填的数字原画一重做就烂掉，且没人知道它当初
是怎么来的，所以把判据写成可重跑的推导。

## 判据（几何，不是拟合）

角色是**原地绘制**的（位移靠平移容器），所以整套循环共用一条地面线 = 全部帧联合 bbox 的底边。
量「贴着底边那几行有多少不透明像素」＝此刻有多少脚踩在地上：

- **跑**：有腾空期 ⇒ 该值在腾空帧**恰好为 0**。落地 = 从 0 抬起来的那一帧。信号无歧义。
- **走**：没有腾空期，双脚交替支撑 ⇒ 该值在**双脚支撑**（跨步最大）时最高。
  落地 ≈ 局部极大值。

⚠ 已知限制：若原画两条腿画得不一样高（`player_anim/walk` 的后半程整体离地面线 3–4 px），
后半程的绝对值会系统性偏低。本工具因此**分半程各取局部极大**，并把「两个落脚帧的间隔
是否≈半个循环」作为对称性自检打印出来——不对称就说明该帧要人眼复核。

## 判据的验证状态（2026-09-07）

- `player_anim/walk` → 序号 `[3, 11]`（槽位 12、20）：**已逐帧看图确认**。
  f3 与 f11 正是标准接触姿（前脚掌平贴地面线 + 后脚尖点地＝双脚支撑），
  f5 / f13 是明显的单脚支撑（摆动腿离地）。间隔 8 帧 = 半循环，对称。
- `player_anim/run` → 序号 `[5, 13]`（槽位 30、38）：腾空判据，无歧义。
- `player_carry_corpse_anim/*`：**静帧上 ±1 帧分辨不出**——那是拖沓的负重步态，
  两只脚几乎不离地。以本工具的可复现结果为准，等有了真脚步素材再用耳朵校一次。

## 用法

    sh scripts/py.sh -m tools.animation_pipeline.contact_frames                    # 全部已知步态，只打印
    sh scripts/py.sh -m tools.animation_pipeline.contact_frames player_anim walk   # 单个
    sh scripts/py.sh -m tools.animation_pipeline.contact_frames --write            # 落到各包 sockets.json

`--write` 只改目标动作用到的那些槽位（设为推导结果），其它动作的落脚帧与全部挂点原样保留。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import List, Sequence

try:
    from PIL import Image
except ImportError:  # pragma: no cover - 环境缺 Pillow 时给人话
    print('需要 Pillow：sh scripts/py.sh -m pip install pillow', file=sys.stderr)
    raise

ANIM_ROOT = os.path.join('public', 'resources', 'runtime', 'animation')

#: 缺省核查的（动画包, 片段）。新增会发声的步态时加在这里。
DEFAULT_TARGETS: Sequence[tuple[str, str]] = (
    ('player_anim', 'walk'),
    ('player_anim', 'slow_walk'),
    ('player_anim', 'run'),
    ('player_carry_corpse_anim', 'carry_walk'),
    ('player_carry_corpse_anim', 'carry_heavy_walk'),
)

#: 贴地判定取底边多少行。太小会被抗锯齿边缘骗，太大会把小腿也算进来。
GROUND_ROWS = 6
#: alpha 阈值：低于此视为透明（原画边缘有羽化）。
ALPHA_MIN = 40


def _load_anim(bundle: str, root: str) -> dict:
    p = os.path.join(root, ANIM_ROOT, bundle, 'anim.json')
    with open(p, encoding='utf-8') as fh:
        return json.load(fh)


def ground_contact_profile(bundle: str, state: str, root: str = '.') -> tuple[List[int], List[int]]:
    """返回 (逐帧贴地像素数, 逐帧最低点离地面线的像素距离)。"""
    d = _load_anim(bundle, root)
    st = d['states'][state]
    cw, ch, cols = d['cellWidth'], d['cellHeight'], d['cols']
    sheet = os.path.join(root, ANIM_ROOT, bundle, d['spritesheet'])
    img = Image.open(sheet).convert('RGBA')

    cells = []
    for f in st['frames']:
        cx, cy = (f % cols) * cw, (f // cols) * ch
        cells.append(img.crop((cx, cy, cx + cw, cy + ch)))

    boxes = [c.getbbox() for c in cells if c.getbbox()]
    if not boxes:
        return [], []
    bottom = max(b[3] for b in boxes)

    counts: List[int] = []
    lifts: List[int] = []
    for c in cells:
        px = c.load()
        cnt = 0
        for y in range(max(0, bottom - GROUND_ROWS), bottom):
            for x in range(c.width):
                if px[x, y][3] > ALPHA_MIN:
                    cnt += 1
        counts.append(cnt)
        bb = c.getbbox()
        lifts.append(bottom - bb[3] if bb else 10 ** 6)
    return counts, lifts


def derive(counts: Sequence[int]) -> tuple[List[int], str]:
    """由贴地像素曲线推出落脚帧（片段内序号）。返回 (序号列表, 用了哪条判据)。"""
    n = len(counts)
    if n == 0:
        return [], 'empty'

    # 有腾空期（存在恰好贴地为 0 的帧）：落地 = 0 → 非 0 的那一帧。信号无歧义，优先用。
    if any(c == 0 for c in counts):
        hits = [i for i in range(n) if counts[i] > 0 and counts[(i - 1) % n] == 0]
        return sorted(hits), 'flight'  # 跑

    # 无腾空期（走）：分半程各取局部极大，避开「两腿画得不一样高」带来的整体偏置
    half = n // 2
    hits = []
    for lo, hi in ((0, half), (half, n)):
        seg = range(lo, hi)
        best = max(seg, key=lambda i: counts[i])
        hits.append(best)
    return sorted(set(hits)), 'double-support'  # 走


def report(bundle: str, state: str, root: str = '.') -> tuple[List[int], List[int]]:
    """打印曲线与判定；返回 (片段内序号, 对应图集槽位)。"""
    counts, lifts = ground_contact_profile(bundle, state, root)
    if not counts:
        print('=== %s/%s  无帧' % (bundle, state))
        return [], []
    frames = [int(f) for f in _load_anim(bundle, root)['states'][state]['frames']]
    hits, rule = derive(counts)
    slots = sorted({frames[i] for i in hits})
    n = len(counts)
    mx = max(counts) or 1
    print('=== %s/%s  %d 帧  判据=%s' % (bundle, state, n, rule))
    for i, c in enumerate(counts):
        mark = '  <== 落脚' if i in hits else ''
        print('  f%-3d 槽位 %-3d 贴地 %4d  离地 %3dpx %-40s%s'
              % (i, frames[i], c, lifts[i], '#' * int(40.0 * c / mx), mark))
    print('  落脚帧序号: %s   → 图集槽位 contactSlots: %s' % (json.dumps(hits), json.dumps(slots)))
    if len(hits) == 2:
        gap = (hits[1] - hits[0]) % n
        ideal = n / 2.0
        flag = '' if abs(gap - ideal) <= 1.5 else '   ⚠ 与半循环差得多，建议人眼复核这一条'
        print('  对称性自检：两落脚帧间隔 %d，半循环 %.1f%s' % (gap, ideal, flag))
    else:
        print('  ⚠ 落脚帧数 != 2，人眼复核（正常的走/跑循环应当是两步）')
    return hits, slots


def write_contact_slots(bundle: str, state: str, slots: Sequence[int], root: str = '.') -> Path:
    """把推导结果写进 `<bundle>/sockets.json` 的 contactSlots（走编辑器同一套读写）。

    只动**这个动作用到的槽位**：属于本动作的槽位按推导结果置 on/off，
    其它动作标过的落脚帧与全部挂点原样保留。
    """
    from tools.editor.shared.animation_sockets import (
        empty_socket_set,
        load_socket_set,
        sanitize_socket_set,
        save_socket_set,
        set_contact_slot,
    )
    anim = _load_anim(bundle, root)
    path = Path(root) / ANIM_ROOT / bundle / 'sockets.json'
    data = load_socket_set(path) or empty_socket_set(anim)
    own = {int(f) for f in anim['states'][state]['frames']}
    want = set(int(s) for s in slots)
    for slot in sorted(own):
        set_contact_slot(data, slot, slot in want)
    save_socket_set(path, sanitize_socket_set(data, anim))
    return path


def main(argv: Sequence[str]) -> int:
    root = os.environ.get('GAMEDRAFT_ROOT', '.')
    args = [a for a in argv if not a.startswith('--')]
    write = '--write' in argv
    targets = DEFAULT_TARGETS
    if len(args) >= 2:
        targets = ((args[0], args[1]),)
    out: dict[str, dict[str, list[int]]] = {}
    for bundle, state in targets:
        try:
            hits, slots = report(bundle, state, root)
        except (KeyError, FileNotFoundError) as exc:
            print('=== %s/%s  跳过：%s' % (bundle, state, exc))
            print()
            continue
        out.setdefault(bundle, {})[state] = slots
        if write and slots:
            p = write_contact_slots(bundle, state, slots, root)
            print('  已写入 %s' % p)
        print()
    print('推导出的 contactSlots（按动画包 / 动作；%s）：'
          % ('已写入各包 sockets.json' if write else '只打印，加 --write 才落盘'))
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
