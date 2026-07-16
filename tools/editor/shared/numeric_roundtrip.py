"""数值参数往返保真：避免编辑器把 JSON 里的整数 1000 漂移成 1000.0。

QDoubleSpinBox 一律以 float 存取，导致 to_dict 输出 `1000.0`，与磁盘上的整数
`1000` 字节不一致——编辑器只要"打开→保存"就会改写所有整数 duration / 坐标。
本模块提供单一规则：**未改动的数值参数按原始 JSON 表示回写**，从根上消除漂移。

- 未改动（与原值数值相等）→ 恢复原始 int/float 表示（含原本就是 1000.0 的情形）。
- 新增 / 被改动 → 保持控件给出的值（float）；调用方如需可另行规整，本模块不擅自改。

不触碰 bool（避免被当作 0/1 数值），不递归嵌套结构（嵌套 action 由各自的 ActionRow
负责其自身的往返保真）。
"""
from __future__ import annotations

from typing import Any

_MISSING = object()


def preserve_numeric_repr(out: dict, original: dict | None) -> dict:
    """就地把 out 中与 original 数值相等的标量键恢复为 original 的原始表示。

    返回同一个 dict（便于链式）。original 为 None 时原样返回。
    """
    if not isinstance(out, dict) or not isinstance(original, dict):
        return out
    for k, v in list(out.items()):
        if isinstance(v, bool):
            # QCheckBox 输出 bool；原值若是字符串 "false"/"true"/"0"/"1" 且语义相同 → 保留原字符串
            #（运行时按字符串同语义解析，编辑器不得把 "false" 改写成 false）。
            ov_b: Any = original.get(k, _MISSING)
            if isinstance(ov_b, str):
                s = ov_b.strip().lower()
                sem = None
                if s in ("false", "0", "no", "off", ""):
                    sem = False
                elif s in ("true", "1", "yes", "on"):
                    sem = True
                if sem is not None and sem == v:
                    out[k] = ov_b
            continue
        ov: Any = original.get(k, _MISSING)
        if ov is _MISSING or isinstance(ov, bool) or not isinstance(ov, (int, float)):
            continue
        if isinstance(v, float):
            # QDoubleSpinBox 输出 1000.0 -> 恢复原始 int 1000（或原本就是 1000.0）。
            if float(ov) == v:
                out[k] = ov
        elif isinstance(v, int):
            # 反方向（审查 P3）：QSpinBox 输出 int 1，原值为 float 1.0 -> 恢复原始 1.0，
            # 否则「打开即保存」把 1.0 漂成 1。仅当原值本就是 float 且数值相等时命中，
            # 对 int 原值零副作用（int==int 表示相同，不改），不影响 anim 种子法
            #（种子法在各自 to_dict 出口另行处理，不经本分支）。
            if isinstance(ov, float) and float(v) == ov:
                out[k] = ov
        elif isinstance(v, str):
            # RichTextLineEdit 等字符串控件输出数字串 "2" -> 恢复原始数值 2（仅当原值本就是数字且相等，
            # 故对真正的字符串参数无副作用；用户改成 [tag:…] 等非数字串则不命中、保持字符串）。
            s = v.strip()
            try:
                fv = float(s)
            except (TypeError, ValueError):
                continue
            if float(ov) == fv:
                out[k] = ov
    return out
