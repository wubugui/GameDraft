"""LLM 提供方配置表单：读写 run 的 llm_config_json，保留非标准键。"""
from __future__ import annotations

import copy
from typing import Any

from PySide6.QtCore import QSize, Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPushButton,
    QSpinBox,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim_v2.gui.layout_compact import tighten, tighten_form

_AGENT_STANDARD_KEYS = frozenset(
    {
        "kind",
        "base_url",
        "api_key",
        "model",
        "ollama_host",
        "embed_model",
        "embedding_model",
        "max_distortion_llm_calls_per_week",
        "override",
    }
)
_EMB_STANDARD_KEYS = frozenset({"kind", "base_url", "api_key", "model", "ollama_host"})
_SEM_STANDARD_KEYS = frozenset({"strict"})

_AGENT_ENTRIES: list[tuple[str, str]] = [
    ("default", "默认（未单独配置的 agent）"),
    ("tier_s_npc", "NPC Tier S"),
    ("tier_a_npc", "NPC Tier A（重要配角）"),
    ("tier_b_npc", "NPC Tier B/C（龙套群体）"),
    ("gm", "GM 世界"),
    ("director", "编年史导演"),
    ("rumor", "谣言"),
    ("week_summarizer", "周总结"),
    ("month_historian", "月史"),
    ("style_rewriter", "风格重写"),
    ("probe", "探针问答"),
    ("initializer", "种子抽取"),
]


def agent_llm_config_keys() -> tuple[str, ...]:
    """供保存前校验迭代各 agent 配置块。"""
    return tuple(k for k, _ in _AGENT_ENTRIES)


KNOWN_TOP_LEVEL = frozenset(
    {"embeddings", "semantic_memory", "llm_audit", "trace", *(k for k, _ in _AGENT_ENTRIES)},
)


def _kind_index(combo: QComboBox, kind: str) -> None:
    k = (kind or "stub").lower()
    for i in range(combo.count()):
        if combo.itemData(i) == k:
            combo.setCurrentIndex(i)
            return
    combo.setCurrentIndex(0)


class _ProfileRefs:
    __slots__ = ("kind", "host", "base", "key", "model")

    def __init__(
        self,
        kind: QComboBox,
        host: QLineEdit,
        base: QLineEdit,
        key: QLineEdit,
        model: QLineEdit,
    ) -> None:
        self.kind = kind
        self.host = host
        self.base = base
        self.key = key
        self.model = model


