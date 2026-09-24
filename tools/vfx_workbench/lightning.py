# -*- coding: utf-8 -*-
"""雷电样式：样式库 + 把一套样式套进效果资产（粒子工作台是唯一写入者）。

制作人 2026-09-24："我能不能四个都支持，然后可以随时改参数换样式"；同日给了 20 张室外参考图，定调
「效果要和这些图对齐」、「天雷一律按世界单位、摆在世界空间」。于是雷不再是离线烘好的贴图，而是**游戏里现画**：

- 样式 = 一组参数（人话名，页面照 :data:`SPEC` 生成控件）：雷的形状（斜多少、折多碎、分叉多密 / 多长……）、
  粗细与光晕（世界宽 + 屏幕下限）、回击加粗那一层、落地 / 水面电弧、雷自己的灯（落点一盏、沿雷身几段线光、
  天上一记）。库里自带几套（:data:`PRESETS`），作者可以改、另存、删（还有效果在用的删不了）。
- 套用 = 把参数写进效果：``bolts``（天上那道 ``sky`` + 贴地电弧 ``ground`` + 水面电弧 ``water``，形状种子 =
  ``generator.seed``），与画它们的几层发射器（:data:`OWNED`：主雷 / 回击加粗 / 落地电弧 / 水面电弧）。
  那几层里作者调过的时间曲线（亮度 / 颜色 / 粗细随寿命、寿命）换参数时保留。别的发射器（落点光团、火星、碎石、
  扬尘、水花……）一个字不动——同组几份要一样，用 :func:`sync_group` 从一份抄到其余几份。
- 效果里记 ``generator: {kind: 'lightning', style, seed, group?, built?}``（运行时忽略）；``built`` = 套用时的
  参数 + 种子 + 版本的哈希，与样式库对不上 = 「不是按现在的样式套用的」。
- 雷的形状 / 画法 / 灯在运行时（``src/systems/vfx/vfxBolt.ts``、``src/rendering/vfx/vfxBoltGlsl.ts``、
  ``Game.boltLightSpec``），工作台预览 bundle 同一份代码——这里只管参数与写盘。

所有写盘：效果走 ``assets.save_asset``（带基线核对）；样式库带基线核对、原子写。
"""
from __future__ import annotations

import copy
import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from . import assets

ROOT = Path(__file__).resolve().parents[2]
LIB_PATH = ROOT / "public" / "assets" / "data" / "vfx_lightning_styles.json"
#: 旧版（离线烘贴图）的生成目录：迁移时整块删掉
LEGACY_OUT_ROOT = ROOT / "public" / "resources" / "runtime" / "images" / "vfx" / "lightning"
#: 套用口径的版本：写进效果的形式变了就加一，所有效果的哈希跟着变、会被提示重新套用
GEN_VERSION = 2
#: 样式拥有的发射器 id（按这个顺序排在效果最前面）
OWNED = ("bolt", "bolt_stroke", "ground_arcs", "water_arcs")
#: 旧版（离线烘贴图）样式拥有、现画不再有的层：套用时一并拿掉（它们画的是迁移时删掉的旧贴图）
LEGACY_OWNED = ("bolt_arcs",)
#: 样式写进效果的雷（``bolts[].id``）
BOLT_IDS = ("sky", "ground", "water")
KINDS = ("bolt",)
KIND_LABEL = {"bolt": "现画天雷"}
#: 雷符那 10 道雷的组名
THUNDER_GROUP = "雷符天雷"
#: 云底高度（wu）：天上那道雷画到这为止，远在任何镜头之外
CLOUD_WU = 30000

# --------------------------------------------------------------------------- #
# 参数表（页面照它生成控件；长度一律世界单位 wu，角色高 150；像素 = 768 高标准视口的屏幕像素）
# --------------------------------------------------------------------------- #
#: type: num / int / range（两个数，前 ≤ 后）/ irange（两个整数）/ color（sRGB 0..1 三元组）
_P = lambda key, group, label, t, default, lo=None, hi=None, unit="", help="": {  # noqa: E731
    "key": key, "group": group, "label": label, "type": t, "default": default,
    **({"min": lo} if lo is not None else {}), **({"max": hi} if hi is not None else {}),
    **({"unit": unit} if unit else {}), **({"help": help} if help else {})}

