from __future__ import annotations

from pathlib import Path

from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QMessageBox,
    QPushButton,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim.core.simulation.run_manager import fork_run
from tools.chronicle_sim.core.storage.db import Database
from tools.chronicle_sim.gui import app_settings
from tools.chronicle_sim.gui.layout_compact import tighten


class ExportWidget(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._db: Database | None = None
        self._run_dir: Path | None = None
        self._last_preview_md: str = ""
        lay = QVBoxLayout(self)
        tighten(lay, margins=(6, 6, 6, 6), spacing=4)
        row = QHBoxLayout()
        row.addWidget(QLabel("模板:"))
        self._tpl = QComboBox()
        self._tpl.addItems(["素材矿清单", "周月摘要合集", "事件表 Markdown"])
        self._tpl.currentIndexChanged.connect(self.refresh)
        row.addWidget(self._tpl)
        btn = QPushButton("导出到文件…")
        btn.clicked.connect(self._export_file)
        row.addWidget(btn)
        btn_fork = QPushButton("从当前 run 分支复制…")
        btn_fork.clicked.connect(self._fork)
        row.addWidget(btn_fork)
        lay.addLayout(row)
        self._preview = QTextEdit()
        self._preview.setReadOnly(True)
        self._preview.setAcceptRichText(True)
        lay.addWidget(self._preview, 1)

    def save_ui_prefs(self) -> None:
        app_settings.set_value("export/tpl_index", self._tpl.currentIndex())

    def restore_ui_prefs(self) -> None:
        t = app_settings.get_value("export/tpl_index", 0)
        try:
            ti = int(t)
        except (TypeError, ValueError):
            ti = 0
        ti = max(0, min(ti, self._tpl.count() - 1))
        self._tpl.blockSignals(True)
        self._tpl.setCurrentIndex(ti)
        self._tpl.blockSignals(False)
        self.refresh()

    def set_database(self, db: Database | None, run_dir: Path | None) -> None:
        self._db = db
        self._run_dir = run_dir
        self.refresh()

    def refresh(self) -> None:
        self._preview.clear()
        self._last_preview_md = ""
        if not self._db:
            return
        idx = self._tpl.currentIndex()
        lines: list[str] = []
        if idx == 0:
            lines.append("# 编年史素材矿\n")
            for r in self._db.conn.execute(
                "SELECT week_start, week_end, text FROM summaries ORDER BY week_start"
            ).fetchall():
                lines.append(f"## 第 {r['week_start']}-{r['week_end']} 段\n\n{r['text']}\n\n")
        elif idx == 1:
            lines.append("# 摘要合集\n")
            for r in self._db.conn.execute(
                "SELECT scope, week_start, week_end, text, style_applied FROM summaries ORDER BY scope, week_start"
            ).fetchall():
                lines.append(
                    f"## [{r['scope']}] {r['week_start']}-{r['week_end']} 润色={r['style_applied']}\n\n{r['text']}\n\n"
                )
        else:
            lines.append("# 事件表\n")
            for e in self._db.conn.execute(
                "SELECT id, week_number, type_id, truth_json, witness_accounts_json FROM events ORDER BY week_number"
            ).fetchall():
                lines.append(f"## {e['id']} 周{e['week_number']} {e['type_id']}\n")
                lines.append(f"truth: {e['truth_json']}\n")
                lines.append(f"witness: {e['witness_accounts_json']}\n\n")
        md = "".join(lines)
        self._last_preview_md = md
        self._preview.setMarkdown(md)

    def _export_file(self) -> None:
        if not self._run_dir:
            return
        path, _ = QFileDialog.getSaveFileName(
            self,
            "导出",
            str(self._run_dir / "exports" / "export.md"),
            "Markdown (*.md);;HTML (*.html)",
        )
        if not path:
            return
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        if path.lower().endswith(".html"):
            doc = self._preview.document().clone()
            html = doc.toHtml()
            Path(path).write_text(
                f"<!DOCTYPE html><html><head><meta charset='utf-8'><title>export</title></head>"
                f"<body>{html}</body></html>",
                encoding="utf-8",
            )
        else:
            Path(path).write_text(self._last_preview_md, encoding="utf-8")
        QMessageBox.information(self, "完成", f"已写入 {path}")

    def _fork(self) -> None:
        if not self._run_dir:
            return
        label, ok = QInputDialog.getText(self, "分支", "分支标签（英文短名）:", text="branch")
        if not ok or not label.strip():
            return
        new_id, new_dir = fork_run(self._run_dir, label.strip())
        QMessageBox.information(self, "完成", f"已复制到新 run：{new_id}\n{new_dir}")
