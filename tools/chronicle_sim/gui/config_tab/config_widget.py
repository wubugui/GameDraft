from __future__ import annotations

import asyncio
import copy
import json
import os
import sys
import threading
from datetime import datetime
from pathlib import Path
from collections.abc import Awaitable, Callable
from typing import Any

from PySide6.QtCore import Qt, QThreadPool, Signal
from PySide6.QtGui import QFont
import shutil

from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMessageBox,
    QPlainTextEdit,
    QProgressDialog,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from tools.chronicle_sim.core.agents.initializer_agent import InitializerAgent
from tools.chronicle_sim.core.llm.client_factory import ClientFactory
from tools.chronicle_sim.core.llm.config_resolve import (
    embedding_profile_explicit_only,
    embedding_profile_from_config,
    provider_profile_for_agent,
)
from tools.chronicle_sim.core.llm.private_defaults import (
    load_private_llm_defaults,
    private_llm_defaults_file,
)
from tools.chronicle_sim.gui.config_tab.llm_config_form import LlmConfigForm, agent_llm_config_keys
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore
from tools.chronicle_sim.core.schema.models import NpcTier, SeedDraft
from tools.chronicle_sim.core.simulation.run_manager import (
    create_run,
    delete_run_dir,
    list_runs,
    open_database,
)
from tools.chronicle_sim.core.simulation.seed_apply import (
    apply_seed_draft,
    set_agent_current_tier,
    set_agent_tier,
)
import sqlite3

from tools.chronicle_sim.core.storage.db import init_schema
from tools.chronicle_sim.gui import app_settings
from tools.chronicle_sim.gui.human_display import llm_config_dict_to_html, seed_draft_dict_to_html
from tools.chronicle_sim.gui.layout_compact import tighten, tighten_form
from tools.chronicle_sim.gui.async_runnable import CancellableAsyncWorker
from tools.chronicle_sim.gui.console_errors import log_messagebox_critical, log_messagebox_warning
from tools.chronicle_sim.gui.error_dialog import exc_human, nonempty_information, show_async_failure
from tools.chronicle_sim.gui.config_tab.seed_md_library_widget import SeedMdLibraryWidget
from tools.chronicle_sim.paths import RUNS_DIR, ensure_runs_dir

# DashScope 等兼容网关常拒绝 temperature=0；仅单条 user 在少数网关也会校验失败。
_CONNECTIVITY_CHAT_MESSAGES: list[dict[str, str]] = [
    {
        "role": "system",
        "content": "You are a helpful assistant. Reply in one short sentence.",
    },
    {"role": "user", "content": "hi"},
]
_CONNECTIVITY_CHAT_TEMPERATURE = 0.01


def _demo_seed_draft() -> SeedDraft:
    """与「插入演示 NPC」相同的种子结构，供模板填入与手动编辑。"""
    return SeedDraft(
        world_setting={
            "title": "演示世界",
            "logline": "民国川渝码头与帮派纠葛",
            "era_and_place": "民国 · 川渝水陆码头",
            "tone_and_themes": "江湖义气、底层生存、规矩与背叛",
            "raw_author_notes": "可在此写任何粗糙随笔，生成种子时会被 LLM 结构化。",
        },
        design_pillars=[
            {
                "id": "pillar_credit",
                "name": "信用与面子",
                "description": "口头规矩比契纸更重要",
                "implications": "违约易引发连锁冲突",
            }
        ],
        custom_sections=[
            {
                "id": "cs_misc",
                "title": "我暂时不想分类的设定",
                "body": "例如：某条河禁止夜航、某个节日要抬神…",
            }
        ],
        agents=[
            {
                "id": "hero_guan",
                "name": "关二狗",
                "suggested_tier": "S",
                "reason": "演示主角",
                "faction_hint": "脚帮",
                "location_hint": "dock_east",
                "personality_tags": ["倔", "讲义气"],
                "secret_tags": ["欠一笔糊涂账"],
            },
            {
                "id": "boss_pao",
                "name": "袍哥舵把子",
                "suggested_tier": "A",
                "reason": "演示头目",
                "faction_hint": "袍哥",
                "location_hint": "teahouse",
                "personality_tags": ["笑面虎"],
                "secret_tags": [],
            },
        ],
        factions=[
            {"id": "faction_pao", "name": "袍哥公口", "description": "演示"},
            {"id": "faction_jiao", "name": "脚帮", "description": "演示"},
        ],
        locations=[
            {"id": "dock_east", "name": "东码头", "description": ""},
            {"id": "teahouse", "name": "茶馆", "description": ""},
        ],
        relationships=[],
        anchor_events=[{"id": "a1", "week_number": 4, "title": "序章节点", "description": ""}],
        social_graph_edges=[
            {
                "from_agent_id": "hero_guan",
                "to_agent_id": "boss_pao",
                "edge_type": "同行",
                "strength": 0.4,
                "propagation_factor": 0.8,
            }
        ],
        event_type_candidates=[],
    )


def _coerce_run_path(raw: Path | str | None) -> Path | None:
    """QComboBox userData 可能被 Qt 转成 str，统一为 Path 并 resolve。"""
    if raw is None:
        return None
    if isinstance(raw, Path):
        p = raw
    else:
        s = str(raw).strip()
        if not s:
            return None
        p = Path(s)
    try:
        return p.resolve()
    except (OSError, RuntimeError):
        return p