SPEC: dict[str, list[dict]] = {"bolt": [
    _P("tiltDeg", "形状", "整体斜多少", "range", [0, 10], 0, 60, "度", "整道雷偏离竖直多少（每道在这个范围里随机取、左右随机）"),
    _P("bendDeg", "形状", "大弯幅度", "num", 10, 0, 45, "度", "走向绕整体方向摆动多大"),
    _P("bendLenWu", "形状", "大弯多长", "num", 700, 50, 20000, "wu", "走多远换一次大方向"),
    _P("stepWu", "形状", "大步多长", "range", [160, 320], 20, 3000, "wu", "大折之间的一步有多长"),
    _P("kinkDeg", "形状", "每步偏多少", "range", [4, 12], 0, 60, "度", "每一大步偏离走向多少"),
    _P("zigzag", "形状", "锯齿感", "num", 0.6, 0, 1, "", "下一步往反方向偏的概率：越大越像锯齿"),
    _P("roughness", "形状", "折得多碎", "num", 0.3, 0, 0.5, "", "每一级往下细分时中点往旁边折多少（小尺度的碎折）"),
    _P("detailWu", "形状", "细到多细", "num", 3, 0.5, 100, "wu", "细分到这么短为止（离得再近也不会比这更碎）"),
    _P("branchPerKWu", "分叉", "分叉多密", "num", 28, 0, 400, "根 / 1000wu", "雷身每 1000 wu 长几根分叉（大多是短枝杈）"),
    _P("branchFromWu", "分叉", "从多高开始长", "num", 150, 0, 5000, "wu", "离地这么高以上才长分叉，到它的两倍高处长满"),
    _P("branchMinWu", "分叉", "最短", "num", 15, 1, 2000, "wu", "分叉长短按幂律：短的多、长的少"),
    _P("branchMaxWu", "分叉", "最长", "num", 1600, 10, 20000, "wu"),
    _P("branchAngleDeg", "分叉", "张开角度", "range", [25, 70], 0, 89, "度", "与主干往下那个方向的夹角"),
    _P("branchIntensity", "分叉", "分叉亮度", "range", [0.3, 0.65], 0, 2, "× 主干", "根部亮度，往梢上淡到没有"),
    _P("branchWidth", "分叉", "分叉粗细", "num", 0.4, 0, 2, "× 主干"),
    _P("forkPerKWu", "分叉", "再分叉多密", "num", 10, 0, 200, "根 / 1000wu"),
    _P("forkDepth", "分叉", "最多再分几级", "int", 2, 0, 4),
    _P("lowBoostGain", "形状", "下半截加亮", "num", 1.15, 1, 4, "倍", "贴地那一段额外亮多少"),
    _P("lowBoostWu", "形状", "下半截多高", "num", 150, 0, 3000, "wu"),
    _P("coreWu", "粗细与光晕", "芯粗（世界）", "num", 1.5, 0, 60, "wu", "离得近时芯有多粗"),
    _P("coreMinPx", "粗细与光晕", "芯最细", "num", 4.5, 0, 40, "像素", "离得再远芯也不细过这么多屏幕像素（强光晕开）"),
    _P("glowWu", "粗细与光晕", "光晕宽（世界）", "num", 4, 0, 200, "wu"),
    _P("glowMinPx", "粗细与光晕", "光晕最窄", "num", 10, 0, 120, "像素"),
    _P("haloWu", "粗细与光晕", "外晕宽（世界）", "num", 20, 0, 1000, "wu"),
    _P("haloMinPx", "粗细与光晕", "外晕最窄", "num", 34, 0, 400, "像素"),
    _P("coreGain", "粗细与光晕", "芯亮度", "num", 3.5, 0, 20, "", "大于 1 = 过曝成一条平顶的白带"),
    _P("glowGain", "粗细与光晕", "光晕亮度", "num", 1.0, 0, 10),
    _P("haloGain", "粗细与光晕", "外晕亮度", "num", 0.12, 0, 4),
    _P("coreColor", "粗细与光晕", "芯色", "color", [1, 1, 1]),
    _P("glowColor", "粗细与光晕", "光晕色", "color", [0.72, 0.78, 1.0]),
    _P("strokeCoreGain", "回击加粗", "芯亮度", "num", 1.6, 0, 20, "", "劈下来和重新闪亮那几下主干再亮一层、粗一档；0 = 不加这一层"),
    _P("strokeCoreWu", "回击加粗", "芯粗（世界）", "num", 1.5, 0, 60, "wu"),
    _P("strokeCoreMinPx", "回击加粗", "芯最细", "num", 5, 0, 40, "像素"),
    _P("strokeGlowWu", "回击加粗", "光晕宽（世界）", "num", 4, 0, 200, "wu"),
    _P("strokeGlowMinPx", "回击加粗", "光晕最窄", "num", 9, 0, 120, "像素"),
    _P("strokeGlowGain", "回击加粗", "光晕亮度", "num", 0.3, 0, 10),
    _P("groundArcCount", "落地电弧", "几根", "irange", [14, 22], 0, 120, "", "落在地上：从落点贴着地面往外爬的短电弧"),
    _P("groundArcLenWu", "落地电弧", "多长", "range", [12, 85], 1, 3000, "wu"),
    _P("groundArcKinkDeg", "落地电弧", "每步偏多少", "range", [10, 35], 0, 60, "度"),
    _P("groundArcRoughness", "落地电弧", "折得多碎", "num", 0.25, 0, 0.5),
    _P("groundArcForkPerKWu", "落地电弧", "再分叉多密", "num", 20, 0, 400, "根 / 1000wu"),
    _P("groundArcIntensity", "落地电弧", "亮度", "range", [0.3, 0.8], 0, 3),
    _P("waterArcCount", "水面电弧", "几根", "irange", [16, 26], 0, 120, "", "落在水面（表面材质区的水面）：在水面上往四周爬开"),
    _P("waterArcLenWu", "水面电弧", "多长", "range", [40, 180], 1, 3000, "wu"),
    _P("waterArcKinkDeg", "水面电弧", "每步偏多少", "range", [10, 30], 0, 60, "度"),
    _P("waterArcRoughness", "水面电弧", "折得多碎", "num", 0.28, 0, 0.5),
    _P("waterArcForkPerKWu", "水面电弧", "再分叉多密", "num", 18, 0, 400, "根 / 1000wu"),
    _P("waterArcIntensity", "水面电弧", "亮度", "range", [0.4, 0.9], 0, 3),
    _P("arcCoreWu", "电弧粗细", "芯粗（世界）", "num", 0.8, 0, 30, "wu", "落地 / 水面电弧共用"),
    _P("arcCoreMinPx", "电弧粗细", "芯最细", "num", 2.0, 0, 20, "像素"),
    _P("arcGlowWu", "电弧粗细", "光晕宽（世界）", "num", 3, 0, 100, "wu"),
    _P("arcGlowMinPx", "电弧粗细", "光晕最窄", "num", 6, 0, 60, "像素"),
    _P("arcCoreGain", "电弧粗细", "芯亮度", "num", 2.2, 0, 20),
    _P("arcGlowGain", "电弧粗细", "光晕亮度", "num", 0.7, 0, 10),
    _P("arcGlowColor", "电弧粗细", "光晕色", "color", [0.72, 0.8, 1.0]),
    _P("lightKelvin", "雷的灯", "色温", "num", 11000, 2000, 30000, "K", "雷的冷白光（落雷动作写了 lightKelvin 就用那个）"),
    _P("contactGain", "雷的灯", "落点那盏", "num", 0.12, 0, 10, "× 总亮度", "贴地一盏，打出落点最亮的那一小片"),
    _P("contactHeightWu", "雷的灯", "落点灯多高", "num", 40, 0, 1000, "wu"),
    _P("contactRangeWu", "雷的灯", "落点灯作用半径", "num", 4000, 50, 50000, "wu"),
    _P("channelGain", "雷的灯", "雷身亮度", "num", 1.0, 0, 20, "× 总亮度",
       "沿着这道雷的折线一段一条线光（主干几段 + 最长的几根分叉）：整道雷的形状都在照亮周围"),
    _P("channelHeightWu", "雷的灯", "雷身发光到多高", "num", 2400, 0, 50000, "wu"),
    _P("channelRangeWu", "雷的灯", "雷身作用半径", "num", 5000, 50, 100000, "wu"),
    _P("skyGain", "雷的灯", "天上那一记", "num", 0.004, 0, 1, "× 总亮度",
       "云被照亮、整片场景一起亮一下；水面 / 湿地上按铺满天的面光反一点（菲涅耳，正看约 2%）"),
    _P("skyElevationDeg", "雷的灯", "天光仰角", "num", 65, 5, 90, "度"),
    _P("blastStrengthWu", "落地那一下", "冲击风多猛", "num", 1000, 0, 20000, "wu/s",
       "落点处往外推的峰值风速（1 m/s ≈ 88 wu/s）：吹动烟尘、纸钱与草木；只进画面，挂件 / 燃烧不吃它。0 = 不扰动"),
    _P("blastRadiusWu", "落地那一下", "冲击风多远", "num", 600, 10, 20000, "wu"),
    _P("blastSeconds", "落地那一下", "冲击风多久", "num", 1.2, 0.1, 20, "秒"),
    _P("igniteRadiusWu", "落地那一下", "点火半径", "num", 80, 0, 2000, "wu",
       "落点这么近的可燃物当场着——只点燃烧工作台里开了「雷劈能点着」的模板；0 = 不点"),
]}

