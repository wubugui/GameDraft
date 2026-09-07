"""动画挂点（sockets）与落脚帧（contactSlots）的编辑器侧读写与几何。

数据是 sidecar：``<动画包目录>/sockets.json``，**产线永不触碰**（导出器从零拼 anim.json，
挂点跟它生命周期不同）。按**图集槽位**索引——同一张图＝同一个手的位置＝同一只脚落地，
导出的去重合并还强化了这一点。落脚帧（``contactSlots``）与挂点同住一份文件、同一份指纹，
在同一个面板里看着图逐帧标；运行时据它决定哪一帧播脚步声。

``atlas`` 是图集指纹：重导出后槽位会漂移，对不上就整份判失效（stale），拒绝使用并提示重标。
盲用漂移后的槽位号会静默挂错位置，比不挂更坏。

⚠ 只是网格指纹（cols/rows/槽位数）：重抠图但网格没变**检测不出来**，
那种情况得靠人重看一遍。这是本机制已知且刻意的边界。

`socket_pose_to_local` 是 ``src/data/animationSockets.ts`` 的 `socketPoseToLocal` 的
**跨语言镜像**——两边必须逐值一致，由 `test_socket_pose_parity.py` 钉死
（norms 第 8 条：手工镜像必配语义级 parity）。
"""
from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

from ..file_io import read_json, write_json

SOCKETS_SCHEMA_VERSION = 1
SOCKETS_FILENAME = "sockets.json"

#: 一条 pose 允许出现的键（写盘时按此顺序，缺省值不落键）
POSE_KEYS = ("x", "y", "angle", "front", "frame")

#: 落脚帧：脚触地的图集槽位（升序去重）。与挂点同住 sidecar、同一份指纹——
#: 都是"看着这一格画的是什么"逐帧标出来的，重导出槽位漂移时一起判失效。
#: 运行时 `SpriteEntity.isContactFrameAt` 按它决定哪一帧播脚步声；空 = 这个包没有脚步。
CONTACT_SLOTS_KEY = "contactSlots"


def sockets_path_for_bundle(animation_bundles_path: Path, bundle_id: str) -> Path:
    """``<animation>/<bundle>/sockets.json``。"""
    return Path(animation_bundles_path) / str(bundle_id).strip() / SOCKETS_FILENAME


def fingerprint_of_anim(anim: dict) -> dict[str, Any]:
    """从 anim.json 取图集指纹（与 sockets.json 里存的那份比对）。

    **只取 cols / rows / slotCount**（与 TS 侧 `fingerprintOfAnim` 逐字同口径）。
    刻意不含 cellWidth/cellHeight：TS 侧那两个值经 normalizeAnimationSetDef 由纹理推导
    补全、这里读的是原始 JSON，放进指纹会让两侧对同一个包算出不同答案。
    """
    def _num(v: object, default: float = 0.0) -> float:
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else default

    frames = anim.get("atlasFrames")
    return {
        "cols": int(_num(anim.get("cols"))),
        "rows": int(_num(anim.get("rows"))),
        "slotCount": len(frames) if isinstance(frames, list) else 0,
    }


def fingerprint_matches(a: dict | None, b: dict | None) -> bool:
    if not isinstance(a, dict) or not isinstance(b, dict):
        return False
    keys = ("cols", "rows", "slotCount")
    return all(a.get(k) == b.get(k) for k in keys)


def empty_socket_set(anim: dict) -> dict[str, Any]:
    """按当前图集指纹起一份空挂点集。"""
    return {
        "schemaVersion": SOCKETS_SCHEMA_VERSION,
        "atlas": fingerprint_of_anim(anim),
        "sockets": {},
    }


