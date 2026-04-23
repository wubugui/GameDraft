"""ClineRunner —— 起 cline CLI 子进程；凭据来自 ProviderService。

行为参考旧 llm/backend/cline.py（已删除），但结构 / 错误 / 凭据来源全部改造：
1. cline_executable 自动探测（PATH / Windows %APPDATA%/npm/cline.cmd）
2. 临时 cwd `<run>/.chronicle_sim/ws/cline_<uuid>/`
3. `.clinerules/{01_role.md, 02_mcp.md (条件), 03_output_contract.md}` 由 spec 注入
4. `input.md`（user 全文）
5. argv：`cline task -y -a --config <dir> -c <cwd> --timeout <sec> [--json] <SHORT_PROMPT>`
   - 末参恒为短引导句（避免 Windows CreateProcess 命令行总长限制）
   - openai_compat + base_url：task 省略 -m（让 cline auth 写入的模型生效）
6. `cline auth -p openai -k <key> -m <model> -b <base>` 刷凭据（ollama 不传 -k）
7. env：`CLINE_DIR=<run>/.cline_config`，剥代理变量，`NO_PROXY=*`
8. Windows：`CREATE_NO_WINDOW`；libuv 0xC0000409 / UV_HANDLE_CLOSING / async.c 抖动重试 3 次
9. stderr 流式 → observer.on_log_line
10. 工作区文件优先回读（按 ref_artifact_filename），stdout 兜底
11. 成功后 archive_workspace（便于排查归档）
12. 错误分类映射到 AgentRunnerError
"""
from __future__ import annotations

import os
import shutil
import json
import re
from pathlib import Path
from time import monotonic
from typing import Any

from tools.chronicle_sim_v3.agents.errors import (
    AgentConfigError,
    AgentRunnerError,
)
from tools.chronicle_sim_v3.agents.resolver import ResolvedAgent
from tools.chronicle_sim_v3.agents.runners.base import (
    SubprocessAgentRunner,
    archive_workspace,
    build_no_proxy_env,
    materialize_temp_ws,
)
from tools.chronicle_sim_v3.agents.types import AgentResult, AgentTask
from tools.chronicle_sim_v3.llm.render import AgentSpec, load_spec
from tools.chronicle_sim_v3.llm.output_parse import parse_output
from tools.chronicle_sim_v3.llm.render import render
from tools.chronicle_sim_v3.llm.types import OutputSpec, Prompt as LLMPrompt
from tools.chronicle_sim_v3.providers.errors import ProviderError
from tools.chronicle_sim_v3.providers.types import ProviderKind, ResolvedProvider

_CLINE_DIRNAME = ".cline_config"

_INPUT_MD_TASK_PROMPT = (
    "完整任务与用户数据已写入当前工作目录 input.md（UTF-8）。"
    "请先用 read_file 读取 input.md 全文，再严格按 .clinerules 里的角色要求输出；"
    "勿以未收到任务正文为由拒答。"
)

_DEFAULT_OUTPUT_CONTRACT = """\
# 输出契约

- 严格按 01_role.md 定义的角色与输出格式；不要添加无关解释
- 若 OutputSpec.kind 为 json_object / json_array：直接输出合法 JSON，不要包 ``` 围栏
- 若 OutputSpec.kind 为 text：直接输出最终文本
- 完成后调用 attempt_completion 结束任务
"""


def _safe_json_load(text: str) -> Any:
    try:
        return json.loads(text)
    except Exception:
        return None


def _extract_json_block(text: str) -> Any:
    from tools.chronicle_sim_v3.llm.output_parse import _extract_json_candidate

    cand = _extract_json_candidate(text)
    if not cand:
        return None
    return _safe_json_load(cand)


def _parse_jsonish(value: Any, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        obj = _safe_json_load(value)
        if obj is not None:
            return obj
    return default


def _coerce_str_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list):
        out: list[str] = []
        for item in value:
            if item is None:
                continue
            s = str(item).strip()
            if s:
                out.append(s)
        return out
    return [str(value)]


def _coerce_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _lookup_nested(data: dict[str, Any], *keys: str) -> Any:
    cur: Any = data
    for key in keys:
        if not isinstance(cur, dict) or key not in cur:
            return None
        cur = cur[key]
    return cur