_DEFAULTS = {s["key"]: s["default"] for s in SPEC["bolt"]}
#: 库里自带的几套（改过的内置样式可「恢复成预设值」）
PRESETS: list[dict] = [
    {"id": "ref_bolt", "label": "参考图天雷", "kind": "bolt", "params": dict(_DEFAULTS)},
    {"id": "ref_bolt_straight", "label": "直一点、少分叉", "kind": "bolt",
     "params": {**_DEFAULTS, "tiltDeg": [0, 6], "kinkDeg": [3, 9], "roughness": 0.24, "branchPerKWu": 12}},
    {"id": "ref_bolt_branchy", "label": "多分叉", "kind": "bolt",
     "params": {**_DEFAULTS, "branchPerKWu": 55, "branchFromWu": 100, "forkPerKWu": 18}},
]
PRESET_IDS = tuple(p["id"] for p in PRESETS)


# --------------------------------------------------------------------------- #
# 形状闸门
# --------------------------------------------------------------------------- #

def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _param(spec: dict, v: Any, where: str) -> Any:
    """一个参数过形状与范围；缺 = 缺省。越界拒（页面按 min/max 夹过，越界只可能是手改文件）。"""
    t, lo, hi = spec["type"], spec.get("min"), spec.get("max")
    if v is None:
        return copy.deepcopy(spec["default"])

    def rng(x: Any) -> Any:
        if lo is not None and x < lo or hi is not None and x > hi:
            raise ValueError(f"{where}「{spec['group']} · {spec['label']}」要在 {lo}..{hi} 之间（收到 {x}）")
        return x

    if t == "num":
        if not _is_num(v):
            raise ValueError(f"{where}「{spec['label']}」要是数")
        return rng(v)
    if t == "int":
        if not _is_num(v) or int(v) != v:
            raise ValueError(f"{where}「{spec['label']}」要是整数")
        return rng(int(v))
    if t in ("range", "irange"):
        if not (isinstance(v, list) and len(v) == 2 and all(_is_num(x) for x in v)):
            raise ValueError(f"{where}「{spec['label']}」要是两个数 [小, 大]")
        a, b = v
        if t == "irange":
            if int(a) != a or int(b) != b:
                raise ValueError(f"{where}「{spec['label']}」要是两个整数")
            a, b = int(a), int(b)
        if a > b:
            raise ValueError(f"{where}「{spec['label']}」前一个不能比后一个大（{a} > {b}）")
        return [rng(a), rng(b)]
    if t == "color":
        if not (isinstance(v, list) and len(v) == 3 and all(_is_num(x) and 0 <= x <= 1 for x in v)):
            raise ValueError(f"{where}「{spec['label']}」要是三个 0..1 的数（sRGB）")
        return list(v)
    raise ValueError(f"参数表里不认识的类型 {t!r}")


