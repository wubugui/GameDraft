"""场景 id 的准入判定 + 新场景最小骨架 —— **新老画布共用这一份**，零 Qt。

## 为什么不是「字母 / 数字 / 下划线」

老画布的「新建场景」曾用「仅字母 / 数字 / 下划线 / 连字符」的正则拦 id。而工程里的场景 id 有一大半是
中文（义庄 / 城门口 / 雾津街头 / 梦_饭屋 …），运行时、validator、打包一路都认 ——
那条正则拦下的不是"会坏的 id"，是"看着不像英文变量名的 id"，策划只好给中文场景
起拼音代号再靠 name 找回来。norms 不变量 7：**Python 兜底校验必须是 TS 权威校验的
子集**，比运行时更严 = 编辑器拒绝合法数据。

## 真正的约束从哪来

场景 id 会变成三样东西，约束只从这三样反推，此外一律放行：

1. **文件名 / 目录名**：``public/assets/scenes/<id>.json`` 与
   ``runtime/scenes/<id>/…``。所以不能含路径分隔符与 Windows 文件名禁用字符，
   不能以 ``.`` 开头（Unix 隐藏文件，glob / 同步脚本常默认跳过）或结尾（Windows
   静默截掉末尾的点），不能撞 Windows 保留设备名（``CON`` / ``NUL`` / ``COM1`` …）。
   **只差大小写的两个 id 在 Windows / macOS 上是同一个文件**，Save All 会互相覆盖，
   也按撞名拒。
2. **限定引用** ``sceneId:groupId``（validator 与分组选择器按第一个 ``:`` 切）→
   id 里不能有 ``:``。
3. **命令行参数** ``--scene <id>``（烘焙 / 审计 / 各 py 工具经 shell 包装脚本传参）→
   不含空白，免得每层包装都得把引号加对。

两个画布的「新建场景」都只调 :func:`scene_id_problem` 与 :func:`new_scene_skeleton`：
判定与骨架各只有一份，两边不会各自漂移。
"""
from __future__ import annotations

from typing import Iterable

__all__ = ["SCENE_ID_HINT", "scene_id_problem", "new_scene_skeleton"]

#: 输入框旁的一句话提示。两个画布的弹窗共用，免得一边说"仅字母数字"一边说"中文可用"。
SCENE_ID_HINT = "中文可用；不能含空白、/ \\ :、以及 < > \" | ? *"

_PATH_SEPARATORS = frozenset("/\\")
_WINDOWS_ILLEGAL = frozenset('<>"|?*')
_WINDOWS_RESERVED = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)


def scene_id_problem(scene_id: str, existing: Iterable[str] = ()) -> str | None:
    """判 ``scene_id`` 能不能当新场景的 id。返回给用户看的原因；``None`` = 可以。

    ``existing`` 是现有场景 id（通常直接传 ``model.scenes``），用来查撞名 ——
    包括只差大小写的撞名。调用方应先 ``strip()``；没 strip 的话首尾空白也会在这里被拒。
    """
    sid = str(scene_id or "")
    if not sid:
        return "场景 id 不能为空。"
    if any(ch.isspace() for ch in sid):
        return (f"场景 id 不能含空白字符：{sid!r}"
                "（它会作为 --scene 参数传给烘焙 / 审计工具）。")
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in sid):
        return f"场景 id 含控制字符：{sid!r}。"
    if any(ch in _PATH_SEPARATORS for ch in sid):
        return f"场景 id 不能含 / 或 \\：{sid!r}（它就是文件名 scenes/<id>.json）。"
    if ":" in sid:
        return f"场景 id 不能含 ':'：{sid!r}（限定引用按 sceneId:groupId 切分）。"
    bad = sorted(ch for ch in set(sid) if ch in _WINDOWS_ILLEGAL)
    if bad:
        return f"场景 id 不能含 Windows 文件名禁用字符 {' '.join(bad)}：{sid!r}。"
    if sid.startswith("."):
        return (f"场景 id 不能以 '.' 开头：{sid!r}"
                "（Unix 上是隐藏文件，同步 / 打包脚本常默认跳过）。")
    if sid.endswith("."):
        return f"场景 id 不能以 '.' 结尾：{sid!r}（Windows 会静默截掉末尾的点）。"
    if sid.split(".", 1)[0].upper() in _WINDOWS_RESERVED:
        return (f"场景 id 与 Windows 保留设备名冲突：{sid!r}"
                "（这个名字在 Windows 上建不出文件）。")
    existing_ids = [str(e) for e in existing]
    if sid in existing_ids:
        return f"场景 id 已存在：{sid}"
    folded = sid.casefold()
    for other in existing_ids:
        if other.casefold() == folded:
            return (f"场景 id {sid!r} 与已有场景 {other!r} 只差大小写，"
                    "在 Windows / macOS 上是同一个文件，Save All 会互相覆盖。")
    return None


def new_scene_skeleton(scene_id: str, name: str = "") -> dict:
    """新场景的最小合法骨架。

    world 尺寸留 0（导入背景图后按图推导）、背景空、给一个出生点占位。
    不预建任何目录：本场景的 runtime 目录在导入背景图时按需创建。
    两个画布都从这里拿，字段列表只维护一处。
    """
    sid = str(scene_id or "").strip()
    return {
        "id": sid,
        "name": str(name or "").strip() or sid,
        "worldWidth": 0,
        "worldHeight": 0,
        "backgrounds": [],
        "spawnPoint": {"x": 400.0, "y": 400.0},
        "hotspots": [],
        "npcs": [],
        "zones": [],
    }
