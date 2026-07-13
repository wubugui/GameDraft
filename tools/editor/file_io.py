"""JSON file I/O for the GameDraft editor."""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path


def read_json(path: Path) -> dict | list:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _json_text(data: dict | list) -> str:
    txt = json.dumps(data, ensure_ascii=False, indent=2)
    if not txt.endswith("\n"):
        txt += "\n"
    return txt


def write_json(path: Path, data: dict | list) -> None:
    """Write JSON atomically via temp file + replace to avoid truncated files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = _json_text(data).encode("utf-8")
    fd, tmp_path = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp_path, path)
    finally:
        if os.path.isfile(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass


class StagedJsonWriter:
    """两阶段 JSON 批量写：stage 阶段把每个目标文件序列化并写入同目录 .tmp（任何失败
    经 abort 清理，磁盘零变化）；commit 阶段统一 os.replace。把「多文件保存中途失败
    留下半保存工程」的失败窗口从『序列化+写入全过程』压缩到『纯 rename 序列』。

    用法（commit 成功后 abort 为 no-op，可放 finally 兜底）::

        w = StagedJsonWriter()
        try:
            w.add(path_a, data_a)
            w.add(path_b, data_b)
            w.commit()
        finally:
            w.abort()
    """

    def __init__(self) -> None:
        self._staged: list[tuple[str, Path]] = []  # (tmp 路径, 目标路径)
        self._committed = False

    def add(self, path: Path, data: dict | list) -> None:
        """序列化 data 并写入 path 同目录下的临时文件（不触碰 path 本身）。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        blob = _json_text(data).encode("utf-8")
        fd, tmp_path = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
        )
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(blob)
                fh.flush()
                os.fsync(fh.fileno())
        except BaseException:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            raise
        self._staged.append((tmp_path, path))

    def commit(self) -> None:
        """把全部暂存文件替换到目标位置（逐个 os.replace，每个替换本身原子）。"""
        for tmp_path, target in self._staged:
            os.replace(tmp_path, target)
        self._committed = True
        self._staged.clear()

    def abort(self) -> None:
        """清理未提交的暂存文件；commit 成功后调用为 no-op。"""
        if self._committed:
            return
        for tmp_path, _target in self._staged:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        self._staged.clear()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def list_json_files(directory: Path, pattern: str = "*.json") -> list[Path]:
    if not directory.exists():
        return []
    return sorted(directory.glob(pattern))


