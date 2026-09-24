"""效果资产里的「雷」（``bolts[]`` 与画它的发射器 ``appearance.bolt``、发射器 ``onSurface``）的形状闸门。

粒子工作台的写盘闸门（``tools/vfx_workbench/assets.py normalize_effect``）与主编辑器的校验器
（``validator._validate_vfx_effects``）共用这一份，TS 权威在 ``src/data/types.ts`` 的
``VfxBoltDef`` / ``VfxBoltLayerDef`` / ``VfxEmitterDef.onSurface``。零 Qt 依赖。

运行时对这些内容错一律静默（引用的雷不存在 = 那层不画；参数不是数 = 形状算出 NaN 整道雷消失），
画面上都是"雷没出来"，只能在写盘 / 构建期拦。
"""

from __future__ import annotations

from typing import Any

BOLT_KINDS = ("sky", "surface")
SURFACE_KINDS = ("ground", "water")
LAYER_PARTS = ("all", "main")

#: 天上那道雷的形状参数：名字 → (种类, 下限, 上限)。种类 ``range`` = [a, b] 两个数
SKY_FIELDS: dict[str, tuple[str, float, float]] = {
    "tiltDeg": ("range", 0, 75),
    "bendDeg": ("num", 0, 60),
    "bendLenWu": ("num", 1, 1e6),
    "stepWu": ("range", 1, 5000),
    "kinkDeg": ("range", 0, 80),
    "zigzag": ("num", 0, 1),
    "roughness": ("num", 0, 0.5),
    "detailWu": ("num", 0.5, 500),
    "branchPerKWu": ("num", 0, 1000),
    "branchFromWu": ("num", 0, 1e6),
    "branchMinWu": ("num", 0.5, 1e5),
    "branchMaxWu": ("num", 1, 1e5),
    "branchAngleDeg": ("range", 0, 90),
    "branchIntensity": ("range", 0, 4),
    "branchWidth": ("num", 0, 4),
    "forkPerKWu": ("num", 0, 1000),
    "forkDepth": ("int", 0, 4),
    "lowBoostGain": ("num", 0, 10),
    "lowBoostWu": ("num", 0, 1e5),
    "cloudWu": ("num", 10, 1e7),
}

#: 贴地 / 水面电弧的形状参数
SURFACE_FIELDS: dict[str, tuple[str, float, float]] = {
    "count": ("range", 0, 200),
    "lenWu": ("range", 1, 1e5),
    "kinkDeg": ("range", 0, 80),
    "roughness": ("num", 0, 0.5),
    "detailWu": ("num", 0.5, 500),
    "forkPerKWu": ("num", 0, 1000),
    "intensity": ("range", 0, 4),
}

#: 画雷的一层（``appearance.bolt``）：必填的数
LAYER_REQUIRED: dict[str, tuple[float, float]] = {
    "coreWu": (0, 1000), "coreMinPx": (0, 200), "glowWu": (0, 1000), "glowMinPx": (0, 400),
    "coreGain": (0, 100), "glowGain": (0, 100),
}
LAYER_OPTIONAL: dict[str, tuple[float, float]] = {
    "haloWu": (0, 5000), "haloMinPx": (0, 1000), "haloGain": (0, 100),
}


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))


