"""Context 抽象（RFC v3-engine.md §5）。

设计要点：
- ContextRead 是节点访问 Run 数据的唯一只读入口
- 节点只能通过返回 Mutation 让引擎统一 commit；不许直接 IO
- 每个 read 方法对应一个 slice key；slice_hash 进 cache key
- ContextStore 内部缓存 slice hash；commit 后失效相关 key

ContextRead 用普通类实现而非 Protocol（CookContextRead），便于测试 monkey-patch。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from tools.chronicle_sim_v3.engine.canonical import canonical_hash
from tools.chronicle_sim_v3.engine.errors import EngineError, ValidationError
from tools.chronicle_sim_v3.engine.io import (
    atomic_write_json,
    atomic_write_text,
    read_json,
    read_yaml,
)
from tools.chronicle_sim_v3.engine.keymap import (
    is_listing_key,
    is_text_key,
    key_to_path,
    parse_key,
    scan_keys,
)


class ContextError(EngineError):
    """Context 读写非法（路径越界、key 不存在等）。"""


# ---------- Mutation ----------


@dataclass(frozen=True)
class Mutation:
    """节点写意图。op + key + payload；引擎统一翻译成磁盘动作。

    - put_json: payload 是 dict/list（小） 或 payload_path 指向大文件
    - put_text: payload 是 str
    - delete: 删除 key 对应文件
    - rename: key → new_key
    """

    op: Literal["put_json", "put_text", "delete", "rename"]
    key: str
    payload: Any = None
    payload_path: Path | None = None
    new_key: str | None = None

    def __post_init__(self) -> None:
        if self.op == "rename" and not self.new_key:
            raise ValidationError("rename mutation 需要 new_key")
        if self.op in ("put_json", "put_text") and self.payload is None and self.payload_path is None:
            raise ValidationError(f"{self.op} mutation 需要 payload 或 payload_path")


# ---------- ContextRead ----------


class ContextRead:
    """节点拿到的只读视图。每个方法都对应一个 slice key。

    实现策略：所有读方法都走 `_read_key`，由 ContextStore 统一缓存与失效。
    """

    def __init__(
        self,
        run_id: str,
        run_dir: Path,
        store: "ContextStore",
        week: int | None,
    ) -> None:
        self.run_id = run_id
        self.run_dir = Path(run_dir)
        self._store = store
        self.week = week

    # 通用读入口（节点也可以直接调，便于扩展）
    def read_key(self, key: str) -> Any:
        return self._store._read_key(key)

    # ---- 世界 ----
    def world_setting(self) -> dict:
        return self.read_key("world.setting") or {}

    def world_pillars(self) -> list:
        return self.read_key("world.pillars") or []

    def world_anchors(self) -> list:
        return self.read_key("world.anchors") or []

    def world_agents(self) -> list[dict]:
        # 列表型：扫目录列出所有 agent.json
        out: list[dict] = []
        for sub_key in scan_keys("world.agents", self.run_dir):
            v = self.read_key(sub_key)
            if v is not None:
                out.append(v)
        return out

    def world_agent(self, agent_id: str) -> dict | None:
        return self.read_key(f"world.agent:{agent_id}")

    def world_factions(self) -> list[dict]:
        out = []
        for sub in scan_keys("world.factions", self.run_dir):
            v = self.read_key(sub)
            if v is not None:
                out.append(v)
        return out

    def world_locations(self) -> list[dict]:
        out = []
        for sub in scan_keys("world.locations", self.run_dir):
            v = self.read_key(sub)
            if v is not None:
                out.append(v)
        return out

    def world_edges(self) -> list[dict]:
        return self.read_key("world.edges") or []

    # ---- 编年史 ----
    def chronicle_events(self, week: int) -> list[dict]:
        out = []
        for sub in scan_keys(f"chronicle.events:week={week}", self.run_dir):
            v = self.read_key(sub)
            if v is not None:
                out.append(v)
        return out

    def chronicle_intents(self, week: int) -> list[dict]:
        out = []
        for sub in scan_keys(f"chronicle.intents:week={week}", self.run_dir):
            v = self.read_key(sub)
            if v is not None:
                out.append(v)
        return out

    def chronicle_drafts(self, week: int) -> list[dict]:
        out = []
        for sub in scan_keys(f"chronicle.drafts:week={week}", self.run_dir):
            v = self.read_key(sub)
            if v is not None:
                out.append(v)
        return out

    def chronicle_rumors(self, week: int) -> list[dict]:
        return self.read_key(f"chronicle.rumors:week={week}") or []

    def chronicle_summary(self, week: int) -> str:
        return self.read_key(f"chronicle.summary:week={week}") or ""

    def chronicle_observation(self, week: int) -> dict:
        return self.read_key(f"chronicle.observation:week={week}") or {}

    def chronicle_public_digest(self, week: int) -> dict:
        return self.read_key(f"chronicle.public_digest:week={week}") or {}

    def chronicle_beliefs(self, week: int, agent_id: str) -> list[dict]:
        return self.read_key(
            f"chronicle.beliefs:week={week},agent_id={agent_id}"
        ) or []

    def chronicle_intent_outcome(self, week: int, agent_id: str) -> dict:
        return self.read_key(
            f"chronicle.intent_outcome:week={week},agent_id={agent_id}"
        ) or {}

    def chronicle_weeks_list(self) -> list[int]:
        out: list[int] = []
        for entry in scan_keys("chronicle.weeks", self.run_dir):
            # entry 形如 "week=N"
            try:
                out.append(int(entry.split("=")[1]))
            except (IndexError, ValueError):
                continue
        return sorted(out)

    # ---- 设定库 ----
    def ideas_list(self) -> list[dict]:
        return self.read_key("ideas.list") or []

    def ideas_body(self, idea_id: str) -> str:
        return self.read_key(f"ideas.entry:id={idea_id}") or ""

    # ---- 配置 ----
    def config_llm(self) -> dict:
        return self.read_key("config.llm") or {}

    def config_cook(self) -> dict:
        return self.read_key("config.cook") or {}


# ---------- ContextStore ----------


class ContextStore:
    """Run 内 Context 的唯一持久化与缓存层。

    - read：按 key 读盘并缓存 slice hash
    - commit：原子写 mutation 并失效对应 slice 缓存
    """

    def __init__(self, run_dir: Path, run_id: str = "") -> None:
        self.run_dir = Path(run_dir)
        self.run_id = run_id
        self._slice_cache: dict[str, str] = {}  # key → hash
        self._value_cache: dict[str, Any] = {}  # key → value（同 cook 内复用）

    def read_view(self, week: int | None = None) -> ContextRead:
        return ContextRead(self.run_id, self.run_dir, self, week)

    def _read_key(self, key: str) -> Any:
        if key in self._value_cache:
            return self._value_cache[key]
        v = self._load_from_disk(key)
        self._value_cache[key] = v
        return v

    def _load_from_disk(self, key: str) -> Any:
        base, _ = parse_key(key)
        path = key_to_path(key, self.run_dir)
        if base == "config.llm" or base == "config.cook":
            return read_yaml(path) if path.is_file() else None
        if is_text_key(key):
            return path.read_text(encoding="utf-8") if path.is_file() else None
        if not path.is_file():
            return None
        try:
            return read_json(path)
        except Exception as e:
            raise ContextError(f"读 key {key!r} 失败 ({path}): {e}") from e

    def slice_hash(self, key: str) -> str:
        """对应 slice 的 sha256；按需计算并缓存到 _slice_cache。

        列表型 key（world.agents / chronicle.events:week=N 等）：
        hash = canonical_hash({"key": key, "items": [(sub_key, sub_hash), ...]})
        这样新增 / 删除 / 修改任一子项都会改变父 hash。
        """
        if key in self._slice_cache:
            return self._slice_cache[key]
        if is_listing_key(key):
            sub_keys = scan_keys(key, self.run_dir)
            items = [(sk, self.slice_hash(sk)) for sk in sub_keys]
            h = canonical_hash({"key": key, "items": items})
        else:
            try:
                v = self._read_key(key)
            except ContextError:
                v = None
            h = canonical_hash({"key": key, "value": _normalize_for_hash(v)})
        self._slice_cache[key] = h
        return h

    def slice_hash_combined(self, keys: list[str]) -> str:
        """对一组 slice key 取联合 hash：按 key 字典序两两拼接。"""
        if not keys:
            return canonical_hash({"reads": []})
        parts = [(k, self.slice_hash(k)) for k in sorted(set(keys))]
        return canonical_hash({"reads": parts})

    def commit(self, mutations: list[Mutation]) -> None:
        """按 key 字典序串行写盘；commit 后失效相关 slice。"""
        sorted_muts = sorted(mutations, key=lambda m: (m.key, m.op))
        affected: set[str] = set()
        for m in sorted_muts:
            self._apply(m)
            affected.add(m.key)
            if m.new_key:
                affected.add(m.new_key)
        for k in affected:
            self._slice_cache.pop(k, None)
            self._value_cache.pop(k, None)
            # 同前缀的列表型父 key 也要失效（如 add agent → world.agents 父列表）
            base, _ = parse_key(k)
            parent_listings = _PARENT_LISTING_BASES.get(base, ())
            for cached in list(self._slice_cache.keys()):
                cb, _ = parse_key(cached)
                if cb in parent_listings:
                    self._slice_cache.pop(cached, None)
                    self._value_cache.pop(cached, None)

    def _apply(self, m: Mutation) -> None:
        if m.op == "delete":
            p = key_to_path(m.key, self.run_dir)
            if p.is_file():
                p.unlink()
            return
        if m.op == "rename":
            src = key_to_path(m.key, self.run_dir)
            dst = key_to_path(m.new_key or "", self.run_dir)
            if not src.is_file():
                raise ContextError(f"rename 源不存在: {m.key}")
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.rename(dst)
            return
        if m.op == "put_text":
            p = key_to_path(m.key, self.run_dir)
            text = m.payload
            if text is None and m.payload_path is not None:
                text = m.payload_path.read_text(encoding="utf-8")
            atomic_write_text(p, str(text))
            return
        if m.op == "put_json":
            p = key_to_path(m.key, self.run_dir)
            payload = m.payload
            if payload is None and m.payload_path is not None:
                payload = read_json(m.payload_path)
            atomic_write_json(p, payload)
            return
        raise ContextError(f"未知 mutation op: {m.op!r}")


# 子条目 base → 受影响的父列表 base（commit 失效用）
_PARENT_LISTING_BASES: dict[str, tuple[str, ...]] = {
    "world.agent": ("world.agents",),
    "world.faction": ("world.factions",),
    "world.location": ("world.locations",),
    "chronicle.event": ("chronicle.events",),
    "chronicle.intent": ("chronicle.intents",),
    "chronicle.draft": ("chronicle.drafts",),
}


def _normalize_for_hash(v: Any) -> Any:
    """让缺值与各种空容器在 hash 中可比较。"""
    if v is None:
        return None
    if isinstance(v, (dict, list, str, int, float, bool)):
        return v
    return str(v)
