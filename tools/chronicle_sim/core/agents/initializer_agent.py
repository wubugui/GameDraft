from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from tools.chronicle_sim.core.llm.client_factory import LLMClient
from tools.chronicle_sim.core.llm.json_extract import LLMJSONError, parse_json_object
from tools.chronicle_sim.core.runtime.agent_state import AgentState
from tools.chronicle_sim.core.runtime.base_agent import BaseAgent
from tools.chronicle_sim.core.runtime.event_bus import EventBus
from tools.chronicle_sim.core.runtime.history_buffer import HistoryBuffer
from tools.chronicle_sim.core.runtime.memory_store import MemoryStore
from tools.chronicle_sim.core.schema.models import SeedDraft
from tools.chronicle_sim.core.storage.seed_md_catalog import build_library_blob
from tools.chronicle_sim.paths import DATA_DIR

_CATALOG_MAX_CHARS = 50_000

_SEED_FIELD_NAMES = frozenset(SeedDraft.model_fields.keys())

_WRAPPER_KEY_LOWER = frozenset(
    {
        "seed",
        "seed_draft",
        "draft",
        "result",
        "data",
        "output",
        "payload",
        "response",
        "answer",
        "content",
        "json",
        "object",
        "root",
    }
)

_CN_TOP_ALIASES: dict[str, str] = {
    "世界观": "world_setting",
    "世界设定": "world_setting",
    "设计支柱": "design_pillars",
    "設計支柱": "design_pillars",
    "自定义章节": "custom_sections",
    "自定义区块": "custom_sections",
    "角色": "agents",
    "人物": "agents",
    "角色列表": "agents",
    "势力": "factions",
    "派系": "factions",
    "地点": "locations",
    "场所": "locations",
    "地图": "locations",
    "关系": "relationships",
    "人物关系": "relationships",
    "锚点事件": "anchor_events",
    "大事": "anchor_events",
    "社交图边": "social_graph_edges",
    "社交边": "social_graph_edges",
    "图边": "social_graph_edges",
    "事件类型候选": "event_type_candidates",
    "事件类型": "event_type_candidates",
}


def _camel_to_snake(name: str) -> str:
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1_\2", name)
    s = re.sub(r"([a-z\d])([A-Z])", r"\1_\2", s)
    return s.replace("-", "_").lower()


def _looks_like_seed_root(d: dict[str, Any]) -> bool:
    return "world_setting" in d or "agents" in d


def _unwrap_seed_wrappers(data: dict[str, Any], max_depth: int = 10) -> dict[str, Any]:
    """剥掉 {\"seed\": {...}}、{\"data\": {...}} 等单层包装，直到出现并列的 SeedDraft 顶层键。"""
    cur: Any = data
    for _ in range(max_depth):
        if not isinstance(cur, dict):
            break
        if len(cur) != 1:
            break
        sole_k, inner = next(iter(cur.items()))
        if not isinstance(inner, dict):
            break
        lk = str(sole_k).lower().replace(" ", "_")
        if lk.endswith("_draft") or lk.endswith("draft"):
            cur = inner
            continue
        if lk in _WRAPPER_KEY_LOWER:
            cur = inner
            continue
        if _looks_like_seed_root(inner):
            cur = inner
            continue
        break
    return cur if isinstance(cur, dict) else data


def _apply_top_level_key_aliases(data: dict[str, Any]) -> dict[str, Any]:
    """将中文或驼峰顶层键映射到 SeedDraft 英文键（仅当目标缺失或为空时写入，避免误覆盖）。"""
    out = dict(data)
    to_delete: list[str] = []
    for k, v in list(out.items()):
        if k in _SEED_FIELD_NAMES:
            continue
        nk = _CN_TOP_ALIASES.get(k)
        if nk is None and isinstance(k, str):
            cand = _camel_to_snake(k)
            if cand in _SEED_FIELD_NAMES:
                nk = cand
        if nk is None:
            continue
        cur = out.get(nk)
        empty = cur in (None, [], {})
        if nk == "world_setting" and isinstance(v, dict) and isinstance(cur, dict) and cur:
            merged = dict(cur)
            merged.update(v)
            out[nk] = merged
            to_delete.append(k)
            continue
        if empty:
            out[nk] = v
            to_delete.append(k)
    for k in to_delete:
        out.pop(k, None)
    return out


