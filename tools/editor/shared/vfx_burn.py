"""粒子效果里「燃烧」那两样字段的形状口径，粒子工作台形状闸门与主校验器共用一份。

两样都是燃烧系统加的（``src/data/types.ts``）：

* ``spawn.shape = {kind: 'external', jitter?}``（``VfxSpawnShapeDef``）：出生点每帧由外部交进来
  （``VfxInstanceSim.setSpawnPoints``——燃烧系统把火苗 / 余烬发在正在烧的格、正在烧的纸上）；每颗在挑中那一点的
  半径 × ``jitter``（缺省 1）的球里出生；**没给点就不出生**。
* ``plate.burnable = {template}``（``BurnablePlateBindingDef``，2026-09-16 模板化）：薄片绑一份**面燃烧**可燃物模板
  （``public/assets/data/burnables/<id>.json``）——碰火会着、按模板的火线速度从被火碰到的那边烧过去、成灰、永久没了。
  引燃时间 / 火焰长度 / 焦黑发光 / 火苗粒子 / 火光全取模板（``src/systems/vfx/vfxPlateBurn.ts`` 的
  ``resolvePlateBurnParams(template)``）；**粒子的贴图与大小仍归粒子自己**。运行时 ``vfxSim.plateBurnOf``：
  模板查不到 / 是消耗燃烧 ⇒ 这张纸**静默**不可燃（不报错）——所以这两条在这里是提醒（让作者看得见），
  形状（不是对象 / 没写 template）才拒存。旧的 ``plate.flammable`` 参数表（``FLAMMABLE_DEFAULTS`` 对账）已作废。

工作台保存时 ``tools/vfx_workbench/assets.py`` 拿问题拒存（ValueError）、拿提醒进 warnings；
主校验器接入时报 error / warning——口径与措辞只写在这里。纯函数，不碰 Qt、不读写文件
（模板文档由调用方给出：``{id: 原始文档}``，与 ``ProjectModel.burnables`` / ``burnables.load_all_burnables`` 同形）。

缺省口径：**写入者（工作台检视器）清空 = 删键**，从不写 null / 空串；形状闸门只查写着的值，不替作者改值、不补缺省。
"""
from __future__ import annotations

import math
from typing import Any, Mapping

from . import burnables as _bn

#: ``BurnablePlateBindingDef`` 的键序（与 types / burnables.ts 同序）
PLATE_BURNABLE_ORDER = ("template",)


