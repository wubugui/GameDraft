"""文件 IO 工具：YAML / JSON / 原子写。

设计：
- 任何持久化都走原子 write_text/write_bytes（tmp + os.replace），避免半文件
- YAML 走 ruamel round-trip 模式，保证 read→write 字节稳定（注释 / 顺序 / 块缩进保留）
- canonical write_yaml_canonical 用固定 key 顺序输出，作为唯一规范出口
- key→path 映射放到 P1-1 的 engine/io.py 扩展，本文件不实现
"""
from __future__ import annotations

import json
import os
import tempfile
from io import StringIO
from pathlib import Path
from typing import Any

from ruamel.yaml import YAML
from ruamel.yaml.comments import CommentedMap


def _yaml_loader() -> YAML:
    y = YAML(typ="rt")
    y.preserve_quotes = True
    y.width = 4096
    y.indent(mapping=2, sequence=4, offset=2)
    return y


def _yaml_dumper() -> YAML:
    return _yaml_loader()


def read_yaml(path: str | os.PathLike[str]) -> Any:
    """读 yaml；空文件返回 {}。"""
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    if not text.strip():
        return {}
    yaml = _yaml_loader()
    return yaml.load(text)


def read_yaml_text(text: str) -> Any:
    yaml = _yaml_loader()
    return yaml.load(text)


def dump_yaml_str(data: Any) -> str:
    yaml = _yaml_dumper()
    buf = StringIO()
    yaml.dump(data, buf)
    return buf.getvalue()


def write_yaml_canonical(
    path: str | os.PathLike[str],
    data: dict[str, Any],
    key_order: list[str] | None = None,
) -> None:
    """按 key_order 重排顶层 key 后落盘。

    顺序之外的 key 追加在末尾（按 sorted 稳定）。文件末尾保证 LF。
    """
    if not isinstance(data, dict):
        raise TypeError("write_yaml_canonical 仅支持顶层为 dict")
    ordered = CommentedMap()
    seen: set[str] = set()
    if key_order:
        for k in key_order:
            if k in data:
                ordered[k] = data[k]
                seen.add(k)
    for k in sorted(data.keys()):
        if k not in seen:
            ordered[k] = data[k]
    text = dump_yaml_str(ordered)
    if not text.endswith("\n"):
        text += "\n"
    atomic_write_text(path, text)


def atomic_write_text(path: str | os.PathLike[str], text: str) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".tmp_", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def atomic_write_json(path: str | os.PathLike[str], data: Any, indent: int = 2) -> None:
    text = json.dumps(data, ensure_ascii=False, indent=indent, sort_keys=True)
    if not text.endswith("\n"):
        text += "\n"
    atomic_write_text(path, text)


def read_json(path: str | os.PathLike[str]) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))
