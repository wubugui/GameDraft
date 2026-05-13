"""Prompt spec 加载与 {{key}} 渲染。

设计：
- spec 是 TOML，最小字段：[meta] / [prompt] system + user，可选 mcp / output_contract
- {{key}} 使用 simple Jinja-like 语法（不引 jinja2，避免任意代码注入风险）
- 缺少 var 直接 raise，附 spec_ref + 缺失键
- inline spec：spec_ref 以 "_inline:" 开头时取 vars["__system"] / vars["__user"] 直接拼

完全独立实现，不 import v2 任何模块。
"""
from __future__ import annotations

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

from tools.chronicle_sim_v3.llm.errors import LLMConfigError
from tools.chronicle_sim_v3.llm.types import Prompt


_VAR_RE = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}")


@dataclass(frozen=True)
class AgentSpec:
    spec_ref: str
    system: str
    user: str
    mcp: str = ""
    output_contract: str = ""
    sha: str = ""

    @property
    def needs_clinerules_mcp(self) -> bool:
        return bool(self.mcp.strip())


def _resolve_spec_path(spec_ref: str, search_root: Path | None = None) -> Path:
    """spec_ref 形如 'data/agent_specs/foo.toml' 或绝对路径。

    若是相对路径，先从 search_root 查；找不到再到 v3 包内 data/ 查。
    """
    p = Path(spec_ref)
    if p.is_absolute() and p.is_file():
        return p
    if search_root:
        cand = (search_root / spec_ref).resolve()
        if cand.is_file():
            return cand
    pkg_root = Path(__file__).resolve().parents[1]
    cand2 = (pkg_root / spec_ref).resolve()
    if cand2.is_file():
        return cand2
    raise LLMConfigError(f"spec 文件不存在: {spec_ref}（已搜索 {search_root!r} 与 {pkg_root!r}）")


def load_spec(spec_ref: str, search_root: Path | None = None) -> AgentSpec:
    """加载 TOML spec。兼容多种 TOML 命名约定：

    - 推荐 v3 风格：`[prompt] system = ... user = ...`
    - 兼容 v2 风格：`[prompts] system = ... user_template = ...`
    - 选项块：`[options] mcp = "chroma"` 或顶层 `mcp = "chroma"`
    - 输出契约：`[output] contract = ...` 或顶层 `output_contract = ...`

    特殊：spec_ref == '_inline' 时不读盘，返回空 spec；
    user/system 由 vars 注入（见 render）。
    """
    if spec_ref == "_inline":
        return AgentSpec(spec_ref=spec_ref, system="", user="")
    p = _resolve_spec_path(spec_ref, search_root)
    raw = p.read_bytes()
    try:
        doc = tomllib.loads(raw.decode("utf-8"))
    except tomllib.TOMLDecodeError as e:
        raise LLMConfigError(f"spec TOML 解析失败 {p}: {e}") from e

    prompt = doc.get("prompt") or doc.get("prompts") or {}
    options = doc.get("options") or {}
    output = doc.get("output") or {}

    system = prompt.get("system", "") or doc.get("system", "")
    user = (
        prompt.get("user", "")
        or prompt.get("user_template", "")
        or doc.get("user", "")
        or doc.get("user_template", "")
    )
    mcp = str(
        options.get("mcp")
        or doc.get("mcp")
        or ""
    ).strip()
    output_contract = (
        output.get("contract", "")
        or doc.get("output_contract", "")
    )
    import hashlib

    return AgentSpec(
        spec_ref=spec_ref,
        system=system,
        user=user,
        mcp=mcp,
        output_contract=output_contract,
        sha=hashlib.sha256(raw).hexdigest(),
    )


def _render_template(template: str, vars_: dict) -> str:
    """{{key}} / {{key.sub}} 替换。缺 var 抛错。"""
    missing: list[str] = []

    def _lookup(path: str):
        cur = vars_
        for part in path.split("."):
            if isinstance(cur, dict) and part in cur:
                cur = cur[part]
            else:
                missing.append(path)
                return ""
        return cur

    def _replace(m: re.Match) -> str:
        key = m.group(1)
        v = _lookup(key)
        if isinstance(v, (dict, list)):
            import json

            return json.dumps(v, ensure_ascii=False)
        return str(v)

    out = _VAR_RE.sub(_replace, template)
    if missing:
        raise LLMConfigError(
            f"渲染缺少变量: {sorted(set(missing))}（template 头={template[:60]!r}）"
        )
    return out


def render(prompt: Prompt, search_root: Path | None = None) -> tuple[str, str, AgentSpec]:
    """渲染并返回 (system, user, spec)。

    inline 模式：vars 必须含 __system / __user 键。
    """
    spec = load_spec(prompt.spec_ref, search_root)
    if prompt.spec_ref == "_inline":
        sys_raw = str(prompt.vars.get("__system", ""))
        usr_raw = str(prompt.vars.get("__user", ""))
        sys_full = sys_raw + (("\n\n" + prompt.system_extra) if prompt.system_extra else "")
        return sys_full, usr_raw, spec
    sys_text = _render_template(spec.system, prompt.vars)
    usr_text = _render_template(spec.user, prompt.vars)
    if prompt.system_extra:
        sys_text = sys_text + "\n\n" + prompt.system_extra
    return sys_text, usr_text, spec


def estimate_tokens_for(prompt: Prompt, search_root: Path | None = None) -> int:
    """粗估渲染后字符数 / 2。"""
    try:
        sys_text, usr_text, _ = render(prompt, search_root)
    except LLMConfigError:
        # 渲染失败时用 vars 文本兜底，避免 limiter 阶段崩
        text = repr(prompt.vars)
        return max(1, len(text) // 2)
    return max(1, (len(sys_text) + len(usr_text)) // 2)