def load_socket_set(path: Path) -> dict[str, Any] | None:
    """读 sockets.json；不存在或坏掉返回 None（当作没有挂点）。"""
    p = Path(path)
    if not p.is_file():
        return None
    try:
        data = read_json(p)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def save_socket_set(path: Path, data: dict) -> Path:
    """写 sockets.json（走 write_json：UTF-8 / 2 空格 / 中文不转义 / 保留键序 / 末尾换行）。

    **整份为空时删文件**：既没有挂点、也没有落脚帧，就不该在包目录里留一个空壳，
    否则每个动画包都多一个永远是 `{}` 的文件。只标了落脚帧、一个挂点都没有的
    sidecar 是合法且常见的（绝大多数会走路的包都这样），必须保留。
    """
    p = Path(path)
    sockets = data.get("sockets")
    has_sockets = isinstance(sockets, dict) and bool(sockets)
    if not has_sockets and not contact_slots_of(data):
        if p.is_file():
            p.unlink()
        return p
    p.parent.mkdir(parents=True, exist_ok=True)
    write_json(p, data)
    return p


def normalize_contact_slots(raw: object, slot_count: int = 0) -> list[int]:
    """落脚帧槽位规整：只收 `0 <= 整数 < slot_count`（slot_count<=0 时不查上界），去重升序。

    与 TS 侧 `parseContactSlots` 同口径：bool 不算整数（`True` 落成 JSON 是 `true`，
    运行时 `Number.isInteger(true)` 为 false），坏项跳过而不是整份作废。
    """
    if not isinstance(raw, list):
        return []
    out: set[int] = set()
    for v in raw:
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            continue
        if isinstance(v, float) and not float(v).is_integer():
            continue
        s = int(v)
        if s < 0 or (slot_count > 0 and s >= slot_count):
            continue
        out.add(s)
    return sorted(out)


def contact_slots_of(data: dict | None) -> list[int]:
    """读一份（内存态或磁盘态）挂点集里的落脚帧槽位；缺省/坏形状 = 空。"""
    if not isinstance(data, dict):
        return []
    return normalize_contact_slots(data.get(CONTACT_SLOTS_KEY))


def set_contact_slot(data: dict, slot: int, on: bool) -> bool:
    """把某个图集槽位标成/取消落脚帧（就地改 data）。返回是否真的变了。"""
    cur = set(contact_slots_of(data))
    s = int(slot)
    if on:
        if s in cur:
            return False
        cur.add(s)
    else:
        if s not in cur:
            return False
        cur.discard(s)
    if cur:
        data[CONTACT_SLOTS_KEY] = sorted(cur)
    else:
        data.pop(CONTACT_SLOTS_KEY, None)
    return True


def normalize_pose(raw: dict) -> dict[str, Any] | None:
    """规整一条 pose：x/y 必需，其余缺省值不落键（往返干净）。"""
    if not isinstance(raw, dict):
        return None
    def _num(key: str):
        v = raw.get(key)
        return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    x, y = _num("x"), _num("y")
    if x is None or y is None:
        return None
    out: dict[str, Any] = {"x": round(x, 5), "y": round(y, 5)}
    angle = _num("angle")
    if angle is not None and round(angle, 3) != 0:
        out["angle"] = round(angle, 3)
    if raw.get("front") is True:
        out["front"] = True
    frame = _num("frame")
    if frame is not None:
        out["frame"] = int(frame)
    return out


def sanitize_socket_set(data: dict, anim: dict) -> dict[str, Any]:
    """把编辑器内存态整理成可写盘的形状（指纹按当前图集刷新、坏 pose 丢弃）。"""
    out: dict[str, Any] = {
        "schemaVersion": SOCKETS_SCHEMA_VERSION,
        "atlas": fingerprint_of_anim(anim),
        "sockets": {},
    }
    # 落脚帧：只在非空时落键（没标过的包不该多出一个 `[]`，往返干净）；
    # 指纹已按当前图集刷新，所以槽位上界也按当前图集裁——超出的必然是漂移后的垃圾。
    contact = normalize_contact_slots(
        data.get(CONTACT_SLOTS_KEY) if isinstance(data, dict) else None,
        int(out["atlas"].get("slotCount") or 0),
    )
    if contact:
        out[CONTACT_SLOTS_KEY] = contact
    raw_sockets = data.get("sockets") if isinstance(data, dict) else None
    if not isinstance(raw_sockets, dict):
        return out
    for name, sock in raw_sockets.items():
        if not isinstance(sock, dict):
            continue
        poses_raw = sock.get("poses")
        if not isinstance(poses_raw, dict):
            continue
        poses: dict[str, Any] = {}
        for slot, pose in sorted(poses_raw.items(), key=lambda kv: int(kv[0]) if str(kv[0]).isdigit() else 1 << 30):
            norm = normalize_pose(pose)
            if norm is not None:
                poses[str(slot)] = norm
        if not poses:
            continue
        entry: dict[str, Any] = {}
        label = sock.get("label")
        if isinstance(label, str) and label.strip():
            entry["label"] = label.strip()
        entry["poses"] = poses
        out["sockets"][str(name)] = entry
    return out


