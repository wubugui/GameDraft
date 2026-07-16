"""「查引用(JSON 语言)」对话框——编辑器消费 json_lang LSP 的 gamedraft/refs。

覆盖全部 id 宇宙(物品/任务/flag/场景/NPC/信号/档案…),含 [tag:…] 文本内引用;
结果实时反映编辑器未保存内容(overlay 已推送时)。双击结果行=跳转到对应编辑页,
右键=复制 JSON 指针。要迁移/改名/删除,实体走场景编辑器「重构」菜单,内容 id 可在
IDE 里 F2。

请求走后台线程 + Signal 回主线程(照 global_search_dialog 世代号样板),避免大查询
在 GUI 线程 event.wait 阻塞整个 UI(审查 P2)。
"""

from __future__ import annotations

import threading

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QDialog, QHBoxLayout, QLabel, QLineEdit, QMenu, QPushButton, QTreeWidget,
    QTreeWidgetItem, QVBoxLayout, QApplication,
)


class LspRefsDialog(QDialog):
    # 查询在后台线程跑(LSP 请求可能阻塞);结果经 Signal 排队回主线程。
    _result_ready = Signal(int, str, object)  # (generation, target, 结果 payload | None)

    def __init__(self, client_getter, parent=None, initial_id: str = "",
                 navigate_cb=None):
        super().__init__(parent)
        self._client_getter = client_getter
        self._navigate_cb = navigate_cb
        self._generation = 0
        self.setWindowTitle("查引用(JSON 语言)")
        self.resize(760, 480)

        root = QVBoxLayout(self)
        row = QHBoxLayout()
        self._input = QLineEdit(initial_id)  # 自由检索框:任意 id / 键名 / tag 段
        self._input.setPlaceholderText("输入任意 id(物品/任务/flag/NPC/信号/档案…)后回车")
        self._input.returnPressed.connect(self._search)
        btn = QPushButton("查引用")
        btn.setToolTip("全内容文件三路匹配:值引用 / 键引用 / [tag:…] 文本内引用;含未保存的编辑器内容")
        btn.clicked.connect(self._search)
        row.addWidget(self._input, 1)
        row.addWidget(btn)
        root.addLayout(row)

        self._head = QLabel("")
        self._head.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        root.addWidget(self._head)

        self._tree = QTreeWidget()
        self._tree.setHeaderLabels(["文件", "类型", "JSON 路径", "上下文"])
        self._tree.setColumnWidth(0, 260)
        self._tree.setColumnWidth(1, 52)
        self._tree.setColumnWidth(2, 220)
        self._tree.setRootIsDecorated(True)
        self._tree.itemDoubleClicked.connect(self._on_double_click)
        self._tree.setContextMenuPolicy(Qt.ContextMenuPolicy.CustomContextMenu)
        self._tree.customContextMenuRequested.connect(self._show_context_menu)
        root.addWidget(self._tree, 1)

        tip = QLabel("双击一行跳到对应编辑页并定位;右键复制 JSON 路径;★=疑似定义处。"
                     "只查不改:实体改名/迁移走场景编辑器「重构」菜单。")
        tip.setStyleSheet("color: gray;")
        tip.setWordWrap(True)
        root.addWidget(tip)

        self._result_ready.connect(self._on_result_ready)

        if initial_id:
            self._search()

    def open_with_id(self, target: str = "") -> None:
        """主窗口入口(单实例复用):显示(或唤起)对话框并聚焦输入框;带 id 则立即查。"""
        if target:
            self._input.setText(target)
        self.show()
        self.raise_()
        self.activateWindow()
        self._input.setFocus()
        self._input.selectAll()
        if self._input.text().strip():
            self._search()

    # ---------------- 查询(后台线程 + 世代号防乱序) ----------------

    def _search(self) -> None:
        target = self._input.text().strip()
        self._tree.clear()
        self._generation += 1
        gen = self._generation
        if not target:
            self._head.setText("")
            return
        client = self._client_getter()
        if client is None or not client.available:
            self._head.setText("⚠ json_lang LSP 未运行(工程未加载或 server 启动失败),查引用不可用")
            return
        self._head.setText(f"正在查「{target}」的引用…")
        threading.Thread(
            target=self._search_worker, args=(gen, target, client), daemon=True,
        ).start()

    def _search_worker(self, gen: int, target: str, client) -> None:
        try:
            result = client.request("gamedraft/refs", {"id": target})
        except Exception as e:
            result = {"__error__": str(e)}
        self._result_ready.emit(gen, target, result)

    def _on_result_ready(self, gen: int, target: str, result) -> None:
        if gen != self._generation:
            return  # 过期结果(用户已改查询)
        self._tree.clear()
        if isinstance(result, dict) and result.get("__error__"):
            self._head.setText(f"⚠ 查询失败:{result['__error__']}")
            return
        if not isinstance(result, dict) or "refs" not in result:
            self._head.setText("⚠ 查询失败(server 无响应或返回异常)")
            return
        universes = result.get("universes") or []
        refs = result.get("refs") or []
        head = f"「{target}」"
        head += f"  ∈ 宇宙: {', '.join(universes)}" if universes else "  (不属于任何已知 id 宇宙)"
        head += f"  ·  共 {len(refs)} 处引用"
        self._head.setText(head)

        by_file: dict[str, list[dict]] = {}
        for r in refs:
            by_file.setdefault(r.get("file", "?"), []).append(r)
        for file in sorted(by_file):
            top = QTreeWidgetItem([file, "", "", f"{len(by_file[file])} 处"])
            self._tree.addTopLevelItem(top)
            for r in by_file[file]:
                mark = " ★" if r.get("definitionHint") else ""
                child = QTreeWidgetItem([
                    "", r.get("kind", ""), r.get("pointer", ""), (r.get("context") or "") + mark,
                ])
                child.setData(0, Qt.ItemDataRole.UserRole, r)
                top.addChild(child)
            top.setExpanded(True)

    # ---------------- 跳转 / 复制 ----------------

    @staticmethod
    def _ref_of(item: QTreeWidgetItem | None) -> dict | None:
        if item is None:
            return None
        r = item.data(0, Qt.ItemDataRole.UserRole)
        return r if isinstance(r, dict) else None

    def _on_double_click(self, item: QTreeWidgetItem, _col: int) -> None:
        """双击结果行=跳转(refs 带 file/pointer,复用主窗 navigate_to_search_hit)。"""
        r = self._ref_of(item)
        if r is None or not callable(self._navigate_cb):
            # 文件分组行或无跳转回调:退回复制指针
            self._copy_pointer(item)
            return
        try:
            ok, note = self._navigate_cb(
                str(r.get("file", "")), str(r.get("pointer", "")), [], "", "")
        except Exception as e:
            ok, note = False, f"跳转失败:{e}"
        # 三态(导航诚实化契约):True=已定位;None=已打开页(软成功);False=未找到/失败。
        if ok is True:
            self._head.setText(note or "已跳转")
        elif ok is None:
            self._head.setText(note or "已打开对应编辑页")
        else:
            self._copy_pointer(item)
            self._head.setText(f"⚠ {note};已复制 JSON 路径到剪贴板")

    def _copy_pointer(self, item: QTreeWidgetItem | None) -> None:
        r = self._ref_of(item)
        if r is not None:
            QApplication.clipboard().setText(f"{r.get('file', '')} @ {r.get('pointer', '')}")

    def _show_context_menu(self, pos) -> None:
        item = self._tree.itemAt(pos)
        if self._ref_of(item) is None:
            return
        menu = QMenu(self)
        if callable(self._navigate_cb):
            menu.addAction("跳转到编辑器", lambda: self._on_double_click(item, 0))
            menu.addSeparator()
        menu.addAction("复制 JSON 路径", lambda: self._copy_pointer(item))
        menu.exec(self._tree.viewport().mapToGlobal(pos))
