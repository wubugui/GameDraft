"""把场景的 `lighting` 块从 v2 迁到 v3（G-buffer / 比例法）。

## 这次迁移改的是**照明模型**，不是美术意图

所以规则很清楚：

| 键 | 处置 | 理由 |
|---|---|---|
| `sky.hemi` → `sky.profile` | **换语义** | `hemi` 是 `(1−h)+h·V` 里的混合权重，没有量纲意义；`profile` 描述天空本身长什么样 |
| `gi`（新） | 恒 **1** | 烘焙 GI 的权重。1 = 画面精确等于原画（见下） |
| `sky.intensity` / `ambient.intensity` | 恒 **0** | 解析光是**重打光时**才加的项，不是默认状态 |
| `charRefIntensity`（新） | 由反解 albedo 推 | 取代 `radianceScale` 那个补不上场的标量 |
| `day` / `placeholder` / `aoStrength` / `ratioMax` / `dehaze` / `radianceScale` / `giGain` | **删** | 见 `SceneLightingDef` 里逐条写的理由 |
| `display.ev` / `display.tonemap` | **换基线** | pass 现在输出真 HDR，旧的 `tonemap:'none'` 会整片过曝；`ev=0`+`reinhard` 精确还原原画 |
| `lights` / `fog` / `display` 其余键 / `emissive` / `shadowBias` / `characterShape` | **原样保留** | 这些是美术调出来的，迁移器一个字都不许动 |

## 为什么未调过的场景画面**精确**等于原画

烘焙期在伪世界里做 final gather，积出原画自身的辐照度 `E`，并把画拆成

    原画 = base · E + emissive          （恒等式，烘焙期有断言，实测往返 ≤ 1.1/255）

`E` 与 `emissive` 都随包发出。迁移器写 `gi = 1`、`sky = ambient = 0`，运行时算的是

    输出 = base · (1·E + 0 + 0) + emissive = 原画

⚠ 这与 v2 的 `placeholder` 恒等**是两回事**：v2 靠一个开关强行让 `S_new ≡ S_day`，
而那个恒等**只对背景成立**，于是角色被整个挡在门外（27 个场景摆灯零响应）。
这里 `gi` 是光照方程里一个有物理含义的项 —— 角色从**同一份** GI 网格里按自己的
世界位置与法线查值，走的是完全相同的那条链。

## 重打光怎么做

把 `gi` 调低、把 `sky` / `lights` 加上去。这是一条**连续**的路：`gi = 0.6` 配一点
天光，就是"保留原画大部分氛围但换个时刻"。`meta.json` 的 `runtime_fit` 给了一组
建议值 —— 那是"若要用解析天光+环境完全替换掉烘焙 GI，大约该填多少"。
它的 `rel_err` 大就说明这张画的照明有强烈局部结构（灶口、窗），两个全局基表达
不了，该摆真灯。
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.atomic_io import retry_transient                        # noqa: E402

from .geometry import SCENES_JSON, SCENES_RT                       # noqa: E402

#: 迁移器签名。工具靠它认出"这块是我写的"。
MIGRATION_TAG = 'gather-v3-2026-08-23'

#: 角色图集的实测中位线性亮度（109 张图集、3081 万不透明像素）。
#: ⚠ 通用图形学的"典型反射率 0.25"对这套暗色民俗恐怖美术差 6.5 倍。
CHARACTER_ATLAS_MEDIAN = 0.0381

#: 角色法线在世界里大致朝相机（相机俯角 45°），于是 `(1+N·up)/2 ≈ 0.854`。
#: 这正是无遮挡均匀阴天下角色的平均传输 —— 与场景侧同一个归一化约定。
CHARACTER_MEAN_TRANSFER = 0.854

#: v3 里不该再存在的键。留着 = 两套语义并存，编辑器往返还会把它们一路带回来。
DROP_KEYS = ('day', 'placeholder', 'aoStrength', 'ratioMax',
             'dehaze', 'radianceScale', 'giGain')

#: 美术调出来的，迁移器一个字都不许动。
#: ⚠ `display` 在列，但它的 `ev` / `tonemap` 两个键是例外 —— 见 `build_block`。
KEEP_KEYS = ('lights', 'fog', 'display', 'emissive', 'shadowBias', 'characterShape')

#: 显示变换的新基线。**这是被迫改的，不是调参**。
#:
#:   v3 的 pass 输出的是**真 HDR 辐射**（`to_hdr` 把原画的高光展开回去了，
#:   量程到 200），而不再是 v2 那种落在 [0,1] 的"原画×比值"。
#:   27 个场景现在写的是 `tonemap: 'none'` —— 那会让画面整片过曝到全白。
#:
#:   `reinhard` 恰好就是 `x/(1+x)`，也就是 `from_hdr` 的正向。于是
#:   `ev = 0` + `reinhard` ⇒ `linearToSrgb(from_hdr(base·E + emissive))`
#:   ⇒ **精确还原原画**。对那 27 个 `none/0` 的场景，画面与迁移前**完全一样**。
#:
#:   唯一会变的是雾津街头（`filmic` + `ev 3.32`）：那个 ev 本来就是在补 v2 管线
#:   自身的尺度（见 per-scene-exposure 决策卡），新管线里原画本来就精确还原，
#:   补偿不再需要。作者要另一种观感就从这个基线上重调。
#:
#:   `whiteKelvin` / `contrast` / `saturation` / `lift` 都在 tonemap **之后**生效，
#:   语义没变，原样保留。
DISPLAY_BASELINE = {'ev': 0.0, 'tonemap': 'reinhard'}

#: 1 wu = 多少 q 单位，由 meta.scale.scene_per_wu 给（逐场景不同）。


def read_meta(sid: str) -> dict | None:
    f = SCENES_RT / sid / 'lighting3' / 'meta.json'
    if not f.exists():
        return None
    return json.loads(f.read_text(encoding='utf-8'))


def build_block(old: dict, meta: dict) -> dict:
    """由旧块 + 烘焙 meta 造出 v3 的 lighting 块。"""
    old_sky = old.get('sky') or {}
    kelvin = old_sky.get('kelvin', 6500)

    block: dict = {
        '_migration': MIGRATION_TAG,
        # ★ gi = 1 ⇒ 输出 = base·E + emissive ≡ 原画。这不是"占位"，
        #   是光照方程里一个有物理含义的项取了它的默认值。
        'gi': 1.0,
        'sky': {
            'kelvin': kelvin,
            # ⚠ 解析天光缺省 **0**：它是重打光时才加的项。
            #   缺省给非零会和 gi=1 叠成双份照明，画面直接过曝。
            'intensity': 0.0,
            # 0 = 均匀阴天（y⁰ 通道）。
            'profile': 0.0,
        },
        'ambient': {
            'kelvin': kelvin,
            # 同上：环境反弹底缺省 0，烘焙 GI 里已经含了原画自身的反弹。
            'intensity': 0.0,
        },
    }
    for k in KEEP_KEYS:
        if k in old:
            block[k] = old[k]
    # ⚠ `display` 整体保留，但 `ev` / `tonemap` 换成新基线 —— 理由见 DISPLAY_BASELINE。
    #   不换的话 27 个 `tonemap: 'none'` 的场景会整片过曝到全白。
    if isinstance(block.get('display'), dict):
        block['display'] = {**block['display'], **DISPLAY_BASELINE}
    block.setdefault('lights', [])
    # ★ 清掉**上一版迁移器自己写进去的** `painted_*` 灯。
    #   那一版从原画检测亮斑写成点光源；现在画里的灯是 `emissive`，
    #   留着这些灯等于双份照明。只删 id 前缀匹配的 —— 作者手摆的一盏不动。
    block['lights'] = [lt for lt in block['lights']
                       if not str(lt.get('id', '')).startswith('painted_')]

    # ⚠ **不再自动写"画里的灯"**（检测亮斑那条整个作废，理由见 bake_gbuffer）。
    #   但**直射光要写**：它是烘焙期从原画反解出来的，是 `E` 的一部分，
    #   `gi=1` 时画面 ≡ 原画的前提就是运行时能重现它。
    block['lights'] = [lt for lt in block['lights'] if lt.get('id') != 'baked_sun']
    dl = meta.get('direct_light') or {}
    if dl.get('found'):
        rad = dl['radiance']
        lum = 0.2126 * rad[0] + 0.7152 * rad[1] + 0.0722 * rad[2]
        block['lights'].insert(0, {
            'id': 'baked_sun',
            'kind': 'directional',
            'enabled': True,
            'intensity': round(float(lum), 4),
            'color': [round(float(c / max(lum, 1e-9)), 4) for c in rad],
            'elevationDeg': round(float(dl['elevation_deg']), 1),
            'azimuthDeg': round(float(dl['azimuth_deg']), 1),
            'castShadow': True,
            # 作者随时可以改方向/色温/强度 —— 这只是"原画那一刻"的解。
            '_from': f"bake: std(log base) 降 {dl.get('drop', 0) * 100:.1f}%",
        })

    # 角色参考天穹：让角色的基底中位与场景的对齐。
    #   base_角色 = 图集 / (0.854 × ref) ，要它 ≈ base_场景中位
    #   ⇒ ref = 图集中位 / (0.854 × base_场景中位)
    # ⚠ 这是**推出来的**，不是拍的。手填会让角色系统性偏亮/偏暗且怎么调灯都对不上。
    a_med = float(meta['base']['median'])
    if a_med > 1e-6:
        block['charRefIntensity'] = round(
            CHARACTER_ATLAS_MEDIAN / (CHARACTER_MEAN_TRANSFER * a_med), 4)
    return block


def _lighting_span(raw: str) -> tuple[int, int] | None:
    """定位顶层 `"lighting": { … }` 的字节区间（含末尾逗号前）。"""
    key = raw.find('"lighting"')
    if key < 0:
        return None
    brace = raw.find('{', key)
    if brace < 0:
        return None
    depth = 0
    i = brace
    in_str = False
    esc = False
    while i < len(raw):
        c = raw[i]
        if in_str:
            if esc:
                esc = False
            elif c == '\\':
                esc = True
            elif c == '"':
                in_str = False
        elif c == '"':
            in_str = True
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return key, i + 1
        i += 1
    return None


def write_block(path: Path, block: dict) -> bool:
    """**定点替换** `"lighting": {...}` 这一段，其余字节原样不动。

    ⚠ 不走 `json.dumps` 整文件重写：那会把 `4000.0` 归一成 `4000`、把 CRLF 变 LF，
    在 diff 里制造几百行噪声，把真正的改动淹掉（2026-08-21 踩过，还因此误用
    `git checkout` 丢了未提交内容）。
    """
    raw = io.open(path, encoding='utf-8', newline='').read()
    span = _lighting_span(raw)
    if span is None:
        return False
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = json.dumps(block, ensure_ascii=False, indent=2)
    text = nl.join('  ' + ln if ln else ln for ln in text.split('\n')).lstrip()
    out = raw[:span[0]] + '"lighting": ' + text + raw[span[1]:]
    json.loads(out)                                   # 语法自检，坏了就不落盘
    tmp = path.with_suffix('.json.tmp')
    io.open(tmp, 'w', encoding='utf-8', newline='').write(out)
    retry_transient(os.replace, tmp, path)
    return True


def migrate(sid: str) -> str:
    path = SCENES_JSON / f'{sid}.json'
    if not path.exists():
        return 'no-scene-json'
    data = json.loads(path.read_text(encoding='utf-8'))
    old = data.get('lighting')
    if old is None:
        return 'no-lighting-block'
    meta = read_meta(sid)
    if meta is None:
        return 'no-lighting3-bake'
    block = build_block(old, meta)
    return 'migrated' if write_block(path, block) else 'write-failed'


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')       # type: ignore[union-attr]
        except Exception:                              # noqa: BLE001
            pass
    ap = argparse.ArgumentParser('scene_relight.migrate3')
    ap.add_argument('--scene', action='append')
    ap.add_argument('--all', action='store_true')
    a = ap.parse_args()
    sids = a.scene or (sorted(p.stem for p in SCENES_JSON.glob('*.json')) if a.all else [])
    if not sids:
        ap.error('要 --scene <id>（可重复）或 --all')

    tally: dict[str, int] = {}
    print(f'{"场景":<20}{"结果":<18}{"gi":>6}{"charRef":>9}{"往返p99":>9}{"建议sky":>9}{"建议amb":>9}')
    for sid in sids:
        r = migrate(sid)
        tally[r] = tally.get(r, 0) + 1
        if r == 'migrated':
            m = read_meta(sid)
            b = build_block(json.loads((SCENES_JSON / f'{sid}.json').read_text(encoding='utf-8'))
                            ['lighting'], m)
            rf = m['runtime_fit']
            print(f'{sid[:20]:<20}{r:<18}{b["gi"]:>6.1f}{b.get("charRefIntensity", 1):>9.2f}'
                  f'{m["roundtrip"]["p99_255"]:>9.3f}{rf["sky"]:>9.3f}{rf["ambient"]:>9.3f}')
        else:
            print(f'{sid[:20]:<20}{r:<18}')
    print()
    for k, v in sorted(tally.items()):
        print(f'{k}: {v}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
