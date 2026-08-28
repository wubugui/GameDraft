"""构建工作台纯逻辑层的回归测试：调度、配置读写、构建扫描、留档裁剪。

这几件事错了代价很大——早一步构建只是浪费 CPU，**多删一份构建就是留档没了**。
所以边界条件全部钉住。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from tools.build_workbench.builds import (  # noqa: E402
    BUILD_MARKER, ArchiveEntry, archives_to_drop, builds_to_archive,
    human_bytes, new_build_dir_name, scan_archives, scan_builds,
)
from tools.build_workbench.config import (  # noqa: E402
    AutoBuildConfig, load_config, save_config,
)


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8", newline="\n")


def _make_build(root: Path, name: str, *, built_at: str, verified: bool = True,
                total: int = 1000, files: int = 3) -> Path:
    d = root / name
    (d / "game").mkdir(parents=True, exist_ok=True)
    _write(d / "game" / "index.html", "x")
    _write(d / "gamedraft.exe", "MZ")
    _write(d / BUILD_MARKER, json.dumps({
        "target": "release", "builtAt": built_at,
        "fileCount": files, "totalBytes": total, "verified": verified,
    }))
    return d


class ScheduleTests(unittest.TestCase):
    """粒度只到天：一次构建 569 MB / 两分多钟，按小时排等于一天堆十几 GB。"""

    def test_返回的永远是将来的时刻(self) -> None:
        """这条钉住一个踩过的坑：调用方**必须**把结果记成状态，
        每拍拿它跟 now 比是永远不会到点的。"""
        now = datetime(2026, 8, 28, 12, 0)
        for cfg in (
            AutoBuildConfig(schedule_mode="daily", build_at="04:00"),
            AutoBuildConfig(schedule_mode="daily", build_at="04:00", every_n_days=3),
            AutoBuildConfig(schedule_mode="weekly", build_at="04:00", weekdays=[0, 3]),
        ):
            for last in (None, datetime(2026, 8, 27, 4, 0)):
                nxt = cfg.next_run_after(last, now)
                self.assertIsNotNone(nxt)
                self.assertGreater(nxt, now, f"{cfg.schedule_mode} last={last}")

    def test_每天_今天那个点没到就是今天(self) -> None:
        cfg = AutoBuildConfig(schedule_mode="daily", build_at="04:00")
        now = datetime(2026, 8, 28, 1, 0)
        self.assertEqual(cfg.next_run_after(None, now), datetime(2026, 8, 28, 4, 0))

    def test_每天_过了点就顺延到明天_不补跑(self) -> None:
        """中午打开工作台，不该因为"今天四点没跑"就立刻烧两分钟 CPU 出个 569 MB 的包。"""
        cfg = AutoBuildConfig(schedule_mode="daily", build_at="04:00")
        now = datetime(2026, 8, 28, 12, 0)
        self.assertEqual(cfg.next_run_after(None, now), datetime(2026, 8, 29, 4, 0))

    def test_每隔三天_从上次那天往后数(self) -> None:
        cfg = AutoBuildConfig(schedule_mode="daily", build_at="04:00", every_n_days=3)
        last = datetime(2026, 8, 25, 4, 0)
        self.assertEqual(
            cfg.next_run_after(last, datetime(2026, 8, 26, 10, 0)),
            datetime(2026, 8, 28, 4, 0),
        )

    def test_每隔三天_停机很久后跳到下一个未来的点_不追平(self) -> None:
        """关了两周再开，不该把这两周欠的六次全补出来。"""
        cfg = AutoBuildConfig(schedule_mode="daily", build_at="04:00", every_n_days=3)
        last = datetime(2026, 8, 1, 4, 0)
        nxt = cfg.next_run_after(last, datetime(2026, 8, 28, 12, 0))
        self.assertGreater(nxt, datetime(2026, 8, 28, 12, 0))
        self.assertEqual(nxt, datetime(2026, 8, 31, 4, 0))  # 8/1 + 3n 里第一个未来的

    def test_每周_跳到最近一个选中的周几(self) -> None:
        # 2026-08-28 是周五(weekday=4)
        cfg = AutoBuildConfig(schedule_mode="weekly", build_at="04:00", weekdays=[0, 2])  # 周一、周三
        now = datetime(2026, 8, 28, 12, 0)
        self.assertEqual(cfg.next_run_after(None, now), datetime(2026, 8, 31, 4, 0))  # 下周一

    def test_每周_当天点没到就是当天(self) -> None:
        cfg = AutoBuildConfig(schedule_mode="weekly", build_at="20:00", weekdays=[4])  # 周五
        now = datetime(2026, 8, 28, 9, 0)
        self.assertEqual(cfg.next_run_after(None, now), datetime(2026, 8, 28, 20, 0))

    def test_每周_今天跑过就不在同一天再跑(self) -> None:
        cfg = AutoBuildConfig(schedule_mode="weekly", build_at="04:00", weekdays=[4, 5])
        last = datetime(2026, 8, 28, 4, 1)
        nxt = cfg.next_run_after(last, datetime(2026, 8, 28, 5, 0))
        self.assertEqual(nxt, datetime(2026, 8, 29, 4, 0))  # 周六

    def test_每周_一天都没选就排不出来(self) -> None:
        cfg = AutoBuildConfig(schedule_mode="weekly", weekdays=[])
        self.assertIsNone(cfg.next_run_after(None, datetime(2026, 8, 28, 12, 0)))

    def test_调度描述是人话(self) -> None:
        self.assertEqual(
            AutoBuildConfig(schedule_mode="daily", build_at="04:00").schedule_text(),
            "每天 04:00")
        self.assertEqual(
            AutoBuildConfig(schedule_mode="daily", build_at="04:00", every_n_days=3).schedule_text(),
            "每隔 3 天 04:00")
        self.assertEqual(
            AutoBuildConfig(schedule_mode="weekly", build_at="22:30", weekdays=[0, 4]).schedule_text(),
            "每周周一、周五 22:30")


class ConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_读不到就用缺省_不抛(self) -> None:
        cfg = load_config(self.root)
        self.assertFalse(cfg.enabled)
        self.assertEqual(cfg.schedule_mode, "daily")

    def test_往返(self) -> None:
        cfg = AutoBuildConfig(
            enabled=True, schedule_mode="weekly", build_at="22:30", every_n_days=2,
            weekdays=[0, 3, 5],
            builds_root="D:/builds", keep_uncompressed=5, keep_archives=10,
            seven_zip_path="C:/7z.exe", skip_verify=True,
        )
        save_config(self.root, cfg)
        back = load_config(self.root)
        self.assertEqual(back.to_dict(), cfg.to_dict())

    def test_脏值一律回落_不让一条坏配置起不来(self) -> None:
        path = self.root / "resources/editor_projects/editor_data/build_workbench/config.json"
        _write(path, json.dumps({
            "scheduleMode": "每小时", "everyNDays": -5, "buildAt": "25:99",
            "weekdays": ["周一", 9, -1], "keepUncompressed": "很多", "keepArchives": -3,
        }))
        cfg = load_config(self.root)
        self.assertEqual(cfg.schedule_mode, "daily")
        self.assertEqual(cfg.every_n_days, 1)
        self.assertEqual(cfg.build_at, "04:00")
        self.assertEqual(cfg.keep_uncompressed, 3)
        self.assertEqual(cfg.keep_archives, 0)

    def test_周几只收合法值(self) -> None:
        path = self.root / "resources/editor_projects/editor_data/build_workbench/config.json"
        _write(path, json.dumps({"weekdays": [5, 0, 99, 3, 0]}))
        self.assertEqual(load_config(self.root).weekdays, [0, 3, 5])  # 去重 + 排序 + 挡掉 99

    def test_明确存了空的周几就是空_不替人发明日程(self) -> None:
        """回落成"周一"等于给人排了一个他没选的构建。空排期交给校验拦，不做善意修复。"""
        path = self.root / "resources/editor_projects/editor_data/build_workbench/config.json"
        _write(path, json.dumps({"weekdays": []}))
        self.assertEqual(load_config(self.root).weekdays, [])

        _write(path, json.dumps({"weekdays": ["周一", 9]}))  # 是列表但全非法
        self.assertEqual(load_config(self.root).weekdays, [])

    def test_键根本不是列表才用缺省(self) -> None:
        path = self.root / "resources/editor_projects/editor_data/build_workbench/config.json"
        _write(path, json.dumps({"weekdays": "周一"}))
        self.assertEqual(load_config(self.root).weekdays, [0])

    def test_按周但一天没选_开不了自动构建(self) -> None:
        cfg = AutoBuildConfig(enabled=True, builds_root="D:/b",
                              schedule_mode="weekly", weekdays=[])
        self.assertTrue(any("至少要选一天" in e for e in cfg.validation_errors()))

    def test_坏_JSON_不抛(self) -> None:
        path = self.root / "resources/editor_projects/editor_data/build_workbench/config.json"
        _write(path, "{not json")
        self.assertFalse(load_config(self.root).enabled)

    def test_开自动构建前必须有构建根目录(self) -> None:
        cfg = AutoBuildConfig(enabled=True)
        self.assertTrue(any("构建根目录" in e for e in cfg.validation_errors()))
        cfg.builds_root = "D:/builds"
        self.assertEqual(cfg.validation_errors(), [])

    def test_保留份数为零会让刚构建完的立刻被归档_拦下来(self) -> None:
        cfg = AutoBuildConfig(builds_root="D:/b", keep_uncompressed=0)
        self.assertTrue(any("至少为 1" in e for e in cfg.validation_errors()))

    def test_归档目录缺省落在构建根下(self) -> None:
        cfg = AutoBuildConfig(builds_root="D:/builds")
        self.assertEqual(cfg.resolved_archive_root(), Path("D:/builds/archive"))
        cfg.archive_root = "E:/keep"
        self.assertEqual(cfg.resolved_archive_root(), Path("E:/keep"))


class ScanTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_只认带构建标记的目录(self) -> None:
        _make_build(self.root, "2026-08-28_0400", built_at="2026-08-28T04:00:00Z")
        (self.root / "别人的目录").mkdir()
        _write(self.root / "别人的目录" / "readme.txt", "x")
        (self.root / "archive").mkdir()

        found = scan_builds(self.root)
        self.assertEqual([b.name for b in found], ["2026-08-28_0400"])

    def test_按时间倒序_新的在前(self) -> None:
        _make_build(self.root, "old", built_at="2026-08-26T04:00:00Z")
        _make_build(self.root, "new", built_at="2026-08-28T04:00:00Z")
        _make_build(self.root, "mid", built_at="2026-08-27T04:00:00Z")
        self.assertEqual([b.name for b in scan_builds(self.root)], ["new", "mid", "old"])

    def test_读出验收状态与体积(self) -> None:
        _make_build(self.root, "b", built_at="2026-08-28T04:00:00Z", verified=False, total=12345)
        b = scan_builds(self.root)[0]
        self.assertFalse(b.verified)
        self.assertEqual(b.total_bytes, 12345)
        self.assertGreater(b.disk_bytes, 0)  # 实测体积独立于标记里记的

    def test_根目录不存在返回空_不抛(self) -> None:
        self.assertEqual(scan_builds(self.root / "没有这个"), [])
        self.assertEqual(scan_archives(self.root / "没有这个"), [])

    def test_归档扫描带压缩率(self) -> None:
        arc = self.root / "archive"
        arc.mkdir()
        (arc / "b1.7z").write_bytes(b"0" * 500)
        _write(arc / "b1.7z.json", json.dumps({
            "target": "release", "builtAt": "2026-08-28T04:00:00Z",
            "totalBytes": 1000, "verified": True,
        }))
        a = scan_archives(arc)[0]
        self.assertEqual(a.archive_bytes, 500)
        self.assertAlmostEqual(a.ratio, 0.5)

    def test_归档没有元数据时不编压缩率(self) -> None:
        arc = self.root / "archive"
        arc.mkdir()
        (arc / "b1.7z").write_bytes(b"0" * 500)
        self.assertIsNone(scan_archives(arc)[0].ratio)

    def test_时间戳缺失或坏掉不让整个列表崩掉(self) -> None:
        """排序时给没时间戳的条目垫底，不能用 datetime.min.astimezone()
        ——Windows 上那会抛 OSError，一个坏标记就让列表全没了。"""
        _write(self.root / "无时间" / BUILD_MARKER, json.dumps({"target": "release"}))
        _write(self.root / "坏时间" / BUILD_MARKER, json.dumps({"builtAt": "不是时间"}))
        _make_build(self.root, "正常", built_at="2026-08-28T04:00:00Z")

        names = [b.name for b in scan_builds(self.root)]
        self.assertEqual(names[0], "正常")          # 有时间的排前面
        self.assertCountEqual(names, ["正常", "无时间", "坏时间"])

        arc = self.root / "archive"
        arc.mkdir()
        (arc / "a.7z").write_bytes(b"0")
        (arc / "b.7z").write_bytes(b"0")
        self.assertEqual(len(scan_archives(arc)), 2)


class RetentionTests(unittest.TestCase):
    """留档裁剪：多删一份就是留档没了，边界必须钉死。"""

    def _entries(self, n: int) -> list:
        return [
            ArchiveEntry(Path(f"/a/{i}.7z"), f"{i}", None, "release", 1, 1, True)
            for i in range(n)
        ]

    def test_保留份数之内一个都不归档(self) -> None:
        builds = [object()] * 3  # type: ignore[list-item]
        self.assertEqual(builds_to_archive(builds, 3), [])  # type: ignore[arg-type]
        self.assertEqual(builds_to_archive(builds, 5), [])  # type: ignore[arg-type]

    def test_超出的最旧那些转归档(self) -> None:
        builds = ["new", "mid", "old"]
        self.assertEqual(builds_to_archive(builds, 2), ["old"])  # type: ignore[arg-type]
        self.assertEqual(builds_to_archive(builds, 1), ["mid", "old"])  # type: ignore[arg-type]

    def test_保留份数为零仍至少留一份_否则刚构建完就被归档(self) -> None:
        builds = ["new", "old"]
        self.assertEqual(builds_to_archive(builds, 0), ["old"])  # type: ignore[arg-type]

    def test_归档保留份数为零表示永久留档(self) -> None:
        self.assertEqual(archives_to_drop(self._entries(50), 0), [])

    def test_归档超出份数才删最旧的(self) -> None:
        arcs = self._entries(5)
        self.assertEqual(archives_to_drop(arcs, 3), arcs[3:])
        self.assertEqual(archives_to_drop(arcs, 5), [])


class MiscTests(unittest.TestCase):
    def test_目录名一眼看得出哪天哪次(self) -> None:
        self.assertEqual(new_build_dir_name(datetime(2026, 8, 28, 4, 0)), "2026-08-28_0400")

    def test_体积可读(self) -> None:
        self.assertEqual(human_bytes(512), "512 B")
        self.assertEqual(human_bytes(2048), "2.0 KB")
        self.assertEqual(human_bytes(5 * 1024 ** 2), "5.0 MB")
        self.assertEqual(human_bytes(3 * 1024 ** 3), "3.00 GB")


if __name__ == "__main__":
    unittest.main()