def valid_style_id(sid: Any) -> bool:
    return assets.valid_id(sid)


def normalize_style(style: Any) -> dict:
    """一套样式的形状闸门：id / 名字 / 形状模型 / 参数（补齐缺省、越界拒、多余的键丢掉）。"""
    if not isinstance(style, dict):
        raise ValueError("样式要是对象")
    sid = str(style.get("id") or "").strip()
    if not valid_style_id(sid):
        raise ValueError(f"样式 id 不合法：{style.get('id')!r}")
    kind = style.get("kind")
    if kind not in KINDS:
        raise ValueError(f"样式「{sid}」的形状模型要是 {' / '.join(KINDS)}（收到 {kind!r}）")
    raw = style.get("params") if isinstance(style.get("params"), dict) else {}
    params = {s["key"]: _param(s, raw.get(s["key"]), f"样式「{sid}」") for s in SPEC[kind]}
    if params["branchMinWu"] > params["branchMaxWu"]:
        raise ValueError(f"样式「{sid}」的分叉最短（{params['branchMinWu']}）比最长（{params['branchMaxWu']}）还长")
    label = str(style.get("label") or "").strip() or sid
    return {"id": sid, "label": label, "kind": kind, "params": params}


def normalize_library(doc: Any) -> dict:
    if not isinstance(doc, dict) or not isinstance(doc.get("styles"), list):
        raise ValueError("样式库要是 {styles: [...]}")
    styles = [normalize_style(s) for s in doc["styles"]]
    ids = [s["id"] for s in styles]
    dup = sorted({i for i in ids if ids.count(i) > 1})
    if dup:
        raise ValueError(f"样式 id 重复：{dup}")
    if not styles:
        raise ValueError("样式库里至少要有一套样式")
    out: dict = {}
    if isinstance(doc.get("_comment"), str):
        out["_comment"] = doc["_comment"]
    out["styles"] = styles
    return out


_LIB_COMMENT = ("雷电样式库：粒子工作台是唯一写入者（效果资产的 generator.style 按 id 引用这里）。"
                "雷在游戏里现画，套用 = 把这里的参数写进效果的 bolts 与那几层发射器。见 tools/vfx_workbench/lightning.py")


def default_library() -> dict:
    return normalize_library({"_comment": _LIB_COMMENT, "styles": copy.deepcopy(PRESETS)})


def load_library() -> tuple[dict | None, str]:
    """读样式库；没有文件 = 内置几套（还没写盘）。读不懂 = (None, 原因)，页面据此只读、绝不覆盖。"""
    if not LIB_PATH.is_file():
        return default_library(), ""
    try:
        return normalize_library(json.loads(LIB_PATH.read_bytes().decode("utf-8"))), ""
    except (OSError, ValueError) as e:
        return None, f"{type(e).__name__}: {e}"


def _disk_library_raw() -> Any:
    if not LIB_PATH.is_file():
        return None
    return json.loads(LIB_PATH.read_bytes().decode("utf-8"))


