"""当前目录条目的 QStandardItemModel 填充：多列，UserRole=绝对路径、是否目录。"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from PySide6.QtCore import Qt, QModelIndex
from PySide6.QtGui import QIcon, QStandardItem, QStandardItemModel

from .file_ops import list_dir_all, list_natural_dir
from .filters import search_accepts, type_filter_accepts

if TYPE_CHECKING:
    from .metadata_store import AssetMetadata

PATH_ROLE = int(Qt.UserRole) + 1
IS_DIR_ROLE = int(Qt.UserRole) + 2
SIZE_NUM_ROLE = int(Qt.UserRole) + 3
MTIME_ROLE = int(Qt.UserRole) + 4


def _fmt_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    for u, div in (("KB", 1024), ("MB", 1024**2), ("GB", 1024**3)):
        v = n / div
        if v < 1024 or u == "GB":
            return f"{v:.1f} {u}"
    return f"{n} B"


def _fmt_time(ts: float | None) -> str:
    if ts is None:
        return ""
    try:
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
    except (ValueError, OSError):
        return ""


@dataclass
class PopulateOptions:
    filter_type: str = "all"
    search: str = ""
    metadata: "AssetMetadata | None" = None
    recursive: bool = False

    def tag_fn(self) -> Callable[[str], list[str]] | None:
        if not self.metadata:
            return None
        m = self.metadata
        from . import metadata_store as ms

        def _tags(p: str) -> list[str]:
            k = ms.norm_key(p)
            return m.tags.get(k, [])

        return _tags


def populate_dir_model(
    model: QStandardItemModel,
    dir_path: str,
    opts: PopulateOptions,
    *,
    set_placeholder_icon: bool = True,
) -> list[str]:
    """填充模型；返回通过过滤的文件路径顺序列表。"""
    model.removeRows(0, model.rowCount())
    paths_out: list[str] = []
    tag_fn = opts.tag_fn()
    base = Path(dir_path)
    it = list_dir_all(dir_path, recursive=opts.recursive) if opts.recursive else list_natural_dir(dir_path)
    for child in it:
        p = str(child)
        if not type_filter_accepts(p, opts.filter_type):
            continue
        if not search_accepts(p, opts.search, tags_for_path=tag_fn):
            continue
        paths_out.append(p)
        try:
            name = child.relative_to(base).as_posix() if opts.recursive else child.name
        except ValueError:
            name = child.name
        is_dir = child.is_dir()
        size_s = ""
        mtime_s = ""
        size_num = 0
        mtime_ts: float | None = None
        if is_dir:
            size_s = "<文件夹>"
        else:
            try:
                st = child.stat()
                size_num = st.st_size
                mtime_ts = st.st_mtime
                size_s = _fmt_size(st.st_size)
                mtime_s = _fmt_time(st.st_mtime)
            except OSError:
                size_s = "?"
        it0 = QStandardItem(name)
        it0.setData(p, PATH_ROLE)
        it0.setData(is_dir, IS_DIR_ROLE)
        it0.setData(size_num, SIZE_NUM_ROLE)
        it0.setData(mtime_ts, MTIME_ROLE)
        it1 = QStandardItem(size_s)
        it2 = QStandardItem(mtime_s)
        if is_dir and set_placeholder_icon:
            it0.setIcon(QIcon())  # 后续可被缩略图替换
        model.appendRow([it0, it1, it2])
    return paths_out


def path_at(model: QStandardItemModel, index: QModelIndex) -> str | None:
    """路径始终只挂在第 0 列，避免在表视图中点选第 1/2 列时取错 item。"""
    if not index.isValid():
        return None
    it = model.item(index.row(), 0)
    if it is None:
        return None
    v = it.data(PATH_ROLE)
    return str(v) if v is not None else None
