"""「全局搜索」对话框——在全部内容 JSON(data/scenes/dialogues)里搜任意字符串。

后端是 json_lang LSP 的 gamedraft/search(值/键/数字整树匹配,含未保存 overlay);
LSP 不可用时自动降级为直接读盘扫描(同一套 search.py,只是看不见未保存编辑,头部
会明确标注)。结果按文件分组,每条命中给出行号/JSON 路径/类型/上下文摘要,命中段
以琥珀底真高亮渲染(_HighlightDelegate);双击跳到对应编辑页并逐条定位,随后做
「字段级聚光」——把承载命中的输入控件展开/聚焦/选中命中段并短暂描边(见
search_spotlight.py),映射不到编辑页的自动复制 JSON 路径兜底。

只查不改:本对话框不写模型、不写盘;选中/跳转与用户手点列表完全同语义。
"""

from __future__ import annotations

import html as _html
import threading
from pathlib import Path

from PySide6.QtCore import Qt, QTimer, Signal
from PySide6.QtGui import QPalette, QTextDocument
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDialog, QHBoxLayout, QLabel, QLineEdit, QMenu,
    QPushButton, QStyle, QStyledItemDelegate, QStyleOptionViewItem,
    QToolButton, QTreeWidget, QTreeWidgetItem, QVBoxLayout,
)

_LIMIT = 800          # 单次搜索最多展示的命中数(后端截断,头部会提示)
_AUTO_MIN_CHARS = 2   # 实时搜索的最短查询长度(回车不受限)
_KIND_LABELS = {"value": "值", "key": "键", "scalar": "数字"}
_ROLE_HIT = Qt.ItemDataRole.UserRole
_ROLE_HTML = Qt.ItemDataRole.UserRole + 1

# 命中段高亮:琥珀底 + 近黑字,明暗主题下都可读;只出现在结果渲染里,不碰全局主题
_MARK_STYLE = "background-color:#e6a817;color:#1a1a1a;font-weight:600;"


class _HighlightDelegate(QStyledItemDelegate):
    """摘要列的富文本渲染:命中段真高亮,其余文字跟随主题前景色/选中色。"""

    def paint(self, painter, option, index) -> None:
        doc_html = index.data(_ROLE_HTML)
        if not doc_html:
            super().paint(painter, option, index)
            return
        opt = QStyleOptionViewItem(option)
        self.initStyleOption(opt, index)
        opt.text = ""  # 背景(含选中态/悬停态)交给样式画,文字我们自己画
        widget = opt.widget
        style = widget.style() if widget is not None else QApplication.style()
        style.drawControl(QStyle.ControlElement.CE_ItemViewItem, opt, painter, widget)

        selected = bool(opt.state & QStyle.StateFlag.State_Selected)
        role = QPalette.ColorRole.HighlightedText if selected else QPalette.ColorRole.Text
        base_color = opt.palette.color(role).name()
        doc = QTextDocument()
        doc.setDefaultFont(opt.font)
        doc.setDocumentMargin(0)
        doc.setHtml(f'<span style="color:{base_color};">{doc_html}</span>')

        painter.save()
        painter.setClipRect(opt.rect)
        y = opt.rect.top() + max(0, int((opt.rect.height() - doc.size().height()) / 2))
        painter.translate(opt.rect.left() + 2, y)
        doc.drawContents(painter)
        painter.restore()

# scope 下拉:显示名 → gamedraft/search 的 scope 参数(简写在 search.py 登记)
_SCOPES = [
    ("全部内容", ""),
    ("data(数据)", "data"),
    ("scenes(场景)", "scenes"),
    ("dialogues(图对话)", "dialogues"),
    ("叙事状态机", "narrative"),
    ("过场", "cutscenes"),
]


_LSP_SEARCH_TIMEOUT = 6.0  # LSP 搜索请求超时(审查 P3:原 20s 太长,策划空等)


