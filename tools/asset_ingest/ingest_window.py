"""分类导入窗口：复制/移动到 public/assets 或 editor_data 下固定结构。"""
from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

from PySide6.QtCore import QUrl, Qt
from PySide6.QtGui import QCloseEvent, QDesktopServices, QDragEnterEvent, QDropEvent
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

# 与工具目的相关的扩展名（过宽会误收杂文件）
_IMPORT_EXTS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tga",
    ".mp4", ".webm", ".mov",
    ".wav", ".mp3", ".ogg", ".flac", ".m4a",
}


@dataclass(frozen=True)
class _Category:
    label: str
    relpath: str  # 相对仓库根
    subfolder_hint: str  # 工具提示
    allow_subfolder: bool


_CATEGORIES: list[_Category] = [
    _Category("游戏 / 背景", "public/assets/images/backgrounds", "一般留空", False),
    _Category("游戏 / 立绘", "public/assets/images/illustrations", "可选子目录，如 埃德加、道具", True),
    _Category("游戏 / 角色头像", "public/assets/images/characters", "一般留空", False),
    _Category("游戏 / 音频", "public/assets/audio", "一般留空", False),
    _Category("工作区 / 动画原视频", "editor_data/animvideo", "一般留空", False),
    _Category("工作区 / 未分类收件箱", "editor_data/asset_inbox", "先扔这里再二次整理", False),
]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _is_safe_custom_relpath(s: str) -> bool:
    s = s.replace("\\", "/").strip().strip("/")
    if not s:
        return False
    low = s.lower()
    return low.startswith("public/") or low.startswith("editor_data/")


def _iter_files_from_paths(paths: Iterable[Path]) -> list[Path]:
    out: list[Path] = []
    for p in paths:
        p = p.resolve()
        if p.is_file():
            if p.suffix.lower() in _IMPORT_EXTS:
                out.append(p)
        elif p.is_dir():
            for root, _, files in os.walk(p):
                for f in files:
                    fp = Path(root) / f
                    if fp.suffix.lower() in _IMPORT_EXTS:
                        out.append(fp)
    # 去重、稳定排序
    seen: set[str] = set()
    uniq: list[Path] = []
    for fp in sorted(out, key=lambda x: str(x).lower()):
        k = str(fp)
        if k not in seen:
            seen.add(k)
            uniq.append(fp)
    return uniq


def _unique_dest(dest_dir: Path, filename: str) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    cand = dest_dir / filename
    if not cand.exists():
        return cand
    stem, suf = os.path.splitext(filename)
    n = 1
    while True:
        c2 = dest_dir / f"{stem}_{n}{suf}"
        if not c2.exists():
            return c2
        n += 1


class _FileDropList(QListWidget):
    """支持拖入文件/文件夹到列表。"""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setAcceptDrops(True)

    def dragEnterEvent(self, e: QDragEnterEvent) -> None:
        if e.mimeData().hasUrls():
            e.acceptProposedAction()
        else:
            super().dragEnterEvent(e)

    def dropEvent(self, e: QDropEvent) -> None:
        for u in e.mimeData().urls():
            p = Path(u.toLocalFile())
            if str(p):
                self.addItem(str(p))
        e.acceptProposedAction()


class IngestWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self._root = _repo_root()
        self.setWindowTitle("GameDraft 素材入库")
        self.resize(920, 620)
        self.setAcceptDrops(True)

        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)

        tip = QLabel(
            "将文件或文件夹拖到下方列表，或点击「添加…」。选择分类与可选子目录后执行「导入」。"
        )
        tip.setWordWrap(True)
        root.addWidget(tip)

        gb = QGroupBox("分类与目标")
        fl = QFormLayout(gb)
        self._combo = QComboBox()
        for c in _CATEGORIES:
            self._combo.addItem(c.label, userData=c)
        self._combo.addItem("自定义相对路径…", userData=None)
        self._combo.currentIndexChanged.connect(self._sync_subfolder_enabled)
        fl.addRow("分类", self._combo)

        self._sub = QLineEdit()
        self._sub.setPlaceholderText("子目录（仅部分分类需要）")
        self._sub.setToolTip("仅「游戏/立绘」等支持子目录的分类会拼到目标路径下。")
        fl.addRow("子目录", self._sub)

        self._custom = QLineEdit()
        self._custom.setPlaceholderText("例如 public/assets/images/illustrations/新主题")
        self._custom.setToolTip("必须以 public/ 或 editor_data/ 开头，相对仓库根。")
        fl.addRow("自定义路径", self._custom)

        self._move = QCheckBox("移动（否则复制）")
        self._move.setToolTip("勾选后从原位置移入工程；不勾选则保留原件。")
        fl.addRow(self._move)
        root.addWidget(gb)

        hl = QHBoxLayout()
        self._btn_add = QPushButton("添加文件…")
        self._btn_add_dir = QPushButton("添加目录…")
        self._btn_clear = QPushButton("清空列表")
        self._btn_out = QPushButton("打开目标目录")
        hl.addWidget(self._btn_add)
        hl.addWidget(self._btn_add_dir)
        hl.addWidget(self._btn_clear)
        hl.addStretch(1)
        hl.addWidget(self._btn_out)
        root.addLayout(hl)

        self._list = _FileDropList()
        self._list.setAlternatingRowColors(True)
        self._list.setMinimumHeight(200)
        self._list.setToolTip("支持拖入文件/文件夹到此处。")
        root.addWidget(self._list, 1)

        self._preview = QLabel("")
        self._preview.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse
        )
        self._preview.setWordWrap(True)
        root.addWidget(self._preview)

        bot = QHBoxLayout()
        self._btn_run = QPushButton("导入选中分类")
        self._btn_run.setDefault(True)
        bot.addWidget(self._btn_run)
        bot.addStretch(1)
        root.addLayout(bot)

        self._log = QTextEdit()
        self._log.setReadOnly(True)
        self._log.setMaximumHeight(160)
        self._log.setPlaceholderText("操作日志…")
        root.addWidget(self._log)

        self._btn_add.clicked.connect(self._pick_files)
        self._btn_add_dir.clicked.connect(self._pick_dir)
        self._btn_clear.clicked.connect(self._list.clear)
        self._btn_out.clicked.connect(self._open_target_dir)
        self._btn_run.clicked.connect(self._do_import)
        self._combo.currentIndexChanged.connect(self._update_preview)
        self._sub.textChanged.connect(self._update_preview)
        self._custom.textChanged.connect(self._update_preview)

        self._sync_subfolder_enabled()
        self._update_preview()

    def _active_category(self) -> _Category | None:
        data = self._combo.currentData()
        return data if isinstance(data, _Category) else None

    def _dest_dir(self) -> Path | None:
        cat = self._active_category()
        if cat is not None:
            rel = cat.relpath
            if cat.allow_subfolder:
                sub = self._sub.text().strip().replace("\\", "/").strip("/")
                if sub:
                    # 防穿越
                    parts = [p for p in sub.split("/") if p and p not in (".", "..")]
                    p = self._root / rel
                    for part in parts:
                        p = p / part
                    return p
            return self._root / rel
        # 自定义
        raw = self._custom.text().strip()
        if not _is_safe_custom_relpath(raw):
            return None
        raw = raw.replace("\\", "/").strip().strip("/")
        return self._root.joinpath(*raw.split("/"))

    def _sync_subfolder_enabled(self) -> None:
        cat = self._active_category()
        custom = cat is None
        self._sub.setEnabled(bool(cat and cat.allow_subfolder))
        self._custom.setEnabled(custom)
        if not self._sub.isEnabled():
            self._sub.clear()
        self._update_preview()

    def _update_preview(self) -> None:
        d = self._dest_dir()
        if d is None:
            self._preview.setText("目标无效：请检查分类或自定义路径。")
        else:
            try:
                rel = d.resolve().relative_to(self._root.resolve())
                self._preview.setText(f"落点：{rel.as_posix()}/")
            except ValueError:
                self._preview.setText("目标无效：路径必须位于仓库内。")

    def _log_line(self, s: str) -> None:
        self._log.append(s)

    def _append_log_file(self, entries: list[dict]) -> None:
        log_path = self._root / "editor_data" / "asset_ingest_log.json"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        data: list = []
        if log_path.is_file():
            try:
                with open(log_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if not isinstance(data, list):
                    data = []
            except (json.JSONDecodeError, OSError):
                data = []
        data.extend(entries)
        # 控制体积：仅保留最后 2000 条
        if len(data) > 2000:
            data = data[-2000:]
        with open(log_path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def _pick_files(self) -> None:
        files, _ = QFileDialog.getOpenFileNames(
            self,
            "选择文件",
            str(self._root),
            "素材 (" + " ".join("*" + e for e in sorted(_IMPORT_EXTS)) + ");;所有文件 (*.*)",
        )
        for f in files:
            self._list.addItem(f)

    def _pick_dir(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "选择目录", str(self._root))
        if d:
            self._list.addItem(d)

    def _paths_from_list(self) -> list[Path]:
        out: list[Path] = []
        for i in range(self._list.count()):
            out.append(Path(self._list.item(i).text()))
        return out

    def _open_target_dir(self) -> None:
        d = self._dest_dir()
        if d is None:
            QMessageBox.warning(self, "无法打开", "当前目标路径无效。")
            return
        d.mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(d.resolve())))

    def _do_import(self) -> None:
        dest = self._dest_dir()
        if dest is None:
            QMessageBox.warning(
                self,
                "无法导入",
                "请选择有效分类，或填写以 public/ 或 editor_data/ 开头的自定义相对路径。",
            )
            return
        try:
            dest.relative_to(self._root.resolve())
        except ValueError:
            QMessageBox.warning(self, "无法导入", "目标必须在仓库根目录下。")
            return

        srcs = _iter_files_from_paths(self._paths_from_list())
        if not srcs:
            QMessageBox.information(self, "无文件", "列表中无有效素材文件。")
            return

        op = "move" if self._move.isChecked() else "copy"
        dest.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        log_entries: list[dict] = []
        n_ok = 0
        for src in srcs:
            name = src.name
            final = _unique_dest(dest, name)
            try:
                if op == "move":
                    shutil.move(str(src), str(final))
                else:
                    shutil.copy2(str(src), str(final))
            except OSError as e:
                self._log_line(f"失败: {src} -> {e}")
                continue
            rel = str(final.resolve().relative_to(self._root.resolve()))
            self._log_line(f"{'移入' if op == 'move' else '复制'}: {rel}")
            log_entries.append(
                {
                    "time": ts,
                    "op": op,
                    "source": str(src),
                    "dest": rel,
                }
            )
            n_ok += 1

        if log_entries:
            self._append_log_file(log_entries)
        if n_ok == len(srcs):
            QMessageBox.information(
                self,
                "完成",
                f"已处理 {n_ok} 个文件。记录已追加到 editor_data/asset_ingest_log.json。",
            )
        elif n_ok > 0:
            QMessageBox.warning(
                self,
                "部分完成",
                f"成功 {n_ok} 个，失败 {len(srcs) - n_ok} 个。见下方日志。",
            )
        else:
            QMessageBox.critical(
                self, "失败", f"0 / {len(srcs)} 成功。见下方日志。"
            )

    def dragEnterEvent(self, e: QDragEnterEvent) -> None:
        if e.mimeData().hasUrls():
            e.acceptProposedAction()
        else:
            super().dragEnterEvent(e)

    def dropEvent(self, e: QDropEvent) -> None:
        for u in e.mimeData().urls():
            p = Path(u.toLocalFile())
            if str(p):
                self._list.addItem(str(p))
        e.acceptProposedAction()

    def closeEvent(self, e: QCloseEvent) -> None:
        e.accept()
