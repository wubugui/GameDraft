"""拍子档案库：每一拍存一份**全量世界状态**存档，跳拍/回退 = 读那份档。

为什么是全量档而不是 setState：游戏存档序列化了 28 个系统（flag / 物品 / 位面 / 任务 /
逐场景实体覆盖 / 随机数种子…），读档回到的那一刻和真玩到那儿一模一样。setState 只推状态机，
世界前置全留在原地，画面对不上。

档带 narrative_graphs.json 的指纹：内容改过之后旧档可能指向已删除的状态，那种"读了档
但状态机停在不存在的状态"是最难查的脏局，宁可标灰让人重收。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

STORE_DIRNAME = "narrative_debugger/savepoints"
INDEX_NAME = "index.json"
_SAFE = re.compile(r"[^0-9A-Za-z_一-鿿.-]+")


@dataclass(frozen=True)
class Savepoint:
    key: str
    label: str
    graph_id: str
    state_id: str
    fingerprint: str
    captured_at: str
    scene_id: str
    filename: str
    drifted: bool = False
    """补记的（演出中存不上、等结束才补）——现场可能已经走过这一拍了。"""

    @property
    def stale(self) -> bool:
        return False  # 由 store 结合当前指纹判定，见 SavepointStore.is_stale

    def as_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "label": self.label,
            "graphId": self.graph_id,
            "stateId": self.state_id,
            "fingerprint": self.fingerprint,
            "capturedAt": self.captured_at,
            "sceneId": self.scene_id,
            "filename": self.filename,
            "drifted": self.drifted,
        }


class SavepointStore:
    """存档点仓库。

    指纹是**逐图**的（graph_fingerprints[graph_id]），不是整个 narrative_graphs.json
    的哈希：策划一天改十几次，用全局哈希的话改一个错别字就让所有点集体变灰，
    每跳一次弹一次窗——那个代价他天天付。
    """

    def __init__(self, project_root: Path, fingerprint: str, graph_fingerprints: dict[str, str] | None = None) -> None:
        self.root = Path(project_root) / "resources/editor_projects/editor_data" / STORE_DIRNAME
        self.fingerprint = fingerprint
        self.graph_fingerprints: dict[str, str] = dict(graph_fingerprints or {})
        self._points: dict[str, Savepoint] = {}
        self._order: list[str] = []
        self.load()

    def _fingerprint_for(self, graph_id: str) -> str:
        return self.graph_fingerprints.get(graph_id) or self.fingerprint

    # ---- 持久化 -------------------------------------------------------

    @property
    def index_path(self) -> Path:
        return self.root / INDEX_NAME

    def load(self) -> None:
        self._points.clear()
        self._order.clear()
        try:
            raw = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        for row in raw.get("savepoints") or []:
            if not isinstance(row, dict):
                continue
            point = Savepoint(
                key=str(row.get("key") or ""),
                label=str(row.get("label") or ""),
                graph_id=str(row.get("graphId") or ""),
                state_id=str(row.get("stateId") or ""),
                fingerprint=str(row.get("fingerprint") or ""),
                captured_at=str(row.get("capturedAt") or ""),
                scene_id=str(row.get("sceneId") or ""),
                filename=str(row.get("filename") or ""),
                drifted=row.get("drifted") is True,
            )
            if not point.key:
                continue
            self._points[point.key] = point
            self._order.append(point.key)

    def _save_index(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {
            "fingerprint": self.fingerprint,
            "savepoints": [self._points[k].as_dict() for k in self._order if k in self._points],
        }
        self.index_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )

    # ---- 读写 ---------------------------------------------------------

    def capture(
        self,
        key: str,
        label: str,
        payload: str,
        *,
        graph_id: str = "",
        state_id: str = "",
        scene_id: str = "",
        drifted: bool = False,
    ) -> Savepoint:
        self.root.mkdir(parents=True, exist_ok=True)
        filename = f"{_slug(key)}.json"
        (self.root / filename).write_text(payload, encoding="utf-8")
        point = Savepoint(
            key=key,
            label=label or key,
            graph_id=graph_id,
            state_id=state_id,
            fingerprint=self._fingerprint_for(graph_id),
            captured_at=datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            scene_id=scene_id,
            filename=filename,
            drifted=drifted,
        )
        if key not in self._points:
            self._order.append(key)
        self._points[key] = point
        self._save_index()
        return point

    def payload(self, key: str) -> str | None:
        point = self._points.get(key)
        if point is None:
            return None
        try:
            return (self.root / point.filename).read_text(encoding="utf-8")
        except OSError:
            return None

    def get(self, key: str) -> Savepoint | None:
        return self._points.get(key)

    def has(self, key: str) -> bool:
        return key in self._points

    def is_stale(self, key: str) -> bool:
        """只有这个点所属的那张图变过，才算可能对不上。"""
        point = self._points.get(key)
        if point is None:
            return False
        expected = self._fingerprint_for(point.graph_id)
        return bool(expected) and bool(point.fingerprint) and point.fingerprint != expected

    def all(self) -> list[Savepoint]:
        return [self._points[k] for k in self._order if k in self._points]

    def delete(self, key: str) -> bool:
        point = self._points.pop(key, None)
        if point is None:
            return False
        self._order = [k for k in self._order if k != key]
        try:
            (self.root / point.filename).unlink()
        except OSError:
            pass
        self._save_index()
        return True

    def clear(self) -> int:
        count = len(self._points)
        for key in list(self._points):
            self.delete(key)
        return count

    def disk_bytes(self) -> int:
        total = 0
        for point in self._points.values():
            try:
                total += (self.root / point.filename).stat().st_size
            except OSError:
                continue
        return total


def _slug(value: str) -> str:
    cleaned = _SAFE.sub("_", value).strip("_")
    return cleaned[:120] or "savepoint"
