"""原始音源库:只进不出、只增不改。

## 为什么单独一层

原始录音是**不可再生资源**——重录要重新约人、换一天的房间声就接不上。所以:

- 源库放在 ``resources/audio_sources/``,**不在 public 下**。public 里的是成品,
  会被工具重写、被 DVC 同步、被人手删;源库不参与这些。
- 导入 = 拷贝进库,**永不移动/删除用户的原始文件**;库内文件永不被本工具改写。
  同名不同内容会另起名字,绝不覆盖。
- 每条记 sha256。重复导入同一份文件直接跳过(不产生副本);库内文件被外部改动过,
  下次扫描会**报出来**而不是默默用新内容——"源被人覆盖了"必须可见。

## 为什么记账文件放在库里

``_library.json`` 与音频放在一起:整个目录拷到另一台机器、或从 DVC 拉回来,
"这条是什么时候从哪导进来的"跟着走。放工具目录下的话,换台机器就只剩一堆孤儿文件。
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from tools.atomic_io import retry_transient

from . import audio_io as aio

#: 库内记账文件名(下划线开头,与音频文件区分)
INDEX_NAME = "_library.json"
INDEX_VERSION = 1


def default_library_root(repo_root: Path) -> Path:
    """默认源库位置:``<仓库>/resources/audio_sources``。

    选 ``resources/`` 而不是 ``public/``:前者是仓库放大文件的地方(与
    ``resources/editor_projects`` 同侧,DVC 托管面),后者是游戏运行时目录——
    **原始素材进 public 迟早会被当成成品发出去**。
    """
    return Path(repo_root) / "resources" / "audio_sources"


@dataclass
class SourceEntry:
    """库里的一条原始素材。``rel`` 是相对库根的路径,全工具唯一身份。"""

    rel: str
    sha256: str
    bytes: int
    imported_at: str
    #: 导入时的原始绝对路径(只作溯源痕迹,不保证还在)
    origin: str = ""
    note: str = ""
    #: 来源是有损编码(mp3/ogg)。**必须可见**:降噪与归一化会把编码噪声一起放大,
    #: "这条素材先天差一截"不该只存在于某个人的记忆里
    lossy: bool = False

    def to_json(self) -> dict:
        return asdict(self)


def sha256_of(path: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            b = f.read(chunk)
            if not b:
                break
            h.update(b)
    return h.hexdigest()


class SourceLibrary:
    """源库:扫描 + 导入 + 完整性校验。目录即真相,记账只作补充。"""

    def __init__(self, root: Path):
        self.root = Path(root)
        self._index: dict[str, SourceEntry] = {}
        self._load_index()

    # ---------------------------------------------------------------- 记账

    @property
    def index_path(self) -> Path:
        return self.root / INDEX_NAME

    def _load_index(self) -> None:
        try:
            raw = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            self._index = {}
            return
        items = raw.get("items") if isinstance(raw, dict) else None
        self._index = {}
        for it in items or []:
            if isinstance(it, dict) and it.get("rel"):
                self._index[str(it["rel"])] = SourceEntry(
                    rel=str(it.get("rel", "")),
                    sha256=str(it.get("sha256", "")),
                    bytes=int(it.get("bytes") or 0),
                    imported_at=str(it.get("imported_at", "")),
                    origin=str(it.get("origin", "")),
                    note=str(it.get("note", "")),
                    lossy=it.get("lossy") is True,
                )

    def _save_index(self) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        doc = {
            "version": INDEX_VERSION,
            "items": [e.to_json() for e in sorted(self._index.values(), key=lambda x: x.rel)],
        }
        tmp = self.index_path.with_suffix(".json.tmp")
        tmp.write_text(
            json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
        )
        retry_transient(os.replace, tmp, self.index_path)

    # ---------------------------------------------------------------- 扫描

    def scan(self) -> list[Path]:
        """库内全部音频文件(相对路径排序)。目录不存在时返回空列表,不报错。"""
        if not self.root.is_dir():
            return []
        out = [
            p for p in sorted(self.root.rglob("*"))
            if p.is_file() and p.suffix.lower() in aio.SUPPORTED_EXT
        ]
        return out

    def entry(self, rel: str) -> SourceEntry | None:
        return self._index.get(str(rel).replace("\\", "/"))

    def rel_of(self, path: Path) -> str:
        return str(Path(path).relative_to(self.root)).replace("\\", "/")

    def verify(self) -> list[str]:
        """完整性校验,返回人话问题列表(空 = 一切正常)。

        两类都要报:**记账里有、磁盘上没了**(素材丢了),
        **磁盘上有、内容与记账对不上**(源被覆盖了)。后者尤其危险——
        默默用新内容意味着"原始素材"这个前提已经不成立。
        """
        problems: list[str] = []
        on_disk = {self.rel_of(p): p for p in self.scan()}
        for rel, e in sorted(self._index.items()):
            p = on_disk.get(rel)
            if p is None:
                problems.append(f"{rel}：记账里有，磁盘上没了（被删或被移走）")
                continue
            if e.sha256 and sha256_of(p) != e.sha256:
                problems.append(f"{rel}：内容与导入时不一致（源被覆盖过，原件可能已丢失）")
        for rel in sorted(on_disk):
            if rel not in self._index:
                problems.append(f"{rel}：在库里但没有导入记录（手工拷进来的？）")
        return problems

    # ---------------------------------------------------------------- 导入

    def find_by_hash(self, digest: str) -> SourceEntry | None:
        for e in self._index.values():
            if e.sha256 == digest:
                return e
        return None

    def import_file(
        self, src: Path, *, subdir: str = "", note: str = "",
    ) -> tuple[SourceEntry, bool]:
        """把一个原始文件拷进库。返回 (条目, 是否新导入)。

        - 同内容已在库里 → 直接返回旧条目,``新导入=False``(不产生副本)
        - 同名不同内容 → 自动加 ``-2``/``-3`` 后缀,**绝不覆盖**
        - 源文件原地不动(拷贝,不是移动)
        """
        src = Path(src)
        if not src.is_file():
            raise aio.AudioIOError(f"找不到文件：{src}")
        if src.suffix.lower() in aio.UNDECODABLE_EXT:
            # 解不开就是解不开——但报错要给出路,不是给说教
            raise aio.AudioIOError(
                f"{src.name} 是 {src.suffix}（AAC 系），解不开。\n{aio._CONVERT_HINT}"
            )
        if src.suffix.lower() not in aio.SUPPORTED_EXT:
            raise aio.AudioIOError(f"{src.name} 不是本工作台认得的音频格式")
        aio.probe(src)                        # 读不出文件头的坏文件当场拒掉

        digest = sha256_of(src)
        existing = self.find_by_hash(digest)
        if existing is not None and (self.root / existing.rel).is_file():
            return existing, False

        dest_dir = self.root / subdir if subdir else self.root
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / src.name
        stem, suffix = dest.stem, dest.suffix
        n = 2
        while dest.exists():
            dest = dest_dir / f"{stem}-{n}{suffix}"
            n += 1

        tmp = dest.with_suffix(dest.suffix + ".tmp")
        shutil.copy2(src, tmp)
        retry_transient(os.replace, tmp, dest)

        entry = SourceEntry(
            rel=self.rel_of(dest),
            sha256=digest,
            bytes=dest.stat().st_size,
            imported_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            origin=str(src),
            note=note,
            lossy=aio.is_lossy(src),
        )
        self._index[entry.rel] = entry
        self._save_index()
        return entry, True

    def import_many(
        self, paths: list[Path], *, subdir: str = "",
    ) -> tuple[list[SourceEntry], list[SourceEntry], list[str]]:
        """批量导入,返回 (新导入, 已存在跳过, 出错信息)。一条失败不中断其余。"""
        added: list[SourceEntry] = []
        skipped: list[SourceEntry] = []
        errors: list[str] = []
        for p in paths:
            try:
                entry, is_new = self.import_file(Path(p), subdir=subdir)
                (added if is_new else skipped).append(entry)
            except (aio.AudioIOError, OSError) as ex:
                errors.append(f"{Path(p).name}：{ex}")
        return added, skipped, errors