def socket_pose_to_local(
    pose: dict,
    *,
    world_width: float,
    world_height: float,
    depth_scale: float = 1.0,
    facing: int = 1,
    visual_lift_y: float = 0.0,
) -> dict[str, Any]:
    """把格内归一化标注解算成**容器局部**位姿。

    ⚠ 这是 ``src/data/animationSockets.ts::socketPoseToLocal`` 的跨语言镜像，
    改一处必改两处（`test_socket_pose_parity.py` 逐值对账）。
    """
    d = depth_scale if isinstance(depth_scale, (int, float)) and depth_scale > 0 else 1.0
    try:
        d = float(d)
        if d != d or d in (float("inf"), float("-inf")):  # NaN / inf
            d = 1.0
    except (TypeError, ValueError):
        d = 1.0
    sign = -1 if facing < 0 else 1
    x = float(pose.get("x", 0.0))
    y = float(pose.get("y", 0.0))
    angle = float(pose.get("angle", 0.0) or 0.0)
    frame = pose.get("frame")
    return {
        "x": (x - 0.5) * world_width * d * sign,
        "y": visual_lift_y + (y - 1.0) * world_height * d,
        "angleDeg": angle * sign,
        "front": pose.get("front") is True,
        "frame": int(frame) if isinstance(frame, (int, float)) and not isinstance(frame, bool) else None,
        "scale": d,
        "facing": sign,
    }


def copy_pose_between_slots(data: dict, socket: str, src_slot: int, dst_slot: int) -> bool:
    """把某挂点上一帧的标注复制到另一帧（逐帧标注的主要省力手段）。"""
    sock = (data.get("sockets") or {}).get(socket)
    if not isinstance(sock, dict):
        return False
    poses = sock.get("poses")
    if not isinstance(poses, dict):
        return False
    src = poses.get(str(src_slot))
    if not isinstance(src, dict):
        return False
    poses[str(dst_slot)] = copy.deepcopy(src)
    return True


def interpolate_poses(data: dict, socket: str, slots: list[int]) -> int:
    """在给定槽位序列上做线性插值：两端已标注、中间空的按比例补。

    逐帧手点 3176 个槽位不现实，关键帧+插值是可行性前提而不是锦上添花。
    只补**空的**中间帧（已标的不覆盖），返回补了几帧。
    """
    sock = (data.get("sockets") or {}).get(socket)
    if not isinstance(sock, dict):
        return 0
    poses = sock.get("poses")
    if not isinstance(poses, dict):
        return 0
    keyed = [i for i, s in enumerate(slots) if isinstance(poses.get(str(s)), dict)]
    if len(keyed) < 2:
        return 0
    filled = 0
    for a, b in zip(keyed, keyed[1:]):
        if b - a < 2:
            continue
        pa = poses[str(slots[a])]
        pb = poses[str(slots[b])]
        for i in range(a + 1, b):
            if isinstance(poses.get(str(slots[i])), dict):
                continue
            t = (i - a) / (b - a)
            mid: dict[str, Any] = {
                "x": round(float(pa["x"]) + (float(pb["x"]) - float(pa["x"])) * t, 5),
                "y": round(float(pa["y"]) + (float(pb["y"]) - float(pa["y"])) * t, 5),
            }
            aa = float(pa.get("angle", 0) or 0)
            ab = float(pb.get("angle", 0) or 0)
            if round(aa, 3) or round(ab, 3):
                mid["angle"] = round(aa + (ab - aa) * t, 3)
            # front / frame 是离散量，插值无意义：跟起点走
            if pa.get("front") is True:
                mid["front"] = True
            if isinstance(pa.get("frame"), int):
                mid["frame"] = pa["frame"]
            poses[str(slots[i])] = mid
            filled += 1
    return filled