@assets.serialized_write
def save_library(doc: dict, base: Any = assets.UNCHECKED_BASE) -> dict:
    """样式库落盘（带基线：盘上那份相对页面载入时被外部改过就拒写，页面改动留着）。"""
    norm = normalize_library(doc)
    if base is not assets.UNCHECKED_BASE:
        disk = _disk_library_raw()
        try:
            disk_norm = normalize_library(disk) if disk is not None else None
        except ValueError:
            disk_norm = disk
        try:
            base_norm = normalize_library(base) if isinstance(base, dict) else None
        except ValueError:
            base_norm = base
        if disk_norm is not None and disk_norm != base_norm and disk_norm != norm:
            raise ValueError("样式库已被外部修改，未覆盖磁盘；页面改动仍保留，请先核对")
        if disk_norm == norm:
            return norm
    assets.atomic_write(LIB_PATH, assets.dumps(norm))
    return norm


def style_map(lib: dict) -> dict[str, dict]:
    return {s["id"]: s for s in lib["styles"]}


# --------------------------------------------------------------------------- #
# 效果资产里的 generator
# --------------------------------------------------------------------------- #

def generator_of(doc: Any) -> dict | None:
    g = doc.get("generator") if isinstance(doc, dict) else None
    return g if isinstance(g, dict) and g.get("kind") == "lightning" else None


generator_problems = assets.generator_problems


def lightning_effects() -> list[dict]:
    """盘上所有带雷电 generator 的效果（读不懂的跳过：清单只给工作台看）。"""
    out = []
    for row in assets.list_assets():
        if row.get("error"):
            continue
        try:
            doc = assets.load_asset(row["id"])
        except (OSError, ValueError):
            continue
        g = generator_of(doc)
        if g:
            out.append({"id": row["id"], "style": str(g.get("style") or ""), "seed": g.get("seed"),
                        "group": str(g.get("group") or ""), "built": str(g.get("built") or "")})
    return out


def usage(effects: list[dict] | None = None) -> dict[str, list[str]]:
    effects = lightning_effects() if effects is None else effects
    out: dict[str, list[str]] = {}
    for e in effects:
        out.setdefault(e["style"], []).append(e["id"])
    return out


def _canon_num(v: Any) -> Any:
    """哈希用的规范形：数一律当浮点（``1`` 与 ``1.0`` 同一个值；页面 JSON 会把 ``1.0`` 写成 ``1``）。"""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, list):
        return [_canon_num(x) for x in v]
    if isinstance(v, dict):
        return {k: _canon_num(x) for k, x in v.items()}
    return v


def build_hash(kind: str, params: dict, seed: int) -> str:
    key = json.dumps({"v": GEN_VERSION, "kind": kind, "params": _canon_num(params), "seed": int(seed)},
                     ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:12]


def expected_hash(style: dict, seed: int) -> str:
    return build_hash(style["kind"], style["params"], seed)


# --------------------------------------------------------------------------- #
# 参数 → 效果里的 bolts 与那几层
# --------------------------------------------------------------------------- #

#: 各层的缺省时间曲线（新长出来的那一层用；已有的那一层保留作者调过的）
_SIM = {"solver": "particle", "spawnPlacement": "shape", "initialVelocity": "configured",
        "influences": {"sceneWind": False, "wind": False, "airflow": False, "stimulus": False}, "recycle": {"mode": "none"}}
_BOLT_ALPHA = [[0, 1.0], [0.075, 1.0], [0.09, 0.4], [0.108, 0.4], [0.12, 1.0], [0.15, 0.95], [0.2, 0.45], [0.225, 0.45],
               [0.237, 1.0], [0.3, 0.9], [0.45, 0.75], [0.65, 0.45], [0.87, 0.15], [1, 0]]
_STROKE_ALPHA = [[0, 1.0], [0.075, 1.0], [0.082, 0.0], [0.113, 0.0], [0.12, 1.0], [0.15, 0.9], [0.16, 0.0], [0.23, 0.0],
                 [0.237, 1.0], [0.28, 0.85], [0.33, 0.0], [1, 0.0]]
_BOLT_TINT_LIFE = [[0, 1.0, 1.0, 1.0], [0.55, 1.0, 1.0, 1.0], [0.8, 0.86, 0.8, 1.0], [1, 0.72, 0.62, 1.0]]
LAYER_DEFAULTS: dict[str, dict] = {
    "bolt": {"alphaOverLife": _BOLT_ALPHA, "tint": [1, 0.98, 1], "tintOverLife": _BOLT_TINT_LIFE, "life": [0.46, 0.46]},
    "bolt_stroke": {"alphaOverLife": _STROKE_ALPHA, "tint": [1, 0.98, 1], "tintOverLife": _BOLT_TINT_LIFE, "life": [0.46, 0.46]},
    "ground_arcs": {"alphaOverLife": _BOLT_ALPHA, "tint": [1, 1, 1], "life": [0.46, 0.46]},
    "water_arcs": {"alphaOverLife": [[0, 1.0], [0.1, 0.9], [0.6, 0.8], [1, 0.0]], "tint": [1, 1, 1],
                   "tintOverLife": [[0, 1.0, 1.0, 1.0], [0.5, 0.85, 0.9, 1.0], [1, 0.55, 0.62, 1.0]], "life": [0.6, 0.6]},
}