def _normalize_npc_intent(
    role_vars: dict[str, Any],
    parsed: Any,
    raw_text: str,
) -> dict[str, Any]:
    data = parsed if isinstance(parsed, dict) else {}
    agent_id = str(data.get("agent_id") or role_vars.get("agent_id") or "")
    week = _coerce_int(data.get("week"), _coerce_int(role_vars.get("week"), 0))
    intent_text = str(data.get("intent_text") or raw_text.strip() or "观望、打听消息")
    out = {
        "agent_id": agent_id,
        "week": week,
        "mood_delta": str(data.get("mood_delta") or "平"),
        "intent_text": intent_text,
        "target_ids": _coerce_str_list(data.get("target_ids")),
    }
    rel = _coerce_str_list(data.get("relationship_hints"))
    if rel:
        out["relationship_hints"] = rel
    return out


def _normalize_npc_perception(
    role_vars: dict[str, Any],
    parsed: Any,
    raw_text: str,
) -> dict[str, Any]:
    data = parsed if isinstance(parsed, dict) else {}
    location_json = _parse_jsonish(role_vars.get("location_json"), {})
    return {
        "agent_id": str(data.get("agent_id") or role_vars.get("agent_id") or ""),
        "week": _coerce_int(data.get("week"), _coerce_int(role_vars.get("week"), 0)),
        "known_facts": _coerce_str_list(data.get("known_facts")),
        "rumor_inputs": _coerce_str_list(data.get("rumor_inputs")),
        "attention_points": _coerce_str_list(data.get("attention_points")) or ([raw_text.strip()] if raw_text.strip() else []),
        "uncertainties": _coerce_str_list(data.get("uncertainties")),
        "location_focus": str(data.get("location_focus") or location_json.get("id") or location_json.get("name") or ""),
        "social_focus": _coerce_str_list(data.get("social_focus")),
    }


def _normalize_npc_action(
    role_vars: dict[str, Any],
    parsed: Any,
    raw_text: str,
) -> dict[str, Any]:
    data = parsed if isinstance(parsed, dict) else {}
    return {
        "agent_id": str(data.get("agent_id") or role_vars.get("agent_id") or ""),
        "week": _coerce_int(data.get("week"), _coerce_int(role_vars.get("week"), 0)),
        "action_summary": str(data.get("action_summary") or raw_text.strip() or "本周保持观望"),
        "action_type": str(data.get("action_type") or "observe"),
        "target_ids": _coerce_str_list(data.get("target_ids")),
        "location_hint": str(data.get("location_hint") or ""),
        "public_effect": str(data.get("public_effect") or ""),
        "private_effect": str(data.get("private_effect") or ""),
    }


def _normalize_npc_reflection(
    role_vars: dict[str, Any],
    parsed: Any,
    raw_text: str,
) -> dict[str, Any]:
    data = parsed if isinstance(parsed, dict) else {}
    summary = str(data.get("memory_summary") or raw_text.strip())
    return {
        "agent_id": str(data.get("agent_id") or role_vars.get("agent_id") or ""),
        "week": _coerce_int(data.get("week"), _coerce_int(role_vars.get("week"), 0)),
        "reflection": str(data.get("reflection") or raw_text.strip() or ""),
        "lessons": _coerce_str_list(data.get("lessons")),
        "belief_shift": _coerce_str_list(data.get("belief_shift")),
        "memory_summary": summary,
        # 为周流程后续沉积保留稳定字段
        "short_memory": {"summary": summary, "lessons": _coerce_str_list(data.get("lessons"))},
        "long_memory": {"summary": summary, "belief_shift": _coerce_str_list(data.get("belief_shift"))},
    }


