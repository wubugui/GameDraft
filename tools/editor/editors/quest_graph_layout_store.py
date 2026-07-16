"""Editor-only persistence of manual quest-graph node positions.

红线：导出的游戏数据必须逐字节一致。任务/分组的位置**绝不**写进
``public/assets/data`` 下的游戏 JSON（也不进 ``types.ts``）。本模块把作者手动
摆放的节点坐标存到工程根下的编辑器侧档 ``.editor/quest_graph_layout.json``，
游戏运行时永不读取它。

侧档格式（JSON）::

    {
      "top::<groupId>": [x, y],
      "grp::<groupId>::<nodeId>": [x, y],
      ...
    }

- 顶层视图（全部分组）用 ``top::<groupId>`` 命名空间。
- 进入某分组后的视图用 ``grp::<groupId>::<nodeId>``，``nodeId`` 可能是任务 id，
  也可能是子分组 id；分组前缀避免不同视图/不同 id 命名空间撞键。

容错：侧档缺失 / 损坏 / 非法 → 视为空，绝不抛异常。``project_path`` 为 None 时
（未加载工程）静默退化为「不持久化」。
"""
from __future__ import annotations

import json
from pathlib import Path

_SIDE_FILE_REL = (".editor", "quest_graph_layout.json")


class QuestGraphLayoutStore:
    """加载/保存任务图节点坐标的编辑器侧档。

    每个键映射到 ``[x, y]``。保存时按当前实际存在的节点键集合裁剪陈旧条目
    （重命名/删除的节点不再保留），但只针对「本次明确知道存在哪些键」的视图。
    """

    def __init__(self, project_path: Path | None):
        self._project_path: Path | None = Path(project_path) if project_path else None
        self._positions: dict[str, list[float]] = {}
        self._loaded = False

    # ------------------------------------------------------------------ paths
    def _side_file(self) -> Path | None:
        if self._project_path is None:
            return None
        return self._project_path.joinpath(*_SIDE_FILE_REL)

    # ------------------------------------------------------------------ load
    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        path = self._side_file()
        if path is None or not path.is_file():
            return
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            # 缺失 / 损坏 / 非 UTF-8 → 当作空，绝不崩
            return
        if not isinstance(raw, dict):
            return
        clean: dict[str, list[float]] = {}
        for key, val in raw.items():
            if not isinstance(key, str):
                continue
            if (
                isinstance(val, (list, tuple))
                and len(val) == 2
                and all(isinstance(c, (int, float)) for c in val)
            ):
                clean[key] = [float(val[0]), float(val[1])]
        self._positions = clean

    def get(self, key: str) -> tuple[float, float] | None:
        """返回某节点键已保存的坐标，没有则 None。"""
        self._ensure_loaded()
        v = self._positions.get(key)
        if v is None:
            return None
        return (v[0], v[1])

    # ------------------------------------------------------------------ save
    def set(self, key: str, x: float, y: float, *, valid_keys: set[str] | None = None) -> None:
        """记录某节点坐标并立即落盘。

        ``valid_keys`` 给出本视图当前存在的全部节点键；提供时会顺带裁剪掉这些键
        所在「视图前缀」下已不存在的陈旧条目（重命名/删除的节点）。其它视图的键
        不受影响。
        """
        self._ensure_loaded()
        self._positions[key] = [float(x), float(y)]
        if valid_keys is not None:
            self._prune_to(valid_keys)
        self._flush()

    def _prune_to(self, valid_keys: set[str]) -> None:
        """裁剪：只在与 ``valid_keys`` 同前缀（top:: 或 grp::<gid>::）的命名空间内剪。

        据 ``valid_keys`` 推断当前视图前缀，删掉该前缀下不在 ``valid_keys`` 的键；
        不碰其它视图前缀，避免误删未在本次重建的视图坐标。
        """
        prefixes = {self._prefix_of(k) for k in valid_keys}
        prefixes.discard(None)
        if not prefixes:
            return
        for key in list(self._positions.keys()):
            pre = self._prefix_of(key)
            if pre in prefixes and key not in valid_keys:
                del self._positions[key]

    @staticmethod
    def _prefix_of(key: str) -> str | None:
        if key.startswith("top::"):
            return "top::"
        if key.startswith("grp::"):
            parts = key.split("::")
            if len(parts) >= 3:
                return f"grp::{parts[1]}::"
        return None

    def _flush(self) -> None:
        path = self._side_file()
        if path is None:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(
                json.dumps(self._positions, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
        except OSError:
            # 写盘失败（只读盘等）不该让编辑器崩
            return
