"""静态贴图实体（没有动画包的道具）—— 编辑器侧解析，运行时那一份的镜像。

运行时（`src/systems/SceneManager.ts` 的 `buildStaticDisplayAnimationSet`）的做法是:
`NpcDef.displayImage` 有图、且**没有** `animFile` 时，就地合成一份 **1×1 单帧动画集**
喂给普通 NPC 的 `SpriteEntity` 路径 —— 于是阴影 / 透视 / 深度遮挡 / 内容层排序 /
逐 entity 光照全都走 NPC 那一条，一处特判都没有。

两个画布（老 `scene_editor` 与新 `scene_v2`）都要照着预览，规则因此只维护这一份。
写成两份的下场不是报错，是**画布对策划撒谎**：尺寸/朝向与游戏里对不上，而且没人会发现。
"""
from __future__ import annotations

from pathlib import Path

from PySide6.QtGui import QPixmap

from .image_path_picker import disk_path_for_runtime_url

__all__ = [
    "DEFAULT_WORLD_WIDTH",
    "static_display_image_of",
    "static_display_disk_path",
    "static_display_pixmap",
    "static_display_world_pair",
    "static_display_facing_x",
    "npc_content_facing_x",
]

#: 与运行时 `resolveAnimationSet.DEFAULT_WORLD_WIDTH` 同值：两维都没给时的回落宽度。
DEFAULT_WORLD_WIDTH = 100.0


def static_display_image_of(npc: dict, anim_file: str = "") -> dict | None:
    """这个 NPC 该不该走静态贴图？返回生效的 ``displayImage``，否则 None。

    ``anim_file`` 传**解析过角色注册表继承之后**的那一份（画布侧用
    ``model.character_field(npc, "animFile")``）—— 两者都有时以动画包为准。
    尺寸不在判据里：多大交给 :func:`static_display_world_pair` 推，
    在这里再写一遍"多大才算有效"就是第二处真相。
    """
    if str(anim_file or "").strip():
        return None
    di = npc.get("displayImage")
    if not isinstance(di, dict):
        return None
    return di if str(di.get("image", "") or "").strip() else None


def static_display_disk_path(model, di: dict) -> Path | None:
    """展示图 URL → 本地磁盘路径（读不到返回 None，调用方画缺件占位）。"""
    img = str(di.get("image", "") or "").strip()
    if not img:
        return None
    return disk_path_for_runtime_url(model, img)


def static_display_pixmap(model, di: dict) -> QPixmap | None:
    """展示图像素；读不出来返回 None。"""
    path = static_display_disk_path(model, di)
    if path is None or not path.is_file():
        return None
    pm = QPixmap(str(path))
    return None if pm.isNull() else pm


def _pos_float(v: object) -> float:
    try:
        f = float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0.0
    return f if f > 0 else 0.0


def static_display_world_pair(
    model, di: dict, pixmap: QPixmap | None = None,
) -> tuple[float, float] | None:
    """世界尺寸；与运行时 ``resolveAnimationWorldSize`` 逐字同口径。

    合成集是 1×1，故"单格像素"就是整张图的像素 —— 两维都给就沿用，只给一维按图素
    长宽比推另一维，两维都没给回落 ``DEFAULT_WORLD_WIDTH`` × 长宽比。
    需要图素比却读不出图时返回 None（画布据此不建精灵，与"图集读不到就没有精灵"同口径）。
    """
    w = _pos_float(di.get("worldWidth"))
    h = _pos_float(di.get("worldHeight"))
    if w > 0 and h > 0:
        return (w, h)
    pm = pixmap if pixmap is not None else static_display_pixmap(model, di)
    if pm is None or pm.isNull() or pm.width() <= 0 or pm.height() <= 0:
        return None
    aspect_hw = pm.height() / pm.width()
    if w > 0:
        return (w, w * aspect_hw)
    if h > 0:
        return (h / aspect_hw, h)
    return (DEFAULT_WORLD_WIDTH, DEFAULT_WORLD_WIDTH * aspect_hw)


def static_display_facing_x(npc: dict, di: dict | None) -> int:
    """镜像符号（1 / -1）。

    ``NpcDef.initialFacing`` 一开口就以它为准（运行时 `loadSprite` 末尾照它摆），
    只有它没开口时才轮到展示图自己的 ``facing`` —— 与 `spriteSort` 同一条取舍：
    NPC 自己的字段是唯一真相，`displayImage` 那一份是热点的遗产。
    """
    f = str(npc.get("initialFacing", "") or "").strip().lower()
    if f in ("left", "right"):
        return -1 if f == "left" else 1
    if isinstance(di, dict) and str(di.get("facing", "") or "").strip().lower() == "left":
        return -1
    return 1


def npc_content_facing_x(npc: dict) -> int:
    """画布内容层用的镜像符号（只看 npc dict，不读盘、不查角色注册表）。

    给视图层用：视图那一层的硬约束是不解析资源，所以这里只认**就地**的 ``animFile``。
    "角色注册表继承来动画包、同时又写了 displayImage.facing、还不写 initialFacing"
    这个组合下会与运行时差一次镜像 —— 那本身就是自相矛盾的数据，校验器会给出警告。
    """
    di = static_display_image_of(npc, str(npc.get("animFile") or ""))
    return static_display_facing_x(npc, di)