def _normalize_group_intents(
    role_vars: dict[str, Any],
    parsed: Any,
    raw_text: str,
) -> dict[str, Any]:
    data = parsed if isinstance(parsed, dict) else {}
    group_agents = _parse_jsonish(role_vars.get("group_agents_json"), [])
    intents = data.get("intents")
    out_intents: list[dict[str, Any]] = []
    if isinstance(intents, list):
        for item in intents:
            if not isinstance(item, dict):
                continue
            aid = str(item.get("agent_id") or "")
            if not aid:
                continue
            out_intents.append({
                "agent_id": aid,
                "week": _coerce_int(item.get("week"), _coerce_int(role_vars.get("week"), 0)),
                "intent_text": str(item.get("intent_text") or "观望"),
            })
    if not out_intents and isinstance(group_agents, list):
        for agent in group_agents:
            if not isinstance(agent, dict):
                continue
            aid = str(agent.get("id") or "")
            if not aid:
                continue
            out_intents.append({
                "agent_id": aid,
                "week": _coerce_int(role_vars.get("week"), 0),
                "intent_text": "观望、打听消息",
            })
    return {
        "tier": str(data.get("tier") or role_vars.get("tier") or ""),
        "week": _coerce_int(data.get("week"), _coerce_int(role_vars.get("week"), 0)),
        "group_summary": str(data.get("group_summary") or raw_text.strip() or ""),
        "intents": out_intents,
    }


def _normalize_director_output(parsed: Any) -> dict[str, Any]:
    data = parsed if isinstance(parsed, dict) else {}
    drafts = data.get("drafts")
    out: list[dict[str, Any]] = []
    if isinstance(drafts, list):
        for d in drafts:
            if not isinstance(d, dict):
                continue
            out.append({
                "type_id": str(d.get("type_id") or ""),
                "week": _coerce_int(d.get("week"), 0),
                "location_id": d.get("location_id"),
                "actor_ids": _coerce_str_list(d.get("actor_ids")),
                "summary": str(d.get("summary") or ""),
                "draft_json": d.get("draft_json") if isinstance(d.get("draft_json"), dict) else {},
            })
    return {"drafts": out}


def _normalize_gm_output(parsed: Any) -> dict[str, Any]:
    data = parsed if isinstance(parsed, dict) else {}
    events = data.get("events")
    out: list[dict[str, Any]] = []
    if isinstance(events, list):
        for e in events:
            if not isinstance(e, dict):
                continue
            out.append({
                "id": str(e.get("id") or ""),
                "type_id": str(e.get("type_id") or ""),
                "week": _coerce_int(e.get("week"), 0),
                "location_id": e.get("location_id"),
                "actor": str(e.get("actor") or ""),
                "related": _coerce_str_list(e.get("related")),
                "witness": _coerce_str_list(e.get("witness")),
                "summary": str(e.get("summary") or ""),
                "truth": e.get("truth") if isinstance(e.get("truth"), dict) else {},
                "witness_accounts": e.get("witness_accounts") if isinstance(e.get("witness_accounts"), dict) else {},
            })
    return {"events": out}


def _normalize_social_state(parsed: Any, raw_text: str) -> dict[str, Any]:
    data = parsed if isinstance(parsed, dict) else {}
    return {
        "overview": str(data.get("overview") or raw_text.strip() or ""),
        "faction_states": data.get("faction_states") if isinstance(data.get("faction_states"), list) else [],
        "location_states": data.get("location_states") if isinstance(data.get("location_states"), list) else [],
        "group_states": data.get("group_states") if isinstance(data.get("group_states"), list) else [],
    }


def _normalize_story_clusters(parsed: Any) -> dict[str, Any]:
    data = parsed if isinstance(parsed, dict) else {}
    clusters = data.get("clusters")
    out: list[dict[str, Any]] = []
    if isinstance(clusters, list):
        for c in clusters:
            if not isinstance(c, dict):
                continue
            out.append({
                "id": str(c.get("id") or ""),
                "title": str(c.get("title") or ""),
                "focus": str(c.get("focus") or ""),
                "event_ids": _coerce_str_list(c.get("event_ids")),
                "rumor_keys": _coerce_str_list(c.get("rumor_keys")),
                "participants": _coerce_str_list(c.get("participants")),
                "story_hook": str(c.get("story_hook") or ""),
            })
    return {"clusters": out}


def _normalize_storylines(parsed: Any) -> dict[str, Any]:
    data = parsed if isinstance(parsed, dict) else {}
    storylines = data.get("storylines")
    out: list[dict[str, Any]] = []
    if isinstance(storylines, list):
        for s in storylines:
            if not isinstance(s, dict):
                continue
            out.append({
                "id": str(s.get("id") or ""),
                "title": str(s.get("title") or ""),
                "weeks": s.get("weeks") if isinstance(s.get("weeks"), list) else [],
                "cluster_ids": _coerce_str_list(s.get("cluster_ids")),
                "focus": str(s.get("focus") or ""),
                "next_hook": str(s.get("next_hook") or ""),
            })
    return {"storylines": out}