class ConfigWidget(QWidget):
    runChanged = Signal(object)
    requestRunWeek = Signal(int)
    requestRunWeekRange = Signal(int, int)
    seedApplied = Signal()
    llmConfigSaved = Signal(dict)
    activityLog = Signal(str)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._run_dir: Path | None = None
        self._db = None
        self._last_seed: SeedDraft | None = None
        self._http_extras: dict[str, Any] = {}
        self._pool = QThreadPool.globalInstance()
        self._long_task_busy = False
        self._busy_kind = ""
        self._worker_db_suspended = False

        root = QVBoxLayout(self)
        tighten(root, margins=(6, 6, 6, 6), spacing=4)
        top = QHBoxLayout()
        self._run_combo = QComboBox()
        self._btn_refresh_runs = QPushButton("刷新 run 列表")
        self._btn_new = QPushButton("新建 run")
        self._name_edit = QLineEdit()
        self._name_edit.setPlaceholderText("run 名称")
        top.addWidget(QLabel("当前 run:"))
        top.addWidget(self._run_combo, 2)
        top.addWidget(self._btn_refresh_runs)
        top.addWidget(self._name_edit)
        top.addWidget(self._btn_new)
        root.addLayout(top)
        top2 = QHBoxLayout()
        self._btn_delete_run = QPushButton("删除当前 run…")
        self._btn_delete_run.setToolTip("永久删除当前选中 run 的整个文件夹（含数据库与快照），不可恢复。")
        self._btn_delete_run.clicked.connect(self._delete_current_run)
        self._btn_open_runs = QPushButton("打开 runs 文件夹")
        self._btn_open_runs.setToolTip(str(RUNS_DIR.resolve()))
        self._btn_open_runs.clicked.connect(self._open_runs_folder)
        top2.addWidget(self._btn_delete_run)
        top2.addWidget(self._btn_open_runs)
        top2.addStretch(1)
        root.addLayout(top2)
        self._session_hint = QLabel(
            "会话状态：本机 QSettings；run 数据在 tools/chronicle_sim/runs/。"
        )
        self._session_hint.setStyleSheet("color: palette(mid); font-size: 11px;")
        self._session_hint.setToolTip(
            "界面状态保存在 QSettings（组织名 GameDraft，应用名 ChronicleSim）。\n"
            "每个 run 为 runs 下独立文件夹，含 run.db 与 snapshots。"
        )
        root.addWidget(self._session_hint)

        split = QSplitter(Qt.Orientation.Horizontal)

        self._sub_tabs = QTabWidget()
        tier_box = QGroupBox("Tier 管理（current_tier → 库）")
        tier_box.setToolTip(
            "Tier B（龙套）与 Tier A 共用「LLM」页「NPC Tier A+B」（配置键 tier_a_npc），无单独 B 档。\n"
            "B 与 A 的差别仅在提示词篇幅。Tier S 使用「NPC Tier S」。"
        )
        tier_lay = QVBoxLayout(tier_box)
        tighten(tier_lay, margins=(8, 8, 8, 8), spacing=4)
        self._tier_table = QTableWidget(0, 5)
        self._tier_table.setHorizontalHeaderLabels(["id", "姓名", "推荐", "理由", "当前 Tier"])
        tier_lay.addWidget(self._tier_table)
        self._lbl_tier_empty = QLabel("")
        self._lbl_tier_empty.setWordWrap(True)
        self._lbl_tier_empty.setStyleSheet("color: palette(mid);")
        tier_lay.addWidget(self._lbl_tier_empty)
        self._lbl_tier_pending = QLabel("")
        tier_lay.addWidget(self._lbl_tier_pending)
        btn_tier = QPushButton("保存 Tier 到数据库")
        btn_tier.clicked.connect(self._save_tiers)
        tier_lay.addWidget(btn_tier)

        seed_box = QGroupBox("种子（JSON）")
        seed_box.setToolTip(
            "Tier 表来自库内 agents；新 run 可能为空。\n"
            "流程：「设定 MD 库」写原文 → 「生成种子」→下方 JSON 可手改 → 「解析」/「写入数据库」。\n"
            "「演示 JSON」=仅填编辑区；「插入演示 NPC」= 直接入库示例。"
        )
        seed_lay = QVBoxLayout(seed_box)
        tighten(seed_lay, margins=(8, 8, 8, 8), spacing=4)
        self._seed_help = QLabel("流程：MD 库 → 生成种子 → 解析或写入库。（悬停本组标题见说明）")
        self._seed_help.setStyleSheet("color: palette(mid); font-size: 11px;")
        seed_lay.addWidget(self._seed_help)
        row_seed_a = QHBoxLayout()
        self._btn_gen_seed = QPushButton("从 MD 库生成种子")
        self._btn_gen_seed.setToolTip("合并 MD 库已启用文档，经 LLM 或启发式抽取为 SeedDraft（未自动入库）。")
        self._btn_gen_seed.clicked.connect(self._generate_seed)
        self._btn_fill_demo = QPushButton("填入演示 JSON")
        self._btn_fill_demo.setToolTip("仅填入下方编辑区，不写入数据库。")
        self._btn_fill_demo.clicked.connect(self._fill_demo_seed_json)
        row_seed_a.addWidget(self._btn_gen_seed)
        row_seed_a.addWidget(self._btn_fill_demo)
        seed_lay.addLayout(row_seed_a)
        self._chk_legacy_root_md = QCheckBox("附加读项目根旧版 .md 列表")
        self._chk_legacy_root_md.setToolTip("兼容早期硬编码文件名；日常只用「设定 MD 库」即可。")
        seed_lay.addWidget(self._chk_legacy_root_md)
        row_seed_b = QHBoxLayout()
        self._btn_parse_seed = QPushButton("解析 JSON")
        self._btn_parse_seed.setToolTip("校验 SeedDraft 并载入内存（未写库）。")
        self._btn_parse_seed.clicked.connect(self._parse_seed_from_editor)
        self._btn_apply_seed = QPushButton("种子写入数据库")
        self._btn_apply_seed.setToolTip("将当前种子 apply到当前 run 的 SQLite。")
        self._btn_apply_seed.clicked.connect(self._apply_seed)
        self._btn_demo = QPushButton("插入演示 NPC")
        self._btn_demo.setToolTip("两名示例角色（S+A）直接入库。")
        self._btn_demo.clicked.connect(self._insert_demo)
        row_seed_b.addWidget(self._btn_parse_seed)
        row_seed_b.addWidget(self._btn_apply_seed)
        row_seed_b.addWidget(self._btn_demo)
        seed_lay.addLayout(row_seed_b)
        self._seed_preview = QTextEdit()
        self._seed_preview.setReadOnly(False)
        self._seed_preview.setMinimumHeight(160)
        self._seed_preview.setFont(QFont("Consolas", 10))
        self._seed_preview.setPlaceholderText(
            "种子 JSON 顶层键：world_setting（对象）, design_pillars, custom_sections, agents, factions, "
            "locations, relationships, anchor_events, social_graph_edges, event_type_candidates。"
            "点「填入演示 JSON」可加载含世界观示例的模板。"
        )
        self._seed_readable = QTextEdit()
        self._seed_readable.setReadOnly(True)
        self._seed_readable.setAcceptRichText(True)
        self._seed_readable.setMinimumHeight(140)
        self._seed_readable.setPlaceholderText(
            "阅读视图：解析成功或生成种子后在此以分节、表格展示（上方仍为可编辑 JSON，入库逻辑不变）。"
        )
        seed_split = QSplitter(Qt.Orientation.Vertical)
        seed_split.addWidget(self._seed_preview)
        seed_split.addWidget(self._seed_readable)
        seed_split.setSizes([220, 200])
        seed_lay.addWidget(seed_split, 1)

        sim_box = QGroupBox("模拟")
        sim_lay = QFormLayout(sim_box)
        tighten_form(sim_lay, vertical=4, horizontal=8)
        self._lbl_run_state = QLabel("就绪")
        self._lbl_run_state.setStyleSheet("font-weight: bold;")
        self._week_spin = QSpinBox()
        self._week_spin.setRange(1, 520)
        self._week_spin.setValue(1)
        self._week_spin.valueChanged.connect(self._on_week_spin_changed)
        self._btn_run_week = QPushButton("运行该周")
        self._btn_run_week.clicked.connect(self._emit_run_week)
        self._lbl_meta = QLabel("")
        sim_lay.addRow("状态:", self._lbl_run_state)
        sim_lay.addRow("推进周次:", self._week_spin)
        sim_lay.addRow(self._btn_run_week)
        row_week_range = QHBoxLayout()
        row_week_range.addWidget(QLabel("批量结束周"))
        self._week_spin_end = QSpinBox()
        self._week_spin_end.setRange(1, 520)
        self._week_spin_end.setValue(1)
        self._week_spin_end.setToolTip("与左侧「推进周次」组成闭区间 [起始, 结束]，依次运行每一周。")
        row_week_range.addWidget(self._week_spin_end)
        self._btn_run_week_range = QPushButton("运行周次范围")
        self._btn_run_week_range.setToolTip("从「推进周次」到「批量结束周」逐周模拟；失败时尝试恢复至该周开始前备份。")
        self._btn_run_week_range.clicked.connect(self._emit_run_week_range)
        row_week_range.addWidget(self._btn_run_week_range)
        row_week_range.addStretch(1)
        sim_lay.addRow(row_week_range)
        sim_lay.addRow(self._lbl_meta)
        self._run_tab_log = QPlainTextEdit()
        self._run_tab_log.setReadOnly(True)
        self._run_tab_log.setPlaceholderText("本页任务日志（与主窗口底部活动日志同步）…")
        self._run_tab_log.setMinimumHeight(72)
        self._run_tab_log.setMaximumHeight(140)
        sim_lay.addRow("运行日志", self._run_tab_log)
        self.activityLog.connect(self._append_run_tab_log)

        llm_box = QGroupBox("LLM / 嵌入")
        llm_box.setToolTip(
            "配置写入当前 run 数据库，不使用环境变量。\n"
            "关闭窗口时会自动保存本页表单与 Tier 下拉。\n"
            "若库内已有 llm_config，启动仍显示库内内容；要改用 data/private_llm_defaults.json 请点「载入 private」再「保存到 run」。"
        )
        llm_lay = QVBoxLayout(llm_box)
        tighten(llm_lay, margins=(8, 8, 8, 8), spacing=4)
        llm_scroll = QScrollArea()
        llm_scroll.setWidgetResizable(True)
        llm_scroll.setMinimumHeight(320)
        llm_inner = QWidget()
        llm_inner_lay = QVBoxLayout(llm_inner)
        llm_inner_lay.setContentsMargins(0, 0, 0, 0)
        self._llm_form = LlmConfigForm()
        self._llm_form.agent_connection_test_requested.connect(self._test_agent_slot_connection)
        llm_inner_lay.addWidget(self._llm_form)
        llm_scroll.setWidget(llm_inner)
        llm_lay.addWidget(llm_scroll)
        self._chk_skip_llm_validate = QCheckBox("保存 LLM 时跳过配置校验（不推荐）")
        self._chk_skip_llm_validate.setToolTip(
            "默认校验 JSON 可序列化、strict 语义记忆时嵌入可用等。仅在手测确认配置无误后再勾选。"
        )
        llm_lay.addWidget(self._chk_skip_llm_validate)
        self._llm_preview = QTextEdit()
        self._llm_preview.setReadOnly(True)
        self._llm_preview.setAcceptRichText(True)
        self._llm_preview.setMinimumHeight(72)
        self._llm_preview.setMaximumHeight(200)
        self._llm_preview.setPlaceholderText("将写入 runs.llm_config_json 的配置（分层阅读视图，刷新预览更新）。")
        llm_lay.addWidget(self._llm_preview)
        llm_btns = QHBoxLayout()
        btn_save_llm = QPushButton("保存 LLM 到 run")
        btn_save_llm.clicked.connect(self._save_llm_config)
        btn_prev = QPushButton("刷新预览")
        btn_prev.clicked.connect(self._refresh_llm_preview)
        btn_load_private = QPushButton("载入 private 默认")
        btn_load_private.setToolTip(
            f"{private_llm_defaults_file()}\n"
            "覆盖当前表单。打开 run 不会自动替换库内已存配置，需本按钮后再「保存到 run」。"
        )
        btn_load_private.clicked.connect(self._load_private_llm_into_form)
        self._btn_test_chat = QPushButton("测试推理")
        self._btn_test_chat.setToolTip(
            "仅测对话：使用左侧列表当前选中的 Agent 槽发一条 hi；遵守各槽「覆盖默认」规则。"
            "也可直接点各槽内的「测试本槽连接」，无需先选中列表项。"
        )
        self._btn_test_chat.clicked.connect(self._test_chat_connection)
        self._btn_test_embed = QPushButton("测试嵌入")
        self._btn_test_embed.setToolTip(
            "仅测嵌入：只使用表单顶部「嵌入（语义记忆向量）」区块，不从 NPC/默认对话推导。可取消。"
        )
        self._btn_test_embed.clicked.connect(self._test_embedding_connection)
        llm_btns.addWidget(btn_save_llm)
        llm_btns.addWidget(btn_prev)
        llm_btns.addWidget(btn_load_private)
        llm_btns.addWidget(self._btn_test_chat)
        llm_btns.addWidget(self._btn_test_embed)
        llm_btns.addStretch(1)
        llm_lay.addLayout(llm_btns)

        proxy_box = QGroupBox("HTTP(S) 代理")
        proxy_box.setToolTip(
            "不使用 Windows 系统代理，也不读 HTTP_PROXY / HTTPS_PROXY。\n"
            "仅此处填写时 LLM 与嵌入走代理；留空则直连 Base URL / Ollama。\n"
            "示例：http://127.0.0.1:7890。可与 LLM 一并保存，关闭窗口时也会写入 runs 表。"
        )
        proxy_lay = QVBoxLayout(proxy_box)
        tighten(proxy_lay, margins=(8, 8, 8, 8), spacing=4)
        px_one = QLabel("不使用系统/环境变量代理；仅下方地址生效（悬停标题见说明）。")
        px_one.setStyleSheet("color: palette(mid); font-size: 11px;")
        proxy_lay.addWidget(px_one)
        self._proxy_url_edit = QLineEdit()
        self._proxy_url_edit.setPlaceholderText("留空=不使用任何代理")
        proxy_lay.addWidget(self._proxy_url_edit)
        to_row = QHBoxLayout()
        to_row.addWidget(QLabel("对话/嵌入 HTTP 读超时（秒）"))
        self._http_timeout_sec = QSpinBox()
        self._http_timeout_sec.setRange(10, 1800)
        self._http_timeout_sec.setValue(300)
        self._http_timeout_sec.setToolTip(
            "等待模型返回（read）与发送较大请求体（write）的上限秒数；连接握手单独限制在至多 30 秒。"
            "种子抽取、长上下文等可酌情调高（默认 300）。"
        )
        to_row.addWidget(self._http_timeout_sec)
        to_row.addStretch(1)
        proxy_lay.addLayout(to_row)
        retry_row = QHBoxLayout()
        retry_row.addWidget(QLabel("HTTP 失败重试次数"))
        self._http_max_retries = QSpinBox()
        self._http_max_retries.setRange(1, 20)
        self._http_max_retries.setValue(3)
        self._http_max_retries.setToolTip("写入 llm_config_json.http.max_retries，供 OpenAI 兼容 / Ollama 适配器使用。")
        retry_row.addWidget(self._http_max_retries)
        retry_row.addWidget(QLabel("重试退避（秒）"))
        self._http_retry_backoff = QDoubleSpinBox()
        self._http_retry_backoff.setRange(0.1, 120.0)
        self._http_retry_backoff.setDecimals(1)
        self._http_retry_backoff.setSingleStep(0.5)
        self._http_retry_backoff.setValue(1.0)
        self._http_retry_backoff.setToolTip("写入 llm_config_json.http.retry_backoff_sec。")
        retry_row.addWidget(self._http_retry_backoff)
        retry_row.addStretch(1)
        proxy_lay.addLayout(retry_row)
        px_row = QHBoxLayout()
        btn_save_proxy = QPushButton("保存代理到当前 run")
        btn_save_proxy.clicked.connect(self._save_proxy_only)
        px_row.addWidget(btn_save_proxy)
        px_row.addStretch(1)
        proxy_lay.addLayout(px_row)

        roll_box = QGroupBox("快照回滚")
        roll_box.setToolTip("用 snapshots/week_XXX.db 覆盖 run.db。请先关闭其它占用该文件的程序。")
        roll_lay = QHBoxLayout(roll_box)
        self._rollback_week = QSpinBox()
        self._rollback_week.setRange(1, 520)
        self._btn_rollback_snapshot = QPushButton("回滚到该周数据库快照")
        self._btn_rollback_snapshot.clicked.connect(self._rollback_db_snapshot)
        roll_lay.addWidget(QLabel("周次"))
        roll_lay.addWidget(self._rollback_week)
        roll_lay.addWidget(self._btn_rollback_snapshot)

        tier_seed_page = QWidget()
        tier_seed_lay = QVBoxLayout(tier_seed_page)
        tier_seed_lay.setContentsMargins(0, 0, 0, 0)
        tier_seed_lay.setSpacing(6)
        tier_seed_lay.addWidget(tier_box)
        tier_seed_lay.addWidget(seed_box, 1)
        tier_seed_scroll = QScrollArea()
        tier_seed_scroll.setWidgetResizable(True)
        tier_seed_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        tier_seed_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        tier_seed_scroll.setMinimumHeight(360)
        tier_seed_scroll.setWidget(tier_seed_page)
        self._seed_md_lib = SeedMdLibraryWidget()
        self._seed_md_lib.changed.connect(lambda: self.activityLog.emit("[MD库] 条目已保存或变更"))
        self._sub_tabs.addTab(self._seed_md_lib, "设定 MD 库")
        self._sub_tabs.addTab(tier_seed_scroll, "Tier / 种子")
        self._sub_tabs.addTab(sim_box, "运行")
        self._sub_tabs.addTab(llm_box, "LLM")
        self._sub_tabs.addTab(proxy_box, "代理")
        self._sub_tabs.addTab(roll_box, "回滚")

        split.addWidget(self._sub_tabs)
        root.addWidget(split, 1)

        self._btn_refresh_runs.clicked.connect(self.refresh_runs)
        self._btn_new.clicked.connect(self._new_run)
        self._run_combo.currentIndexChanged.connect(self._combo_run_changed)

        ensure_runs_dir()
        self.refresh_runs()

    def get_run_dir(self) -> Path | None:
        return self._run_dir

    def persist_open_run_to_db(self) -> None:
        """关闭窗口时调用：Tier 下拉 + LLM 表单写入 runs / agents（无弹窗）。"""
        if not self._db:
            return
        for i in range(self._tier_table.rowCount()):
            item0 = self._tier_table.item(i, 0)
            if not item0:
                continue
            aid = item0.text()
            w = self._tier_table.cellWidget(i, 4)
            if isinstance(w, QComboBox):
                set_agent_current_tier(self._db.conn, aid, NpcTier(w.currentText()))
        cfg = self._merged_llm_config()
        self._db.conn.execute(
            "UPDATE runs SET llm_config_json = ? WHERE 1=1",
            (json.dumps(cfg, ensure_ascii=False),),
        )
        self._db.conn.commit()

    def save_session_prefs(self) -> None:
        app_settings.set_value("config/sub_tab", self._sub_tabs.currentIndex())
        app_settings.set_value("config/week_spin", self._week_spin.value())
        app_settings.set_value("config/week_spin_end", self._week_spin_end.value())
        app_settings.set_value("config/rollback_week", self._rollback_week.value())
        app_settings.set_value("config/run_name_draft", self._name_edit.text())
        app_settings.set_value("config/seed_legacy_root_md", self._chk_legacy_root_md.isChecked())

    def restore_session_prefs(self) -> None:
        st = app_settings.get_value("config/sub_tab", 0)
        try:
            i = int(st)
        except (TypeError, ValueError):
            i = 0
        i = max(0, min(i, self._sub_tabs.count() - 1))
        self._sub_tabs.setCurrentIndex(i)
        wk = app_settings.get_value("config/week_spin", 1)
        try:
            self._week_spin.setValue(int(wk))
        except (TypeError, ValueError):
            pass
        wke = app_settings.get_value("config/week_spin_end", 1)
        try:
            self._week_spin_end.setValue(int(wke))
        except (TypeError, ValueError):
            pass
        rw = app_settings.get_value("config/rollback_week", 1)
        try:
            self._rollback_week.setValue(int(rw))
        except (TypeError, ValueError):
            pass
        name_d = app_settings.get_value("config/run_name_draft", "")
        if isinstance(name_d, str) and name_d:
            self._name_edit.setText(name_d)
        leg = app_settings.get_value("config/seed_legacy_root_md", False)
        self._chk_legacy_root_md.setChecked(bool(leg))

    def get_runtime_llm_config(self) -> dict[str, Any]:
        """当前表单 + 代理页合并后的配置（可与数据库尚未保存的内容一致）。"""
        return self._merged_llm_config()

    def is_long_task_busy(self) -> bool:
        return self._long_task_busy

    def suspend_run_db_for_worker(self) -> None:
        """周次模拟工作线程独占 run.db 时关闭本页持有的连接。"""
        self._worker_db_suspended = True
        if self._db is not None:
            try:
                self._db.close()
            except Exception:
                pass
            self._db = None

    def resume_run_db_after_worker(self) -> None:
        """工作线程结束后恢复本页数据库连接（不改变当前选中 run）。"""
        self._worker_db_suspended = False
        path = self._run_dir
        if path and (path / "run.db").is_file() and self._db is None:
            self._db = open_database(path)

    def set_long_task_busy(self, busy: bool, kind: str = "") -> None:
        """长任务进行中：禁用运行周次、连接测试、蓝图生成种子等，防止重复点击。"""
        self._long_task_busy = busy
        self._busy_kind = kind if busy else ""
        idle = not busy
        self._btn_run_week.setEnabled(idle)
        self._btn_run_week_range.setEnabled(idle)
        self._btn_test_chat.setEnabled(idle)
        self._btn_test_embed.setEnabled(idle)
        self._btn_gen_seed.setEnabled(idle)
        self._week_spin.setEnabled(idle)
        self._week_spin_end.setEnabled(idle)
        self._run_combo.setEnabled(idle)
        self._btn_refresh_runs.setEnabled(idle)
        self._btn_new.setEnabled(idle)
        self._btn_delete_run.setEnabled(idle)
        self._btn_rollback_snapshot.setEnabled(idle)
        self._rollback_week.setEnabled(idle)
        if idle:
            self._lbl_run_state.setText("就绪")
        elif kind == "week":
            self._lbl_run_state.setText("周次模拟运行中…")
        elif kind == "seed":
            self._lbl_run_state.setText("从蓝图生成种子中…")
        elif kind == "test_chat":
            self._lbl_run_state.setText("推理接口测试中…")
        elif kind == "test_embed":
            self._lbl_run_state.setText("嵌入接口测试中…")
        else:
            self._lbl_run_state.setText("后台任务执行中…")

    def _append_run_tab_log(self, msg: str) -> None:
        line = f"[{datetime.now().strftime('%H:%M:%S')}] {msg}"
        self._run_tab_log.appendPlainText(line)
        sb = self._run_tab_log.verticalScrollBar()
        sb.setValue(sb.maximum())
        doc = self._run_tab_log.document()
        if doc.blockCount() > 400:
            t = self._run_tab_log.toPlainText()
            lines = t.splitlines()
            if len(lines) > 350:
                self._run_tab_log.setPlainText("\n".join(lines[-300:]))

    def _apply_http_from_llm_dict(self, loaded: dict[str, Any]) -> None:
        raw = loaded.pop("http", None)
        self._http_extras = {}
        proxy_u = ""
        if not isinstance(raw, dict):
            self._http_timeout_sec.setValue(300)
            self._http_max_retries.setValue(3)
            self._http_retry_backoff.setValue(1.0)
        if isinstance(raw, dict):
            p = raw.get("proxy")
            if isinstance(p, str):
                proxy_u = p.strip()
            ts = raw.get("chat_timeout_sec", 300)
            try:
                self._http_timeout_sec.setValue(max(10, min(1800, int(float(ts)))))
            except (TypeError, ValueError):
                self._http_timeout_sec.setValue(300)
            try:
                mr = int(raw.get("max_retries", 3))
                self._http_max_retries.setValue(max(1, min(20, mr)))
            except (TypeError, ValueError):
                self._http_max_retries.setValue(3)
            try:
                bo = float(raw.get("retry_backoff_sec", 1.0))
                self._http_retry_backoff.setValue(max(0.1, min(120.0, bo)))
            except (TypeError, ValueError):
                self._http_retry_backoff.setValue(1.0)
            self._http_extras = {
                k: copy.deepcopy(v)
                for k, v in raw.items()
                if k
                not in (
                    "proxy",
                    "trust_env",
                    "chat_timeout_sec",
                    "max_retries",
                    "retry_backoff_sec",
                )
            }
        self._proxy_url_edit.setText(proxy_u)

    def _merge_http_into_cfg(self, cfg: dict[str, Any]) -> None:
        proxy_u = self._proxy_url_edit.text().strip()
        ex = dict(self._http_extras)
        ex["chat_timeout_sec"] = float(self._http_timeout_sec.value())
        ex["max_retries"] = int(self._http_max_retries.value())
        ex["retry_backoff_sec"] = float(self._http_retry_backoff.value())
        if proxy_u:
            cfg["http"] = {**ex, "proxy": proxy_u}
        elif ex:
            cfg["http"] = ex
        else:
            cfg.pop("http", None)

    def _merged_llm_config(self) -> dict[str, Any]:
        cfg = self._llm_form.to_dict()
        self._merge_http_into_cfg(cfg)
        return cfg

    def _refresh_llm_preview(self) -> None:
        try:
            cfg = self._merged_llm_config()
            html = llm_config_dict_to_html(cfg)
            self._llm_preview.setHtml(
                '<div style="font-family:\'Microsoft YaHei UI\',sans-serif;font-size:12px">'
                + html
                + "</div>"
            )
        except Exception as e:
            self._llm_preview.setHtml(f"<p style='color:#c53030'>（预览失败: {e}）</p>")

    def _refresh_seed_readable(self) -> None:
        if self._last_seed is None:
            self._seed_readable.clear()
            return
        try:
            html = seed_draft_dict_to_html(self._last_seed.model_dump())
            self._seed_readable.setHtml(
                '<div style="font-family:\'Microsoft YaHei UI\',sans-serif;font-size:13px">'
                + html
                + "</div>"
            )
        except Exception:
            self._seed_readable.setHtml("<p style='color:#718096'>（无法生成阅读视图）</p>")

    def _load_private_llm_into_form(self) -> None:
        p = private_llm_defaults_file()
        cfg = load_private_llm_defaults()
        if not cfg:
            QMessageBox.warning(
                self,
                "无配置",
                f"未读到有效 JSON（文件不存在或解析失败）：\n{p}\n\n"
                "请确认该路径下有 private_llm_defaults.json，或从 private_llm_defaults.example.json 复制改名后填写。",
            )
            return
        merged = copy.deepcopy(cfg)
        self._apply_http_from_llm_dict(merged)
        self._llm_form.set_from_dict(merged)
        self._refresh_llm_preview()
        QMessageBox.information(
            self,
            "已载入",
            "已用本地文件覆盖当前 LLM 表单。若要写入当前 run，请再点「保存 LLM 配置到 run」。",
        )

    def reload_run_meta(self) -> None:
        self._load_run(self._run_dir)

    def refresh_runs(self) -> None:
        self._run_combo.blockSignals(True)
        self._run_combo.clear()
        for r in list_runs():
            self._run_combo.addItem(f"{r['name']} ({r['run_id']})", userData=Path(r["path"]))
        self._run_combo.blockSignals(False)
        if self._run_combo.count() == 0:
            self._load_run(None)
            app_settings.save_last_run_path(None)
            return
        preferred = app_settings.load_last_run_path()
        idx = -1
        if preferred is not None:
            pref = preferred.resolve()
            for i in range(self._run_combo.count()):
                if _coerce_run_path(self._run_combo.itemData(i)) == pref:
                    idx = i
                    break
            if idx < 0:
                idx = self._run_combo.findData(preferred)
        if idx < 0:
            idx = 0
        self._run_combo.setCurrentIndex(idx)
        # 刷新后必须显式同步：setCurrentIndex与当前相同时 Qt 可能不发出 currentIndexChanged，导致 _db 一直为 None
        self._apply_combo_selection_to_run()

    def _combo_run_changed(self) -> None:
        self._apply_combo_selection_to_run()

    def _apply_combo_selection_to_run(self) -> None:
        path = _coerce_run_path(self._run_combo.currentData())
        self._load_run(path)
        app_settings.save_last_run_path(path if path and path.is_dir() else None)

    def _load_run(self, path: Path | str | None) -> None:
        path = _coerce_run_path(path)
        if self._worker_db_suspended:
            return
        if path != self._run_dir:
            if self._db is not None:
                try:
                    self._db.close()
                except Exception:
                    pass
                self._db = None
        self._run_dir = path
        if path and (path / "run.db").is_file():
            if self._db is None:
                self._db = open_database(path)
            meta = self._db.run_meta()
            if meta:
                self._lbl_meta.setText(
                    f"run_id={meta['run_id']} 当前周={meta['current_week']} pacing={meta['pacing_profile_id']}"
                )
                raw = meta.get("llm_config_json") or "{}"
                try:
                    loaded = json.loads(raw) if isinstance(raw, str) else {}
                except json.JSONDecodeError:
                    loaded = {}
                if not isinstance(loaded, dict):
                    loaded = {}
                if not loaded:
                    priv = load_private_llm_defaults()
                    loaded = copy.deepcopy(priv) if priv else {}
                else:
                    loaded = copy.deepcopy(loaded)
                self._apply_http_from_llm_dict(loaded)
                self._llm_form.set_from_dict(loaded)
            else:
                self._lbl_meta.setText("runs 表无元数据")
                self._http_extras = {}
                self._proxy_url_edit.clear()
                self._llm_form.set_from_dict({})
            self._reload_tier_table()
            self.refresh_tier_queue_hint()
        else:
            if self._db is not None:
                try:
                    self._db.close()
                except Exception:
                    pass
                self._db = None
            self._lbl_meta.setText("未打开数据库")
            self._lbl_tier_pending.setText("")
            self._http_extras = {}
            self._proxy_url_edit.clear()
            self._llm_form.set_from_dict({})
        self._refresh_llm_preview()
        self.runChanged.emit(path)

    def _new_run(self) -> None:
        name = self._name_edit.text().strip() or "未命名 run"
        rid, rdir = create_run(name)
        self.refresh_runs()
        idx = -1
        target = rdir.resolve()
        for i in range(self._run_combo.count()):
            if _coerce_run_path(self._run_combo.itemData(i)) == target:
                idx = i
                break
        if idx < 0:
            idx = self._run_combo.findData(rdir)
        if idx >= 0:
            self._run_combo.setCurrentIndex(idx)
            self._apply_combo_selection_to_run()

    def _open_runs_folder(self) -> None:
        ensure_runs_dir()
        p = str(RUNS_DIR.resolve())
        try:
            if sys.platform == "win32":
                os.startfile(p)  # type: ignore[attr-defined]
            elif sys.platform == "darwin":
                os.system(f'open "{p}"')
            else:
                os.system(f'xdg-open "{p}"')
        except OSError as e:
            log_messagebox_warning("无法打开", f"{p}\n{e}")
            QMessageBox.warning(self, "无法打开", f"{p}\n{e}")

    def _delete_current_run(self) -> None:
        path = _coerce_run_path(self._run_combo.currentData())
        if path is None:
            QMessageBox.warning(self, "提示", "没有可删除的 run（列表为空或未选中）。")
            return
        if not path.is_dir():
            QMessageBox.warning(self, "提示", "路径无效。")
            return
        label = path.name
        if self._db is not None and self._run_dir == path:
            meta = self._db.run_meta()
            if meta:
                label = f"{meta.get('name', '')}（id={meta.get('run_id', '')}）"
        reply = QMessageBox.question(
            self,
            "确认删除 run",
            "将永久删除该 run 的整个文件夹（含 run.db、snapshots、chroma_memory 等），无法恢复。\n\n"
            f"目标：{path}\n"
            f"{label}\n\n"
            "确定删除？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if reply != QMessageBox.StandardButton.Yes:
            return
        if self._db is not None:
            try:
                self._db.close()
            except Exception:
                pass
            self._db = None
        # 主窗口与其它 Tab 也持有同一 run.db 的连接；不先释放则 Windows 下 rmtree 报 WinError 32
        self._run_dir = None
        self.runChanged.emit(None)
        try:
            delete_run_dir(path)
        except Exception as e:
            log_messagebox_critical("删除失败", exc_human(e), exc=e)
            QMessageBox.critical(self, "删除失败", exc_human(e))
            self.refresh_runs()
            return
        app_settings.save_last_run_path(None)
        self.refresh_runs()
        self.seedApplied.emit()
        QMessageBox.information(self, "已删除", "该 run 已从磁盘移除。")

    def refresh_tier_queue_hint(self) -> None:
        if not self._db:
            self._lbl_tier_pending.setText("")
            return
        n = self._db.conn.execute(
            "SELECT COUNT(*) AS c FROM tier_changes WHERE pending_flag = 1"
        ).fetchone()["c"]
        self._lbl_tier_pending.setText(f"待应用 Tier 变更（下周推进时生效）: {int(n)} 条")

    def _reload_tier_table(self) -> None:
        self._tier_table.setRowCount(0)
        if not self._db:
            self._lbl_tier_empty.setText("请先创建或选择一个 run。")
            return
        rows = self._db.conn.execute(
            "SELECT id, name, init_agent_suggested_tier, init_agent_suggestion_reason, current_tier FROM agents ORDER BY id"
        ).fetchall()
        for i, r in enumerate(rows):
            self._tier_table.insertRow(i)
            self._tier_table.setItem(i, 0, QTableWidgetItem(r["id"]))
            self._tier_table.setItem(i, 1, QTableWidgetItem(r["name"]))
            self._tier_table.setItem(i, 2, QTableWidgetItem(r["init_agent_suggested_tier"] or ""))
            self._tier_table.setItem(i, 3, QTableWidgetItem(r["init_agent_suggestion_reason"] or ""))
            combo = QComboBox()
            for t in ("S", "A", "B"):
                combo.addItem(t)
            idx = combo.findText(r["current_tier"] or "B")
            if idx >= 0:
                combo.setCurrentIndex(idx)
            self._tier_table.setCellWidget(i, 4, combo)
        self.refresh_tier_queue_hint()
        if self._tier_table.rowCount() == 0:
            self._lbl_tier_empty.setText(
                "当前还没有 NPC：请使用下方「填入演示 JSON」→「解析」→「写入数据库」，或点「插入演示 NPC」。"
            )
        else:
            self._lbl_tier_empty.setText("")

    def _save_tiers(self) -> None:
        if not self._db:
            return
        for i in range(self._tier_table.rowCount()):
            aid = self._tier_table.item(i, 0).text()
            w = self._tier_table.cellWidget(i, 4)
            if isinstance(w, QComboBox):
                set_agent_current_tier(self._db.conn, aid, NpcTier(w.currentText()))
        self._db.conn.commit()
        QMessageBox.information(self, "已保存", "Tier 已写入 agents表。")
        self.seedApplied.emit()

    def _generate_seed(self) -> None:
        if self._long_task_busy:
            self.activityLog.emit("已有任务在执行，已忽略「从蓝图生成种子」。")
            return

        cancel_flag = threading.Event()
        llm_cfg_snap = copy.deepcopy(self._merged_llm_config())

        async def _go() -> SeedDraft:
            self.activityLog.emit("[种子] 开始：合并「设定 MD 库」已启用文档…")
            cfg = llm_cfg_snap
            prof = provider_profile_for_agent("initializer", cfg)
            if prof.kind == "ollama":
                self.activityLog.emit(
                    f"[种子] LLM 端点：initializer→Ollama host={prof.ollama_host!r} model={prof.model!r}"
                )
            elif prof.kind == "openai_compat":
                self.activityLog.emit(
                    f"[种子] LLM 端点：initializer→OpenAI 兼容 base={prof.base_url!r} model={prof.model!r}"
                )
            else:
                self.activityLog.emit(
                    f"[种子] LLM 端点：initializer→Stub（未使用 HTTP；若需真实模型请在「默认」或「种子抽取」槽配置非 Stub）"
                )
            llm = ClientFactory.build_for_agent(
                "initializer",
                prof,
                cfg,
                run_dir=self._run_dir,
            )
            try:
                mem_conn = sqlite3.connect(":memory:")
                init_schema(mem_conn)
                init = InitializerAgent(
                    llm,
                    MemoryStore(mem_conn, "initializer"),
                    HistoryBuffer(),
                    AgentState(),
                    EventBus(),
                )
                if cancel_flag.is_set():
                    raise asyncio.CancelledError()
                legacy = self._chk_legacy_root_md.isChecked()
                if legacy:
                    self.activityLog.emit("[种子] 已勾选附加项目根旧版 .md 列表")
                self.activityLog.emit(
                    "[种子] 正在调用 LLM 抽取结构化种子（世界观/支柱/自定义区块 + NPC 等；Stub 时为启发式）…"
                )
                draft = await init.run_extraction(
                    target_npc_count=40,
                    use_legacy_project_blueprints=legacy,
                    progress_log=lambda m: self.activityLog.emit(m),
                )
                self.activityLog.emit("[种子] 返回已校验为 SeedDraft")
                return draft
            finally:
                await llm.aclose()

        progress = QProgressDialog("正在从设定 MD 库生成种子…", "取消", 0, 0, self)
        progress.setWindowTitle("生成种子")
        progress.setWindowModality(Qt.WindowModality.WindowModal)
        progress.setMinimumDuration(0)
        progress.setMinimumWidth(420)

        worker = CancellableAsyncWorker(_go())

        def _close_progress() -> None:
            progress.reset()
            progress.close()

        def _done_ok(draft: SeedDraft) -> None:
            _close_progress()
            self.set_long_task_busy(False, "")
            self._last_seed = draft
            self._seed_preview.setPlainText(draft.model_dump_json(indent=2))
            self._refresh_seed_readable()
            self.activityLog.emit("[种子] 已填入下方编辑区（未写入数据库）")
            QMessageBox.information(
                self,
                "完成",
                "已从设定 MD 库生成种子，内容已填入下方编辑区。若需入库请再点「将当前种子写入 run 数据库」。",
            )

        def _done_err(summary: str, detail: str) -> None:
            _close_progress()
            self.set_long_task_busy(False, "")
            self.activityLog.emit(f"[种子] 失败：{summary}")
            show_async_failure(self, "生成失败", summary, detail)

        def _done_cancel() -> None:
            _close_progress()
            self.set_long_task_busy(False, "")
            self.activityLog.emit("[种子] 已由用户取消")
            QMessageBox.information(self, "已取消", "生成种子已取消。")

        worker.signals.finished.connect(_done_ok)
        worker.signals.error.connect(_done_err)
        worker.signals.cancelled.connect(_done_cancel)

        def _on_cancel() -> None:
            cancel_flag.set()
            worker.request_cancel()
            self.activityLog.emit("[种子] 收到取消请求，正在中断…")

        progress.canceled.connect(_on_cancel)
        self.set_long_task_busy(True, "seed")
        self.activityLog.emit("[种子] 已启动后台任务（界面不应再卡住，可点「取消」）")
        progress.show()
        self._pool.start(worker)

    def _fill_demo_seed_json(self) -> None:
        d = _demo_seed_draft()
        self._last_seed = d
        self._seed_preview.setPlainText(d.model_dump_json(indent=2))
        self._refresh_seed_readable()

    def _try_parse_seed_editor(self, *, quiet: bool) -> bool:
        raw = self._seed_preview.toPlainText().strip()
        if not raw:
            if not quiet:
                QMessageBox.warning(
                    self,
                    "提示",
                    "编辑区为空。可点「填入演示 JSON」，或粘贴符合 SeedDraft 结构的 JSON 后再解析。",
                )
            return False
        try:
            data = json.loads(raw)
            self._last_seed = SeedDraft.model_validate(data)
            self._seed_preview.setPlainText(self._last_seed.model_dump_json(indent=2))
            self._refresh_seed_readable()
            return True
        except Exception as e:
            if not quiet:
                log_messagebox_critical("JSON 无效", exc_human(e), exc=e)
                QMessageBox.critical(self, "JSON 无效", exc_human(e))
            return False

    def _parse_seed_from_editor(self) -> None:
        if self._try_parse_seed_editor(quiet=False):
            QMessageBox.information(
                self,
                "已解析",
                "已载入为当前种子。若需入库请点「将当前种子写入 run 数据库」。",
            )

    def _apply_seed(self) -> None:
        if not self._db:
            QMessageBox.warning(self, "提示", "请先打开或新建 run。")
            return
        if not self._last_seed and self._seed_preview.toPlainText().strip():
            self._try_parse_seed_editor(quiet=True)
        if not self._last_seed:
            QMessageBox.warning(
                self,
                "提示",
                "没有可用的种子：请「从蓝图生成」、点「填入演示 JSON」并「解析」，或直接「插入演示 NPC」。",
            )
            return
        apply_seed_draft(self._db.conn, self._last_seed)
        self._db.conn.commit()
        self._reload_tier_table()
        QMessageBox.information(self, "完成", "种子已写入数据库。")
        self.seedApplied.emit()

    def _insert_demo(self) -> None:
        if not self._db:
            QMessageBox.warning(self, "提示", "请先打开 run。")
            return
        draft = _demo_seed_draft()
        apply_seed_draft(self._db.conn, draft)
        set_agent_tier(self._db.conn, "hero_guan", NpcTier.S)
        set_agent_tier(self._db.conn, "boss_pao", NpcTier.A)
        self._db.conn.commit()
        self._last_seed = draft
        self._seed_preview.setPlainText(draft.model_dump_json(indent=2))
        self._refresh_seed_readable()
        self._reload_tier_table()
        QMessageBox.information(self, "完成", "已插入演示 NPC。")
        self.seedApplied.emit()

    def _on_week_spin_changed(self, _value: int) -> None:
        if self._week_spin_end.value() < self._week_spin.value():
            self._week_spin_end.setValue(self._week_spin.value())

    def _emit_run_week(self) -> None:
        if self._long_task_busy:
            self.activityLog.emit("已有任务在执行，已忽略本次「运行该周」。")
            return
        self.requestRunWeek.emit(self._week_spin.value())

    def _emit_run_week_range(self) -> None:
        if self._long_task_busy:
            self.activityLog.emit("已有任务在执行，已忽略批量周次。")
            return
        start_w = self._week_spin.value()
        end_w = self._week_spin_end.value()
        if end_w < start_w:
            QMessageBox.warning(self, "提示", "结束周次不能小于起始周次，已改为与起始相同。")
            end_w = start_w
            self._week_spin_end.setValue(end_w)
        self.requestRunWeekRange.emit(start_w, end_w)

    def _rollback_db_snapshot(self) -> None:
        if not self._run_dir:
            return
        wk = self._rollback_week.value()
        src = self._run_dir / "snapshots" / f"week_{wk:03d}.db"
        dst = self._run_dir / "run.db"
        if not src.is_file():
            log_messagebox_warning("无快照", str(src))
            QMessageBox.warning(self, "无快照", str(src))
            return
        if self._db:
            self._db.close()
            self._db = None
        shutil.copy2(src, dst)
        self._db = open_database(self._run_dir)
        QMessageBox.information(self, "完成", f"已用 {src.name} 覆盖 run.db，请重新检查 Tier/数据。")
        self._load_run(self._run_dir)
        self.runChanged.emit(self._run_dir)
        self.seedApplied.emit()

    def _validate_merged_llm_config(self, cfg: dict[str, Any]) -> None:
        json.dumps(cfg)
        http = cfg.get("http")
        if http is not None and not isinstance(http, dict):
            raise ValueError("http 必须是 JSON 对象")
        aud = cfg.get("llm_audit")
        if aud is not None and not isinstance(aud, dict):
            raise ValueError("llm_audit 必须是 JSON 对象")
        for key in agent_llm_config_keys():
            provider_profile_for_agent(key, cfg)
        sem = cfg.get("semantic_memory")
        if isinstance(sem, dict) and sem.get("strict"):
            if embedding_profile_from_config(cfg) is None:
                raise ValueError(
                    "「语义记忆」已开启 strict，但未找到可用的嵌入配置（请配置嵌入或确保某档 NPC/默认对话可推导嵌入）。"
                )

    def _save_llm_config(self) -> None:
        if not self._db:
            return
        cfg = self._merged_llm_config()
        if not self._chk_skip_llm_validate.isChecked():
            try:
                self._validate_merged_llm_config(cfg)
            except (TypeError, ValueError) as e:
                log_messagebox_critical("LLM 配置未通过校验", exc_human(e), exc=e)
                QMessageBox.critical(self, "校验失败", exc_human(e))
                return
        self._db.conn.execute(
            "UPDATE runs SET llm_config_json = ? WHERE 1=1",
            (json.dumps(cfg, ensure_ascii=False),),
        )
        self._db.conn.commit()
        self._refresh_llm_preview()
        self.llmConfigSaved.emit(cfg)
        QMessageBox.information(self, "已保存", "LLM 与代理相关字段已写入 runs 表。")

    def _save_proxy_only(self) -> None:
        if not self._db:
            QMessageBox.warning(self, "提示", "请先打开或新建 run。")
            return
        cfg = self._merged_llm_config()
        if not self._chk_skip_llm_validate.isChecked():
            try:
                self._validate_merged_llm_config(cfg)
            except (TypeError, ValueError) as e:
                log_messagebox_critical("LLM 配置未通过校验", exc_human(e), exc=e)
                QMessageBox.critical(self, "校验失败", exc_human(e))
                return
        self._db.conn.execute(
            "UPDATE runs SET llm_config_json = ? WHERE 1=1",
            (json.dumps(cfg, ensure_ascii=False),),
        )
        self._db.conn.commit()
        self._refresh_llm_preview()
        self.llmConfigSaved.emit(cfg)
        QMessageBox.information(self, "已保存", "代理与当前 LLM 表单已写入 runs 表。")

    def _test_chat_connection(self) -> None:
        cfg_snap = copy.deepcopy(self._merged_llm_config())
        sel_key = self._llm_form.selected_agent_config_key()

        async def run(cancel_flag: threading.Event) -> str:
            def slog(m: str) -> None:
                self.activityLog.emit(m)

            cfg = cfg_snap
            key = sel_key
            slog(f"[推理测试] 开始（列表选中槽位：{key}，遵守覆盖默认）")
            prof = provider_profile_for_agent(key, cfg)
            if prof.kind == "stub":
                slog("[推理测试] Stub，未请求网络")
                return f"推理（{key}）：Stub，未发起网络请求。"
            slog("[推理测试] 正在请求对话接口…")
            llm = ClientFactory.build_for_agent("connectivity_test_chat", prof, cfg)
            try:
                r = await llm.chat(
                    _CONNECTIVITY_CHAT_MESSAGES,
                    temperature=_CONNECTIVITY_CHAT_TEMPERATURE,
                )
                t = (r.text or "").strip()
                snippet = t[:160] + ("…" if len(t) > 160 else "")
                slog(f"[推理测试] 成功，回复长度 {len(t)}")
                if cancel_flag.is_set():
                    raise asyncio.CancelledError()
                return f"推理（{key}）：成功，回复预览：{snippet or '（空）'}"
            finally:
                await llm.aclose()

        self._launch_llm_connectivity_task(
            busy_kind="test_chat",
            progress_label="正在测试推理（对话）接口…",
            window_title="推理连接测试",
            result_box_title="推理测试结果",
            fail_box_title="推理测试失败",
            cancel_toast="推理测试已取消。",
            log_cancel="[推理测试] 已由用户取消",
            run=run,
        )

    def _test_agent_slot_connection(self, slot_key: str) -> None:
        cfg_snap = copy.deepcopy(self._merged_llm_config())

        async def run(cancel_flag: threading.Event) -> str:
            def slog(m: str) -> None:
                self.activityLog.emit(m)

            cfg = cfg_snap
            slog(f"[推理测试·槽位] {slot_key}（遵守覆盖默认规则）")
            prof = provider_profile_for_agent(slot_key, cfg)
            if prof.kind == "ollama":
                slog(f"[推理测试] 解析端点：Ollama host={prof.ollama_host!r} model={prof.model!r}")
            elif prof.kind == "openai_compat":
                slog(f"[推理测试] 解析端点：base={prof.base_url!r} model={prof.model!r}")
            if prof.kind == "stub":
                slog("[推理测试] Stub，未请求网络")
                return f"推理（{slot_key}）：Stub，未发起网络请求。"
            slog("[推理测试] 正在请求对话接口…")
            llm = ClientFactory.build_for_agent("connectivity_test_chat", prof, cfg)
            try:
                r = await llm.chat(
                    _CONNECTIVITY_CHAT_MESSAGES,
                    temperature=_CONNECTIVITY_CHAT_TEMPERATURE,
                )
                t = (r.text or "").strip()
                snippet = t[:160] + ("…" if len(t) > 160 else "")
                slog(f"[推理测试] 成功，回复长度 {len(t)}")
                if cancel_flag.is_set():
                    raise asyncio.CancelledError()
                return f"推理（{slot_key}）：成功，回复预览：{snippet or '（空）'}"
            finally:
                await llm.aclose()

        self._launch_llm_connectivity_task(
            busy_kind="test_chat",
            progress_label=f"正在测试槽位「{slot_key}」对话接口…",
            window_title="推理连接测试",
            result_box_title="推理测试结果",
            fail_box_title="推理测试失败",
            cancel_toast="推理测试已取消。",
            log_cancel="[推理测试] 已由用户取消",
            run=run,
        )

    def _test_embedding_connection(self) -> None:
        cfg_snap = copy.deepcopy(self._merged_llm_config())

        async def run(cancel_flag: threading.Event) -> str:
            def slog(m: str) -> None:
                self.activityLog.emit(m)

            cfg = cfg_snap
            slog("[嵌入测试] 开始（仅表单「嵌入」区，不从对话推导）")
            eprof = embedding_profile_explicit_only(cfg)
            if eprof is None:
                slog("[嵌入测试] 未配置独立嵌入，未请求网络")
                return (
                    "嵌入：当前未启用独立嵌入（表单顶部「方式」为关闭或未写入 embeddings）。\n"
                    "请选择 Ollama 或 OpenAI 兼容并填写地址与模型后再测。\n"
                    "说明：本按钮不会使用 NPC/默认对话配置来推导嵌入。"
                )
            eb = ClientFactory.build_embedding_backend(eprof, cfg)
            if eb is None:
                slog("[嵌入测试] 无法构建嵌入后端")
                return "嵌入：当前配置无法构建后端（请检查「方式」与必填字段）。"
            slog("[嵌入测试] 正在请求嵌入接口…")
            try:
                vecs = await eb.embed(["ping"])
                dim = len(vecs[0]) if vecs and vecs[0] else 0
                slog(f"[嵌入测试] 成功，向量维度 {dim}")
                if cancel_flag.is_set():
                    raise asyncio.CancelledError()
                return f"嵌入：成功，向量维度 {dim}。"
            finally:
                await eb.aclose()

        self._launch_llm_connectivity_task(
            busy_kind="test_embed",
            progress_label="正在测试嵌入接口…",
            window_title="嵌入连接测试",
            result_box_title="嵌入测试结果",
            fail_box_title="嵌入测试失败",
            cancel_toast="嵌入测试已取消。",
            log_cancel="[嵌入测试] 已由用户取消",
            run=run,
        )

    def _launch_llm_connectivity_task(
        self,
        *,
        busy_kind: str,
        progress_label: str,
        window_title: str,
        result_box_title: str,
        fail_box_title: str,
        cancel_toast: str,
        log_cancel: str,
        run: Callable[[threading.Event], Awaitable[str]],
    ) -> None:
        if self._long_task_busy:
            self.activityLog.emit("已有任务在执行，已忽略本次测试。")
            return

        cancel_flag = threading.Event()

        async def _go() -> str:
            return await run(cancel_flag)

        progress = QProgressDialog(progress_label, "取消", 0, 0, self)
        progress.setWindowTitle(window_title)
        progress.setWindowModality(Qt.WindowModality.WindowModal)
        progress.setMinimumDuration(0)
        progress.setMinimumWidth(380)

        worker = CancellableAsyncWorker(_go())

        def _close_progress() -> None:
            progress.reset()
            progress.close()

        def _done_ok(msg: str) -> None:
            _close_progress()
            self.set_long_task_busy(False, "")
            nonempty_information(
                self,
                result_box_title,
                msg,
                empty_fallback="测试结束，但未产生文本输出。",
            )

        def _done_err(summary: str, detail: str) -> None:
            _close_progress()
            self.set_long_task_busy(False, "")
            self.activityLog.emit(f"[{window_title}] 失败：{summary}")
            show_async_failure(self, fail_box_title, summary, detail)

        def _done_cancel() -> None:
            _close_progress()
            self.set_long_task_busy(False, "")
            self.activityLog.emit(log_cancel)
            QMessageBox.information(self, "已取消", cancel_toast)

        worker.signals.finished.connect(_done_ok)
        worker.signals.error.connect(_done_err)
        worker.signals.cancelled.connect(_done_cancel)

        def _on_cancel() -> None:
            cancel_flag.set()
            worker.request_cancel()
            self.activityLog.emit(f"[{window_title}] 收到取消请求…")

        progress.canceled.connect(_on_cancel)
        progress.show()
        self.set_long_task_busy(True, busy_kind)
        self._pool.start(worker)
