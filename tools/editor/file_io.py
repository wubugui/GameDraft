"""JSON file I/O for the GameDraft editor."""
from __future__ import annotations

import errno
import hashlib
import json
import os
import tempfile
from pathlib import Path


class JsonFileError(json.JSONDecodeError):
    """坏 JSON 报错必须带文件路径 + 行列 + 修复建议（审查 P1-18）。

    继承 json.JSONDecodeError（⊂ ValueError）：既有的
    ``except (OSError, ValueError, json.JSONDecodeError)`` 处理路径全部兼容。
    str() 形如::

        public/assets/data/items.json 解析失败：Expecting ',' delimiter。
        请检查该文件是否缺逗号/引号/括号，修复后重试（也可用 git 恢复该文件）: line 3 column 5 (char 42)
    """

    def __init__(self, path: Path, cause: json.JSONDecodeError):
        msg = (
            f"{path} 解析失败：{cause.msg}。"
            "请检查该文件是否缺逗号/引号/括号，修复后重试（也可用 git 恢复该文件）"
        )
        super().__init__(msg, cause.doc, cause.pos)
        self.path = Path(path)


def read_json(path: Path) -> dict | list:
    with open(path, "r", encoding="utf-8") as f:
        try:
            return json.load(f)
        except json.JSONDecodeError as e:
            raise JsonFileError(Path(path), e) from e


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
        self._create_only: set[Path] = set()
        # target -> expected SHA-256; None means the target must be absent.
        self._expected_content: dict[Path, str | None] = {}
        self._deletes: list[Path] = []
        self._committed = False

    def add(self, path: Path, data: dict | list) -> None:
        """序列化 data 并写入 path 同目录下的临时文件（不触碰 path 本身）。

        磁盘/权限类失败（OSError）包上目标文件与修复建议再抛——裸 errno 弹窗
        策划无从定位（审查 P3）。序列化失败（TypeError 等）原样抛，语义不变。
        """
        path = Path(path)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            blob = _json_text(data).encode("utf-8")
            fd, tmp_path = tempfile.mkstemp(
                prefix=f".{path.name}.",
                suffix=".tmp",
                dir=path.parent,
            )
        except OSError as e:
            raise OSError(
                f"写盘失败：{path}：{e}，请检查磁盘空间与文件/目录权限"
            ) from e
        try:
            with os.fdopen(fd, "wb") as fh:
                fh.write(blob)
                fh.flush()
                os.fsync(fh.fileno())
        except BaseException as exc:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
            if isinstance(exc, OSError):
                raise OSError(
                    f"写盘失败：{path}：{exc}，请检查磁盘空间与文件/目录权限"
                ) from exc
            raise
        self._staged.append((tmp_path, path))

    def add_new(self, path: Path, data: dict | list) -> None:
        """Stage a file that must still be absent at atomic install time.

        A preflight ``exists`` check cannot enforce this contract because an
        external editor may create the target before commit.  ``commit`` uses
        ``os.link(tmp, target)`` for these entries: hard-link creation is an
        atomic fail-if-exists operation, and the temp lives in the same
        directory/filesystem.  Any collision rolls the whole batch back.
        """
        target = Path(path)
        self.add(target, data)
        self._create_only.add(target)

    def expect_unchanged(self, path: Path, expected_digest: str | None) -> None:
        """Require target bytes to match a baseline at the commit boundary."""
        self._expected_content[Path(path)] = expected_digest

    def add_delete(self, path: Path) -> None:
        """把删除纳入同一次两阶段提交。

        这里只记录目标，不立即 unlink；commit 会先把旧文件移到同目录
        回滚备份，所有替换/删除都成功后才清理备份。因而对话图改名可以
        表达为 ``add(new) + add_delete(old)``，不会先丢旧文件。
        """
        self._deletes.append(Path(path))

    @staticmethod
    def _reserve_backup_path(target: Path) -> str:
        fd, name = tempfile.mkstemp(
            prefix=f".{target.name}.", suffix=".rollback", dir=target.parent,
        )
        os.close(fd)
        os.remove(name)
        return name

    @staticmethod
    def _digest(path: Path | str) -> str:
        hasher = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                hasher.update(chunk)
        return hasher.hexdigest()

    def commit(self) -> None:
        """提交全部替换与删除；任一 ``os.replace`` 失败则恢复已动过的目标。

        单次 ``os.replace`` 虽然原子，但旧实现逐个 replace 时，第 N 个失败会把
        前 N-1 个永久留在新版，与「全部成功或磁盘零变化」契约不符。
        现在先将所有已存目标原子移入同目录 rollback 备份，再就位新文件；
        失败时逆序恢复。删除目标只移入备份而不就位新文件。
        """
        write_targets = [Path(target) for _tmp, target in self._staged]
        delete_targets = [Path(target) for target in self._deletes]
        all_targets = write_targets + delete_targets
        if len({str(p.resolve()) for p in all_targets}) != len(all_targets):
            raise ValueError("同一两阶段提交中存在重复目标路径")

        backups: dict[Path, str] = {}
        installed: list[tuple[Path, tuple[int, int], str]] = []
        active_target: Path | None = None
        try:
            # Early diagnostic only. The os.link install below is the actual
            # atomic guard against a target created after this check.
            for target in self._create_only:
                active_target = target
                if target.exists():
                    raise FileExistsError(
                        errno.EEXIST,
                        "只允许新建的目标已存在，拒绝覆盖",
                        str(target),
                    )
            for target, expected in self._expected_content.items():
                active_target = target
                if expected is None:
                    if target.exists():
                        raise FileExistsError(
                            errno.EEXIST,
                            "基线中不存在的目标已被外部创建",
                            str(target),
                        )
                elif not target.exists():
                    raise FileNotFoundError(
                        errno.ENOENT,
                        "基线中的目标已被外部删除",
                        str(target),
                    )
            # 旧内容先转为可回滚备份；不存在的新文件则无备份。
            for target in all_targets:
                active_target = target
                if (
                    target in self._create_only
                    or (
                        target in self._expected_content
                        and self._expected_content[target] is None
                    )
                ):
                    # Baseline says absent: never move a newly appeared
                    # external file into our rollback area. A staged write is
                    # installed with os.link below and atomically gets EEXIST;
                    # a staged delete simply leaves the external file alone.
                    continue
                if (
                    target in self._expected_content
                    and self._expected_content[target] is not None
                    and not target.exists()
                ):
                    raise FileNotFoundError(
                        errno.ENOENT,
                        "目标在提交瞬间被外部删除",
                        str(target),
                    )
                if target.exists():
                    backup = self._reserve_backup_path(target)
                    os.replace(target, backup)
                    backups[target] = backup
                    expected = self._expected_content.get(target, "")
                    if expected and self._digest(backup) != expected:
                        raise OSError(
                            getattr(errno, "ESTALE", errno.EBUSY),
                            "目标内容已在提交前被外部修改",
                            str(target),
                        )

            for tmp_path, target in self._staged:
                active_target = Path(target)
                # Temp and installed target are the same inode after link or
                # same-filesystem replace. Capture identity *before* install;
                # an external atomic replace between syscall return and a
                # target.stat() must never be mistaken for our own file during
                # rollback and deleted.
                tmp_stat = os.stat(tmp_path)
                installed_identity = (tmp_stat.st_dev, tmp_stat.st_ino)
                installed_digest = self._digest(tmp_path)
                if (
                    active_target in self._create_only
                    or active_target in self._expected_content
                ):
                    # Atomic create-without-overwrite. If another process won
                    # the name after preflight, EEXIST triggers full rollback
                    # and its bytes are never touched.
                    os.link(tmp_path, active_target)
                    installed.append(
                        (active_target, installed_identity, installed_digest),
                    )
                    os.remove(tmp_path)
                else:
                    os.replace(tmp_path, active_target)
                    installed.append(
                        (active_target, installed_identity, installed_digest),
                    )

            # An external process may replace or edit an installed target
            # after the install syscall returns even when no later install
            # fails. Verify every installed token before deleting backups or
            # reporting success; mismatch enters the same preservation-first
            # rollback path below.
            for target, expected_identity, expected_digest in installed:
                active_target = target
                if not target.exists():
                    raise FileNotFoundError(
                        errno.ENOENT,
                        "刚安装的目标已被外部删除",
                        str(target),
                    )
                stat = target.stat()
                if (
                    (stat.st_dev, stat.st_ino) != expected_identity
                    or self._digest(target) != expected_digest
                ):
                    raise OSError(
                        getattr(errno, "ESTALE", errno.EBUSY),
                        "刚安装的目标已被外部替换或改写",
                        str(target),
                    )
        except BaseException as exc:
            rollback_errors: list[str] = []
            externally_changed_targets: set[Path] = set()
            # 先拿掉已就位的新文件，再把原文件逆序放回。
            for target, installed_identity, installed_digest in reversed(installed):
                try:
                    if not target.exists():
                        externally_changed_targets.add(target)
                        rollback_errors.append(
                            f"{target} 已被外部删除，保留删除状态",
                        )
                        continue
                    stat = target.stat()
                    same_inode = (stat.st_dev, stat.st_ino) == installed_identity
                    same_content = same_inode and self._digest(target) == installed_digest
                    if same_content:
                        os.remove(target)
                    else:
                        externally_changed_targets.add(target)
                        rollback_errors.append(
                            f"{target} 已被外部再次替换或改写，保留外部文件",
                        )
                except OSError as rb_exc:
                    externally_changed_targets.add(target)
                    rollback_errors.append(f"清理新文件 {target} 失败: {rb_exc}")
            for target in reversed(all_targets):
                backup = backups.get(target)
                if not backup:
                    continue
                if target in externally_changed_targets:
                    rollback_errors.append(
                        f"提交前旧版保留在 {backup}，未覆盖外部路径状态",
                    )
                    continue
                try:
                    os.link(backup, target)
                    os.remove(backup)
                except OSError as rb_exc:
                    rollback_errors.append(f"恢复 {target} 失败: {rb_exc}")
            if isinstance(exc, OSError):
                suffix = ("；回滚异常：" + "；".join(rollback_errors)) if rollback_errors else ""
                raise OSError(
                    f"写盘失败：{active_target or '?'}：{exc}，"
                    f"已尝试恢复提交前状态{suffix}"
                ) from exc
            raise

        # 业务文件已全部就位；rollback 备份只是临时产物，清理失败不得
        # 把已成功保存误报为失败（否则用户重试会覆盖新数据）。
        for backup in backups.values():
            try:
                os.remove(backup)
            except OSError:
                pass
        self._committed = True
        self._staged.clear()
        self._create_only.clear()
        self._expected_content.clear()
        self._deletes.clear()

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
        self._create_only.clear()
        self._expected_content.clear()
        self._deletes.clear()


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