def bolts_for(params: dict, seed: int) -> list[dict]:
    """样式参数 + 种子 → 效果的 ``bolts``（天上那道 / 落地电弧 / 水面电弧）。"""
    p = params
    sky = {k: copy.deepcopy(p[k]) for k in (
        "tiltDeg", "bendDeg", "bendLenWu", "stepWu", "kinkDeg", "zigzag", "roughness", "detailWu",
        "branchPerKWu", "branchFromWu", "branchMinWu", "branchMaxWu", "branchAngleDeg", "branchIntensity",
        "branchWidth", "forkPerKWu", "forkDepth", "lowBoostGain", "lowBoostWu")}
    sky["cloudWu"] = CLOUD_WU
    light = {
        "kelvin": p["lightKelvin"],
        "contact": {"gain": p["contactGain"], "heightWu": p["contactHeightWu"], "rangeWu": p["contactRangeWu"]},
        "channel": {"gain": p["channelGain"], "heightWu": p["channelHeightWu"], "rangeWu": p["channelRangeWu"]},
        "sky": {"gain": p["skyGain"], "elevationDeg": p["skyElevationDeg"]},
    }
    surf = lambda pre: {  # noqa: E731
        "count": list(p[f"{pre}ArcCount"]), "lenWu": list(p[f"{pre}ArcLenWu"]), "kinkDeg": list(p[f"{pre}ArcKinkDeg"]),
        "roughness": p[f"{pre}ArcRoughness"], "detailWu": 2, "forkPerKWu": p[f"{pre}ArcForkPerKWu"],
        "intensity": list(p[f"{pre}ArcIntensity"])}
    impact: dict = {}
    if p["blastStrengthWu"] > 0:
        impact["blast"] = {"strengthWu": p["blastStrengthWu"], "radiusWu": p["blastRadiusWu"], "seconds": p["blastSeconds"]}
    if p["igniteRadiusWu"] > 0:
        impact["igniteRadiusWu"] = p["igniteRadiusWu"]
    s = int(seed)
    top = {"id": "sky", "kind": "sky", "seed": s, "sky": sky, "light": light}
    if impact:
        top["impact"] = impact
    return [
        top,
        {"id": "ground", "kind": "surface", "seed": s + 1, "surface": surf("ground")},
        {"id": "water", "kind": "surface", "seed": s + 2, "surface": surf("water")},
    ]


def _layer_look(p: dict, layer: str) -> dict:
    if layer == "bolt":
        return {"bolt": "sky", "part": "all", "coreWu": p["coreWu"], "coreMinPx": p["coreMinPx"], "glowWu": p["glowWu"],
                "glowMinPx": p["glowMinPx"], "haloWu": p["haloWu"], "haloMinPx": p["haloMinPx"], "coreGain": p["coreGain"],
                "glowGain": p["glowGain"], "haloGain": p["haloGain"], "coreColor": list(p["coreColor"]),
                "glowColor": list(p["glowColor"])}
    if layer == "bolt_stroke":
        return {"bolt": "sky", "part": "main", "coreWu": p["strokeCoreWu"], "coreMinPx": p["strokeCoreMinPx"],
                "glowWu": p["strokeGlowWu"], "glowMinPx": p["strokeGlowMinPx"], "coreGain": p["strokeCoreGain"],
                "glowGain": p["strokeGlowGain"], "coreColor": list(p["coreColor"]), "glowColor": list(p["glowColor"])}
    return {"bolt": "ground" if layer == "ground_arcs" else "water", "part": "all", "coreWu": p["arcCoreWu"],
            "coreMinPx": p["arcCoreMinPx"], "glowWu": p["arcGlowWu"], "glowMinPx": p["arcGlowMinPx"],
            "coreGain": p["arcCoreGain"], "glowGain": p["arcGlowGain"], "coreColor": list(p["coreColor"]),
            "glowColor": list(p["arcGlowColor"])}


def _emitter_skeleton(layer: str) -> dict:
    d = LAYER_DEFAULTS[layer]
    ap: dict = {"sizeWu": 1, "alphaOverLife": copy.deepcopy(d["alphaOverLife"]), "tint": list(d["tint"])}
    if "tintOverLife" in d:
        ap["tintOverLife"] = copy.deepcopy(d["tintOverLife"])
    ap.update({"blend": "add", "lit": False})
    em = {"id": layer, "simulation": copy.deepcopy(_SIM), "offset": [0, 0, 0], "appearance": ap,
          "spawn": {"max": 1, "burst": 1, "shape": {"kind": "point"}, "speed": [0, 0]},
          "motion": {}, "life": {"seconds": list(d["life"])}}
    if layer == "ground_arcs":
        em["onSurface"] = ["ground"]
    elif layer == "water_arcs":
        em["onSurface"] = ["water"]
    return em


