"""Archive editor: characters, lore, books, documents."""
from __future__ import annotations

from PySide6.QtWidgets import (
    QWidget, QHBoxLayout, QVBoxLayout, QSplitter, QListWidget, QTabWidget,
    QFormLayout, QLineEdit, QComboBox, QTextEdit, QPushButton, QSpinBox,
    QScrollArea, QLabel, QGroupBox,
)
from PySide6.QtCore import Qt

from ..project_model import ProjectModel
from ..shared.condition_editor import ConditionEditor


# ---------------------------------------------------------------------------
# Helpers for repeatable condition+text groups
# ---------------------------------------------------------------------------

class _CondTextGroup(QGroupBox):
    def __init__(self, title: str, data: dict,
                 model: ProjectModel | None = None, parent: QWidget | None = None):
        super().__init__(title, parent)
        lay = QVBoxLayout(self)
        self._cond = ConditionEditor("conditions")
        self._cond.set_flag_pattern_context(model, None)
        self._cond.set_data(data.get("conditions", []))
        lay.addWidget(self._cond)
        self._text = QTextEdit(data.get("text", ""))
        self._text.setMaximumHeight(50)
        lay.addWidget(self._text)

    def to_dict(self) -> dict:
        return {"conditions": self._cond.to_list(), "text": self._text.toPlainText()}


class _ListDetailTab(QWidget):
    """Generic list+detail for a flat list of dicts."""

    def __init__(self, model: ProjectModel, items_ref: list[dict],
                 data_type: str, build_detail, save_detail,
                 make_new, display_fn, parent=None):
        super().__init__(parent)
        self._model = model
        self._items = items_ref
        self._data_type = data_type
        self._build_detail = build_detail
        self._save_detail = save_detail
        self._make_new = make_new
        self._display_fn = display_fn
        self._current_idx = -1

        root = QHBoxLayout(self)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Add"); btn_add.clicked.connect(self._add)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._delete)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._list = QListWidget()
        self._list.currentRowChanged.connect(self._on_select)
        ll.addWidget(self._list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        self._detail = QWidget()
        self._detail_layout = QVBoxLayout(self._detail)
        self._build_detail(self._detail_layout)
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply)
        self._detail_layout.addWidget(apply_btn)
        self._detail_layout.addStretch()
        scroll.setWidget(self._detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 550])
        root.addWidget(splitter)
        self.refresh()

    def refresh(self) -> None:
        self._list.clear()
        for it in self._items:
            self._list.addItem(self._display_fn(it))

    def _on_select(self, row: int) -> None:
        if row < 0 or row >= len(self._items):
            return
        self._current_idx = row

    def _apply(self) -> None:
        if self._current_idx >= 0:
            self._save_detail(self._current_idx)
            self._model.mark_dirty(self._data_type)
            self.refresh()

    def _add(self) -> None:
        self._items.append(self._make_new())
        self._model.mark_dirty(self._data_type)
        self.refresh()

    def _delete(self) -> None:
        if self._current_idx >= 0:
            self._items.pop(self._current_idx)
            self._current_idx = -1
            self._model.mark_dirty(self._data_type)
            self.refresh()


# ---------------------------------------------------------------------------
# ArchiveEditor
# ---------------------------------------------------------------------------

