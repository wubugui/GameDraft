"""实体轨迹动画的**纯数据规范化**层（零 Qt、零磁盘）。

## 这一层在整条链子上的位置

轨迹动画的哲学与 parallax 同源：**运行时只认 `keyframes`**，编辑器工作态 `source`
（手绘路径 / 物理参数 / 烘焙设置）一概不看。因此链子是

    source（作者面） --烘焙--> keyframes（运行时真相） --采样--> pose（每帧）

本模块只管两头的**形状**：

- :func:`normalize_keyframe` —— 磁盘帧（大量键可缺省）→ **七通道全填满**的计算态姿态；
- :func:`write_keyframe` —— 姿态 → 磁盘帧（**省掉一切等于缺省的键** + 固定键序 + 定位取整）。

真正的运动学（弧长参数化、时间曲线、物理积分、抽稀）在
:mod:`tools.trajectory_workbench.bake`。

## 为什么"填满"这一步必须在这里做，而不是指望采样器

`src/utils/keyframeSampler.ts` 是**哑的**：它只知道「这个键不是 number 就取 channels 里的
缺省值」，不知道 `sortY 缺省 = y`、也不知道 `scaleX/scaleY 缺省 = scale`。金标用例
``multichannel-defaults-participate`` 把这条钉死了：中间帧没写 `sortY` 时采样器取的是
``channels.sortY``（一个常数），**绝不会**回落到该帧的 `y`。

也就是说：**语义缺省是消费侧的义务**。任何要把磁盘帧喂进采样器的地方（烘焙、画布预览、
运行时 TS 侧同理），都必须先过一遍 :func:`normalize_keyframe`，否则空中飞行的物件会
在深度上瞬移回 0。

## `write_keyframe` 为什么恒不写 `easing`

密帧 + 段缓动 = **缓动做两遍**。parallax 上踩过同一个坑（见
``src/utils/keyframeSampler.ts`` 的模块注释与 ``TrajectoryKeyframe.easing`` 的文档）。
烘焙产物一律线性回放，作者面的缓动已经被"烘"进帧的疏密里了。

## 权威契约

``src/data/types.ts`` 的 ``TrajectoryKeyframe`` / ``TrajectoryAsset`` / ``TrajectorySource``
是 TS 侧权威，本模块是它的 Python 投影。字段名逐字对齐，不许改名。

坐标系：画面空间（场景坐标）wu，**原点画布左上、Y 向下**（角色高 150 wu）。
"""
from __future__ import annotations

import copy
from typing import Any

__all__ = [
    "POSE_CHANNELS",
    "POSE_CHANNEL_DEFAULTS",
    "TRAJECTORY_TARGET_KINDS",
    "sampler_channels",
    "as_number",
    "normalize_keyframe",
    "normalize_keyframes",
    "write_keyframe",
    "normalize_target",
    "normalize_trajectory",
]

# ---------------------------------------------------------------------------
# 通道表
# ---------------------------------------------------------------------------

#: 姿态的七个通道，**顺序固定**（决定 dict 的键序 → 决定 json.dumps 的字节）。
POSE_CHANNELS: tuple[str, ...] = ("x", "y", "rotation", "scaleX", "scaleY", "alpha", "sortY")

#: 各通道的**静态**缺省值。注意 `sortY` 这里是 0 而不是 "y"——
#: "sortY 缺省 = y" 是**关系型**缺省，只能在 :func:`normalize_keyframe` 里落实。
POSE_CHANNEL_DEFAULTS: dict[str, float] = {
    "x": 0.0,
    "y": 0.0,
    "rotation": 0.0,
    "scaleX": 1.0,
    "scaleY": 1.0,
    "alpha": 1.0,
    "sortY": 0.0,
}

TRAJECTORY_TARGET_KINDS: tuple[str, ...] = ("npc", "player")

#: 位置/深度取 2 位，角度取 2 位，缩放/alpha 取 4 位。
_ROUND_DIGITS: dict[str, int] = {
    "x": 2,
    "y": 2,
    "sortY": 2,
    "rotation": 2,
    "scaleX": 4,
    "scaleY": 4,
    "alpha": 4,
}


