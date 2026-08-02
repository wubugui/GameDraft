"""脏桶键名 parity + save_all 两阶段原子性护栏（复核 P1-02 / P1-03）。

历史 bug：mark_dirty("quests")（应为 "quest"）→ Save All 不写文件却清脏标记，
暂存内容无声丢失。护栏三件：
1. 全源码 mark_dirty("…") 字面量 ⊆ ProjectModel.KNOWN_DIRTY_BUCKETS；
2. KNOWN_DIRTY_BUCKETS 与 save_all 写盘分支（`if "x" in dty`）一一对应；
3. mark_dirty 收到未登记键直接 raise（不再无声吞）。
另：save_all 两阶段写——任一桶序列化失败时，磁盘上任何目标文件都不得已被改写。
"""
from __future__ import annotations

import re
import hashlib
import sys
import unittest
from unittest.mock import patch
from pathlib import Path
from tempfile import TemporaryDirectory

from PySide6.QtWidgets import QApplication

from tools.editor.project_model import ProjectModel
from tools.editor.tests.save_test_utils import (
    file_sha256,
    write_minimal_loadable_project,
)

_REPO = Path(__file__).resolve().parents[3]
_TOOL_DIRS = (
    _REPO / "tools" / "editor",
    _REPO / "tools" / "dialogue_graph_editor",
)


def _iter_source_files():
    for base in _TOOL_DIRS:
        for p in base.rglob("*.py"):
            if "tests" in p.parts or "__pycache__" in p.parts:
                continue
            yield p


class TestDirtyBucketParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_all_mark_dirty_literals_are_known_buckets(self) -> None:
        pat = re.compile(r'mark_dirty\(\s*"([^"]+)"')
        offenders: list[str] = []
        for p in _iter_source_files():
            for mline, m in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
                for hit in pat.findall(m):
                    if hit not in ProjectModel.KNOWN_DIRTY_BUCKETS:
                        offenders.append(f"{p.relative_to(_REPO)}:{mline}: {hit!r}")
        self.assertEqual(
            offenders, [],
            "存在未登记的 mark_dirty 桶名（save_all 不写文件却清脏标记，数据无声丢失）：\n"
            + "\n".join(offenders),
        )

    def test_known_buckets_match_save_all_branches(self) -> None:
        src = (_REPO / "tools" / "editor" / "project_model.py").read_text(encoding="utf-8")
        handled = set(re.findall(r'if "([a-zA-Z_]+)" in dty', src))
        self.assertEqual(
            set(ProjectModel.KNOWN_DIRTY_BUCKETS), handled,
            "KNOWN_DIRTY_BUCKETS 与 save_all 写盘分支不一致——两处必须同步维护",
        )

    def test_mark_dirty_rejects_unknown_bucket(self) -> None:
        m = ProjectModel()
        with self.assertRaises(ValueError):
            m.mark_dirty("quests")  # 历史 bug 的原始拼写，必须被当场拦下


