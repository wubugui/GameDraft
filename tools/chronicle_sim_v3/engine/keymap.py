"""key ↔ Path 双向映射（schema 驱动）。

设计原则：
- 节点只见 key（如 `chronicle.events:week=3`），从不拼路径
- 所有持久化 IO 走 `key_to_path` / `path_to_key`
- key 的 base/path/listing/text/yaml 等属性来自 `data/context_schema.yaml`
"""
from __future__ import annotations

import re
from pathlib import Path

from tools.chronicle_sim_v3.engine.context_schema import load_context_schema_registry
from tools.chronicle_sim_v3.engine.errors import ValidationError

_BASE_RE = re.compile(r"^([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*)(?::(.*))?$")


def parse_key(key: str) -> tuple[str, dict[str, str]]:
    """解析 key 为 (base, params)。"""
    m = _BASE_RE.match(key)
    if not m:
        raise ValidationError(f"非法 key 格式: {key!r}")
    base, raw = m.group(1), m.group(2)
    if not raw:
        return base, {}
    params: dict[str, str] = {}
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if "=" in part:
            k, _, v = part.partition("=")
            params[k.strip()] = v.strip()
        else:
            params["_"] = part
    return base, params


def is_listing_key(key: str) -> bool:
    base, _ = parse_key(key)
    return load_context_schema_registry().is_listing_base(base)


def key_to_path(key: str, run_dir: Path) -> Path:
    base, params = parse_key(key)
    rel = load_context_schema_registry().key_to_path(base, params)
    return (Path(run_dir) / rel).resolve()


def is_text_key(key: str) -> bool:
    base, _ = parse_key(key)
    return load_context_schema_registry().storage_for(base) == "text"


def scan_keys(prefix: str, run_dir: Path) -> list[str]:
    base, params = parse_key(prefix)
    return load_context_schema_registry().scan_keys(base, params, Path(run_dir))


def path_to_key(path: Path, run_dir: Path) -> str:
    p = Path(path).resolve()
    rd = Path(run_dir).resolve()
    try:
        rel = p.relative_to(rd).as_posix()
    except ValueError as e:
        raise ValidationError(f"path 不在 run_dir 内: {p}") from e
    return load_context_schema_registry().path_to_key(rel)