def sampler_channels() -> dict[str, float]:
    """给 :func:`~tools.trajectory_workbench.bake.sample_keyframes` 的 `channels` 表。

    返回**新的**副本（调用方可以随手改）。喂进采样器的帧必须已经过
    :func:`normalize_keyframe`，所以这些缺省值实际上永远用不上——留着是为了
    与 TS 侧 `channels` 的键集完全一致（采样器返回的键集恒等于本表的键集）。
    """
    return dict(POSE_CHANNEL_DEFAULTS)


def as_number(value: Any, default: float) -> float:
    """`typeof v === 'number'` 的 Python 对应：bool 不算数，其余非数一律取缺省。

    ``True`` 在 Python 里是 ``int`` 的子类，不排除掉就会被当成 1.0——JS 侧
    ``typeof true === 'boolean'`` 不会。
    """
    if isinstance(value, bool):
        return float(default)
    if isinstance(value, (int, float)):
        return float(value)
    return float(default)


# ---------------------------------------------------------------------------
# 帧：磁盘形 <-> 计算形
# ---------------------------------------------------------------------------

def normalize_keyframe(kf: Any) -> dict:
    """磁盘帧 → **七通道全填满**的计算态帧。

    返回的 dict 键序恒为 ``atMs`` + :data:`POSE_CHANNELS`（+ 合法的 `easing`）。

    缺省语义（与 ``src/data/types.ts`` 的 ``TrajectoryKeyframe`` 逐条对齐）:

    ==========  ===========================================
    通道        缺省
    ==========  ===========================================
    rotation    0（叠加度数）
    scaleX      ``scale``，再缺省 1
    scaleY      ``scale``，再缺省 1
    alpha       1
    sortY       **该帧的 y**（不是 0！飞在空中的物件靠它保持落点的前后关系）
    ==========  ===========================================

    `easing` 只在取值合法时保留（采样器要用**起始帧**的 easing）；
    非法值直接丢掉——采样器对未知字符串本就当 linear，留着只会污染往返。
    """
    src: dict = kf if isinstance(kf, dict) else {}
    at_ms = as_number(src.get("atMs"), 0.0)
    x = as_number(src.get("x"), POSE_CHANNEL_DEFAULTS["x"])
    y = as_number(src.get("y"), POSE_CHANNEL_DEFAULTS["y"])
    scale = as_number(src.get("scale"), 1.0)
    out: dict = {
        "atMs": at_ms,
        "x": x,
        "y": y,
        "rotation": as_number(src.get("rotation"), 0.0),
        "scaleX": as_number(src.get("scaleX"), scale),
        "scaleY": as_number(src.get("scaleY"), scale),
        "alpha": as_number(src.get("alpha"), 1.0),
        # 关系型缺省：采样器给不了，只能在这儿补。
        "sortY": as_number(src.get("sortY"), y),
    }
    easing = src.get("easing")
    if isinstance(easing, str) and easing in ("linear", "easeIn", "easeOut", "easeInOut"):
        out["easing"] = easing
    return out


def normalize_keyframes(frames: Any) -> list[dict]:
    """整串帧过一遍 :func:`normalize_keyframe`（不排序、不去重——顺序是作者面的事）。"""
    if not isinstance(frames, (list, tuple)):
        return []
    return [normalize_keyframe(f) for f in frames]


def _round_channel(value: float, digits: int) -> float | int:
    """取整到 `digits` 位；整数值落成 ``int``（避免磁盘上出现 ``100.0``）。

    顺手把 ``-0.0`` 归零——不然 JSON 里会冒出 ``-0.0``，逐字节比对时莫名其妙。
    """
    r = round(float(value), digits)
    if r == 0:
        return 0
    if r == int(r):
        return int(r)
    return r


