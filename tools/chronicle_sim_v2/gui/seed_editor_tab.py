"""种子编辑标签页：JSON 编辑 + 生成 + 写入世界 + Tier 管理 + LLM 配置。"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from PySide6.QtCore import Qt, QThreadPool, Signal
from PySide6.QtWidgets import (
    QHBoxLayout, QHeaderView, QLabel, QPushButton, QMessageBox,
    QSplitter, QTableWidget, QTableWidgetItem, QTextEdit, QVBoxLayout, QWidget,
)

from tools.chronicle_sim_v2.core.sim.run_manager import create_run, list_runs, load_llm_config
from tools.chronicle_sim_v2.core.world.seed_writer import write_seed_to_fs, validate_seed_agents
from tools.chronicle_sim_v2.core.world.seed_reader import read_all_agents
from tools.chronicle_sim_v2.core.world.fs import read_json, write_json, delete_json
from tools.chronicle_sim_v2.gui.app_settings import save_last_run_path, load_last_run_path
from tools.chronicle_sim_v2.gui.async_runnable import CancellableAsyncWorker
from tools.chronicle_sim_v2.gui.llm_config_form import LlmConfigForm


class SeedEditorTab(QWidget):
    log_signal = Signal(str)
    run_changed = Signal(object)

    def __init__(self) -> None:
        super().__init__()
        self._run_dir: Path | None = None
        self._llm_config: dict = {}
        self._llm_dirty = False  # 标记 LLM 配置是否已修改未保存
        self._gen_worker: CancellableAsyncWorker | None = None

        layout = QVBoxLayout(self)

        # 主内容：左右分割
        main_splitter = QSplitter(Qt.Horizontal)

        # === 左侧：种子 JSON 编辑 + Tier 表 ===
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 0, 0)

        left_layout.addWidget(QLabel("SeedDraft JSON:"))
        self.seed_json = QTextEdit()
        self.seed_json.setPlaceholderText("在此粘贴种子 JSON，或点击生成...")
        self.seed_json.textChanged.connect(self._on_seed_changed)
        left_layout.addWidget(self.seed_json)

        # 种子工具栏
        seed_toolbar = QHBoxLayout()
        self.btn_parse = QPushButton("解析校验")
        self.btn_parse.clicked.connect(self._parse_seed)
        seed_toolbar.addWidget(self.btn_parse)
        self.btn_generate = QPushButton("从设定库生成")
        self.btn_generate.clicked.connect(self._generate_from_ideas)
        seed_toolbar.addWidget(self.btn_generate)
        self.btn_write = QPushButton("写入世界")
        self.btn_write.clicked.connect(self._write_seed)
        seed_toolbar.addWidget(self.btn_write)
        self.btn_demo = QPushButton("演示模板")
        self.btn_demo.clicked.connect(self._fill_demo)
        seed_toolbar.addWidget(self.btn_demo)
        seed_toolbar.addStretch()
        left_layout.addLayout(seed_toolbar)

        # Tier 表
        left_layout.addWidget(QLabel("NPC 列表:"))
        self.tier_table = QTableWidget()
        self.tier_table.setColumnCount(4)
        self.tier_table.setHorizontalHeaderLabels(["ID", "名称", "当前 Tier", "生命状态"])
        self.tier_table.horizontalHeader().setStretchLastSection(True)
        self.tier_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.ResizeToContents)
        self.tier_table.horizontalHeader().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        left_layout.addWidget(self.tier_table)

        tier_toolbar = QHBoxLayout()
        self.btn_refresh_agents = QPushButton("刷新")
        self.btn_refresh_agents.clicked.connect(self._refresh_agents)
        tier_toolbar.addWidget(self.btn_refresh_agents)
        self.btn_delete_agent = QPushButton("删除选中")
        self.btn_delete_agent.clicked.connect(self._delete_selected_agent)
        tier_toolbar.addWidget(self.btn_delete_agent)
        self.btn_save_tiers = QPushButton("保存 Tier")
        self.btn_save_tiers.clicked.connect(self._save_tiers)
        tier_toolbar.addWidget(self.btn_save_tiers)
        tier_toolbar.addStretch()
        left_layout.addLayout(tier_toolbar)

        main_splitter.addWidget(left)

        # === 右侧：LLM 配置 + 可读预览 ===
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)

        self.llm_form = LlmConfigForm()
        self.llm_form.changed.connect(self._on_llm_changed)
        self.llm_form.agent_connection_test_requested.connect(self._test_agent_connection)
        self.llm_form.embedding_test_requested.connect(self._test_embedding)
        right_layout.addWidget(QLabel("LLM 配置:"))
        right_layout.addWidget(self.llm_form)

        # 连接测试结果区
        self.test_result = QTextEdit()
        self.test_result.setReadOnly(True)
        self.test_result.setMaximumHeight(120)
        self.test_result.setPlaceholderText("点击「测试本槽连接」后的结果会显示在这里…")
        right_layout.addWidget(QLabel("测试结果:"))
        right_layout.addWidget(self.test_result)

        llm_toolbar = QHBoxLayout()
        self.btn_save_llm = QPushButton("保存 LLM 配置")
        self.btn_save_llm.clicked.connect(self._save_llm)
        llm_toolbar.addWidget(self.btn_save_llm)
        llm_toolbar.addStretch()
        right_layout.addLayout(llm_toolbar)

        right_layout.addWidget(QLabel("可读预览:"))
        self.preview = QTextEdit()
        self.preview.setReadOnly(True)
        right_layout.addWidget(self.preview)

        main_splitter.addWidget(right)
        main_splitter.setStretchFactor(0, 1)
        main_splitter.setStretchFactor(1, 1)
        layout.addWidget(main_splitter)

    def set_run_dir(self, run_dir: Path | None, llm_config: dict | None = None) -> None:
        self._run_dir = run_dir
        self._llm_dirty = False
        if run_dir:
            self._refresh_agents()
            # 加载 LLM 配置
            if llm_config:
                self._llm_config = llm_config
            else:
                self._llm_config = load_llm_config(run_dir)
            self.llm_form.set_from_dict(self._llm_config)
            # 尝试加载已有种子
            from tools.chronicle_sim_v2.core.world.fs import read_json, list_dir as fs_list
            ws = read_json(run_dir, "world/world_setting.json")
            agents = read_all_agents(run_dir)
            factions = []
            for f in fs_list(run_dir, "world/factions"):
                data = read_json(run_dir, f"world/factions/{f}")
                if data:
                    factions.append(data)
            seed = {
                "world_setting": ws,
                "agents": agents,
                "factions": factions,
            }
            self.seed_json.setPlainText(json.dumps(seed, ensure_ascii=False, indent=2))
            self._update_preview(seed)
        else:
            self.seed_json.clear()
            self.preview.clear()

    def _on_seed_changed(self) -> None:
        # 实时解析校验
        text = self.seed_json.toPlainText().strip()
        if not text:
            return
        try:
            data = json.loads(text)
            self._update_preview(data)
        except json.JSONDecodeError:
            pass  # 输入中，忽略

    def _on_llm_changed(self) -> None:
        self._llm_dirty = True

    def _load_run_dialog(self) -> None:
        """显示 Run 选择对话框。"""
        runs = list_runs()
        if not runs:
            self.log_signal.emit("没有可用的 run，请先新建")
            return
        # 构建显示列表
        names = []
        for r in runs:
            name = r.get("name", r.get("run_id", ""))
            rid = r.get("run_id", "")
            names.append(f"{name} ({rid})")
        from PySide6.QtWidgets import QInputDialog
        name, ok = QInputDialog.getItem(
            self, "加载 Run", "选择要加载的 Run:", names, 0, False
        )
        if not ok:
            return
        # 提取 run_id
        for r in runs:
            rname = r.get("name", r.get("run_id", ""))
            rid = r.get("run_id", "")
            if f"{rname} ({rid})" == name:
                from tools.chronicle_sim_v2.paths import RUNS_DIR
                run_dir = RUNS_DIR / rid
                if run_dir.is_dir():
                    self._set_run_dir(run_dir)
                    self.log_signal.emit(f"加载 run: {rname}")
                break

    def _new_run(self) -> None:
        from PySide6.QtWidgets import QInputDialog
        name, ok = QInputDialog.getText(self, "新建 Run", "Run 名称:")
        if ok and name.strip():
            run_id, run_dir = create_run(name.strip())
            self._set_run_dir(run_dir)
            self.log_signal.emit(f"创建 run: {name} ({run_id})")

    def _set_run_dir(self, run_dir: Path) -> None:
        self._run_dir = run_dir
        save_last_run_path(str(run_dir))
        self._llm_config = load_llm_config(run_dir)
        self._llm_dirty = False
        self.llm_form.set_from_dict(self._llm_config)
        self._refresh_agents()
        self.run_changed.emit(run_dir)

    def _parse_seed(self) -> None:
        try:
            data = json.loads(self.seed_json.toPlainText())
            self.log_signal.emit("种子 JSON 格式正确")
            self._update_preview(data)
        except json.JSONDecodeError as e:
            self.log_signal.emit(f"JSON 解析失败: {e}")

    def _write_seed(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        try:
            data = json.loads(self.seed_json.toPlainText())
        except json.JSONDecodeError as e:
            self.log_signal.emit(f"JSON 解析失败: {e}")
            return
        # 重名 / 重 ID 校验
        issues = validate_seed_agents(data)
        if issues:
            warn_lines = ["发现以下问题："]
            for issue in issues:
                warn_lines.append(f"  ⚠ {issue}")
            reply = QMessageBox.warning(
                self, "种子校验警告",
                "\n".join(warn_lines) + "\n\n是否继续写入？",
                QMessageBox.Yes | QMessageBox.No,
                QMessageBox.No,
            )
            if reply != QMessageBox.Yes:
                return
            self.log_signal.emit("用户确认忽略校验问题，继续写入")
        write_seed_to_fs(self._run_dir, data)
        self.log_signal.emit("种子已写入世界目录")
        self._refresh_agents()

    def _fill_demo(self) -> None:
        demo = {
            "world_setting": {
                "era": "民国川渝",
                "description": "江水滔滔，袍哥人家。茶馆酒肆，脚帮码头。",
                "supernatural_level": "low",
            },
            "agents": [
                {"id": "npc_guan", "name": "关二狗", "current_tier": "S", "life_status": "alive", "personality": "豪爽仗义"},
                {"id": "npc_liu", "name": "刘三娘", "current_tier": "S", "life_status": "alive", "personality": "精明干练"},
                {"id": "npc_zhang", "name": "张老幺", "current_tier": "A", "life_status": "alive", "personality": "圆滑世故"},
                {"id": "npc_wang", "name": "王大锤", "current_tier": "B", "life_status": "alive", "personality": "憨厚老实"},
            ],
            "factions": [
                {"id": "fac_paoge", "name": "袍哥会", "description": "川渝民间帮会"},
                {"id": "fac_jiaobang", "name": "脚帮", "description": "码头苦力组织"},
            ],
            "locations": [
                {"id": "loc_teahouse", "name": "望江茶馆", "description": "码头边的老茶馆"},
                {"id": "loc_dock", "name": "朝天门码头", "description": "重庆最繁忙的水陆码头"},
            ],
            "design_pillars": ["川渝方言", "民国市井", "克制志怪"],
        }
        self.seed_json.setPlainText(json.dumps(demo, ensure_ascii=False, indent=2))
        self._update_preview(demo)

    def _generate_from_ideas(self) -> None:
        """从设定库生成种子（后台线程跑 asyncio，避免卡死主界面）。"""
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        from tools.chronicle_sim_v2.core.world.idea_library import build_ideas_blob, list_ideas

        ideas = list_ideas(self._run_dir)
        if not ideas:
            self.log_signal.emit("设定库为空，请先导入 MD 文件")
            return
        llm_config = load_llm_config(self._run_dir)
        default_cfg = llm_config.get("default", {})
        kind = str(default_cfg.get("kind", "")).lower()
        if kind == "stub":
            self.log_signal.emit(
                "未配置 LLM：请先在「LLM 配置」中设置 default 槽位并点击「保存 LLM 配置」"
                "（模拟与生成均从磁盘 config/llm_config.json 读取）。"
            )
            return

        run_dir = self._run_dir

        self.log_signal.emit(
            "[种子生成] 已提交后台任务（主窗口不应再卡死）；进度见本日志，"
            "若长时间停在「等待 LLM」属正常，请等 HTTP 返回。"
        )
        self.btn_generate.setEnabled(False)

        async def _run_gen():
            from tools.chronicle_sim_v2.core.agents.initializer_agent import (
                build_initializer_pa,
                run_initializer,
            )

            def _log(msg: str) -> None:
                self.log_signal.emit(msg)

            _log("[种子生成] 后台协程已启动…")
            _log("[种子生成] 正在聚合设定库文本（build_ideas_blob）…")
            ideas_blob = build_ideas_blob(run_dir)
            _log(f"[种子生成] 设定库聚合完成，约 {len(ideas_blob)} 字符。")

            pa = build_initializer_pa(llm_config, run_dir)
            try:
                result = await run_initializer(
                    pa,
                    run_dir,
                    ideas_blob,
                    log_callback=_log,
                )
                return result
            except Exception as exc:
                raw_full = ""
                if hasattr(exc, "raw_text"):
                    raw_full = str(exc.raw_text)
                elif hasattr(exc, "preview"):
                    raw_full = str(exc.preview)
                if raw_full:
                    self.log_signal.emit("--- LLM 原始输出 ---")
                    self.log_signal.emit(raw_full)
                    self.log_signal.emit("--- 输出结束 ---")
                raise
            finally:
                await pa.aclose()

        self._gen_worker = CancellableAsyncWorker(_run_gen())
        self._gen_worker.signals.finished.connect(self._on_seed_generate_finished)
        self._gen_worker.signals.error.connect(self._on_seed_generate_error)
        self._gen_worker.signals.cancelled.connect(self._on_seed_generate_cancelled)
        QThreadPool.globalInstance().start(self._gen_worker)

    def _on_seed_generate_finished(self, result: object) -> None:
        self._gen_worker = None
        self.btn_generate.setEnabled(True)
        try:
            if isinstance(result, dict):
                seed_json_text = json.dumps(result, ensure_ascii=False, indent=2)
                self.seed_json.setPlainText(seed_json_text)
                try:
                    self._update_preview(result)
                except Exception:
                    pass
                self.log_signal.emit("[种子生成] 成功，已填入左侧 JSON。")
            else:
                self.log_signal.emit(f"[种子生成] 完成但结果类型异常: {type(result)!r}")
        except Exception as e:
            self.log_signal.emit(f"[种子生成] 写入界面失败: {e}")

    def _on_seed_generate_error(self, summary: str, detail: str) -> None:
        self._gen_worker = None
        self.btn_generate.setEnabled(True)
        self.log_signal.emit(f"[种子生成] 失败: {summary}")
        if detail.strip():
            self.log_signal.emit(detail)

    def _on_seed_generate_cancelled(self) -> None:
        self._gen_worker = None
        self.btn_generate.setEnabled(True)
        self.log_signal.emit("[种子生成] 已取消")

    def _update_preview(self, data: dict) -> None:
        parts = []
        ws = data.get("world_setting", {})
        if isinstance(ws, dict):
            desc = ws.get("description", ws.get("name", ""))
            if desc:
                parts.append(f"世界: {desc}")
        agents = data.get("agents", [])
        if agents:
            parts.append(f"NPC ({len(agents)} 个):")
            for a in agents:
                name = a.get("name", a.get("id", "?"))
                tier = a.get("current_tier", a.get("tier", a.get("suggested_tier", "?")))
                parts.append(f"  [{tier}] {name}")
        factions = data.get("factions", [])
        if factions:
            parts.append(f"势力 ({len(factions)} 个):")
            for f in factions:
                parts.append(f"  - {f.get('name', '?')}")
        self.preview.setPlainText("\n\n".join(parts))

    def _refresh_agents(self) -> None:
        if not self._run_dir:
            return
        agents = read_all_agents(self._run_dir)
        self.tier_table.setRowCount(0)
        for i, a in enumerate(agents):
            self.tier_table.insertRow(i)
            aid = a.get("id", a.get("name", "?"))
            name = a.get("name", a.get("id", "?"))
            tier = a.get("current_tier", a.get("tier", a.get("suggested_tier", "B")))
            life = a.get("life_status", "alive")
            self.tier_table.setItem(i, 0, QTableWidgetItem(str(aid)))
            self.tier_table.setItem(i, 1, QTableWidgetItem(str(name)))

            # Tier 下拉框
            from PySide6.QtWidgets import QComboBox
            combo = QComboBox()
            combo.addItems(["S", "A", "B", "C"])
            combo.setCurrentText(str(tier).upper())
            self.tier_table.setCellWidget(i, 2, combo)

            # 生命状态下拉框
            life_combo = QComboBox()
            life_combo.addItems(["alive", "dead", "missing"])
            life_combo.setCurrentText(str(life))
            self.tier_table.setCellWidget(i, 3, life_combo)

    def _delete_selected_agent(self) -> None:
        if not self._run_dir:
            return
        selected_rows = self.tier_table.selectionModel().selectedRows()
        if not selected_rows:
            QMessageBox.information(self, "提示", "请先选择要删除的 NPC 行")
            return
        ids_to_delete = []
        for idx in selected_rows:
            row = idx.row()
            aid_item = self.tier_table.item(row, 0)
            if aid_item:
                ids_to_delete.append(aid_item.text())
        if not ids_to_delete:
            return
        msg = "确定要删除以下 NPC 吗？\n" + "\n".join(f"  - {aid}" for aid in ids_to_delete)
        reply = QMessageBox.question(self, "确认删除", msg)
        if reply != QMessageBox.Yes:
            return
        deleted = 0
        for aid in ids_to_delete:
            agent_path = f"world/agents/{aid}.json"
            if delete_json(self._run_dir, agent_path):
                deleted += 1
        if deleted > 0:
            self.log_signal.emit(f"已删除 {deleted} 个 NPC")
            self._refresh_agents()

    def _save_tiers(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        from tools.chronicle_sim_v2.core.world.fs import read_json
        saved = 0
        for row in range(self.tier_table.rowCount()):
            aid_item = self.tier_table.item(row, 0)
            if not aid_item:
                continue
            aid = aid_item.text()
            tier_combo = self.tier_table.cellWidget(row, 2)
            life_combo = self.tier_table.cellWidget(row, 3)
            if tier_combo:
                new_tier = tier_combo.currentText()
                agent_file = f"world/agents/{aid}.json"
                data = read_json(self._run_dir, agent_file)
                if data:
                    old = str(data.get("current_tier", data.get("tier", "B")))
                    if str(new_tier).upper() != str(old).upper():
                        data["current_tier"] = new_tier
                        data["tier"] = new_tier
                        saved += 1
                if life_combo:
                    if data:
                        data["life_status"] = life_combo.currentText()
                    from tools.chronicle_sim_v2.core.world.fs import write_json
                    if data:
                        write_json(self._run_dir, agent_file, data)
        if saved > 0:
            self.log_signal.emit(f"Tier 已保存（{saved} 个 NPC 变更）")
        else:
            self.log_signal.emit("Tier 已保存（无变更）")

    def _save_llm(self) -> None:
        if not self._run_dir:
            self.log_signal.emit("请先选择一个 Run")
            return
        new_config = self.llm_form.to_dict()
        old_emb = self._llm_config.get("embeddings")
        new_emb = new_config.get("embeddings")
        self._llm_config = new_config
        from tools.chronicle_sim_v2.core.sim.run_manager import save_llm_config
        save_llm_config(self._run_dir, self._llm_config)
        self._llm_dirty = False
        self.log_signal.emit("LLM 配置已保存")
        if old_emb != new_emb:
            QMessageBox.information(self, "嵌入配置变更",
                "嵌入模型配置已更新。已导入的数据仍使用旧的向量索引。\n"
                "请前往「设定库」和「编年史」标签页，点击「重建索引」以刷新。")

    def _test_agent_connection(self, slot_key: str) -> None:
        """测试指定槽位的 LLM 连接。"""
        cfg = self.llm_form.to_dict()
        # 获取该槽位的实际配置（考虑覆盖默认规则）
        block = cfg.get(slot_key, {})
        is_override = block.get("override", False) if slot_key != "default" else True
        if is_override:
            kind = str(block.get("kind", "stub")).lower()
            model = block.get("model", "")
            base_url = block.get("base_url", "")
            api_key = block.get("api_key", "")
            ollama_host = block.get("ollama_host", "")
        else:
            # 使用默认配置
            default = cfg.get("default", {})
            kind = str(default.get("kind", "stub")).lower()
            model = default.get("model", "")
            base_url = default.get("base_url", "")
            api_key = default.get("api_key", "")
            ollama_host = default.get("ollama_host", "")

        self.test_result.setPlainText(f"[{slot_key}] 正在测试… kind={kind}, model={model}")

        if kind == "stub":
            self.test_result.setPlainText(f"[{slot_key}] Stub（离线占位），未请求网络。")
            return

        # 异步测试连接
        async def _do():
            import httpx
            try:
                if kind == "openai_compat":
                    if not base_url.endswith("/chat/completions"):
                        endpoint = base_url.rstrip("/") + "/chat/completions"
                    else:
                        endpoint = base_url
                    self.test_result.setPlainText(f"[{slot_key}] 请求 OpenAI 兼容 API: {endpoint}\nmodel={model}")
                    async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
                        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
                        payload = {
                            "model": model,
                            "messages": [{"role": "user", "content": "hi"}],
                            "max_tokens": 10,
                        }
                        resp = await client.post(endpoint, json=payload, headers=headers)
                        resp.raise_for_status()
                        data = resp.json()
                        reply = data.get("choices", [{}])[0].get("message", {}).get("content", "")[:100]
                        self.test_result.setPlainText(f"[{slot_key}] 连接成功！\nmodel={model}\n回复: {reply}")
                elif kind == "ollama":
                    host = ollama_host.rstrip("/")
                    endpoint = f"{host}/api/chat"
                    self.test_result.setPlainText(f"[{slot_key}] 请求 Ollama: {endpoint}\nmodel={model}")
                    async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
                        payload = {"model": model, "messages": [{"role": "user", "content": "hi"}], "stream": False}
                        resp = await client.post(endpoint, json=payload)
                        resp.raise_for_status()
                        data = resp.json()
                        reply = data.get("message", {}).get("content", "")[:100]
                        self.test_result.setPlainText(f"[{slot_key}] 连接成功！\nmodel={model}\n回复: {reply}")
            except httpx.TimeoutException:
                self.test_result.setPlainText(f"[{slot_key}] 超时（30s）。检查地址和代理。")
            except httpx.ConnectError as e:
                self.test_result.setPlainText(f"[{slot_key}] 连接失败: {e}")
            except Exception as e:
                body = str(e)
                if hasattr(e, 'response') and e.response:
                    body = e.response.text[:300]
                self.test_result.setPlainText(f"[{slot_key}] 请求失败:\n{body}")

        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_do())
        finally:
            loop.close()

    def _test_embedding(self) -> None:
        """测试嵌入模型连接。"""
        cfg = self.llm_form.to_dict()
        emb = cfg.get("embeddings", {})
        kind = str(emb.get("kind", "")).lower()

        if not kind:
            self.test_result.setPlainText("[嵌入] 未配置嵌入模型。请选择 OpenAI 兼容 API 或 Ollama。")
            return

        model = emb.get("model", "")
        base_url = emb.get("base_url", "")
        api_key = emb.get("api_key", "")
        ollama_host = emb.get("ollama_host", "")

        async def _do():
            import httpx
            try:
                if kind == "openai_compat":
                    endpoint = base_url.rstrip("/") + "/embeddings"
                    self.test_result.setPlainText(f"[嵌入] 请求 OpenAI 兼容 API: {endpoint}\nmodel={model}")
                    async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
                        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
                        payload = {"model": model, "input": ["test embedding"]}
                        resp = await client.post(endpoint, json=payload, headers=headers)
                        resp.raise_for_status()
                        data = resp.json()
                        dims = len(data.get("data", [{}])[0].get("embedding", []))
                        self.test_result.setPlainText(f"[嵌入] 连接成功！\nmodel={model}\n向量维度: {dims}")
                elif kind == "ollama":
                    host = ollama_host.rstrip("/")
                    endpoint = f"{host}/api/embed"
                    self.test_result.setPlainText(f"[嵌入] 请求 Ollama: {endpoint}\nmodel={model}")
                    async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
                        payload = {"model": model, "input": ["test embedding"]}
                        resp = await client.post(endpoint, json=payload)
                        resp.raise_for_status()
                        data = resp.json()
                        dims = len(data.get("embeddings", [[]])[0])
                        self.test_result.setPlainText(f"[嵌入] 连接成功！\nmodel={model}\n向量维度: {dims}")
            except httpx.TimeoutException:
                self.test_result.setPlainText(f"[嵌入] 超时（30s）。检查地址和代理。")
            except httpx.ConnectError as e:
                self.test_result.setPlainText(f"[嵌入] 连接失败: {e}")
            except Exception as e:
                body = str(e)
                if hasattr(e, 'response') and e.response:
                    body = e.response.text[:300]
                self.test_result.setPlainText(f"[嵌入] 请求失败:\n{body}")

        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(_do())
        finally:
            loop.close()