def _normalize_structured_output(
    *,
    spec_ref: str,
    role_vars: dict[str, Any],
    raw_text: str,
    parsed: Any,
) -> Any:
    name = Path(spec_ref).name
    if name in {"tier_s_npc.toml", "tier_a_npc.toml", "tier_b_npc.toml", "tier_c_npc.toml"}:
        return _normalize_npc_intent(role_vars, parsed, raw_text)
    if name == "npc_perception.toml":
        return _normalize_npc_perception(role_vars, parsed, raw_text)
    if name == "npc_action.toml":
        return _normalize_npc_action(role_vars, parsed, raw_text)
    if name == "npc_reflection.toml":
        return _normalize_npc_reflection(role_vars, parsed, raw_text)
    if name == "group_intent_pack.toml":
        return _normalize_group_intents(role_vars, parsed, raw_text)
    if name == "director.toml":
        return _normalize_director_output(parsed)
    if name == "gm.toml":
        return _normalize_gm_output(parsed)
    if name == "social_state_settler.toml":
        return _normalize_social_state(parsed, raw_text)
    if name == "story_clusterer.toml":
        return _normalize_story_clusters(parsed)
    if name == "storyline_aggregator.toml":
        return _normalize_storylines(parsed)
    return parsed


def resolve_cline_executable(explicit: str = "") -> str:
    if explicit:
        p = Path(explicit).expanduser()
        if p.is_file():
            return str(p.resolve())
        w = shutil.which(explicit)
        if w:
            return w
        return explicit
    for name in ("cline", "cline.cmd"):
        w = shutil.which(name)
        if w:
            return w
    if os.name == "nt":
        for env_key in ("APPDATA", "LOCALAPPDATA"):
            base = os.environ.get(env_key, "")
            if not base:
                continue
            for fname in ("cline.cmd", "cline"):
                cand = Path(base) / "npm" / fname
                if cand.is_file():
                    return str(cand.resolve())
    return "cline"


def _materialize_clinerules(ws: Path, spec: AgentSpec) -> None:
    rules = ws / ".clinerules"
    rules.mkdir()
    (rules / "01_role.md").write_text(
        spec.system or "(empty system)\n", encoding="utf-8"
    )
    if spec.needs_clinerules_mcp:
        (rules / "02_mcp.md").write_text(spec.mcp + "\n", encoding="utf-8")
    contract = spec.output_contract or _DEFAULT_OUTPUT_CONTRACT
    (rules / "03_output_contract.md").write_text(contract, encoding="utf-8")


def _build_auth_argv(
    exe: str,
    config_dir: Path,
    provider: ResolvedProvider,
    model_id: str,
    *,
    verbose: bool = False,
) -> list[str] | None:
    cfg = ["--config", str(config_dir)]

    def _vx(rest: list[str]) -> list[str]:
        return [exe, "--verbose", *rest] if verbose else [exe, *rest]

    kind: ProviderKind = provider.kind
    if kind in ("openai_compat", "dashscope_compat"):
        key = (provider.api_key or "").strip() or "no-api-key"
        model = (model_id or "gpt-4o-mini").strip()
        base = (provider.base_url or "").strip().rstrip("/")
        if not base:
            base = "https://api.openai.com/v1"
        return _vx([*cfg, "auth", "-p", "openai", "-k", key, "-m", model, "-b", base])
    if kind == "ollama":
        host = (provider.base_url or "http://127.0.0.1:11434").rstrip("/")
        model = (model_id or "llama3").strip()
        return _vx([*cfg, "auth", "-p", "ollama", "-m", model, "-b", f"{host}/v1"])
    if kind == "stub":
        # stub 不需要刷凭据
        return None
    return None


def _cline_task_model_flag(
    provider: ResolvedProvider,
    model_id: str,
) -> str | None:
    """openai_compat + 自定义 base_url 时 task 省略 -m，
    让 cline auth 写入的 model 生效。"""
    if provider.kind in ("openai_compat", "dashscope_compat") and provider.base_url.strip():
        return None
    m = (model_id or "").strip()
    return m or None


