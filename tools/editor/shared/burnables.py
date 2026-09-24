"""燃烧系统的数据形状闸门（燃烧工作台 / 主编辑器 / 校验器 / 粒子工作台共用这一份）。

玩法口径 ``docs/玩法功能需求清单.md`` A3.8；运行时 ``src/data/burnables.ts``（字段语义与缺省以那里为准）；
机制 agent_docs ``burn-system`` / ``burn-workbench``。

**可燃物是模板，宿主引用它 = 实例化一次**（制作人 2026-09-16 改定）：

* 可燃物模板 ``public/assets/data/burnables/<id>.json``（``id == 文件名``）：图 / 真实尺寸（厘米）/ 握点 / 燃料 / 着火点 /
  烧法 / 粒子 / 火光——**和场景没有任何关系**。唯一写入者是燃烧工作台（``tools/burn_workbench``）；
* 宿主上的可燃配置 ``burnable: {template, initial?, playerIgnite?, igniteConditions?, signals?}``：写在宿主自己身上——
  热点 / NPC（场景 JSON，主编辑器写）、挂件预设（主编辑器挂件预设页写）、轨迹 spawn 规格（动作编辑器写）；
* 粒子薄片绑模板 ``plate.burnable: {template}``（粒子效果资产，粒子工作台写）；
* 运行态（燃烧事件 / 快照 / 烧没了的纸钱）：存档，不落数据盘。

本模块零 Qt 依赖。落盘口径与主编辑器一致：``ensure_ascii=False`` + 2 空格缩进 + 末尾换行 + 不排序键 + LF。
``normalize_*`` **只收束键序、硬拒不合法形状，绝不改数值**（int 不许漂成 float；未知键原样保留在末尾）。
"""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

BURNABLES_PARTS = ("public", "assets", "data", "burnables")
ASSETS_PARTS = ("public", "assets")
#: 游戏侧 URL（与 ``src/core/projectPaths.ts`` 同值）
BURNABLES_URL = "/assets/data/burnables"
#: 1 米 = 88 wu（与 ``src/data/burnables.ts`` 的 ``BURN_WU_PER_M`` 同值）
WU_PER_M = 88
WU_PER_CM = WU_PER_M / 100

MODES = ("spread", "consume")
ORIENTATIONS = ("upright", "ground")
CONSUME_FROM = ("top", "bottom", "left", "right")
PARTICLE_SOURCES = ("flame", "ember", "ash")
BURN_STATES = ("unburnt", "burning", "out", "burnt")
INITIAL_STATES = ("unburnt", "burning")
SIGNAL_KEYS = ("ignited", "burntOut", "extinguished")
#: 宿主种类：场景实体（热点 / NPC）/ 挂件预设 / 轨迹 spawn 规格
HOST_KINDS = ("entity", "prop", "spawn")

GRID_MIN = 16
GRID_MAX = 160

#: 缺省（与 ``src/data/burnables.ts`` 的 ``BURN_DEFAULTS`` 同值；``test_burnables_parity`` 对着 TS 源文本断言）
DEFAULTS: dict[str, Any] = {
    "gridCells": 96,
    "alphaThreshold": 0.1,
    "speedOpposed": 0.6,
    "speedConcurrent": 6,
    "consumeSeconds": 600,
    "flameWidth": 0.2,
    "flameSeconds": 3,
    "emberSeconds": 4,
    "flameLength": 12,
    "ignitionDelay": 0.5,
    "particleRefArea": 100,
}