def _parsed_seed_body_empty(data: dict[str, Any]) -> bool:
    """解析得到的 dict 是否不含任何可入库的种子主体（用于识别键名语言不符等）。"""
    ws = data.get("world_setting")
    if isinstance(ws, dict) and len(ws) > 0:
        return False
    if isinstance(ws, str) and ws.strip():
        return False
    ag = data.get("agents")
    if isinstance(ag, list) and len(ag) > 0:
        return False
    if isinstance(ag, dict) and len(ag) > 0:
        return False
    for k in (
        "design_pillars",
        "custom_sections",
        "factions",
        "locations",
        "relationships",
        "anchor_events",
        "social_graph_edges",
        "event_type_candidates",
    ):
        v = data.get(k)
        if isinstance(v, list) and len(v) > 0:
            return False
        if isinstance(v, dict) and len(v) > 0:
            return False
    return True


def _as_dict_list(v: Any) -> list[dict[str, Any]]:
    """LLM 常把「名称列表」写成 str 数组；SeedDraft 要求 list[dict]。"""
    if not isinstance(v, list):
        return []
    out: list[dict[str, Any]] = []
    for item in v:
        if isinstance(item, dict):
            out.append(item)
        elif isinstance(item, str) and item.strip():
            s = item.strip()
            out.append({"id": s[:120], "label": s})
    return out


def _normalize_agents(v: Any) -> list[dict[str, Any]]:
    """LLM 常把 agents 写成 { agent_id: { name, ... } }；本工具要 list[{id, ...}]。"""
    if isinstance(v, list):
        return [x for x in v if isinstance(x, dict)]
    if isinstance(v, dict):
        rows: list[dict[str, Any]] = []
        for aid, body in v.items():
            if not isinstance(body, dict):
                continue
            row = dict(body)
            if not row.get("id"):
                row["id"] = str(aid)
            rows.append(row)
        return rows
    return []


def _unwrap_outer_single_key(data: dict[str, Any]) -> dict[str, Any]:
    """{"seed": { world_setting: ... } } 或 {"result": {...}}。"""
    if len(data) != 1:
        return data
    inner = next(iter(data.values()))
    if isinstance(inner, dict) and "world_setting" in inner:
        return inner
    return data


def _hoist_misnested_seed_fields(data: dict[str, Any]) -> dict[str, Any]:
    """把误塞进 world_setting 的并列顶层数组提到根上。"""
    ws = data.get("world_setting")
    if not isinstance(ws, dict):
        return data
    hoist_keys = [k for k in SeedDraft.model_fields if k != "world_setting"]
    out = dict(data)
    new_ws = dict(ws)
    moved = False
    for k in hoist_keys:
        nested = new_ws.get(k)
        if nested is None:
            continue
        top = out.get(k)
        if top in (None, [], {}):
            out[k] = nested
            del new_ws[k]
            moved = True
    if moved:
        out["world_setting"] = new_ws
    return out