def _build_task_argv(
    exe: str,
    config_dir: Path,
    ws: Path,
    *,
    output_kind: str,
    timeout_sec: int,
    model_flag: str | None,
    verbose: bool,
) -> list[str]:
    args: list[str] = [exe]
    if verbose:
        args.append("--verbose")
    args.append("task")
    args.extend([
        "-y", "-a",
        "--config", str(config_dir),
        "-c", str(ws),
        "--timeout", str(timeout_sec),
    ])
    if model_flag:
        args.extend(["-m", model_flag])
    if output_kind == "jsonl":
        args.append("--json")
    args.append(_INPUT_MD_TASK_PROMPT)
    return args


def _read_artifact_or_stdout(
    ws: Path,
    artifact_filename: str,
    stdout_text: str,
) -> str:
    if artifact_filename:
        p = ws / artifact_filename
        if p.is_file():
            try:
                body = p.read_text(encoding="utf-8").strip()
                if body:
                    return body
            except OSError:
                pass
    return stdout_text.strip()


def _stub_cline_text(seed: str, rendered_user: str, physical: str, output_kind: str) -> str:
    import json
    if output_kind == "text":
        return f"[cline-stub:{physical}] seed={seed} prompt={rendered_user[:60]!r}"
    if output_kind == "json_object":
        return json.dumps({
            "ok": True,
            "seed": seed,
            "runner": "cline",
            "physical": physical,
            "echo": rendered_user[:200],
        }, ensure_ascii=False)
    if output_kind == "json_array":
        return json.dumps([{
            "ok": True,
            "seed": seed,
            "runner": "cline",
            "physical": physical,
            "echo": rendered_user[:120],
        }], ensure_ascii=False)
    if output_kind == "jsonl":
        return "\n".join([
            json.dumps({"type": "say", "text": f"[cline-stub] {rendered_user[:60]}"}, ensure_ascii=False),
            json.dumps({"final": {"ok": True, "seed": seed, "runner": "cline"}}, ensure_ascii=False),
        ])
    return f"[cline-stub:{physical}:unknown_kind={output_kind}]"