def apply_style(doc: dict, style: dict, seed: int) -> dict:
    """把一套样式套进效果：``bolts`` 换成这套参数的，样式那几层按 :data:`OWNED` 的顺序排最前、只换
    ``appearance.bolt``（作者调过的曲线 / 寿命 / onSurface 留着；新长出来的层用缺省），别的发射器原样、原顺序跟在后面。
    回击加粗亮度为 0 = 不要那一层（拿掉）。"""
    out = copy.deepcopy(doc)
    p = style["params"]
    ems = [e for e in (out.get("emitters") or []) if isinstance(e, dict)]
    prev = {e.get("id"): e for e in ems if e.get("id") in OWNED}
    made = []
    for layer in OWNED:
        if layer == "bolt_stroke" and not p["strokeCoreGain"] > 0:
            continue
        old = prev.get(layer)
        em = copy.deepcopy(old) if old is not None and isinstance(old.get("appearance"), dict) \
            and "bolt" in old["appearance"] else _emitter_skeleton(layer)
        ap = em["appearance"]
        for k in ("animFile", "image", "state", "restState", "frameRate"):
            ap.pop(k, None)
        ap["sizeWu"] = ap.get("sizeWu") if _is_num(ap.get("sizeWu")) and ap["sizeWu"] > 0 else 1
        ap["bolt"] = _layer_look(p, layer)
        made.append(em)
    out["emitters"] = made + [e for e in ems if e.get("id") not in OWNED and e.get("id") not in LEGACY_OWNED]
    others = [b for b in (out.get("bolts") or []) if isinstance(b, dict) and b.get("id") not in BOLT_IDS]
    out["bolts"] = bolts_for(p, seed) + others
    g = dict(out.get("generator") or {})
    g["style"] = style["id"]
    g["seed"] = int(seed)
    g["built"] = expected_hash(style, seed)
    out["generator"] = g
    return out


# --------------------------------------------------------------------------- #
# 套用 / 同组同步
# --------------------------------------------------------------------------- #

def reapply(effect_ids: list[str], lib: dict, assign: dict[str, str] | None = None) -> list[dict]:
    """把这批效果按样式重新套用并落盘：``assign`` = {效果 id: 新样式 id}（换样式），其余按各自现有的样式。
    一份失败不回滚已经成功的（每份都是完整一致的状态），失败的原样留着、错误带回。"""
    styles = style_map(lib)
    assign = assign or {}
    results = []
    for eid in effect_ids:
        try:
            disk = assets.load_asset(eid)
            if disk is None:
                raise FileNotFoundError(f"效果「{eid}」不存在")
            g = dict(generator_of(disk) or {})
            if not g:
                raise ValueError(f"效果「{eid}」没有雷电生成器（generator.kind = lightning）")
            sid = assign.get(eid, g.get("style"))
            style = styles.get(sid)
            if style is None:
                raise ValueError(f"效果「{eid}」用的样式「{sid}」不在样式库里")
            new = apply_style(disk, style, int(g["seed"]))
            _p, norm, warn = assets.save_asset(new, base=disk)
            results.append({"id": eid, "ok": True, "hash": norm["generator"]["built"], "doc": norm, "warnings": warn})
        except Exception as e:  # noqa: BLE001 — 一份失败不拖垮整批，错误原样带回
            results.append({"id": eid, "ok": False, "err": f"{type(e).__name__}: {e}"})
    return results


def apply(library: dict, base: Any, assign: dict[str, str] | None = None,
          regenerate_ids: list[str] | None = None) -> dict:
    """工作台「套用」：先存样式库（带基线），再把受影响的效果全部按样式重新套用、落盘。

    受影响 = ``assign`` 里的 + ``regenerate_ids`` + 盘上所有用着被改过的样式（哈希对不上）的效果。
    """
    lib = normalize_library(library)
    assign = {str(k): str(v) for k, v in (assign or {}).items()}
    styles = style_map(lib)
    for eid, sid in assign.items():
        if sid not in styles:
            raise ValueError(f"「{eid}」要换成的样式「{sid}」不在样式库里")
    effects = lightning_effects()
    for e in effects:
        sid = assign.get(e["id"], e["style"])
        if sid not in styles:
            raise ValueError(f"样式「{sid}」还被「{e['id']}」用着，不能删（先把它换成别的样式）")
    old_lib, err = load_library()
    if err and LIB_PATH.is_file():
        raise ValueError(f"盘上样式库读不懂，不覆盖它：{err}")
    saved = save_library(lib, base)
    targets = []
    for e in effects:
        sid = assign.get(e["id"], e["style"])
        want = expected_hash(styles[sid], int(e["seed"])) if isinstance(e["seed"], int) else ""
        if e["id"] in assign or e["id"] in (regenerate_ids or []) or e["built"] != want:
            targets.append(e["id"])
    for eid in regenerate_ids or []:
        if eid not in targets:
            targets.append(eid)
    res = reapply(targets, saved, assign)
    return {"library": saved, "results": res, "usage": usage()}


def progress() -> dict:
    """套用是同步写盘（没有烘焙），不需要进度；留着这个口子给页面的旧轮询。"""
    return {"running": False, "done": 0, "total": 0, "current": "", "err": ""}


