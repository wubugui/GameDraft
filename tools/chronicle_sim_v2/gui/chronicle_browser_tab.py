"""编年史浏览标签页：目录树浏览 + 探针问答 + 搜索。"""
from __future__ import annotations

import json
import os
from html import escape as html_escape
from pathlib import Path

from PySide6.QtCore import Qt, QThreadPool, Signal
from PySide6.QtWidgets import (
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QPlainTextEdit,
    QPushButton,
    QSplitter,
    QTabWidget,
    QTextBrowser,
    QTextEdit,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim_v2.core.llm.client_factory import ClientFactory
from tools.chronicle_sim_v2.core.llm.config_resolve import provider_profile_for_agent
from tools.chronicle_sim_v2.core.llm.pa_run import dict_chat_to_message_history
from tools.chronicle_sim_v2.core.world.fs import read_json, read_text, grep_search
from tools.chronicle_sim_v2.core.world.chroma import is_embedding_configured, search_world
from tools.chronicle_sim_v2.core.world.week_state import list_weeks
from tools.chronicle_sim_v2.gui.async_runnable import CancellableAsyncWorker
from tools.chronicle_sim_v2.gui.human_display import probe_reply_to_html
from tools.chronicle_sim_v2.paths import PROMPTS_DIR


class ChronicleBrowserTab(QWidget):
    log_signal = Signal(str)
    run_changed = Signal(object)

    def __init__(self) -> None:
        super().__init__()
        self._run_dir: Path | None = None
        self._llm_config: dict = {}
        self._visible = False
        self._probe_turns: list[tuple[str, str]] = []
        self._probe_worker: CancellableAsyncWorker | None = None
        self._pending_probe_user: str = ""
        self._probe_job_run: Path | None = None

        layout = QVBoxLayout(self)

        self._tabs = QTabWidget()
        layout.addWidget(self._tabs)

        # —— 浏览 ——
        browse = QWidget()
        browse_layout = QVBoxLayout(browse)

        search_layout = QHBoxLayout()
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("搜索编年史内容...")
        search_layout.addWidget(self.search_edit)

        self.btn_grep = QPushButton("Grep 搜索")
        self.btn_grep.clicked.connect(self._grep_search)
        search_layout.addWidget(self.btn_grep)

        self.btn_semantic = QPushButton("语义搜索")
        self.btn_semantic.clicked.connect(self._semantic_search)
        search_layout.addWidget(self.btn_semantic)

        self.btn_export = QPushButton("导出 MD")
        self.btn_export.clicked.connect(self._export_md)
        search_layout.addWidget(self.btn_export)

        self.btn_clear_search = QPushButton("清除")
        self.btn_clear_search.clicked.connect(self._clear_search)
        search_layout.addWidget(self.btn_clear_search)

        self.btn_rebuild = QPushButton("重建索引")
        self.btn_rebuild.clicked.connect(self._rebuild_index)
        search_layout.addWidget(self.btn_rebuild)

        search_layout.addStretch()
        browse_layout.addLayout(search_layout)

        splitter = QSplitter(Qt.Horizontal)
        self.tree = QTreeWidget()
        self.tree.setHeaderLabel("编年史目录")
        self.tree.itemClicked.connect(self._on_tree_click)
        splitter.addWidget(self.tree)

        self.detail = QTextEdit()
        self.detail.setReadOnly(True)
        splitter.addWidget(self.detail)

        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 2)
        browse_layout.addWidget(splitter)

        self._tabs.addTab(browse, "浏览")

        # —— 素材探针 ——
        probe = QWidget()
        probe_layout = QVBoxLayout(probe)

        self.probe_status = QLabel("就绪")
        self.probe_status.setStyleSheet("QLabel { font-weight: bold; }")
        probe_layout.addWidget(self.probe_status)

        self.probe_browser = QTextBrowser()
        self.probe_browser.setMinimumHeight(220)
        self.probe_browser.setOpenExternalLinks(True)
        probe_layout.addWidget(self.probe_browser, 1)

        self.probe_input = QPlainTextEdit()
        self.probe_input.setPlaceholderText("输入关于本 Run 编年史的问题（可多轮追问）…")
        self.probe_input.setMaximumHeight(140)
        probe_layout.addWidget(self.probe_input)

        probe_btns = QHBoxLayout()
        self.btn_probe_send = QPushButton("发送")
        self.btn_probe_send.clicked.connect(self._on_probe_send)
        probe_btns.addWidget(self.btn_probe_send)

        self.btn_probe_cancel = QPushButton("取消")
        self.btn_probe_cancel.setEnabled(False)
        self.btn_probe_cancel.clicked.connect(self._on_probe_cancel)
        probe_btns.addWidget(self.btn_probe_cancel)

        self.btn_probe_clear_session = QPushButton("清空会话")
        self.btn_probe_clear_session.clicked.connect(self._clear_probe_session)
        probe_btns.addWidget(self.btn_probe_clear_session)

        probe_btns.addStretch()
        probe_layout.addLayout(probe_btns)

        self._tabs.addTab(probe, "素材探针")

    def set_run_dir(self, run_dir: Path | None, llm_config: dict | None = None) -> None:
        prev = self._run_dir
        if prev != run_dir and self._probe_worker is not None:
            try:
                self._probe_worker.request_cancel()
            except Exception:
                pass
        self._run_dir = run_dir
        if llm_config is not None:
            self._llm_config = llm_config
        if prev != run_dir:
            self._clear_probe_session()
            self._set_probe_busy(False)
        if run_dir:
            self._refresh_tree()
        else:
            self.tree.clear()
            self.detail.clear()

    def showEvent(self, event) -> None:  # type: ignore
        super().showEvent(event)
        if not self._visible:
            self._visible = True
        self._refresh_tree()

    def _clear_probe_session(self) -> None:
        self._probe_turns.clear()
        self.probe_browser.clear()
        self.probe_status.setText("就绪")

    def _set_probe_busy(self, busy: bool) -> None:
        self._probe_busy = busy
        self.btn_probe_send.setEnabled(not busy)
        self.btn_probe_cancel.setEnabled(busy)
        self.btn_probe_clear_session.setEnabled(not busy)
        self.probe_input.setReadOnly(busy)

    def _on_probe_send(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        text = self.probe_input.toPlainText().strip()
        if not text:
            return
        self._pending_probe_user = text
        rows = []
        for u, a in self._probe_turns:
            rows.append({"role": "user", "content": u})
            rows.append({"role": "assistant", "content": a})
        msg_hist = dict_chat_to_message_history(rows) if rows else None

        self.probe_browser.append(f"<p style='margin:8px 0'><b>你：</b>{html_escape(text)}</p>")
        self.probe_input.clear()
        self.probe_status.setText("正在处理…")
        self._set_probe_busy(True)
        self._probe_job_run = self._run_dir

        run_dir = self._run_dir
        llm = self._llm_config

        async def _do() -> str:
            pa = ClientFactory.build_pa_chat(
                "probe",
                provider_profile_for_agent("probe", llm),
                llm,
                run_dir=run_dir,
            )
            from tools.chronicle_sim_v2.core.agents.probe_agent import run_probe_user_turn

            return await run_probe_user_turn(
                pa,
                PROMPTS_DIR,
                run_dir,
                text,
                message_history=msg_hist,
            )

        self._probe_worker = CancellableAsyncWorker(_do())
        self._probe_worker.signals.finished.connect(self._on_probe_finished)
        self._probe_worker.signals.error.connect(self._on_probe_error)
        self._probe_worker.signals.cancelled.connect(self._on_probe_cancelled)
        QThreadPool.globalInstance().start(self._probe_worker)

    def _on_probe_finished(self, result: object) -> None:
        self._set_probe_busy(False)
        if self._run_dir != self._probe_job_run:
            return
        self.probe_status.setText("就绪")
        ans = str(result) if result is not None else ""
        self._probe_turns.append((self._pending_probe_user, ans))
        self.probe_browser.append(
            "<div style='margin:8px 0;padding:8px;background:#f7f7f8;border-radius:6px'>"
            "<div style='font-weight:600;color:#2c5282;margin-bottom:6px'>探针</div>"
            f"{probe_reply_to_html(ans)}</div>"
        )

    def _on_probe_error(self, summary: str, detail: str) -> None:
        self._set_probe_busy(False)
        if self._run_dir != self._probe_job_run:
            return
        self.probe_status.setText(f"错误: {summary}")
        self.log_signal.emit(f"探针错误: {summary}")
        self.log_signal.emit(detail)
        self.probe_browser.append(
            f"<p style='color:#c53030'><b>错误：</b>{html_escape(summary)}</p>"
        )

    def _on_probe_cancelled(self) -> None:
        self._set_probe_busy(False)
        if self._run_dir != self._probe_job_run:
            return
        self.probe_status.setText("已取消")
        self.log_signal.emit("探针已取消")
        self.probe_browser.append("<p style='color:#666'>（已取消）</p>")

    def _on_probe_cancel(self) -> None:
        if self._probe_worker:
            self._probe_worker.request_cancel()

    def _refresh_tree(self) -> None:
        if not self._run_dir or not self._run_dir.is_dir():
            return
        weeks = list_weeks(self._run_dir)
        self.tree.clear()

        for week in weeks:
            week_item = QTreeWidgetItem(self.tree, [f"第 {week} 周"])

            ev_dir = self._run_dir / "chronicle" / f"week_{week:03d}" / "events"
            if ev_dir.is_dir():
                ev_count = len([f for f in os.listdir(ev_dir) if f.endswith(".json")])
                ev_item = QTreeWidgetItem(week_item, [f"事件 ({ev_count})"])
                for f in sorted(os.listdir(ev_dir)):
                    if f.endswith(".json"):
                        QTreeWidgetItem(ev_item, [f])

            intent_dir = self._run_dir / "chronicle" / f"week_{week:03d}" / "intents"
            if intent_dir.is_dir():
                intent_count = len([f for f in os.listdir(intent_dir) if f.endswith(".json")])
                intent_item = QTreeWidgetItem(week_item, [f"意图 ({intent_count})"])
                for f in sorted(os.listdir(intent_dir)):
                    if f.endswith(".json"):
                        QTreeWidgetItem(intent_item, [f])

            mem_dir = self._run_dir / "chronicle" / f"week_{week:03d}" / "memories"
            if mem_dir.is_dir():
                mem_count = len([f for f in os.listdir(mem_dir) if f.endswith(".json")])
                if mem_count > 0:
                    mem_item = QTreeWidgetItem(week_item, [f"记忆 ({mem_count})"])
                    for f in sorted(os.listdir(mem_dir)):
                        if f.endswith(".json"):
                            QTreeWidgetItem(mem_item, [f])

            rumors_path = self._run_dir / "chronicle" / f"week_{week:03d}" / "rumors.json"
            if rumors_path.is_file():
                rdata = read_json(self._run_dir, f"chronicle/week_{week:03d}/rumors.json")
                rn = len(rdata) if isinstance(rdata, list) else (1 if rdata else 0)
                rumors_item = QTreeWidgetItem(week_item, [f"谣言 ({rn})"])
                QTreeWidgetItem(rumors_item, ["rumors.json"])

            summary_path = self._run_dir / "chronicle" / f"week_{week:03d}" / "summary.md"
            if summary_path.is_file():
                summ_item = QTreeWidgetItem(week_item, ["总结"])
                QTreeWidgetItem(summ_item, ["summary.md"])

            week_item.setExpanded(True)

        chronicle_dir = self._run_dir / "chronicle"
        if chronicle_dir.is_dir():
            for f in sorted(os.listdir(chronicle_dir)):
                if f.startswith("month_") and f.endswith(".md"):
                    QTreeWidgetItem(self.tree, [f.replace(".md", "")])

    def _on_tree_click(self, item: QTreeWidgetItem, _column: int) -> None:
        if not self._run_dir:
            return
        text = item.text(0)

        if text.endswith(".json") or text.endswith(".md"):
            parent = item.parent()
            while parent and not parent.text(0).startswith("第"):
                parent = parent.parent()
            if not parent:
                return
            week_text = parent.text(0)
            try:
                week = int(week_text.replace("第", "").replace("周", "").strip())
            except ValueError:
                return

            if item.parent():
                parent_text = item.parent().text(0)
                if parent_text.startswith("谣言"):
                    rel_path = f"chronicle/week_{week:03d}/rumors.json"
                    data = read_json(self._run_dir, rel_path)
                    if data is not None:
                        self.detail.setPlainText(json.dumps(data, ensure_ascii=False, indent=2))
                    else:
                        self.detail.setPlainText("(空文件)")
                    return
                if parent_text.startswith("总结"):
                    rel_path = f"chronicle/week_{week:03d}/summary.md"
                    content = read_text(self._run_dir, rel_path)
                    self.detail.setPlainText(content)
                    return

            rel_path = f"chronicle/week_{week:03d}/"
            if item.parent():
                parent_text = item.parent().text(0)
                if parent_text.startswith("事件"):
                    rel_path += "events/"
                elif parent_text.startswith("意图"):
                    rel_path += "intents/"
                elif parent_text.startswith("记忆"):
                    rel_path += "memories/"
            rel_path += text

            if text.endswith(".json"):
                data = read_json(self._run_dir, rel_path)
                if data:
                    self.detail.setPlainText(json.dumps(data, ensure_ascii=False, indent=2))
                else:
                    self.detail.setPlainText("(空文件)")
            else:
                content = read_text(self._run_dir, rel_path)
                self.detail.setPlainText(content)

        elif text.startswith("month_"):
            rel_path = f"chronicle/{text}.md"
            content = read_text(self._run_dir, rel_path)
            self.detail.setPlainText(content)

    def _rebuild_index(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        from tools.chronicle_sim_v2.core.world.chroma import rebuild_world_collection

        n = rebuild_world_collection(self._run_dir)
        self.log_signal.emit(f"世界索引重建完成（{n} 条）")
        self._refresh_tree()

    def _clear_search(self) -> None:
        self.search_edit.clear()
        self.detail.clear()

    def _grep_search(self) -> None:
        if not self._run_dir:
            return
        q = self.search_edit.text().strip()
        if not q:
            return
        results = grep_search(self._run_dir, q, "chronicle")
        if not results:
            self.detail.setPlainText("未找到匹配")
            return
        lines = [f"{rel}:{ln}: {txt}" for rel, ln, txt in results[:50]]
        self.detail.setPlainText("\n".join(lines))
        self.log_signal.emit(f"Grep '{q}' → {len(results)} 条结果")

    def _semantic_search(self) -> None:
        if not self._run_dir:
            return
        q = self.search_edit.text().strip()
        if not q:
            return
        if not is_embedding_configured(self._run_dir):
            self.log_signal.emit("语义搜索未配置嵌入模型。请在种子编辑器 > LLM 配置 > 「嵌入」区域设置")
            return
        results = search_world(self._run_dir, q, n_results=10)
        if not results:
            self.detail.setPlainText("未找到相关结果")
            return
        parts = []
        for i, r in enumerate(results, 1):
            meta = r.get("metadata") or {}
            doc = r.get("document", "")
            kind = meta.get("kind", "unknown")
            parts.append(f"[{i}] kind={kind}\n{doc[:500]}")
        self.detail.setPlainText("\n\n".join(parts))
        self.log_signal.emit(f"语义搜索 '{q}' → {len(results)} 条结果")

    def _export_md(self) -> None:
        if not self._run_dir:
            return
        dest, _ = QFileDialog.getSaveFileName(self, "导出编年史", "", "Markdown 文件 (*.md)")
        if not dest:
            return
        parts = []
        weeks = list_weeks(self._run_dir)
        for week in weeks:
            wdir = f"chronicle/week_{week:03d}"

            summary = read_text(self._run_dir, f"{wdir}/summary.md")
            if summary:
                parts.append(f"# 第 {week} 周\n\n## 总结\n\n{summary}")

            ev_dir = self._run_dir / f"{wdir}/events"
            if ev_dir.is_dir():
                event_parts = []
                for f in sorted(os.listdir(ev_dir)):
                    if f.endswith(".json"):
                        data = read_json(self._run_dir, f"{wdir}/events/{f}")
                        if data:
                            title = data.get("type_id", f)
                            truth = data.get("truth_json", {})
                            truth_text = (
                                truth.get("what_happened", truth.get("note", ""))
                                if isinstance(truth, dict)
                                else str(truth)
                            )
                            event_parts.append(
                                f"### {title}\n\n**真相**: {truth_text}\n\n**目击者**:"
                            )
                            for w in data.get("witness_accounts", []):
                                event_parts.append(f"- {w.get('agent_id', '?')}: {w.get('account_text', '')}")
                if event_parts:
                    parts.append(f"\n## 事件详情\n\n" + "\n\n".join(event_parts))

            rumors = read_json(self._run_dir, f"{wdir}/rumors.json")
            if rumors:
                parts.append(f"\n## 谣言 ({len(rumors)} 条)\n\n")
                for r in rumors:
                    parts.append(
                        f"- {r.get('teller_id', '?')} → {r.get('hearer_id', '?')}: {r.get('content', '')}"
                    )

            intent_dir = self._run_dir / f"{wdir}/intents"
            if intent_dir.is_dir():
                intent_parts = []
                for f in sorted(os.listdir(intent_dir)):
                    if f.endswith(".json"):
                        data = read_json(self._run_dir, f"{wdir}/intents/{f}")
                        if data:
                            intent_parts.append(f"- {data.get('agent_id', f)}: {data.get('intent_text', '')}")
                if intent_parts:
                    parts.append(f"\n## 意图\n\n" + "\n".join(intent_parts))

        chronicle_dir = self._run_dir / "chronicle"
        if chronicle_dir.is_dir():
            for f in sorted(os.listdir(chronicle_dir)):
                if f.startswith("month_") and f.endswith(".md"):
                    content = read_text(self._run_dir, f"chronicle/{f}")
                    parts.append(f"\n# {f.replace('.md', '')}\n\n{content}")

        with open(dest, "w", encoding="utf-8") as out:
            out.write("\n\n---\n\n".join(parts))
        self.log_signal.emit(f"导出: {dest}")
