"""Central data model that holds every JSON asset in memory."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from PySide6.QtCore import QObject, Signal
from PySide6.QtGui import QUndoStack, QUndoCommand

from .file_io import StagedJsonWriter, read_json, write_json, list_json_files
from .shared.project_paths import ProjectPaths


# ---------------------------------------------------------------------------
# Undo helpers
# ---------------------------------------------------------------------------

class DataEditCommand(QUndoCommand):
    """Generic undo command that swaps a value inside ProjectModel."""

    def __init__(self, model: ProjectModel, data_type: str, key: str,
                 old_value: Any, new_value: Any, description: str = ""):
        super().__init__(description or f"Edit {data_type}.{key}")
        self._model = model
        self._data_type = data_type
        self._key = key
        self._old = old_value
        self._new = new_value

    def redo(self) -> None:
        self._model._apply(self._data_type, self._key, self._new)

    def undo(self) -> None:
        self._model._apply(self._data_type, self._key, self._old)


# ---------------------------------------------------------------------------
# ProjectModel
# ---------------------------------------------------------------------------

class ProjectModel(QObject):
    data_changed = Signal(str, str)  # (data_type, item_id_or_empty)
    dirty_changed = Signal(bool)

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self.project_path: Path | None = None
        self.undo_stack = QUndoStack(self)

        # 载入期被静默修正/丢弃的数据异常（如角色 id 重复被后者覆盖）。载入不打断、
        # 不修盘，只记录；validator 把它们作为 warning 冒出来，避免问题从此不可见。
        self.load_anomalies: list[str] = []

        # 外部修改防护（审查 P1-19）：受管文件的 (st_mtime_ns, st_size) 基线。
        # 键 = 相对工程根的 posix 路径；值 = 载入/上次成功保存时的盘面状态，
        # _BASELINE_ABSENT 表示「彼时文件不存在」。detect_external_changes() 用它
        # 找出「基线之后被外部改动、且本次 Save All 将要覆写」的文件。
        self._file_baselines: dict[str, tuple[int, int]] = {}

        self.game_config: dict = {}
        self.items: list[dict] = []
        self.quests: list[dict] = []
        self.quest_groups: list[dict] = []
        self.encounters: list[dict] = []
        self.rules_data: dict = {}
        self.shops: list[dict] = []
        self.map_nodes: list[dict] = []
        self.map_background_image: str = ""
        self._map_config_is_object: bool = False
        self._map_config_had_background_image_key: bool = False
        self.cutscenes: list[dict] = []
        # parallax_scenes.json：由独立的 parallax Web 编辑器维护，主编辑器只读加载，
        # 供 cutscene present:parallaxScene 步的场景 id 选择器与校验用（不写回，避免与工具争抢）。
        self.parallax_scenes: list[dict] = []
        self.audio_config: dict = {}
        self.strings: dict = {}
        self.character_registry: dict[str, dict] = {}
        self.archive_characters: list[dict] = []
        self.archive_lore: dict = {}
        self.archive_books: list[dict] = []
        self.archive_documents: list[dict] = []
        self.animations: dict[str, dict] = {}
        self.scenes: dict[str, dict] = {}
        self.filter_defs: dict[str, dict] = {}
        self.flag_registry: dict = {}
        self.overlay_images: dict[str, str] = {}
        self.scenarios_catalog: dict = {}
        self.narrative_graphs: dict = {}
        self.document_reveals: list = []
        self.smell_profiles: dict = {}
        self.pressure_holds: list[dict] = []
        self.signal_cues: list[dict] = []
        # planes.json：位面注册表（PlaneDef[]，TS 权威类型 src/systems/plane/types.ts）。
        # 文件可能尚未创建（由运行时/内容侧初始化），缺失时容错为空数组。
        self.planes: list[dict] = []
        # narrative_templates.json：叙事状态机模板（archetype）注册表——编辑器专用，运行时永不加载。
        # 归一形状 {schemaVersion, templates:[...]}；缺失时容错为空表。见 shared/narrative_templates.py。
        self.narrative_templates: dict = {"schemaVersion": 1, "templates": []}
        # narrative_categories.json：叙事状态机「整理分组」标签——编辑器专用，运行时永不加载，绝不进
        # narrative_graphs.json。形状 {schemaVersion, compositions:{id:name}, subgraphs:{compId:{elId:name}}}；
        # 缺失时容错为空注册表。见 shared/narrative_categories.py。
        from .shared.narrative_categories import default_categories_file
        self.narrative_categories: dict = default_categories_file()
        # 模板盖章暂存的空白对话桩（id → 图 JSON）：随 Save All 一次性写盘（脏键 dialogue_stubs），
        # 只写尚不存在的文件、永不覆盖。全有全无：盖章本身零磁盘写入，放弃/崩溃即三样全无。
        self.pending_dialogue_stubs: dict[str, dict] = {}
        # 信号重构等跨文件操作对**既有**对话图文件的暂存修改（id → 整份图 JSON）：随 Save All
        # 覆写原文件（脏键 dialogue_graph_edits）。与 dialogue_stubs 同为零磁盘写入的暂存面，
        # 放弃/崩溃即消失，磁盘不动。见 shared/signal_refactor.py。
        self.pending_dialogue_graph_edits: dict[str, dict] = {}
        # 叙事重构（信号/状态/图 id 改名、信号删除）的共享撤销日志：web 桥与 PyQt
        # 信号管理器同一份（同一引擎、同一撤销栈），换工程即清空。
        self.narrative_refactor_journal: list[dict] = []

        self.water_minigames_index: list[dict] = []
        self.water_minigames_instances: dict[str, dict] = {}
        self.sugar_wheel_index: list[dict] = []
        self.sugar_wheel_instances: dict[str, dict] = {}
        self.paper_craft_index: list[dict] = []
        self.paper_craft_instances: dict[str, dict] = {}

        self._dirty: set[str] = set()
        self._dirty_scene_ids: set[str] = set()
        self._dirty_scenes_all: bool = False

    # ---- properties -------------------------------------------------------

    @property
    def is_dirty(self) -> bool:
        return len(self._dirty) > 0

    @property
    def paths(self) -> ProjectPaths:
        """统一资源路径入口（迁移后约定单点）。

        所有派生路径建议走 ``self.paths``；旧的 ``assets_path``、``runtime_resources_path``
        作为薄包装继续保留，供存量代码使用，后续迭代再逐步替换。
        """
        assert self.project_path is not None
        return ProjectPaths(self.project_path)

    @property
    def assets_path(self) -> Path:
        return self.paths.assets_root

    @property
    def runtime_resources_path(self) -> Path:
        return self.paths.runtime_root

    @property
    def editor_projects_path(self) -> Path:
        return self.paths.editor_projects_root

    @property
    def editor_data_path(self) -> Path:
        return self.paths.editor_data_root

    @property
    def data_path(self) -> Path:
        return self.assets_path / "data"

    @property
    def scenes_path(self) -> Path:
        return self.assets_path / "scenes"

    def map_config_document(self) -> list[dict] | dict:
        """Return the exact top-level document shape used for map_config.json.

        Older projects store map nodes as a bare array. Newer projects can attach
        map-wide settings, currently the runtime paper-map background, next to the
        node list. Keep this as the single serialization contract so editor save
        paths and safety tests do not have to know the storage shape.
        """
        if self._map_config_is_object or self.map_background_image:
            doc: dict = {}
            if self.map_background_image or self._map_config_had_background_image_key:
                doc["backgroundImage"] = self.map_background_image
            doc["nodes"] = self.map_nodes
            return doc
        return self.map_nodes

    @property
    def animation_bundles_path(self) -> Path:
        """每个子目录含 anim.json +图集，与 video_to_atlas 导出一致。"""
        return self.runtime_resources_path / "animation"

    @property
    def dialogues_path(self) -> Path:
        return self.assets_path / "dialogues"

    # ---- loading ----------------------------------------------------------

    def load_project(self, project_path: Path) -> None:
        """换工程半途失败必须回滚：旧实现先改 project_path 再逐文件读，任一文件损坏就留下
        「新路径 + 新旧混合数据」，之后 Save All 会把混合数据写进新工程（审查 P1-30）。
        现在快照全部属性，失败时整体还原到打开前状态再抛错。"""
        _prev_state = dict(self.__dict__)
        try:
            self._load_project_inner(project_path)
        except Exception:
            self.__dict__.clear()
            self.__dict__.update(_prev_state)
            raise

    def _load_project_inner(self, project_path: Path) -> None:
        self.project_path = project_path
        dp = self.data_path
        sp = self.scenes_path

        self.load_anomalies = []
        self.game_config = self._load(dp / "game_config.json", {})
        _char_reg = self._load(dp / "character_registry.json", {})
        _chars = _char_reg.get("characters") if isinstance(_char_reg, dict) else None
        # id -> 角色定义（name/animFile/portraitSlug）；供 NPC 读取端合并继承。
        # 重复/缺 id 条目不再静默吞掉——记入 load_anomalies 由 validator 冒出。
        self.character_registry: dict[str, dict] = {}
        for c in (_chars or []):
            if not isinstance(c, dict) or not str(c.get("id") or "").strip():
                self.load_anomalies.append(
                    "character_registry.json: 存在缺 id 或非对象的角色条目（载入时被忽略）",
                )
                continue
            cid = str(c["id"]).strip()
            if cid in self.character_registry:
                self.load_anomalies.append(
                    f"character_registry.json: 角色 id {cid!r} 重复（载入时后者覆盖前者）",
                )
            self.character_registry[cid] = c
        self.items = self._load(dp / "items.json", [])
        self.quests = self._load(dp / "quests.json", [])
        self.quest_groups = self._load(dp / "questGroups.json", [])
        self.encounters = self._load(dp / "encounters.json", [])
        self.rules_data = self._load(dp / "rules.json", {})
        self.shops = self._load(dp / "shops.json", [])
        raw_map_config = self._load(dp / "map_config.json", [])
        self._map_config_is_object = isinstance(raw_map_config, dict)
        if isinstance(raw_map_config, dict):
            self._map_config_had_background_image_key = "backgroundImage" in raw_map_config
            raw_nodes = raw_map_config.get("nodes")
            self.map_nodes = raw_nodes if isinstance(raw_nodes, list) else []
            self.map_background_image = str(raw_map_config.get("backgroundImage") or "")
        elif isinstance(raw_map_config, list):
            self.map_nodes = raw_map_config
            self.map_background_image = ""
            self._map_config_had_background_image_key = False
        else:
            self.map_nodes = []
            self.map_background_image = ""
            self._map_config_had_background_image_key = False
            if raw_map_config is not None and (dp / "map_config.json").exists():
                self.load_anomalies.append(
                    "map_config.json: 根既非数组也非对象，载入为空地图（下次保存 map 会覆写该文件）",
                )
        self.cutscenes = self._load(dp / "cutscenes" / "index.json", [])
        raw_parallax = self._load(dp / "parallax_scenes.json", [])
        if isinstance(raw_parallax, list):
            self.parallax_scenes = [x for x in raw_parallax if isinstance(x, dict)]
            _dropped = len(raw_parallax) - len(self.parallax_scenes)
            if _dropped:
                self.load_anomalies.append(
                    f"parallax_scenes.json: {_dropped} 条非对象条目载入时被忽略（该文件只读，不会被改写）",
                )
        else:
            self.parallax_scenes = []
            if (dp / "parallax_scenes.json").exists():
                self.load_anomalies.append(
                    "parallax_scenes.json: 根不是数组，载入为空（该文件只读，不会被改写）",
                )
        self.audio_config = self._load(dp / "audio_config.json", {})
        self.strings = self._load(dp / "strings.json", {})
        self.archive_characters = self._load(dp / "archive" / "characters.json", [])
        self.archive_lore = self._load(dp / "archive" / "lore.json", {})
        self.archive_books = self._load(dp / "archive" / "books.json", [])
        self.archive_documents = self._load(dp / "archive" / "documents.json", [])
        self.pressure_holds = self._load(dp / "pressure_holds.json", [])
        self.signal_cues = self._load(dp / "signal_cues.json", [])
        self.smell_profiles = self._load(dp / "smell_profiles.json", {})
        raw_planes = self._load(dp / "planes.json", [])
        if isinstance(raw_planes, list):
            self.planes = [x for x in raw_planes if isinstance(x, dict)]
            _dropped = len(raw_planes) - len(self.planes)
            if _dropped:
                self.load_anomalies.append(
                    f"planes.json: {_dropped} 条非对象条目载入时被丢弃（下次保存 planes 会把丢弃结果写盘）",
                )
        else:
            self.planes = []
            if (dp / "planes.json").exists():
                self.load_anomalies.append(
                    "planes.json: 根不是数组，载入为空（下次保存 planes 会覆写该文件）",
                )
        from .shared.narrative_templates import normalize_templates_file
        self.narrative_templates = normalize_templates_file(
            self._load(dp / "narrative_templates.json", {"schemaVersion": 1, "templates": []})
        )
        from .shared.narrative_categories import (
            default_categories_file,
            normalize_categories_file,
        )
        self.narrative_categories = normalize_categories_file(
            self._load(dp / "narrative_categories.json", default_categories_file())
        )
        self.pending_dialogue_stubs = {}
        self.pending_dialogue_graph_edits = {}
        self.narrative_refactor_journal = []

        self.animations = {}
        anim_root = self.animation_bundles_path
        if anim_root.is_dir():
            for sub in sorted(anim_root.iterdir()):
                if sub.is_dir():
                    aj = sub / "anim.json"
                    if aj.is_file():
                        self.animations[sub.name] = self._load(aj, {})

        # 场景以**文件名 stem 为键**载入（审查 P1-06）。旧实现按内部 id 建键：
        # 两个文件内部 id 相同（agent 复制场景忘改 id）时后者静默影子化前者，
        # Save All 再把可见者写进 scenes/{id}.json 覆毁另一文件。stem 键保证
        # 每个文件保存回自己（保存路径 scenes/{键}.json），不丢任何一份数据；
        # 「内部 id ≠ 文件名」记 load_anomalies 并由 validator 冒 error。
        self.scenes = {}
        _seen_scene_internal_ids: dict[str, str] = {}
        for p in list_json_files(sp, "*.json"):
            if p.parent == sp:
                data = self._load(p, {})
                if not isinstance(data, dict):
                    self.load_anomalies.append(
                        f"scenes/{p.name}: 根不是 JSON 对象，载入时被跳过（磁盘文件保持不动）",
                    )
                    continue
                internal_id = str(data.get("id", "") or "").strip()
                if internal_id and internal_id != p.stem:
                    self.load_anomalies.append(
                        f"scenes/{p.name}: 内部 id {internal_id!r} 与文件名不一致"
                        f"（编辑器按文件名 {p.stem!r} 管理该场景；保存会写回原文件，不覆盖他人）",
                    )
                if internal_id:
                    prev = _seen_scene_internal_ids.get(internal_id)
                    if prev is not None:
                        self.load_anomalies.append(
                            f"scenes/{p.name}: 内部 id {internal_id!r} 与 scenes/{prev} 重复"
                            f"（两个文件都已按各自文件名载入，未互相覆盖；请修正其一的 id）",
                        )
                    else:
                        _seen_scene_internal_ids[internal_id] = p.name
                self.scenes[p.stem] = data

        self.filter_defs = {}
        filters_dir = dp / "filters"
        if filters_dir.is_dir():
            for p in list_json_files(filters_dir):
                self.filter_defs[p.stem] = self._load(p, {})

        from .flag_registry import flag_registry_path, load_flag_registry
        self.flag_registry = load_flag_registry(flag_registry_path(self.assets_path))

        self.overlay_images = self._load(dp / "overlay_images.json", {})
        # scenarios.json 缺失 → 默认 {"scenarios": []}（审查 P2）：旧默认 {} 会让
        # presave 校验「缺少 scenarios 字段」把无 scenarios.json 的工程整体锁死。
        raw_sc = self._load(dp / "scenarios.json", {"scenarios": []})
        if isinstance(raw_sc, dict):
            self.scenarios_catalog = raw_sc
        else:
            self.scenarios_catalog = {"scenarios": []}
            self.load_anomalies.append(
                "scenarios.json: 根不是 JSON 对象，载入为空清单（下次保存 scenarios 会覆写该文件）",
            )
        raw_ng = self._load(dp / "narrative_graphs.json", {"schemaVersion": 2, "compositions": []})
        if isinstance(raw_ng, dict):
            self.narrative_graphs = raw_ng
        else:
            self.narrative_graphs = {"schemaVersion": 2, "compositions": []}
            self.load_anomalies.append(
                "narrative_graphs.json: 根不是 JSON 对象，载入为空图集（下次保存 narrative_graphs 会覆写该文件）",
            )
        raw_dr = self._load(dp / "document_reveals.json", [])
        if isinstance(raw_dr, list):
            self.document_reveals = raw_dr
        else:
            self.document_reveals = []
            self.load_anomalies.append(
                "document_reveals.json: 根不是数组，载入为空（下次保存 document_reveals 会覆写该文件）",
            )

        self.water_minigames_index, self.water_minigames_instances = \
            self._load_minigame_family(dp, "water_minigames")
        self.sugar_wheel_index, self.sugar_wheel_instances = \
            self._load_minigame_family(dp, "sugar_wheel")
        self.paper_craft_index, self.paper_craft_instances = \
            self._load_minigame_family(dp, "paper_craft")

        self._dirty.clear()
        self._dirty_scene_ids.clear()
        self._dirty_scenes_all = False
        self.undo_stack.clear()
        self.dirty_changed.emit(False)
        if self._rebuild_dialogue_graph_ids_from_graph_files():
            # 载入即回写派生索引 → 工程一打开就带脏（scenarios）。记一条 load_anomalies
            # 让策划看到「脏从哪来」（审查 P3）：这是自动对齐 dialogueGraphIds 的结果，
            # 保存一次即消除，非误标。
            self.load_anomalies.append(
                "scenarios.json: 各 scenario 的 dialogueGraphIds 派生索引与对话图 meta.scenarioId "
                "不一致，载入时已自动对齐（工程因此标记为待保存；保存一次即固化）",
            )
            self.mark_dirty("scenarios")

    def reload_filters_from_disk(self) -> None:
        """重读 public/assets/data/filters，与 tools.filter_tool 写入目录一致（不标脏）。"""
        if self.project_path is None:
            return
        self.filter_defs = {}
        filters_dir = self.data_path / "filters"
        if filters_dir.is_dir():
            for p in list_json_files(filters_dir):
                self.filter_defs[p.stem] = self._load(p, {})
        self.data_changed.emit("filter", "")

    def reload_animations_from_disk(self) -> None:
        """重读 public/resources/runtime/animation/*/anim.json（不标脏；导出/外部工具改盘后用于同步内存）。"""
        if self.project_path is None:
            return
        self.animations = {}
        anim_root = self.animation_bundles_path
        if anim_root.is_dir():
            for sub in sorted(anim_root.iterdir()):
                if sub.is_dir():
                    aj = sub / "anim.json"
                    if aj.is_file():
                        self.animations[sub.name] = self._load(aj, {})
        self.data_changed.emit("animation", "")

    def save_animation_bundle(self, bundle_id: str, anim: dict) -> Path:
        """把单个动画包的 anim.json 写回磁盘并同步内存。

        - 只写 ``animation/<id>/anim.json``，不碰图集 PNG / atlas.meta.json（像素布局相关字段
          cols/rows/cellWidth/cellHeight/atlasFrames 由调用方原样带回，避免与图集脱钩）。
        - 经 :func:`file_io.write_json` 落盘：UTF-8、2 空格缩进、中文不转义、保留键序、末尾换行，
          与 video_to_atlas 导出及仓库内既有 anim.json 约定一致（编辑器可往返）。
        - 写后回读，保证内存 ``self.animations[id]`` 与盘面字节一致，再广播 ``animation`` 变更。
        """
        if self.project_path is None:
            raise RuntimeError("未加载工程")
        bid = str(bundle_id).strip()
        if not bid:
            raise ValueError("空动画包 ID")
        aj = self.animation_bundles_path / bid / "anim.json"
        if not aj.parent.is_dir():
            raise FileNotFoundError(f"动画包目录不存在：{aj.parent}")
        write_json(aj, anim)
        self.animations[bid] = read_json(aj)
        self.data_changed.emit("animation", bid)
        return aj

    def _load_minigame_family(
        self, dp: Path, family: str,
    ) -> tuple[list[dict], dict[str, dict]]:
        """载入 water_minigames / sugar_wheel / paper_craft 三个同构小游戏族。

        统一了三处以前重复的载入逻辑，并把过去静默的清洗一律记 load_anomalies
        （审查 P2）：
        - index 非数组 / 条目非对象 → 记异常并跳过；
        - 登记项指向的实例文件缺失 → **不再凭空造空实例**（旧行为会静默造 {} 空实例，
          下次保存把真数据抹成空白），改记 load_anomalies；
        - 实例内部 id 与登记 id 不符 → 就地改写内存副本并记异常（保存时以登记 id 为准）。
        """
        index: list[dict] = []
        instances: dict[str, dict] = {}
        base_dir = dp / family
        idx_path = base_dir / "index.json"
        if not idx_path.is_file():
            return index, instances
        raw_idx = self._load(idx_path, [])
        if isinstance(raw_idx, list):
            index = [x for x in raw_idx if isinstance(x, dict)]
            dropped = len(raw_idx) - len(index)
            if dropped:
                self.load_anomalies.append(
                    f"{family}/index.json: {dropped} 条非对象条目载入时被忽略",
                )
        else:
            self.load_anomalies.append(
                f"{family}/index.json: 根不是数组，载入为空",
            )
            return index, instances
        for row in index:
            fid = row.get("file")
            iid = str(row.get("id") or "").strip()
            if not iid or not isinstance(fid, str) or not fid.endswith(".json"):
                continue
            inst_path = base_dir / fid
            if not inst_path.exists():
                self.load_anomalies.append(
                    f"{family}: 登记项 {iid!r} 指向的实例文件 {family}/{fid} 缺失"
                    f"（未凭空创建空实例；请补文件或从 index 删除该登记，否则保存时该项无实例可写）",
                )
                continue
            data = self._load(inst_path, {})
            if not isinstance(data, dict):
                self.load_anomalies.append(
                    f"{family}/{fid}: 实例根不是 JSON 对象，登记项 {iid!r} 载入时被跳过",
                )
                continue
            if str(data.get("id") or "").strip() != iid:
                self.load_anomalies.append(
                    f"{family}/{fid}: 实例内部 id 与 index 登记 id {iid!r} 不一致"
                    f"（编辑器以登记 id 为准；保存时写回登记 id）",
                )
                data["id"] = iid
            instances[iid] = data
        return index, instances

    def _load(self, path: Path, default: Any) -> Any:
        """读一个受管 JSON；顺带记录外部修改基线（文件缺失记「彼时不存在」）。"""
        if path.exists():
            data = read_json(path)
            self._record_file_baseline(path)
            return data
        self._file_baselines[self._baseline_key(path)] = self._BASELINE_ABSENT
        return default

    # ---- external-change detection (审查 P1-19) ----------------------------

    #: 「基线采集时文件不存在」的哨兵值（区别于"未跟踪"= 键不存在）。
    _BASELINE_ABSENT: tuple[int, int] = (-1, -1)

    def _baseline_key(self, path: Path) -> str:
        """基线字典键：相对工程根的 posix 路径（工程外/未设根时退化为绝对路径）。"""
        p = Path(path)
        if self.project_path is not None:
            try:
                return p.resolve().relative_to(Path(self.project_path).resolve()).as_posix()
            except ValueError:
                pass
        return p.resolve().as_posix()

    def _record_file_baseline(self, path: Path) -> None:
        """把 path 当前盘面状态记为基线（= 内存与磁盘同步的时刻）。"""
        try:
            st = Path(path).stat()
        except OSError:
            self._file_baselines[self._baseline_key(path)] = self._BASELINE_ABSENT
            return
        self._file_baselines[self._baseline_key(path)] = (st.st_mtime_ns, st.st_size)

    def detect_external_changes(self) -> list[str]:
        """返回「自基线（载入或上次成功 Save All）后被外部改动、且本次 Save All 将要
        覆写」的文件相对路径（相对工程根，posix，有序）。

        只提供检测 API，不弹窗不拦截——主窗在 Save All 前调用并决定提示策略。
        语义：
        - 基线不存在（未跟踪文件，如从未读过的对话图）→ 不报告；
        - 基线为「彼时不存在」而现在盘上有文件 → 报告（外部新建，将被覆写）；
        - 基线存在而文件已被删除 → 报告（外部删除，保存会凭空复活旧内容）；
        - (mtime_ns, size) 与基线不一致 → 报告。
        """
        if self.project_path is None or not self.is_dirty:
            return []
        out: list[str] = []
        for path in self._planned_write_paths():
            key = self._baseline_key(path)
            baseline = self._file_baselines.get(key)
            if baseline is None:
                continue  # 未跟踪：无从判断，不误报
            try:
                st = Path(path).stat()
                current: tuple[int, int] | None = (st.st_mtime_ns, st.st_size)
            except OSError:
                current = None
            if baseline == self._BASELINE_ABSENT:
                if current is not None:
                    out.append(key)
            elif current is None or current != baseline:
                out.append(key)
        return sorted(set(out))

    def _planned_write_paths(self) -> list[Path]:
        """按当前脏桶推演本次 save_all 将写盘的目标文件（只读，不产生副作用）。

        与 save_all 的 if 链一一对应（同步维护）；dialogue_stubs 刻意排除——
        它只写「盘上尚不存在」的文件、永不覆盖，构不成外部修改冲突。
        """
        if self.project_path is None:
            return []
        dp = self.data_path
        sp = self.scenes_path
        dty = self._dirty
        out: list[Path] = []
        if "config" in dty:
            out.append(dp / "game_config.json")
        if "characterRegistry" in dty:
            out.append(dp / "character_registry.json")
        if "item" in dty:
            out.append(dp / "items.json")
        if "quest" in dty:
            out.append(dp / "quests.json")
        if "questGroup" in dty:
            out.append(dp / "questGroups.json")
        if "encounter" in dty:
            out.append(dp / "encounters.json")
        if "rules" in dty:
            out.append(dp / "rules.json")
        if "shop" in dty:
            out.append(dp / "shops.json")
        if "map" in dty:
            out.append(dp / "map_config.json")
        if "cutscene" in dty:
            out.append(dp / "cutscenes" / "index.json")
        if "audio" in dty:
            out.append(dp / "audio_config.json")
        if "strings" in dty:
            out.append(dp / "strings.json")
        if "archive" in dty:
            out.extend([
                dp / "archive" / "characters.json",
                dp / "archive" / "lore.json",
                dp / "archive" / "books.json",
                dp / "archive" / "documents.json",
            ])
        if "scene" in dty:
            if self._dirty_scenes_all or not self._dirty_scene_ids:
                scene_ids = sorted(self.scenes.keys())
            else:
                scene_ids = sorted(set(self._dirty_scene_ids) & set(self.scenes.keys()))
            out.extend(sp / f"{sid}.json" for sid in scene_ids)
        if "flag_registry" in dty:
            from .flag_registry import flag_registry_path
            out.append(flag_registry_path(self.assets_path))
        if "overlay_images" in dty:
            out.append(dp / "overlay_images.json")
        if "scenarios" in dty:
            out.append(dp / "scenarios.json")
        if "narrative_graphs" in dty:
            out.append(dp / "narrative_graphs.json")
        if "document_reveals" in dty:
            out.append(dp / "document_reveals.json")
        if "smell_profiles" in dty:
            out.append(dp / "smell_profiles.json")
        if "pressure_holds" in dty:
            out.append(dp / "pressure_holds.json")
        if "signal_cues" in dty:
            out.append(dp / "signal_cues.json")
        if "planes" in dty:
            out.append(dp / "planes.json")
        if "narrative_templates" in dty:
            out.append(dp / "narrative_templates.json")
        if "narrative_categories" in dty:
            out.append(dp / "narrative_categories.json")
        if "dialogue_graph_edits" in dty:
            from .shared.narrative_templates import _dialogue_id_error
            graphs_dir = self.dialogues_path / "graphs"
            for gid, graph in self.pending_dialogue_graph_edits.items():
                gid_s = str(gid).strip()
                if not gid_s or _dialogue_id_error(gid_s) or not isinstance(graph, dict):
                    continue
                out.append(graphs_dir / f"{gid_s}.json")
        if "water_minigames" in dty:
            wm_dir = dp / "water_minigames"
            out.append(wm_dir / "index.json")
            for row in self.water_minigames_index:
                if not isinstance(row, dict):
                    continue
                iid = str(row.get("id") or "").strip()
                fid = row.get("file")
                if self.water_minigames_instances.get(iid) and isinstance(fid, str):
                    out.append(wm_dir / fid)
        if "sugar_wheel" in dty:
            sw_dir = dp / "sugar_wheel"
            out.append(sw_dir / "index.json")
            for row in self.sugar_wheel_index:
                if not isinstance(row, dict):
                    continue
                iid = str(row.get("id") or "").strip()
                fid = row.get("file")
                if self.sugar_wheel_instances.get(iid) and isinstance(fid, str):
                    out.append(sw_dir / fid)
        if "paper_craft" in dty:
            pc_dir = dp / "paper_craft"
            out.append(pc_dir / "index.json")
            for row in self.paper_craft_index:
                if not isinstance(row, dict):
                    continue
                iid = str(row.get("id") or "").strip()
                fid = row.get("file")
                if self.paper_craft_instances.get(iid) and isinstance(fid, str):
                    out.append(pc_dir / fid)
        if "filter" in dty:
            filters_dir = dp / "filters"
            out.extend(filters_dir / f"{stem}.json" for stem in sorted(self.filter_defs.keys()))
        return out

    # ---- saving -----------------------------------------------------------

    def save_all(self) -> None:
        if self.project_path is None:
            return
        from .editor_perf import PerfClock, maybe_stamp, perf_span

        clk = PerfClock(label="model.save_all")
        if not self.is_dirty:
            maybe_stamp(clk, "无 dirty，跳过保存与校验")
            return

        maybe_stamp(clk, "开始（有 dirty）")
        dp = self.data_path
        sp = self.scenes_path
        dty = self._dirty

        from .scenarios_catalog_validate import validate_scenarios_catalog_for_save
        from .shared.ref_validator import validate_refs_for_save

        with perf_span("model.save_all.presave_validators"):
            # 按脏桶收口（审查 P2-③）：只校验本次将写盘的域，盘上无关域的历史坏
            # 数据不再锁死保存。
            ref_err = validate_refs_for_save(self, dirty=set(dty))
            if ref_err:
                raise ValueError(ref_err)

            # scenarios 校验只在本次要写 scenarios 时把关（旧实现无条件跑：无
            # scenarios.json 的工程改任何东西都存不了——现默认 {"scenarios": []}
            # 已能通过，这里仍收口到脏桶，避免盘上既有坏 scenarios 锁死无关域）。
            if "scenarios" in dty:
                sc_errs = validate_scenarios_catalog_for_save(
                    self.scenarios_catalog,
                    flag_registry=self.flag_registry,
                    model=self,
                )
                if sc_errs:
                    raise ValueError("scenarios.json 校验失败：\n" + "\n".join(sc_errs))

            # 仅在本次要写 paper_craft 时把关：不因磁盘上既有的坏数据拦住无关域的保存。
            if "paper_craft" in dty:
                pc_err = self._paper_craft_presave_error()
                if pc_err:
                    raise ValueError(pc_err)

            # narrative_graphs 规范化+校验前移到任何写盘之前：历史实现放在写盘序列
            # 中段，quest 已落盘后才发现 narrative 非法 → 半保存出孤儿镜像任务。
            if "narrative_graphs" in dty:
                from .editors.narrative_state_editor import (
                    _normalize_file as _normalize_narrative_graphs,
                    _validation_errors_for_save as _narrative_validation_errors_for_save,
                )
                normalized_narrative = _normalize_narrative_graphs(self.narrative_graphs)
                narrative_errors = _narrative_validation_errors_for_save(normalized_narrative, self)
                if narrative_errors:
                    preview = "; ".join(str(e.get("message") or e.get("code")) for e in narrative_errors[:4])
                    raise ValueError(
                        f"narrative_graphs.json 校验未通过：{len(narrative_errors)} 条错误。{preview}"
                    )
                self.narrative_graphs = normalized_narrative

            # 位面 extends 缺父/成环：运行时只 warn 并静默忽略继承（数据意义改变），
            # 保存前必须拦成硬错误（复核 P1-04）。
            if "planes" in dty:
                from .validator import plane_extends_errors
                plane_errs = plane_extends_errors(self.planes)
                if plane_errs:
                    msg = "\n".join(f"位面 {pid!r}: {m}" for pid, m in plane_errs[:8])
                    raise ValueError(f"planes.json 保存被拦截：\n{msg}")

        maybe_stamp(clk, "预校验通过 — 顺序：refs → scenarios → narrative → planes → writes")

        # ---- 两阶段写（复核 P1-03）：先把全部脏桶序列化并落同目录 .tmp（任何失败
        # 经 abort 清理，磁盘零变化），再统一 os.replace 提交。删除类副作用（filters
        # 淘汰、pending 暂存清空）一律推迟到提交成功之后。
        w = StagedJsonWriter()
        deferred_unlinks: list[Path] = []
        try:
            if "config" in dty:
                w.add(dp / "game_config.json", self.game_config)
            if "characterRegistry" in dty:
                # 按载入顺序回写（往返保真优先，审查 P2-⑤）：character_registry 是
                # 插入序 dict（载入时按文件内数组顺序建键），保存沿用该顺序，不再强制
                # sorted——否则首次保存必改写磁盘顺序（现盘面未按 id 排）。
                w.add(
                    dp / "character_registry.json",
                    {"characters": list(self.character_registry.values())},
                )
            if "item" in dty:
                w.add(dp / "items.json", self.items)
            if "quest" in dty:
                w.add(dp / "quests.json", self.quests)
            if "questGroup" in dty:
                w.add(dp / "questGroups.json", self.quest_groups)
            if "encounter" in dty:
                w.add(dp / "encounters.json", self.encounters)
            if "rules" in dty:
                w.add(dp / "rules.json", self.rules_data)
            if "shop" in dty:
                w.add(dp / "shops.json", self.shops)
            if "map" in dty:
                map_doc = self.map_config_document()
                w.add(dp / "map_config.json", map_doc)
                self._map_config_is_object = isinstance(map_doc, dict)
                self._map_config_had_background_image_key = (
                    isinstance(map_doc, dict) and "backgroundImage" in map_doc
                )
            if "cutscene" in dty:
                w.add(dp / "cutscenes" / "index.json", self.cutscenes)
            if "audio" in dty:
                w.add(dp / "audio_config.json", self.audio_config)
            if "strings" in dty:
                w.add(dp / "strings.json", self.strings)
            if "archive" in dty:
                w.add(dp / "archive" / "characters.json", self.archive_characters)
                w.add(dp / "archive" / "lore.json", self.archive_lore)
                w.add(dp / "archive" / "books.json", self.archive_books)
                w.add(dp / "archive" / "documents.json", self.archive_documents)
            maybe_stamp(clk, "已暂存 data 下聚合 JSON（按 dirty）")
            if "scene" in dty:
                if self._dirty_scenes_all or not self._dirty_scene_ids:
                    scene_ids = sorted(self.scenes.keys())
                else:
                    scene_ids = sorted(
                        set(self._dirty_scene_ids) & set(self.scenes.keys()),
                    )
                for sid in scene_ids:
                    w.add(sp / f"{sid}.json", self.scenes[sid])
                maybe_stamp(clk, f"已暂存 {len(scene_ids)} 个场景 JSON")
            if "flag_registry" in dty:
                from .flag_registry import flag_registry_path

                w.add(flag_registry_path(self.assets_path), self.flag_registry)
            if "overlay_images" in dty:
                w.add(dp / "overlay_images.json", self.overlay_images)
            if "scenarios" in dty:
                w.add(dp / "scenarios.json", self.scenarios_catalog)
            if "narrative_graphs" in dty:
                # 规范化与校验已在预校验段完成（写盘前零副作用拦截）。
                w.add(dp / "narrative_graphs.json", self.narrative_graphs)
            if "document_reveals" in dty:
                w.add(dp / "document_reveals.json", self.document_reveals)
            if "smell_profiles" in dty:
                w.add(dp / "smell_profiles.json", self.smell_profiles)
            if "pressure_holds" in dty:
                w.add(dp / "pressure_holds.json", self.pressure_holds)
            if "signal_cues" in dty:
                w.add(dp / "signal_cues.json", self.signal_cues)
            if "planes" in dty:
                w.add(dp / "planes.json", self.planes)
            if "narrative_templates" in dty:
                from .shared.narrative_templates import normalize_templates_file
                self.narrative_templates = normalize_templates_file(self.narrative_templates)
                w.add(dp / "narrative_templates.json", self.narrative_templates)
            if "narrative_categories" in dty:
                # 编辑器专用整理分组：归一（排序/丢空）后写旁挂文件，绝不进 narrative_graphs.json。
                from .shared.narrative_categories import normalize_categories_file
                self.narrative_categories = normalize_categories_file(self.narrative_categories)
                w.add(dp / "narrative_categories.json", self.narrative_categories)
            if "dialogue_stubs" in dty:
                # 模板盖章暂存的空白对话桩：只写尚不存在的文件，永不覆盖既有对话图。
                # pending 的清空推迟到提交成功之后，失败时暂存内容不丢。
                from .shared.narrative_templates import _dialogue_id_error
                stubs_dir = self.dialogues_path / "graphs"
                for gid, graph in list(self.pending_dialogue_stubs.items()):
                    gid_s = str(gid).strip()
                    if not gid_s or _dialogue_id_error(gid_s) or not isinstance(graph, dict):
                        continue
                    target = stubs_dir / f"{gid_s}.json"
                    if not target.exists():
                        w.add(target, graph)
                maybe_stamp(clk, "dialogue_stubs 已暂存")
            if "dialogue_graph_edits" in dty:
                # 信号重构等跨文件操作对既有对话图的暂存修改：覆写原文件（区别于
                # dialogue_stubs 的只写新文件）。pending 清空推迟到提交成功之后。
                from .shared.narrative_templates import _dialogue_id_error
                graphs_dir = self.dialogues_path / "graphs"
                for gid, graph in list(self.pending_dialogue_graph_edits.items()):
                    gid_s = str(gid).strip()
                    if not gid_s or _dialogue_id_error(gid_s) or not isinstance(graph, dict):
                        continue
                    w.add(graphs_dir / f"{gid_s}.json", graph)
                maybe_stamp(clk, "dialogue_graph_edits 已暂存")
            if "water_minigames" in dty:
                wm_dir = dp / "water_minigames"
                w.add(wm_dir / "index.json", self.water_minigames_index)
                for row in self.water_minigames_index:
                    if not isinstance(row, dict):
                        continue
                    iid = str(row.get("id") or "").strip()
                    fid = row.get("file")
                    inst = self.water_minigames_instances.get(iid)
                    if not inst or not isinstance(fid, str):
                        continue
                    w.add(wm_dir / fid, inst)
                maybe_stamp(clk, "water_minigames 已暂存")
            if "sugar_wheel" in dty:
                sw_dir = dp / "sugar_wheel"
                w.add(sw_dir / "index.json", self.sugar_wheel_index)
                for row in self.sugar_wheel_index:
                    if not isinstance(row, dict):
                        continue
                    iid = str(row.get("id") or "").strip()
                    fid = row.get("file")
                    inst = self.sugar_wheel_instances.get(iid)
                    if not inst or not isinstance(fid, str):
                        continue
                    w.add(sw_dir / fid, inst)
                maybe_stamp(clk, "sugar_wheel 已暂存")
            if "paper_craft" in dty:
                pc_dir = dp / "paper_craft"
                w.add(pc_dir / "index.json", self.paper_craft_index)
                for row in self.paper_craft_index:
                    if not isinstance(row, dict):
                        continue
                    iid = str(row.get("id") or "").strip()
                    fid = row.get("file")
                    inst = self.paper_craft_instances.get(iid)
                    if not inst or not isinstance(fid, str):
                        continue
                    w.add(pc_dir / fid, inst)
                maybe_stamp(clk, "paper_craft 已暂存")
            if "filter" in dty:
                filters_dir = dp / "filters"
                keep = set(self.filter_defs.keys())
                if filters_dir.is_dir():
                    for p in list(filters_dir.glob("*.json")):
                        if p.stem not in keep:
                            deferred_unlinks.append(p)
                for stem, data in sorted(self.filter_defs.items()):
                    w.add(filters_dir / f"{stem}.json", data)
                maybe_stamp(clk, "filters 已暂存")
            maybe_stamp(clk, "全部暂存完成，开始提交（os.replace 序列）")
            w.commit()
        finally:
            w.abort()  # commit 成功后为 no-op；中途失败时清理 .tmp，磁盘零变化

        # ---- 提交成功后的收尾（不再有可失败回滚的写盘）----
        # 外部修改基线（审查 P1-19）：本次写盘的文件现在内存==磁盘，刷新基线，
        # 否则下次保存会把自己刚写的内容误报成外部改动。dialogue_stubs 只写新文件、
        # 永不覆盖，无需纳入冲突检测，不刷新其基线。
        for path in self._planned_write_paths():
            self._record_file_baseline(path)
        for stale in deferred_unlinks:
            try:
                stale.unlink()
            except OSError:
                pass
            # 被淘汰的 filter 文件：基线记为「已不存在」。
            self._file_baselines[self._baseline_key(stale)] = self._BASELINE_ABSENT
        if "dialogue_stubs" in dty:
            self.pending_dialogue_stubs = {}
        if "dialogue_graph_edits" in dty:
            self.pending_dialogue_graph_edits = {}

        self._dirty.clear()
        self._dirty_scene_ids.clear()
        self._dirty_scenes_all = False
        self.dirty_changed.emit(False)
        maybe_stamp(clk, "结束（清 dirty）")

    def _paper_craft_presave_error(self) -> str | None:
        """扎纸订单硬约束：每张订单 paperOptions/finishOptions 非空——运行时缺失即拒载
        （PaperCraftMinigameScene 加载时 throw），存出去就是坏档，保存前必须拦下。"""
        errs: list[str] = []
        for iid, inst in self.paper_craft_instances.items():
            if not isinstance(inst, dict):
                continue
            for order in inst.get("orders") or []:
                if not isinstance(order, dict):
                    continue
                oid = str(order.get("id") or "").strip() or "?"
                for key, label in (("paperOptions", "纸色"), ("finishOptions", "收尾")):
                    rows = order.get(key)
                    if not isinstance(rows, list) or not rows:
                        errs.append(
                            f"paper_craft[{iid}] 订单「{oid}」的 {key} 为空：{label}选项至少 1 条（运行时拒载）",
                        )
        if not errs:
            return None
        return "扎纸订单校验失败，未保存：\n" + "\n".join(errs)

    #: save_all 认领的全部脏桶键（与其 if 链一一对应）。mark_dirty 只接受这里登记的
    #: 键——历史教训：标错键（如 "quests" vs "quest"）时 Save All 不写文件却清脏标记，
    #: 暂存内容无声丢失（复核 P1-02 护栏）。新增数据域时两处同步更新。
    KNOWN_DIRTY_BUCKETS: frozenset = frozenset({
        "config", "characterRegistry", "item", "quest", "questGroup", "encounter",
        "rules", "shop", "map", "cutscene", "audio", "strings", "archive", "scene",
        "flag_registry", "overlay_images", "scenarios", "narrative_graphs",
        "document_reveals", "smell_profiles", "pressure_holds", "signal_cues",
        "planes", "narrative_templates", "narrative_categories", "dialogue_stubs",
        "dialogue_graph_edits", "water_minigames", "sugar_wheel", "paper_craft", "filter",
    })

    def mark_dirty(self, data_type: str, item_id: str = "") -> None:
        if data_type not in self.KNOWN_DIRTY_BUCKETS:
            raise ValueError(
                f"未知脏桶 {data_type!r}：save_all 不认领它，标记会被无声丢弃"
                "（写盘跳过、脏标记却被清除）。新增数据域时同步更新 "
                "ProjectModel.KNOWN_DIRTY_BUCKETS 与 save_all 的写盘分支。"
            )
        was_dirty = self.is_dirty
        self._dirty.add(data_type)
        if data_type == "scene":
            sid = (item_id or "").strip()
            if sid:
                self._dirty_scene_ids.add(sid)
            else:
                self._dirty_scenes_all = True
        self.data_changed.emit(data_type, item_id)
        if not was_dirty:
            self.dirty_changed.emit(True)

    # ---- undo integration -------------------------------------------------

    def _apply(self, data_type: str, key: str, value: Any) -> None:
        setattr(self, key, value)
        self.mark_dirty(data_type)

    def push_edit(self, data_type: str, attr_name: str,
                  old_value: Any, new_value: Any, desc: str = "") -> None:
        cmd = DataEditCommand(self, data_type, attr_name,
                              old_value, new_value, desc)
        self.undo_stack.push(cmd)

    # ---- id helpers -------------------------------------------------------

    def all_scene_ids(self) -> list[str]:
        return list(self.scenes.keys())

    def collect_emote_strings_used_in_project(self) -> list[str]:
        """扫描内存数据树中 Action 等的 ``emote`` 参数，汇总已出现过的气泡文案（去重排序）。"""
        seen: set[str] = set()

        def walk(o: Any) -> None:
            if isinstance(o, dict):
                em = o.get("emote")
                if isinstance(em, str):
                    s = em.strip()
                    if s:
                        seen.add(s)
                for v in o.values():
                    walk(v)
            elif isinstance(o, list):
                for it in o:
                    walk(it)

        for root in (
            self.cutscenes,
            self.quests,
            self.quest_groups,
            self.encounters,
            self.map_nodes,
            self.scenarios_catalog,
            self.rules_data,
            self.game_config,
        ):
            walk(root)
        return sorted(seen, key=lambda x: (str(x).lower(), x))

    def spawn_point_keys_for_scene(self, scene_id: str) -> list[str]:
        """Spawn point id strings from scene JSON ``spawnPoints`` (empty first = default)."""
        sc = self.scenes.get(scene_id) or {}
        raw = sc.get("spawnPoints") or {}
        if not isinstance(raw, dict):
            return [""]
        keys = sorted(str(k) for k in raw.keys())
        return [""] + keys

    def archive_entry_ids_for_book_type(self, book_type: str) -> list[tuple[str, str]]:
        """Ids for addArchiveEntry ``entryId`` picker by ``bookType``."""
        if book_type == "character":
            return [(ch["id"], ch.get("name", ch["id"])) for ch in self.archive_characters]
        if book_type == "lore":
            entries = self.archive_lore
            if isinstance(entries, dict):
                entries = entries.get("entries", [])
            return [
                (e["id"], (e.get("title") or e["id"])[:40])
                for e in entries
                if isinstance(e, dict) and e.get("id")
            ]
        if book_type == "document":
            return [
                (d["id"], (d.get("name") or d.get("title") or d["id"])[:40])
                for d in self.archive_documents
                if isinstance(d, dict) and d.get("id")
            ]
        if book_type == "book":
            return [
                (b["id"], (b.get("title") or b["id"])[:40])
                for b in self.archive_books
                if isinstance(b, dict) and b.get("id")
            ]
        if book_type == "bookEntry":
            out: list[tuple[str, str]] = []
            for b in self.archive_books:
                if not isinstance(b, dict):
                    continue
                for pg in b.get("pages") or []:
                    if not isinstance(pg, dict):
                        continue
                    for ent in pg.get("entries") or []:
                        if not isinstance(ent, dict):
                            continue
                        eid = ent.get("id")
                        if eid:
                            label = (ent.get("title") or eid)[:40]
                            out.append((str(eid), str(label)))
            return out
        return []

    def character_field(self, npc: dict, key: str) -> str:
        """NPC 的 name/animFile/portraitSlug 生效值：就地字段优先，缺省从 characterId 引用的角色继承。"""
        v = npc.get(key)
        if isinstance(v, str) and v.strip():
            return v
        cid = str(npc.get("characterId") or "").strip()
        if cid:
            ch = self.character_registry.get(cid)
            if isinstance(ch, dict):
                cv = ch.get(key)
                if isinstance(cv, str) and cv.strip():
                    return cv
        return str(v) if v is not None else ""

    def _npc_label(self, npc: dict) -> str:
        return (
            npc.get("label")
            or self.character_field(npc, "name")
            or str(npc.get("id") or npc.get("npcId") or "")
        )

    def all_npc_ids_global(self) -> list[tuple[str, str]]:
        """All NPC ids across all scenes, deduplicated."""
        seen: dict[str, str] = {}
        for sc in self.scenes.values():
            if not isinstance(sc, dict):
                continue
            for npc in sc.get("npcs") or []:
                if not isinstance(npc, dict):
                    continue
                nid = npc.get("id") or npc.get("npcId")
                if nid and str(nid) not in seen:
                    seen[str(nid)] = str(self._npc_label(npc))[:40]
        return [(k, v) for k, v in sorted(seen.items())]

    def all_npc_names(self) -> list[str]:
        """All unique NPC display names across all scenes（含角色注册表继承名）。"""
        names: set[str] = set()
        for sc in self.scenes.values():
            if not isinstance(sc, dict):
                continue
            for npc in sc.get("npcs") or []:
                if not isinstance(npc, dict):
                    continue
                name = self.character_field(npc, "name") or npc.get("label") or npc.get("id")
                if name:
                    names.add(str(name))
        # 角色注册表里可能有尚未在任何场景摆放的角色名，一并纳入
        for ch in self.character_registry.values():
            nm = ch.get("name")
            if isinstance(nm, str) and nm.strip():
                names.add(nm.strip())
        return sorted(names)

    def npc_ids_for_scene(self, scene_id: str | None) -> list[tuple[str, str]]:
        """NPC ids in a scene (for hotspot / emote targets)."""
        if not scene_id:
            return []
        sc = self.scenes.get(scene_id) or {}
        out: list[tuple[str, str]] = []
        for npc in sc.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            nid = npc.get("id") or npc.get("npcId")
            if nid:
                out.append((str(nid), str(self._npc_label(npc))[:40]))
        return out

    def hotspot_ids_for_scene(self, scene_id: str | None) -> list[tuple[str, str]]:
        """Hotspot ids in a scene."""
        if not scene_id:
            return []
        sc = self.scenes.get(scene_id) or {}
        out: list[tuple[str, str]] = []
        for hs in sc.get("hotspots") or []:
            if not isinstance(hs, dict):
                continue
            hid = str(hs.get("id", "") or "").strip()
            if not hid:
                continue
            label = hs.get("label") or hs.get("type") or hid
            out.append((hid, str(label)[:40]))
        return out

    def standard_zone_ids_for_scene(self, scene_id: str | None) -> list[tuple[str, str]]:
        """普通 Zone（排除 depth_floor）的 id，供 Action 下拉。"""
        if not scene_id:
            return []
        sc = self.scenes.get(scene_id) or {}
        out: list[tuple[str, str]] = []
        for z in sc.get("zones") or []:
            if not isinstance(z, dict):
                continue
            if str(z.get("zoneKind") or "standard").strip() == "depth_floor":
                continue
            zid = str(z.get("id", "") or "").strip()
            if not zid:
                continue
            out.append((zid, zid))
        return out

    def entity_ids_for_scene(self, scene_id: str | None, kind: str) -> list[tuple[str, str]]:
        if kind == "npc":
            return self.npc_ids_for_scene(scene_id)
        if kind == "hotspot":
            return self.hotspot_ids_for_scene(scene_id)
        return []

    def runtime_entity_field_choices(self, kind: str) -> list[tuple[str, str]]:
        from .shared.runtime_field_schema import field_choices
        return field_choices(kind)

    def runtime_entity_field_meta(self, kind: str, field_name: str) -> dict[str, str] | None:
        from .shared.runtime_field_schema import field_meta
        return field_meta(kind, field_name)

    def all_hotspot_ids(self) -> list[tuple[str, str]]:
        """全场景热点 id 列表 (id, 展示说明)，供 Action 等筛选器使用。"""
        from collections import defaultdict

        by_id: dict[str, list[str]] = defaultdict(list)
        for sid, sc in self.scenes.items():
            if not isinstance(sc, dict):
                continue
            for hs in sc.get("hotspots") or []:
                if not isinstance(hs, dict):
                    continue
                hid = str(hs.get("id", "") or "").strip()
                if not hid:
                    continue
                by_id[hid].append(str(sid))
        out: list[tuple[str, str]] = []
        for hid in sorted(by_id.keys(), key=str.lower):
            scenes = by_id[hid]
            if len(scenes) <= 3:
                scen_part = ", ".join(scenes)
            else:
                scen_part = ", ".join(scenes[:3]) + "…"
            out.append((hid, f"{hid}（{scen_part}）"[:100]))
        return out

    def scene_transitions(self) -> list[dict]:
        """All transition edges between scenes, derived from hotspot data.

        Returns list of {from_scene, to_scene, label, conditional}.
        """
        edges: list[dict] = []
        for sid, sc in self.scenes.items():
            if not isinstance(sc, dict):
                continue
            for hs in sc.get("hotspots") or []:
                if not isinstance(hs, dict):
                    continue
                if hs.get("type") != "transition":
                    continue
                data = hs.get("data") or {}
                target = data.get("targetScene")
                if not target:
                    continue
                edges.append({
                    "from_scene": str(sid),
                    "to_scene": str(target),
                    "label": str(hs.get("label", "")),
                    "conditional": bool(hs.get("conditions")),
                })
        return edges

    def all_item_ids(self) -> list[tuple[str, str]]:
        return [(it["id"], it.get("name", it["id"])) for it in self.items]

    def all_quest_ids(self) -> list[tuple[str, str]]:
        return [(q["id"], q.get("title", q["id"])) for q in self.quests]

    def all_quest_group_ids(self) -> list[tuple[str, str]]:
        return [(g["id"], g.get("name", g["id"])) for g in self.quest_groups]

    def all_encounter_ids(self) -> list[tuple[str, str]]:
        return [(e["id"], e.get("narrative", e["id"])[:30]) for e in self.encounters]

    def all_rule_ids(self) -> list[tuple[str, str]]:
        rules = self.rules_data.get("rules", [])
        return [(r["id"], r.get("name", r["id"])) for r in rules]

    def all_fragment_ids(self) -> list[tuple[str, str]]:
        frags = self.rules_data.get("fragments", [])
        return [(f["id"], f.get("text", f["id"])[:30]) for f in frags]

    def all_cutscene_ids(self) -> list[tuple[str, str]]:
        return [(c["id"], c["id"]) for c in self.cutscenes]

    def all_parallax_scene_ids(self) -> list[tuple[str, str]]:
        """`(id, label)`：parallax_scenes.json 的场景 id，供 present:parallaxScene 步选场景。

        label 附图层数，方便在下拉里辨认（如 `shenxianding_02_demo · 2 层`）。
        """
        out: list[tuple[str, str]] = []
        for s in self.parallax_scenes:
            if not isinstance(s, dict):
                continue
            sid = str(s.get("id") or "").strip()
            if not sid:
                continue
            n = len(s.get("layers") or []) if isinstance(s.get("layers"), list) else 0
            out.append((sid, f"{sid} · {n} 层"))
        return out

    def all_shop_ids(self) -> list[tuple[str, str]]:
        return [(s["id"], s.get("name", s["id"])) for s in self.shops]

    def all_water_minigame_ids(self) -> list[tuple[str, str]]:
        """`(id, label)`：`water_minigames/index.json` 登记项。"""
        out: list[tuple[str, str]] = []
        for row in self.water_minigames_index:
            if not isinstance(row, dict):
                continue
            iid = str(row.get("id") or "").strip()
            if not iid:
                continue
            label = str(row.get("label") or "").strip()
            out.append((iid, label or iid))
        return out

    def all_sugar_wheel_minigame_ids(self) -> list[tuple[str, str]]:
        """`(id, label)`：`sugar_wheel/index.json` 登记项。"""
        out: list[tuple[str, str]] = []
        for row in self.sugar_wheel_index:
            if not isinstance(row, dict):
                continue
            iid = str(row.get("id") or "").strip()
            if not iid:
                continue
            label = str(row.get("label") or "").strip()
            out.append((iid, label or iid))
        return out

    def all_paper_craft_minigame_ids(self) -> list[tuple[str, str]]:
        """`(id, label)`：`paper_craft/index.json` 登记项。"""
        out: list[tuple[str, str]] = []
        for row in self.paper_craft_index:
            if not isinstance(row, dict):
                continue
            iid = str(row.get("id") or "").strip()
            if not iid:
                continue
            label = str(row.get("label") or "").strip()
            out.append((iid, label or iid))
        return out

    def all_plane_ids(self) -> list[tuple[str, str]]:
        """`(id, label)`：planes.json（PlaneDef[]）登记项。文件缺失时为空列表；按 id 去重（保留首条）。"""
        out: list[tuple[str, str]] = []
        seen: set[str] = set()
        for row in self.planes:
            if not isinstance(row, dict):
                continue
            pid = str(row.get("id") or "").strip()
            if not pid or pid in seen:
                continue
            seen.add(pid)
            label = str(row.get("label") or "").strip()
            out.append((pid, label or pid))
        return out

    def plane_membership(self, plane_id: str) -> str:
        """位面世界模型 'shared' | 'exclusive'（与运行时 PlaneReconciler 同口径）。

        本位面未写 membership 时沿 extends 链向父解析（槽级继承）；normal / 未登记 /
        链断裂 / 成环兜底 shared（保守：世界保持可见）。
        """
        pid = str(plane_id or "").strip()
        if not pid or pid == "normal":
            return "shared"
        by_id: dict[str, dict] = {}
        for row in self.planes:
            if isinstance(row, dict):
                rid = str(row.get("id") or "").strip()
                if rid and rid not in by_id:
                    by_id[rid] = row
        trail: set[str] = set()
        cur: str | None = pid
        while cur and cur in by_id and cur not in trail:
            trail.add(cur)
            row = by_id[cur]
            mem = row.get("membership")
            if mem == "exclusive":
                return "exclusive"
            if mem == "shared":
                return "shared"
            ext = row.get("extends")
            cur = str(ext).strip() if isinstance(ext, str) and ext.strip() else None
        return "shared"

    def all_narrative_template_ids(self) -> list[tuple[str, str]]:
        """`(id, label)`：narrative_templates.json 的模板条目。文件缺失时为空列表。"""
        out: list[tuple[str, str]] = []
        data = self.narrative_templates if isinstance(self.narrative_templates, dict) else {}
        for row in data.get("templates") or []:
            if not isinstance(row, dict):
                continue
            tid = str(row.get("id") or "").strip()
            if not tid:
                continue
            label = str(row.get("label") or "").strip()
            out.append((tid, label or tid))
        return out

    def all_smell_profile_ids(self) -> list[tuple[str, str]]:
        """`(id, name)`：smell_profiles.json 的 profiles 词条（供 setSmell.scent 下拉）。"""
        data = self.smell_profiles if isinstance(self.smell_profiles, dict) else {}
        profs = data.get("profiles", {})
        out: list[tuple[str, str]] = []
        if isinstance(profs, dict):
            for pid, p in profs.items():
                name = (p.get("name") if isinstance(p, dict) else "") or pid
                out.append((str(pid), str(name)))
        return out

    def all_filter_ids(self) -> list[str]:
        return list(self.filter_defs.keys())

    def all_audio_ids(self, channel: str) -> list[str]:
        return list(self.audio_config.get(channel, {}).keys())

    def all_anim_files(self) -> list[str]:
        """动画包目录名（与 `animation/<id>/anim.json` 的 id 一致）。"""
        return list(self.animations.keys())

    def all_dialogue_graph_ids(self) -> list[str]:
        """`dialogues/graphs/<id>.json` 的 id（不含扩展名）。"""
        if self.project_path is None:
            return []
        gp = self.dialogues_path / "graphs"
        if not gp.is_dir():
            return []
        return sorted(p.stem for p in gp.glob("*.json"))

    def scenario_ids_ordered(self) -> list[str]:
        """scenarios.json 中 ``scenarios[].id``，按文件内数组顺序。"""
        raw = self.scenarios_catalog.get("scenarios") or []
        if not isinstance(raw, list):
            return []
        out: list[str] = []
        for e in raw:
            if isinstance(e, dict):
                sid = e.get("id")
                if sid is not None and str(sid).strip():
                    out.append(str(sid).strip())
        return out

    def narrative_graph_ids_ordered(self) -> list[str]:
        """Runtime graph ids compiled from narrative compositions.

        Kept for older callers that need graph choices; the editor itself uses
        compositions as its top-level authoring unit.
        """
        if not isinstance(self.narrative_graphs, dict):
            return []
        out: list[str] = []
        comps = self.narrative_graphs.get("compositions")
        if isinstance(comps, list):
            for comp in comps:
                if not isinstance(comp, dict):
                    continue
                main = comp.get("mainGraph")
                if isinstance(main, dict):
                    gid = str(main.get("id", "")).strip()
                    if gid:
                        out.append(gid)
                elements = comp.get("elements")
                if not isinstance(elements, list):
                    continue
                for el in elements:
                    if not isinstance(el, dict):
                        continue
                    if el.get("kind") not in ("wrapperGraph", "scenarioSubgraph"):
                        continue
                    graph = el.get("graph")
                    if isinstance(graph, dict):
                        gid = str(graph.get("id", "")).strip()
                        if gid:
                            out.append(gid)
            return out
        raw = self.narrative_graphs.get("graphs")
        if isinstance(raw, list):
            return [
                str(g.get("id", "")).strip()
                for g in raw
                if isinstance(g, dict) and str(g.get("id", "")).strip()
            ]
        return []

    def narrative_composition_ids_ordered(self) -> list[str]:
        if not isinstance(self.narrative_graphs, dict):
            return []
        raw = self.narrative_graphs.get("compositions")
        if not isinstance(raw, list):
            return []
        return [
            str(c.get("id", "")).strip()
            for c in raw
            if isinstance(c, dict) and str(c.get("id", "")).strip()
        ]

    def narrative_signal_rows(self) -> list[tuple[str, str]]:
        """Registered narrative signals as ``(display, id)`` rows for pickers."""
        if not isinstance(self.narrative_graphs, dict):
            return []
        raw = self.narrative_graphs.get("signals")
        if not isinstance(raw, list):
            return []
        out: list[tuple[str, str]] = []
        seen: set[str] = set()
        for row in raw:
            if not isinstance(row, dict):
                continue
            sid = str(row.get("id") or "").strip()
            if not sid or sid in seen:
                continue
            seen.add(sid)
            label = str(row.get("label") or "").strip()
            desc = str(row.get("description") or "").strip()
            if label and label != sid:
                display = f"{sid} - {label}"
            else:
                display = sid
            if desc:
                display = f"{display} ({desc[:48]})"
            out.append((display, sid))
        return out

    def all_scene_entity_ids(self) -> list[tuple[str, str]]:
        out: list[tuple[str, str]] = []
        for sid, scene in sorted(self.scenes.items()):
            if not isinstance(scene, dict):
                continue
            for kind, label in (("npcs", "npc"), ("hotspots", "hotspot"), ("zones", "zone")):
                arr = scene.get(kind)
                if not isinstance(arr, list):
                    continue
                for e in arr:
                    if not isinstance(e, dict):
                        continue
                    eid = str(e.get("id", "")).strip()
                    if eid:
                        out.append((eid, f"{label}:{eid} @ {sid}"))
        return out

    def phases_for_scenario(self, scenario_id: str) -> list[str]:
        """某 scenario 的 ``phases`` 键名列表（与 scenarios.json 中对象键顺序一致）。"""
        sid = (scenario_id or "").strip()
        if not sid:
            return []
        raw = self.scenarios_catalog.get("scenarios") or []
        if not isinstance(raw, list):
            return []
        for e in raw:
            if not isinstance(e, dict):
                continue
            if str(e.get("id", "")).strip() != sid:
                continue
            ph = e.get("phases")
            if isinstance(ph, dict):
                return [str(k) for k in ph.keys()]
            return []
        return []

    def _rebuild_dialogue_graph_ids_from_graph_files(self) -> bool:
        """按各图根级 meta.scenarioId 汇总到 scenarios[].dialogueGraphIds；有变化返回 True。"""
        from .file_io import read_json

        links: dict[str, list[str]] = {}
        for stem in self.all_dialogue_graph_ids():
            p = self.dialogues_path / "graphs" / f"{stem}.json"
            try:
                data = read_json(p)
            except Exception:
                continue
            if not isinstance(data, dict):
                continue
            gid = str(data.get("id", stem)).strip() or stem
            meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
            sid = str(meta.get("scenarioId", "")).strip()
            if sid:
                links.setdefault(sid, [])
                if gid not in links[sid]:
                    links[sid].append(gid)
        for ids in links.values():
            ids.sort(key=lambda x: (x.lower(), x))
        raw = self.scenarios_catalog.get("scenarios")
        if not isinstance(raw, list):
            return False
        changed = False
        for e in raw:
            if not isinstance(e, dict):
                continue
            sid = str(e.get("id", "")).strip()
            new_arr = list(links.get(sid, []))
            old_raw = e.get("dialogueGraphIds")
            if not isinstance(old_raw, list):
                old_norm: list[str] = []
            else:
                old_norm = [str(x).strip() for x in old_raw if str(x).strip()]
            if old_norm != new_arr:
                changed = True
                if new_arr:
                    e["dialogueGraphIds"] = new_arr
                elif "dialogueGraphIds" in e:
                    del e["dialogueGraphIds"]
        return changed

    def relink_dialogue_graph_to_scenarios(self, graph_id: str, scenario_id: str | None) -> bool:
        """图 meta.scenarioId 变化时：从所有 scenario 的 dialogueGraphIds 去掉本图，再挂到目标 scenario。有改动返回 True。"""
        gid = (graph_id or "").strip()
        if not gid:
            return False
        raw = self.scenarios_catalog.get("scenarios")
        if not isinstance(raw, list):
            return False

        def _dg_snapshot() -> str:
            snap: list[Any] = []
            for e in raw:
                if isinstance(e, dict):
                    snap.append(e.get("dialogueGraphIds"))
                else:
                    snap.append(None)
            return json.dumps(snap, ensure_ascii=False)

        before = _dg_snapshot()
        for e in raw:
            if not isinstance(e, dict):
                continue
            arr = e.get("dialogueGraphIds")
            if not isinstance(arr, list):
                continue
            narr = [str(x).strip() for x in arr if str(x).strip() and str(x).strip() != gid]
            if narr:
                e["dialogueGraphIds"] = narr
            elif "dialogueGraphIds" in e:
                del e["dialogueGraphIds"]
        new_s = (scenario_id or "").strip()
        if new_s:
            for e in raw:
                if not isinstance(e, dict):
                    continue
                if str(e.get("id", "")).strip() != new_s:
                    continue
                arr = e.get("dialogueGraphIds")
                if not isinstance(arr, list):
                    arr = []
                else:
                    arr = [str(x).strip() for x in arr if str(x).strip()]
                if gid not in arr:
                    arr.append(gid)
                    arr.sort(key=lambda x: (x.lower(), x))
                e["dialogueGraphIds"] = arr
                break
        if _dg_snapshot() != before:
            self.mark_dirty("scenarios")
            return True
        return False

    def rename_dialogue_graph_in_scenarios_catalog(self, old_id: str, new_id: str) -> None:
        """图根 id 重命名时，替换各 scenario.dialogueGraphIds 中的引用。"""
        o = (old_id or "").strip()
        n = (new_id or "").strip()
        if not o or not n or o == n:
            return
        raw = self.scenarios_catalog.get("scenarios")
        if not isinstance(raw, list):
            return
        changed = False
        for e in raw:
            if not isinstance(e, dict):
                continue
            arr = e.get("dialogueGraphIds")
            if not isinstance(arr, list):
                continue
            old_norm = [str(x).strip() for x in arr if str(x).strip()]
            repl: list[str] = [n if x == o else x for x in old_norm]
            seen: set[str] = set()
            dedup: list[str] = []
            for x in repl:
                if x not in seen:
                    seen.add(x)
                    dedup.append(x)
            if dedup != old_norm:
                changed = True
                if dedup:
                    e["dialogueGraphIds"] = dedup
                elif "dialogueGraphIds" in e:
                    del e["dialogueGraphIds"]
        if changed:
            self.mark_dirty("scenarios")

    def document_reveal_ids(self) -> list[str]:
        """document_reveals.json 各条目的 ``id``（去空白，保持列表顺序）。"""
        out: list[str] = []
        for d in self.document_reveals or []:
            if isinstance(d, dict):
                i = d.get("id")
                if i is not None and str(i).strip():
                    out.append(str(i).strip())
        return out

    def all_archive_document_ids(self) -> list[tuple[str, str]]:
        """archive/documents.json 条目 ``(id, name)``，供文档揭示等选择 documentId。"""
        out: list[tuple[str, str]] = []
        for d in self.archive_documents or []:
            if not isinstance(d, dict):
                continue
            i = d.get("id")
            if i is None or not str(i).strip():
                continue
            rid = str(i).strip()
            out.append((rid, str(d.get("name", rid))))
        return out

    def anim_asset_path_choices(self) -> list[tuple[str, str]]:
        """(runtime path /resources/runtime/animation/<id>/anim.json, 显示名) for npc animFile."""
        return [
            (f"/resources/runtime/animation/{stem}/anim.json", stem)
            for stem in self.all_anim_files()
        ]

    def overlay_short_id_entries(self) -> list[tuple[str, str]]:
        """overlay_images.json 的短 id 键，供 show/hide/blend 叠图动作 id 下拉。"""
        if not isinstance(self.overlay_images, dict):
            return []
        out: list[tuple[str, str]] = []
        for k in sorted(self.overlay_images.keys(), key=lambda x: (str(x).lower(), str(x))):
            ks = str(k).strip()
            if ks:
                out.append((ks, ks))
        return out

    def actor_id_items_for_scene(self, scene_id: str | None) -> list[tuple[str, str]]:
        """与 Game.resolveActor 一致：过场临时演员 + 当前场景 NPC + player。"""
        items: list[tuple[str, str]] = []
        for tid, disp in self.collect_cutscene_temp_actor_ids():
            items.append((tid, disp))
        for nid, label in self.npc_ids_for_scene(scene_id):
            items.append((nid, label))
        items.append(("player", "player"))
        return items

    def npc_actor_items_for_scene(self, scene_id: str | None) -> list[tuple[str, str]]:
        """仅场景 NPC（persistNpc* / stopNpcPatrol 等，不含 player 与 _cut_）。"""
        return list(self.npc_ids_for_scene(scene_id))

    def collect_cutscene_temp_actor_ids(self) -> list[tuple[str, str]]:
        """从所有过场 steps 收集 cutsceneSpawnActor 的 _cut_* id（跨过场全集）。"""
        found: set[str] = set()
        for cs in self.cutscenes:
            for tid in self._walk_cutscene_spawn_ids(cs.get("steps") or []):
                found.add(tid)
        ordered = sorted(found, key=lambda x: (x.lower(), x))
        return [(i, i) for i in ordered]

    def cutscene_temp_actor_ids_in_cutscene(self, cutscene_id: str) -> list[str]:
        """单个过场内 cutsceneSpawnActor 产生的 _cut_* id 列表（有序、去重）。"""
        cid = (cutscene_id or "").strip()
        if not cid:
            return []
        target = next((c for c in self.cutscenes if str(c.get("id", "")) == cid), None)
        if not isinstance(target, dict):
            return []
        found: set[str] = set()
        for tid in self._walk_cutscene_spawn_ids(target.get("steps") or []):
            found.add(tid)
        return sorted(found, key=lambda x: (x.lower(), x))

    @staticmethod
    def _walk_cutscene_spawn_ids(steps: list):
        """遍历 steps / parallel tracks，产出 _cut_ 开头的 spawn id。"""
        for step in steps or []:
            if not isinstance(step, dict):
                continue
            if step.get("kind") == "action" and step.get("type") == "cutsceneSpawnActor":
                p = step.get("params") or {}
                i = str(p.get("id") or "").strip()
                if i.startswith("_cut_"):
                    yield i
            tr = step.get("tracks")
            if isinstance(tr, list):
                for sub in tr:
                    if isinstance(sub, dict):
                        yield from ProjectModel._walk_cutscene_spawn_ids([sub])

    def animation_state_names_for_manifest(self, manifest_path: str) -> list[str]:
        """anim.json 内 states 的键名列表（有序）。"""
        p = (manifest_path or "").strip()
        if not p.startswith("/resources/runtime/animation/"):
            return []
        rel = p[len("/resources/runtime/animation/"):]
        stem = rel.split("/", 1)[0]
        if not stem:
            return []
        data = self.animations.get(stem)
        if not isinstance(data, dict):
            return []
        st = data.get("states")
        if not isinstance(st, dict):
            return []
        return [str(k) for k in st.keys()]

    def npc_anim_manifest_for_scene(self, scene_id: str | None, npc_id: str) -> str:
        """某场景 NPC 的 animFile 路径；找不到则返回空字符串。"""
        nid = (npc_id or "").strip()
        if not nid or not scene_id:
            return ""
        sc = self.scenes.get(scene_id) or {}
        for npc in sc.get("npcs") or []:
            if not isinstance(npc, dict):
                continue
            raw = npc.get("id") or npc.get("npcId")
            if raw is None or str(raw).strip() != nid:
                continue
            af = self.character_field(npc, "animFile")
            if af.strip():
                return af.strip()
        return ""

    def player_avatar_anim_manifest(self) -> str:
        """game_config.playerAvatar.animManifest（默认玩家动画包）。"""
        pa = self.game_config.get("playerAvatar") if isinstance(self.game_config, dict) else None
        if not isinstance(pa, dict):
            return ""
        am = pa.get("animManifest")
        return str(am).strip() if am is not None else ""

    def animation_state_names_for_actor(self, scene_id: str | None, actor_id: str) -> list[str]:
        """resolveActor 目标当前可用的动画 state 名（player 用配置 animManifest，NPC 用 animFile）。"""
        aid = (actor_id or "").strip()
        if not aid:
            return []
        if aid == "player":
            return self.animation_state_names_for_manifest(self.player_avatar_anim_manifest())
        mf = self.npc_anim_manifest_for_scene(scene_id, aid)
        return self.animation_state_names_for_manifest(mf)

    def dialogue_graph_node_ids(self, graph_id: str) -> list[str]:
        """对话图 JSON nodes 的键名（与 entry 一致）。"""
        gid = (graph_id or "").strip()
        if not gid:
            return []
        p = self.dialogues_path / "graphs" / f"{gid}.json"
        data = self._load(p, {})
        if not isinstance(data, dict):
            return []
        nodes = data.get("nodes")
        if not isinstance(nodes, dict):
            return []
        return sorted((str(k) for k in nodes.keys()), key=lambda x: (x.lower(), x))

    def illustration_asset_choices(self) -> list[tuple[str, str]]:
        """Known illustration paths under /resources/runtime/images/illustrations/."""
        root = self.runtime_resources_path / "images" / "illustrations"
        if not root.is_dir():
            return []
        out: list[tuple[str, str]] = []
        for pat in ("*.png", "*.jpg", "*.webp"):
            for p in sorted(root.glob(pat)):
                out.append((f"/resources/runtime/images/illustrations/{p.name}", p.name))
        return out

    def audio_src_choices(self) -> list[tuple[str, str]]:
        """Existing wav under resources/runtime/audio for audio_config src."""
        root = self.runtime_resources_path / "audio"
        if not root.is_dir():
            return []
        return [(f"/resources/runtime/audio/{p.name}", p.name) for p in sorted(root.glob("*.wav"))]

    def all_flags(self) -> set[str]:
        """Collect every flag name referenced across the project data."""
        flags: set[str] = set()
        self._collect_flags_from_conditions(self.quests, flags)
        self._collect_flags_from_conditions(self.encounters, flags)
        self._collect_flags_from_conditions(self.map_nodes, flags)
        for sc in self.scenes.values():
            self._collect_flags_from_scene(sc, flags)
        # Cutscene 使用新 steps schema（无副作用，不含 set_flag）
        for it in self.items:
            for dd in it.get("dynamicDescriptions", []):
                for cond in dd.get("conditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
        for ch in self.archive_characters:
            for cond in ch.get("unlockConditions", []):
                if "flag" in cond:
                    flags.add(cond["flag"])
            for imp in ch.get("impressions", []):
                for cond in imp.get("conditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
            for ki in ch.get("knownInfo", []):
                for cond in ki.get("conditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
        entries = self.archive_lore
        if isinstance(entries, dict):
            entries = entries.get("entries", [])
        for le in entries:
            for cond in le.get("unlockConditions", []):
                if "flag" in cond:
                    flags.add(cond["flag"])
        for doc in self.archive_documents:
            for cond in doc.get("discoverConditions", []):
                if "flag" in cond:
                    flags.add(cond["flag"])
        for bk in self.archive_books:
            for pg in bk.get("pages", []):
                for cond in pg.get("unlockConditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
        return flags

    def registry_flag_choices(self, scene_id: str | None = None) -> list[str]:
        """Editor-only: static + pattern-expanded keys from flag_registry (single source)."""
        from .flag_registry import expand_registry_flag_keys
        return expand_registry_flag_keys(self.flag_registry, self, scene_id=scene_id)

    # ---- private helpers --------------------------------------------------

    @staticmethod
    def _collect_flags_from_conditions(items: list[dict], flags: set[str]) -> None:
        for item in items:
            for key in ("preconditions", "completionConditions", "conditions",
                        "unlockConditions", "discoverConditions"):
                for cond in item.get(key, []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
            for opt in item.get("options", []):
                for cond in opt.get("conditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])
                for act in opt.get("resultActions", []):
                    p = act.get("params", {})
                    if act.get("type") == "setFlag" and "key" in p:
                        flags.add(p["key"])
            for act in item.get("acceptActions", []):
                p = act.get("params", {})
                if act.get("type") == "setFlag" and "key" in p:
                    flags.add(p["key"])
            for act in item.get("rewards", []):
                p = act.get("params", {})
                if act.get("type") == "setFlag" and "key" in p:
                    flags.add(p["key"])
            for edge in item.get("nextQuests", []):
                for cond in edge.get("conditions", []):
                    if "flag" in cond:
                        flags.add(cond["flag"])

    @staticmethod
    def _collect_flags_from_scene(sc: dict, flags: set[str]) -> None:
        for act in sc.get("onEnter", []) or []:
            if not isinstance(act, dict):
                continue
            p = act.get("params", {}) or {}
            if act.get("type") == "setFlag" and "key" in p:
                flags.add(p["key"])
            elif act.get("type") == "enableRuleOffers":
                for slot in (p.get("slots") or []):
                    if not isinstance(slot, dict):
                        continue
                    for ract in slot.get("resultActions", []) or []:
                        rp = ract.get("params", {}) or {}
                        if ract.get("type") == "setFlag" and "key" in rp:
                            flags.add(rp["key"])
        for hs in sc.get("hotspots", []):
            for cond in hs.get("conditions", []):
                if "flag" in cond:
                    flags.add(cond["flag"])
            data = hs.get("data", {})
            for act in data.get("actions", []):
                p = act.get("params", {})
                if act.get("type") == "setFlag" and "key" in p:
                    flags.add(p["key"])
        for zone in sc.get("zones", []):
            for cond in zone.get("conditions", []):
                if "flag" in cond:
                    flags.add(cond["flag"])
            for ev in ("onEnter", "onStay", "onExit"):
                for act in zone.get(ev, []) or []:
                    p = act.get("params", {}) or {}
                    at = act.get("type")
                    if at == "setFlag" and "key" in p:
                        flags.add(p["key"])
                    elif at == "enableRuleOffers":
                        for slot in (p.get("slots") or []):
                            if not isinstance(slot, dict):
                                continue
                            for ract in slot.get("resultActions", []) or []:
                                rp = ract.get("params", {}) or {}
                                if ract.get("type") == "setFlag" and "key" in rp:
                                    flags.add(rp["key"])