class LlmConfigForm(QWidget):
    agent_connection_test_requested = Signal(str)
    embedding_test_requested = Signal()  # 测试嵌入模型连接
    changed = Signal()  # 任何字段修改时发射

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._unknown_top: dict[str, Any] = {}
        self._agent_extras: dict[str, dict[str, Any]] = {k: {} for k, _ in _AGENT_ENTRIES}
        self._emb_extra: dict[str, Any] = {}
        self._sem_extra: dict[str, Any] = {}
        self._override_by_key: dict[str, QCheckBox] = {}
        self._agent_form_layouts: dict[str, QFormLayout] = {}
        self._in_set = False  # set_from_dict 期间忽略 changed

        root = QVBoxLayout(self)
        root.setContentsMargins(0, 0, 0, 0)
        tighten(root, margins=(0, 0, 0, 0), spacing=4)
        self.setToolTip(
            "API Key、Base URL 等保存在当前 run 数据库，不从环境变量读取。\n"
            "代理仅在「配置 → 代理」填写后生效；本软件不读系统代理。\n"
            "除「默认」外各槽可勾选「覆盖默认」才使用本页连接，否则与「默认」相同。\n"
            "Tier S 选「NPC Tier S」；Tier A 与 B 共用「NPC Tier A+B」（B 仅提示词更短）。"
        )

        top = QGroupBox("嵌入（语义记忆向量）")
        top.setToolTip("关闭时按 NPC/默认对话配置推导嵌入模型与地址。")
        top_lay = QFormLayout(top)
        tighten_form(top_lay, vertical=4, horizontal=8)
        self._emb_kind = QComboBox()
        self._emb_kind.addItem("关闭（从对话配置推导）", "")
        self._emb_kind.addItem("Ollama", "ollama")
        self._emb_kind.addItem("OpenAI 兼容 API", "openai_compat")
        self._emb_host = QLineEdit()
        self._emb_host.setPlaceholderText("http://127.0.0.1:11434")
        self._emb_base = QLineEdit()
        self._emb_base.setPlaceholderText("https://api.openai.com/v1")
        self._emb_key = QLineEdit()
        self._emb_key.setEchoMode(QLineEdit.EchoMode.Password)
        self._emb_key.setPlaceholderText("API Key（可选，视网关而定）")
        self._emb_model = QLineEdit()
        self._emb_model.setPlaceholderText("如 nomic-embed-text / text-embedding-3-small")
        top_lay.addRow("方式", self._emb_kind)
        top_lay.addRow("Ollama 地址", self._emb_host)
        top_lay.addRow("API Base URL", self._emb_base)
        top_lay.addRow("API Key", self._emb_key)
        top_lay.addRow("嵌入模型名", self._emb_model)
        self._emb_test_btn = QPushButton("测试嵌入")
        self._emb_test_btn.setToolTip("向当前配置的嵌入模型发一条请求，验证是否可用。")
        self._emb_test_btn.clicked.connect(lambda _=False: self.embedding_test_requested.emit())
        top_lay.addRow("", self._emb_test_btn)
        root.addWidget(top)

        sem_box = QGroupBox("语义记忆")
        sem_lay = QHBoxLayout(sem_box)
        self._strict = QCheckBox("strict：无可用嵌入则推进周次前直接报错")
        self._strict.setToolTip("开启后会在运行周次前探测嵌入接口；失败则中止，避免静默退回仅时间序记忆。")
        sem_lay.addWidget(self._strict)
        sem_lay.addStretch(1)
        root.addWidget(sem_box)

        audit_box = QGroupBox("LLM 审计")
        audit_box.setToolTip("启用后，每次非 Stub 对话请求会在 run 目录下 llm_audit/ 追加 JSONL（内容已脱敏与截断）。")
        audit_lay = QHBoxLayout(audit_box)
        self._llm_audit_enabled = QCheckBox("启用审计日志（llm_audit/）")
        self._llm_audit_enabled.setToolTip("与「保存 LLM 到 run」一并写入 llm_config_json；仅真实请求会落盘。")
        audit_lay.addWidget(self._llm_audit_enabled)
        audit_lay.addStretch(1)
        root.addWidget(audit_box)

        trace_box = QGroupBox("调试追踪（stderr / 活动日志）")
        trace_box.setToolTip(
            "写入 llm_config_json.trace，随当前 run 保存，不使用环境变量。\n"
            "勾选「输出 new/all messages JSON」会打印 Crew 任务与原始输出等调试信息，日志可能很长。"
        )
        trace_lay = QFormLayout(trace_box)
        tighten_form(trace_lay, vertical=4, horizontal=8)
        self._trace_full_messages = QCheckBox("输出 new_messages / all_messages 大段 JSON")
        self._trace_full_messages.setChecked(True)
        self._trace_full_messages.setToolTip("对应 trace.full_messages_json；关闭后仅保留简短 [chat·in] / [chat·out]。")
        self._trace_max_chars = QSpinBox()
        self._trace_max_chars.setRange(4096, 9_999_999)
        self._trace_max_chars.setValue(800_000)
        self._trace_max_chars.setSingleStep(10_000)
        self._trace_max_chars.setToolTip("trace.max_chars：单条 trace 字符串上限（防刷屏）。")
        self._trace_full_user_prompt = QCheckBox("[chat·in] 打印完整 user_prompt（仍受 max_chars 截断）")
        self._trace_full_user_prompt.setChecked(False)
        self._trace_full_user_prompt.setToolTip("trace.full_user_prompt；种子抽取等长输入慎用。")
        trace_lay.addRow(self._trace_full_messages)
        trace_lay.addRow("单条 trace 最大字符数", self._trace_max_chars)
        trace_lay.addRow(self._trace_full_user_prompt)
        root.addWidget(trace_box)

        mid = QHBoxLayout()
        self._agent_list = QListWidget()
        self._agent_list.setMaximumWidth(200)
        self._stack = QStackedWidget()
        self._refs_by_key: dict[str, _ProfileRefs] = {}
        for key, label in _AGENT_ENTRIES:
            item = QListWidgetItem(label)
            if key == "tier_s_npc":
                item.setToolTip(
                    "仅数据库中 current_tier=S 的 NPC 使用本页配置（llm_config.tier_s_npc）。"
                )
            elif key == "tier_a_npc":
                item.setToolTip(
                    "仅 current_tier=A 的 NPC 使用本页配置（llm_config.tier_a_npc）。"
                )
            elif key == "tier_b_npc":
                item.setToolTip(
                    "current_tier=B/C 的龙套群体使用本页配置（llm_config.tier_b_npc）。\n"
                    "B 类使用独立的 system prompt（npc_tier_b.md），与 A 类提示词不同。"
                )
            self._agent_list.addItem(item)
            page, refs, form_lay = self._make_agent_page(key)
            self._stack.addWidget(page)
            self._refs_by_key[key] = refs
            self._agent_form_layouts[key] = form_lay
        self._agent_list.currentRowChanged.connect(self._stack.setCurrentIndex)
        mid.addWidget(self._agent_list)
        mid.addWidget(self._stack, 1)
        root.addLayout(mid, 1)

        rumor_lay = self._agent_form_layouts["rumor"]
        self._rumor_distort_cap = QSpinBox()
        self._rumor_distort_cap.setRange(0, 99999)
        self._rumor_distort_cap.setValue(64)
        self._rumor_distort_cap.setToolTip(
            "每推进一周，传闻改写最多调用 LLM 的次数；超出则用启发式缩短句。\n"
            "0 表示不限制。"
        )
        rumor_lay.addRow("传闻改写 LLM 周上限（0=不限制）", self._rumor_distort_cap)

        self._agent_list.setCurrentRow(0)
        self._apply_emb_kind_visibility()
        self._emb_kind.currentIndexChanged.connect(lambda _i: self._apply_emb_kind_visibility())
        self._apply_all_agent_page_states()
        self._wire_change_signals()

    def _wire_change_signals(self) -> None:
        """将所有表单字段连接到 changed 信号。"""
        for w in (
            self._emb_kind, self._emb_host, self._emb_base,
            self._emb_key, self._emb_model,
            self._strict,
            self._llm_audit_enabled,
            self._trace_full_messages, self._trace_max_chars, self._trace_full_user_prompt,
            self._rumor_distort_cap,
        ):
            if isinstance(w, QComboBox):
                w.currentIndexChanged.connect(self._emit_changed)
            elif isinstance(w, QLineEdit):
                w.textChanged.connect(self._emit_changed)
            elif isinstance(w, QCheckBox):
                w.toggled.connect(self._emit_changed)
            elif isinstance(w, QSpinBox):
                w.valueChanged.connect(self._emit_changed)
        # 覆盖默认复选框
        for ov in self._override_by_key.values():
            ov.toggled.connect(self._emit_changed)
        # 各 Agent 槽位字段
        for refs in self._refs_by_key.values():
            refs.kind.currentIndexChanged.connect(self._emit_changed)
            refs.host.textChanged.connect(self._emit_changed)
            refs.base.textChanged.connect(self._emit_changed)
            refs.key.textChanged.connect(self._emit_changed)
            refs.model.textChanged.connect(self._emit_changed)

    def _emit_changed(self) -> None:
        if not self._in_set:
            self.changed.emit()

    def _make_agent_page(self, slot_key: str) -> tuple[QWidget, _ProfileRefs, QFormLayout]:
        w = QWidget()
        outer = QVBoxLayout(w)
        tighten(outer, margins=(0, 0, 0, 0), spacing=4)

        top_row = QHBoxLayout()
        if slot_key == "default":
            hint = QLabel("此项为全局默认连接；其它槽位未勾选「覆盖默认」时使用此处。")
            hint.setWordWrap(True)
            hint.setStyleSheet("color: palette(mid);")
            top_row.addWidget(hint, 1)
        else:
            ov = QCheckBox("覆盖默认（勾选后才使用本页连接，否则与「默认」相同）")
            ov.setToolTip(
                "不勾选：运行时该 agent 使用「默认」槽的连接与模型。\n"
                "勾选：使用本页单独设置的提供方、地址与模型。"
            )
            ov.toggled.connect(lambda _c, sk=slot_key: self._apply_agent_page_enabled_state(sk))
            top_row.addWidget(ov, 1)
            self._override_by_key[slot_key] = ov
        btn = QPushButton("测试本槽连接")
        btn.setToolTip("按「覆盖默认」规则向本槽实际使用的对话端发一条 hi（与底部「测试推理」相同机制）。")
        btn.clicked.connect(lambda _=False, sk=slot_key: self.agent_connection_test_requested.emit(sk))
        top_row.addWidget(btn)
        outer.addLayout(top_row)

        form_host = QWidget()
        lay = QFormLayout(form_host)
        tighten_form(lay, vertical=4, horizontal=8)
        kind = QComboBox()
        kind.addItem("Stub（离线占位）", "stub")
        kind.addItem("Ollama", "ollama")
        kind.addItem("OpenAI 兼容 API", "openai_compat")
        host = QLineEdit()
        host.setPlaceholderText("http://127.0.0.1:11434")
        base = QLineEdit()
        base.setPlaceholderText("https://api.openai.com/v1")
        api_key_edit = QLineEdit()
        api_key_edit.setEchoMode(QLineEdit.EchoMode.Password)
        api_key_edit.setPlaceholderText("Bearer Token / API Key")
        model = QLineEdit()
        model.setPlaceholderText("对话模型 id")
        lay.addRow("提供方", kind)
        lay.addRow("Ollama 地址", host)
        lay.addRow("API Base URL", base)
        lay.addRow("API Key", api_key_edit)
        lay.addRow("模型名", model)
        outer.addWidget(form_host)

        refs = _ProfileRefs(kind, host, base, api_key_edit, model)
        kind.currentIndexChanged.connect(lambda _i, sk=slot_key: self._on_agent_kind_changed(sk))
        return w, refs, lay

    def _apply_all_agent_page_states(self) -> None:
        for k in self._refs_by_key:
            self._apply_agent_page_enabled_state(k)

    def _apply_agent_page_enabled_state(self, slot_key: str) -> None:
        refs = self._refs_by_key[slot_key]
        ovb = self._override_by_key.get(slot_key)
        if ovb is None:
            refs.kind.setEnabled(True)
            refs.model.setEnabled(True)
            self._apply_agent_kind_visibility(refs)
            return
        en = ovb.isChecked()
        refs.kind.setEnabled(en)
        refs.model.setEnabled(en)
        if en:
            self._apply_agent_kind_visibility(refs)
        else:
            refs.host.setEnabled(False)
            refs.base.setEnabled(False)
            refs.key.setEnabled(False)

    def _on_agent_kind_changed(self, slot_key: str) -> None:
        ovb = self._override_by_key.get(slot_key)
        if ovb is None or ovb.isChecked():
            self._apply_agent_kind_visibility(self._refs_by_key[slot_key])

    def _apply_emb_kind_visibility(self) -> None:
        k = self._emb_kind.currentData()
        is_ollama = k == "ollama"
        is_openai = k == "openai_compat"
        self._emb_host.setEnabled(is_ollama)
        self._emb_base.setEnabled(is_openai)
        self._emb_key.setEnabled(is_openai)
        self._emb_model.setEnabled(bool(k))
        self._emb_test_btn.setEnabled(bool(k))

    def _apply_agent_kind_visibility(self, refs: _ProfileRefs) -> None:
        k = refs.kind.currentData()
        is_ollama = k == "ollama"
        is_openai = k == "openai_compat"
        refs.host.setEnabled(is_ollama)
        refs.base.setEnabled(is_openai)
        refs.key.setEnabled(is_openai)
        refs.model.setEnabled(True)

    def _apply_block_to_refs(self, refs: _ProfileRefs, block: dict[str, Any]) -> None:
        _kind_index(refs.kind, str(block.get("kind", "stub")))
        refs.host.setText(str(block.get("ollama_host", "")))
        refs.base.setText(str(block.get("base_url", "")))
        refs.key.setText(str(block.get("api_key", "")))
        refs.model.setText(str(block.get("model", "")))
        self._apply_agent_kind_visibility(refs)

    def _refs_to_block(self, refs: _ProfileRefs) -> dict[str, Any]:
        kind = str(refs.kind.currentData() or "stub")
        if kind == "ollama":
            return {
                "kind": "ollama",
                "ollama_host": refs.host.text().strip() or "http://127.0.0.1:11434",
                "model": refs.model.text().strip() or "llama3",
            }
        if kind == "openai_compat":
            return {
                "kind": "openai_compat",
                "base_url": refs.base.text().strip() or "https://api.openai.com/v1",
                "api_key": refs.key.text().strip(),
                "model": refs.model.text().strip() or "gpt-4o-mini",
            }
        return {"kind": "stub", "model": refs.model.text().strip() or "stub"}

    def set_from_dict(self, data: dict[str, Any] | None) -> None:
        self._in_set = True
        try:
            self._set_from_dict_impl(data)
        finally:
            self._in_set = False

    def _set_from_dict_impl(self, data: dict[str, Any] | None) -> None:
        d = copy.deepcopy(data) if data else {}
        self._unknown_top = {k: copy.deepcopy(v) for k, v in d.items() if k not in KNOWN_TOP_LEVEL}

        emb = d.get("embeddings")
        if isinstance(emb, dict) and str(emb.get("kind", "")).strip():
            ek = str(emb["kind"]).lower()
            if ek in ("none", "off", "disabled"):
                self._emb_kind.setCurrentIndex(0)
                self._emb_host.clear()
                self._emb_base.clear()
                self._emb_key.clear()
                self._emb_model.clear()
                self._emb_extra = {}
            else:
                _kind_index(self._emb_kind, ek)
                self._emb_host.setText(str(emb.get("ollama_host", "")))
                self._emb_base.setText(str(emb.get("base_url", "")))
                self._emb_key.setText(str(emb.get("api_key", "")))
                self._emb_model.setText(str(emb.get("model", "")))
                self._emb_extra = {k: copy.deepcopy(v) for k, v in emb.items() if k not in _EMB_STANDARD_KEYS}
        else:
            self._emb_kind.setCurrentIndex(0)
            self._emb_host.clear()
            self._emb_base.clear()
            self._emb_key.clear()
            self._emb_model.clear()
            self._emb_extra = {}

        sem = d.get("semantic_memory")
        if isinstance(sem, dict):
            self._strict.setChecked(bool(sem.get("strict")))
            self._sem_extra = {k: copy.deepcopy(v) for k, v in sem.items() if k not in _SEM_STANDARD_KEYS}
        else:
            self._strict.setChecked(False)
            self._sem_extra = {}

        la = d.get("llm_audit")
        if isinstance(la, dict):
            self._llm_audit_enabled.setChecked(bool(la.get("enabled")))
        else:
            self._llm_audit_enabled.setChecked(False)

        tr = d.get("trace")
        if isinstance(tr, dict):
            self._trace_full_messages.setChecked(bool(tr.get("full_messages_json", True)))
            try:
                self._trace_max_chars.setValue(
                    max(4096, min(9_999_999, int(tr.get("max_chars", 800_000))))
                )
            except (TypeError, ValueError):
                self._trace_max_chars.setValue(800_000)
            self._trace_full_user_prompt.setChecked(bool(tr.get("full_user_prompt", False)))
        else:
            self._trace_full_messages.setChecked(True)
            self._trace_max_chars.setValue(800_000)
            self._trace_full_user_prompt.setChecked(False)

        for key, _label in _AGENT_ENTRIES:
            block = d.get(key)
            refs = self._refs_by_key[key]
            ovb = self._override_by_key.get(key)
            if isinstance(block, dict):
                self._agent_extras[key] = {
                    k: copy.deepcopy(v) for k, v in block.items() if k not in _AGENT_STANDARD_KEYS
                }
                self._apply_block_to_refs(refs, block)
                if ovb is not None:
                    ov_raw = block.get("override")
                    if ov_raw is None:
                        raw_kind = str(block.get("kind", "stub")).strip().lower()
                        ovb.setChecked(raw_kind not in ("", "stub"))
                    else:
                        ovb.setChecked(bool(ov_raw))
            else:
                self._agent_extras[key] = {}
                self._apply_block_to_refs(refs, {})
                if ovb is not None:
                    ovb.setChecked(False)

        rb = d.get("rumor")
        if isinstance(rb, dict) and "max_distortion_llm_calls_per_week" in rb:
            try:
                self._rumor_distort_cap.setValue(
                    max(0, min(99999, int(rb["max_distortion_llm_calls_per_week"])))
                )
            except (TypeError, ValueError):
                self._rumor_distort_cap.setValue(64)
        else:
            self._rumor_distort_cap.setValue(64)

        self._apply_emb_kind_visibility()
        self._apply_all_agent_page_states()

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = copy.deepcopy(self._unknown_top)

        ek = self._emb_kind.currentData()
        if ek:
            emb: dict[str, Any] = {**copy.deepcopy(self._emb_extra)}
            if ek == "ollama":
                emb.update(
                    {
                        "kind": "ollama",
                        "ollama_host": self._emb_host.text().strip() or "http://127.0.0.1:11434",
                        "model": self._emb_model.text().strip() or "nomic-embed-text",
                    }
                )
            elif ek == "openai_compat":
                emb.update(
                    {
                        "kind": "openai_compat",
                        "base_url": self._emb_base.text().strip() or "https://api.openai.com/v1",
                        "api_key": self._emb_key.text().strip(),
                        "model": self._emb_model.text().strip() or "text-embedding-3-small",
                    }
                )
            out["embeddings"] = emb

        sem: dict[str, Any] = {**copy.deepcopy(self._sem_extra), "strict": self._strict.isChecked()}
        out["semantic_memory"] = sem

        out["llm_audit"] = {"enabled": bool(self._llm_audit_enabled.isChecked())}

        out["trace"] = {
            "full_messages_json": bool(self._trace_full_messages.isChecked()),
            "max_chars": int(self._trace_max_chars.value()),
            "full_user_prompt": bool(self._trace_full_user_prompt.isChecked()),
        }

        for key, _label in _AGENT_ENTRIES:
            refs = self._refs_by_key[key]
            block = {**copy.deepcopy(self._agent_extras[key]), **self._refs_to_block(refs)}
            if key != "default":
                ovb = self._override_by_key.get(key)
                if ovb is not None:
                    block["override"] = ovb.isChecked()
            if key == "rumor":
                block["max_distortion_llm_calls_per_week"] = int(self._rumor_distort_cap.value())
            out[key] = block

        return out

    def selected_agent_config_key(self) -> str:
        """左侧列表当前选中的 llm_config 键（如 tier_s_npc、probe）。"""
        i = self._agent_list.currentRow()
        if i < 0 or i >= len(_AGENT_ENTRIES):
            return "default"
        return _AGENT_ENTRIES[i][0]

    def sizeHint(self) -> QSize:
        return QSize(560, 380)
