"""文件系统工具：读写 JSON/文本、目录列表、grep/glob 搜索，全部原子写。"""
from __future__ import annotations

import fnmatch
import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any


def _resolve(base: Path, rel: str) -> Path:
    """解析相对路径并创建父目录。"""
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def read_json(base: Path, rel: str) -> Any:
    """读取 JSON 文件。"""
    p = _resolve(base, rel)
    if not p.is_file():
        return None
    with open(p, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(base: Path, rel: str, data: Any) -> None:
    """原子写 JSON 文件：临时文件 + os.replace。"""
    p = _resolve(base, rel)
    content = json.dumps(data, ensure_ascii=False, indent=2)
    _atomic_write(p, content)


def read_text(base: Path, rel: str) -> str:
    """读取文本文件。"""
    p = _resolve(base, rel)
    if not p.is_file():
        return ""
    with open(p, "r", encoding="utf-8") as f:
        return f.read()


def delete_json(base: Path, rel: str) -> bool:
    """删除 JSON 文件，成功返回 True，不存在返回 False。"""
    p = base / rel
    if p.is_file():
        p.unlink()
        return True
    return False


def write_text(base: Path, rel: str, text: str) -> None:
    """原子写文本文件。"""
    p = _resolve(base, rel)
    _atomic_write(p, text)


def _atomic_write(path: Path, content: str) -> None:
    """原子写入：先写临时文件再 os.replace。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        os.replace(tmp, str(path))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def list_dir(base: Path, rel: str) -> list[str]:
    """列出目录内容（文件名列表）。"""
    p = _resolve(base, rel)
    if not p.is_dir():
        return []
    return sorted(os.listdir(p))


def list_dir_recursive(base: Path, rel: str) -> list[str]:
    """递归列出目录中所有文件（相对路径列表）。"""
    p = _resolve(base, rel)
    if not p.is_dir():
        return []
    result = []
    for root, _dirs, files in os.walk(p):
        for f in files:
            full = Path(root) / f
            result.append(str(full.relative_to(base)))
    return sorted(result)


def grep_search(base: Path, pattern: str, rel: str = "") -> list[tuple[str, int, str]]:
    """在目录下搜索匹配 pattern 的行。
    返回 [(相对路径, 行号, 行内容)]。
    """
    root = _resolve(base, rel)
    if not root.is_dir():
        return []
    regex = re.compile(pattern, re.IGNORECASE)
    results: list[tuple[str, int, str]] = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fname in filenames:
            if not fname.endswith((".json", ".md", ".txt", ".yaml", ".yml")):
                continue
            fpath = Path(dirpath) / fname
            try:
                with open(fpath, "r", encoding="utf-8") as f:
                    for lineno, line in enumerate(f, 1):
                        if regex.search(line):
                            rel_path = str(fpath.relative_to(base))
                            results.append((rel_path, lineno, line.rstrip()))
            except (UnicodeDecodeError, OSError):
                continue
    return results


def glob_search(base: Path, pattern: str, rel: str = "") -> list[str]:
    """glob 模式匹配文件。返回相对路径列表。"""
    root = _resolve(base, rel)
    if not root.is_dir():
        return []
    results = []
    for dirpath, _dirnames, filenames in os.walk(root):
        for fname in filenames:
            if fnmatch.fnmatch(fname, pattern):
                fpath = Path(dirpath) / fname
                results.append(str(fpath.relative_to(base)))
    return sorted(results)
