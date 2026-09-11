"""音频引用的**逐处音量**（编辑器侧解析/写回；运行时侧是 ``src/data/audioCue.ts``）。

一处音频引用有两种形态：裸 id（``"sfx_door"``）或带本处音量的对象
（``{"id": "sfx_door", "volume": 0.5}``）。本处音量**替换**素材级 ``audio_config[...].volume``，
再乘通道音量——口径与运行时同一份，写在 ``src/data/audioCue.ts`` 的头注释里，别在这里另立一套。

**为什么写回要这么小心**（三条都踩过同族的坑，见 [numeric-roundtrip-fidelity]）：

1. **未知键必须原样留着**：对象形态以后可能长出 ``pan`` / ``fadeMs``。读表时只认 id/volume、
   写回时重建一个只有这两键的新对象 = 把别人的字段**静默删掉**。所以写回一律在原对象上改。
2. **中性值不写键**：``volume == 1`` 与不写完全等价。打开一个面板就给全项目每条引用注入
   ``"volume": 1`` 是纯噪音（且让 diff 没法看）。
3. **但原本就写着的中性值要留住**：盘上写了 ``"volume": 1`` 而用户没动过，写回还得是它——
   "打开即保存"不该改动任何一个字节。判据是"用户动没动过"，不是"值等不等于中性"。
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any

#: 音量中性值：与"不写这个键"完全等价。
NEUTRAL_VOLUME = 1.0

#: 作者面音量控件的量程上限。>1 表示"比素材原音更响"，但最终仍被运行时 clamp 到满幅——
#: 只能吃掉"当前音量→满幅"那段余量，要更响得放大素材文件本身。
MAX_SITE_VOLUME = 4.0


def cue_id(raw: object) -> str:
    """引用取 id；未配置 / 结构不合法一律空串（与运行时 ``audioCueId`` 同判据）。"""
    if isinstance(raw, str):
        return raw.strip()
    if isinstance(raw, dict):
        return str(raw.get("id") or "").strip()
    return ""


def cue_volume(raw: object) -> float | int | None:
    """引用取本处音量，**保留原始字面类型**（``1`` 保 int、``0.8`` 保 float）。

    没写 / 非数值 / 负数 → ``None``（= 沿用素材级）。``0`` 是合法值（"这里就是要哑"），
    绝不能与 ``None`` 合并。
    """
    if not isinstance(raw, dict):
        return None
    v = raw.get("volume")
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if v < 0:
        return None
    return v


def make_cue(
    audio_id: str,
    volume: float | int | None,
    original: object = None,
) -> str | dict | None:
    """按 (id, 本处音量) 组出写盘值；``None`` = 这个键整个不写。

    ``original`` 是**盘上原值**：对象形态时在它的副本上改，未知键原样留着（见模块头注释）。
    """
    aid = (audio_id or "").strip()
    if not aid:
        return None

    if isinstance(original, dict):
        out = deepcopy(original)
        out["id"] = aid
        if volume is None:
            out.pop("volume", None)
        else:
            out["volume"] = volume
        # 只剩 id 一个键的对象等价于裸字符串——退回裸串，别在数据里留一堆 {"id": ...}
        return aid if set(out.keys()) == {"id"} else out

    if volume is None:
        return aid
    return {"id": aid, "volume": volume}


def resolve_volume_for_write(
    spin_value: float,
    seed: float,
    original_raw: float | int | None,
) -> float | int | None:
    """把音量控件的当前值折算成**写盘值**（``None`` = 不写这个键）。

    - 用户没动过（``spin_value == seed``）→ 原样回写盘上的原值（含盘上写着的中性 ``1``）；
    - 动过且落在中性值 → ``None``（回到"素材原始音量"，不留噪音键）；
    - 动过且非中性 → 控件当前值。
    """
    if abs(spin_value - seed) < 1e-9:
        return original_raw
    if abs(spin_value - NEUTRAL_VOLUME) < 1e-9:
        return None
    return float(spin_value)


def cue_list_ids(raw: object) -> list[str]:
    """引用列表取 id 列表（跳过解析不出 id 的元素）。"""
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        aid = cue_id(item)
        if aid:
            out.append(aid)
    return out


def cue_list_entries(raw: object) -> list[tuple[str, float | int | None, Any]]:
    """引用列表拆成 ``(id, 本处音量, 原始元素)`` 三元组——原始元素留着供写回时保未知键。"""
    if not isinstance(raw, list):
        return []
    out: list[tuple[str, float | int | None, Any]] = []
    for item in raw:
        aid = cue_id(item)
        if aid:
            out.append((aid, cue_volume(item), item))
    return out