class ArchiveEditor(QWidget):
    def __init__(self, model: ProjectModel, parent: QWidget | None = None):
        super().__init__(parent)
        self._model = model

        root = QVBoxLayout(self)
        tabs = QTabWidget()
        root.addWidget(tabs)

        tabs.addTab(self._build_characters_tab(), "Characters")
        tabs.addTab(self._build_lore_tab(), "Lore")
        tabs.addTab(self._build_documents_tab(), "Documents")
        tabs.addTab(self._build_books_tab(), "Books")

    # ---- Characters -------------------------------------------------------

    def _build_characters_tab(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Character"); btn_add.clicked.connect(self._add_char)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_char)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._char_list = QListWidget()
        self._char_list.currentRowChanged.connect(self._on_char_select)
        ll.addWidget(self._char_list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        dl = QVBoxLayout(detail)
        f = QFormLayout()
        self._ch_id = QLineEdit(); f.addRow("id", self._ch_id)
        self._ch_name = QLineEdit(); f.addRow("name", self._ch_name)
        self._ch_title = QLineEdit(); f.addRow("title", self._ch_title)
        dl.addLayout(f)
        self._ch_unlock = ConditionEditor("unlockConditions")
        dl.addWidget(self._ch_unlock)

        dl.addWidget(QLabel("<b>Impressions</b>"))
        self._ch_imp_layout = QVBoxLayout()
        dl.addLayout(self._ch_imp_layout)
        add_imp = QPushButton("+ Impression"); add_imp.clicked.connect(self._add_impression)
        dl.addWidget(add_imp)

        dl.addWidget(QLabel("<b>Known Info</b>"))
        self._ch_ki_layout = QVBoxLayout()
        dl.addLayout(self._ch_ki_layout)
        add_ki = QPushButton("+ Known Info"); add_ki.clicked.connect(self._add_known_info)
        dl.addWidget(add_ki)

        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply_char)
        dl.addWidget(apply_btn)
        dl.addStretch()
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 550])
        lay.addWidget(splitter)
        self._char_idx = -1
        self._imp_widgets: list[_CondTextGroup] = []
        self._ki_widgets: list[_CondTextGroup] = []
        self._refresh_chars()
        return w

    def _refresh_chars(self) -> None:
        self._char_list.clear()
        for ch in self._model.archive_characters:
            self._char_list.addItem(f"{ch.get('id', '?')}  [{ch.get('name', '')}]")

    def _on_char_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.archive_characters):
            return
        self._char_idx = row
        ch = self._model.archive_characters[row]
        self._ch_id.setText(ch.get("id", ""))
        self._ch_name.setText(ch.get("name", ""))
        self._ch_title.setText(ch.get("title", ""))
        self._ch_unlock.set_flag_pattern_context(self._model, None)
        self._ch_unlock.set_data(ch.get("unlockConditions", []))
        self._rebuild_cond_text_list(self._ch_imp_layout, self._imp_widgets,
                                      ch.get("impressions", []), "Impression")
        self._rebuild_cond_text_list(self._ch_ki_layout, self._ki_widgets,
                                      ch.get("knownInfo", []), "Info")

    def _rebuild_cond_text_list(self, layout, widgets, items, prefix):
        for w in widgets:
            layout.removeWidget(w)
            w.deleteLater()
        widgets.clear()
        for i, item in enumerate(items):
            g = _CondTextGroup(f"{prefix} {i + 1}", item, self._model)
            widgets.append(g)
            layout.addWidget(g)

    def _add_impression(self) -> None:
        g = _CondTextGroup(f"Impression {len(self._imp_widgets) + 1}",
                           {"conditions": [], "text": ""}, self._model)
        self._imp_widgets.append(g)
        self._ch_imp_layout.addWidget(g)

    def _add_known_info(self) -> None:
        g = _CondTextGroup(f"Info {len(self._ki_widgets) + 1}",
                           {"conditions": [], "text": ""}, self._model)
        self._ki_widgets.append(g)
        self._ch_ki_layout.addWidget(g)

    def _apply_char(self) -> None:
        if self._char_idx < 0:
            return
        ch = self._model.archive_characters[self._char_idx]
        ch["id"] = self._ch_id.text().strip()
        ch["name"] = self._ch_name.text()
        ch["title"] = self._ch_title.text()
        ch["unlockConditions"] = self._ch_unlock.to_list()
        ch["impressions"] = [w.to_dict() for w in self._imp_widgets]
        ch["knownInfo"] = [w.to_dict() for w in self._ki_widgets]
        self._model.mark_dirty("archive")
        self._refresh_chars()

    def _add_char(self) -> None:
        self._model.archive_characters.append({
            "id": f"char_{len(self._model.archive_characters)}", "name": "New",
            "title": "", "impressions": [], "knownInfo": [], "unlockConditions": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_chars()

    def _del_char(self) -> None:
        if self._char_idx >= 0:
            self._model.archive_characters.pop(self._char_idx)
            self._char_idx = -1
            self._model.mark_dirty("archive")
            self._refresh_chars()

    # ---- Lore -------------------------------------------------------------

    def _build_lore_tab(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Lore"); btn_add.clicked.connect(self._add_lore)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_lore)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._lore_list = QListWidget()
        self._lore_list.currentRowChanged.connect(self._on_lore_select)
        ll.addWidget(self._lore_list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        f = QFormLayout(detail)
        self._lo_id = QLineEdit(); f.addRow("id", self._lo_id)
        self._lo_title = QLineEdit(); f.addRow("title", self._lo_title)
        self._lo_content = QTextEdit(); self._lo_content.setMaximumHeight(100)
        f.addRow("content", self._lo_content)
        self._lo_source = QLineEdit(); f.addRow("source", self._lo_source)
        self._lo_cat = QComboBox()
        self._lo_cat.addItems(["legend", "geography", "folklore", "affairs"])
        f.addRow("category", self._lo_cat)
        self._lo_cond = ConditionEditor("unlockConditions")
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply_lore)

        right = QWidget()
        rl = QVBoxLayout(right)
        rl.addWidget(scroll)
        scroll.setWidget(detail)
        rl.addWidget(self._lo_cond)
        rl.addWidget(apply_btn)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([220, 550])
        lay.addWidget(splitter)
        self._lore_idx = -1
        self._refresh_lore()
        return w

    def _lore_entries(self) -> list[dict]:
        d = self._model.archive_lore
        if isinstance(d, dict):
            return d.setdefault("entries", [])
        return d if isinstance(d, list) else []

    def _refresh_lore(self) -> None:
        self._lore_list.clear()
        for e in self._lore_entries():
            self._lore_list.addItem(f"{e.get('id', '?')}  [{e.get('title', '')}]")

    def _on_lore_select(self, row: int) -> None:
        entries = self._lore_entries()
        if row < 0 or row >= len(entries):
            return
        self._lore_idx = row
        e = entries[row]
        self._lo_id.setText(e.get("id", ""))
        self._lo_title.setText(e.get("title", ""))
        self._lo_content.setPlainText(e.get("content", ""))
        self._lo_source.setText(e.get("source", ""))
        self._lo_cat.setCurrentText(e.get("category", "legend"))
        self._lo_cond.set_flag_pattern_context(self._model, None)
        self._lo_cond.set_data(e.get("unlockConditions", []))

    def _apply_lore(self) -> None:
        entries = self._lore_entries()
        if self._lore_idx < 0 or self._lore_idx >= len(entries):
            return
        e = entries[self._lore_idx]
        e["id"] = self._lo_id.text().strip()
        e["title"] = self._lo_title.text()
        e["content"] = self._lo_content.toPlainText()
        e["source"] = self._lo_source.text()
        e["category"] = self._lo_cat.currentText()
        e["unlockConditions"] = self._lo_cond.to_list()
        self._model.mark_dirty("archive")
        self._refresh_lore()

    def _add_lore(self) -> None:
        entries = self._lore_entries()
        entries.append({
            "id": f"lore_{len(entries)}", "title": "", "content": "",
            "source": "", "category": "legend", "unlockConditions": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_lore()

    def _del_lore(self) -> None:
        entries = self._lore_entries()
        if 0 <= self._lore_idx < len(entries):
            entries.pop(self._lore_idx)
            self._lore_idx = -1
            self._model.mark_dirty("archive")
            self._refresh_lore()

    # ---- Documents --------------------------------------------------------

    def _build_documents_tab(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Document"); btn_add.clicked.connect(self._add_doc)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_doc)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._doc_list = QListWidget()
        self._doc_list.currentRowChanged.connect(self._on_doc_select)
        ll.addWidget(self._doc_list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        dl = QVBoxLayout(detail)
        f = QFormLayout()
        self._doc_id = QLineEdit(); f.addRow("id", self._doc_id)
        self._doc_name = QLineEdit(); f.addRow("name", self._doc_name)
        self._doc_content = QTextEdit(); self._doc_content.setMaximumHeight(120)
        f.addRow("content", self._doc_content)
        self._doc_annot = QTextEdit(); self._doc_annot.setMaximumHeight(60)
        f.addRow("annotation", self._doc_annot)
        dl.addLayout(f)
        self._doc_cond = ConditionEditor("discoverConditions")
        dl.addWidget(self._doc_cond)
        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply_doc)
        dl.addWidget(apply_btn)
        dl.addStretch()
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 550])
        lay.addWidget(splitter)
        self._doc_idx = -1
        self._refresh_docs()
        return w

    def _refresh_docs(self) -> None:
        self._doc_list.clear()
        for d in self._model.archive_documents:
            self._doc_list.addItem(f"{d.get('id', '?')}  [{d.get('name', '')}]")

    def _on_doc_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.archive_documents):
            return
        self._doc_idx = row
        d = self._model.archive_documents[row]
        self._doc_id.setText(d.get("id", ""))
        self._doc_name.setText(d.get("name", ""))
        self._doc_content.setPlainText(d.get("content", ""))
        self._doc_annot.setPlainText(d.get("annotation", ""))
        self._doc_cond.set_flag_pattern_context(self._model, None)
        self._doc_cond.set_data(d.get("discoverConditions", []))

    def _apply_doc(self) -> None:
        if self._doc_idx < 0:
            return
        d = self._model.archive_documents[self._doc_idx]
        d["id"] = self._doc_id.text().strip()
        d["name"] = self._doc_name.text()
        d["content"] = self._doc_content.toPlainText()
        annot = self._doc_annot.toPlainText()
        if annot:
            d["annotation"] = annot
        elif "annotation" in d:
            del d["annotation"]
        d["discoverConditions"] = self._doc_cond.to_list()
        self._model.mark_dirty("archive")
        self._refresh_docs()

    def _add_doc(self) -> None:
        self._model.archive_documents.append({
            "id": f"doc_{len(self._model.archive_documents)}", "name": "",
            "content": "", "discoverConditions": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_docs()

    def _del_doc(self) -> None:
        if self._doc_idx >= 0:
            self._model.archive_documents.pop(self._doc_idx)
            self._doc_idx = -1
            self._model.mark_dirty("archive")
            self._refresh_docs()

    # ---- Books ------------------------------------------------------------

    def _build_books_tab(self) -> QWidget:
        w = QWidget()
        lay = QHBoxLayout(w)
        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        ll = QVBoxLayout(left); ll.setContentsMargins(0, 0, 0, 0)
        btn_row = QHBoxLayout()
        btn_add = QPushButton("+ Book"); btn_add.clicked.connect(self._add_book)
        btn_del = QPushButton("Delete"); btn_del.clicked.connect(self._del_book)
        btn_row.addWidget(btn_add); btn_row.addWidget(btn_del)
        ll.addLayout(btn_row)
        self._book_list = QListWidget()
        self._book_list.currentRowChanged.connect(self._on_book_select)
        ll.addWidget(self._book_list)

        scroll = QScrollArea(); scroll.setWidgetResizable(True)
        detail = QWidget()
        dl = QVBoxLayout(detail)
        f = QFormLayout()
        self._bk_id = QLineEdit(); f.addRow("id", self._bk_id)
        self._bk_title = QLineEdit(); f.addRow("title", self._bk_title)
        self._bk_pages_spin = QSpinBox(); self._bk_pages_spin.setRange(0, 99)
        f.addRow("totalPages", self._bk_pages_spin)
        dl.addLayout(f)
        dl.addWidget(QLabel("<b>Pages</b>"))
        self._page_list = QListWidget()
        self._page_list.currentRowChanged.connect(self._on_page_select)
        dl.addWidget(self._page_list)
        page_btns = QHBoxLayout()
        add_pg = QPushButton("+ Page"); add_pg.clicked.connect(self._add_page)
        page_btns.addWidget(add_pg)
        dl.addLayout(page_btns)

        pf = QFormLayout()
        self._pg_title = QLineEdit(); pf.addRow("title", self._pg_title)
        self._pg_content = QTextEdit(); self._pg_content.setMaximumHeight(100)
        pf.addRow("content", self._pg_content)
        self._pg_illust = QLineEdit(); pf.addRow("illustration", self._pg_illust)
        dl.addLayout(pf)
        self._pg_cond = ConditionEditor("unlockConditions")
        dl.addWidget(self._pg_cond)

        apply_btn = QPushButton("Apply"); apply_btn.clicked.connect(self._apply_book)
        dl.addWidget(apply_btn)
        dl.addStretch()
        scroll.setWidget(detail)

        splitter.addWidget(left)
        splitter.addWidget(scroll)
        splitter.setSizes([220, 550])
        lay.addWidget(splitter)
        self._book_idx = -1
        self._page_idx = -1
        self._refresh_books()
        return w

    def _refresh_books(self) -> None:
        self._book_list.clear()
        for b in self._model.archive_books:
            self._book_list.addItem(f"{b.get('id', '?')}  [{b.get('title', '')}]")

    def _on_book_select(self, row: int) -> None:
        if row < 0 or row >= len(self._model.archive_books):
            return
        self._book_idx = row
        b = self._model.archive_books[row]
        self._bk_id.setText(b.get("id", ""))
        self._bk_title.setText(b.get("title", ""))
        self._bk_pages_spin.setValue(b.get("totalPages", 0))
        self._page_list.clear()
        for pg in b.get("pages", []):
            self._page_list.addItem(f"Page {pg.get('pageNum', '?')}: {pg.get('title', '')}")

    def _on_page_select(self, row: int) -> None:
        if self._book_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].get("pages", [])
        if row < 0 or row >= len(pages):
            return
        self._page_idx = row
        pg = pages[row]
        self._pg_title.setText(pg.get("title", ""))
        self._pg_content.setPlainText(pg.get("content", ""))
        self._pg_illust.setText(pg.get("illustration", ""))
        self._pg_cond.set_flag_pattern_context(self._model, None)
        self._pg_cond.set_data(pg.get("unlockConditions", []))

    def _add_page(self) -> None:
        if self._book_idx < 0:
            return
        pages = self._model.archive_books[self._book_idx].setdefault("pages", [])
        pages.append({"pageNum": len(pages) + 1, "content": "", "unlockConditions": []})
        self._on_book_select(self._book_idx)

    def _apply_book(self) -> None:
        if self._book_idx < 0:
            return
        b = self._model.archive_books[self._book_idx]
        b["id"] = self._bk_id.text().strip()
        b["title"] = self._bk_title.text()
        b["totalPages"] = self._bk_pages_spin.value()
        if self._page_idx >= 0:
            pages = b.get("pages", [])
            if self._page_idx < len(pages):
                pg = pages[self._page_idx]
                pg["title"] = self._pg_title.text() or None
                if pg["title"] is None:
                    pg.pop("title", None)
                pg["content"] = self._pg_content.toPlainText()
                ill = self._pg_illust.text().strip()
                if ill:
                    pg["illustration"] = ill
                elif "illustration" in pg:
                    del pg["illustration"]
                pg["unlockConditions"] = self._pg_cond.to_list()
        self._model.mark_dirty("archive")
        self._refresh_books()

    def _add_book(self) -> None:
        self._model.archive_books.append({
            "id": f"book_{len(self._model.archive_books)}", "title": "",
            "totalPages": 0, "pages": [],
        })
        self._model.mark_dirty("archive")
        self._refresh_books()

    def _del_book(self) -> None:
        if self._book_idx >= 0:
            self._model.archive_books.pop(self._book_idx)
            self._book_idx = -1
            self._model.mark_dirty("archive")
            self._refresh_books()
