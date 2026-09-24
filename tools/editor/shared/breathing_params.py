"""呼吸图（breathing overlay）参数表的 Python 读取口 —— 零 Qt 依赖。

**唯一真相源是 ``src/data/breathingParams.json``**：运行时（``src/systems/breathing/breathingParams.ts``）、
呼吸工作台、主编辑器 ``setBreathingParams`` 表单与校验器都读这一份。本模块**只读、不抄**——
键名 / 中文名 / 量程 / 步长 / 单位 / 说明一律从 JSON 现读，Python 里不存第二份清单。

读不到 / 读不懂时返回空表（调用方据此"不做该项判断"：表单照样保值展示磁盘上的每个键，
校验器跳过未知键与量程判断——宁可少校验，不误报）。
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path

#: 参数表相对仓库根的位置（与 TS 侧 `import schemaJson from '../../data/breathingParams.json'` 同一份文件）
BREATHING_PARAMS_REL = ("src", "data", "breathingParams.json")

#: 呼吸图资产目录（`<id>.json` 一文件一张图，id = 文件名；与 TS `TEXT_URLS.breathingDir` 同口径）
BREATHING_DIR_REL = ("public", "assets", "data", "breathing")

#: breathingPerform.act 的取值（与 TS `BREATHING_ACTS` 逐字对应）+ 给人看的中文名。
#: ⚠ 手工镜像：TS 那边加档这里要跟，`test_breathing_action_registration` 解析 TS 源码对账。
BREATHING_ACT_ROWS: tuple[tuple[str, str], ...] = (
    ("breathe", "恢复呼吸"),
    ("fadeOut", "渐弱至停"),
    ("gasp", "猛抽一口气"),
    ("stopNow", "立刻停住"),
    ("restart", "从头来"),
)
BREATHING_ACTS: frozenset[str] = frozenset(v for v, _ in BREATHING_ACT_ROWS)


@dataclass(frozen=True)
class BreathingParamDef:
    key: str
    label: str
    default: float
    min: float
    max: float
    step: float
    unit: str
    hint: str
    group_id: str
    group_title: str


@dataclass(frozen=True)
class BreathingParamGroup:
    id: str
    title: str
    note: str
    params: tuple[BreathingParamDef, ...]


def breathing_params_path(project_root: Path | None) -> Path:
    """参数表的磁盘路径；``project_root`` 为空时取本文件所在仓库。"""
    root = Path(project_root) if project_root is not None else Path(__file__).resolve().parents[3]
    return root.joinpath(*BREATHING_PARAMS_REL)


def _num(v: object) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if math.isfinite(f) else None


def load_breathing_param_groups(project_root: Path | None = None) -> list[BreathingParamGroup]:
    """按 JSON 里的顺序读出分组与参数（每次现读；文件只有几十行）。

    一条参数缺 key / label，或 min/max/default/step 不是有限数，就跳过这一条——
    TS 侧对这份表做类型断言后直接用，写坏了运行时也是坏的；这里不替它猜。
    """
    try:
        doc = json.loads(breathing_params_path(project_root).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    groups_raw = doc.get("groups") if isinstance(doc, dict) else None
    out: list[BreathingParamGroup] = []
    for g in groups_raw if isinstance(groups_raw, list) else []:
        if not isinstance(g, dict):
            continue
        gid = str(g.get("id") or "").strip()
        title = str(g.get("title") or gid).strip()
        rows: list[BreathingParamDef] = []
        for p in g.get("params") if isinstance(g.get("params"), list) else []:
            if not isinstance(p, dict):
                continue
            key = str(p.get("key") or "").strip()
            lo, hi, dv, st = _num(p.get("min")), _num(p.get("max")), _num(p.get("default")), _num(p.get("step"))
            if not key or lo is None or hi is None or dv is None:
                continue
            rows.append(BreathingParamDef(
                key=key,
                label=str(p.get("label") or key).strip() or key,
                default=dv, min=lo, max=hi,
                step=st if st is not None and st > 0 else 0.01,
                unit=str(p.get("unit") or "").strip(),
                hint=str(p.get("hint") or "").strip(),
                group_id=gid, group_title=title,
            ))
        out.append(BreathingParamGroup(id=gid, title=title, note=str(g.get("note") or "").strip(), params=tuple(rows)))
    return out


def breathing_param_defs(project_root: Path | None = None) -> dict[str, BreathingParamDef]:
    """key → 定义（表里的顺序）。"""
    return {p.key: p for g in load_breathing_param_groups(project_root) for p in g.params}


def step_decimals(step: float) -> int:
    """按步长推数值控件的小数位（0.05 → 2、0.5 → 1、1 → 0），上限 4。"""
    s = f"{step:.6f}".rstrip("0").rstrip(".")
    return min(4, len(s.split(".")[1])) if "." in s else 0
