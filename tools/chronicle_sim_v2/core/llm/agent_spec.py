"""Agent spec（TOML 单一来源）：加载与模板渲染。"""
from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

from tools.chronicle_sim_v2.paths import DATA_DIR

AGENT_SPECS_DIR: Path = DATA_DIR / "agent_specs"
_PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


@dataclass(frozen=True)
class AgentSpec:
    """从 `data/agent_specs/<slot>.toml` 解析的调用契约。"""

    agent_id: str
    system: str
    user_template: str
    mcp: str
    copy_chronicle_to_cwd: bool
    thinking: bool
    output_mode: str


class AgentSpecError(RuntimeError):
    pass


def _spec_path(slot: str) -> Path:
    return AGENT_SPECS_DIR / f"{slot}.toml"


def _require(d: dict, path: str, key: str) -> object:
    if key not in d:
        raise AgentSpecError(f"agent spec 缺少字段：{path}.{key}")
    return d[key]


def load_agent_spec(slot: str) -> AgentSpec:
    """按槽位名加载 TOML；缺文件/字段直接抛错，不做回退。"""
    p = _spec_path(slot)
    if not p.is_file():
        raise AgentSpecError(f"agent spec 文件不存在：{p}")
    with p.open("rb") as f:
        data = tomllib.load(f)

    meta = _require(data, "", "meta")
    if not isinstance(meta, dict):
        raise AgentSpecError("[meta] 必须是表")
    agent_id = str(_require(meta, "meta", "agent_id")).strip()
    if not agent_id:
        raise AgentSpecError("[meta].agent_id 不能为空")

    prompts = _require(data, "", "prompts")
    if not isinstance(prompts, dict):
        raise AgentSpecError("[prompts] 必须是表")
    system = str(_require(prompts, "prompts", "system"))
    user_template = str(_require(prompts, "prompts", "user_template"))

    options = data.get("options") or {}
    if not isinstance(options, dict):
        raise AgentSpecError("[options] 必须是表")

    mcp = str(options.get("mcp", "none")).strip().lower()
    if mcp not in ("chroma", "none"):
        raise AgentSpecError(f"[options].mcp 取值非法：{mcp!r}（仅支持 chroma/none）")

    output_mode = str(options.get("output_mode", "text")).strip().lower()
    if output_mode not in ("text", "jsonl"):
        raise AgentSpecError(
            f"[options].output_mode 取值非法：{output_mode!r}（仅支持 text/jsonl）"
        )

    return AgentSpec(
        agent_id=agent_id,
        system=system,
        user_template=user_template,
        mcp=mcp,
        copy_chronicle_to_cwd=bool(options.get("copy_chronicle_to_cwd", False)),
        thinking=bool(options.get("thinking", False)),
        output_mode=output_mode,
    )


def _render(template: str, ctx: dict[str, str], *, origin: str) -> str:
    """`{{key}}` 替换；缺失占位符抛错。"""
    missing: list[str] = []

    def _sub(m: re.Match[str]) -> str:
        k = m.group(1)
        if k not in ctx:
            missing.append(k)
            return ""
        return str(ctx[k])

    out = _PLACEHOLDER_RE.sub(_sub, template)
    if missing:
        uniq = sorted(set(missing))
        raise AgentSpecError(f"{origin} 模板占位符未替换：{uniq!r}")
    return out


def render_system(spec: AgentSpec, ctx: dict[str, str] | None = None) -> str:
    return _render(spec.system, dict(ctx or {}), origin=f"[{spec.agent_id}].system")


def render_user(spec: AgentSpec, ctx: dict[str, str] | None = None) -> str:
    return _render(
        spec.user_template, dict(ctx or {}), origin=f"[{spec.agent_id}].user_template"
    )