#: 资产键序（与 ``src/data/burnables.ts`` 的 ``BurnableDef`` 逐字同序）
BURNABLE_ORDER = (
    "id", "label", "image", "widthCm", "heightCm", "grip", "mode", "orientation", "gridCells", "fuel", "ignitionPoints",
    "spread", "consume", "flameSeconds", "emberSeconds", "flameLength", "ignitionDelay", "lightningIgnites", "look", "particles",
    "light", "blowout",
)
_GRIP_ORDER = ("u", "v")
_FUEL_ORDER = ("alphaThreshold", "maskData")
_POINT_ORDER = ("id", "u", "v")
_SPREAD_ORDER = ("speedOpposed", "speedConcurrent")
_CONSUME_ORDER = ("seconds", "from", "orderData", "flameU", "flameWidth")
_LOOK_ORDER = (
    "scorchSeconds", "scorchColor", "charColor", "glowKelvin", "glowStrength", "emberKelvin", "emberStrength",
    "ashColor", "ashAlpha", "ashFadeSeconds", "edgeNoise",
)
_PARTICLE_ORDER = ("effect", "from", "refArea")
_LIGHT_ORDER = ("kelvin", "color", "intensityPerM2", "maxIntensity", "range", "softeningRadius", "puffAmp", "castShadow")
_BLOWOUT_ORDER = ("windSpeed", "drainSeconds", "recoverSeconds")
#: 宿主上的可燃配置键序（与 ``BurnableHostDef`` 同序）
HOST_ORDER = ("template", "initial", "playerIgnite", "igniteConditions", "signals")

_ID_RE = re.compile(r"^[A-Za-z0-9_\-一-鿿]+$")


class BurnShapeError(ValueError):
    """形状不合法（保存闸门硬拒）。消息是给作者看的中文。"""


# ---------------------------------------------------------------------------- 工具