class TestStagedSaveAtomicity(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._qt_app = QApplication.instance() or QApplication(sys.argv)

    def test_serialize_failure_leaves_all_files_untouched(self) -> None:
        """config+item 双桶脏、item 序列化失败：config 文件也不得被改写（两阶段写）。"""
        with TemporaryDirectory() as td:
            root = Path(td) / "p"
            write_minimal_loadable_project(root)
            m = ProjectModel()
            m.load_project(root)
            dp = root / "public" / "assets" / "data"
            cfg_before = file_sha256(dp / "game_config.json")
            items_before = file_sha256(dp / "items.json")

            m.game_config["_probe"] = 1
            m.items.append({"id": "bad", "payload": {1, 2, 3}})  # set 不可 JSON 序列化
            m.mark_dirty("config")
            m.mark_dirty("item")
            with self.assertRaises(TypeError):
                m.save_all()

            self.assertEqual(file_sha256(dp / "game_config.json"), cfg_before,
                             "任一桶失败时，其它桶也不得已落盘（半保存）")
            self.assertEqual(file_sha256(dp / "items.json"), items_before)
            self.assertTrue(m.is_dirty, "失败后 dirty 必须保留，修好可重存")
            stray = [p.name for p in dp.rglob("*.tmp")]
            self.assertEqual(stray, [], f"失败路径必须清理暂存 .tmp：{stray}")

    def test_commit_replace_failure_rolls_back_writes_and_delete(self) -> None:
        """提交阶段第二个 replace 失败：已就位新文件与暂存删除都必须恢复。"""
        from tools.editor.file_io import StagedJsonWriter
        import os

        with TemporaryDirectory() as td:
            root = Path(td)
            changed = root / "changed.json"
            deleted = root / "deleted.json"
            changed.write_text('{"version":"old"}\n', encoding="utf-8")
            deleted.write_text('{"keep":true}\n', encoding="utf-8")
            before_changed = changed.read_bytes()
            before_deleted = deleted.read_bytes()

            writer = StagedJsonWriter()
            writer.add(changed, {"version": "new"})
            writer.add_delete(deleted)
            real_replace = os.replace
            injected = {"done": False}

            def flaky_replace(src, dst):
                # 旧文件入 rollback 备份允许成功；在新文件就位时失败。
                if not injected["done"] and Path(dst) == changed and str(src).endswith(".tmp"):
                    injected["done"] = True
                    raise OSError("注入的 replace 失败")
                return real_replace(src, dst)

            try:
                with patch("tools.editor.file_io.os.replace", side_effect=flaky_replace):
                    with self.assertRaises(OSError):
                        writer.commit()
            finally:
                writer.abort()

            self.assertEqual(changed.read_bytes(), before_changed)
            self.assertEqual(deleted.read_bytes(), before_deleted)
            leftovers = [p.name for p in root.iterdir() if p.name.startswith(".")]
            self.assertEqual(leftovers, [], f"失败回滚不得留临时文件：{leftovers}")

    def test_expected_absent_target_created_at_install_is_never_overwritten(self) -> None:
        from tools.editor.file_io import StagedJsonWriter
        import os

        with TemporaryDirectory() as td:
            target = Path(td) / "new.json"
            external = b'{"external":true}\n'
            writer = StagedJsonWriter()
            writer.add(target, {"task": True})
            writer.expect_unchanged(target, None)
            real_link = os.link
            injected = False

            def collide(src, dst, *args, **kwargs):
                nonlocal injected
                if not injected and Path(dst) == target:
                    injected = True
                    target.write_bytes(external)
                return real_link(src, dst, *args, **kwargs)

            try:
                with patch("tools.editor.file_io.os.link", side_effect=collide):
                    with self.assertRaises(OSError):
                        writer.commit()
            finally:
                writer.abort()

            self.assertTrue(injected)
            self.assertEqual(target.read_bytes(), external)
            leftovers = [p.name for p in target.parent.iterdir() if p.name.startswith(".")]
            self.assertEqual(leftovers, [])

    def test_rollback_never_deletes_external_replace_after_install(self) -> None:
        from tools.editor.file_io import StagedJsonWriter
        import os

        with TemporaryDirectory() as td:
            root = Path(td)
            first = root / "a.json"
            second = root / "b.json"
            first.write_bytes(b'{"old":"a"}\n')
            second.write_bytes(b'{"old":"b"}\n')
            second_before = second.read_bytes()
            external = b'{"external":"after-link"}\n'
            writer = StagedJsonWriter()
            writer.add(first, {"task": "a"})
            writer.add(second, {"task": "b"})
            writer.expect_unchanged(first, hashlib.sha256(first.read_bytes()).hexdigest())
            writer.expect_unchanged(second, hashlib.sha256(second.read_bytes()).hexdigest())
            real_link = os.link

            def race_link(src, dst, *args, **kwargs):
                target = Path(dst)
                if target == first:
                    result = real_link(src, dst, *args, **kwargs)
                    external_tmp = root / "external.tmp"
                    external_tmp.write_bytes(external)
                    os.replace(external_tmp, first)
                    return result
                if target == second and str(src).endswith(".tmp"):
                    raise OSError("injected later install failure")
                return real_link(src, dst, *args, **kwargs)

            try:
                with patch("tools.editor.file_io.os.link", side_effect=race_link):
                    with self.assertRaises(OSError):
                        writer.commit()
            finally:
                writer.abort()

            self.assertEqual(first.read_bytes(), external)
            self.assertEqual(second.read_bytes(), second_before)
            rollback_files = list(root.glob(".*.rollback"))
            self.assertTrue(
                rollback_files,
                "外部文件占住原路径时应保留旧版 rollback 供人工恢复，不能覆盖外部文件",
            )

    def test_rollback_never_deletes_external_inplace_edit_after_install(self) -> None:
        from tools.editor.file_io import StagedJsonWriter
        import os

        with TemporaryDirectory() as td:
            root = Path(td)
            first = root / "a.json"
            second = root / "b.json"
            first.write_bytes(b'{"old":"a"}\n')
            second.write_bytes(b'{"old":"b"}\n')
            second_before = second.read_bytes()
            external = b'{"external":"in-place"}\n'
            writer = StagedJsonWriter()
            writer.add(first, {"task": "a"})
            writer.add(second, {"task": "b"})
            writer.expect_unchanged(first, hashlib.sha256(first.read_bytes()).hexdigest())
            writer.expect_unchanged(second, hashlib.sha256(second.read_bytes()).hexdigest())
            real_link = os.link

            def race_link(src, dst, *args, **kwargs):
                target = Path(dst)
                if target == first:
                    result = real_link(src, dst, *args, **kwargs)
                    first.write_bytes(external)
                    return result
                if target == second and str(src).endswith(".tmp"):
                    raise OSError("injected later install failure")
                return real_link(src, dst, *args, **kwargs)

            try:
                with patch("tools.editor.file_io.os.link", side_effect=race_link):
                    with self.assertRaises(OSError):
                        writer.commit()
            finally:
                writer.abort()

            self.assertEqual(first.read_bytes(), external)
            self.assertEqual(second.read_bytes(), second_before)
            self.assertTrue(list(root.glob(".*.rollback")))

    def test_success_boundary_detects_external_replace_after_install(self) -> None:
        from tools.editor.file_io import StagedJsonWriter
        import os

        with TemporaryDirectory() as td:
            root = Path(td)
            first = root / "a.json"
            second = root / "b.json"
            first.write_bytes(b'{"old":"a"}\n')
            second.write_bytes(b'{"old":"b"}\n')
            second_before = second.read_bytes()
            external = b'{"external":"replace"}\n'
            writer = StagedJsonWriter()
            writer.add(first, {"task": "a"})
            writer.add(second, {"task": "b"})
            writer.expect_unchanged(first, hashlib.sha256(first.read_bytes()).hexdigest())
            writer.expect_unchanged(second, hashlib.sha256(second.read_bytes()).hexdigest())
            real_link = os.link
            replaced = False

            def race_link(src, dst, *args, **kwargs):
                nonlocal replaced
                result = real_link(src, dst, *args, **kwargs)
                if Path(dst) == first and not replaced:
                    replaced = True
                    temp = root / "external.tmp"
                    temp.write_bytes(external)
                    os.replace(temp, first)
                return result

            try:
                with patch("tools.editor.file_io.os.link", side_effect=race_link):
                    with self.assertRaises(OSError):
                        writer.commit()
            finally:
                writer.abort()

            self.assertTrue(replaced)
            self.assertEqual(first.read_bytes(), external)
            self.assertEqual(second.read_bytes(), second_before)
            self.assertTrue(list(root.glob(".*.rollback")))

    def test_success_boundary_detects_external_inplace_edit_after_install(self) -> None:
        from tools.editor.file_io import StagedJsonWriter
        import os

        with TemporaryDirectory() as td:
            root = Path(td)
            first = root / "a.json"
            second = root / "b.json"
            first.write_bytes(b'{"old":"a"}\n')
            second.write_bytes(b'{"old":"b"}\n')
            second_before = second.read_bytes()
            external = b'{"external":"in-place-success"}\n'
            writer = StagedJsonWriter()
            writer.add(first, {"task": "a"})
            writer.add(second, {"task": "b"})
            writer.expect_unchanged(first, hashlib.sha256(first.read_bytes()).hexdigest())
            writer.expect_unchanged(second, hashlib.sha256(second.read_bytes()).hexdigest())
            real_link = os.link
            edited = False

            def race_link(src, dst, *args, **kwargs):
                nonlocal edited
                result = real_link(src, dst, *args, **kwargs)
                if Path(dst) == first and not edited:
                    edited = True
                    first.write_bytes(external)
                return result

            try:
                with patch("tools.editor.file_io.os.link", side_effect=race_link):
                    with self.assertRaises(OSError):
                        writer.commit()
            finally:
                writer.abort()

            self.assertTrue(edited)
            self.assertEqual(first.read_bytes(), external)
            self.assertEqual(second.read_bytes(), second_before)
            self.assertTrue(list(root.glob(".*.rollback")))

    def test_success_boundary_preserves_external_delete_after_install(self) -> None:
        from tools.editor.file_io import StagedJsonWriter
        import os

        with TemporaryDirectory() as td:
            root = Path(td)
            first = root / "a.json"
            second = root / "b.json"
            first.write_bytes(b'{"old":"a"}\n')
            second.write_bytes(b'{"old":"b"}\n')
            second_before = second.read_bytes()
            writer = StagedJsonWriter()
            writer.add(first, {"task": "a"})
            writer.add(second, {"task": "b"})
            writer.expect_unchanged(first, hashlib.sha256(first.read_bytes()).hexdigest())
            writer.expect_unchanged(second, hashlib.sha256(second.read_bytes()).hexdigest())
            real_link = os.link
            deleted = False

            def race_link(src, dst, *args, **kwargs):
                nonlocal deleted
                result = real_link(src, dst, *args, **kwargs)
                if Path(dst) == first and not deleted:
                    deleted = True
                    first.unlink()
                return result

            try:
                with patch("tools.editor.file_io.os.link", side_effect=race_link):
                    with self.assertRaises(OSError):
                        writer.commit()
            finally:
                writer.abort()

            self.assertTrue(deleted)
            self.assertFalse(first.exists())
            self.assertEqual(second.read_bytes(), second_before)
            self.assertTrue(list(root.glob(".*.rollback")))


if __name__ == "__main__":
    unittest.main()