class ClineRunner(SubprocessAgentRunner):
    runner_kind = "cline"

    async def run_task(
        self,
        resolved: ResolvedAgent,
        task: AgentTask,
        ref_output_kind: str,
        ref_artifact_filename: str,
        ctx: Any,
        timeout_sec: int,
    ) -> AgentResult:
        observer = ctx.observer
        if not resolved.provider_id:
            raise AgentConfigError(
                f"agent {resolved.physical} runner=cline 必须配 provider"
            )
        try:
            provider = ctx.provider_service.resolve(resolved.provider_id)
        except ProviderError as e:
            raise AgentConfigError(
                f"cline runner 无法解析 provider {resolved.provider_id!r}: {e}"
            ) from e

        spec = load_spec(task.spec_ref, ctx.spec_search_root)
        # 渲染 user 文本（cline 是 black box，不需要 system 文本，
        # system 由 .clinerules 注入）
        from tools.chronicle_sim_v3.llm.render import render
        from tools.chronicle_sim_v3.llm.types import Prompt as LLMPrompt
        _, rendered_user, _ = render(
            LLMPrompt(
                spec_ref=task.spec_ref,
                vars=dict(task.vars),
                system_extra=task.system_extra,
            ),
            ctx.spec_search_root,
        )

        config_dir = (ctx.run_dir / _CLINE_DIRNAME).resolve()
        config_dir.mkdir(parents=True, exist_ok=True)

        ws = materialize_temp_ws(ctx.run_dir, sub="cline")
        _materialize_clinerules(ws, spec)
        if rendered_user.strip():
            (ws / "input.md").write_text(rendered_user, encoding="utf-8")

        if provider.kind == "stub":
            import hashlib
            t_start = monotonic()
            output_spec = OutputSpec(
                kind=ref_output_kind,
                artifact_filename=ref_artifact_filename,
            )
            seed = hashlib.sha256(
                f"{resolved.physical}|{task.spec_ref}|{rendered_user}".encode("utf-8")
            ).hexdigest()[:16]
            raw_text = _stub_cline_text(seed, rendered_user, resolved.physical, ref_output_kind)
            parsed, tool_log = parse_output(raw_text, output_spec)
            elapsed_ms = int((monotonic() - t_start) * 1000)
            return AgentResult(
                text=raw_text if ref_output_kind == "text" else (raw_text if isinstance(parsed, str) else raw_text),
                parsed=parsed,
                tool_log=tool_log,
                exit_code=0,
                timings={"total_ms": elapsed_ms, "stub_ms": elapsed_ms},
                runner_kind=self.runner_kind,
                physical_agent=resolved.physical,
                llm_calls_count=None,
            )

        cfg = resolved.config or {}
        verbose = bool(cfg.get("cline_verbose", False))
        stream_stderr = bool(cfg.get("cline_stream_stderr", True))
        executable_cfg = str(cfg.get("cline_executable", "") or "")

        # 强制禁用系统代理（用户硬约束）；config.no_proxy 已废弃。
        env = build_no_proxy_env()
        env["CLINE_DIR"] = str(config_dir)

        exe = resolve_cline_executable(executable_cfg)
        t_start = monotonic()
        t_auth_ms = 0
        t_exec_ms = 0
        archived_path: Path | None = None
        try:
            auth_argv = _build_auth_argv(
                exe, config_dir, provider,
                model_id=resolved.model_id, verbose=verbose,
            )
            if auth_argv:
                t0 = monotonic()
                await self._run_one(
                    auth_argv, env, str(ctx.run_dir.resolve()),
                    timeout=120.0, observer=observer,
                    stream_stderr=stream_stderr,
                    phase="cline.auth", source="cline",
                )
                t_auth_ms = int((monotonic() - t0) * 1000)

            model_flag = _cline_task_model_flag(provider, resolved.model_id)
            task_argv = _build_task_argv(
                exe, config_dir, ws,
                output_kind=ref_output_kind, timeout_sec=timeout_sec,
                model_flag=model_flag, verbose=verbose,
            )
            t0 = monotonic()
            out_b, err_b, rc = await self._run_one(
                task_argv, env, str(ws),
                timeout=float(timeout_sec), observer=observer,
                stream_stderr=stream_stderr,
                phase="cline.task", source="cline",
                return_streams=True,
            )
            t_exec_ms = int((monotonic() - t0) * 1000)
            text_out = (out_b or b"").decode("utf-8", errors="replace")

            if rc != 0:
                err_t = (err_b or b"").decode("utf-8", errors="replace")[:500]
                raise AgentRunnerError(
                    f"cline exit={rc} stderr={err_t!r}"
                )

            final_text = _read_artifact_or_stdout(
                ws, ref_artifact_filename, text_out
            )
            output_spec = OutputSpec(
                kind=ref_output_kind,
                artifact_filename=ref_artifact_filename,
            )
            tool_log: list[dict] = []
            try:
                parsed, tool_log = parse_output(final_text, output_spec)
            except Exception as e:
                if ref_output_kind in ("json_object", "json_array"):
                    # 真实 cline 偶发先输出解释、再给半结构化内容；这里不直接信任原样 JSON，
                    # 而是回退到「从原始文本 + 输入变量中抽取/组装目标结构」。
                    observer.on_phase("cline.parse_fallback", {
                        "spec_ref": task.spec_ref,
                        "error": str(e)[:240],
                    })
                    tool_log = [{
                        "type": "parse_fallback",
                        "spec_ref": task.spec_ref,
                        "error": str(e),
                    }]
                    parsed = None
                else:
                    raise AgentRunnerError(
                        f"cline 输出解析失败(kind={ref_output_kind}): {e}"
                    ) from e
            parsed = _normalize_structured_output(
                spec_ref=task.spec_ref,
                role_vars=dict(task.vars),
                raw_text=final_text,
                parsed=parsed,
            )
            archived_path = archive_workspace(
                ctx.run_dir, ws, role=resolved.physical
            )
            return AgentResult(
                text=final_text,
                parsed=parsed,
                tool_log=tool_log,
                exit_code=0,
                timings={
                    "total_ms": int((monotonic() - t_start) * 1000),
                    "auth_ms": t_auth_ms,
                    "exec_ms": t_exec_ms,
                },
                runner_kind=self.runner_kind,
                physical_agent=resolved.physical,
                llm_calls_count=None,  # cline 内部 LLM 调用不可观测
            )
        finally:
            if ws.is_dir() and archived_path is None:
                archive_workspace(ctx.run_dir, ws, role=resolved.physical)