def sync_group(source_id: str) -> list[dict]:
    """把 ``source_id`` 这份效果里**样式以外**的那几层（落点光团、火星、碎石、扬尘、水花……）与预热设置
    抄到同组的其余几份：同组几份的样式层各自保留（形状种子不同），其余层与来源逐字相同。"""
    src = assets.load_asset(source_id)
    g = generator_of(src)
    if not g or not str(g.get("group") or "").strip():
        raise ValueError(f"「{source_id}」不在任何雷电样式组里")
    group = str(g["group"])
    extra = [copy.deepcopy(e) for e in (src.get("emitters") or []) if isinstance(e, dict) and e.get("id") not in OWNED]
    results = []
    for e in lightning_effects():
        if e["group"] != group or e["id"] == source_id:
            continue
        try:
            disk = assets.load_asset(e["id"])
            doc = copy.deepcopy(disk)
            own = [x for x in (doc.get("emitters") or []) if isinstance(x, dict) and x.get("id") in OWNED]
            doc["emitters"] = own + copy.deepcopy(extra)
            for k in ("prewarmSeconds",):
                if k in src:
                    doc[k] = copy.deepcopy(src[k])
                else:
                    doc.pop(k, None)
            if doc == disk:
                results.append({"id": e["id"], "ok": True, "changed": False})
                continue
            _p, norm, warn = assets.save_asset(doc, base=disk)
            results.append({"id": e["id"], "ok": True, "changed": True, "doc": norm, "warnings": warn})
        except Exception as ex:  # noqa: BLE001
            results.append({"id": e["id"], "ok": False, "err": f"{type(ex).__name__}: {ex}"})
    return results


# --------------------------------------------------------------------------- #
# 命令行（迁移 / 重新套用 / 检查）
# --------------------------------------------------------------------------- #

def migrate_to_bolt(default_style: str = "ref_bolt") -> list[dict]:
    """从离线烘贴图的旧版迁到现画：样式库换成内置几套、所有带生成器的效果按 ``default_style`` 重新套用、
    旧生成目录整块删掉。旧样式库读不懂（旧的形状模型）不算错——正是要换掉它。"""
    lib = save_library(default_library())
    ids = []
    for row in assets.list_assets():
        if row.get("error"):
            continue
        doc = assets.load_asset(row["id"])
        g = doc.get("generator") if isinstance(doc, dict) else None
        if isinstance(g, dict) and g.get("kind") == "lightning":
            ids.append(row["id"])
    res = reapply(ids, lib, {i: default_style for i in ids})
    if LEGACY_OUT_ROOT.is_dir():
        shutil.rmtree(LEGACY_OUT_ROOT, ignore_errors=True)
    return res


def status_rows() -> list[dict]:
    lib, err = load_library()
    if err:
        raise ValueError(err)
    styles = style_map(lib)
    rows = []
    for e in lightning_effects():
        st = styles.get(e["style"])
        want = expected_hash(st, int(e["seed"])) if st else ""
        rows.append({**e, "expected": want, "upToDate": bool(st) and e["built"] == want})
    return rows


def main(argv: list[str] | None = None) -> int:
    import argparse
    ap = argparse.ArgumentParser(description="雷电样式：迁移 / 重新套用 / 检查（作者面是粒子工作台）")
    ap.add_argument("--migrate-bolt", action="store_true", help="从离线烘贴图的旧版迁到现画（一次性）")
    ap.add_argument("--reapply", nargs="*", metavar="EFFECT", help="重新套用这些效果（不给 = 所有带生成器的）")
    ap.add_argument("--sync-group", metavar="EFFECT", help="把这份效果样式以外的那几层抄给同组其余几份")
    ap.add_argument("--check", action="store_true", help="列出每份效果是不是按现在的样式套用的；有过期的退出码 1")
    a = ap.parse_args(argv)
    if a.migrate_bolt:
        for r in migrate_to_bolt():
            print(r["id"], "ok" if r["ok"] else r["err"], r.get("hash", ""))
        return 0
    if a.sync_group:
        bad = 0
        for r in sync_group(a.sync_group):
            bad += 0 if r["ok"] else 1
            print(r["id"], ("改了" if r.get("changed") else "本来就一样") if r["ok"] else r["err"])
        return 1 if bad else 0
    if a.reapply is not None:
        lib, err = load_library()
        if err:
            print("样式库读不懂：", err)
            return 2
        ids = a.reapply or [e["id"] for e in lightning_effects()]
        bad = 0
        for r in reapply(ids, lib):
            bad += 0 if r["ok"] else 1
            print(r["id"], "ok" if r["ok"] else r["err"], r.get("hash", ""))
        return 1 if bad else 0
    rows = status_rows()
    stale = [r for r in rows if not r["upToDate"]]
    for r in rows:
        # 只用中文与 ASCII：Windows 控制台是 GBK，✓ / ✗ 这类符号直接 UnicodeEncodeError
        print(f"{r['id']:<24} {r['style']:<20} 种子 {r['seed']:<6} {'最新' if r['upToDate'] else '过期，需要重新套用'}")
    return 1 if (a.check and stale) else 0


if __name__ == "__main__":
    raise SystemExit(main())
