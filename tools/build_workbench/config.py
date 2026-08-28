"""自动构建的配置：什么时候构建、构建到哪、旧包怎么归档。

## 这份配置和别处的分工

| 存哪 | 管什么 |
|---|---|
| `public/assets/data/game_config.json` | 游戏设计参数（编辑器 Config 页） |
| `tools/build/build_config.json` | 档位差异（从哪个场景起、带不带调试设施） |
| **本文件** | **调度与留档**：多久构建一次、构建根目录、保留几份、归档到哪 |
| `release.mjs --out-dir` | 这一次放哪（每次传参，不入任何配置） |

最后一条是既有约定（见 `tools/build/README.md`）。本工作台不破坏它：
它是**自动化的那一侧**——每次按 `builds_root` + 时间戳算出一个新目录，
然后把它当参数传给 `release.mjs`。"这一次放哪"仍然是参数，只是由工作台算出来的。

落盘位置与 production_workbench 同族：
`resources/editor_projects/editor_data/build_workbench/config.json`
（工具自有状态，**不是游戏数据**，不进 `public/`）。
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from datetime import datetime, time as dtime, timedelta
from pathlib import Path

from tools.atomic_io import retry_transient
from tools.editor.shared.project_paths import ProjectPaths

SCHEMA_VERSION = 1

#: 调度模式。
#:
#: **粒度只到天。** 一次构建 569 MB、跑两分多钟，按小时构建等于一天堆十几 GB
#: ——那不是配置项，是个陷阱。所以只提供：
#:
#: * ``daily``  —— 每隔 N 天的某个时刻（N=1 就是每天）
#: * ``weekly`` —— 每周指定的那几天的某个时刻
SCHEDULE_MODES = ("daily", "weekly")

#: 0=周一 … 6=周日（与 `datetime.weekday()` 一致）
WEEKDAY_NAMES = ("周一", "周二", "周三", "周四", "周五", "周六", "周日")

#: 只做发行档。dev 档是开发自用的，走主编辑器手动构建。
BUILD_TARGET = "release"


def config_path(project_root: Path) -> Path:
    return ProjectPaths(project_root).editor_data_root / "build_workbench" / "config.json"


@dataclass
class AutoBuildConfig:
    """自动构建配置。字段全部有缺省，读到坏值一律回落，不因为一条脏配置起不来。"""

    #: 总开关。关掉时工作台仍可手动构建。
    enabled: bool = False

    #: `daily`（每隔 every_n_days 天）或 `weekly`（每周 weekdays 那几天）
    schedule_mode: str = "daily"
    #: 两种模式共用的时刻，"HH:MM"。缺省凌晨四点——那会儿机器多半闲着。
    build_at: str = "04:00"
    #: daily 模式：每隔几天。1 = 每天。
    every_n_days: int = 1
    #: weekly 模式：周几构建。0=周一 … 6=周日。空 = 相当于没排。
    weekdays: list[int] = field(default_factory=lambda: [0])

    #: 每次构建落在 `<builds_root>/<时间戳>/`。空 = 没配，工作台会拦下来。
    builds_root: str = ""

    #: 保留几份**未压缩**的构建（可直接跑）。超出的最旧那些转归档。
    keep_uncompressed: int = 3
    #: 归档（.7z）保留几份。0 = 不限，永久留档。
    keep_archives: int = 0
    #: 归档放哪。空 = `<builds_root>/archive`。
    archive_root: str = ""

    #: 7z 可执行路径。空 = 自动找（PATH + 常见安装位置）。
    seven_zip_path: str = ""

    #: 验收不过时照样出包（构建标记会记 verified:false）。
    #: 缺省 false：不把已知有缺陷的包留进档案。
    skip_verify: bool = False

    #: 关窗口时缩到托盘而不是退出。缺省开——不然"定期构建"会被一次误点终结。
    minimize_to_tray: bool = True

    # ---------------------------------------------------------------- 读写

    @classmethod
    def from_dict(cls, data: dict) -> "AutoBuildConfig":
        cfg = cls()
        if not isinstance(data, dict):
            return cfg
        cfg.enabled = bool(data.get("enabled", cfg.enabled))
        mode = str(data.get("scheduleMode") or "")
        cfg.schedule_mode = mode if mode in SCHEDULE_MODES else cfg.schedule_mode
        cfg.build_at = _hhmm(data.get("buildAt"), cfg.build_at)
        cfg.every_n_days = _positive_int(data.get("everyNDays"), cfg.every_n_days)
        cfg.weekdays = _weekdays(data.get("weekdays"), cfg.weekdays)
        cfg.builds_root = str(data.get("buildsRoot") or "")
        cfg.keep_uncompressed = _nonneg_int(data.get("keepUncompressed"), cfg.keep_uncompressed)
        cfg.keep_archives = _nonneg_int(data.get("keepArchives"), cfg.keep_archives)
        cfg.archive_root = str(data.get("archiveRoot") or "")
        cfg.seven_zip_path = str(data.get("sevenZipPath") or "")
        cfg.skip_verify = bool(data.get("skipVerify", cfg.skip_verify))
        cfg.minimize_to_tray = bool(data.get("minimizeToTray", cfg.minimize_to_tray))
        return cfg

    def to_dict(self) -> dict:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "enabled": self.enabled,
            "scheduleMode": self.schedule_mode,
            "buildAt": self.build_at,
            "everyNDays": self.every_n_days,
            "weekdays": sorted(self.weekdays),
            "buildsRoot": self.builds_root,
            "keepUncompressed": self.keep_uncompressed,
            "keepArchives": self.keep_archives,
            "archiveRoot": self.archive_root,
            "sevenZipPath": self.seven_zip_path,
            "skipVerify": self.skip_verify,
            "minimizeToTray": self.minimize_to_tray,
        }

    # ------------------------------------------------------------ 派生路径

    def resolved_archive_root(self) -> Path | None:
        """归档目录：显式配了就用它，否则 `<builds_root>/archive`。"""
        if self.archive_root.strip():
            return Path(self.archive_root)
        if self.builds_root.strip():
            return Path(self.builds_root) / "archive"
        return None

    # -------------------------------------------------------------- 调度

    def next_run_after(self, last: datetime | None, now: datetime) -> datetime | None:
        """下一次该构建的时刻；排不出来（weekly 一天都没选）返回 None。

        两种模式共有的一条：**从没构建过也不补跑**。早上四点的任务，中午打开工作台
        不该立刻烧两分钟 CPU 出一个 569 MB 的包——那不是"到点了"，是"错过了"。
        """
        at = _parse_hhmm(self.build_at) or dtime(4, 0)

        if self.schedule_mode == "weekly":
            days = sorted(set(self.weekdays))
            if not days:
                return None
            # 从今天起往后найд最近一个选中的周几；今天这个点已过就从明天算
            for offset in range(0, 8):
                day = now.date() + timedelta(days=offset)
                if day.weekday() not in days:
                    continue
                candidate = datetime.combine(day, at)
                if candidate <= now:
                    continue
                if last is not None and last.date() == day:
                    continue  # 这天已经跑过了
                return candidate
            return None

        # daily：每隔 N 天
        step = max(1, self.every_n_days)
        if last is None:
            # 没跑过：下一个还没到的那个时刻（今天的点过了就明天）
            candidate = datetime.combine(now.date(), at)
            return candidate if candidate > now else candidate + timedelta(days=1)
        # 跑过：从上次那天往后数 N 天
        candidate = datetime.combine(last.date() + timedelta(days=step), at)
        while candidate <= now:
            candidate += timedelta(days=step)
        return candidate

    def validation_errors(self) -> list[str]:
        """开自动构建之前必须补齐的东西。"""
        errs: list[str] = []
        if not self.builds_root.strip():
            errs.append("没设「构建根目录」——自动构建不知道该把包放哪")
        if _parse_hhmm(self.build_at) is None:
            errs.append(f"构建时刻格式不对：{self.build_at!r}（要 HH:MM）")
        if self.schedule_mode == "daily" and self.every_n_days < 1:
            errs.append("「每隔几天」至少是 1 天")
        if self.schedule_mode == "weekly" and not self.weekdays:
            errs.append("按周构建至少要选一天")
        if self.keep_uncompressed < 1:
            errs.append("未压缩保留份数至少为 1（否则刚构建完就被归档）")
        return errs

    def schedule_text(self) -> str:
        """给人看的一句话调度描述。"""
        if self.schedule_mode == "weekly":
            days = sorted(set(self.weekdays))
            if not days:
                return "按周构建，但一天都没选"
            return "每周" + "、".join(WEEKDAY_NAMES[d] for d in days) + f" {self.build_at}"
        n = max(1, self.every_n_days)
        return f"每天 {self.build_at}" if n == 1 else f"每隔 {n} 天 {self.build_at}"


# ------------------------------------------------------------------ 取值兜底

def _positive_int(raw: object, fallback: int) -> int:
    try:
        v = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return v if v >= 1 else fallback


def _nonneg_int(raw: object, fallback: int) -> int:
    try:
        v = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return fallback
    return v if v >= 0 else fallback


def _parse_hhmm(raw: object) -> dtime | None:
    if not isinstance(raw, str):
        return None
    parts = raw.strip().split(":")
    if len(parts) != 2:
        return None
    try:
        h, m = int(parts[0]), int(parts[1])
    except ValueError:
        return None
    if not (0 <= h <= 23 and 0 <= m <= 59):
        return None
    return dtime(h, m)


def _hhmm(raw: object, fallback: str) -> str:
    t = _parse_hhmm(raw)
    return f"{t.hour:02d}:{t.minute:02d}" if t else fallback


def _weekdays(raw: object, fallback: list[int]) -> list[int]:
    """只收 0..6 的整数。

    **不做"善意修复"**：配置里明明白白是个列表时，过滤完是空就返回空，
    绝不回落成"周一"——那等于给人排了一个他没选的构建。空排期交给
    `validation_errors()` 拦下来，让人看见"至少要选一天"，比替他决定强。

    只有**根本不是列表**（键缺失、写成字符串之类）才用缺省。
    """
    if not isinstance(raw, list):
        return list(fallback)
    return sorted({v for v in raw if isinstance(v, int) and 0 <= v <= 6})


# ------------------------------------------------------------------ 落盘

def load_config(project_root: Path) -> AutoBuildConfig:
    """读配置；文件不在或坏了一律返回缺省，不抛。"""
    path = config_path(project_root)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return AutoBuildConfig()
    return AutoBuildConfig.from_dict(data)


def save_config(project_root: Path, cfg: AutoBuildConfig) -> None:
    """原子写。直写会在断电/被杀时留下半个 JSON，下次启动就回落成缺省——
    配置无声地回到出厂设置是很难查的那类问题。"""
    path = config_path(project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(cfg.to_dict(), ensure_ascii=False, indent=2) + "\n"
    tmp = path.with_suffix(".json.tmp")
    # newline="\n"：Windows 上 write_text 默认把 \n 翻成 \r\n
    tmp.write_text(payload, encoding="utf-8", newline="\n")
    retry_transient(os.replace, tmp, path)