class InitializerAgent(BaseAgent):
    """从「设定 MD 库」与可选旧版根目录 md 抽取结构化种子（含世界观/支柱/自定义区块）。"""

    def __init__(
        self,
        llm: LLMClient,
        memory: MemoryStore,
        history: HistoryBuffer,
        state: AgentState,
        bus: EventBus,
        *,
        prompts_dir: Path | None = None,
    ) -> None:
        super().__init__("initializer", llm, memory, history, state, bus)
        self._prompts_dir = prompts_dir if prompts_dir is not None else DATA_DIR / "prompts"

    def _system_prompt(self, target_npc_count: int, truncated: bool) -> str:
        p = self._prompts_dir / "initializer_agent.md"
        note = ""
        if truncated:
            note = (
                f"\n\n（用户设定原文已截断，仅见前 {_CATALOG_MAX_CHARS} 字符；"
                "请在有限信息下仍输出完整闭合的 JSON 根对象。）"
            )
        if p.is_file():
            tpl = p.read_text(encoding="utf-8")
            return (
                tpl.replace("{{TARGET_NPC_COUNT}}", str(target_npc_count))
                .replace("{{TRUNCATION_NOTE}}", note)
            )
        return (
            "你是编年史模拟器的种子抽取器，只输出一个 SeedDraft JSON 对象，"
            f"agents 约 {target_npc_count} 条，suggested_tier 仅 S/A/B。"
            + note
        )

    def _coerce_llm_dict(self, data: dict[str, Any]) -> dict[str, Any]:
        """LLM 返回的松散 dict 对齐 SeedDraft 各键类型。"""
        v_ws = data.get("world_setting")
        if isinstance(v_ws, str) and v_ws.strip():
            try:
                parsed = json.loads(v_ws)
                v_ws = parsed if isinstance(parsed, dict) else {"raw_author_notes": v_ws[:8000]}
            except json.JSONDecodeError:
                v_ws = {"raw_author_notes": v_ws[:8000]}
        ws_out = v_ws if isinstance(v_ws, dict) else {}
        agents_raw = _normalize_agents(data.get("agents"))
        for a in agents_raw:
            st = str(a.get("suggested_tier") or "B").strip().upper()
            if st not in ("S", "A", "B"):
                a["suggested_tier"] = "B"
        return {
            "world_setting": ws_out,
            "design_pillars": _as_dict_list(data.get("design_pillars")),
            "custom_sections": _as_dict_list(data.get("custom_sections")),
            "agents": agents_raw,
            "factions": _as_dict_list(data.get("factions")),
            "locations": _as_dict_list(data.get("locations")),
            "relationships": _as_dict_list(data.get("relationships")),
            "anchor_events": _as_dict_list(data.get("anchor_events")),
            "social_graph_edges": _as_dict_list(data.get("social_graph_edges")),
            "event_type_candidates": _as_dict_list(data.get("event_type_candidates")),
        }

    async def run_extraction(
        self,
        target_npc_count: int = 50,
        *,
        use_legacy_project_blueprints: bool = False,
        progress_log: Any | None = None,
    ) -> SeedDraft:
        catalog_blob = build_library_blob(
            use_legacy_project_blueprints=use_legacy_project_blueprints,
        )
        if not catalog_blob.strip():
            catalog_blob = (
                "（当前「设定 MD 库」无已启用文档。请在配置页「设定 MD 库」添加并保存；"
                "或在生成种子时勾选「同时读取项目根目录旧版固定列表」。）"
            )
        original_len = len(catalog_blob)
        truncated = False
        if original_len > _CATALOG_MAX_CHARS:
            catalog_blob = catalog_blob[:_CATALOG_MAX_CHARS]
            truncated = True
            msg = (
                f"[种子] 设定原文已截断：原长 {original_len} 字符，仅发送前 {_CATALOG_MAX_CHARS} 字符。"
            )
            if progress_log:
                progress_log(msg)

        system = self._system_prompt(target_npc_count, truncated)
        messages: list[dict[str, str]] = [
            {"role": "system", "content": system},
            {
                "role": "user",
                "content": catalog_blob + "\n\n请仅输出根对象 JSON（不要围栏与说明文字）。",
            },
        ]
        last_err: Exception | None = None
        last_resp_text = ""
        for attempt in range(4):
            try:
                resp = await self.llm.chat(messages, json_schema={"type": "object"}, temperature=0.3)
                last_resp_text = resp.text or ""
                data = parse_json_object(last_resp_text)
                data = _unwrap_seed_wrappers(data)
                data = _unwrap_outer_single_key(data)
                data = _apply_top_level_key_aliases(data)
                data = _hoist_misnested_seed_fields(data)
                if _parsed_seed_body_empty(data) and len((last_resp_text or "").strip()) > 400:
                    keys_preview = list(data.keys())[:16]
                    raise ValueError(
                        "解析后的 JSON 在 world_setting、agents 等字段上仍为空，但输出较长；"
                        "请使用 SeedDraft 英文顶层键名（world_setting、agents 等），并与 world_setting 并列在根上。"
                        f"（当前顶层键示例：{keys_preview!r}）"
                    )
                coerced = self._coerce_llm_dict(data)
                return SeedDraft.model_validate(coerced)
            except (LLMJSONError, ValueError, TypeError, ValidationError) as e:
                last_err = e
                if attempt < 3:
                    if progress_log and isinstance(e, ValidationError):
                        progress_log(
                            f"[种子] 模型已返回 JSON，但结构与 SeedDraft 不符（将自动纠错重试，非 HTTP 重试）："
                            f"{e.errors()[:3]!r}…"
                        )
                    elif progress_log and isinstance(e, LLMJSONError):
                        progress_log(f"[种子] JSON 解析失败（将重试）：{e}")
                    snippet = last_resp_text[:360].replace("\n", "\\n")
                    if attempt == 0:
                        hint = (
                            f"上次输出无效：{e}。请仅输出一个 JSON 根对象，"
                            "含 world_setting、design_pillars、custom_sections、agents 等顶层键。"
                            f"（回复前 360 字预览：{snippet!r}）"
                        )
                    elif attempt == 1:
                        hint = (
                            f"仍无效：{e}。下一回复从首字符起必须是 {{ ，末尾闭合 }} ；"
                            "不要 markdown、不要前后缀。"
                            f"（预览：{snippet!r}）"
                        )
                    else:
                        hint = (
                            f"第三次仍失败：{e}。键名双引号，末尾无多余逗号。"
                            f"（预览：{snippet!r}）"
                        )
                    messages = list(messages) + [{"role": "user", "content": hint}]
                    continue
                raise RuntimeError(f"种子抽取失败（模型输出无效）：{e}") from e
        raise RuntimeError(f"种子抽取失败：{last_err}") from last_err

    async def step(self, week: int) -> Any:
        return None