def _rgb(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 3 and all(_num(x) and 0 <= x <= 16 for x in v)


def _check_params(obj: Any, spec: dict[str, tuple[str, float, float]], where: str) -> list[str]:
    if not isinstance(obj, dict):
        return [f"{where} 要是对象"]
    out: list[str] = []
    for name, (kind, lo, hi) in spec.items():
        v = obj.get(name)
        if kind == "range":
            if not (isinstance(v, list) and len(v) == 2 and all(_num(x) and lo <= x <= hi for x in v)):
                out.append(f"{where}.{name} 须为两个 {lo:g}..{hi:g} 之间的数 [下, 上]")
        elif kind == "int":
            if not (_num(v) and float(v).is_integer() and lo <= v <= hi):
                out.append(f"{where}.{name} 须为 {lo:g}..{hi:g} 的整数")
        elif not (_num(v) and lo <= v <= hi):
            out.append(f"{where}.{name} 须为 {lo:g}..{hi:g} 的数")
    return out


def _check_light(light: Any, where: str) -> list[str]:
    if not isinstance(light, dict):
        return [f"{where} 要是对象"]
    out: list[str] = []
    if "kelvin" in light and not (_num(light["kelvin"]) and 1000 <= light["kelvin"] <= 40000):
        out.append(f"{where}.kelvin 须为 1000..40000 的色温")
    for part, keys in (("contact", ("gain", "heightWu", "rangeWu")), ("channel", ("gain", "heightWu", "rangeWu")),
                       ("sky", ("gain", "elevationDeg"))):
        if part not in light:
            continue
        p = light[part]
        if not isinstance(p, dict):
            out.append(f"{where}.{part} 要是对象")
            continue
        for k in keys:
            if not (_num(p.get(k)) and p.get(k) >= 0):
                out.append(f"{where}.{part}.{k} 须为 ≥ 0 的数")
    return out


def _check_impact(im: Any, where: str) -> list[str]:
    """落地那一下：``blast``（冲击风，三项必填 > 0）+ ``igniteRadiusWu``（≥ 0，0 = 不点）。"""
    if not isinstance(im, dict):
        return [f"{where} 要是对象"]
    out: list[str] = []
    if "blast" in im:
        b = im["blast"]
        if not isinstance(b, dict):
            out.append(f"{where}.blast 要是对象")
        else:
            for k, hi in (("strengthWu", 1e5), ("radiusWu", 1e5), ("seconds", 60)):
                if not (_num(b.get(k)) and 0 < b[k] <= hi):
                    out.append(f"{where}.blast.{k} 须为 (0, {hi:g}] 的数")
    if "igniteRadiusWu" in im and not (_num(im["igniteRadiusWu"]) and 0 <= im["igniteRadiusWu"] <= 1e4):
        out.append(f"{where}.igniteRadiusWu 须为 0..10000 的数（0 = 不点火）")
    return out


def bolt_def_problems(bolts: Any) -> list[str]:
    """效果顶层 ``bolts`` 的问题（空表 = 没问题）。"""
    if bolts is None:
        return []
    if not isinstance(bolts, list):
        return ["bolts 要是数组"]
    out: list[str] = []
    seen: set[str] = set()
    for i, b in enumerate(bolts):
        if not isinstance(b, dict):
            out.append(f"bolts[{i}] 不是对象")
            continue
        bid = str(b.get("id") or "").strip()
        where = f"雷「{bid or i}」"
        if not bid:
            out.append(f"bolts[{i}] 缺 id")
        elif bid in seen:
            out.append(f"{where} 的 id 重复")
        seen.add(bid)
        kind = b.get("kind")
        if kind not in BOLT_KINDS:
            out.append(f"{where} 的 kind 只能是 sky（天上劈下来）/ surface（贴地爬开的电弧）")
            continue
        if "seed" in b and not _num(b["seed"]):
            out.append(f"{where} 的 seed 要是数")
        if kind == "sky":
            out += _check_params(b.get("sky"), SKY_FIELDS, f"{where}.sky")
            sky = b.get("sky") if isinstance(b.get("sky"), dict) else {}
            if _num(sky.get("branchMinWu")) and _num(sky.get("branchMaxWu")) and sky["branchMinWu"] > sky["branchMaxWu"]:
                out.append(f"{where}.sky 的 branchMinWu 大于 branchMaxWu")
        else:
            out += _check_params(b.get("surface"), SURFACE_FIELDS, f"{where}.surface")
        if "light" in b:
            if kind != "sky":
                out.append(f"{where} 是贴地电弧，不带灯（灯写在天上那道雷上）")
            else:
                out += _check_light(b["light"], f"{where}.light")
        if "impact" in b:
            if kind != "sky":
                out.append(f"{where} 是贴地电弧，没有落地那一下（冲击风 / 点火写在天上那道雷上）")
            else:
                out += _check_impact(b["impact"], f"{where}.impact")
    return out


def bolt_layer_problems(layer: Any, bolt_ids: set[str], where: str) -> list[str]:
    """发射器 ``appearance.bolt`` 的问题。"""
    if not isinstance(layer, dict):
        return [f"{where}.bolt 要是对象"]
    out: list[str] = []
    ref = str(layer.get("bolt") or "").strip()
    if not ref:
        out.append(f"{where}.bolt 缺 bolt（画哪道雷）")
    elif ref not in bolt_ids:
        out.append(f"{where}.bolt 引用的雷「{ref}」不在这份效果的 bolts 里（运行时整层不画）")
    if "part" in layer and layer["part"] not in LAYER_PARTS:
        out.append(f"{where}.bolt.part 只能是 all（主干 + 分叉）/ main（只主干）")
    for k, (lo, hi) in LAYER_REQUIRED.items():
        if not (_num(layer.get(k)) and lo <= layer[k] <= hi):
            out.append(f"{where}.bolt.{k} 须为 {lo:g}..{hi:g} 的数")
    for k, (lo, hi) in LAYER_OPTIONAL.items():
        if k in layer and not (_num(layer[k]) and lo <= layer[k] <= hi):
            out.append(f"{where}.bolt.{k} 须为 {lo:g}..{hi:g} 的数")
    if not _rgb(layer.get("glowColor")):
        out.append(f"{where}.bolt.glowColor 须为三个数 [r, g, b]")
    if "coreColor" in layer and not _rgb(layer["coreColor"]):
        out.append(f"{where}.bolt.coreColor 须为三个数 [r, g, b]")
    return out


def on_surface_problems(v: Any, where: str) -> list[str]:
    if v is None:
        return []
    if not isinstance(v, list) or not v or any(x not in SURFACE_KINDS for x in v) or len(set(v)) != len(v):
        return [f"{where}.onSurface 须为不重复的 ground / water 数组（不写 = 哪都发）"]
    return []


def effect_bolt_problems(effect: Any) -> list[str]:
    """整份效果里与雷有关的问题：``bolts`` 本身 + 每个发射器的 ``appearance.bolt`` / ``onSurface``。"""
    if not isinstance(effect, dict):
        return []
    out = bolt_def_problems(effect.get("bolts"))
    ids = {str(b.get("id")) for b in (effect.get("bolts") or []) if isinstance(b, dict) and b.get("id")}
    for e in effect.get("emitters") or []:
        if not isinstance(e, dict):
            continue
        where = f"发射器「{e.get('id')}」"
        ap = e.get("appearance")
        if isinstance(ap, dict) and "bolt" in ap:
            out += bolt_layer_problems(ap["bolt"], ids, f"{where} appearance")
        out += on_surface_problems(e.get("onSurface"), where)
    return out