def dumps(doc: Any) -> bytes:
    return (json.dumps(doc, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def burnables_dir(project_root: Path) -> Path:
    return Path(project_root).joinpath(*BURNABLES_PARTS)


def is_valid_id(s: Any) -> bool:
    return isinstance(s, str) and bool(s) and bool(_ID_RE.match(s))


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _ordered(d: dict, order: tuple[str, ...]) -> dict:
    out = {k: d[k] for k in order if k in d}
    for k, v in d.items():
        if k not in out:
            out[k] = v
    return out


def _color(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 3 and all(_is_num(x) and 0 <= x <= 1 for x in v)


# ---------------------------------------------------------------------------- 可燃物资产


def normalize_burnable(raw: Any, file_id: str | None = None) -> tuple[dict, list[str]]:
    """清洗一份可燃物资产：返回 ``(按键序收束的文档, 警告)``；形状不合法抛 ``BurnShapeError``。

    **不补缺省、不改数值**——缺省住在运行时（``resolveBurnable``），文件里只写作者写了的。
    """
    if not isinstance(raw, dict):
        raise BurnShapeError("可燃物资产必须是对象")
    warnings: list[str] = []
    doc = dict(raw)
    bid = doc.get("id")
    if not is_valid_id(bid):
        raise BurnShapeError(f"id 不合法：{bid!r}（只许字母数字 _ - 与汉字）")
    if file_id is not None and bid != file_id:
        raise BurnShapeError(f"id「{bid}」与文件名「{file_id}」不一致")
    image = doc.get("image")
    if not isinstance(image, str) or not image.strip():
        raise BurnShapeError("image 必填：模板的图（实例接管宿主渲染时画的就是它）")
    for k in ("widthCm", "heightCm"):
        if not (_is_num(doc.get(k)) and doc[k] > 0):
            raise BurnShapeError(f"{k} 必填且 > 0：模板的真实尺寸（厘米），图按它画、烧的快慢按它算")
    if "grip" in doc:
        g = doc["grip"]
        if not isinstance(g, dict) or not all(_is_num(g.get(k)) and 0 <= g[k] <= 1 for k in _GRIP_ORDER):
            raise BurnShapeError("grip 必须是 {u, v}，两项都在 0..1（挂到手上时挂点对准的点）")
        doc["grip"] = _ordered(g, _GRIP_ORDER)
    if "label" in doc and not isinstance(doc["label"], str):
        raise BurnShapeError("label 必须是字符串")
    mode = doc.get("mode", "spread")
    if mode not in MODES:
        raise BurnShapeError(f"mode 必须是 {' / '.join(MODES)}：{mode!r}")
    if "orientation" in doc and doc["orientation"] not in ORIENTATIONS:
        raise BurnShapeError(f"orientation 必须是 {' / '.join(ORIENTATIONS)}：{doc['orientation']!r}")
    if "gridCells" in doc:
        g = doc["gridCells"]
        if not (isinstance(g, int) and not isinstance(g, bool) and GRID_MIN <= g <= GRID_MAX):
            raise BurnShapeError(f"gridCells 必须是 {GRID_MIN}..{GRID_MAX} 的整数：{g!r}")

    if "fuel" in doc:
        fuel = doc["fuel"]
        if not isinstance(fuel, dict):
            raise BurnShapeError("fuel 必须是对象")
        if "alphaThreshold" in fuel and not (_is_num(fuel["alphaThreshold"]) and 0 <= fuel["alphaThreshold"] <= 1):
            raise BurnShapeError("fuel.alphaThreshold 必须在 0..1")
        if "maskData" in fuel and not (isinstance(fuel["maskData"], str) and fuel["maskData"].startswith("data:image/png;base64,")):
            raise BurnShapeError("fuel.maskData 必须是 PNG data URL")
        doc["fuel"] = _ordered(fuel, _FUEL_ORDER)

    if "ignitionPoints" in doc:
        pts = doc["ignitionPoints"]
        if not isinstance(pts, list):
            raise BurnShapeError("ignitionPoints 必须是数组")
        seen: set[str] = set()
        out = []
        for i, p in enumerate(pts):
            if not isinstance(p, dict):
                raise BurnShapeError(f"ignitionPoints[{i}] 必须是对象")
            pid = p.get("id")
            if not is_valid_id(pid):
                raise BurnShapeError(f"ignitionPoints[{i}].id 不合法：{pid!r}")
            if pid in seen:
                raise BurnShapeError(f"着火点 id 重复：{pid}")
            seen.add(pid)
            for k in ("u", "v"):
                if not (_is_num(p.get(k)) and 0 <= p[k] <= 1):
                    raise BurnShapeError(f"着火点「{pid}」的 {k} 必须在 0..1")
            out.append(_ordered(p, _POINT_ORDER))
        doc["ignitionPoints"] = out

    if "spread" in doc:
        sp = doc["spread"]
        if not isinstance(sp, dict):
            raise BurnShapeError("spread 必须是对象")
        for k in _SPREAD_ORDER:
            if k in sp and not (_is_num(sp[k]) and sp[k] > 0):
                raise BurnShapeError(f"spread.{k} 必须是 > 0 的数（cm/s）")
        if _is_num(sp.get("speedOpposed")) and _is_num(sp.get("speedConcurrent")) and sp["speedConcurrent"] < sp["speedOpposed"]:
            warnings.append("spread.speedConcurrent 小于 speedOpposed：运行时按逆流速度算（往上烧不会比往下慢）")
        if mode != "spread":
            warnings.append("spread 块只对面燃烧（mode=spread）有用")
        doc["spread"] = _ordered(sp, _SPREAD_ORDER)

    if "consume" in doc:
        c = doc["consume"]
        if not isinstance(c, dict):
            raise BurnShapeError("consume 必须是对象")
        if "seconds" in c and not (_is_num(c["seconds"]) and c["seconds"] > 0):
            raise BurnShapeError("consume.seconds 必须是 > 0 的数（秒）")
        if "from" in c and c["from"] not in CONSUME_FROM:
            raise BurnShapeError(f"consume.from 必须是 {' / '.join(CONSUME_FROM)}")
        if "orderData" in c and not (isinstance(c["orderData"], str) and c["orderData"].startswith("data:image/png;base64,")):
            raise BurnShapeError("consume.orderData 必须是 PNG data URL")
        if "flameU" in c and not (_is_num(c["flameU"]) and 0 <= c["flameU"] <= 1):
            raise BurnShapeError("consume.flameU 必须在 0..1")
        if "flameWidth" in c and not (_is_num(c["flameWidth"]) and 0 < c["flameWidth"] <= 1):
            raise BurnShapeError("consume.flameWidth 必须在 (0, 1]")
        if mode != "consume":
            warnings.append("consume 块只对消耗燃烧（mode=consume）有用")
        doc["consume"] = _ordered(c, _CONSUME_ORDER)

    for k in ("flameSeconds", "flameLength"):
        if k in doc and not (_is_num(doc[k]) and doc[k] > 0):
            raise BurnShapeError(f"{k} 必须是 > 0 的数")
    for k in ("emberSeconds", "ignitionDelay"):
        if k in doc and not (_is_num(doc[k]) and doc[k] >= 0):
            raise BurnShapeError(f"{k} 必须是 ≥ 0 的数")
    # 雷劈能点着（缺省否）：点着会进存档、烧完永久没了，逐个模板由作者开
    if "lightningIgnites" in doc and not isinstance(doc["lightningIgnites"], bool):
        raise BurnShapeError("lightningIgnites 必须是布尔（雷劈能不能点着它）")

    if "look" in doc:
        look = doc["look"]
        if not isinstance(look, dict):
            raise BurnShapeError("look 必须是对象")
        for k in ("scorchColor", "charColor", "ashColor"):
            if k in look and not _color(look[k]):
                raise BurnShapeError(f"look.{k} 必须是 3 个 0..1 的数")
        for k in ("glowKelvin", "emberKelvin"):
            if k in look and not (_is_num(look[k]) and 1000 <= look[k] <= 40000):
                raise BurnShapeError(f"look.{k} 必须在 1000..40000 K")
        for k in ("scorchSeconds", "glowStrength", "emberStrength", "ashFadeSeconds", "edgeNoise"):
            if k in look and not (_is_num(look[k]) and look[k] >= 0):
                raise BurnShapeError(f"look.{k} 必须是 ≥ 0 的数")
        if "ashAlpha" in look and not (_is_num(look["ashAlpha"]) and 0 <= look["ashAlpha"] <= 1):
            raise BurnShapeError("look.ashAlpha 必须在 0..1")
        doc["look"] = _ordered(look, _LOOK_ORDER)

    if "particles" in doc:
        ps = doc["particles"]
        if not isinstance(ps, list):
            raise BurnShapeError("particles 必须是数组")
        out = []
        for i, p in enumerate(ps):
            if not isinstance(p, dict):
                raise BurnShapeError(f"particles[{i}] 必须是对象")
            if not (isinstance(p.get("effect"), str) and p["effect"].strip()):
                raise BurnShapeError(f"particles[{i}].effect 必填（粒子效果 id）")
            if p.get("from") not in PARTICLE_SOURCES:
                raise BurnShapeError(f"particles[{i}].from 必须是 {' / '.join(PARTICLE_SOURCES)}")
            if "refArea" in p and not (_is_num(p["refArea"]) and p["refArea"] > 0):
                raise BurnShapeError(f"particles[{i}].refArea 必须是 > 0 的数（cm²）")
            out.append(_ordered(p, _PARTICLE_ORDER))
        doc["particles"] = out

    if "light" in doc:
        L = doc["light"]
        if not isinstance(L, dict):
            raise BurnShapeError("light 必须是对象")
        if not (_is_num(L.get("intensityPerM2")) and L["intensityPerM2"] > 0):
            raise BurnShapeError("light.intensityPerM2 必填且 > 0（每平方米明火的强度）")
        if "color" in L and not _color(L["color"]):
            raise BurnShapeError("light.color 必须是 3 个 0..1 的数")
        if "kelvin" in L and not (_is_num(L["kelvin"]) and 1000 <= L["kelvin"] <= 40000):
            raise BurnShapeError("light.kelvin 必须在 1000..40000 K")
        for k in ("maxIntensity", "range", "softeningRadius"):
            if k in L and not (_is_num(L[k]) and L[k] > 0):
                raise BurnShapeError(f"light.{k} 必须是 > 0 的数")
        if "puffAmp" in L and not (_is_num(L["puffAmp"]) and 0 <= L["puffAmp"] <= 1):
            raise BurnShapeError("light.puffAmp 必须在 0..1")
        if "castShadow" in L and not isinstance(L["castShadow"], bool):
            raise BurnShapeError("light.castShadow 必须是布尔")
        doc["light"] = _ordered(L, _LIGHT_ORDER)

    if "blowout" in doc:
        b = doc["blowout"]
        if not isinstance(b, dict):
            raise BurnShapeError("blowout 必须是对象")
        for k in _BLOWOUT_ORDER:
            if not (_is_num(b.get(k)) and b[k] > 0):
                raise BurnShapeError(f"blowout.{k} 必填且 > 0")
        if mode != "consume":
            warnings.append("blowout 只对消耗燃烧（蜡烛 / 香）有用：面燃烧吹不灭")
        doc["blowout"] = _ordered(b, _BLOWOUT_ORDER)

    return _ordered(doc, BURNABLE_ORDER), warnings


def list_burnable_ids(project_root: Path) -> list[str]:
    d = burnables_dir(project_root)
    if not d.is_dir():
        return []
    return sorted(p.stem for p in d.glob("*.json") if p.is_file())


def load_burnable(project_root: Path, bid: str) -> tuple[dict | None, str]:
    """读一份资产。返回 ``(文档或 None, 错误文本)``；不存在 = ``(None, "")``。"""
    p = burnables_dir(project_root) / f"{bid}.json"
    if not p.is_file():
        return None, ""
    try:
        return json.loads(p.read_text(encoding="utf-8")), ""
    except (OSError, ValueError) as e:
        return None, f"{p.name} 读不懂：{e}"


def load_all_burnables(project_root: Path) -> tuple[dict[str, dict], dict[str, str]]:
    """全部资产：``({id: 原始文档}, {id: 读不懂的原因})``"""
    docs: dict[str, dict] = {}
    errors: dict[str, str] = {}
    for bid in list_burnable_ids(project_root):
        doc, err = load_burnable(project_root, bid)
        if err:
            errors[bid] = err
        elif isinstance(doc, dict):
            docs[bid] = doc
    return docs, errors


# ---------------------------------------------------------------------------- 宿主上的可燃配置 / 粒子绑定


def normalize_burnable_host(raw: Any, where: str, host_kind: str = "entity") -> tuple[dict, list[str]]:
    """清洗宿主上的 ``burnable`` 块：返回 ``(按键序收束的块, 警告)``；形状不合法抛 ``BurnShapeError``。

    ``host_kind``：``entity`` 热点 / NPC、``prop`` 挂件预设、``spawn`` 轨迹 spawn 规格。挂件不走按 E 点，
    写了 ``playerIgnite`` / ``igniteConditions`` 只警告（运行时不读）。
    """
    if host_kind not in HOST_KINDS:
        raise ValueError(f"host_kind 必须是 {HOST_KINDS}")
    if not isinstance(raw, dict):
        raise BurnShapeError(f"{where}：burnable 必须是对象")
    warnings: list[str] = []
    doc = dict(raw)
    if not (isinstance(doc.get("template"), str) and doc["template"].strip()):
        raise BurnShapeError(f"{where}：burnable.template 必填（可燃物模板 id）")
    if "initial" in doc and doc["initial"] not in INITIAL_STATES:
        raise BurnShapeError(f"{where}：initial 必须是 {' / '.join(INITIAL_STATES)}")
    if "playerIgnite" in doc and not isinstance(doc["playerIgnite"], bool):
        raise BurnShapeError(f"{where}：playerIgnite 必须是布尔")
    if "igniteConditions" in doc and not isinstance(doc["igniteConditions"], list):
        raise BurnShapeError(f"{where}：igniteConditions 必须是条件数组")
    if host_kind == "prop":
        for k in ("playerIgnite", "igniteConditions"):
            if k in doc:
                warnings.append(f"{where}：挂件不走按 E 点，{k} 运行时不读")
    if "signals" in doc:
        sig = doc["signals"]
        if not isinstance(sig, dict):
            raise BurnShapeError(f"{where}：signals 必须是对象")
        for k, v in sig.items():
            if k not in SIGNAL_KEYS:
                raise BurnShapeError(f"{where}：signals 只认 {' / '.join(SIGNAL_KEYS)}：{k!r}")
            if not isinstance(v, str):
                raise BurnShapeError(f"{where}：signals.{k} 必须是信号 id 字符串")
        doc["signals"] = _ordered(sig, SIGNAL_KEYS)
    return _ordered(doc, HOST_ORDER), warnings


def normalize_plate_binding(raw: Any, where: str) -> dict:
    """粒子薄片的 ``plate.burnable``：``{template}``（只能绑面燃烧模板——那一条由校验器对着模板查）。"""
    if not isinstance(raw, dict):
        raise BurnShapeError(f"{where}：plate.burnable 必须是对象 {{template}}")
    if not (isinstance(raw.get("template"), str) and raw["template"].strip()):
        raise BurnShapeError(f"{where}：plate.burnable.template 必填（面燃烧可燃物模板 id）")
    return _ordered(dict(raw), ("template",))


def template_world_size(doc: Any) -> tuple[float, float] | None:
    """模板的画面尺寸（wu，未乘宿主缩放）；尺寸没写 / 坏 ⇒ None。"""
    if not isinstance(doc, dict) or not (_is_num(doc.get("widthCm")) and _is_num(doc.get("heightCm"))):
        return None
    if doc["widthCm"] <= 0 or doc["heightCm"] <= 0:
        return None
    return float(doc["widthCm"]) * WU_PER_CM, float(doc["heightCm"]) * WU_PER_CM


def template_grip(doc: Any) -> tuple[float, float]:
    """握点 ``(u, v)``；没写 / 坏 ⇒ 底边中点 ``(0.5, 1.0)``（与运行时同口径）。"""
    g = doc.get("grip") if isinstance(doc, dict) else None
    if isinstance(g, dict) and _is_num(g.get("u")) and _is_num(g.get("v")):
        return min(1.0, max(0.0, float(g["u"]))), min(1.0, max(0.0, float(g["v"])))
    return 0.5, 1.0


def host_signals(host: Any) -> list[tuple[str, str]]:
    """宿主块里配的信号 ``(时刻, 信号 id)``（时刻 ∈ ``SIGNAL_KEYS``）"""
    sig = host.get("signals") if isinstance(host, dict) else None
    out: list[tuple[str, str]] = []
    if isinstance(sig, dict):
        for k in SIGNAL_KEYS:
            v = sig.get(k)
            if isinstance(v, str) and v.strip():
                out.append((k, v.strip()))
    return out


# ---------------------------------------------------------------------------- 谁引用了模板（全工程扫描）


def _classify_ref(rel: str, path: list) -> dict:
    """``rel`` = 相对 ``public/assets`` 的文件路径；``path`` = 到宿主对象（``burnable`` 块所在对象）的 JSON 路径。"""
    parts = rel.split("/")
    info: dict[str, Any] = {"kind": "other"}
    if path and path[-1] == "spawn":
        info["kind"] = "spawn"
    elif path and path[-1] == "plate":
        info["kind"] = "plate"
        if parts[:2] == ["data", "vfx"]:
            info["effect"] = parts[-1][:-5] if parts[-1].endswith(".json") else parts[-1]
    elif parts[0] == "scenes" and len(path) >= 2 and path[-2] in ("hotspots", "npcs"):
        info["kind"] = "hotspot" if path[-2] == "hotspots" else "npc"
    elif rel == "data/prop_presets.json" and len(path) == 1:
        info["kind"] = "prop"
        info["prop"] = path[0]
    if parts[0] == "scenes" and len(parts) == 2 and parts[1].endswith(".json"):
        info["scene"] = parts[1][:-5]
    return info


def scan_template_refs(project_root: Path) -> list[dict]:
    """全工程（``public/assets/**/*.json``）里所有 ``burnable: {template: …}`` 块。

    每条 ``{template, file, path, kind, scene?, entity?, prop?, effect?}``：``file`` 是相对工程根的 POSIX 路径、
    ``path`` 是到**宿主对象**（``burnable`` 所在的那个对象）的 JSON 路径（键 / 下标列表）；
    ``kind`` ∈ ``hotspot / npc / prop / spawn / plate / other``；``entity`` = 宿主对象自己的 ``id``（有的话）。
    读不懂的文件跳过。
    """
    root = Path(project_root)
    base = root.joinpath(*ASSETS_PARTS)
    out: list[dict] = []
    if not base.is_dir():
        return out
    for f in sorted(base.rglob("*.json")):
        try:
            doc = json.loads(f.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        rel = f.relative_to(base).as_posix()
        stack: list[tuple[Any, list]] = [(doc, [])]
        while stack:
            node, path = stack.pop()
            if isinstance(node, dict):
                b = node.get("burnable")
                if isinstance(b, dict) and isinstance(b.get("template"), str) and b["template"].strip():
                    ref = {"template": b["template"].strip(), "file": f.relative_to(root).as_posix(), "path": list(path)}
                    ref.update(_classify_ref(rel, path))
                    if isinstance(node.get("id"), str):
                        ref["entity"] = node["id"]
                    out.append(ref)
                for k, v in node.items():
                    if isinstance(v, (dict, list)):
                        stack.append((v, path + [k]))
            elif isinstance(node, list):
                for i, v in enumerate(node):
                    if isinstance(v, (dict, list)):
                        stack.append((v, path + [i]))
    out.sort(key=lambda r: (r["template"], r["file"], [str(x) for x in r["path"]]))
    return out


def refs_of_template(project_root: Path, template_id: str) -> list[dict]:
    """引用这份模板的所有宿主（见 :func:`scan_template_refs`）"""
    return [r for r in scan_template_refs(project_root) if r["template"] == template_id]


# ---------------------------------------------------------------------------- 只读辅助（主编辑器 / 校验器）


#: 可燃配置信号三个时刻的人话（信号关系面板 / 校验器共用一份叫法）
SIGNAL_MOMENT_LABELS = {"ignited": "点着时", "burntOut": "烧完时", "extinguished": "熄灭时"}
#: 四个状态的人话（条件编辑器 / 条件摘要共用一份叫法）
BURN_STATE_LABELS = {"unburnt": "没点", "burning": "在烧", "out": "灭了", "burnt": "烧完"}


def ignition_point_ids(doc: Any) -> list[str]:
    """可燃物资产里写着的着火点 id（原序、去重、只收非空字符串；形状坏不抛）。

    与运行时 ``resolveBurnable`` 的 ``ignitionPoints`` 清洗同口径：id 非空、不重复、u / v 是有限数。
    """
    pts = doc.get("ignitionPoints") if isinstance(doc, dict) else None
    out: list[str] = []
    for p in pts if isinstance(pts, list) else []:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if not isinstance(pid, str) or not pid.strip() or pid.strip() in out:
            continue
        if not (_is_num(p.get("u")) and _is_num(p.get("v"))):
            continue
        out.append(pid.strip())
    return out


def ignition_points_uv(doc: Any) -> list[tuple[str, float, float]]:
    """着火点 ``(id, u, v)``（u / v 夹到 0..1，与运行时同口径）；画布标记用。"""
    pts = doc.get("ignitionPoints") if isinstance(doc, dict) else None
    out: list[tuple[str, float, float]] = []
    seen: set[str] = set()
    for p in pts if isinstance(pts, list) else []:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if not isinstance(pid, str) or not pid.strip() or pid.strip() in seen:
            continue
        if not (_is_num(p.get("u")) and _is_num(p.get("v"))):
            continue
        seen.add(pid.strip())
        out.append((pid.strip(), min(1.0, max(0.0, float(p["u"]))), min(1.0, max(0.0, float(p["v"])))))
    return out
