"""脚底接触 AO（胶囊 AO）作者面的共享定义——零 Qt，编辑器控件 / 画布预览 / 校验器共用。

作者面（制作人 2026-09-24 定）：勾「接触 AO」就有；**方向 AO 缺省也开**（「所有 npc 默认都开方向 ao，包括主角」，
同日改口，此前缺省只有简单 AO）；取消方向 AO 就只剩简单 AO（无方向的近场遮蔽）；参数都能调。
数据挂在 NPC 的 `contactAo` 与场景的 `playerContactAo` 上（类型见 `src/data/types.ts` 的 `ContactAoDef`）。

- 明暗 `darkness` / 大小 `size` 不写 = 跟随场景光环境（`lightEnv.shadow.contact` / `contactSize`）；
- 方向 AO `directional` 不写 = 开（写 false 才关）；
- 方向来源 `dirSource` 不写 = 按光照（跟角色身上的光一致：间接光一路 + 每盏实体灯一路，按各自照到地面的量
  加权；另两档：跟阴影绑定 / 场景主光）；
- 其余参数不写 = 用下面的缺省。

⚠ 缺省值是运行时 `src/rendering/contactAo.ts` 的**镜像**，对账测试逐字比对
  （`tools/editor/editors/tests/test_npc_contact_shadow_form.py`）。改一边必须改另一边。
"""
from __future__ import annotations

import math

__all__ = [
    "SPREAD_DEFAULT", "DIR_STRENGTH_DEFAULT", "DIR_LENGTH_DEFAULT", "DIR_CONE_DEG_DEFAULT",
    "DIRECTIONAL_DEFAULT", "DIR_SOURCES", "DIR_SOURCE_DEFAULT", "DIR_SOURCE_LABELS",
    "PARAM_RANGES", "contact_ao_issues",
]

#: 简单 AO 的晕开范围：无方向部分的遮挡高度占身高的比例。
SPREAD_DEFAULT = 0.25
#: 方向 AO 浓度（0..1）。
DIR_STRENGTH_DEFAULT = 0.9
#: 方向 AO 拖尾长度（× 身高）。
DIR_LENGTH_DEFAULT = 0.7
#: 方向 AO 半影锥角（度），越大越软。
DIR_CONE_DEG_DEFAULT = 32.0
#: 方向 AO 缺省开（制作人 2026-09-24：所有 NPC 默认都开方向 AO，包括主角）。
DIRECTIONAL_DEFAULT = True
#: 方向 AO 的方向来源（`dirSource`）。制作人 2026-09-24：是个选项；缺省「ao 方向本来就和间接光强度要一致」。
DIR_SOURCES: tuple[str, ...] = ("lighting", "binding", "scene")
DIR_SOURCE_DEFAULT = "lighting"
#: 下拉里给作者看的名字（顺序同 DIR_SOURCES）。
DIR_SOURCE_LABELS: dict[str, str] = {
    "lighting": "按光照",
    "binding": "跟阴影绑定",
    "scene": "场景主光",
}

#: 数值字段的合法区间（闭区间）。与运行时 `resolveContactAo` 的钳位同口径。
PARAM_RANGES: dict[str, tuple[float, float]] = {
    "darkness": (0.0, 1.0),
    "size": (0.0, 10.0),
    "spread": (0.01, 3.0),
    "dirStrength": (0.0, 1.0),
    "dirLength": (0.01, 10.0),
    "dirConeDeg": (1.0, 85.0),
}
_BOOL_KEYS = ("enabled", "directional")


def contact_ao_issues(value: object, who: str) -> list[str]:
    """校验一份 `contactAo` / `playerContactAo`。返回错误文案列表（空 = 合法）。

    运行时只认「显式 false 才关」、数值越界一律钳住——写成字符串 "false" 或越界不会报错，
    只会画出来和作者以为的不一样，所以在这里拦。未知键不报（留给以后加字段，不连坐）。
    """
    if value is None:
        return []
    if not isinstance(value, dict):
        return [f"{who} contactAo 必须是对象（当前 {value!r}）"]
    out: list[str] = []
    for k in _BOOL_KEYS:
        if k in value and not isinstance(value[k], bool):
            out.append(f"{who} contactAo.{k} 必须是 true/false（当前 {value[k]!r}）")
    if "dirSource" in value and value["dirSource"] not in DIR_SOURCES:
        out.append(f"{who} contactAo.dirSource 只能是 {'/'.join(DIR_SOURCES)}（当前 {value['dirSource']!r}）")
    for k, (lo, hi) in PARAM_RANGES.items():
        if k not in value:
            continue
        v = value[k]
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
            out.append(f"{who} contactAo.{k} 必须是数字（当前 {v!r}）")
        elif not (lo <= v <= hi):
            out.append(f"{who} contactAo.{k} 超出范围 {lo}~{hi}（当前 {v}）")
    return out