def write_keyframe(pose: Any) -> dict:
    """计算态姿态 → 磁盘帧：**省掉一切等于缺省的键**，键序固定。

    键序恒为 ``atMs, x, y, rotation, scale|scaleX, scaleY, alpha, sortY``
    （dict 的插入序 = ``json.dumps`` 的字节序，所以这是硬契约的一部分）。

    省键规则（**先取整再比较**，免得 ``200.0001`` 和 ``200`` 判成不等而多写一个键）:

    - ``rotation == 0`` / ``alpha == 1`` → 不写；
    - ``scaleX == scaleY`` → 合并写 ``scale``；再等于 1 → 连 ``scale`` 都不写；
    - ``scaleX != scaleY`` → 两个都写（哪怕其中一个是 1，缺了就会被当成"走 scale"）；
    - ``sortY == y`` → 不写（缺省就是 y）。

    **恒不写 `easing`**：密帧 + 段缓动 = 缓动两遍。这条与 parallax 同一硬契约，
    别"顺手支持一下"。
    """
    p: dict = pose if isinstance(pose, dict) else {}
    x = _round_channel(as_number(p.get("x"), 0.0), _ROUND_DIGITS["x"])
    y = _round_channel(as_number(p.get("y"), 0.0), _ROUND_DIGITS["y"])
    rotation = _round_channel(as_number(p.get("rotation"), 0.0), _ROUND_DIGITS["rotation"])
    scale_x = _round_channel(as_number(p.get("scaleX"), 1.0), _ROUND_DIGITS["scaleX"])
    scale_y = _round_channel(as_number(p.get("scaleY"), 1.0), _ROUND_DIGITS["scaleY"])
    alpha = _round_channel(as_number(p.get("alpha"), 1.0), _ROUND_DIGITS["alpha"])
    sort_y = _round_channel(as_number(p.get("sortY"), y), _ROUND_DIGITS["sortY"])

    out: dict = {"atMs": int(round(as_number(p.get("atMs"), 0.0))), "x": x, "y": y}
    if rotation != 0:
        out["rotation"] = rotation
    if scale_x == scale_y:
        if scale_x != 1:
            out["scale"] = scale_x
    else:
        out["scaleX"] = scale_x
        out["scaleY"] = scale_y
    if alpha != 1:
        out["alpha"] = alpha
    if sort_y != y:
        out["sortY"] = sort_y
    return out


# ---------------------------------------------------------------------------
# 轨迹：整体规范化 / 新建 / 查找
# ---------------------------------------------------------------------------

def normalize_target(target: Any) -> dict:
    """``TrajectoryTargetRef`` 规范化：`kind` 非法一律落到 ``'npc'``。

    ``kind`` 为 ``player`` 时 `id` 无意义，直接丢掉——留着只会
    在选择器里显示成"玩家（某个 npc id）"这种自相矛盾的标签。
    （``camera`` 已不是轨迹目标：运镜走 cameraFollowActor / cameraMove 那一族。）
    """
    src: dict = target if isinstance(target, dict) else {}
    kind = str(src.get("kind") or "").strip()
    if kind not in TRAJECTORY_TARGET_KINDS:
        kind = "npc"
    out: dict = {"kind": kind}
    if kind == "npc":
        tid = str(src.get("id") or "").strip()
        if tid:
            out["id"] = tid
    return out


def normalize_trajectory(d: Any) -> dict:
    """``TrajectoryAsset``（或任何带 keyframes 的轨迹 dict）→ **计算态**副本（不改入参）。

    - `keyframes` 全部过 :func:`normalize_keyframe`（七通道填满，**不是**磁盘形）；
    - `target` 过 :func:`normalize_target`；
    - `id` / `label` 归一成 str；
    - 其余键（含 `source` 与任何未知键）**原样深拷贝保留**——本函数是算东西用的，
      不是写盘用的，绝不能顺手把作者面的数据吃掉。

    ⚠ 返回值**不能直接写回磁盘**：`keyframes` 是填满形。写盘走
    :func:`write_keyframe`（烘焙产物）或原样保留磁盘上那份。
    """
    src: dict = d if isinstance(d, dict) else {}
    out: dict = copy.deepcopy(src)
    out["id"] = str(src.get("id") or "").strip()
    label = src.get("label")
    if isinstance(label, str) and label.strip():
        out["label"] = label.strip()
    elif "label" in out:
        del out["label"]
    if "target" in src:
        out["target"] = normalize_target(src.get("target"))
    out["keyframes"] = normalize_keyframes(src.get("keyframes"))
    return out
