"""把场景接进统一光影，**画面零变化**。

## 这一步在做什么

给每个还没有 `lighting` 块的场景写一份**恒等配置**：让新管线算出来的
`S_new` 与 `S_day` 逐项相等，于是

```
场景 = 原画 × clamp(S_new / S_day, 0, ratioMax) = 原画 × 1 = 原画
```

再配一条恒等的显示变换（ev=0、tonemap=none、对比/饱和=1、白平衡 6500K=(1,1,1)），
最终像素与迁移前**逐像素相同**。

## 为什么值得做

P6 要删的那批旧机制（`lightEnv` / `lightEnvCurve` / `filterId` / `shadowField` …）
是 28 个未迁移场景**唯一**的光照来源——不迁移就不能删。而"逐场景摆灯调参"是
内容工作、要美术拍板，会把删旧机制无限期挂起。

恒等迁移把这两件事**解耦**：先让所有场景都跑在新管线上（可以删旧的了），
美术再按自己的节奏逐个重调。任何时候只调一个场景，其余 27 个纹丝不动。

## 恒等是怎么成立的

运行时的两个式子（`SceneLightingPass.BAKE_FRAG`）：

```
S_day = (1 − day.hemi) + day.hemi·skyvis + day.sunIntensity·max(N·L_day, 0)
S_new = skyColor·skyIntensity·((1 − sky.hemi) + sky.hemi·mix(1, skyvis, aoStrength))
      + Σ 灯
```

令 `day.sunIntensity = 0`、无灯、`skyColor = (1,1,1)`、`skyIntensity = 1`、
`aoStrength = 1`、**`sky.hemi = day.hemi = 烘焙拟合出的 day_hemi`**，两式逐项相同。

⚠ `day.hemi` **刻意留空**。恒等要求两侧用同一个数——留空时运行时正是回落到
烘焙拟合值（`SceneLightingPass.applyParams` 的 `def.day.hemi ?? bakedDayHemi`），
与写进 `sky.hemi` 的是同一个。写出来虽然更自证，但会触发项目自己的
「day.hemi 别手填」告警，27 个场景一起响会**把警告通道淹掉**——那正是那条规则
想防的事。恒等由 `--verify` 证，不由冗余字段证。

⚠ `dehaze` 必须为 0。去霾是**故意改变原画**（把白天的大气散射除掉），
开着就不是恒等了。
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

from tools.atomic_io import retry_transient          # noqa: E402

from tools.character_lighting_lab.scene_geometry import SCENES_JSON, SCENES_RT  # noqa: E402


def identity_lighting(day_hemi: float) -> dict:
    """恒等光照块。改这里等于改"迁移后画面是否不变"，动它必须重跑 --verify。"""
    return {
        # 天光 = 白、强度 1、半球权重取烘焙拟合值 ⇒ 与 S_day 的半球项逐项相同
        'sky': {'color': [1.0, 1.0, 1.0], 'intensity': 1.0, 'hemi': day_hemi},
        # 白天参考光：日光项置 0，两边就只剩半球项。
        # ⚠ **刻意不写 day.hemi** —— 运行时缺省就回落到烘焙拟合值，与上面 sky.hemi
        #   取的是同一个数，恒等照样成立。写出来虽然更自证，但会让项目自己的
        #   「day.hemi 别手填」告警在 27 个场景上一起响，**把警告通道淹掉**
        #   —— 那正是那条规则想防的事。
        'day': {'sunIntensity': 0.0,
                'sunElevationDeg': 50.0, 'sunAzimuthDeg': 180.0},
        # 一盏灯都不摆。摆灯是美术的事，恒等迁移不替他做决定。
        'lights': [],
        # 恒等显示变换：6500K 在本仓库的色温表里正好归一为 (1,1,1)
        'display': {'ev': 0.0, 'tonemap': 'none', 'whiteKelvin': 6500.0,
                    'contrast': 1.0, 'saturation': 1.0,
                    'lift': 0.0, 'liftKelvin': 6500.0},
        'aoStrength': 1.0,
        'ratioMax': 8.0,
        # ⚠ 0：去霾是**故意改变原画**，开着就不是恒等了
        'dehaze': 0.0,
        # 灯体自发光：没有灯，写 0 表明是刻意的而不是忘了
        'emissive': {'gain': 0.0},
        # GI：没有灯时反弹光就是天光照亮的表面，加进去会让角色比迁移前亮。
        # 恒等迁移一律关掉；美术开始摆灯时再打开。
        'giGain': 0.0,
        # ★ 占位标记：背景已接新管线（零变化），但**角色仍走旧 probe 路径**。
        #   恒等只对背景成立；角色那边旧路径是烘出来的 3D 辐射场，新路径是一个标量
        #   天光项，不可能相等。作者真给这个场景摆了灯之后，删掉这个键角色才切过来。
        'placeholder': True,
        '_migration': 'identity-2026-08-21',
    }


#: `day_hemi` 的安全上限。恰好 1.0 时 `S_day = (1−1) + 1·skyvis = skyvis`，
#: 而**全封闭点的 skyvis 是 0** ⇒ S_day = 0 ⇒ 运行时那句 `sNew / max(sDay, 1e-4)`
#: 被 epsilon 兜住、比值塌成 0 ⇒ 那些像素**直接变黑**。
#: 实测 28 个场景的拟合值上限是 0.96，够不着；但拟合是在 [0,1] 的 0.02 网格上做的，
#: 1.0 是可达的，所以这里挡一道——宁可拒绝迁移，也不要静默出黑块。
MAX_SAFE_DAY_HEMI = 0.99


def baked_day_hemi(sid: str) -> float | None:
    # 2026-08-31:几何场载荷改住 `lighting/<背景基名>/geometry.json`
    #（原先是扁平的 `lighting2/meta.json`——那条路径连按图名分目录都没跟上，
    # 换过背景的场景一直读不到，静默回落到"没烘"）。
    from tools.character_lighting_lab.scene_geometry import Scene
    try:
        p = Scene(sid).bake_dir / 'geometry.json'
    except Exception:                                # noqa: BLE001 — 缺背景等,按"没烘"处理
        return None
    if not p.exists():
        return None
    try:
        m = json.loads(p.read_text(encoding='utf-8'))
    except Exception:
        return None
    v = m.get('day_hemi')
    return float(v) if isinstance(v, (int, float)) else None


def _write_json_preserving(path: Path, mutate) -> bool:
    """读—改—写，**保留原文件的换行与缩进风格**。

    ⚠ 不走 `json.dumps` 整文件重写：那会把 `4000.0` 归一成 `4000`、把 CRLF 变 LF，
    在 diff 里制造几百行噪声，把真正的改动淹掉（2026-08-21 踩过，还因此误用
    `git checkout` 丢了未提交内容）。这里只在顶层做**定点插入**。
    """
    raw = io.open(path, encoding='utf-8', newline='').read()
    data = json.loads(raw)
    block = mutate(data)
    if block is None:
        return False
    nl = '\r\n' if '\r\n' in raw else '\n'
    text = json.dumps(block, ensure_ascii=False, indent=2)
    text = nl.join('  ' + ln if ln else ln for ln in text.split('\n')).lstrip()
    # 插在顶层 `{` 之后。⚠ 不能假设后面一定有换行——紧凑（单行）JSON 也得能处理，
    # 否则 `raw.index(nl, i)` 直接抛 ValueError。真实场景文件都是多行的，
    # 但工具不该只在"文件长得好看"时才工作。
    i = raw.index('{') + 1
    k = raw.find(nl, i)
    j = (k + len(nl)) if k >= 0 else i
    if k < 0:
        text = json.dumps(block, ensure_ascii=False)      # 紧凑文件就跟着紧凑
    out = raw[:j] + '  "lighting": ' + text + ',' + (nl if k >= 0 else '') + raw[j:]
    json.loads(out)                                   # 语法自检，坏了就不落盘
    tmp = path.with_suffix('.json.tmp')
    io.open(tmp, 'w', encoding='utf-8', newline='').write(out)
    retry_transient(os.replace, tmp, path)
    return True


def migrate(sid: str, *, force: bool = False) -> str:
    path = SCENES_JSON / f'{sid}.json'
    if not path.exists():
        return 'no-scene-json'
    data = json.loads(path.read_text(encoding='utf-8'))
    if data.get('lighting') is not None and not force:
        return 'already-configured'
    if not data.get('depthConfig'):
        return 'no-depth-config'
    hemi = baked_day_hemi(sid)
    if hemi is None:
        return 'not-baked'
    if hemi > MAX_SAFE_DAY_HEMI:
        # 见 MAX_SAFE_DAY_HEMI：这种场景恒等会在全封闭处出黑块，必须人工看过再定
        return f'day-hemi-too-high({hemi:.2f})'

    def mutate(_d: dict) -> dict:
        return identity_lighting(hemi)

    return 'migrated' if _write_json_preserving(path, mutate) else 'failed'


def verify_identity(sid: str) -> dict:
    """离线验恒等：按运行时的式子算一遍 `S_new / S_day`，必须处处为 1。

    ⚠ 这里**只验数学**，不验渲染。真正的"画面逐像素相同"要进游戏取帧对比
    （`extract.pixels` 读不了浮点 RT，得走正常渲染路径 + 取屏）。
    但数学恒等是必要条件：它不成立，画面一定变；它成立而画面变了，
    问题就一定在渲染链的别处，排查面立刻缩小一个数量级。
    """
    import numpy as np
    from tools.character_lighting_lab.scene_geometry import Scene
    path = SCENES_JSON / f'{sid}.json'
    data = json.loads(path.read_text(encoding='utf-8'))
    lit = data.get('lighting')
    if not lit:
        return {'sid': sid, 'status': 'no-lighting'}
    if not lit.get('placeholder'):
        return {'sid': sid, 'status': 'hand-tuned-skip'}

    scene = Scene(sid)
    nw, _ = scene.native
    w = min(512, nw)
    h = max(1, round(scene.native[1] * w / nw))
    sky = scene.baked_skyvis((w, h))
    if sky is None:
        return {'sid': sid, 'status': 'no-skyvis'}

    # day.hemi 留空 ⇒ 运行时回落烘焙值；验证也走同一条回落，才是在验真实行为。
    #
    # ⚠ 回落必须判 **is None**，不能用 `or`。有 6 个室内场景（temple / 义庄 / 崖墓 /
    #   梦_里屋 / 梦_饭屋 / 破屋）的烘焙值正好是 **0.0**，`or` 会把它当假值跳到兜底的 0.9，
    #   于是验证器报"不是恒等 max 误差 9.0"——而运行时那边是 `??`（只对 null/undefined
    #   回落），0.0 原样透传，压根没问题。差点照着这个假报警去"修"一个好的实现。
    _dh = lit['day'].get('hemi')
    if _dh is None:
        _dh = baked_day_hemi(sid)
    day_hemi = float(_dh) if _dh is not None else 0.9
    sky_hemi = float(lit['sky']['hemi'])
    sky_int = float(lit['sky']['intensity'])
    ao = float(lit.get('aoStrength', 1.0))
    col = np.asarray(lit['sky'].get('color') or [1.0, 1.0, 1.0], np.float64)

    s_day = (1.0 - day_hemi) + day_hemi * sky
    vis = 1.0 + ao * (sky - 1.0)                      # mix(1, skyvis, ao)
    s_new = sky_int * ((1.0 - sky_hemi) + sky_hemi * vis)
    ratio = s_new / np.maximum(s_day, 1e-4)
    err = float(np.abs(ratio - 1.0).max())
    chroma = float(np.abs(col - 1.0).max())
    ok = (err < 1e-6 and chroma < 1e-9
          and lit.get('placeholder') is True
          and float(lit.get('dehaze', 1.0)) == 0.0
          and float(lit.get('giGain', 1.0)) == 0.0
          and not lit.get('lights')
          and float(lit['day']['sunIntensity']) == 0.0
          and lit['display']['tonemap'] == 'none'
          and float(lit['display']['ev']) == 0.0
          and float(lit['display']['contrast']) == 1.0
          and float(lit['display']['saturation']) == 1.0
          and float(lit['display']['whiteKelvin']) == 6500.0)
    return {'sid': sid, 'status': 'ok' if ok else 'NOT-IDENTITY',
            'max_ratio_err': err, 'day_hemi': day_hemi}


def main() -> int:
    # Windows 控制台默认 GBK，打中文/勾号会 UnicodeEncodeError 直接崩在最后一行输出上
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8')       # type: ignore[union-attr]
        except Exception:
            pass
    ap = argparse.ArgumentParser('scene_relight.migrate')
    ap.add_argument('--scene')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--force', action='store_true',
                    help='已有 lighting 块也覆盖（会**丢掉已调好的参数**，慎用）')
    ap.add_argument('--verify', action='store_true',
                    help='只验恒等，不写盘')
    a = ap.parse_args()
    sids = ([a.scene] if a.scene
            else sorted(p.stem for p in SCENES_JSON.glob('*.json')) if a.all
            else [])
    if not sids:
        ap.error('要 --scene <id> 或 --all')
    tally: dict[str, int] = {}
    if a.verify:
        bad = 0
        for sid in sids:
            r = verify_identity(sid)
            tally[r['status']] = tally.get(r['status'], 0) + 1
            if r['status'] == 'NOT-IDENTITY':
                bad += 1
                print(f"  ✗ {sid}: 不是恒等，max|S_new/S_day − 1| = {r['max_ratio_err']:.3e}")
            elif r['status'] == 'ok':
                print(f"  ✓ {sid}: 恒等（day_hemi={r['day_hemi']:.2f}，"
                      f"max 误差 {r['max_ratio_err']:.1e}）")
        print()
        for k, v in sorted(tally.items()):
            print(f'{k}: {v}')
        return 1 if bad else 0
    for sid in sids:
        r = migrate(sid, force=a.force)
        tally[r] = tally.get(r, 0) + 1
        if r == 'migrated':
            print(f'  ✓ {sid}: 恒等迁移（day_hemi={baked_day_hemi(sid):.2f}）')
        elif r != 'already-configured':
            print(f'  · {sid}: {r}')
    print()
    for k, v in sorted(tally.items()):
        print(f'{k}: {v}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