class GlobalSearchDialog(QDialog):
    # 搜索在后台线程跑(LSP 请求可能阻塞);结果经 Signal 排队回主线程。
    _result_ready = Signal(int, dict, bool)  # (generation, 结果 payload, 是否经 LSP)
    # LSP 响应健康度:超时未应答=False(主窗芯片转"疑似无响应"),正常应答=True。
    lsp_health = Signal(bool)

    def __init__(self, client_getter, root_getter, navigate_cb,
                 refs_cb=None, parent=None):
        super().__init__(parent)
        self._client_getter = client_getter
        self._root_getter = root_getter
        self._navigate_cb = navigate_cb
        self._refs_cb = refs_cb
        self._generation = 0

        self.setWindowTitle("全局搜索(全部内容 JSON)")
        self.resize(860, 560)

        root = QVBoxLayout(self)

        row = QHBoxLayout()
        self._input = QLineEdit()
        self._input.setPlaceholderText("输入任意字符串:台词 / 物品名 / id / 路径 / 数字…(回车立即搜索)")
        self._input.setClearButtonEnabled(True)
        self._input.textChanged.connect(self._on_text_changed)
        self._input.returnPressed.connect(self._search_now)
        row.addWidget(self._input, 1)

        self._case_btn = QToolButton()
        self._case_btn.setText("Aa")
        self._case_btn.setCheckable(True)
        self._case_btn.setAutoRaise(True)
        self._case_btn.setToolTip("区分大小写(默认不区分;中文不受影响)")
        self._case_btn.toggled.connect(lambda _c: self._search_now())
        row.addWidget(self._case_btn)

        self._scope_cb = QComboBox()
        for label, value in _SCOPES:
            self._scope_cb.addItem(label, value)
        self._scope_cb.setToolTip("限定搜索范围(按内容目录)")
        self._scope_cb.currentIndexChanged.connect(lambda _i: self._search_now())
        row.addWidget(self._scope_cb)

        btn = QPushButton("搜索")
        btn.setToolTip("立即搜索(输入停顿后也会自动搜索)")
        btn.clicked.connect(self._search_now)
        row.addWidget(btn)
        root.addLayout(row)

        self._head = QLabel("")
        # 查询串可能含 "<b>"/"<script" 之类,默认 AutoText 会当富文本渲染错乱
        self._head.setTextFormat(Qt.TextFormat.PlainText)
        self._head.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        root.addWidget(self._head)

        self._tree = QTreeWidget()
        self._tree.setHeaderLabels(["位置", "类型", "命中内容(高亮为命中段)"])
        self._tree.setColumnWidth(0, 300)
        self._tree.setColumnWidth(1, 44)
        self._tree.setRootIsDecorated(True)
        self._tree.setUniformRowHeights(True)
        self._tree.setItemDelegateForColumn(2, _HighlightDelegate(self._tree))
        self._tree.itemActivated.connect(self._on_item_activated)
        self._tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tree.customContextMenuRequested.connect(self._show_context_menu)
        root.addWidget(self._tree, 1)

        tip = QLabel("双击一行跳到对应编辑页并定位;右键更多操作。"
                     "搜索实时包含未保存的编辑(需 LSP 运行;图对话/小游戏等暂存类编辑以磁盘为准)。")
        tip.setStyleSheet("color: gray;")
        tip.setWordWrap(True)
        root.addWidget(tip)

        # 输入防抖:停顿 350ms 自动搜索(≥2 字符;回车不受限、立即搜)
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(350)
        self._debounce.timeout.connect(self._auto_search)

        self._result_ready.connect(self._on_result_ready)

    # ---------------- 打开/输入 ----------------

    def open_with_query(self, query: str = "") -> None:
        """主窗口入口:显示(或唤起)对话框并聚焦输入框;带查询则立即搜。"""
        if query:
            self._input.setText(query)
        self.show()
        self.raise_()
        self.activateWindow()
        self._input.setFocus()
        self._input.selectAll()
        if self._input.text().strip():
            self._search_now()

    def _on_text_changed(self, _text: str) -> None:
        self._debounce.start()

    def _auto_search(self) -> None:
        if len(self._input.text().strip()) >= _AUTO_MIN_CHARS and self.isVisible():
            self._search_now()

    # ---------------- 搜索(后台线程 + 世代号防乱序) ----------------

    def _search_now(self) -> None:
        query = self._input.text().strip()
        self._debounce.stop()
        self._generation += 1
        gen = self._generation
        if not query:
            self._tree.clear()
            self._head.setText("")
            return
        params = {
            "query": query,
            "ignoreCase": not self._case_btn.isChecked(),
            "limit": _LIMIT,
            "scope": self._scope_cb.currentData() or "",
        }
        self._head.setText(f"正在搜索「{query}」…")
        client = self._client_getter() if self._client_getter else None
        root = self._root_getter() if self._root_getter else None
        threading.Thread(
            target=self._search_worker, args=(gen, params, client, root), daemon=True,
        ).start()

    def _search_worker(self, gen: int, params: dict, client, root) -> None:
        try:
            if client is not None and client.available:
                result = client.request(
                    "gamedraft/search", params, timeout=_LSP_SEARCH_TIMEOUT)
                if isinstance(result, dict) and "hits" in result:
                    self.lsp_health.emit(True)  # server 正常应答
                    self._result_ready.emit(gen, result, True)
                    return
                if result is None:
                    # 进程活着(available)却在超时内没应答 → 疑似假死,芯片如实降级
                    self.lsp_health.emit(False)
            # 降级:直接读盘扫描(不含未保存编辑)
            result = self._disk_scan(params, root)
            self._result_ready.emit(gen, result, False)
        except Exception as e:
            self._result_ready.emit(gen, {"error": str(e), "hits": []}, False)

    @staticmethod
    def _disk_scan(params: dict, root) -> dict:
        if root is None:
            return {"error": "未打开工程", "hits": []}
        try:
            from tools.json_lang.search import find_text
        except ImportError:
            import sys
            sys.path.insert(0, str(root))
            from tools.json_lang.search import find_text
        res = find_text(Path(root), params["query"],
                        ignore_case=params.get("ignoreCase", True),
                        limit=params.get("limit", _LIMIT),
                        scope=params.get("scope", ""))
        return {
            "query": params["query"], "total": res.total,
            "truncated": res.total > len(res.hits),
            "filesScanned": res.files_scanned, "failedFiles": res.failed_files,
            "hits": [{
                "file": h.file, "pointer": h.pointer, "kind": h.kind,
                "context": h.context, "excerpt": h.excerpt,
                "matchStart": h.match_start, "matchLen": h.match_len,
                "anchors": h.anchors,
            } for h in res.hits],
        }

    # ---------------- 结果渲染 ----------------

    def _on_result_ready(self, gen: int, result: dict, via_lsp: bool) -> None:
        if gen != self._generation:
            return  # 过期结果(用户已改查询)
        self._tree.clear()
        if result.get("error"):
            self._head.setText(f"⚠ 搜索失败:{result['error']}")
            return
        hits = result.get("hits") or []
        total = int(result.get("total", len(hits)))
        by_file: dict[str, list[dict]] = {}
        for h in hits:
            by_file.setdefault(str(h.get("file", "?")), []).append(h)

        head = f"「{result.get('query', '')}」共 {total} 处命中 · {len(by_file)} 个文件"
        if result.get("truncated"):
            head += f" · 仅展示前 {len(hits)} 条(请细化查询)"
        if not via_lsp:
            head += " · ⚠ 直接读盘(LSP 未运行,不含未保存编辑)"
        failed = result.get("failedFiles") or []
        if failed:
            head += f" · {len(failed)} 个文件解析失败被跳过"
        self._head.setText(head)

        for file in sorted(by_file):
            rows = by_file[file]
            short = file.removeprefix("public/assets/")
            top = QTreeWidgetItem([short, "", f"{len(rows)} 处"])
            top.setToolTip(0, file)
            self._tree.addTopLevelItem(top)
            for h in rows:
                excerpt = str(h.get("excerpt", ""))
                ms = int(h.get("matchStart", 0))
                ml = int(h.get("matchLen", 0))
                context = str(h.get("context", "") or "")
                if 0 <= ms <= len(excerpt) and ml > 0 and ms + ml <= len(excerpt):
                    marked_html = (
                        _html.escape(excerpt[:ms])
                        + f'<span style="{_MARK_STYLE}">'
                        + _html.escape(excerpt[ms:ms + ml]) + "</span>"
                        + _html.escape(excerpt[ms + ml:])
                    )
                else:
                    marked_html = _html.escape(excerpt)
                summary_html = (
                    f'<span style="color:gray;">{_html.escape(context)} ｜ </span>'
                    if context else ""
                ) + marked_html
                line = h.get("line")
                loc = (f"行 {line}  " if isinstance(line, int) else "") + str(h.get("pointer", ""))
                kind = _KIND_LABELS.get(str(h.get("kind", "")), str(h.get("kind", "")))
                plain = (context + " ｜ " if context else "") + excerpt
                child = QTreeWidgetItem(["", kind, plain])
                child.setText(0, loc)
                child.setToolTip(0, f"{file}\n{h.get('pointer', '')}")
                # Qt tooltip 支持富文本:悬停也看得到高亮
                child.setToolTip(2, f'<p style="white-space:pre-wrap;">{summary_html}</p>')
                child.setData(0, _ROLE_HIT, h)
                child.setData(2, _ROLE_HTML, summary_html)
                top.addChild(child)
            top.setExpanded(True)

    # ---------------- 跳转 / 复制 ----------------

    def _hit_of(self, item: QTreeWidgetItem | None) -> dict | None:
        if item is None:
            return None
        h = item.data(0, _ROLE_HIT)
        return h if isinstance(h, dict) else None

    def _on_item_activated(self, item: QTreeWidgetItem, _col: int) -> None:
        self._navigate(item)

    @staticmethod
    def _matched_slice(h: dict) -> str:
        """命中处的数据原文切片(字段级聚光用它在编辑页里精确找到控件)。"""
        excerpt = str(h.get("excerpt", ""))
        ms, ml = int(h.get("matchStart", 0)), int(h.get("matchLen", 0))
        if 0 <= ms <= len(excerpt) and ml > 0 and ms + ml <= len(excerpt):
            return excerpt[ms:ms + ml]
        return ""

    def _navigate(self, item: QTreeWidgetItem | None) -> None:
        h = self._hit_of(item)
        if h is None:
            return
        ok, note = True, ""
        if callable(self._navigate_cb):
            ok, note = self._navigate_cb(
                str(h.get("file", "")), str(h.get("pointer", "")),
                h.get("anchors") or [], self._matched_slice(h),
                str(h.get("excerpt", "")))
        # 三态(导航诚实化契约):True=已定位;None=已打开页但未逐条定位(软成功,
        # 不复制指针不报警告);False=未找到/失败(复制指针兜底 + ⚠ 提示)。
        if ok is True:
            self._head.setText(note or "已跳转")
        elif ok is None:
            self._head.setText(note or "已打开对应编辑页")
        else:
            self._copy_pointer(item)
            self._head.setText(f"⚠ {note};已复制 JSON 路径到剪贴板")

    def _copy_pointer(self, item: QTreeWidgetItem | None) -> None:
        h = self._hit_of(item)
        if h is not None:
            QApplication.clipboard().setText(f"{h.get('file', '')} @ {h.get('pointer', '')}")

    def _copy_excerpt(self, item: QTreeWidgetItem | None) -> None:
        h = self._hit_of(item)
        if h is not None:
            QApplication.clipboard().setText(str(h.get("excerpt", "")))

    def _open_refs(self, item: QTreeWidgetItem | None) -> None:
        h = self._hit_of(item)
        if h is None or not callable(self._refs_cb):
            return
        self._refs_cb(self._matched_slice(h) or str(h.get("excerpt", "")))

    def _show_context_menu(self, pos) -> None:
        item = self._tree.itemAt(pos)
        if self._hit_of(item) is None:
            return
        menu = QMenu(self)
        menu.addAction("跳转到编辑器", lambda: self._navigate(item))
        menu.addSeparator()
        menu.addAction("复制 JSON 路径", lambda: self._copy_pointer(item))
        menu.addAction("复制命中片段", lambda: self._copy_excerpt(item))
        if callable(self._refs_cb):
            menu.addAction("以命中文本查精确引用…", lambda: self._open_refs(item))
        menu.exec(self._tree.viewport().mapToGlobal(pos))