def _finite(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(float(v))


def external_shape_problem(shape: Any) -> str | None:
    """``{kind: 'external', jitter?}`` 的形状问题；None = 合法。只看 ``kind == 'external'`` 的形状。"""
    if not isinstance(shape, dict) or shape.get("kind") != "external":
        return None
    if "jitter" in shape:
        j = shape["jitter"]
        if not _finite(j) or float(j) < 0:
            return (f"spawn.shape.jitter 必须是 ≥ 0 的数（外部给点的出生球半径倍率，缺省 1；不写就删掉这个键），"
                    f"收到 {j!r}")
    return None


def external_shape_notes(shape: Any, solver: str, spawn_placement: str) -> list[str]:
    """写了 external 但运行时点不起作用 / 一个都发不出来的情形（提醒，不拒）。

    ``solver`` / ``spawn_placement`` = ``vfx_program`` 解出来的有效执行配置（与运行时 ``resolveEmitterProgram`` 同判据）。
    """
    if not isinstance(shape, dict) or shape.get("kind") != "external":
        return []
    out: list[str] = []
    if solver == "flock":
        out.append("群体发射器用了外部给点（external）：群体出生由巢管理，没有外部点时整群一个都摆不出来")
    elif spawn_placement == "surface":
        out.append("出生位置是「发射区域的可见表面」时外部给点（external）的点不起作用（出生后被挪到区域表面），"
                   "没有外部点时一个都不发——外部给点要配「发射形状」")
    return out


def plate_template_id(value: Any) -> str:
    """``plate.burnable`` 里绑的模板 id（去空白）；形状不对 / 没写 ⇒ ``""``（与运行时 ``plateBurnOf`` 同口径）。"""
    if not isinstance(value, dict):
        return ""
    t = value.get("template")
    return t.strip() if isinstance(t, str) else ""


def plate_burnable_problems(value: Any) -> list[str]:
    """``plate.burnable`` 的形状问题（拒存）；空列表 = 合法。

    只拒形状：必须是对象、``template`` 是非空字符串（清空 = 删掉整个 ``burnable`` 键；与 ``burnables.normalize_plate_binding`` 同一道闸）。
    模板在不在 / 是不是面燃烧见 :func:`plate_burnable_notes`。
    """
    try:
        _bn.normalize_plate_binding(value, "plate.burnable")
    except _bn.BurnShapeError as e:
        return [f"{e}（不可燃就删掉 plate.burnable 这个键）"]
    return []


def plate_burnable_notes(value: Any, templates: Mapping[str, Any] | None) -> list[str]:
    """能存但运行时这张纸**不可燃**的情形（提醒）：绑的模板不存在 / 读不懂 / 是消耗燃烧（蜡烛、香）。

    ``templates`` = ``{模板 id: 原始文档}``（读不懂的文件不在表里）；None = 不查。
    判据与运行时 ``plateBurnOf`` 一致：模板要装得上（``resolveBurnable`` 非空：有图、有正的真实尺寸）且 ``mode`` 不是 ``consume``
    （``resolveBurnable`` 只认 ``mode === 'consume'``，别的一律当面燃烧）。
    """
    tid = plate_template_id(value)
    if not tid or templates is None:
        return []
    doc = templates.get(tid)
    if not isinstance(doc, dict):
        return [f"plate.burnable.template「{tid}」不在 assets/data/burnables/ 里（或读不懂）：运行时这张纸不可燃"]
    if doc.get("mode") == "consume":
        return [f"plate.burnable.template「{tid}」是消耗燃烧模板（蜡烛 / 香）：薄片只能绑面燃烧模板，运行时这张纸不可燃"]
    if not template_resolvable(doc):
        return [f"plate.burnable.template「{tid}」这份模板没有图或没写正的真实尺寸（widthCm / heightCm）："
                "运行时装不上，这张纸不可燃"]
    return []


def template_resolvable(doc: Any) -> bool:
    """运行时 ``resolveBurnable`` 会不会给出非空：有图（非空串）、``widthCm`` / ``heightCm`` 是正的有限数。"""
    if not isinstance(doc, dict):
        return False
    img = doc.get("image")
    return (isinstance(img, str) and bool(img.strip())
            and _finite(doc.get("widthCm")) and doc["widthCm"] > 0
            and _finite(doc.get("heightCm")) and doc["heightCm"] > 0)


def plate_bindable_template_ids(templates: Mapping[str, Any]) -> list[str]:
    """薄片能绑的模板 id（排序）：装得上且不是消耗燃烧——与 :func:`plate_burnable_notes` 零提醒的集合相等（候选面 = 校验面）。"""
    return sorted(tid for tid, doc in templates.items()
                  if isinstance(doc, dict) and doc.get("mode") != "consume" and template_resolvable(doc))


def plate_template_summary(doc: Any) -> dict:
    """模板的关键参数（只读展示用）：``{label, mode, widthCm, heightCm, ignitionDelay, flameLength, speedOpposed,
    speedConcurrent, flameSeconds, emberSeconds, particles:[effect…], light}``——没写的取运行时缺省（``burnables.DEFAULTS``），
    ``defaulted`` 列出哪些是缺省值（界面灰显）。"""
    d = doc if isinstance(doc, dict) else {}
    D = _bn.DEFAULTS
    out: dict[str, Any] = {"label": str(d.get("label") or ""), "mode": "consume" if d.get("mode") == "consume" else "spread",
                           "widthCm": d.get("widthCm"), "heightCm": d.get("heightCm")}
    defaulted: list[str] = []

    def pick(key: str, raw: Any, default: Any) -> None:
        if _finite(raw):
            out[key] = raw
        else:
            out[key] = default
            defaulted.append(key)

    sp = d.get("spread") if isinstance(d.get("spread"), dict) else {}
    pick("ignitionDelay", d.get("ignitionDelay"), D["ignitionDelay"])
    pick("flameLength", d.get("flameLength"), D["flameLength"])
    pick("speedOpposed", sp.get("speedOpposed"), D["speedOpposed"])
    pick("speedConcurrent", sp.get("speedConcurrent"), D["speedConcurrent"])
    pick("flameSeconds", d.get("flameSeconds"), D["flameSeconds"])
    pick("emberSeconds", d.get("emberSeconds"), D["emberSeconds"])
    parts = d.get("particles") if isinstance(d.get("particles"), list) else []
    out["particles"] = [f"{p.get('effect')}（{p.get('from')}）" for p in parts
                        if isinstance(p, dict) and isinstance(p.get("effect"), str)]
    out["light"] = isinstance(d.get("light"), dict)
    out["defaulted"] = defaulted
    return out
